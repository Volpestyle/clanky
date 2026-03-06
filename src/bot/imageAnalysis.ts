import {
  MAX_IMAGE_LOOKUP_QUERY_LEN,
  extractUrlsFromText,
  normalizeDirectiveText
} from "../botHelpers.ts";
import type { BotContext } from "./botContext.ts";
import { isLikelyImageUrl, parseHistoryImageReference } from "./messageHistory.ts";
import { MAX_MODEL_IMAGE_INPUTS } from "./replyPipelineShared.ts";

const MAX_HISTORY_IMAGE_CANDIDATES = 24;
const MAX_HISTORY_IMAGE_LOOKUP_RESULTS = 6;
const MAX_IMAGE_LOOKUP_QUERY_TOKENS = 7;

export interface ImageCaptionCacheLike {
  get?: (url: string) => { caption?: string | null } | null;
  hasOrInflight?: (url: string) => boolean;
  getOrCaption?: (payload: {
    url: string;
    llm: BotContext["llm"];
    settings?: Record<string, unknown> | null;
    mimeType?: string;
    trace?: Record<string, unknown> | null;
  }) => Promise<unknown>;
}

type HistoryImageCandidate = {
  messageId?: string | null;
  authorName?: string;
  createdAt?: string;
  url?: string;
  filename?: string;
  contentType?: string;
  context?: string;
  recencyRank?: number;
  hasCachedCaption?: boolean;
  score?: number;
  matchReason?: string;
};

type CaptionRecentHistoryImagesOptions = {
  imageCaptionCache: ImageCaptionCacheLike | null;
  captionTimestamps: number[];
  candidates?: HistoryImageCandidate[];
  settings?: Record<string, unknown> | null;
  trace?: Record<string, unknown> | null;
};

type GetAutoIncludeImageInputsOptions = {
  candidates?: HistoryImageCandidate[];
  maxImages?: number;
};

type ExtractHistoryImageCandidatesOptions = {
  recentMessages?: Array<Record<string, unknown>>;
  excluded?: Set<string>;
  imageCaptionCache?: ImageCaptionCacheLike | null;
};

type RankImageLookupCandidatesOptions = {
  candidates?: HistoryImageCandidate[];
  query?: string;
};

type RunModelRequestedImageLookupOptions = {
  imageLookup?:
    | ({
        enabled?: boolean;
        candidates?: HistoryImageCandidate[];
        requested?: boolean;
        used?: boolean;
        query?: string;
        results?: HistoryImageCandidate[];
        selectedImageInputs?: Array<Record<string, unknown>>;
        error?: string | null;
      } & Record<string, unknown>)
    | null;
  query?: string;
};

type MergeImageInputsOptions = {
  baseInputs?: Array<Record<string, unknown>>;
  extraInputs?: Array<Record<string, unknown>>;
  maxInputs?: number;
};

function getVisionMaxCaptionsPerHour(settings: Record<string, unknown> | null) {
  const visionSettings =
    settings?.vision && typeof settings.vision === "object" && !Array.isArray(settings.vision)
      ? settings.vision
      : null;
  const maxPerHour =
    visionSettings && "maxCaptionsPerHour" in visionSettings
      ? Number(visionSettings.maxCaptionsPerHour)
      : Number.NaN;
  return Number.isFinite(maxPerHour) ? maxPerHour : 60;
}

export function captionRecentHistoryImages(
  ctx: BotContext,
  {
    imageCaptionCache,
    captionTimestamps,
    candidates = [],
    settings = null,
    trace = null
  }: CaptionRecentHistoryImagesOptions
) {
  if (
    !imageCaptionCache ||
    typeof imageCaptionCache.getOrCaption !== "function" ||
    !Array.isArray(captionTimestamps)
  ) {
    return;
  }

  const list = Array.isArray(candidates) ? candidates : [];
  const maxPerBatch = Math.min(list.length, 5);
  let scheduled = 0;

  const budgetCap = getVisionMaxCaptionsPerHour(settings);
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  for (let index = captionTimestamps.length - 1; index >= 0; index -= 1) {
    if (captionTimestamps[index] <= oneHourAgo) {
      captionTimestamps.splice(index, 1);
    }
  }
  const remainingBudget = Math.max(0, budgetCap - captionTimestamps.length);
  if (remainingBudget === 0) return;

  for (const candidate of list) {
    if (scheduled >= maxPerBatch) break;
    if (scheduled >= remainingBudget) break;
    if (!candidate?.url) continue;
    if (imageCaptionCache.hasOrInflight?.(candidate.url)) continue;

    scheduled += 1;
    captionTimestamps.push(now);
    imageCaptionCache
      .getOrCaption({
        url: candidate.url,
        llm: ctx.llm,
        settings,
        mimeType: candidate.contentType || "",
        trace: trace || {
          guildId: null,
          channelId: null,
          userId: null,
          source: "history_image_caption"
        }
      })
      .catch(() => {});
  }
}

export function getAutoIncludeImageInputs({
  candidates = [],
  maxImages = 3
}: GetAutoIncludeImageInputsOptions = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cap = Math.max(0, Math.min(Number(maxImages) || 3, 6));
  const inputs = [];

  for (const candidate of list) {
    if (inputs.length >= cap) break;
    if (!candidate?.url) continue;
    inputs.push({
      url: candidate.url,
      filename: candidate.filename || "(unnamed)",
      contentType: candidate.contentType || ""
    });
  }

  return inputs;
}

