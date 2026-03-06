import {
  MAX_BROWSER_BROWSE_QUERY_LEN,
  MAX_IMAGE_LOOKUP_QUERY_LEN,
  MAX_MEMORY_LOOKUP_QUERY_LEN,
  MAX_WEB_QUERY_LEN,
  normalizeDirectiveText,
  parseStructuredReplyOutput
} from "../botHelpers.ts";
import { getFollowupSettings, getResolvedFollowupBinding } from "../settings/agentStack.ts";
import { deepMerge } from "../utils.ts";

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

type MemoryLookupState = {
  enabled?: boolean;
  requested?: boolean;
  query?: string;
  used?: boolean;
  results?: unknown[];
  error?: string | null;
  [key: string]: unknown;
};

type BrowserBrowseState = {
  configured?: boolean;
  enabled?: boolean;
  requested?: boolean;
  query?: string;
  used?: boolean;
  blockedByBudget?: boolean;
  text?: string;
  steps?: number;
  hitStepLimit?: boolean;
  error?: string | null;
  budget?: {
    canBrowse?: boolean;
  };
  [key: string]: unknown;
};

type ImageLookupState = {
  enabled?: boolean;
  requested?: boolean;
  query?: string;
  used?: boolean;
  candidates?: unknown[];
  results?: unknown[];
  selectedImageInputs?: Array<Record<string, unknown>>;
  error?: string | null;
  [key: string]: unknown;
};

type ReplyDirectiveShape = ReturnType<typeof parseStructuredReplyOutput>;

type ReplyGenerationShape = {
  text: string;
  [key: string]: unknown;
};

type ReplyFollowupPromptPayload = {
  webSearch: WebSearchState | null;
  browserBrowse: BrowserBrowseState | null;
  memoryLookup: MemoryLookupState;
  imageLookup: ImageLookupState | null;
  imageInputs: Array<Record<string, unknown>>;
  allowWebSearchDirective: boolean;
  allowBrowserBrowseDirective: boolean;
  allowMemoryLookupDirective: boolean;
  allowImageLookupDirective: boolean;
};

type ReplyFollowupLoopLimits = {
  maxSteps: number;
  maxTotalToolCalls: number;
  maxWebSearchCalls: number;
  maxMemoryLookupCalls: number;
  maxImageLookupCalls: number;
  toolTimeoutMs: number;
};

const DEFAULT_FOLLOWUP_MAX_STEPS = 2;
const DEFAULT_FOLLOWUP_MAX_TOTAL_TOOL_CALLS = 3;
const DEFAULT_FOLLOWUP_MAX_WEB_SEARCH_CALLS = 2;
const DEFAULT_FOLLOWUP_MAX_MEMORY_LOOKUP_CALLS = 2;
const DEFAULT_FOLLOWUP_MAX_IMAGE_LOOKUP_CALLS = 2;
const DEFAULT_FOLLOWUP_TOOL_TIMEOUT_MS = 10_000;

function clampFollowupInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function resolveReplyFollowupLoopLimits(settings, loopConfig = null): ReplyFollowupLoopLimits {
  const followupConfig = getFollowupSettings(settings);
  const overrides = loopConfig && typeof loopConfig === "object" ? loopConfig : {};
  return {
    maxSteps: clampFollowupInt(
      overrides.maxSteps ?? followupConfig.toolBudget?.maxToolSteps,
      DEFAULT_FOLLOWUP_MAX_STEPS,
      0,
      6
    ),
    maxTotalToolCalls: clampFollowupInt(
      overrides.maxTotalToolCalls ?? followupConfig.toolBudget?.maxTotalToolCalls,
      DEFAULT_FOLLOWUP_MAX_TOTAL_TOOL_CALLS,
      0,
      12
    ),
    maxWebSearchCalls: clampFollowupInt(
      overrides.maxWebSearchCalls ?? followupConfig.toolBudget?.maxWebSearchCalls,
      DEFAULT_FOLLOWUP_MAX_WEB_SEARCH_CALLS,
      0,
      6
    ),
    maxMemoryLookupCalls: clampFollowupInt(
      overrides.maxMemoryLookupCalls ?? followupConfig.toolBudget?.maxMemoryLookupCalls,
      DEFAULT_FOLLOWUP_MAX_MEMORY_LOOKUP_CALLS,
      0,
      6
    ),
    maxImageLookupCalls: clampFollowupInt(
      overrides.maxImageLookupCalls ?? followupConfig.toolBudget?.maxImageLookupCalls,
      DEFAULT_FOLLOWUP_MAX_IMAGE_LOOKUP_CALLS,
      0,
      6
    ),
    toolTimeoutMs: clampFollowupInt(
      overrides.toolTimeoutMs ?? followupConfig.toolBudget?.toolTimeoutMs,
      DEFAULT_FOLLOWUP_TOOL_TIMEOUT_MS,
      0,
      60_000
    )
  };
}

