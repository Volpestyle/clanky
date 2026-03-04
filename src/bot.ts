import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes
} from "discord.js";
import { clankCommand } from "./commands/clankCommand.ts";
import { browseCommand } from "./commands/browseCommand.ts";
import { runBrowseAgent } from "./agents/browseAgent.ts";
import { musicCommands } from "./voice/musicCommands.ts";
import {
  buildAutomationPrompt,
  buildInitiativePrompt,
  buildReplyPrompt,
  buildSystemPrompt
} from "./prompts.ts";
import { getMediaPromptCraftGuidance } from "./promptCore.ts";
import {
  MAX_GIF_QUERY_LEN,
  MAX_IMAGE_LOOKUP_QUERY_LEN,
  MAX_VIDEO_FALLBACK_MESSAGES,
  MAX_VIDEO_TARGET_SCAN,
  collectMemoryFactHints,
  composeInitiativeImagePrompt,
  composeInitiativeVideoPrompt,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  embedWebSearchSources,
  emptyMentionResolution,
  extractRecentVideoTargets,
  extractUrlsFromText,
  formatReactionSummary,
  isWebSearchOptOutText,
  looksLikeVideoFollowupMessage,
  normalizeDirectiveText,
  normalizeReactionEmojiToken,
  normalizeSkipSentinel,
  parseInitiativeMediaDirective,
  parseStructuredReplyOutput,
  pickInitiativeMediaDirective,
  pickReplyMediaDirective,
  REPLY_OUTPUT_JSON_SCHEMA,
  resolveMaxMediaPromptLen,
  splitDiscordMessage
} from "./botHelpers.ts";
import {
  getLocalTimeZoneLabel,
  resolveFollowingNextRunAt
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
  evaluateInitiativeSchedule,
  evaluateSpontaneousInitiativeSchedule,
  getInitiativeAverageIntervalMs,
  getInitiativeMinGapMs,
  getInitiativePacingMode,
  getInitiativePostingIntervalMs,
  pickInitiativeChannel
} from "./bot/initiativeSchedule.ts";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";
import type { BrowserManager } from "./services/BrowserManager.ts";
import {
  resolveOperationalChannel,
  sendToChannel
} from "./voice/voiceOperationalMessaging.ts";
import { loadPromptMemorySliceFromMemory } from "./memory/promptMemorySlice.ts";

const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
const REPLY_QUEUE_MAX_PER_CHANNEL = 60;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const STARTUP_TASK_DELAY_MS = 4500;
const INITIATIVE_TICK_MS = 60_000;
const AUTOMATION_TICK_MS = 30_000;
const GATEWAY_WATCHDOG_TICK_MS = 30_000;
const MAX_MODEL_IMAGE_INPUTS = 8;
const MAX_HISTORY_IMAGE_CANDIDATES = 24;
const MAX_HISTORY_IMAGE_LOOKUP_RESULTS = 6;
const MAX_IMAGE_LOOKUP_QUERY_TOKENS = 7;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;
const MAX_AUTOMATION_RUNS_PER_TICK = 4;
const SCREEN_SHARE_MESSAGE_MAX_CHARS = 420;
const SCREEN_SHARE_INTENT_THRESHOLD = 0.66;
const REPLY_PERFORMANCE_VERSION = 1;
const LOOKUP_CONTEXT_PROMPT_LIMIT = 4;
const LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS = 72;
const LOOKUP_CONTEXT_TTL_HOURS = 48;
const LOOKUP_CONTEXT_MAX_RESULTS = 5;
const LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL = 120;
const IS_TEST_PROCESS = /\.test\.[cm]?[jt]sx?$/i.test(String(process.argv?.[1] || "")) ||
  process.execArgv.includes("--test") ||
  process.argv.includes("--test");
const SCREEN_SHARE_EXPLICIT_REQUEST_RE =
  /\b(?:screen\s*share|share\s*(?:my|the)?\s*screen|watch\s*(?:my|the)?\s*screen|see\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*stream|watch\s*(?:my|the)?\s*stream)\b/i;
type ReplyPerformanceSeed = {
  triggerMessageCreatedAtMs?: number | null;
  queuedAtMs?: number | null;
  ingestMs?: number | null;
};

type ReplyPerformanceTracker = {
  source: string;
  startedAtMs: number;
  triggerMessageCreatedAtMs: number | null;
  queuedAtMs: number | null;
  ingestMs: number | null;
  memorySliceMs: number | null;
  llm1Ms: number | null;
  followupMs: number | null;
};

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

type ReplyPromptCapture = {
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
};

