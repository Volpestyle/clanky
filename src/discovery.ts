import { assertPublicUrl, isBlockedHost } from "./urlSafety.ts";
import { clamp } from "./utils.ts";
import { getDiscoverySettings } from "./settings/agentStack.ts";
import { normalizeWhitespaceText } from "./normalization/text.ts";
import { isRedirectStatus } from "./retry.ts";

const DISCOVERY_TIMEOUT_MS = 9_000;
const DISCOVERY_MAX_REDIRECTS = 5;
const DISCOVERY_USER_AGENT =
  "clanker-conk/0.1 (+discovery-posts; https://github.com/Volpestyle/clanker_conk)";

const TRACKING_QUERY_PREFIXES = ["utm_"];
const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "si",
  "spm"
]);

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "before",
  "being",
  "cant",
  "could",
  "didnt",
  "dont",
  "from",
  "gonna",
  "have",
  "just",
  "like",
  "make",
  "more",
  "only",
  "really",
  "some",
  "that",
  "their",
  "there",
  "they",
  "this",
  "thing",
  "very",
  "want",
  "with",
  "would",
  "your"
]);

const SOURCE_WEIGHTS = {
  reddit: 0.94,
  hackernews: 1,
  youtube: 0.96,
  rss: 0.92,
  x: 0.9
};

export class DiscoveryService {
  store;

  constructor({ store }) {
    this.store = store;
  }

  async collect({
    settings,
    guildId,
    channelId,
    channelName,
    recentMessages
  }) {
    const config = normalizeDiscoveryConfig(getDiscoverySettings(settings));
    if (!config.enabled) {
      return {
        enabled: false,
        topics: [],
        candidates: [],
        selected: [],
        reports: [],
        errors: [],
        dedupeSinceIso: null
      };
    }

    const topics = buildTopicSeeds({
      preferredTopics: config.preferredTopics,
      recentMessages,
      channelName
    });
    const sinceIso = new Date(Date.now() - config.dedupeHours * 60 * 60_000).toISOString();
    const tasks = [];

    if (config.sources.reddit && config.redditSubreddits.length) {
      tasks.push(this.fetchReddit(config));
    }
    if (config.sources.hackerNews) {
      tasks.push(this.fetchHackerNews(config));
    }
    if (config.sources.youtube && config.youtubeChannelIds.length) {
      tasks.push(this.fetchYoutube(config));
    }
    if (config.sources.rss && config.rssFeeds.length) {
      tasks.push(this.fetchRss(config));
    }
    if (config.sources.x && config.xHandles.length) {
      tasks.push(this.fetchX(config));
    }

    const settled = await Promise.allSettled(tasks);
    const reports = [];
    const errors = [];
    const rawCandidates = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        reports.push(result.value.report);
        rawCandidates.push(...result.value.items);
        continue;
      }