function normalizeLookupQuery(text, maxLen) {
  return normalizeDirectiveText(text, maxLen);
}

function buildSuppressedLookupState<T extends Record<string, unknown>>(
  baseState: T,
  query: string,
  reason: string
): T {
  return {
    ...baseState,
    requested: true,
    query,
    used: false,
    error: reason
  } as T;
}

async function runWithOptionalTimeout<T>(task: () => Promise<T>, timeoutMs = 0, onTimeout: () => T): Promise<T> {
  const boundedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  if (!boundedTimeoutMs) return await task();

  const timeoutPromise = new Promise<T>((resolve) => {
    setTimeout(() => {
      resolve(onTimeout());
    }, Math.max(50, boundedTimeoutMs));
  });
  return await Promise.race([task(), timeoutPromise]);
}

export function resolveReplyFollowupGenerationSettings(settings) {
  const followupConfig = getFollowupSettings(settings);
  if (!followupConfig.enabled) return settings;

  const binding = getResolvedFollowupBinding(settings);
  const provider = String(binding.provider || "").trim();
  const model = String(binding.model || "").trim();
  if (!provider || !model) return settings;

  return deepMerge(deepMerge({}, settings), {
    agentStack: {
      overrides: {
        orchestrator: {
          provider,
          model
        }
      }
    }
  });
}

export async function runModelRequestedWebSearch<T extends WebSearchState>(runtime, {
  settings,
  webSearch,
  query,
  trace = {}
}: {
  settings: Record<string, unknown>;
  webSearch: T;
  query: string;
  trace?: ReplyFollowupTrace;
}): Promise<T> {
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
      trace
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

export async function runModelRequestedWebSearchWithTimeout<T extends WebSearchState>({
  runSearch,
  webSearch,
  query,
  timeoutMs = null
}: {
  runSearch: () => Promise<T>;
  webSearch: T;
  query: string;
  timeoutMs?: number | null;
}): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_WEB_QUERY_LEN);
  const baseState = {
    ...webSearch,
    requested: true,
    query: normalizedQuery,
    used: false
  } as T;
  const resolvedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));

  if (!resolvedTimeoutMs) {
    try {
      return await runSearch();
    } catch (error) {
      return {
        ...baseState,
        error: String(error?.message || error || "web lookup failed")
      } as T;
    }
  }

  type WebSearchSuccess<U> = {
    ok: true;
    value: U;
  };
  type WebSearchFailure = {
    ok: false;
    error: Error;
  };
  type WebSearchTimeout = {
    ok: false;
    timeout: true;
  };

  const runPromise = Promise.resolve(runSearch()).then(
    (value): WebSearchSuccess<T> => ({ ok: true, value }),
    (error): WebSearchFailure => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  );
  const timeoutPromise = new Promise<WebSearchTimeout>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, timeout: true });
    }, Math.max(50, resolvedTimeoutMs));
  });

  const result = await Promise.race<WebSearchSuccess<T> | WebSearchFailure | WebSearchTimeout>([
    runPromise,
    timeoutPromise
  ]);
  if (result?.ok) return result.value;
  if ("timeout" in result && result.timeout) {
    return {
      ...baseState,
      error: `web lookup timed out after ${Math.max(50, resolvedTimeoutMs)}ms`
    } as T;
  }
  return {
    ...baseState,
    error: "error" in result
      ? String(result.error?.message || result.error || "web lookup failed")
      : "web lookup failed"
  } as T;
}

