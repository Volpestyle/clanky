import type { ClankerBot } from "../bot.ts";
import type { appConfig } from "../config.ts";
import type { DiscoveryService } from "../services/discovery.ts";
import type { GifService } from "../services/gif.ts";
import type { LLMService } from "../llm.ts";
import type { MemoryManager } from "../memory/memoryManager.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";
import type { WebSearchService } from "../services/search.ts";
import type { Store } from "../store/store.ts";
import type { BrowserTaskRegistry } from "../tools/browserTaskRuntime.ts";
import type { ActiveReplyRegistry } from "../tools/activeReplyRegistry.ts";
import type { VideoContextService } from "../video/videoContextService.ts";
import type { ImageCaptionCache } from "../vision/imageCaptionCache.ts";
import type { SubAgentSessionManager } from "../agents/subAgentSession.ts";
import type { BrowserStreamPublishManager } from "../voice/voiceBrowserStreamPublish.ts";
import type {
  InFlightAcceptedBrainTurn,
  VoiceSession,
  VoiceSessionStreamWatchState,
  VoiceSessionDurableContextEntry
} from "../voice/voiceSessionTypes.ts";
import type { WarmMemoryState } from "../voice/voiceSessionWarmMemory.ts";

export type AppConfig = typeof appConfig;

interface DiscordClientUserLike {
  id?: string;
  username?: string;
  tag?: string;
}

interface DiscordClientGuildMemberLike {
  displayName?: string;
  user?: {
    username?: string;
  } | null;
}