      const message = String(result.reason?.message || result.reason || "unknown discovery error");
      errors.push(message);
      reports.push({
        source: "unknown",
        fetched: 0,
        accepted: 0,
        error: message
      });
    }

    const seen = new Set();
    const filtered = [];
    const now = Date.now();
    const freshnessMs = config.freshnessHours * 60 * 60_000;

    for (const item of rawCandidates) {
      const normalizedUrl = normalizeDiscoveryUrl(item.url);
      if (!normalizedUrl) continue;
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);

      if (!config.allowNsfw && item.nsfw) continue;
      if (item.publishedAt) {
        const publishedTs = Date.parse(item.publishedAt);
        if (Number.isFinite(publishedTs) && now - publishedTs > freshnessMs) continue;
      }
      if (this.store.wasLinkSharedSince(normalizedUrl, sinceIso)) continue;

      const score = scoreCandidate({
        item,
        topics,
        freshnessHours: config.freshnessHours,
        randomness: config.randomness
      });
      filtered.push({
        ...item,
        url: normalizedUrl,
        score
      });
    }

    filtered.sort((a, b) => b.score - a.score);
    const candidates = filtered.slice(0, config.maxCandidatesForPrompt).map(toPromptCandidate);
    const selected = pickSelectedCandidates(
      candidates,
      config.maxLinksPerPost,
      config.randomness
    );

    const reportBySource = reports.reduce((acc, report) => {
      const key = String(report.source || "unknown");
      acc[key] = report;
      return acc;
    }, {});

    return {
      enabled: true,
      topics,
      candidates,
      selected,
      reports,
      reportBySource,
      errors,
      dedupeSinceIso: sinceIso,
      summary: {
        guildId,
        channelId,
        sourceCount: tasks.length,
        fetchedCount: rawCandidates.length,
        candidateCount: candidates.length,
        selectedCount: selected.length
      }
    };
  }

  async fetchReddit(config) {
    const items = [];
    let fetched = 0;
    const selectedSubs = config.redditSubreddits.slice(0, 6);
    const errors = [];

    for (const subreddit of selectedSubs) {
      const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=${config.sourceFetchLimit}&raw_json=1`;

      let payload;
      try {
        payload = await readJson(url);
      } catch (error) {
        errors.push(`r/${subreddit}: ${String(error?.message || error)}`);
        continue;
      }

      const children = payload?.data?.children;
      if (!Array.isArray(children)) continue;

      for (const child of children) {
        const post = child?.data;
        if (!post || post.stickied) continue;
        fetched += 1;

        const outbound = post.url_overridden_by_dest || post.url || "";
        const permalink = post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : "";
        const candidateUrl = normalizeDiscoveryUrl(outbound) || normalizeDiscoveryUrl(permalink);
        if (!candidateUrl) continue;

        items.push({
          source: "reddit",
          sourceLabel: `r/${subreddit}`,
          title: sanitizeExternalText(post.title, 180),
          url: candidateUrl,
          excerpt: sanitizeExternalText(post.selftext || post.link_flair_text || "", 200),
          popularity: Number(post.ups || 0) + Number(post.num_comments || 0),
          publishedAt: Number.isFinite(post.created_utc)
            ? new Date(post.created_utc * 1000).toISOString()
            : null,
          nsfw: Boolean(post.over_18)
        });
      }
    }

    return {
      report: {
        source: "reddit",
        fetched,
        accepted: items.length,
        error: errors.length ? errors.join(" | ") : null
      },
      items
    };
  }

  async fetchHackerNews(config) {
    let topIds = [];
    try {
      topIds = await readJson("https://hacker-news.firebaseio.com/v0/topstories.json");
    } catch (error) {
      return {
        report: {
          source: "hackernews",
          fetched: 0,
          accepted: 0,
          error: String(error?.message || error)
        },
        items: []
      };
    }

    if (!Array.isArray(topIds) || !topIds.length) {
      return {
        report: {
          source: "hackernews",
          fetched: 0,
          accepted: 0,
          error: "no story ids returned"
        },
        items: []
      };
    }

    const ids = topIds.slice(0, Math.min(30, config.sourceFetchLimit * 2));
    const rows = await Promise.all(
      ids.map((id) =>
        readJson(`https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(String(id))}.json`).catch(
          () => null
        )
      )
    );

    const items = [];
    let fetched = 0;
    for (const row of rows) {
      if (!row || row.type !== "story" || !row.title) continue;
      fetched += 1;

      const externalUrl = normalizeDiscoveryUrl(row.url || "");
      const fallback = normalizeDiscoveryUrl(
        `https://news.ycombinator.com/item?id=${encodeURIComponent(String(row.id || ""))}`
      );
      const url = externalUrl || fallback;
      if (!url) continue;

      items.push({
        source: "hackernews",
        sourceLabel: "Hacker News",
        title: sanitizeExternalText(row.title, 180),
        url,
        excerpt: "",
        popularity: Number(row.score || 0) + Number(row.descendants || 0),
        publishedAt: Number.isFinite(row.time) ? new Date(row.time * 1000).toISOString() : null,
        nsfw: false
      });
    }

    return {
      report: {
        source: "hackernews",
        fetched,
        accepted: items.length,
        error: null
      },
      items
    };
  }

  async fetchYoutube(config) {
    return await this.fetchFeedSources({
      source: "youtube",
      inputs: config.youtubeChannelIds.slice(0, 8),
      config,
      excerptMaxLen: 180,
      buildUrl: (channelId) =>
        `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(String(channelId || ""))}`,
      buildSourceLabel: ({ input, parsed }) => parsed.feedTitle || `YouTube ${input}`
    });
  }

  async fetchRss(config) {
    return await this.fetchFeedSources({
      source: "rss",
      inputs: config.rssFeeds.slice(0, 8),
      config,
      excerptMaxLen: 180,
      buildUrl: (feedUrl) => String(feedUrl || ""),
      buildSourceLabel: ({ input, parsed }) => parsed.feedTitle || String(input || "")
    });
  }

  async fetchX(config) {
    const baseUrl = config.xNitterBaseUrl.replace(/\/+$/, "");
    return await this.fetchFeedSources({
      source: "x",
      inputs: config.xHandles.slice(0, 6),
      config,
      excerptMaxLen: 200,
      buildUrl: (handle) => `${baseUrl}/${encodeURIComponent(String(handle || ""))}/rss`,
      buildSourceLabel: ({ input }) => `@${input}`
    });
  }

  async fetchFeedSources({
    source,
    inputs,
    config,
    buildUrl,
    buildSourceLabel,
    excerptMaxLen = 180
  }) {
    const normalizedSource = String(source || "rss");
    const items = [];
    let fetched = 0;
    const errors = [];

    for (const input of Array.isArray(inputs) ? inputs : []) {
      const inputValue = String(input || "").trim();
      if (!inputValue) continue;

      const url = String(buildUrl?.(inputValue) || "").trim();
      if (!url) continue;

      let xml = "";
      try {
        xml = await readText(url);
      } catch (error) {
        errors.push(`${inputValue}: ${String(error?.message || error)}`);
        continue;
      }

      const parsed = parseFeed(xml, { maxItems: config.sourceFetchLimit });
      fetched += parsed.items.length;

      for (const entry of parsed.items) {
        if (!entry.link) continue;
        items.push({
          source: normalizedSource,
          sourceLabel: String(
            buildSourceLabel?.({ input: inputValue, parsed, entry, url }) || parsed.feedTitle || inputValue
          ),
          title: sanitizeExternalText(entry.title, 180),
          url: entry.link,
          excerpt: sanitizeExternalText(entry.summary || "", excerptMaxLen),
          popularity: 0,
          publishedAt: entry.publishedAt,
          nsfw: false
        });
      }
    }

    return {
      report: {
        source: normalizedSource,
        fetched,
        accepted: items.length,
        error: errors.length ? errors.join(" | ") : null
      },
      items
    };
  }
}