async function runModelRequestedMemoryLookup<T extends MemoryLookupState>(runtime, {
  settings,
  memoryLookup,
  query,
  guildId,
  channelId = null,
  trace = {}
}: {
  settings: Record<string, unknown>;
  memoryLookup: T;
  query: string;
  guildId: string;
  channelId?: string | null;
  trace?: ReplyFollowupTrace;
}): Promise<T> {
  const normalizedQuery = normalizeDirectiveText(query, MAX_MEMORY_LOOKUP_QUERY_LEN);
  const state = {
    ...memoryLookup,
    requested: true,
    query: normalizedQuery
  } as T;

  if (!state.enabled || !runtime.memory?.searchDurableFacts) {
    return state;
  }
  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing memory lookup query."
    } as T;
  }
  if (!guildId) {
    return {
      ...state,
      error: "Memory lookup requires guild scope."
    } as T;
  }

  try {
    const results = await runtime.memory.searchDurableFacts({
      guildId: String(guildId),
      channelId: String(channelId || "").trim() || null,
      queryText: normalizedQuery,
      settings,
      trace: {
        ...trace,
        source: "model_memory_lookup"
      },
      limit: 10
    });
    return {
      ...state,
      used: Boolean(results.length),
      results
    } as T;
  } catch (error) {
    return {
      ...state,
      error: String(error?.message || error)
    } as T;
  }
}

export async function maybeRegenerateWithMemoryLookup<
  TGeneration extends ReplyGenerationShape,
  TDirective extends ReplyDirectiveShape,
  TWebSearch extends WebSearchState | null,
  TBrowserBrowse extends BrowserBrowseState | null,
  TMemoryLookup extends MemoryLookupState,
  TImageLookup extends ImageLookupState | null
