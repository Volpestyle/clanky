import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes
} from "discord.js";
import { clankCommand } from "./commands/clankCommand.ts";
import { browseCommand } from "./commands/browseCommand.ts";
import { codeCommand } from "./commands/codeCommand.ts";
import {
  runCodeAgent,
  isCodeAgentUserAllowed,
  resolveCodeAgentConfig,
  getActiveCodeAgentTaskCount
} from "./agents/codeAgent.ts";
import { musicCommands } from "./voice/musicCommands.ts";
import { ImageCaptionCache } from "./vision/imageCaptionCache.ts";
import {
  normalizeReactionEmojiToken
} from "./botHelpers.ts";
import {
  resolveFollowingNextRunAt,
  resolveInitialNextRunAt
} from "./automation.ts";
import { chance, clamp, sleep } from "./utils.ts";
import {
  applyAutomationControlAction,
  composeAutomationControlReply
} from "./bot/automationControl.ts";
import {
  CONVERSATION_HISTORY_PROMPT_LIMIT,
  CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
  CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER,
  CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE,
  LOOKUP_CONTEXT_PROMPT_LIMIT,
  LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS,
  MAX_MODEL_IMAGE_INPUTS,
  finalizeReplyPerformanceSample,
  normalizeReplyPerformanceSeed
} from "./bot/replyPipelineShared.ts";
import type { ReplyPerformanceSeed } from "./bot/replyPipelineShared.ts";
import {
  buildSubAgentSessionsRuntime as buildSubAgentSessionsRuntimeForAgentTasks,
  createBrowserAgentSession as createBrowserAgentSessionForAgentTasks,
  createCodeAgentSession as createCodeAgentSessionForAgentTasks,
  runModelRequestedBrowserBrowse as runModelRequestedBrowserBrowseForAgentTasks,
  runModelRequestedCodeTask as runModelRequestedCodeTaskForAgentTasks
} from "./bot/agentTasks.ts";
import {
  buildBrowserBrowseContext as buildBrowserBrowseContextForBudgetTracking,
  buildImageLookupContext as buildImageLookupContextForBudgetTracking,
  buildMemoryLookupContext as buildMemoryLookupContextForBudgetTracking,
  buildVideoReplyContext as buildVideoReplyContextForBudgetTracking,
  buildWebSearchContext as buildWebSearchContextForBudgetTracking,
  getBrowserBudgetState as getBrowserBudgetStateForBudgetTracking,
  getGifBudgetState as getGifBudgetStateForBudgetTracking,
  getImageBudgetState as getImageBudgetStateForBudgetTracking,
  getMediaGenerationCapabilities as getMediaGenerationCapabilitiesForBudgetTracking,
  getWebSearchBudgetState as getWebSearchBudgetStateForBudgetTracking,
  getVideoContextBudgetState as getVideoContextBudgetStateForBudgetTracking,
  getVideoGenerationBudgetState as getVideoGenerationBudgetStateForBudgetTracking,
  isImageGenerationReady as isImageGenerationReadyForBudgetTracking,
  isVideoGenerationReady as isVideoGenerationReadyForBudgetTracking
} from "./bot/budgetTracking.ts";
import {
  captionRecentHistoryImages as captionRecentHistoryImagesForImageAnalysis,
  extractHistoryImageCandidates as extractHistoryImageCandidatesForImageAnalysis,
  getAutoIncludeImageInputs as getAutoIncludeImageInputsForImageAnalysis,
  mergeImageInputs as mergeImageInputsForImageAnalysis,
  rankImageLookupCandidates as rankImageLookupCandidatesForImageAnalysis,
  runModelRequestedImageLookup as runModelRequestedImageLookupForImageAnalysis
} from "./bot/imageAnalysis.ts";
import {
  buildMessagePayloadWithGif as buildMessagePayloadWithGifForMediaAttachment,
  buildMessagePayloadWithImage as buildMessagePayloadWithImageForMediaAttachment,
  buildMessagePayloadWithVideo as buildMessagePayloadWithVideoForMediaAttachment,
  maybeAttachGeneratedImage as maybeAttachGeneratedImageForMediaAttachment,
  maybeAttachGeneratedVideo as maybeAttachGeneratedVideoForMediaAttachment,
  maybeAttachReplyGif as maybeAttachReplyGifForMediaAttachment,
  resolveMediaAttachment as resolveMediaAttachmentForMediaAttachment
} from "./bot/mediaAttachment.ts";
import {
  composeMessageContentForHistory as composeMessageContentForHistoryForMessageHistory,
  getConversationHistoryForPrompt as getConversationHistoryForPromptForMessageHistory,
  getImageInputs as getImageInputsForMessageHistory,
  getRecentLookupContextForPrompt as getRecentLookupContextForPromptForMessageHistory,
  recordReactionHistoryEvent as recordReactionHistoryEventForMessageHistory,
  rememberRecentLookupContext as rememberRecentLookupContextForMessageHistory,
  syncMessageSnapshot as syncMessageSnapshotForMessageHistory,
  syncMessageSnapshotFromReaction as syncMessageSnapshotFromReactionForMessageHistory
} from "./bot/messageHistory.ts";
import {
  buildMediaMemoryFacts as buildMediaMemoryFactsForMemorySlice,
  getScopedFallbackFacts as getScopedFallbackFactsForMemorySlice,
  loadPromptMemorySlice as loadPromptMemorySliceForMemorySlice,
  loadRelevantMemoryFacts as loadRelevantMemoryFactsForMemorySlice
} from "./bot/memorySlice.ts";
import {
  isChannelAllowed as isChannelAllowedForPermissions,
  isDiscoveryChannel as isDiscoveryChannelForPermissions,
  isReplyChannel as isReplyChannelForPermissions,
  isUserBlocked as isUserBlockedForPermissions
} from "./bot/permissions.ts";
import {
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  hasBotMessageInRecentWindow as hasBotMessageInRecentWindowForReplyAdmission,
  hasStartupFollowupAfterMessage as hasStartupFollowupAfterMessageForReplyAdmission,
  shouldAttemptReplyDecision as shouldAttemptReplyDecisionForReplyAdmission,
  shouldForceRespondForAddressSignal as shouldForceRespondForAddressSignalForReplyAdmission
} from "./bot/replyAdmission.ts";
import { runStartupCatchup as runStartupCatchupForStartupCatchup } from "./bot/startupCatchup.ts";
import {
  applyDiscoveryLinkPolicy as applyDiscoveryLinkPolicyForDiscoveryEngine,
  collectDiscoveryForPost as collectDiscoveryForPostForDiscoveryEngine,
  maybeRunDiscoveryCycle as maybeRunDiscoveryCycleForDiscoveryEngine
} from "./bot/discoveryEngine.ts";
import {
  composeScreenShareOfferMessage as composeScreenShareOfferMessageForScreenShare,
  composeScreenShareUnavailableMessage as composeScreenShareUnavailableMessageForScreenShare,
  getVoiceScreenShareCapability as getVoiceScreenShareCapabilityForScreenShare,
  maybeHandleScreenShareOfferIntent as maybeHandleScreenShareOfferIntentForScreenShare,
  offerVoiceScreenShareLink as offerVoiceScreenShareLinkForScreenShare,
  resolveOperationalChannel as resolveOperationalChannelForScreenShare,
  sendToChannel as sendToChannelForScreenShare
} from "./bot/screenShare.ts";
import type { ScreenShareSessionManagerLike } from "./bot/screenShare.ts";
import {
  composeVoiceOperationalMessage as composeVoiceOperationalMessageForVoiceCoordination,
  generateVoiceTurnReply as generateVoiceTurnReplyForVoiceCoordination,
  requestVoiceJoinFromDashboard as requestVoiceJoinFromDashboardForVoiceCoordination,
  resolveDashboardVoiceJoinRequester as resolveDashboardVoiceJoinRequesterForVoiceCoordination,
  resolveDashboardVoiceJoinTextChannel as resolveDashboardVoiceJoinTextChannelForVoiceCoordination
} from "./bot/voiceCoordination.ts";
import {
  generateAutomationPayload as generateAutomationPayloadForAutomationEngine,
  maybeRunAutomationCycle as maybeRunAutomationCycleForAutomationEngine,
  runAutomationJob as runAutomationJobForAutomationEngine
} from "./bot/automationEngine.ts";
import {
  buildStoredMessageRuntime as buildStoredMessageRuntimeForTextThoughtLoop,
  getLatestRecentHumanMessage as getLatestRecentHumanMessageForTextThoughtLoop,
  isRecentHumanActivity as isRecentHumanActivityForTextThoughtLoop,
  maybeRunTextThoughtLoopCycle as maybeRunTextThoughtLoopCycleForTextThoughtLoop,
  pickTextThoughtLoopCandidate as pickTextThoughtLoopCandidateForTextThoughtLoop
} from "./bot/textThoughtLoop.ts";
import {
  dequeueReplyBurst,
  dequeueReplyJob,
  ensureGatewayHealthy,
  getReplyCoalesceMaxMessages,
  getReplyCoalesceWaitMs,
  getReplyCoalesceWindowMs,
  getReplyQueueWaitMs,
  processReplyQueue,
  reconnectGateway,
  requeueReplyJobs,
  scheduleReconnect
} from "./bot/queueGateway.ts";
import {
  evaluateDiscoverySchedule,
  evaluateSpontaneousDiscoverySchedule,
  getDiscoveryAverageIntervalMs,
  getDiscoveryMinGapMs,
  getDiscoveryPacingMode,
  getDiscoveryPostingIntervalMs,
  pickDiscoveryChannel
} from "./bot/discoverySchedule.ts";
import type {
  AgentContext,
  BotContext,
  BudgetContext,
  MediaAttachmentContext,
  QueueGatewayRuntime,
  ReplyPipelineRuntime,
  VoiceReplyRuntime
} from "./bot/botContext.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";
import type { BrowserManager } from "./services/BrowserManager.ts";
import {
  BrowserTaskRegistry,
  buildBrowserTaskScopeKey,
  isAbortError
} from "./tools/browserTaskRuntime.ts";
import { maybeReplyToMessagePipeline } from "./bot/replyPipeline.ts";
import { SubAgentSessionManager } from "./agents/subAgentSession.ts";
import {
  getMemorySettings,
  getBotName,
  getDiscoverySettings,
  getReplyPermissions,
  getActivitySettings,
  getVoiceAdmissionSettings,
  isDevTaskEnabled
} from "./settings/agentStack.ts";

