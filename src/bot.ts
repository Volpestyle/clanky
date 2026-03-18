import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  MessageType,
  Partials,
  REST,
  Routes
} from "discord.js";
import { applySelfbotPatches } from "./selfbot/selfbotPatches.ts";
import {
  createStreamDiscoveryState,
  createGoLiveStreamState,
  buildStreamKey,
  buildGoLiveStreamStateFromStream,
  removeSessionGoLiveStream,
  setupStreamDiscovery,
  syncPrimaryGoLiveStream,
  upsertSessionGoLiveStream,
  type StreamDiscoveryState
} from "./selfbot/streamDiscovery.ts";
import { clankCommand } from "./commands/clankCommand.ts";
import type { Settings } from "./settings/settingsSchema.ts";
import {
  runCodeAgent,
  isCodeAgentUserAllowed,
  normalizeCodeAgentRole,
  resolveCodeAgentConfig,
  getActiveCodeAgentTaskCount
} from "./agents/codeAgent.ts";
import { ImageCaptionCache } from "./vision/imageCaptionCache.ts";
import {
  normalizeReactionEmojiToken
} from "./bot/botHelpers.ts";
import {
  resolveFollowingNextRunAt,
  resolveInitialNextRunAt
} from "./bot/automation.ts";
import { chance } from "./utils.ts";
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
  runModelRequestedBrowserBrowse as runModelRequestedBrowserBrowseForAgentTasks,
  runModelRequestedCodeTask as runModelRequestedCodeTaskForAgentTasks,
  buildSubAgentSessionsRuntime as buildSubAgentSessionsRuntimeForAgentTasks
} from "./bot/agentTasks.ts";
import {
  buildBrowserBrowseContext as buildBrowserBrowseContextForBudgetTracking,
} from "./bot/budgetTracking.ts";
import {
  composeMessageContentForHistory as composeMessageContentForHistoryForMessageHistory,
  recordReactionHistoryEvent as recordReactionHistoryEventForMessageHistory,
  syncMessageSnapshot as syncMessageSnapshotForMessageHistory,
  syncMessageSnapshotFromReaction as syncMessageSnapshotFromReactionForMessageHistory
} from "./bot/messageHistory.ts";
import { generateTextCancelAcknowledgement } from "./bot/textCancelAcknowledgement.ts";
import {
  isChannelAllowed as isChannelAllowedForPermissions,
  isDiscoveryChannel as isDiscoveryChannelForPermissions,
  isReplyChannel as isReplyChannelForPermissions,
  isUserBlocked as isUserBlockedForPermissions
} from "./bot/permissions.ts";
import {
  evaluateReplyAdmissionDecision,
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  hasStartupFollowupAfterMessage as hasStartupFollowupAfterMessageForReplyAdmission
} from "./bot/replyAdmission.ts";
import { buildRuntimeDecisionCorrelation } from "./services/runtimeCorrelation.ts";
import { runStartupCatchup as runStartupCatchupForStartupCatchup } from "./bot/startupCatchup.ts";
import {
  maybeRunInitiativeCycle as maybeRunInitiativeCycleForInitiativeEngine
} from "./bot/initiativeEngine.ts";
import {
  getVoiceScreenWatchCapability as getVoiceScreenWatchCapabilityForScreenShare,
  startVoiceScreenWatch as startVoiceScreenWatchForScreenShare,
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
  dequeueReplyBurst,
  dequeueReplyJob,
  ensureGatewayHealthy,
  getReplyQueueWaitMs,
  processReplyQueue,
  reconnectGateway,
  requeueReplyJobs,
  scheduleReconnect
} from "./bot/queueGateway.ts";
import type {
  AgentContext,
  BotContext,
  BudgetContext,
  MediaAttachmentContext,
  QueueGatewayRuntime,
  ReplyPipelineRuntime,
  VoiceReplyRuntime
} from "./bot/botContext.ts";
import {
  buildAgentContext,
  buildAutomationEngineRuntime,
  buildBotContext,
  buildBudgetContext,
  buildInitiativeRuntime,
  buildMediaAttachmentContext,
  buildQueueGatewayRuntime,
  buildReplyPipelineRuntime,
  buildScreenShareRuntime,
  buildVoiceCoordinationRuntime,
  buildVoiceReplyRuntime
} from "./bot/botRuntimeFactories.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";
import type { BrowserManager } from "./services/BrowserManager.ts";
import {
  BrowserTaskRegistry,
  buildBrowserTaskScopeKey,
  isAbortError
} from "./tools/browserTaskRuntime.ts";
import {
  ActiveReplyRegistry,
  buildTextReplyScopeKey
} from "./tools/activeReplyRegistry.ts";
import { isCancelIntent } from "./tools/cancelDetection.ts";
import { maybeReplyToMessagePipeline } from "./bot/replyPipeline.ts";
import { SubAgentSessionManager } from "./agents/subAgentSession.ts";
import {
  BackgroundTaskRunner,
  buildCodeTaskScopeKey,
  type BackgroundTask
} from "./agents/backgroundTaskRunner.ts";
import {
  getMemorySettings,
  getBotName,
  getReplyPermissions,
  getActivitySettings,
  isDevTaskEnabled
} from "./settings/agentStack.ts";
import { buildCodeTaskResultPrompt } from "./prompts/promptText.ts";

const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const TEXT_CANCEL_FALLBACK_REACTION = "🛑";
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