export function extractHistoryImageCandidates({
  recentMessages = [],
  excluded = new Set(),
  imageCaptionCache = null
}: ExtractHistoryImageCandidatesOptions = {}) {
  const rows = Array.isArray(recentMessages) ? recentMessages : [];
  const seen = excluded instanceof Set ? new Set(excluded) : new Set<string>();
  const candidates = [];

  for (const row of rows) {
    if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
    const content = String(row?.content || "");
    if (!content) continue;

    const urls = extractUrlsFromText(content);
    if (!urls.length) continue;

    for (const rawUrl of urls) {
      if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
      const url = String(rawUrl || "").trim();
      if (!url) continue;
      if (!isLikelyImageUrl(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const parsed = parseHistoryImageReference(url);
      const contentSansUrl = content.replace(url, " ").replace(/\s+/g, " ").trim();
      const cachedCaption = imageCaptionCache?.get?.(url);
      const captionText = String(cachedCaption?.caption || "");
      const baseContext = contentSansUrl.slice(0, 180);
      const enrichedContext = captionText
        ? (baseContext ? `${baseContext} [caption: ${captionText}]` : `[caption: ${captionText}]`).slice(0, 360)
        : baseContext;

      candidates.push({
        messageId: String(row?.message_id || "").trim() || null,
        authorName: String(row?.author_name || "unknown").trim() || "unknown",
        createdAt: String(row?.created_at || "").trim(),
        url,
        filename: parsed.filename || "(unnamed)",
        contentType: parsed.contentType || "",
        context: enrichedContext,
        recencyRank: candidates.length,
        hasCachedCaption: Boolean(cachedCaption)
      });
    }
  }

  return candidates;
}

export function rankImageLookupCandidates({
  candidates = [],
  query = ""
}: RankImageLookupCandidatesOptions = {}) {
  const normalizedQuery = String(query || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const queryTokens = [...new Set(normalizedQuery.match(/[a-z0-9]{3,}/g) || [])].slice(
    0,
    MAX_IMAGE_LOOKUP_QUERY_TOKENS
  );
  const wantsVisualRecall = /\b(?:image|photo|picture|pic|screenshot|meme|earlier|previous|that)\b/i.test(
    normalizedQuery
  );

  const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const haystack = [candidate?.context, candidate?.filename, candidate?.authorName]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    let score = Math.max(0, 4 - index * 0.3);
    const reasons = [];

    if (normalizedQuery && haystack.includes(normalizedQuery)) {
      score += 9;
      reasons.push("phrase match");
    }

    let tokenHits = 0;
    for (const token of queryTokens) {
      if (!token) continue;
      if (haystack.includes(token)) {
        score += 2;
        tokenHits += 1;
      }
    }
    if (tokenHits > 0) {
      reasons.push(`${tokenHits} token hit${tokenHits === 1 ? "" : "s"}`);
    }

    if (wantsVisualRecall) {
      score += 1;
    }

    return {
      ...candidate,
      score,
      matchReason: reasons.join(", ") || "recency fallback"
    };
  });

  ranked.sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (a.recencyRank || 0) - (b.recencyRank || 0);
  });

  const matched = ranked.filter((item) => (item.score || 0) >= 4);
  return matched.length ? matched : ranked;
}

export async function runModelRequestedImageLookup({
  imageLookup,
  query
}: RunModelRequestedImageLookupOptions) {
  const normalizedQuery = normalizeDirectiveText(query, MAX_IMAGE_LOOKUP_QUERY_LEN);
  const baseState = imageLookup || {};
  const state = {
    ...baseState,
    enabled: Boolean(baseState.enabled),
    candidates: Array.isArray(baseState.candidates) ? baseState.candidates : [],
    requested: true,
    used: false,
    query: normalizedQuery,
    results: [],
    selectedImageInputs: [],
    error: null
  };

  if (!state.enabled) {
    return state;
  }
  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing image lookup query."
    };
  }

  const candidates = state.candidates;
  if (!candidates.length) {
    return {
      ...state,
      error: "No recent history images are available for lookup."
    };
  }

  const ranked = rankImageLookupCandidates({
    candidates,
    query: normalizedQuery
  });
  const selected = ranked.slice(0, Math.min(MAX_HISTORY_IMAGE_LOOKUP_RESULTS, MAX_MODEL_IMAGE_INPUTS));
  if (!selected.length) {
    return {
      ...state,
      error: "No matching history images were found."
    };
  }

  return {
    ...state,
    used: true,
    results: selected,
    selectedImageInputs: selected.map((item) => ({
      url: item.url,
      filename: item.filename,
      contentType: item.contentType
    }))
  };
}

export function mergeImageInputs({
  baseInputs = [],
  extraInputs = [],
  maxInputs = MAX_MODEL_IMAGE_INPUTS
}: MergeImageInputsOptions = {}) {
  const merged = [];
  const seen = new Set();
  const pushUnique = (input: Record<string, unknown>) => {
    if (!input || typeof input !== "object") return;
    const url = String(input.url || "").trim();
    const mediaType = String(input.mediaType || input.contentType || "").trim().toLowerCase();
    const inlineData = String(input.dataBase64 || "").trim();
    const key = url
      ? `url:${url}`
      : inlineData
        ? `inline:${mediaType}:${inlineData.slice(0, 80)}`
        : "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(input);
  };

  for (const input of Array.isArray(baseInputs) ? baseInputs : []) {
    if (merged.length >= maxInputs) break;
    pushUnique(input);
  }
  for (const input of Array.isArray(extraInputs) ? extraInputs : []) {
    if (merged.length >= maxInputs) break;
    pushUnique(input);
  }

  return merged.slice(0, maxInputs);
}
