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
  finalizeReplyPerformanceSample,
  normalizeReplyPerformanceSeed
} from "./bot/replyPipelineShared.ts";
import type { ReplyPerformanceSeed } from "./bot/replyPipelineShared.ts";
import {
  buildSubAgentSessionsRuntime as buildSubAgentSessionsRuntimeForAgentTasks,
  runModelRequestedBrowserBrowse as runModelRequestedBrowserBrowseForAgentTasks,
  runModelRequestedCodeTask as runModelRequestedCodeTaskForAgentTasks
} from "./bot/agentTasks.ts";
import {
  buildBrowserBrowseContext as buildBrowserBrowseContextForBudgetTracking,
  buildImageLookupContext as buildImageLookupContextForBudgetTracking,
  buildMemoryLookupContext as buildMemoryLookupContextForBudgetTracking,
  buildVideoReplyContext as buildVideoReplyContextForBudgetTracking,
  buildWebSearchContext as buildWebSearchContextForBudgetTracking,
  getGifBudgetState as getGifBudgetStateForBudgetTracking,
  getImageBudgetState as getImageBudgetStateForBudgetTracking,
  getMediaGenerationCapabilities as getMediaGenerationCapabilitiesForBudgetTracking,
  getVideoGenerationBudgetState as getVideoGenerationBudgetStateForBudgetTracking
} from "./bot/budgetTracking.ts";
import {
  captionRecentHistoryImages as captionRecentHistoryImagesForImageAnalysis,
  getAutoIncludeImageInputs as getAutoIncludeImageInputsForImageAnalysis,
  mergeImageInputs as mergeImageInputsForImageAnalysis,
  runModelRequestedImageLookup as runModelRequestedImageLookupForImageAnalysis
} from "./bot/imageAnalysis.ts";
import {
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
  loadPromptMemorySlice as loadPromptMemorySliceForMemorySlice,
  loadRelevantMemoryFacts as loadRelevantMemoryFactsForMemorySlice
} from "./bot/memorySlice.ts";
import {
  isChannelAllowed as isChannelAllowedForPermissions,
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
  maybeRunDiscoveryCycle as maybeRunDiscoveryCycleForDiscoveryEngine
} from "./bot/discoveryEngine.ts";
import {
  getVoiceScreenShareCapability as getVoiceScreenShareCapabilityForScreenShare,
  maybeHandleScreenShareOfferIntent as maybeHandleScreenShareOfferIntentForScreenShare,
  offerVoiceScreenShareLink as offerVoiceScreenShareLinkForScreenShare,
} from "./bot/screenShare.ts";
import type { ScreenShareSessionManagerLike } from "./bot/screenShare.ts";
import {
  composeVoiceOperationalMessage as composeVoiceOperationalMessageForVoiceCoordination,
  generateVoiceTurnReply as generateVoiceTurnReplyForVoiceCoordination,
  requestVoiceJoinFromDashboard as requestVoiceJoinFromDashboardForVoiceCoordination
} from "./bot/voiceCoordination.ts";
import {
  maybeRunAutomationCycle as maybeRunAutomationCycleForAutomationEngine
} from "./bot/automationEngine.ts";
import {
  maybeRunTextThoughtLoopCycle as maybeRunTextThoughtLoopCycleForTextThoughtLoop
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
      composeOperationalMessage: (payload) =>
        composeVoiceOperationalMessageForVoiceCoordination(this.toVoiceCoordinationRuntime(), payload),
      generateVoiceTurn: (payload) =>
        generateVoiceTurnReplyForVoiceCoordination(this.toVoiceCoordinationRuntime(), payload),
      getVoiceScreenShareCapability: (payload) =>
        getVoiceScreenShareCapabilityForScreenShare(this.toScreenShareRuntime(), payload),
      offerVoiceScreenShareLink: (payload) =>
        offerVoiceScreenShareLinkForScreenShare(this.toScreenShareRuntime(), payload)
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
      composeVoiceOperationalMessage: (payload) =>
        composeVoiceOperationalMessageForVoiceCoordination(this.toVoiceCoordinationRuntime(), payload)
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
    const botContext = this.toBotContext();
    const budgetContext = this.toBudgetContext();
    const mediaAttachmentContext = this.toMediaAttachmentContext();
    const runtime = {
      ...botContext,
      client: this.client,
      discovery: this.discovery,
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings),
      hydrateRecentMessages: (channel, limit) => this.hydrateRecentMessages(channel, limit),
      loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFactsForMemorySlice(botContext, payload),
      buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
      getImageBudgetState: (settings) => getImageBudgetStateForBudgetTracking(budgetContext, settings),
      getVideoGenerationBudgetState: (settings) =>
        getVideoGenerationBudgetStateForBudgetTracking(budgetContext, settings),
      getMediaGenerationCapabilities: (settings) =>
        getMediaGenerationCapabilitiesForBudgetTracking(budgetContext, settings),
      getEmojiHints: (guild) => this.getEmojiHints(guild),
      resolveMediaAttachment: (payload) =>
        resolveMediaAttachmentForMediaAttachment(mediaAttachmentContext, payload),
      composeMessageContentForHistory: (message, baseText) =>
        composeMessageContentForHistoryForMessageHistory(message as Parameters<
          typeof composeMessageContentForHistoryForMessageHistory
        >[0], baseText),
      markSpoke: () => this.markSpoke(),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      isChannelAllowed: (settings, channelId) =>
        isChannelAllowedForPermissions(settings, String(channelId)),
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
    const botContext = this.toBotContext();
    const budgetContext = this.toBudgetContext();
    const mediaAttachmentContext = this.toMediaAttachmentContext();
    const runtime = {
      ...botContext,
      client: this.client,
      search: this.search,
      isChannelAllowed: (settings, channelId) =>
        isChannelAllowedForPermissions(settings, String(channelId)),
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      markSpoke: () => this.markSpoke(),
      composeMessageContentForHistory: (message, baseText) =>
        composeMessageContentForHistoryForMessageHistory(message as Parameters<
          typeof composeMessageContentForHistoryForMessageHistory
        >[0], baseText),
      loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
      buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
      buildMemoryLookupContext: (payload) => buildMemoryLookupContextForBudgetTracking(budgetContext, payload),
      getImageBudgetState: (settings) => getImageBudgetStateForBudgetTracking(budgetContext, settings),
      getVideoGenerationBudgetState: (settings) =>
        getVideoGenerationBudgetStateForBudgetTracking(budgetContext, settings),
      getGifBudgetState: (settings) => getGifBudgetStateForBudgetTracking(budgetContext, settings),
      getMediaGenerationCapabilities: (settings) =>
        getMediaGenerationCapabilitiesForBudgetTracking(budgetContext, settings),
      resolveMediaAttachment: (payload) =>
        resolveMediaAttachmentForMediaAttachment(mediaAttachmentContext, payload),
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
      isChannelAllowed: (settings, channelId) =>
        isChannelAllowedForPermissions(settings, String(channelId)),
      isNonPrivateReplyEligibleChannel: (channel) => this.isNonPrivateReplyEligibleChannel(channel),
      hydrateRecentMessages: (channel, limit) => this.hydrateRecentMessages(channel, limit),
      hasBotMessageInRecentWindow: (payload) =>
        hasBotMessageInRecentWindowForReplyAdmission({
          botUserId: this.client.user?.id,
          ...payload
        }),
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
    const botContext = this.toBotContext();
    const runtime: QueueGatewayRuntime = {
      ...botContext,
      lastBotMessageAt: this.lastBotMessageAt,
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      replyQueues: this.replyQueues,
      replyQueueWorkers: this.replyQueueWorkers,
      replyQueuedMessageIds: this.replyQueuedMessageIds,
      isStopping: this.isStopping,
      isChannelAllowed: (settings, channelId) =>
        isChannelAllowedForPermissions(
          settings as Parameters<typeof isChannelAllowedForPermissions>[0],
          String(channelId)
        ),
      isUserBlocked: (settings, userId) =>
        isUserBlockedForPermissions(
          settings as Parameters<typeof isUserBlockedForPermissions>[0],
          String(userId)
        ),
      getReplyAddressSignal: (settings, message, recentMessages = []) =>
        getReplyAddressSignalForReplyAdmission(
          {
            botUserId: botContext.botUserId,
            isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
              this.isDirectlyAddressed(resolvedSettings, resolvedMessage)
          },
          settings as Parameters<typeof getReplyAddressSignalForReplyAdmission>[1],
          message,
          recentMessages
        ),
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
    const botContext = this.toBotContext();
    const budgetContext = this.toBudgetContext();
    const mediaAttachmentContext = this.toMediaAttachmentContext();
    const agentContext = this.toAgentContext();
    return {
      ...botContext,
      gifs: this.gifs,
      search: this.search,
      voiceSessionManager: this.voiceSessionManager,
      getReplyAddressSignal: (settings, message, recentMessages = []) =>
        getReplyAddressSignalForReplyAdmission(
          {
            botUserId: botContext.botUserId,
            isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
              this.isDirectlyAddressed(resolvedSettings, resolvedMessage)
          },
          settings as Parameters<typeof getReplyAddressSignalForReplyAdmission>[1],
          message,
          recentMessages
        ),
      isReplyChannel: (settings, channelId) =>
        isReplyChannelForPermissions(
          settings as Parameters<typeof isReplyChannelForPermissions>[0],
          String(channelId)
        ),
      getReactionEmojiOptions: (guild) => this.getReactionEmojiOptions(guild),
      shouldAttemptReplyDecision: (payload) =>
        shouldAttemptReplyDecisionForReplyAdmission({
          botUserId: this.client.user?.id,
          ...payload,
          windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
        } as Parameters<typeof shouldAttemptReplyDecisionForReplyAdmission>[0]),
      loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
      getRecentLookupContextForPrompt: (payload) =>
        getRecentLookupContextForPromptForMessageHistory(botContext, payload),
      getConversationHistoryForPrompt: (payload) =>
        getConversationHistoryForPromptForMessageHistory(botContext, payload),
      buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
      getImageInputs: (message) =>
        getImageInputsForMessageHistory(message as Parameters<typeof getImageInputsForMessageHistory>[0]),
      getImageBudgetState: (settings) => getImageBudgetStateForBudgetTracking(budgetContext, settings),
      getVideoGenerationBudgetState: (settings) =>
        getVideoGenerationBudgetStateForBudgetTracking(budgetContext, settings),
      getMediaGenerationCapabilities: (settings) =>
        getMediaGenerationCapabilitiesForBudgetTracking(budgetContext, settings),
      getGifBudgetState: (settings) => getGifBudgetStateForBudgetTracking(budgetContext, settings),
      buildWebSearchContext: (settings, messageText) =>
        buildWebSearchContextForBudgetTracking(budgetContext, settings, messageText),
      buildBrowserBrowseContext: (settings) =>
        buildBrowserBrowseContextForBudgetTracking(budgetContext, settings),
      buildMemoryLookupContext: (payload) => buildMemoryLookupContextForBudgetTracking(budgetContext, payload),
      buildVideoReplyContext: (payload) => buildVideoReplyContextForBudgetTracking(budgetContext, payload),
      buildImageLookupContext: (payload) => buildImageLookupContextForBudgetTracking(budgetContext, payload),
      getAutoIncludeImageInputs: (payload) => getAutoIncludeImageInputsForImageAnalysis(payload),
      captionRecentHistoryImages: (payload = {}) =>
        captionRecentHistoryImagesForImageAnalysis(botContext, {
          imageCaptionCache: this.imageCaptionCache,
          captionTimestamps: this.captionTimestamps,
          candidates: payload.candidates || [],
          settings: payload.settings || null,
          trace: payload.trace || null
        }),
      getVoiceScreenShareCapability: (payload) =>
        getVoiceScreenShareCapabilityForScreenShare(this.toScreenShareRuntime(), payload),
      getEmojiHints: (guild) => this.getEmojiHints(guild),
      runModelRequestedBrowserBrowse: (payload) =>
        runModelRequestedBrowserBrowseForAgentTasks(agentContext, payload),
      runModelRequestedCodeTask: (payload) => runModelRequestedCodeTaskForAgentTasks(agentContext, payload),
      buildSubAgentSessionsRuntime: () => buildSubAgentSessionsRuntimeForAgentTasks(agentContext),
      runModelRequestedImageLookup: (payload) =>
        runModelRequestedImageLookupForImageAnalysis({
          imageLookup: payload.imageLookup || {},
          query: payload.query || ""
        }),
      mergeImageInputs: (payload) => mergeImageInputsForImageAnalysis(payload),
      maybeHandleStructuredVoiceIntent: (payload) => this.maybeHandleStructuredVoiceIntent(payload),
      maybeHandleStructuredAutomationIntent: (payload) =>
        this.maybeHandleStructuredAutomationIntent(payload),
      rememberRecentLookupContext: (payload) =>
        rememberRecentLookupContextForMessageHistory(botContext, payload),
      maybeApplyReplyReaction: (payload) => this.maybeApplyReplyReaction(payload),
      logSkippedReply: (payload) => this.logSkippedReply(payload),
      maybeHandleScreenShareOfferIntent: (payload) =>
        maybeHandleScreenShareOfferIntentForScreenShare(this.toScreenShareRuntime(), {
          ...payload,
          settings: this.store.getSettings()
        }),
      resolveMediaAttachment: (payload) =>
        resolveMediaAttachmentForMediaAttachment(mediaAttachmentContext, payload),
      maybeAttachReplyGif: (payload) => maybeAttachReplyGifForMediaAttachment(mediaAttachmentContext, payload),
      maybeAttachGeneratedImage: (payload) =>
        maybeAttachGeneratedImageForMediaAttachment(mediaAttachmentContext, payload),
      maybeAttachGeneratedVideo: (payload) =>
        maybeAttachGeneratedVideoForMediaAttachment(mediaAttachmentContext, payload),
      getSimulatedTypingDelayMs: (minMs, jitterMs) => this.getSimulatedTypingDelayMs(minMs, jitterMs),
      shouldSendAsReply: (payload) => this.shouldSendAsReply(payload),
      markSpoke: () => this.markSpoke(),
      composeMessageContentForHistory: (message, baseText) =>
        composeMessageContentForHistoryForMessageHistory(message as Parameters<
          typeof composeMessageContentForHistoryForMessageHistory
        >[0], baseText),
      canSendMessage: (maxPerHour) => this.canSendMessage(maxPerHour),
      canTalkNow: (settings) => this.canTalkNow(settings)
    };
  }

  toVoiceReplyRuntime(): VoiceReplyRuntime {
    const botContext = this.toBotContext();
    const budgetContext = this.toBudgetContext();
    const agentContext = this.toAgentContext();
    return {
      ...botContext,
      search: this.search,
      loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFactsForMemorySlice(botContext, payload),
      buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
      loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
      buildWebSearchContext: (settings, messageText) =>
        buildWebSearchContextForBudgetTracking(budgetContext, settings, messageText),
      loadRecentConversationHistory: (payload) =>
        getConversationHistoryForPromptForMessageHistory(botContext, payload),
      loadRecentLookupContext: (payload) =>
        getRecentLookupContextForPromptForMessageHistory(botContext, payload),
      rememberRecentLookupContext: (payload) =>
        rememberRecentLookupContextForMessageHistory(botContext, payload),
      getVoiceScreenShareCapability: (payload) =>
        getVoiceScreenShareCapabilityForScreenShare(this.toScreenShareRuntime(), payload),
      offerVoiceScreenShareLink: (payload) =>
        offerVoiceScreenShareLinkForScreenShare(this.toScreenShareRuntime(), payload),
      runModelRequestedBrowserBrowse: (payload) =>
        runModelRequestedBrowserBrowseForAgentTasks(agentContext, payload),
      buildBrowserBrowseContext: (settings) =>
        buildBrowserBrowseContextForBudgetTracking(budgetContext, settings),
      runModelRequestedCodeTask: (payload) => runModelRequestedCodeTaskForAgentTasks(agentContext, payload)
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
          const browserContext = buildBrowserBrowseContextForBudgetTracking(
            this.toBudgetContext(),
            settings
          );
          if (!browserContext.configured) {
            await interaction.editReply("Browser runtime is currently unavailable on this server.");
            return;
          }
          if (!browserContext.enabled) {
            await interaction.editReply("Browser runtime is disabled in settings on this server.");
            return;
          }

          const result = await runModelRequestedBrowserBrowseForAgentTasks(this.toAgentContext(), {
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
      maybeRunDiscoveryCycleForDiscoveryEngine(this.toDiscoveryEngineRuntime()).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `discovery_cycle: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);
    this.textThoughtLoopTimer = setInterval(() => {
      maybeRunTextThoughtLoopCycleForTextThoughtLoop(this.toTextThoughtLoopRuntime()).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `text_thought_loop: ${String(error?.message || error)}`
        });
      });
    }, INITIATIVE_TICK_MS);
    this.automationTimer = setInterval(() => {
      maybeRunAutomationCycleForAutomationEngine(this.toAutomationEngineRuntime()).catch((error) => {
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
    const recordedContent = composeMessageContentForHistoryForMessageHistory(
      message as Parameters<typeof composeMessageContentForHistoryForMessageHistory>[0],
      text
    );
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
    if (!isChannelAllowedForPermissions(settings, String(message.channelId))) return;
    if (isUserBlockedForPermissions(settings, String(message.author.id))) return;

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
    const addressSignal = await getReplyAddressSignalForReplyAdmission(
      {
        botUserId: String(this.client.user?.id || "").trim(),
        isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
          this.isDirectlyAddressed(resolvedSettings, resolvedMessage)
      },
      settings,
      message,
      recentMessages
    );
    const shouldQueueReply = shouldAttemptReplyDecisionForReplyAdmission({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      forceRespond: false,
      triggerMessageId: message.id,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });
    if (!shouldQueueReply) return;
    this.enqueueReplyJob({
      source: "message_event",
      message,
      forceRespond: shouldForceRespondForAddressSignalForReplyAdmission(addressSignal),
      addressSignal
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
          isChannelAllowedForPermissions(runtimeSettings, String(channelId)),
        maybeRunAutomationCycle: () => maybeRunAutomationCycleForAutomationEngine(this.toAutomationEngineRuntime())
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
      content: composeMessageContentForHistoryForMessageHistory(
        sent as Parameters<typeof composeMessageContentForHistoryForMessageHistory>[0],
        finalText
      ),
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
        canStandalonePost: isReplyChannelForPermissions(settings, String(message.channelId)),
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

  isNonPrivateReplyEligibleChannel(channel) {
    if (!channel || typeof channel !== "object") return false;
    if (!channel.isTextBased?.() || typeof channel.send !== "function") return false;
    if (channel.isDMBased?.()) return false;
    if (!String(channel.guildId || channel.guild?.id || "").trim()) return false;
    if (channel.isThread?.() && Boolean(channel.private)) return false;
    return true;
  }

  isDirectlyAddressed(_settings, message) {
    const mentioned = message.mentions?.users?.has(this.client.user.id);
    const isReplyToBot = message.mentions?.repliedUser?.id === this.client.user.id;
    return Boolean(mentioned || isReplyToBot);
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
        isChannelAllowed: (runtimeSettings, channelId) =>
          isChannelAllowedForPermissions(runtimeSettings, String(channelId)),
        isUserBlocked: (runtimeSettings, userId) => isUserBlockedForPermissions(runtimeSettings, String(userId)),
        getReplyAddressSignal: (runtimeSettings, message, recentMessages) =>
          getReplyAddressSignalForReplyAdmission(
            {
              botUserId: this.toBotContext().botUserId,
              isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
                this.isDirectlyAddressed(resolvedSettings, resolvedMessage)
            },
            runtimeSettings,
            message,
            recentMessages
          ),
        hasStartupFollowupAfterMessage: (payload) =>
          hasStartupFollowupAfterMessageForReplyAdmission({
            botUserId: this.client.user?.id,
            ...payload
          }),
        enqueueReplyJob: (payload) => this.enqueueReplyJob(payload)
      },
      settings
    );
    await maybeRunDiscoveryCycleForDiscoveryEngine(this.toDiscoveryEngineRuntime(), { startup: true });
    await maybeRunAutomationCycleForAutomationEngine(this.toAutomationEngineRuntime());

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
        if (!isChannelAllowedForPermissions(settings, String(channel.id))) continue;
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
          content: composeMessageContentForHistoryForMessageHistory(
            message as Parameters<typeof composeMessageContentForHistoryForMessageHistory>[0],
            String(message.content || "").trim()
          ),
          referencedMessageId: message.reference?.messageId
        });
      }

      return sorted;
    } catch {
      return [];
    }
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
      isChannelAllowed: (resolvedSettings, channelId) =>
        isChannelAllowedForPermissions(resolvedSettings, String(channelId))
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

  async syncMessageSnapshotFromReaction(reaction) {
    await syncMessageSnapshotFromReactionForMessageHistory(this.toBotContext(), reaction);
  }

  async recordReactionHistoryEvent(reaction, user) {
    await recordReactionHistoryEventForMessageHistory(this.toBotContext(), reaction, user);
  }

  async syncMessageSnapshot(message) {
    await syncMessageSnapshotForMessageHistory(this.toBotContext(), message);
  }

}