const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;
const AUTOMATION_TICK_MS = 30_000;
const GATEWAY_WATCHDOG_TICK_MS = 30_000;
const REFLECTION_TICK_MS = 60_000;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;
const PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
const IS_TEST_PROCESS = /\.test\.[cm]?[jt]sx?$/i.test(String(process.argv?.[1] || "")) ||
  process.execArgv.includes("--test") ||
  process.argv.includes("--test");
export type ReplyAttemptOptions = {
  recentMessages?: Array<Record<string, unknown>>;
  addressSignal?: {
    direct?: boolean;
    inferred?: boolean;
    triggered?: boolean;
    reason?: string;
    confidence?: number;
    threshold?: number;
    confidenceSource?: "llm" | "fallback" | "direct" | "exact_name";
  } | null;
  triggerMessageIds?: string[];
  forceRespond?: boolean;
  forceDecisionLoop?: boolean;
  source?: string;
  performanceSeed?: ReplyPerformanceSeed | null;
};

type DiscoveryLinkCandidate = {
  url?: string;
  source?: string;
};

type SentMessageLike = {
  id: string;
  createdTimestamp: number;
  guildId: string;
  channelId: string;
  content?: string;
  attachments?: unknown;
  embeds?: unknown[];
};

type CachedChannelLike = {
  id: string;
  name?: string;
  send?: (payload: unknown) => Promise<SentMessageLike>;
  sendTyping?: () => Promise<unknown>;
  isTextBased?: () => boolean;
  isVoiceBased?: () => boolean;
  parent?: { name?: string } | null;
};

type GuildMemberLike = {
  displayName?: string;
  user?: {
    username?: string;
  } | null;
};

type GuildLike = {
  id: string;
  name: string;
  members?: {
    cache?: {
      get: (id: string) => GuildMemberLike | undefined;
    };
  };
  channels?: {
    cache: {
      get: (id: string) => CachedChannelLike | undefined;
      values: () => IterableIterator<CachedChannelLike>;
      filter: (predicate: (channel: CachedChannelLike) => boolean) => {
        first: (count: number) => CachedChannelLike[];
      };
    };
  };
};

type DiscordClientLike = {
  on: Client["on"];
  destroy: Client["destroy"];
  isReady: Client["isReady"];
  login: Client["login"];
  user: {
    id?: string;
    username?: string;
    tag?: string;
  } | null;
  guilds: {
    cache: {
      get: (id: string) => GuildLike | undefined;
      values: () => IterableIterator<GuildLike>;
      size: number;
    };
  };
  channels: {
    cache: {
      get: (id: string) => CachedChannelLike | undefined;
    };
  };
  users?: {
    cache?: {
      get: (id: string) => {
        username?: string;
      } | undefined;
    };
  };
};

function isSendableChannel(
  channel: CachedChannelLike | null | undefined
): channel is CachedChannelLike & {
  send: (payload: unknown) => Promise<SentMessageLike>;
  sendTyping: () => Promise<unknown>;
} {
  return Boolean(channel) &&
    channel.isTextBased?.() === true &&
    typeof channel.send === "function" &&
    typeof channel.sendTyping === "function";
}

export class ClankerBot {
  appConfig;
  store;
  llm;
  memory;
  discovery;
  search;
  gifs;
  video;
  lastBotMessageAt;
  memoryTimer;
  discoveryTimer;
  textThoughtLoopTimer;
  automationTimer;
  gatewayWatchdogTimer;
  reconnectTimeout;
  startupTasksRan;
  startupTimeout;
  discoveryPosting;
  textThoughtLoopRunning;
  automationCycleRunning;
  reconnectInFlight;
  isStopping;
  hasConnectedAtLeastOnce;
  lastGatewayEventAt;
  reconnectAttempts;
  replyQueues;
  replyQueueWorkers;
  replyQueuedMessageIds: Set<string>;
  reflectionTimer;
  nextReflectionRunAt: string | null;
  screenShareSessionManager: ScreenShareSessionManagerLike | null;
  client: DiscordClientLike;
  voiceSessionManager: VoiceSessionManager;
  browserManager: BrowserManager | null;
  activeBrowserTasks: BrowserTaskRegistry;
  subAgentSessions: SubAgentSessionManager;
  imageCaptionCache: ImageCaptionCache;
  private captionTimestamps: number[];

