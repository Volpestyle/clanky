import type { ClankerBot } from "../bot.ts";
import type { appConfig } from "../config.ts";
import type { DiscoveryService } from "../discovery.ts";
import type { GifService } from "../gif.ts";
import type { LLMService } from "../llm.ts";
import type { MemoryManager } from "../memory.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import type { WebSearchService } from "../search.ts";
import type { Store } from "../store.ts";
import type { BrowserTaskRegistry } from "../tools/browserTaskRuntime.ts";
import type { VideoContextService } from "../video.ts";
import type { ImageCaptionCache } from "../vision/imageCaptionCache.ts";
import type { SubAgentSessionManager } from "../agents/subAgentSession.ts";

export type AppConfig = typeof appConfig;

export interface DiscordClientUserLike {
  id?: string;
  username?: string;
  tag?: string;
}

export interface DiscordClientGuildMemberLike {
  displayName?: string;
  user?: {
    username?: string;
  } | null;
}

export interface DiscordClientGuildLike {
  members?: {
    cache?: {
      get: (id: string) => DiscordClientGuildMemberLike | undefined;
    } | null;
  } | null;
}

export interface DiscordClientLike {
  user?: DiscordClientUserLike | null;
  guilds: {
    cache: {
      get: (id: string) => DiscordClientGuildLike | undefined;
    };
  };
  users?: {
    cache?: {
      get: (id: string) => {
        username?: string;
      } | undefined;
    };
  };
  isReady?: () => boolean;
  destroy?: () => Promise<unknown>;
  login?: (token: string) => Promise<unknown>;
}

export interface BotContext {
  readonly appConfig: AppConfig;
  readonly store: Store;
  readonly llm: LLMService;
  readonly memory: MemoryManager;
  readonly client: DiscordClientLike;
  readonly botUserId?: string | null;
}

export interface DiscoveryContext extends BotContext {
  readonly discovery: DiscoveryService;
}

export interface MediaContext extends BotContext {
  readonly gifs: GifService;
  readonly video: VideoContextService;
}

export interface MediaAttachmentContext extends BudgetContext {
  readonly gifs: GifService;
}

export interface AgentContext extends BotContext {
  readonly browserManager: BrowserManager | null;
  readonly activeBrowserTasks: BrowserTaskRegistry;
  readonly subAgentSessions: SubAgentSessionManager;
}

export interface BudgetContext extends BotContext {
  readonly search: WebSearchService;
  readonly video: VideoContextService;
  readonly browserManager: BrowserManager | null;
  readonly imageCaptionCache: ImageCaptionCache;
}

type LoadPromptMemorySliceFn = typeof import("./memorySlice.ts").loadPromptMemorySlice;
type BuildMediaMemoryFactsFn = typeof import("./memorySlice.ts").buildMediaMemoryFacts;
type LoadRelevantMemoryFactsFn = typeof import("./memorySlice.ts").loadRelevantMemoryFacts;
type GetRecentLookupContextForPromptFn = typeof import("./messageHistory.ts").getRecentLookupContextForPrompt;
type GetConversationHistoryForPromptFn = typeof import("./messageHistory.ts").getConversationHistoryForPrompt;
type RememberRecentLookupContextFn = typeof import("./messageHistory.ts").rememberRecentLookupContext;
type GetImageInputsFn = typeof import("./messageHistory.ts").getImageInputs;
type GetImageBudgetStateFn = typeof import("./budgetTracking.ts").getImageBudgetState;
type GetVideoGenerationBudgetStateFn = typeof import("./budgetTracking.ts").getVideoGenerationBudgetState;
type GetGifBudgetStateFn = typeof import("./budgetTracking.ts").getGifBudgetState;
type GetMediaGenerationCapabilitiesFn = typeof import("./budgetTracking.ts").getMediaGenerationCapabilities;
type BuildWebSearchContextFn = typeof import("./budgetTracking.ts").buildWebSearchContext;
type BuildBrowserBrowseContextFn = typeof import("./budgetTracking.ts").buildBrowserBrowseContext;
type BuildMemoryLookupContextFn = typeof import("./budgetTracking.ts").buildMemoryLookupContext;
type BuildVideoReplyContextFn = typeof import("./budgetTracking.ts").buildVideoReplyContext;
type BuildImageLookupContextFn = typeof import("./budgetTracking.ts").buildImageLookupContext;
type GetAutoIncludeImageInputsFn = typeof import("./imageAnalysis.ts").getAutoIncludeImageInputs;
type RunModelRequestedImageLookupFn = typeof import("./imageAnalysis.ts").runModelRequestedImageLookup;
type MergeImageInputsFn = typeof import("./imageAnalysis.ts").mergeImageInputs;
type GetVoiceScreenShareCapabilityFn = typeof import("./screenShare.ts").getVoiceScreenShareCapability;
type OfferVoiceScreenShareLinkFn = typeof import("./screenShare.ts").offerVoiceScreenShareLink;
type MaybeHandleScreenShareOfferIntentFn = typeof import("./screenShare.ts").maybeHandleScreenShareOfferIntent;
type RunModelRequestedBrowserBrowseFn = typeof import("./agentTasks.ts").runModelRequestedBrowserBrowse;
type RunModelRequestedCodeTaskFn = typeof import("./agentTasks.ts").runModelRequestedCodeTask;
type BuildSubAgentSessionsRuntimeFn = typeof import("./agentTasks.ts").buildSubAgentSessionsRuntime;
type ResolveMediaAttachmentFn = typeof import("./mediaAttachment.ts").resolveMediaAttachment;
type MaybeAttachReplyGifFn = typeof import("./mediaAttachment.ts").maybeAttachReplyGif;
type MaybeAttachGeneratedImageFn = typeof import("./mediaAttachment.ts").maybeAttachGeneratedImage;
type MaybeAttachGeneratedVideoFn = typeof import("./mediaAttachment.ts").maybeAttachGeneratedVideo;
type GetReplyAddressSignalFn = typeof import("./replyAdmission.ts").getReplyAddressSignal;
type ShouldAttemptReplyDecisionFn = typeof import("./replyAdmission.ts").shouldAttemptReplyDecision;
type StripFirstArg<T> = T extends (first: unknown, ...rest: infer Rest) => infer Result
  ? (...args: Rest) => Result
  : never;
