import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { resolveMemoryToolNamespaceScope } from "../memory/memoryToolRuntime.ts";
import {
  applyOrchestratorOverrideSettings,
  getBotNameAliases,
  getMemorySettings,
  getFollowupSettings,
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceInitiativeBinding,
  getVoiceConversationPolicy,
  getVoiceInitiativeSettings,
  getVoiceRuntimeConfig,
  getVoiceSoundboardSettings,
  getVoiceTranscriptionSettings
} from "../settings/agentStack.ts";
import {
  buildVoiceToneGuardrails,
  buildHardLimitsSection,
  DEFAULT_PROMPT_VOICE_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptVoiceLookupBusySystemPrompt,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptStyle,
  getPromptVoiceGuidance,
  interpolatePromptTemplate
} from "../promptCore.ts";
import { clamp } from "../utils.ts";
import { hasBotNameCue } from "../directAddressConfidence.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import {
  defaultVoiceReplyDecisionModel,
  normalizeVoiceReplyDecisionProvider,
  parseVoiceThoughtDecisionContract
} from "./voiceDecisionRuntime.ts";
import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";
import { createMusicPlaybackProvider } from "./musicPlayback.ts";
import { createMusicSearchProvider } from "./musicSearch.ts";
import { createDiscordMusicPlayer } from "./musicPlayer.ts";
import {
  clearMusicDisambiguationState as clearMusicDisambiguationStateRuntime,
  ensureSessionMusicState as ensureSessionMusicStateRuntime,
  ensureToolMusicQueueState as ensureToolMusicQueueStateRuntime,

  extractMusicPlayQuery as extractMusicPlayQueryFallback,
  findPendingMusicSelectionById as findPendingMusicSelectionByIdRuntime,
  getMusicDisambiguationPromptContext as getMusicDisambiguationPromptContextRuntime,
  haltSessionOutputForMusicPlayback as haltSessionOutputForMusicPlaybackRuntime,
  handleMusicSlashCommand as handleMusicSlashCommandRuntime,
  isLikelyMusicPlayPhrase as isLikelyMusicPlayPhraseFallback,
  isLikelyMusicStopPhrase as isLikelyMusicStopPhraseFallback,
  isMusicDisambiguationActive as isMusicDisambiguationActiveRuntime,
  getMusicPhase as getMusicPhaseRuntime,
  setMusicPhase as setMusicPhaseRuntime,
  isCommandOnlyActive as isCommandOnlyActiveRuntime,
  maybeHandleMusicPlaybackTurn as maybeHandleMusicPlaybackTurnRuntime,
  maybeHandleMusicTextSelectionRequest as maybeHandleMusicTextSelectionRequestRuntime,
  maybeHandleMusicTextStopRequest as maybeHandleMusicTextStopRequestRuntime,
  normalizeMusicPlatformToken as normalizeMusicPlatformTokenRuntime,
  normalizeMusicSelectionResult as normalizeMusicSelectionResultRuntime,
  playMusicViaDiscord as playMusicViaDiscordRuntime,
  requestPauseMusic as requestPauseMusicRuntime,
  requestPlayMusic as requestPlayMusicRuntime,
  requestStopMusic as requestStopMusicRuntime,
  resolveMusicDuckingConfig as resolveMusicDuckingConfigRuntime,
  clearBotSpeechMusicUnduckTimer as clearBotSpeechMusicUnduckTimerRuntime,
  engageBotSpeechMusicDuck as engageBotSpeechMusicDuckRuntime,
  scheduleBotSpeechMusicUnduck as scheduleBotSpeechMusicUnduckRuntime,
  releaseBotSpeechMusicDuck as releaseBotSpeechMusicDuckRuntime,
  setMusicDisambiguationState as setMusicDisambiguationStateRuntime,
  snapshotMusicRuntimeState as snapshotMusicRuntimeStateRuntime
} from "./voiceMusicPlayback.ts";
import {
  enableWatchStreamForUser,
  getStreamWatchBrainContextForPrompt,
  generateVisionFallbackStreamWatchCommentary,
  ingestStreamFrame,
  initializeStreamWatchState,
  isUserInSessionVoiceChannel,
  maybeTriggerStreamWatchCommentary,
  requestStopWatchingStream,
  requestStreamWatchStatus,
  requestWatchStream,
  resolveStreamWatchVisionProviderSettings,
  stopWatchStreamForUser,
  supportsStreamWatchCommentary,
  supportsStreamWatchBrainContext,
  supportsVisionFallbackStreamWatchCommentary
} from "./voiceStreamWatch.ts";
import {
  resolveOperationalChannel,
  sendOperationalMessage,
  sendToChannel
} from "./voiceOperationalMessaging.ts";
import {
  type AsrBridgeDeps,
  type AsrBridgeState,
  asrPhaseIsClosing,
  ensureAsrSessionConnected,
  beginAsrUtterance,
  appendAudioToAsr,
  commitAsrUtterance,
  discardAsrUtterance,
  scheduleAsrIdleClose,
  closeAllPerUserAsrSessions,
  closeSharedAsrSession,
  closePerUserAsrSession,
  releaseSharedAsrActiveUser,
  tryHandoffSharedAsr,
  getOrCreatePerUserAsrState,
  getOrCreateSharedAsrState
} from "./voiceAsrBridge.ts";
import {
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  buildRealtimeTextUtterancePrompt,
  encodePcm16MonoAsWav,
  extractSoundboardDirective,
  findMentionedSoundboardReference,
  formatRealtimeMemoryFacts,
  formatSoundboardCandidateLine,
  isRealtimeMode,
  matchSoundboardReference,
  normalizeInlineText,
  normalizeVoiceText,
  parseSoundboardDirectiveSequence,
  parsePreferredSoundboardReferences,
  resolveRealtimeProvider,
  shortError,
  shouldAllowVoiceNsfwHumor
} from "./voiceSessionHelpers.ts";
import {
  SYSTEM_SPEECH_SOURCE,
  resolveSystemSpeechOpportunityType,
  resolveSystemSpeechReplyAccountingOnLocalPlayback,
  resolveSystemSpeechReplyAccountingOnRequest,
  shouldAllowSystemSpeechSkipAfterFire,
  shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech,
  shouldSupersedeSystemSpeechBeforePlayback
} from "./systemSpeechOpportunity.ts";
import { requestJoin } from "./voiceJoinFlow.ts";
import { evaluateVoiceReplyDecision as evaluateVoiceReplyDecisionModule } from "./voiceReplyDecision.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_RETRY_MAX_AGE_MS,
  BARGE_IN_SUPPRESSION_MAX_MS,
  BOT_DISCONNECT_GRACE_MS,
  BOT_TURN_DEFERRED_COALESCE_MAX,
  BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
  BOT_TURN_DEFERRED_QUEUE_MAX,
  BOT_TURN_SILENCE_RESET_MS,
  RECENT_ENGAGEMENT_WINDOW_MS,
  LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS,
  LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_POLL_MS,
  LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS,
  JOIN_GREETING_LLM_WINDOW_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  OPENAI_ASR_SESSION_IDLE_TTL_MS,
  OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS,
  OPENAI_TOOL_CALL_EVENT_MAX,
  OPENAI_TOOL_RESPONSE_DEBOUNCE_MS,
  SOUNDBOARD_CATALOG_REFRESH_MS,
  SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS,
  SPEAKING_END_ADAPTIVE_BUSY_BACKLOG,
  SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_BUSY_SCALE,
  SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG,
  SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_HEAVY_SCALE,
  SPEAKING_END_FINALIZE_MICRO_MS,
  SPEAKING_END_FINALIZE_MIN_MS,
  SPEAKING_END_FINALIZE_QUICK_MS,
  SPEAKING_END_FINALIZE_SHORT_MS,
  SPEAKING_END_MICRO_CAPTURE_MS,
  SPEAKING_END_SHORT_CAPTURE_MS,
  STT_CONTEXT_MAX_MESSAGES,
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_DECIDER_HISTORY_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_FRESH_MS,
  VOICE_MEMBERSHIP_EVENT_MAX_TRACKED,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
  VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
  VOICE_THOUGHT_MAX_CHARS,
  VOICE_THOUGHT_MEMORY_SEARCH_LIMIT,
  VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
  VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS,
  VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS,
  VOICE_TURN_PROMOTION_ACTIVE_RATIO_MIN,
  VOICE_TURN_PROMOTION_MIN_CLIP_MS,
  VOICE_TURN_PROMOTION_PEAK_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_ACTIVE_RATIO_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_PEAK_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_RMS_MIN,
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_SILENCE_GATE_PEAK_MAX,
  VOICE_SILENCE_GATE_RMS_MAX,
  VOICE_LOOKUP_BUSY_MAX_CHARS,
  VOICE_TURN_MIN_ASR_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import { providerSupports } from "./voiceModes.ts";
import { ensureSessionToolRuntimeState, getVoiceMcpServerStatuses, resolveVoiceRealtimeToolDescriptors, buildRealtimeFunctionTools, recordVoiceToolCallEvent, parseOpenAiRealtimeToolArguments, resolveOpenAiRealtimeToolDescriptor, summarizeVoiceToolOutput, executeOpenAiRealtimeFunctionCall, refreshRealtimeTools, executeVoiceMemorySearchTool, executeVoiceMemoryWriteTool, executeVoiceAdaptiveStyleAddTool, executeVoiceAdaptiveStyleRemoveTool, executeVoiceConversationSearchTool, executeVoiceMusicSearchTool, executeVoiceMusicQueueAddTool, executeVoiceMusicQueueNextTool, executeVoiceMusicPlayNowTool, executeVoiceWebSearchTool, executeLocalVoiceToolCall, executeMcpVoiceToolCall } from "./voiceToolCalls.ts";
import type {
  DeferredQueuedUserTurn,
  DeferredVoiceAction,
  OutputChannelState
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseIsAudible,
} from "./voiceSessionTypes.ts";
import { BargeInController } from "./bargeInController.ts";
import { CaptureManager } from "./captureManager.ts";
import { DeferredActionQueue } from "./deferredActionQueue.ts";
import { GreetingManager } from "./greetingManager.ts";
import { InstructionManager } from "./instructionManager.ts";
import { ReplyManager } from "./replyManager.ts";
import { SessionLifecycle } from "./sessionLifecycle.ts";
import { ThoughtEngine } from "./thoughtEngine.ts";
import { TurnProcessor } from "./turnProcessor.ts";

export function resolveVoiceThoughtTopicalityBias({
  silenceMs = 0,
  minSilenceSeconds = 20,
  minSecondsBetweenThoughts = 20
} = {}) {
  const normalizedSilenceMs = Math.max(0, Number(silenceMs) || 0);
  const normalizedMinSilenceSeconds = clamp(
    Number(minSilenceSeconds) || 20,
    VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
  );
  const normalizedMinBetweenSeconds = clamp(
    Number(minSecondsBetweenThoughts) || normalizedMinSilenceSeconds,
    VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS
  );
  const silenceSeconds = normalizedSilenceMs / 1000;
  const topicalStartSeconds = normalizedMinSilenceSeconds;
  const fullDriftSeconds = Math.max(
    topicalStartSeconds + 18,
    Math.round(normalizedMinBetweenSeconds * 3),
    60
  );
  const driftProgress = clamp(
    (silenceSeconds - topicalStartSeconds) / Math.max(1, fullDriftSeconds - topicalStartSeconds),
    0,
    1
  );
  const topicTetherStrength = Math.round((1 - driftProgress) * 100);
  const randomInspirationStrength = Math.round(driftProgress * 100);
  let phase = "anchored";
  let promptHint = "Keep it clearly tied to the current conversation topic.";

  if (topicTetherStrength < 35) {
    phase = "ambient";
    promptHint =
      "Treat old topic context as stale. Prefer standalone, fresh, lightly inspired lines over callbacks.";
  } else if (topicTetherStrength < 70) {
    phase = "blended";
    promptHint =
      "Mix in novelty. Keep only loose thematic links to recent dialogue, avoid direct callbacks that require context.";
  }

  return {
    silenceSeconds: Number(silenceSeconds.toFixed(2)),
    topicTetherStrength,
    randomInspirationStrength,
    phase,
    topicalStartSeconds,
    fullDriftSeconds,
    promptHint
  };
}

const VOICE_ADDRESSING_ALL_TOKENS = new Set([
  "ALL",
  "EVERYONE",
  "EVERYBODY",
  "WHOLE_ROOM",
  "WHOLE_CHAT",
  "VC"
]);

function normalizeVoiceAddressingTargetToken(value = "") {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (VOICE_ADDRESSING_ALL_TOKENS.has(upper)) return "ALL";
  return normalized;
}

const VOICE_COMMAND_SESSION_TTL_MS = 20 * 1000;
const OPENAI_COMPLETED_TOOL_CALL_TTL_MS = 10 * 60 * 1000;
const OPENAI_COMPLETED_TOOL_CALL_MAX = 256;
const OPENAI_FUNCTION_CALL_ITEM_TYPES = new Set([
  "response.output_item.added",
  "response.output_item.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done"
]);

type MusicSelectionResult = {
  id: string;
  title: string;
  artist: string;
  platform: "youtube" | "soundcloud" | "discord" | "auto";
  externalUrl: string | null;
  durationSeconds: number | null;
};

type MusicDisambiguationPayload = {
  session?: Record<string, unknown> | null;
  query?: string;
  platform?: string;
  action?: "play_now" | "queue_next" | "queue_add";
  results?: Array<Record<string, unknown>>;
  requestedByUserId?: string | null;
};

type MusicTextCommandMessage = {
  guild?: { id?: string | null } | null;
  guildId?: string | null;
  channel?: unknown;
  channelId?: string | null;
  author?: { id?: string | null } | null;
  id?: string | null;
  content?: string | null;
};

type MusicTextRequestPayload = {
  message?: MusicTextCommandMessage | null;
  settings?: Record<string, unknown> | null;
};

type VoiceAddressingAnnotation = {
  talkingTo: string | null;
  directedConfidence: number;
  source: string | null;
  reason: string | null;
};

type VoiceAddressingState = {
  currentSpeakerTarget: string | null;
  currentSpeakerDirectedConfidence: number;
  lastDirectedToMe: {
    speakerName: string;
    directedConfidence: number;
    ageMs: number | null;
  } | null;
  recentAddressingGuesses: Array<{
    speakerName: string;
    talkingTo: string | null;
    directedConfidence: number;
    ageMs: number | null;
  }>;
};

type VoiceConversationContext = {
  engagementState: string;
  engaged: boolean;
  engagedWithCurrentSpeaker: boolean;
  recentAssistantReply: boolean;
  recentDirectAddress: boolean;
  sameAsRecentDirectAddress: boolean;
  msSinceAssistantReply: number | null;
  msSinceDirectAddress: number | null;
  activeCommandSpeaker?: string | null;
  activeCommandDomain?: string | null;
  activeCommandIntent?: string | null;
  msUntilCommandSessionExpiry?: number | null;
  voiceAddressingState?: VoiceAddressingState | null;
  currentTurnAddressing?: VoiceAddressingAnnotation | null;
  addressedToOtherSignal?: boolean;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
};

type VoiceReplyDecision = {
  allow: boolean;
  reason: string;
  participantCount: number;
  directAddressed: boolean;
  directAddressConfidence: number;
  directAddressThreshold: number;
  transcript: string;
  conversationContext: VoiceConversationContext;
  voiceAddressing?: VoiceAddressingAnnotation | null;
  llmResponse?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  error?: string | null;
  retryAfterMs?: number | null;
  requiredSilenceMs?: number | null;
  msSinceInboundAudio?: number | null;
  outputLockReason?: string | null;
  classifierLatencyMs?: number | null;
  classifierDecision?: "allow" | "deny" | null;
  classifierConfidence?: number | null;
  classifierTarget?: string | null;
  classifierReason?: string | null;
};

type VoiceTimelineTurn = {
  role: "assistant" | "user";
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  addressing?: VoiceAddressingAnnotation;
};

type VoiceRealtimeToolDescriptor = {
  toolType: "function" | "mcp";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  serverName?: string | null;
};

type VoiceToolCallEvent = {
  callId: string;
  toolName: string;
  toolType: "function" | "mcp";
  arguments: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  runtimeMs: number | null;
  success: boolean;
  outputSummary: string | null;
  error: string | null;
  sourceEventType?: string | null;
};

type VoiceMcpServerStatus = {
  serverName: string;
  connected: boolean;
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastCallAt: string | null;
  baseUrl: string;
  toolPath: string;
  timeoutMs: number;
  headers: Record<string, string>;
};

type VoiceRealtimeToolSettings = {
  webSearch?: {
    enabled?: boolean;
    maxResults?: number;
    recencyDaysDefault?: number;
  };
  memory?: {
    enabled?: boolean;
  };
  browser?: {
    enabled?: boolean;
  };
  voice?: {
    replyPath?: string;
  };
  [key: string]: unknown;
};

type VoiceToolRuntimeSessionLike = {
  ending?: boolean;
  mode?: string;
  realtimeClient?: {
    updateTools?: (payload: {
      tools: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
      toolChoice?: "auto" | "none" | "required" | { type: "function"; name: string };
    }) => void;
  } | null;
  mcpStatus?: VoiceMcpServerStatus[];
  settingsSnapshot?: VoiceRealtimeToolSettings | null;
  openAiToolDefinitions?: VoiceRealtimeToolDescriptor[];
  lastOpenAiRealtimeToolHash?: string | null;
  lastOpenAiRealtimeToolRefreshAt?: number | null;
  guildId?: string;
  textChannelId?: string;
  id?: string;
  openAiToolResponseDebounceTimer?: ReturnType<typeof setTimeout> | null;
  openAiToolCallExecutions?: Map<string, { startedAtMs: number; toolName: string }>;
  openAiPendingToolCalls?: Map<string, {
    callId: string;
    name: string;
    argumentsText: string;
    done: boolean;
    startedAtMs: number;
    sourceEventType: string;
  }>;
  toolMusicTrackCatalog?: Map<string, unknown>;
  memoryWriteWindow?: number[];
  toolCallEvents?: VoiceToolCallEvent[];
  musicQueueState?: Record<string, unknown>;
  lastOpenAiToolCallerUserId?: string | null;
  awaitingToolOutputs?: boolean;
  pendingMemoryIngest?: Promise<unknown> | null;
  [key: string]: unknown;
};

export class VoiceSessionManager {
  client;
  store;
  appConfig;
  llm;
  memory;
  search;
  browserManager;
  composeOperationalMessage;
  generateVoiceTurn;
  getVoiceScreenShareCapabilityHook;
  offerVoiceScreenShareLinkHook;
  sessions;
  pendingSessionGuildIds;
  joinLocks;
  soundboardDirector;
  musicPlayback;
  musicSearch;
  musicPlayer;
  bargeInController;
  captureManager;
  deferredActionQueue;
  greetingManager;
  instructionManager;
  replyManager;
  sessionLifecycle;
  thoughtEngine;
  turnProcessor;
  onVoiceStateUpdate;