function isAppCommandInvocationMessage(message: { type?: number | null } | null | undefined) {
  return message?.type === MessageType.ChatInputCommand ||
    message?.type === MessageType.ContextMenuCommand;
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
  initiativeTimer;
  automationTimer;
  gatewayWatchdogTimer;
  reconnectTimeout;
  startupTasksRan;
  startupTimeout;
  initiativeCycleRunning;
  pendingInitiativeThoughts;
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
  activeReplies: ActiveReplyRegistry;
  activeBrowserTasks: BrowserTaskRegistry;
  subAgentSessions: SubAgentSessionManager;
  backgroundTaskRunner: BackgroundTaskRunner;
  imageCaptionCache: ImageCaptionCache;
  streamDiscovery: StreamDiscoveryState;
  private streamDiscoveryCleanup: (() => void) | null;
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
    this.initiativeTimer = null;
    this.automationTimer = null;
    this.gatewayWatchdogTimer = null;
    this.reconnectTimeout = null;
    this.startupTasksRan = false;
    this.startupTimeout = null;
    this.initiativeCycleRunning = false;
    this.pendingInitiativeThoughts = new Map();
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
    this.activeReplies = new ActiveReplyRegistry();
    this.activeBrowserTasks = new BrowserTaskRegistry();
    this.subAgentSessions = new SubAgentSessionManager({
      idleTimeoutMs: Number(appConfig?.subAgentOrchestration?.sessionIdleTimeoutMs) || 300_000,
      maxSessions: Number(appConfig?.subAgentOrchestration?.maxConcurrentSessions) || 20
    });
    this.subAgentSessions.startSweep();
    this.backgroundTaskRunner = new BackgroundTaskRunner({
      store: this.store,
      sessionManager: this.subAgentSessions
    });
    this.imageCaptionCache = new ImageCaptionCache({
      maxEntries: 200,
      defaultTtlMs: 60 * 60 * 1000 // 1 hour
    });
    this.captionTimestamps = [];
    this.streamDiscovery = createStreamDiscoveryState();
    this.streamDiscoveryCleanup = null;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });
    applySelfbotPatches(this.client as Client);
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
      activeReplies: this.activeReplies,
      streamDiscovery: this.streamDiscovery,
      getVoiceScreenWatchCapability: (payload) =>
        getVoiceScreenWatchCapabilityForScreenShare(this.toScreenShareRuntime(), payload),
      startVoiceScreenWatch: (payload) =>
        startVoiceScreenWatchForScreenShare(this.toScreenShareRuntime(), payload)
    });

    // Wire code agent hooks onto VoiceSessionManager so code_task is
    // available on the voice_realtime surface (provider-native tool calls).
    const voiceAgentContext = this.toAgentContext();
    this.voiceSessionManager.runModelRequestedCodeTask = (payload) =>
      runModelRequestedCodeTaskForAgentTasks(voiceAgentContext, payload);
    this.voiceSessionManager.createCodeAgentSession = (opts) => {
      const sessionsRuntime = buildSubAgentSessionsRuntimeForAgentTasks(voiceAgentContext);
      return sessionsRuntime.createCodeSession(opts) ?? null;
    };
    this.voiceSessionManager.dispatchBackgroundCodeTask = (payload) =>
      this.dispatchBackgroundCodeTask(payload);
    this.voiceSessionManager.subAgentSessions = this.subAgentSessions;

    this.registerEvents();
  }

  attachScreenShareSessionManager(manager: ScreenShareSessionManagerLike | null) {
    this.screenShareSessionManager = manager || null;
  }

  toBotContext(): BotContext {
    return buildBotContext(this);
  }

  toAgentContext(): AgentContext {
    return buildAgentContext(this);
  }

  toBudgetContext(): BudgetContext {
    return buildBudgetContext(this);
  }

  toMediaAttachmentContext(): MediaAttachmentContext {
    return buildMediaAttachmentContext(this);
  }

  toScreenShareRuntime() {
    return buildScreenShareRuntime(this);
  }

  toVoiceCoordinationRuntime() {
    return buildVoiceCoordinationRuntime(this);
  }

  toInitiativeRuntime() {
    return buildInitiativeRuntime(this);
  }

  toAutomationEngineRuntime() {
    return buildAutomationEngineRuntime(this);
  }

  toQueueGatewayRuntime(): QueueGatewayRuntime {
    return buildQueueGatewayRuntime(this);
  }

  toReplyPipelineRuntime(): ReplyPipelineRuntime {
    return buildReplyPipelineRuntime(this, {
      captionTimestamps: this.captionTimestamps,
      unsolicitedReplyContextWindow: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });
  }

  toVoiceReplyRuntime(): VoiceReplyRuntime {
    return buildVoiceReplyRuntime(this);
  }

  async handleClankSlashCommand(interaction: ChatInputCommandInteraction) {
    const settings = this.store.getSettings();
    const subcommandGroup = interaction.options.getSubcommandGroup(false);

    if (subcommandGroup === "music") {
      return await this.voiceSessionManager.handleClankSlashCommand(interaction, settings);
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "say") {
      return await this.voiceSessionManager.handleClankSlashCommand(interaction, settings);
    }
    if (subcommand === "browse") {
      return await this.handleClankBrowseSlashCommand(interaction, settings);
    }
    if (subcommand === "code") {
      return await this.handleClankCodeSlashCommand(interaction, settings);
    }

    await interaction.reply({ content: "Unsupported /clank command.", ephemeral: true });
  }

  async handleClankBrowseSlashCommand(
    interaction: ChatInputCommandInteraction,
    settings: Settings
  ) {
    await interaction.deferReply();
    const browseInstruction = interaction.options.getString("task", true);

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
        source: "slash_command_clank_browse"
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
      this.store.logAction({ kind: "bot_error", guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, content: "slash_command_browse_error", metadata: { error: String(error instanceof Error ? error.message : error) } });
      const message = error instanceof Error ? error.message : String(error);
      if (isAbortError(error)) {
        try {
          await interaction.editReply("Browser session was cancelled.");
        } catch (replyError) {
           this.store.logAction({ kind: "bot_error", guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, content: "slash_command_browse_cancelled_reply_failed", metadata: { error: String(replyError instanceof Error ? replyError.message : replyError) } });
        }
      } else {
        try {
          await interaction.editReply(`An error occurred while browsing: ${message}`);
        } catch (replyError) {
           this.store.logAction({ kind: "bot_error", guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, content: "slash_command_browse_error_reply_failed", metadata: { error: String(replyError instanceof Error ? replyError.message : replyError) } });
        }
      }
    }
  }

  async handleClankCodeSlashCommand(
    interaction: ChatInputCommandInteraction,
    settings: Settings
  ) {
    await interaction.deferReply();
    const codeInstruction = interaction.options.getString("task", true);
    const codeRole = normalizeCodeAgentRole(interaction.options.getString("role", false), "implementation");
    const codeCwd = interaction.options.getString("cwd", false) || undefined;

    if (!isDevTaskEnabled(settings)) {
      await interaction.editReply("Code agent is disabled in settings.");
      return;
    }
    if (!isCodeAgentUserAllowed(interaction.user.id, settings)) {
      await interaction.editReply("This capability is restricted to allowed users.");
      return;
    }

    const codeAgentConfig = resolveCodeAgentConfig(settings, codeCwd, codeRole);
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
        codexCliModel,
        maxTurns,
        timeoutMs,
        maxBufferBytes
      } = codeAgentConfig;
      const codexCompatibleClient = this.llm?.getCodexCompatibleClient() || null;
      const codexCostProvider = this.llm?.openai ? "openai" : this.llm?.codexOAuth ? "openai-oauth" : undefined;

      const result = await runCodeAgent({
        instruction: codeInstruction,
        cwd,
        provider,
        maxTurns,
        timeoutMs,
        maxBufferBytes,
        model,
        codexModel,
        codexCliModel,
        openai: codexCompatibleClient,
        codexCostProvider,
        trace: {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          source: "slash_command_clank_code",
          role: codeRole
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
      this.store.logAction({ kind: "bot_error", guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, content: "slash_command_code_error", metadata: { error: String(error instanceof Error ? error.message : error) } });
      const message = error instanceof Error ? error.message : String(error);
      try {
        await interaction.editReply(`An error occurred while running code task: ${message}`);
      } catch (replyError) {
         this.store.logAction({ kind: "bot_error", guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, content: "slash_command_code_error_reply_failed", metadata: { error: String(replyError instanceof Error ? replyError.message : replyError) } });
      }
    }
  }

  registerEvents() {
    this.client.on("clientReady", async () => {
      this.hasConnectedAtLeastOnce = true;
      this.reconnectAttempts = 0;
      this.lastGatewayEventAt = Date.now();
      this.store.logAction({ kind: "bot_lifecycle", content: "bot_logged_in", metadata: { tag: this.client.user?.tag || this.client.user?.username || "unknown" } });

      this.streamDiscoveryCleanup = setupStreamDiscovery(
        this.client as never,
        this.streamDiscovery,
        {
          onGoLiveDetected: ({ userId, guildId, channelId }) => {
            const isSelfStream = String(userId || "").trim() === String(this.client.user?.id || "").trim();
            const session = this.voiceSessionManager.getSession(guildId);
            if (session && !isSelfStream) {
              const streamKey = buildStreamKey(guildId, channelId, userId);
              const existingGoLiveStream = session.goLiveStreams?.get(streamKey);
              if (existingGoLiveStream) {
                return;
              }
              upsertSessionGoLiveStream(session, {
                ...createGoLiveStreamState(),
                streamKey,
                targetUserId: userId,
                guildId,
                channelId,
                discoveredAt: Date.now(),
              });
              this.store.logAction({
                kind: "stream_discovery",
                guildId,
                channelId,
                userId,
                content: `stream_discovery_go_live_bootstrap_seeded: streamKey=${streamKey}`,
                metadata: { streamKey }
              });
            }
          },
          onGoLiveEnded: ({ userId, guildId, channelId }) => {
            const isSelfStream = String(userId || "").trim() === String(this.client.user?.id || "").trim();
            const session = this.voiceSessionManager.getSession(guildId);
            const provisionalStreamKey = channelId ? buildStreamKey(guildId, channelId, userId) : null;
            if (
              session &&
              !isSelfStream &&
              (provisionalStreamKey
                ? session.goLiveStreams?.has(provisionalStreamKey)
                : [...(session.goLiveStreams?.values() || [])].some((stream) =>
                    String(stream.targetUserId || "").trim() === String(userId || "").trim() &&
                    String(stream.guildId || "").trim() === String(guildId || "").trim() &&
                    (!channelId || String(stream.channelId || "").trim() === String(channelId || "").trim())
                  ))
            ) {
              this.store.logAction({
                kind: "stream_discovery",
                guildId,
                channelId,
                userId,
                content: `stream_discovery_go_live_bootstrap_cleared: streamKey=${provisionalStreamKey ?? session.goLiveStream?.streamKey ?? "unknown"}`,
                metadata: {
                  streamKey: provisionalStreamKey ?? session.goLiveStream?.streamKey ?? null,
                  reason: "voice_state_self_stream_false"
                }
              });
              removeSessionGoLiveStream(session, {
                streamKey: provisionalStreamKey,
                targetUserId: userId
              });
            }
          },
          onStreamDiscovered: (stream) => {
            this.store.logAction({
              kind: "stream_discovery",
              guildId: stream.guildId,
              channelId: stream.channelId,
              userId: stream.userId,
              content: `stream_discovered: streamKey=${stream.streamKey} rtcServerId=${stream.rtcServerId ?? "unknown"}`,
              metadata: { streamKey: stream.streamKey, rtcServerId: stream.rtcServerId }
            });
            const isSelfStream = String(stream.userId || "").trim() === String(this.client.user?.id || "").trim();
            const session = this.voiceSessionManager.getSession(stream.guildId);
            if (session && !isSelfStream) {
              upsertSessionGoLiveStream(session, buildGoLiveStreamStateFromStream(stream), stream.userId);
            }
          },
          onStreamCredentialsReceived: (stream) => {
            this.store.logAction({
              kind: "stream_discovery",
              guildId: stream.guildId,
              channelId: stream.channelId,
              userId: stream.userId,
              content: `stream_credentials_received: streamKey=${stream.streamKey} hasEndpoint=${Boolean(stream.endpoint)} hasToken=${Boolean(stream.token)}`,
              metadata: { streamKey: stream.streamKey, rtcServerId: stream.rtcServerId }
            });
            const isSelfStream = String(stream.userId || "").trim() === String(this.client.user?.id || "").trim();
            const session = this.voiceSessionManager.getSession(stream.guildId);
            if (session && !isSelfStream) {
              upsertSessionGoLiveStream(session, buildGoLiveStreamStateFromStream(stream), stream.userId);
            }
            if (isSelfStream) {
              this.voiceSessionManager.handleDiscoveredSelfStreamCredentialsReceived({ stream });
            } else {
              this.voiceSessionManager.handleDiscoveredStreamCredentialsReceived({ stream });
            }
          },
          onStreamDeleted: (stream) => {
            this.store.logAction({
              kind: "stream_discovery",
              guildId: stream.guildId,
              channelId: stream.channelId,
              userId: stream.userId,
              content: `stream_deleted: streamKey=${stream.streamKey}`,
              metadata: { streamKey: stream.streamKey }
            });
            const isSelfStream = String(stream.userId || "").trim() === String(this.client.user?.id || "").trim();
            const session = this.voiceSessionManager.getSession(stream.guildId);
            if (!isSelfStream && session) {
              removeSessionGoLiveStream(session, {
                streamKey: stream.streamKey,
                targetUserId: stream.userId
              });
              syncPrimaryGoLiveStream(session);
            }
            const handlerPromise = isSelfStream
              ? Promise.resolve(this.voiceSessionManager.handleDiscoveredSelfStreamDeleted({ stream }))
              : this.voiceSessionManager.handleDiscoveredStreamDeleted({ stream });
            void handlerPromise.catch((error) => {
              this.store.logAction({
                kind: "voice_error",
                guildId: stream.guildId,
                channelId: stream.channelId,
                userId: stream.userId,
                content: `stream_discovery_delete_handler_failed: ${String((error as Error)?.message || error)}`,
                metadata: {
                  streamKey: stream.streamKey
                }
              });
            });
          },
          onLog: (action, detail) => {
            this.store.logAction({
              kind: "stream_discovery",
              guildId: (detail.guildId as string) ?? null,
              channelId: (detail.channelId as string) ?? null,
              userId: (detail.userId as string) ?? null,
              content: `${action}: ${JSON.stringify(detail)}`
            });
          }
        }
      );
    });

    this.client.on("shardResume", () => {
      this.lastGatewayEventAt = Date.now();
    });

    this.client.on("shardDisconnect", (event, shardId) => {
      this.lastGatewayEventAt = Date.now();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_disconnect: shard=${shardId} code=${event?.code ?? "unknown"}`
      });
    });

    this.client.on("shardError", (error, shardId) => {
      this.lastGatewayEventAt = Date.now();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_shard_error: shard=${shardId} ${String(error?.message || error)}`
      });
    });

    this.client.on("error", (error) => {
      this.lastGatewayEventAt = Date.now();
      this.store.logAction({
        kind: "bot_error",
        userId: this.client.user?.id,
        content: `gateway_error: ${String(error?.message || error)}`
      });
    });

    this.client.on("invalidated", () => {
      this.lastGatewayEventAt = Date.now();
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

    this.client.on("guildMemberAdd", async (member) => {
      try {
        await this.handleMemberJoin(member);
      } catch (error) {
        this.store.logAction({
          kind: "bot_error",
          guildId: member?.guild?.id,
          userId: member?.user?.id,
          content: `member_join_handler: ${String(error?.message || error)}`
        });
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
    this.lastGatewayEventAt = Date.now();

    this.memoryTimer = setInterval(() => {
      this.memory.refreshMemoryMarkdown().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `memory_refresh: ${String(error?.message || error)}`
        });
      });
    }, 5 * 60_000);

    this.initiativeTimer = setInterval(() => {
      maybeRunInitiativeCycleForInitiativeEngine(this.toInitiativeRuntime()).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `initiative_cycle: ${String(error?.message || error)}`
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
    if (this.initiativeTimer) clearInterval(this.initiativeTimer);
    if (this.automationTimer) clearInterval(this.automationTimer);
    if (this.gatewayWatchdogTimer) clearInterval(this.gatewayWatchdogTimer);
    if (this.reflectionTimer) clearInterval(this.reflectionTimer);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.initiativeTimer = null;
    this.gatewayWatchdogTimer = null;
    this.reflectionTimer = null;
    this.automationTimer = null;
    this.reconnectTimeout = null;
    this.startupTimeout = null;
    this.replyQueues.clear();
    this.replyQueueWorkers.clear();
    this.replyQueuedMessageIds.clear();
    this.pendingInitiativeThoughts.clear();
    this.streamDiscoveryCleanup?.();
    this.streamDiscoveryCleanup = null;
    await this.voiceSessionManager.dispose("shutdown");
    if (this.memory?.drainIngestQueue) {
      try {
        await this.memory.drainIngestQueue({ timeoutMs: 4000 });
      } catch (error) {
        try { this.store.logAction({ kind: "bot_error", content: "shutdown_drain_memory_queue_failed", metadata: { error: String(error instanceof Error ? error.message : error) } }); } catch { /* store may be closing */ }
        console.warn("[ClankerBot] Failed to drain memory ingest queue during shutdown:", error);
      }
    }
    if (this.browserManager?.closeAll) {
      try {
        await this.browserManager.closeAll();
      } catch (error) {
        try { this.store.logAction({ kind: "bot_error", content: "shutdown_close_browser_sessions_failed", metadata: { error: String(error instanceof Error ? error.message : error) } }); } catch { /* store may be closing */ }
        console.warn("[ClankerBot] Failed to close browser sessions during shutdown:", error);
      }
    }
    this.backgroundTaskRunner.close();
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

  purgeGuildMemoryRuntime(guildId: string) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return false;

    const session = this.voiceSessionManager.getSession(normalizedGuildId);
    if (!session) return false;

    session.factProfiles = new Map();
    session.guildFactProfile = null;
    session.behavioralFactCache = null;
    session.conversationHistoryCaches = null;
    if (session.warmMemory?.snapshot) {
      session.warmMemory.snapshot = null;
    }
    this.voiceSessionManager.primeSessionFactProfiles(session);
    return true;
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

  clearQueuedReplies(channelId) {
    const normalizedChannelId = String(channelId || "").trim();
    if (!normalizedChannelId) return 0;
    const queue = this.replyQueues.get(normalizedChannelId);
    if (!Array.isArray(queue) || queue.length <= 0) return 0;
    for (const job of queue) {
      const queuedMessageId = String(job?.message?.id || "").trim();
      if (queuedMessageId) {
        this.replyQueuedMessageIds.delete(queuedMessageId);
      }
    }
    this.replyQueues.delete(normalizedChannelId);
    return queue.length;
  }

  dispatchBackgroundCodeTask({
    session,
    task,
    role,
    guildId,
    channelId,
    userId = null,
    triggerMessageId = null,
    source = "reply_tool_code_task",
    progressReports
  }: {
    session: import("./agents/subAgentSession.ts").SubAgentSession;
    task: string;
    role: import("./agents/codeAgent.ts").CodeAgentRole;
    guildId: string;
    channelId: string;
    userId?: string | null;
    triggerMessageId?: string | null;
    source?: string;
    progressReports?: {
      enabled?: boolean;
      intervalMs?: number;
      maxReportsPerTask?: number;
    };
  }) {
    const scopeKey = buildCodeTaskScopeKey({ guildId, channelId });
    return this.backgroundTaskRunner.dispatch({
      session,
      input: task,
      role,
      guildId,
      channelId,
      userId,
      triggerMessageId,
      scopeKey,
      source,
      progressReports: {
        enabled: progressReports?.enabled !== false,
        intervalMs: Number(progressReports?.intervalMs) || 60_000,
        maxReportsPerTask: Number(progressReports?.maxReportsPerTask) || 5
      },
      onProgress: async (taskSnapshot, recentEvents) => {
        await this.deliverAsyncTaskProgress(taskSnapshot, recentEvents);
      },
      onComplete: async (taskSnapshot) => {
        await this.deliverAsyncTaskResult(taskSnapshot);
      }
    });
  }

  async deliverAsyncTaskResult(task: BackgroundTask) {
    if (!task?.channelId || !task?.guildId) return false;
    const mode = task.status === "cancelled" ? "cancelled" : "completion";
    const durationMs = Math.max(0, Number(task.completedAt || Date.now()) - Number(task.startedAt || Date.now()));
    const rawResultText = String(task.result?.text || "").trim();
    const fallbackResultText = String(task.errorMessage || "").trim();
    const resultText = (rawResultText || fallbackResultText || "Task finished with no text output.").slice(0, 6000);
    const promptText = buildCodeTaskResultPrompt({
      mode,
      sessionId: task.sessionId,
      role: task.role,
      status: task.status,
      durationMs,
      costUsd: Number(task.result?.costUsd || 0),
      resultText,
      filesTouched: task.progress.fileEdits,
      triggerMessageId: task.triggerMessageId
    });
    const source = String(task.source || "")
      .trim()
      .toLowerCase();
    const fromVoiceRealtime = source.startsWith("voice_realtime_tool_code_task");
    if (fromVoiceRealtime) {
      const deliveredToVoiceRealtime = this.voiceSessionManager.requestRealtimeCodeTaskFollowup({
        guildId: task.guildId,
        channelId: task.channelId,
        prompt: promptText,
        userId: task.userId,
        source:
          mode === "cancelled"
            ? "voice_realtime_code_task_cancelled_followup"
            : "voice_realtime_code_task_result_followup"
      });
      if (deliveredToVoiceRealtime) {
        return true;
      }
    }
    return await this.enqueueCodeTaskSyntheticEvent({
      task,
      source: "code_task_result",
      promptText,
      forceRespond: true
    });
  }

  async deliverAsyncTaskProgress(task: BackgroundTask, recentEvents: import("./agents/subAgentSession.ts").SubAgentProgressEvent[]) {
    if (!task?.channelId || !task?.guildId) return false;
    if (!Array.isArray(recentEvents) || recentEvents.length <= 0) return false;
    const elapsedMs = Math.max(0, Date.now() - Number(task.startedAt || Date.now()));
    const promptText = buildCodeTaskResultPrompt({
      mode: "progress",
      sessionId: task.sessionId,
      role: task.role,
      status: task.status,
      durationMs: elapsedMs,
      costUsd: Number(task.result?.costUsd || 0),
      filesTouched: task.progress.fileEdits,
      triggerMessageId: task.triggerMessageId,
      recentEvents: recentEvents.map((event) => ({ summary: event.summary }))
    });
    return await this.enqueueCodeTaskSyntheticEvent({
      task,
      source: "code_task_progress",
      promptText,
      forceRespond: true
    });
  }

  private async enqueueCodeTaskSyntheticEvent({
    task,
    source,
    promptText,
    forceRespond
  }: {
    task: BackgroundTask;
    source: string;
    promptText: string;
    forceRespond: boolean;
  }) {
    const channel = this.client.channels.cache.get(String(task.channelId || ""));
    if (!isSendableChannel(channel)) {
      this.store.logAction({
        kind: "bot_error",
        guildId: task.guildId || null,
        channelId: task.channelId || null,
        userId: task.userId || null,
        content: "code_task_synthetic_delivery_channel_unavailable",
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          source
        }
      });
      return false;
    }

    const guild = this.client.guilds.cache.get(String(task.guildId || ""));
    if (!guild) {
      this.store.logAction({
        kind: "bot_error",
        guildId: task.guildId || null,
        channelId: task.channelId || null,
        userId: task.userId || null,
        content: "code_task_synthetic_delivery_guild_unavailable",
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          source
        }
      });
      return false;
    }

    const requesterUserId = String(task.userId || this.client.user?.id || "system").trim() || "system";
    const requesterNameFromGuild = guild.members?.cache?.get(requesterUserId)?.displayName;
    const requesterNameFromUser = this.client.users?.cache?.get(requesterUserId)?.username;
    const requesterName = String(requesterNameFromGuild || requesterNameFromUser || "Requester");
    const syntheticId = `${source}-${task.id}-${Date.now()}`;
    const syntheticTimestamp = Date.now();

    this.store.recordMessage({
      messageId: syntheticId,
      createdAt: syntheticTimestamp,
      guildId: String(task.guildId || ""),
      channelId: String(task.channelId || ""),
      authorId: requesterUserId,
      authorName: requesterName,
      isBot: false,
      content: promptText,
      referencedMessageId: task.triggerMessageId || null
    });

    const syntheticMessage = {
      id: syntheticId,
      channelId: String(task.channelId || ""),
      guildId: String(task.guildId || ""),
      guild,
      channel,
      content: promptText,
      createdTimestamp: syntheticTimestamp,
      author: {
        id: requesterUserId,
        username: requesterName,
        bot: false
      },
      member: {
        displayName: requesterName
      },
      mentions: { users: new Map(), repliedUser: null },
      reference: task.triggerMessageId
        ? { messageId: task.triggerMessageId }
        : null,
      referencedMessage: null,
      attachments: new Map()
    };

    const queued = this.enqueueReplyJob({
      source,
      message: syntheticMessage,
      forceRespond
    });
    this.store.logAction({
      kind: queued ? "text_runtime" : "bot_error",
      guildId: String(task.guildId || ""),
      channelId: String(task.channelId || ""),
      userId: requesterUserId,
      content: queued ? "code_task_synthetic_delivery_queued" : "code_task_synthetic_delivery_queue_rejected",
      metadata: {
        taskId: task.id,
        sessionId: task.sessionId,
        source,
        forceRespond: Boolean(forceRespond),
        syntheticMessageId: syntheticId
      }
    });
    return queued;
  }

  async acknowledgeTextCancellation({
    message,
    settings,
    cancelText,
    cancelledReplyCount = 0,
    cancelledQueuedReplyCount = 0,
    browserCancelled = false
  }) {
    const acknowledgement = await generateTextCancelAcknowledgement({
      llm: this.llm,
      settings,
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      userId: message.author?.id || null,
      messageId: message.id || null,
      authorName: message.member?.displayName || message.author?.username || "someone",
      cancelText,
      cancelledReplyCount,
      cancelledQueuedReplyCount,
      browserCancelled
    });

    if (acknowledgement) {
      try {
        const sent = await message.reply({
          content: acknowledgement,
          allowedMentions: { repliedUser: false }
        });
        this.lastBotMessageAt = Date.now();
        const botUserId = String(this.client.user?.id || "").trim();
        if (botUserId && sent?.id) {
          this.store.recordMessage({
            messageId: sent.id,
            createdAt: sent.createdTimestamp,
            guildId: sent.guildId,
            channelId: sent.channelId,
            authorId: botUserId,
            authorName: getBotName(settings),
            isBot: true,
            content: composeMessageContentForHistoryForMessageHistory(
              sent as Parameters<typeof composeMessageContentForHistoryForMessageHistory>[0],
              acknowledgement
            ),
            referencedMessageId: message.id
          });
        }
        return true;
      } catch (error) {
        this.store.logAction({ kind: "bot_error", guildId: message.guildId, channelId: message.channelId, userId: message.author.id, content: "text_cancel_acknowledgement_failed", metadata: { error: String(error instanceof Error ? error.message : error) } });
      }
    }

    try {
      await message.react(TEXT_CANCEL_FALLBACK_REACTION);
      return true;
    } catch (error) {
      this.store.logAction({ kind: "bot_error", guildId: message.guildId, channelId: message.channelId, userId: message.author.id, content: "text_cancel_reaction_failed", metadata: { error: String(error instanceof Error ? error.message : error) } });
      return false;
    }
  }

  async handleMessage(message) {
    if (!message.guild || !message.channel || !message.author) return;
    if (isAppCommandInvocationMessage(message)) return;

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

    if (isCancelIntent(text)) {
      const replyScopeKey = buildTextReplyScopeKey({
        guildId: message.guildId,
        channelId: message.channelId
      });
      const cancelledReplyCount = this.activeReplies.abortAll(
        replyScopeKey,
        "User requested cancellation via text"
      );
      const browserScopeKey = buildBrowserTaskScopeKey({
        guildId: message.guildId,
        channelId: message.channelId
      });
      const browserCancelled = this.activeBrowserTasks.abort(
        browserScopeKey,
        "User requested cancellation via text"
      );
      const codeTaskScopeKey = buildCodeTaskScopeKey({
        guildId: message.guildId,
        channelId: message.channelId
      });
      const cancelledBackgroundCodeTaskCount = this.backgroundTaskRunner.cancelByScope(
        codeTaskScopeKey,
        "User requested cancellation via text"
      );
      const cancelledQueuedReplyCount = this.clearQueuedReplies(message.channelId);
      if (
        cancelledReplyCount > 0 ||
        cancelledQueuedReplyCount > 0 ||
        browserCancelled ||
        cancelledBackgroundCodeTaskCount > 0
      ) {
        await this.acknowledgeTextCancellation({
          message,
          settings,
          cancelText: text,
          cancelledReplyCount,
          cancelledQueuedReplyCount,
          browserCancelled
        });
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
    const isReplyChannel = isReplyChannelForPermissions(settings, String(message.channelId));
    const replyAdmissionDecision = evaluateReplyAdmissionDecision({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      isReplyChannel,
      triggerMessageId: message.id,
      triggerAuthorId: message.author?.id || null,
      triggerReferenceMessageId: message.reference?.messageId || null,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });
    this.store.logAction({
      kind: "text_runtime",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      content: "reply_admission_decision",
      metadata: {
        ...buildRuntimeDecisionCorrelation({
          botId: this.client.user?.id || null,
          triggerMessageId: message.id,
          source: "message_event",
          stage: "admission",
          allow: replyAdmissionDecision.allow,
          reason: replyAdmissionDecision.reason
        }),
        isReplyChannel,
        allowUnsolicitedReplies: replyAdmissionDecision.allowUnsolicitedReplies,
        ambientReplyEagerness: Number(settings?.interaction?.activity?.ambientReplyEagerness || 0),
        addressSignal: {
          direct: Boolean(addressSignal.direct),
          inferred: Boolean(addressSignal.inferred),
          triggered: Boolean(addressSignal.triggered),
          reason: String(addressSignal.reason || "llm_decides"),
          confidence: Math.max(0, Math.min(1, Number(addressSignal.confidence) || 0)),
          threshold: Math.max(0.4, Math.min(0.95, Number(addressSignal.threshold) || 0.62)),
          confidenceSource: addressSignal.confidenceSource || "fallback"
        },
        attentionMode: replyAdmissionDecision.attentionState.mode,
        attentionReason: replyAdmissionDecision.attentionState.reason,
        recentReplyWindowActive: replyAdmissionDecision.attentionState.recentReplyWindowActive,
        responseWindowSize: replyAdmissionDecision.attentionState.responseWindowSize,
        latestBotMessageId: replyAdmissionDecision.attentionState.latestBotMessageId,
        triggerReferenceMessageId: message.reference?.messageId || null,
        recentMessageCount: Array.isArray(recentMessages) ? recentMessages.length : 0
      }
    });
    if (!replyAdmissionDecision.allow) return;
    this.enqueueReplyJob({
      source: "message_event",
      message,
      addressSignal
    });
  }

  /**
   * Handle a new member joining the guild.
   * Resolves a target text channel (reply channels first, then system channel),
   * records a synthetic event message, and feeds it through the normal reply
   * pipeline so the LLM can decide whether to greet.
   */
  async handleMemberJoin(member) {
    if (!member?.guild || !member?.user) return;
    if (member.user.bot) return;
    if (String(member.user.id) === String(this.client.user?.id || "")) return;

    const settings = this.store.getSettings();
    if (!settings?.permissions?.replies?.allowReplies) return;

    const displayName = member.displayName || member.user.username || "Someone";
    const accountAge = member.user.createdAt
      ? Math.floor((Date.now() - member.user.createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const accountAgeNote = accountAge !== null && accountAge < 7
      ? " (brand new Discord account)"
      : "";
    const eventContent = `[SERVER EVENT: ${displayName} just joined the server${accountAgeNote}. This is not a chat message — it is a membership event. You may greet them naturally if it fits, or output [SKIP] if you have nothing to say.]`;

    // Resolve target channel: prefer reply channels, then guild system channel,
    // then first sendable channel in the guild.
    const permissions = getReplyPermissions(settings);
    const greetingCandidateIds = [
      ...(Array.isArray(permissions.replyChannelIds) ? permissions.replyChannelIds : []),
      ...(Array.isArray(permissions.discoveryChannelIds) ? permissions.discoveryChannelIds : [])
    ].map((id) => String(id).trim()).filter(Boolean);

    let targetChannel = null;
    for (const channelId of greetingCandidateIds) {
      const channel = this.client.channels.cache.get(channelId);
      if (isSendableChannel(channel) && isChannelAllowedForPermissions(settings, channelId)) {
        targetChannel = channel;
        break;
      }
    }
    if (!targetChannel && member.guild.systemChannelId) {
      const sysChannel = this.client.channels.cache.get(member.guild.systemChannelId);
      if (isSendableChannel(sysChannel) && isChannelAllowedForPermissions(settings, member.guild.systemChannelId)) {
        targetChannel = sysChannel;
      }
    }
    if (!targetChannel) {
      const fallback = member.guild.channels.cache
        .filter((ch) => isSendableChannel(ch) && isChannelAllowedForPermissions(settings, String(ch.id)))
        .first();
      if (fallback && isSendableChannel(fallback)) {
        targetChannel = fallback;
      }
    }
    if (!targetChannel) return;

    // Build a synthetic pseudo-ID so the dedup checks in enqueueReplyJob pass.
    const syntheticId = `member-join-${member.user.id}-${Date.now()}`;

    // Record the event in message history so it appears in recent chat context.
    this.store.recordMessage({
      messageId: syntheticId,
      createdAt: Date.now(),
      guildId: member.guild.id,
      channelId: targetChannel.id,
      authorId: member.user.id,
      authorName: displayName,
      isBot: false,
      content: eventContent,
      referencedMessageId: null
    });

    // Build a minimal message-like object that the reply pipeline can consume.
    const syntheticMessage = {
      id: syntheticId,
      channelId: targetChannel.id,
      guildId: member.guild.id,
      guild: member.guild,
      channel: targetChannel,
      content: eventContent,
      createdTimestamp: Date.now(),
      author: {
        id: member.user.id,
        username: member.user.username,
        bot: false
      },
      member: {
        displayName
      },
      mentions: { users: new Map(), repliedUser: null },
      reference: null,
      referencedMessage: null,
      attachments: new Map()
    };

    this.store.logAction({
      kind: "text_runtime",
      guildId: member.guild.id,
      channelId: targetChannel.id,
      userId: member.user.id,
      content: "member_join_event",
      metadata: {
        displayName,
        targetChannelId: targetChannel.id,
        syntheticId
      }
    });

    // Feed through normal admission — the LLM decides whether to greet.
    const recentMessages = this.store.getRecentMessages(targetChannel.id, 20);
    const addressSignal = {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "member_join_event",
      confidence: 0,
      threshold: 0.62,
      confidenceSource: "fallback" as const
    };
    const isReplyChannel = isReplyChannelForPermissions(settings, String(targetChannel.id));
    const replyAdmissionDecision = evaluateReplyAdmissionDecision({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      isReplyChannel,
      triggerMessageId: syntheticId,
      triggerAuthorId: member.user.id,
      triggerReferenceMessageId: null,
      windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW
    });

    this.store.logAction({
      kind: "text_runtime",
      guildId: member.guild.id,
      channelId: targetChannel.id,
      userId: member.user.id,
      content: "member_join_admission_decision",
      metadata: {
        allow: replyAdmissionDecision.allow,
        reason: replyAdmissionDecision.reason,
        isReplyChannel,
        syntheticId
      }
    });

    if (!replyAdmissionDecision.allow) return;

    this.enqueueReplyJob({
      source: "member_join_event",
      message: syntheticMessage,
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
    const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);
    const sendStartedAtMs = Date.now();
    const sent = await message.reply({
      content: finalText,
      allowedMentions: { repliedUser: false }
    });
    const sendMs = Math.max(0, Date.now() - sendStartedAtMs);
    const memorySettings = getMemorySettings(settings);

    this.lastBotMessageAt = Date.now();
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
    if (memorySettings.enabled && typeof this.memory?.ingestMessage === "function") {
      void this.memory.ingestMessage({
        messageId: sent.id,
        authorId: this.client.user.id,
        authorName: getBotName(settings),
        content: finalText,
        isBot: true,
        settings,
        trace: {
          guildId: sent.guildId,
          channelId: sent.channelId,
          userId: this.client.user.id,
          source: "text_reply_memory_ingest"
        }
      }).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: sent.guildId,
          channelId: sent.channelId,
          messageId: sent.id,
          userId: this.client.user.id,
          content: `memory_text_reply_ingest: ${String(error?.message || error)}`
        });
      });
    }
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
        canStandalonePost: isReplyChannelForPermissions(settings, String(message.channelId))
          || isDiscoveryChannelForPermissions(settings, String(message.channelId)),
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

  canTakeAction(kind, maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const count = this.store.countActionsSince(kind, since);
    return count < maxPerHour;
  }

  canSendMessage(maxPerHour) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sentReplies = this.store.countActionsSince("sent_reply", since);
    const sentMessages = this.store.countActionsSince("sent_message", since);
    const initiativePosts = this.store.countActionsSince("initiative_post", since);
    return sentReplies + sentMessages + initiativePosts < maxPerHour;
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
    await maybeRunAutomationCycleForAutomationEngine(this.toAutomationEngineRuntime());

    // Run an ambient initiative cycle on startup to catch unanswered conversations
    await maybeRunInitiativeCycleForInitiativeEngine(this.toInitiativeRuntime());

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
    const channels = [];
    const seen = new Set();

    const explicit = [
      ...permissions.replyChannelIds,
      ...permissions.discoveryChannelIds,
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