type CaptionRecentHistoryImagesRuntimeFn = (payload?: {
  candidates?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown> | null;
  trace?: Record<string, unknown> | null;
}) => void;
type MaybeHandleScreenShareOfferIntentRuntimeFn = (payload: {
  message: unknown;
  replyDirective: Record<string, unknown> | null | undefined;
  source?: string;
}) => ReturnType<MaybeHandleScreenShareOfferIntentFn>;
type RunModelRequestedImageLookupRuntimeFn = (payload: {
  imageLookup?: Record<string, unknown> | null;
  query?: string;
}) => ReturnType<RunModelRequestedImageLookupFn>;
type ComposeMessageContentForHistoryRuntimeFn = (message: unknown, baseText?: string) => string;
type GetReplyAddressSignalRuntimeFn = (
  settings: Record<string, unknown>,
  message: unknown,
  recentMessages?: Array<Record<string, unknown>>
) => ReturnType<GetReplyAddressSignalFn>;
type IsChannelAllowedRuntimeFn = (settings: Record<string, unknown>, channelId: string) => boolean;
type IsUserBlockedRuntimeFn = (settings: Record<string, unknown>, userId: string) => boolean;
type IsReplyChannelRuntimeFn = (settings: Record<string, unknown>, channelId: string) => boolean;
type ShouldAttemptReplyDecisionRuntimeFn = (payload: {
  settings: Record<string, unknown>;
  recentMessages: Array<Record<string, unknown>>;
  addressSignal: Record<string, unknown> | null;
  forceRespond?: boolean;
  forceDecisionLoop?: boolean;
  triggerMessageId?: string | null;
}) => ReturnType<ShouldAttemptReplyDecisionFn>;
type HasBotMessageInRecentWindowRuntimeFn = (payload: {
  recentMessages: Array<Record<string, unknown>>;
  windowSize?: number;
  triggerMessageId?: string | null;
}) => boolean;

type QueueGatewayRuntimeMember =
  | "lastBotMessageAt"
  | "canSendMessage"
  | "replyQueues"
  | "replyQueueWorkers"
  | "replyQueuedMessageIds"
  | "isStopping"
  | "maybeReplyToMessage"
  | "reconnectInFlight"
  | "hasConnectedAtLeastOnce"
  | "lastGatewayEventAt"
  | "reconnectTimeout"
  | "markGatewayEvent"
  | "reconnectAttempts";

export interface QueueGatewayRuntime extends BotContext, Pick<ClankerBot, QueueGatewayRuntimeMember> {
  isChannelAllowed: IsChannelAllowedRuntimeFn;
  isUserBlocked: IsUserBlockedRuntimeFn;
  getReplyAddressSignal: GetReplyAddressSignalRuntimeFn;
}

type ReplyPipelineRuntimeMember =
  | "gifs"
  | "search"
  | "voiceSessionManager"
  | "getReactionEmojiOptions"
  | "getEmojiHints"
  | "maybeHandleStructuredVoiceIntent"
  | "maybeHandleStructuredAutomationIntent"
  | "maybeApplyReplyReaction"
  | "logSkippedReply"
  | "getSimulatedTypingDelayMs"
  | "shouldSendAsReply"
  | "markSpoke"
  | "canSendMessage"
  | "canTalkNow";

