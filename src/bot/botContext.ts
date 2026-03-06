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

type QueueGatewayRuntimeMember =
  | "lastBotMessageAt"
  | "canSendMessage"
  | "replyQueues"
  | "replyQueueWorkers"
  | "replyQueuedMessageIds"
  | "isStopping"
  | "isChannelAllowed"
  | "isUserBlocked"
  | "getReplyAddressSignal"
  | "maybeReplyToMessage"
  | "reconnectInFlight"
  | "hasConnectedAtLeastOnce"
  | "lastGatewayEventAt"
  | "reconnectTimeout"
  | "markGatewayEvent"
  | "reconnectAttempts";

export type QueueGatewayRuntime = BotContext & Pick<ClankerBot, QueueGatewayRuntimeMember>;

type ReplyPipelineRuntimeMember =
  | "gifs"
  | "search"
  | "voiceSessionManager"
  | "getReplyAddressSignal"
  | "isReplyChannel"
  | "getReactionEmojiOptions"
  | "shouldAttemptReplyDecision"
  | "loadPromptMemorySlice"
  | "getRecentLookupContextForPrompt"
  | "getConversationHistoryForPrompt"
  | "buildMediaMemoryFacts"
  | "getImageInputs"
  | "getImageBudgetState"
  | "getVideoGenerationBudgetState"
  | "getMediaGenerationCapabilities"
  | "getGifBudgetState"
  | "buildWebSearchContext"
  | "buildBrowserBrowseContext"
  | "buildMemoryLookupContext"
  | "buildVideoReplyContext"
  | "buildImageLookupContext"
  | "getAutoIncludeImageInputs"
  | "captionRecentHistoryImages"
  | "getVoiceScreenShareCapability"
  | "getEmojiHints"
  | "runModelRequestedBrowserBrowse"
  | "runModelRequestedCodeTask"
  | "buildSubAgentSessionsRuntime"
  | "runModelRequestedImageLookup"
  | "mergeImageInputs"
  | "maybeHandleStructuredVoiceIntent"
  | "maybeHandleStructuredAutomationIntent"
  | "rememberRecentLookupContext"
  | "maybeApplyReplyReaction"
  | "logSkippedReply"
  | "maybeHandleScreenShareOfferIntent"
  | "maybeAttachReplyGif"
  | "maybeAttachGeneratedImage"
  | "maybeAttachGeneratedVideo"
  | "getSimulatedTypingDelayMs"
  | "shouldSendAsReply"
  | "markSpoke"
  | "composeMessageContentForHistory"
  | "canSendMessage"
  | "canTalkNow";

export type ReplyPipelineRuntime = BotContext & Pick<ClankerBot, ReplyPipelineRuntimeMember>;

export interface VoiceReplyRuntime extends BotContext {
  readonly search: WebSearchService;
  loadRelevantMemoryFacts: ClankerBot["loadRelevantMemoryFacts"];
  buildMediaMemoryFacts: ClankerBot["buildMediaMemoryFacts"];
  loadPromptMemorySlice: ClankerBot["loadPromptMemorySlice"];
  buildWebSearchContext: ClankerBot["buildWebSearchContext"];
  loadRecentConversationHistory: ClankerBot["getConversationHistoryForPrompt"];
  loadRecentLookupContext: ClankerBot["getRecentLookupContextForPrompt"];
  rememberRecentLookupContext: ClankerBot["rememberRecentLookupContext"];
  getVoiceScreenShareCapability: ClankerBot["getVoiceScreenShareCapability"];
  offerVoiceScreenShareLink: ClankerBot["offerVoiceScreenShareLink"];
  runModelRequestedBrowserBrowse: ClankerBot["runModelRequestedBrowserBrowse"];
  buildBrowserBrowseContext: ClankerBot["buildBrowserBrowseContext"];
  runModelRequestedCodeTask: ClankerBot["runModelRequestedCodeTask"];
}