function toPromptCandidate(item) {
  return {
    title: sanitizeExternalText(item.title || "", 180),
    url: String(item.url || "").trim(),
    source: String(item.source || "web"),
    sourceLabel: sanitizeExternalText(item.sourceLabel || item.source || "web", 60),
    excerpt: sanitizeExternalText(item.excerpt || "", 220),
    score: Number(item.score || 0),
    publishedAt: item.publishedAt || null
  };
}

function normalizeDiscoveryConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const sources = cfg.sources && typeof cfg.sources === "object" ? cfg.sources : {};

  return {
    enabled: cfg.enabled !== undefined ? Boolean(cfg.enabled) : true,
    linkChancePercent: clamp(Number(cfg.linkChancePercent) || 80, 0, 100),
    maxLinksPerPost: clamp(Number(cfg.maxLinksPerPost) || 2, 1, 4),
    maxCandidatesForPrompt: clamp(Number(cfg.maxCandidatesForPrompt) || 6, 1, 12),
    freshnessHours: clamp(Number(cfg.freshnessHours) || 96, 1, 24 * 14),
    dedupeHours: clamp(Number(cfg.dedupeHours) || 168, 1, 24 * 45),
    randomness: clamp(Number(cfg.randomness) || 55, 0, 100),
    sourceFetchLimit: clamp(Number(cfg.sourceFetchLimit) || 10, 2, 30),
    allowNsfw: Boolean(cfg.allowNsfw),
    preferredTopics: stringList(cfg.preferredTopics, 16, 80),
    redditSubreddits: stringList(cfg.redditSubreddits, 20, 40)
      .map((entry) => entry.replace(/^r\//i, ""))
      .filter(Boolean),
    youtubeChannelIds: stringList(cfg.youtubeChannelIds, 20, 80),
    rssFeeds: stringList(cfg.rssFeeds, 30, 240).filter((url) => Boolean(normalizeDiscoveryUrl(url))),
    xHandles: stringList(cfg.xHandles, 20, 40)
      .map((entry) => entry.replace(/^@/, ""))
      .filter(Boolean),
    xNitterBaseUrl: normalizeNitterBase(cfg.xNitterBaseUrl),
    sources: {
      reddit: sources.reddit !== undefined ? Boolean(sources.reddit) : true,
      hackerNews: sources.hackerNews !== undefined ? Boolean(sources.hackerNews) : true,
      youtube: sources.youtube !== undefined ? Boolean(sources.youtube) : true,
      rss: sources.rss !== undefined ? Boolean(sources.rss) : true,
      x: sources.x !== undefined ? Boolean(sources.x) : false
    }
  };
}

function normalizeNitterBase(value) {
  const raw = String(value || "").trim() || "https://nitter.net";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "https://nitter.net";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "https://nitter.net";
  }
}