interface DiscordClientGuildLike {
  members?: {
    cache?: {
      get: (id: string) => DiscordClientGuildMemberLike | undefined;
    } | null;
  } | null;
  channels?: {
    cache?: {
      get: (id: string) => {
        name?: string | null;
      } | undefined;
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

interface DiscoveryContext extends BotContext {
  readonly discovery: DiscoveryService;
}

interface MediaContext extends BotContext {
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

type LoadFactProfileFn = typeof import("./memorySlice.ts").loadFactProfile;
type BuildMediaMemoryFactsFn = typeof import("./memorySlice.ts").buildMediaMemoryFacts;
type LoadRelevantMemoryFactsFn = typeof import("./memorySlice.ts").loadRelevantMemoryFacts;
type GetConversationHistoryForPromptFn = typeof import("./messageHistory.ts").getConversationHistoryForPrompt;
type GetImageInputsFn = typeof import("./messageHistory.ts").getImageInputs;
type GetVideoInputsFn = typeof import("./messageHistory.ts").getVideoInputs;
type GetImageBudgetStateFn = typeof import("./budgetTracking.ts").getImageBudgetState;
type GetVideoGenerationBudgetStateFn = typeof import("./budgetTracking.ts").getVideoGenerationBudgetState;
type GetGifBudgetStateFn = typeof import("./budgetTracking.ts").getGifBudgetState;
type GetMediaGenerationCapabilitiesFn = typeof import("./budgetTracking.ts").getMediaGenerationCapabilities;
type BuildWebSearchContextFn = typeof import("./budgetTracking.ts").buildWebSearchContext;
type BuildBrowserBrowseContextFn = typeof import("./budgetTracking.ts").buildBrowserBrowseContext;
type BuildMemoryLookupContextFn = typeof import("./budgetTracking.ts").buildMemoryLookupContext;
type BuildImageLookupContextFn = typeof import("./budgetTracking.ts").buildImageLookupContext;
type RunModelRequestedImageLookupFn = typeof import("./imageAnalysis.ts").runModelRequestedImageLookup;
type MergeImageInputsFn = typeof import("./imageAnalysis.ts").mergeImageInputs;
type GetVoiceScreenWatchCapabilityFn = typeof import("./screenShare.ts").getVoiceScreenWatchCapability;
type StartVoiceScreenWatchFn = typeof import("./screenShare.ts").startVoiceScreenWatch;
type MaybeHandleScreenWatchIntentFn = typeof import("./screenShare.ts").maybeHandleScreenWatchIntent;
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
type MaybeHandleScreenWatchIntentRuntimeFn = (payload: {
  message: unknown;
  replyDirective: Record<string, unknown> | null | undefined;
  source?: string;
}) => ReturnType<MaybeHandleScreenWatchIntentFn>;
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
type IsDiscoveryChannelRuntimeFn = (settings: Record<string, unknown>, channelId: string) => boolean;
type ShouldAttemptReplyDecisionRuntimeFn = (payload: {
  settings: Record<string, unknown>;
  recentMessages: Array<Record<string, unknown>>;
  addressSignal: Record<string, unknown> | null;
  isReplyChannel?: boolean;
  forceRespond?: boolean;
  forceDecisionLoop?: boolean;
  triggerMessageId?: string | null;
  triggerAuthorId?: string | null;
  triggerReferenceMessageId?: string | null;
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
  | "reconnectAttempts";

export interface QueueGatewayRuntime extends BotContext, Pick<ClankerBot, QueueGatewayRuntimeMember> {
  isChannelAllowed: IsChannelAllowedRuntimeFn;
  isUserBlocked: IsUserBlockedRuntimeFn;
  getReplyAddressSignal: GetReplyAddressSignalRuntimeFn;
  markGatewayEvent: () => void;
}

type ReplyPipelineRuntimeMember =
  | "gifs"
  | "search"
  | "voiceSessionManager"
  | "getReactionEmojiOptions"
  | "getEmojiHints"
  | "maybeHandleStructuredAutomationIntent"
  | "maybeApplyReplyReaction"
  | "logSkippedReply"
  | "getSimulatedTypingDelayMs"
  | "shouldSendAsReply"
  | "canSendMessage"
  | "canTalkNow";

export interface ReplyPipelineRuntime extends BotContext, Pick<ClankerBot, ReplyPipelineRuntimeMember> {
  activeReplies: ActiveReplyRegistry;
  video: VideoContextService;
  getReplyAddressSignal: GetReplyAddressSignalRuntimeFn;
  isReplyChannel: IsReplyChannelRuntimeFn;
  isDiscoveryChannel: IsDiscoveryChannelRuntimeFn;
  shouldAttemptReplyDecision: ShouldAttemptReplyDecisionRuntimeFn;
  loadFactProfile: StripFirstArg<LoadFactProfileFn>;
  getConversationHistoryForPrompt: StripFirstArg<GetConversationHistoryForPromptFn>;
  buildMediaMemoryFacts: BuildMediaMemoryFactsFn;
  getImageInputs: (message: unknown) => ReturnType<GetImageInputsFn>;
  getVideoInputs: (message: unknown) => ReturnType<GetVideoInputsFn>;
  getImageBudgetState: StripFirstArg<GetImageBudgetStateFn>;
  getVideoGenerationBudgetState: StripFirstArg<GetVideoGenerationBudgetStateFn>;
  getMediaGenerationCapabilities: StripFirstArg<GetMediaGenerationCapabilitiesFn>;
  getGifBudgetState: StripFirstArg<GetGifBudgetStateFn>;
  buildWebSearchContext: StripFirstArg<BuildWebSearchContextFn>;
  buildBrowserBrowseContext: StripFirstArg<BuildBrowserBrowseContextFn>;
  buildMemoryLookupContext: StripFirstArg<BuildMemoryLookupContextFn>;
  buildImageLookupContext: StripFirstArg<BuildImageLookupContextFn>;
  captionRecentHistoryImages: CaptionRecentHistoryImagesRuntimeFn;
  getVoiceScreenWatchCapability: StripFirstArg<GetVoiceScreenWatchCapabilityFn>;
  runModelRequestedBrowserBrowse: StripFirstArg<RunModelRequestedBrowserBrowseFn>;
  runModelRequestedCodeTask: StripFirstArg<RunModelRequestedCodeTaskFn>;
  buildSubAgentSessionsRuntime: StripFirstArg<BuildSubAgentSessionsRuntimeFn>;
  runModelRequestedImageLookup: RunModelRequestedImageLookupRuntimeFn;
  mergeImageInputs: MergeImageInputsFn;
  maybeHandleScreenWatchIntent: MaybeHandleScreenWatchIntentRuntimeFn;
  resolveMediaAttachment: StripFirstArg<ResolveMediaAttachmentFn>;
  maybeAttachReplyGif: StripFirstArg<MaybeAttachReplyGifFn>;
  maybeAttachGeneratedImage: StripFirstArg<MaybeAttachGeneratedImageFn>;
  maybeAttachGeneratedVideo: StripFirstArg<MaybeAttachGeneratedVideoFn>;
  composeMessageContentForHistory: ComposeMessageContentForHistoryRuntimeFn;
  markSpoke: () => void;
}

export interface VoiceReplyRuntime extends BotContext {
  readonly search: WebSearchService;
  readonly voiceSessionManager?: (BrowserStreamPublishManager & {
    getSessionById?: (sessionId: string | null | undefined) => {
      mode?: string | null;
      realtimeToolOwnership?: "transport_only" | "provider_native" | null;
      durableContext?: VoiceSessionDurableContextEntry[];
      inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
      warmMemory?: WarmMemoryState | null;
      streamWatch?: VoiceSessionStreamWatchState | null;
    } | null;
    resolveVoiceSpeakerName?: (session: VoiceSession, userId?: string | null) => string;
    getStreamWatchNotesForPrompt?: (
      session: VoiceSession,
      settings?: Record<string, unknown> | null
    ) => {
      prompt?: string;
      notes?: string[];
      active?: boolean;
      lastAt?: number;
      provider?: string | null;
      model?: string | null;
    } | null;
    getVoiceScreenWatchCapability?: (args?: {
      settings?: Record<string, unknown> | null;
      guildId?: string | null;
      channelId?: string | null;
      requesterUserId?: string | null;
    }) => Record<string, unknown> | null;
    getVoiceChannelParticipants?: (session: VoiceSession) => Array<{
      userId: string;
      displayName: string;
    }>;
    getRecentVoiceMembershipEvents?: (
      session: VoiceSession,
      args?: { now?: number; maxItems?: number }
    ) => Array<{
      userId: string;
      displayName: string;
      eventType: string;
      at: number;
      ageMs: number;
    }>;
    getRecentVoiceChannelEffectEvents?: (
      session: VoiceSession,
      args?: { now?: number; maxItems?: number }
    ) => Array<{
      userId: string;
      displayName: string;
      channelId: string;
      guildId: string;
      effectType: string;
      soundId: string | null;
      soundName: string | null;
      soundVolume: number | null;
      emoji: string | null;
      animationType: number | null;
      animationId: number | null;
      at: number;
      ageMs: number;
      summary: string;
    }>;
    abortHeldPrePlaybackReplyBeforeToolCall?: (payload: {
      session?: {
        durableContext?: VoiceSessionDurableContextEntry[];
        inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
      } | null;
      source?: string;
    }) => boolean;
    getSessionFactProfileSlice?: (payload: {
      session?: {
        durableContext?: VoiceSessionDurableContextEntry[];
        inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
      } | null;
      userId?: string | null;
    }) => {
      userFacts: Array<Record<string, unknown>>;
      relevantFacts: Array<Record<string, unknown>>;
    };
    getMusicPromptContext?: (session: {
      durableContext?: VoiceSessionDurableContextEntry[];
      inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
    } | null) => {
      playbackState: "playing" | "paused" | "stopped" | "idle";
      currentTrack: { id: string | null; title: string; artists: string[] } | null;
      lastTrack: { id: string | null; title: string; artists: string[] } | null;
      queueLength: number;
      upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
      lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
      lastQuery: string | null;
    } | null;
    getMusicDisambiguationPromptContext?: (session: {
      durableContext?: VoiceSessionDurableContextEntry[];
      inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
    } | null) => {
      active: true;
      query: string | null;
      platform: "youtube" | "soundcloud" | "discord" | "auto";
      action: "play_now" | "queue_next" | "queue_add";
      requestedByUserId: string | null;
      options: Array<{
        id: string;
        title: string;
        artist: string | null;
        platform: string;
        externalUrl?: string | null;
        durationSeconds?: number | null;
      }>;
    } | null;
    requestPlayMusic?: (payload?: {
      guildId?: string | null;
      channelId?: string | null;
      requestedByUserId?: string | null;
      settings?: Record<string, unknown> | null;
      query?: string;
      trackId?: string | null;
      platform?: string;
      action?: "play_now" | "queue_next" | "queue_add";
      searchResults?: Array<Record<string, unknown>> | null;
      reason?: string;
      source?: string;
      mustNotify?: boolean;
    }) => Promise<unknown>;
    requestStopMusic?: (payload?: {
      guildId?: string | null;
      channelId?: string | null;
      requestedByUserId?: string | null;
      settings?: Record<string, unknown> | null;
      reason?: string;
      source?: string;
      requestText?: string;
      clearQueue?: boolean;
      mustNotify?: boolean;
    }) => Promise<unknown>;
    requestPauseMusic?: (payload?: {
      guildId?: string | null;
      channelId?: string | null;
      requestedByUserId?: string | null;
      settings?: Record<string, unknown> | null;
      reason?: string;
      source?: string;
      requestText?: string;
      mustNotify?: boolean;
    }) => Promise<unknown>;
    refreshSessionGuildFactProfile?: (session: {
      durableContext?: VoiceSessionDurableContextEntry[];
      inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
    } | null) => void;
    refreshSessionUserFactProfile?: (
      session: {
        durableContext?: VoiceSessionDurableContextEntry[];
        inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
      } | null,
      userId: string
    ) => void;
  }) | null;
  loadRelevantMemoryFacts: StripFirstArg<LoadRelevantMemoryFactsFn>;
  buildMediaMemoryFacts: BuildMediaMemoryFactsFn;
  loadFactProfile: StripFirstArg<LoadFactProfileFn>;
  buildWebSearchContext: StripFirstArg<BuildWebSearchContextFn>;
  loadRecentConversationHistory: StripFirstArg<GetConversationHistoryForPromptFn>;
  getVoiceScreenWatchCapability: StripFirstArg<GetVoiceScreenWatchCapabilityFn>;
  startVoiceScreenWatch: StripFirstArg<StartVoiceScreenWatchFn>;
  runModelRequestedBrowserBrowse: StripFirstArg<RunModelRequestedBrowserBrowseFn>;
  buildBrowserBrowseContext: StripFirstArg<BuildBrowserBrowseContextFn>;
  runModelRequestedCodeTask: StripFirstArg<RunModelRequestedCodeTaskFn>;
  buildSubAgentSessionsRuntime?: StripFirstArg<BuildSubAgentSessionsRuntimeFn>;
}

type TextThoughtLoopPolicyRuntime = {
  isChannelAllowed: IsChannelAllowedRuntimeFn;
  hasBotMessageInRecentWindow: HasBotMessageInRecentWindowRuntimeFn;
};
