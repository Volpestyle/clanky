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
  getActiveCodeAgentTaskCount,
  createCodeAgentSession as createCodeAgentSessionRuntime
} from "./agents/codeAgent.ts";
import { musicCommands } from "./voice/musicCommands.ts";
import { ImageCaptionCache } from "./vision/imageCaptionCache.ts";
import {
  buildAutomationPrompt,
  buildDiscoveryPrompt,
  buildSystemPrompt
} from "./prompts.ts";
import { getMediaPromptCraftGuidance } from "./promptCore.ts";
import {
  MAX_BROWSER_BROWSE_QUERY_LEN,
  MAX_GIF_QUERY_LEN,
  MAX_IMAGE_LOOKUP_QUERY_LEN,
  MAX_VIDEO_FALLBACK_MESSAGES,
  MAX_VIDEO_TARGET_SCAN,
  collectMemoryFactHints,
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  extractRecentVideoTargets,
  extractUrlsFromText,
  formatReactionSummary,
  isWebSearchOptOutText,
  looksLikeVideoFollowupMessage,
  normalizeDirectiveText,
  normalizeReactionEmojiToken,
  normalizeSkipSentinel,
  parseDiscoveryMediaDirective,
  parseStructuredReplyOutput,
  pickDiscoveryMediaDirective,
  pickReplyMediaDirective,
  REPLY_OUTPUT_JSON_SCHEMA,
  resolveMaxMediaPromptLen,
  splitDiscordMessage
} from "./botHelpers.ts";
import {
  resolveFollowingNextRunAt,
  resolveInitialNextRunAt
} from "./automation.ts";
import { normalizeDiscoveryUrl } from "./discovery.ts";
import { chance, clamp, sanitizeBotText, sleep } from "./utils.ts";
import {
  applyAutomationControlAction,
  composeAutomationControlReply
} from "./bot/automationControl.ts";
import {
  resolveDeterministicMentions as resolveDeterministicMentionsForMentions
} from "./bot/mentions.ts";
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
  buildReplyToolSet,
  executeReplyTool
} from "./tools/replyTools.ts";
import type { ReplyToolRuntime, ReplyToolContext } from "./tools/replyTools.ts";
import {
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  hasBotMessageInRecentWindow as hasBotMessageInRecentWindowForReplyAdmission,
  hasStartupFollowupAfterMessage as hasStartupFollowupAfterMessageForReplyAdmission,
  shouldAttemptReplyDecision as shouldAttemptReplyDecisionForReplyAdmission,
  shouldForceRespondForAddressSignal as shouldForceRespondForAddressSignalForReplyAdmission
} from "./bot/replyAdmission.ts";
import { runStartupCatchup as runStartupCatchupForStartupCatchup } from "./bot/startupCatchup.ts";
import {
  composeVoiceOperationalMessage,
  generateVoiceTurnReply
} from "./bot/voiceReplies.ts";
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
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";
import type { BrowserManager } from "./services/BrowserManager.ts";
import {
  BrowserTaskRegistry,
  buildBrowserTaskScopeKey,
  isAbortError,
  runBrowserBrowseTask
} from "./tools/browserTaskRuntime.ts";
import type { ActiveBrowserTask } from "./tools/browserTaskRuntime.ts";
import {
  resolveOperationalChannel,
  sendToChannel
} from "./voice/voiceOperationalMessaging.ts";
import { loadPromptMemorySliceFromMemory } from "./memory/promptMemorySlice.ts";
import { maybeReplyToMessagePipeline } from "./bot/replyPipeline.ts";
import { SubAgentSessionManager } from "./agents/subAgentSession.ts";
import { BrowserAgentSession } from "./agents/browseAgent.ts";

const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;
const AUTOMATION_TICK_MS = 30_000;
const GATEWAY_WATCHDOG_TICK_MS = 30_000;
const REFLECTION_TICK_MS = 60_000;
const MAX_HISTORY_IMAGE_CANDIDATES = 24;
const MAX_HISTORY_IMAGE_LOOKUP_RESULTS = 6;
const MAX_IMAGE_LOOKUP_QUERY_TOKENS = 7;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;
const MAX_AUTOMATION_RUNS_PER_TICK = 4;
const PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
const SCREEN_SHARE_MESSAGE_MAX_CHARS = 420;
const SCREEN_SHARE_INTENT_THRESHOLD = 0.66;
const LOOKUP_CONTEXT_TTL_HOURS = 48;
const LOOKUP_CONTEXT_MAX_RESULTS = 5;
const LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL = 120;
const IS_TEST_PROCESS = /\.test\.[cm]?[jt]sx?$/i.test(String(process.argv?.[1] || "")) ||
  process.execArgv.includes("--test") ||
  process.argv.includes("--test");
const SCREEN_SHARE_EXPLICIT_REQUEST_RE =
  /\b(?:screen\s*share|share\s*(?:my|the)?\s*screen|watch\s*(?:my|the)?\s*screen|see\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*stream|watch\s*(?:my|the)?\s*stream)\b/i;