export interface ReplyPipelineRuntime extends BotContext, Pick<ClankerBot, ReplyPipelineRuntimeMember> {
  getReplyAddressSignal: GetReplyAddressSignalRuntimeFn;
  isReplyChannel: IsReplyChannelRuntimeFn;
  shouldAttemptReplyDecision: ShouldAttemptReplyDecisionRuntimeFn;
  loadPromptMemorySlice: StripFirstArg<LoadPromptMemorySliceFn>;
  getRecentLookupContextForPrompt: StripFirstArg<GetRecentLookupContextForPromptFn>;
  getConversationHistoryForPrompt: StripFirstArg<GetConversationHistoryForPromptFn>;
  buildMediaMemoryFacts: BuildMediaMemoryFactsFn;
  getImageInputs: (message: unknown) => ReturnType<GetImageInputsFn>;
  getImageBudgetState: StripFirstArg<GetImageBudgetStateFn>;
  getVideoGenerationBudgetState: StripFirstArg<GetVideoGenerationBudgetStateFn>;
  getMediaGenerationCapabilities: StripFirstArg<GetMediaGenerationCapabilitiesFn>;
  getGifBudgetState: StripFirstArg<GetGifBudgetStateFn>;
  buildWebSearchContext: StripFirstArg<BuildWebSearchContextFn>;
  buildBrowserBrowseContext: StripFirstArg<BuildBrowserBrowseContextFn>;
  buildMemoryLookupContext: StripFirstArg<BuildMemoryLookupContextFn>;
  buildVideoReplyContext: StripFirstArg<BuildVideoReplyContextFn>;
  buildImageLookupContext: StripFirstArg<BuildImageLookupContextFn>;
  getAutoIncludeImageInputs: GetAutoIncludeImageInputsFn;
  captionRecentHistoryImages: CaptionRecentHistoryImagesRuntimeFn;
  getVoiceScreenShareCapability: StripFirstArg<GetVoiceScreenShareCapabilityFn>;
  runModelRequestedBrowserBrowse: StripFirstArg<RunModelRequestedBrowserBrowseFn>;
  runModelRequestedCodeTask: StripFirstArg<RunModelRequestedCodeTaskFn>;
  buildSubAgentSessionsRuntime: StripFirstArg<BuildSubAgentSessionsRuntimeFn>;
  runModelRequestedImageLookup: RunModelRequestedImageLookupRuntimeFn;
  mergeImageInputs: MergeImageInputsFn;
  rememberRecentLookupContext: StripFirstArg<RememberRecentLookupContextFn>;
  maybeHandleScreenShareOfferIntent: MaybeHandleScreenShareOfferIntentRuntimeFn;
  resolveMediaAttachment: StripFirstArg<ResolveMediaAttachmentFn>;
  maybeAttachReplyGif: StripFirstArg<MaybeAttachReplyGifFn>;
  maybeAttachGeneratedImage: StripFirstArg<MaybeAttachGeneratedImageFn>;
  maybeAttachGeneratedVideo: StripFirstArg<MaybeAttachGeneratedVideoFn>;
  composeMessageContentForHistory: ComposeMessageContentForHistoryRuntimeFn;
}

export interface VoiceReplyRuntime extends BotContext {
  readonly search: WebSearchService;
  loadRelevantMemoryFacts: StripFirstArg<LoadRelevantMemoryFactsFn>;
  buildMediaMemoryFacts: BuildMediaMemoryFactsFn;
  loadPromptMemorySlice: StripFirstArg<LoadPromptMemorySliceFn>;
  buildWebSearchContext: StripFirstArg<BuildWebSearchContextFn>;
  loadRecentConversationHistory: StripFirstArg<GetConversationHistoryForPromptFn>;
  loadRecentLookupContext: StripFirstArg<GetRecentLookupContextForPromptFn>;
  rememberRecentLookupContext: StripFirstArg<RememberRecentLookupContextFn>;
  getVoiceScreenShareCapability: StripFirstArg<GetVoiceScreenShareCapabilityFn>;
  offerVoiceScreenShareLink: StripFirstArg<OfferVoiceScreenShareLinkFn>;
  runModelRequestedBrowserBrowse: StripFirstArg<RunModelRequestedBrowserBrowseFn>;
  buildBrowserBrowseContext: StripFirstArg<BuildBrowserBrowseContextFn>;
  runModelRequestedCodeTask: StripFirstArg<RunModelRequestedCodeTaskFn>;
}

export type TextThoughtLoopPolicyRuntime = {
  isChannelAllowed: IsChannelAllowedRuntimeFn;
  hasBotMessageInRecentWindow: HasBotMessageInRecentWindowRuntimeFn;
};
