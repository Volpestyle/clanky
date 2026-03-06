import OpenAI from "openai";
import { normalizeDiscoveryUrl } from "./discovery.ts";
import {
  getResearchRuntimeConfig,
  getResolvedOrchestratorBinding,
  resolveAgentStack
} from "./settings/agentStack.ts";
import { assertPublicUrl } from "./urlSafety.ts";
import { clamp } from "./utils.ts";
import { normalizeWhitespaceText } from "./normalization/text.ts";
import { sleep } from "./normalization/time.ts";
import {
  getRetryDelayMs,
  isRetryableFetchError,
  shouldRetryHttpStatus,
  withAttemptCount
} from "./retry.ts";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const SERPAPI_SEARCH_API_URL = "https://serpapi.com/search.json";
const SEARCH_TIMEOUT_MS = 5_000;
const FAST_FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SEARCH_RETRY_ATTEMPTS = 2;
const FETCH_RETRY_ATTEMPTS = 2;
const SEARCH_USER_AGENT =
  "clanker-conk/0.2 (+web-search-v2; https://github.com/Volpestyle/clanker_conk)";
type ProviderSearchInput = {
  query: string;
  maxResults: number;
  recencyDays: number;
  safeSearch: boolean;
};

type ProviderSearchRow = {
  url: string;
  provider?: string | null;
  [key: string]: string | number | boolean | null | undefined;
};

type ProviderSearchResult = {
  results: ProviderSearchRow[];
};

class AttemptError extends Error {
  attempts;

  constructor(message, attempts) {
    super(message);
    this.attempts = Number(attempts || 1);
  }
}

export class WebSearchService {
  store;
  providers;
  openai;

  constructor({ appConfig, store }) {
    this.store = store;
    this.providers = buildProviders(appConfig);
    this.openai = String(appConfig?.openaiApiKey || "").trim()
      ? new OpenAI({ apiKey: String(appConfig?.openaiApiKey || "").trim() })
      : null;
  }

  isConfigured() {
    return Boolean(this.openai) || this.providers.some((provider) => provider.isConfigured());
  }