  constructor({
    client,
    store,
    appConfig,
    llm = null,
    memory = null,
    search = null,
    browserManager = null,
    composeOperationalMessage = null,
    generateVoiceTurn = null,
    getVoiceScreenShareCapability = null,
    offerVoiceScreenShareLink = null
  }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
    this.llm = llm || null;
    this.memory = memory || null;
    this.search = search || null;
    this.browserManager = browserManager || null;
    this.composeOperationalMessage =
      typeof composeOperationalMessage === "function" ? composeOperationalMessage : null;
    this.generateVoiceTurn = typeof generateVoiceTurn === "function" ? generateVoiceTurn : null;
    this.getVoiceScreenShareCapabilityHook =
      typeof getVoiceScreenShareCapability === "function" ? getVoiceScreenShareCapability : null;
    this.offerVoiceScreenShareLinkHook =
      typeof offerVoiceScreenShareLink === "function" ? offerVoiceScreenShareLink : null;
    this.sessions = new Map();
    this.pendingSessionGuildIds = new Set();
    this.joinLocks = new Map();
    this.soundboardDirector = new SoundboardDirector({
      client,
      store,
      appConfig
    });
    this.musicPlayback = createMusicPlaybackProvider(this.appConfig || {});
    this.musicSearch = createMusicSearchProvider(this.appConfig || {});
    this.musicPlayer = createDiscordMusicPlayer();
    this.bargeInController = new BargeInController(this);
    this.captureManager = new CaptureManager(this);
    this.deferredActionQueue = new DeferredActionQueue(this);
    this.greetingManager = new GreetingManager(this);
    this.instructionManager = new InstructionManager(this);
    this.replyManager = new ReplyManager(this);
    this.sessionLifecycle = new SessionLifecycle(this);
    this.thoughtEngine = new ThoughtEngine(this);
    this.turnProcessor = new TurnProcessor(this);
    this.onVoiceStateUpdate = (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: newState?.guild?.id || oldState?.guild?.id || null,
          channelId: newState?.channelId || oldState?.channelId || null,
          userId: this.client.user?.id || null,
          content: `voice_state_update: ${String(error?.message || error)}`
        });
      });
    };

    this.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
  }

  getVoiceScreenShareCapability({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null
  } = {}) {
    if (typeof this.getVoiceScreenShareCapabilityHook === "function") {
      return (
        this.getVoiceScreenShareCapabilityHook({
          settings,
          guildId,
          channelId,
          requesterUserId
        }) || {
          supported: false,
          enabled: false,
          available: false,
          status: "disabled",
          publicUrl: "",
          reason: "screen_share_manager_unavailable"
        }
      );
    }
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_share_manager_unavailable"
    };
  }

  async offerVoiceScreenShareLink({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    transcript = "",
    source = "voice_realtime_tool_call"
  } = {}) {
    if (typeof this.offerVoiceScreenShareLinkHook !== "function") {
      return {
        offered: false,
        reason: "screen_share_manager_unavailable"
      };
    }
    return (
      await this.offerVoiceScreenShareLinkHook({
        settings,
        guildId,
        channelId,
        requesterUserId,
        transcript,
        source
      })
    ) || {
      offered: false,
      reason: "screen_share_manager_unavailable"
    };
  }

  getSession(guildId) {
    const id = String(guildId || "");
    if (!id) return null;
    return this.sessions.get(id) || null;
  }

  hasActiveSession(guildId) {
    return Boolean(this.getSession(guildId));
  }

  getRuntimeState() {
    const sessions = [...this.sessions.values()].map((session) => {
      const now = Date.now();
      const participants = this.getVoiceChannelParticipants(session);
      const participantDisplayByUserId = new Map(
        participants.map((entry) => [String(entry?.userId || ""), String(entry?.displayName || "")])
      );
      const membershipEvents = this.getRecentVoiceMembershipEvents(session, {
        maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
      });
      const activeCaptureEntries = session.userCaptures instanceof Map
        ? [...session.userCaptures.entries()]
        : [];
      const activeCaptures = activeCaptureEntries
        .map(([rawUserId, rawCapture]) => {
          const userId = String(rawUserId || "").trim();
          if (!userId) return null;
          const capture = rawCapture && typeof rawCapture === "object" ? rawCapture : {};
          const startedAtMs = Number(capture?.startedAt || 0);
          const startedAt = Number.isFinite(startedAtMs) && startedAtMs > 0
            ? new Date(startedAtMs).toISOString()
            : null;
          const ageMs = Number.isFinite(startedAtMs) && startedAtMs > 0
            ? Math.max(0, Math.round(now - startedAtMs))
            : null;
          const participantDisplayName = String(participantDisplayByUserId.get(userId) || "").trim();
          const membershipDisplayName = String(
            membershipEvents
              .slice()
              .reverse()
              .find((entry) => String(entry?.userId || "") === userId)
              ?.displayName || ""
          ).trim();
          const cachedUser = this.client?.users?.cache?.get?.(userId) || null;
          const cachedDisplayName = String(
            cachedUser?.displayName ||
            cachedUser?.globalName ||
            cachedUser?.username ||
            ""
          ).trim();
          const displayName = participantDisplayName || membershipDisplayName || cachedDisplayName || null;
          return {
            userId,
            displayName,
            startedAt,
            ageMs
          };
        })
        .filter(Boolean);
      const wakeContext = this.buildVoiceConversationContext({
        session,
        now
      });
      const addressingState = this.buildVoiceAddressingState({
        session,
        now
      });
      const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
      const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
      const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
      const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
      const deferredQueue = this.deferredActionQueue.getDeferredQueuedUserTurns(session);
      const generationSummary =
        session.modelContextSummary && typeof session.modelContextSummary === "object"
          ? session.modelContextSummary.generation || null
          : null;
      const deciderSummary =
        session.modelContextSummary && typeof session.modelContextSummary === "object"
          ? session.modelContextSummary.decider || null
          : null;
      const streamWatchRawEntries = Array.isArray(session.streamWatch?.brainContextEntries)
        ? session.streamWatch.brainContextEntries
        : [];
      const streamWatchVisualFeed = streamWatchRawEntries
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const text = String(entry.text || "").trim();
          if (!text) return null;
          const atMs = Number(entry.at || 0);
          return {
            text: text.slice(0, 220),
            at: Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : null,
            provider: String(entry.provider || "").trim() || null,
            model: String(entry.model || "").trim() || null,
            speakerName: String(entry.speakerName || "").trim() || null
          };
        })
        .filter(Boolean);
      const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(
        session,
        session.settingsSnapshot || null
      );
      const streamWatchLatestFrameDataBase64 = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
      const streamWatchLatestFrameApproxBytes = streamWatchLatestFrameDataBase64
        ? Math.max(0, Math.floor((streamWatchLatestFrameDataBase64.length * 3) / 4))
        : 0;

      return {
        sessionId: session.id,
        guildId: session.guildId,
        voiceChannelId: session.voiceChannelId,
        textChannelId: session.textChannelId,
        startedAt: new Date(session.startedAt).toISOString(),
        lastActivityAt: new Date(session.lastActivityAt).toISOString(),
        maxEndsAt: session.maxEndsAt ? new Date(session.maxEndsAt).toISOString() : null,
        inactivityEndsAt: session.inactivityEndsAt ? new Date(session.inactivityEndsAt).toISOString() : null,
        activeInputStreams: session.userCaptures.size,
        activeCaptures,
        soundboard: {
          playCount: session.soundboard?.playCount || 0,
          lastPlayedAt: session.soundboard?.lastPlayedAt
            ? new Date(session.soundboard.lastPlayedAt).toISOString()
            : null
        },
        mode: session.mode || "voice_agent",
        botTurnOpen: Boolean(session.botTurnOpen),
        assistantOutput: {
          phase: this.replyManager.syncAssistantOutputState(session, "runtime_state")?.phase || "idle",
          reason: session.assistantOutput?.reason || null,
          lastTrigger: session.assistantOutput?.lastTrigger || null,
          phaseEnteredAt: Number(session.assistantOutput?.phaseEnteredAt || 0) > 0
            ? new Date(Number(session.assistantOutput.phaseEnteredAt)).toISOString()
            : null,
          requestId: Number.isFinite(Number(session.assistantOutput?.requestId))
            ? Math.round(Number(session.assistantOutput.requestId))
            : null,
          ttsPlaybackState: session.assistantOutput?.ttsPlaybackState || "idle",
          ttsBufferedSamples: Math.max(0, Number(session.assistantOutput?.ttsBufferedSamples || 0))
        },
        playbackArm: {
          armed: Boolean(session.playbackArmed),
          reason: session.playbackArmedReason || null,
          armedAt: session.playbackArmedAt ? new Date(session.playbackArmedAt).toISOString() : null,
        },
        conversation: {
          lastAssistantReplyAt: session.lastAssistantReplyAt
            ? new Date(session.lastAssistantReplyAt).toISOString()
            : null,
          lastDirectAddressAt: session.lastDirectAddressAt
            ? new Date(session.lastDirectAddressAt).toISOString()
            : null,
          lastDirectAddressUserId: session.lastDirectAddressUserId || null,
          musicWakeLatchedUntil: Number(session?.musicWakeLatchedUntil || 0) > 0
            ? new Date(Number(session.musicWakeLatchedUntil)).toISOString()
            : null,
          musicWakeLatchedByUserId: session.musicWakeLatchedByUserId || null,
          wake: {
            state: wakeContext?.engaged ? "awake" : "listening",
            active: Boolean(wakeContext?.engaged),
            engagementState: wakeContext?.engagementState || "wake_word_biased",
            engagedWithCurrentSpeaker: Boolean(wakeContext?.engagedWithCurrentSpeaker),
            recentAssistantReply: Boolean(wakeContext?.recentAssistantReply),
            recentDirectAddress: Boolean(wakeContext?.recentDirectAddress),
            msSinceAssistantReply: Number.isFinite(wakeContext?.msSinceAssistantReply)
              ? Math.round(wakeContext.msSinceAssistantReply)
              : null,
            msSinceDirectAddress: Number.isFinite(wakeContext?.msSinceDirectAddress)
              ? Math.round(wakeContext.msSinceDirectAddress)
              : null,
            windowMs: RECENT_ENGAGEMENT_WINDOW_MS
          },
          joinWindow: {
            active: joinWindowActive,
            ageMs: Math.round(joinWindowAgeMs),
            windowMs: JOIN_GREETING_LLM_WINDOW_MS,
            greetingPending: Boolean(this.greetingManager.getJoinGreetingOpportunity(session)),
          },
          thoughtEngine: {
            busy: Boolean(session.thoughtLoopBusy),
            nextAttemptAt: session.nextThoughtAt ? new Date(session.nextThoughtAt).toISOString() : null,
            lastAttemptAt: session.lastThoughtAttemptAt
              ? new Date(session.lastThoughtAttemptAt).toISOString()
              : null,
            lastSpokenAt: session.lastThoughtSpokenAt
              ? new Date(session.lastThoughtSpokenAt).toISOString()
              : null
          },
          addressing: addressingState,
          modelContext: {
            generation: generationSummary,
            decider: deciderSummary,
            trackedTurns: modelTurns.length,
            trackedTurnLimit: VOICE_DECIDER_HISTORY_MAX_TURNS,
            trackedTranscriptTurns: transcriptTurns.length
          }
        },
        participants: participants.map((p) => ({ userId: p.userId, displayName: p.displayName })),
        participantCount: participants.length,
        membershipEvents: membershipEvents.map((entry) => ({
          userId: entry.userId,
          displayName: entry.displayName,
          eventType: entry.eventType,
          at: new Date(entry.at).toISOString(),
          ageMs: Math.max(0, Math.round(entry.ageMs))
        })),
        voiceLookupBusyCount: Number(session.voiceLookupBusyCount || 0),
        pendingDeferredTurns: deferredQueue.length,
        recentTurns: transcriptTurns.slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS).map((t) => ({
          role: t.role,
          speakerName: t.speakerName || "",
          text: String(t.text || ""),
          at: t.at ? new Date(t.at).toISOString() : null,
          addressing:
            t?.addressing && typeof t.addressing === "object"
              ? {
                talkingTo: t.addressing.talkingTo || null,
                directedConfidence: Number.isFinite(Number(t.addressing.directedConfidence))
                  ? Number(clamp(Number(t.addressing.directedConfidence), 0, 1).toFixed(3))
                  : 0,
                source: t.addressing.source || null,
                reason: t.addressing.reason || null
              }
              : null
        })),
        lastGenerationContext: session.lastGenerationContext || null,
        streamWatch: {
          active: Boolean(session.streamWatch?.active),
          targetUserId: session.streamWatch?.targetUserId || null,
          requestedByUserId: session.streamWatch?.requestedByUserId || null,
          lastFrameAt: session.streamWatch?.lastFrameAt
            ? new Date(session.streamWatch.lastFrameAt).toISOString()
            : null,
          lastCommentaryAt: session.streamWatch?.lastCommentaryAt
            ? new Date(session.streamWatch.lastCommentaryAt).toISOString()
            : null,
          lastCommentaryNote: session.streamWatch?.lastCommentaryNote || null,
          lastMemoryRecapAt: session.streamWatch?.lastMemoryRecapAt
            ? new Date(session.streamWatch.lastMemoryRecapAt).toISOString()
            : null,
          lastMemoryRecapText: session.streamWatch?.lastMemoryRecapText || null,
          lastMemoryRecapDurableSaved: Boolean(session.streamWatch?.lastMemoryRecapDurableSaved),
          lastMemoryRecapReason: session.streamWatch?.lastMemoryRecapReason || null,
          latestFrameAt: session.streamWatch?.latestFrameAt
            ? new Date(session.streamWatch.latestFrameAt).toISOString()
            : null,
          latestFrameMimeType: session.streamWatch?.latestFrameMimeType || null,
          latestFrameApproxBytes: streamWatchLatestFrameApproxBytes,
          acceptedFrameCountInWindow: Number(session.streamWatch?.acceptedFrameCountInWindow || 0),
          frameWindowStartedAt: session.streamWatch?.frameWindowStartedAt
            ? new Date(session.streamWatch.frameWindowStartedAt).toISOString()
            : null,
          lastBrainContextAt: session.streamWatch?.lastBrainContextAt
            ? new Date(session.streamWatch.lastBrainContextAt).toISOString()
            : null,
          lastBrainContextProvider: session.streamWatch?.lastBrainContextProvider || null,
          lastBrainContextModel: session.streamWatch?.lastBrainContextModel || null,
          brainContextCount: Array.isArray(session.streamWatch?.brainContextEntries)
            ? session.streamWatch.brainContextEntries.length
            : 0,
          ingestedFrameCount: Number(session.streamWatch?.ingestedFrameCount || 0),
          visualFeed: streamWatchVisualFeed,
          brainContextPayload: streamWatchBrainContext
            ? {
              prompt: String(streamWatchBrainContext.prompt || "").trim(),
              notes: Array.isArray(streamWatchBrainContext.notes)
                ? streamWatchBrainContext.notes
                  .map((note) => String(note || "").trim())
                  .filter(Boolean)
                  .slice(-24)
                : [],
              lastAt: Number(streamWatchBrainContext.lastAt || 0)
                ? new Date(Number(streamWatchBrainContext.lastAt)).toISOString()
                : null,
              provider: streamWatchBrainContext.provider || null,
              model: streamWatchBrainContext.model || null
            }
            : null
        },
        asrSessions: (() => {
          const asrMap = session.openAiAsrSessions instanceof Map ? session.openAiAsrSessions : null;
          if (!asrMap || asrMap.size === 0) return null;
          return [...asrMap.entries()].map(([uid, asr]) => {
            const ws = asr?.client?.ws;
            const connected = Boolean(ws && ws.readyState === 1);
            const idleTtlMs = Math.max(
              1_000,
              Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
            );
            const lastActivityMs = Math.max(
              Number(asr.lastAudioAt || 0),
              Number(asr.lastTranscriptAt || 0)
            );
            const idleMs = lastActivityMs > 0 ? Math.max(0, now - lastActivityMs) : null;
            return {
              userId: String(uid || ""),
              displayName: participantDisplayByUserId.get(String(uid || "")) || null,
              connected,
              phase: String(asr.phase || "idle"),
              connectedAt: asr.connectedAt > 0 ? new Date(asr.connectedAt).toISOString() : null,
              lastAudioAt: asr.lastAudioAt > 0 ? new Date(asr.lastAudioAt).toISOString() : null,
              lastTranscriptAt: asr.lastTranscriptAt > 0 ? new Date(asr.lastTranscriptAt).toISOString() : null,
              idleMs,
              idleTtlMs,
              hasIdleTimer: Boolean(asr.idleTimer),
              pendingAudioBytes: Number(asr.pendingAudioBytes || 0),
              pendingAudioChunks: Array.isArray(asr.pendingAudioChunks) ? asr.pendingAudioChunks.length : 0,
              utterance: asr.utterance ? {
                partialText: String(asr.utterance.partialText || "").slice(0, 200),
                finalSegments: Array.isArray(asr.utterance.finalSegments) ? asr.utterance.finalSegments.length : 0,
                bytesSent: Number(asr.utterance.bytesSent || 0)
              } : null,
              model: String(
                asr.client?.sessionConfig?.inputTranscriptionModel ||
                session.openAiPerUserAsrModel ||
                ""
              ).trim() || null,
              sessionId: asr.client?.sessionId || null
            };
          });
        })(),
        sharedAsrSession: (() => {
          const shared = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
            ? session.openAiSharedAsrState
            : null;
          if (!shared) return null;
          const ws = shared?.client?.ws;
          const connected = Boolean(ws && ws.readyState === 1);
          const idleTtlMs = Math.max(
            1_000,
            Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
          );
          const lastActivityMs = Math.max(
            Number(shared.lastAudioAt || 0),
            Number(shared.lastTranscriptAt || 0)
          );
          const idleMs = lastActivityMs > 0 ? Math.max(0, now - lastActivityMs) : null;
          const activeUserId = String(shared.userId || "").trim();
          return {
            connected,
            phase: String(shared.phase || "idle"),
            userId: activeUserId || null,
            displayName: activeUserId ? participantDisplayByUserId.get(activeUserId) || null : null,
            connectedAt: shared.connectedAt > 0 ? new Date(shared.connectedAt).toISOString() : null,
            lastAudioAt: shared.lastAudioAt > 0 ? new Date(shared.lastAudioAt).toISOString() : null,
            lastTranscriptAt: shared.lastTranscriptAt > 0 ? new Date(shared.lastTranscriptAt).toISOString() : null,
            idleMs,
            idleTtlMs,
            hasIdleTimer: Boolean(shared.idleTimer),
            pendingAudioBytes: Number(shared.pendingAudioBytes || 0),
            pendingAudioChunks: Array.isArray(shared.pendingAudioChunks) ? shared.pendingAudioChunks.length : 0,
            pendingCommitResolvers: Array.isArray(shared.pendingCommitResolvers) ? shared.pendingCommitResolvers.length : 0,
            pendingCommitRequests: Array.isArray(shared.pendingCommitRequests) ? shared.pendingCommitRequests.length : 0,
            transcriptByItemIds: shared.finalTranscriptsByItemId instanceof Map ? shared.finalTranscriptsByItemId.size : 0,
            speakerByItemIds: shared.itemIdToUserId instanceof Map ? shared.itemIdToUserId.size : 0,
            utterance: shared.utterance
              ? {
                partialText: String(shared.utterance.partialText || "").slice(0, 200),
                finalSegments: Array.isArray(shared.utterance.finalSegments) ? shared.utterance.finalSegments.length : 0,
                bytesSent: Number(shared.utterance.bytesSent || 0)
              }
              : null,
            model: String(
              shared.client?.sessionConfig?.inputTranscriptionModel ||
              session.openAiPerUserAsrModel ||
              ""
            ).trim() || null,
            sessionId: shared.client?.sessionId || null
          };
        })(),
        brainTools: (() => {
          const tools = Array.isArray(session.openAiToolDefinitions) ? session.openAiToolDefinitions : [];
          if (!tools.length) return null;
          return tools.map((tool) => ({
            name: String(tool?.name || ""),
            toolType: tool?.toolType === "mcp" ? "mcp" : "function",
            serverName: tool?.serverName || null,
            description: String(tool?.description || "")
          }));
        })(),
        toolCalls: (() => {
          const events = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
          if (!events.length) return null;
          return events.slice(-OPENAI_TOOL_CALL_EVENT_MAX).map((entry) => ({
            callId: String(entry?.callId || ""),
            toolName: String(entry?.toolName || ""),
            toolType: entry?.toolType === "mcp" ? "mcp" : "function",
            arguments: entry?.arguments && typeof entry.arguments === "object" ? entry.arguments : {},
            startedAt: String(entry?.startedAt || ""),
            completedAt: entry?.completedAt ? String(entry.completedAt) : null,
            runtimeMs: Number.isFinite(Number(entry?.runtimeMs)) ? Math.round(Number(entry.runtimeMs)) : null,
            success: Boolean(entry?.success),
            outputSummary: entry?.outputSummary ? String(entry.outputSummary) : null,
            error: entry?.error ? String(entry.error) : null
          }));
        })(),
        mcpStatus: (() => {
          const rows = Array.isArray(session.mcpStatus) ? session.mcpStatus : [];
          if (!rows.length) return null;
          return rows.map((row) => ({
            serverName: String(row?.serverName || ""),
            connected: Boolean(row?.connected),
            tools: Array.isArray(row?.tools)
              ? row.tools.map((tool) => ({
                name: String(tool?.name || ""),
                description: String(tool?.description || "")
              }))
              : [],
            lastError: row?.lastError ? String(row.lastError) : null,
            lastConnectedAt: row?.lastConnectedAt ? String(row.lastConnectedAt) : null,
            lastCallAt: row?.lastCallAt ? String(row.lastCallAt) : null
          }));
        })(),
        music: this.snapshotMusicRuntimeState(session),
        stt: session.mode === "stt_pipeline"
          ? {
            pendingTurns: Number(session.pendingSttTurns || 0),
            contextMessages: modelTurns.length
          }
          : null,
        realtime: isRealtimeMode(session.mode)
          ? {
            provider: session.realtimeProvider || resolveRealtimeProvider(session.mode),
            inputSampleRateHz: Number(session.realtimeInputSampleRateHz) || 24000,
            outputSampleRateHz: Number(session.realtimeOutputSampleRateHz) || 24000,
            recentVoiceTurns: modelTurns.length,
            replySuperseded: Math.max(0, Number(session.realtimeReplySupersededCount || 0)),
            pendingTurns:
              (session.realtimeTurnDrainActive ? 1 : 0) +
              (Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0),
            drainActive: Boolean(session.realtimeTurnDrainActive),
            coalesceActive: Boolean(session.realtimeTurnCoalesceTimer),
            state: session.realtimeClient?.getState?.() || null
          }
          : null,
        latency: (() => {
          const stages = Array.isArray(session.latencyStages) ? session.latencyStages : [];
          if (stages.length === 0) return null;
          const recentTurns = stages.slice(-8).reverse().map((e) => ({
            at: new Date(e.at).toISOString(),
            finalizedToAsrStartMs: e.finalizedToAsrStartMs ?? null,
            asrToGenerationStartMs: e.asrToGenerationStartMs ?? null,
            generationToReplyRequestMs: e.generationToReplyRequestMs ?? null,
            replyRequestToAudioStartMs: e.replyRequestToAudioStartMs ?? null,
            totalMs: e.totalMs ?? null,
            queueWaitMs: e.queueWaitMs ?? null,
            pendingQueueDepth: e.pendingQueueDepth ?? null
          }));
          const avg = (field) => {
            const vals = stages.map((e) => e[field]).filter((v) => Number.isFinite(v) && v >= 0);
            return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
          };
          return {
            recentTurns,
            averages: {
              finalizedToAsrStartMs: avg("finalizedToAsrStartMs"),
              asrToGenerationStartMs: avg("asrToGenerationStartMs"),
              generationToReplyRequestMs: avg("generationToReplyRequestMs"),
              replyRequestToAudioStartMs: avg("replyRequestToAudioStartMs"),
              totalMs: avg("totalMs")
            },
            turnCount: stages.length
          };
        })()
      };
    });

    return {
      activeCount: sessions.length,
      sessions
    };
  }

  async requestJoin({ message, settings, intentConfidence = null }) {
    return await requestJoin(this, { message, settings, intentConfidence });
  }

  async requestLeave({ message, settings, reason = "nl_leave" }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    if (!this.sessions.has(guildId)) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_leave_request",
        reason: "not_in_voice",
        details: {},
        mustNotify: true
      });
      return true;
    }

    await this.endSession({
      guildId,
      reason,
      requestedByUserId: message.author?.id || null,
      announceChannel: message.channel,
      announcement: "aight i'm leaving vc.",
      settings,
      messageId: message.id
    });

    return true;
  }

  async requestStatus({ message, settings }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);
    const requestText = String(message?.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);

    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_status_request",
        reason: "offline",
        details: {},
        mustNotify: true
      });
      return true;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    const remainingSeconds = session.maxEndsAt
      ? Math.max(0, Math.ceil((session.maxEndsAt - Date.now()) / 1000))
      : null;
    const inactivitySeconds = session.inactivityEndsAt
      ? Math.max(0, Math.ceil((session.inactivityEndsAt - Date.now()) / 1000))
      : null;

    await this.sendOperationalMessage({
      channel: message.channel,
      settings: settings || session.settingsSnapshot,
      guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_status_request",
      reason: "online",
      details: {
        voiceChannelId: session.voiceChannelId,
        elapsedSeconds,
        remainingSeconds: remainingSeconds ?? null,
        inactivitySeconds: inactivitySeconds ?? null,
        activeCaptures: session.userCaptures.size,
        streamWatchActive: Boolean(session.streamWatch?.active),
        streamWatchTargetUserId: session.streamWatch?.targetUserId || null,
        musicActive: this.isMusicPlaybackActive(session),
        musicProvider: this.ensureSessionMusicState(session)?.provider || null,
        musicTrackTitle: this.ensureSessionMusicState(session)?.lastTrackTitle || null,
        musicTrackArtists: this.ensureSessionMusicState(session)?.lastTrackArtists || [],
        requestText: requestText || null
      },
      mustNotify: true
    });

    return true;
  }

  ensureSessionMusicState(session) {
    return ensureSessionMusicStateRuntime(this, session);
  }

  ensureVoiceCommandState(session) {
    if (!session || typeof session !== "object") return null;
    const current =
      session.voiceCommandState && typeof session.voiceCommandState === "object"
        ? session.voiceCommandState
        : null;
    if (!current) {
      session.voiceCommandState = null;
      return null;
    }
    const expiresAt = Math.max(0, Number(current.expiresAt || 0));
    if (!expiresAt || expiresAt <= Date.now()) {
      session.voiceCommandState = null;
      return null;
    }
    const next = {
      userId: String(current.userId || "").trim() || null,
      domain: normalizeInlineText(current.domain, 40) || null,
      intent: normalizeInlineText(current.intent, 80) || null,
      startedAt: Math.max(0, Number(current.startedAt || 0)),
      expiresAt
    };
    session.voiceCommandState = next;
    return next;
  }

  beginVoiceCommandSession({
    session,
    userId = null,
    domain = "voice",
    intent = "followup",
    ttlMs = VOICE_COMMAND_SESSION_TTL_MS
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    userId?: string | null;
    domain?: string | null;
    intent?: string | null;
    ttlMs?: number | null;
  } = {}) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return null;
    const now = Date.now();
    const durationMs = clamp(Math.round(Number(ttlMs) || VOICE_COMMAND_SESSION_TTL_MS), 3_000, 120_000);
    const next = {
      userId: normalizedUserId,
      domain: normalizeInlineText(domain, 40) || "voice",
      intent: normalizeInlineText(intent, 80) || "followup",
      startedAt: now,
      expiresAt: now + durationMs
    };
    session.voiceCommandState = next;
    return next;
  }

  clearVoiceCommandSession(session) {
    if (!session || typeof session !== "object") return;
    session.voiceCommandState = null;
  }

  isVoiceCommandSessionActiveForUser(session, userId, { domain = null } = {}) {
    const state = this.ensureVoiceCommandState(session);
    if (!state) return false;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId || state.userId !== normalizedUserId) return false;
    const normalizedDomain = normalizeInlineText(domain, 40);
    if (normalizedDomain && state.domain && state.domain !== normalizedDomain) return false;
    return true;
  }

  resetToolMusicQueueState(session) {
    const queueState = this.ensureToolMusicQueueState(session);
    if (!queueState) return null;
    queueState.tracks = [];
    queueState.nowPlayingIndex = null;
    queueState.isPaused = false;
    return queueState;
  }

  snapshotMusicRuntimeState(session) {
    return snapshotMusicRuntimeStateRuntime(this, session);
  }

  getMusicPromptContext(session): {
    playbackState: "playing" | "paused" | "stopped" | "idle";
    currentTrack: { title: string; artists: string[] } | null;
    lastTrack: { title: string; artists: string[] } | null;
    queueLength: number;
    upcomingTracks: Array<{ title: string; artist: string | null }>;
    lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
    lastQuery: string | null;
  } | null {
    const snapshot = this.snapshotMusicRuntimeState(session);
    if (!snapshot) return null;
    const queueTracks = Array.isArray(snapshot.queueState?.tracks) ? snapshot.queueState.tracks : [];
    const nowPlayingIndex = Number.isInteger(snapshot.queueState?.nowPlayingIndex)
      ? Number(snapshot.queueState?.nowPlayingIndex)
      : null;
    const currentQueueTrack =
      nowPlayingIndex != null && nowPlayingIndex >= 0 && nowPlayingIndex < queueTracks.length
        ? queueTracks[nowPlayingIndex]
        : null;
    const currentTrack = currentQueueTrack?.title
      ? {
        title: currentQueueTrack.title,
        artists: currentQueueTrack.artist ? [currentQueueTrack.artist] : []
      }
      : snapshot.active && snapshot.lastTrackTitle
        ? {
          title: snapshot.lastTrackTitle,
          artists: Array.isArray(snapshot.lastTrackArtists) ? snapshot.lastTrackArtists : []
        }
        : null;
    const lastTrack = snapshot.lastTrackTitle
      ? {
        title: snapshot.lastTrackTitle,
        artists: Array.isArray(snapshot.lastTrackArtists) ? snapshot.lastTrackArtists : []
      }
      : null;
    const upcomingTracks =
      nowPlayingIndex != null && nowPlayingIndex >= 0
        ? queueTracks.slice(nowPlayingIndex + 1)
        : queueTracks;
    let playbackState: "playing" | "paused" | "stopped" | "idle" = "idle";
    if (snapshot.queueState?.isPaused) {
      playbackState = "paused";
    } else if (snapshot.active) {
      playbackState = "playing";
    } else if (snapshot.lastCommandReason && this.describeMusicPromptAction(snapshot.lastCommandReason) === "stop") {
      playbackState = "stopped";
    }
    return {
      playbackState,
      currentTrack,
      lastTrack,
      queueLength: queueTracks.length,
      upcomingTracks: upcomingTracks
        .map((track) => ({
          title: String(track?.title || "").trim(),
          artist: track?.artist ? String(track.artist).trim() : null
        }))
        .filter((track) => track.title)
        .slice(0, 3),
      lastAction: this.describeMusicPromptAction(snapshot.lastCommandReason),
      lastQuery: snapshot.lastQuery || null
    };
  }

  describeMusicPromptAction(reason: unknown): "play_now" | "stop" | "pause" | "resume" | "skip" | null {
    const normalizedReason = String(reason || "")
      .trim()
      .toLowerCase();
    if (!normalizedReason) return null;
    if (normalizedReason.includes("pause")) return "pause";
    if (normalizedReason.includes("resume")) return "resume";
    if (normalizedReason.includes("skip")) return "skip";
    if (normalizedReason.includes("stop") || normalizedReason === "session_end") return "stop";
    if (normalizedReason.includes("play")) return "play_now";
    return null;
  }

  /** Get the current music playback phase (single source of truth). */
  getMusicPhase(session) {
    return getMusicPhaseRuntime(this, session);
  }

  /** Set the music playback phase. ALL state transitions go through this. */
  setMusicPhase(session, phase, pauseReason = null) {
    return setMusicPhaseRuntime(this, session, phase, pauseReason);
  }

  isMusicPlaybackActive(session) {
    return musicPhaseIsActive(this.getMusicPhase(session));
  }

  isCommandOnlyActive(session, settings = null) {
    return isCommandOnlyActiveRuntime(this, session, settings);
  }

  isMusicPlaybackAudible(session) {
    return musicPhaseIsAudible(this.getMusicPhase(session));
  }

  resolveMusicDuckingConfig(settings = null) {
    return resolveMusicDuckingConfigRuntime(this, settings);
  }

  clearBotSpeechMusicUnduckTimer(session) {
    return clearBotSpeechMusicUnduckTimerRuntime(this, session);
  }

  async engageBotSpeechMusicDuck(session, settings = null, { awaitFade = false } = {}) {
    return engageBotSpeechMusicDuckRuntime(this, session, settings, { awaitFade });
  }

  scheduleBotSpeechMusicUnduck(session, settings = null, delayMs = BOT_TURN_SILENCE_RESET_MS) {
    return scheduleBotSpeechMusicUnduckRuntime(this, session, settings, delayMs);
  }

  async releaseBotSpeechMusicDuck(session, settings = null, { force = false } = {}) {
    return releaseBotSpeechMusicDuckRuntime(this, session, settings, { force });
  }


  isAsrActive(session, settings = null) {
    const resolved = settings || session?.settingsSnapshot || this.store.getSettings();
    if (!getVoiceTranscriptionSettings(resolved).enabled) return false;
    if (getVoiceConversationPolicy(resolved).textOnlyMode) return false;
    // PCM capture stays open during music — the music gate downstream
    // (maybeHandleMusicPlaybackTurn) decides which turns to act on vs swallow.
    return true;
  }

  normalizeMusicPlatformToken(value: unknown = "", fallback: "youtube" | "soundcloud" | "discord" | "auto" | null = null) {
    return normalizeMusicPlatformTokenRuntime(this, value, fallback);
  }

  normalizeMusicSelectionResult(rawResult: Record<string, unknown> | null = null): MusicSelectionResult | null {
    return normalizeMusicSelectionResultRuntime(this, rawResult);
  }

  isMusicDisambiguationActive(musicState = null) {
    return isMusicDisambiguationActiveRuntime(this, musicState);
  }

  clearMusicDisambiguationState(session) {
    return clearMusicDisambiguationStateRuntime(this, session);
  }

  setMusicDisambiguationState({
    session,
    query = "",
    platform = "auto",
    action = "play_now",
    results = [],
    requestedByUserId = null
  }: MusicDisambiguationPayload = {}) {
    return setMusicDisambiguationStateRuntime(this, {
      session,
      query,
      platform,
      action,
      results,
      requestedByUserId
    });
  }

  findPendingMusicSelectionById(session, selectedResultId = "") {
    return findPendingMusicSelectionByIdRuntime(this, session, selectedResultId);
  }

  getMusicDisambiguationPromptContext(session): {
    active: true;
    query: string | null;
    platform: "youtube" | "soundcloud" | "discord" | "auto";
    action: "play_now" | "queue_next" | "queue_add";
    requestedByUserId: string | null;
    options: MusicSelectionResult[];
  } | null {
    return getMusicDisambiguationPromptContextRuntime(this, session);
  }

  ensureToolMusicQueueState(session) {
    return ensureToolMusicQueueStateRuntime(this, session);
  }

  hasBotNameCueForTranscript({ transcript = "", settings = null } = {}) {
    const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;

    const resolvedSettings = settings || this.store.getSettings();
    const botName = getPromptBotName(resolvedSettings);
    const aliases = getBotNameAliases(resolvedSettings);
    const primaryToken = String(botName || "")
      .replace(/[^a-z0-9\s]+/gi, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .at(0) || "";
    const shortPrimaryToken = primaryToken.length >= 5 ? primaryToken.slice(0, 5) : "";
    const candidateNames = [
      botName,
      ...aliases,
      primaryToken,
      shortPrimaryToken
    ]
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);

    for (const candidate of candidateNames) {
      if (hasBotNameCue({ transcript: normalizedTranscript, botName: candidate })) {
        return true;
      }
    }
    return false;
  }

  isLikelyMusicStopPhrase({ transcript = "", settings = null } = {}) {
    return isLikelyMusicStopPhraseFallback(this, { transcript, settings });
  }

  isLikelyMusicPlayPhrase({ transcript = "", settings = null } = {}) {
    return isLikelyMusicPlayPhraseFallback(this, { transcript, settings });
  }

  extractMusicPlayQuery(transcript = "") {
    return extractMusicPlayQueryFallback(this, transcript);
  }

  haltSessionOutputForMusicPlayback(session, reason = "music_playback_started") {
    return haltSessionOutputForMusicPlaybackRuntime(this, session, reason);
  }

  async requestPlayMusic({
    message = null,
    guildId = null,
    channel = null,
    channelId = null,
    requestedByUserId = null,
    settings = null,
    query = "",
    trackId = null,
    platform = "auto",
    action = "play_now",
    searchResults = null,
    reason = "nl_play_music",
    source = "text_voice_intent",
    mustNotify = true
  } = {}) {
    return await requestPlayMusicRuntime(this, {
      message,
      guildId,
      channel,
      channelId,
      requestedByUserId,
      settings,
      query,
      trackId,
      platform,
      action,
      searchResults,
      reason,
      source,
      mustNotify
    });
  }

  async playMusicViaDiscord(session: any, track: { id: string; title: string; artist: string; platform: string; externalUrl: string | null }) {
    return await playMusicViaDiscordRuntime(this, session, track);
  }

  async requestStopMusic({
    message = null,
    guildId = null,
    channel = null,
    channelId = null,
    requestedByUserId = null,
    settings = null,
    reason = "nl_stop_music",
    source = "text_voice_intent",
    requestText = "",
    clearQueue = false,
    mustNotify = true
  } = {}) {
    return await requestStopMusicRuntime(this, {
      message,
      guildId,
      channel,
      channelId,
      requestedByUserId,
      settings,
      reason,
      source,
      requestText,
      clearQueue,
      mustNotify
    });
  }

  async requestPauseMusic({
    message = null,
    guildId = null,
    channel = null,
    channelId = null,
    requestedByUserId = null,
    settings = null,
    reason = "nl_pause_music",
    source = "text_voice_intent",
    requestText = "",
    mustNotify = true
  }: {
    message?: MusicTextCommandMessage | null;
    guildId?: string | null;
    channel?: unknown;
    channelId?: string | null;
    requestedByUserId?: string | null;
    settings?: Record<string, unknown> | null;
    reason?: string;
    source?: string;
    requestText?: string;
    mustNotify?: boolean;
  } = {}) {
    return await requestPauseMusicRuntime(this, {
      message,
      guildId,
      channel,
      channelId,
      requestedByUserId,
      settings,
      reason,
      source,
      requestText,
      mustNotify
    });
  }

  async maybeHandleMusicTextSelectionRequest({
    message = null,
    settings = null
  }: MusicTextRequestPayload = {}) {
    return await maybeHandleMusicTextSelectionRequestRuntime(this, {
      message,
      settings
    });
  }

  hasPendingMusicDisambiguationForUser(session, userId = null) {
    const disambiguation = this.getMusicDisambiguationPromptContext(session);
    if (!disambiguation?.active) return false;
    const normalizedUserId = String(userId || "").trim();
    const requestedByUserId = String(disambiguation.requestedByUserId || "").trim();
    if (!normalizedUserId || !requestedByUserId) return false;
    return normalizedUserId === requestedByUserId;
  }

  isMusicDisambiguationResolutionTurn(session, userId = null, transcript = "") {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    if (!this.hasPendingMusicDisambiguationForUser(session, normalizedUserId)) {
      return false;
    }
    if (!this.isVoiceCommandSessionActiveForUser(session, normalizedUserId, { domain: "music" })) {
      return false;
    }
    const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!text) return false;
    if (/^(?:cancel|nevermind|never mind|nvm|forget it)$/i.test(text)) {
      return true;
    }
    return Boolean(this.resolvePendingMusicDisambiguationSelection(session, text));
  }

  resolvePendingMusicDisambiguationSelection(session, transcript = "") {
    const disambiguation = this.getMusicDisambiguationPromptContext(session);
    if (!disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
      return null;
    }
    const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!text) return null;
    const normalizedText = text.toLowerCase();
    const options = disambiguation.options;
    const parsedIndex = Number.parseInt(text, 10);
    if (Number.isFinite(parsedIndex) && String(parsedIndex) === text && parsedIndex >= 1) {
      return options[parsedIndex - 1] || null;
    }
    const ordinalIndexByToken = new Map<string, number>([
      ["first", 0],
      ["1st", 0],
      ["second", 1],
      ["2nd", 1],
      ["third", 2],
      ["3rd", 2],
      ["fourth", 3],
      ["4th", 3],
      ["fifth", 4],
      ["5th", 4]
    ]);
    for (const [token, optionIndex] of ordinalIndexByToken.entries()) {
      if (normalizedText.includes(token)) {
        return options[optionIndex] || null;
      }
    }

    const cleanedSelectionText = normalizedText
      .replace(/\b(?:the|one|version|song|track|by|please|plz|uh|um|like)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return options.find((entry) => {
      const idToken = String(entry?.id || "").trim().toLowerCase();
      if (idToken && normalizedText === idToken) return true;
      const artistToken = String(entry?.artist || "").trim().toLowerCase();
      const titleToken = String(entry?.title || "").trim().toLowerCase();
      const combined = `${titleToken} ${artistToken}`.trim();
      if (cleanedSelectionText && combined.includes(cleanedSelectionText)) return true;
      if (cleanedSelectionText && artistToken && cleanedSelectionText.includes(artistToken)) return true;
      if (cleanedSelectionText && titleToken && cleanedSelectionText.includes(titleToken)) return true;
      return false;
    }) || null;
  }

  async completePendingMusicDisambiguationSelection({
    session,
    settings,
    userId = null,
    selected,
    reason = "voice_music_disambiguation_selection",
    source = "voice_disambiguation",
    channel = null,
    channelId = null,
    messageId = null,
    mustNotify = false
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: Record<string, unknown> | null;
    userId?: string | null;
    selected?: MusicSelectionResult | null;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  } = {}) {
    const disambiguation = this.getMusicDisambiguationPromptContext(session);
    if (!session || !disambiguation?.active || !selected) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const normalizedUserId = String(userId || "").trim() || null;
    const action = disambiguation.action || "play_now";
    if (action === "play_now") {
      await this.requestPlayMusic({
        guildId: session.guildId,
        channel,
        channelId: channelId || session.textChannelId || null,
        requestedByUserId: normalizedUserId,
        settings: resolvedSettings,
        query: disambiguation.query || "",
        platform: disambiguation.platform || "auto",
        trackId: selected.id,
        searchResults: disambiguation.options,
        reason,
        source,
        mustNotify
      });
      return true;
    }

    const runtimeSession = this.ensureSessionToolRuntimeState(session);
    const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
      ? runtimeSession.toolMusicTrackCatalog
      : new Map();
    if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
      runtimeSession.toolMusicTrackCatalog = catalog;
    }
    catalog.set(selected.id, selected);
    this.clearMusicDisambiguationState(session);
    if (action === "queue_next") {
      await this.executeVoiceMusicQueueNextTool({
        session,
        settings: resolvedSettings,
        args: {
          tracks: [selected.id]
        }
      });
    } else {
      await this.executeVoiceMusicQueueAddTool({
        session,
        settings: resolvedSettings,
        args: {
          tracks: [selected.id],
          position: "end"
        }
      });
    }
    this.clearVoiceCommandSession(session);
    await this.sendOperationalMessage({
      channel,
      settings: resolvedSettings,
      guildId: session.guildId,
      channelId: channelId || session.textChannelId || null,
      userId: normalizedUserId,
      messageId,
      event: "voice_music_request",
      reason: action === "queue_next" ? "queued_next" : "queued",
      details: {
        source,
        query: disambiguation.query || null,
        trackId: selected.id,
        trackTitle: selected.title,
        trackArtists: selected.artist ? [selected.artist] : []
      },
      mustNotify
    });
    return true;
  }

  async maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings,
    userId = null,
    transcript = "",
    reason = "voice_music_disambiguation_selection",
    source = "voice_disambiguation",
    channel = null,
    channelId = null,
    messageId = null,
    mustNotify = false
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: Record<string, unknown> | null;
    userId?: string | null;
    transcript?: string;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  } = {}) {
    const disambiguation = this.getMusicDisambiguationPromptContext(session);
    if (!session || !disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
      return false;
    }
    const normalizedUserId = String(userId || "").trim();
    const requestedByUserId = String(disambiguation.requestedByUserId || "").trim();
    if (!normalizedUserId) {
      return false;
    }
    if (requestedByUserId && normalizedUserId !== requestedByUserId) {
      return false;
    }
    const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!text) return false;
    if (/^(?:cancel|nevermind|never mind|nvm|forget it)$/i.test(text)) {
      this.clearMusicDisambiguationState(session);
      this.clearVoiceCommandSession(session);
      await this.sendOperationalMessage({
        channel,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        guildId: session.guildId,
        channelId: channelId || session.textChannelId || null,
        userId: normalizedUserId,
        messageId,
        event: "voice_music_request",
        reason: "disambiguation_cancelled",
        details: {
          source,
          requestText: text
        },
        mustNotify
      });
      return true;
    }

    const selected = this.resolvePendingMusicDisambiguationSelection(session, text);
    if (!selected) return false;
    return await this.completePendingMusicDisambiguationSelection({
      session,
      settings,
      userId: normalizedUserId,
      selected,
      reason,
      source,
      channel,
      channelId,
      messageId,
      mustNotify
    });
  }

  async maybeHandleMusicTextStopRequest({
    message = null,
    settings = null
  }: MusicTextRequestPayload = {}) {
    return await maybeHandleMusicTextStopRequestRuntime(this, {
      message,
      settings
    });
  }



  async maybeHandleMusicPlaybackTurn({
    session,
    settings,
    userId,
    pcmBuffer,
    captureReason = "stream_end",
    source = "voice_turn",
    transcript = undefined as string | undefined
  }) {
    return await maybeHandleMusicPlaybackTurnRuntime(this, {
      session,
      settings,
      userId,
      pcmBuffer,
      captureReason,
      source,
      transcript
    });
  }

  async requestWatchStream({ message, settings, targetUserId = null }) {
    return await requestWatchStream(this, { message, settings, targetUserId });
  }

  initializeStreamWatchState({ session, requesterUserId, targetUserId = null }) {
    return initializeStreamWatchState(this, { session, requesterUserId, targetUserId });
  }

  supportsStreamWatchCommentary(session, settings = null) {
    return supportsStreamWatchCommentary(this, session, settings);
  }

  supportsVisionFallbackStreamWatchCommentary({ session = null, settings = null } = {}) {
    return supportsVisionFallbackStreamWatchCommentary(this, { session, settings });
  }

  supportsStreamWatchBrainContext({ session = null, settings = null } = {}) {
    return supportsStreamWatchBrainContext(this, { session, settings });
  }

  resolveStreamWatchVisionProviderSettings(settings = null) {
    return resolveStreamWatchVisionProviderSettings(this, settings);
  }

  getStreamWatchBrainContextForPrompt(session, settings = null) {
    return getStreamWatchBrainContextForPrompt(session, settings);
  }

  async generateVisionFallbackStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    frameMimeType = "image/jpeg",
    frameDataBase64 = ""
  }) {
    return await generateVisionFallbackStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      frameMimeType,
      frameDataBase64
    });
  }

  isUserInSessionVoiceChannel({ session, userId }) {
    return isUserInSessionVoiceChannel(this, { session, userId });
  }

  async enableWatchStreamForUser({
    guildId,
    requesterUserId,
    targetUserId = null,
    settings = null,
    source = "screen_share_link"
  }) {
    return await enableWatchStreamForUser(this, {
      guildId,
      requesterUserId,
      targetUserId,
      settings,
      source
    });
  }

  async requestStopWatchingStream({ message, settings }) {
    return await requestStopWatchingStream(this, { message, settings });
  }

  async stopWatchStreamForUser({
    guildId,
    requesterUserId = null,
    targetUserId = null,
    settings = null,
    reason = "screen_share_session_stopped"
  }) {
    return await stopWatchStreamForUser(this, {
      guildId,
      requesterUserId,
      targetUserId,
      settings,
      reason
    });
  }

  async requestStreamWatchStatus({ message, settings }) {
    return await requestStreamWatchStatus(this, { message, settings });
  }

  async ingestStreamFrame({
    guildId,
    streamerUserId = null,
    mimeType = "image/jpeg",
    dataBase64 = "",
    source = "api_stream_ingest",
    settings = null
  }) {
    return await ingestStreamFrame(this, {
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings
    });
  }

  async maybeTriggerStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest"
  }) {
    return await maybeTriggerStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      source
    });
  }

  async maybeTriggerAssistantDirectedSoundboard({
    session,
    settings,
    userId = null,
    transcript = "",
    requestedRef = "",
    source = "voice_transcript"
  }) {
    if (!session || session.ending) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (!resolvedSettings?.voice?.soundboard?.enabled) return;
    const normalizedRef = String(requestedRef || "").trim().slice(0, 180);
    if (!normalizedRef) return;

    const normalizedTranscript = normalizeVoiceText(transcript, SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS);
    session.soundboard = session.soundboard || {
      playCount: 0,
      lastPlayedAt: 0,
      catalogCandidates: [],
      catalogFetchedAt: 0,
      lastDirectiveKey: "",
      lastDirectiveAt: 0
    };

    const directiveKey = [
      String(source || "voice_transcript").trim().toLowerCase(),
      normalizedRef.toLowerCase(),
      String(normalizedTranscript || "").trim().toLowerCase()
    ].join("|");
    const now = Date.now();
    if (
      directiveKey &&
      directiveKey === String(session.soundboard.lastDirectiveKey || "") &&
      now - Number(session.soundboard.lastDirectiveAt || 0) < 6_000
    ) {
      return;
    }
    session.soundboard.lastDirectiveKey = directiveKey;
    session.soundboard.lastDirectiveAt = now;

    const candidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings: resolvedSettings
    });
    const candidates = Array.isArray(candidateInfo?.candidates) ? candidateInfo.candidates : [];
    const candidateSource = String(candidateInfo?.source || "none");
    const byReference = matchSoundboardReference(candidates, normalizedRef);
    const byMention = byReference ? null : findMentionedSoundboardReference(candidates, normalizedRef);
    const byName =
      byReference || byMention
        ? null
        : candidates.find((entry) => String(entry?.name || "").trim().toLowerCase() === normalizedRef.toLowerCase()) ||
        candidates.find((entry) =>
          String(entry?.name || "")
            .trim()
            .toLowerCase()
            .includes(normalizedRef.toLowerCase())
        );
    const matched = byReference || byMention || byName || null;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: "voice_soundboard_directive_decision",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        candidateCount: candidates.length,
        candidateSource,
        matchedReference: matched?.reference || null
      }
    });

    if (!matched) return;

    const result = await this.soundboardDirector.play({
      session,
      settings: resolvedSettings,
      soundId: matched.soundId,
      sourceGuildId: matched.sourceGuildId,
      reason: `assistant_directive_${String(source || "voice_transcript").slice(0, 50)}`
    });

    this.store.logAction({
      kind: result.ok ? "voice_runtime" : "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: result.ok ? "voice_soundboard_directive_played" : "voice_soundboard_directive_failed",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        soundId: matched.soundId,
        sourceGuildId: matched.sourceGuildId,
        reason: result.reason || null,
        error: result.ok ? null : shortError(result.message || "")
      }
    });
  }

  async resolveSoundboardCandidates({ session = null, settings, guild = null }) {
    const preferred = parsePreferredSoundboardReferences(getVoiceSoundboardSettings(settings).preferredSoundIds);
    if (preferred.length) {
      return {
        source: "preferred",
        candidates: preferred.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    const guildCandidates = await this.fetchGuildSoundboardCandidates({
      session,
      guild
    });
    if (guildCandidates.length) {
      return {
        source: "guild_catalog",
        candidates: guildCandidates.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    return {
      source: "none",
      candidates: []
    };
  }

  async fetchGuildSoundboardCandidates({ session = null, guild = null }) {
    if (session && session.ending) return [];
    const now = Date.now();

    let cached = [];
    if (session) {
      session.soundboard = session.soundboard || {
        playCount: 0,
        lastPlayedAt: 0,
        catalogCandidates: [],
        catalogFetchedAt: 0,
        lastDirectiveKey: "",
        lastDirectiveAt: 0
      };
      cached = Array.isArray(session.soundboard.catalogCandidates)
        ? session.soundboard.catalogCandidates.filter(Boolean)
        : [];
      const lastFetchedAt = Number(session.soundboard.catalogFetchedAt || 0);
      if (lastFetchedAt > 0 && now - lastFetchedAt < SOUNDBOARD_CATALOG_REFRESH_MS) {
        return cached;
      }
    }

    const resolvedGuild = guild || this.client.guilds.cache.get(String(session?.guildId || ""));
    if (!resolvedGuild?.soundboardSounds?.fetch) {
      return cached || [];
    }

    try {
      const fetched = await resolvedGuild.soundboardSounds.fetch();
      const candidates = [];
      fetched.forEach((sound) => {
        if (!sound || sound.available === false) return;
        const soundId = String(sound.soundId || "").trim();
        if (!soundId) return;
        const name = String(sound.name || "").trim();
        candidates.push({
          soundId,
          sourceGuildId: null,
          reference: soundId,
          name: name || null,
          origin: "guild_catalog"
        });
      });

      const deduped = dedupeSoundboardCandidates(candidates).slice(0, SOUNDBOARD_MAX_CANDIDATES);
      if (session?.soundboard) {
        session.soundboard.catalogCandidates = deduped;
        session.soundboard.catalogFetchedAt = now;
      }
      return deduped;
    } catch (error) {
      if (session) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `voice_soundboard_catalog_fetch_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        session.soundboard.catalogFetchedAt = now;
      }
      return cached || [];
    }
  }

  async stopAll(reason = "shutdown") {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) {
      await this.endSession({ guildId, reason, announcement: null });
    }
  }

  async dispose(reason = "shutdown") {
    if (this.onVoiceStateUpdate) {
      this.client.off("voiceStateUpdate", this.onVoiceStateUpdate);
      this.onVoiceStateUpdate = null;
    }

    await this.stopAll(reason);
    this.pendingSessionGuildIds.clear();
    this.joinLocks.clear();
  }

  async withJoinLock(guildId, fn) {
    const key = String(guildId || "");
    if (!key) return await fn();

    const previous = this.joinLocks.get(key) || Promise.resolve();
    let release = null;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.joinLocks.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      if (typeof release === "function") {
        release();
      }
      if (this.joinLocks.get(key) === current) {
        this.joinLocks.delete(key);
      }
    }
  }

  async reconcileSettings(settings) {
    return this.sessionLifecycle.reconcileSettings(settings);
  }

  touchActivity(guildId, settings) {
    return this.sessionLifecycle.touchActivity(guildId, settings);
  }

  getDeferredOutputChannelBlockReason(session): OutputChannelState["deferredBlockReason"] {
    return this.deferredActionQueue.getDeferredOutputChannelBlockReason(session);
  }

  getDeferredQueuedUserTurns(session): DeferredQueuedUserTurn[] {
    return this.deferredActionQueue.getDeferredQueuedUserTurns(session);
  }

  /**
   * Generic gating check shared by all deferred action types.
   * Returns null if the action can fire, or a block-reason string if not.
   *
   * Covers: session validity, expiry, notBeforeAt floor, and output channel
   * clear (captures, pendingResponse, active response, tool calls).
   */
  canFireDeferredAction(session, action: DeferredVoiceAction | null): string | null {
    return this.deferredActionQueue.canFireDeferredAction(session, action);
  }

  normalizeReplyInterruptionPolicy(rawPolicy = null) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : null;
    if (!policy) return null;

    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(policy.talkingTo || "");
    const scopeRaw = String(policy.scope || "")
      .trim()
      .toLowerCase();
    const scope = scopeRaw === "none" || scopeRaw === "all" || normalizedTalkingTo === "ALL" ? "none" : "speaker";
    const allowedUserId = String(policy.allowedUserId || "").trim() || null;
    const assertive =
      policy.assertive === undefined
        ? scope === "none" || Boolean(allowedUserId)
        : Boolean(policy.assertive);
    if (!assertive) return null;
    if (scope === "speaker" && !allowedUserId) return null;

    const normalizedReason =
      String(policy.reason || "")
        .replace(/\s+/g, "_")
        .trim()
        .toLowerCase()
        .slice(0, 80) || null;
    const normalizedSource =
      String(policy.source || "")
        .replace(/\s+/g, "_")
        .trim()
        .toLowerCase()
        .slice(0, 80) || null;

    return {
      assertive: true,
      scope,
      allowedUserId: scope === "none" ? null : allowedUserId,
      talkingTo: normalizedTalkingTo || null,
      reason: normalizedReason,
      source: normalizedSource
    };
  }

  buildReplyInterruptionPolicy({
    session = null,
    userId = null,
    directAddressed = false,
    conversationContext = null,
    generatedVoiceAddressing = null,
    source = "realtime"
  } = {}) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(generatedVoiceAddressing?.talkingTo || "");
    const targetsAll = normalizedTalkingTo === "ALL";
    const engagedWithCurrentSpeaker = Boolean(conversationContext?.engagedWithCurrentSpeaker);
    const assertive = Boolean(directAddressed) || engagedWithCurrentSpeaker || targetsAll;
    if (!assertive) return null;

    const scope = targetsAll ? "none" : "speaker";
    const reason = targetsAll
      ? "assistant_target_all"
      : directAddressed
        ? "direct_addressed"
        : engagedWithCurrentSpeaker
          ? "engaged_continuation"
          : "assertive_reply";

    return this.normalizeReplyInterruptionPolicy({
      assertive: true,
      scope,
      allowedUserId: scope === "speaker" ? normalizedUserId : null,
      talkingTo: normalizedTalkingTo || null,
      reason,
      source
    });
  }

  isUserAllowedToInterruptReply({
    policy = null,
    userId = null
  } = {}) {
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(policy);
    if (!normalizedPolicy?.assertive) return true;
    if (normalizedPolicy.scope === "none") return false;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    return normalizedUserId === String(normalizedPolicy.allowedUserId || "");
  }

  setActiveReplyInterruptionPolicy(session, policy = null) {
    if (!session) return;
    session.activeReplyInterruptionPolicy = this.normalizeReplyInterruptionPolicy(policy);
  }

  maybeClearActiveReplyInterruptionPolicy(session) {
    if (!session || session.ending) return;
    const outputChannelState = this.getOutputChannelState(session);
    if (outputChannelState.locked) return;
    session.activeReplyInterruptionPolicy = null;
  }

  hasCaptureBeenPromoted(capture) {
    return Math.max(0, Number(capture?.promotedAt || 0)) > 0;
  }

  hasCaptureServerVadSpeech({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    const normalizedUserId = String(capture.userId || "").trim();
    const utteranceId = Math.max(0, Number(capture.asrUtteranceId || 0));
    if (!normalizedUserId || !utteranceId) return false;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId: normalizedUserId
    });
    if (!asrState || typeof asrState !== "object") return false;
    return (
      Math.max(0, Number(asrState.speechDetectedUtteranceId || 0)) === utteranceId &&
      Math.max(0, Number(asrState.speechDetectedAt || 0)) > 0
    );
  }

  resolveCaptureTurnPromotionReason({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return null;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minPromotionBytes = Math.max(
      2,
      Math.ceil((sampleRateHz * 2 * VOICE_TURN_PROMOTION_MIN_CLIP_MS) / 1000)
    );
    if (Math.max(0, Number(capture.bytesSent || 0)) < minPromotionBytes) return null;

    const signal = this.bargeInController.getCaptureSignalMetrics(capture);
    if (signal.sampleCount <= 0) return null;

    const serverVadConfirmed = this.hasCaptureServerVadSpeech({ session, capture });
    if (
      serverVadConfirmed &&
      signal.activeSampleRatio >= VOICE_TURN_PROMOTION_ACTIVE_RATIO_MIN &&
      signal.peak >= VOICE_TURN_PROMOTION_PEAK_MIN
    ) {
      return "server_vad_confirmed";
    }

    if (
      signal.activeSampleRatio >= VOICE_TURN_PROMOTION_STRONG_LOCAL_ACTIVE_RATIO_MIN &&
      signal.peak >= VOICE_TURN_PROMOTION_STRONG_LOCAL_PEAK_MIN &&
      signal.rms >= VOICE_TURN_PROMOTION_STRONG_LOCAL_RMS_MIN
    ) {
      return "strong_local_audio";
    }

    return null;
  }

  isCaptureEligibleForTurnPromotion({ session, capture }) {
    return this.resolveCaptureTurnPromotionReason({ session, capture }) !== null;
  }

  isCaptureConfirmedLiveSpeech({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    if (!this.hasCaptureBeenPromoted(capture)) return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minSpeechBytes = Math.max(
      2,
      Math.ceil((sampleRateHz * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000)
    );
    if (Number(capture.bytesSent || 0) < minSpeechBytes) return false;
    return this.bargeInController.isCaptureSignalAssertive(capture);
  }

  isCaptureBlockingDeferredReplay({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    const bytesSent = Math.max(0, Number(capture.bytesSent || 0));
    const signalSampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (!capture.speakingEndFinalizeTimer && bytesSent <= 0 && signalSampleCount <= 0) {
      return true;
    }
    if (!this.hasCaptureBeenPromoted(capture)) return false;
    return this.isCaptureConfirmedLiveSpeech({ session, capture });
  }

  hasReplayBlockingActiveCapture(session) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) {
      return false;
    }
    for (const capture of session.userCaptures.values()) {
      if (this.isCaptureBlockingDeferredReplay({ session, capture })) {
        return true;
      }
    }
    return false;
  }

  summarizeRealtimeInterruptingLiveCaptures({
    session = null,
    promotedAfterMs = 0
  } = {}) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) {
      return {
        livePromotedCaptureCount: 0,
        oldestPromotedAt: null,
        newestPromotedAt: null
      };
    }

    const promotedAfter = Math.max(0, Number(promotedAfterMs || 0));
    let livePromotedCaptureCount = 0;
    let oldestPromotedAt = Number.POSITIVE_INFINITY;
    let newestPromotedAt = 0;

    for (const capture of session.userCaptures.values()) {
      if (!this.hasCaptureBeenPromoted(capture)) continue;
      if (!this.isCaptureConfirmedLiveSpeech({ session, capture })) continue;
      const promotedAt = Math.max(0, Number(capture?.promotedAt || capture?.startedAt || 0));
      if (promotedAfter > 0 && promotedAt > 0 && promotedAt <= promotedAfter) {
        continue;
      }
      livePromotedCaptureCount += 1;
      if (promotedAt > 0 && promotedAt < oldestPromotedAt) {
        oldestPromotedAt = promotedAt;
      }
      if (promotedAt > newestPromotedAt) {
        newestPromotedAt = promotedAt;
      }
    }

    return {
      livePromotedCaptureCount,
      oldestPromotedAt: Number.isFinite(oldestPromotedAt)
        ? Math.max(0, Math.round(oldestPromotedAt))
        : null,
      newestPromotedAt: newestPromotedAt > 0
        ? Math.max(0, Math.round(newestPromotedAt))
        : null
    };
  }

  cancelPendingSystemSpeechForUserSpeech({
    session = null,
    userId = null,
    captureState = null,
    source = "capture_promoted",
    now = Date.now()
  } = {}) {
    if (!session || session.ending) return false;
    const pending = session.pendingResponse && typeof session.pendingResponse === "object"
      ? session.pendingResponse
      : null;
    const pendingOpportunityType = resolveSystemSpeechOpportunityType(pending?.source);
    if (!pending || !shouldCancelSystemSpeechBeforeAudioOnPromotedUserSpeech(pending.source)) return false;
    if (this.replyManager.pendingResponseHasAudio(session, pending)) return false;

    const signal = this.bargeInController.getCaptureSignalMetrics(captureState);
    const cancelTelemetry = this.cancelRealtimeResponseForBargeIn(session);
    this.replyManager.clearPendingResponse(session);
    this.maybeClearActiveReplyInterruptionPolicy(session);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || null,
      content: "voice_system_speech_cancelled_for_user_speech",
      metadata: {
        sessionId: session.id,
        opportunityType: pendingOpportunityType,
        source: String(source || "capture_promoted"),
        pendingSource: String(pending.source || SYSTEM_SPEECH_SOURCE.JOIN_GREETING),
        pendingRequestId: Number(pending.requestId || 0) || null,
        captureStartedAt: Math.max(0, Number(captureState?.startedAt || 0)) || null,
        capturePromotedAt: Math.max(0, Number(captureState?.promotedAt || now)) || null,
        captureBytes: Math.max(0, Number(captureState?.bytesSent || 0)),
        capturePeak: signal.peak,
        captureRms: signal.rms,
        captureActiveSampleRatio: signal.activeSampleRatio,
        ...cancelTelemetry
      }
    });
    return true;
  }

  findAssertiveInboundCaptureUserId(session, interruptionPolicy = null) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) return null;
    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicy);
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));

    for (const [captureUserId, capture] of session.userCaptures.entries()) {
      if (!capture || typeof capture !== "object") continue;
      const normalizedCaptureUserId = String(capture.userId || captureUserId || "").trim();
      if (!normalizedCaptureUserId) continue;
      if (capture.speakingEndFinalizeTimer) continue;
      if (Number(capture.bytesSent || 0) < minCaptureBytes) continue;
      if (!this.bargeInController.isCaptureSignalAssertive(capture)) continue;
      if (
        !this.isUserAllowedToInterruptReply({
          policy: normalizedInterruptionPolicy,
          userId: normalizedCaptureUserId
        })
      ) {
        continue;
      }
      return normalizedCaptureUserId;
    }
    return null;
  }

  hasAssertiveInboundCapture(session, interruptionPolicy = null) {
    return Boolean(this.findAssertiveInboundCaptureUserId(session, interruptionPolicy));
  }

  cancelRealtimeResponseForBargeIn(session) {
    let responseCancelAttempted = false;
    let responseCancelSucceeded = false;
    let responseCancelError = null;
    let truncateAttempted = false;
    let truncateSucceeded = false;
    let truncateError = null;
    let truncateItemId = null;
    let truncateContentIndex = 0;
    let truncateAudioEndMs = 0;

    const cancelActiveResponse = session.realtimeClient?.cancelActiveResponse;
    if (typeof cancelActiveResponse === "function") {
      responseCancelAttempted = true;
      try {
        responseCancelSucceeded = Boolean(cancelActiveResponse.call(session.realtimeClient));
      } catch (error) {
        responseCancelError = shortError(error);
      }
    }

    const truncateConversationItem = session.realtimeClient?.truncateConversationItem;
    if (isRealtimeMode(session.mode) && typeof truncateConversationItem === "function") {
      const latestItemId = String(session.lastOpenAiAssistantAudioItemId || "").trim();
      if (latestItemId) {
        truncateAttempted = true;
        truncateItemId = latestItemId;
        truncateContentIndex = Math.max(0, Number(session.lastOpenAiAssistantAudioItemContentIndex || 0));
        const estimatedReceivedMs = Math.max(0, Number(session.lastOpenAiAssistantAudioItemReceivedMs || 0));
        const estimatedUnplayedMs = this.estimateDiscordPcmPlaybackDurationMs(0);
        truncateAudioEndMs = Math.max(0, Math.round(estimatedReceivedMs - estimatedUnplayedMs));
        try {
          truncateSucceeded = Boolean(
            truncateConversationItem.call(session.realtimeClient, {
              itemId: latestItemId,
              contentIndex: truncateContentIndex,
              audioEndMs: truncateAudioEndMs
            })
          );
        } catch (error) {
          truncateError = shortError(error);
        }
      }
    }

    return {
      responseCancelAttempted,
      responseCancelSucceeded,
      responseCancelError,
      truncateAttempted,
      truncateSucceeded,
      truncateError,
      truncateItemId,
      truncateContentIndex,
      truncateAudioEndMs
    };
  }

  interruptBotSpeechForBargeIn({
    session,
    userId = null,
    source = "speaking_start",
    minCaptureBytes = 0,
    captureState = null
  }) {
    const command = this.bargeInController.buildInterruptBotSpeechForBargeInCommand({
      session,
      userId,
      source,
      minCaptureBytes,
      captureState
    });
    if (!command) return false;
    return this.executeBargeInInterruptCommand({ session, command });
  }

  executeBargeInInterruptCommand({ session, command }) {
    if (!session || session.ending || !command) return false;
    const cancelTelemetry = this.cancelRealtimeResponseForBargeIn(session);

    this.replyManager.resetBotAudioPlayback(session);
    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
      session.botTurnResetTimer = null;
    }
    session.botTurnOpen = false;
    session.botTurnOpenAt = 0;
    this.replyManager.syncAssistantOutputState(session, "barge_in_interrupt");

    // Unduck music immediately on barge-in so the user hears it while speaking.
    const resolvedSettings = session.settingsSnapshot || this.store.getSettings();
    this.releaseBotSpeechMusicDuck(session, resolvedSettings, { force: true }).catch((error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_music_unduck_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: "barge_in_interrupt"
        }
      });
    });

    if (session.pendingResponse && typeof session.pendingResponse === "object") {
      session.lastAudioDeltaAt = Math.max(Number(session.lastAudioDeltaAt || 0), command.now);
      session.pendingResponse.audioReceivedAt = Number(session.lastAudioDeltaAt || command.now);
    }

    // Only queue a retry and set full suppression if the response was
    // actually cancelled. If the cancel failed, the response already
    // completed — there's nothing to retry and we should not suppress
    // the follow-up audio (which would be a new legitimate response).
    const responseWasActuallyCancelled = Boolean(cancelTelemetry.responseCancelSucceeded);

    if (isRealtimeMode(session.mode) && command.retryUtteranceText && responseWasActuallyCancelled) {
      this.deferredActionQueue.setDeferredVoiceAction(session, {
        type: "interrupted_reply",
        goal: "complete_interrupted_reply",
        freshnessPolicy: "retry_then_regenerate",
        status: "deferred",
        reason: "barge_in_interrupt",
        notBeforeAt: 0,
        expiresAt: command.now + BARGE_IN_RETRY_MAX_AGE_MS,
        payload: {
          utteranceText: command.retryUtteranceText,
          interruptedByUserId: command.userId,
          interruptedAt: command.now,
          source: command.source,
          interruptionPolicy: command.interruptionPolicy
        }
      });
    } else {
      this.deferredActionQueue.clearDeferredVoiceAction(session, "interrupted_reply");
    }

    session.bargeInSuppressionUntil = responseWasActuallyCancelled
      ? command.now + BARGE_IN_SUPPRESSION_MAX_MS
      : command.now + BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: command.userId,
      content: "voice_barge_in_interrupt",
      metadata: {
        sessionId: session.id,
        source: command.source,
        streamBufferedBytesDropped: 0,
        pendingRequestId: command.pendingRequestId,
        minCaptureBytes: command.minCaptureBytes,
        suppressionMs: responseWasActuallyCancelled ? BARGE_IN_SUPPRESSION_MAX_MS : BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
        captureSignalPeak: command.captureSignalPeak,
        captureSignalActiveSampleRatio: command.captureSignalActiveSampleRatio,
        captureBytesSent: command.captureBytesSent,
        botTurnOpen: command.botTurnWasOpen,
        botTurnAgeMs: command.botTurnAgeMs,
        queuedRetryUtterance: Boolean(
          isRealtimeMode(session.mode) &&
          command.retryUtteranceText &&
          responseWasActuallyCancelled
        ),
        retryInterruptionPolicyScope: command.interruptionPolicy?.scope || null,
        retryInterruptionPolicyAllowedUserId: command.interruptionPolicy?.allowedUserId || null,
        ...cancelTelemetry,
        truncateContentIndex: cancelTelemetry.truncateAttempted ? cancelTelemetry.truncateContentIndex : null,
        truncateAudioEndMs: cancelTelemetry.truncateAttempted ? cancelTelemetry.truncateAudioEndMs : null
      }
    });
    return true;
  }

  getOutputChannelState(session): OutputChannelState {
    const replyOutputLockState = this.replyManager.getReplyOutputLockState(session);
    const sessionInactive = !session || session.ending;
    const captureBlocking =
      !sessionInactive &&
      Number(session.userCaptures?.size || 0) > 0 &&
      this.hasReplayBlockingActiveCapture(session);
    const toolCallsRunning =
      !sessionInactive &&
      session.openAiToolCallExecutions instanceof Map &&
      session.openAiToolCallExecutions.size > 0;
    const awaitingToolOutputs =
      replyOutputLockState.awaitingToolOutputs || toolCallsRunning;
    const deferredBlockReason: OutputChannelState["deferredBlockReason"] = sessionInactive
      ? "session_inactive"
      : captureBlocking
        ? "active_captures"
        : replyOutputLockState.pendingResponse
          ? "pending_response"
          : replyOutputLockState.openAiActiveResponse
            ? "active_response"
            : session.awaitingToolOutputs
              ? "awaiting_tool_outputs"
              : toolCallsRunning
                ? "tool_calls_running"
                : null;

    return {
      phase: replyOutputLockState.phase,
      locked: replyOutputLockState.locked,
      lockReason: replyOutputLockState.reason || null,
      musicActive: replyOutputLockState.musicActive,
      captureBlocking,
      bargeInSuppressed: !sessionInactive && this.bargeInController.isBargeInOutputSuppressed(session),
      turnBacklog: this.getTurnBacklogSize(session),
      toolCallsRunning,
      botTurnOpen: replyOutputLockState.botTurnOpen,
      bufferedBotSpeech: replyOutputLockState.bufferedBotSpeech,
      pendingResponse: replyOutputLockState.pendingResponse,
      openAiActiveResponse: replyOutputLockState.openAiActiveResponse,
      awaitingToolOutputs,
      streamBufferedBytes: replyOutputLockState.streamBufferedBytes,
      deferredBlockReason
    };
  }

  async enqueueChunkedTtsPcmForPlayback({
    session,
    ttsPcm,
    inputSampleRateHz = 24000
  }) {
    if (!session || session.ending) return false;
    const pcm = Buffer.isBuffer(ttsPcm) ? ttsPcm : Buffer.from(ttsPcm || []);
    if (!pcm.length) return false;

    if (!session.voxClient?.isAlive) return false;

    // Send the entire TTS PCM buffer to the subprocess. The Rust side now
    // caps pcm_buffer at 15s (720k samples @ 48kHz) and drops oldest samples
    // on overflow, so unbounded growth is no longer possible.
    const sampleRate = Math.max(8_000, Math.floor(Number(inputSampleRateHz) || 24_000));
    try {
      session.voxClient.sendAudio(pcm.toString("base64"), sampleRate);
    } catch {
      return false;
    }

    return true;
  }

  getTurnBacklogSize(session) {
    if (!session) return 0;
    return Math.max(
      0,
      this.turnProcessor.getRealtimeTurnBacklogSize(session) + Number(session.pendingSttTurns || 0)
    );
  }

  resolveSpeakingEndFinalizeDelayMs({ session, captureAgeMs }) {
    const normalizedCaptureAgeMs = Math.max(0, Number(captureAgeMs || 0));
    let baseDelayMs = SPEAKING_END_FINALIZE_QUICK_MS;
    if (normalizedCaptureAgeMs < SPEAKING_END_SHORT_CAPTURE_MS) {
      baseDelayMs =
        normalizedCaptureAgeMs < SPEAKING_END_MICRO_CAPTURE_MS
          ? SPEAKING_END_FINALIZE_MICRO_MS
          : SPEAKING_END_FINALIZE_SHORT_MS;
    }

    const activeCaptureCount = Number(session?.userCaptures?.size || 0);
    const realtimeTurnBacklog = this.turnProcessor.getRealtimeTurnBacklogSize(session);
    const sttTurnBacklog = Number(session?.pendingSttTurns || 0);
    const turnBacklog = Math.max(0, realtimeTurnBacklog, sttTurnBacklog);

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_HEAVY_SCALE)
      );
    }

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_BUSY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_BUSY_SCALE)
      );
    }

    return baseDelayMs;
  }

  isInboundCaptureSuppressed(session) {
    if (!session || session.ending) return true;
    const activeLookupCount = Number(session.voiceLookupBusyCount || 0);
    return activeLookupCount > 0;
  }

  abortActiveInboundCaptures({ session, reason = "capture_suppressed" }) {
    if (!session || session.ending) return;
    const captures: Array<[
      string,
      {
        abort?: (reason?: string) => void;
      }
    ]> = [];
    if (session.userCaptures instanceof Map) {
      for (const [rawUserId, rawCapture] of session.userCaptures.entries()) {
        const normalizedCapture =
          rawCapture && typeof rawCapture === "object"
            ? { ...rawCapture }
            : {};
        captures.push([String(rawUserId || ""), normalizedCapture]);
      }
    }
    for (const [userId, capture] of captures) {
      if (capture && typeof capture.abort === "function") {
        capture.abort(reason);
        continue;
      }

      // Unsubscribe from subprocess audio for this user
      try {
        session.voxClient?.unsubscribeUser(String(userId || ""));
      } catch {
        // ignore
      }
      session.userCaptures?.delete?.(String(userId || ""));
    }
  }

  resolveVoiceThoughtEngineConfig(settings = null) {
    const resolvedSettings = settings || this.store.getSettings();
    const thoughtEngine = getVoiceInitiativeSettings(resolvedSettings);
    const thoughtBinding = getResolvedVoiceInitiativeBinding(resolvedSettings);
    const enabled = Boolean(thoughtEngine.enabled);
    const provider = normalizeLlmProvider(thoughtBinding.provider, "anthropic");
    const model = String(thoughtBinding.model || defaultModelForLlmProvider(provider)).trim().slice(0, 120) ||
      defaultModelForLlmProvider(provider);
    const configuredTemperature = Number(thoughtBinding.temperature);
    const temperature = clamp(Number.isFinite(configuredTemperature) ? configuredTemperature : 0.8, 0, 2);
    const eagerness = clamp(Number(thoughtEngine.eagerness) || 0, 0, 100);
    const minSilenceSeconds = clamp(
      Number(thoughtEngine.minSilenceSeconds) || 20,
      VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
      VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
    );
    const minSecondsBetweenThoughts = clamp(
      Number(thoughtEngine.minSecondsBetweenThoughts) || minSilenceSeconds,
      VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
      VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS
    );

    return {
      enabled,
      provider,
      model,
      temperature,
      eagerness,
      minSilenceSeconds,
      minSecondsBetweenThoughts
    };
  }

  resolveVoiceThoughtTopicalityBias(args = {}) {
    return resolveVoiceThoughtTopicalityBias(args);
  }

  clearVoiceThoughtLoopTimer(session) {
    if (!session) return;
    if (session.thoughtLoopTimer) {
      clearTimeout(session.thoughtLoopTimer);
      session.thoughtLoopTimer = null;
    }
    session.nextThoughtAt = 0;
  }

  evaluateVoiceThoughtLoopGate({
    session,
    settings = null,
    config = null,
    now = Date.now()
  }) {
    return this.thoughtEngine.evaluateVoiceThoughtLoopGate({
      session,
      settings,
      config,
      now
    });
  }

  async maybeRunVoiceThoughtLoop({
    session,
    settings = null,
    trigger = "timer"
  }) {
    return this.thoughtEngine.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger
    });
  }

  async generateVoiceThoughtCandidate({
    session,
    settings,
    config,
    trigger = "timer"
  }) {
    if (!session || session.ending) return "";
    if (!this.llm?.generate) return "";

    const thoughtConfig = config || this.resolveVoiceThoughtEngineConfig(settings);
    const participants = this.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
    const recentHistory = this.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const thoughtEagerness = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100);
    const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
    const topicalityBias = resolveVoiceThoughtTopicalityBias({
      silenceMs,
      minSilenceSeconds: thoughtConfig.minSilenceSeconds,
      minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
    });
    const botName = getPromptBotName(settings);
    const systemPrompt = [
      `You are the internal thought engine for ${botName} in live Discord voice chat.`,
      "Draft exactly one short natural spoken line that might fit right now.",
      "Thought style: freedom to reflect the social atmosphere. Try to catch a vibe.",
      "It can be funny, insightful, witty, serious, frustrated, or even a short train-of-thought blurb when that still feels socially natural.",
      "It is valid to be random or to reflect the bot's current mood/persona.",
      "Topic drift rule: as silence grows, rely less on old-topic callbacks and more on fresh standalone lines.",
      "When topic tether is low, avoid stale references that require shared context (for example: vague that/they/it callbacks).",
      "If there is no good line, output exactly [SKIP].",
      "No markdown, no quotes, no meta commentary, no soundboard directives."
    ].join("\n");
    const userPromptParts = [
      `Current humans in VC: ${participants.length || 0}.`,
      participants.length ? `Participant names: ${participants.slice(0, 12).join(", ")}.` : "Participant names: none.",
      `Thought eagerness setting: ${thoughtEagerness}/100.`,
      `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
      `Topic tether strength: ${topicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
      `Random inspiration strength: ${topicalityBias.randomInspirationStrength}/100.`,
      `Topic drift phase: ${topicalityBias.phase}.`,
      `Topic drift guidance: ${topicalityBias.promptHint}`,
      "Goal: seed a light initiative line that can keep conversation moving without forcing it."
    ];
    if (recentHistory) {
      userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }
    const userPrompt = userPromptParts.join("\n");
    const generationSettings = applyOrchestratorOverrideSettings(settings, {
      provider: thoughtConfig.provider,
      model: thoughtConfig.model,
      temperature: thoughtConfig.temperature,
      maxOutputTokens: 96
    });

    const generation = await this.llm.generate({
      settings: generationSettings,
      systemPrompt,
      userPrompt,
      contextMessages: [],
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        source: "voice_thought_generation",
        event: String(trigger || "timer")
      }
    });
    const thoughtRaw = String(generation?.text || "").trim();
    const thoughtNoDirective = extractSoundboardDirective(thoughtRaw).text;
    const thoughtCandidate = normalizeVoiceText(thoughtNoDirective, VOICE_THOUGHT_MAX_CHARS);
    if (!thoughtCandidate || thoughtCandidate === "[SKIP]") {
      return "";
    }
    return thoughtCandidate;
  }

  async loadVoiceThoughtMemoryFacts({
    session,
    settings,
    thoughtCandidate
  }) {
    if (!session || session.ending) return [];
    if (!settings?.memory?.enabled) return [];
    if (!this.memory || typeof this.memory.searchDurableFacts !== "function") return [];

    const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
    if (!normalizedThought) return [];
    const recentHistory = this.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const queryText = normalizeVoiceText(
      [normalizedThought, recentHistory].filter(Boolean).join("\n"),
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (!queryText) return [];

    try {
      const results = await this.memory.searchDurableFacts({
        guildId: session.guildId,
        channelId: session.textChannelId || null,
        queryText,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source: "voice_thought_memory_search"
        },
        limit: VOICE_THOUGHT_MEMORY_SEARCH_LIMIT
      });

      const rows = Array.isArray(results) ? results : [];
      const deduped = [];
      const seenFacts = new Set();
      for (const row of rows) {
        const factText = normalizeVoiceText(row?.fact || "", 180);
        if (!factText) continue;
        const dedupeKey = factText.toLowerCase();
        if (seenFacts.has(dedupeKey)) continue;
        seenFacts.add(dedupeKey);
        deduped.push(row);
        if (deduped.length >= VOICE_THOUGHT_MEMORY_SEARCH_LIMIT) break;
      }
      return deduped;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_thought_memory_search_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return [];
    }
  }

  async evaluateVoiceThoughtDecision({
    session,
    settings,
    thoughtCandidate,
    memoryFacts = [],
    topicalityBias = null
  }) {
    const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
    if (!normalizedThought) {
      return {
        allow: false,
        reason: "empty_thought_candidate",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: 0
      };
    }

    const classifierBinding = getResolvedVoiceAdmissionClassifierBinding(settings);
    if (!this.llm?.generate) {
      return {
        allow: false,
        reason: "llm_generate_unavailable",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: 0
      };
    }

    const llmProvider = normalizeVoiceReplyDecisionProvider(classifierBinding?.provider || "openai");
    const llmModel = String(classifierBinding?.model || defaultVoiceReplyDecisionModel(llmProvider))
      .trim()
      .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);
    const participants = this.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
    const recentHistory = this.formatVoiceDecisionHistory(session, 8, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
    const resolvedThoughtConfig = this.resolveVoiceThoughtEngineConfig(settings);
    const resolvedTopicalityBias =
      topicalityBias && typeof topicalityBias === "object"
        ? topicalityBias
        : resolveVoiceThoughtTopicalityBias({
          silenceMs,
          minSilenceSeconds: resolvedThoughtConfig.minSilenceSeconds,
          minSecondsBetweenThoughts: resolvedThoughtConfig.minSecondsBetweenThoughts
        });
    const thoughtEagerness = clamp(Number(resolvedThoughtConfig.eagerness) || 0, 0, 100);
    const ambientMemoryFacts = Array.isArray(memoryFacts) ? memoryFacts : [];
    const ambientMemory = formatRealtimeMemoryFacts(ambientMemoryFacts, VOICE_THOUGHT_MEMORY_SEARCH_LIMIT);
    const botName = getPromptBotName(settings);

    const systemPrompt = [
      `You decide whether ${botName} should speak a candidate thought line right now in live Discord voice chat.`,
      "Return strict JSON only with keys: allow (boolean), finalThought (string), usedMemory (boolean), reason (string).",
      "If allow is true, finalThought must contain one short spoken line.",
      "If allow is false, finalThought must be an empty string.",
      "You may improve the draft using memory only when it feels natural and additive.",
      "Topic drift bias is required: as silence gets older, prefer fresh standalone lines over stale callbacks to earlier topic details.",
      "When topic tether is low, reject callback-heavy lines that depend on shared old context.",
      "Prefer allow=false over awkward memory references.",
      "No markdown, no extra keys."
    ].join("\n");
    const userPromptParts = [
      `Draft thought: "${normalizedThought}"`,
      `Thought eagerness: ${thoughtEagerness}/100.`,
      `Current human participant count: ${participants.length || 0}.`,
      `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
      `Topic tether strength: ${resolvedTopicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
      `Random inspiration strength: ${resolvedTopicalityBias.randomInspirationStrength}/100.`,
      `Topic drift phase: ${resolvedTopicalityBias.phase}.`,
      `Topic drift guidance: ${resolvedTopicalityBias.promptHint}`,
      `Final thought hard max chars: ${VOICE_THOUGHT_MAX_CHARS}.`,
      "Decision rule: allow only when saying the final line now would feel natural and additive."
    ];
    if (participants.length) {
      userPromptParts.push(`Participant names: ${participants.slice(0, 12).join(", ")}.`);
    }
    if (recentHistory) {
      userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }
    if (ambientMemory) {
      userPromptParts.push(`Ambient durable memory (optional): ${ambientMemory}`);
    }

    try {
      const generation = await this.llm.generate({
        settings: applyOrchestratorOverrideSettings(settings, {
          provider: llmProvider,
          model: llmModel,
          temperature: 0,
          maxOutputTokens: VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
          reasoningEffort: "minimal"
        }),
        systemPrompt,
        userPrompt: userPromptParts.join("\n"),
        contextMessages: [],
        jsonSchema: JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["allow", "finalThought", "usedMemory", "reason"],
          properties: {
            allow: { type: "boolean" },
            finalThought: {
              type: "string",
              maxLength: VOICE_THOUGHT_MAX_CHARS
            },
            usedMemory: { type: "boolean" },
            reason: {
              type: "string",
              maxLength: 80
            }
          }
        }),
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source: "voice_thought_decision"
        }
      });
      const raw = String(generation?.text || "").trim();
      const parsed = parseVoiceThoughtDecisionContract(raw);
      if (!parsed.confident) {
        return {
          allow: false,
          reason: "llm_contract_violation",
          finalThought: "",
          usedMemory: false,
          memoryFactCount: ambientMemoryFacts.length,
          llmResponse: raw,
          llmProvider: generation?.provider || llmProvider,
          llmModel: generation?.model || llmModel
        };
      }
      const sanitizedThought = normalizeVoiceText(
        extractSoundboardDirective(parsed.finalThought || "").text,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (parsed.allow && (!sanitizedThought || sanitizedThought === "[SKIP]")) {
        return {
          allow: false,
          reason: "llm_contract_violation",
          finalThought: "",
          usedMemory: false,
          memoryFactCount: ambientMemoryFacts.length,
          llmResponse: raw,
          llmProvider: generation?.provider || llmProvider,
          llmModel: generation?.model || llmModel
        };
      }
      const parsedReason = String(parsed.reason || "")
        .trim()
        .toLowerCase()
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80);
      return {
        allow: parsed.allow,
        reason: parsedReason || (parsed.allow ? "llm_allow" : "llm_deny"),
        finalThought: parsed.allow ? sanitizedThought : "",
        usedMemory: parsed.allow ? Boolean(parsed.usedMemory) : false,
        memoryFactCount: ambientMemoryFacts.length,
        llmResponse: raw,
        llmProvider: generation?.provider || llmProvider,
        llmModel: generation?.model || llmModel
      };
    } catch (error) {
      return {
        allow: false,
        reason: "llm_error",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: ambientMemoryFacts.length,
        llmProvider,
        llmModel,
        error: String(error?.message || error)
      };
    }
  }

  async deliverVoiceThoughtCandidate({
    session,
    settings,
    thoughtCandidate,
    trigger = "timer"
  }) {
    if (!session || session.ending) return false;
    const line = normalizeVoiceText(thoughtCandidate, STT_REPLY_MAX_CHARS);
    if (!line) return false;

    const useApiTts = String(getVoiceConversationPolicy(settings).ttsMode || "").trim().toLowerCase() === "api";
    let requestedRealtimeUtterance = false;
    if (isRealtimeMode(session.mode) && !useApiTts) {
      requestedRealtimeUtterance = this.requestRealtimeTextUtterance({
        session,
        text: line,
        userId: this.client.user?.id || null,
        source: SYSTEM_SPEECH_SOURCE.THOUGHT
      });
      if (!requestedRealtimeUtterance) {
        return false;
      }
    } else {
      const spokeLine = await this.speakVoiceLineWithTts({
        session,
        settings,
        text: line,
        source: SYSTEM_SPEECH_SOURCE.THOUGHT_TTS
      });
      if (!spokeLine) return false;
      session.lastAudioDeltaAt = Date.now();
    }

    const replyAt = Date.now();
    const replyAccounting = requestedRealtimeUtterance
      ? resolveSystemSpeechReplyAccountingOnRequest(SYSTEM_SPEECH_SOURCE.THOUGHT)
      : resolveSystemSpeechReplyAccountingOnLocalPlayback(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS);
    if (replyAccounting !== "none") {
      session.lastAssistantReplyAt = replyAt;
    }
    this.recordVoiceTurn(session, {
      role: "assistant",
      userId: this.client.user?.id || null,
      text: line
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_thought_spoken",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        trigger: String(trigger || "timer"),
        thoughtText: line,
        requestedRealtimeUtterance
      }
    });

    return true;
  }

  beginVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) {
      return () => undefined;
    }

    session.voiceLookupBusyCount = Number(session.voiceLookupBusyCount || 0) + 1;
    const busyCount = Number(session.voiceLookupBusyCount || 0);
    if (busyCount === 1) {
      this.abortActiveInboundCaptures({
        session,
        reason: "voice_web_lookup_busy"
      });
      if (session.voiceLookupBusyAnnounceTimer) {
        clearTimeout(session.voiceLookupBusyAnnounceTimer);
        session.voiceLookupBusyAnnounceTimer = null;
      }
      session.voiceLookupBusyAnnounceTimer = setTimeout(() => {
        session.voiceLookupBusyAnnounceTimer = null;
        if (!session || session.ending) return;
        if (Number(session.voiceLookupBusyCount || 0) <= 0) return;
        this.announceVoiceWebLookupBusy({
          session,
          settings,
          userId,
          query,
          source
        }).catch((error) => {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: userId || this.client.user?.id || null,
            content: `voice_web_lookup_busy_announce_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id,
              source: String(source || "voice_web_lookup"),
              query: String(query || "").trim().slice(0, 220) || null
            }
          });
        });
      }, VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_start",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup"),
          query: String(query || "").trim().slice(0, 220) || null
        }
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, Number(session.voiceLookupBusyCount || 0) - 1);
      session.voiceLookupBusyCount = nextCount;
      if (nextCount > 0) return;
      if (session.voiceLookupBusyAnnounceTimer) {
        clearTimeout(session.voiceLookupBusyAnnounceTimer);
        session.voiceLookupBusyAnnounceTimer = null;
      }
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_end",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup")
        }
      });
    };
  }

  async announceVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) return;
    if (isRealtimeMode(session.mode)) {
      const realtimePrompt = this.buildVoiceLookupBusyRealtimePrompt({
        settings,
        query
      });
      const requested = this.requestRealtimePromptUtterance({
        session,
        prompt: realtimePrompt,
        userId,
        source: `${String(source || "voice_web_lookup")}:busy_utterance`,
        utteranceText: null
      });
      if (requested) return;
    }

    const line = await this.generateVoiceLookupBusyLine({
      session,
      settings,
      userId,
      query
    });
    if (!line) return;

    const realtimeMode = isRealtimeMode(session.mode);
    const busyUseApiTts = String(getVoiceConversationPolicy(settings).ttsMode || "").trim().toLowerCase() === "api";
    if (realtimeMode && !busyUseApiTts && this.requestRealtimeTextUtterance({
      session,
      text: line,
      userId,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    })) {
      return;
    }
    if (realtimeMode && !busyUseApiTts) return;

    await this.speakVoiceLineWithTts({
      session,
      settings,
      text: line,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    });
  }

  async generateVoiceLookupBusyLine({
    session,
    settings,
    userId = null,
    query = ""
  }) {
    if (!this.llm?.generate) return "";
    const normalizedQuery = normalizeVoiceText(query, 80);
    const orchestrator = getResolvedOrchestratorBinding(settings);
    const replyGeneration = getReplyGenerationSettings(settings);
    const tunedSettings = applyOrchestratorOverrideSettings(settings, {
      provider: orchestrator.provider,
      model: orchestrator.model,
      temperature: clamp(Number(replyGeneration.temperature) || 0.75, 0.2, 1.1),
      maxOutputTokens: clamp(Number(replyGeneration.maxOutputTokens) || 28, 8, 40),
      reasoningEffort: orchestrator.reasoningEffort
    });
    const systemPrompt = interpolatePromptTemplate(getPromptVoiceLookupBusySystemPrompt(settings), {
      botName: getPromptBotName(settings)
    });
    const userPrompt = [
      normalizedQuery ? `Lookup query: ${normalizedQuery}` : "Lookup query: (not specified)",
      "Write one quick filler line before lookup results are ready."
    ].join("\n");

    try {
      const generation = await this.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        contextMessages: [],
        trace: {
          guildId: session?.guildId || null,
          channelId: session?.textChannelId || null,
          userId: userId || null,
          source: "voice_web_lookup_busy_line"
        }
      });
      const line = normalizeVoiceText(String(generation?.text || ""), VOICE_LOOKUP_BUSY_MAX_CHARS);
      if (!line || line === "[SKIP]") return "";
      return line;
    } catch {
      return "";
    }
  }

  buildVoiceLookupBusyRealtimePrompt({
    settings,
    query = ""
  }) {
    const normalizedQuery = normalizeVoiceText(query, 80);
    const systemPrompt = interpolatePromptTemplate(getPromptVoiceLookupBusySystemPrompt(settings), {
      botName: getPromptBotName(settings)
    });
    return [
      systemPrompt,
      normalizedQuery ? `Lookup query: ${normalizedQuery}` : "Lookup query: (not specified)",
      "Respond with one short spoken line only."
    ]
      .filter(Boolean)
      .join("\n");
  }

  requestRealtimePromptUtterance({
    session,
    prompt,
    userId = null,
    source = "voice_prompt_utterance",
    interruptionPolicy = null,
    latencyContext = null,
    utteranceText = null
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;

    const utterancePrompt = String(prompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, STT_REPLY_MAX_CHARS + 420);
    if (!utterancePrompt) return false;

    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicy);
    const normalizedUtteranceText =
      utteranceText === null
        ? null
        : normalizeVoiceText(String(utteranceText || ""), STT_REPLY_MAX_CHARS) || null;

    try {
      realtimeClient.requestTextUtterance(utterancePrompt);
      this.replyManager.createTrackedAudioResponse({
        session,
        userId: userId || this.client.user?.id || null,
        source,
        resetRetryState: true,
        emitCreateEvent: false,
        interruptionPolicy: normalizedInterruptionPolicy,
        utteranceText: normalizedUtteranceText,
        latencyContext
      });
      session.lastRequestedRealtimeUtterance = {
        utteranceText: normalizedUtteranceText,
        requestedAt: Date.now(),
        source: String(source || "voice_prompt_utterance"),
        interruptionPolicy: normalizedInterruptionPolicy
      };
      return true;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_text_utterance_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_prompt_utterance")
        }
      });
      return false;
    }
  }

  requestRealtimeTextUtterance({
    session,
    text,
    userId = null,
    source = "voice_text_utterance",
    interruptionPolicy = null,
    latencyContext = null
  }) {
    const normalizedLine = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!normalizedLine) return false;
    const utterancePrompt = buildRealtimeTextUtterancePrompt(normalizedLine, STT_REPLY_MAX_CHARS);
    if (!utterancePrompt) return false;
    return this.requestRealtimePromptUtterance({
      session,
      prompt: utterancePrompt,
      userId,
      source,
      interruptionPolicy,
      latencyContext,
      utteranceText: normalizedLine
    });
  }

  normalizeSoundboardRefs(soundboardRefs = []) {
    return (Array.isArray(soundboardRefs) ? soundboardRefs : [])
      .map((entry) =>
        String(entry || "")
          .trim()
          .slice(0, 180)
      )
      .filter(Boolean)
      .slice(0, 12);
  }

  buildVoiceReplyPlaybackPlan({
    replyText = "",
    trailingSoundboardRefs = []
  }) {
    const parsed = parseSoundboardDirectiveSequence(replyText);
    const sequence = Array.isArray(parsed?.sequence) ? parsed.sequence : [];
    const steps = [];
    const appendSpeech = (rawText) => {
      const normalized = normalizeVoiceText(rawText, STT_REPLY_MAX_CHARS);
      if (!normalized) return;
      const last = steps[steps.length - 1];
      if (last?.type === "speech") {
        last.text = normalizeVoiceText(`${last.text} ${normalized}`, STT_REPLY_MAX_CHARS);
      } else {
        steps.push({
          type: "speech",
          text: normalized
        });
      }
    };

    for (const entry of sequence) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "speech") {
        appendSpeech(entry.text);
        continue;
      }
      if (entry.type === "soundboard") {
        const reference = String(entry.reference || "")
          .trim()
          .slice(0, 180);
        if (!reference) continue;
        steps.push({
          type: "soundboard",
          reference
        });
      }
    }

    for (const reference of this.normalizeSoundboardRefs(trailingSoundboardRefs)) {
      steps.push({
        type: "soundboard",
        reference
      });
    }

    const spokenText = normalizeVoiceText(parsed?.text || "", STT_REPLY_MAX_CHARS);
    const soundboardRefs = steps
      .filter((entry) => entry?.type === "soundboard")
      .map((entry) => entry.reference);
    return {
      spokenText,
      steps,
      soundboardRefs
    };
  }

  summarizeRealtimeInterruptingQueue({
    session = null,
    finalizedAfterMs = 0
  } = {}) {
    const pendingQueue = Array.isArray(session?.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!pendingQueue.length) {
      return {
        pendingInterruptingQueueDepth: 0,
        pendingNearSilentQueueDepth: 0,
        totalPendingRealtimeQueueDepth: 0,
        consideredPendingRealtimeQueueDepth: 0,
        oldestConsideredFinalizedAt: null,
        newestConsideredFinalizedAt: null
      };
    }

    const finalizedAfter = Math.max(0, Number(finalizedAfterMs || 0));
    const sampleRateHz = Number(session?.realtimeInputSampleRateHz) || 24000;
    let pendingInterruptingQueueDepth = 0;
    let pendingNearSilentQueueDepth = 0;
    let consideredPendingRealtimeQueueDepth = 0;
    let oldestConsideredFinalizedAt = Number.POSITIVE_INFINITY;
    let newestConsideredFinalizedAt = 0;

    for (const queuedTurn of pendingQueue) {
      const turnFinalizedAt = Math.max(0, Number(queuedTurn?.finalizedAt || 0));
      if (finalizedAfter > 0 && turnFinalizedAt > 0 && turnFinalizedAt <= finalizedAfter) {
        continue;
      }
      const pcmBuffer = Buffer.isBuffer(queuedTurn?.pcmBuffer) ? queuedTurn.pcmBuffer : null;
      if (!pcmBuffer?.length) continue;
      consideredPendingRealtimeQueueDepth += 1;
      if (turnFinalizedAt > 0) {
        if (turnFinalizedAt < oldestConsideredFinalizedAt) {
          oldestConsideredFinalizedAt = turnFinalizedAt;
        }
        if (turnFinalizedAt > newestConsideredFinalizedAt) {
          newestConsideredFinalizedAt = turnFinalizedAt;
        }
      }
      const clipDurationMs = this.estimatePcm16MonoDurationMs(pcmBuffer.length, sampleRateHz);
      if (clipDurationMs < VOICE_TURN_MIN_ASR_CLIP_MS) continue;
      const silenceGate = this.evaluatePcmSilenceGate({
        pcmBuffer,
        sampleRateHz
      });
      if (silenceGate.drop) {
        pendingNearSilentQueueDepth += 1;
        continue;
      }
      pendingInterruptingQueueDepth += 1;
    }

    return {
      pendingInterruptingQueueDepth,
      pendingNearSilentQueueDepth,
      totalPendingRealtimeQueueDepth: pendingQueue.length,
      consideredPendingRealtimeQueueDepth,
      oldestConsideredFinalizedAt: Number.isFinite(oldestConsideredFinalizedAt)
        ? Math.max(0, Math.round(oldestConsideredFinalizedAt))
        : null,
      newestConsideredFinalizedAt: newestConsideredFinalizedAt > 0
        ? Math.max(0, Math.round(newestConsideredFinalizedAt))
        : null
    };
  }

  maybeSupersedeRealtimeReplyBeforePlayback({
    session = null,
    source = "voice_reply",
    speechStep = 0,
    generationStartedAtMs = 0,
    includePromotedCaptureSupersede = false
  } = {}) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const generationStartedAt = Math.max(0, Number(generationStartedAtMs || 0));
    const pendingSummary = this.summarizeRealtimeInterruptingQueue({
      session,
      finalizedAfterMs: generationStartedAt
    });
    const hasInterruptingNewerInput = pendingSummary.pendingInterruptingQueueDepth > 0;
    const liveCaptureSummary = includePromotedCaptureSupersede
      ? this.summarizeRealtimeInterruptingLiveCaptures({
        session,
        promotedAfterMs: generationStartedAt
      })
      : {
        livePromotedCaptureCount: 0,
        oldestPromotedAt: null,
        newestPromotedAt: null
      };
    const hasInterruptingLiveCapture = liveCaptureSummary.livePromotedCaptureCount > 0;
    if (!hasInterruptingNewerInput && !hasInterruptingLiveCapture) return false;

    const supersedeReason = hasInterruptingNewerInput
      ? "newer_finalized_realtime_turn"
      : "newer_live_promoted_capture";

    session.realtimeReplySupersededCount =
      Math.max(0, Number(session.realtimeReplySupersededCount || 0)) + 1;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_reply_superseded_newer_input",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_reply"),
        supersedeReason,
        generationStartedAt: generationStartedAt > 0 ? generationStartedAt : null,
        pendingRealtimeQueueDepth: pendingSummary.pendingInterruptingQueueDepth,
        totalPendingRealtimeQueueDepth: pendingSummary.totalPendingRealtimeQueueDepth,
        consideredPendingRealtimeQueueDepth: pendingSummary.consideredPendingRealtimeQueueDepth,
        pendingNearSilentQueueDepth: pendingSummary.pendingNearSilentQueueDepth,
        oldestConsideredFinalizedAt: pendingSummary.oldestConsideredFinalizedAt,
        newestConsideredFinalizedAt: pendingSummary.newestConsideredFinalizedAt,
        livePromotedCaptureCount: liveCaptureSummary.livePromotedCaptureCount,
        oldestLivePromotedAt: liveCaptureSummary.oldestPromotedAt,
        newestLivePromotedAt: liveCaptureSummary.newestPromotedAt,
        speechStep: Math.max(0, Number(speechStep || 0)),
        supersededCount: Math.max(0, Number(session.realtimeReplySupersededCount || 0))
      }
    });
    this.maybeClearActiveReplyInterruptionPolicy(session);
    return true;
  }

  async playVoiceReplyInOrder({
    session,
    settings,
    spokenText = "",
    playbackSteps = [],
    source = "voice_reply",
    preferRealtimeUtterance = false,
    interruptionPolicy = null,
    latencyContext = null
  }) {
    if (!session || session.ending) {
      return {
        completed: false,
        spokeLine: false,
        requestedRealtimeUtterance: false,
        playedSoundboardCount: 0
      };
    }
    const steps = Array.isArray(playbackSteps) ? playbackSteps : [];
    if (!steps.length) {
      return {
        completed: true,
        spokeLine: false,
        requestedRealtimeUtterance: false,
        playedSoundboardCount: 0
      };
    }

    const requiresOrderedPlayback = steps.some((entry) => entry?.type === "soundboard");
    let speechStep = 0;
    let soundboardStep = 0;
    let spokeLine = false;
    let requestedRealtimeUtterance = false;
    let playedSoundboardCount = 0;
    let completed = true;
    const allowLiveCaptureSupersede = shouldSupersedeSystemSpeechBeforePlayback(source);

    for (const step of steps) {
      if (session.ending) {
        completed = false;
        break;
      }
      if (!step || typeof step !== "object") continue;
      if (step.type === "speech") {
        const segmentText = normalizeVoiceText(step.text, STT_REPLY_MAX_CHARS);
        if (!segmentText) continue;
        speechStep += 1;
        const speechSource = `${String(source || "voice_reply")}:speech_${speechStep}`;
        if (preferRealtimeUtterance) {
          if (
            this.maybeSupersedeRealtimeReplyBeforePlayback({
              session,
              source: speechSource,
              speechStep,
              generationStartedAtMs: Number(latencyContext?.generationStartedAtMs || 0),
              includePromotedCaptureSupersede: allowLiveCaptureSupersede
            })
          ) {
            completed = false;
            break;
          }
          const requested = this.requestRealtimeTextUtterance({
            session,
            text: segmentText,
            userId: this.client.user?.id || null,
            source: speechSource,
            interruptionPolicy,
            latencyContext
          });
          if (requested) {
            spokeLine = true;
            requestedRealtimeUtterance = true;
            if (requiresOrderedPlayback) {
              await this.waitForLeaveDirectivePlayback({
                session,
                expectRealtimeAudio: true,
                source: speechSource
              });
            }
            continue;
          }
          if (
            this.maybeSupersedeRealtimeReplyBeforePlayback({
              session,
              source: speechSource,
              speechStep,
              generationStartedAtMs: Number(latencyContext?.generationStartedAtMs || 0),
              includePromotedCaptureSupersede: allowLiveCaptureSupersede
            })
          ) {
            completed = false;
            break;
          }
          completed = false;
          break;
        }
        const spoke = await this.speakVoiceLineWithTts({
          session,
          settings,
          text: segmentText,
          source: speechSource
        });
        if (!spoke) {
          completed = false;
          break;
        }
        spokeLine = true;
        if (requiresOrderedPlayback) {
          await this.waitForLeaveDirectivePlayback({
            session,
            expectRealtimeAudio: false,
            source: speechSource
          });
        }
        continue;
      }
      if (step.type === "soundboard") {
        const requestedRef = String(step.reference || "")
          .trim()
          .slice(0, 180);
        if (!requestedRef) continue;
        soundboardStep += 1;
        await this.maybeTriggerAssistantDirectedSoundboard({
          session,
          settings,
          userId: this.client.user?.id || null,
          transcript: spokenText,
          requestedRef,
          source: `${String(source || "voice_reply")}:soundboard_${soundboardStep}`
        });
        playedSoundboardCount += 1;
      }
    }

    return {
      completed,
      spokeLine,
      requestedRealtimeUtterance,
      playedSoundboardCount
    };
  }

  async waitForLeaveDirectivePlayback({
    session,
    expectRealtimeAudio = false,
    source = "leave_directive"
  }) {
    if (!session || session.ending) return;
    const hasPlaybackSignals =
      typeof session.botTurnOpen === "boolean" ||
      (expectRealtimeAudio && session.pendingResponse && typeof session.pendingResponse === "object");
    if (!hasPlaybackSignals) return;

    const waitStartedAt = Date.now();
    let audioRequestedAt = Math.max(
      0,
      Number(session.pendingResponse?.requestedAt || 0),
      Number(session.lastResponseRequestAt || 0)
    );
    if (!audioRequestedAt) {
      audioRequestedAt = waitStartedAt;
    }
    const deadlineAt = waitStartedAt + LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS;
    let observedPlayback = false;
    let timedOutOnStart = false;

    while (!session.ending) {
      const now = Date.now();
      if (now >= deadlineAt) break;
      const botTurnOpen = Boolean(session.botTurnOpen);
      const bufferedBotSpeech = this.replyManager.hasBufferedTtsPlayback(session);
      const pending = session.pendingResponse;
      const pendingHasAudio = pending ? this.replyManager.pendingResponseHasAudio(session, pending) : false;
      const hasPostRequestAudio = Number(session.lastAudioDeltaAt || 0) >= audioRequestedAt;

      if (botTurnOpen || bufferedBotSpeech || pendingHasAudio || hasPostRequestAudio) {
        observedPlayback = true;
      }

      if (observedPlayback && !botTurnOpen && !bufferedBotSpeech) {
        break;
      }

      const elapsedMs = now - waitStartedAt;
      if (!observedPlayback) {
        if (expectRealtimeAudio && elapsedMs >= LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS) {
          timedOutOnStart = true;
          break;
        }
        if (!expectRealtimeAudio && elapsedMs >= LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, LEAVE_DIRECTIVE_PLAYBACK_POLL_MS));
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "leave_directive_playback_wait",
      metadata: {
        sessionId: session.id,
        source: String(source || "leave_directive"),
        expectRealtimeAudio,
        observedPlayback,
        timedOutOnStart,
        elapsedMs: Math.max(0, Date.now() - waitStartedAt),
        botTurnOpen: Boolean(session.botTurnOpen),
        streamBufferedBytes: 0
      }
    });
  }

  async speakVoiceLineWithTts({
    session,
    settings,
    text,
    source = "voice_tts_line"
  }) {
    if (!session || session.ending) return false;
    if (this.hasReplayBlockingActiveCapture(session)) return false;
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;
    if (!this.llm?.synthesizeSpeech) return false;

    const sttSettings = getVoiceRuntimeConfig(settings).sttPipeline;
    const ttsModel = String(sttSettings?.ttsModel || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const ttsVoice = String(sttSettings?.ttsVoice || "alloy").trim() || "alloy";
    const ttsSpeedRaw = Number(sttSettings?.ttsSpeed);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw) ? ttsSpeedRaw : 1;

    let ttsPcm = Buffer.alloc(0);
    try {
      const tts = await this.llm.synthesizeSpeech({
        text: line,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
        responseFormat: "pcm",
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source
        }
      });
      ttsPcm = tts.audioBuffer;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_tts_line_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_tts_line")
        }
      });
      return false;
    }

    const duckedMusic = await this.engageBotSpeechMusicDuck(session, settings, { awaitFade: true });
    if (!ttsPcm.length || session.ending) {
      if (duckedMusic) {
        await this.releaseBotSpeechMusicDuck(session, settings, { force: true });
      }
      return false;
    }
    const queued = await this.enqueueChunkedTtsPcmForPlayback({
      session,
      ttsPcm,
      inputSampleRateHz: 24000
    });
    if (!queued) {
      if (duckedMusic) {
        await this.releaseBotSpeechMusicDuck(session, settings, { force: true });
      }
      return false;
    }
    this.replyManager.markBotTurnOut(session, settings);
    if (duckedMusic) {
      this.scheduleBotSpeechMusicUnduck(session, settings, BOT_TURN_SILENCE_RESET_MS);
    }
    return true;
  }

  shouldUsePerUserTranscription({
    session = null,
    settings = null
  }: {
    session?: {
      ending?: boolean;
      mode?: string;
      settingsSnapshot?: Record<string, unknown> | null;
    } | null;
    settings?: Record<string, unknown> | null;
  } = {}) {
    if (!session || session.ending) return false;
    if (!providerSupports(session.mode || "", "perUserAsr")) return false;
    if (!this.appConfig?.openaiApiKey) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
    const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
    if (voiceConversation.textOnlyMode) return false;
    const transcriptionMethod = String(
      voiceRuntime.openaiRealtime?.transcriptionMethod || "realtime_bridge"
    )
      .trim()
      .toLowerCase();
    if (this.resolveRealtimeReplyStrategy({
      session,
      settings: resolvedSettings
    }) !== "brain") {
      return false;
    }
    if (transcriptionMethod !== "realtime_bridge") {
      return false;
    }
    if (!voiceRuntime.openaiRealtime?.usePerUserAsrBridge) {
      return false;
    }
    return true;
  }

  shouldUseSharedTranscription({
    session = null,
    settings = null
  }: {
    session?: {
      ending?: boolean;
      mode?: string;
      settingsSnapshot?: Record<string, unknown> | null;
    } | null;
    settings?: Record<string, unknown> | null;
  } = {}) {
    if (!session || session.ending) return false;
    if (!providerSupports(session.mode || "", "sharedAsr")) return false;
    if (!this.appConfig?.openaiApiKey) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
    const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
    if (voiceConversation.textOnlyMode) return false;
    const transcriptionMethod = String(
      voiceRuntime.openaiRealtime?.transcriptionMethod || "realtime_bridge"
    )
      .trim()
      .toLowerCase();
    if (this.resolveRealtimeReplyStrategy({
      session,
      settings: resolvedSettings
    }) !== "brain") {
      return false;
    }
    if (transcriptionMethod !== "realtime_bridge") {
      return false;
    }
    if (voiceRuntime.openaiRealtime?.usePerUserAsrBridge) {
      return false;
    }
    return true;
  }

  shouldUseRealtimeTranscriptBridge({
    session = null,
    settings = null
  }: {
    session?: {
      ending?: boolean;
      mode?: string;
      settingsSnapshot?: Record<string, unknown> | null;
    } | null;
    settings?: Record<string, unknown> | null;
  } = {}) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode || "")) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceConversation = getVoiceConversationPolicy(resolvedSettings);
    const replyPath = String(voiceConversation.replyPath || "")
      .trim()
      .toLowerCase();
    if (replyPath === "bridge") {
      const ttsMode = String(voiceConversation.ttsMode || "").trim().toLowerCase();
      if (ttsMode === "api") return false;
      return true;
    }
    if (replyPath === "brain" || replyPath === "native") return false;
    return false;
  }

  // ── ASR bridge deps factory & delegation ─────────────────────────────

  buildAsrBridgeDeps(session): AsrBridgeDeps {
    return {
      session,
      appConfig: this.appConfig,
      store: this.store,
      botUserId: this.client.user?.id || null,
      resolveVoiceSpeakerName: (s, userId) => this.resolveVoiceSpeakerName(s, userId)
    };
  }

  getOpenAiSharedAsrState(session) {
    return getOrCreateSharedAsrState(session);
  }

  getOpenAiAsrSessionMap(session) {
    if (!session || session.ending) return null;
    if (!(session.openAiAsrSessions instanceof Map)) {
      session.openAiAsrSessions = new Map();
    }
    return session.openAiAsrSessions;
  }

  getOrCreateOpenAiAsrSessionState({ session, userId }) {
    return getOrCreatePerUserAsrState(session, userId);
  }

  async ensureOpenAiAsrSessionConnected({ session, settings = null, userId }) {
    if (!session || session.ending) return null;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return null;
    return await ensureAsrSessionConnected(
      "per_user",
      this.buildAsrBridgeDeps(session),
      settings,
      userId
    );
  }

  beginOpenAiAsrUtterance({ session, settings = null, userId }) {
    if (!session || session.ending) return;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return;
    beginAsrUtterance("per_user", session, this.buildAsrBridgeDeps(session), settings, userId);
  }

  appendAudioToOpenAiAsr({ session, settings = null, userId, pcmChunk }) {
    if (!session || session.ending) return;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return;
    appendAudioToAsr("per_user", session, this.buildAsrBridgeDeps(session), settings, userId, pcmChunk);
  }

  async commitOpenAiAsrUtterance({ session, settings = null, userId, captureReason = "stream_end" }) {
    if (!session || session.ending) return null;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return null;
    return commitAsrUtterance("per_user", this.buildAsrBridgeDeps(session), settings, userId, captureReason);
  }

  discardOpenAiAsrUtterance({ session, userId }) {
    if (!session || session.ending) return false;
    return discardAsrUtterance("per_user", session, userId);
  }

  scheduleOpenAiAsrSessionIdleClose({ session, userId }) {
    scheduleAsrIdleClose("per_user", session, this.buildAsrBridgeDeps(session), userId);
  }

  async closeOpenAiAsrSession({ session, userId, reason = "manual" }) {
    await closePerUserAsrSession(session, this.buildAsrBridgeDeps(session), userId, reason);
  }

  async closeAllOpenAiAsrSessions(session, reason = "session_end") {
    await closeAllPerUserAsrSessions(session, this.buildAsrBridgeDeps(session), reason);
  }

  beginOpenAiSharedAsrUtterance({ session, settings = null, userId }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    return beginAsrUtterance("shared", session, this.buildAsrBridgeDeps(session), settings, userId);
  }

  appendAudioToOpenAiSharedAsr({ session, settings = null, userId, pcmChunk }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    return appendAudioToAsr("shared", session, this.buildAsrBridgeDeps(session), settings, userId, pcmChunk);
  }

  async commitOpenAiSharedAsrUtterance({ session, settings = null, userId, captureReason = "stream_end" }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseSharedTranscription({ session, settings })) return null;
    return commitAsrUtterance("shared", this.buildAsrBridgeDeps(session), settings, userId, captureReason);
  }

  discardOpenAiSharedAsrUtterance({ session, userId }) {
    if (!session || session.ending) return false;
    return discardAsrUtterance("shared", session, userId);
  }

  scheduleOpenAiSharedAsrSessionIdleClose(session) {
    scheduleAsrIdleClose("shared", session, this.buildAsrBridgeDeps(session), "");
  }

  releaseOpenAiSharedAsrActiveUser(session, userId = null) {
    releaseSharedAsrActiveUser(session, userId);
  }

  tryHandoffSharedAsrToWaitingCapture({ session, settings = null }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    const asrState = this.getOpenAiSharedAsrState(session) as AsrBridgeState | null;
    if (!asrState || asrPhaseIsClosing(asrState.phase)) return false;
    if (asrState.userId) return false;
    const deps = this.buildAsrBridgeDeps(session);
    return tryHandoffSharedAsr({
      session,
      asrState,
      deps,
      settings,
      beginUtterance: (uid) => this.beginOpenAiSharedAsrUtterance({ session, settings, userId: uid }),
      appendAudio: (uid, pcmChunk) => this.appendAudioToOpenAiSharedAsr({ session, settings, userId: uid, pcmChunk }),
      releaseUser: (uid) => this.releaseOpenAiSharedAsrActiveUser(session, uid)
    });
  }

  async closeOpenAiSharedAsrSession(session, reason = "manual") {
    await closeSharedAsrSession(session, this.buildAsrBridgeDeps(session), reason);
  }

  startInboundCapture({ session, userId, settings = session?.settingsSnapshot }) {
    return this.captureManager.startInboundCapture({
      session,
      userId,
      settings
    });
  }

  maybeHandleInterruptedReplyRecovery({
    session,
    userId = null,
    pcmBuffer = null,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    return this.deferredActionQueue.recheckDeferredVoiceActions({
      session,
      reason: "barge_in_capture_resolved",
      preferredTypes: ["interrupted_reply"],
      context: {
        userId,
        pcmBuffer,
        captureReason
      }
    });
  }

  queueRealtimeTurnFromAsrBridge({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    finalizedAt = 0,
    asrResult = null,
    source = "unknown"
  }) {
    if (!session || session.ending) return false;
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const transcript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
    if (!transcript) {
      const clipDurationMs = this.estimatePcm16MonoDurationMs(
        normalizedPcmBuffer.length,
        Number(session.realtimeInputSampleRateHz) || 24000
      );
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "openai_realtime_asr_bridge_empty_dropped",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          source: String(source || "unknown"),
          pcmBytes: normalizedPcmBuffer.length,
          clipDurationMs,
          asrResultAvailable: Boolean(asrResult)
        }
      });
      this.deferredActionQueue.recheckDeferredVoiceActions({
        session,
        reason: "empty_asr_bridge_drop"
      });
      this.greetingManager.maybeFireJoinGreetingOpportunity(session, "empty_asr_bridge_drop");
      return false;
    }

    const clipDurationMs = this.estimatePcm16MonoDurationMs(
      normalizedPcmBuffer.length,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    this.turnProcessor.queueRealtimeTurn({
      session,
      userId,
      captureReason,
      finalizedAt,
      transcriptOverride: transcript,
      clipDurationMsOverride: clipDurationMs,
      asrStartedAtMsOverride: Math.max(0, Number(asrResult?.asrStartedAtMs || 0)),
      asrCompletedAtMsOverride: Math.max(0, Number(asrResult?.asrCompletedAtMs || 0)),
      transcriptionModelPrimaryOverride: String(asrResult?.transcriptionModelPrimary || "").trim(),
      transcriptionModelFallbackOverride:
        String(asrResult?.transcriptionModelFallback || "").trim() || null,
      transcriptionPlanReasonOverride: String(asrResult?.transcriptionPlanReason || "").trim(),
      usedFallbackModelForTranscriptOverride: Boolean(asrResult?.usedFallbackModel),
      transcriptLogprobsOverride: Array.isArray(asrResult?.transcriptLogprobs)
        ? asrResult.transcriptLogprobs
        : null
    });
    return true;
  }

  estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
    const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
    const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
    return Math.round((normalizedBytes / (2 * normalizedRate)) * 1000);
  }

  estimateDiscordPcmPlaybackDurationMs(pcmByteLength) {
    const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
    const bytesPerSecond = 48_000 * 2 * 2;
    return Math.round((normalizedBytes / bytesPerSecond) * 1000);
  }

  analyzeMonoPcmSignal(pcmBuffer) {
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const evenByteLength = Math.max(0, buffer.length - (buffer.length % 2));
    if (evenByteLength <= 0) {
      return {
        sampleCount: 0,
        rms: 0,
        peak: 0,
        activeSampleRatio: 0
      };
    }

    let sumSquares = 0;
    let peakAbs = 0;
    let activeSamples = 0;
    const sampleCount = evenByteLength / 2;
    for (let offset = 0; offset < evenByteLength; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      const absSample = Math.abs(sample);
      sumSquares += sample * sample;
      if (absSample > peakAbs) {
        peakAbs = absSample;
      }
      if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
        activeSamples += 1;
      }
    }

    const rmsAbs = Math.sqrt(sumSquares / sampleCount);
    return {
      sampleCount,
      rms: rmsAbs / 32768,
      peak: peakAbs / 32768,
      activeSampleRatio: activeSamples / sampleCount
    };
  }

  evaluatePcmSilenceGate({ pcmBuffer, sampleRateHz = 24000 }) {
    const clipDurationMs = this.estimatePcm16MonoDurationMs(pcmBuffer?.length || 0, sampleRateHz);
    const signal = this.analyzeMonoPcmSignal(pcmBuffer);
    const eligibleForGate = clipDurationMs >= VOICE_SILENCE_GATE_MIN_CLIP_MS;
    const nearSilentSignal =
      signal.rms <= VOICE_SILENCE_GATE_RMS_MAX &&
      signal.peak <= VOICE_SILENCE_GATE_PEAK_MAX &&
      signal.activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX;

    return {
      clipDurationMs,
      ...signal,
      drop: Boolean(eligibleForGate && nearSilentSignal)
    };
  }

  computeLatencyMs(startMs = 0, endMs = 0) {
    const normalizedStart = Number(startMs || 0);
    const normalizedEnd = Number(endMs || 0);
    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null;
    if (normalizedStart <= 0 || normalizedEnd <= 0) return null;
    if (normalizedEnd < normalizedStart) return null;
    return Math.max(0, Math.round(normalizedEnd - normalizedStart));
  }

  buildVoiceLatencyStageMetrics({
    finalizedAtMs = 0,
    asrStartedAtMs = 0,
    asrCompletedAtMs = 0,
    generationStartedAtMs = 0,
    replyRequestedAtMs = 0,
    audioStartedAtMs = 0
  } = {}) {
    return {
      finalizedToAsrStartMs: this.computeLatencyMs(finalizedAtMs, asrStartedAtMs),
      asrToGenerationStartMs: this.computeLatencyMs(asrCompletedAtMs, generationStartedAtMs),
      generationToReplyRequestMs: this.computeLatencyMs(generationStartedAtMs, replyRequestedAtMs),
      replyRequestToAudioStartMs: this.computeLatencyMs(replyRequestedAtMs, audioStartedAtMs)
    };
  }

  logVoiceLatencyStage(payload = null) {
    const {
      session = null,
      userId = null,
      stage = "unknown",
      source = "realtime",
      captureReason = null,
      requestId = null,
      queueWaitMs = null,
      pendingQueueDepth = null,
      finalizedAtMs = 0,
      asrStartedAtMs = 0,
      asrCompletedAtMs = 0,
      generationStartedAtMs = 0,
      replyRequestedAtMs = 0,
      audioStartedAtMs = 0
    } = payload && typeof payload === "object" ? payload : {};
    if (!session || session.ending) return;
    const metrics = this.buildVoiceLatencyStageMetrics({
      finalizedAtMs,
      asrStartedAtMs,
      asrCompletedAtMs,
      generationStartedAtMs,
      replyRequestedAtMs,
      audioStartedAtMs
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: "voice_latency_stage",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        stage: String(stage || "unknown"),
        source: String(source || "realtime"),
        captureReason: captureReason ? String(captureReason) : null,
        requestId: Number.isFinite(Number(requestId)) && Number(requestId) > 0
          ? Number(requestId)
          : null,
        queueWaitMs: Number.isFinite(Number(queueWaitMs))
          ? Math.max(0, Math.round(Number(queueWaitMs)))
          : null,
        pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
          ? Math.max(0, Math.round(Number(pendingQueueDepth)))
          : null,
        finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
        asrToGenerationStartMs: metrics.asrToGenerationStartMs,
        generationToReplyRequestMs: metrics.generationToReplyRequestMs,
        replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs
      }
    });

    if (String(stage || "").toLowerCase() === "audio_started") {
      const totalMs = [
        metrics.finalizedToAsrStartMs,
        metrics.asrToGenerationStartMs,
        metrics.generationToReplyRequestMs,
        metrics.replyRequestToAudioStartMs
      ].reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);

      const entry = {
        at: Date.now(),
        stage: String(stage),
        source: String(source || "realtime"),
        finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
        asrToGenerationStartMs: metrics.asrToGenerationStartMs,
        generationToReplyRequestMs: metrics.generationToReplyRequestMs,
        replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs,
        totalMs,
        queueWaitMs: Number.isFinite(Number(queueWaitMs))
          ? Math.max(0, Math.round(Number(queueWaitMs)))
          : null,
        pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
          ? Math.max(0, Math.round(Number(pendingQueueDepth)))
          : null
      };

      if (!Array.isArray(session.latencyStages)) session.latencyStages = [];
      session.latencyStages.push(entry);
      if (session.latencyStages.length > 12) {
        session.latencyStages = session.latencyStages.slice(-12);
      }
    }
  }

  resolveRealtimeReplyStrategy({ session, settings = null }) {
    if (!session || !isRealtimeMode(session.mode)) return "brain";
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const replyPath = String(getVoiceConversationPolicy(resolvedSettings).replyPath || "").trim().toLowerCase();
    if (replyPath === "native") return "native";
    return "brain";
  }

  shouldUseNativeRealtimeReply({ session, settings = null }) {
    return this.resolveRealtimeReplyStrategy({ session, settings }) === "native";
  }

  queueDeferredBotTurnOpenTurn({
    session,
    userId = null,
    transcript = "",
    pcmBuffer = null,
    captureReason = "stream_end",
    source = "voice_turn",
    directAddressed = false,
    deferReason = "bot_turn_open",
    flushDelayMs = null
  }) {
    if (!session || session.ending) return;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const normalizedDeferReason = String(deferReason || "bot_turn_open").trim() || "bot_turn_open";
    const normalizedFlushDelayMs = Number.isFinite(Number(flushDelayMs))
      ? Math.max(20, Math.round(Number(flushDelayMs)))
      : BOT_TURN_DEFERRED_FLUSH_DELAY_MS;
    const pendingQueue = this.deferredActionQueue.getDeferredQueuedUserTurns(session).slice();
    if (pendingQueue.length >= BOT_TURN_DEFERRED_QUEUE_MAX) {
      pendingQueue.shift();
    }
    pendingQueue.push({
      userId: String(userId || "").trim() || null,
      transcript: normalizedTranscript,
      pcmBuffer: pcmBuffer?.length ? pcmBuffer : null,
      captureReason: String(captureReason || "stream_end"),
      source: String(source || "voice_turn"),
      directAddressed: Boolean(directAddressed),
      deferReason: normalizedDeferReason,
      flushDelayMs: normalizedFlushDelayMs,
      queuedAt: Date.now()
    });
    const nextFlushAt = Date.now() + normalizedFlushDelayMs;
    this.deferredActionQueue.setDeferredVoiceAction(session, {
      type: "queued_user_turns",
      goal: "respond_to_deferred_user_turns",
      freshnessPolicy: "regenerate_from_goal",
      status: "deferred",
      reason: normalizedDeferReason,
      notBeforeAt: nextFlushAt,
      expiresAt: 0,
      payload: {
        turns: pendingQueue,
        nextFlushAt
      }
    });
    const outputChannelState = this.getOutputChannelState(session);
    const deferredOutputLockDebugMetadata = this.replyManager.getOutputLockDebugMetadata(
      session,
      outputChannelState.lockReason
    );
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_deferred_bot_turn_open",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        mode: session.mode,
        captureReason: String(captureReason || "stream_end"),
        deferReason: normalizedDeferReason,
        outputLockReason: outputChannelState.lockReason,
        directAddressed: Boolean(directAddressed),
        flushDelayMs: normalizedFlushDelayMs,
        deferredQueueSize: pendingQueue.length,
        ...deferredOutputLockDebugMetadata
      }
    });
    this.scheduleDeferredBotTurnOpenFlush({
      session,
      delayMs: normalizedFlushDelayMs,
      reason: normalizedDeferReason
    });
  }

  scheduleDeferredBotTurnOpenFlush({
    session,
    delayMs = BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
    reason = "bot_turn_open_deferred"
  }) {
    if (!session || session.ending) return;
    const pendingQueue = this.deferredActionQueue.getDeferredQueuedUserTurns(session);
    if (!pendingQueue.length) {
      this.deferredActionQueue.clearDeferredVoiceAction(session, "queued_user_turns");
      return;
    }
    const normalizedDelayMs = Math.max(20, Number(delayMs) || BOT_TURN_DEFERRED_FLUSH_DELAY_MS);
    const nextFlushAt = Date.now() + normalizedDelayMs;
    this.deferredActionQueue.setDeferredVoiceAction(session, {
      type: "queued_user_turns",
      goal: "respond_to_deferred_user_turns",
      freshnessPolicy: "regenerate_from_goal",
      status: "scheduled",
      reason,
      notBeforeAt: nextFlushAt,
      expiresAt: 0,
      payload: {
        turns: pendingQueue,
        nextFlushAt
      }
    });
    this.deferredActionQueue.scheduleDeferredVoiceActionRecheck(session, {
      type: "queued_user_turns",
      delayMs: normalizedDelayMs,
      reason
    });
  }

  async flushDeferredBotTurnOpenTurns({
    session,
    deferredTurns = null,
    reason = "bot_turn_open_deferred_flush"
  }) {
    if (!session || session.ending) return;
    const pendingQueue = Array.isArray(deferredTurns)
      ? deferredTurns
      : this.deferredActionQueue.getDeferredQueuedUserTurns(session).slice();
    if (!pendingQueue.length) return;
    if (!Array.isArray(deferredTurns)) {
      const outputChannelState = this.getOutputChannelState(session);
      if (outputChannelState.locked || outputChannelState.captureBlocking) {
        this.scheduleDeferredBotTurnOpenFlush({ session, reason });
        return;
      }
    }
    if (!Array.isArray(deferredTurns)) {
      this.deferredActionQueue.clearDeferredVoiceAction(session, "queued_user_turns");
    }
    const deferredTurnsToFlush = pendingQueue;
    const coalescedTurns = deferredTurnsToFlush.slice(-BOT_TURN_DEFERRED_COALESCE_MAX);
    const turnsForTranscript = coalescedTurns;
    // If any deferred turn was direct-addressed, use that turn's userId and
    // place its transcript first so the wake phrase isn't buried mid-string.
    const directAddressedTurn = turnsForTranscript.find((entry) => entry?.directAddressed) || null;
    const latestTurn = directAddressedTurn || turnsForTranscript[turnsForTranscript.length - 1];
    const orderedTurns = directAddressedTurn
      ? [directAddressedTurn, ...turnsForTranscript.filter((t) => t !== directAddressedTurn)]
      : turnsForTranscript;
    const coalescedTranscript = normalizeVoiceText(
      orderedTurns
        .map((entry) => String(entry?.transcript || "").trim())
        .filter(Boolean)
        .join(" "),
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (!coalescedTranscript) return;
    const coalescedPcmBuffer = isRealtimeMode(session.mode)
      ? Buffer.concat(
        orderedTurns
          .map((entry) => (entry?.pcmBuffer?.length ? entry.pcmBuffer : null))
          .filter(Boolean)
      )
      : null;

    const settings = session.settingsSnapshot || this.store.getSettings();
    const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({ session, settings });
    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      source: "bot_turn_open_deferred_flush"
    });
    if (decision.directAddressed && session && !session.ending) {
      session.lastDirectAddressAt = Date.now();
      session.lastDirectAddressUserId = latestTurn?.userId || null;
    }
    const decisionVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: decision?.voiceAddressing,
      directAddressed: Boolean(decision.directAddressed),
      directedConfidence: Number(decision.directAddressConfidence),
      source: "decision",
      reason: decision.reason
    });
    this.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId: latestTurn?.userId || null,
      text: decision.transcript || coalescedTranscript,
      addressing: decisionVoiceAddressing
    });
    const decisionAddressingState = this.buildVoiceAddressingState({
      session,
      userId: latestTurn?.userId || null
    });
    const deferredOutputLockDebugMetadata = this.replyManager.getOutputLockDebugMetadata(
      session,
      decision.outputLockReason || null
    );

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: latestTurn?.userId || null,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "bot_turn_open_deferred_flush",
        captureReason: latestTurn?.captureReason || "stream_end",
        deferredActionReason: reason,
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0),
        directAddressed: Boolean(decision.directAddressed),
        talkingTo: decisionVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(decisionVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(decisionVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        addressingSource: decisionVoiceAddressing?.source || null,
        addressingReason: decisionVoiceAddressing?.reason || null,
        currentSpeakerTarget: decisionAddressingState?.currentSpeakerTarget || null,
        currentSpeakerDirectedConfidence: Number.isFinite(
          Number(decisionAddressingState?.currentSpeakerDirectedConfidence)
        )
          ? Number(clamp(Number(decisionAddressingState.currentSpeakerDirectedConfidence), 0, 1).toFixed(3))
          : 0,
        transcript: decision.transcript || coalescedTranscript || null,
        deferredTurnCount: coalescedTurns.length,
        conversationState: decision.conversationContext?.engagementState || null,
        conversationEngaged: Boolean(decision.conversationContext?.engaged),
        engagedWithCurrentSpeaker: Boolean(decision.conversationContext?.engagedWithCurrentSpeaker),
        recentAssistantReply: Boolean(decision.conversationContext?.recentAssistantReply),
        msSinceAssistantReply: Number.isFinite(decision.conversationContext?.msSinceAssistantReply)
          ? Math.round(decision.conversationContext.msSinceAssistantReply)
          : null,
        msSinceDirectAddress: Number.isFinite(decision.conversationContext?.msSinceDirectAddress)
          ? Math.round(decision.conversationContext.msSinceDirectAddress)
          : null,
        msSinceInboundAudio: Number.isFinite(decision.msSinceInboundAudio)
          ? Math.round(decision.msSinceInboundAudio)
          : null,
        requiredSilenceMs: Number.isFinite(decision.requiredSilenceMs)
          ? Math.round(decision.requiredSilenceMs)
          : null,
        retryAfterMs: Number.isFinite(decision.retryAfterMs)
          ? Math.round(decision.retryAfterMs)
          : null,
        outputLockReason: decision.outputLockReason || null,
        classifierLatencyMs: Number.isFinite(decision.classifierLatencyMs)
          ? Math.round(decision.classifierLatencyMs)
          : null,
        classifierDecision: decision.classifierDecision || null,
        classifierConfidence: Number.isFinite(decision.classifierConfidence)
          ? Number(clamp(Number(decision.classifierConfidence), 0, 1).toFixed(3))
          : null,
        classifierTarget: decision.classifierTarget || null,
        classifierReason: decision.classifierReason || null,
        musicWakeLatched: Boolean(decision.conversationContext?.musicWakeLatched),
        musicWakeLatchedUntil: Number(session?.musicWakeLatchedUntil || 0) > 0
          ? new Date(Number(session.musicWakeLatchedUntil)).toISOString()
          : null,
        error: decision.error || null,
        ...deferredOutputLockDebugMetadata
      }
    });
    if (!decision.allow) {
      if (
        decision.reason === "bot_turn_open"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId: latestTurn?.userId || null,
          transcript: coalescedTranscript,
          pcmBuffer: coalescedPcmBuffer,
          captureReason: latestTurn?.captureReason || "stream_end",
          source: "bot_turn_open_deferred_flush",
          directAddressed: Boolean(decision.directAddressed),
          deferReason: decision.reason,
          flushDelayMs: decision.retryAfterMs
        });
      }
      return;
    }

    if (session.mode === "stt_pipeline") {
      await this.runSttPipelineReply({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        directAddressed: Boolean(decision.directAddressed),
        directAddressConfidence: Number(decision.directAddressConfidence),
        conversationContext: decision.conversationContext || null
      });
      return;
    }

    if (!isRealtimeMode(session.mode)) return;
    if (useNativeRealtimeReply) {
      if (!coalescedPcmBuffer?.length) return;
      await this.forwardRealtimeTurnAudio({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        pcmBuffer: coalescedPcmBuffer,
        captureReason: "bot_turn_open_deferred_flush"
      });
      return;
    }

    if (this.shouldUseRealtimeTranscriptBridge({ session, settings })) {
      await this.forwardRealtimeTextTurnToBrain({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        captureReason: "bot_turn_open_deferred_flush",
        source: "bot_turn_open_deferred_flush",
        directAddressed: Boolean(decision.directAddressed),
        conversationContext: decision.conversationContext || null
      });
      return;
    }

    await this.runRealtimeBrainReply({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      source: "bot_turn_open_deferred_flush"
    });
  }

  async forwardRealtimeTextTurnToBrain({
    session,
    settings,
    userId,
    transcript = "",
    captureReason = "stream_end",
    source = "openai_realtime_text_turn",
    directAddressed = false,
    conversationContext = null,
    latencyContext = null
  }) {
    if (!session || session.ending) return false;
    if (!providerSupports(session.mode || "", "textInput")) return false;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    if (!session.realtimeClient || typeof session.realtimeClient.requestTextUtterance !== "function") {
      return false;
    }

    const normalizedUserId = String(userId || "").trim() || null;
    this.ensureSessionToolRuntimeState(session);
    if (normalizedUserId) {
      session.lastOpenAiToolCallerUserId = normalizedUserId;
    }
    const speakerName =
      this.resolveVoiceSpeakerName(session, normalizedUserId) || normalizedUserId || "someone";
    const labeledTranscript = normalizeVoiceText(
      `(${speakerName}): ${normalizedTranscript}`,
      STT_REPLY_MAX_CHARS
    );
    if (!labeledTranscript) return false;

    // Cancel any in-flight response so the model sees all user messages and
    // generates a single contextual reply instead of queuing separate responses.
    if (this.replyManager.isRealtimeResponseActive(session)) {
      try {
        const cancel = session.realtimeClient?.cancelActiveResponse;
        if (typeof cancel === "function") {
          cancel.call(session.realtimeClient);
        }
      } catch { /* best-effort */ }
      try { session.voxClient?.stopPlayback(); } catch { /* ignore */ }
      this.replyManager.clearPendingResponse(session);
    }

    const replyInterruptionPolicy = this.buildReplyInterruptionPolicy({
      session,
      userId: normalizedUserId,
      directAddressed: Boolean(directAddressed),
      conversationContext: conversationContext && typeof conversationContext === "object" ? conversationContext : null,
      source: String(source || "openai_realtime_text_turn")
    });
    try {
      await this.instructionManager.prepareRealtimeTurnContext({
        session,
        settings,
        userId: normalizedUserId,
        transcript: normalizedTranscript,
        captureReason
      });
      session.realtimeClient.requestTextUtterance(labeledTranscript);
      this.replyManager.createTrackedAudioResponse({
        session,
        userId: normalizedUserId,
        source: String(source || "openai_realtime_text_turn"),
        resetRetryState: true,
        emitCreateEvent: false,
        interruptionPolicy: replyInterruptionPolicy,
        utteranceText: null,
        latencyContext
      });
      session.lastRequestedRealtimeUtterance = null;

      session.lastGenerationContext = {
        capturedAt: new Date().toISOString(),
        incomingTranscript: normalizedTranscript,
        speakerName,
        directAddressed: Boolean(directAddressed),
        isEagerTurn: false,
        contextMessages: [],
        conversationContext: null,
        userFacts: [],
        relevantFacts: []
      };

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "openai_realtime_text_turn_forwarded",
        metadata: {
          sessionId: session.id,
          source: String(source || "openai_realtime_text_turn"),
          captureReason: String(captureReason || "stream_end"),
          transcript: normalizedTranscript,
          labeledTranscript,
          speakerName
        }
      });
      return true;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `openai_realtime_text_turn_forward_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "openai_realtime_text_turn"),
          captureReason: String(captureReason || "stream_end")
        }
      });
      return false;
    }
  }

  async forwardRealtimeTurnAudio({
    session,
    settings,
    userId,
    transcript = "",
    pcmBuffer,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (!pcmBuffer?.length) return false;
    try {
      session.realtimeClient.appendInputAudioPcm(pcmBuffer);
      session.pendingRealtimeInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0)) + pcmBuffer.length;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_append_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode
        }
      });
      return false;
    }

    if (providerSupports(session.mode || "", "updateInstructions")) {
      this.instructionManager.queueRealtimeTurnContextRefresh({
        session,
        settings,
        userId,
        transcript,
        captureReason
      });
    }
    this.turnProcessor.scheduleResponseFromBufferedAudio({ session, userId });
    return true;
  }

  queueVoiceMemoryIngest({
    session,
    settings,
    userId,
    transcript,
    source = "voice_stt_pipeline_ingest",
    captureReason = "stream_end",
    errorPrefix = "voice_stt_memory_ingest_failed"
  }) {
    if (!settings?.memory?.enabled) return;
    if (!this.memory || typeof this.memory.ingestMessage !== "function") return;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return;

    const ingestPromise = this.memory
      .ingestMessage({
        messageId: `voice-${String(session.guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        authorId: normalizedUserId,
        authorName: this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown",
        content: normalizedTranscript,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: String(source || "voice_stt_pipeline_ingest")
        }
      })
      .catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId || null,
          content: `${String(errorPrefix || "voice_stt_memory_ingest_failed")}: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end")
          }
        });
      });

    if (session) {
      session.pendingMemoryIngest = ingestPromise;
    }
  }

  buildVoiceConversationContext({
    session = null,
    userId = null,
    directAddressed = false,
    addressedToOtherParticipant = false,
    now = Date.now()
  } = {}): VoiceConversationContext {
    const normalizedUserId = String(userId || "").trim();

    const lastAudioDeltaAt = Number(session?.lastAudioDeltaAt || 0);
    const msSinceAssistantReply = lastAudioDeltaAt > 0 ? Math.max(0, now - lastAudioDeltaAt) : null;
    const recentAssistantReply =
      Number.isFinite(msSinceAssistantReply) &&
      msSinceAssistantReply <= RECENT_ENGAGEMENT_WINDOW_MS;

    const lastDirectAddressUserId = String(session?.lastDirectAddressUserId || "").trim();
    const sameAsRecentDirectAddress =
      Boolean(normalizedUserId) &&
      Boolean(lastDirectAddressUserId) &&
      normalizedUserId === lastDirectAddressUserId;
    const lastDirectAddressAt = Number(session?.lastDirectAddressAt || 0);
    const msSinceDirectAddress = lastDirectAddressAt > 0 ? Math.max(0, now - lastDirectAddressAt) : null;
    const recentDirectAddress =
      Number.isFinite(msSinceDirectAddress) &&
      msSinceDirectAddress <= RECENT_ENGAGEMENT_WINDOW_MS;
    const activeVoiceCommandState = this.ensureVoiceCommandState(session);
    const sameAsVoiceCommandUser =
      Boolean(normalizedUserId) &&
      Boolean(activeVoiceCommandState?.userId) &&
      normalizedUserId === activeVoiceCommandState.userId;

    const engagedWithCurrentSpeaker =
      Boolean(directAddressed) ||
      sameAsVoiceCommandUser ||
      (recentAssistantReply && sameAsRecentDirectAddress) ||
      (recentDirectAddress && sameAsRecentDirectAddress);
    const engaged =
      !addressedToOtherParticipant &&
      engagedWithCurrentSpeaker;

    return {
      engagementState: engaged ? "engaged" : activeVoiceCommandState ? "command_only_engaged" : "wake_word_biased",
      engaged,
      engagedWithCurrentSpeaker,
      recentAssistantReply,
      recentDirectAddress,
      sameAsRecentDirectAddress,
      msSinceAssistantReply: Number.isFinite(msSinceAssistantReply) ? msSinceAssistantReply : null,
      msSinceDirectAddress: Number.isFinite(msSinceDirectAddress) ? msSinceDirectAddress : null,
      activeCommandSpeaker: activeVoiceCommandState?.userId || null,
      activeCommandDomain: activeVoiceCommandState?.domain || null,
      activeCommandIntent: activeVoiceCommandState?.intent || null,
      msUntilCommandSessionExpiry: activeVoiceCommandState
        ? Math.max(0, activeVoiceCommandState.expiresAt - now)
        : null
    };
  }

  async evaluateVoiceReplyDecision({
    session,
    settings,
    userId,
    transcript,
    source = "stt_pipeline",
    transcriptionContext = null
  }): Promise<VoiceReplyDecision> {
    return evaluateVoiceReplyDecisionModule(this, {
      session,
      settings,
      userId,
      transcript,
      source,
      transcriptionContext
    });
  }

  formatVoiceDecisionHistory(session, maxTurns = 6, maxTotalChars = VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS) {
    const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
    if (!turns.length) return "";
    const lines = turns
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((turn) => {
        const role = turn?.role === "assistant" ? "assistant" : "user";
        const text = normalizeVoiceText(turn?.text || "", VOICE_DECIDER_HISTORY_MAX_CHARS);
        if (!text) return "";
        const speaker =
          role === "assistant"
            ? getPromptBotName(session?.settingsSnapshot || this.store.getSettings())
            : String(turn?.speakerName || "someone").trim() || "someone";
        const addressing =
          turn?.addressing && typeof turn.addressing === "object" ? turn.addressing : null;
        const talkingTo =
          String(addressing?.talkingTo || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || null;
        const directedConfidenceRaw = Number(addressing?.directedConfidence);
        const directedConfidence = Number.isFinite(directedConfidenceRaw)
          ? clamp(directedConfidenceRaw, 0, 1)
          : 0;
        const addressingSuffix = talkingTo
          ? ` [to ${talkingTo}; confidence ${directedConfidence.toFixed(2)}]`
          : "";
        return `${speaker}: "${text}"${addressingSuffix}`;
      })
      .filter(Boolean);

    const boundedLines = [];
    let totalChars = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      const delimiterChars = boundedLines.length > 0 ? 1 : 0;
      const projectedChars = totalChars + delimiterChars + line.length;
      if (projectedChars > Math.max(120, Number(maxTotalChars) || VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS)) {
        break;
      }
      boundedLines.push(line);
      totalChars = projectedChars;
    }

    return boundedLines.reverse().join("\n");
  }

  normalizeVoiceAddressingAnnotation({
    rawAddressing = null,
    directAddressed = false,
    directedConfidence = Number.NaN,
    source = "",
    reason = null
  } = {}): VoiceAddressingAnnotation | null {
    const input = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
    const talkingToToken = normalizeVoiceAddressingTargetToken(input?.talkingTo ?? input?.target ?? "");
    let talkingTo = talkingToToken || null;

    const confidenceRaw = Number(
      input?.directedConfidence ?? input?.confidence ?? directedConfidence
    );
    let normalizedDirectedConfidence = Number.isFinite(confidenceRaw)
      ? clamp(confidenceRaw, 0, 1)
      : 0;

    if (directAddressed && !talkingTo) {
      talkingTo = "ME";
    }
    if (directAddressed && talkingTo === "ME") {
      normalizedDirectedConfidence = Math.max(normalizedDirectedConfidence, 0.72);
    }

    if (!talkingTo && normalizedDirectedConfidence <= 0) return null;

    const normalizedSource = String(source || "")
      .replace(/\s+/g, "_")
      .trim()
      .toLowerCase()
      .slice(0, 48);
    const normalizedReason =
      String(reason || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140) || null;

    return {
      talkingTo,
      directedConfidence: Number(normalizedDirectedConfidence.toFixed(3)),
      source: normalizedSource || null,
      reason: normalizedReason
    };
  }

  mergeVoiceAddressingAnnotation(
    existing: VoiceAddressingAnnotation | null = null,
    incoming: VoiceAddressingAnnotation | null = null
  ): VoiceAddressingAnnotation | null {
    const current = existing && typeof existing === "object" ? existing : null;
    const next = incoming && typeof incoming === "object" ? incoming : null;
    if (!next) return current;
    if (!current) return next;

    const currentTarget = String(current.talkingTo || "").trim();
    const nextTarget = String(next.talkingTo || "").trim();
    const currentConfidence = Number.isFinite(Number(current.directedConfidence))
      ? clamp(Number(current.directedConfidence), 0, 1)
      : 0;
    const nextConfidence = Number.isFinite(Number(next.directedConfidence))
      ? clamp(Number(next.directedConfidence), 0, 1)
      : 0;
    const nextSource = String(next.source || "").trim().toLowerCase();
    const shouldReplace =
      (nextTarget && !currentTarget) ||
      nextConfidence > currentConfidence + 0.02 ||
      (nextSource === "generation" && nextTarget && nextConfidence >= currentConfidence - 0.05);

    return shouldReplace
      ? {
        ...current,
        ...next
      }
      : current;
  }

  findLatestVoiceTurnIndex(rows, { role = "user", userId = null, text = null, textMaxChars = STT_TRANSCRIPT_MAX_CHARS }) {
    const source = Array.isArray(rows) ? rows : [];
    if (!source.length) return -1;
    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedText = text ? normalizeVoiceText(text, textMaxChars) : "";

    for (let index = source.length - 1; index >= 0; index -= 1) {
      const row = source[index];
      if (!row || typeof row !== "object") continue;
      const rowRole = row.role === "assistant" ? "assistant" : "user";
      if (rowRole !== normalizedRole) continue;
      if (String(row.userId || "") !== String(normalizedUserId || "")) continue;
      if (normalizedText) {
        const rowText = normalizeVoiceText(row.text || "", textMaxChars);
        if (!rowText || rowText !== normalizedText) continue;
      }
      return index;
    }
    return -1;
  }

  annotateLatestVoiceTurnAddressing({
    session = null,
    role = "user",
    userId = null,
    text = "",
    addressing = null
  } = {}) {
    if (!session || session.ending) return false;
    const normalizedAddressing =
      addressing && typeof addressing === "object"
        ? this.normalizeVoiceAddressingAnnotation({ rawAddressing: addressing })
        : null;
    if (!normalizedAddressing) return false;

    const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    const modelTurnIndex = this.findLatestVoiceTurnIndex(modelTurns, {
      role,
      userId,
      text,
      textMaxChars: VOICE_DECIDER_HISTORY_MAX_CHARS
    });
    const transcriptTurnIndex = this.findLatestVoiceTurnIndex(transcriptTurns, {
      role,
      userId,
      text,
      textMaxChars: STT_TRANSCRIPT_MAX_CHARS
    });
    if (modelTurnIndex < 0 && transcriptTurnIndex < 0) return false;

    if (modelTurnIndex >= 0) {
      const current = modelTurns[modelTurnIndex]?.addressing;
      modelTurns[modelTurnIndex] = {
        ...modelTurns[modelTurnIndex],
        addressing: this.mergeVoiceAddressingAnnotation(current, normalizedAddressing)
      };
    }
    if (transcriptTurnIndex >= 0) {
      const current = transcriptTurns[transcriptTurnIndex]?.addressing;
      transcriptTurns[transcriptTurnIndex] = {
        ...transcriptTurns[transcriptTurnIndex],
        addressing: this.mergeVoiceAddressingAnnotation(current, normalizedAddressing)
      };
    }

    return true;
  }

  buildVoiceAddressingState({
    session = null,
    userId = null,
    now = Date.now(),
    maxItems = 6
  } = {}): VoiceAddressingState | null {
    const sourceTurns = Array.isArray(session?.transcriptTurns) ? session.transcriptTurns : [];
    if (!sourceTurns.length) return null;

    const normalizedUserId = String(userId || "").trim();
    const normalizedMaxItems = Math.max(1, Math.min(12, Math.floor(Number(maxItems) || 6)));
    const annotatedRows = sourceTurns
      .filter((row) => row && typeof row === "object" && (row.role === "user" || row.role === "assistant"))
      .map((row) => {
        const normalized = this.normalizeVoiceAddressingAnnotation({
          rawAddressing: row?.addressing
        });
        if (!normalized) return null;
        const atRaw = Number(row?.at || 0);
        const at = atRaw > 0 ? atRaw : null;
        const ageMs = at ? Math.max(0, now - at) : null;
        return {
          role: row.role === "assistant" ? "assistant" : "user",
          userId: String(row?.userId || "").trim() || null,
          speakerName: String(row?.speakerName || "").trim() || "someone",
          talkingTo: normalized.talkingTo || null,
          directedConfidence: Number(normalized.directedConfidence || 0),
          at,
          ageMs
        };
      })
      .filter(Boolean);
    if (!annotatedRows.length) return null;

    const recentAddressingGuesses = annotatedRows
      .slice(-normalizedMaxItems)
      .map((row) => ({
        speakerName: row.speakerName,
        talkingTo: row.talkingTo || null,
        directedConfidence: Number(clamp(Number(row.directedConfidence) || 0, 0, 1).toFixed(3)),
        ageMs: Number.isFinite(row.ageMs) ? Math.round(row.ageMs) : null
      }));

    const currentSpeakerRow = normalizedUserId
      ? [...annotatedRows]
        .reverse()
        .find((row) => row.role === "user" && String(row.userId || "") === normalizedUserId) || null
      : null;
    const lastDirectedToMeRow =
      [...annotatedRows]
        .reverse()
        .find((row) => row.role === "user" && row.talkingTo === "ME" && Number(row.directedConfidence || 0) > 0) ||
      null;

    return {
      currentSpeakerTarget: currentSpeakerRow?.talkingTo || null,
      currentSpeakerDirectedConfidence: Number(
        clamp(Number(currentSpeakerRow?.directedConfidence) || 0, 0, 1).toFixed(3)
      ),
      lastDirectedToMe: lastDirectedToMeRow
        ? {
          speakerName: lastDirectedToMeRow.speakerName,
          directedConfidence: Number(clamp(Number(lastDirectedToMeRow.directedConfidence) || 0, 0, 1).toFixed(3)),
          ageMs: Number.isFinite(lastDirectedToMeRow.ageMs) ? Math.round(lastDirectedToMeRow.ageMs) : null
        }
        : null,
      recentAddressingGuesses
    };
  }

  shouldPersistUserTranscriptTimelineTurn({
    session: _session = null,
    settings: _settings = null,
    transcript = ""
  }: {
    session?: unknown;
    settings?: unknown;
    transcript?: string;
  } = {}) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    return Boolean(normalizedTranscript);
  }

  persistAssistantVoiceTimelineTurn(session, text = "", createdAtMs = Date.now()) {
    if (!session || session.ending) return;
    if (!this.store || typeof this.store.recordMessage !== "function") return;
    const normalizedText = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    const normalizedChannelId = String(session.textChannelId || "").trim();
    const botUserId = String(this.client.user?.id || "").trim();
    if (!normalizedText || !normalizedChannelId || !botUserId) return;

    this.store.recordMessage({
      messageId: `voice-assistant-${String(session.id || "session")}-${String(createdAtMs)}`,
      createdAt: createdAtMs,
      guildId: String(session.guildId || "").trim() || null,
      channelId: normalizedChannelId,
      authorId: botUserId,
      authorName: getPromptBotName(session.settingsSnapshot || this.store.getSettings()),
      isBot: true,
      content: normalizedText,
      referencedMessageId: null
    });
  }

  recordVoiceTurn(session, { role = "user", userId = null, text = "", addressing = null } = {}) {
    if (!session || session.ending) return;
    const normalizedContextText = normalizeVoiceText(text, VOICE_DECIDER_HISTORY_MAX_CHARS);
    const normalizedTranscriptText = normalizeVoiceText(text, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedContextText || !normalizedTranscriptText) return;

    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const turns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    const speakerName =
      normalizedRole === "assistant"
        ? getPromptBotName(session.settingsSnapshot || this.store.getSettings())
        : this.resolveVoiceSpeakerName(session, normalizedUserId) || "someone";
    const previous = turns[turns.length - 1];
    if (
      previous &&
      previous.role === normalizedRole &&
      String(previous.userId || "") === String(normalizedUserId || "") &&
      String(previous.text || "") === normalizedContextText
    ) {
      return;
    }

    const nextAt = Date.now();
    const normalizedSpeakerName = String(speakerName || "").trim() || "someone";
    const normalizedAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: addressing
    });
    const modelTurnEntry: VoiceTimelineTurn = {
      role: normalizedRole,
      userId: normalizedUserId,
      speakerName: normalizedSpeakerName,
      text: normalizedContextText,
      at: nextAt
    };
    if (normalizedAddressing) {
      modelTurnEntry.addressing = normalizedAddressing;
    }
    const transcriptTurnEntry: VoiceTimelineTurn = {
      role: normalizedRole,
      userId: normalizedUserId,
      speakerName: normalizedSpeakerName,
      text: normalizedTranscriptText,
      at: nextAt
    };
    if (normalizedAddressing) {
      transcriptTurnEntry.addressing = normalizedAddressing;
    }
    session.recentVoiceTurns = [
      ...turns,
      modelTurnEntry
    ].slice(-VOICE_DECIDER_HISTORY_MAX_TURNS);
    session.transcriptTurns = [
      ...transcriptTurns,
      transcriptTurnEntry
    ].slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS);
    if (normalizedRole === "assistant") {
      this.persistAssistantVoiceTimelineTurn(session, normalizedTranscriptText, nextAt);
    }
  }

  updateModelContextSummary(session, section, summary = null) {
    if (!session || session.ending) return;
    const key = section === "decider" ? "decider" : "generation";
    const current =
      session.modelContextSummary && typeof session.modelContextSummary === "object"
        ? session.modelContextSummary
        : { generation: null, decider: null };
    current[key] = summary && typeof summary === "object" ? summary : null;
    session.modelContextSummary = current;
  }

  countHumanVoiceParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return 1;

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (channel?.members && typeof channel.members.forEach === "function") {
      let count = 0;
      channel.members.forEach((member) => {
        if (!member?.user?.bot) count += 1;
      });
      return Math.max(0, count);
    }

    if (guild.members?.cache) {
      let count = 0;
      guild.members.cache.forEach((member) => {
        if (member?.user?.bot) return;
        if (String(member?.voice?.channelId || "") !== voiceChannelId) return;
        count += 1;
      });
      return Math.max(0, count);
    }

    return 1;
  }

  extractOpenAiFunctionCallEnvelope(event) {
    if (!event || typeof event !== "object") return null;
    const eventType = String(event.type || "").trim();
    if (!OPENAI_FUNCTION_CALL_ITEM_TYPES.has(eventType)) return null;

    const item =
      event.item && typeof event.item === "object"
        ? event.item
        : event.output_item && typeof event.output_item === "object"
          ? event.output_item
          : null;
    const itemType = String(item?.type || "").trim().toLowerCase();
    if (item && itemType && itemType !== "function_call") return null;

    const callId = normalizeInlineText(event.call_id || item?.call_id, 180);
    const name = normalizeInlineText(event.name || item?.name, 120);
    if (!callId && !name) return null;

    if (eventType === "response.function_call_arguments.delta") {
      const delta = String(event.delta || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      return {
        phase: "delta",
        eventType,
        callId: callId || null,
        name: name || null,
        argumentsFragment: delta
      };
    }

    if (eventType === "response.function_call_arguments.done") {
      const argumentsText = String(event.arguments || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      return {
        phase: "done",
        eventType,
        callId: callId || null,
        name: name || null,
        argumentsFragment: argumentsText
      };
    }

    const itemArguments = String(item?.arguments || event.arguments || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
    return {
      phase: eventType === "response.output_item.done" ? "done" : "added",
      eventType,
      callId: callId || null,
      name: name || null,
      argumentsFragment: itemArguments
    };
  }

  scheduleOpenAiRealtimeToolFollowupResponse({
    session,
    userId = null
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    userId?: string | null;
  } = {}) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateTools")) return;
    if (session.openAiToolResponseDebounceTimer) {
      clearTimeout(session.openAiToolResponseDebounceTimer);
      session.openAiToolResponseDebounceTimer = null;
    }

    session.openAiToolResponseDebounceTimer = setTimeout(() => {
      session.openAiToolResponseDebounceTimer = null;
      if (!session || session.ending) return;
      if (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0) return;
      session.awaitingToolOutputs = false;
      this.replyManager.syncAssistantOutputState(session, "tool_outputs_ready");

      const created = this.replyManager.createTrackedAudioResponse({
        session,
        userId: userId || session.lastOpenAiToolCallerUserId || null,
        source: "tool_call_followup",
        resetRetryState: true,
        emitCreateEvent: true
      });
      if (!created) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "openai_realtime_tool_followup_skipped",
          metadata: {
            sessionId: session.id
          }
        });
        this.replyManager.syncAssistantOutputState(session, "tool_followup_skipped");
      }
    }, OPENAI_TOOL_RESPONSE_DEBOUNCE_MS);
  }

  async handleOpenAiRealtimeFunctionCallEvent({ session, settings, event }) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateTools")) return;
    const envelope = this.extractOpenAiFunctionCallEnvelope(event);
    if (!envelope) return;
    const runtimeSession = this.ensureSessionToolRuntimeState(session);
    if (!runtimeSession) return;

    const pendingCalls = runtimeSession.openAiPendingToolCalls;
    const completedCalls = runtimeSession.openAiCompletedToolCallIds;
    const executions = runtimeSession.openAiToolCallExecutions;
    const normalizedCallId = normalizeInlineText(envelope.callId, 180);
    const normalizedName = normalizeInlineText(envelope.name, 120);
    if (!normalizedCallId) return;
    if (completedCalls instanceof Map) {
      for (const [callId, completedAtMs] of completedCalls.entries()) {
        if (Date.now() - Number(completedAtMs || 0) > OPENAI_COMPLETED_TOOL_CALL_TTL_MS) {
          completedCalls.delete(callId);
        }
      }
      if (completedCalls.has(normalizedCallId)) {
        return;
      }
      if (completedCalls.size > OPENAI_COMPLETED_TOOL_CALL_MAX) {
        const prunedEntries = [...completedCalls.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(-OPENAI_COMPLETED_TOOL_CALL_MAX);
        runtimeSession.openAiCompletedToolCallIds = new Map(prunedEntries);
      }
    }

    const existing = pendingCalls.get(normalizedCallId) || null;
    const pendingCall = existing && typeof existing === "object"
      ? existing
      : {
        callId: normalizedCallId,
        name: normalizedName || "",
        argumentsText: "",
        done: false,
        startedAtMs: Date.now(),
        sourceEventType: envelope.eventType
      };
    if (normalizedName && !pendingCall.name) {
      pendingCall.name = normalizedName;
    }

    const fragment = String(envelope.argumentsFragment || "");
    if (fragment) {
      if (envelope.phase === "delta") {
        pendingCall.argumentsText = `${String(pendingCall.argumentsText || "")}${fragment}`.slice(
          0,
          OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS
        );
      } else {
        pendingCall.argumentsText = fragment.slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      }
    }

    if (envelope.phase === "done") {
      pendingCall.done = true;
    }
    pendingCalls.set(normalizedCallId, pendingCall);
    if (!pendingCall.done) return;
    if (executions.has(normalizedCallId)) return;

    executions.set(normalizedCallId, {
      startedAtMs: Date.now(),
      toolName: pendingCall.name
    });
    session.awaitingToolOutputs = true;
    this.replyManager.syncAssistantOutputState(session, "tool_call_in_progress");

    await this.executeOpenAiRealtimeFunctionCall({
      session,
      settings,
      pendingCall
    });
  }

  resolveVoiceMemoryNamespaceScope({
    session,
    namespace = "",
    authorSpeakerId = null
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    namespace?: string;
    authorSpeakerId?: string | null;
  } = {}) {
    void authorSpeakerId;
    return resolveMemoryToolNamespaceScope({
      guildId: String(session?.guildId || "").trim(),
      actorUserId: session?.lastOpenAiToolCallerUserId || null,
      namespace
    });
  }

  async playVoiceQueueTrackByIndex({ session, settings, index }) {
    const queueState = this.ensureToolMusicQueueState(session);
    if (!queueState) {
      return {
        ok: false,
        error: "queue_unavailable"
      };
    }
    const normalizedIndex = Number.isInteger(Number(index))
      ? clamp(Math.floor(Number(index)), 0, Math.max(0, queueState.tracks.length - 1))
      : queueState.nowPlayingIndex != null
        ? clamp(Math.floor(Number(queueState.nowPlayingIndex)), 0, Math.max(0, queueState.tracks.length - 1))
        : 0;
    const track = queueState.tracks[normalizedIndex];
    if (!track) {
      return {
        ok: false,
        error: "track_not_found"
      };
    }

    const selectedTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist || "Unknown",
      platform: this.normalizeMusicPlatformToken(track.platform, "youtube") || "youtube",
      externalUrl: track.externalUrl || track.streamUrl || null,
      durationSeconds: Number.isFinite(Number(track.durationMs))
        ? Math.max(0, Math.round(Number(track.durationMs) / 1000))
        : null
    };
    await this.requestPlayMusic({
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: session.lastOpenAiToolCallerUserId || null,
      settings,
      query: normalizeInlineText(`${track.title} ${track.artist || ""}`, 120),
      trackId: track.id,
      searchResults: [selectedTrack],
      reason: "voice_tool_music_play",
      source: "voice_tool_call",
      mustNotify: false
    });
    queueState.nowPlayingIndex = normalizedIndex;
    queueState.isPaused = false;
    return {
      ok: true,
      now_playing: {
        ...track
      },
      index: normalizedIndex
    };
  }

  buildVoiceQueueStatePayload(session) {
    const queueState = this.ensureToolMusicQueueState(session);
    if (!queueState) return null;
    return {
      guildId: queueState.guildId,
      voiceChannelId: queueState.voiceChannelId,
      tracks: queueState.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist || null,
        durationMs: track.durationMs,
        source: track.source,
        streamUrl: track.streamUrl || null
      })),
      nowPlayingIndex: queueState.nowPlayingIndex,
      isPaused: queueState.isPaused,
      volume: queueState.volume
    };
  }

  updateVoiceMcpStatus(session, serverName, updates = {}) {
    if (!session || !serverName) return;
    this.ensureSessionToolRuntimeState(session);
    const rows = Array.isArray(session.mcpStatus) ? session.mcpStatus : [];
    const index = rows.findIndex((row) => String(row?.serverName || "") === String(serverName));
    if (index < 0) return;
    rows[index] = {
      ...rows[index],
      ...(updates && typeof updates === "object" ? updates : {})
    };
    session.mcpStatus = rows;
  }

  getVoiceChannelParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return [];

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (!channel?.members || typeof channel.members.forEach !== "function") return [];

    const selfBotId = String(this.client.user?.id || "");
    const participants = [];
    channel.members.forEach((member) => {
      if (!member) return;
      if (member.id === selfBotId) return;
      const displayName = String(member.displayName || member.user?.globalName || member.user?.username || "").trim();
      if (!displayName) return;
      participants.push({
        userId: String(member.id || ""),
        displayName
      });
    });

    return participants.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  getRecentVoiceMembershipEvents(
    session,
    { now = Date.now(), maxItems = VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT } = {}
  ) {
    const events = Array.isArray(session?.membershipEvents) ? session.membershipEvents : [];
    const normalizedNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const boundedMax = clamp(
      Math.floor(Number(maxItems) || VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT),
      1,
      VOICE_MEMBERSHIP_EVENT_MAX_TRACKED
    );

    return events
      .map((entry) => {
        const eventType = String(entry?.eventType || "")
          .trim()
          .toLowerCase();
        if (eventType !== "join" && eventType !== "leave") return null;

        const userId = String(entry?.userId || "").trim();
        const displayName = String(entry?.displayName || "")
          .trim()
          .slice(0, 80);
        const at = Number(entry?.at || 0);
        if (!Number.isFinite(at) || at <= 0) return null;

        return {
          userId,
          displayName: displayName || "unknown",
          eventType,
          at,
          ageMs: Math.max(0, normalizedNow - at)
        };
      })
      .filter((entry) => entry && entry.ageMs <= VOICE_MEMBERSHIP_EVENT_FRESH_MS)
      .slice(-boundedMax);
  }

  recordVoiceMembershipEvent({ session, userId, eventType, displayName = "", at = Date.now() }) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim();
    const normalizedEventType = String(eventType || "")
      .trim()
      .toLowerCase();
    if (!normalizedUserId) return null;
    if (normalizedEventType !== "join" && normalizedEventType !== "leave") return null;

    const membershipEvents = Array.isArray(session.membershipEvents) ? session.membershipEvents : [];
    if (!Array.isArray(session.membershipEvents)) {
      session.membershipEvents = membershipEvents;
    }

    const eventAt = Number.isFinite(Number(at)) ? Math.max(0, Number(at)) : Date.now();
    const resolvedDisplayName =
      String(displayName || "").trim() || this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown";
    const previous = membershipEvents[membershipEvents.length - 1];
    const duplicate =
      previous &&
      String(previous.userId || "").trim() === normalizedUserId &&
      String(previous.eventType || "").trim().toLowerCase() === normalizedEventType &&
      eventAt - Number(previous.at || 0) <= 2500;
    if (duplicate) {
      return null;
    }

    const eventRow = {
      userId: normalizedUserId,
      displayName: resolvedDisplayName.slice(0, 80),
      eventType: normalizedEventType,
      at: eventAt
    };
    membershipEvents.push(eventRow);
    if (membershipEvents.length > VOICE_MEMBERSHIP_EVENT_MAX_TRACKED) {
      session.membershipEvents = membershipEvents.slice(-VOICE_MEMBERSHIP_EVENT_MAX_TRACKED);
    } else {
      session.membershipEvents = membershipEvents;
    }
    return eventRow;
  }

  resolveVoiceSpeakerName(session, userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return "";

    const participants = this.getVoiceChannelParticipants(session);
    const inChannel = participants.find((participant) => participant.userId === normalizedUserId);
    if (inChannel?.displayName) return inChannel.displayName;

    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const guildName =
      guild?.members?.cache?.get(normalizedUserId)?.displayName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.globalName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.username ||
      null;
    if (guildName) return String(guildName);

    const userName = this.client.users?.cache?.get(normalizedUserId)?.username || "";
    return String(userName || "").trim();
  }

  async runSttPipelineReply({
    session,
    settings,
    userId,
    transcript,
    directAddressed = false,
    directAddressConfidence = Number.NaN,
    conversationContext = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!this.llm?.synthesizeSpeech) return;
    if (typeof this.generateVoiceTurn !== "function") return;

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
    const contextTurns = Array.isArray(session.recentVoiceTurns)
      ? session.recentVoiceTurns
        .filter((row) => row && typeof row === "object")
        .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    if (contextTurns.length > 0 && contextTranscript) {
      const lastTurn = contextTurns[contextTurns.length - 1];
      const lastRole = lastTurn?.role === "assistant" ? "assistant" : "user";
      const lastContent = normalizeVoiceText(lastTurn?.text, STT_REPLY_MAX_CHARS);
      if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
        contextTurns.pop();
      }
    }
    const contextMessages = contextTurns
      .map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
      }))
      .filter((row) => row.content);
    const contextMessageChars = contextMessages.reduce((total, row) => total + String(row?.content || "").length, 0);
    this.updateModelContextSummary(session, "generation", {
      source: "stt_pipeline",
      capturedAt: new Date().toISOString(),
      availableTurns: contextTurns.length,
      sentTurns: contextMessages.length,
      maxTurns: STT_CONTEXT_MAX_MESSAGES,
      contextChars: contextMessageChars,
      transcriptChars: normalizedTranscript.length,
      directAddressed: Boolean(directAddressed)
    });
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const resolvedConversationContext =
      conversationContext && typeof conversationContext === "object"
        ? conversationContext
        : this.buildVoiceConversationContext({
          session,
          userId,
          directAddressed: Boolean(directAddressed)
        });
    const participantRoster = this.getVoiceChannelParticipants(session).slice(0, REALTIME_CONTEXT_MEMBER_LIMIT);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const contextNow = Date.now();
    const joinWindowAgeMs = Math.max(0, contextNow - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const sessionTiming = this.sessionLifecycle.buildVoiceSessionTimingContext(session);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const voiceAddressingState = this.buildVoiceAddressingState({
      session,
      userId,
      now: contextNow
    });
    const generationConversationContext = {
      ...(resolvedConversationContext || {}),
      joinWindowActive,
      joinWindowAgeMs: Math.round(joinWindowAgeMs),
      sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
      sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
      streamWatchBrainContext,
      voiceAddressingState
    };

    let replyText = "";
    let requestedSoundboardRefs = [];
    let usedWebSearchFollowup = false;
    let usedOpenArticleFollowup = false;
    let usedScreenShareOffer = false;
    let leaveVoiceChannelRequested = false;
    let generatedVoiceAddressing = null;
    let releaseLookupBusy = null;
    const voiceConversation = getVoiceConversationPolicy(settings);
    const followup = getFollowupSettings(settings);
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        directAddressed: Boolean(directAddressed),
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed && !generationConversationContext?.engaged,
        joinWindowActive,
        joinWindowAgeMs,
        voiceEagerness: Number(voiceConversation.replyEagerness) || 0,
        conversationContext: generationConversationContext,
        sessionTiming,
        participantRoster,
        recentMembershipEvents,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: "stt_pipeline_web_lookup"
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(followup.toolBudget?.toolTimeoutMs),
        voiceToolCallbacks: this.buildVoiceToolCallbacks({ session, settings })
      });
      const generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
            text: generated,
            soundboardRefs: [],
            usedWebSearchFollowup: false,
            usedOpenArticleFollowup: false,
            usedScreenShareOffer: false,
            leaveVoiceChannelRequested: false,
            voiceAddressing: null
          };
      if (generatedPayload?.generationContextSnapshot) {
        session.lastGenerationContext = {
          ...generatedPayload.generationContextSnapshot,
          source: "stt_pipeline",
          mode: session.mode || "stt_pipeline"
        };
      }
      replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
      requestedSoundboardRefs = this.normalizeSoundboardRefs(generatedPayload?.soundboardRefs);
      usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
      usedOpenArticleFollowup = Boolean(generatedPayload?.usedOpenArticleFollowup);
      usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
      leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
      generatedVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
        rawAddressing: generatedPayload?.voiceAddressing,
        directAddressed: Boolean(directAddressed),
        directedConfidence: Number(directAddressConfidence),
        source: "generation",
        reason: "voice_generation"
      });
      if (generatedVoiceAddressing) {
        this.annotateLatestVoiceTurnAddressing({
          session,
          role: "user",
          userId,
          text: normalizedTranscript,
          addressing: generatedVoiceAddressing
        });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `stt_pipeline_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
        releaseLookupBusy = null;
      }
    }
    if (session.ending) return;
    const playbackPlan = this.buildVoiceReplyPlaybackPlan({
      replyText,
      trailingSoundboardRefs: requestedSoundboardRefs
    });
    if (!playbackPlan.spokenText && playbackPlan.soundboardRefs.length === 0 && !leaveVoiceChannelRequested) return;
    const playbackResult = await this.playVoiceReplyInOrder({
      session,
      settings,
      spokenText: playbackPlan.spokenText,
      playbackSteps: playbackPlan.steps,
      source: "stt_pipeline_reply",
      preferRealtimeUtterance: false
    });
    if (!playbackResult.completed) {
      if (playbackPlan.spokenText) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: `[interrupted] ${playbackPlan.spokenText}`
        });
      }
      return;
    }
    const spokeLine = Boolean(playbackResult.spokeLine);

    try {
      const replyAt = Date.now();
      const replyRuntimeEvent = playbackPlan.spokenText
        ? "stt_pipeline_reply_spoken"
        : playbackPlan.soundboardRefs.length > 0
          ? "stt_pipeline_soundboard_only"
          : leaveVoiceChannelRequested
            ? "stt_pipeline_leave_directive"
            : "stt_pipeline_reply_skipped";
      if (spokeLine) {
        session.lastAudioDeltaAt = replyAt;
      }
      session.lastAssistantReplyAt = replyAt;
      if (playbackPlan.spokenText) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: playbackPlan.spokenText
        });
      }
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: replyRuntimeEvent,
        metadata: {
          sessionId: session.id,
          replyText: playbackPlan.spokenText || null,
          spokeLine,
          soundboardRefs: playbackPlan.soundboardRefs,
          playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          leaveVoiceChannelRequested,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `stt_pipeline_audio_write_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }

    if (!leaveVoiceChannelRequested || session.ending) return;

    if (playbackPlan.spokenText && spokeLine) {
      await this.waitForLeaveDirectivePlayback({
        session,
        expectRealtimeAudio: false,
        source: "stt_pipeline_leave_directive"
      });
    }

    await this.endSession({
      guildId: session.guildId,
      reason: "assistant_leave_directive",
      requestedByUserId: this.client.user?.id || null,
      settings,
      announcement: "wrapping up vc."
    }).catch((error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `assistant_leave_directive_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode
        }
      });
    });
  }

  async runRealtimeBrainReply({
    session,
    settings,
    userId,
    transcript = "",
    inputKind = "transcript",
    directAddressed = false,
    directAddressConfidence = Number.NaN,
    conversationContext = null,
    source = "realtime",
    latencyContext = null,
    forceSpokenOutput = false,
    spokenOutputRetryCount = 0
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (typeof this.generateVoiceTurn !== "function") {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_generation_unavailable",
        metadata: {
          sessionId: session.id,
          source: String(source || "realtime")
        }
      });
      return false;
    }

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
    const contextTurns = Array.isArray(session.recentVoiceTurns)
      ? session.recentVoiceTurns
        .filter((row) => row && typeof row === "object")
        .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    if (contextTurns.length > 0 && contextTranscript) {
      const lastTurn = contextTurns[contextTurns.length - 1];
      const lastRole = lastTurn?.role === "assistant" ? "assistant" : "user";
      const lastContent = normalizeVoiceText(lastTurn?.text, STT_REPLY_MAX_CHARS);
      if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
        contextTurns.pop();
      }
    }
    const contextMessages = contextTurns
      .map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
      }))
      .filter((row) => row.content);
    const contextMessageChars = contextMessages.reduce((total, row) => total + String(row?.content || "").length, 0);
    this.updateModelContextSummary(session, "generation", {
      source: String(source || "realtime"),
      capturedAt: new Date().toISOString(),
      availableTurns: contextTurns.length,
      sentTurns: contextMessages.length,
      maxTurns: STT_CONTEXT_MAX_MESSAGES,
      contextChars: contextMessageChars,
      transcriptChars: normalizedTranscript.length,
      directAddressed: Boolean(directAddressed)
    });
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const resolvedConversationContext =
      conversationContext && typeof conversationContext === "object"
        ? conversationContext
        : this.buildVoiceConversationContext({
          session,
          userId,
          directAddressed: Boolean(directAddressed)
        });
    const participantRoster = this.getVoiceChannelParticipants(session).slice(0, REALTIME_CONTEXT_MEMBER_LIMIT);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const contextNow = Date.now();
    const joinWindowAgeMs = Math.max(0, contextNow - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const sessionTiming = this.sessionLifecycle.buildVoiceSessionTimingContext(session);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const voiceAddressingState = this.buildVoiceAddressingState({
      session,
      userId,
      now: contextNow
    });
    const generationConversationContext = {
      ...(resolvedConversationContext || {}),
      joinWindowActive,
      joinWindowAgeMs: Math.round(joinWindowAgeMs),
      sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
      sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
      streamWatchBrainContext,
      voiceAddressingState
    };
    const normalizedLatencyContext =
      latencyContext && typeof latencyContext === "object" ? latencyContext : {};
    const latencyFinalizedAtMs = Math.max(0, Number(normalizedLatencyContext.finalizedAtMs || 0));
    const latencyAsrStartedAtMs = Math.max(0, Number(normalizedLatencyContext.asrStartedAtMs || 0));
    const latencyAsrCompletedAtMs = Math.max(0, Number(normalizedLatencyContext.asrCompletedAtMs || 0));
    const latencyQueueWaitMs = Number.isFinite(Number(normalizedLatencyContext.queueWaitMs))
      ? Math.max(0, Math.round(Number(normalizedLatencyContext.queueWaitMs)))
      : null;
    const latencyPendingQueueDepth = Number.isFinite(Number(normalizedLatencyContext.pendingQueueDepth))
      ? Math.max(0, Math.round(Number(normalizedLatencyContext.pendingQueueDepth)))
      : null;
    const latencyCaptureReason =
      String(normalizedLatencyContext.captureReason || "").trim() || null;

    const generationStartedAt = Date.now();
    let releaseLookupBusy = null;
    let generatedPayload = null;
    let generatedVoiceAddressing = null;
    const voiceConversation = getVoiceConversationPolicy(settings);
    const followup = getFollowupSettings(settings);
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        inputKind,
        directAddressed: Boolean(directAddressed),
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed && !generationConversationContext?.engaged,
        joinWindowActive,
        joinWindowAgeMs,
        voiceEagerness: Number(voiceConversation.replyEagerness) || 0,
        conversationContext: generationConversationContext,
        sessionTiming,
        participantRoster,
        recentMembershipEvents,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: `${String(source || "realtime")}:web_lookup`
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(followup.toolBudget?.toolTimeoutMs),
        voiceToolCallbacks: this.buildVoiceToolCallbacks({ session, settings })
      });
      generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
            text: generated,
            soundboardRefs: [],
            usedWebSearchFollowup: false,
            usedOpenArticleFollowup: false,
            usedScreenShareOffer: false,
            leaveVoiceChannelRequested: false,
            voiceAddressing: null
          };
      if (generatedPayload?.generationContextSnapshot) {
        session.lastGenerationContext = {
          ...generatedPayload.generationContextSnapshot,
          source: String(source || "realtime"),
          mode: session.mode || "realtime"
        };
      }
      generatedVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
        rawAddressing: generatedPayload?.voiceAddressing,
        directAddressed: Boolean(directAddressed),
        directedConfidence: Number(directAddressConfidence),
        source: "generation",
        reason: "voice_generation"
      });
      if (generatedVoiceAddressing) {
        this.annotateLatestVoiceTurnAddressing({
          session,
          role: "user",
          userId,
          text: normalizedTranscript,
          addressing: generatedVoiceAddressing
        });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `realtime_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "realtime")
        }
      });
      return false;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
      }
    }

    const replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
    const requestedSoundboardRefs = this.normalizeSoundboardRefs(generatedPayload?.soundboardRefs);
    const usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
    const usedOpenArticleFollowup = Boolean(generatedPayload?.usedOpenArticleFollowup);
    const usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
    const leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
    const replyInterruptionPolicy = this.buildReplyInterruptionPolicy({
      session,
      userId,
      directAddressed: Boolean(directAddressed),
      conversationContext: resolvedConversationContext,
      generatedVoiceAddressing,
      source: String(source || "realtime")
    });
    const shouldRetryForcedSpeech =
      Boolean(forceSpokenOutput) &&
      !shouldAllowSystemSpeechSkipAfterFire(source) &&
      Number(spokenOutputRetryCount || 0) < 1 &&
      (!replyText || replyText === "[SKIP]");
    if (shouldRetryForcedSpeech) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "realtime_reply_retrying_forced_system_speech",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "realtime"),
          retryCount: Number(spokenOutputRetryCount || 0) + 1
        }
      });
      return await this.runRealtimeBrainReply({
        session,
        settings,
        userId,
        transcript: `${normalizedTranscript} Respond now with one short spoken line. Do not return [SKIP].`,
        inputKind,
        directAddressed,
        directAddressConfidence,
        conversationContext: resolvedConversationContext,
        source,
        latencyContext,
        forceSpokenOutput: true,
        spokenOutputRetryCount: Number(spokenOutputRetryCount || 0) + 1
      });
    }
    const playbackPlan = this.buildVoiceReplyPlaybackPlan({
      replyText,
      trailingSoundboardRefs: requestedSoundboardRefs
    });
    if (!playbackPlan.spokenText && playbackPlan.soundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      const skipCause = !replyText
        ? "empty_reply_text"
        : replyText === "[SKIP]"
          ? "model_skip"
          : "no_playback_steps";
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "realtime_reply_skipped",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "realtime"),
          forceSpokenOutput: Boolean(forceSpokenOutput),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          soundboardRefs: [],
          leaveVoiceChannelRequested,
          skipCause,
          replyTextPreview: replyText ? replyText.slice(0, 220) : null,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          conversationState: resolvedConversationContext?.engagementState || null,
          engagedWithCurrentSpeaker: Boolean(resolvedConversationContext?.engagedWithCurrentSpeaker),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
      return true;
    }

    if (playbackPlan.spokenText && providerSupports(session.mode || "", "updateInstructions")) {
      void this.instructionManager.prepareRealtimeTurnContext({
        session,
        settings,
        userId,
        transcript: normalizedTranscript,
        captureReason: String(source || "realtime")
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `openai_realtime_turn_context_refresh_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            source: String(source || "realtime")
          }
        });
      });
    }

    const replyRequestedAt = Date.now();
    const replyLatencyContext = {
      finalizedAtMs: latencyFinalizedAtMs,
      asrStartedAtMs: latencyAsrStartedAtMs,
      asrCompletedAtMs: latencyAsrCompletedAtMs,
      generationStartedAtMs: generationStartedAt,
      replyRequestedAtMs: replyRequestedAt,
      audioStartedAtMs: 0,
      source: String(source || "realtime"),
      captureReason: latencyCaptureReason,
      queueWaitMs: latencyQueueWaitMs,
      pendingQueueDepth: latencyPendingQueueDepth
    };
    this.setActiveReplyInterruptionPolicy(session, replyInterruptionPolicy);
    session.lastAssistantReplyAt = replyRequestedAt;
    const useRealtimeTts = String(getVoiceConversationPolicy(settings).ttsMode || "").trim().toLowerCase() !== "api";
    const playbackResult = await this.playVoiceReplyInOrder({
      session,
      settings,
      spokenText: playbackPlan.spokenText,
      playbackSteps: playbackPlan.steps,
      source: `${String(source || "realtime")}:reply`,
      preferRealtimeUtterance: useRealtimeTts,
      interruptionPolicy: replyInterruptionPolicy,
      latencyContext: replyLatencyContext
    });
    if (!playbackResult.completed) {
      if (playbackPlan.spokenText) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: `[interrupted] ${playbackPlan.spokenText}`
        });
      }
      this.maybeClearActiveReplyInterruptionPolicy(session);
      return false;
    }
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    this.logVoiceLatencyStage({
      session,
      userId: this.client.user?.id || null,
      stage: "reply_requested",
      source: String(source || "realtime"),
      captureReason: latencyCaptureReason,
      requestId: pendingRequestId,
      queueWaitMs: latencyQueueWaitMs,
      pendingQueueDepth: latencyPendingQueueDepth,
      finalizedAtMs: latencyFinalizedAtMs,
      asrStartedAtMs: latencyAsrStartedAtMs,
      asrCompletedAtMs: latencyAsrCompletedAtMs,
      generationStartedAtMs: generationStartedAt,
      replyRequestedAtMs: replyRequestedAt,
      audioStartedAtMs: 0
    });
    const requestedRealtimeUtterance = Boolean(playbackResult.requestedRealtimeUtterance);
    if (playbackResult.spokeLine && !requestedRealtimeUtterance) {
      session.lastAudioDeltaAt = replyRequestedAt;
      session.lastAssistantReplyAt = replyRequestedAt;
    }
    if (playbackPlan.spokenText && !requestedRealtimeUtterance) {
      this.recordVoiceTurn(session, {
        role: "assistant",
        userId: this.client.user?.id || null,
        text: playbackPlan.spokenText
      });
    }
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_reply_requested",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "realtime"),
        requestId: pendingRequestId,
        replyText: playbackPlan.spokenText || null,
        requestedRealtimeUtterance,
        soundboardRefs: playbackPlan.soundboardRefs,
        playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        talkingTo: generatedVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        leaveVoiceChannelRequested,
        joinWindowActive,
        joinWindowAgeMs: Math.round(joinWindowAgeMs),
        contextTurnsSent: contextMessages.length,
        contextTurnsAvailable: contextTurns.length,
        contextCharsSent: contextMessageChars
      }
    });

    if (leaveVoiceChannelRequested && !session.ending) {
      if (playbackPlan.spokenText && playbackResult.spokeLine) {
        await this.waitForLeaveDirectivePlayback({
          session,
          expectRealtimeAudio: requestedRealtimeUtterance,
          source: `${String(source || "realtime")}:leave_directive`
        });
      }
      await this.endSession({
        guildId: session.guildId,
        reason: "assistant_leave_directive",
        requestedByUserId: this.client.user?.id || null,
        settings,
        announcement: "wrapping up vc."
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `assistant_leave_directive_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            source: String(source || "realtime")
          }
        });
      });
    }

    return true;
  }

  async transcribePcmTurn({
    session,
    userId,
    pcmBuffer,
    model,
    sampleRateHz = 24000,
    captureReason = "stream_end",
    traceSource = "voice_stt_pipeline_turn",
    errorPrefix = "stt_pipeline_transcription_failed",
    emptyTranscriptRuntimeEvent = "voice_transcription_empty",
    emptyTranscriptErrorStreakThreshold = 1,
    suppressEmptyTranscriptLogs = false,
    asrLanguage = "",
    asrPrompt = ""
  }) {
    if (!this.llm?.transcribeAudio || !pcmBuffer?.length) return "";
    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const source = String(traceSource || "voice_stt_pipeline_turn");
    const emptyTranscriptThreshold = Math.max(1, Math.floor(Number(emptyTranscriptErrorStreakThreshold) || 1));
    if (!session.asrEmptyTranscriptStreakBySource || typeof session.asrEmptyTranscriptStreakBySource !== "object") {
      session.asrEmptyTranscriptStreakBySource = {};
    }
    const streaks = session.asrEmptyTranscriptStreakBySource;
    const wavBytes = encodePcm16MonoAsWav(pcmBuffer, sampleRateHz);
    try {
      const transcript = await this.llm.transcribeAudio({
        audioBytes: wavBytes,
        fileName: "turn.wav",
        model: resolvedModel,
        language: asrLanguage,
        prompt: asrPrompt,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          source
        }
      });
      streaks[source] = 0;
      return normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    } catch (error) {
      const message = String(error?.message || error);
      const emptyTranscriptError = /ASR returned empty transcript\.?/i.test(message);
      if (emptyTranscriptError) {
        if (suppressEmptyTranscriptLogs) {
          return "";
        }
        const nextStreak = Math.max(0, Number(streaks[source] || 0)) + 1;
        streaks[source] = nextStreak;
        const escalated = nextStreak >= emptyTranscriptThreshold;
        this.store.logAction({
          kind: escalated ? "voice_error" : "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: escalated
            ? `${String(errorPrefix || "stt_pipeline_transcription_failed")}: ${message}`
            : String(emptyTranscriptRuntimeEvent || "voice_transcription_empty"),
          metadata: {
            sessionId: session.id,
            model: resolvedModel,
            language: String(asrLanguage || "").trim() || null,
            prompt: String(asrPrompt || "").trim() || null,
            captureReason: String(captureReason || "stream_end"),
            source,
            emptyTranscript: true,
            emptyTranscriptStreak: nextStreak,
            emptyTranscriptErrorThreshold: emptyTranscriptThreshold
          }
        });
        return "";
      }
      streaks[source] = 0;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `${String(errorPrefix || "stt_pipeline_transcription_failed")}: ${message}`,
        metadata: {
          sessionId: session.id,
          model: resolvedModel,
          language: String(asrLanguage || "").trim() || null,
          prompt: String(asrPrompt || "").trim() || null,
          captureReason: String(captureReason || "stream_end"),
          source
        }
      });
      return "";
    }
  }

  async endSession({
    guildId,
    reason = "unknown",
    requestedByUserId = null,
    announceChannel = null,
    announcement = undefined,
    settings = null,
    messageId = null
  }) {
    const session = this.sessions.get(String(guildId));
    if (!session) return false;
    if (session.ending) return false;

    const music = this.ensureSessionMusicState(session);
    const musicWasActive = musicPhaseIsActive(this.getMusicPhase(session));
    if (musicWasActive) {
      try {
        const playbackResult = this.musicPlayback?.isConfigured?.()
          ? await this.musicPlayback.stopPlayback()
          : null;
        this.setMusicPhase(session, "idle");
        if (music) {
          music.stoppedAt = Date.now();
          music.lastCommandAt = Date.now();
          music.lastCommandReason = "session_end";
          if (!music.provider) {
            music.provider = playbackResult?.provider || this.musicPlayback?.provider || null;
          }
        }
      } catch {
        this.setMusicPhase(session, "idle");
        if (music) {
          music.stoppedAt = Date.now();
          music.lastCommandAt = Date.now();
          music.lastCommandReason = "session_end";
        }
      }
    }

    session.ending = true;
    this.sessions.delete(String(guildId));

    this.sessionLifecycle.clearSessionRuntimeTimers(session);
    this.sessionLifecycle.clearSessionRuntimeState(session);
    await this.closeAllOpenAiAsrSessions(session, "session_end");
    await this.closeOpenAiSharedAsrSession(session, "session_end");
    this.sessionLifecycle.runSessionCleanupHandlers(session);

    try {
      await session.realtimeClient?.close?.();
    } catch {
      // ignore
    }

    // Destroy subprocess — this handles connection teardown, audio player
    // stop, and all stream cleanup inside the Node.js subprocess.
    try {
      await session.voxClient?.destroy();
    } catch {
      // ignore
    }

    const durationSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    this.store.logAction({
      kind: "voice_session_end",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: requestedByUserId || this.client.user?.id || null,
      content: reason,
      metadata: {
        sessionId: session.id,
        mode: session.mode || "voice_agent",
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        requestedByUserId
      }
    });

    const channel = announceChannel || this.client.channels.cache.get(session.textChannelId);
    if (announcement !== null) {
      const normalizedReason = String(reason || "")
        .trim()
        .toLowerCase();
      const mustNotify = normalizedReason !== "switch_channel" && normalizedReason !== "nl_leave";
      const announcementHint = String(announcement || "").trim();
      const details = {
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        announcementHint: announcementHint || null
      };
      await this.sendOperationalMessage({
        channel,
        settings: settings || session.settingsSnapshot,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: requestedByUserId || this.client.user?.id || null,
        messageId,
        event: "voice_session_end",
        reason,
        details,
        mustNotify
      });
    }

    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const botId = String(this.client.user?.id || "");
    if (!botId) return;

    const stateUserId = String(newState?.id || oldState?.id || "");
    const guildId = String(newState?.guild?.id || oldState?.guild?.id || "");
    if (!guildId) return;

    const session = this.sessions.get(guildId);
    if (!session) return;
    const oldChannelId = String(oldState?.channelId || "");
    const newChannelId = String(newState?.channelId || "");
    const sessionVoiceChannelId = String(session.voiceChannelId || "");

    if (stateUserId !== botId) {
      const stateMember = newState?.member || oldState?.member || null;
      const movedIntoSession = sessionVoiceChannelId && oldChannelId !== sessionVoiceChannelId && newChannelId === sessionVoiceChannelId;
      const movedOutOfSession = sessionVoiceChannelId && oldChannelId === sessionVoiceChannelId && newChannelId !== sessionVoiceChannelId;
      if (movedIntoSession || movedOutOfSession) {
        const recordedEvent = this.recordVoiceMembershipEvent({
          session,
          userId: stateUserId,
          eventType: movedIntoSession ? "join" : "leave",
          displayName: stateMember?.displayName || stateMember?.user?.globalName || stateMember?.user?.username || ""
        });
        if (recordedEvent) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId,
            channelId: session.textChannelId,
            userId: stateUserId,
            content: "voice_membership_changed",
            metadata: {
              sessionId: session.id,
              eventType: recordedEvent.eventType,
              memberUserId: recordedEvent.userId,
              displayName: recordedEvent.displayName,
              participantCount: this.countHumanVoiceParticipants(session)
            }
          });
        }
      }
      if (
        providerSupports(session.mode || "", "updateInstructions") &&
        sessionVoiceChannelId &&
        (oldChannelId === sessionVoiceChannelId || newChannelId === sessionVoiceChannelId)
      ) {
        this.instructionManager.scheduleRealtimeInstructionRefresh({
          session,
          settings: session.settingsSnapshot,
          reason: "voice_membership_changed",
          speakerUserId: stateUserId
        });
      }
      return;
    }

    if (!newState?.channelId) {
      if (!session.botDisconnectTimer) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "bot_disconnect_grace_started",
          metadata: {
            sessionId: session.id,
            graceMs: BOT_DISCONNECT_GRACE_MS
          }
        });
        session.botDisconnectTimer = setTimeout(() => {
          session.botDisconnectTimer = null;
          const liveSession = this.sessions.get(guildId);
          if (!liveSession || liveSession.ending) return;

          const guild = this.client.guilds.cache.get(guildId) || null;
          const liveChannelId = String(guild?.members?.me?.voice?.channelId || "").trim();
          if (liveChannelId) {
            liveSession.voiceChannelId = liveChannelId;
            liveSession.lastActivityAt = Date.now();
            this.instructionManager.scheduleRealtimeInstructionRefresh({
              session: liveSession,
              settings: liveSession.settingsSnapshot,
              reason: "voice_channel_recovered"
            });
            this.store.logAction({
              kind: "voice_runtime",
              guildId,
              channelId: liveSession.textChannelId,
              userId: this.client.user?.id || null,
              content: "bot_disconnect_grace_resolved",
              metadata: {
                sessionId: liveSession.id,
                voiceChannelId: liveChannelId
              }
            });
            return;
          }

          this.endSession({
            guildId,
            reason: "bot_disconnected",
            announcement: "i got disconnected from vc.",
            settings: liveSession.settingsSnapshot
          }).catch((error) => {
            this.store.logAction({
              kind: "voice_error",
              guildId,
              channelId: liveSession.textChannelId,
              userId: this.client.user?.id || null,
              content: `voice_end_session_dispatch_failed: ${String(error?.message || error)}`,
              metadata: {
                sessionId: liveSession.id,
                source: "bot_disconnect_grace",
                reason: "bot_disconnected"
              }
            });
          });
        }, BOT_DISCONNECT_GRACE_MS);
      }
      return;
    }

    if (session.botDisconnectTimer) {
      clearTimeout(session.botDisconnectTimer);
      session.botDisconnectTimer = null;
      this.store.logAction({
        kind: "voice_runtime",
        guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_disconnect_grace_cleared",
        metadata: {
          sessionId: session.id,
          voiceChannelId: String(newState.channelId)
        }
      });
    }

    if (String(newState.channelId) !== session.voiceChannelId) {
      session.voiceChannelId = String(newState.channelId);
      session.lastActivityAt = Date.now();
      this.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings: session.settingsSnapshot,
        reason: "voice_channel_changed"
      });
    }
  }

  buildVoiceInstructions(settings, { soundboardCandidates = [] } = {}) {
    const botName = getPromptBotName(settings);
    const style = getPromptStyle(settings);
    const allowNsfwHumor = shouldAllowVoiceNsfwHumor(settings);
    const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
    const soundboardEnabled = Boolean(getVoiceSoundboardSettings(settings).enabled);
    const soundboardCandidateLines = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const voiceToneGuardrails = buildVoiceToneGuardrails();
    const voiceGuidance = getPromptVoiceGuidance(settings, DEFAULT_PROMPT_VOICE_GUIDANCE);
    const lines = [
      `You are ${botName}, a real-feeling regular in a Discord server, speaking in live voice chat.`,
      `Stay in-character as ${botName}. Style: ${style}.`,
      ...voiceGuidance,
      ...voiceToneGuardrails,
      allowNsfwHumor
        ? "Adult/NSFW humor is allowed for consenting adults, but never include minors, coercion, or targeted harassment."
        : "Keep humor non-sexual by default unless users explicitly request a safe toned-down joke.",
      getPromptCapabilityHonestyLine(settings),
      memoryEnabled
        ? getPromptMemoryEnabledLine(
          settings,
          "You have persistent memory across conversations via saved durable facts. Do not claim each conversation starts from zero."
        )
        : getPromptMemoryDisabledLine(settings),
      getPromptImpossibleActionLine(settings),
      ...buildHardLimitsSection(settings, { maxItems: 12 }),
      "You do not need to respond to filler words, background noise, or things that don't warrant a reply."
    ];

    if (soundboardEnabled && soundboardCandidateLines.length) {
      lines.push("Soundboard control is enabled.");
      lines.push("Available sound refs:");
      lines.push(soundboardCandidateLines.join("\n"));
      lines.push(
        "If you want soundboard effects, insert one or more directives where they should fire: [[SOUNDBOARD:<sound_ref>]] using exact refs from the list."
      );
      lines.push("If no sound should play, omit that directive.");
      lines.push("Never mention or explain the directive in normal speech.");
    }

    return lines.join("\n");
  }

  async sendOperationalMessage({
    channel,
    settings = null,
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = "voice_runtime",
    reason = null,
    details = {},
    mustNotify = false
  }) {
    return await sendOperationalMessage(this, {
      channel,
      settings,
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason,
      details,
      mustNotify
    });
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

  getMissingJoinPermissionInfo({ guild, voiceChannel }) {
    const me = guild?.members?.me;
    if (!me) {
      return {
        reason: "bot_member_unavailable",
        missingPermissions: []
      };
    }

    const perms = voiceChannel?.permissionsFor?.(me);
    const missingPermissions = [];
    if (!perms?.has(PermissionFlagsBits.Connect)) missingPermissions.push("CONNECT");
    if (!perms?.has(PermissionFlagsBits.Speak)) missingPermissions.push("SPEAK");
    if (!missingPermissions.length) return null;
    return {
      reason: "missing_voice_permissions",
      missingPermissions
    };
  }

  async handleMusicSlashCommand(
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) {
    return await handleMusicSlashCommandRuntime(this, interaction, settings);
  }

  async handleClankSlashCommand(
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) {
    const guild = interaction.guild;
    const user = interaction.user;
    if (!guild) {
      await interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
      return;
    }
    const guildId = guild.id;
    const session = this.sessions.get(guildId);
    if (!session || session.ending) {
      await interaction.reply({ content: "No active voice session in this server.", ephemeral: true });
      return;
    }
    if (session.mode !== "stt_pipeline") {
      await interaction.reply({ content: "The /clank command is only available in STT pipeline voice mode.", ephemeral: true });
      return;
    }

    const message = interaction.options.getString("message", true);
    const normalizedMessage = normalizeVoiceText(message, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedMessage) {
      await interaction.reply({ content: "Message cannot be empty.", ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      await this.injectTextTurn({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        userId: user.id,
        text: normalizedMessage,
        source: "slash_command_clank"
      });
      await interaction.editReply(`Processing: "${normalizedMessage}"`);
    } catch (error) {
      await interaction.editReply(`Failed to process message: ${String(error?.message || error)}`);
    }
  }

  async injectTextTurn({
    session,
    settings = null,
    userId,
    text,
    source = "text_injection"
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const normalizedText = normalizeVoiceText(text, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedText) return;

    this.recordVoiceTurn(session, {
      role: "user",
      userId,
      text: normalizedText
    });

    session.lastActivityAt = Date.now();
    session.lastDirectAddressAt = Date.now();
    session.lastDirectAddressUserId = userId;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_text_turn_injected",
      metadata: {
        sessionId: session.id,
        source,
        textLength: normalizedText.length
      }
    });

    await this.runSttPipelineReply({
      session,
      settings: resolvedSettings,
      userId,
      transcript: normalizedText,
      directAddressed: true,
      directAddressConfidence: 1.0,
      conversationContext: this.buildVoiceConversationContext({
        session,
        userId,
        directAddressed: true
      })
    });
  }

  ensureSessionToolRuntimeState(session) {
    return ensureSessionToolRuntimeState(this, session);
  }

  getVoiceMcpServerStatuses() {
    return getVoiceMcpServerStatuses(this);
  }

  resolveVoiceRealtimeToolDescriptors(opts: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: VoiceRealtimeToolSettings | null;
  } = {}) {
    return resolveVoiceRealtimeToolDescriptors(this, opts);
  }

  buildRealtimeFunctionTools(opts: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: VoiceRealtimeToolSettings | null;
  } = {}) {
    return buildRealtimeFunctionTools(this, opts);
  }

  recordVoiceToolCallEvent(opts: {
    session?: VoiceToolRuntimeSessionLike | null;
    event?: VoiceToolCallEvent | null;
  } = {}) {
    return recordVoiceToolCallEvent(this, opts);
  }

  parseOpenAiRealtimeToolArguments(argumentsText = "") {
    return parseOpenAiRealtimeToolArguments(this, argumentsText);
  }

  resolveOpenAiRealtimeToolDescriptor(session, toolName = "") {
    return resolveOpenAiRealtimeToolDescriptor(this, session, toolName);
  }

  summarizeVoiceToolOutput(output: unknown = null) {
    return summarizeVoiceToolOutput(this, output);
  }

  async executeOpenAiRealtimeFunctionCall(opts: {
    session;
    settings;
    pendingCall;
  }) {
    return executeOpenAiRealtimeFunctionCall(this, opts);
  }

  async refreshRealtimeTools(opts: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: VoiceRealtimeToolSettings | null;
    reason?: string;
  } = {}) {
    return refreshRealtimeTools(this, opts);
  }

  async executeVoiceMemorySearchTool(opts: {
    session;
    settings;
    args;
  }) {
    return executeVoiceMemorySearchTool(this, opts);
  }

  async executeVoiceMemoryWriteTool(opts: {
    session;
    settings;
    args;
  }) {
    return executeVoiceMemoryWriteTool(this, opts);
  }

  async executeVoiceAdaptiveStyleAddTool(opts: {
    session;
    args;
  }) {
    return executeVoiceAdaptiveStyleAddTool(this, opts);
  }

  async executeVoiceAdaptiveStyleRemoveTool(opts: {
    session;
    args;
  }) {
    return executeVoiceAdaptiveStyleRemoveTool(this, opts);
  }

  async executeVoiceConversationSearchTool(opts: {
    session;
    args;
  }) {
    return executeVoiceConversationSearchTool(this, opts);
  }

  async executeVoiceMusicSearchTool(opts: { session; args }) {
    return executeVoiceMusicSearchTool(this, opts);
  }

  async executeVoiceMusicQueueAddTool(opts: { session; settings; args }) {
    return executeVoiceMusicQueueAddTool(this, opts);
  }

  async executeVoiceMusicQueueNextTool(opts: { session; settings; args }) {
    return executeVoiceMusicQueueNextTool(this, opts);
  }

  async executeVoiceMusicPlayNowTool(opts: { session; settings; args }) {
    return executeVoiceMusicPlayNowTool(this, opts);
  }

  async executeVoiceWebSearchTool(opts: { session; settings; args }) {
    return executeVoiceWebSearchTool(this, opts);
  }

  async executeLocalVoiceToolCall(opts: {
    session;
    settings;
    toolName;
    args;
    signal?: AbortSignal;
  }) {
    return executeLocalVoiceToolCall(this, opts);
  }

  async executeMcpVoiceToolCall(opts: {
    session;
    settings;
    toolDescriptor;
    args;
  }) {
    return executeMcpVoiceToolCall(this, opts);
  }

  buildVoiceToolCallbacks({ session, settings }) {
    return {
      musicSearch: (query: string, limit: number) =>
        this.executeVoiceMusicSearchTool({ session, args: { query, max_results: limit } }),
      musicQueueAdd: (trackIds: string[], position?: number | "end") =>
        this.executeVoiceMusicQueueAddTool({ session, settings, args: { tracks: trackIds, position } }),
      musicPlayNow: (trackId: string) =>
        this.executeVoiceMusicPlayNowTool({ session, settings, args: { track_id: trackId } }),
      musicQueueNext: (trackIds: string[]) =>
        this.executeVoiceMusicQueueNextTool({ session, settings, args: { tracks: trackIds } }),
      musicStop: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "music_stop", args: {} }),
      musicPause: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "music_pause", args: {} }),
      musicResume: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "music_resume", args: {} }),
      musicSkip: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "music_skip", args: {} }),
      musicNowPlaying: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "music_now_playing", args: {} }),
      leaveVoiceChannel: () =>
        this.executeLocalVoiceToolCall({ session, settings, toolName: "leave_voice_channel", args: {} })
    };
  }
}


export {
  parseVoiceDecisionContract,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