function stringList(input, maxItems, maxLen) {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\n,]/g)
      : [];

  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLen));
}

function buildTopicSeeds({ preferredTopics, recentMessages, channelName }) {
  const topics = stringList(preferredTopics, 16, 40);
  const counts = new Map();

  const words = [
    String(channelName || ""),
    ...((recentMessages || []).map((msg) => String(msg.content || "")))
  ]
    .join(" ")
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,24}/g);

  for (const token of words || []) {
    if (STOP_WORDS.has(token)) continue;
    counts.set(token, Number(counts.get(token) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([token]) => token);

  return [...new Set([...topics, ...ranked])].slice(0, 16);
}

function scoreCandidate({ item, topics, freshnessHours, randomness }) {
  const source = String(item.source || "web");
  const sourceWeight = Number(SOURCE_WEIGHTS[source]) || 0.9;
  const titleText = `${item.title || ""} ${item.excerpt || ""}`.toLowerCase();
  const topicMatches = topics.reduce(
    (count, topic) => (topic && titleText.includes(topic.toLowerCase()) ? count + 1 : count),
    0
  );
  const topicScore = clamp(topicMatches / Math.max(1, Math.min(topics.length, 3)), 0, 1);

  let freshnessScore = 0.35;
  if (item.publishedAt) {
    const publishedTs = Date.parse(item.publishedAt);
    if (Number.isFinite(publishedTs)) {
      const ageHours = Math.max(0, (Date.now() - publishedTs) / 3_600_000);
      freshnessScore = clamp(1 - ageHours / Math.max(1, freshnessHours * 1.1), 0, 1);
    }
  }

  const popularity = Math.max(0, Number(item.popularity) || 0);
  const popularityScore = clamp(Math.log10(popularity + 1) / 4, 0, 1);
  const randomSkew = (Math.random() - 0.5) * (clamp(randomness, 0, 100) / 100) * 0.5;

  return Number((sourceWeight * 0.3 + topicScore * 0.4 + freshnessScore * 0.2 + popularityScore * 0.1 + randomSkew).toFixed(4));
}

function pickSelectedCandidates(candidates, maxLinks, randomness) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const pool = candidates.slice(0, Math.min(candidates.length, Math.max(maxLinks * 3, 6)));
  const randomness01 = clamp(randomness, 0, 100) / 100;

  const weighted = pool
    .map((item, index) => ({
      ...item,
      weightedScore:
        Number(item.score || 0) +
        (Math.random() - 0.5) * 0.35 * randomness01 -
        index * 0.03 * (1 - randomness01)
    }))
    .sort((a, b) => b.weightedScore - a.weightedScore);

  const selected = [];
  const usedSources = new Set();

  for (const item of weighted) {
    if (selected.length >= maxLinks) break;
    if (usedSources.has(item.source)) continue;
    selected.push(item);
    usedSources.add(item.source);
  }

  for (const item of weighted) {
    if (selected.length >= maxLinks) break;
    if (selected.some((picked) => picked.url === item.url)) continue;
    selected.push(item);
  }

  return selected.map(({ weightedScore: _weightedScore, ...rest }) => rest);
}

export function normalizeDiscoveryUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  if (isBlockedHost(parsed.hostname)) return null;
  parsed.hash = "";

  for (const key of [...parsed.searchParams.keys()]) {
    const lowered = key.toLowerCase();
    if (TRACKING_QUERY_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
      parsed.searchParams.delete(key);
      continue;
    }
    if (TRACKING_QUERY_KEYS.has(lowered)) {
      parsed.searchParams.delete(key);
    }
  }

  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
    parsed.port = "";
  }

  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function readJson(url) {
  const raw = await readText(url, "application/json");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON from ${url}`);
  }
}

async function readText(url, accept = "application/xml,text/xml,application/rss+xml,text/plain,application/json") {
  const safeUrl = normalizeDiscoveryUrl(url);
  if (!safeUrl) {
    throw new Error(`blocked or invalid discovery URL: ${url}`);
  }
  const { response, finalUrl } = await fetchDiscoveryResponse({
    url: safeUrl,
    accept
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${finalUrl}`);
  }

  return response.text();
}