type ReplyAttemptOptions = {
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

type MemoryTrace = Record<string, unknown> & {
  source?: string;
};

type DiscoveryLinkCandidate = {
  url?: string;
  source?: string;
};

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
  screenShareSessionManager: any;
  client: any;
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

  attachScreenShareSessionManager(manager) {
    this.screenShareSessionManager = manager || null;
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
        let activeBrowserTask: ActiveBrowserTask | null = null;

        if (!this.browserManager) {
          await interaction.editReply("Browser agent is currently unavailable on this server.");
          return;
        }
        if (!settings?.browser?.enabled) {
          await interaction.editReply("Browser agent is disabled in settings on this server.");
          return;
        }

        try {
          const browserLlmProvider = String(settings?.browser?.llm?.provider || "anthropic").trim();
          const browserLlmModel = String(settings?.browser?.llm?.model || "claude-sonnet-4-5-20250929").trim();
          const maxSteps = Math.max(1, Math.min(30, Number(settings?.browser?.maxStepsPerTask) || 15));
          const stepTimeoutMs = Math.max(5000, Math.min(120000, Number(settings?.browser?.stepTimeoutMs) || 30000));
          const scopeKey = buildBrowserTaskScopeKey({
            guildId: interaction.guildId,
            channelId: interaction.channelId
          });
          activeBrowserTask = this.activeBrowserTasks.beginTask(scopeKey);

          const result = await runBrowserBrowseTask({
            llm: this.llm,
            browserManager: this.browserManager,
            store: this.store,
            sessionKey: `slash:${activeBrowserTask.taskId}`,
            instruction: browseInstruction,
            provider: browserLlmProvider,
            model: browserLlmModel,
            maxSteps,
            stepTimeoutMs,
            trace: {
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              userId: interaction.user.id,
              source: "slash_command_browse"
            },
            logSource: "slash_command_browse",
            signal: activeBrowserTask.abortController.signal
          });

          let responseText = result.text;
          if (result.hitStepLimit) {
            responseText += "\n\n*(Note: I reached my maximum step limit before finishing the task completely.)*";
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
        } finally {
          this.activeBrowserTasks.clear(activeBrowserTask);
        }
      } else if (commandName === "code") {
        await interaction.deferReply();
        const codeInstruction = interaction.options.getString("task", true);
        const codeCwd = interaction.options.getString("cwd", false) || undefined;
        const settings = this.store.getSettings();

        if (!settings?.codeAgent?.enabled) {
          await interaction.editReply("Code agent is disabled in settings.");
          return;
        }
        if (!isCodeAgentUserAllowed(interaction.user.id, settings)) {
          await interaction.editReply("This capability is restricted to allowed users.");
          return;
        }

        const maxParallel = Number(settings?.codeAgent?.maxParallelTasks) || 2;
        if (getActiveCodeAgentTaskCount() >= maxParallel) {
          await interaction.editReply("Too many code agent tasks are already running. Try again shortly.");
          return;
        }
        const maxPerHour = Number(settings?.codeAgent?.maxTasksPerHour) || 10;
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
          } = resolveCodeAgentConfig(settings, codeCwd);

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

    this.client.on("messageReactionAdd", async (reaction) => {
      try {
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

  resolveDashboardVoiceJoinRequester(guild, requesterUserId = "") {
    if (!guild?.voiceStates?.cache) {
      return {
        member: null,
        voiceChannel: null,
        reason: "no_voice_members_found"
      };
    }

    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    if (normalizedRequesterUserId) {
      const explicitVoiceState = guild.voiceStates.cache.get(normalizedRequesterUserId) || null;
      const explicitMember = explicitVoiceState?.member || guild.members?.cache?.get(normalizedRequesterUserId) || null;
      const explicitVoiceChannel = explicitVoiceState?.channel || explicitMember?.voice?.channel || null;
      if (explicitMember?.user?.bot) {
        return {
          member: null,
          voiceChannel: null,
          reason: "requester_is_bot"
        };
      }
      if (explicitMember && explicitVoiceChannel) {
        return {
          member: explicitMember,
          voiceChannel: explicitVoiceChannel,
          reason: "ok"
        };
      }
      return {
        member: null,
        voiceChannel: null,
        reason: "requester_not_in_voice"
      };
    }

    for (const voiceState of guild.voiceStates.cache.values()) {
      const member = voiceState?.member || null;
      if (!member || member.user?.bot) continue;
      const voiceChannel = voiceState?.channel || member.voice?.channel || null;
      if (!voiceChannel) continue;
      return {
        member,
        voiceChannel,
        reason: "ok"
      };
    }

    return {
      member: null,
      voiceChannel: null,
      reason: "no_voice_members_found"
    };
  }

  resolveDashboardVoiceJoinTextChannel({ guild, textChannelId = "" }) {
    if (!guild?.channels?.cache) return null;

    const normalizedTextChannelId = String(textChannelId || "").trim();
    const existingSession = this.voiceSessionManager.sessions.get(String(guild.id));
    const botMember = guild.members?.me || guild.members?.cache?.get(this.client.user?.id || "");
    const candidateIds = [
      normalizedTextChannelId,
      String(existingSession?.textChannelId || "").trim(),
      String(guild.systemChannelId || "").trim()
    ];
    const seenIds = new Set();

    const canSendInChannel = (channel) => {
      if (!channel || typeof channel.send !== "function") return false;
      if (typeof channel.isTextBased === "function" && !channel.isTextBased()) return false;
      if (botMember && typeof channel.permissionsFor === "function") {
        const permissions = channel.permissionsFor(botMember);
        if (permissions && typeof permissions.has === "function" && !permissions.has("SendMessages")) {
          return false;
        }
      }
      return true;
    };

    for (const candidateId of candidateIds) {
      if (!candidateId || seenIds.has(candidateId)) continue;
      seenIds.add(candidateId);
      const channel = guild.channels.cache.get(candidateId) || null;
      if (canSendInChannel(channel)) return channel;
    }

    for (const channel of guild.channels.cache.values()) {
      if (canSendInChannel(channel)) return channel;
    }

    return null;
  }

  async requestVoiceJoinFromDashboard({
    guildId = null,
    requesterUserId = null,
    textChannelId = null,
    source = "dashboard_voice_tab"
  } = {}) {
    const settings = this.store.getSettings();
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    const normalizedTextChannelId = String(textChannelId || "").trim();
    const normalizedSource = String(source || "dashboard_voice_tab").trim() || "dashboard_voice_tab";

    const guilds = [...this.client.guilds.cache.values()];
    let targetGuild = null;
    if (normalizedGuildId) {
      targetGuild = this.client.guilds.cache.get(normalizedGuildId) || null;
    } else {
      for (const guild of guilds) {
        const resolution = this.resolveDashboardVoiceJoinRequester(guild, normalizedRequesterUserId);
        if (resolution.member && resolution.voiceChannel) {
          targetGuild = guild;
          break;
        }
      }
      if (!targetGuild && guilds.length > 0) {
        targetGuild = guilds[0];
      }
    }

    if (!targetGuild) {
      return {
        ok: false,
        reason: normalizedGuildId ? "guild_not_found" : "no_guild_available",
        guildId: normalizedGuildId || null,
        voiceChannelId: null,
        textChannelId: null,
        requesterUserId: normalizedRequesterUserId || null
      };
    }

    const requesterResolution = this.resolveDashboardVoiceJoinRequester(targetGuild, normalizedRequesterUserId);
    const targetMember = requesterResolution.member;
    const targetVoiceChannel = requesterResolution.voiceChannel;
    if (!targetMember || !targetVoiceChannel) {
      return {
        ok: false,
        reason: requesterResolution.reason || "requester_not_in_voice",
        guildId: targetGuild.id,
        voiceChannelId: null,
        textChannelId: null,
        requesterUserId: normalizedRequesterUserId || null
      };
    }

    const targetTextChannel = this.resolveDashboardVoiceJoinTextChannel({
      guild: targetGuild,
      textChannelId: normalizedTextChannelId
    });
    if (!targetTextChannel) {
      return {
        ok: false,
        reason: "text_channel_unavailable",
        guildId: targetGuild.id,
        voiceChannelId: String(targetVoiceChannel.id || "") || null,
        textChannelId: normalizedTextChannelId || null,
        requesterUserId: String(targetMember.id || "") || null
      };
    }

    const targetVoiceChannelId = String(targetVoiceChannel.id || "").trim();
    const existingSession = this.voiceSessionManager.sessions.get(String(targetGuild.id));
    const alreadyInTargetChannel =
      Boolean(existingSession) &&
      existingSession.ending !== true &&
      String(existingSession.voiceChannelId || "") === targetVoiceChannelId;

    const syntheticMessage = {
      guild: targetGuild,
      guildId: String(targetGuild.id || ""),
      channel: targetTextChannel,
      channelId: String(targetTextChannel.id || ""),
      id: null,
      author: {
        id: String(targetMember.id || ""),
        username: String(targetMember?.user?.username || targetMember?.displayName || targetMember?.id || "")
      },
      member: targetMember
    };

    const handled = await this.voiceSessionManager.requestJoin({
      message: syntheticMessage,
      settings,
      intentConfidence: 1
    });

    const activeSession = this.voiceSessionManager.sessions.get(String(targetGuild.id));
    const joinedTargetChannel =
      Boolean(activeSession) &&
      activeSession.ending !== true &&
      String(activeSession.voiceChannelId || "") === targetVoiceChannelId;

    const reason = !handled
      ? "join_not_handled"
      : joinedTargetChannel
        ? alreadyInTargetChannel
          ? "already_in_channel"
          : "joined"
        : "voice_join_unconfirmed";

    this.store.logAction({
      kind: "voice_runtime",
      guildId: targetGuild.id,
      channelId: String(targetTextChannel.id || "") || null,
      userId: String(targetMember.id || "") || null,
      content: "dashboard_voice_join",
      metadata: {
        source: normalizedSource,
        reason,
        requestedGuildId: normalizedGuildId || null,
        requestedRequesterUserId: normalizedRequesterUserId || null,
        requestedTextChannelId: normalizedTextChannelId || null,
        voiceChannelId: targetVoiceChannelId || null,
        handled: Boolean(handled),
        joinedTargetChannel: Boolean(joinedTargetChannel)
      }
    });

    return {
      ok: joinedTargetChannel,
      reason,
      guildId: targetGuild.id,
      voiceChannelId: targetVoiceChannelId || null,
      textChannelId: String(targetTextChannel.id || "") || null,
      requesterUserId: String(targetMember.id || "") || null
    };
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
    return getReplyQueueWaitMs(this, settings);
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
    return dequeueReplyJob(this, channelId);
  }

  dequeueReplyBurst(channelId, settings) {
    return dequeueReplyBurst(this, channelId, settings);
  }

  requeueReplyJobs(channelId, jobs) {
    return requeueReplyJobs(this, channelId, jobs);
  }

  async processReplyQueue(channelId) {
    return await processReplyQueue(this, channelId);
  }

  async ensureGatewayHealthy() {
    return await ensureGatewayHealthy(this);
  }

  scheduleReconnect(reason, delayMs) {
    return scheduleReconnect(this, reason, delayMs);
  }

  async reconnectGateway(reason) {
    return await reconnectGateway(this, reason);
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

    if (settings.memory.enabled) {
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
      settings.memory.maxRecentMessages
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
    const runtime = {
      llm: this.llm,
      store: this.store,
      memory: this.memory,
      search: this.search,
      client: this.client,
      loadRelevantMemoryFacts: (payload) => this.loadRelevantMemoryFacts(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      loadPromptMemorySlice: (payload) => this.loadPromptMemorySlice(payload),
      buildWebSearchContext: (runtimeSettings, messageText) =>
        this.buildWebSearchContext(runtimeSettings, messageText),
      loadRecentConversationHistory: (payload) => this.getConversationHistoryForPrompt(payload),
      loadRecentLookupContext: (payload) => this.getRecentLookupContextForPrompt(payload),
      rememberRecentLookupContext: (payload) => this.rememberRecentLookupContext(payload),
      getVoiceScreenShareCapability: (payload) => this.getVoiceScreenShareCapability(payload),
      offerVoiceScreenShareLink: (payload) => this.offerVoiceScreenShareLink(payload)
    };
    return await composeVoiceOperationalMessage(runtime, {
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
    webSearchTimeoutMs = null
  }) {
    const runtime = {
      llm: this.llm,
      store: this.store,
      memory: this.memory,
      search: this.search,
      client: this.client,
      loadRelevantMemoryFacts: (payload) => this.loadRelevantMemoryFacts(payload),
      buildMediaMemoryFacts: (payload) => this.buildMediaMemoryFacts(payload),
      loadPromptMemorySlice: (payload) => this.loadPromptMemorySlice(payload),
      buildWebSearchContext: (runtimeSettings, messageText) =>
        this.buildWebSearchContext(runtimeSettings, messageText),
      loadRecentConversationHistory: (payload) => this.getConversationHistoryForPrompt(payload),
      loadRecentLookupContext: (payload) => this.getRecentLookupContextForPrompt(payload),
      rememberRecentLookupContext: (payload) => this.rememberRecentLookupContext(payload),
      getVoiceScreenShareCapability: (payload) => this.getVoiceScreenShareCapability(payload),
      offerVoiceScreenShareLink: (payload) => this.offerVoiceScreenShareLink(payload)
    };
    return await generateVoiceTurnReply(runtime, {
      settings,
      guildId,
      channelId,
      userId,
      transcript,
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
      webSearchTimeoutMs
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
    return await maybeReplyToMessagePipeline(this, message, settings, options);
  }

  getVoiceScreenShareCapability({
    settings: _settings = null,
    guildId: _guildId = null,
    channelId: _channelId = null,
    requesterUserId: _requesterUserId = null
  } = {}) {
    const manager = this.screenShareSessionManager;
    if (!manager || typeof manager.getLinkCapability !== "function") {
      return {
        supported: false,
        enabled: false,
        available: false,
        status: "disabled",
        publicUrl: "",
        reason: "screen_share_manager_unavailable"
      };
    }

    const capability = manager.getLinkCapability();
    const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
    const enabled = Boolean(capability?.enabled);
    const available = enabled && status === "ready";
    const rawReason = String(capability?.reason || "").trim().toLowerCase();
    return {
      supported: true,
      enabled,
      available,
      status,
      publicUrl: String(capability?.publicUrl || "").trim(),
      reason: available ? null : rawReason || status || "unavailable"
    };
  }

  async offerVoiceScreenShareLink({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    transcript = "",
    source = "voice_turn_directive"
  } = {}) {
    const manager = this.screenShareSessionManager;
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim();
    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    if (!normalizedGuildId || !normalizedChannelId || !normalizedRequesterUserId) {
      return {
        offered: false,
        reason: "invalid_context"
      };
    }

    const resolvedSettings = settings || this.store.getSettings();
    const guild = this.client.guilds.cache.get(normalizedGuildId) || null;
    const requesterDisplayName =
      guild?.members?.cache?.get(normalizedRequesterUserId)?.displayName ||
      guild?.members?.cache?.get(normalizedRequesterUserId)?.user?.username ||
      this.client.users?.cache?.get(normalizedRequesterUserId)?.username ||
      "unknown";
    const syntheticMessage = {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      id: null,
      author: {
        id: normalizedRequesterUserId,
        username: requesterDisplayName
      },
      member: {
        displayName: requesterDisplayName
      }
    };
    const eventSource = String(source || "voice_turn_directive").trim().slice(0, 80) || "voice_turn_directive";

    const channel = await this.resolveOperationalChannel(null, normalizedChannelId, {
      guildId: normalizedGuildId,
      userId: normalizedRequesterUserId,
      messageId: null,
      event: "voice_screen_share_offer",
      reason: "voice_directive"
    });
    if (!channel) {
      return {
        offered: false,
        reason: "channel_unavailable"
      };
    }

    if (!manager || typeof manager.createSession !== "function") {
      const unavailableMessage = await this.composeScreenShareUnavailableMessage({
        message: syntheticMessage,
        settings: resolvedSettings,
        reason: "screen_share_manager_unavailable",
        source: eventSource
      });
      if (unavailableMessage) {
        await this.sendToChannel(channel, unavailableMessage, {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId,
          userId: normalizedRequesterUserId,
          event: "voice_screen_share_offer",
          reason: "screen_share_manager_unavailable"
        });
      }
      return {
        offered: false,
        reason: "screen_share_manager_unavailable"
      };
    }

    const created = await manager.createSession({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      requesterUserId: normalizedRequesterUserId,
      requesterDisplayName,
      targetUserId: normalizedRequesterUserId,
      source: eventSource
    });
    if (!created?.ok) {
      const unavailableReason = String(created?.reason || "unknown");
      const unavailableMessage = await this.composeScreenShareUnavailableMessage({
        message: syntheticMessage,
        settings: resolvedSettings,
        reason: unavailableReason,
        source: eventSource
      });
      if (unavailableMessage) {
        await this.sendToChannel(channel, unavailableMessage, {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId,
          userId: normalizedRequesterUserId,
          event: "voice_screen_share_offer",
          reason: unavailableReason
        });
      }
      return {
        offered: false,
        reason: unavailableReason
      };
    }

    const linkUrl = String(created?.shareUrl || "").trim();
    const expiresInMinutes = Number(created?.expiresInMinutes || 0);
    if (!linkUrl) {
      return {
        offered: false,
        reason: "missing_share_url"
      };
    }
    if (created?.reused) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: normalizedRequesterUserId,
        content: "screen_share_offer_suppressed_existing_session",
        metadata: {
          source: eventSource,
          transcript: String(transcript || "").slice(0, 220),
          expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
          linkHost: safeUrlHost(linkUrl)
        }
      });
      return {
        offered: false,
        reused: true,
        reason: "already_active_session",
        linkUrl,
        expiresInMinutes
      };
    }

    const offerMessage = await this.composeScreenShareOfferMessage({
      message: syntheticMessage,
      settings: resolvedSettings,
      linkUrl,
      expiresInMinutes,
      explicitRequest: true,
      intentRequested: true,
      confidence: 1,
      source: eventSource
    });
    if (!offerMessage) {
      return {
        offered: false,
        reason: "offer_message_empty"
      };
    }

    const sent = await this.sendToChannel(channel, offerMessage, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: normalizedRequesterUserId,
      event: "voice_screen_share_offer",
      reason: "voice_directive"
    });
    if (!sent) {
      return {
        offered: false,
        reason: "offer_message_send_failed"
      };
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: normalizedRequesterUserId,
      content: "screen_share_offer_sent_from_voice",
      metadata: {
        source: eventSource,
        transcript: String(transcript || "").slice(0, 220),
        expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
        linkHost: safeUrlHost(linkUrl)
      }
    });

    return {
      offered: true,
      reason: "offered",
      linkUrl,
      expiresInMinutes
    };
  }

  async maybeHandleStructuredVoiceIntent({ message, settings, replyDirective }) {
    const voiceSettings = settings?.voice || {};
    if (!voiceSettings.enabled) return false;

    const intent = replyDirective?.voiceIntent;
    if (!intent?.intent) return false;

    const threshold = clamp(Number(voiceSettings.intentConfidenceThreshold) || 0.75, 0.4, 0.99);
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
      authorName: settings.botName,
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
    const empty = {
      offered: false,
      appendText: "",
      linkUrl: null,
      explicitRequest: false,
      intentRequested: false,
      confidence: 0,
      reason: null
    };

    const explicitRequest = SCREEN_SHARE_EXPLICIT_REQUEST_RE.test(String(message?.content || ""));
    const manager = this.screenShareSessionManager;
    const settings = this.store.getSettings();
    if (!message?.guildId || !message?.channelId) return empty;
    if (!manager) {
      if (!explicitRequest) return empty;
      const appendText = await this.composeScreenShareUnavailableMessage({
        message,
        settings,
        reason: "screen_share_manager_unavailable",
        source
      });
      return {
        ...empty,
        explicitRequest: true,
        appendText
      };
    }

    const intent = replyDirective?.screenShareIntent || {};
    const intentRequested = intent?.action === "offer_link";
    const confidence = Number(intent?.confidence || 0);
    const intentAllowed = intentRequested && confidence >= SCREEN_SHARE_INTENT_THRESHOLD;
    if (!explicitRequest && !intentAllowed) return empty;

    const created = await manager.createSession({
      guildId: message.guildId,
      channelId: message.channelId,
      requesterUserId: message.author?.id || null,
      requesterDisplayName: message.member?.displayName || message.author?.username || "",
      targetUserId: message.author?.id || null,
      source
    });

    if (!created?.ok) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_unavailable",
        metadata: {
          reason: created?.reason || "unknown",
          explicitRequest,
          intentRequested,
          confidence,
          source
        }
      });
      if (!explicitRequest) {
        return {
          ...empty,
          explicitRequest,
          intentRequested,
          confidence,
          reason: created?.reason || "unknown"
        };
      }
      const appendText = await this.composeScreenShareUnavailableMessage({
        message,
        settings,
        reason: created?.reason || "unknown",
        source
      });
      return {
        ...empty,
        explicitRequest,
        intentRequested,
        confidence,
        reason: created?.reason || "unknown",
        appendText
      };
    }

    const linkUrl = String(created.shareUrl || "").trim();
    const expiresInMinutes = Number(created.expiresInMinutes || 0);
    if (!linkUrl) return empty;
    if (created?.reused) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_suppressed_existing_session",
        metadata: {
          explicitRequest,
          intentRequested,
          confidence,
          expiresInMinutes,
          linkHost: safeUrlHost(linkUrl),
          source
        }
      });
      return {
        ...empty,
        explicitRequest,
        intentRequested,
        confidence,
        linkUrl,
        reason: "already_active_session"
      };
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      content: "screen_share_offer_prepared",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence,
        expiresInMinutes,
        linkHost: safeUrlHost(linkUrl),
        source
      }
    });

    const appendText = await this.composeScreenShareOfferMessage({
      message,
      settings,
      linkUrl,
      expiresInMinutes,
      explicitRequest,
      intentRequested,
      confidence,
      source
    });

    return {
      offered: true,
      appendText,
      linkUrl,
      explicitRequest,
      intentRequested,
      confidence,
      reason: "offered"
    };
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
    const composed = await this.composeVoiceOperationalMessage({
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_screen_share_offer",
      reason: explicitRequest ? "explicit_request" : "proactive_offer",
      details: {
        linkUrl,
        expiresInMinutes,
        explicitRequest: Boolean(explicitRequest),
        intentRequested: Boolean(intentRequested),
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      },
      maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
    });

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(String(composed || "")),
      SCREEN_SHARE_MESSAGE_MAX_CHARS
    );
    if (!normalized || normalized === "[SKIP]") {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_message_empty",
        metadata: {
          explicitRequest: Boolean(explicitRequest),
          intentRequested: Boolean(intentRequested),
          confidence: Number(confidence || 0),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    if (!String(normalized).includes(linkUrl)) {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_offer_message_missing_link",
        metadata: {
          explicitRequest: Boolean(explicitRequest),
          intentRequested: Boolean(intentRequested),
          confidence: Number(confidence || 0),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    return normalized;
  }

  async composeScreenShareUnavailableMessage({
    message,
    settings,
    reason = "unavailable",
    source = "message_event"
  }) {
    const composed = await this.composeVoiceOperationalMessage({
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_screen_share_offer",
      reason: String(reason || "unavailable"),
      details: {
        source: String(source || "message_event"),
        unavailable: true
      },
      maxOutputChars: SCREEN_SHARE_MESSAGE_MAX_CHARS
    });

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(String(composed || "")),
      SCREEN_SHARE_MESSAGE_MAX_CHARS
    );
    if (!normalized || normalized === "[SKIP]") {
      this.store.logAction({
        kind: "voice_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        content: "screen_share_unavailable_message_empty",
        metadata: {
          reason: String(reason || "unavailable"),
          source: String(source || "message_event")
        }
      });
      return "";
    }
    return normalized;
  }

  async resolveOperationalChannel(
    channel,
    channelId,
    { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await resolveOperationalChannel(this, channel, channelId, {
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
    return await sendToChannel(this, channel, text, {
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

    if (!settings.permissions.allowReactions) {
      return {
        ...result,
        blockedByPermission: true
      };
    }

    if (!this.canTakeAction("reacted", settings.permissions.maxReactionsPerHour)) {
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
    const elapsed = Date.now() - this.lastBotMessageAt;
    return elapsed >= settings.activity.minSecondsBetweenMessages * 1000;
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
    const maxPerDay = clamp(Number(settings.discovery?.maxImagesPerDay) || 0, 0, 200);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("image_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canGenerate: maxPerDay > 0 && remaining > 0
    };
  }

  getVideoGenerationBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.discovery?.maxVideosPerDay) || 0, 0, 120);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("video_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canGenerate: maxPerDay > 0 && remaining > 0
    };
  }

  getGifBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.discovery?.maxGifsPerDay) || 0, 0, 300);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("gif_call", since24h);
    const remaining = Math.max(0, maxPerDay - used);

    return {
      maxPerDay,
      used,
      remaining,
      canFetch: maxPerDay > 0 && remaining > 0
    };
  }

  getMediaGenerationCapabilities(settings) {
    if (!this.llm?.getMediaGenerationCapabilities) {
      return {
        simpleImageReady: false,
        complexImageReady: false,
        videoReady: false,
        simpleImageModel: null,
        complexImageModel: null,
        videoModel: null
      };
    }

    return this.llm.getMediaGenerationCapabilities(settings);
  }

  isImageGenerationReady(settings, variant = "any") {
    return Boolean(this.llm?.isImageGenerationReady?.(settings, variant));
  }

  isVideoGenerationReady(settings) {
    return Boolean(this.llm?.isVideoGenerationReady?.(settings));
  }

  getWebSearchBudgetState(settings) {
    const maxPerHour = clamp(Number(settings.webSearch?.maxSearchesPerHour) || 0, 0, 120);
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const successCount = this.store.countActionsSince("search_call", since1h);
    const errorCount = this.store.countActionsSince("search_error", since1h);
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

  getBrowserBudgetState(settings) {
    const maxPerHour = clamp(Number(settings.browser?.maxBrowseCallsPerHour) || 0, 0, 60);
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("browser_browse_call", since1h);
    const remaining = Math.max(0, maxPerHour - used);

    return {
      maxPerHour,
      used,
      remaining,
      canBrowse: maxPerHour > 0 && remaining > 0
    };
  }

  getVideoContextBudgetState(settings) {
    const maxPerHour = clamp(Number(settings.videoContext?.maxLookupsPerHour) || 0, 0, 120);
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const successCount = this.store.countActionsSince("video_context_call", since1h);
    const errorCount = this.store.countActionsSince("video_context_error", since1h);
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

  async buildVideoReplyContext({ settings, message, recentMessages = [], trace = {} }) {
    const messageText = String(message?.content || "");
    const enabled = Boolean(settings.videoContext?.enabled);
    const budget = this.getVideoContextBudgetState(settings);
    const maxVideosPerMessage = clamp(Number(settings.videoContext?.maxVideosPerMessage) || 0, 0, 6);
    const maxTranscriptChars = clamp(Number(settings.videoContext?.maxTranscriptChars) || 1200, 200, 4000);
    const keyframeIntervalSeconds = clamp(Number(settings.videoContext?.keyframeIntervalSeconds) || 0, 0, 120);
    const maxKeyframesPerVideo = clamp(Number(settings.videoContext?.maxKeyframesPerVideo) || 0, 0, 8);
    const allowAsrFallback = Boolean(settings.videoContext?.allowAsrFallback);
    const maxAsrSeconds = clamp(Number(settings.videoContext?.maxAsrSeconds) || 120, 15, 600);

    const base = {
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

    if (!this.video) {
      return base;
    }

    const directTargets = this.video.extractMessageTargets(message, MAX_VIDEO_TARGET_SCAN);
    const fallbackTargets =
      !directTargets.length && looksLikeVideoFollowupMessage(messageText)
        ? extractRecentVideoTargets({
          videoService: this.video,
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
      const result = await this.video.fetchContexts({
        targets: selectedTargets,
        maxTranscriptChars,
        keyframeIntervalSeconds,
        maxKeyframesPerVideo,
        allowAsrFallback,
        maxAsrSeconds,
        trace
      });
      const firstError = result.errors?.[0]?.error || null;
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
        error: String(error?.message || error),
        errors: [
          {
            videoId: null,
            url: null,
            error: String(error?.message || error)
          }
        ]
      };
    }
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
    if (!this.store || typeof this.store.searchLookupContext !== "function") return [];
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedQuery = String(queryText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    try {
      return this.store.searchLookupContext({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        limit,
        maxAgeHours
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: this.client.user?.id || null,
        content: `lookup_context_search: ${String(error?.message || error)}`
      });
      return [];
    }
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
    if (!this.store || typeof this.store.searchConversationWindows !== "function") return [];
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedQuery = String(queryText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    if (!normalizedQuery) return [];
    try {
      return this.store.searchConversationWindows({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        limit,
        maxAgeHours,
        before,
        after
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: this.client.user?.id || null,
        content: `conversation_history_search: ${String(error?.message || error)}`
      });
      return [];
    }
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
    if (!this.store || typeof this.store.recordLookupContext !== "function") return false;
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return false;
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedSource = String(source || "reply_web_lookup")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const normalizedQuery = String(query || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    if (!normalizedQuery) return false;
    const normalizedResults = (Array.isArray(results) ? results : []).slice(0, LOOKUP_CONTEXT_MAX_RESULTS);
    if (!normalizedResults.length) return false;
    try {
      return this.store.recordLookupContext({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: normalizedUserId,
        source: normalizedSource,
        query: normalizedQuery,
        provider,
        results: normalizedResults,
        ttlHours: LOOKUP_CONTEXT_TTL_HOURS,
        maxResults: LOOKUP_CONTEXT_MAX_RESULTS,
        maxRowsPerChannel: LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: this.client.user?.id || null,
        content: `lookup_context_record: ${String(error?.message || error)}`
      });
      return false;
    }
  }

  buildWebSearchContext(settings, messageText) {
    const text = String(messageText || "");
    const configured = Boolean(this.search?.isConfigured?.());
    const enabled = Boolean(settings.webSearch?.enabled);
    const budget = this.getWebSearchBudgetState(settings);

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

  buildBrowserBrowseContext(settings) {
    const configured = Boolean(this.browserManager);
    const enabled = Boolean(settings?.browser?.enabled);
    const budget = this.getBrowserBudgetState(settings);

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

  buildMemoryLookupContext({ settings }) {
    const enabled = Boolean(settings?.memory?.enabled && this.memory?.searchDurableFacts);
    return {
      enabled,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    };
  }

  buildImageLookupContext({ recentMessages = [], excludedUrls = [] } = {}) {
    const excluded = new Set(
      (Array.isArray(excludedUrls) ? excludedUrls : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    );
    const candidates = this.extractHistoryImageCandidates({
      recentMessages,
      excluded
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

  /**
   * Kick off async captioning for uncaptioned image candidates.
   * Fire-and-forget — errors are silently swallowed.
   */
  captionRecentHistoryImages({ candidates = [], settings = null, trace = null } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const maxPerBatch = Math.min(list.length, 5);
    let scheduled = 0;

    // Enforce hourly caption budget
    const maxPerHour = Number((settings as Record<string, any>)?.vision?.maxCaptionsPerHour);
    const budgetCap = Number.isFinite(maxPerHour) ? maxPerHour : 60;
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    this.captionTimestamps = this.captionTimestamps.filter((t) => t > oneHourAgo);
    const remainingBudget = Math.max(0, budgetCap - this.captionTimestamps.length);
    if (remainingBudget === 0) return;

    for (const candidate of list) {
      if (scheduled >= maxPerBatch) break;
      if (scheduled >= remainingBudget) break;
      if (!candidate?.url) continue;
      if (this.imageCaptionCache.hasOrInflight(candidate.url)) continue;

      scheduled++;
      this.captionTimestamps.push(now);
      this.imageCaptionCache
        .getOrCaption({
          url: candidate.url,
          llm: this.llm,
          settings,
          mimeType: candidate.contentType || "",
          trace: trace || {
            guildId: null,
            channelId: null,
            userId: null,
            source: "history_image_caption"
          }
        })
        .catch(() => { });
    }
  }

  /**
   * Build auto-include image inputs from recent history candidates.
   * Returns the top N candidates as direct vision inputs for the LLM.
   */
  getAutoIncludeImageInputs({ candidates = [], maxImages = 3 } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const cap = Math.max(0, Math.min(Number(maxImages) || 3, 6));
    const inputs = [];

    for (const candidate of list) {
      if (inputs.length >= cap) break;
      if (!candidate?.url) continue;
      inputs.push({
        url: candidate.url,
        filename: candidate.filename || "(unnamed)",
        contentType: candidate.contentType || ""
      });
    }

    return inputs;
  }

  extractHistoryImageCandidates({ recentMessages = [], excluded = new Set() } = {}) {
    const rows = Array.isArray(recentMessages) ? recentMessages : [];
    const seen = excluded instanceof Set ? new Set(excluded) : new Set();
    const candidates = [];

    for (const row of rows) {
      if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
      const content = String(row?.content || "");
      if (!content) continue;

      const urls = extractUrlsFromText(content);
      if (!urls.length) continue;

      for (const rawUrl of urls) {
        if (candidates.length >= MAX_HISTORY_IMAGE_CANDIDATES) break;
        const url = String(rawUrl || "").trim();
        if (!url) continue;
        if (!isLikelyImageUrl(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const parsed = parseHistoryImageReference(url);
        const contentSansUrl = content.replace(url, " ").replace(/\s+/g, " ").trim();
        // Enrich context with cached vision caption if available
        const cachedCaption = this.imageCaptionCache?.get(url);
        const captionText = cachedCaption?.caption || "";
        const baseContext = contentSansUrl.slice(0, 180);
        const enrichedContext = captionText
          ? (baseContext ? `${baseContext} [caption: ${captionText}]` : `[caption: ${captionText}]`).slice(0, 360)
          : baseContext;

        candidates.push({
          messageId: String(row?.message_id || "").trim() || null,
          authorName: String(row?.author_name || "unknown").trim() || "unknown",
          createdAt: String(row?.created_at || "").trim(),
          url,
          filename: parsed.filename || "(unnamed)",
          contentType: parsed.contentType || "",
          context: enrichedContext,
          recencyRank: candidates.length,
          hasCachedCaption: Boolean(cachedCaption)
        });
      }
    }

    return candidates;
  }

  rankImageLookupCandidates({ candidates = [], query = "" } = {}) {
    const normalizedQuery = String(query || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const queryTokens = [...new Set(normalizedQuery.match(/[a-z0-9]{3,}/g) || [])].slice(
      0,
      MAX_IMAGE_LOOKUP_QUERY_TOKENS
    );
    const wantsVisualRecall = /\b(?:image|photo|picture|pic|screenshot|meme|earlier|previous|that)\b/i.test(
      normalizedQuery
    );

    const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
      const haystack = [
        candidate?.context,
        candidate?.filename,
        candidate?.authorName
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      let score = Math.max(0, 4 - index * 0.3);
      const reasons = [];

      if (normalizedQuery && haystack.includes(normalizedQuery)) {
        score += 9;
        reasons.push("phrase match");
      }

      let tokenHits = 0;
      for (const token of queryTokens) {
        if (!token) continue;
        if (haystack.includes(token)) {
          score += 2;
          tokenHits += 1;
        }
      }
      if (tokenHits > 0) {
        reasons.push(`${tokenHits} token hit${tokenHits === 1 ? "" : "s"}`);
      }

      if (wantsVisualRecall) {
        score += 1;
      }

      return {
        ...candidate,
        score,
        matchReason: reasons.join(", ") || "recency fallback"
      };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.recencyRank || 0) - (b.recencyRank || 0);
    });

    const matched = ranked.filter((item) => item.score >= 4);
    return matched.length ? matched : ranked;
  }

  async runModelRequestedImageLookup({
    imageLookup,
    query
  }) {
    const normalizedQuery = normalizeDirectiveText(query, MAX_IMAGE_LOOKUP_QUERY_LEN);
    const state = {
      ...imageLookup,
      requested: true,
      used: false,
      query: normalizedQuery,
      results: [],
      selectedImageInputs: [],
      error: null
    };

    if (!state.enabled) {
      return state;
    }
    if (!normalizedQuery) {
      return {
        ...state,
        error: "Missing image lookup query."
      };
    }

    const candidates = Array.isArray(state.candidates) ? state.candidates : [];
    if (!candidates.length) {
      return {
        ...state,
        error: "No recent history images are available for lookup."
      };
    }

    const ranked = this.rankImageLookupCandidates({
      candidates,
      query: normalizedQuery
    });
    const selected = ranked.slice(0, Math.min(MAX_HISTORY_IMAGE_LOOKUP_RESULTS, MAX_MODEL_IMAGE_INPUTS));
    if (!selected.length) {
      return {
        ...state,
        error: "No matching history images were found."
      };
    }

    return {
      ...state,
      used: true,
      results: selected,
      selectedImageInputs: selected.map((item) => ({
        url: item.url,
        filename: item.filename,
        contentType: item.contentType
      }))
    };
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
    const normalizedQuery = normalizeDirectiveText(query, MAX_BROWSER_BROWSE_QUERY_LEN);
    const state = {
      ...browserBrowse,
      requested: true,
      used: false,
      blockedByBudget: false,
      query: normalizedQuery,
      text: "",
      steps: 0,
      hitStepLimit: false,
      error: null
    };

    if (!state.enabled || !state.configured || !this.browserManager) {
      return state;
    }
    if (!state.budget?.canBrowse) {
      return {
        ...state,
        blockedByBudget: true
      };
    }
    if (!normalizedQuery) {
      return {
        ...state,
        error: "Missing browser browse query."
      };
    }
    if (!this.llm) {
      return {
        ...state,
        error: "llm_unavailable"
      };
    }

    const maxSteps = clamp(Number(settings?.browser?.maxStepsPerTask) || 15, 1, 30);
    const stepTimeoutMs = clamp(Number(settings?.browser?.stepTimeoutMs) || 30_000, 5_000, 120_000);
    const browserLlmProvider = String(settings?.browser?.llm?.provider || "anthropic").trim();
    const browserLlmModel = String(settings?.browser?.llm?.model || "claude-sonnet-4-5-20250929").trim();

    const scopeKey = buildBrowserTaskScopeKey({
      guildId,
      channelId
    });
    const activeBrowserTask = this.activeBrowserTasks.beginTask(scopeKey);

    try {
      const result = await runBrowserBrowseTask({
        llm: this.llm,
        browserManager: this.browserManager,
        store: this.store,
        sessionKey: `reply:${activeBrowserTask.taskId}`,
        instruction: normalizedQuery,
        provider: browserLlmProvider,
        model: browserLlmModel,
        maxSteps,
        stepTimeoutMs,
        trace: {
          guildId,
          channelId,
          userId,
          source: `${source}_browser_browse`
        },
        logSource: source,
        signal: activeBrowserTask.abortController.signal
      });

      return {
        ...state,
        used: true,
        text: result.text,
        steps: result.steps,
        hitStepLimit: result.hitStepLimit
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ...state,
          error: "Browser session cancelled by user."
        };
      }
      return {
        ...state,
        error: String(error?.message || error)
      };
    } finally {
      this.activeBrowserTasks.clear(activeBrowserTask);
    }
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
    if (!settings?.codeAgent?.enabled) {
      return { text: "", error: "code_agent_disabled" };
    }
    if (userId && !isCodeAgentUserAllowed(userId, settings)) {
      return { text: "", blockedByPermission: true };
    }

    const maxParallel = Number(settings?.codeAgent?.maxParallelTasks) || 2;
    if (getActiveCodeAgentTaskCount() >= maxParallel) {
      return { text: "", blockedByParallelLimit: true };
    }

    const maxPerHour = Number(settings?.codeAgent?.maxTasksPerHour) || 10;
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("code_agent_call", since1h);
    if (used >= maxPerHour) {
      return { text: "", blockedByBudget: true };
    }

    const {
      cwd,
      provider,
      model,
      codexModel,
      maxTurns,
      timeoutMs,
      maxBufferBytes
    } = resolveCodeAgentConfig(settings, cwdOverride);

    try {
      const result = await runCodeAgent({
        instruction: task,
        cwd,
        provider,
        maxTurns,
        timeoutMs,
        maxBufferBytes,
        model,
        codexModel,
        openai: this.llm?.openai || null,
        trace: {
          guildId,
          channelId,
          userId,
          source
        },
        store: this.store
      });

      return {
        text: result.text,
        isError: result.isError,
        costUsd: result.costUsd,
        error: result.isError ? result.errorMessage : null
      };
    } catch (error) {
      return {
        text: "",
        error: String(error?.message || error)
      };
    }
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
    if (!settings?.codeAgent?.enabled) return null;
    if (userId && !isCodeAgentUserAllowed(userId, settings)) return null;

    const maxParallel = Number(settings?.codeAgent?.maxParallelTasks) || 2;
    if (getActiveCodeAgentTaskCount() >= maxParallel) return null;

    // Enforce hourly task budget (same check as tryRunCodeAgentTask)
    const maxPerHour = Number(settings?.codeAgent?.maxTasksPerHour) || 10;
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const used = this.store.countActionsSince("code_agent_call", since1h);
    if (used >= maxPerHour) return null;

    const {
      cwd,
      provider,
      model,
      codexModel,
      maxTurns,
      timeoutMs,
      maxBufferBytes
    } = resolveCodeAgentConfig(settings, cwdOverride);

    const scopeKey = `${guildId || "dm"}:${channelId || "dm"}`;
    try {
      return createCodeAgentSessionRuntime({
        scopeKey,
        cwd,
        provider,
        model,
        codexModel,
        maxTurns,
        timeoutMs,
        maxBufferBytes,
        trace: { guildId, channelId, userId, source },
        store: this.store,
        openai: this.llm?.openai || null
      });
    } catch {
      return null;
    }
  }

  createBrowserAgentSession({
    settings,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }) {
    if (!this.browserManager) return null;

    const maxSteps = clamp(Number(settings?.browser?.maxStepsPerTask) || 15, 1, 30);
    const stepTimeoutMs = clamp(Number(settings?.browser?.stepTimeoutMs) || 30_000, 5_000, 120_000);
    const browserLlmProvider = String(settings?.browser?.llm?.provider || "anthropic").trim();
    const browserLlmModel = String(settings?.browser?.llm?.model || "claude-sonnet-4-5-20250929").trim();

    const scopeKey = `${guildId || "dm"}:${channelId || "dm"}`;
    const sessionKey = `session:${scopeKey}:${Date.now()}`;
    return new BrowserAgentSession({
      scopeKey,
      llm: this.llm,
      browserManager: this.browserManager,
      store: this.store,
      sessionKey,
      provider: browserLlmProvider,
      model: browserLlmModel,
      maxSteps,
      stepTimeoutMs,
      trace: { guildId, channelId, userId, source }
    });
  }

  /** Build the subAgentSessions runtime adapter for the reply tool pipeline. */
  buildSubAgentSessionsRuntime() {
    return {
      manager: this.subAgentSessions,
      createCodeSession: (opts) => this.createCodeAgentSession(opts),
      createBrowserSession: (opts) => this.createBrowserAgentSession(opts)
    };
  }

  mergeImageInputs({ baseInputs = [], extraInputs = [], maxInputs = MAX_MODEL_IMAGE_INPUTS } = {}) {
    const merged = [];
    const seen = new Set();
    const pushUnique = (input) => {
      if (!input || typeof input !== "object") return;
      const url = String(input?.url || "").trim();
      const mediaType = String(input?.mediaType || input?.contentType || "").trim().toLowerCase();
      const inlineData = String(input?.dataBase64 || "").trim();
      const key = url
        ? `url:${url}`
        : inlineData
          ? `inline:${mediaType}:${inlineData.slice(0, 80)}`
          : "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(input);
    };

    for (const input of Array.isArray(baseInputs) ? baseInputs : []) {
      if (merged.length >= maxInputs) break;
      pushUnique(input);
    }
    for (const input of Array.isArray(extraInputs) ? extraInputs : []) {
      if (merged.length >= maxInputs) break;
      pushUnique(input);
    }

    return merged.slice(0, maxInputs);
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
    return await loadPromptMemorySliceFromMemory({
      settings,
      memory: this.memory,
      userId,
      guildId,
      channelId,
      queryText,
      trace,
      source,
      onError: ({ error, context }) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: context.guildId,
          channelId: context.channelId,
          userId: context.userId,
          content: `${context.source}: ${String(error?.message || error)}`
        });
      }
    });
  }

  buildMediaMemoryFacts({ userFacts = [], relevantFacts = [], maxItems = 5 } = {}) {
    const merged = [
      ...(Array.isArray(userFacts) ? userFacts : []),
      ...(Array.isArray(relevantFacts) ? relevantFacts : [])
    ];
    const max = clamp(Math.floor(Number(maxItems) || 5), 1, 8);
    return collectMemoryFactHints(merged, max);
  }

  getScopedFallbackFacts({ guildId, channelId = null, limit = 8 }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId || typeof this.store?.getFactsForScope !== "function") return [];

    const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
    const candidateLimit = clamp(boundedLimit * 4, boundedLimit, 120);
    const rows = this.store.getFactsForScope({
      guildId: normalizedGuildId,
      limit: candidateLimit
    });
    if (!rows.length) return [];

    const normalizedChannelId = String(channelId || "").trim();
    if (!normalizedChannelId) return rows.slice(0, boundedLimit);

    const sameChannel = [];
    const noChannel = [];
    const otherChannel = [];
    for (const row of rows) {
      const rowChannelId = String(row?.channel_id || "").trim();
      if (rowChannelId && rowChannelId === normalizedChannelId) {
        sameChannel.push(row);
        continue;
      }
      if (!rowChannelId) {
        noChannel.push(row);
        continue;
      }
      otherChannel.push(row);
    }

    return [...sameChannel, ...noChannel, ...otherChannel].slice(0, boundedLimit);
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
    trace?: MemoryTrace;
    limit?: number;
    fallbackWhenNoMatch?: boolean;
  }) {
    if (!settings?.memory?.enabled || !this.memory?.searchDurableFacts) return [];
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return [];
    const normalizedChannelId = String(channelId || "").trim() || null;
    const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
    const normalizedQuery = String(queryText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    if (!normalizedQuery) {
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    }

    try {
      const results = await this.memory.searchDurableFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        settings,
        trace: {
          ...trace,
          source: trace?.source || "memory_context"
        },
        limit: boundedLimit
      });
      if (results.length || !fallbackWhenNoMatch) return results;
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        content: `memory_context: ${String(error?.message || error)}`,
        metadata: {
          queryText: normalizedQuery.slice(0, 120),
          source: trace?.source || "memory_context"
        }
      });
      return this.getScopedFallbackFacts({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        limit: boundedLimit
      });
    }
  }

  async maybeAttachGeneratedImage({ settings, text, prompt, variant = "simple", trace }) {
    const payload = { content: text };
    const ready = this.isImageGenerationReady(settings, variant);
    if (!ready) {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: false,
        blockedByCapability: true,
        budget: this.getImageBudgetState(settings)
      };
    }

    const budget = this.getImageBudgetState(settings);
    if (!budget.canGenerate) {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: true,
        blockedByCapability: false,
        budget
      };
    }

    try {
      const image = await this.llm.generateImage({
        settings,
        prompt,
        variant,
        trace
      });
      const withImage = this.buildMessagePayloadWithImage(text, image);
      return {
        payload: withImage.payload,
        imageUsed: withImage.imageUsed,
        variant: image.variant || variant,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    } catch {
      return {
        payload,
        imageUsed: false,
        variant: null,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    }
  }

  async maybeAttachGeneratedVideo({ settings, text, prompt, trace }) {
    const payload = { content: text };
    const ready = this.isVideoGenerationReady(settings);
    if (!ready) {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: false,
        blockedByCapability: true,
        budget: this.getVideoGenerationBudgetState(settings)
      };
    }

    const budget = this.getVideoGenerationBudgetState(settings);
    if (!budget.canGenerate) {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: true,
        blockedByCapability: false,
        budget
      };
    }

    try {
      const video = await this.llm.generateVideo({
        settings,
        prompt,
        trace
      });
      const withVideo = this.buildMessagePayloadWithVideo(text, video);
      return {
        payload: withVideo.payload,
        videoUsed: withVideo.videoUsed,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    } catch {
      return {
        payload,
        videoUsed: false,
        blockedByBudget: false,
        blockedByCapability: false,
        budget
      };
    }
  }

  async maybeAttachReplyGif({ settings, text, query, trace }) {
    const payload = { content: text };
    const budget = this.getGifBudgetState(settings);
    const normalizedQuery = normalizeDirectiveText(query, MAX_GIF_QUERY_LEN);

    if (!settings.discovery.allowReplyGifs) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: true,
        budget
      };
    }

    if (!normalizedQuery) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }

    if (!this.gifs?.isConfigured?.()) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: true,
        budget
      };
    }

    if (!budget.canFetch) {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: true,
        blockedByConfiguration: false,
        budget
      };
    }

    try {
      const gif = await this.gifs.pickGif({
        query: normalizedQuery,
        trace
      });
      if (!gif?.url) {
        return {
          payload,
          gifUsed: false,
          blockedByBudget: false,
          blockedByConfiguration: false,
          budget
        };
      }

      const withGif = this.buildMessagePayloadWithGif(text, gif.url);
      return {
        payload: withGif.payload,
        gifUsed: withGif.gifUsed,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    } catch {
      return {
        payload,
        gifUsed: false,
        blockedByBudget: false,
        blockedByConfiguration: false,
        budget
      };
    }
  }

  buildMessagePayloadWithImage(text, image) {
    if (image.imageBuffer) {
      return {
        payload: {
          content: text,
          files: [{ attachment: image.imageBuffer, name: `clanker-${Date.now()}.png` }]
        },
        imageUsed: true
      };
    }

    if (image.imageUrl) {
      const normalizedUrl = String(image.imageUrl || "").trim();
      const trimmedText = String(text || "").trim();
      const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
      return {
        payload: { content },
        imageUsed: true
      };
    }

    return {
      payload: { content: text },
      imageUsed: false
    };
  }

  buildMessagePayloadWithVideo(text, video) {
    const videoUrl = String(video?.videoUrl || "").trim();
    if (!videoUrl) {
      return {
        payload: { content: text },
        videoUsed: false
      };
    }

    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${videoUrl}` : videoUrl;
    return {
      payload: { content },
      videoUsed: true
    };
  }

  buildMessagePayloadWithGif(text, gifUrl) {
    const normalizedUrl = String(gifUrl || "").trim();
    if (!normalizedUrl) {
      return {
        payload: { content: text },
        gifUsed: false
      };
    }

    const trimmedText = String(text || "").trim();
    const content = trimmedText ? `${trimmedText}\n${normalizedUrl}` : normalizedUrl;
    return {
      payload: { content },
      gifUsed: true
    };
  }

  isUserBlocked(settings, userId) {
    const blockedUserIds = Array.isArray(settings?.permissions?.blockedUserIds)
      ? settings.permissions.blockedUserIds
      : [];
    return blockedUserIds.includes(String(userId));
  }

  isChannelAllowed(settings, channelId) {
    const id = String(channelId);
    const blockedChannelIds = Array.isArray(settings?.permissions?.blockedChannelIds)
      ? settings.permissions.blockedChannelIds
      : [];
    const allowedChannelIds = Array.isArray(settings?.permissions?.allowedChannelIds)
      ? settings.permissions.allowedChannelIds
      : [];

    if (blockedChannelIds.includes(id)) {
      return false;
    }

    const allowList = allowedChannelIds;
    if (allowList.length === 0) return true;

    return allowList.includes(id);
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
    const id = String(channelId);
    const replyChannelIds = Array.isArray(settings?.permissions?.replyChannelIds)
      ? settings.permissions.replyChannelIds
      : [];
    if (!replyChannelIds.length) {
      const channel = this.client.channels.cache.get(id);
      if (!channel) return true;
      return this.isNonPrivateReplyEligibleChannel(channel);
    }
    return replyChannelIds.includes(id);
  }

  isDiscoveryChannel(settings, channelId) {
    const id = String(channelId);
    const discoveryChannelIds = Array.isArray(settings?.discovery?.channelIds)
      ? settings.discovery.channelIds
      : [];
    return discoveryChannelIds.includes(id);
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
    if (startupSettings?.memory?.enabled && startupSettings?.memory?.reflection?.enabled) {
      await this.memory.runDailyReflection(startupSettings);
    }
  }

  async maybeRunReflection() {
    const settings = this.store.getSettings();
    if (!settings?.memory?.enabled || !settings?.memory?.reflection?.enabled) return;

    const hour = Number(settings.memory.reflection.hour ?? 4);
    const minute = Number(settings.memory.reflection.minute ?? 0);
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
    const settings = this.store.getSettings();
    if (!settings?.automations?.enabled) return;
    if (this.automationCycleRunning) return;
    this.automationCycleRunning = true;

    try {
      const dueRows = this.store.claimDueAutomations({
        now: new Date().toISOString(),
        limit: MAX_AUTOMATION_RUNS_PER_TICK
      });
      if (!dueRows.length) return;

      for (const row of dueRows) {
        await this.runAutomationJob(row);
      }
    } finally {
      this.automationCycleRunning = false;
    }
  }

  async runAutomationJob(automation) {
    const startedAt = new Date().toISOString();
    const guildId = String(automation?.guild_id || "").trim();
    const channelId = String(automation?.channel_id || "").trim();
    const automationId = Number(automation?.id || 0);
    if (!guildId || !channelId || !Number.isInteger(automationId) || automationId <= 0) return;

    const settings = this.store.getSettings();
    let status = "active";
    let nextRunAt = null;
    let runStatus = "ok";
    let summary = "";
    let errorText = "";
    let sentMessageId = null;
    let retrySoon = false;

    try {
      if (!this.isChannelAllowed(settings, channelId)) {
        runStatus = "error";
        errorText = "channel blocked by current settings";
      } else if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) {
        runStatus = "skipped";
        summary = "hourly message cap hit; retrying soon";
        retrySoon = true;
      } else if (!this.canTalkNow(settings)) {
        runStatus = "skipped";
        summary = "message cooldown active; retrying soon";
        retrySoon = true;
      } else {
        const channel = this.client.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") {
          runStatus = "error";
          errorText = "channel unavailable";
        } else {
          const generationResult = await this.generateAutomationPayload({
            automation,
            settings,
            channel
          });

          if (generationResult.skip) {
            runStatus = "skipped";
            summary = generationResult.summary || "model skipped this run";
          } else {
            await channel.sendTyping();
            await sleep(this.getSimulatedTypingDelayMs(350, 1100));
            const autoChunks = splitDiscordMessage(generationResult.payload.content);
            const autoFirstPayload = { ...generationResult.payload, content: autoChunks[0] };
            const sent = await channel.send(autoFirstPayload);
            for (let i = 1; i < autoChunks.length; i++) {
              await channel.send({ content: autoChunks[i] });
            }
            sentMessageId = sent.id;
            summary = generationResult.summary || "posted";
            this.markSpoke();
            this.store.recordMessage({
              messageId: sent.id,
              createdAt: sent.createdTimestamp,
              guildId: sent.guildId,
              channelId: sent.channelId,
              authorId: this.client.user.id,
              authorName: settings.botName,
              isBot: true,
              content: this.composeMessageContentForHistory(sent, generationResult.text),
              referencedMessageId: null
            });
            this.store.logAction({
              kind: "automation_post",
              guildId: sent.guildId,
              channelId: sent.channelId,
              messageId: sent.id,
              userId: this.client.user.id,
              content: generationResult.text,
              metadata: {
                automationId,
                media: generationResult.media || null,
                llm: generationResult.llm || null
              }
            });
          }
        }
      }
    } catch (error) {
      runStatus = "error";
      errorText = String(error?.message || error);
    }

    if (runStatus === "error") {
      status = "paused";
      nextRunAt = null;
    } else if (retrySoon) {
      nextRunAt = new Date(Date.now() + 5 * 60_000).toISOString();
    } else {
      nextRunAt = resolveFollowingNextRunAt({
        schedule: automation.schedule,
        previousNextRunAt: automation.next_run_at,
        runFinishedMs: Date.now()
      });
      if (!nextRunAt) {
        status = "paused";
      }
    }

    const finishedAt = new Date().toISOString();
    const finalized = this.store.finalizeAutomationRun({
      automationId,
      guildId,
      status,
      nextRunAt,
      lastRunAt: finishedAt,
      lastError: errorText || null,
      lastResult: summary || (runStatus === "error" ? "error" : runStatus)
    });
    this.store.recordAutomationRun({
      automationId,
      startedAt,
      finishedAt,
      status: runStatus,
      summary: summary || null,
      error: errorText || null,
      messageId: sentMessageId,
      metadata: {
        nextRunAt,
        statusAfterRun: finalized?.status || status
      }
    });

    this.store.logAction({
      kind: runStatus === "error" ? "automation_error" : "automation_run",
      guildId,
      channelId,
      messageId: sentMessageId,
      userId: this.client.user?.id || null,
      content:
        runStatus === "error"
          ? `automation #${automationId}: ${errorText || "run failed"}`
          : `automation #${automationId}: ${summary || runStatus}`,
      metadata: {
        automationId,
        runStatus,
        statusAfterRun: finalized?.status || status,
        nextRunAt
      }
    });
  }

  async generateAutomationPayload({ automation, settings, channel }) {
    if (!this.llm?.generate) {
      const fallback = sanitizeBotText(String(automation?.instruction || "scheduled task"), 1200);
      return {
        skip: false,
        summary: fallback.slice(0, 220),
        text: fallback,
        payload: { content: fallback },
        media: null,
        llm: null
      };
    }

    const recentMessages = this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);
    const automationOwnerId = String(automation?.created_by_user_id || "").trim() || null;
    const automationQuery = `${String(automation?.title || "")} ${String(automation?.instruction || "")}`
      .replace(/\s+/g, " ")
      .trim();
    const memorySlice = await this.loadPromptMemorySlice({
      settings,
      userId: automationOwnerId,
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      queryText: automationQuery,
      trace: {
        guildId: automation.guild_id,
        channelId: automation.channel_id,
        userId: automationOwnerId
      },
      source: "automation_run"
    });

    const imageBudget = this.getImageBudgetState(settings);
    const videoBudget = this.getVideoGenerationBudgetState(settings);
    const gifBudget = this.getGifBudgetState(settings);
    const mediaCapabilities = this.getMediaGenerationCapabilities(settings);
    const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
    const automationMediaMemoryFacts = this.buildMediaMemoryFacts({
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts
    });
    const memoryLookup = this.buildMemoryLookupContext({ settings });
    const promptBase = {
      instruction: automation.instruction,
      channelName: channel.name || "channel",
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      allowSimpleImagePosts:
        settings.discovery.allowImagePosts && mediaCapabilities.simpleImageReady && imageBudget.canGenerate,
      allowComplexImagePosts:
        settings.discovery.allowImagePosts && mediaCapabilities.complexImageReady && imageBudget.canGenerate,
      allowVideoPosts:
        settings.discovery.allowVideoPosts && mediaCapabilities.videoReady && videoBudget.canGenerate,
      allowGifs: settings.discovery.allowReplyGifs && this.gifs?.isConfigured?.() && gifBudget.canFetch,
      remainingImages: imageBudget.remaining,
      remainingVideos: videoBudget.remaining,
      remainingGifs: gifBudget.remaining,
      maxMediaPromptChars: mediaPromptLimit,
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    };
    const userPrompt = buildAutomationPrompt({
      ...promptBase,
      memoryLookup,
      allowMemoryLookupDirective: false
    });
    const automationSystemPrompt = buildSystemPrompt(settings);

    const automationTrace = {
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      userId: this.client.user?.id || null,
      source: "automation_run",
      event: `automation:${automation.id}`
    };
    const automationReplyTools = buildReplyToolSet(settings, {
      webSearchAvailable: false,
      browserBrowseAvailable: false,
      memoryAvailable: settings.memory?.enabled,
      adaptiveDirectivesAvailable: false,
      imageLookupAvailable: false,
      openArticleAvailable: false
    });
    const automationToolRuntime: ReplyToolRuntime = {
      search: this.search,
      memory: this.memory,
      store: this.store
    };
    const automationToolContext: ReplyToolContext = {
      settings,
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      userId: this.client.user?.id || "",
      sourceMessageId: `automation:${automation.id}`,
      sourceText: String(automation.instruction || ""),
      botUserId: this.client.user?.id || undefined,
      trace: automationTrace
    };

    let automationContextMessages: Array<{ role: string; content: unknown }> = [];
    let generation = await this.llm.generate({
      settings,
      systemPrompt: automationSystemPrompt,
      userPrompt,
      contextMessages: automationContextMessages,
      jsonSchema: automationReplyTools.length ? "" : REPLY_OUTPUT_JSON_SCHEMA,
      tools: automationReplyTools,
      trace: automationTrace
    });

    const AUTOMATION_TOOL_LOOP_MAX_STEPS = 2;
    const AUTOMATION_TOOL_LOOP_MAX_CALLS = 3;
    let automationToolLoopSteps = 0;
    let automationTotalToolCalls = 0;

    while (
      generation.toolCalls?.length > 0 &&
      automationToolLoopSteps < AUTOMATION_TOOL_LOOP_MAX_STEPS &&
      automationTotalToolCalls < AUTOMATION_TOOL_LOOP_MAX_CALLS
    ) {
      const assistantContent = generation.rawContent || [
        { type: "text", text: generation.text || "" }
      ];
      automationContextMessages = [
        ...automationContextMessages,
        { role: "user", content: userPrompt },
        { role: "assistant", content: assistantContent }
      ];

      const toolResultMessages: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const toolCall of generation.toolCalls) {
        if (automationTotalToolCalls >= AUTOMATION_TOOL_LOOP_MAX_CALLS) break;
        automationTotalToolCalls += 1;

        const result = await executeReplyTool(
          toolCall.name,
          toolCall.input as Record<string, unknown>,
          automationToolRuntime,
          automationToolContext
        );

        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }

      automationContextMessages = [
        ...automationContextMessages,
        { role: "user", content: toolResultMessages }
      ];

      generation = await this.llm.generate({
        settings,
        systemPrompt: automationSystemPrompt,
        userPrompt: "",
        contextMessages: automationContextMessages,
        jsonSchema: "",
        tools: automationReplyTools,
        trace: {
          ...automationTrace,
          event: `automation:${automation.id}:tool_loop:${automationToolLoopSteps + 1}`
        }
      });
      automationToolLoopSteps += 1;
    }

    const directive = parseStructuredReplyOutput(generation.text, mediaPromptLimit);

    let finalText = sanitizeBotText(normalizeSkipSentinel(directive.text || ""), 1200);
    if (!finalText) {
      finalText = sanitizeBotText(String(automation.instruction || "scheduled task"), 1200);
    }

    if (finalText === "[SKIP]") {
      return {
        skip: true,
        summary: "model skipped run",
        text: "",
        payload: null,
        media: null,
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      };
    }

    const mediaDirective = pickReplyMediaDirective(directive);
    let payload = { content: finalText };
    let media = null;

    if (mediaDirective?.type === "gif" && directive.gifQuery) {
      const gifResult = await this.maybeAttachReplyGif({
        settings,
        text: finalText,
        query: directive.gifQuery,
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = gifResult.payload;
      if (gifResult.gifUsed) media = { type: "gif" };
    }

    if (mediaDirective?.type === "image_simple" && directive.imagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          directive.imagePrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        variant: "simple",
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = imageResult.payload;
      if (imageResult.imageUsed) media = { type: "image_simple" };
    }

    if (mediaDirective?.type === "image_complex" && directive.complexImagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          directive.complexImagePrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        variant: "complex",
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = imageResult.payload;
      if (imageResult.imageUsed) media = { type: "image_complex" };
    }

    if (mediaDirective?.type === "video" && directive.videoPrompt) {
      const videoResult = await this.maybeAttachGeneratedVideo({
        settings,
        text: finalText,
        prompt: composeReplyVideoPrompt(
          directive.videoPrompt,
          finalText,
          mediaPromptLimit,
          automationMediaMemoryFacts
        ),
        trace: {
          guildId: automation.guild_id,
          channelId: automation.channel_id,
          userId: this.client.user?.id || null,
          source: "automation_run"
        }
      });
      payload = videoResult.payload;
      if (videoResult.videoUsed) media = { type: "video" };
    }

    return {
      skip: false,
      summary: finalText.slice(0, 220),
      text: finalText,
      payload,
      media,
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd
      }
    };
  }

  getStartupScanChannels(settings) {
    const channels = [];
    const seen = new Set();

    const explicit = [
      ...settings.permissions.replyChannelIds,
      ...settings.discovery.channelIds,
      ...settings.permissions.allowedChannelIds
    ];

    for (const id of explicit) {
      const channel = this.client.channels.cache.get(String(id));
      if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      channels.push(channel);
    }

    if (channels.length) return channels;

    for (const guild of this.client.guilds.cache.values()) {
      const guildChannels = guild.channels.cache
        .filter((channel) => channel.isTextBased?.() && typeof channel.send === "function")
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
    if (this.textThoughtLoopRunning) return;
    this.textThoughtLoopRunning = true;

    try {
      const settings = this.store.getSettings();
      if (!settings.textThoughtLoop?.enabled) return;
      if (settings.textThoughtLoop.maxThoughtsPerDay <= 0) return;
      if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
      if (!this.canTalkNow(settings)) return;

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const thoughts24h = this.store.countActionsSince("text_thought_loop_post", since24h);
      if (thoughts24h >= settings.textThoughtLoop.maxThoughtsPerDay) return;

      const lastThoughtAt = this.store.getLastActionTime("text_thought_loop_post");
      const lastThoughtTs = lastThoughtAt ? new Date(lastThoughtAt).getTime() : 0;
      const minGapMs = Math.max(
        1,
        Number(settings.textThoughtLoop.minMinutesBetweenThoughts || 0) * 60_000
      );
      if (lastThoughtTs && Date.now() - lastThoughtTs < minGapMs) return;

      const candidate = await this.pickTextThoughtLoopCandidate(settings);
      if (!candidate) return;

      const sent = await this.maybeReplyToMessage(candidate.message, settings, {
        source: "text_thought_loop",
        recentMessages: candidate.recentMessages,
        addressSignal: {
          direct: false,
          inferred: false,
          triggered: false,
          reason: "llm_decides",
          confidence: 0,
          threshold: 0.62,
          confidenceSource: "fallback"
        },
        forceDecisionLoop: true
      });
      if (!sent) return;

      this.store.logAction({
        kind: "text_thought_loop_post",
        guildId: candidate.message.guildId,
        channelId: candidate.message.channelId,
        messageId: candidate.message.id,
        userId: this.client.user?.id || null,
        content: candidate.message.content,
        metadata: {
          lookbackMessages: settings.textThoughtLoop.lookbackMessages,
          source: "text_thought_loop"
        }
      });
    } finally {
      this.textThoughtLoopRunning = false;
    }
  }

  async pickTextThoughtLoopCandidate(settings) {
    const replyChannelIds = [...new Set(
      (Array.isArray(settings?.permissions?.replyChannelIds) ? settings.permissions.replyChannelIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )];
    const candidateIds = replyChannelIds.length
      ? replyChannelIds
      : [...new Set(
        this.client.channels.cache
          .filter((channel) => this.isNonPrivateReplyEligibleChannel(channel))
          .map((channel) => String(channel.id || "").trim())
          .filter(Boolean)
      )];
    if (!candidateIds.length) return null;

    const shuffled = candidateIds
      .map((id) => ({ id, sortKey: Math.random() }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((entry) => entry.id);

    const lookback = clamp(Number(settings.textThoughtLoop.lookbackMessages) || 0, 4, 80);
    for (const channelId of shuffled) {
      if (!this.isChannelAllowed(settings, channelId)) continue;
      const channel = this.client.channels.cache.get(channelId);
      if (!this.isNonPrivateReplyEligibleChannel(channel)) continue;

      await this.hydrateRecentMessages(channel, lookback);
      const recentMessages = this.store.getRecentMessages(channel.id, lookback);
      if (!recentMessages.length) continue;
      if (this.hasBotMessageInRecentWindow({ recentMessages, windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW })) {
        continue;
      }

      const latestHuman = this.getLatestRecentHumanMessage(recentMessages);
      if (!latestHuman) continue;
      if (!this.isRecentHumanActivity(latestHuman)) {
        continue;
      }

      return {
        channel,
        recentMessages,
        message: this.buildStoredMessageRuntime(channel, latestHuman)
      };
    }

    return null;
  }

  buildStoredMessageRuntime(channel, row) {
    const guild = channel.guild;
    const guildId = String(row?.guild_id || channel.guildId || guild?.id || "").trim();
    const channelId = String(row?.channel_id || channel.id || "").trim();
    const messageId = String(row?.message_id || "").trim() || `stored-${Date.now()}`;
    const authorId = String(row?.author_id || "unknown").trim();
    const authorName = String(row?.author_name || "unknown").trim() || "unknown";
    const content = String(row?.content || "").trim();
    const createdAtMs = Date.parse(String(row?.created_at || ""));

    return {
      id: messageId,
      createdTimestamp: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      guildId,
      channelId,
      guild,
      channel,
      author: {
        id: authorId,
        username: authorName,
        bot: Boolean(row?.is_bot)
      },
      member: {
        displayName: authorName
      },
      content,
      mentions: {
        users: {
          has() {
            return false;
          }
        },
        repliedUser: null
      },
      reference: null,
      attachments: new Map(),
      embeds: [],
      reactions: {
        cache: new Map()
      },
      async react() {
        return undefined;
      },
      async reply(payload) {
        return await channel.send({
          ...payload,
          allowedMentions: { repliedUser: false }
        });
      }
    };
  }

  getLatestRecentHumanMessage(rows = []) {
    return (Array.isArray(rows) ? rows : []).find((row) => !row?.is_bot) || null;
  }

  isRecentHumanActivity(row, { maxAgeMs = PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS } = {}) {
    if (!row || row.is_bot) return false;
    const createdAtMs = Date.parse(String(row.created_at || ""));
    if (!Number.isFinite(createdAtMs)) return false;
    return Date.now() - createdAtMs <= Math.max(60_000, Number(maxAgeMs) || PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS);
  }

  async maybeRunDiscoveryCycle({ startup = false } = {}) {
    if (this.discoveryPosting) return;
    this.discoveryPosting = true;

    try {
      const settings = this.store.getSettings();
      if (!settings.discovery?.enabled) return;
      if (!settings.discovery.channelIds.length) return;
      if (settings.discovery.maxPostsPerDay <= 0) return;
      if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
      if (!this.canTalkNow(settings)) return;

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const posts24h = this.store.countActionsSince("discovery_post", since24h);
      if (posts24h >= settings.discovery.maxPostsPerDay) return;

      const lastPostAt = this.store.getLastActionTime("discovery_post");
      const lastPostTs = lastPostAt ? new Date(lastPostAt).getTime() : 0;
      const nowTs = Date.now();
      const elapsedMs = lastPostTs ? nowTs - lastPostTs : null;
      const scheduleDecision = this.evaluateDiscoverySchedule({
        settings,
        startup,
        lastPostTs,
        elapsedMs,
        posts24h
      });
      if (!scheduleDecision.shouldPost) return;

      const channel = this.pickDiscoveryChannel(settings);
      if (!channel) return;

      const recent = await this.hydrateRecentMessages(channel, settings.memory.maxRecentMessages);
      const recentMessages = recent.length
        ? recent
          .slice()
          .reverse()
          .slice(0, settings.memory.maxRecentMessages)
          .map((msg) => ({
            author_name: msg.member?.displayName || msg.author?.username || "unknown",
            content: String(msg.content || "").trim(),
            created_at: new Date(msg.createdTimestamp).toISOString(),
            is_bot: Boolean(msg.author?.bot)
          }))
        : this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);
      const discoveryMemoryQuery = recentMessages
        .slice(0, 6)
        .map((row) => String(row?.content || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320);
      const discoveryRelevantFacts = await this.loadRelevantMemoryFacts({
        settings,
        guildId: channel.guildId,
        channelId: channel.id,
        queryText: discoveryMemoryQuery,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id,
          source: "discovery_prompt"
        },
        limit: 8
      });
      const discoveryMediaMemoryFacts = this.buildMediaMemoryFacts({
        userFacts: [],
        relevantFacts: discoveryRelevantFacts
      });

      const discoveryResult = await this.collectDiscoveryForPost({
        settings,
        channel,
        recentMessages
      });
      const requireDiscoveryLink =
        discoveryResult.enabled &&
        discoveryResult.candidates.length > 0 &&
        chance((settings.discovery?.linkChancePercent || 0) / 100);
      const discoveryImageBudget = this.getImageBudgetState(settings);
      const discoveryVideoBudget = this.getVideoGenerationBudgetState(settings);
      const discoveryMediaCapabilities = this.getMediaGenerationCapabilities(settings);
      const discoverySimpleImageCapabilityReady = discoveryMediaCapabilities.simpleImageReady;
      const discoveryComplexImageCapabilityReady = discoveryMediaCapabilities.complexImageReady;
      const discoveryImageCapabilityReady =
        discoverySimpleImageCapabilityReady || discoveryComplexImageCapabilityReady;
      const discoveryVideoCapabilityReady = discoveryMediaCapabilities.videoReady;

      const systemPrompt = buildSystemPrompt(settings);
      const userPrompt = buildDiscoveryPrompt({
        channelName: channel.name || "channel",
        recentMessages,
        relevantFacts: discoveryRelevantFacts,
        emojiHints: this.getEmojiHints(channel.guild),
        allowSimpleImagePosts:
          settings.discovery.allowImagePosts &&
          discoverySimpleImageCapabilityReady &&
          discoveryImageBudget.canGenerate,
        allowComplexImagePosts:
          settings.discovery.allowImagePosts &&
          discoveryComplexImageCapabilityReady &&
          discoveryImageBudget.canGenerate,
        remainingDiscoveryImages: discoveryImageBudget.remaining,
        allowVideoPosts:
          settings.discovery.allowVideoPosts &&
          discoveryVideoCapabilityReady &&
          discoveryVideoBudget.canGenerate,
        remainingDiscoveryVideos: discoveryVideoBudget.remaining,
        discoveryFindings: discoveryResult.candidates,
        maxLinksPerPost: settings.discovery?.maxLinksPerPost || 2,
        requireDiscoveryLink,
        maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
        mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
      });

      const generation = await this.llm.generate({
        settings,
        systemPrompt,
        userPrompt,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id
        }
      });

      const discoveryMediaPromptLimit = resolveMaxMediaPromptLen(settings);
      const discoveryDirective = parseDiscoveryMediaDirective(generation.text, discoveryMediaPromptLimit);
      const imagePrompt = discoveryDirective.imagePrompt;
      const complexImagePrompt = discoveryDirective.complexImagePrompt;
      const videoPrompt = discoveryDirective.videoPrompt;
      const mediaDirective = pickDiscoveryMediaDirective(discoveryDirective);
      let finalText = sanitizeBotText(discoveryDirective.text || (mediaDirective ? "" : generation.text));
      finalText = normalizeSkipSentinel(finalText);
      const allowMediaOnlyDiscovery = !finalText && Boolean(mediaDirective);
      if (finalText === "[SKIP]") return;
      if (!finalText && !allowMediaOnlyDiscovery) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "discovery_model_output_empty",
          metadata: {
            source: startup ? "discovery_startup" : "discovery_scheduler"
          }
        });
        return;
      }
      const linkPolicy = this.applyDiscoveryLinkPolicy({
        text: finalText,
        candidates: discoveryResult.candidates,
        selected: discoveryResult.selected,
        requireDiscoveryLink
      });
      finalText = normalizeSkipSentinel(linkPolicy.text);
      const allowMediaOnlyAfterLinkPolicy = !finalText && Boolean(mediaDirective);
      if (finalText === "[SKIP]") return;
      if (!finalText && !allowMediaOnlyAfterLinkPolicy) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "discovery_model_output_empty_after_link_policy",
          metadata: {
            source: startup ? "discovery_startup" : "discovery_scheduler",
            forcedLink: Boolean(linkPolicy.forcedLink)
          }
        });
        return;
      }
      const mentionResolution = await resolveDeterministicMentionsForMentions(
        { store: this.store },
        {
          text: finalText,
          guild: channel.guild,
          guildId: channel.guildId
        }
      );
      finalText = mentionResolution.text;

      let payload = { content: finalText };
      let imageUsed = false;
      let imageBudgetBlocked = false;
      let imageCapabilityBlocked = false;
      let imageVariantUsed = null;
      let videoUsed = false;
      let videoBudgetBlocked = false;
      let videoCapabilityBlocked = false;
      if (mediaDirective?.type === "image_simple" && settings.discovery.allowImagePosts && imagePrompt) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeDiscoveryImagePrompt(
            imagePrompt,
            finalText,
            discoveryMediaPromptLimit,
            discoveryMediaMemoryFacts
          ),
          variant: "simple",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "discovery_post"
          }
        });
        payload = imageResult.payload;
        imageUsed = imageResult.imageUsed;
        imageBudgetBlocked = imageResult.blockedByBudget;
        imageCapabilityBlocked = imageResult.blockedByCapability;
        imageVariantUsed = imageResult.variant || "simple";
      }

      if (
        mediaDirective?.type === "image_complex" &&
        settings.discovery.allowImagePosts &&
        complexImagePrompt
      ) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeDiscoveryImagePrompt(
            complexImagePrompt,
            finalText,
            discoveryMediaPromptLimit,
            discoveryMediaMemoryFacts
          ),
          variant: "complex",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "discovery_post"
          }
        });
        payload = imageResult.payload;
        imageUsed = imageResult.imageUsed;
        imageBudgetBlocked = imageResult.blockedByBudget;
        imageCapabilityBlocked = imageResult.blockedByCapability;
        imageVariantUsed = imageResult.variant || "complex";
      }

      if (mediaDirective?.type === "video" && settings.discovery.allowVideoPosts && videoPrompt) {
        const videoResult = await this.maybeAttachGeneratedVideo({
          settings,
          text: finalText,
          prompt: composeDiscoveryVideoPrompt(
            videoPrompt,
            finalText,
            discoveryMediaPromptLimit,
            discoveryMediaMemoryFacts
          ),
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "discovery_post"
          }
        });
        payload = videoResult.payload;
        videoUsed = videoResult.videoUsed;
        videoBudgetBlocked = videoResult.blockedByBudget;
        videoCapabilityBlocked = videoResult.blockedByCapability;
      }

      if (!finalText && !imageUsed && !videoUsed) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "discovery_model_output_empty_after_media",
          metadata: {
            source: startup ? "discovery_startup" : "discovery_scheduler"
          }
        });
        return;
      }

      await channel.sendTyping();
      await sleep(this.getSimulatedTypingDelayMs(500, 1200));

      const discoveryChunks = splitDiscordMessage(payload.content);
      const discoveryFirstPayload = { ...payload, content: discoveryChunks[0] };
      const sent = await channel.send(discoveryFirstPayload);
      for (let i = 1; i < discoveryChunks.length; i++) {
        await channel.send({ content: discoveryChunks[i] });
      }

      this.markSpoke();
      this.store.recordMessage({
        messageId: sent.id,
        createdAt: sent.createdTimestamp,
        guildId: sent.guildId,
        channelId: sent.channelId,
        authorId: this.client.user.id,
        authorName: settings.botName,
        isBot: true,
        content: this.composeMessageContentForHistory(sent, finalText),
        referencedMessageId: null
      });
      for (const sharedLink of linkPolicy.usedLinks) {
        this.store.recordSharedLink({
          url: sharedLink.url,
          source: sharedLink.source
        });
      }

      this.store.logAction({
        kind: "discovery_post",
        guildId: sent.guildId,
        channelId: sent.channelId,
        messageId: sent.id,
        userId: this.client.user.id,
        content: finalText,
        metadata: {
          source: startup ? "discovery_startup" : "discovery_scheduler",
          pacing: {
            mode: scheduleDecision.mode,
            trigger: scheduleDecision.trigger,
            chance: "chance" in scheduleDecision ? scheduleDecision.chance ?? null : null,
            roll: "roll" in scheduleDecision ? scheduleDecision.roll ?? null : null,
            elapsedMs: scheduleDecision.elapsedMs ?? null,
            requiredIntervalMs: scheduleDecision.requiredIntervalMs ?? null
          },
          discovery: {
            enabled: discoveryResult.enabled,
            requiredLink: requireDiscoveryLink,
            topics: discoveryResult.topics,
            candidateCount: discoveryResult.candidates.length,
            selectedCount: discoveryResult.selected.length,
            usedLinks: linkPolicy.usedLinks,
            forcedLink: linkPolicy.forcedLink,
            reports: discoveryResult.reports,
            errors: discoveryResult.errors
          },
          mentions: mentionResolution,
          imageRequestedByModel: Boolean(imagePrompt || complexImagePrompt),
          imageRequestedSimpleByModel: Boolean(imagePrompt),
          imageRequestedComplexByModel: Boolean(complexImagePrompt),
          imageUsed,
          imageVariantUsed,
          imageBudgetBlocked,
          imageCapabilityBlocked,
          imageSimpleCapabilityReadyAtPromptTime: discoverySimpleImageCapabilityReady,
          imageComplexCapabilityReadyAtPromptTime: discoveryComplexImageCapabilityReady,
          imageCapabilityReadyAtPromptTime: discoveryImageCapabilityReady,
          videoRequestedByModel: Boolean(videoPrompt),
          videoUsed,
          videoBudgetBlocked,
          videoCapabilityBlocked,
          videoCapabilityReadyAtPromptTime: discoveryVideoCapabilityReady,
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
    } finally {
      this.discoveryPosting = false;
    }
  }

  async collectDiscoveryForPost({ settings, channel, recentMessages }) {
    if (!this.discovery) {
      return {
        enabled: false,
        topics: [],
        candidates: [],
        selected: [],
        reports: [],
        errors: []
      };
    }

    try {
      return await this.discovery.collect({
        settings,
        guildId: channel.guildId,
        channelId: channel.id,
        channelName: channel.name || "channel",
        recentMessages
      });
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: channel.guildId,
        channelId: channel.id,
        userId: this.client.user?.id || null,
        content: `discovery_collect: ${String(error?.message || error)}`
      });

      return {
        enabled: true,
        topics: [],
        candidates: [],
        selected: [],
        reports: [],
        errors: [String(error?.message || error)]
      };
    }
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
    const cleanText = sanitizeBotText(text);
    const candidateEntries: Array<[string, DiscoveryLinkCandidate]> = [];
    for (const item of candidates || []) {
      const normalizedUrl = normalizeDiscoveryUrl(item.url);
      if (!normalizedUrl) continue;
      candidateEntries.push([normalizedUrl, item]);
    }
    const candidateMap = new Map<string, DiscoveryLinkCandidate>(candidateEntries);
    const mentionedUrls = extractUrlsFromText(cleanText);
    const matchedLinks = mentionedUrls
      .map((url) => normalizeDiscoveryUrl(url))
      .filter(Boolean)
      .filter((url, index, arr) => arr.indexOf(url) === index)
      .map((url) => ({
        url,
        source: candidateMap.get(url)?.source || "discovery"
      }));

    if (matchedLinks.length || !requireDiscoveryLink) {
      return {
        text: cleanText,
        usedLinks: matchedLinks,
        forcedLink: false
      };
    }

    const fallbackPool = [...(selected || []), ...(candidates || [])];
    const fallback = fallbackPool.find((item) => normalizeDiscoveryUrl(item.url));
    if (!fallback) {
      return {
        text: "[SKIP]",
        usedLinks: [],
        forcedLink: false
      };
    }

    const fallbackUrl = normalizeDiscoveryUrl(fallback.url);
    const withForcedLink = sanitizeBotText(`${cleanText}\n${fallbackUrl}`);
    return {
      text: withForcedLink,
      usedLinks: [
        {
          url: fallbackUrl,
          source: fallback.source || "discovery"
        }
      ],
      forcedLink: true
    };
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
    const images = [];

    for (const attachment of message.attachments.values()) {
      if (images.length >= MAX_IMAGE_INPUTS) break;

      const url = String(attachment.url || attachment.proxyURL || "").trim();
      if (!url) continue;

      const filename = String(attachment.name || "").trim();
      const contentType = String(attachment.contentType || "").toLowerCase();
      const urlPath = url.split("?")[0];
      const isImage = contentType.startsWith("image/") || IMAGE_EXT_RE.test(filename) || IMAGE_EXT_RE.test(urlPath);
      if (!isImage) continue;

      images.push({ url, filename, contentType });
    }

    return images;
  }

  async syncMessageSnapshotFromReaction(reaction) {
    if (!reaction) return;

    let resolved = reaction;
    if (resolved.partial && typeof resolved.fetch === "function") {
      try {
        resolved = await resolved.fetch();
      } catch {
        return;
      }
    }

    await this.syncMessageSnapshot(resolved?.message);
  }

  async syncMessageSnapshot(message) {
    if (!message) return;

    let resolved = message;
    if (resolved.partial && typeof resolved.fetch === "function") {
      try {
        resolved = await resolved.fetch();
      } catch {
        return;
      }
    }

    if (!resolved?.guildId || !resolved?.channelId || !resolved?.id || !resolved?.author?.id) return;

    this.store.recordMessage({
      messageId: resolved.id,
      createdAt: resolved.createdTimestamp,
      guildId: resolved.guildId,
      channelId: resolved.channelId,
      authorId: resolved.author.id,
      authorName: resolved.member?.displayName || resolved.author.username || "unknown",
      isBot: Boolean(resolved.author.bot),
      content: this.composeMessageContentForHistory(resolved, String(resolved.content || "").trim()),
      referencedMessageId: resolved.reference?.messageId
    });
  }

  composeMessageContentForHistory(message, baseText = "") {
    const parts = [];
    const text = String(baseText || "").trim();
    if (text) parts.push(text);

    if (message?.attachments?.size) {
      for (const attachment of message.attachments.values()) {
        const url = String(attachment.url || attachment.proxyURL || "").trim();
        if (!url) continue;
        parts.push(url);
      }
    }

    if (Array.isArray(message?.embeds) && message.embeds.length) {
      for (const embed of message.embeds) {
        const videoUrl = String(embed?.video?.url || embed?.video?.proxyURL || "").trim();
        const embedUrl = String(embed?.url || "").trim();
        if (videoUrl) parts.push(videoUrl);
        if (embedUrl) parts.push(embedUrl);
      }
    }

    const reactionSummary = formatReactionSummary(message);
    if (reactionSummary) {
      parts.push(`[reactions: ${reactionSummary}]`);
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
}

function safeUrlHost(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}

function isLikelyImageUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (IMAGE_EXT_RE.test(pathname) || pathname.endsWith(".avif")) return true;
    const formatParam = String(parsed.searchParams.get("format") || "").trim().toLowerCase();
    if (formatParam && /^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/.test(formatParam)) return true;
    return false;
  } catch {
    return false;
  }
}

function parseHistoryImageReference(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return { filename: "(unnamed)", contentType: "" };
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "");
    const segment = pathname.split("/").pop() || "";
    const decoded = decodeURIComponent(segment || "");
    const fallback = decoded || segment || "(unnamed)";
    const ext = fallback.includes(".") ? fallback.split(".").pop() : "";
    let contentType = normalizeImageContentTypeFromExt(ext);
    if (!contentType) {
      const formatParam = String(parsed.searchParams.get("format") || "").trim().toLowerCase();
      contentType = normalizeImageContentTypeFromExt(formatParam);
    }
    return {
      filename: fallback,
      contentType
    };
  } catch {
    return { filename: "(unnamed)", contentType: "" };
  }
}

function normalizeImageContentTypeFromExt(rawExt) {
  const ext = String(rawExt || "").trim().toLowerCase().replace(/^\./, "");
  if (!ext) return "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "avif") return "image/avif";
  return "";
}