  constructor({ appConfig, store, llm, memory, discovery, search, gifs, video, browserManager = null }) {
    this.appConfig = appConfig;
    this.store = store;
    this.llm = llm;
    this.memory = memory;
    this.discovery = discovery;
    this.search = search;
    this.gifs = gifs;
    this.video = video;
    this.browserManager = browserManager;

    this.lastBotMessageAt = 0;
    this.memoryTimer = null;
    this.discoveryTimer = null;
    this.textThoughtLoopTimer = null;
    this.automationTimer = null;
    this.gatewayWatchdogTimer = null;
    this.reconnectTimeout = null;
    this.startupTasksRan = false;
    this.startupTimeout = null;
    this.discoveryPosting = false;
    this.textThoughtLoopRunning = false;
    this.automationCycleRunning = false;
    this.reconnectInFlight = false;
    this.isStopping = false;
    this.hasConnectedAtLeastOnce = false;
    this.lastGatewayEventAt = Date.now();
    this.reconnectAttempts = 0;
    this.replyQueues = new Map();
    this.replyQueueWorkers = new Set();
    this.replyQueuedMessageIds = new Set();
    this.reflectionTimer = null;
    this.nextReflectionRunAt = null;
    this.screenShareSessionManager = null;
    this.activeBrowserTasks = new BrowserTaskRegistry();
    this.subAgentSessions = new SubAgentSessionManager({
      idleTimeoutMs: Number(appConfig?.subAgentOrchestration?.sessionIdleTimeoutMs) || 300_000,
      maxSessions: Number(appConfig?.subAgentOrchestration?.maxConcurrentSessions) || 20
    });
    this.subAgentSessions.startSweep();
    this.imageCaptionCache = new ImageCaptionCache({
      maxEntries: 200,
      defaultTtlMs: 60 * 60 * 1000 // 1 hour
    });
    this.captionTimestamps = [];

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });
    this.voiceSessionManager = new VoiceSessionManager({
      client: this.client,
      store: this.store,
      appConfig: this.appConfig,
      llm: this.llm,
      memory: this.memory,
      search: this.search,
      browserManager: this.browserManager,
      composeOperationalMessage: (payload) => this.composeVoiceOperationalMessage(payload),
      generateVoiceTurn: (payload) => this.generateVoiceTurnReply(payload),
      getVoiceScreenShareCapability: (payload) => this.getVoiceScreenShareCapability(payload),
      offerVoiceScreenShareLink: (payload) => this.offerVoiceScreenShareLink(payload)
    });

    this.registerEvents();
  }

  attachScreenShareSessionManager(manager: ScreenShareSessionManagerLike | null) {
    this.screenShareSessionManager = manager || null;
  }

  toBotContext(): BotContext {
    return {
      appConfig: this.appConfig,
      store: this.store,
      llm: this.llm,
      memory: this.memory,
      client: this.client,
      botUserId: String(this.client.user?.id || "").trim() || null
    };
  }

  toAgentContext(): AgentContext {
    return {
      ...this.toBotContext(),
      browserManager: this.browserManager,
      activeBrowserTasks: this.activeBrowserTasks,
      subAgentSessions: this.subAgentSessions
    };
  }

  toBudgetContext(): BudgetContext {
    return {
      ...this.toBotContext(),
      search: this.search,
      video: this.video,
      browserManager: this.browserManager,
      imageCaptionCache: this.imageCaptionCache
    };
  }

  toMediaAttachmentContext(): MediaAttachmentContext {
    return {
      ...this.toBudgetContext(),
      gifs: this.gifs
    };
  }

  toScreenShareRuntime() {
    return {
      ...this.toBotContext(),
      screenShareSessionManager: this.screenShareSessionManager,
      composeVoiceOperationalMessage: (payload) => this.composeVoiceOperationalMessage(payload),
      composeScreenShareOfferMessage: (payload) => this.composeScreenShareOfferMessage(payload),
      composeScreenShareUnavailableMessage: (payload) => this.composeScreenShareUnavailableMessage(payload),
      resolveOperationalChannel: (channel, channelId, meta = {}) =>
        this.resolveOperationalChannel(channel, channelId, meta),
      sendToChannel: (channel, text, meta = {}) => this.sendToChannel(channel, text, meta)
    };
  }

  toVoiceCoordinationRuntime() {
    return {
      ...this.toBotContext(),
      client: this.client,
      voiceSessionManager: this.voiceSessionManager,
      toVoiceReplyRuntime: () => this.toVoiceReplyRuntime()
    };
  }

  toDiscoveryEngineRuntime() {
    const runtime = {
      ...this.toBotContext(),
      client: this.client,
      discovery: this.discovery,
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings),
      hydrateRecentMessages: (channel, limit) => this.hydrateRecentMessages(channel, limit),
      loadRelevantMemoryFacts: (payload) => this.loadRelevantMemoryFacts(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      getImageBudgetState: (settings) => this.getImageBudgetState(settings),
      getVideoGenerationBudgetState: (settings) => this.getVideoGenerationBudgetState(settings),
      getMediaGenerationCapabilities: (settings) => this.getMediaGenerationCapabilities(settings),
      getEmojiHints: (guild) => this.getEmojiHints(guild),
      resolveMediaAttachment: (payload) => this.resolveMediaAttachment(payload),
      composeMessageContentForHistory: (message, baseText) =>
        this.composeMessageContentForHistory(message, baseText),
      markSpoke: () => this.markSpoke(),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      isChannelAllowed: (settings, channelId) => this.isChannelAllowed(settings, channelId),
      discoveryPosting: this.discoveryPosting
    };

    Object.defineProperty(runtime, "discoveryPosting", {
      get: () => this.discoveryPosting,
      set: (value) => {
        this.discoveryPosting = Boolean(value);
      },
      enumerable: true
    });

    return runtime;
  }

  toAutomationEngineRuntime() {
    const runtime = {
      ...this.toBotContext(),
      client: this.client,
      search: this.search,
      isChannelAllowed: (settings, channelId) => this.isChannelAllowed(settings, channelId),
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      markSpoke: () => this.markSpoke(),
      composeMessageContentForHistory: (message, baseText) =>
        this.composeMessageContentForHistory(message, baseText),
      loadPromptMemorySlice: (payload) => this.loadPromptMemorySlice(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      buildMemoryLookupContext: (payload) => this.buildMemoryLookupContext(payload),
      getImageBudgetState: (settings) => this.getImageBudgetState(settings),
      getVideoGenerationBudgetState: (settings) => this.getVideoGenerationBudgetState(settings),
      getGifBudgetState: (settings) => this.getGifBudgetState(settings),
      getMediaGenerationCapabilities: (settings) => this.getMediaGenerationCapabilities(settings),
      resolveMediaAttachment: (payload) => this.resolveMediaAttachment(payload),
      automationCycleRunning: this.automationCycleRunning
    };

    Object.defineProperty(runtime, "automationCycleRunning", {
      get: () => this.automationCycleRunning,
      set: (value) => {
        this.automationCycleRunning = Boolean(value);
      },
      enumerable: true
    });

    return runtime;
  }

  toTextThoughtLoopRuntime() {
    const runtime = {
      ...this.toBotContext(),
      client: this.client,
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings),
      maybeReplyToMessage: (message, settings, options) => this.maybeReplyToMessage(message, settings, options),
      isChannelAllowed: (settings, channelId) => this.isChannelAllowed(settings, channelId),
      isNonPrivateReplyEligibleChannel: (channel) => this.isNonPrivateReplyEligibleChannel(channel),
      hydrateRecentMessages: (channel, limit) => this.hydrateRecentMessages(channel, limit),
      hasBotMessageInRecentWindow: (payload) => this.hasBotMessageInRecentWindow(payload),
      textThoughtLoopRunning: this.textThoughtLoopRunning
    };

    Object.defineProperty(runtime, "textThoughtLoopRunning", {
      get: () => this.textThoughtLoopRunning,
      set: (value) => {
        this.textThoughtLoopRunning = Boolean(value);
      },
      enumerable: true
    });

    return runtime;
  }

  toQueueGatewayRuntime(): QueueGatewayRuntime {
    const runtime: QueueGatewayRuntime = {
      ...this.toBotContext(),
      lastBotMessageAt: this.lastBotMessageAt,
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      replyQueues: this.replyQueues,
      replyQueueWorkers: this.replyQueueWorkers,
      replyQueuedMessageIds: this.replyQueuedMessageIds,
      isStopping: this.isStopping,
      isChannelAllowed: (settings, channelId) => this.isChannelAllowed(settings, channelId),
      isUserBlocked: (settings, userId) => this.isUserBlocked(settings, userId),
      getReplyAddressSignal: (settings, message, recentMessages = []) =>
        this.getReplyAddressSignal(settings, message, recentMessages),
      maybeReplyToMessage: (message, settings, options = {}) =>
        this.maybeReplyToMessage(message, settings, options),
      reconnectInFlight: this.reconnectInFlight,
      hasConnectedAtLeastOnce: this.hasConnectedAtLeastOnce,
      lastGatewayEventAt: this.lastGatewayEventAt,
      reconnectTimeout: this.reconnectTimeout,
      markGatewayEvent: () => this.markGatewayEvent(),
      reconnectAttempts: this.reconnectAttempts
    };

    Object.defineProperties(runtime, {
      lastBotMessageAt: {
        get: () => this.lastBotMessageAt,
        set: (value) => {
          this.lastBotMessageAt = Number(value) || 0;
        },
        enumerable: true
      },
      isStopping: {
        get: () => this.isStopping,
        set: (value) => {
          this.isStopping = Boolean(value);
        },
        enumerable: true
      },
      reconnectInFlight: {
        get: () => this.reconnectInFlight,
        set: (value) => {
          this.reconnectInFlight = Boolean(value);
        },
        enumerable: true
      },
      hasConnectedAtLeastOnce: {
        get: () => this.hasConnectedAtLeastOnce,
        set: (value) => {
          this.hasConnectedAtLeastOnce = Boolean(value);
        },
        enumerable: true
      },
      lastGatewayEventAt: {
        get: () => this.lastGatewayEventAt,
        set: (value) => {
          this.lastGatewayEventAt = Number(value) || Date.now();
        },
        enumerable: true
      },
      reconnectTimeout: {
        get: () => this.reconnectTimeout,
        set: (value) => {
          this.reconnectTimeout = value;
        },
        enumerable: true
      },
      reconnectAttempts: {
        get: () => this.reconnectAttempts,
        set: (value) => {
          this.reconnectAttempts = Number(value) || 0;
        },
        enumerable: true
      }
    });

    return runtime;
  }

  toReplyPipelineRuntime(): ReplyPipelineRuntime {
    return {
      ...this.toBotContext(),
      gifs: this.gifs,
      search: this.search,
      voiceSessionManager: this.voiceSessionManager,
      getReplyAddressSignal: (settings, message, recentMessages = []) =>
        this.getReplyAddressSignal(settings, message, recentMessages),
      isReplyChannel: (settings, channelId) => this.isReplyChannel(settings, channelId),
      getReactionEmojiOptions: (guild) => this.getReactionEmojiOptions(guild),
      shouldAttemptReplyDecision: (payload) => this.shouldAttemptReplyDecision(payload),
      loadPromptMemorySlice: (payload) => this.loadPromptMemorySlice(payload),
      getRecentLookupContextForPrompt: (payload) => this.getRecentLookupContextForPrompt(payload),
      getConversationHistoryForPrompt: (payload) => this.getConversationHistoryForPrompt(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      getImageInputs: (message) => this.getImageInputs(message),
      getImageBudgetState: (settings) => this.getImageBudgetState(settings),
      getVideoGenerationBudgetState: (settings) => this.getVideoGenerationBudgetState(settings),
      getMediaGenerationCapabilities: (settings) => this.getMediaGenerationCapabilities(settings),
      getGifBudgetState: (settings) => this.getGifBudgetState(settings),
      buildWebSearchContext: (settings, messageText) => this.buildWebSearchContext(settings, messageText),
      buildBrowserBrowseContext: (settings) => this.buildBrowserBrowseContext(settings),
      buildMemoryLookupContext: (payload) => this.buildMemoryLookupContext(payload),
      buildVideoReplyContext: (payload) => this.buildVideoReplyContext(payload),
      buildImageLookupContext: (payload) => this.buildImageLookupContext(payload),
      getAutoIncludeImageInputs: (payload) => this.getAutoIncludeImageInputs(payload),
      captionRecentHistoryImages: (payload) => this.captionRecentHistoryImages(payload),
      getVoiceScreenShareCapability: (payload) => this.getVoiceScreenShareCapability(payload),
      getEmojiHints: (guild) => this.getEmojiHints(guild),
      runModelRequestedBrowserBrowse: (payload) => this.runModelRequestedBrowserBrowse(payload),
      runModelRequestedCodeTask: (payload) => this.runModelRequestedCodeTask(payload),
      buildSubAgentSessionsRuntime: () => this.buildSubAgentSessionsRuntime(),
      runModelRequestedImageLookup: (payload) => this.runModelRequestedImageLookup(payload),
      mergeImageInputs: (payload) => this.mergeImageInputs(payload),
      maybeHandleStructuredVoiceIntent: (payload) => this.maybeHandleStructuredVoiceIntent(payload),
      maybeHandleStructuredAutomationIntent: (payload) =>
        this.maybeHandleStructuredAutomationIntent(payload),
      rememberRecentLookupContext: (payload) => this.rememberRecentLookupContext(payload),
      maybeApplyReplyReaction: (payload) => this.maybeApplyReplyReaction(payload),
      logSkippedReply: (payload) => this.logSkippedReply(payload),
      maybeHandleScreenShareOfferIntent: (payload) => this.maybeHandleScreenShareOfferIntent(payload),
      resolveMediaAttachment: (payload) => this.resolveMediaAttachment(payload),
      maybeAttachReplyGif: (payload) => this.maybeAttachReplyGif(payload),
      maybeAttachGeneratedImage: (payload) => this.maybeAttachGeneratedImage(payload),
      maybeAttachGeneratedVideo: (payload) => this.maybeAttachGeneratedVideo(payload),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      shouldSendAsReply: (payload) => this.shouldSendAsReply(payload),
      markSpoke: () => this.markSpoke(),
      composeMessageContentForHistory: (message, baseText) =>
        this.composeMessageContentForHistory(message, baseText),
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings)
    };
  }

  toVoiceReplyRuntime(): VoiceReplyRuntime {
    return {
      ...this.toBotContext(),
      search: this.search,
      loadRelevantMemoryFacts: (payload) => this.loadRelevantMemoryFacts(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      loadPromptMemorySlice: (payload) => this.loadPromptMemorySlice(payload),
      buildWebSearchContext: (settings, messageText) => this.buildWebSearchContext(settings, messageText),
      loadRecentConversationHistory: (payload) => this.getConversationHistoryForPrompt(payload),
      loadRecentLookupContext: (payload) => this.getRecentLookupContextForPrompt(payload),
      rememberRecentLookupContext: (payload) => this.rememberRecentLookupContext(payload),
      getVoiceScreenShareCapability: (payload) => this.getVoiceScreenShareCapability(payload),
      offerVoiceScreenShareLink: (payload) => this.offerVoiceScreenShareLink(payload),
      runModelRequestedBrowserBrowse: (payload) => this.runModelRequestedBrowserBrowse(payload),
      buildBrowserBrowseContext: (settings) => this.buildBrowserBrowseContext(settings),
      runModelRequestedCodeTask: (payload) => this.runModelRequestedCodeTask(payload)
    };
  }

  registerEvents() {
    this.client.on("clientReady", async () => {
      this.hasConnectedAtLeastOnce = true;
      this.reconnectAttempts = 0;
      this.markGatewayEvent();
      console.log(`Logged in as ${this.client.user?.tag || "unknown"}`);

      try {
        const rest = new REST({ version: "10" }).setToken(this.appConfig.discordToken);
        await rest.put(Routes.applicationCommands(this.client.user?.id || ""), { body: [...musicCommands, clankCommand, browseCommand, codeCommand] });
        console.log("[slashCommands] Registered slash commands");
      } catch (error) {
        console.error("[musicCommands] Failed to register slash commands:", error);
      }
    });

    this.client.on("shardResume", () => {
      this.markGatewayEvent();
    });

    this.client.on("shardDisconnect", (event, shardId) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_disconnect: shard=${shardId} code=${event?.code ?? "unknown"}`
      });
    });

    this.client.on("shardError", (error, shardId) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_error: shard=${shardId} ${String(error?.message || error)}`
      });
    });

    this.client.on("error", (error) => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_error: ${String(error?.message || error)}`
      });
    });

    this.client.on("invalidated", () => {
      this.markGatewayEvent();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: "gateway_session_invalidated"
      });
      this.scheduleReconnect("session_invalidated", 2_000);
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id,
          content: String(error?.message || error)
        });
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const { commandName } = interaction;
      if (["play", "stop", "pause", "resume", "skip"].includes(commandName)) {
        try {
          await this.voiceSessionManager.handleMusicSlashCommand(interaction, this.store.getSettings());
        } catch (error) {
          console.error("[slashCommands] Error handling music command:", error);
          await interaction.reply({ content: "An error occurred processing your command.", ephemeral: true });
        }
      } else if (commandName === "clank") {
        try {
          await this.voiceSessionManager.handleClankSlashCommand(interaction, this.store.getSettings());
        } catch (error) {
          console.error("[slashCommands] Error handling clank command:", error);
          await interaction.reply({ content: "An error occurred processing your command.", ephemeral: true });
        }
      } else if (commandName === "browse") {
        await interaction.deferReply();
        const browseInstruction = interaction.options.getString("task", true);
        const settings = this.store.getSettings();
        try {
          const browserContext = this.buildBrowserBrowseContext(settings);
          if (!browserContext.configured) {
            await interaction.editReply("Browser runtime is currently unavailable on this server.");
            return;
          }
          if (!browserContext.enabled) {
            await interaction.editReply("Browser runtime is disabled in settings on this server.");
            return;
          }

          const result = await this.runModelRequestedBrowserBrowse({
            settings,
            browserBrowse: browserContext,
            query: browseInstruction,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            source: "slash_command_browse"
          });

          let responseText = String(result.text || "").trim();
          if (result.error) {
            responseText = result.error;
          }
          if (result.hitStepLimit) {
            responseText += "\n\n*(Note: I reached my maximum step limit before finishing the task completely.)*";
          }
          if (!responseText) {
            responseText = "Browser task completed with no text result.";
          }

          if (responseText.length > 2000) {
            await interaction.editReply(responseText.substring(0, 1997) + "...");
          } else {
            await interaction.editReply(responseText);
          }
        } catch (error) {
          console.error("[slashCommands] Error handling browse command:", error);
          const message = error instanceof Error ? error.message : String(error);
          if (isAbortError(error)) {
            await interaction.editReply("Browser session was cancelled.").catch(() => undefined);
          } else {
            await interaction.editReply(`An error occurred while browsing: ${message}`).catch(() => undefined);
          }
        }
      } else if (commandName === "code") {
        await interaction.deferReply();
        const codeInstruction = interaction.options.getString("task", true);
        const codeCwd = interaction.options.getString("cwd", false) || undefined;
        const settings = this.store.getSettings();

        if (!isDevTaskEnabled(settings)) {
          await interaction.editReply("Code agent is disabled in settings.");
          return;
        }
        if (!isCodeAgentUserAllowed(interaction.user.id, settings)) {
          await interaction.editReply("This capability is restricted to allowed users.");
          return;
        }

        const codeAgentConfig = resolveCodeAgentConfig(settings, codeCwd);
        const maxParallel = codeAgentConfig.maxParallelTasks;
        if (getActiveCodeAgentTaskCount() >= maxParallel) {
          await interaction.editReply("Too many code agent tasks are already running. Try again shortly.");
          return;
        }
        const maxPerHour = codeAgentConfig.maxTasksPerHour;
        const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const usedThisHour = this.store.countActionsSince("code_agent_call", since1h);
        if (usedThisHour >= maxPerHour) {
          await interaction.editReply("Code agent is currently blocked by hourly limits. Try again shortly.");
          return;
        }

        try {
          const {
            cwd,
            provider,
            model,
            codexModel,
            maxTurns,
            timeoutMs,
            maxBufferBytes
          } = codeAgentConfig;

          const result = await runCodeAgent({
            instruction: codeInstruction,
            cwd,
            provider,
            maxTurns,
            timeoutMs,
            maxBufferBytes,
            model,
            codexModel,
            openai: this.llm?.openai || null,
            trace: {
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              userId: interaction.user.id,
              source: "slash_command_code"
            },
            store: this.store
          });

          let responseText = result.text;
          if (result.costUsd > 0) {
            responseText += `\n\n*(Cost: $${result.costUsd.toFixed(4)})*`;
          }
          if (responseText.length > 2000) {
            await interaction.editReply(responseText.substring(0, 1997) + "...");
          } else {
            await interaction.editReply(responseText || "Code task completed with no output.");
          }
        } catch (error) {
          console.error("[slashCommands] Error handling code command:", error);
          const message = error instanceof Error ? error.message : String(error);
          await interaction.editReply(`An error occurred while running code task: ${message}`).catch(() => undefined);
        }
      }
    });

    this.client.on("messageReactionAdd", async (reaction, user) => {
      try {
        await this.recordReactionHistoryEvent(reaction, user);
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_add: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemove", async (reaction) => {
      try {
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemoveAll", async (message) => {
      try {
        await this.syncMessageSnapshot(message);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: message?.guildId,
          channelId: message?.channelId,
          messageId: message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove_all: ${String(error?.message || error)}`
        });
      }
    });

    this.client.on("messageReactionRemoveEmoji", async (reaction) => {
      try {
        await this.syncMessageSnapshotFromReaction(reaction);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: reaction?.message?.guildId,
          channelId: reaction?.message?.channelId,
          messageId: reaction?.message?.id,
          userId: this.client.user?.id,
          content: `reaction_sync_remove_emoji: ${String(error?.message || error)}`
        });
      }
    });
  }

  async start() {
    this.isStopping = false;
    await this.client.login(this.appConfig.discordToken);
    this.markGatewayEvent();

    this.memoryTimer = setInterval(() => {
      this.memory.refreshMemoryMarkdown().catch(() => undefined);
    }, 5 * 60_000);

    this.discoveryTimer = setInterval(() => {
      this.maybeRunDiscoveryCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `discovery_cycle: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);
    this.textThoughtLoopTimer = setInterval(() => {
      this.maybeRunTextThoughtLoopCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `text_thought_loop: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);
    this.automationTimer = setInterval(() => {
      this.maybeRunAutomationCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `automation_cycle: ${String(error?.message || error)}`
        });
      });
    }, AUTOMATION_TICK_MS);
    this.gatewayWatchdogTimer = setInterval(() => {
      this.ensureGatewayHealthy().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          userId: this.client.user?.id,
          content: `gateway_watchdog: ${String(error?.message || error)}`
        });
      });
    }, GATEWAY_WATCHDOG_TICK_MS);
    this.reflectionTimer = setInterval(() => {
      this.maybeRunReflection().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `reflection_cycle: ${String(error?.message || error)}`
        });
      });
    }, REFLECTION_TICK_MS);

    this.startupTimeout = setTimeout(() => {
      if (this.isStopping) return;
      this.runStartupTasks().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `startup_tasks: ${String(error?.message || error)}`
        });
      });
    }, STARTUP_TASK_DELAY_MS);
  }

  async stop() {
    this.isStopping = true;
    if (this.startupTimeout) clearTimeout(this.startupTimeout);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.textThoughtLoopTimer) clearInterval(this.textThoughtLoopTimer);
    if (this.automationTimer) clearInterval(this.automationTimer);
    if (this.gatewayWatchdogTimer) clearInterval(this.gatewayWatchdogTimer);
    if (this.reflectionTimer) clearInterval(this.reflectionTimer);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.gatewayWatchdogTimer = null;
    this.reflectionTimer = null;
    this.automationTimer = null;
    this.reconnectTimeout = null;
    this.startupTimeout = null;
    this.replyQueues.clear();
    this.replyQueueWorkers.clear();
    this.replyQueuedMessageIds.clear();
    await this.voiceSessionManager.dispose("shutdown");
    if (this.memory?.drainIngestQueue) {
      await this.memory.drainIngestQueue({ timeoutMs: 4000 }).catch(() => undefined);
    }
    if (this.browserManager?.closeAll) {
      await this.browserManager.closeAll().catch(() => undefined);
    }
    await this.client.destroy();
  }

  getRuntimeState() {
    return {
      isReady: this.client.isReady(),
      userTag: this.client.user?.tag ?? null,
      guildCount: this.client.guilds.cache.size,
      lastBotMessageAt: this.lastBotMessageAt ? new Date(this.lastBotMessageAt).toISOString() : null,
      replyQueue: {
        channels: this.replyQueues.size,
        pending: this.getReplyQueuePendingCount()
      },
      gateway: {
        hasConnectedAtLeastOnce: this.hasConnectedAtLeastOnce,
        reconnectInFlight: this.reconnectInFlight,
        reconnectAttempts: this.reconnectAttempts,
        lastGatewayEventAt: this.lastGatewayEventAt
          ? new Date(this.lastGatewayEventAt).toISOString()
          : null
      },
      voice: this.voiceSessionManager.getRuntimeState()
    };
  }

  getGuilds() {
    return [...this.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
  }

  getGuildChannels(guildId: string) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    const results: { id: string; name: string; type: string; category: string | null }[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased?.() && !channel.isVoiceBased?.()) continue;
      const type = channel.isVoiceBased?.() ? "voice" : "text";
      const category = (channel as { parent?: { name?: string } | null }).parent?.name ?? null;
      results.push({ id: channel.id, name: channel.name, type, category });
    }
    results.sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
    return results;
  }

  resolveDashboardVoiceJoinRequester(guild, requesterUserId = "") {
    return resolveDashboardVoiceJoinRequesterForVoiceCoordination(guild, requesterUserId);
  }

  resolveDashboardVoiceJoinTextChannel({ guild, textChannelId = "" }) {
    return resolveDashboardVoiceJoinTextChannelForVoiceCoordination(this.toVoiceCoordinationRuntime(), {
      guild,
      textChannelId
    });
  }

  async requestVoiceJoinFromDashboard({
    guildId = null,
    requesterUserId = null,
    textChannelId = null,
    source = "dashboard_voice_tab"
  } = {}) {
    return await requestVoiceJoinFromDashboardForVoiceCoordination(this.toVoiceCoordinationRuntime(), {
      guildId,
      requesterUserId,
      textChannelId,
      source
    });
  }

  async applyRuntimeSettings(nextSettings = null) {
    const settings = nextSettings || this.store.getSettings();
    await this.voiceSessionManager.reconcileSettings(settings);
  }

  async ingestVoiceStreamFrame({
    guildId,
    streamerUserId = null,
    mimeType = "image/jpeg",
    dataBase64 = "",
    source = "api_stream_ingest"
  }) {
    const settings = this.store.getSettings();
    return await this.voiceSessionManager.ingestStreamFrame({
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings
    });
  }

  markGatewayEvent() {
    this.lastGatewayEventAt = Date.now();
  }

  getReplyQueuePendingCount() {
    let total = 0;
    for (const queue of this.replyQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  enqueueReplyJob({
    message,
    source,
    forceRespond = false,
    addressSignal = null,
    performanceSeed = null
  }) {
    if (!message?.id || !message?.channelId) return false;

    const messageId = String(message.id);
    if (!messageId) return false;
    if (this.replyQueuedMessageIds.has(messageId)) return false;
    if (this.store.hasTriggeredResponse(messageId)) return false;

    const channelId = String(message.channelId);
    const queue = this.replyQueues.get(channelId) || [];
    if (queue.length >= REPLY_QUEUE_MAX_PER_CHANNEL) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId,
        userId: message.author?.id || null,
        content: `reply_queue_overflow: limit=${REPLY_QUEUE_MAX_PER_CHANNEL}`
      });
      return false;
    }

    queue.push({
      message,
      source: source || "message_event",
      forceRespond: Boolean(forceRespond),
      addressSignal,
      performanceSeed: normalizeReplyPerformanceSeed({
        triggerMessageCreatedAtMs: message?.createdTimestamp,
        queuedAtMs: Date.now(),
        ingestMs: performanceSeed?.ingestMs
      }),
      attempts: 0
    });
    this.replyQueues.set(channelId, queue);
    this.replyQueuedMessageIds.add(messageId);

    this.processReplyQueue(channelId).catch((error) => {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId,
        userId: message.author?.id || null,
        content: `reply_queue_worker: ${String(error?.message || error)}`
      });
    });

    return true;
  }

  getReplyQueueWaitMs(settings) {
    return getReplyQueueWaitMs(this.toQueueGatewayRuntime(), settings);
  }

  getReplyCoalesceWindowMs(settings) {
    return getReplyCoalesceWindowMs(settings);
  }

  getReplyCoalesceMaxMessages(settings) {
    return getReplyCoalesceMaxMessages(settings);
  }

  getReplyCoalesceWaitMs(settings, message) {
    return getReplyCoalesceWaitMs(settings, message);
  }

  dequeueReplyJob(channelId) {
    return dequeueReplyJob(this.toQueueGatewayRuntime(), channelId);
  }

  dequeueReplyBurst(channelId, settings) {
    return dequeueReplyBurst(this.toQueueGatewayRuntime(), channelId, settings);
  }

  requeueReplyJobs(channelId, jobs) {
    return requeueReplyJobs(this.toQueueGatewayRuntime(), channelId, jobs);
  }

  async processReplyQueue(channelId) {
    return await processReplyQueue(this.toQueueGatewayRuntime(), channelId);
  }

  async ensureGatewayHealthy() {
    return await ensureGatewayHealthy(this.toQueueGatewayRuntime());
  }

  scheduleReconnect(reason, delayMs) {
    return scheduleReconnect(this.toQueueGatewayRuntime(), reason, delayMs);
  }

  async reconnectGateway(reason) {
    return await reconnectGateway(this.toQueueGatewayRuntime(), reason);
  }

  async handleMessage(message) {
    if (!message.guild || !message.channel || !message.author) return;

    const settings = this.store.getSettings();

    const text = String(message.content || "").trim();
    const recordedContent = this.composeMessageContentForHistory(message, text);
    this.store.recordMessage({
      messageId: message.id,
      createdAt: message.createdTimestamp,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.username,
      isBot: message.author.bot,
      content: recordedContent,
      referencedMessageId: message.reference?.messageId
    });

    if (String(message.author.id) === String(this.client.user?.id || "")) return;
    if (!this.isChannelAllowed(settings, message.channelId)) return;
    if (this.isUserBlocked(settings, message.author.id)) return;

    const lowerText = text.toLowerCase().trim();
    if (lowerText === "stop" || lowerText === "cancel" || lowerText === "never mind" || lowerText === "nevermind") {
      const scopeKey = buildBrowserTaskScopeKey({
        guildId: message.guildId,
        channelId: message.channelId
      });
      const cancelled = this.activeBrowserTasks.abort(scopeKey, "User requested cancellation via text");
      if (cancelled) {
        await message.reply("Cancelled the active browser session.").catch(() => undefined);
        return;
      }
    }

    const musicSelectionHandled = await this.voiceSessionManager.maybeHandleMusicTextSelectionRequest({
      message,
      settings
    });
    if (musicSelectionHandled) return;
    const musicStopHandled = await this.voiceSessionManager.maybeHandleMusicTextStopRequest({
      message,
      settings
    });
    if (musicStopHandled) return;

    const memorySettings = getMemorySettings(settings);
    if (memorySettings.enabled) {
      void this.memory.ingestMessage({
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.member?.displayName || message.author.username,
        content: text,
        settings,
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id
        }
      }).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author.id,
          content: `memory_ingest: ${String(error?.message || error)}`
        });
      });
    }

    const recentMessages = this.store.getRecentMessages(
      message.channelId,
      memorySettings.promptSlice.maxRecentMessages
    );
    const addressSignal = await this.getReplyAddressSignal(settings, message, recentMessages);
    const shouldQueueReply = this.shouldAttemptReplyDecision({
      settings,
      recentMessages,
      addressSignal,
      forceRespond: false,
      triggerMessageId: message.id
    });
    if (!shouldQueueReply) return;
    this.enqueueReplyJob({
      source: "message_event",
      message,
      forceRespond: shouldForceRespondForAddressSignalForReplyAdmission(addressSignal),
      addressSignal
    });
  }

  async composeVoiceOperationalMessage({
    settings,
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = "voice_runtime",
    reason = null,
    details = {},
    maxOutputChars = 180,
    allowSkip = false
  }) {
    return await composeVoiceOperationalMessageForVoiceCoordination(this.toVoiceCoordinationRuntime(), {
      settings,
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason,
      details,
      maxOutputChars,
      allowSkip
    });
  }

  async generateVoiceTurnReply({
    settings,
    guildId = null,
    channelId = null,
    userId = null,
    transcript = "",
    inputKind = "transcript",
    contextMessages = [],
    sessionId = null,
    isEagerTurn = false,
    sessionTiming = null,
    joinWindowActive = false,
    joinWindowAgeMs = null,
    voiceEagerness = 0,
    conversationContext = null,
    participantRoster = [],
    recentMembershipEvents = [],
    soundboardCandidates = [],
    onWebLookupStart = null,
    onWebLookupComplete = null,
    webSearchTimeoutMs = null,
    voiceToolCallbacks = null
  }) {
    return await generateVoiceTurnReplyForVoiceCoordination(this.toVoiceCoordinationRuntime(), {
      settings,
      guildId,
      channelId,
      userId,
      transcript,
      inputKind,
      contextMessages,
      sessionId,
      isEagerTurn,
      sessionTiming,
      joinWindowActive,
      joinWindowAgeMs,
      voiceEagerness,
      conversationContext,
      participantRoster,
      recentMembershipEvents,
      soundboardCandidates,
      onWebLookupStart,
      onWebLookupComplete,
      webSearchTimeoutMs,
      voiceToolCallbacks
    });
  }

  shouldSendAsReply({ isReplyChannel = false, shouldThreadReply = false, replyText = "" } = {}) {
    if (!shouldThreadReply) return false;
    const textLength = String(replyText || "").trim().length;
    const isShortReply = textLength > 0 && textLength <= 30;
    if (isShortReply) return chance(0.25);
    if (!isReplyChannel) return chance(0.82);
    return chance(0.55);
  }

  shouldSkipSimulatedTypingDelay() {
    if (this.appConfig?.disableSimulatedTypingDelay === true) return true;
    return IS_TEST_PROCESS;
  }

  getSimulatedTypingDelayMs(minMs, jitterMs) {
    if (this.shouldSkipSimulatedTypingDelay()) return 0;
    return minMs + Math.floor(Math.random() * jitterMs);
  }

  async maybeReplyToMessage(message, settings, options: ReplyAttemptOptions = {}) {
    return await maybeReplyToMessagePipeline(this.toReplyPipelineRuntime(), message, settings, options);
  }

  getVoiceScreenShareCapability({
    settings: _settings = null,
    guildId: _guildId = null,
    channelId: _channelId = null,
    requesterUserId: _requesterUserId = null
  } = {}) {
    return getVoiceScreenShareCapabilityForScreenShare(this.toScreenShareRuntime(), {
      settings: _settings,
      guildId: _guildId,
      channelId: _channelId,
      requesterUserId: _requesterUserId
    });
  }

  async offerVoiceScreenShareLink({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    transcript = "",
    source = "voice_turn_directive"
  } = {}) {
    return await offerVoiceScreenShareLinkForScreenShare(this.toScreenShareRuntime(), {
      settings,
      guildId,
      channelId,
      requesterUserId,
      transcript,
      source
    });
  }

  async maybeHandleStructuredVoiceIntent({ message, settings, replyDirective }) {
    if (!settings?.voice?.enabled) return false;

    const intent = replyDirective?.voiceIntent;
    if (!intent?.intent) return false;

    const threshold = clamp(
      Number(getVoiceAdmissionSettings(settings).intentConfidenceThreshold) || 0.75,
      0.4,
      0.99
    );
    if (intent.confidence < threshold) return false;

    this.store.logAction({
      kind: "voice_intent_detected",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      content: intent.intent,
      metadata: {
        confidence: intent.confidence,
        threshold,
        detector: "reply_llm",
        reason: intent.reason || null
      }
    });

    if (intent.intent === "join") {
      return await this.voiceSessionManager.requestJoin({
        message,
        settings,
        intentConfidence: intent.confidence
      });
    }

    if (intent.intent === "leave") {
      return await this.voiceSessionManager.requestLeave({
        message,
        settings,
        reason: "nl_leave"
      });
    }

    if (intent.intent === "status") {
      return await this.voiceSessionManager.requestStatus({
        message,
        settings
      });
    }

    if (intent.intent === "watch_stream") {
      return await this.voiceSessionManager.requestWatchStream({
        message,
        settings,
        targetUserId: message.author?.id || null
      });
    }

    if (intent.intent === "stop_watching_stream") {
      return await this.voiceSessionManager.requestStopWatchingStream({
        message,
        settings
      });
    }

    if (intent.intent === "stream_status") {
      return await this.voiceSessionManager.requestStreamWatchStatus({
        message,
        settings
      });
    }

    if (
      intent.intent === "music_play_now" ||
      intent.intent === "music_queue_next" ||
      intent.intent === "music_queue_add"
    ) {
      const query = String(intent.query || "").trim();
      const trackId = String(intent.selectedResultId || "").trim() || null;
      const platform = String(intent.platform || "").trim().toLowerCase() || "auto";
      const searchResults = Array.isArray(intent.searchResults) ? intent.searchResults : null;
      const action =
        intent.intent === "music_queue_next"
          ? "queue_next"
          : intent.intent === "music_queue_add"
            ? "queue_add"
            : "play_now";
      return await this.voiceSessionManager.requestPlayMusic({
        message,
        settings,
        query,
        trackId,
        platform,
        action,
        searchResults,
        reason: `nl_${intent.intent}`,
        source: "text_voice_intent"
      });
    }

    if (intent.intent === "music_stop") {
      return await this.voiceSessionManager.requestStopMusic({
        message,
        settings,
        reason: "nl_music_stop",
        clearQueue: true,
        source: "text_voice_intent"
      });
    }

    if (intent.intent === "music_pause") {
      return await this.voiceSessionManager.requestPauseMusic({
        message,
        settings,
        reason: "nl_music_pause",
        source: "text_voice_intent"
      });
    }

    return false;
  }

  async maybeHandleStructuredAutomationIntent({
    message,
    settings,
    replyDirective,
    generation,
    source,
    triggerMessageIds = [],
    addressing = null,
    performance = null,
    replyPrompts = null
  }) {
    if (!settings?.automations?.enabled) return false;
    const automationAction = replyDirective?.automationAction;
    const operation = String(automationAction?.operation || "").trim();
    if (!operation) return false;

    const result = await applyAutomationControlAction(
      {
        store: this.store,
        client: this.client,
        isChannelAllowed: (runtimeSettings, channelId) =>
          this.isChannelAllowed(runtimeSettings, channelId),
        maybeRunAutomationCycle: () => this.maybeRunAutomationCycle()
      },
      {
        message,
        settings,
        automationAction
      }
    );
    if (!result || typeof result !== "object" || !("handled" in result) || result.handled !== true) {
      return false;
    }
    const resultDetailLines = "detailLines" in result && Array.isArray(result.detailLines)
      ? result.detailLines
      : [];
    const resultMetadata = "metadata" in result ? result.metadata : null;

    const finalText = composeAutomationControlReply({
      modelText: replyDirective?.text,
      detailLines: resultDetailLines
    });

    if (!finalText || finalText === "[SKIP]") {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "automation_control_reply_missing",
        metadata: {
          operation,
          source,
          automationControl: resultMetadata || null
        }
      });
      return true;
    }

    const typingStartedAtMs = Date.now();
    await message.channel.sendTyping();
    await sleep(this.getSimulatedTypingDelayMs(350, 800));
    const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);
    const sendStartedAtMs = Date.now();
    const sent = await message.reply({
      content: finalText,
      allowedMentions: { repliedUser: false }
    });
    const sendMs = Math.max(0, Date.now() - sendStartedAtMs);

    this.markSpoke();
    this.store.recordMessage({
      messageId: sent.id,
      createdAt: sent.createdTimestamp,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: this.client.user.id,
      authorName: getBotName(settings),
      isBot: true,
      content: this.composeMessageContentForHistory(sent, finalText),
      referencedMessageId: message.id
    });
    this.store.logAction({
      kind: "sent_reply",
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: this.client.user.id,
      content: finalText,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        sendAsReply: true,
        canStandalonePost: this.isReplyChannel(settings, message.channelId),
        addressing,
        replyPrompts,
        automationControl: resultMetadata || null,
        llm: {
          provider: generation?.provider || null,
          model: generation?.model || null,
          usage: generation?.usage || null,
          costUsd: generation?.costUsd || 0
        },
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind: "sent_reply",
          typingDelayMs,
          sendMs
        })
      }
    });

    return true;
  }

  async maybeHandleScreenShareOfferIntent({
    message,
    replyDirective,
    source = "message_event"
  }) {
    return await maybeHandleScreenShareOfferIntentForScreenShare(this.toScreenShareRuntime(), {
      message,
      settings: this.store.getSettings(),
      replyDirective,
      source
    });
  }

  async composeScreenShareOfferMessage({
    message,
    settings,
    linkUrl,
    expiresInMinutes,
    explicitRequest = false,
    intentRequested = false,
    confidence = 0,
    source = "message_event"
  }) {
    return await composeScreenShareOfferMessageForScreenShare(this.toScreenShareRuntime(), {
      message,
      settings,
      linkUrl,
      expiresInMinutes,
      explicitRequest,
      intentRequested,
      confidence,
      source
    });
  }

  async composeScreenShareUnavailableMessage({
    message,
    settings,
    reason = "unavailable",
    source = "message_event"
  }) {
    return await composeScreenShareUnavailableMessageForScreenShare(this.toScreenShareRuntime(), {
      message,
      settings,
      reason,
      source
    });
  }

  async resolveOperationalChannel(
    channel,
    channelId,
    { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await resolveOperationalChannelForScreenShare(this.toScreenShareRuntime(), channel, channelId, {
      guildId,
      userId,
      messageId,
      event,
      reason
    });
  }

  async sendToChannel(
    channel,
    text,
    { guildId = null, channelId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await sendToChannelForScreenShare(this.toScreenShareRuntime(), channel, text, {
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason
    });
  }

  async maybeApplyReplyReaction({
    message,
    settings,
    emojiOptions,
    emojiToken,
    generation,
    source,
    triggerMessageId,
    triggerMessageIds = [],
    addressing
  }) {
    const result = {
      requestedByModel: Boolean(emojiToken),
      used: false,
      emoji: null,
      blockedByPermission: false,
      blockedByHourlyCap: false,
      blockedByAllowedSet: false
    };
    const normalized = normalizeReactionEmojiToken(emojiToken);
    if (!normalized) return result;

    const permissions = getReplyPermissions(settings);
    if (!permissions.allowReactions) {
      return {
        ...result,
        blockedByPermission: true
      };
    }

    if (!this.canTakeAction("reacted", permissions.maxReactionsPerHour)) {
      return {
        ...result,
        blockedByHourlyCap: true
      };
    }

    if (!emojiOptions.includes(normalized)) {
      return {
        ...result,
        blockedByAllowedSet: true,
        emoji: normalized
      };
    }

    try {
      await message.react(normalized);
      this.store.logAction({
        kind: "reacted",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user.id,
        content: normalized,
        metadata: {
          source,
          triggerMessageId,
          triggerMessageIds,
          addressing,
          reason: "reply_directive",
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
      return {
        ...result,
        used: true,
        emoji: normalized
      };
    } catch {
      return {
        ...result,
        emoji: normalized
      };
    }
  }

  logSkippedReply({
    message,
    source,
    triggerMessageIds = [],
    addressSignal,
    generation = null,
    usedWebSearchFollowup = false,
    reason,
    reaction,
    screenShareOffer = null,
    performance = null,
    prompts = null,
    extraMetadata = null
  }) {
    const llmMetadata = generation
      ? {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd,
        usedWebSearchFollowup
      }
      : null;
    this.store.logAction({
      kind: "reply_skipped",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: this.client.user.id,
      content: reason,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        addressing: addressSignal,
        replyPrompts: prompts,
        reaction,
        screenShareOffer,
        llm: llmMetadata,
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind: "reply_skipped"
        }),
        ...(extraMetadata && typeof extraMetadata === "object" ? extraMetadata : {})
      }
    });
  }

  canTalkNow(settings) {
    const activity = getActivitySettings(settings);
    const elapsed = Date.now() - this.lastBotMessageAt;
    return elapsed >= activity.minSecondsBetweenMessages * 1000;
  }

  markSpoke() {
    this.lastBotMessageAt = Date.now();
  }

  canTakeAction(kind, maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const count = this.store.countActionsSince(kind, since);
    return count < maxPerHour;
  }

  canSendMessage(maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sentReplies = this.store.countActionsSince("sent_reply", since);
    const sentMessages = this.store.countActionsSince("sent_message", since);
    const discoveryPosts = this.store.countActionsSince("discovery_post", since);
    return sentReplies + sentMessages + discoveryPosts < maxPerHour;
  }

  getImageBudgetState(settings) {
    return getImageBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  getVideoGenerationBudgetState(settings) {
    return getVideoGenerationBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  getGifBudgetState(settings) {
    return getGifBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  getMediaGenerationCapabilities(settings) {
    return getMediaGenerationCapabilitiesForBudgetTracking(this.toBudgetContext(), settings);
  }

  isImageGenerationReady(settings, variant = "any") {
    return isImageGenerationReadyForBudgetTracking(this.toBudgetContext(), settings, variant);
  }

  isVideoGenerationReady(settings) {
    return isVideoGenerationReadyForBudgetTracking(this.toBudgetContext(), settings);
  }

  getWebSearchBudgetState(settings) {
    return getWebSearchBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  getBrowserBudgetState(settings) {
    return getBrowserBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  getVideoContextBudgetState(settings) {
    return getVideoContextBudgetStateForBudgetTracking(this.toBudgetContext(), settings);
  }

  async buildVideoReplyContext({ settings, message, recentMessages = [], trace = {} }) {
    return await buildVideoReplyContextForBudgetTracking(this.toBudgetContext(), {
      settings,
      message,
      recentMessages,
      trace
    });
  }

  /**
   * @param {{
   *   guildId?: string | null;
   *   channelId?: string | null;
   *   queryText?: string;
   *   limit?: number;
   *   maxAgeHours?: number;
   * }} options
   */
  getRecentLookupContextForPrompt({
    guildId = null,
    channelId = null,
    queryText = "",
    limit = LOOKUP_CONTEXT_PROMPT_LIMIT,
    maxAgeHours = LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
  } = {}) {
    return getRecentLookupContextForPromptForMessageHistory(this.toBotContext(), {
      guildId,
      channelId,
      queryText,
      limit,
      maxAgeHours
    });
  }

  /**
   * @param {{
   *   guildId?: string | null;
   *   channelId?: string | null;
   *   queryText?: string;
   *   limit?: number;
   *   maxAgeHours?: number;
   *   before?: number;
   *   after?: number;
   * }} options
   */
  getConversationHistoryForPrompt({
    guildId = null,
    channelId = null,
    queryText = "",
    limit = CONVERSATION_HISTORY_PROMPT_LIMIT,
    maxAgeHours = CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
    before = CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE,
    after = CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER
  } = {}) {
    return getConversationHistoryForPromptForMessageHistory(this.toBotContext(), {
      guildId,
      channelId,
      queryText,
      limit,
      maxAgeHours,
      before,
      after
    });
  }

  /**
   * @param {{
   *   guildId?: string | null;
   *   channelId?: string | null;
   *   userId?: string | null;
   *   source?: string;
   *   query?: string;
   *   provider?: string | null;
   *   results?: unknown[];
   * }} options
   */
  rememberRecentLookupContext({
    guildId = null,
    channelId = null,
    userId = null,
    source = "reply_web_lookup",
    query = "",
    provider = null,
    results = []
  } = {}) {
    return rememberRecentLookupContextForMessageHistory(this.toBotContext(), {
      guildId,
      channelId,
      userId,
      source,
      query,
      provider,
      results
    });
  }

  buildWebSearchContext(settings, messageText) {
    return buildWebSearchContextForBudgetTracking(this.toBudgetContext(), settings, messageText);
  }

  buildBrowserBrowseContext(settings) {
    return buildBrowserBrowseContextForBudgetTracking(this.toBudgetContext(), settings);
  }

  buildMemoryLookupContext({ settings }) {
    return buildMemoryLookupContextForBudgetTracking(this.toBudgetContext(), {
      settings
    });
  }

  buildImageLookupContext({ recentMessages = [], excludedUrls = [] } = {}) {
    return buildImageLookupContextForBudgetTracking(this.toBudgetContext(), {
      recentMessages,
      excludedUrls
    });
  }

  /**
   * Kick off async captioning for uncaptioned image candidates.
   * Fire-and-forget — errors are silently swallowed.
   */
  captionRecentHistoryImages({ candidates = [], settings = null, trace = null } = {}) {
    captionRecentHistoryImagesForImageAnalysis(this.toBotContext(), {
      imageCaptionCache: this.imageCaptionCache,
      captionTimestamps: this.captionTimestamps,
      candidates,
      settings,
      trace
    });
  }

  /**
   * Build auto-include image inputs from recent history candidates.
   * Returns the top N candidates as direct vision inputs for the LLM.
   */
  getAutoIncludeImageInputs({ candidates = [], maxImages = 3 } = {}) {
    return getAutoIncludeImageInputsForImageAnalysis({
      candidates,
      maxImages
    });
  }

  extractHistoryImageCandidates({ recentMessages = [], excluded = new Set<string>() } = {}) {
    return extractHistoryImageCandidatesForImageAnalysis({
      recentMessages,
      excluded,
      imageCaptionCache: this.imageCaptionCache
    });
  }

  rankImageLookupCandidates({ candidates = [], query = "" } = {}) {
    return rankImageLookupCandidatesForImageAnalysis({
      candidates,
      query
    });
  }

  async runModelRequestedImageLookup({
    imageLookup,
    query
  }) {
    return await runModelRequestedImageLookupForImageAnalysis({
      imageLookup,
      query
    });
  }

  async runModelRequestedBrowserBrowse({
    settings,
    browserBrowse,
    query,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_message"
  }) {
    return await runModelRequestedBrowserBrowseForAgentTasks(this.toAgentContext(), {
      settings,
      browserBrowse,
      query,
      guildId,
      channelId,
      userId,
      source
    });
  }

  async runModelRequestedCodeTask({
    settings,
    task,
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_message"
  }) {
    return await runModelRequestedCodeTaskForAgentTasks(this.toAgentContext(), {
      settings,
      task,
      cwd: cwdOverride,
      guildId,
      channelId,
      userId,
      source
    });
  }

  // ---------------------------------------------------------------------------
  // Sub-agent session factories for multi-turn interactive mode
  // ---------------------------------------------------------------------------

  createCodeAgentSession({
    settings,
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }) {
    return createCodeAgentSessionForAgentTasks(this.toAgentContext(), {
      settings,
      cwd: cwdOverride,
      guildId,
      channelId,
      userId,
      source
    });
  }

  createBrowserAgentSession({
    settings,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }) {
    return createBrowserAgentSessionForAgentTasks(this.toAgentContext(), {
      settings,
      guildId,
      channelId,
      userId,
      source
    });
  }

  /** Build the subAgentSessions runtime adapter for the reply tool pipeline. */
  buildSubAgentSessionsRuntime() {
    return buildSubAgentSessionsRuntimeForAgentTasks(this.toAgentContext());
  }

  mergeImageInputs({ baseInputs = [], extraInputs = [], maxInputs = MAX_MODEL_IMAGE_INPUTS } = {}) {
    return mergeImageInputsForImageAnalysis({
      baseInputs,
      extraInputs,
      maxInputs
    });
  }

  async loadPromptMemorySlice({
    settings,
    userId = null,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    source = "prompt_memory_slice"
  }) {
    return await loadPromptMemorySliceForMemorySlice(this.toBotContext(), {
      settings,
      userId,
      guildId,
      channelId,
      queryText,
      trace,
      source
    });
  }

  buildMediaMemoryFacts({ userFacts = [], relevantFacts = [], maxItems = 5 } = {}) {
    return buildMediaMemoryFactsForMemorySlice({
      userFacts,
      relevantFacts,
      maxItems
    });
  }

  getScopedFallbackFacts({ guildId, channelId = null, limit = 8 }) {
    return getScopedFallbackFactsForMemorySlice(this.toBotContext(), {
      guildId,
      channelId,
      limit
    });
  }

  async loadRelevantMemoryFacts({
    settings,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    limit = 8,
    fallbackWhenNoMatch = true
  }: {
    settings: {
      memory?: {
        enabled?: boolean;
      };
    } & Record<string, unknown>;
    guildId: string;
    channelId?: string | null;
    queryText?: string;
    trace?: Record<string, unknown> & {
      source?: string;
    };
    limit?: number;
    fallbackWhenNoMatch?: boolean;
  }) {
    return await loadRelevantMemoryFactsForMemorySlice(this.toBotContext(), {
      settings,
      guildId,
      channelId,
      queryText,
      trace,
      limit,
      fallbackWhenNoMatch
    });
  }

  async resolveMediaAttachment({ settings, text, directive = null, trace }) {
    return await resolveMediaAttachmentForMediaAttachment(this.toMediaAttachmentContext(), {
      settings,
      text,
      directive,
      trace
    });
  }

  async maybeAttachGeneratedImage({ settings, text, prompt, variant = "simple", trace }) {
    return await maybeAttachGeneratedImageForMediaAttachment(this.toMediaAttachmentContext(), {
      settings,
      text,
      prompt,
      variant,
      trace
    });
  }

  async maybeAttachGeneratedVideo({ settings, text, prompt, trace }) {
    return await maybeAttachGeneratedVideoForMediaAttachment(this.toMediaAttachmentContext(), {
      settings,
      text,
      prompt,
      trace
    });
  }

  async maybeAttachReplyGif({ settings, text, query, trace }) {
    return await maybeAttachReplyGifForMediaAttachment(this.toMediaAttachmentContext(), {
      settings,
      text,
      query,
      trace
    });
  }

  buildMessagePayloadWithImage(text, image) {
    return buildMessagePayloadWithImageForMediaAttachment(text, image);
  }

  buildMessagePayloadWithVideo(text, video) {
    return buildMessagePayloadWithVideoForMediaAttachment(text, video);
  }

  buildMessagePayloadWithGif(text, gifUrl) {
    return buildMessagePayloadWithGifForMediaAttachment(text, gifUrl);
  }

  isUserBlocked(settings, userId) {
    return isUserBlockedForPermissions(settings, String(userId));
  }

  isChannelAllowed(settings, channelId) {
    return isChannelAllowedForPermissions(settings, String(channelId));
  }

  isNonPrivateReplyEligibleChannel(channel) {
    if (!channel || typeof channel !== "object") return false;
    if (!channel.isTextBased?.() || typeof channel.send !== "function") return false;
    if (channel.isDMBased?.()) return false;
    if (!String(channel.guildId || channel.guild?.id || "").trim()) return false;
    if (channel.isThread?.() && Boolean(channel.private)) return false;
    return true;
  }

  isReplyChannel(settings, channelId) {
    return isReplyChannelForPermissions(settings, String(channelId));
  }

  isDiscoveryChannel(settings, channelId) {
    return isDiscoveryChannelForPermissions(settings, String(channelId));
  }

  isDirectlyAddressed(_settings, message) {
    const mentioned = message.mentions?.users?.has(this.client.user.id);
    const isReplyToBot = message.mentions?.repliedUser?.id === this.client.user.id;
    return Boolean(mentioned || isReplyToBot);
  }

  hasBotMessageInRecentWindow({
    recentMessages,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW,
    triggerMessageId = null
  }) {
    return hasBotMessageInRecentWindowForReplyAdmission({
      botUserId: this.client.user?.id,
      recentMessages,
      windowSize,
      triggerMessageId
    });
  }

  hasStartupFollowupAfterMessage({
    messages,
    messageIndex,
    triggerMessageId,
    windowSize = UNSOLICITED_REPLY_CONTEXT_WINDOW
  }) {
    return hasStartupFollowupAfterMessageForReplyAdmission({
      botUserId: this.client.user?.id,
      messages,
      messageIndex,
      triggerMessageId,
      windowSize
    });
  }

  shouldAttemptReplyDecision({
    settings,
    recentMessages,
    addressSignal,
    forceRespond = false,
    forceDecisionLoop = false,
    triggerMessageId = null
  }) {
    return shouldAttemptReplyDecisionForReplyAdmission({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      forceRespond,
      forceDecisionLoop,
      triggerMessageId,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });
  }

  async getReplyAddressSignal(settings, message, recentMessages = []) {
    return await getReplyAddressSignalForReplyAdmission(
      {
        botUserId: String(this.client.user?.id || "").trim(),
        isDirectlyAddressed: (runtimeSettings, runtimeMessage) =>
          this.isDirectlyAddressed(runtimeSettings, runtimeMessage)
      },
      settings,
      message,
      recentMessages
    );
  }

  async runStartupTasks() {
    if (this.isStopping) return;
    if (this.startupTasksRan) return;
    this.startupTasksRan = true;

    const settings = this.store.getSettings();
    await runStartupCatchupForStartupCatchup(
      {
        botUserId: String(this.client.user?.id || "").trim(),
        store: this.store,
        getStartupScanChannels: (runtimeSettings) => this.getStartupScanChannels(runtimeSettings),
        hydrateRecentMessages: (channel, limit) => this.hydrateRecentMessages(channel, limit),
        isChannelAllowed: (runtimeSettings, channelId) => this.isChannelAllowed(runtimeSettings, channelId),
        isUserBlocked: (runtimeSettings, userId) => this.isUserBlocked(runtimeSettings, userId),
        getReplyAddressSignal: (runtimeSettings, message, recentMessages) =>
          this.getReplyAddressSignal(runtimeSettings, message, recentMessages),
        hasStartupFollowupAfterMessage: (payload) => this.hasStartupFollowupAfterMessage(payload),
        enqueueReplyJob: (payload) => this.enqueueReplyJob(payload)
      },
      settings
    );
    await this.maybeRunDiscoveryCycle({ startup: true });
    await this.maybeRunAutomationCycle();

    // Catch up on any missed reflections from past days
    const startupSettings = this.store.getSettings();
    const startupMemory = getMemorySettings(startupSettings);
    if (startupMemory.enabled && startupMemory.reflection?.enabled) {
      await this.memory.runDailyReflection(startupSettings);
    }
  }

  async maybeRunReflection() {
    const settings = this.store.getSettings();
    const memory = getMemorySettings(settings);
    if (!memory.enabled || !memory.reflection?.enabled) return;

    const hour = Number(memory.reflection.hour ?? 4);
    const minute = Number(memory.reflection.minute ?? 0);
    const schedule = { kind: "daily" as const, hour, minute };

    if (!this.nextReflectionRunAt) {
      this.nextReflectionRunAt = resolveInitialNextRunAt({ schedule, nowMs: Date.now() });
    }
    if (!this.nextReflectionRunAt) return;

    if (Date.now() < Date.parse(this.nextReflectionRunAt)) return;

    try {
      await this.memory.runDailyReflection(settings);
    } finally {
      this.nextReflectionRunAt = resolveFollowingNextRunAt({
        schedule,
        runFinishedMs: Date.now()
      });
    }
  }

  async maybeRunAutomationCycle() {
    return await maybeRunAutomationCycleForAutomationEngine(this.toAutomationEngineRuntime());
  }

  async runAutomationJob(automation) {
    return await runAutomationJobForAutomationEngine(this.toAutomationEngineRuntime(), automation);
  }

  async generateAutomationPayload({ automation, settings, channel }) {
    return await generateAutomationPayloadForAutomationEngine(this.toAutomationEngineRuntime(), {
      automation,
      settings,
      channel
    });
  }

  getStartupScanChannels(settings) {
    const permissions = getReplyPermissions(settings);
    const discovery = getDiscoverySettings(settings);
    const channels = [];
    const seen = new Set();

    const explicit = [
      ...permissions.replyChannelIds,
      ...discovery.channelIds,
      ...permissions.allowedChannelIds
    ];

    for (const id of explicit) {
      const channel = this.client.channels.cache.get(String(id));
      if (!isSendableChannel(channel)) continue;
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      channels.push(channel);
    }

    if (channels.length) return channels;

    for (const guild of this.client.guilds.cache.values()) {
      const guildChannels = guild.channels.cache
        .filter((channel) => isSendableChannel(channel))
        .first(8);

      for (const channel of guildChannels) {
        if (seen.has(channel.id)) continue;
        if (!this.isChannelAllowed(settings, channel.id)) continue;
        seen.add(channel.id);
        channels.push(channel);
      }
    }

    return channels;
  }

  async hydrateRecentMessages(channel, limit) {
    try {
      const fetched = await channel.messages.fetch({ limit });
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const message of sorted) {
        this.store.recordMessage({
          messageId: message.id,
          createdAt: message.createdTimestamp,
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.author?.id || "unknown",
          authorName: message.member?.displayName || message.author?.username || "unknown",
          isBot: Boolean(message.author?.bot),
          content: this.composeMessageContentForHistory(message, String(message.content || "").trim()),
          referencedMessageId: message.reference?.messageId
        });
      }

      return sorted;
    } catch {
      return [];
    }
  }

  async maybeRunTextThoughtLoopCycle() {
    return await maybeRunTextThoughtLoopCycleForTextThoughtLoop(this.toTextThoughtLoopRuntime());
  }

  async pickTextThoughtLoopCandidate(settings) {
    return await pickTextThoughtLoopCandidateForTextThoughtLoop(this.toTextThoughtLoopRuntime(), settings);
  }

  buildStoredMessageRuntime(channel, row) {
    return buildStoredMessageRuntimeForTextThoughtLoop(channel, row);
  }

  getLatestRecentHumanMessage(rows = []) {
    return getLatestRecentHumanMessageForTextThoughtLoop(rows);
  }

  isRecentHumanActivity(row, { maxAgeMs = PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS } = {}) {
    return isRecentHumanActivityForTextThoughtLoop(row, { maxAgeMs });
  }

  async maybeRunDiscoveryCycle({ startup = false } = {}) {
    return await maybeRunDiscoveryCycleForDiscoveryEngine(this.toDiscoveryEngineRuntime(), { startup });
  }

  async collectDiscoveryForPost({ settings, channel, recentMessages }) {
    return await collectDiscoveryForPostForDiscoveryEngine(this.toDiscoveryEngineRuntime(), {
      settings,
      channel,
      recentMessages
    });
  }

  applyDiscoveryLinkPolicy({
    text,
    candidates,
    selected,
    requireDiscoveryLink
  }: {
    text: string;
    candidates?: DiscoveryLinkCandidate[];
    selected?: DiscoveryLinkCandidate[];
    requireDiscoveryLink?: boolean;
  }) {
    return applyDiscoveryLinkPolicyForDiscoveryEngine({
      text,
      candidates,
      selected,
      requireDiscoveryLink
    });
  }

  getDiscoveryPostingIntervalMs(settings) {
    return getDiscoveryPostingIntervalMs(settings);
  }

  getDiscoveryAverageIntervalMs(settings) {
    return getDiscoveryAverageIntervalMs(settings);
  }

  getDiscoveryPacingMode(settings) {
    return getDiscoveryPacingMode(settings);
  }

  getDiscoveryMinGapMs(settings) {
    return getDiscoveryMinGapMs(settings);
  }

  evaluateDiscoverySchedule({ settings, startup, lastPostTs, elapsedMs, posts24h }) {
    return evaluateDiscoverySchedule({
      settings,
      startup,
      lastPostTs,
      elapsedMs,
      posts24h
    });
  }

  evaluateSpontaneousDiscoverySchedule({ settings, lastPostTs, elapsedMs, posts24h, minGapMs }) {
    return evaluateSpontaneousDiscoverySchedule({
      settings,
      lastPostTs,
      elapsedMs,
      posts24h,
      minGapMs
    });
  }

  pickDiscoveryChannel(settings) {
    return pickDiscoveryChannel({
      settings,
      client: this.client,
      isChannelAllowed: (resolvedSettings, channelId) => this.isChannelAllowed(resolvedSettings, channelId)
    });
  }

  getEmojiHints(guild) {
    const custom = guild.emojis.cache
      .map((emoji) => (emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`))
      .slice(0, 24);

    return custom;
  }

  getReactionEmojiOptions(guild) {
    return guild.emojis.cache.map((emoji) => emoji.identifier).slice(0, 24);
  }

  getImageInputs(message) {
    return getImageInputsForMessageHistory(message);
  }

  async syncMessageSnapshotFromReaction(reaction) {
    await syncMessageSnapshotFromReactionForMessageHistory(this.toBotContext(), reaction);
  }

  async recordReactionHistoryEvent(reaction, user) {
    await recordReactionHistoryEventForMessageHistory(this.toBotContext(), reaction, user);
  }

  async syncMessageSnapshot(message) {
    await syncMessageSnapshotForMessageHistory(this.toBotContext(), message);
  }

  composeMessageContentForHistory(message, baseText = "") {
    return composeMessageContentForHistoryForMessageHistory(message, baseText);
  }
}
