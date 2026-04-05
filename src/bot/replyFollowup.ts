import { MAX_WEB_QUERY_LEN, normalizeDirectiveText } from "./botHelpers.ts";

type ReplyFollowupTrace = Record<string, unknown> & {
  event?: string;
  source?: string;
};

type WebSearchState = {
  requested?: boolean;
  query?: string;
  optedOutByUser?: boolean;
  enabled?: boolean;
  configured?: boolean;
  used?: boolean;
  blockedByBudget?: boolean;
  error?: string | null;
  results?: unknown[];
  fetchedPages?: number;
  providerUsed?: string | null;
  providerFallbackUsed?: boolean;
  summaryText?: string;
  budget?: {
    canSearch?: boolean;
  };
  [key: string]: unknown;
};

export async function runModelRequestedWebSearch<T extends WebSearchState>(
  runtime,
  {
    settings,
    webSearch,
    query,
    trace = {},
    signal
  }: {
    settings: Record<string, unknown>;
    webSearch: T;
    query: string;
    trace?: ReplyFollowupTrace;
    signal?: AbortSignal;
  }
): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
  const state = {
    ...webSearch,
    requested: true,
    query: normalizedQuery
  } as T;

  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing web search query."
    } as T;
  }

  if (state.optedOutByUser || !state.enabled || !state.configured) {
    return state;
  }

  if (!state.budget?.canSearch) {
    return {
      ...state,
      blockedByBudget: true
    } as T;
  }

  try {
    const result = await runtime.search.searchAndRead({
      settings,
      query: normalizedQuery,
      trace,
      signal
    });

    return {
      ...state,
      used: result.results.length > 0,
      query: result.query,
      results: result.results,
      fetchedPages: result.fetchedPages || 0,
      providerUsed: result.providerUsed || null,
      providerFallbackUsed: Boolean(result.providerFallbackUsed),
      summaryText: String(result.summaryText || "").trim()
    } as T;
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    } as T;
  }
}
