import {
  isWebSearchOptOutText
} from "./botHelpers.ts";
import {
  getBrowserRuntimeConfig,
  getDiscoverySettings,
  getMemorySettings,
  getResearchRuntimeConfig,
  getResolvedBrowserTaskConfig
} from "../settings/agentStack.ts";
import type { Settings } from "../settings/settingsSchema.ts";
import { clamp } from "../utils.ts";
import { extractHistoryImageCandidates } from "./imageAnalysis.ts";
import type { BudgetContext } from "./botContext.ts";

export type ImageBudgetState = {
  maxPerDay: number;
  used: number;
  remaining: number;
  canGenerate: boolean;
};

export type VideoGenerationBudgetState = {
  maxPerDay: number;
  used: number;
  remaining: number;
  canGenerate: boolean;
};

export type GifBudgetState = {
  maxPerDay: number;
  used: number;
  remaining: number;
  canFetch: boolean;
};

type MediaGenerationCapabilities = {
  simpleImageReady: boolean;
  complexImageReady: boolean;
  videoReady: boolean;
  simpleImageModel: string | null;
  complexImageModel: string | null;
  videoModel: string | null;
};

type WebSearchBudgetState = {
  maxPerHour: number;
  used: number;
  successCount: number;
  errorCount: number;
  remaining: number;
  canSearch: boolean;
};

export type BrowserBudgetState = {
  maxPerHour: number;
  used: number;
  remaining: number;
  canBrowse: boolean;
};

type RecentHistoryMessage = Record<string, unknown>;
type GenericLookupResult = Record<string, unknown>;
type SelectedImageInput = {
  url?: string;
  filename?: string;
  contentType?: string;
  mediaType?: string;
  dataBase64?: string;
};

type HistoryImageCandidate = ReturnType<typeof extractHistoryImageCandidates>[number];

type BuildMemoryLookupContextOptions = {
  settings: Settings;
};

type BuildImageLookupContextOptions = {
  recentMessages?: RecentHistoryMessage[];
  excludedUrls?: string[];
};

type WebSearchContextState = {
  requested: boolean;
  configured: boolean;
  enabled: boolean;
  used: boolean;
  blockedByBudget: boolean;
  optedOutByUser: boolean;
  error: string | null;
  query: string;
  results: GenericLookupResult[];
  fetchedPages: number;
  providerUsed: string | null;
  providerFallbackUsed: boolean;
  budget: WebSearchBudgetState;
};

export type BrowserBrowseContextState = {
  requested: boolean;
  configured: boolean;
  enabled: boolean;
  used: boolean;
  cancelled?: boolean;
  blockedByBudget: boolean;
  error: string | null;
  query: string;
  text: string;
  imageInputs?: SelectedImageInput[];
  steps: number;
  hitStepLimit: boolean;
  budget: BrowserBudgetState;
};

type MemoryLookupContextState = {
  enabled: boolean;
  requested: boolean;
  used: boolean;
  query: string;
  results: GenericLookupResult[];
  error: string | null;
};

type ImageLookupContextState = {
  enabled: boolean;
  requested: boolean;
  used: boolean;
  query: string;
  candidates: HistoryImageCandidate[];
  results: HistoryImageCandidate[];
  selectedImageInputs: SelectedImageInput[];
  error: string | null;
};

const DAY_IN_HOURS = 24;
const DEFAULT_MEDIA_GENERATION_CAPABILITIES: MediaGenerationCapabilities = {
  simpleImageReady: false,
  complexImageReady: false,
  videoReady: false,
  simpleImageModel: null,
  complexImageModel: null,
  videoModel: null
};