  async searchAndRead({
    settings,
    query,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const config = normalizeWebSearchConfig(getResearchRuntimeConfig(settings).localExternalSearch);
    const resolvedStack = resolveAgentStack(settings);
    const normalizedQuery = sanitizeExternalText(query, 220);
    if (!normalizedQuery) {
      return {
        query: "",
        results: [],
        fetchedPages: 0,
        providerUsed: null,
        providerFallbackUsed: false,
        summaryText: ""
      };
    }

    if (resolvedStack.researchRuntime === "openai_native_web_search") {
      return await this.searchWithOpenAiHostedWebSearch({
        settings,
        query: normalizedQuery,
        trace
      });
    }

    const providers = resolveProviderOrder(this.providers, config.providerOrder);
    const primaryProvider = providers[0] || null;
    const secondaryProvider = providers[1] || null;

    if (!primaryProvider) {
      throw new Error("Live search is not configured. Set BRAVE_SEARCH_API_KEY and/or SERPAPI_API_KEY.");
    }

    const started = Date.now();
    let providerUsed = primaryProvider.name;
    let providerFallbackUsed = false;

    try {
      let searchData;
      try {
        searchData = await primaryProvider.search({
          query: normalizedQuery,
          maxResults: config.maxResults,
          recencyDays: config.recencyDaysDefault,
          safeSearch: config.safeSearch
        });
      } catch (error) {
        if (!secondaryProvider) throw error;
        providerFallbackUsed = true;
        providerUsed = secondaryProvider.name;
        searchData = await secondaryProvider.search({
          query: normalizedQuery,
          maxResults: config.maxResults,
          recencyDays: config.recencyDaysDefault,
          safeSearch: config.safeSearch
        });
      }

      const readCandidates = searchData.results.slice(0, config.maxPagesToRead);
      const pageSummaries = await mapConcurrent(readCandidates, config.maxConcurrentFetches, async (item) => {
        try {
          return await this.readPageSummary(item.url, config.maxCharsPerPage);
        } catch (error) {
          this.logSearchError({
            trace,
            query: normalizedQuery,
            provider: providerUsed,
            stage: "fetch",
            attempts: Number(error?.attempts || 1),
            error
          });
          return { error: String(error?.message || error), attempts: Number(error?.attempts || 1) };
        }
      });

      const summaryByUrl = new Map();
      for (let index = 0; index < readCandidates.length; index += 1) {
        summaryByUrl.set(readCandidates[index].url, pageSummaries[index]);
      }

      const results = searchData.results.map((item) => {
        const page = summaryByUrl.get(item.url);
        return {
          ...item,
          provider: item.provider || providerUsed,
          pageTitle: page?.title || null,
          pageSummary: page?.summary || null,
          pageError: page?.error || null,
          extractionMethod: page?.extractionMethod || null
        };
      });

      const fetchedPages = results.filter((row) => row.pageSummary).length;

      this.store.logAction({
        kind: "search_call",
        guildId: trace.guildId,
        channelId: trace.channelId,
        userId: trace.userId,
        content: normalizedQuery,
        metadata: {
          query: normalizedQuery,
          source: trace.source || "unknown",
          maxResults: config.maxResults,
          returnedResults: results.length,
          pageReadsRequested: readCandidates.length,
          pageReadsSucceeded: fetchedPages,
          providerUsed,
          fallbackUsed: providerFallbackUsed,
          latencyMs: Date.now() - started
        }
      });

      return {
        query: normalizedQuery,
        results,
        fetchedPages,
        providerUsed,
        providerFallbackUsed,
        summaryText: ""
      };
    } catch (error) {
      this.logSearchError({
        trace,
        query: normalizedQuery,
        provider: providerUsed,
        stage: "provider",
        attempts: Number(error?.attempts || 1),
        error
      });
      throw error;
    }
  }

  async searchWithOpenAiHostedWebSearch({
    settings,
    query,
    trace
  }) {
    if (!this.openai) {
      throw new Error("OpenAI native web search requires OPENAI_API_KEY.");
    }

    const researchConfig = getResearchRuntimeConfig(settings);
    const nativeConfig = researchConfig.openaiNativeWebSearch as {
      userLocation?: string;
      allowedDomains?: readonly string[];
    };
    const tool = {
      type: "web_search_preview_2025_03_11",
      ...(buildOpenAiWebSearchUserLocation(nativeConfig.userLocation)
        ? { user_location: buildOpenAiWebSearchUserLocation(nativeConfig.userLocation) }
        : {}),
      ...(normalizeAllowedDomains(nativeConfig.allowedDomains).length
        ? {
            filters: {
              allowed_domains: normalizeAllowedDomains(nativeConfig.allowedDomains)
            }
          }
        : {})
    };
    const orchestrator = getResolvedOrchestratorBinding(settings);
    const model =
      String(orchestrator?.provider || "").trim() === "openai" && String(orchestrator?.model || "").trim()
        ? String(orchestrator.model).trim()
        : "gpt-5.2";
    const started = Date.now();
    const response = await this.openai.responses.create({
      model,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: query
        }]
      }],
      tools: [tool],
      include: ["web_search_call.action.sources"]
    });

    const summaryText = normalizeWhitespaceText(String(response.output_text || "").trim(), {
      maxLen: 6_000
    });
    const results = extractOpenAiWebSearchResults(response).slice(
      0,
      Math.max(1, Number(researchConfig.localExternalSearch?.maxResults) || 5)
    );
    const fetchedPages = results.filter((row) => row.pageSummary).length;

    this.store.logAction({
      kind: "search_call",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: query,
      metadata: {
        query,
        source: trace.source || "unknown",
        runtime: "openai_native_web_search",
        returnedResults: results.length,
        pageReadsRequested: 0,
        pageReadsSucceeded: fetchedPages,
        providerUsed: "openai_native_web_search",
        fallbackUsed: false,
        latencyMs: Date.now() - started
      }
    });

    return {
      query,
      results,
      fetchedPages,
      providerUsed: "openai_native_web_search",
      providerFallbackUsed: false,
      summaryText
    };
  }

  async readPageSummary(url, maxChars) {
    const safeUrl = normalizeDiscoveryUrl(url);
    if (!safeUrl) {
      throw new Error(`blocked or invalid page URL: ${url}`);
    }

    await assertPublicUrl(safeUrl);

    const { response, attempts } = await fetchWithRetry({
      request: () =>
        fetch(safeUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": SEARCH_USER_AGENT,
            accept: "text/html,text/plain;q=0.9,*/*;q=0.2"
          },
          signal: AbortSignal.timeout(FAST_FETCH_TIMEOUT_MS)
        }),
      shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
      maxAttempts: FETCH_RETRY_ATTEMPTS
    });

    if (!response.ok) {
      throw new AttemptError(`page fetch HTTP ${response.status}`, attempts);
    }

      const finalUrl = normalizeDiscoveryUrl(response.url);
    if (!finalUrl) {
      throw new AttemptError(`redirected to blocked URL: ${response.url}`, attempts);
    }
    await assertPublicUrl(finalUrl);

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      throw new AttemptError(`unsupported content type: ${contentType || "unknown"}`, attempts);
    }

    const { text: raw, truncated } = await readResponseBodyLimited(response, MAX_RESPONSE_BYTES);
    if (!raw) {
      throw new AttemptError("empty page response", attempts);
    }

    if (contentType.includes("text/plain")) {
      const summary = sanitizeExternalText(raw, maxChars);
      if (!summary) {
        throw new AttemptError("page text had no usable content", attempts);
      }

      return {
        title: null,
        summary,
        attempts,
        extractionMethod: truncated ? "fast_truncated" : "fast"
      };
    }

    const extraction = extractReadableContent(raw, maxChars);
    if (!extraction.summary) {
      throw new AttemptError("HTML page had no usable text", attempts);
    }

    return {
      title: extraction.title,
      summary: extraction.summary,
      attempts,
      extractionMethod: truncated ? "fast_truncated" : "fast"
    };
  }

  logSearchError({ trace, query, provider, stage, attempts, error }) {
    this.store.logAction({
      kind: "search_error",
      guildId: trace.guildId,
      channelId: trace.channelId,
      userId: trace.userId,
      content: String(error?.message || error),
      metadata: {
        query,
        source: trace.source || "unknown",
        provider,
        stage,
        attempts,
        maxAttemptsPerRequest: Math.max(SEARCH_RETRY_ATTEMPTS, FETCH_RETRY_ATTEMPTS)
      }
    });
  }
}

