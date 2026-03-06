import {
  MAX_VIDEO_FALLBACK_MESSAGES,
  MAX_VIDEO_TARGET_SCAN,
  extractRecentVideoTargets,
  isWebSearchOptOutText,
  looksLikeVideoFollowupMessage
} from "../botHelpers.ts";
import {
  getBrowserRuntimeConfig,
  getDiscoverySettings,
  getMemorySettings,
  getResearchRuntimeConfig,
  getResolvedBrowserTaskConfig,
  getVideoContextSettings
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

export type MediaGenerationCapabilities = {
  simpleImageReady: boolean;
  complexImageReady: boolean;
  videoReady: boolean;
  simpleImageModel: string | null;
  complexImageModel: string | null;
  videoModel: string | null;
};

export type WebSearchBudgetState = {
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

export type VideoContextBudgetState = {
  maxPerHour: number;
  used: number;
  successCount: number;
  errorCount: number;
  remaining: number;
  canLookup: boolean;
};

type TraceContext = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type RecentHistoryMessage = Record<string, unknown>;
type GenericLookupResult = Record<string, unknown>;
type SelectedImageInput = {
  url?: string;
  filename?: string;
  contentType?: string;
};

type VideoReplyMessageLike = {
  content?: string | null;
  attachments?: {
    size?: number;
    values?: () => IterableIterator<unknown>;
  } | null;
  embeds?: unknown[] | null;
};

type HistoryImageCandidate = ReturnType<typeof extractHistoryImageCandidates>[number];

type BuildVideoReplyContextOptions = {
  settings: Settings;
  message: VideoReplyMessageLike;
  recentMessages?: RecentHistoryMessage[];
  trace?: TraceContext;
};

type BuildMemoryLookupContextOptions = {
  settings: Settings;
};

type BuildImageLookupContextOptions = {
  recentMessages?: RecentHistoryMessage[];
  excludedUrls?: string[];
};

export type VideoReplyContextState = {
  requested: boolean;
  enabled: boolean;
  used: boolean;
  blockedByBudget: boolean;
  error: string | null;
  errors: GenericLookupResult[];
  detectedVideos: number;
  detectedFromRecentMessages: boolean;
  videos: GenericLookupResult[];
  frameImages: GenericLookupResult[];
  budget: VideoContextBudgetState;
};

export type WebSearchContextState = {
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
  blockedByBudget: boolean;
  error: string | null;
  query: string;
  text: string;
  steps: number;
  hitStepLimit: boolean;
  budget: BrowserBudgetState;
};

export type MemoryLookupContextState = {
  enabled: boolean;
  requested: boolean;
  used: boolean;
  query: string;
  results: GenericLookupResult[];
  error: string | null;
};

export type ImageLookupContextState = {
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

export function getBrowserBudgetState(
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

export function getVideoContextBudgetState(
  ctx: BudgetContext,
  settings: Settings
): VideoContextBudgetState {
  const videoContext = getVideoContextSettings(settings);
  const maxPerHour = clamp(Number(videoContext.maxLookupsPerHour) || 0, 0, 120);
  const since1h = buildWindowStart(1);
  const successCount = ctx.store.countActionsSince("video_context_call", since1h);
  const errorCount = ctx.store.countActionsSince("video_context_error", since1h);
  const used = successCount + errorCount;
  const remaining = Math.max(0, maxPerHour - used);

  return {
    maxPerHour,
    used,
    successCount,
    errorCount,
    remaining,
    canLookup: maxPerHour > 0 && remaining > 0
  };
}

export async function buildVideoReplyContext(
  ctx: BudgetContext,
  {
    settings,
    message,
    recentMessages = [],
    trace = {}
  }: BuildVideoReplyContextOptions
): Promise<VideoReplyContextState> {
  const videoContextSettings = getVideoContextSettings(settings);
  const messageText = String(message?.content || "");
  const enabled = Boolean(videoContextSettings.enabled);
  const budget = getVideoContextBudgetState(ctx, settings);
  const maxVideosPerMessage = clamp(Number(videoContextSettings.maxVideosPerMessage) || 0, 0, 6);
  const maxTranscriptChars = clamp(Number(videoContextSettings.maxTranscriptChars) || 1200, 200, 4000);
  const keyframeIntervalSeconds = clamp(Number(videoContextSettings.keyframeIntervalSeconds) || 0, 0, 120);
  const maxKeyframesPerVideo = clamp(Number(videoContextSettings.maxKeyframesPerVideo) || 0, 0, 8);
  const allowAsrFallback = Boolean(videoContextSettings.allowAsrFallback);
  const maxAsrSeconds = clamp(Number(videoContextSettings.maxAsrSeconds) || 120, 15, 600);

  const base: VideoReplyContextState = {
    requested: false,
    enabled,
    used: false,
    blockedByBudget: false,
    error: null,
    errors: [],
    detectedVideos: 0,
    detectedFromRecentMessages: false,
    videos: [],
    frameImages: [],
    budget
  };

  const videoService = ctx.video;
  if (
    !videoService ||
    typeof videoService.extractMessageTargets !== "function" ||
    typeof videoService.fetchContexts !== "function"
  ) {
    return base;
  }

  const directTargets = videoService.extractMessageTargets(message, MAX_VIDEO_TARGET_SCAN);
  const fallbackTargets =
    !directTargets.length && looksLikeVideoFollowupMessage(messageText)
      ? extractRecentVideoTargets({
          videoService,
          recentMessages,
          maxMessages: MAX_VIDEO_FALLBACK_MESSAGES,
          maxTargets: MAX_VIDEO_TARGET_SCAN
        })
      : [];
  const detectedTargets = directTargets.length ? directTargets : fallbackTargets;
  if (!detectedTargets.length) return base;
  const detectedFromRecentMessages = directTargets.length === 0 && fallbackTargets.length > 0;

  if (maxVideosPerMessage <= 0) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages
    };
  }

  const targets = detectedTargets.slice(0, maxVideosPerMessage);
  if (!targets.length) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages
    };
  }

  if (!enabled) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages
    };
  }

  if (!budget.canLookup) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages,
      blockedByBudget: true
    };
  }

  const allowedCount = Math.min(targets.length, budget.remaining);
  if (allowedCount <= 0) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages,
      blockedByBudget: true
    };
  }

  const selectedTargets = targets.slice(0, allowedCount);
  const blockedByBudget = selectedTargets.length < targets.length;

  try {
    const result = await videoService.fetchContexts({
      targets: selectedTargets,
      maxTranscriptChars,
      keyframeIntervalSeconds,
      maxKeyframesPerVideo,
      allowAsrFallback,
      maxAsrSeconds,
      trace
    });
    const firstError = String(result.errors?.[0]?.error || "").trim() || null;
    const videos = (result.videos || []).map((item) => {
      const { frameImages: _frameImages, ...rest } = item || {};
      return rest;
    });
    const frameImages = (result.videos || []).flatMap((item) => item?.frameImages || []);

    return {
      ...base,
      requested: true,
      used: Boolean(videos.length),
      blockedByBudget,
      error: firstError,
      errors: result.errors || [],
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages,
      videos,
      frameImages
    };
  } catch (error) {
    return {
      ...base,
      requested: true,
      detectedVideos: detectedTargets.length,
      detectedFromRecentMessages,
      blockedByBudget,
      error: String(error instanceof Error ? error.message : error),
      errors: [
        {
          videoId: null,
          url: null,
          error: String(error instanceof Error ? error.message : error)
        }
      ]
    };
  }
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
  const configured = Boolean(
    ctx.browserManager &&
    (browserTaskConfig.runtime !== "openai_computer_use" || ctx.llm.openai)
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