function buildWindowStart(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function getImageBudgetState(
  ctx: BudgetContext,
  settings: Settings
): ImageBudgetState {
  const discovery = getDiscoverySettings(settings);
  const maxPerDay = clamp(Number(discovery.maxImagesPerDay) || 0, 0, 200);
  const used = ctx.store.countActionsSince("image_call", buildWindowStart(DAY_IN_HOURS));
  const remaining = Math.max(0, maxPerDay - used);

  return {
    maxPerDay,
    used,
    remaining,
    canGenerate: maxPerDay > 0 && remaining > 0
  };
}

export function getVideoGenerationBudgetState(
  ctx: BudgetContext,
  settings: Settings
): VideoGenerationBudgetState {
  const discovery = getDiscoverySettings(settings);
  const maxPerDay = clamp(Number(discovery.maxVideosPerDay) || 0, 0, 120);
  const used = ctx.store.countActionsSince("video_call", buildWindowStart(DAY_IN_HOURS));
  const remaining = Math.max(0, maxPerDay - used);

  return {
    maxPerDay,
    used,
    remaining,
    canGenerate: maxPerDay > 0 && remaining > 0
  };
}

export function getGifBudgetState(
  ctx: BudgetContext,
  settings: Settings
): GifBudgetState {
  const discovery = getDiscoverySettings(settings);
  const maxPerDay = clamp(Number(discovery.maxGifsPerDay) || 0, 0, 300);
  const used = ctx.store.countActionsSince("gif_call", buildWindowStart(DAY_IN_HOURS));
  const remaining = Math.max(0, maxPerDay - used);

  return {
    maxPerDay,
    used,
    remaining,
    canFetch: maxPerDay > 0 && remaining > 0
  };
}

export function getMediaGenerationCapabilities(
  ctx: BudgetContext,
  settings: Settings
): MediaGenerationCapabilities {
  if (typeof ctx.llm?.getMediaGenerationCapabilities !== "function") {
    return DEFAULT_MEDIA_GENERATION_CAPABILITIES;
  }

  return ctx.llm.getMediaGenerationCapabilities(settings);
}

export function isImageGenerationReady(
  ctx: BudgetContext,
  settings: Settings,
  variant = "any"
) {
  const normalizedVariant =
    variant === "simple" || variant === "complex" || variant === "any"
      ? variant
      : "any";
  return Boolean(ctx.llm?.isImageGenerationReady?.(settings, normalizedVariant));
}

export function isVideoGenerationReady(
  ctx: BudgetContext,
  settings: Settings
) {
  return Boolean(ctx.llm?.isVideoGenerationReady?.(settings));
}

export function getWebSearchBudgetState(
  ctx: BudgetContext,
  settings: Settings
): WebSearchBudgetState {
  const research = getResearchRuntimeConfig(settings);
  const maxPerHour = clamp(Number(research.maxSearchesPerHour) || 0, 0, 120);
  const since1h = buildWindowStart(1);
  const successCount = ctx.store.countActionsSince("search_call", since1h);
  const errorCount = ctx.store.countActionsSince("search_error", since1h);
  const used = successCount + errorCount;
  const remaining = Math.max(0, maxPerHour - used);

  return {
    maxPerHour,
    used,
    successCount,
    errorCount,
    remaining,
    canSearch: maxPerHour > 0 && remaining > 0
  };
}

function getBrowserBudgetState(
  ctx: BudgetContext,
  settings: Settings
): BrowserBudgetState {
  const browser = getBrowserRuntimeConfig(settings);
  const maxPerHour = clamp(Number(browser.localBrowserAgent?.maxBrowseCallsPerHour) || 0, 0, 60);
  const used = ctx.store.countActionsSince("browser_browse_call", buildWindowStart(1));
  const remaining = Math.max(0, maxPerHour - used);

  return {
    maxPerHour,
    used,
    remaining,
    canBrowse: maxPerHour > 0 && remaining > 0
  };
}

export function buildWebSearchContext(
  ctx: BudgetContext,
  settings: Settings,
  messageText: string
): WebSearchContextState {
  const text = String(messageText || "");
  const configured = Boolean(ctx.search?.isConfigured?.());
  const enabled = Boolean(getResearchRuntimeConfig(settings).enabled);
  const budget = getWebSearchBudgetState(ctx, settings);

  return {
    requested: false,
    configured,
    enabled,
    used: false,
    blockedByBudget: false,
    optedOutByUser: isWebSearchOptOutText(text),
    error: null,
    query: "",
    results: [],
    fetchedPages: 0,
    providerUsed: null,
    providerFallbackUsed: false,
    budget
  };
}

export function buildBrowserBrowseContext(
  ctx: BudgetContext,
  settings: Settings
): BrowserBrowseContextState {
  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  const computerUseClient =
    browserTaskConfig.runtime === "openai_computer_use"
      ? ctx.llm?.getComputerUseClient?.(browserTaskConfig.openaiComputerUse.client)
      : null;
  const configured = Boolean(
    ctx.browserManager &&
    (browserTaskConfig.runtime !== "openai_computer_use" || computerUseClient?.client)
  );
  const enabled = Boolean(getBrowserRuntimeConfig(settings).enabled);
  const budget = getBrowserBudgetState(ctx, settings);

  return {
    requested: false,
    configured,
    enabled,
    used: false,
    blockedByBudget: false,
    error: null,
    query: "",
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    budget
  };
}

export function buildMemoryLookupContext(
  ctx: BudgetContext,
  { settings }: BuildMemoryLookupContextOptions
): MemoryLookupContextState {
  const enabled = Boolean(getMemorySettings(settings).enabled && ctx.memory.searchDurableFacts);

  return {
    enabled,
    requested: false,
    used: false,
    query: "",
    results: [],
    error: null
  };
}

export function buildImageLookupContext(
  ctx: BudgetContext,
  {
    recentMessages = [],
    excludedUrls = []
  }: BuildImageLookupContextOptions = {}
): ImageLookupContextState {
  const excluded = new Set(
    (Array.isArray(excludedUrls) ? excludedUrls : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const candidates = extractHistoryImageCandidates({
    recentMessages,
    excluded,
    imageCaptionCache: ctx.imageCaptionCache
  });

  return {
    enabled: true,
    requested: false,
    used: false,
    query: "",
    candidates,
    results: [],
    selectedImageInputs: [],
    error: null
  };
}