async function fetchDiscoveryResponse({ url, accept, maxRedirects = DISCOVERY_MAX_REDIRECTS }) {
  let currentUrl = String(url || "");
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    await assertPublicUrl(currentUrl);
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": DISCOVERY_USER_AGENT,
        accept
      },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    });

    if (isRedirectStatus(response.status)) {
      const location = String(response.headers.get("location") || "").trim();
      if (!location) {
        throw new Error(`redirect missing location for ${currentUrl}`);
      }
      const nextUrl = normalizeDiscoveryUrl(new URL(location, currentUrl).toString());
      if (!nextUrl) {
        throw new Error(`blocked or invalid discovery redirect URL: ${location}`);
      }
      currentUrl = nextUrl;
      continue;
    }

    const finalUrl = normalizeDiscoveryUrl(response.url || currentUrl);
    if (!finalUrl) {
      throw new Error(`blocked or invalid discovery URL: ${response.url || currentUrl}`);
    }
    await assertPublicUrl(finalUrl);
    return {
      response,
      finalUrl
    };
  }

  throw new Error(`too many redirects for discovery URL: ${url}`);
}

function parseFeed(xml, { maxItems = 10 } = {}) {
  const text = String(xml || "");
  const items = [];
  const feedTitle =
    sanitizeExternalText(
      decodeXmlEntities(extractFirstTag(text, "channel") ? extractTag(extractFirstTag(text, "channel"), "title") : ""),
      80
    ) ||
    sanitizeExternalText(decodeXmlEntities(extractTag(text, "title")), 80);

  const rssItems = matchAllBlocks(text, "item");
  const atomEntries = matchAllBlocks(text, "entry");
  const blocks = rssItems.length ? rssItems : atomEntries;

  for (const block of blocks.slice(0, maxItems)) {
    const title = decodeXmlEntities(extractTag(block, "title") || "");
    const summary =
      decodeXmlEntities(extractTag(block, "description") || "") ||
      decodeXmlEntities(extractTag(block, "summary") || "") ||
      decodeXmlEntities(extractTag(block, "content") || "");
    const link =
      decodeXmlEntities(extractTag(block, "link") || "") ||
      decodeXmlEntities(extractAtomHref(block) || "");
    const publishedAtRaw =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated");

    const publishedTs = publishedAtRaw ? Date.parse(publishedAtRaw) : NaN;
    items.push({
      title: sanitizeExternalText(title, 180),
      summary: sanitizeExternalText(summary, 260),
      link: normalizeDiscoveryUrl(link),
      publishedAt: Number.isFinite(publishedTs) ? new Date(publishedTs).toISOString() : null
    });
  }

  return {
    feedTitle,
    items: items.filter((item) => Boolean(item.link))
  };
}

function extractFirstTag(input, tagName) {
  const matches = matchAllBlocks(input, tagName);
  return matches[0] || "";
}

function matchAllBlocks(input, tagName) {
  const pattern = new RegExp(
    `<${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
    "gi"
  );
  return [...String(input || "").matchAll(pattern)].map((match) => String(match[1] || ""));
}

function extractTag(input, tagName) {
  const pattern = new RegExp(
    `<${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
    "i"
  );
  const match = String(input || "").match(pattern);
  return match?.[1] ? stripTagMarkup(match[1]) : "";
}

function extractAtomHref(input) {
  const linkTagPattern = /<link\b([^>]*?)\/?>/gi;
  for (const match of String(input || "").matchAll(linkTagPattern)) {
    const attrs = String(match[1] || "");
    const href = attrs.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!href) continue;
    const rel = attrs.match(/\brel\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!rel || rel.toLowerCase() === "alternate") {
      return href;
    }
  }
  return "";
}

function stripTagMarkup(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function sanitizeExternalText(value, maxLen = 180) {
  return normalizeWhitespaceText(decodeXmlEntities(String(value || "")), {
    maxLen,
    ellipsis: true,
    replacements: [{ pattern: /\[([^\]]{2,80})\]\([^)]+\)/g, replacement: "$1" }]
  });
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