function buildProviders(appConfig) {
  return [
    new BraveSearchProvider(appConfig),
    new SerpApiSearchProvider(appConfig)
  ];
}

function normalizeAllowedDomains(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function buildOpenAiWebSearchUserLocation(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!parts.length) return null;
  const [city = "", region = "", country = ""] = parts;
  return {
    type: "approximate",
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {})
  };
}

function extractOpenAiWebSearchResults(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const results = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "web_search_call") continue;
    const sources = Array.isArray(item?.action?.sources) ? item.action.sources : [];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const url = normalizeDiscoveryUrl(String(source.url || "").trim());
      if (!url) continue;
      let domain = "";
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }
      results.push({
        title: String(source.title || domain || "untitled").trim() || "untitled",
        url,
        domain,
        snippet: normalizeWhitespaceText(String(source.description || source.snippet || "").trim(), { maxLen: 500 }),
        provider: "openai_native_web_search"
      });
    }
  }
  return dedupeOpenAiWebSearchResults(results);
}

function dedupeOpenAiWebSearchResults(results) {
  const deduped = [];
  const seen = new Set();
  for (const result of Array.isArray(results) ? results : []) {
    const url = String(result?.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push(result);
  }
  return deduped;
}

function resolveProviderOrder(providers = [], configuredOrder) {
  const desired = Array.isArray(configuredOrder) && configuredOrder.length
    ? configuredOrder
    : ["brave", "serpapi"];
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const ordered = [];
  for (const key of desired) {
    const provider = byName.get(key);
    if (provider?.isConfigured()) ordered.push(provider);
  }
  for (const provider of providers) {
    if (provider.isConfigured() && !ordered.includes(provider)) {
      ordered.push(provider);
    }
  }
  return ordered;
}

class BraveSearchProvider {
  name;
  apiKey;

  constructor(appConfig) {
    this.name = "brave";
    this.apiKey = String(appConfig?.braveSearchApiKey || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async search(input: ProviderSearchInput): Promise<ProviderSearchResult> {
    const endpoint = new URL(BRAVE_SEARCH_API_URL);
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("count", String(clamp(Number(input.maxResults) || 5, 1, 10)));
    if (input.recencyDays) {
      endpoint.searchParams.set("freshness", `${clamp(Number(input.recencyDays) || 30, 1, 365)}d`);
    }
    endpoint.searchParams.set("safesearch", input.safeSearch ? "strict" : "off");

    const payload = await fetchSearchPayload({
      endpoint,
      headers: {
        "x-subscription-token": this.apiKey,
        accept: "application/json",
        "user-agent": SEARCH_USER_AGENT
      },
      requestLabel: "Brave Search",
      invalidJsonMessage: "Brave Search returned invalid JSON."
    });
    const rawItems = Array.isArray(payload?.web?.results) ? payload.web.results : [];
    return { results: normalizeProviderResults(rawItems, "brave", input.maxResults) };
  }
}

class SerpApiSearchProvider {
  name;
  apiKey;

  constructor(appConfig) {
    this.name = "serpapi";
    this.apiKey = String(appConfig?.serpApiKey || "").trim();
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async search(input: ProviderSearchInput): Promise<ProviderSearchResult> {
    const endpoint = new URL(SERPAPI_SEARCH_API_URL);
    endpoint.searchParams.set("engine", "google");
    endpoint.searchParams.set("q", input.query);
    endpoint.searchParams.set("api_key", this.apiKey);
    endpoint.searchParams.set("num", String(clamp(Number(input.maxResults) || 5, 1, 10)));
    endpoint.searchParams.set("safe", input.safeSearch ? "active" : "off");
    if (input.recencyDays) {
      endpoint.searchParams.set("tbs", `qdr:d${clamp(Number(input.recencyDays) || 30, 1, 365)}`);
    }

    const payload = await fetchSearchPayload({
      endpoint,
      headers: {
        accept: "application/json",
        "user-agent": SEARCH_USER_AGENT
      },
      requestLabel: "SerpApi",
      invalidJsonMessage: "SerpApi returned invalid JSON."
    });
    const rawItems = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
    return { results: normalizeProviderResults(rawItems, "serpapi", input.maxResults) };
  }
}

async function fetchSearchPayload({ endpoint, headers, requestLabel, invalidJsonMessage }) {
  const { response, attempts } = await fetchWithRetry({
    request: () =>
      fetch(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      }),
    shouldRetryResponse: (res) => !res.ok && shouldRetryHttpStatus(res.status),
    maxAttempts: SEARCH_RETRY_ATTEMPTS
  });

  if (!response.ok) {
    throw new AttemptError(`${String(requestLabel || "Search")} HTTP ${response.status}`, attempts);
  }

  return await safeJson(response, attempts, invalidJsonMessage);
}

function normalizeProviderResults(rawItems, provider, maxResults) {
  const seen = new Set();
  const normalized = [];
  for (const entry of rawItems) {
      const normalizedUrl = normalizeDiscoveryUrl(entry?.url || entry?.link || "");
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    normalized.push({
      rank: normalized.length + 1,
      title: sanitizeExternalText(entry?.title || "untitled", 180),
      url: normalizedUrl,
      domain: extractDomain(normalizedUrl),
      snippet: sanitizeExternalText(entry?.description || entry?.snippet || "", 320),
      published: entry?.age || entry?.date || null,
      provider
    });
  }
  return normalized.slice(0, clamp(Number(maxResults) || 5, 1, 10));
}

function normalizeWebSearchConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const maxResultsRaw = Number(cfg.maxResults);
  const maxPagesRaw = Number(cfg.maxPagesToRead);
  const maxCharsRaw = Number(cfg.maxCharsPerPage);
  const maxConcurrentFetches = Number(cfg.maxConcurrentFetches);

  return {
    maxResults: clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10),
    maxPagesToRead: clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 5),
    maxCharsPerPage: clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 6000, 350, 24000),
    safeSearch: cfg.safeSearch !== undefined ? Boolean(cfg.safeSearch) : true,
    recencyDaysDefault: clamp(Number(cfg.recencyDaysDefault) || 30, 1, 365),
    providerOrder: normalizeProviderOrder(cfg.providerOrder),
    maxConcurrentFetches: clamp(Number.isFinite(maxConcurrentFetches) ? maxConcurrentFetches : 5, 1, 10)
  };
}