type LoggedReplyPrompts = {
  hiddenByDefault: true;
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  followupSteps: number;
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
  initiativeTimer;
  automationTimer;
  gatewayWatchdogTimer;
  reconnectTimeout;
  startupTasksRan;
  startupTimeout;
  initiativePosting;
  automationCycleRunning;
  reconnectInFlight;
  isStopping;
  hasConnectedAtLeastOnce;
  lastGatewayEventAt;
  reconnectAttempts;
  replyQueues;
  replyQueueWorkers;
  replyQueuedMessageIds: Set<string>;
  screenShareSessionManager: any;
  client: any;
  voiceSessionManager: VoiceSessionManager;
  browserManager: BrowserManager | null;

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
    this.initiativePosting = false;
    this.automationCycleRunning = false;
    this.reconnectInFlight = false;
    this.isStopping = false;
    this.hasConnectedAtLeastOnce = false;
    this.lastGatewayEventAt = Date.now();
    this.reconnectAttempts = 0;
    this.replyQueues = new Map();
    this.replyQueueWorkers = new Set();
    this.replyQueuedMessageIds = new Set();
    this.screenShareSessionManager = null;

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
      generateVoiceTurn: (payload) => this.generateVoiceTurnReply(payload)
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
        await rest.put(Routes.applicationCommands(this.client.user?.id || ""), { body: [...musicCommands, clankCommand, browseCommand] });
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
        const task = interaction.options.getString("task", true);

        if (!this.browserManager) {
          await interaction.editReply("Browser agent is currently unavailable on this server.");
          return;
        }

        try {
          const settings = this.store.getSettings();
          const maxSteps = Math.max(1, Math.min(30, Number(settings?.browser?.maxStepsPerTask) || 15));
          const stepTimeoutMs = Math.max(5000, Math.min(120000, Number(settings?.browser?.stepTimeoutMs) || 30000));

          const result = await runBrowseAgent({
            llm: this.llm,
            browserManager: this.browserManager,
            store: this.store,
            sessionKey: interaction.guildId || interaction.channelId || interaction.id,
            instruction: task,
            maxSteps,
            stepTimeoutMs,
            trace: {
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              userId: interaction.user.id,
              source: "slash_command_browse"
            }
          });

          this.store.logAction({
            kind: "browser_browse_call",
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            content: task.slice(0, 200),
            metadata: {
              steps: result.steps,
              hitStepLimit: result.hitStepLimit,
              totalCostUsd: result.totalCostUsd,
              source: "slash_command_browse"
            },
            usdCost: result.totalCostUsd
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
          await interaction.editReply(`An error occurred while browsing: ${message}`);
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

    this.initiativeTimer = setInterval(() => {
      this.maybeRunInitiativeCycle().catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          content: `initiative_cycle: ${String(error?.message || error)}`
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
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.gatewayWatchdogTimer = null;
    this.automationTimer = null;
    this.reconnectTimeout = null;
    this.startupTimeout = null;
    this.replyQueues.clear();
    this.replyQueueWorkers.clear();
    this.replyQueuedMessageIds.clear();
    if (this.memory?.drainIngestQueue) {
      await this.memory.drainIngestQueue({ timeoutMs: 4000 }).catch(() => undefined);
    }
    if (this.browserManager?.closeAll) {
      await this.browserManager.closeAll().catch(() => undefined);
    }
    await this.voiceSessionManager.dispose("shutdown");
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
    const isInitiativeChannel = this.isInitiativeChannel(settings, message.channelId);

    const shouldQueueReply = this.shouldAttemptReplyDecision({
      settings,
      recentMessages,
      addressSignal,
      isInitiativeChannel,
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

  shouldSendAsReply({ isInitiativeChannel = false, shouldThreadReply = false, replyText = "" } = {}) {
    if (!shouldThreadReply) return false;
    const textLength = String(replyText || "").trim().length;
    const isShortReply = textLength > 0 && textLength <= 30;
    if (isShortReply) return chance(0.25);
    if (!isInitiativeChannel) return chance(0.82);
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
    if (!settings.permissions.allowReplies) return false;
    if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return false;
    if (!this.canTalkNow(settings)) return false;

    const recentMessages = Array.isArray(options.recentMessages)
      ? options.recentMessages
      : this.store.getRecentMessages(message.channelId, settings.memory.maxRecentMessages);
    const addressSignal =
      options.addressSignal || await this.getReplyAddressSignal(settings, message, recentMessages);
    const triggerMessageIds = [
      ...new Set(
        [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ];
    const addressed = addressSignal.triggered;
    const reactionEagerness = clamp(Number(settings.activity?.reactionLevel) || 0, 0, 100);
    const isInitiativeChannel = this.isInitiativeChannel(settings, message.channelId);
    const replyEagerness = clamp(
      Number(
        isInitiativeChannel
          ? settings.activity?.replyLevelInitiative
          : settings.activity?.replyLevelNonInitiative
      ) || 0,
      0,
      100
    );
    const reactionEmojiOptions = [
      ...new Set([...this.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS])
    ];

    const shouldRunDecisionLoop = this.shouldAttemptReplyDecision({
      settings,
      recentMessages,
      addressSignal,
      isInitiativeChannel,
      forceRespond: Boolean(options.forceRespond),
      triggerMessageId: message.id
    });
    if (!shouldRunDecisionLoop) return false;

    const source = String(options.source || "message_event");
    const performance = createReplyPerformanceTracker({
      messageCreatedAtMs: message?.createdTimestamp,
      source,
      seed: options.performanceSeed
    });

    const memorySliceStartedAtMs = Date.now();
    const memorySlice = await this.loadPromptMemorySlice({
      settings,
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      queryText: message.content,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id
      },
      source
    });
    performance.memorySliceMs = Math.max(0, Date.now() - memorySliceStartedAtMs);
    const replyMediaMemoryFacts = this.buildMediaMemoryFacts({
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts
    });
    const attachmentImageInputs = this.getImageInputs(message);
    const imageBudget = this.getImageBudgetState(settings);
    const videoBudget = this.getVideoGenerationBudgetState(settings);
    const mediaCapabilities = this.getMediaGenerationCapabilities(settings);
    const simpleImageCapabilityReady = mediaCapabilities.simpleImageReady;
    const complexImageCapabilityReady = mediaCapabilities.complexImageReady;
    const imageCapabilityReady = simpleImageCapabilityReady || complexImageCapabilityReady;
    const videoCapabilityReady = mediaCapabilities.videoReady;
    const gifBudget = this.getGifBudgetState(settings);
    const gifsConfigured = Boolean(this.gifs?.isConfigured?.());
    let webSearch = this.buildWebSearchContext(settings, message.content);
    const recentWebLookups = this.getRecentLookupContextForPrompt({
      guildId: message.guildId,
      channelId: message.channelId,
      queryText: message.content,
      limit: LOOKUP_CONTEXT_PROMPT_LIMIT,
      maxAgeHours: LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
    });
    let memoryLookup = this.buildMemoryLookupContext({ settings });
    const videoContext = await this.buildVideoReplyContext({
      settings,
      message,
      recentMessages,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source
      }
    });
    let modelImageInputs = [...attachmentImageInputs, ...(videoContext.frameImages || [])].slice(0, MAX_MODEL_IMAGE_INPUTS);
    let imageLookup = this.buildImageLookupContext({
      recentMessages,
      excludedUrls: modelImageInputs.map((image) => String(image?.url || "").trim())
    });
    const replyTrace = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id
    };
    const screenShareCapability = this.getVoiceScreenShareCapability({
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      requesterUserId: message.author?.id || null
    });
    const activeVoiceSession =
      typeof this.voiceSessionManager?.getSession === "function"
        ? this.voiceSessionManager.getSession(message.guildId)
        : null;
    const inVoiceChannelNow = Boolean(activeVoiceSession && !activeVoiceSession.ending);
    const activeVoiceParticipantRoster =
      inVoiceChannelNow && typeof this.voiceSessionManager?.getVoiceChannelParticipants === "function"
        ? this.voiceSessionManager
          .getVoiceChannelParticipants(activeVoiceSession)
          .map((entry) => String(entry?.displayName || "").trim())
          .filter(Boolean)
        : [];
    const musicDisambiguation =
      inVoiceChannelNow &&
        typeof this.voiceSessionManager?.getMusicDisambiguationPromptContext === "function"
        ? this.voiceSessionManager.getMusicDisambiguationPromptContext(activeVoiceSession)
        : null;

    const systemPrompt = buildSystemPrompt(settings);
    const replyPromptBase = {
      message: {
        authorName: message.member?.displayName || message.author.username,
        content: message.content
      },
      triggerMessageIds,
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      emojiHints: this.getEmojiHints(message.guild),
      reactionEmojiOptions,
      allowReplySimpleImages:
        settings.initiative.allowReplyImages && simpleImageCapabilityReady && imageBudget.canGenerate,
      allowReplyComplexImages:
        settings.initiative.allowReplyImages && complexImageCapabilityReady && imageBudget.canGenerate,
      remainingReplyImages: imageBudget.remaining,
      allowReplyVideos:
        settings.initiative.allowReplyVideos && videoCapabilityReady && videoBudget.canGenerate,
      remainingReplyVideos: videoBudget.remaining,
      allowReplyGifs: settings.initiative.allowReplyGifs && gifsConfigured && gifBudget.canFetch,
      remainingReplyGifs: gifBudget.remaining,
      gifRepliesEnabled: settings.initiative.allowReplyGifs,
      gifsConfigured,
      replyEagerness,
      reactionEagerness,
      addressing: {
        directlyAddressed: addressed,
        directAddressConfidence: Number(addressSignal?.confidence) || 0,
        directAddressThreshold: Number(addressSignal?.threshold) || 0.62,
        responseRequired: Boolean(options.forceRespond)
      },
      allowMemoryDirective: settings.memory.enabled,
      allowAutomationDirective: true,
      automationTimeZoneLabel: getLocalTimeZoneLabel(),
      voiceMode: {
        enabled: Boolean(settings?.voice?.enabled),
        activeSession: inVoiceChannelNow,
        participantRoster: activeVoiceParticipantRoster,
        musicDisambiguation
      },
      recentWebLookups,
      screenShare: screenShareCapability,
      videoContext,
      channelMode: isInitiativeChannel ? "initiative" : "non_initiative",
      maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    };
    const initialUserPrompt = buildReplyPrompt({
      ...replyPromptBase,
      imageInputs: modelImageInputs,
      webSearch,
      memoryLookup,
      imageLookup,
      allowWebSearchDirective: true,
      allowMemoryLookupDirective: true,
      allowImageLookupDirective: true
    });
    const replyPromptCapture = createReplyPromptCapture({
      systemPrompt,
      initialUserPrompt
    });
    let replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, 0);

    const replyTools = buildReplyToolSet(settings, {
      webSearchAvailable:
        Boolean(webSearch?.enabled) &&
        Boolean(webSearch?.configured) &&
        !webSearch?.blockedByBudget &&
        Boolean(webSearch?.budget?.canSearch),
      memoryAvailable: settings.memory.enabled,
      imageLookupAvailable: Boolean(imageLookup?.enabled && imageLookup?.candidates?.length),
      openArticleAvailable: false
    });

    const llm1StartedAtMs = Date.now();
    const toolRuntime: ReplyToolRuntime = {
      search: this.search,
      memory: this.memory,
      store: this.store
    };
    const toolContext: ReplyToolContext = {
      settings,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      sourceMessageId: message.id,
      sourceText: message.content,
      botUserId: this.client.user?.id || undefined,
      trace: replyTrace
    };

    let contextMessages: Array<{ role: string; content: unknown }> = [];
    let generation = await this.llm.generate({
      settings,
      systemPrompt,
      userPrompt: initialUserPrompt,
      imageInputs: modelImageInputs,
      contextMessages,
      jsonSchema: replyTools.length ? "" : REPLY_OUTPUT_JSON_SCHEMA,
      tools: replyTools,
      trace: replyTrace
    });
    performance.llm1Ms = Math.max(0, Date.now() - llm1StartedAtMs);
    let usedWebSearchFollowup = false;
    let usedMemoryLookupFollowup = false;
    let usedImageLookupFollowup = false;
    const mediaPromptLimit = resolveMaxMediaPromptLen(settings);

    const TOOL_LOOP_MAX_STEPS = 2;
    const TOOL_LOOP_MAX_CALLS = 3;
    let toolLoopSteps = 0;
    let totalToolCalls = 0;

    while (
      generation.toolCalls?.length > 0 &&
      toolLoopSteps < TOOL_LOOP_MAX_STEPS &&
      totalToolCalls < TOOL_LOOP_MAX_CALLS
    ) {
      const assistantContent = generation.rawContent || [
        { type: "text", text: generation.text || "" }
      ];
      contextMessages = [
        ...contextMessages,
        { role: "user", content: initialUserPrompt },
        { role: "assistant", content: assistantContent }
      ];

      const toolResultMessages: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const toolCall of generation.toolCalls) {
        if (totalToolCalls >= TOOL_LOOP_MAX_CALLS) break;
        totalToolCalls += 1;

        const result = await executeReplyTool(
          toolCall.name,
          toolCall.input as Record<string, unknown>,
          toolRuntime,
          toolContext
        );

        if (toolCall.name === "web_search" && !result.isError) {
          usedWebSearchFollowup = true;
        }
        if (toolCall.name === "memory_search" && !result.isError) {
          usedMemoryLookupFollowup = true;
        }
        if (toolCall.name === "image_lookup" && !result.isError) {
          usedImageLookupFollowup = true;
        }

        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }

      contextMessages = [
        ...contextMessages,
        { role: "user", content: toolResultMessages }
      ];

      generation = await this.llm.generate({
        settings,
        systemPrompt,
        userPrompt: "",
        imageInputs: modelImageInputs,
        contextMessages,
        jsonSchema: "",
        tools: replyTools,
        trace: {
          ...replyTrace,
          event: `reply_tool_loop:${toolLoopSteps + 1}`
        }
      });
      toolLoopSteps += 1;
    }

    if (toolLoopSteps > 0) {
      performance.followupMs = Math.max(0, Date.now() - llm1StartedAtMs - (performance.llm1Ms || 0));
    }
    replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, toolLoopSteps);

    let replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
    let voiceIntentHandled = await this.maybeHandleStructuredVoiceIntent({
      message,
      settings,
      replyDirective
    });
    if (voiceIntentHandled) return true;

    const automationIntentHandled = await this.maybeHandleStructuredAutomationIntent({
      message,
      settings,
      replyDirective,
      generation,
      source,
      triggerMessageIds,
      addressing: addressSignal,
      performance,
      replyPrompts
    });
    if (automationIntentHandled) return true;

    const reaction = await this.maybeApplyReplyReaction({
      message,
      settings,
      emojiOptions: reactionEmojiOptions,
      emojiToken: replyDirective.reactionEmoji,
      generation,
      source,
      triggerMessageId: message.id,
      triggerMessageIds,
      addressing: addressSignal
    });

    let memorySaved = false;
    let selfMemorySaved = false;
    let userMemorySaved = false;

    const mediaDirective = pickReplyMediaDirective(replyDirective);
    let finalText = sanitizeBotText(replyDirective.text || "");
    let mentionResolution = emptyMentionResolution();
    finalText = normalizeSkipSentinel(finalText);
    const screenShareOffer = await this.maybeHandleScreenShareOfferIntent({
      message,
      replyDirective,
      source
    });
    if (screenShareOffer.appendText) {
      const textParts = [];
      if (finalText && finalText !== "[SKIP]") textParts.push(finalText);
      textParts.push(screenShareOffer.appendText);
      finalText = sanitizeBotText(textParts.join("\n"), 1700);
    }
    const allowMediaOnlyReply = !finalText && Boolean(mediaDirective);
    const modelProducedSkip = finalText === "[SKIP]";
    const modelProducedEmpty = !finalText;
    if (modelProducedEmpty && !allowMediaOnlyReply) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "reply_model_output_empty",
        metadata: {
          source,
          triggerMessageIds,
          addressed: Boolean(addressSignal?.triggered)
        }
      });
    }
    if (finalText === "[SKIP]" || (!finalText && !allowMediaOnlyReply)) {
      this.logSkippedReply({
        message,
        source,
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: modelProducedSkip ? "llm_skip" : "empty_reply",
        reaction,
        screenShareOffer,
        performance,
        prompts: replyPrompts
      });
      return false;
    }

    mentionResolution = await resolveDeterministicMentionsForMentions(
      { store: this.store },
      {
        text: finalText,
        guild: message.guild,
        guildId: message.guildId
      }
    );
    finalText = mentionResolution.text;
    finalText = embedWebSearchSources(finalText, webSearch);

    let payload = { content: finalText };
    let imageUsed = false;
    let imageBudgetBlocked = false;
    let imageCapabilityBlocked = false;
    let imageVariantUsed = null;
    let videoUsed = false;
    let videoBudgetBlocked = false;
    let videoCapabilityBlocked = false;
    let gifUsed = false;
    let gifBudgetBlocked = false;
    let gifConfigBlocked = false;
    const imagePrompt = replyDirective.imagePrompt;
    const complexImagePrompt = replyDirective.complexImagePrompt;
    const videoPrompt = replyDirective.videoPrompt;
    const gifQuery = replyDirective.gifQuery;

    if (mediaDirective?.type === "gif" && gifQuery) {
      const gifResult = await this.maybeAttachReplyGif({
        settings,
        text: finalText,
        query: gifQuery,
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = gifResult.payload;
      gifUsed = gifResult.gifUsed;
      gifBudgetBlocked = gifResult.blockedByBudget;
      gifConfigBlocked = gifResult.blockedByConfiguration;
    }

    if (mediaDirective?.type === "image_simple" && settings.initiative.allowReplyImages && imagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          imagePrompt,
          finalText,
          mediaPromptLimit,
          replyMediaMemoryFacts
        ),
        variant: "simple",
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = imageResult.payload;
      imageUsed = imageResult.imageUsed;
      imageBudgetBlocked = imageResult.blockedByBudget;
      imageCapabilityBlocked = imageResult.blockedByCapability;
      imageVariantUsed = imageResult.variant || "simple";
    }

    if (mediaDirective?.type === "image_complex" && settings.initiative.allowReplyImages && complexImagePrompt) {
      const imageResult = await this.maybeAttachGeneratedImage({
        settings,
        text: finalText,
        prompt: composeReplyImagePrompt(
          complexImagePrompt,
          finalText,
          mediaPromptLimit,
          replyMediaMemoryFacts
        ),
        variant: "complex",
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = imageResult.payload;
      imageUsed = imageResult.imageUsed;
      imageBudgetBlocked = imageResult.blockedByBudget;
      imageCapabilityBlocked = imageResult.blockedByCapability;
      imageVariantUsed = imageResult.variant || "complex";
    }

    if (mediaDirective?.type === "video" && settings.initiative.allowReplyVideos && videoPrompt) {
      const videoResult = await this.maybeAttachGeneratedVideo({
        settings,
        text: finalText,
        prompt: composeReplyVideoPrompt(
          videoPrompt,
          finalText,
          mediaPromptLimit,
          replyMediaMemoryFacts
        ),
        trace: {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source: "reply_message"
        }
      });
      payload = videoResult.payload;
      videoUsed = videoResult.videoUsed;
      videoBudgetBlocked = videoResult.blockedByBudget;
      videoCapabilityBlocked = videoResult.blockedByCapability;
    }

    if (!finalText && !imageUsed && !videoUsed && !gifUsed) {
      this.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: this.client.user?.id || null,
        content: "reply_model_output_empty_after_media",
        metadata: {
          source,
          triggerMessageIds,
          addressed: Boolean(addressSignal?.triggered)
        }
      });
      this.logSkippedReply({
        message,
        source,
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: "empty_reply_after_media",
        reaction,
        screenShareOffer,
        performance,
        prompts: replyPrompts
      });
      return false;
    }

    const typingStartedAtMs = Date.now();
    await message.channel.sendTyping();
    await sleep(this.getSimulatedTypingDelayMs(600, 1800));
    const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);

    const shouldThreadReply = addressed || options.forceRespond;
    const canStandalonePost = isInitiativeChannel || !shouldThreadReply;
    const sendAsReply = this.shouldSendAsReply({
      isInitiativeChannel,
      shouldThreadReply,
      replyText: finalText
    });
    const sendStartedAtMs = Date.now();
    const textChunks = splitDiscordMessage(payload.content);
    const firstPayload = { ...payload, content: textChunks[0] };
    const sent = sendAsReply
      ? await message.reply({
        ...firstPayload,
        allowedMentions: { repliedUser: false }
      })
      : await message.channel.send(firstPayload);
    for (let i = 1; i < textChunks.length; i++) {
      await message.channel.send({ content: textChunks[i] });
    }
    const sendMs = Math.max(0, Date.now() - sendStartedAtMs);
    const actionKind = sendAsReply ? "sent_reply" : "sent_message";
    const referencedMessageId = sendAsReply ? message.id : null;

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
      referencedMessageId
    });
    this.store.logAction({
      kind: actionKind,
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: this.client.user.id,
      content: finalText,
      metadata: {
        triggerMessageId: message.id,
        triggerMessageIds,
        source,
        addressing: addressSignal,
        replyPrompts,
        sendAsReply,
        canStandalonePost,
        image: {
          requestedByModel: Boolean(imagePrompt || complexImagePrompt),
          requestedSimpleByModel: Boolean(imagePrompt),
          requestedComplexByModel: Boolean(complexImagePrompt),
          selectedVariant: imageVariantUsed,
          used: imageUsed,
          blockedByDailyCap: imageBudgetBlocked,
          blockedByCapability: imageCapabilityBlocked,
          maxPerDay: imageBudget.maxPerDay,
          remainingAtPromptTime: imageBudget.remaining,
          simpleCapabilityReadyAtPromptTime: simpleImageCapabilityReady,
          complexCapabilityReadyAtPromptTime: complexImageCapabilityReady,
          capabilityReadyAtPromptTime: imageCapabilityReady
        },
        videoGeneration: {
          requestedByModel: Boolean(videoPrompt),
          used: videoUsed,
          blockedByDailyCap: videoBudgetBlocked,
          blockedByCapability: videoCapabilityBlocked,
          maxPerDay: videoBudget.maxPerDay,
          remainingAtPromptTime: videoBudget.remaining,
          capabilityReadyAtPromptTime: videoCapabilityReady
        },
        gif: {
          requestedByModel: Boolean(gifQuery),
          used: gifUsed,
          blockedByDailyCap: gifBudgetBlocked,
          blockedByConfiguration: gifConfigBlocked,
          maxPerDay: gifBudget.maxPerDay,
          remainingAtPromptTime: gifBudget.remaining
        },
        memory: {
          toolCallsUsed: usedMemoryLookupFollowup,
          saved: Boolean(memorySaved || selfMemorySaved || userMemorySaved)
        },
        imageLookup: {
          requested: imageLookup.requested,
          used: imageLookup.used,
          query: imageLookup.query,
          candidateCount: imageLookup.candidates?.length || 0,
          resultCount: imageLookup.results?.length || 0,
          error: imageLookup.error || null
        },
        mentions: mentionResolution,
        reaction,
        screenShareOffer,
        webSearch: {
          requested: webSearch.requested,
          used: webSearch.used,
          query: webSearch.query,
          resultCount: webSearch.results?.length || 0,
          fetchedPages: webSearch.fetchedPages || 0,
          providerUsed: webSearch.providerUsed || null,
          providerFallbackUsed: Boolean(webSearch.providerFallbackUsed),
          blockedByHourlyCap: webSearch.blockedByBudget,
          maxPerHour: webSearch.budget?.maxPerHour ?? null,
          remainingAtPromptTime: webSearch.budget?.remaining ?? null,
          configured: webSearch.configured,
          optedOutByUser: webSearch.optedOutByUser,
          error: webSearch.error || null
        },
        video: {
          requested: videoContext.requested,
          used: videoContext.used,
          detectedVideos: videoContext.detectedVideos,
          detectedFromRecentMessages: videoContext.detectedFromRecentMessages,
          fetchedVideos: videoContext.videos?.length || 0,
          extractedKeyframes: videoContext.frameImages?.length || 0,
          blockedByHourlyCap: videoContext.blockedByBudget,
          maxPerHour: videoContext.budget?.maxPerHour ?? null,
          remainingAtPromptTime: videoContext.budget?.remaining ?? null,
          enabled: videoContext.enabled,
          errorCount: videoContext.errors?.length || 0
        },
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd,
          usedWebSearchFollowup,
          usedMemoryLookupFollowup,
          usedImageLookupFollowup
        },
        performance: finalizeReplyPerformanceSample({
          performance,
          actionKind,
          typingDelayMs,
          sendMs
        })
      }
    });

    return true;
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

    if (intent.intent === "play_music") {
      const query = String(intent.query || "").trim();
      const trackId = String(intent.selectedResultId || "").trim() || null;
      const platform = String(intent.platform || "").trim().toLowerCase() || "auto";
      const searchResults = Array.isArray(intent.searchResults) ? intent.searchResults : null;
      return await this.voiceSessionManager.requestPlayMusic({
        message,
        settings,
        query,
        trackId,
        platform,
        searchResults,
        reason: "nl_play_music",
        source: "text_voice_intent"
      });
    }

    if (intent.intent === "stop_music") {
      return await this.voiceSessionManager.requestStopMusic({
        message,
        settings,
        reason: "nl_stop_music",
        source: "text_voice_intent"
      });
    }

    if (intent.intent === "pause_music") {
      return await this.voiceSessionManager.requestPauseMusic({
        message,
        settings,
        reason: "nl_pause_music",
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
        canStandalonePost: this.isInitiativeChannel(settings, message.channelId),
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
    const initiativePosts = this.store.countActionsSince("initiative_post", since);
    return sentReplies + sentMessages + initiativePosts < maxPerHour;
  }

  getImageBudgetState(settings) {
    const maxPerDay = clamp(Number(settings.initiative?.maxImagesPerDay) || 0, 0, 200);
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
    const maxPerDay = clamp(Number(settings.initiative?.maxVideosPerDay) || 0, 0, 120);
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
    const maxPerDay = clamp(Number(settings.initiative?.maxGifsPerDay) || 0, 0, 300);
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
        candidates.push({
          messageId: String(row?.message_id || "").trim() || null,
          authorName: String(row?.author_name || "unknown").trim() || "unknown",
          createdAt: String(row?.created_at || "").trim(),
          url,
          filename: parsed.filename || "(unnamed)",
          contentType: parsed.contentType || "",
          context: contentSansUrl.slice(0, 180),
          recencyRank: candidates.length
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

    if (!settings.initiative.allowReplyGifs) {
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

  isInitiativeChannel(settings, channelId) {
    const id = String(channelId);
    const initiativeChannelIds = Array.isArray(settings?.permissions?.initiativeChannelIds)
      ? settings.permissions.initiativeChannelIds
      : [];
    return initiativeChannelIds.includes(id);
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
    isInitiativeChannel = false,
    forceRespond = false,
    triggerMessageId = null
  }) {
    return shouldAttemptReplyDecisionForReplyAdmission({
      botUserId: this.client.user?.id,
      settings,
      recentMessages,
      addressSignal,
      isInitiativeChannel,
      forceRespond,
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
    await this.maybeRunInitiativeCycle({ startup: true });
    await this.maybeRunAutomationCycle();
  }

  async maybeRunAutomationCycle() {
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
    let memoryLookup = this.buildMemoryLookupContext({ settings });
    const promptBase = {
      instruction: automation.instruction,
      channelName: channel.name || "channel",
      recentMessages,
      relevantMessages: memorySlice.relevantMessages,
      userFacts: memorySlice.userFacts,
      relevantFacts: memorySlice.relevantFacts,
      allowSimpleImagePosts:
        settings.initiative.allowImagePosts && mediaCapabilities.simpleImageReady && imageBudget.canGenerate,
      allowComplexImagePosts:
        settings.initiative.allowImagePosts && mediaCapabilities.complexImageReady && imageBudget.canGenerate,
      allowVideoPosts:
        settings.initiative.allowVideoPosts && mediaCapabilities.videoReady && videoBudget.canGenerate,
      allowGifs: settings.initiative.allowReplyGifs && this.gifs?.isConfigured?.() && gifBudget.canFetch,
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
      memoryAvailable: settings.memory?.enabled,
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

    let directive = parseStructuredReplyOutput(generation.text, mediaPromptLimit);

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
      ...settings.permissions.initiativeChannelIds,
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

  async maybeRunInitiativeCycle({ startup = false } = {}) {
    if (this.initiativePosting) return;
    this.initiativePosting = true;

    try {
      const settings = this.store.getSettings();
      if (!settings.initiative?.enabled) return;
      if (!settings.permissions.initiativeChannelIds.length) return;
      if (settings.initiative.maxPostsPerDay <= 0) return;
      if (!this.canSendMessage(settings.permissions.maxMessagesPerHour)) return;
      if (!this.canTalkNow(settings)) return;

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const posts24h = this.store.countInitiativePostsSince(since24h);
      if (posts24h >= settings.initiative.maxPostsPerDay) return;

      const lastPostAt = this.store.getLastActionTime("initiative_post");
      const lastPostTs = lastPostAt ? new Date(lastPostAt).getTime() : 0;
      const nowTs = Date.now();
      const elapsedMs = lastPostTs ? nowTs - lastPostTs : null;
      const scheduleDecision = this.evaluateInitiativeSchedule({
        settings,
        startup,
        lastPostTs,
        elapsedMs,
        posts24h
      });
      if (!scheduleDecision.shouldPost) return;

      const channel = this.pickInitiativeChannel(settings);
      if (!channel) return;

      const recent = await this.hydrateRecentMessages(channel, settings.memory.maxRecentMessages);
      const recentMessages = recent.length
        ? recent
          .slice()
          .reverse()
          .slice(0, settings.memory.maxRecentMessages)
          .map((msg) => ({
            author_name: msg.member?.displayName || msg.author?.username || "unknown",
            content: String(msg.content || "").trim()
          }))
        : this.store.getRecentMessages(channel.id, settings.memory.maxRecentMessages);
      const initiativeMemoryQuery = recentMessages
        .slice(0, 6)
        .map((row) => String(row?.content || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320);
      const initiativeRelevantFacts = await this.loadRelevantMemoryFacts({
        settings,
        guildId: channel.guildId,
        channelId: channel.id,
        queryText: initiativeMemoryQuery,
        trace: {
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user.id,
          source: "initiative_prompt"
        },
        limit: 8
      });
      const initiativeMediaMemoryFacts = this.buildMediaMemoryFacts({
        userFacts: [],
        relevantFacts: initiativeRelevantFacts
      });

      const discoveryResult = await this.collectDiscoveryForInitiative({
        settings,
        channel,
        recentMessages
      });
      const requireDiscoveryLink =
        discoveryResult.enabled &&
        discoveryResult.candidates.length > 0 &&
        chance((settings.initiative?.discovery?.linkChancePercent || 0) / 100);
      const initiativeImageBudget = this.getImageBudgetState(settings);
      const initiativeVideoBudget = this.getVideoGenerationBudgetState(settings);
      const initiativeMediaCapabilities = this.getMediaGenerationCapabilities(settings);
      const initiativeSimpleImageCapabilityReady = initiativeMediaCapabilities.simpleImageReady;
      const initiativeComplexImageCapabilityReady = initiativeMediaCapabilities.complexImageReady;
      const initiativeImageCapabilityReady =
        initiativeSimpleImageCapabilityReady || initiativeComplexImageCapabilityReady;
      const initiativeVideoCapabilityReady = initiativeMediaCapabilities.videoReady;

      const systemPrompt = buildSystemPrompt(settings);
      const userPrompt = buildInitiativePrompt({
        channelName: channel.name || "channel",
        recentMessages,
        relevantFacts: initiativeRelevantFacts,
        emojiHints: this.getEmojiHints(channel.guild),
        allowSimpleImagePosts:
          settings.initiative.allowImagePosts &&
          initiativeSimpleImageCapabilityReady &&
          initiativeImageBudget.canGenerate,
        allowComplexImagePosts:
          settings.initiative.allowImagePosts &&
          initiativeComplexImageCapabilityReady &&
          initiativeImageBudget.canGenerate,
        remainingInitiativeImages: initiativeImageBudget.remaining,
        allowVideoPosts:
          settings.initiative.allowVideoPosts &&
          initiativeVideoCapabilityReady &&
          initiativeVideoBudget.canGenerate,
        remainingInitiativeVideos: initiativeVideoBudget.remaining,
        discoveryFindings: discoveryResult.candidates,
        maxLinksPerPost: settings.initiative?.discovery?.maxLinksPerPost || 2,
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

      const initiativeMediaPromptLimit = resolveMaxMediaPromptLen(settings);
      const initiativeDirective = parseInitiativeMediaDirective(generation.text, initiativeMediaPromptLimit);
      const imagePrompt = initiativeDirective.imagePrompt;
      const complexImagePrompt = initiativeDirective.complexImagePrompt;
      const videoPrompt = initiativeDirective.videoPrompt;
      const mediaDirective = pickInitiativeMediaDirective(initiativeDirective);
      let finalText = sanitizeBotText(initiativeDirective.text || (mediaDirective ? "" : generation.text));
      finalText = normalizeSkipSentinel(finalText);
      const allowMediaOnlyInitiative = !finalText && Boolean(mediaDirective);
      if (finalText === "[SKIP]") return;
      if (!finalText && !allowMediaOnlyInitiative) {
        this.store.logAction({
          kind: "bot_error",
          guildId: channel.guildId,
          channelId: channel.id,
          userId: this.client.user?.id || null,
          content: "initiative_model_output_empty",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler"
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
          content: "initiative_model_output_empty_after_link_policy",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler",
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
      if (mediaDirective?.type === "image_simple" && settings.initiative.allowImagePosts && imagePrompt) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeInitiativeImagePrompt(
            imagePrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          variant: "simple",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
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
        settings.initiative.allowImagePosts &&
        complexImagePrompt
      ) {
        const imageResult = await this.maybeAttachGeneratedImage({
          settings,
          text: finalText,
          prompt: composeInitiativeImagePrompt(
            complexImagePrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          variant: "complex",
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
          }
        });
        payload = imageResult.payload;
        imageUsed = imageResult.imageUsed;
        imageBudgetBlocked = imageResult.blockedByBudget;
        imageCapabilityBlocked = imageResult.blockedByCapability;
        imageVariantUsed = imageResult.variant || "complex";
      }

      if (mediaDirective?.type === "video" && settings.initiative.allowVideoPosts && videoPrompt) {
        const videoResult = await this.maybeAttachGeneratedVideo({
          settings,
          text: finalText,
          prompt: composeInitiativeVideoPrompt(
            videoPrompt,
            finalText,
            initiativeMediaPromptLimit,
            initiativeMediaMemoryFacts
          ),
          trace: {
            guildId: channel.guildId,
            channelId: channel.id,
            userId: this.client.user.id,
            source: "initiative_post"
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
          content: "initiative_model_output_empty_after_media",
          metadata: {
            source: startup ? "initiative_startup" : "initiative_scheduler"
          }
        });
        return;
      }

      await channel.sendTyping();
      await sleep(this.getSimulatedTypingDelayMs(500, 1200));

      const initChunks = splitDiscordMessage(payload.content);
      const initFirstPayload = { ...payload, content: initChunks[0] };
      const sent = await channel.send(initFirstPayload);
      for (let i = 1; i < initChunks.length; i++) {
        await channel.send({ content: initChunks[i] });
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
        kind: "initiative_post",
        guildId: sent.guildId,
        channelId: sent.channelId,
        messageId: sent.id,
        userId: this.client.user.id,
        content: finalText,
        metadata: {
          source: startup ? "initiative_startup" : "initiative_scheduler",
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
          imageSimpleCapabilityReadyAtPromptTime: initiativeSimpleImageCapabilityReady,
          imageComplexCapabilityReadyAtPromptTime: initiativeComplexImageCapabilityReady,
          imageCapabilityReadyAtPromptTime: initiativeImageCapabilityReady,
          videoRequestedByModel: Boolean(videoPrompt),
          videoUsed,
          videoBudgetBlocked,
          videoCapabilityBlocked,
          videoCapabilityReadyAtPromptTime: initiativeVideoCapabilityReady,
          llm: {
            provider: generation.provider,
            model: generation.model,
            usage: generation.usage,
            costUsd: generation.costUsd
          }
        }
      });
    } finally {
      this.initiativePosting = false;
    }
  }

  async collectDiscoveryForInitiative({ settings, channel, recentMessages }) {
    if (!this.discovery || !settings.initiative?.discovery?.enabled) {
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
        content: `initiative_discovery: ${String(error?.message || error)}`
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
        source: candidateMap.get(url)?.source || "initiative"
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
          source: fallback.source || "initiative"
        }
      ],
      forcedLink: true
    };
  }

  getInitiativePostingIntervalMs(settings) {
    return getInitiativePostingIntervalMs(settings);
  }

  getInitiativeAverageIntervalMs(settings) {
    return getInitiativeAverageIntervalMs(settings);
  }

  getInitiativePacingMode(settings) {
    return getInitiativePacingMode(settings);
  }

  getInitiativeMinGapMs(settings) {
    return getInitiativeMinGapMs(settings);
  }

  evaluateInitiativeSchedule({ settings, startup, lastPostTs, elapsedMs, posts24h }) {
    return evaluateInitiativeSchedule({
      settings,
      startup,
      lastPostTs,
      elapsedMs,
      posts24h
    });
  }

  evaluateSpontaneousInitiativeSchedule({ settings, lastPostTs, elapsedMs, posts24h, minGapMs }) {
    return evaluateSpontaneousInitiativeSchedule({
      settings,
      lastPostTs,
      elapsedMs,
      posts24h,
      minGapMs
    });
  }

  pickInitiativeChannel(settings) {
    return pickInitiativeChannel({
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

function createReplyPromptCapture({
  systemPrompt = "",
  initialUserPrompt = ""
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
} = {}): ReplyPromptCapture {
  return {
    systemPrompt: String(systemPrompt || ""),
    initialUserPrompt: String(initialUserPrompt || ""),
    followupUserPrompts: []
  };
}

function appendReplyFollowupPrompt(
  capture: ReplyPromptCapture | null = null,
  userPrompt = ""
) {
  if (!capture || typeof capture !== "object") return;
  if (!Array.isArray(capture.followupUserPrompts)) {
    capture.followupUserPrompts = [];
  }
  capture.followupUserPrompts.push(String(userPrompt || ""));
}

function buildLoggedReplyPrompts(
  capture: ReplyPromptCapture | null = null,
  followupSteps = 0
): LoggedReplyPrompts | null {
  if (!capture || typeof capture !== "object") return null;
  const systemPrompt = String(capture.systemPrompt || "");
  const initialUserPrompt = String(capture.initialUserPrompt || "");
  const followupUserPrompts = Array.isArray(capture.followupUserPrompts)
    ? capture.followupUserPrompts.map((prompt) => String(prompt || ""))
    : [];
  const resolvedFollowupSteps = Math.max(
    0,
    Number.isFinite(Number(followupSteps))
      ? Math.floor(Number(followupSteps))
      : followupUserPrompts.length
  );

  return {
    hiddenByDefault: true,
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts,
    followupSteps: resolvedFollowupSteps
  };
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

function normalizeNonNegativeMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.floor(parsed);
}

function normalizeReplyPerformanceSeed(seed: ReplyPerformanceSeed = {}) {
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(seed?.triggerMessageCreatedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(seed?.queuedAtMs);
  const ingestMs = normalizeNonNegativeMs(seed?.ingestMs);
  if (triggerMessageCreatedAtMs === null && queuedAtMs === null && ingestMs === null) return null;

  return {
    triggerMessageCreatedAtMs,
    queuedAtMs,
    ingestMs
  };
}

function createReplyPerformanceTracker({
  messageCreatedAtMs = null,
  source = "message_event",
  seed = null
}: {
  messageCreatedAtMs?: number | null;
  source?: string;
  seed?: ReplyPerformanceSeed | null;
} = {}): ReplyPerformanceTracker {
  const normalizedSeed = normalizeReplyPerformanceSeed({
    triggerMessageCreatedAtMs: seed?.triggerMessageCreatedAtMs ?? messageCreatedAtMs,
    queuedAtMs: seed?.queuedAtMs,
    ingestMs: seed?.ingestMs
  });
  const startedAtMs = Date.now();

  return {
    source: String(source || "message_event"),
    startedAtMs,
    triggerMessageCreatedAtMs: normalizedSeed?.triggerMessageCreatedAtMs ?? normalizeNonNegativeMs(messageCreatedAtMs),
    queuedAtMs: normalizedSeed?.queuedAtMs ?? null,
    ingestMs: normalizedSeed?.ingestMs ?? null,
    memorySliceMs: null,
    llm1Ms: null,
    followupMs: null
  };
}

function finalizeReplyPerformanceSample({
  performance,
  actionKind,
  typingDelayMs = null,
  sendMs = null
}: {
  performance?: ReplyPerformanceTracker | null;
  actionKind?: string;
  typingDelayMs?: number | null;
  sendMs?: number | null;
} = {}) {
  if (!performance || typeof performance !== "object") return null;

  const finishedAtMs = Date.now();
  const triggerMessageCreatedAtMs = normalizeNonNegativeMs(performance.triggerMessageCreatedAtMs);
  const startedAtMs = normalizeNonNegativeMs(performance.startedAtMs);
  const queuedAtMs = normalizeNonNegativeMs(performance.queuedAtMs);
  const normalizedSendMs = normalizeNonNegativeMs(sendMs);
  const normalizedTypingDelayMs = normalizeNonNegativeMs(typingDelayMs);
  const triggerToFinishMs =
    triggerMessageCreatedAtMs !== null ? Math.max(0, finishedAtMs - triggerMessageCreatedAtMs) : null;
  const hasReasonableTriggerBaseline =
    triggerToFinishMs !== null && triggerToFinishMs <= 15 * 60 * 1000;
  const totalMs = hasReasonableTriggerBaseline
    ? triggerToFinishMs
    : queuedAtMs !== null
      ? Math.max(0, finishedAtMs - queuedAtMs)
      : startedAtMs !== null
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
  const processingMs = startedAtMs !== null ? Math.max(0, finishedAtMs - startedAtMs) : null;
  const queueMs = startedAtMs !== null && queuedAtMs !== null ? Math.max(0, startedAtMs - queuedAtMs) : null;

  const sample = {
    version: REPLY_PERFORMANCE_VERSION,
    source: String(performance.source || "message_event"),
    actionKind: String(actionKind || "unknown"),
    totalMs: normalizeNonNegativeMs(totalMs),
    queueMs: normalizeNonNegativeMs(queueMs),
    processingMs: normalizeNonNegativeMs(processingMs),
    ingestMs: normalizeNonNegativeMs(performance.ingestMs),
    memorySliceMs: normalizeNonNegativeMs(performance.memorySliceMs),
    llm1Ms: normalizeNonNegativeMs(performance.llm1Ms),
    followupMs: normalizeNonNegativeMs(performance.followupMs),
    typingDelayMs: normalizedTypingDelayMs,
    sendMs: normalizedSendMs
  };

  const hasAnyTiming = [
    sample.totalMs,
    sample.queueMs,
    sample.processingMs,
    sample.ingestMs,
    sample.memorySliceMs,
    sample.llm1Ms,
    sample.followupMs,
    sample.typingDelayMs,
    sample.sendMs
  ].some((value) => typeof value === "number");
  return hasAnyTiming ? sample : null;
}