>(runtime, {
  settings,
  followupSettings = null,
  systemPrompt,
  generation,
  directive,
  webSearch = null,
  browserBrowse = null,
  memoryLookup,
  imageLookup = null,
  guildId,
  channelId = null,
  trace = {},
  mediaPromptLimit,
  imageInputs = null,
  forceRegenerate = false,
  buildUserPrompt,
  runModelRequestedWebSearch,
  runModelRequestedBrowserBrowse,
  runModelRequestedImageLookup,
  mergeImageInputs,
  maxModelImageInputs,
  jsonSchema = "",
  loopConfig = null
}: {
  settings: Record<string, unknown>;
  followupSettings?: Record<string, unknown> | null;
  systemPrompt: string;
  generation: TGeneration;
  directive: TDirective;
  webSearch?: TWebSearch;
  browserBrowse?: TBrowserBrowse;
  memoryLookup: TMemoryLookup;
  imageLookup?: TImageLookup;
  guildId: string;
  channelId?: string | null;
  trace?: ReplyFollowupTrace;
  mediaPromptLimit: number;
  imageInputs?: Array<Record<string, unknown>> | null;
  forceRegenerate?: boolean;
  buildUserPrompt: (payload: ReplyFollowupPromptPayload) => string;
  runModelRequestedWebSearch?: (payload: {
    webSearch: TWebSearch;
    query: string;
    step: number;
  }) => Promise<TWebSearch>;
  runModelRequestedBrowserBrowse?: (payload: {
    browserBrowse: TBrowserBrowse;
    query: string;
    step: number;
  }) => Promise<TBrowserBrowse>;
  runModelRequestedImageLookup?: (payload: {
    imageLookup: TImageLookup;
    query: string;
    step: number;
  }) => Promise<TImageLookup>;
  mergeImageInputs?: (payload: {
    baseInputs: Array<Record<string, unknown>>;
    extraInputs: Array<Record<string, unknown>>;
    maxInputs: number;
  }) => Array<Record<string, unknown>>;
  maxModelImageInputs: number;
  jsonSchema?: string;
  loopConfig?: {
    maxSteps?: number;
    maxTotalToolCalls?: number;
    maxWebSearchCalls?: number;
    maxMemoryLookupCalls?: number;
    maxImageLookupCalls?: number;
    toolTimeoutMs?: number | null;
  } | null;
}) {
  const limits = resolveReplyFollowupLoopLimits(settings, loopConfig);
  let nextWebSearch = webSearch;
  let nextBrowserBrowse = browserBrowse;
  let nextMemoryLookup = memoryLookup;
  let nextImageLookup = imageLookup;
  let nextGeneration = generation;
  let nextDirective = directive;
  let usedWebSearch = false;
  let usedBrowserBrowse = false;
  let usedMemoryLookup = false;
  let usedImageLookup = false;
  let nextImageInputs = Array.isArray(imageInputs) ? [...imageInputs] : [];
  const seenWebQueries = new Set<string>();
  const seenBrowserQueries = new Set<string>();
  const seenMemoryQueries = new Set<string>();
  const seenImageQueries = new Set<string>();
  let followupRegenerations = 0;
  let webSearchCalls = 0;
  let browserBrowseCalls = 0;
  let memoryLookupCalls = 0;
  let imageLookupCalls = 0;
  let totalToolCalls = 0;
  let forceNextRegenerate = Boolean(forceRegenerate);
  const normalizedJsonSchema = String(jsonSchema || "").trim();

  while (followupRegenerations < limits.maxSteps && typeof buildUserPrompt === "function") {
    const requestedWebQuery = normalizeLookupQuery(nextDirective?.webSearchQuery, MAX_WEB_QUERY_LEN);
    const requestedBrowserQuery = normalizeLookupQuery(nextDirective?.browserBrowseQuery, MAX_BROWSER_BROWSE_QUERY_LEN);
    const requestedMemoryQuery = normalizeLookupQuery(nextDirective?.memoryLookupQuery, MAX_MEMORY_LOOKUP_QUERY_LEN);
    const requestedImageQuery = normalizeLookupQuery(nextDirective?.imageLookupQuery, MAX_IMAGE_LOOKUP_QUERY_LEN);
    let shouldRegenerate = forceNextRegenerate;
    const toolTasks: Array<Promise<void>> = [];

    if (requestedWebQuery && nextWebSearch && typeof runModelRequestedWebSearch === "function") {
      const canRun =
        webSearchCalls < limits.maxWebSearchCalls &&
        totalToolCalls < limits.maxTotalToolCalls &&
        !seenWebQueries.has(requestedWebQuery);
      if (canRun) {
        const currentStep = followupRegenerations + 1;
        toolTasks.push(
          (async () => {
            const nextState = await runWithOptionalTimeout(
              async () =>
                await runModelRequestedWebSearch({
                  webSearch: nextWebSearch,
                  query: requestedWebQuery,
                  step: currentStep
                }),
              limits.toolTimeoutMs,
              () =>
                buildSuppressedLookupState(
                  nextWebSearch as Record<string, unknown>,
                  requestedWebQuery,
                  `web lookup timed out after ${Math.max(50, limits.toolTimeoutMs)}ms`
                ) as TWebSearch
            );
            nextWebSearch = nextState;
            usedWebSearch = true;
          })()
        );
        seenWebQueries.add(requestedWebQuery);
        webSearchCalls += 1;
        totalToolCalls += 1;
        shouldRegenerate = true;
      } else {
        nextWebSearch = buildSuppressedLookupState(
          nextWebSearch as Record<string, unknown>,
          requestedWebQuery,
          seenWebQueries.has(requestedWebQuery)
            ? "Duplicate web lookup query suppressed in this turn."
            : "Web lookup cap reached for this turn."
        ) as TWebSearch;
        shouldRegenerate = true;
      }
    }

    if (
      requestedBrowserQuery &&
      nextBrowserBrowse &&
      typeof runModelRequestedBrowserBrowse === "function"
    ) {
      const canRun =
        browserBrowseCalls < 1 &&
        totalToolCalls < limits.maxTotalToolCalls &&
        !seenBrowserQueries.has(requestedBrowserQuery);
      if (canRun) {
        const currentStep = followupRegenerations + 1;
        toolTasks.push(
          (async () => {
            const nextState = await runWithOptionalTimeout(
              async () =>
                await runModelRequestedBrowserBrowse({
                  browserBrowse: nextBrowserBrowse,
                  query: requestedBrowserQuery,
                  step: currentStep
                }),
              limits.toolTimeoutMs,
              () =>
                buildSuppressedLookupState(
                  nextBrowserBrowse as Record<string, unknown>,
                  requestedBrowserQuery,
                  `browser browse timed out after ${Math.max(50, limits.toolTimeoutMs)}ms`
                ) as TBrowserBrowse
            );
            nextBrowserBrowse = nextState as TBrowserBrowse;
            usedBrowserBrowse = true;
          })()
        );
        seenBrowserQueries.add(requestedBrowserQuery);
        browserBrowseCalls += 1;
        totalToolCalls += 1;
        shouldRegenerate = true;
      } else {
        nextBrowserBrowse = buildSuppressedLookupState(
          nextBrowserBrowse as Record<string, unknown>,
          requestedBrowserQuery,
          seenBrowserQueries.has(requestedBrowserQuery)
            ? "Duplicate browser browse query suppressed in this turn."
            : "Browser browse cap reached for this turn."
        ) as TBrowserBrowse;
        shouldRegenerate = true;
      }
    }

    if (requestedMemoryQuery) {
      const canRun =
        memoryLookupCalls < limits.maxMemoryLookupCalls &&
        totalToolCalls < limits.maxTotalToolCalls &&
        !seenMemoryQueries.has(requestedMemoryQuery);
      if (canRun) {
        toolTasks.push(
          (async () => {
            const nextState = await runWithOptionalTimeout(
              async () =>
                await runModelRequestedMemoryLookup(runtime, {
                  settings,
                  memoryLookup: nextMemoryLookup,
                  query: requestedMemoryQuery,
                  guildId,
                  channelId,
                  trace
                }),
              limits.toolTimeoutMs,
              () =>
                buildSuppressedLookupState(
                  nextMemoryLookup as Record<string, unknown>,
                  requestedMemoryQuery,
                  `memory lookup timed out after ${Math.max(50, limits.toolTimeoutMs)}ms`
                ) as TMemoryLookup
            );
            nextMemoryLookup = nextState as TMemoryLookup;
            usedMemoryLookup = true;
          })()
        );
        seenMemoryQueries.add(requestedMemoryQuery);
        memoryLookupCalls += 1;
        totalToolCalls += 1;
        shouldRegenerate = true;
      } else {
        nextMemoryLookup = buildSuppressedLookupState(
          nextMemoryLookup as Record<string, unknown>,
          requestedMemoryQuery,
          seenMemoryQueries.has(requestedMemoryQuery)
            ? "Duplicate memory lookup query suppressed in this turn."
            : "Memory lookup cap reached for this turn."
        ) as TMemoryLookup;
        shouldRegenerate = true;
      }
    }

    if (
      requestedImageQuery &&
      nextImageLookup &&
      typeof runModelRequestedImageLookup === "function"
    ) {
      const canRun =
        imageLookupCalls < limits.maxImageLookupCalls &&
        totalToolCalls < limits.maxTotalToolCalls &&
        !seenImageQueries.has(requestedImageQuery);
      if (canRun) {
        const currentStep = followupRegenerations + 1;
        toolTasks.push(
          (async () => {
            const nextState = await runWithOptionalTimeout(
              async () =>
                await runModelRequestedImageLookup({
                  imageLookup: nextImageLookup,
                  query: requestedImageQuery,
                  step: currentStep
                }),
              limits.toolTimeoutMs,
              () =>
                buildSuppressedLookupState(
                  nextImageLookup as Record<string, unknown>,
                  requestedImageQuery,
                  `image lookup timed out after ${Math.max(50, limits.toolTimeoutMs)}ms`
                ) as TImageLookup
            );
            nextImageLookup = nextState as TImageLookup;
            usedImageLookup = true;
            if (
              Array.isArray(nextImageLookup?.selectedImageInputs) &&
              nextImageLookup.selectedImageInputs.length &&
              typeof mergeImageInputs === "function"
            ) {
              nextImageInputs = mergeImageInputs({
                baseInputs: nextImageInputs,
                extraInputs: nextImageLookup.selectedImageInputs,
                maxInputs: maxModelImageInputs
              });
            }
          })()
        );
        seenImageQueries.add(requestedImageQuery);
        imageLookupCalls += 1;
        totalToolCalls += 1;
        shouldRegenerate = true;
      } else {
        nextImageLookup = buildSuppressedLookupState(
          nextImageLookup as Record<string, unknown>,
          requestedImageQuery,
          seenImageQueries.has(requestedImageQuery)
            ? "Duplicate image lookup query suppressed in this turn."
            : "Image lookup cap reached for this turn."
        ) as TImageLookup;
        shouldRegenerate = true;
      }
    }

    if (toolTasks.length) {
      await Promise.all(toolTasks);
    }
    if (!shouldRegenerate) break;

    const allowWebSearchDirective =
      Boolean(nextWebSearch && typeof runModelRequestedWebSearch === "function") &&
      webSearchCalls < limits.maxWebSearchCalls &&
      totalToolCalls < limits.maxTotalToolCalls;
    const allowBrowserBrowseDirective =
      Boolean(nextBrowserBrowse && typeof runModelRequestedBrowserBrowse === "function") &&
      browserBrowseCalls < 1 &&
      totalToolCalls < limits.maxTotalToolCalls;
    const allowMemoryLookupDirective =
      memoryLookupCalls < limits.maxMemoryLookupCalls &&
      totalToolCalls < limits.maxTotalToolCalls;
    const allowImageLookupDirective =
      Boolean(nextImageLookup && typeof runModelRequestedImageLookup === "function") &&
      imageLookupCalls < limits.maxImageLookupCalls &&
      totalToolCalls < limits.maxTotalToolCalls;

    const followupPrompt = buildUserPrompt({
      webSearch: nextWebSearch,
      browserBrowse: nextBrowserBrowse,
      memoryLookup: nextMemoryLookup,
      imageLookup: nextImageLookup,
      imageInputs: nextImageInputs,
      allowWebSearchDirective,
      allowBrowserBrowseDirective,
      allowMemoryLookupDirective,
      allowImageLookupDirective
    });
    const followupTrace = {
      ...trace,
      event: String(trace?.event || "llm_followup")
        .trim()
        .concat(`:lookup_followup:${followupRegenerations + 1}`)
    };
    const generationPayload: {
      settings: Record<string, unknown>;
      systemPrompt: string;
      userPrompt: string;
      trace: ReplyFollowupTrace;
      imageInputs?: Array<Record<string, unknown>>;
      jsonSchema?: string;
    } = {
      settings: followupSettings || settings,
      systemPrompt,
      userPrompt: followupPrompt,
      trace: followupTrace
    };
    if (nextImageInputs.length) {
      generationPayload.imageInputs = nextImageInputs;
    }
    if (normalizedJsonSchema) {
      generationPayload.jsonSchema = normalizedJsonSchema;
    }
    nextGeneration = await runtime.llm.generate(generationPayload) as TGeneration;
    nextDirective = parseStructuredReplyOutput(
      String(nextGeneration.text || ""),
      mediaPromptLimit
    ) as TDirective;
    followupRegenerations += 1;
    forceNextRegenerate = false;
  }

  return {
    generation: nextGeneration,
    directive: nextDirective,
    webSearch: nextWebSearch,
    browserBrowse: nextBrowserBrowse,
    memoryLookup: nextMemoryLookup,
    imageLookup: nextImageLookup,
    imageInputs: nextImageInputs,
    regenerated: followupRegenerations > 0,
    followupSteps: followupRegenerations,
    usedWebSearch,
    usedBrowserBrowse,
    usedMemoryLookup,
    usedImageLookup
  };
}