export function normalizeProviderOrder(order) {
  const allowed = new Set(["brave", "serpapi"]);
  const values = Array.isArray(order) ? order : ["brave", "serpapi"];
  const normalized = [];
  for (const value of values) {
    const key = String(value || "").toLowerCase();
    if (!allowed.has(key) || normalized.includes(key)) continue;
    normalized.push(key);
  }
  if (!normalized.length) {
    return ["brave", "serpapi"];
  }
  return normalized;
}

function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function sanitizeExternalText(value, maxLen = 240) {
  return normalizeWhitespaceText(value, {
    maxLen,
    ellipsis: true
  });
}

async function fetchWithRetry({ request, shouldRetryResponse, maxAttempts }) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await request();
      if (!shouldRetryResponse(response) || attempt >= maxAttempts) {
        return { response, attempts: attempt };
      }
    } catch (error) {
      if (!isRetryableFetchError(error) || attempt >= maxAttempts) {
        throw withAttemptCount(error, attempt);
      }
    }

    await sleep(getRetryDelayMs(attempt));
  }

  throw withAttemptCount(new Error("Web fetch failed after retries."), maxAttempts);
}

async function safeJson(response, attempts, errorMessage) {
  try {
    return await response.json();
  } catch {
    throw new AttemptError(errorMessage, attempts);
  }
}

async function readResponseBodyLimited(response, maxBytes) {
  if (!response.body) {
    return {
      text: "",
      truncated: false
    };
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size >= maxBytes) {
        truncated = true;
        break;
      }
      const remaining = Math.max(0, maxBytes - size);
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        break;
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    text: buffer.toString("utf8"),
    truncated
  };
}

function extractReadableContent(html, maxChars) {
  const title = sanitizeExternalText(extractTitle(html), 120) || null;
  const body = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<\/\s*(p|div|article|section|h1|h2|h3|h4|h5|h6|li|tr|blockquote|pre|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const num = Number.parseInt(hex, 16);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
  const summary = sanitizeExternalText(body, maxChars);
  return { title, summary };
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return String(match?.[1] || "").replace(/\s+/g, " ").trim();
}

async function mapConcurrent(items, limit, mapper) {
  const max = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  // Safe because mapper is always async (does I/O), so cursor is only
  // read/incremented synchronously between awaits on the single JS thread.
  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
  return results;
}
