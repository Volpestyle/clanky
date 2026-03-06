import { clamp } from "../utils.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";

const GIPHY_SEARCH_API_URL = "https://api.giphy.com/v1/gifs/search";
const GIF_TIMEOUT_MS = 8_500;
const GIF_USER_AGENT =
  "clanker-conk/0.1 (+gif-search; https://github.com/Volpestyle/clanker_conk)";
const MAX_GIF_QUERY_LEN = 120;
const GIPHY_ALLOWED_RATINGS = new Set(["g", "pg", "pg-13", "r"]);
type GifTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

export class GifService {
  store;
  apiKey;
  rating;

  constructor({ appConfig, store }) {
    this.store = store;
    this.apiKey = String(appConfig?.giphyApiKey || "").trim();
    this.rating = normalizeGiphyRating(appConfig?.giphyRating);
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async pickGif({ query, trace = {} as GifTrace }) {
    if (!this.isConfigured()) {
      throw new Error("GIPHY GIF search is not configured. Set GIPHY_API_KEY.");
    }

    const normalizedQuery = sanitizeExternalText(query, MAX_GIF_QUERY_LEN);
    if (!normalizedQuery) {
      return null;
    }

    try {
      const matches = await this.searchGiphy({
        query: normalizedQuery,
        limit: 10
      });
      const selected = pickRandom(matches);

      this.store.logAction({
        kind: "gif_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: normalizedQuery,
        metadata: {
          provider: "giphy",
          query: normalizedQuery,
          source: trace.source || "unknown",
          rating: this.rating,
          returnedResults: matches.length,
          used: Boolean(selected),
          gifUrl: selected?.url || null
        }
      });

      return selected || null;
    } catch (error) {
      this.store.logAction({
        kind: "gif_error",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: String(error?.message || error),
        metadata: {
          provider: "giphy",
          query: normalizedQuery,
          rating: this.rating,
          source: trace.source || "unknown"
        }
      });
      throw error;
    }
  }

  async searchGiphy({ query, limit }) {
    const endpoint = new URL(GIPHY_SEARCH_API_URL);
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("limit", String(clamp(Number(limit) || 10, 1, 25)));
    endpoint.searchParams.set("rating", this.rating);
    endpoint.searchParams.set("lang", "en");
    endpoint.searchParams.set("bundle", "messaging_non_clips");

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "user-agent": GIF_USER_AGENT,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(GIF_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`GIPHY HTTP ${response.status}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error("GIPHY returned invalid JSON.");
    }

    const rawItems = Array.isArray(payload?.data) ? payload.data : [];
    const seenUrls = new Set();
    const items = [];

    for (const row of rawItems) {
      const media = row?.images ?? {};
      const url = sanitizeHttpsUrl(
        media?.fixed_height?.url ||
          media?.downsized?.url ||
          media?.original?.url ||
          media?.preview_gif?.url ||
          ""
      );
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      items.push({
        id: String(row?.id || ""),
        title: sanitizeExternalText(row?.title || "", 140),
        url,
        pageUrl: sanitizeHttpsUrl(row?.url || row?.bitly_url || "")
      });
    }

    return items;
  }
}

function normalizeGiphyRating(rawValue) {
  const normalized = String(rawValue || "pg-13")
    .trim()
    .toLowerCase();
  return GIPHY_ALLOWED_RATINGS.has(normalized) ? normalized : "pg-13";
}

function pickRandom(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function sanitizeExternalText(text, maxLen) {
  return normalizeWhitespaceText(text, {
    maxLen: clamp(Number(maxLen) || 120, 1, 5000)
  });
}

function sanitizeHttpsUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:") return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
