import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { resolveMemoryToolNamespaceScope } from "../memory/memoryToolRuntime.ts";
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
const AUDIO_DEBUG = !!process.env.AUDIO_DEBUG;
import { estimateUsdCost } from "../pricing.ts";
import { clamp } from "../utils.ts";
import { hasBotNameCue } from "../directAddressConfidence.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import {
  defaultVoiceReplyDecisionModel,
  isLowSignalVoiceFragment,
  normalizeVoiceReplyDecisionProvider,
  parseVoiceThoughtDecisionContract,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";
import {
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeTranscriptionModel
} from "./realtimeProviderNormalization.ts";
import { createMusicPlaybackProvider } from "./musicPlayback.ts";
import { createMusicSearchProvider } from "./musicSearch.ts";
import { createDiscordMusicPlayer } from "./musicPlayer.ts";
import {
  clearMusicDisambiguationState as clearMusicDisambiguationStateRuntime,
  ensureSessionMusicState as ensureSessionMusicStateRuntime,
  ensureToolMusicQueueState as ensureToolMusicQueueStateRuntime,
  evaluateMusicStopIntentFromTranscript as evaluateMusicStopIntentFromTranscriptRuntime,
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
  isMusicPlaybackActive as isMusicPlaybackActiveRuntime,
  maybeHandleMusicPlaybackTurn as maybeHandleMusicPlaybackTurnRuntime,
  maybeHandleMusicTextSelectionRequest as maybeHandleMusicTextSelectionRequestRuntime,
  maybeHandleMusicTextStopRequest as maybeHandleMusicTextStopRequestRuntime,
  normalizeMusicPlatformToken as normalizeMusicPlatformTokenRuntime,
  normalizeMusicSelectionResult as normalizeMusicSelectionResultRuntime,
  playMusicViaDiscord as playMusicViaDiscordRuntime,
  requestPauseMusic as requestPauseMusicRuntime,
  requestPlayMusic as requestPlayMusicRuntime,
  requestStopMusic as requestStopMusicRuntime,
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
import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";
import {
  REALTIME_MEMORY_FACT_LIMIT,
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  buildRealtimeTextUtterancePrompt,
  encodePcm16MonoAsWav,
  extractSoundboardDirective,
  findMentionedSoundboardReference,
  getRealtimeCommitMinimumBytes,
  formatRealtimeMemoryFacts,
  formatSoundboardCandidateLine,
  getRealtimeRuntimeLabel,
  isFinalRealtimeTranscriptEventType,
  isRecoverableRealtimeError,
  isRealtimeMode,
  isVoiceTurnAddressedToBot,
  matchSoundboardReference,
  normalizeVoiceText,
  parseSoundboardDirectiveSequence,
  parsePreferredSoundboardReferences,
  parseRealtimeErrorPayload,
  parseResponseDoneId,
  parseResponseDoneModel,
  parseResponseDoneStatus,
  parseResponseDoneUsage,
  resolveVoiceAsrLanguageGuidance,
  resolveRealtimeProvider,
  shortError,
  shouldAllowVoiceNsfwHumor,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import { requestJoin } from "./voiceJoinFlow.ts";
import { evaluateVoiceReplyDecision as evaluateVoiceReplyDecisionModule } from "./voiceReplyDecision.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  ACTIVITY_TOUCH_THROTTLE_MS,
  BARGE_IN_ASSERTION_MS,
  BARGE_IN_ASSERTION_IDLE_MS,
  BARGE_IN_FULL_OVERRIDE_MIN_MS,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_RETRY_MAX_AGE_MS,
  BARGE_IN_SUPPRESSION_MAX_MS,
  BOT_DISCONNECT_GRACE_MS,
  BOT_TURN_DEFERRED_COALESCE_MAX,
  BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
  BOT_TURN_DEFERRED_QUEUE_MAX,
  BOT_TURN_SILENCE_RESET_MS,
  CAPTURE_IDLE_FLUSH_MS,
  CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX,
  CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS,
  CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX,
  CAPTURE_MAX_DURATION_MS,
  RECENT_ENGAGEMENT_WINDOW_MS,
  INPUT_SPEECH_END_SILENCE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS,
  LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_POLL_MS,
  LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS,
  MAX_INACTIVITY_SECONDS,
  MAX_MAX_SESSION_MINUTES,
  OPENAI_REALTIME_MAX_SESSION_MINUTES,
  MAX_RESPONSE_SILENCE_RETRIES,
  MIN_INACTIVITY_SECONDS,
  MIN_MAX_SESSION_MINUTES,
  MIN_RESPONSE_REQUEST_GAP_MS,
  OPENAI_ACTIVE_RESPONSE_RETRY_MS,
  JOIN_GREETING_LLM_WINDOW_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
  REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS,
  REALTIME_TURN_COALESCE_MAX_BYTES,
  REALTIME_TURN_COALESCE_WINDOW_MS,
  REALTIME_TURN_PENDING_MERGE_MAX_BYTES,
  REALTIME_TURN_QUEUE_MAX,
  REALTIME_TURN_STALE_SKIP_MS,
  RESPONSE_DONE_SILENCE_GRACE_MS,
  RESPONSE_FLUSH_DEBOUNCE_MS,
  RESPONSE_SILENCE_RETRY_DELAY_MS,
  OPENAI_ASR_SESSION_IDLE_TTL_MS,
  OPENAI_ASR_BRIDGE_MAX_WAIT_MS,
  OPENAI_ASR_TRANSCRIPT_STABLE_MS,
  OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS,
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
  STT_TURN_COALESCE_MAX_BYTES,
  STT_TURN_COALESCE_WINDOW_MS,
  STT_TURN_QUEUE_MAX,
  STT_TURN_STALE_SKIP_MS,
  VOICE_DECIDER_HISTORY_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_FRESH_MS,
  VOICE_MEMBERSHIP_EVENT_MAX_TRACKED,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
  VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
  VOICE_THOUGHT_MAX_CHARS,
  VOICE_THOUGHT_MEMORY_SEARCH_LIMIT,
  VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
  VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS,
  VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
  VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX,
  VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS,
  VOICE_FALLBACK_NOISE_GATE_PEAK_MAX,
  VOICE_FALLBACK_NOISE_GATE_RMS_MAX,
  VOICE_INACTIVITY_WARNING_SECONDS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_MAX_DURATION_WARNING_SECONDS,
  VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS,
  VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS,
  VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS,
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_SILENCE_GATE_PEAK_MAX,
  VOICE_SILENCE_GATE_RMS_MAX,
  VOICE_LOOKUP_BUSY_MAX_CHARS,
  VOICE_TURN_MIN_ASR_CLIP_MS,
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import { loadPromptMemorySliceFromMemory } from "../memory/promptMemorySlice.ts";
import { providerSupports } from "./voiceModes.ts";
import { ensureSessionToolRuntimeState, getVoiceMcpServerStatuses, resolveVoiceRealtimeToolDescriptors, buildRealtimeFunctionTools, recordVoiceToolCallEvent, parseOpenAiRealtimeToolArguments, resolveOpenAiRealtimeToolDescriptor, summarizeVoiceToolOutput, executeOpenAiRealtimeFunctionCall, refreshRealtimeTools, executeVoiceMemorySearchTool, executeVoiceMemoryWriteTool, executeVoiceAdaptiveStyleAddTool, executeVoiceAdaptiveStyleRemoveTool, executeVoiceConversationSearchTool, executeVoiceMusicSearchTool, executeVoiceMusicQueueAddTool, executeVoiceMusicQueueNextTool, executeVoiceMusicPlayNowTool, executeVoiceWebSearchTool, executeLocalVoiceToolCall, executeMcpVoiceToolCall } from "./voiceToolCalls.ts";
import { formatAdaptiveDirectives, formatConversationWindows, formatRecentLookupContext } from "../prompts/promptFormatters.ts";
import {
  loadConversationContinuityContext
} from "../bot/conversationContinuity.ts";
import type { ConversationContinuityPayload } from "../bot/conversationContinuity.ts";
import type { DeferredQueuedUserTurn, DeferredQueuedUserTurnsAction } from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseIsAudible,
  musicPhaseShouldLockOutput,
  musicPhaseShouldForceCommandOnly,
  musicPhaseShouldAllowDucking,
  musicPhaseCanResume
} from "./voiceSessionTypes.ts";

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

function normalizeInlineText(value: unknown = "", maxChars = STT_TRANSCRIPT_MAX_CHARS) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, Number(maxChars) || STT_TRANSCRIPT_MAX_CHARS));
}

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
  openAiToolCallExecutions?: Map<string, Promise<void>>;
  openAiPendingToolCalls?: Map<string, unknown>;
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
      const deferredQueue = this.getDeferredQueuedUserTurns(session);
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
            greetingPending: Boolean(this.getDeferredVoiceAction(session, "join_greeting")),
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
              closing: Boolean(asr.closing),
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
            closing: Boolean(shared.closing),
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
    const resolved = settings || session?.settingsSnapshot || this.store.getSettings();
    if (resolved?.voice?.commandOnlyMode) return true;
    return musicPhaseShouldForceCommandOnly(this.getMusicPhase(session));
  }

  isMusicPlaybackAudible(session) {
    return musicPhaseIsAudible(this.getMusicPhase(session));
  }

  resolveMusicDuckingConfig(settings = null) {
    const resolved = settings || this.store.getSettings();
    const targetGainRaw = Number(resolved?.voice?.musicDucking?.targetGain);
    const fadeMsRaw = Number(resolved?.voice?.musicDucking?.fadeMs);
    return {
      targetGain: clamp(
        Number.isFinite(targetGainRaw) ? targetGainRaw : 0.15,
        0.05,
        1
      ),
      fadeMs: clamp(
        Number.isFinite(fadeMsRaw) ? Math.round(fadeMsRaw) : 300,
        0,
        5000
      )
    };
  }

  clearBotSpeechMusicUnduckTimer(session) {
    if (!session) return;
    if (session.botSpeechMusicUnduckTimer) {
      clearTimeout(session.botSpeechMusicUnduckTimer);
      session.botSpeechMusicUnduckTimer = null;
    }
  }

  async engageBotSpeechMusicDuck(session, settings = null, { awaitFade = false } = {}) {
    if (!session || session.ending) return false;
    if (!musicPhaseShouldAllowDucking(this.getMusicPhase(session))) {
      session.botSpeechMusicDucked = false;
      return false;
    }
    this.clearBotSpeechMusicUnduckTimer(session);
    const music = this.ensureSessionMusicState(session);
    if (music?.ducked) {
      session.botSpeechMusicDucked = true;
      return true;
    }
    const { targetGain, fadeMs } = this.resolveMusicDuckingConfig(
      settings || session.settingsSnapshot || this.store.getSettings()
    );
    const duckPromise = this.musicPlayer?.duck({ targetGain, fadeMs });
    if (music) music.ducked = true;
    session.botSpeechMusicDucked = true;
    if (awaitFade) {
      await duckPromise;
    }
    return true;
  }

  scheduleBotSpeechMusicUnduck(session, settings = null, delayMs = BOT_TURN_SILENCE_RESET_MS) {
    if (!session || session.ending) return;
    const music = this.ensureSessionMusicState(session);
    if (!session.botSpeechMusicDucked && !music?.ducked) return;
    this.clearBotSpeechMusicUnduckTimer(session);
    const normalizedDelayMs = clamp(Math.round(Number(delayMs) || 0), 0, 15_000);
    session.botSpeechMusicUnduckTimer = setTimeout(() => {
      session.botSpeechMusicUnduckTimer = null;
      this.releaseBotSpeechMusicDuck(session, settings).catch(() => undefined);
    }, normalizedDelayMs);
  }

  async releaseBotSpeechMusicDuck(session, settings = null, { force = false } = {}) {
    if (!session) return false;
    this.clearBotSpeechMusicUnduckTimer(session);
    const music = this.ensureSessionMusicState(session);
    const ducked = Boolean(music?.ducked) || Boolean(session.botSpeechMusicDucked);
    if (!ducked) {
      return false;
    }
    session.botSpeechMusicDucked = false;
    if (music) music.ducked = false;
    if (!force && !musicPhaseShouldAllowDucking(this.getMusicPhase(session))) {
      return false;
    }
    const { fadeMs } = this.resolveMusicDuckingConfig(
      settings || session.settingsSnapshot || this.store.getSettings()
    );
    this.musicPlayer?.unduck({ targetGain: 1, fadeMs });
    return true;
  }


  isAsrActive(session, settings = null) {
    const resolved = settings || session?.settingsSnapshot || this.store.getSettings();
    if (!resolved?.voice?.asrEnabled) return false;
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
    const aliases = Array.isArray(resolvedSettings?.botNameAliases) ? resolvedSettings.botNameAliases : [];
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

  async evaluateMusicStopIntentFromTranscript({
    session,
    settings,
    userId,
    transcript = "",
    source = "voice_music_turn"
  }) {
    return await evaluateMusicStopIntentFromTranscriptRuntime(this, {
      session,
      settings,
      userId,
      transcript,
      source
    });
  }

  async maybeHandleMusicPlaybackTurn({
    session,
    settings,
    userId,
    pcmBuffer,
    captureReason = "stream_end",
    source = "voice_turn"
  }) {
    return await maybeHandleMusicPlaybackTurnRuntime(this, {
      session,
      settings,
      userId,
      pcmBuffer,
      captureReason,
      source
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
    const preferred = parsePreferredSoundboardReferences(settings?.voice?.soundboard?.preferredSoundIds);
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
    const voiceEnabled = Boolean(settings?.voice?.enabled);
    const allowlist = new Set(settings?.voice?.allowedVoiceChannelIds || []);
    const blocklist = new Set(settings?.voice?.blockedVoiceChannelIds || []);

    for (const session of [...this.sessions.values()]) {
      session.settingsSnapshot = settings || session.settingsSnapshot;

      if (!voiceEnabled) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_disabled",
          announcement: "voice mode was disabled, leaving vc.",
          settings
        });
        continue;
      }

      if (blocklist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_blocked",
          announcement: "this vc is now blocked for me, leaving.",
          settings
        });
        continue;
      }

      if (allowlist.size > 0 && !allowlist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_not_allowlisted",
          announcement: "this vc is no longer allowlisted, leaving.",
          settings
        });
        continue;
      }

      this.touchActivity(session.guildId, settings);
    }
  }

  startSessionTimers(session, settings) {
    const maxSessionMinutesCap = isRealtimeMode(session?.mode)
      ? OPENAI_REALTIME_MAX_SESSION_MINUTES
      : MAX_MAX_SESSION_MINUTES;
    const maxSessionMinutes = clamp(
      Number(settings.voice?.maxSessionMinutes) || 30,
      MIN_MAX_SESSION_MINUTES,
      maxSessionMinutesCap
    );
    const maxDurationMs = maxSessionMinutes * 60_000;

    session.maxEndsAt = Date.now() + maxDurationMs;
    session.maxTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "max_duration",
        announcement: `max session time (${maxSessionMinutes}m) reached, leaving vc.`,
        settings
      }).catch(() => undefined);
    }, maxDurationMs);

    this.touchActivity(session.guildId, settings);
  }

  touchActivity(guildId, settings) {
    const session = this.sessions.get(String(guildId));
    if (!session) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();

    const inactivitySeconds = clamp(
      Number(resolvedSettings?.voice?.inactivityLeaveSeconds) || 300,
      MIN_INACTIVITY_SECONDS,
      MAX_INACTIVITY_SECONDS
    );

    session.lastActivityAt = Date.now();
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);

    session.inactivityEndsAt = Date.now() + inactivitySeconds * 1000;
    session.inactivityTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "inactivity_timeout",
        announcement: `no one talked for ${inactivitySeconds}s, leaving vc.`,
        settings: resolvedSettings
      }).catch(() => undefined);
    }, inactivitySeconds * 1000);

    this.scheduleVoiceThoughtLoop({
      session,
      settings: resolvedSettings
    });
  }

  buildVoiceSessionTimingContext(session) {
    if (!session || typeof session !== "object") return null;

    const now = Date.now();
    const maxEndsAt = Number(session.maxEndsAt);
    const inactivityEndsAt = Number(session.inactivityEndsAt);
    const maxSecondsRemaining = Number.isFinite(maxEndsAt)
      ? Math.max(0, Math.ceil((maxEndsAt - now) / 1000))
      : null;
    const inactivitySecondsRemaining = Number.isFinite(inactivityEndsAt)
      ? Math.max(0, Math.ceil((inactivityEndsAt - now) / 1000))
      : null;

    const maxDurationWarningActive =
      Number.isFinite(maxSecondsRemaining) && maxSecondsRemaining <= VOICE_MAX_DURATION_WARNING_SECONDS;
    const inactivityWarningActive =
      Number.isFinite(inactivitySecondsRemaining) && inactivitySecondsRemaining <= VOICE_INACTIVITY_WARNING_SECONDS;

    let timeoutWarningReason = "none";
    if (maxDurationWarningActive && inactivityWarningActive) {
      timeoutWarningReason =
        maxSecondsRemaining <= inactivitySecondsRemaining
          ? "max_duration"
          : "inactivity";
    } else if (maxDurationWarningActive) {
      timeoutWarningReason = "max_duration";
    } else if (inactivityWarningActive) {
      timeoutWarningReason = "inactivity";
    }

    return {
      timeoutWarningActive: maxDurationWarningActive || inactivityWarningActive,
      timeoutWarningReason,
      maxSecondsRemaining,
      inactivitySecondsRemaining
    };
  }

  bindSubprocessHandlers(session) {
    if (!session?.subprocessClient) return;

    const onPlayerState = (status) => {
      session.playerState = status;
      if (status === "playing") {
        session.lastActivityAt = Date.now();
      }
      if (AUDIO_DEBUG) {
        console.log(`[subprocess:audio-player] → ${status}`);
      }
    };

    const onError = (message) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "subprocess_error",
        metadata: { sessionId: session.id, error: String(message || "unknown") }
      });
    };

    // Note: connectionState and crashed handlers are registered in
    // bindSessionHandlers to avoid duplicate endSession calls.

    const onPlaybackArmed = (reason) => {
      session.playbackArmed = true;
      session.playbackArmedReason = reason;
      session.playbackArmedAt = Date.now();
      if (reason !== "connection_ready") return;
      this.setDeferredVoiceAction(session, {
        type: "join_greeting",
        goal: "announce_join",
        freshnessPolicy: "regenerate_from_goal",
        status: "scheduled",
        reason: "connection_ready",
        notBeforeAt: Date.now() + 2500,
        expiresAt: Number(session.startedAt || 0) + JOIN_GREETING_LLM_WINDOW_MS,
        payload: {
          trigger: "connection_ready"
        }
      });
      // If instructions are already set, start the observation grace window.
      if (session.lastOpenAiRealtimeInstructions && !session.lastAssistantReplyAt) {
        this.scheduleJoinGreetingGrace(session);
      }
    };

    const onMusicIdle = () => {
      this.setMusicPhase(session, "idle");
      const music = this.ensureSessionMusicState(session);
      if (music) {
        music.stoppedAt = Date.now();
        music.ducked = false;
      }
      this.musicPlayer?.clearCurrentTrack?.();
      this.scheduleRealtimeInstructionRefresh({
        session,
        settings: session.settingsSnapshot || this.store.getSettings(),
        reason: "music_idle"
      });
    };

    const onMusicError = () => {
      this.setMusicPhase(session, "idle");
      const music = this.ensureSessionMusicState(session);
      if (music) {
        music.stoppedAt = Date.now();
        music.ducked = false;
      }
      this.musicPlayer?.clearCurrentTrack?.();
    };

    session.subprocessClient.on("playerState", onPlayerState);
    session.subprocessClient.on("playbackArmed", onPlaybackArmed);
    session.subprocessClient.on("musicIdle", onMusicIdle);
    session.subprocessClient.on("musicError", onMusicError);
    session.subprocessClient.on("error", onError);

    // Replay sticky playback-armed state in case the subprocess emitted it
    // before handlers were attached (join bootstrap race).
    const armedReason = session.subprocessClient.getPlaybackArmedReason?.();
    if (armedReason) {
      onPlaybackArmed(armedReason);
    }

    session.cleanupHandlers.push(() => {
      session.subprocessClient?.off("playerState", onPlayerState);
      session.subprocessClient?.off("playbackArmed", onPlaybackArmed);
      session.subprocessClient?.off("musicIdle", onMusicIdle);
      session.subprocessClient?.off("musicError", onMusicError);
      session.subprocessClient?.off("error", onError);
    });
  }

  getDeferredVoiceActions(session) {
    if (!session || typeof session !== "object") return {};
    const existing = session.deferredVoiceActions;
    if (existing && typeof existing === "object") {
      return existing;
    }
    const actions = {};
    session.deferredVoiceActions = actions;
    return actions;
  }

  getDeferredVoiceActionTimers(session) {
    if (!session || typeof session !== "object") return {};
    const existing = session.deferredVoiceActionTimers;
    if (existing && typeof existing === "object") {
      return existing;
    }
    const timers = {};
    session.deferredVoiceActionTimers = timers;
    return timers;
  }

  getDeferredVoiceAction(session, type) {
    if (!session) return null;
    const actions = this.getDeferredVoiceActions(session);
    const action = actions[type];
    return action && typeof action === "object" ? action : null;
  }

  upsertDeferredVoiceAction(session, actionInput: {
    type?: string;
    goal?: string;
    freshnessPolicy?: string;
    status?: string;
    notBeforeAt?: number;
    expiresAt?: number;
    reason?: string;
    payload?: Record<string, unknown>;
  } = {}) {
    if (!session || session.ending) return null;
    const normalizedType = String(actionInput.type || "").trim();
    if (!normalizedType) return null;
    const now = Date.now();
    const actions = this.getDeferredVoiceActions(session);
    const existing = this.getDeferredVoiceAction(session, normalizedType);
    const action = {
      type: normalizedType,
      goal: String(actionInput.goal || existing?.goal || "").trim() || normalizedType,
      freshnessPolicy: String(actionInput.freshnessPolicy || existing?.freshnessPolicy || "regenerate_from_goal").trim(),
      status: actionInput.status === "scheduled" ? "scheduled" : "deferred",
      createdAt: Math.max(0, Number(existing?.createdAt || 0)) || now,
      updatedAt: now,
      notBeforeAt: Math.max(0, Number(actionInput.notBeforeAt ?? existing?.notBeforeAt ?? 0)),
      expiresAt: Math.max(0, Number(actionInput.expiresAt ?? existing?.expiresAt ?? 0)),
      reason: String(actionInput.reason || existing?.reason || "deferred").trim() || "deferred",
      revision: Math.max(0, Number(existing?.revision || 0)) + 1,
      payload:
        actionInput.payload && typeof actionInput.payload === "object"
          ? actionInput.payload
          : existing?.payload && typeof existing.payload === "object"
            ? existing.payload
            : {}
    };
    actions[normalizedType] = action;
    return action;
  }

  setDeferredVoiceAction(session, payload = {}) {
    return this.upsertDeferredVoiceAction(session, payload);
  }

  getDeferredQueuedUserTurnsAction(session): DeferredQueuedUserTurnsAction | null {
    const action = this.getDeferredVoiceAction(session, "queued_user_turns");
    if (!action || typeof action !== "object") return null;
    const payload = action.payload && typeof action.payload === "object" ? action.payload : null;
    if (!payload || !Array.isArray(payload.turns)) return null;
    return action as DeferredQueuedUserTurnsAction;
  }

  getDeferredQueuedUserTurns(session): DeferredQueuedUserTurn[] {
    const action = this.getDeferredQueuedUserTurnsAction(session);
    return Array.isArray(action?.payload?.turns) ? action.payload.turns : [];
  }

  clearDeferredVoiceActionTimer(session, type) {
    if (!session) return;
    const timers = this.getDeferredVoiceActionTimers(session);
    const timer = timers[type];
    if (timer) {
      clearTimeout(timer);
    }
    timers[type] = null;
  }

  clearDeferredVoiceAction(session, type) {
    if (!session) return;
    const normalizedType = String(type || "").trim();
    if (!normalizedType) return;
    this.clearDeferredVoiceActionTimer(session, normalizedType);
    const actions = this.getDeferredVoiceActions(session);
    delete actions[normalizedType];
  }

  clearAllDeferredVoiceActions(session) {
    if (!session) return;
    const actions = this.getDeferredVoiceActions(session);
    for (const type of Object.keys(actions)) {
      this.clearDeferredVoiceAction(session, type);
    }
  }

  scheduleDeferredVoiceActionRecheck(session, {
    type,
    delayMs = 0,
    reason = "scheduled_recheck"
  }) {
    if (!session || session.ending) return;
    const normalizedType = String(type || "").trim();
    if (!normalizedType) return;
    const action = this.getDeferredVoiceAction(session, normalizedType);
    if (!action) return;
    this.clearDeferredVoiceActionTimer(session, normalizedType);
    const timers = this.getDeferredVoiceActionTimers(session);
    timers[normalizedType] = setTimeout(() => {
      timers[normalizedType] = null;
      this.recheckDeferredVoiceActions({
        session,
        reason,
        preferredTypes: [normalizedType]
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  scheduleJoinGreetingGrace(session) {
    if (!session || session.ending) return;
    const action = this.getDeferredVoiceAction(session, "join_greeting");
    if (!action || session.lastAssistantReplyAt) return;
    const delayMs = Math.max(0, Number(action.notBeforeAt || 0) - Date.now());
    this.scheduleDeferredVoiceActionRecheck(session, {
      type: "join_greeting",
      delayMs,
      reason: "join_greeting_grace"
    });
  }

  recheckDeferredVoiceActions({
    session,
    reason = "manual",
    preferredTypes = null,
    context = null
  }) {
    if (!session || session.ending) return false;
    const actionPriority = ["interrupted_reply", "queued_user_turns", "join_greeting"];
    const knownActions = this.getDeferredVoiceActions(session);
    const types = Array.isArray(preferredTypes) && preferredTypes.length > 0
      ? preferredTypes
      : actionPriority.filter((type) => Boolean(knownActions[type]));
    for (const type of types) {
      if (type === "queued_user_turns" && this.recheckDeferredQueuedUserTurns(session, {
        action: this.getDeferredQueuedUserTurnsAction(session),
        reason
      })) {
        return true;
      }
      if (type === "join_greeting" && this.recheckDeferredJoinGreeting(session, {
        action: this.getDeferredVoiceAction(session, type),
        reason
      })) {
        return true;
      }
      if (type === "interrupted_reply" && this.recheckDeferredInterruptedReply(session, {
        action: this.getDeferredVoiceAction(session, type),
        reason,
        context
      })) {
        return true;
      }
    }
    return false;
  }

  recheckDeferredQueuedUserTurns(session, {
    action = null,
    reason = "manual"
  }: {
    action?: DeferredQueuedUserTurnsAction | null;
    reason?: string;
  } = {}) {
    if (!session || session.ending) return false;
    const queuedTurnsAction = action && typeof action === "object"
      ? action
      : this.getDeferredQueuedUserTurnsAction(session);
    if (!queuedTurnsAction) return false;

    const pendingQueue = Array.isArray(queuedTurnsAction?.payload?.turns)
      ? queuedTurnsAction.payload.turns
      : [];
    if (!pendingQueue.length) {
      this.clearDeferredVoiceAction(session, "queued_user_turns");
      return false;
    }

    const now = Date.now();
    const notBeforeAt = Math.max(0, Number(queuedTurnsAction.notBeforeAt || 0));
    if (notBeforeAt > now) {
      this.scheduleDeferredBotTurnOpenFlush({
        session,
        delayMs: notBeforeAt - now,
        reason
      });
      return false;
    }

    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked || Number(session.userCaptures?.size || 0) > 0) {
      this.scheduleDeferredBotTurnOpenFlush({
        session,
        reason
      });
      return false;
    }

    this.clearDeferredVoiceAction(session, "queued_user_turns");
    void this.flushDeferredBotTurnOpenTurns({
      session,
      deferredTurns: pendingQueue,
      reason
    });
    return true;
  }

  fireJoinGreeting(session, reason = "manual") {
    return this.recheckDeferredVoiceActions({
      session,
      reason,
      preferredTypes: ["join_greeting"]
    });
  }

  recheckDeferredJoinGreeting(session, {
    action = null,
    reason = "manual"
  } = {}) {
    if (!session || session.ending) return false;
    const joinGreetingAction = action && typeof action === "object"
      ? action
      : this.getDeferredVoiceAction(session, "join_greeting");
    if (!joinGreetingAction) return false;
    if (!isRealtimeMode(session.mode) || !session.playbackArmed || session.lastAssistantReplyAt) {
      this.clearDeferredVoiceAction(session, "join_greeting");
      return false;
    }

    const now = Date.now();
    const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const expiresAt = Math.max(0, Number(joinGreetingAction.expiresAt || 0));
    if (!joinWindowActive || (expiresAt > 0 && now >= expiresAt)) {
      this.clearDeferredVoiceAction(session, "join_greeting");
      return false;
    }

    const notBeforeAt = Math.max(0, Number(joinGreetingAction.notBeforeAt || 0));
    if (notBeforeAt > now) {
      this.scheduleDeferredVoiceActionRecheck(session, {
        type: "join_greeting",
        delayMs: notBeforeAt - now,
        reason
      });
      return false;
    }

    if (
      Number(session.userCaptures?.size || 0) > 0 ||
      session.pendingResponse ||
      this.isRealtimeResponseActive(session) ||
      Boolean(session.awaitingToolOutputs) ||
      (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0)
    ) {
      this.setDeferredVoiceAction(session, {
        type: "join_greeting",
        goal: "announce_join",
        freshnessPolicy: "regenerate_from_goal",
        status: "deferred",
        reason,
        notBeforeAt: 0,
        expiresAt,
        payload: {
          trigger: String(joinGreetingAction?.payload?.trigger || joinGreetingAction.reason || "join").trim() || null
        }
      });
      return false;
    }

    const resolvedSettings = session.settingsSnapshot || this.store.getSettings();
    const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({
      session,
      settings: resolvedSettings
    });
    if (useNativeRealtimeReply) {
      this.createTrackedAudioResponse({
        session,
        source: "voice_join_greeting",
        emitCreateEvent: true,
        resetRetryState: true
      });
      session.lastAssistantReplyAt = Date.now();
    } else {
      const joinGreetingTrigger = String(
        joinGreetingAction?.payload?.trigger || joinGreetingAction.reason || "join_greeting"
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const joinGreetingBrainEventText = [
        "Join greeting opportunity.",
        `Trigger: ${joinGreetingTrigger || "join_greeting"}.`,
        "If it fits naturally, greet briefly. If not, return [SKIP]."
      ].join(" ");
      void this.runRealtimeBrainReply({
        session,
        settings: resolvedSettings,
        userId: null,
        transcript: joinGreetingBrainEventText,
        inputKind: "event",
        directAddressed: false,
        directAddressConfidence: 0,
        conversationContext: this.buildVoiceConversationContext({
          session,
          userId: null,
          directAddressed: false
        }),
        source: "voice_join_greeting"
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `voice_join_greeting_brain_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            mode: session.mode
          }
        });
      });
      session.lastAssistantReplyAt = Date.now();
    }
    this.clearDeferredVoiceAction(session, "join_greeting");
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_join_greeting_fired",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        strategy: useNativeRealtimeReply ? "native" : "brain",
        deferredActionReason: String(joinGreetingAction.reason || "deferred"),
        recheckReason: String(reason || "manual")
      }
    });
    return true;
  }

  recheckDeferredInterruptedReply(session, {
    action = null,
    reason = "manual",
    context = null
  } = {}) {
    if (!session || session.ending) return false;
    const interruptedReplyAction = action && typeof action === "object"
      ? action
      : this.getDeferredVoiceAction(session, "interrupted_reply");
    if (!interruptedReplyAction) return false;
    if (!isRealtimeMode(session.mode)) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const interruptedAt = Math.max(0, Number(interruptedReplyAction?.payload?.interruptedAt || 0));
    const now = Date.now();
    if (!interruptedAt || now - interruptedAt > BARGE_IN_RETRY_MAX_AGE_MS) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const normalizedUserId = String(context?.userId || "").trim();
    const interruptedByUserId = String(interruptedReplyAction?.payload?.interruptedByUserId || "").trim();
    if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
      return false;
    }

    if (Number(session.userCaptures?.size || 0) > 0) {
      return false;
    }

    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const captureByteLength = Buffer.isBuffer(context?.pcmBuffer)
      ? context.pcmBuffer.length
      : Buffer.from(context?.pcmBuffer || []).length;
    const bargeDurationMs = this.estimatePcm16MonoDurationMs(captureByteLength, sampleRateHz);
    const fullOverride = bargeDurationMs >= BARGE_IN_FULL_OVERRIDE_MIN_MS;
    if (fullOverride) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_barge_in_retry_skipped_full_override",
        metadata: {
          sessionId: session.id,
          captureReason: String(context?.captureReason || "stream_end"),
          bargeDurationMs,
          fullOverrideMinMs: BARGE_IN_FULL_OVERRIDE_MIN_MS
        }
      });
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const retryText = normalizeVoiceText(interruptedReplyAction?.payload?.utteranceText || "", STT_REPLY_MAX_CHARS);
    const interruptionPolicy = this.normalizeReplyInterruptionPolicy(
      interruptedReplyAction?.payload?.interruptionPolicy
    );
    if (!retryText) {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
      return false;
    }

    const retried = this.requestRealtimeTextUtterance({
      session,
      text: retryText,
      userId: this.client.user?.id || null,
      source: "barge_in_retry",
      interruptionPolicy
    });
    if (!retried) return false;

    this.clearDeferredVoiceAction(session, "interrupted_reply");
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_barge_in_retry_requested",
      metadata: {
        sessionId: session.id,
        captureReason: String(context?.captureReason || "stream_end"),
        bargeDurationMs,
        fullOverrideMinMs: BARGE_IN_FULL_OVERRIDE_MIN_MS,
        interruptionPolicyScope: interruptionPolicy?.scope || null,
        interruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null,
        freshnessPolicy: interruptedReplyAction?.freshnessPolicy || null,
        deferredActionReason: String(reason || "manual")
      }
    });
    return true;
  }

  isBargeInOutputSuppressed(session, now = Date.now()) {
    if (!session) return false;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return false;
    if (now < suppressedUntil) return true;
    this.clearBargeInOutputSuppression(session, "timeout");
    return false;
  }

  clearBargeInOutputSuppression(session, reason = "cleared") {
    if (!session) return;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return;
    const droppedChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0));
    const droppedBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0));

    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    if (reason === "timeout" && droppedChunks <= 0 && droppedBytes <= 0) return;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_barge_in_suppression_cleared",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "cleared"),
        droppedAudioChunks: droppedChunks,
        droppedAudioBytes: droppedBytes
      }
    });
  }

  isBargeInInterruptTargetActive(session) {
    if (!session || session.ending) return false;
    if (this.isBargeInOutputSuppressed(session)) return false;
    const lockState = this.getReplyOutputLockState(session);
    if (!lockState.locked) return false;
    if (
      lockState.musicActive &&
      !lockState.botTurnOpen &&
      !lockState.pendingResponse &&
      !lockState.openAiActiveResponse
    ) {
      return false;
    }
    return true;
  }

  normalizeReplyInterruptionPolicy(rawPolicy = null) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : null;
    if (!policy) return null;

    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(policy.talkingTo || "");
    const scopeRaw = String(policy.scope || "")
      .trim()
      .toLowerCase();
    const scope = scopeRaw === "all" || normalizedTalkingTo === "ALL" ? "all" : "speaker";
    const allowedUserId = String(policy.allowedUserId || "").trim() || null;
    const assertive =
      policy.assertive === undefined
        ? scope === "all" || Boolean(allowedUserId)
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
      allowedUserId: scope === "all" ? null : allowedUserId,
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

    const scope = targetsAll ? "all" : "speaker";
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
    if (normalizedPolicy.scope === "all") return false;
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
    const lockState = this.getReplyOutputLockState(session);
    if (lockState.locked) return;
    session.activeReplyInterruptionPolicy = null;
  }

  maybeInterruptBotForAssertiveSpeech({
    session,
    userId = null,
    source = "speaking_start"
  }) {
    if (!session || session.ending) return false;
    if (isRealtimeMode(session.mode)) return false;
    if (!this.isBargeInInterruptTargetActive(session)) return false;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    if (
      !this.isUserAllowedToInterruptReply({
        policy: session.activeReplyInterruptionPolicy,
        userId: normalizedUserId
      })
    ) {
      return false;
    }
    const capture = session.userCaptures?.get?.(normalizedUserId);
    if (!capture) return false;
    if (capture.speakingEndFinalizeTimer) return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));
    if (Number(capture.bytesSent || 0) < minCaptureBytes) return false;
    if (!this.isCaptureSignalAssertive(capture)) return false;

    return this.interruptBotSpeechForBargeIn({
      session,
      userId: normalizedUserId,
      source: String(source || "speaking_start"),
      minCaptureBytes
    });
  }

  isCaptureSignalAssertive(capture) {
    if (!capture || typeof capture !== "object") return false;
    const sampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (sampleCount <= 0) return false;

    const activeSampleCount = Math.max(0, Number(capture.signalActiveSampleCount || 0));
    const peakAbs = Math.max(0, Number(capture.signalPeakAbs || 0));
    const activeSampleRatio = activeSampleCount / sampleCount;
    const peak = peakAbs / 32768;

    const nearSilentSignal =
      activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX &&
      peak <= VOICE_SILENCE_GATE_PEAK_MAX;
    return !nearSilentSignal;
  }

  isCaptureEligibleForActivityTouch({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minSpeechBytes = Math.max(
      2,
      Math.ceil((sampleRateHz * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000)
    );
    if (Number(capture.bytesSent || 0) < minSpeechBytes) return false;
    return this.isCaptureSignalAssertive(capture);
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
      if (!this.isCaptureSignalAssertive(capture)) continue;
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

  interruptBotSpeechForBargeIn({
    session,
    userId = null,
    source = "speaking_start",
    minCaptureBytes = 0
  }) {
    if (!session || session.ending) return false;

    const streamBufferedBytes = 0;
    const now = Date.now();
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    const interruptionPolicy = this.normalizeReplyInterruptionPolicy(
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    const retryUtteranceText = normalizeVoiceText(
      session.pendingResponse?.utteranceText || session.lastRequestedRealtimeUtterance?.utteranceText || "",
      STT_REPLY_MAX_CHARS
    );
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
        const estimatedUnplayedMs = this.estimateDiscordPcmPlaybackDurationMs(streamBufferedBytes);
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

    this.resetBotAudioPlayback(session);
    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
      session.botTurnResetTimer = null;
    }
    session.botTurnOpen = false;

    // Unduck music immediately on barge-in so the user hears it while speaking.
    const resolvedSettings = session.settingsSnapshot || this.store.getSettings();
    this.releaseBotSpeechMusicDuck(session, resolvedSettings, { force: true }).catch(() => undefined);

    if (session.pendingResponse && typeof session.pendingResponse === "object") {
      session.lastAudioDeltaAt = Math.max(Number(session.lastAudioDeltaAt || 0), now);
      session.pendingResponse.audioReceivedAt = Number(session.lastAudioDeltaAt || now);
    }

    if (isRealtimeMode(session.mode) && retryUtteranceText) {
      this.setDeferredVoiceAction(session, {
        type: "interrupted_reply",
        goal: "complete_interrupted_reply",
        freshnessPolicy: "retry_then_regenerate",
        status: "deferred",
        reason: "barge_in_interrupt",
        notBeforeAt: 0,
        expiresAt: now + BARGE_IN_RETRY_MAX_AGE_MS,
        payload: {
          utteranceText: retryUtteranceText,
          interruptedByUserId: String(userId || "").trim() || null,
          interruptedAt: now,
          source: String(source || "speaking_start"),
          interruptionPolicy
        }
      });
    } else {
      this.clearDeferredVoiceAction(session, "interrupted_reply");
    }

    session.bargeInSuppressionUntil = now + BARGE_IN_SUPPRESSION_MAX_MS;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: String(userId || "").trim() || null,
      content: "voice_barge_in_interrupt",
      metadata: {
        sessionId: session.id,
        source: String(source || "speaking_start"),
        streamBufferedBytesDropped: streamBufferedBytes,
        pendingRequestId,
        minCaptureBytes: Math.max(0, Number(minCaptureBytes || 0)),
        suppressionMs: BARGE_IN_SUPPRESSION_MAX_MS,
        queuedRetryUtterance: Boolean(isRealtimeMode(session.mode) && retryUtteranceText),
        retryInterruptionPolicyScope: interruptionPolicy?.scope || null,
        retryInterruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null,
        responseCancelAttempted,
        responseCancelSucceeded,
        responseCancelError,
        truncateAttempted,
        truncateSucceeded,
        truncateError,
        truncateItemId,
        truncateContentIndex: truncateAttempted ? truncateContentIndex : null,
        truncateAudioEndMs: truncateAttempted ? truncateAudioEndMs : null
      }
    });
    return true;
  }

  isAudioActivelyFlowing(session) {
    if (!session || session.ending) return false;
    // With subprocess, we can't check stream buffer; rely on recent audio delta timing.
    const msSinceLastDelta = Date.now() - Number(session.lastAudioDeltaAt || 0);
    return msSinceLastDelta < 200;
  }

  armAssertiveBargeIn({
    session,
    userId = null,
    source = "speaking_start",
    delayMs = null
  }) {
    if (!session || session.ending) return;
    if (isRealtimeMode(session.mode)) return;
    if (!this.isBargeInInterruptTargetActive(session)) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;
    const capture = session.userCaptures?.get?.(normalizedUserId);
    if (!capture) return;
    if (capture.speakingEndFinalizeTimer) return;
    if (capture.bargeInAssertTimer) return;
    const audioActivelyFlowing = this.isAudioActivelyFlowing(session);
    const effectiveDelayMs = delayMs != null
      ? Math.max(60, Math.round(Number(delayMs)))
      : (audioActivelyFlowing ? BARGE_IN_ASSERTION_MS : BARGE_IN_ASSERTION_IDLE_MS);
    capture.bargeInAssertTimer = setTimeout(() => {
      capture.bargeInAssertTimer = null;
      const interrupted = this.maybeInterruptBotForAssertiveSpeech({
        session,
        userId: normalizedUserId,
        source: String(source || "speaking_start")
      });
      if (interrupted) return;
      const currentCapture = session.userCaptures?.get?.(normalizedUserId);
      if (!currentCapture || currentCapture.speakingEndFinalizeTimer || !session.botTurnOpen) return;
      this.armAssertiveBargeIn({
        session,
        userId: normalizedUserId,
        source: String(source || "speaking_start"),
        delayMs: BARGE_IN_ASSERTION_IDLE_MS
      });
    }, effectiveDelayMs);
  }

  trackOpenAiRealtimeAssistantAudioEvent(session, event) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!event || typeof event !== "object") return;
    const eventType = String(event.type || "").trim();
    if (eventType !== "response.output_audio.delta" && eventType !== "response.output_audio.done") return;

    const itemId = normalizeInlineText(event.item_id || event.item?.id || event.output_item?.id, 180);
    if (!itemId) return;
    const contentIndexRaw = Number(event.content_index ?? event.contentIndex ?? 0);
    const contentIndex =
      Number.isFinite(contentIndexRaw) && contentIndexRaw >= 0 ? Math.floor(contentIndexRaw) : 0;
    const previousItemId = String(session.lastOpenAiAssistantAudioItemId || "");
    const previousContentIndex = Math.max(0, Number(session.lastOpenAiAssistantAudioItemContentIndex || 0));
    if (itemId !== previousItemId || contentIndex !== previousContentIndex) {
      session.lastOpenAiAssistantAudioItemReceivedMs = 0;
    }
    session.lastOpenAiAssistantAudioItemId = itemId;
    session.lastOpenAiAssistantAudioItemContentIndex = contentIndex;
  }

  bindRealtimeHandlers(session, settings = session.settingsSnapshot) {
    if (!session?.realtimeClient) return;
    this.ensureSessionToolRuntimeState(session);
    const runtimeLabel = getRealtimeRuntimeLabel(session.mode);
    // -- Audio delta → subprocess ------------------------------------------------
    // Audio deltas are forwarded directly to the Node.js subprocess which
    // handles resampling, Opus encoding, and playback via its own event loop.
    // No queue or yield logic is needed in the main process.

    const onAudioDelta = (audioBase64) => {
      const b64Str = String(audioBase64 || "");
      if (!b64Str.length) return;
      // Compute PCM byte count from base64 length without allocating a Buffer.
      // base64 encodes 3 bytes into 4 chars; padding '=' chars reduce decoded size.
      const padding = b64Str.endsWith("==") ? 2 : b64Str.endsWith("=") ? 1 : 0;
      const pcmByteLength = Math.floor((b64Str.length * 3) / 4) - padding;
      if (pcmByteLength <= 0) return;

      const sampleRate = Number(session.realtimeOutputSampleRateHz) || 24000;

      // Duration tracking stays synchronous — used for truncation estimates
      // when barge-in interrupts the response mid-stream.
      if (isRealtimeMode(session.mode) && session.lastOpenAiAssistantAudioItemId) {
        session.lastOpenAiAssistantAudioItemReceivedMs = Math.max(
          0,
          Number(session.lastOpenAiAssistantAudioItemReceivedMs || 0)
        ) + this.estimatePcm16MonoDurationMs(pcmByteLength, sampleRate);
      }

      if (this.isBargeInOutputSuppressed(session)) {
        session.lastAudioDeltaAt = Date.now();
        session.bargeInSuppressedAudioChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0)) + 1;
        session.bargeInSuppressedAudioBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0)) + pcmByteLength;
        const pending = session.pendingResponse;
        if (pending && typeof pending === "object") {
          pending.audioReceivedAt = Number(session.lastAudioDeltaAt || Date.now());
        }
        return;
      }

      session.lastAudioDeltaAt = Date.now();

      // Duck music when realtime TTS starts speaking — playVoiceReplyInOrder
      // handles ducking for the STT pipeline, but realtime audio arrives here
      // directly and bypasses that path.
      if (musicPhaseShouldAllowDucking(this.getMusicPhase(session))) {
        this.engageBotSpeechMusicDuck(
          session,
          session.settingsSnapshot || this.store.getSettings()
        ).catch(() => undefined);
      }

      // Send raw PCM to subprocess — it handles conversion + Opus encoding.
      if (!session.subprocessClient?.isAlive) return;
      try {
        session.subprocessClient.sendAudio(b64Str, sampleRate);
      } catch {
        return;
      }

      this.markBotTurnOut(session, settings);
      if (isRealtimeMode(session.mode)) {
        session.pendingRealtimeInputBytes = 0;
      }

      if (this.pendingResponseHasAudio(session)) {
        const pending = session.pendingResponse;
        if (pending) {
          pending.audioReceivedAt = session.lastAudioDeltaAt;
        }
        this.clearResponseSilenceTimers(session);
      }
    };

    const onTranscript = (payload) => {
      const transcriptText =
        payload && typeof payload === "object" ? payload.text : payload;
      const transcriptEventType =
        payload && typeof payload === "object" ? String(payload.eventType || "") : "";
      const transcript = String(transcriptText || "").trim();
      if (!transcript) return;
      const transcriptSource = transcriptSourceFromEventType(transcriptEventType);
      const finalTranscriptEvent = isFinalRealtimeTranscriptEventType(transcriptEventType, transcriptSource);
      const parsedDirective =
        transcriptSource === "output"
          ? parseSoundboardDirectiveSequence(transcript)
          : {
            text: transcript,
            references: []
          };
      const transcriptForLogs = String(parsedDirective?.text || transcript).trim();
      const requestedSoundboardRefs = this.normalizeSoundboardRefs(parsedDirective?.references || []);
      if (finalTranscriptEvent) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `${runtimeLabel}_transcript`,
          metadata: {
            sessionId: session.id,
            transcript: transcriptForLogs || transcript,
            transcriptEventType: transcriptEventType || null,
            transcriptSource,
            soundboardRefs: requestedSoundboardRefs.length ? requestedSoundboardRefs : null
          }
        });
      }

      if (isRealtimeMode(session.mode) && transcriptSource === "output") {
        session.pendingRealtimeInputBytes = 0;
      }
      const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
      if (
        transcriptSource === "output" &&
        transcriptForLogs &&
        finalTranscriptEvent
      ) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: transcriptForLogs
        });
      }

      if (transcriptSource === "output" && requestedSoundboardRefs.length > 0 && finalTranscriptEvent) {
        (async () => {
          let directiveIndex = 0;
          for (const requestedRef of requestedSoundboardRefs) {
            directiveIndex += 1;
            await this.maybeTriggerAssistantDirectedSoundboard({
              session,
              settings: resolvedSettings,
              userId: this.client.user?.id || null,
              transcript: transcriptForLogs || transcript,
              requestedRef,
              source: `realtime_output_transcript_${directiveIndex}`
            });
          }
        })().catch(() => undefined);
      }
    };

    const onErrorEvent = (errorPayload) => {
      if (session.ending) return;
      const details = parseRealtimeErrorPayload(errorPayload);
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_error_event: ${details.message}`,
        metadata: {
          sessionId: session.id,
          code: details.code,
          param: details.param,
          lastOutboundEventType: details.lastOutboundEventType,
          lastOutboundEvent: details.lastOutboundEvent,
          recentOutboundEvents: details.recentOutboundEvents
        }
      });

      if (
        isRecoverableRealtimeError({
          mode: session.mode,
          code: details.code,
          message: details.message
        })
      ) {
        const normalizedCode = String(details.code || "")
          .trim()
          .toLowerCase();
        const isActiveResponseCollision =
          normalizedCode === "conversation_already_has_active_response" ||
          /active response in progress/i.test(String(details.message || ""));
        const hasActiveResponse = this.isRealtimeResponseActive(session);
        session.pendingRealtimeInputBytes = 0;
        const pending = session.pendingResponse;
        if (
          normalizedCode === "input_audio_buffer_commit_empty" &&
          pending &&
          !hasActiveResponse &&
          !this.pendingResponseHasAudio(session, pending)
        ) {
          this.clearPendingResponse(session);
        } else if (isActiveResponseCollision && pending) {
          pending.handlingSilence = false;
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId
          });
        }
        return;
      }

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_runtime_error",
        announcement: "voice runtime hit an error, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketClosed = (closeInfo) => {
      if (session.ending) return;
      const code = Number(closeInfo?.code || 0) || null;
      const reason = String(closeInfo?.reason || "").trim() || null;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_closed`,
        metadata: {
          sessionId: session.id,
          code,
          reason
        }
      });

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_socket_closed",
        announcement: "lost realtime voice runtime, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketError = (socketError) => {
      if (session.ending) return;
      const message = String(socketError?.message || "unknown socket error");
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_error: ${message}`,
        metadata: {
          sessionId: session.id
        }
      });
    };

    const onResponseDone = (event) => {
      if (session.ending) return;
      const hadBargeSuppression = this.isBargeInOutputSuppressed(session);
      if (hadBargeSuppression) {
        this.clearBargeInOutputSuppression(session, "response_done");
      }
      const pending = session.pendingResponse;
      const responseId = parseResponseDoneId(event);
      const responseStatus = parseResponseDoneStatus(event);
      const responseUsage = parseResponseDoneUsage(event);
      const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
      const realtimeProvider = resolveRealtimeProvider(session.mode);
      const resolvedResponseModel = isRealtimeMode(session.mode)
        ? parseResponseDoneModel(event) ||
        String(session.realtimeClient?.sessionConfig?.model || "").trim() ||
        String(resolvedSettings?.voice?.openaiRealtime?.model || "gpt-realtime").trim() ||
        "gpt-realtime"
        : parseResponseDoneModel(event);
      const responseUsdCost =
        isRealtimeMode(session.mode) && responseUsage
          ? estimateUsdCost({
            provider: realtimeProvider || "openai",
            model: resolvedResponseModel || "gpt-realtime",
            inputTokens: Number(responseUsage.inputTokens || 0),
            outputTokens: Number(responseUsage.outputTokens || 0),
            cacheReadTokens: Number(responseUsage.cacheReadTokens || 0),
            cacheWriteTokens: 0,
            customPricing: resolvedSettings?.llm?.pricing
          })
          : 0;
      const hadAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;
      const hasInFlightToolCalls =
        Boolean(session.awaitingToolOutputs) ||
        (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0);

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_response_done`,
        usdCost: responseUsdCost,
        metadata: {
          sessionId: session.id,
          requestId: pending?.requestId || null,
          responseId,
          responseStatus,
          responseModel: resolvedResponseModel || null,
          responseUsage,
          hadAudio,
          retryCount: pending ? Number(pending.retryCount || 0) : null,
          hardRecoveryAttempted:
            pending && Object.hasOwn(pending, "hardRecoveryAttempted")
              ? Boolean(pending.hardRecoveryAttempted)
              : null
        }
      });

      if (!pending) return;

      if (hadAudio) {
        // Schedule music unduck after the subprocess finishes playing
        // buffered audio (~BOT_TURN_SILENCE_RESET_MS after last delta).
        this.scheduleBotSpeechMusicUnduck(session, resolvedSettings, BOT_TURN_SILENCE_RESET_MS);

        // Resume music if it was paused for a wake-word direct address.
        const musicPhase = this.getMusicPhase(session);
        if (musicPhase === "paused_wake_word") {
          setTimeout(() => {
            if (session.ending) return;
            this.setMusicPhase(session, "playing");
            this.musicPlayer?.resume?.();
            this.haltSessionOutputForMusicPlayback(session, "music_resumed_after_wake_word");
          }, BOT_TURN_SILENCE_RESET_MS);
        }

        this.clearPendingResponse(session);
        return;
      }

      if (hasInFlightToolCalls) {
        this.clearPendingResponse(session);
        return;
      }

      if (session.responseDoneGraceTimer) {
        clearTimeout(session.responseDoneGraceTimer);
      }

      const requestId = Number(pending.requestId || 0);
      const responseUserId = pending.userId || null;
      session.responseDoneGraceTimer = setTimeout(() => {
        session.responseDoneGraceTimer = null;
        if (!session || session.ending) return;
        const current = session.pendingResponse;
        if (!current || Number(current.requestId || 0) !== requestId) return;
        if (this.pendingResponseHasAudio(session, current)) {
          this.clearPendingResponse(session);
          return;
        }
        this.handleSilentResponse({
          session,
          userId: responseUserId,
          trigger: "response_done",
          responseId,
          responseStatus
        }).catch(() => undefined);
      }, RESPONSE_DONE_SILENCE_GRACE_MS);
    };

    const onEvent = (event) => {
      if (!session || session.ending) return;
      if (!event || typeof event !== "object") return;
      if (!isRealtimeMode(session.mode)) return;
      this.trackOpenAiRealtimeAssistantAudioEvent(session, event);
      this.handleOpenAiRealtimeFunctionCallEvent({
        session,
        settings,
        event
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `openai_realtime_tool_event_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
      });
    };

    session.realtimeClient.on("audio_delta", onAudioDelta);
    session.realtimeClient.on("transcript", onTranscript);
    session.realtimeClient.on("error_event", onErrorEvent);
    session.realtimeClient.on("socket_closed", onSocketClosed);
    session.realtimeClient.on("socket_error", onSocketError);
    session.realtimeClient.on("response_done", onResponseDone);
    session.realtimeClient.on("event", onEvent);

    session.cleanupHandlers.push(() => {
      session.realtimeClient.off("audio_delta", onAudioDelta);
      session.realtimeClient.off("transcript", onTranscript);
      session.realtimeClient.off("error_event", onErrorEvent);
      session.realtimeClient.off("socket_closed", onSocketClosed);
      session.realtimeClient.off("socket_error", onSocketError);
      session.realtimeClient.off("response_done", onResponseDone);
      session.realtimeClient.off("event", onEvent);
    });
  }

  resetBotAudioPlayback(session) {
    if (!session) return;
    if (musicPhaseIsActive(this.getMusicPhase(session))) {
      // Clear TTS buffer only — stopPlayback would kill the pending music pipeline.
      try { session.subprocessClient?.stopTtsPlayback(); } catch { /* ignore */ }
    } else {
      try { session.subprocessClient?.stopPlayback(); } catch { /* ignore */ }
    }
    this.maybeClearActiveReplyInterruptionPolicy(session);
  }

  queueRealtimeTurnContextRefresh({
    session,
    settings,
    userId,
    transcript = "",
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    const pendingRefreshState =
      session.openAiTurnContextRefreshState &&
        typeof session.openAiTurnContextRefreshState === "object"
        ? session.openAiTurnContextRefreshState
        : {
          inFlight: false,
          pending: null
        };
    session.openAiTurnContextRefreshState = pendingRefreshState;
    pendingRefreshState.pending = {
      settings: settings || session.settingsSnapshot || this.store.getSettings(),
      userId: String(userId || "").trim() || null,
      transcript: normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS),
      captureReason: String(captureReason || "stream_end")
    };
    if (pendingRefreshState.inFlight) return;
    pendingRefreshState.inFlight = true;

    const runQueuedRefresh = async () => {
      let nextRefresh: typeof pendingRefreshState.pending = null;
      try {
        while (!session.ending) {
          const queued = pendingRefreshState.pending;
          pendingRefreshState.pending = null;
          if (!queued) break;
          await this.prepareRealtimeTurnContext({
            session,
            settings: queued.settings,
            userId: queued.userId,
            transcript: queued.transcript,
            captureReason: queued.captureReason
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `openai_realtime_turn_context_refresh_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            source: "queued_turn_context_refresh"
          }
        });
      } finally {
        pendingRefreshState.inFlight = false;
        if (session.ending) {
          if (session.openAiTurnContextRefreshState === pendingRefreshState) {
            session.openAiTurnContextRefreshState = null;
          }
        } else if (pendingRefreshState.pending) {
          nextRefresh = pendingRefreshState.pending;
        } else if (session.openAiTurnContextRefreshState === pendingRefreshState) {
          session.openAiTurnContextRefreshState = null;
        }
      }

      if (nextRefresh) {
        this.queueRealtimeTurnContextRefresh({
          session,
          settings: nextRefresh.settings,
          userId: nextRefresh.userId,
          transcript: nextRefresh.transcript,
          captureReason: nextRefresh.captureReason
        });
      }
    };

    void runQueuedRefresh();
  }

  getReplyOutputLockState(session) {
    if (!session || session.ending) {
      return {
        locked: true,
        reason: "session_inactive",
        musicActive: false,
        botTurnOpen: false,
        pendingResponse: false,
        openAiActiveResponse: false,
        streamBufferedBytes: 0
      };
    }

    const streamBufferedBytes = 0; // Subprocess manages its own stream buffer
    const musicActive = musicPhaseShouldLockOutput(this.getMusicPhase(session));
    const botTurnOpen = Boolean(session.botTurnOpen);
    const pendingResponse = Boolean(session.pendingResponse && typeof session.pendingResponse === "object");
    const openAiActiveResponse = this.isRealtimeResponseActive(session);
    const locked =
      musicActive ||
      botTurnOpen ||
      pendingResponse ||
      openAiActiveResponse;

    let reason = "idle";
    if (musicActive) {
      reason = "music_playback_active";
    } else if (pendingResponse) {
      reason = "pending_response";
    } else if (openAiActiveResponse) {
      reason = "openai_active_response";
    } else if (botTurnOpen) {
      reason = "bot_turn_open";
    }

    return {
      locked,
      reason,
      musicActive,
      botTurnOpen,
      pendingResponse,
      openAiActiveResponse,
      streamBufferedBytes
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

    if (!session.subprocessClient?.isAlive) return false;

    // Send the entire TTS PCM buffer to the subprocess which handles
    // conversion and Opus encoding with Node's reliable event loop.
    const sampleRate = Math.max(8_000, Math.floor(Number(inputSampleRateHz) || 24_000));
    try {
      session.subprocessClient.sendAudio(pcm.toString("base64"), sampleRate);
    } catch {
      return false;
    }

    return true;
  }

  markBotTurnOut(session, settings = session.settingsSnapshot) {
    const now = Date.now();
    if (now - Number(session.lastBotActivityTouchAt || 0) >= ACTIVITY_TOUCH_THROTTLE_MS) {
      this.touchActivity(session.guildId, settings);
      session.lastBotActivityTouchAt = now;
    }

    const pendingResponse =
      session.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
    const pendingLatencyContext =
      pendingResponse?.latencyContext && typeof pendingResponse.latencyContext === "object"
        ? pendingResponse.latencyContext
        : null;
    if (pendingLatencyContext && Number(pendingLatencyContext.audioStartedAtMs || 0) <= 0) {
      pendingLatencyContext.audioStartedAtMs = now;
      this.logVoiceLatencyStage({
        session,
        userId: this.client.user?.id || null,
        stage: "audio_started",
        source: pendingLatencyContext.source || pendingResponse?.source || "realtime",
        captureReason: pendingLatencyContext.captureReason || null,
        requestId: pendingResponse?.requestId || null,
        queueWaitMs: pendingLatencyContext.queueWaitMs,
        pendingQueueDepth: pendingLatencyContext.pendingQueueDepth,
        finalizedAtMs: pendingLatencyContext.finalizedAtMs,
        asrStartedAtMs: pendingLatencyContext.asrStartedAtMs,
        asrCompletedAtMs: pendingLatencyContext.asrCompletedAtMs,
        generationStartedAtMs: pendingLatencyContext.generationStartedAtMs,
        replyRequestedAtMs:
          Number(pendingLatencyContext.replyRequestedAtMs || 0) ||
          Number(pendingResponse?.requestedAt || 0) ||
          0,
        audioStartedAtMs: now
      });
    }

    if (!session.botTurnOpen) {
      session.botTurnOpen = true;
      session.lastAssistantReplyAt = now;
      this.store.logAction({
        kind: "voice_turn_out",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_started",
        metadata: {
          sessionId: session.id
        }
      });
    }

    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
    }

    session.botTurnResetTimer = setTimeout(() => {
      session.botTurnOpen = false;
      session.botTurnResetTimer = null;
      this.maybeClearActiveReplyInterruptionPolicy(session);
    }, BOT_TURN_SILENCE_RESET_MS);
  }

  getRealtimeTurnBacklogSize(session) {
    if (!session) return 0;
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns)
      ? session.pendingRealtimeTurns.length
      : 0;
    return Math.max(0, (session.realtimeTurnDrainActive ? 1 : 0) + pendingQueueDepth);
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
    const realtimeTurnBacklog = this.getRealtimeTurnBacklogSize(session);
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
        session.subprocessClient?.unsubscribeUser(String(userId || ""));
      } catch {
        // ignore
      }
      session.userCaptures?.delete?.(String(userId || ""));
    }
  }

  resolveVoiceThoughtEngineConfig(settings = null) {
    const resolvedSettings = settings || this.store.getSettings();
    const voiceSettings = resolvedSettings?.voice || {};
    const thoughtEngine = voiceSettings?.thoughtEngine || {};
    const enabled =
      thoughtEngine?.enabled !== undefined ? Boolean(thoughtEngine.enabled) : true;
    const provider = normalizeLlmProvider(
      thoughtEngine?.provider,
      voiceSettings?.generationLlm?.provider || "anthropic"
    );
    const configuredModel = String(thoughtEngine?.model || "").trim().slice(0, 120);
    const model = configuredModel || defaultModelForLlmProvider(provider);
    const configuredTemperature = Number(thoughtEngine?.temperature);
    const temperature = clamp(Number.isFinite(configuredTemperature) ? configuredTemperature : 0.8, 0, 2);
    const eagerness = clamp(Number(thoughtEngine?.eagerness) || 0, 0, 100);
    const minSilenceSeconds = clamp(
      Number(thoughtEngine?.minSilenceSeconds) || 20,
      VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
      VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
    );
    const minSecondsBetweenThoughts = clamp(
      Number(thoughtEngine?.minSecondsBetweenThoughts) || minSilenceSeconds,
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

  clearVoiceThoughtLoopTimer(session) {
    if (!session) return;
    if (session.thoughtLoopTimer) {
      clearTimeout(session.thoughtLoopTimer);
      session.thoughtLoopTimer = null;
    }
    session.nextThoughtAt = 0;
  }

  scheduleVoiceThoughtLoop({
    session,
    settings = null,
    delayMs = null
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.resolveVoiceThoughtEngineConfig(resolvedSettings);
    this.clearVoiceThoughtLoopTimer(session);
    if (!thoughtConfig.enabled) return;

    const defaultDelayMs = thoughtConfig.minSilenceSeconds * 1000;
    const requestedDelayMs = Number(delayMs);
    const waitMs = Math.max(
      120,
      Number.isFinite(requestedDelayMs) ? Math.round(requestedDelayMs) : defaultDelayMs
    );
    session.nextThoughtAt = Date.now() + waitMs;
    session.thoughtLoopTimer = setTimeout(() => {
      session.thoughtLoopTimer = null;
      session.nextThoughtAt = 0;
      this.maybeRunVoiceThoughtLoop({
        session,
        settings: session.settingsSnapshot || this.store.getSettings(),
        trigger: "timer"
      }).catch(() => undefined);
    }, waitMs);
  }

  evaluateVoiceThoughtLoopGate({
    session,
    settings = null,
    config = null,
    now = Date.now()
  }) {
    if (!session || session.ending) {
      return {
        allow: false,
        reason: "session_inactive",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }

    const thoughtConfig = config || this.resolveVoiceThoughtEngineConfig(settings);
    if (!thoughtConfig.enabled) {
      return {
        allow: false,
        reason: "thought_engine_disabled",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (this.isCommandOnlyActive(session, settings)) {
      return {
        allow: false,
        reason: "command_only_mode",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (musicPhaseIsActive(this.getMusicPhase(session))) {
      return {
        allow: false,
        reason: "music_playback_active",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    const minSilenceMs = thoughtConfig.minSilenceSeconds * 1000;
    const minIntervalMs = thoughtConfig.minSecondsBetweenThoughts * 1000;
    const silentDurationMs = Math.max(0, now - Number(session.lastActivityAt || 0));
    if (silentDurationMs < minSilenceMs) {
      return {
        allow: false,
        reason: "silence_window_not_met",
        retryAfterMs: Math.max(200, minSilenceMs - silentDurationMs)
      };
    }

    const sinceLastAttemptMs = Math.max(0, now - Number(session.lastThoughtAttemptAt || 0));
    if (sinceLastAttemptMs < minIntervalMs) {
      return {
        allow: false,
        reason: "thought_attempt_cooldown",
        retryAfterMs: Math.max(300, minIntervalMs - sinceLastAttemptMs)
      };
    }

    if (session.thoughtLoopBusy) {
      return {
        allow: false,
        reason: "thought_loop_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked) {
      return {
        allow: false,
        reason: "bot_turn_open",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
        outputLockReason: replyOutputLockState.reason
      };
    }
    if (Number(session.voiceLookupBusyCount || 0) > 0) {
      return {
        allow: false,
        reason: "voice_lookup_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.userCaptures?.size || 0) > 0) {
      return {
        allow: false,
        reason: "active_user_capture",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.pendingSttTurns || 0) > 0) {
      return {
        allow: false,
        reason: "pending_stt_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.getRealtimeTurnBacklogSize(session) > 0) {
      return {
        allow: false,
        reason: "pending_realtime_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.getDeferredQueuedUserTurns(session).length > 0) {
      return {
        allow: false,
        reason: "pending_deferred_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.countHumanVoiceParticipants(session) <= 0) {
      return {
        allow: false,
        reason: "no_human_participants",
        retryAfterMs: minSilenceMs
      };
    }

    return {
      allow: true,
      reason: "ok",
      retryAfterMs: minIntervalMs
    };
  }

  async maybeRunVoiceThoughtLoop({
    session,
    settings = null,
    trigger = "timer"
  }) {
    if (!session || session.ending) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.resolveVoiceThoughtEngineConfig(resolvedSettings);
    if (!thoughtConfig.enabled) {
      this.clearVoiceThoughtLoopTimer(session);
      return false;
    }

    const gate = this.evaluateVoiceThoughtLoopGate({
      session,
      settings: resolvedSettings,
      config: thoughtConfig
    });
    if (!gate.allow) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: gate.retryAfterMs
      });
      return false;
    }

    const thoughtChance = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100) / 100;
    const now = Date.now();
    session.lastThoughtAttemptAt = now;
    if (thoughtChance <= 0) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    const roll = Math.random();
    if (roll > thoughtChance) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_thought_skipped_probability",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          thoughtEagerness: Math.round(thoughtChance * 100),
          roll: Number(roll.toFixed(5))
        }
      });
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    session.thoughtLoopBusy = true;
    try {
      const thoughtDraft = await this.generateVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        config: thoughtConfig,
        trigger
      });
      if (!thoughtDraft) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "voice_thought_generation_skip",
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            trigger: String(trigger || "timer")
          }
        });
        return false;
      }

      const thoughtMemoryFacts = await this.loadVoiceThoughtMemoryFacts({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft
      });
      const thoughtTopicalityBias = resolveVoiceThoughtTopicalityBias({
        silenceMs: Math.max(0, Date.now() - Number(session.lastActivityAt || 0)),
        minSilenceSeconds: thoughtConfig.minSilenceSeconds,
        minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
      });
      const decision = await this.evaluateVoiceThoughtDecision({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft,
        memoryFacts: thoughtMemoryFacts,
        topicalityBias: thoughtTopicalityBias
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_thought_decision",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          allow: Boolean(decision.allow),
          reason: decision.reason,
          thoughtDraft,
          finalThought: decision.finalThought || null,
          memoryFactCount: Number(decision.memoryFactCount || 0),
          usedMemory: Boolean(decision.usedMemory),
          topicTetherStrength: thoughtTopicalityBias.topicTetherStrength,
          randomInspirationStrength: thoughtTopicalityBias.randomInspirationStrength,
          topicDriftPhase: thoughtTopicalityBias.phase,
          topicDriftHint: thoughtTopicalityBias.promptHint,
          llmResponse: decision.llmResponse || null,
          llmProvider: decision.llmProvider || null,
          llmModel: decision.llmModel || null,
          error: decision.error || null
        }
      });
      if (!decision.allow) return false;
      const finalThought = normalizeVoiceText(
        decision.finalThought || thoughtDraft,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (!finalThought) return false;

      const spoken = await this.deliverVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        thoughtCandidate: finalThought,
        trigger
      });
      if (spoken) {
        session.lastThoughtSpokenAt = Date.now();
      }
      return spoken;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_thought_loop_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer")
        }
      });
      return false;
    } finally {
      session.thoughtLoopBusy = false;
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
    }
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
    const generationSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        provider: thoughtConfig.provider,
        model: thoughtConfig.model,
        temperature: thoughtConfig.temperature,
        maxOutputTokens: 96
      }
    };

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

    const replyDecisionLlm = settings?.voice?.replyDecisionLlm || {};
    if (!this.llm?.generate) {
      return {
        allow: false,
        reason: "llm_generate_unavailable",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: 0
      };
    }

    const llmProvider = normalizeVoiceReplyDecisionProvider(replyDecisionLlm?.provider);
    const llmModel = String(replyDecisionLlm?.model || defaultVoiceReplyDecisionModel(llmProvider))
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
    const thoughtEagerness = clamp(Number(settings?.voice?.thoughtEngine?.eagerness) || 0, 0, 100);
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
        settings: {
          ...settings,
          llm: {
            ...(settings?.llm || {}),
            provider: llmProvider,
            model: llmModel,
            temperature: 0,
            maxOutputTokens: VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
            reasoningEffort: String(replyDecisionLlm?.reasoningEffort || "minimal").trim().toLowerCase() || "minimal"
          }
        },
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

    let requestedRealtimeUtterance = false;
    if (isRealtimeMode(session.mode)) {
      requestedRealtimeUtterance = this.requestRealtimeTextUtterance({
        session,
        text: line,
        userId: this.client.user?.id || null,
        source: "voice_thought_engine"
      });
      if (!requestedRealtimeUtterance) {
        const spokeFallback = await this.speakVoiceLineWithTts({
          session,
          settings,
          text: line,
          source: "voice_thought_engine_tts_fallback"
        });
        if (!spokeFallback) return false;
        session.lastAudioDeltaAt = Date.now();
      }
    } else {
      const spokeLine = await this.speakVoiceLineWithTts({
        session,
        settings,
        text: line,
        source: "voice_thought_engine_tts"
      });
      if (!spokeLine) return false;
      session.lastAudioDeltaAt = Date.now();
    }

    const replyAt = Date.now();
    session.lastAssistantReplyAt = replyAt;
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
        }).catch(() => undefined);
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

    if (isRealtimeMode(session.mode) && this.requestRealtimeTextUtterance({
      session,
      text: line,
      userId,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    })) {
      return;
    }

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
    const tunedSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        temperature: clamp(Number(settings?.llm?.temperature) || 0.75, 0.2, 1.1),
        maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 28, 8, 40)
      }
    };
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
      this.createTrackedAudioResponse({
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
    generationStartedAtMs = 0
  } = {}) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const generationStartedAt = Math.max(0, Number(generationStartedAtMs || 0));
    const pendingSummary = this.summarizeRealtimeInterruptingQueue({
      session,
      finalizedAfterMs: generationStartedAt
    });
    const hasInterruptingNewerInput = pendingSummary.pendingInterruptingQueueDepth > 0;
    if (!hasInterruptingNewerInput) return false;

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
        supersedeReason: "newer_finalized_realtime_turn",
        generationStartedAt: generationStartedAt > 0 ? generationStartedAt : null,
        pendingRealtimeQueueDepth: pendingSummary.pendingInterruptingQueueDepth,
        totalPendingRealtimeQueueDepth: pendingSummary.totalPendingRealtimeQueueDepth,
        consideredPendingRealtimeQueueDepth: pendingSummary.consideredPendingRealtimeQueueDepth,
        pendingNearSilentQueueDepth: pendingSummary.pendingNearSilentQueueDepth,
        oldestConsideredFinalizedAt: pendingSummary.oldestConsideredFinalizedAt,
        newestConsideredFinalizedAt: pendingSummary.newestConsideredFinalizedAt,
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
              generationStartedAtMs: Number(latencyContext?.generationStartedAtMs || 0)
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
              generationStartedAtMs: Number(latencyContext?.generationStartedAtMs || 0)
            })
          ) {
            completed = false;
            break;
          }
        }
        const spoke = await this.speakVoiceLineWithTts({
          session,
          settings,
          text: segmentText,
          source: `${speechSource}:tts_fallback`
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
      const pending = session.pendingResponse;
      const pendingHasAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;
      const hasPostRequestAudio = Number(session.lastAudioDeltaAt || 0) >= audioRequestedAt;

      if (botTurnOpen || pendingHasAudio || hasPostRequestAudio) {
        observedPlayback = true;
      }

      if (observedPlayback && !botTurnOpen && (session.playerState === "idle" || session.playerState === "buffering")) {
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
    if (Number(session.userCaptures?.size || 0) > 0) return false;
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;
    if (!this.llm?.synthesizeSpeech) return false;

    const sttSettings = settings?.voice?.sttPipeline || {};
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
    this.markBotTurnOut(session, settings);
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
    const transcriptionMethod = String(
      resolvedSettings?.voice?.openaiRealtime?.transcriptionMethod || "realtime_bridge"
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
    if (resolvedSettings?.voice?.openaiRealtime?.usePerUserAsrBridge === false) {
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
    const transcriptionMethod = String(
      resolvedSettings?.voice?.openaiRealtime?.transcriptionMethod || "realtime_bridge"
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
    if (resolvedSettings?.voice?.openaiRealtime?.usePerUserAsrBridge === true) {
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
    const replyPath = String(resolvedSettings?.voice?.replyPath || "")
      .trim()
      .toLowerCase();
    if (replyPath === "bridge") return true;
    if (replyPath === "brain" || replyPath === "native") return false;
    return false;
  }

  getOpenAiSharedAsrState(session) {
    if (!session || session.ending) return null;
    if (!session.openAiSharedAsrState) {
      session.openAiSharedAsrState = {
        userId: null,
        client: null,
        connectPromise: null,
        closing: false,
        isCommittingAsr: false,
        committingUtteranceId: 0,
        pendingAudioChunks: [],
        pendingAudioBytes: 0,
        connectedAt: 0,
        lastAudioAt: 0,
        lastTranscriptAt: 0,
        lastPartialLogAt: 0,
        lastPartialText: "",
        idleTimer: null,
        utterance: {
          id: 0,
          startedAt: 0,
          bytesSent: 0,
          partialText: "",
          finalSegments: [],
          finalSegmentEntries: [],
          lastUpdateAt: 0
        },
        itemIdToUserId: new Map(),
        finalTranscriptsByItemId: new Map(),
        pendingCommitResolvers: [],
        pendingCommitRequests: []
      };
    }
    return session.openAiSharedAsrState;
  }

  getOpenAiAsrSessionMap(session) {
    if (!session || session.ending) return null;
    if (!(session.openAiAsrSessions instanceof Map)) {
      session.openAiAsrSessions = new Map();
    }
    return session.openAiAsrSessions;
  }

  getOrCreateOpenAiAsrSessionState({ session, userId }) {
    const sessionMap = this.getOpenAiAsrSessionMap(session);
    const normalizedUserId = String(userId || "").trim();
    if (!sessionMap || !normalizedUserId) return null;
    const existing = sessionMap.get(normalizedUserId);
    if (existing && typeof existing === "object") {
      return existing;
    }

    const state = {
      userId: normalizedUserId,
      client: null,
      connectPromise: null,
      closing: false,
      isCommittingAsr: false,
      committingUtteranceId: 0,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      connectedAt: 0,
      lastAudioAt: 0,
      lastTranscriptAt: 0,
      lastPartialLogAt: 0,
      lastPartialText: "",
      idleTimer: null,
      utterance: {
        id: 0,
        startedAt: 0,
        bytesSent: 0,
        partialText: "",
        finalSegments: [],
        finalSegmentEntries: [],
        lastUpdateAt: 0
      }
    };
    sessionMap.set(normalizedUserId, state);
    return state;
  }

  createOpenAiAsrRuntimeLogger(session, userId) {
    return ({ level, event, metadata }) => {
      this.store.logAction({
        kind: level === "warn" ? "voice_error" : "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: String(userId || "").trim() || this.client.user?.id || null,
        content: event,
        metadata: {
          sessionId: session.id,
          ...(metadata && typeof metadata === "object" ? metadata : {})
        }
      });
    };
  }

  async ensureOpenAiAsrSessionConnected({
    session,
    settings = null,
    userId
  }) {
    if (!session || session.ending) return null;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return null;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return null;
    if (asrState.closing) return null;

    const ws = asrState.client?.ws;
    if (ws && ws.readyState === 1) {
      return asrState;
    }

    if (asrState.connectPromise) {
      await asrState.connectPromise.catch(() => undefined);
      return asrState.client ? asrState : null;
    }

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceAsrGuidance = resolveVoiceAsrLanguageGuidance(resolvedSettings);
    const model = String(
      session.openAiPerUserAsrModel ||
      resolvedSettings?.voice?.openaiRealtime?.inputTranscriptionModel ||
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    )
      .trim()
      .slice(0, 120);
    const normalizedModel = normalizeOpenAiRealtimeTranscriptionModel(
      model,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const language = String(
      session.openAiPerUserAsrLanguage || voiceAsrGuidance.language || ""
    )
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 24);
    const prompt = String(session.openAiPerUserAsrPrompt || voiceAsrGuidance.prompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    const runtimeLogger = this.createOpenAiAsrRuntimeLogger(session, userId);
    const client = new OpenAiRealtimeTranscriptionClient({
      apiKey: this.appConfig.openaiApiKey,
      logger: runtimeLogger
    });
    asrState.client = client;
    asrState.connectPromise = (async () => {
      client.on("transcript", (payload) => {
        if (session.ending) return;
        const transcript = normalizeVoiceText(payload?.text || "", STT_TRANSCRIPT_MAX_CHARS);
        if (!transcript) return;

        const eventType = String(payload?.eventType || "").trim();
        const isFinal = Boolean(payload?.final);
        const itemId = normalizeInlineText(payload?.itemId, 180);
        const previousItemId = normalizeInlineText(payload?.previousItemId, 180) || null;
        const now = Date.now();
        asrState.lastTranscriptAt = now;
        asrState.utterance.lastUpdateAt = now;
        if (isFinal) {
          if (itemId) {
            const entries = Array.isArray(asrState.utterance.finalSegmentEntries)
              ? asrState.utterance.finalSegmentEntries
              : [];
            const nextEntry = {
              itemId,
              previousItemId,
              text: transcript,
              receivedAt: now
            };
            const existingIndex = entries.findIndex((entry) => String(entry?.itemId || "") === itemId);
            if (existingIndex >= 0) {
              entries[existingIndex] = nextEntry;
            } else {
              entries.push(nextEntry);
            }
            asrState.utterance.finalSegmentEntries = entries;
            asrState.utterance.finalSegments = this.orderOpenAiAsrFinalSegments(entries);
          } else {
            asrState.utterance.finalSegments.push(transcript);
          }
          asrState.utterance.partialText = "";
        } else {
          asrState.utterance.partialText = transcript;
        }

        const speakerName = this.resolveVoiceSpeakerName(session, userId) || "someone";
        const shouldLogPartial =
          !isFinal &&
          transcript !== asrState.lastPartialText &&
          now - Number(asrState.lastPartialLogAt || 0) >= 180;
        if (isFinal || shouldLogPartial) {
          if (!isFinal) {
            asrState.lastPartialLogAt = now;
            asrState.lastPartialText = transcript;
          }
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: String(userId || "").trim() || null,
            content: isFinal ? "openai_realtime_asr_final_segment" : "openai_realtime_asr_partial_segment",
            metadata: {
              sessionId: session.id,
              speakerName,
              transcript,
              eventType: eventType || null,
              itemId: itemId || null,
              previousItemId
            }
          });
        }
      });

      client.on("error_event", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: `openai_realtime_asr_error: ${String(payload?.message || "unknown error")}`,
          metadata: {
            sessionId: session.id,
            code: payload?.code || null,
            param: payload?.param || null
          }
        });
      });

      client.on("socket_closed", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: "openai_realtime_asr_socket_closed",
          metadata: {
            sessionId: session.id,
            code: Number(payload?.code || 0) || null,
            reason: String(payload?.reason || "").trim() || null
          }
        });
      });

      await client.connect({
        model: normalizedModel,
        inputAudioFormat: "pcm16",
        inputTranscriptionModel: normalizedModel,
        inputTranscriptionLanguage: language,
        inputTranscriptionPrompt: prompt
      });
      asrState.connectedAt = Date.now();
      await this.flushPendingOpenAiAsrAudio({
        session,
        userId,
        asrState
      });
    })();

    try {
      await asrState.connectPromise;
      return asrState;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: String(userId || "").trim() || null,
        content: `openai_realtime_asr_connect_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      await this.closeOpenAiAsrSession({
        session,
        userId,
        reason: "connect_failed"
      });
      return null;
    } finally {
      asrState.connectPromise = null;
    }
  }

  async flushPendingOpenAiAsrAudio({
    session,
    userId,
    asrState = null,
    utteranceId = null
  }) {
    const state = asrState && typeof asrState === "object"
      ? asrState
      : this.getOrCreateOpenAiAsrSessionState({
        session,
        userId
      });
    if (!state || state.closing) return;
    const client = state.client;
    if (!client || !client.ws || client.ws.readyState !== 1) return;
    const targetUtteranceId = Math.max(
      0,
      Number(
        utteranceId !== null && utteranceId !== undefined
          ? utteranceId
          : state.utterance?.id || 0
      )
    );
    if (!targetUtteranceId) return;
    const committingUtteranceId = Math.max(0, Number(state.committingUtteranceId || 0));
    if (
      state.isCommittingAsr &&
      committingUtteranceId > 0 &&
      targetUtteranceId !== committingUtteranceId
    ) {
      return;
    }
    const chunks = Array.isArray(state.pendingAudioChunks) ? state.pendingAudioChunks : [];
    if (!chunks.length) return;

    const remainingChunks = [];
    while (chunks.length > 0) {
      const entry = chunks.shift();
      if (!entry || !Buffer.isBuffer(entry.chunk)) continue;
      if (Number(entry.utteranceId || 0) !== targetUtteranceId) {
        remainingChunks.push(entry);
        continue;
      }
      try {
        client.appendInputAudioPcm(entry.chunk);
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: `openai_realtime_asr_audio_append_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        remainingChunks.push(entry);
        while (chunks.length > 0) {
          const pendingEntry = chunks.shift();
          if (!pendingEntry || !Buffer.isBuffer(pendingEntry.chunk)) continue;
          remainingChunks.push(pendingEntry);
        }
        break;
      }
    }
    state.pendingAudioChunks = remainingChunks;
    state.pendingAudioBytes = state.pendingAudioChunks.reduce(
      (total, pendingChunk) => total + Number(pendingChunk?.chunk?.length || 0),
      0
    );
  }

  beginOpenAiAsrUtterance({
    session,
    settings = null,
    userId
  }) {
    if (!session || session.ending) return;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return;

    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }

    asrState.utterance = {
      id: Math.max(0, Number(asrState.utterance?.id || 0)) + 1,
      startedAt: Date.now(),
      bytesSent: 0,
      partialText: "",
      finalSegments: [],
      finalSegmentEntries: [],
      lastUpdateAt: 0
    };
    asrState.lastPartialText = "";
    asrState.lastPartialLogAt = 0;
    // Do NOT clear the OpenAI buffer here — a concurrent commit may have
    // already flushed audio that hasn't been committed yet.  The buffer is
    // implicitly reset after each successful commit, and clearing here risks
    // wiping in-flight audio in rapid speech-restart scenarios.

    void this.ensureOpenAiAsrSessionConnected({
      session,
      settings,
      userId
    });
  }

  appendAudioToOpenAiAsr({
    session,
    settings = null,
    userId,
    pcmChunk
  }) {
    if (!session || session.ending) return;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState || asrState.closing) return;
    const chunk = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk || []);
    if (!chunk.length) return;
    asrState.lastAudioAt = Date.now();
    asrState.utterance.bytesSent = Math.max(0, Number(asrState.utterance?.bytesSent || 0)) + chunk.length;
    const utteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
    if (!utteranceId) return;
    const queuedChunk = {
      utteranceId,
      chunk
    };

    const queue = Array.isArray(asrState.pendingAudioChunks) ? asrState.pendingAudioChunks : [];
    asrState.pendingAudioChunks = queue;
    queue.push(queuedChunk);
    asrState.pendingAudioBytes = Math.max(0, Number(asrState.pendingAudioBytes || 0)) + chunk.length;
    const maxBufferedBytes = 24_000 * 2 * 10;
    if (asrState.pendingAudioBytes > maxBufferedBytes && queue.length > 1) {
      while (queue.length > 1 && asrState.pendingAudioBytes > maxBufferedBytes) {
        const dropped = queue.shift();
        asrState.pendingAudioBytes = Math.max(
          0,
          asrState.pendingAudioBytes - Number(dropped?.chunk?.length || 0)
        );
      }
    }

    void this.ensureOpenAiAsrSessionConnected({
      session,
      settings,
      userId
    }).then((state) => {
      if (!state) return;
      void this.flushPendingOpenAiAsrAudio({
        session,
        userId,
        asrState: state,
        utteranceId
      });
    });
  }

  orderOpenAiAsrFinalSegments(entries = []) {
    const normalizedEntries = Array.isArray(entries)
      ? entries
        .map((entry, index) => ({
          itemId: normalizeInlineText(entry?.itemId, 180),
          previousItemId: normalizeInlineText(entry?.previousItemId, 180) || null,
          text: normalizeVoiceText(entry?.text || "", STT_TRANSCRIPT_MAX_CHARS),
          receivedAt: Math.max(0, Number(entry?.receivedAt || 0)),
          index
        }))
        .filter((entry) => entry.itemId && entry.text)
      : [];
    if (normalizedEntries.length <= 1) {
      return normalizedEntries.map((entry) => entry.text);
    }

    const byId = new Map();
    for (const entry of normalizedEntries) {
      byId.set(entry.itemId, entry);
    }
    const sorted = [...byId.values()].sort((a, b) => {
      const delta = Number(a.receivedAt || 0) - Number(b.receivedAt || 0);
      if (delta !== 0) return delta;
      return Number(a.index || 0) - Number(b.index || 0);
    });

    const placed = new Set();
    const ordered = [];
    while (ordered.length < sorted.length) {
      let progressed = false;
      for (const entry of sorted) {
        if (placed.has(entry.itemId)) continue;
        const previousItemId = String(entry.previousItemId || "");
        if (!previousItemId || !byId.has(previousItemId) || placed.has(previousItemId)) {
          placed.add(entry.itemId);
          ordered.push(entry.text);
          progressed = true;
        }
      }
      if (progressed) continue;
      // Fall back to arrival order if chain is incomplete/cyclic.
      for (const entry of sorted) {
        if (placed.has(entry.itemId)) continue;
        placed.add(entry.itemId);
        ordered.push(entry.text);
      }
    }

    return ordered;
  }

  async waitForOpenAiAsrTranscriptSettle({
    session,
    asrState,
    utterance = null
  }) {
    if (!session || session.ending || !asrState) return "";
    const trackedUtterance = utterance && typeof utterance === "object"
      ? utterance
      : asrState.utterance;
    const stableWindowMs = Math.max(
      100,
      Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS)
    );
    const maxWaitMs = Math.max(
      stableWindowMs + 120,
      Number(session.openAiAsrTranscriptWaitMaxMs || OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS)
    );
    const startedAt = Date.now();
    while (Date.now() - startedAt <= maxWaitMs) {
      if (session.ending) return "";
      const now = Date.now();
      const lastUpdateAt = Math.max(0, Number(trackedUtterance?.lastUpdateAt || 0));
      const stable = lastUpdateAt > 0 ? now - lastUpdateAt >= stableWindowMs : false;
      const finalText = normalizeVoiceText(
        Array.isArray(trackedUtterance?.finalSegments)
          ? trackedUtterance.finalSegments.join(" ")
          : "",
        STT_TRANSCRIPT_MAX_CHARS
      );
      const partialText = normalizeVoiceText(
        trackedUtterance?.partialText || "",
        STT_TRANSCRIPT_MAX_CHARS
      );
      if (finalText && stable) return finalText;
      if (!finalText && partialText && stable) return partialText;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const finalText = normalizeVoiceText(
      Array.isArray(trackedUtterance?.finalSegments)
        ? trackedUtterance.finalSegments.join(" ")
        : "",
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (finalText) return finalText;
    return normalizeVoiceText(trackedUtterance?.partialText || "", STT_TRANSCRIPT_MAX_CHARS);
  }

  async commitOpenAiAsrUtterance({
    session,
    settings = null,
    userId,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return null;
    if (!this.shouldUsePerUserTranscription({ session, settings })) return null;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return null;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId: normalizedUserId
    });
    if (!asrState || asrState.closing) return null;
    const trackedUtterance = asrState.utterance && typeof asrState.utterance === "object"
      ? asrState.utterance
      : null;
    const trackedUtteranceId = Math.max(0, Number(trackedUtterance?.id || 0));
    if (!trackedUtteranceId) return null;
    asrState.isCommittingAsr = true;
    asrState.committingUtteranceId = trackedUtteranceId;

    const connectedAsrState = await this.ensureOpenAiAsrSessionConnected({
      session,
      settings,
      userId: normalizedUserId
    });
    if (!connectedAsrState || connectedAsrState !== asrState || asrState.closing) {
      asrState.isCommittingAsr = false;
      asrState.committingUtteranceId = 0;
      return null;
    }
    const transcriptionModelPrimary = normalizeOpenAiRealtimeTranscriptionModel(
      session.openAiPerUserAsrModel,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const utteranceBytesSent = Math.max(0, Number(trackedUtterance?.bytesSent || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (utteranceBytesSent < minCommitBytes) {
      if (utteranceBytesSent > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "openai_realtime_asr_commit_skipped_small_buffer",
          metadata: {
            sessionId: session.id,
            utteranceBytesSent,
            minCommitBytes,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }
      this.scheduleOpenAiAsrSessionIdleClose({
        session,
        userId: normalizedUserId
      });
      return {
        transcript: "",
        asrStartedAtMs: 0,
        asrCompletedAtMs: 0,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_per_user_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    }

    await this.flushPendingOpenAiAsrAudio({
      session,
      userId: normalizedUserId,
      asrState,
      utteranceId: trackedUtteranceId
    });

    const asrStartedAtMs = Date.now();
    try {
      asrState.client?.commitInputAudioBuffer?.();
      const transcript = await this.waitForOpenAiAsrTranscriptSettle({
        session,
        asrState,
        utterance: trackedUtterance
      });
      const asrCompletedAtMs = Date.now();

      this.scheduleOpenAiAsrSessionIdleClose({
        session,
        userId: normalizedUserId
      });
      if (trackedUtterance) {
        trackedUtterance.bytesSent = 0;
      }

      if (!transcript) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_per_user_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `openai_realtime_asr_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return null;
    } finally {
      asrState.isCommittingAsr = false;
      asrState.committingUtteranceId = 0;
      const activeUtteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
      if (activeUtteranceId > 0) {
        void this.flushPendingOpenAiAsrAudio({
          session,
          userId: normalizedUserId,
          asrState,
          utteranceId: activeUtteranceId
        });
      }
    }
  }

  scheduleOpenAiAsrSessionIdleClose({
    session,
    userId
  }) {
    if (!session || session.ending) return;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return;
    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }
    const ttlMs = Math.max(
      1_000,
      Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
    );
    asrState.idleTimer = setTimeout(() => {
      asrState.idleTimer = null;
      this.closeOpenAiAsrSession({
        session,
        userId,
        reason: "idle_ttl"
      }).catch(() => undefined);
    }, ttlMs);
  }

  async closeOpenAiAsrSession({
    session,
    userId,
    reason = "manual"
  }) {
    if (!session) return;
    const sessionMap = this.getOpenAiAsrSessionMap(session);
    const normalizedUserId = String(userId || "").trim();
    if (!sessionMap || !normalizedUserId) return;
    const state = sessionMap.get(normalizedUserId);
    if (!state) return;
    state.closing = true;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    sessionMap.delete(normalizedUserId);

    try {
      await state.client?.close?.();
    } catch {
      // ignore
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      content: "openai_realtime_asr_session_closed",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "manual")
      }
    });
  }

  async closeAllOpenAiAsrSessions(session, reason = "session_end") {
    if (!session) return;
    const sessionMap = this.getOpenAiAsrSessionMap(session);
    if (!sessionMap || sessionMap.size <= 0) return;
    const userIds = [...sessionMap.keys()];
    for (const userId of userIds) {
      await this.closeOpenAiAsrSession({
        session,
        userId,
        reason
      });
    }
  }

  resolveOpenAiSharedAsrSpeakerUserId({
    session: _session,
    asrState,
    itemId = "",
    fallbackUserId = null
  }) {
    const normalizedItemId = normalizeInlineText(itemId, 180);
    if (normalizedItemId && asrState?.itemIdToUserId instanceof Map) {
      const mappedUserId = String(asrState.itemIdToUserId.get(normalizedItemId) || "").trim();
      if (mappedUserId) return mappedUserId;
    }
    const normalizedFallbackUserId = String(fallbackUserId || "").trim();
    if (normalizedFallbackUserId) return normalizedFallbackUserId;
    const activeSharedUserId = String(asrState?.userId || "").trim();
    if (activeSharedUserId) return activeSharedUserId;
    return this.client.user?.id || null;
  }

  getOpenAiSharedAsrPendingCommitRequests(asrState) {
    if (!asrState || typeof asrState !== "object") return [];
    const pendingCommitRequests = Array.isArray(asrState.pendingCommitRequests)
      ? asrState.pendingCommitRequests
      : [];
    asrState.pendingCommitRequests = pendingCommitRequests;
    return pendingCommitRequests;
  }

  pruneOpenAiSharedAsrPendingCommitRequests(asrState, maxAgeMs = 30_000) {
    const pendingCommitRequests = this.getOpenAiSharedAsrPendingCommitRequests(asrState);
    if (!pendingCommitRequests.length) return pendingCommitRequests;
    const maxAge = Math.max(1_000, Number(maxAgeMs) || 30_000);
    const now = Date.now();
    while (pendingCommitRequests.length > 0) {
      const head = pendingCommitRequests[0];
      const requestedAt = Math.max(0, Number(head?.requestedAt || 0));
      if (requestedAt > 0 && now - requestedAt <= maxAge) break;
      pendingCommitRequests.shift();
    }
    return pendingCommitRequests;
  }

  trackOpenAiSharedAsrCommittedItem({
    asrState,
    itemId,
    fallbackUserId = null
  }) {
    if (!asrState || !(asrState.itemIdToUserId instanceof Map)) return;
    const normalizedItemId = normalizeInlineText(itemId, 180);
    if (!normalizedItemId) return;
    const pendingCommitRequests = this.pruneOpenAiSharedAsrPendingCommitRequests(asrState);
    const commitRequest = pendingCommitRequests.length > 0 ? pendingCommitRequests.shift() : null;
    const commitRequestUserId = String(commitRequest?.userId || "").trim();
    const mappedUserId = String(fallbackUserId || commitRequestUserId || "").trim();
    if (mappedUserId) {
      asrState.itemIdToUserId.set(normalizedItemId, mappedUserId);
      if (asrState.itemIdToUserId.size > 320) {
        const overflow = asrState.itemIdToUserId.size - 320;
        let dropped = 0;
        for (const staleItemId of asrState.itemIdToUserId.keys()) {
          asrState.itemIdToUserId.delete(staleItemId);
          dropped += 1;
          if (dropped >= overflow) break;
        }
      }
    }
    const pendingResolvers = Array.isArray(asrState.pendingCommitResolvers)
      ? asrState.pendingCommitResolvers
      : [];
    asrState.pendingCommitResolvers = pendingResolvers;
    if (!pendingResolvers.length) return;
    const resolverIndex = mappedUserId
      ? pendingResolvers.findIndex((entry) => String(entry?.userId || "").trim() === mappedUserId)
      : pendingResolvers.findIndex((entry) => !String(entry?.userId || "").trim());
    if (resolverIndex < 0) return;
    const [resolver] = pendingResolvers.splice(resolverIndex, 1);
    if (resolver && typeof resolver.resolve === "function") {
      resolver.resolve(normalizedItemId);
    }
  }

  waitForOpenAiSharedAsrCommittedItem({
    session,
    asrState,
    userId,
    commitRequestId = ""
  }): Promise<string> {
    if (!session || session.ending || !asrState) return Promise.resolve("");
    const waitMs = Math.max(
      600,
      Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS) * 4
    );
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedCommitRequestId = String(commitRequestId || "").trim();
    return new Promise<string>((resolve) => {
      const pendingResolvers = Array.isArray(asrState.pendingCommitResolvers)
        ? asrState.pendingCommitResolvers
        : [];
      asrState.pendingCommitResolvers = pendingResolvers;
      const waiterId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const timeout = setTimeout(() => {
        const index = pendingResolvers.findIndex((entry) => entry?.id === waiterId);
        if (index >= 0) pendingResolvers.splice(index, 1);
        resolve("");
      }, waitMs);
      const waiter = {
        id: waiterId,
        userId: normalizedUserId,
        commitRequestId: normalizedCommitRequestId || null,
        resolve: (itemId) => {
          clearTimeout(timeout);
          resolve(normalizeInlineText(itemId, 180) || "");
        }
      };
      pendingResolvers.push(waiter);
    });
  }

  async waitForOpenAiSharedAsrTranscriptByItem({
    session,
    asrState,
    itemId = ""
  }) {
    if (!session || session.ending || !asrState) return "";
    const normalizedItemId = normalizeInlineText(itemId, 180);
    if (!normalizedItemId) {
      return this.waitForOpenAiAsrTranscriptSettle({
        session,
        asrState
      });
    }
    const stableWindowMs = Math.max(
      100,
      Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS)
    );
    const maxWaitMs = Math.max(
      stableWindowMs + 120,
      Number(session.openAiAsrTranscriptWaitMaxMs || OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS)
    );
    const startedAt = Date.now();
    while (Date.now() - startedAt <= maxWaitMs) {
      if (session.ending) return "";
      const finalByItemId = asrState.finalTranscriptsByItemId instanceof Map
        ? asrState.finalTranscriptsByItemId
        : null;
      const transcript = normalizeVoiceText(finalByItemId?.get(normalizedItemId) || "", STT_TRANSCRIPT_MAX_CHARS);
      if (transcript) return transcript;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const finalByItemId = asrState.finalTranscriptsByItemId instanceof Map
      ? asrState.finalTranscriptsByItemId
      : null;
    return normalizeVoiceText(finalByItemId?.get(normalizedItemId) || "", STT_TRANSCRIPT_MAX_CHARS);
  }

  async ensureOpenAiSharedAsrSessionConnected({
    session,
    settings = null
  }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseSharedTranscription({ session, settings })) return null;
    const asrState = this.getOpenAiSharedAsrState(session);
    if (!asrState || asrState.closing) return null;

    const ws = asrState.client?.ws;
    if (ws && ws.readyState === 1) {
      return asrState;
    }

    if (asrState.connectPromise) {
      await asrState.connectPromise.catch(() => undefined);
      return asrState.client ? asrState : null;
    }

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceAsrGuidance = resolveVoiceAsrLanguageGuidance(resolvedSettings);
    const model = String(
      session.openAiPerUserAsrModel ||
      resolvedSettings?.voice?.openaiRealtime?.inputTranscriptionModel ||
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    )
      .trim()
      .slice(0, 120);
    const normalizedModel = normalizeOpenAiRealtimeTranscriptionModel(
      model,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const language = String(
      session.openAiPerUserAsrLanguage || voiceAsrGuidance.language || ""
    )
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 24);
    const prompt = String(session.openAiPerUserAsrPrompt || voiceAsrGuidance.prompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    const runtimeLogger = this.createOpenAiAsrRuntimeLogger(session, "shared_asr");
    const client = new OpenAiRealtimeTranscriptionClient({
      apiKey: this.appConfig.openaiApiKey,
      logger: runtimeLogger
    });
    asrState.client = client;
    asrState.connectPromise = (async () => {
      client.on("event", (event) => {
        if (session.ending || !event || typeof event !== "object") return;
        if (event.type === "input_audio_buffer.committed") {
          this.trackOpenAiSharedAsrCommittedItem({
            asrState,
            itemId: event.item_id || event.item?.id
          });
        }
      });

      client.on("transcript", (payload) => {
        if (session.ending) return;
        const transcript = normalizeVoiceText(payload?.text || "", STT_TRANSCRIPT_MAX_CHARS);
        if (!transcript) return;

        const eventType = String(payload?.eventType || "").trim();
        const isFinal = Boolean(payload?.final);
        const itemId = normalizeInlineText(payload?.itemId, 180);
        const previousItemId = normalizeInlineText(payload?.previousItemId, 180) || null;
        const now = Date.now();
        asrState.lastTranscriptAt = now;
        asrState.utterance.lastUpdateAt = now;
        if (isFinal) {
          if (itemId) {
            const entries = Array.isArray(asrState.utterance.finalSegmentEntries)
              ? asrState.utterance.finalSegmentEntries
              : [];
            const nextEntry = {
              itemId,
              previousItemId,
              text: transcript,
              receivedAt: now
            };
            const existingIndex = entries.findIndex((entry) => String(entry?.itemId || "") === itemId);
            if (existingIndex >= 0) {
              entries[existingIndex] = nextEntry;
            } else {
              entries.push(nextEntry);
            }
            asrState.utterance.finalSegmentEntries = entries;
            asrState.utterance.finalSegments = this.orderOpenAiAsrFinalSegments(entries);
            if (!(asrState.finalTranscriptsByItemId instanceof Map)) {
              asrState.finalTranscriptsByItemId = new Map();
            }
            asrState.finalTranscriptsByItemId.set(itemId, transcript);
            if (asrState.finalTranscriptsByItemId.size > 320) {
              const overflow = asrState.finalTranscriptsByItemId.size - 320;
              let dropped = 0;
              for (const staleItemId of asrState.finalTranscriptsByItemId.keys()) {
                asrState.finalTranscriptsByItemId.delete(staleItemId);
                dropped += 1;
                if (dropped >= overflow) break;
              }
            }
          } else {
            asrState.utterance.finalSegments.push(transcript);
          }
          asrState.utterance.partialText = "";
        } else {
          asrState.utterance.partialText = transcript;
        }

        const transcriptSpeakerUserId = this.resolveOpenAiSharedAsrSpeakerUserId({
          session,
          asrState,
          itemId,
          fallbackUserId: asrState.userId
        });
        const speakerName = this.resolveVoiceSpeakerName(session, transcriptSpeakerUserId) || "someone";
        const shouldLogPartial =
          !isFinal &&
          transcript !== asrState.lastPartialText &&
          now - Number(asrState.lastPartialLogAt || 0) >= 180;
        if (isFinal || shouldLogPartial) {
          if (!isFinal) {
            asrState.lastPartialLogAt = now;
            asrState.lastPartialText = transcript;
          }
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: transcriptSpeakerUserId || null,
            content: isFinal ? "openai_realtime_asr_final_segment" : "openai_realtime_asr_partial_segment",
            metadata: {
              sessionId: session.id,
              speakerName,
              transcript,
              eventType: eventType || null,
              itemId: itemId || null,
              previousItemId
            }
          });
        }
      });

      client.on("error_event", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: asrState.userId || null,
          content: `openai_realtime_asr_error: ${String(payload?.message || "unknown error")}`,
          metadata: {
            sessionId: session.id,
            code: payload?.code || null,
            param: payload?.param || null
          }
        });
      });

      client.on("socket_closed", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: asrState.userId || null,
          content: "openai_realtime_asr_socket_closed",
          metadata: {
            sessionId: session.id,
            code: Number(payload?.code || 0) || null,
            reason: String(payload?.reason || "").trim() || null
          }
        });
      });

      await client.connect({
        model: normalizedModel,
        inputAudioFormat: "pcm16",
        inputTranscriptionModel: normalizedModel,
        inputTranscriptionLanguage: language,
        inputTranscriptionPrompt: prompt
      });
      asrState.connectedAt = Date.now();
      await this.flushPendingOpenAiSharedAsrAudio({
        session,
        asrState
      });
    })();

    try {
      await asrState.connectPromise;
      return asrState;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: asrState.userId || null,
        content: `openai_realtime_asr_connect_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      await this.closeOpenAiSharedAsrSession(session, "connect_failed");
      return null;
    } finally {
      asrState.connectPromise = null;
    }
  }

  async flushPendingOpenAiSharedAsrAudio({
    session,
    asrState = null,
    utteranceId = null
  }) {
    const state = asrState && typeof asrState === "object"
      ? asrState
      : this.getOpenAiSharedAsrState(session);
    if (!state || state.closing) return;
    const client = state.client;
    if (!client || !client.ws || client.ws.readyState !== 1) return;
    const targetUtteranceId = Math.max(
      0,
      Number(
        utteranceId !== null && utteranceId !== undefined
          ? utteranceId
          : state.utterance?.id || 0
      )
    );
    if (!targetUtteranceId) return;
    const committingUtteranceId = Math.max(0, Number(state.committingUtteranceId || 0));
    if (
      state.isCommittingAsr &&
      committingUtteranceId > 0 &&
      targetUtteranceId !== committingUtteranceId
    ) {
      return;
    }
    const chunks = Array.isArray(state.pendingAudioChunks) ? state.pendingAudioChunks : [];
    if (!chunks.length) return;

    const remainingChunks = [];
    while (chunks.length > 0) {
      const entry = chunks.shift();
      if (!entry || !Buffer.isBuffer(entry.chunk)) continue;
      if (Number(entry.utteranceId || 0) !== targetUtteranceId) {
        remainingChunks.push(entry);
        continue;
      }
      try {
        client.appendInputAudioPcm(entry.chunk);
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: state.userId || null,
          content: `openai_realtime_asr_audio_append_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        remainingChunks.push(entry);
        while (chunks.length > 0) {
          const pendingEntry = chunks.shift();
          if (!pendingEntry || !Buffer.isBuffer(pendingEntry.chunk)) continue;
          remainingChunks.push(pendingEntry);
        }
        break;
      }
    }
    state.pendingAudioChunks = remainingChunks;
    state.pendingAudioBytes = state.pendingAudioChunks.reduce(
      (total, pendingChunk) => total + Number(pendingChunk?.chunk?.length || 0),
      0
    );
  }

  beginOpenAiSharedAsrUtterance({
    session,
    settings = null,
    userId
  }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    const asrState = this.getOpenAiSharedAsrState(session);
    const normalizedUserId = String(userId || "").trim();
    if (!asrState || !normalizedUserId) return false;
    if (asrState.closing) return false;
    if (asrState.userId && asrState.userId !== normalizedUserId) return false;

    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }
    asrState.userId = normalizedUserId;
    asrState.utterance = {
      id: Math.max(0, Number(asrState.utterance?.id || 0)) + 1,
      startedAt: Date.now(),
      bytesSent: 0,
      partialText: "",
      finalSegments: [],
      finalSegmentEntries: [],
      lastUpdateAt: 0
    };
    asrState.lastPartialText = "";
    asrState.lastPartialLogAt = 0;
    // Do NOT clear the OpenAI buffer here — a concurrent commit may have
    // already flushed audio that hasn't been committed yet.  The buffer is
    // implicitly reset after each successful commit, and clearing here risks
    // wiping in-flight audio in rapid speech-restart scenarios.

    void this.ensureOpenAiSharedAsrSessionConnected({
      session,
      settings
    });
    return true;
  }

  appendAudioToOpenAiSharedAsr({
    session,
    settings = null,
    userId,
    pcmChunk
  }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    const asrState = this.getOpenAiSharedAsrState(session);
    const normalizedUserId = String(userId || "").trim();
    if (!asrState || asrState.closing || !normalizedUserId) return false;
    if (!asrState.userId) {
      asrState.userId = normalizedUserId;
    } else if (asrState.userId !== normalizedUserId) {
      return false;
    }
    const chunk = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk || []);
    if (!chunk.length) return false;
    asrState.lastAudioAt = Date.now();
    asrState.utterance.bytesSent = Math.max(0, Number(asrState.utterance?.bytesSent || 0)) + chunk.length;
    const utteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
    if (!utteranceId) return false;
    const queuedChunk = {
      utteranceId,
      chunk
    };

    const queue = Array.isArray(asrState.pendingAudioChunks) ? asrState.pendingAudioChunks : [];
    asrState.pendingAudioChunks = queue;
    queue.push(queuedChunk);
    asrState.pendingAudioBytes = Math.max(0, Number(asrState.pendingAudioBytes || 0)) + chunk.length;
    const maxBufferedBytes = 24_000 * 2 * 10;
    if (asrState.pendingAudioBytes > maxBufferedBytes && queue.length > 1) {
      while (queue.length > 1 && asrState.pendingAudioBytes > maxBufferedBytes) {
        const dropped = queue.shift();
        asrState.pendingAudioBytes = Math.max(
          0,
          asrState.pendingAudioBytes - Number(dropped?.chunk?.length || 0)
        );
      }
    }

    void this.ensureOpenAiSharedAsrSessionConnected({
      session,
      settings
    }).then((state) => {
      if (!state) return;
      void this.flushPendingOpenAiSharedAsrAudio({
        session,
        asrState: state,
        utteranceId
      });
    });
    return true;
  }

  async commitOpenAiSharedAsrUtterance({
    session,
    settings = null,
    userId,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseSharedTranscription({ session, settings })) return null;
    const asrState = await this.ensureOpenAiSharedAsrSessionConnected({
      session,
      settings
    });
    const normalizedUserId = String(userId || "").trim();
    if (!asrState || asrState.closing || !normalizedUserId) return null;
    if (asrState.userId && asrState.userId !== normalizedUserId) {
      return null;
    }
    asrState.userId = normalizedUserId;
    const trackedUtterance = asrState.utterance && typeof asrState.utterance === "object"
      ? asrState.utterance
      : null;
    const trackedUtteranceId = Math.max(0, Number(trackedUtterance?.id || 0));
    if (!trackedUtteranceId) return null;
    const transcriptionModelPrimary = normalizeOpenAiRealtimeTranscriptionModel(
      session.openAiPerUserAsrModel,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const utteranceBytesSent = Math.max(0, Number(trackedUtterance?.bytesSent || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (utteranceBytesSent < minCommitBytes) {
      if (utteranceBytesSent > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "openai_realtime_asr_commit_skipped_small_buffer",
          metadata: {
            sessionId: session.id,
            utteranceBytesSent,
            minCommitBytes,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }
      if (asrState.userId === normalizedUserId) {
        asrState.userId = null;
      }
      if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
        this.scheduleOpenAiSharedAsrSessionIdleClose(session);
      }
      return {
        transcript: "",
        asrStartedAtMs: 0,
        asrCompletedAtMs: 0,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_shared_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    }

    asrState.isCommittingAsr = true;
    asrState.committingUtteranceId = trackedUtteranceId;
    await this.flushPendingOpenAiSharedAsrAudio({
      session,
      asrState,
      utteranceId: trackedUtteranceId
    });

    const asrStartedAtMs = Date.now();
    try {
      const pendingCommitRequests = this.pruneOpenAiSharedAsrPendingCommitRequests(asrState);
      const commitRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      pendingCommitRequests.push({
        id: commitRequestId,
        userId: normalizedUserId,
        requestedAt: Date.now()
      });
      asrState.client?.commitInputAudioBuffer?.();
      const committedItemId = await this.waitForOpenAiSharedAsrCommittedItem({
        session,
        asrState,
        userId: normalizedUserId,
        commitRequestId
      });
      const transcript = await this.waitForOpenAiSharedAsrTranscriptByItem({
        session,
        asrState,
        itemId: committedItemId
      });
      const asrCompletedAtMs = Date.now();

      if (asrState.utterance === trackedUtterance) {
        trackedUtterance.bytesSent = 0;
      }
      if (asrState.userId === normalizedUserId) {
        asrState.userId = null;
      }
      if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
        this.scheduleOpenAiSharedAsrSessionIdleClose(session);
      }

      // If the committed buffer was empty (race with new utterance clearing
      // it, or server-side discard), fall back to the streaming transcript
      // that the tracked utterance accumulated via realtime deltas.
      let resolvedTranscript = transcript;
      if (!resolvedTranscript && trackedUtterance) {
        const streamingFinal = normalizeVoiceText(
          Array.isArray(trackedUtterance.finalSegments)
            ? trackedUtterance.finalSegments.join(" ")
            : "",
          STT_TRANSCRIPT_MAX_CHARS
        );
        const streamingPartial = normalizeVoiceText(
          trackedUtterance.partialText || "",
          STT_TRANSCRIPT_MAX_CHARS
        );
        resolvedTranscript = streamingFinal || streamingPartial;
        if (resolvedTranscript) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: "openai_realtime_asr_streaming_fallback_used",
            metadata: {
              sessionId: session.id,
              transcriptChars: resolvedTranscript.length,
              source: streamingFinal ? "final_segments" : "partial_text",
              captureReason: String(captureReason || "stream_end")
            }
          });
        }
      }

      if (!resolvedTranscript) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript: resolvedTranscript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_shared_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `openai_realtime_asr_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return null;
    } finally {
      asrState.isCommittingAsr = false;
      asrState.committingUtteranceId = 0;
      const activeUtteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
      if (activeUtteranceId > 0) {
        void this.flushPendingOpenAiSharedAsrAudio({
          session,
          asrState,
          utteranceId: activeUtteranceId
        });
      }
    }
  }

  scheduleOpenAiSharedAsrSessionIdleClose(session) {
    if (!session || session.ending) return;
    const asrState = this.getOpenAiSharedAsrState(session);
    if (!asrState) return;
    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }
    const ttlMs = Math.max(
      1_000,
      Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
    );
    asrState.idleTimer = setTimeout(() => {
      asrState.idleTimer = null;
      this.closeOpenAiSharedAsrSession(session, "idle_ttl").catch(() => undefined);
    }, ttlMs);
  }

  releaseOpenAiSharedAsrActiveUser(session, userId = null) {
    if (!session || session.ending) return;
    const asrState = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
      ? session.openAiSharedAsrState
      : null;
    if (!asrState) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId || String(asrState.userId || "").trim() === normalizedUserId) {
      asrState.userId = null;
    }
  }

  tryHandoffSharedAsrToWaitingCapture({ session, settings = null }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseSharedTranscription({ session, settings })) return false;
    const asrState = this.getOpenAiSharedAsrState(session);
    if (!asrState || asrState.closing) return false;
    if (asrState.userId) return false;

    for (const [candidateUserId, captureState] of session.userCaptures) {
      if (!captureState || !candidateUserId) continue;
      if (Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) > 0) continue;
      if (Math.max(0, Number(captureState.bytesSent || 0)) <= 0) continue;

      const began = this.beginOpenAiSharedAsrUtterance({
        session,
        settings,
        userId: candidateUserId
      });
      if (!began) continue;

      const chunks = Array.isArray(captureState.pcmChunks) ? captureState.pcmChunks : [];
      if (chunks.length <= 0) {
        this.releaseOpenAiSharedAsrActiveUser(session, candidateUserId);
        continue;
      }
      let replayedChunks = 0;
      let replayedBytes = 0;
      for (const chunk of chunks) {
        if (!chunk || !chunk.length) continue;
        const appended = this.appendAudioToOpenAiSharedAsr({
          session,
          settings,
          userId: candidateUserId,
          pcmChunk: chunk
        });
        if (appended) {
          replayedChunks += 1;
          replayedBytes += chunk.length;
          captureState.sharedAsrBytesSent =
            Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) + chunk.length;
        }
      }
      if (replayedChunks <= 0 || replayedBytes <= 0) {
        this.releaseOpenAiSharedAsrActiveUser(session, candidateUserId);
        continue;
      }

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: candidateUserId,
        content: "openai_shared_asr_handoff",
        metadata: {
          sessionId: session.id,
          replayedChunks,
          replayedBytes
        }
      });
      return true;
    }
    return false;
  }

  async closeOpenAiSharedAsrSession(session, reason = "manual") {
    if (!session) return;
    const state = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
      ? session.openAiSharedAsrState
      : null;
    if (!state) return;
    state.closing = true;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const pendingResolvers = Array.isArray(state.pendingCommitResolvers) ? state.pendingCommitResolvers : [];
    while (pendingResolvers.length > 0) {
      const entry = pendingResolvers.shift();
      if (entry && typeof entry.resolve === "function") {
        entry.resolve("");
      }
    }
    session.openAiSharedAsrState = null;

    try {
      await state.client?.close?.();
    } catch {
      // ignore
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: String(state.userId || "").trim() || null,
      content: "openai_realtime_asr_session_closed",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "manual")
      }
    });
  }

  bindSessionHandlers(session, settings) {
    const useOpenAiPerUserAsr = this.shouldUsePerUserTranscription({
      session,
      settings
    });
    const useOpenAiSharedAsr = this.shouldUseSharedTranscription({
      session,
      settings
    });

    // Connection state from subprocess
    const onConnectionState = (status) => {
      if (session.ending) return;
      if (status === "destroyed" || status === "disconnected") {
        this.endSession({
          guildId: session.guildId,
          reason: "connection_lost",
          announcement: "voice connection dropped, i'm out.",
          settings
        }).catch(() => undefined);
      }
    };

    // Subprocess crash handler
    const onCrashed = ({ code, signal }) => {
      if (session.ending) return;
      console.error(
        `[voiceSessionManager] subprocess crashed code=${code} signal=${signal} guild=${session.guildId}`
      );
      this.endSession({
        guildId: session.guildId,
        reason: "subprocess_crashed",
        announcement: "voice subprocess crashed, i'm out.",
        settings
      }).catch(() => undefined);
    };

    if (session.subprocessClient) {
      session.subprocessClient.on("connectionState", onConnectionState);
      session.subprocessClient.on("crashed", onCrashed);
      session.cleanupHandlers.push(() => {
        session.subprocessClient?.off("connectionState", onConnectionState);
        session.subprocessClient?.off("crashed", onCrashed);
      });
    }

    // Speaking events from subprocess (forwarded from voice receiver)
    const onSpeakingStart = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      if (this.isInboundCaptureSuppressed(session)) {
        const now = Date.now();
        if (now - Number(session.lastSuppressedCaptureLogAt || 0) >= VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS) {
          session.lastSuppressedCaptureLogAt = now;
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: String(userId || "").trim() || null,
            content: "voice_input_suppressed",
            metadata: {
              sessionId: session.id,
              mode: session.mode,
              reason: "voice_web_lookup_busy"
            }
          });
        }
        return;
      }
      if (!this.isAsrActive(session, settings)) return;
      const normalizedUserId = String(userId || "");
      const activeCapture = session.userCaptures.get(normalizedUserId);
      if (activeCapture?.speakingEndFinalizeTimer) {
        clearTimeout(activeCapture.speakingEndFinalizeTimer);
        activeCapture.speakingEndFinalizeTimer = null;
      }
      if (useOpenAiPerUserAsr && !activeCapture) {
        this.beginOpenAiAsrUtterance({
          session,
          settings,
          userId: normalizedUserId
        });
      }
      if (useOpenAiSharedAsr && !activeCapture) {
        this.beginOpenAiSharedAsrUtterance({
          session,
          settings,
          userId: normalizedUserId
        });
      }
      this.startInboundCapture({
        session,
        userId: normalizedUserId,
        settings
      });
      this.armAssertiveBargeIn({
        session,
        userId: normalizedUserId,
        source: "speaking_start"
      });
    };

    const onSpeakingEnd = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      const capture = session.userCaptures.get(String(userId || ""));
      if (!capture || typeof capture.finalize !== "function") return;
      if (capture.bargeInAssertTimer) {
        clearTimeout(capture.bargeInAssertTimer);
        capture.bargeInAssertTimer = null;
      }
      if (capture.speakingEndFinalizeTimer) return;
      const captureAgeMs = Math.max(0, Date.now() - Number(capture.startedAt || Date.now()));
      const finalizeDelayMs = this.resolveSpeakingEndFinalizeDelayMs({
        session,
        captureAgeMs
      });
      capture.speakingEndFinalizeTimer = setTimeout(() => {
        capture.speakingEndFinalizeTimer = null;
        capture.finalize("speaking_end");
      }, finalizeDelayMs);
    };

    const onClientDisconnect = (disconnectUserId) => {
      const normalizedUserId = String(disconnectUserId || "").trim();
      if (!normalizedUserId) return;
      if (normalizedUserId === String(this.client.user?.id || "")) return;
      const capture = session.userCaptures?.get?.(normalizedUserId);
      if (!capture) return;
      // Immediately finalize — the user has left the channel, no point waiting
      if (capture.speakingEndFinalizeTimer) {
        clearTimeout(capture.speakingEndFinalizeTimer);
        capture.speakingEndFinalizeTimer = null;
      }
      if (capture.bargeInAssertTimer) {
        clearTimeout(capture.bargeInAssertTimer);
        capture.bargeInAssertTimer = null;
      }
      if (typeof capture.finalize === "function") {
        capture.finalize("client_disconnect");
      }
    };

    if (session.subprocessClient) {
      session.subprocessClient.on("speakingStart", onSpeakingStart);
      session.subprocessClient.on("speakingEnd", onSpeakingEnd);
      session.subprocessClient.on("clientDisconnect", onClientDisconnect);
      session.cleanupHandlers.push(() => {
        session.subprocessClient?.off("speakingStart", onSpeakingStart);
        session.subprocessClient?.off("speakingEnd", onSpeakingEnd);
        session.subprocessClient?.off("clientDisconnect", onClientDisconnect);
      });
    }
  }

  startInboundCapture({ session, userId, settings = session?.settingsSnapshot }) {
    if (!session || !userId) return;
    if (session.userCaptures.has(userId)) return;
    const useOpenAiPerUserAsr = this.shouldUsePerUserTranscription({
      session,
      settings
    });
    const useOpenAiSharedAsr = this.shouldUseSharedTranscription({
      session,
      settings
    });

    // Subprocess auto-subscribes on speaking_start; this call updates
    // the default silence duration for future auto-subscriptions.
    const sampleRate = isRealtimeMode(session.mode) ? Number(session.realtimeInputSampleRateHz) || 24000 : 24000;
    session.subprocessClient?.subscribeUser(userId, INPUT_SPEECH_END_SILENCE_MS, sampleRate);

    const captureState = {
      userId,
      startedAt: Date.now(),
      bytesSent: 0,
      signalSampleCount: 0,
      signalActiveSampleCount: 0,
      signalPeakAbs: 0,
      pcmChunks: [],
      sharedAsrBytesSent: 0,
      lastActivityTouchAt: 0,
      idleFlushTimer: null,
      maxFlushTimer: null,
      speakingEndFinalizeTimer: null,
      bargeInAssertTimer: null,
      finalize: null,
      abort: null,
      removeSubprocessListeners: null
    };

    session.userCaptures.set(userId, captureState);

    this.store.logAction({
      kind: "voice_turn_in",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_activity_started",
      metadata: {
        sessionId: session.id
      }
    });

    const cleanupCapture = () => {
      const current = session.userCaptures.get(userId);
      if (!current) return;
      session.userCaptures.delete(userId);

      if (current.idleFlushTimer) {
        clearTimeout(current.idleFlushTimer);
      }
      if (current.maxFlushTimer) {
        clearTimeout(current.maxFlushTimer);
      }
      if (current.speakingEndFinalizeTimer) {
        clearTimeout(current.speakingEndFinalizeTimer);
      }
      if (current.bargeInAssertTimer) {
        clearTimeout(current.bargeInAssertTimer);
      }

      // Remove per-capture IPC listeners so they don't accumulate across captures
      try {
        current.removeSubprocessListeners?.();
      } catch {
        // ignore
      }

      // Do NOT unsubscribe from the subprocess here.  The subprocess manages
      // its own subscription lifecycle via AfterSilence — when the user stops
      // speaking, the opus stream ends naturally and the subscription is removed.
      //
      // Sending unsubscribe_user from the main process created a race condition:
      // if the user starts speaking again between AfterSilence cleanup and the
      // arrival of our unsubscribe IPC, the auto-subscribe creates a fresh
      // subscription that our stale unsubscribe then destroys — leaving no
      // active subscription for the new speech.
    };

    // Called after a capture resolves with no usable speech (empty, silence-
    // gated, or suppressed). If this was the last capture and a join greeting
    // is still pending, fire it now.
    const maybeTriggerJoinGreeting = () => {
      if (this.getDeferredVoiceAction(session, "join_greeting") && session.userCaptures.size === 0) {
        this.fireJoinGreeting(session, "capture_resolved");
      }
    };

    const scheduleIdleFlush = () => {
      if (captureState.idleFlushTimer) {
        clearTimeout(captureState.idleFlushTimer);
      }
      captureState.idleFlushTimer = setTimeout(() => {
        finalizeUserTurn("idle_timeout");
      }, CAPTURE_IDLE_FLUSH_MS);
    };

    // Subprocess userAudio handler — receives already-converted mono PCM
    const onUserAudio = (audioUserId, pcmBase64) => {
      if (String(audioUserId || "") !== userId) return;
      const now = Date.now();
      let normalizedPcm: Buffer;
      try {
        if (Buffer.isBuffer(pcmBase64)) {
          normalizedPcm = pcmBase64;
        } else {
          normalizedPcm = Buffer.from(String(pcmBase64 || ""), "base64");
        }
      } catch (e) {
        this.store.logAction({
          kind: "voice_warn",
          guildId: session.guildId,
          channelId: session.textChannelId,
          content: "invalid_pcm_base64_from_subprocess",
          metadata: { userId, error: e.message }
        });
        return;
      }
      if (!normalizedPcm.length) return;
      captureState.bytesSent += normalizedPcm.length;
      const sampleCount = Math.floor(normalizedPcm.length / 2);
      if (sampleCount > 0) {
        let peakAbs = Math.max(0, Number(captureState.signalPeakAbs || 0));
        let activeSamples = 0;
        for (let offset = 0; offset + 1 < normalizedPcm.length; offset += 2) {
          const sample = normalizedPcm.readInt16LE(offset);
          const absSample = Math.abs(sample);
          if (absSample > peakAbs) peakAbs = absSample;
          if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
            activeSamples += 1;
          }
        }
        captureState.signalSampleCount = Math.max(0, Number(captureState.signalSampleCount || 0)) + sampleCount;
        captureState.signalActiveSampleCount =
          Math.max(0, Number(captureState.signalActiveSampleCount || 0)) + activeSamples;
        captureState.signalPeakAbs = peakAbs;
      }
      captureState.pcmChunks.push(normalizedPcm);
      if (useOpenAiPerUserAsr) {
        this.appendAudioToOpenAiAsr({
          session,
          settings,
          userId,
          pcmChunk: normalizedPcm
        });
      } else if (useOpenAiSharedAsr) {
        const appendedToSharedAsr = this.appendAudioToOpenAiSharedAsr({
          session,
          settings,
          userId,
          pcmChunk: normalizedPcm
        });
        if (appendedToSharedAsr) {
          captureState.sharedAsrBytesSent =
            Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) + normalizedPcm.length;
        }
      }
      if (captureState.speakingEndFinalizeTimer) {
        clearTimeout(captureState.speakingEndFinalizeTimer);
        captureState.speakingEndFinalizeTimer = null;
      }
      scheduleIdleFlush();

      session.lastInboundAudioAt = now;
      if (
        this.isCaptureEligibleForActivityTouch({ session, capture: captureState }) &&
        now - captureState.lastActivityTouchAt >= ACTIVITY_TOUCH_THROTTLE_MS
      ) {
        this.touchActivity(session.guildId, settings);
        captureState.lastActivityTouchAt = now;
      }

      if (isRealtimeMode(session.mode) && this.isBargeInInterruptTargetActive(session)) {
        const interruptionPolicy = this.normalizeReplyInterruptionPolicy(
          session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
        );
        const canInterrupt = this.isUserAllowedToInterruptReply({
          policy: interruptionPolicy,
          userId
        });
        if (canInterrupt && this.isCaptureSignalAssertive(captureState)) {
          const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
          const minCaptureBytes = Math.max(
            2,
            Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000)
          );
          if (Number(captureState.bytesSent || 0) >= minCaptureBytes) {
            this.interruptBotSpeechForBargeIn({
              session,
              userId,
              source: "speaking_data",
              minCaptureBytes
            });
          }
        }
      }

      const captureAgeMs = Math.max(0, now - Number(captureState.startedAt || now));
      const signalSampleCount = Math.max(0, Number(captureState.signalSampleCount || 0));
      if (captureAgeMs >= CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS && signalSampleCount > 0) {
        const activeSampleCount = Math.max(0, Number(captureState.signalActiveSampleCount || 0));
        const activeSampleRatio = activeSampleCount / signalSampleCount;
        const peak = Math.max(0, Number(captureState.signalPeakAbs || 0)) / 32768;
        if (
          activeSampleRatio <= CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX &&
          peak <= CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX
        ) {
          finalizeUserTurn("near_silence_early_abort");
          return;
        }
      }

    };

    let captureFinalized = false;
    const finalizeUserTurn = (reason = "stream_end") => {
      if (captureFinalized) return;
      captureFinalized = true;
      const finalizedAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_finalized",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "stream_end"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, finalizedAt - captureState.startedAt)
        }
      });

      if (captureState.bytesSent <= 0 || session.ending) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_skipped_empty_capture",
          metadata: {
            sessionId: session.id,
            reason: String(reason || "stream_end"),
            bytesSent: Number(captureState.bytesSent || 0),
            ending: Boolean(session.ending)
          }
        });
        cleanupCapture();
        maybeTriggerJoinGreeting();
        if (useOpenAiPerUserAsr) {
          this.scheduleOpenAiAsrSessionIdleClose({
            session,
            userId
          });
        } else if (useOpenAiSharedAsr) {
          this.releaseOpenAiSharedAsrActiveUser(session, userId);
          if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
            this.scheduleOpenAiSharedAsrSessionIdleClose(session);
          }
        }
        return;
      }

      const pcmBuffer = Buffer.concat(captureState.pcmChunks);

      // Silence gate: drop near-silent captures that slipped past the
      // in-flight near-silence abort (e.g., very short VAD false positives
      // or receiver buffer burst artifacts).
      const captureDurationMs = Math.max(0, finalizedAt - captureState.startedAt);
      const sampleRateHz = isRealtimeMode(session.mode)
        ? Number(session.realtimeInputSampleRateHz) || 24000
        : 24000;
      const silenceGate = this.evaluatePcmSilenceGate({ pcmBuffer, sampleRateHz });
      const audioDurationMs = silenceGate.clipDurationMs;
      // A capture whose wall-clock time is <25% of its audio duration
      // means opus packets were delivered in a burst from the receiver
      // buffer — not from live speech.
      const isBurstArtifact = audioDurationMs > 200 && captureDurationMs < audioDurationMs * 0.25;

      if (silenceGate.drop) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_dropped_silence_gate",
          metadata: {
            sessionId: session.id,
            reason: String(reason || "stream_end"),
            bytesSent: captureState.bytesSent,
            captureDurationMs,
            audioDurationMs,
            rms: silenceGate.rms,
            peak: silenceGate.peak,
            activeSampleRatio: silenceGate.activeSampleRatio,
            isBurstArtifact,
            silenceGateDrop: silenceGate.drop
          }
        });
        cleanupCapture();
        maybeTriggerJoinGreeting();
        if (useOpenAiPerUserAsr) {
          this.scheduleOpenAiAsrSessionIdleClose({ session, userId });
        } else if (useOpenAiSharedAsr) {
          this.releaseOpenAiSharedAsrActiveUser(session, userId);
          this.scheduleOpenAiSharedAsrSessionIdleClose(session);
        }
        return;
      }

      if (isBurstArtifact) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_burst_artifact_processed",
          metadata: {
            sessionId: session.id,
            reason: String(reason || "stream_end"),
            bytesSent: captureState.bytesSent,
            captureDurationMs,
            audioDurationMs
          }
        });
      }

      cleanupCapture();
      if (session.mode === "stt_pipeline") {
        this.queueSttPipelineTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
      } else {
        const handledInterruptedReply = this.maybeHandleInterruptedReplyRecovery({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
        if (!handledInterruptedReply && useOpenAiPerUserAsr) {
          // During music, per-user ASR bridge fails (audio buffers cleared).
          // Route directly to processRealtimeTurn so maybeHandleMusicPlaybackTurn
          // can transcribe the PCM and detect wake words.
          if (musicPhaseIsActive(this.getMusicPhase(session))) {
            this.queueRealtimeTurn({
              session,
              userId,
              pcmBuffer,
              captureReason: reason,
              finalizedAt
            });
            return;
          }
          const asrBridgeMaxWaitMs = Math.max(120, Number(OPENAI_ASR_BRIDGE_MAX_WAIT_MS) || 700);
          let bridgeForwarded = false;
          const forwardAsrBridgeTurn = (asrResult, source) => {
            if (bridgeForwarded || session.ending) return false;
            const queued = this.queueRealtimeTurnFromAsrBridge({
              session,
              userId,
              pcmBuffer,
              captureReason: reason,
              finalizedAt,
              asrResult,
              source
            });
            if (queued) bridgeForwarded = true;
            return queued;
          };

          const fallbackTimer = setTimeout(() => {
            if (bridgeForwarded || session.ending) return;
            this.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: session.textChannelId,
              userId,
              content: "openai_realtime_asr_bridge_timeout_fallback",
              metadata: {
                sessionId: session.id,
                captureReason: String(reason || "stream_end"),
                source: "per_user",
                waitMs: asrBridgeMaxWaitMs
              }
            });
          }, asrBridgeMaxWaitMs);

          void (async () => {
            try {
              const asrResult = await this.commitOpenAiAsrUtterance({
                session,
                settings,
                userId,
                captureReason: reason
              });
              clearTimeout(fallbackTimer);
              const commitTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);

              // If commit returned a transcript, forward immediately.
              if (commitTranscript) {
                const forwarded = forwardAsrBridgeTurn(asrResult, "per_user");
                if (forwarded) return;
              }

              // Commit returned empty — poll the tracked utterance for
              // late-arriving streaming transcript segments before giving up.
              // Skip the initial forward to avoid logging a premature empty-drop
              // and triggering deferred actions before recovery has a chance.
              if (!bridgeForwarded && !session.ending) {
                const lateAsrState = this.getOrCreateOpenAiAsrSessionState({ session, userId });
                const trackedUtterance = lateAsrState?.utterance;
                if (trackedUtterance) {
                  const lateDeadlineMs = Date.now() + 1500;
                  while (Date.now() < lateDeadlineMs && !bridgeForwarded && !session.ending) {
                    await new Promise((r) => setTimeout(r, 80));
                    // Bail if the utterance was replaced by new speech — we'd
                    // be reading transcript from a different user turn.
                    if (lateAsrState.utterance !== trackedUtterance) break;
                    const lateFinal = normalizeVoiceText(
                      Array.isArray(trackedUtterance.finalSegments)
                        ? trackedUtterance.finalSegments.join(" ")
                        : "",
                      STT_TRANSCRIPT_MAX_CHARS
                    );
                    if (lateFinal) {
                      const lateForwarded = forwardAsrBridgeTurn(
                        { ...asrResult, transcript: lateFinal },
                        "per_user_late_streaming"
                      );
                      if (lateForwarded) {
                        this.store.logAction({
                          kind: "voice_runtime",
                          guildId: session.guildId,
                          channelId: session.textChannelId,
                          userId,
                          content: "openai_realtime_asr_bridge_late_streaming_recovered",
                          metadata: {
                            sessionId: session.id,
                            captureReason: String(reason || "stream_end"),
                            transcriptChars: lateFinal.length,
                            lateWaitMs: Date.now() - (lateDeadlineMs - 1500)
                          }
                        });
                      }
                      return;
                    }
                  }
                }
              }

              // Recovery failed — now record the empty drop.
              if (!bridgeForwarded) {
                forwardAsrBridgeTurn(asrResult, "per_user");
              }
              const lateTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
              if (!lateTranscript) return;
              this.store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId,
                content: "openai_realtime_asr_bridge_late_result_ignored",
                metadata: {
                  sessionId: session.id,
                  captureReason: String(reason || "stream_end"),
                  source: "per_user",
                  transcriptChars: lateTranscript.length
                }
              });
            } catch (error) {
              clearTimeout(fallbackTimer);
              this.store.logAction({
                kind: "voice_error",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId,
                content: `openai_realtime_asr_turn_failed: ${String(error?.message || error)}`,
                metadata: {
                  sessionId: session.id,
                  captureReason: String(reason || "stream_end")
                }
              });
              forwardAsrBridgeTurn(null, "per_user_error");
            }
          })();
          return;
        }
        if (!handledInterruptedReply && useOpenAiSharedAsr) {
          const hasSharedAsrAudio = Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) > 0;
          if (!hasSharedAsrAudio) {
            this.queueRealtimeTurn({
              session,
              userId,
              pcmBuffer,
              captureReason: reason,
              finalizedAt
            });
            return;
          }

          const asrBridgeMaxWaitMs = Math.max(120, Number(OPENAI_ASR_BRIDGE_MAX_WAIT_MS) || 700);
          let bridgeForwarded = false;
          const forwardAsrBridgeTurn = (asrResult, source) => {
            if (bridgeForwarded || session.ending) return false;
            const queued = this.queueRealtimeTurnFromAsrBridge({
              session,
              userId,
              pcmBuffer,
              captureReason: reason,
              finalizedAt,
              asrResult,
              source
            });
            if (queued) bridgeForwarded = true;
            return queued;
          };

          // Mark commit in-flight synchronously so a new utterance's
          // beginOpenAiSharedAsrUtterance won't clear the buffer before
          // the async commit runs.
          const sharedAsrState = this.getOpenAiSharedAsrState(session);
          if (sharedAsrState) {
            sharedAsrState.isCommittingAsr = true;
          }

          const fallbackTimer = setTimeout(() => {
            if (bridgeForwarded || session.ending) return;
            this.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: session.textChannelId,
              userId,
              content: "openai_realtime_asr_bridge_timeout_fallback",
              metadata: {
                sessionId: session.id,
                captureReason: String(reason || "stream_end"),
                source: "shared",
                waitMs: asrBridgeMaxWaitMs
              }
            });
          }, asrBridgeMaxWaitMs);

          void (async () => {
            try {
              const asrResult = await this.commitOpenAiSharedAsrUtterance({
                session,
                settings,
                userId,
                captureReason: reason
              });
              clearTimeout(fallbackTimer);
              const commitTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);

              // If commit returned a transcript, forward immediately.
              if (commitTranscript) {
                const forwarded = forwardAsrBridgeTurn(asrResult, "shared");
                if (forwarded) return;
              }

              // Commit returned empty — poll the shared ASR state for
              // late-arriving streaming transcript segments before giving up.
              // Skip the initial forward to avoid logging a premature empty-drop
              // and triggering deferred actions before recovery has a chance.
              if (!bridgeForwarded && !session.ending) {
                const lateSharedState = this.getOpenAiSharedAsrState(session);
                const trackedUtterance = lateSharedState?.utterance;
                if (trackedUtterance) {
                  const lateDeadlineMs = Date.now() + 1500;
                  while (Date.now() < lateDeadlineMs && !bridgeForwarded && !session.ending) {
                    await new Promise((r) => setTimeout(r, 80));
                    // Bail if the utterance was replaced by new speech.
                    if (lateSharedState.utterance !== trackedUtterance) break;
                    const lateFinal = normalizeVoiceText(
                      Array.isArray(trackedUtterance.finalSegments)
                        ? trackedUtterance.finalSegments.join(" ")
                        : "",
                      STT_TRANSCRIPT_MAX_CHARS
                    );
                    if (lateFinal) {
                      const lateForwarded = forwardAsrBridgeTurn(
                        { ...asrResult, transcript: lateFinal },
                        "shared_late_streaming"
                      );
                      if (lateForwarded) {
                        this.store.logAction({
                          kind: "voice_runtime",
                          guildId: session.guildId,
                          channelId: session.textChannelId,
                          userId,
                          content: "openai_realtime_asr_bridge_late_streaming_recovered",
                          metadata: {
                            sessionId: session.id,
                            captureReason: String(reason || "stream_end"),
                            source: "shared",
                            transcriptChars: lateFinal.length,
                            lateWaitMs: Date.now() - (lateDeadlineMs - 1500)
                          }
                        });
                      }
                      return;
                    }
                  }
                }
              }

              // Recovery failed — now record the empty drop.
              if (!bridgeForwarded) {
                forwardAsrBridgeTurn(asrResult, "shared");
              }
              const lateTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
              if (!lateTranscript) return;
              this.store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId,
                content: "openai_realtime_asr_bridge_late_result_ignored",
                metadata: {
                  sessionId: session.id,
                  captureReason: String(reason || "stream_end"),
                  source: "shared",
                  transcriptChars: lateTranscript.length
                }
              });
            } catch (error) {
              clearTimeout(fallbackTimer);
              this.store.logAction({
                kind: "voice_error",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId,
                content: `openai_realtime_asr_turn_failed: ${String(error?.message || error)}`,
                metadata: {
                  sessionId: session.id,
                  captureReason: String(reason || "stream_end")
                }
              });
              forwardAsrBridgeTurn(null, "shared_error");
            }
          })();
          return;
        }
        if (!handledInterruptedReply) {
          this.queueRealtimeTurn({
            session,
            userId,
            pcmBuffer,
            captureReason: reason,
            finalizedAt
          });
        }
      }
    };
    captureState.finalize = finalizeUserTurn;
    captureState.abort = (reason = "capture_suppressed") => {
      if (captureFinalized) return;
      captureFinalized = true;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "capture_suppressed"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, Date.now() - captureState.startedAt)
        }
      });
      cleanupCapture();
      maybeTriggerJoinGreeting();
      if (useOpenAiPerUserAsr) {
        this.scheduleOpenAiAsrSessionIdleClose({
          session,
          userId
        });
      } else if (useOpenAiSharedAsr) {
        this.releaseOpenAiSharedAsrActiveUser(session, userId);
        if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
          this.scheduleOpenAiSharedAsrSessionIdleClose(session);
        }
      }
    };
    captureState.maxFlushTimer = setTimeout(() => {
      finalizeUserTurn("max_duration");
    }, CAPTURE_MAX_DURATION_MS);

    // Listen for user audio and stream-end from subprocess
    const onUserAudioEnd = (audioUserId) => {
      if (String(audioUserId || "") !== userId) return;
      // Subprocess AfterSilence stream ended — finalize if not already done.
      if (!captureFinalized) {
        finalizeUserTurn("stream_end");
      }
    };

    // Removes the per-capture IPC listeners. Called both from cleanupCapture
    // (when the individual capture ends) and from session cleanup (as a safety net).
    let listenersRemoved = false;
    const removeListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      session.subprocessClient?.off("userAudio", onUserAudio);
      session.subprocessClient?.off("userAudioEnd", onUserAudioEnd);
    };
    captureState.removeSubprocessListeners = removeListeners;

    if (session.subprocessClient) {
      session.subprocessClient.on("userAudio", onUserAudio);
      session.subprocessClient.on("userAudioEnd", onUserAudioEnd);
      session.cleanupHandlers.push(removeListeners);
    }
  }

  maybeHandleInterruptedReplyRecovery({
    session,
    userId = null,
    pcmBuffer = null,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    return this.recheckDeferredVoiceActions({
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
      this.recheckDeferredVoiceActions({
        session,
        reason: "empty_asr_bridge_drop",
        preferredTypes: ["join_greeting"]
      });
      return false;
    }

    const clipDurationMs = this.estimatePcm16MonoDurationMs(
      normalizedPcmBuffer.length,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    this.queueRealtimeTurn({
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
      usedFallbackModelForTranscriptOverride: Boolean(asrResult?.usedFallbackModel)
    });
    return true;
  }

  mergeRealtimeQueuedTurn(existingTurn, incomingTurn) {
    if (!existingTurn) return incomingTurn || null;
    if (!incomingTurn) return existingTurn;

    const existingBuffer = Buffer.isBuffer(existingTurn.pcmBuffer) ? existingTurn.pcmBuffer : Buffer.alloc(0);
    const incomingBuffer = Buffer.isBuffer(incomingTurn.pcmBuffer) ? incomingTurn.pcmBuffer : Buffer.alloc(0);
    const existingTranscript = normalizeVoiceText(existingTurn.transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
    const incomingTranscript = normalizeVoiceText(incomingTurn.transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
    const mergedTranscript = normalizeVoiceText(
      [existingTranscript, incomingTranscript].filter(Boolean).join(" "),
      STT_TRANSCRIPT_MAX_CHARS
    );

    if (!incomingBuffer.length && !incomingTranscript) return existingTurn;

    let combinedBytes = existingBuffer.length + incomingBuffer.length;
    let droppedHeadBytes = 0;
    let mergedBuffer = existingBuffer;
    if (incomingBuffer.length > 0) {
      const maxMergeBytes = Math.max(1, Number(REALTIME_TURN_PENDING_MERGE_MAX_BYTES) || combinedBytes);
      droppedHeadBytes = Math.max(0, combinedBytes - maxMergeBytes);
      if (droppedHeadBytes > 0) {
        const mergedWindow = Buffer.concat([existingBuffer, incomingBuffer], combinedBytes).subarray(droppedHeadBytes);
        mergedBuffer = Buffer.from(mergedWindow);
      } else {
        mergedBuffer = Buffer.concat([existingBuffer, incomingBuffer], combinedBytes);
      }
    } else {
      combinedBytes = existingBuffer.length;
      mergedBuffer = existingBuffer;
    }

    const existingFinalizedAt = Math.max(0, Number(existingTurn.finalizedAt || 0));
    const incomingFinalizedAt = Math.max(0, Number(incomingTurn.finalizedAt || 0));
    const mergedFinalizedAt =
      existingFinalizedAt > 0 && incomingFinalizedAt > 0
        ? Math.min(existingFinalizedAt, incomingFinalizedAt)
        : Math.max(existingFinalizedAt, incomingFinalizedAt);

    return {
      ...existingTurn,
      ...incomingTurn,
      pcmBuffer: mergedBuffer,
      transcriptOverride: mergedTranscript || null,
      queuedAt: Number(incomingTurn.queuedAt || Date.now()),
      finalizedAt: mergedFinalizedAt || 0,
      mergedTurnCount: Math.max(1, Number(existingTurn.mergedTurnCount || 1)) + 1,
      droppedHeadBytes
    };
  }

  queueRealtimeTurn({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    finalizedAt = 0,
    transcriptOverride = "",
    clipDurationMsOverride = Number.NaN,
    asrStartedAtMsOverride = 0,
    asrCompletedAtMsOverride = 0,
    transcriptionModelPrimaryOverride = "",
    transcriptionModelFallbackOverride = null,
    transcriptionPlanReasonOverride = "",
    usedFallbackModelForTranscriptOverride = false
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const normalizedTranscriptOverride = normalizeVoiceText(transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedPcmBuffer.length && !normalizedTranscriptOverride) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }
    const queuedAt = Date.now();
    const normalizedFinalizedAt = Math.max(0, Number(finalizedAt || 0)) || queuedAt;

    const queuedTurn = {
      session,
      userId,
      pcmBuffer: normalizedPcmBuffer.length ? normalizedPcmBuffer : Buffer.alloc(0),
      captureReason,
      queuedAt,
      finalizedAt: normalizedFinalizedAt,
      transcriptOverride: normalizedTranscriptOverride || null,
      clipDurationMsOverride: Number.isFinite(Number(clipDurationMsOverride))
        ? Math.max(0, Math.round(Number(clipDurationMsOverride)))
        : null,
      asrStartedAtMsOverride: Math.max(0, Number(asrStartedAtMsOverride || 0)),
      asrCompletedAtMsOverride: Math.max(0, Number(asrCompletedAtMsOverride || 0)),
      transcriptionModelPrimaryOverride: String(transcriptionModelPrimaryOverride || "").trim() || null,
      transcriptionModelFallbackOverride:
        String(transcriptionModelFallbackOverride || "").trim() || null,
      transcriptionPlanReasonOverride: String(transcriptionPlanReasonOverride || "").trim() || null,
      usedFallbackModelForTranscriptOverride: Boolean(usedFallbackModelForTranscriptOverride),
      mergedTurnCount: 1,
      droppedHeadBytes: 0
    };

    if (session.realtimeTurnDrainActive) {
      const firstPending = pendingQueue.shift() || null;
      let mergedPending = firstPending || queuedTurn;
      while (pendingQueue.length > 0) {
        const nextPending = pendingQueue.shift();
        if (!nextPending) continue;
        mergedPending = this.mergeRealtimeQueuedTurn(mergedPending, nextPending);
      }
      if (firstPending) {
        mergedPending = this.mergeRealtimeQueuedTurn(mergedPending, queuedTurn);
      }
      if (!mergedPending) return;
      pendingQueue.push(mergedPending);
      if (Number(mergedPending.mergedTurnCount || 1) > 1 || Number(mergedPending.droppedHeadBytes || 0) > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: mergedPending.pcmBuffer.length,
            mergedTurnCount: Number(mergedPending.mergedTurnCount || 1),
            droppedHeadBytes: Number(mergedPending.droppedHeadBytes || 0),
            queueDepth: pendingQueue.length,
            maxQueueDepth: REALTIME_TURN_QUEUE_MAX
          }
        });
      }
      return;
    }

    if (pendingQueue.length > 0) {
      // A coalesce timer may be running — cancel it since we are merging and
      // draining now (a new turn arrived within the window).
      if (session.realtimeTurnCoalesceTimer) {
        clearTimeout(session.realtimeTurnCoalesceTimer);
        session.realtimeTurnCoalesceTimer = null;
      }
      let nextTurn = pendingQueue.shift() || queuedTurn;
      while (pendingQueue.length > 0) {
        const pendingTurn = pendingQueue.shift();
        if (!pendingTurn) continue;
        nextTurn = this.mergeRealtimeQueuedTurn(nextTurn, pendingTurn);
      }
      nextTurn = this.mergeRealtimeQueuedTurn(nextTurn, queuedTurn);
      if (!nextTurn) return;
      this.drainRealtimeTurnQueue(nextTurn).catch(() => undefined);
      return;
    }

    // --- Realtime turn coalesce window ---
    // Hold the turn briefly before dispatching so a mid-sentence pause
    // ("Play a Future song… like the rapper") can be merged into one turn
    // instead of producing two separate responses.
    // Skip the window when the PCM is already large enough to suggest a
    // complete utterance, or when there is no user capture that might
    // produce a follow-up segment soon.
    const pcmBytes = queuedTurn.pcmBuffer?.length || 0;
    const skipCoalesce =
      pcmBytes >= REALTIME_TURN_COALESCE_MAX_BYTES ||
      session.ending;

    if (!skipCoalesce && REALTIME_TURN_COALESCE_WINDOW_MS > 0) {
      pendingQueue.push(queuedTurn);
      session.realtimeTurnCoalesceTimer = setTimeout(() => {
        session.realtimeTurnCoalesceTimer = null;
        if (session.ending) return;
        let turn = pendingQueue.shift() || null;
        while (pendingQueue.length > 0) {
          const next = pendingQueue.shift();
          if (!next) continue;
          turn = turn ? this.mergeRealtimeQueuedTurn(turn, next) : next;
        }
        if (turn) {
          this.drainRealtimeTurnQueue(turn).catch(() => undefined);
        }
      }, REALTIME_TURN_COALESCE_WINDOW_MS);
      return;
    }

    this.drainRealtimeTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainRealtimeTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.realtimeTurnDrainActive) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }

    session.realtimeTurnDrainActive = true;
    let turn = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runRealtimeTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `realtime_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const next = pendingQueue.shift();
        turn = next || null;
      }
    } finally {
      session.realtimeTurnDrainActive = false;
      if (session.ending) {
        session.pendingRealtimeTurns = [];
      } else {
        const pending = pendingQueue.shift();
        if (pending) {
          this.drainRealtimeTurnQueue(pending).catch(() => undefined);
        }
      }
    }
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

  shouldDropFallbackLowSignalTurn({
    transcript,
    usedFallbackModel = false,
    silenceGate,
    captureReason = "stream_end"
  }) {
    if (!usedFallbackModel) return false;
    if (String(captureReason || "stream_end") !== "speaking_end") return false;
    const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript || !isLowSignalVoiceFragment(normalizedTranscript)) return false;

    const clipDurationMs = Number(silenceGate?.clipDurationMs || 0);
    const rms = Number(silenceGate?.rms || 0);
    const peak = Number(silenceGate?.peak || 0);
    const activeSampleRatio = Number(silenceGate?.activeSampleRatio || 0);

    return (
      clipDurationMs > 0 &&
      clipDurationMs <= VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS &&
      rms <= VOICE_FALLBACK_NOISE_GATE_RMS_MAX &&
      peak <= VOICE_FALLBACK_NOISE_GATE_PEAK_MAX &&
      activeSampleRatio <= VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX
    );
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
    const replyPath = String(resolvedSettings?.voice?.replyPath || "").trim().toLowerCase();
    if (replyPath === "native") return "native";
    return "brain";
  }

  shouldUseNativeRealtimeReply({ session, settings = null }) {
    return this.resolveRealtimeReplyStrategy({ session, settings }) === "native";
  }

  async runRealtimeTurn({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    queuedAt = 0,
    finalizedAt = 0,
    transcriptOverride = "",
    clipDurationMsOverride = Number.NaN,
    asrStartedAtMsOverride = 0,
    asrCompletedAtMsOverride = 0,
    transcriptionModelPrimaryOverride = "",
    transcriptionModelFallbackOverride = null,
    transcriptionPlanReasonOverride = "",
    usedFallbackModelForTranscriptOverride = false
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const normalizedTranscriptOverride = normalizeVoiceText(transcriptOverride, STT_TRANSCRIPT_MAX_CHARS);
    const hasTranscriptOverride = Boolean(normalizedTranscriptOverride);
    if (!normalizedPcmBuffer?.length && !hasTranscriptOverride) return;
    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const finalizedAtMs = Math.max(0, Number(finalizedAt || 0)) || Math.max(0, Number(queuedAt || 0));
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0;
    if (
      pendingQueueDepth > 0 &&
      queueWaitMs >= REALTIME_TURN_STALE_SKIP_MS &&
      String(captureReason || "") !== "bot_turn_open_deferred_flush"
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: normalizedPcmBuffer.length
        }
      });
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const consumedByMusicMode = await this.maybeHandleMusicPlaybackTurn({
      session,
      settings,
      userId,
      pcmBuffer: normalizedPcmBuffer,
      captureReason,
      source: "realtime"
    });
    if (consumedByMusicMode) return;

    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const preferredModel =
      isRealtimeMode(session.mode)
        ? settings?.voice?.openaiRealtime?.inputTranscriptionModel
        : settings?.voice?.sttPipeline?.transcriptionModel;
    const transcriptionModel = String(preferredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const transcriptionPlan = hasTranscriptOverride
      ? {
        primaryModel:
          String(transcriptionModelPrimaryOverride || transcriptionModel).trim() || transcriptionModel,
        fallbackModel:
          String(transcriptionModelFallbackOverride || "").trim() || null,
        reason:
          String(transcriptionPlanReasonOverride || "openai_realtime_per_user_transcription").trim() ||
          "openai_realtime_per_user_transcription"
      }
      : resolveRealtimeTurnTranscriptionPlan({
        mode: session.mode,
        configuredModel: transcriptionModel,
        pcmByteLength: normalizedPcmBuffer.length,
        sampleRateHz
      });
    const silenceGate = hasTranscriptOverride
      ? {
        clipDurationMs: Number.isFinite(Number(clipDurationMsOverride))
          ? Math.max(0, Math.round(Number(clipDurationMsOverride)))
          : 0,
        sampleCount: 0,
        rms: 0,
        peak: 0,
        activeSampleRatio: 0,
        drop: false
      }
      : this.evaluatePcmSilenceGate({
        pcmBuffer: normalizedPcmBuffer,
        sampleRateHz
      });
    const clipDurationMs = silenceGate.clipDurationMs;
    if (!hasTranscriptOverride && silenceGate.drop) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_silence_gate",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: normalizedPcmBuffer.length,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          queueWaitMs,
          pendingQueueDepth
        }
      });
      return;
    }
    const minAsrClipBytes = Math.max(
      2,
      Math.ceil(((VOICE_TURN_MIN_ASR_CLIP_MS / 1000) * sampleRateHz * 2))
    );
    const isShortSpeakingEndClip =
      String(captureReason || "stream_end") === "speaking_end" &&
      normalizedPcmBuffer.length < minAsrClipBytes;
    const skipShortClipAsr = Boolean(!hasTranscriptOverride && isShortSpeakingEndClip);
    let turnTranscript = hasTranscriptOverride ? normalizedTranscriptOverride : "";
    let asrStartedAtMs = hasTranscriptOverride ? Math.max(0, Number(asrStartedAtMsOverride || 0)) : 0;
    let asrCompletedAtMs = hasTranscriptOverride ? Math.max(0, Number(asrCompletedAtMsOverride || 0)) : 0;
    let resolvedFallbackModel = transcriptionPlan.fallbackModel || null;
    let resolvedTranscriptionPlanReason = transcriptionPlan.reason;
    let usedFallbackModelForTranscript = hasTranscriptOverride
      ? Boolean(usedFallbackModelForTranscriptOverride)
      : false;
    if (skipShortClipAsr) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_transcription_skipped_short_clip",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: normalizedPcmBuffer.length,
          clipDurationMs,
          minAsrClipMs: VOICE_TURN_MIN_ASR_CLIP_MS,
          minAsrClipBytes
        }
      });
    } else if (!hasTranscriptOverride && this.llm?.isAsrReady?.() && this.llm?.transcribeAudio) {
      asrStartedAtMs = Date.now();
      turnTranscript = await this.transcribePcmTurn({
        session,
        userId,
        pcmBuffer: normalizedPcmBuffer,
        model: transcriptionPlan.primaryModel,
        sampleRateHz,
        captureReason,
        traceSource: "voice_realtime_turn_decider",
        errorPrefix: "voice_realtime_transcription_failed",
        emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
        emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
        asrLanguage: asrLanguageGuidance.language,
        asrPrompt: asrLanguageGuidance.prompt
      });

      if (
        !turnTranscript &&
        !resolvedFallbackModel &&
        session.mode === "voice_agent" &&
        transcriptionPlan.primaryModel === "gpt-4o-mini-transcribe"
      ) {
        resolvedFallbackModel = "whisper-1";
        resolvedTranscriptionPlanReason = "mini_with_full_fallback_runtime";
      }

      if (
        !turnTranscript &&
        resolvedFallbackModel &&
        resolvedFallbackModel !== transcriptionPlan.primaryModel
      ) {
        turnTranscript = await this.transcribePcmTurn({
          session,
          userId,
          pcmBuffer: normalizedPcmBuffer,
          model: resolvedFallbackModel,
          sampleRateHz,
          captureReason,
          traceSource: "voice_realtime_turn_decider_fallback",
          errorPrefix: "voice_realtime_transcription_fallback_failed",
          emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
          emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
          suppressEmptyTranscriptLogs: true,
          asrLanguage: asrLanguageGuidance.language,
          asrPrompt: asrLanguageGuidance.prompt
        });
        if (turnTranscript) {
          usedFallbackModelForTranscript = true;
        }
      }
      asrCompletedAtMs = Date.now();
    }

    if (
      !hasTranscriptOverride &&
      turnTranscript &&
      this.shouldDropFallbackLowSignalTurn({
        transcript: turnTranscript,
        usedFallbackModel: usedFallbackModelForTranscript,
        silenceGate,
        captureReason
      })
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_low_signal_fallback",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          transcript: turnTranscript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary: transcriptionPlan.primaryModel,
          transcriptionModelFallback: resolvedFallbackModel || null,
          transcriptionUsedFallbackModel: true
        }
      });
      return;
    }

    // Guard: ASR bridge was active but returned empty → PCM fallback produced transcript
    // This catches hallucinations from non-speech audio (coughs, throat clears, mic bumps)
    // where the ASR buffer race caused empty commit and gpt-4o-transcribe hallucinated.
    const asrBridgeWasActive = session.perUserAsrEnabled || session.sharedAsrEnabled;
    if (
      asrBridgeWasActive &&
      !hasTranscriptOverride &&
      turnTranscript &&
      clipDurationMs > 0 &&
      clipDurationMs <= VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS &&
      silenceGate.rms <= VOICE_FALLBACK_NOISE_GATE_RMS_MAX &&
      silenceGate.peak <= VOICE_FALLBACK_NOISE_GATE_PEAK_MAX &&
      silenceGate.activeSampleRatio <= VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_asr_bridge_fallback_hallucination",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          transcript: turnTranscript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary: transcriptionPlan.primaryModel,
          transcriptionModelFallback: resolvedFallbackModel || null,
          hasTranscriptOverride
        }
      });
      return;
    }

    const isNonSpeechCapture =
      String(captureReason || "") === "idle_timeout" ||
      String(captureReason || "") === "near_silence_early_abort";
    const idleSignalIsNoise =
      !hasTranscriptOverride &&
      silenceGate.rms <= VOICE_FALLBACK_NOISE_GATE_RMS_MAX &&
      silenceGate.peak <= VOICE_FALLBACK_NOISE_GATE_PEAK_MAX &&
      silenceGate.activeSampleRatio <= VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX;
    if (
      turnTranscript &&
      isNonSpeechCapture &&
      idleSignalIsNoise
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_idle_hallucination",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          transcript: turnTranscript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary: transcriptionPlan.primaryModel,
          hasTranscriptOverride
        }
      });
      return;
    }

    const persistRealtimeTranscriptTurn = this.shouldPersistUserTranscriptTimelineTurn({
      session,
      settings,
      transcript: turnTranscript
    });
    if (turnTranscript && persistRealtimeTranscriptTurn) {
      this.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: turnTranscript
      });
      this.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        source: "voice_realtime_ingest",
        captureReason,
        errorPrefix: "voice_realtime_memory_ingest_failed"
      });
    }

    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      source: "realtime",
      transcriptionContext: {
        usedFallbackModel: usedFallbackModelForTranscript,
        captureReason: String(captureReason || "stream_end"),
        clipDurationMs
      }
    });
    if (decision.directAddressed && session && !session.ending) {
      session.lastDirectAddressAt = Date.now();
      session.lastDirectAddressUserId = userId;
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
      userId,
      text: decision.transcript || turnTranscript,
      addressing: decisionVoiceAddressing
    });
    const decisionAddressingState = this.buildVoiceAddressingState({
      session,
      userId
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "realtime",
        captureReason: String(captureReason || "stream_end"),
        queueWaitMs,
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
        transcript: decision.transcript || turnTranscript || null,
        transcriptionModelPrimary: transcriptionPlan.primaryModel,
        transcriptionModelFallback: resolvedFallbackModel || null,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason: resolvedTranscriptionPlanReason,
        clipDurationMs,
        asrSkippedShortClip: skipShortClipAsr,
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
        error: decision.error || null
      }
    });

    const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({ session, settings });
    if (!decision.allow) {
      if (
        decision.reason === "bot_turn_open" ||
        decision.reason === "awaiting_non_direct_silence_window"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: decision.transcript || turnTranscript,
          pcmBuffer: normalizedPcmBuffer.length ? normalizedPcmBuffer : null,
          captureReason,
          source: "realtime",
          directAddressed: Boolean(decision.directAddressed),
          deferReason: decision.reason,
          flushDelayMs: decision.retryAfterMs
        });
      }
      return;
    }

    if (useNativeRealtimeReply) {
      if (!normalizedPcmBuffer?.length) {
        return;
      }
      await this.forwardRealtimeTurnAudio({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        pcmBuffer: normalizedPcmBuffer,
        captureReason
      });
      return;
    }

    if (this.shouldUseRealtimeTranscriptBridge({ session, settings })) {
      await this.forwardRealtimeTextTurnToBrain({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        captureReason,
        source: "realtime_transcript_turn",
        directAddressed: Boolean(decision.directAddressed),
        conversationContext: decision.conversationContext || null,
        latencyContext: {
          finalizedAtMs,
          asrStartedAtMs,
          asrCompletedAtMs,
          queueWaitMs,
          pendingQueueDepth,
          captureReason: String(captureReason || "stream_end")
        }
      });
      return;
    }

    await this.runRealtimeBrainReply({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      source: "realtime",
      latencyContext: {
        finalizedAtMs,
        asrStartedAtMs,
        asrCompletedAtMs,
        queueWaitMs,
        pendingQueueDepth,
        captureReason: String(captureReason || "stream_end")
      }
    });
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
    const pendingQueue = this.getDeferredQueuedUserTurns(session).slice();
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
    this.setDeferredVoiceAction(session, {
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
        directAddressed: Boolean(directAddressed),
        flushDelayMs: normalizedFlushDelayMs,
        deferredQueueSize: pendingQueue.length
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
    const pendingQueue = this.getDeferredQueuedUserTurns(session);
    if (!pendingQueue.length) {
      this.clearDeferredVoiceAction(session, "queued_user_turns");
      return;
    }
    const normalizedDelayMs = Math.max(20, Number(delayMs) || BOT_TURN_DEFERRED_FLUSH_DELAY_MS);
    const nextFlushAt = Date.now() + normalizedDelayMs;
    this.setDeferredVoiceAction(session, {
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
    this.scheduleDeferredVoiceActionRecheck(session, {
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
    const pendingQueue = Array.isArray(deferredTurns) ? deferredTurns : this.getDeferredQueuedUserTurns(session).slice();
    if (!pendingQueue.length) return;
    if (!Array.isArray(deferredTurns)) {
      const replyOutputLockState = this.getReplyOutputLockState(session);
      if (replyOutputLockState.locked || Number(session.userCaptures?.size || 0) > 0) {
        this.scheduleDeferredBotTurnOpenFlush({ session, reason });
        return;
      }
    }
    if (!Array.isArray(deferredTurns)) {
      this.clearDeferredVoiceAction(session, "queued_user_turns");
    }
    const deferredTurnsToFlush = pendingQueue;
    const coalescedTurns = deferredTurnsToFlush.slice(-BOT_TURN_DEFERRED_COALESCE_MAX);
    const substantiveTurns = coalescedTurns.filter(
      (entry) => !isLowSignalVoiceFragment(String(entry?.transcript || ""))
    );
    const turnsForTranscript = substantiveTurns.length > 0 ? substantiveTurns : coalescedTurns;
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
        error: decision.error || null
      }
    });
    if (!decision.allow) {
      if (
        decision.reason === "bot_turn_open" ||
        decision.reason === "awaiting_non_direct_silence_window"
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
    if (this.isRealtimeResponseActive(session)) {
      try {
        const cancel = session.realtimeClient?.cancelActiveResponse;
        if (typeof cancel === "function") {
          cancel.call(session.realtimeClient);
        }
      } catch { /* best-effort */ }
      try { session.subprocessClient?.stopPlayback(); } catch { /* ignore */ }
      this.clearPendingResponse(session);
    }

    const replyInterruptionPolicy = this.buildReplyInterruptionPolicy({
      session,
      userId: normalizedUserId,
      directAddressed: Boolean(directAddressed),
      conversationContext: conversationContext && typeof conversationContext === "object" ? conversationContext : null,
      source: String(source || "openai_realtime_text_turn")
    });
    try {
      await this.prepareRealtimeTurnContext({
        session,
        settings,
        userId: normalizedUserId,
        transcript: normalizedTranscript,
        captureReason
      });
      session.realtimeClient.requestTextUtterance(labeledTranscript);
      this.createTrackedAudioResponse({
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
      this.queueRealtimeTurnContextRefresh({
        session,
        settings,
        userId,
        transcript,
        captureReason
      });
    }
    this.scheduleResponseFromBufferedAudio({ session, userId });
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

  shouldPersistUserTranscriptTimelineTurn({ session = null, settings = null, transcript = "" } = {}) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    const resolvedSettings = settings || session?.settingsSnapshot || this.store.getSettings();
    const directAddressed = isVoiceTurnAddressedToBot(normalizedTranscript, resolvedSettings);
    if (directAddressed) return true;
    return !isLowSignalVoiceFragment(normalizedTranscript);
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

  async prepareRealtimeTurnContext({ session, settings, userId, transcript = "", captureReason: _captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const memorySlice = await this.buildRealtimeMemorySlice({
      session,
      settings,
      userId,
      transcript: normalizedTranscript
    });

    await this.refreshRealtimeInstructions({
      session,
      settings,
      reason: "turn_context",
      speakerUserId: userId,
      transcript: normalizedTranscript,
      memorySlice
    });
  }

  async buildRealtimeMemorySlice({ session, settings, userId, transcript = "" }) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) {
      const adaptiveDirectives =
        Boolean(settings?.adaptiveDirectives?.enabled) &&
          this.store && typeof this.store.searchAdaptiveStyleNotesForPrompt === "function"
          ? this.store.searchAdaptiveStyleNotesForPrompt({
            guildId: String(session?.guildId || "").trim(),
            queryText: "",
            limit: 8
          })
          : [];
      return {
        userFacts: [],
        relevantFacts: [],
        relevantMessages: [],
        recentConversationHistory: [],
        recentWebLookups: [],
        adaptiveDirectives
      };
    }

    if (session?.pendingMemoryIngest) {
      try { await session.pendingMemoryIngest; } catch { }
      session.pendingMemoryIngest = null;
    }

    const normalizedUserId = String(userId || "").trim() || null;
    return await loadConversationContinuityContext({
      settings,
      userId: normalizedUserId,
      guildId: session.guildId,
      channelId: session.textChannelId,
      queryText: normalizedTranscript,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId
      },
      source: "voice_realtime_instruction_context",
      loadPromptMemorySlice:
        this.memory && typeof this.memory === "object"
          ? (payload: ConversationContinuityPayload) =>
            loadPromptMemorySliceFromMemory({
              settings: payload.settings,
              memory: this.memory,
              userId: String(payload.userId || "").trim() || null,
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              trace: payload.trace || {},
              source: String(payload.source || "voice_realtime_instruction_context"),
              onError: ({ error }) => {
                this.store.logAction({
                  kind: "voice_error",
                  guildId: session.guildId,
                  channelId: session.textChannelId,
                  userId: normalizedUserId,
                  content: `voice_realtime_memory_slice_failed: ${String(error?.message || error)}`,
                  metadata: {
                    sessionId: session.id
                  }
                });
              }
            })
          : null,
      loadRecentLookupContext:
        this.store && typeof this.store.searchLookupContext === "function"
          ? (payload) =>
            this.store.searchLookupContext({
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              limit: Number(payload.limit) || undefined,
              maxAgeHours: Number(payload.maxAgeHours) || undefined
            })
          : null,
      loadRecentConversationHistory:
        this.store && typeof this.store.searchConversationWindows === "function"
          ? (payload) =>
            this.store.searchConversationWindows({
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              limit: Number(payload.limit) || undefined,
              maxAgeHours: Number(payload.maxAgeHours) || undefined,
              before: 1,
              after: 1
            })
          : null,
      loadAdaptiveDirectives:
        Boolean(settings?.adaptiveDirectives?.enabled) &&
          this.store && typeof this.store.searchAdaptiveStyleNotesForPrompt === "function"
          ? (payload) =>
            this.store.searchAdaptiveStyleNotesForPrompt({
              guildId: String(payload.guildId || "").trim(),
              queryText: String(payload.queryText || ""),
              limit: 8
            })
          : null
    });
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

      const created = this.createTrackedAudioResponse({
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

  scheduleRealtimeInstructionRefresh({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    if (session.realtimeInstructionRefreshTimer) {
      clearTimeout(session.realtimeInstructionRefreshTimer);
      session.realtimeInstructionRefreshTimer = null;
    }

    session.realtimeInstructionRefreshTimer = setTimeout(() => {
      session.realtimeInstructionRefreshTimer = null;
      this.refreshRealtimeInstructions({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        reason,
        speakerUserId,
        transcript,
        memorySlice
      }).catch(() => undefined);
    }, REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS);
  }

  async refreshRealtimeInstructions({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;
    if (!session.realtimeClient || typeof session.realtimeClient.updateInstructions !== "function") return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    await this.refreshRealtimeTools({
      session,
      settings: resolvedSettings,
      reason
    });
    const instructions = this.buildRealtimeInstructions({
      session,
      settings: resolvedSettings,
      speakerUserId,
      transcript,
      memorySlice
    });
    if (!instructions) return;
    if (instructions === session.lastOpenAiRealtimeInstructions) return;

    try {
      session.realtimeClient.updateInstructions(instructions);
      session.lastOpenAiRealtimeInstructions = instructions;
      session.lastOpenAiRealtimeInstructionsAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "openai_realtime_instructions_updated",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh"),
          speakerUserId: speakerUserId ? String(speakerUserId) : null,
          participantCount: this.getVoiceChannelParticipants(session).length,
          transcriptChars: transcript ? String(transcript).length : 0,
          userFactCount: Array.isArray(memorySlice?.userFacts) ? memorySlice.userFacts.length : 0,
          relevantFactCount: Array.isArray(memorySlice?.relevantFacts) ? memorySlice.relevantFacts.length : 0,
          conversationWindowCount: Array.isArray(memorySlice?.recentConversationHistory)
            ? memorySlice.recentConversationHistory.length
            : 0,
          instructionsChars: instructions.length
        }
      });

      // Start greeting observation window now that instructions are set.
      if (this.getDeferredVoiceAction(session, "join_greeting") && session.playbackArmed && !session.lastAssistantReplyAt) {
        this.scheduleJoinGreetingGrace(session);
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `openai_realtime_instruction_update_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    }
  }

  buildRealtimeInstructions({ session, settings, speakerUserId = null, transcript = "", memorySlice = null }) {
    const baseInstructions = String(session?.baseVoiceInstructions || this.buildVoiceInstructions(settings)).trim();
    const speakerName = this.resolveVoiceSpeakerName(session, speakerUserId);
    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const hasScreenFrameContext = Array.isArray(streamWatchBrainContext?.notes) && streamWatchBrainContext.notes.length > 0;
    const hasActiveScreenFrameContext = hasScreenFrameContext && Boolean(streamWatchBrainContext?.active);
    const hasRecentScreenFrameMemory = hasScreenFrameContext && !streamWatchBrainContext?.active;
    const screenShareCapability = this.getVoiceScreenShareCapability({
      settings,
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      requesterUserId: speakerUserId || null
    });
    const participants = this.getVoiceChannelParticipants(session);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const voiceChannel = guild?.channels?.cache?.get(String(session?.voiceChannelId || "")) || null;
    const roster =
      participants.length > 0
        ? participants
          .slice(0, REALTIME_CONTEXT_MEMBER_LIMIT)
          .map((participant) => participant.displayName)
          .join(", ")
        : "unknown";
    const membershipSummary = recentMembershipEvents.length
      ? recentMembershipEvents
        .map((entry) => {
          const action = entry.eventType === "join" ? "joined" : "left";
          return `${entry.displayName} ${action} (${Math.max(0, Math.round(entry.ageMs))}ms ago)`;
        })
        .join(" | ")
      : "none";
    const userFacts = formatRealtimeMemoryFacts(memorySlice?.userFacts, REALTIME_MEMORY_FACT_LIMIT);
    const relevantFacts = formatRealtimeMemoryFacts(memorySlice?.relevantFacts, REALTIME_MEMORY_FACT_LIMIT);
    const recentConversationHistory = formatConversationWindows(memorySlice?.recentConversationHistory);
    const recentWebLookups = formatRecentLookupContext(memorySlice?.recentWebLookups);
    const adaptiveDirectives = formatAdaptiveDirectives(memorySlice?.adaptiveDirectives, 8);
    const activeVoiceCommandState = this.ensureVoiceCommandState(session);
    const musicDisambiguation = this.getMusicDisambiguationPromptContext(session);

    const sections = [baseInstructions];
    sections.push(
      [
        "Live server context:",
        `- Server: ${String(guild?.name || "unknown").trim() || "unknown"}`,
        `- Voice channel: ${String(voiceChannel?.name || "unknown").trim() || "unknown"}`,
        `- Humans currently in channel: ${roster}`,
        `- Recent membership changes: ${membershipSummary}`,
        "- If someone recently joined, a quick natural greeting is usually good.",
        "- If someone recently left, a brief natural goodbye/acknowledgement is usually good."
      ].join("\n")
    );

    const joinWindowAgeMs = Math.max(0, Date.now() - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const deferredJoinGreeting = this.getDeferredVoiceAction(session, "join_greeting");
    if (joinWindowActive && !session.lastAssistantReplyAt) {
      if (deferredJoinGreeting?.status === "deferred") {
        sections.push(
          "You recently joined this voice channel, but your greeting was deferred while you waited for better timing. Re-evaluate whether a brief casual greeting still fits right now. If the moment has passed or the room has clearly moved on, you may skip."
        );
      } else {
        sections.push("You just joined this voice channel. Say a brief, casual greeting to announce your presence. Keep it to one short sentence. Be natural.");
      }
    }

    if (speakerName || normalizedTranscript) {
      sections.push(
        [
          "Current turn context:",
          speakerName ? `- Active speaker: ${speakerName}` : null,
          normalizedTranscript ? `- Latest speaker transcript: ${normalizedTranscript}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (userFacts || relevantFacts) {
      sections.push(
        [
          "Durable memory context:",
          userFacts ? `- Known facts about active speaker: ${userFacts}` : null,
          relevantFacts ? `- Other relevant memory: ${relevantFacts}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (Array.isArray(memorySlice?.recentConversationHistory) && memorySlice.recentConversationHistory.length > 0) {
      sections.push(
        [
          "Recent conversation continuity:",
          "- These windows come from persisted shared text/voice history.",
          recentConversationHistory
        ].join("\n")
      );
    }

    if (Array.isArray(memorySlice?.recentWebLookups) && memorySlice.recentWebLookups.length > 0) {
      sections.push(
        [
          "Recent lookup continuity:",
          "- These are recent successful web searches from the shared text/voice conversation.",
          recentWebLookups
        ].join("\n")
      );
    }

    if (Array.isArray(memorySlice?.adaptiveDirectives) && memorySlice.adaptiveDirectives.length > 0) {
      sections.push(
        [
          "Adaptive directives:",
          "- Guidance directives shape tone/persona. Behavior directives define recurring trigger/action behavior when the current turn matches.",
          adaptiveDirectives
        ].join("\n")
      );
    }

    if (activeVoiceCommandState || musicDisambiguation) {
      sections.push(
        [
          "Active command session:",
          activeVoiceCommandState?.userId
            ? `- Locked speaker user ID: ${activeVoiceCommandState.userId}`
            : null,
          activeVoiceCommandState?.domain
            ? `- Domain: ${activeVoiceCommandState.domain}`
            : null,
          activeVoiceCommandState?.intent
            ? `- Intent: ${activeVoiceCommandState.intent}`
            : null,
          activeVoiceCommandState
            ? `- Command session expires in about ${Math.max(0, Math.round((activeVoiceCommandState.expiresAt - Date.now()) / 1000))} seconds.`
            : null,
          "- In command-only mode, a follow-up from the locked speaker does not need the wake word again.",
          musicDisambiguation?.active
            ? `- Pending music action: ${musicDisambiguation.action}`
            : null,
          musicDisambiguation?.query
            ? `- Pending music query: ${musicDisambiguation.query}`
            : null,
          ...(musicDisambiguation?.options || []).slice(0, 5).map((option, index) =>
            `- Music option ${index + 1}: ${option.title} - ${option.artist} [${option.id}]`
          )
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    const musicContext = this.getMusicPromptContext(session);
    if (musicContext && musicContext.playbackState !== "idle") {
      const musicLines = ["Music playback:"];
      musicLines.push(`- Status: ${musicContext.playbackState}`);
      if (musicContext.currentTrack) {
        const artists = musicContext.currentTrack.artists.length
          ? musicContext.currentTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(`- Now playing: ${musicContext.currentTrack.title} by ${artists}`);
      } else if (musicContext.lastTrack && musicContext.playbackState === "stopped") {
        const artists = musicContext.lastTrack.artists.length
          ? musicContext.lastTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(`- Last played: ${musicContext.lastTrack.title} by ${artists}`);
      }
      if (musicContext.queueLength > 0) {
        musicLines.push(`- Queue: ${musicContext.queueLength} track(s)`);
      }
      sections.push(musicLines.join("\n"));
    }

    const configuredTools = Array.isArray(session.openAiToolDefinitions) ? session.openAiToolDefinitions : [];
    if (configuredTools.length > 0) {
      const localToolNames = configuredTools
        .filter((tool) => tool?.toolType !== "mcp")
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, 16);
      const mcpToolNames = configuredTools
        .filter((tool) => tool?.toolType === "mcp")
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, 16);
      sections.push(
        [
          "Tooling policy:",
          localToolNames.length > 0 ? `- Local tools: ${localToolNames.join(", ")}` : null,
          mcpToolNames.length > 0 ? `- MCP tools: ${mcpToolNames.join(", ")}` : null,
          "- Use tools when they improve factuality or action execution.",
          "- Use conversation_search when the speaker asks what was said earlier or asks you to remember a prior exchange.",
          "- For memory writes, only store concise durable facts and avoid secrets.",
          settings?.adaptiveDirectives?.enabled
            ? "- If someone explicitly asks you to change how you talk, follow a standing instruction, or perform a recurring trigger/action behavior in future conversations, use adaptive_directive_add or adaptive_directive_remove instead of memory_write."
            : "- Adaptive directives are disabled right now. Do not imply you can save standing behavior changes for later.",
          "- For music controls, use music_play_now for immediate playback, music_queue_next to place a track after the current one, music_queue_add to append, and music_stop to stop playback.",
          "- Do not emulate play-now by chaining music_queue_add and music_skip.",
          "- Do not use music_skip as a substitute for music_stop.",
          "- If a tool fails, explain the failure briefly and continue naturally."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (hasActiveScreenFrameContext) {
      sections.push(
        [
          "Visual context:",
          "- You currently have screen-share frame snapshots for this conversation.",
          "- You may comment only on what those snapshots show.",
          "- Do not imply you have a continuous live view beyond the provided frame context."
        ].join("\n")
      );
    } else if (hasRecentScreenFrameMemory) {
      sections.push(
        [
          "Visual context:",
          "- You do not currently see the user's screen.",
          "- You do retain notes from an earlier screen-share in this conversation.",
          "- If asked, answer only from those earlier notes and make clear they are not a live view."
        ].join("\n")
      );
    } else {
      const rawScreenShareReason = String(screenShareCapability?.reason || "").trim().toLowerCase();
      const screenShareReason = rawScreenShareReason || "unavailable";
      const screenShareAvailable = Boolean(screenShareCapability?.available);
      const screenShareSupported = Boolean(screenShareCapability?.supported);
      if (screenShareAvailable) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content until actual frame context is provided.",
            "- If the speaker asks you to see/watch/share their screen or stream, call offer_screen_share_link.",
            "- After offering the link, you may briefly tell them to open the link and start sharing."
          ].join("\n")
        );
      } else if (screenShareSupported) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Screen-share link capability exists but is unavailable right now.",
            `- Current unavailability reason: ${screenShareReason}.`,
            "- If asked, say the link flow is unavailable right now.",
            "- Do not claim to see or watch the screen."
          ].join("\n")
        );
      } else {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content.",
            "- If asked about screen sharing, explain that you need an active screen-share link and incoming frame context before you can comment on what is on screen."
          ].join("\n")
        );
      }
    }

    if (hasScreenFrameContext) {
      sections.push(
        [
          hasActiveScreenFrameContext ? "Screen-share stream frame context:" : "Recent screen-share memory:",
          `- Guidance: ${String(streamWatchBrainContext.prompt || "").trim()}`,
          ...streamWatchBrainContext.notes.slice(-8).map((note) => `- ${note}`),
          hasActiveScreenFrameContext
            ? "- Treat these notes as snapshots, not a continuous feed."
            : "- Treat these notes as earlier snapshots, not a current live view."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return sections.join("\n\n").slice(0, 5200);
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

  getPendingSttTurnQueue(session) {
    if (!session) return [];
    const pendingQueue = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue : [];
    if (!Array.isArray(session.pendingSttTurnsQueue)) {
      session.pendingSttTurnsQueue = pendingQueue;
    }
    return pendingQueue;
  }

  syncPendingSttTurnCount(session) {
    if (!session) return;
    const pendingQueueDepth = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue.length : 0;
    session.pendingSttTurns = Math.max(0, (session.sttTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  shouldCoalesceSttTurn(prevTurn, nextTurn) {
    if (!prevTurn || !nextTurn) return false;
    const prevUserId = String(prevTurn.userId || "").trim();
    const nextUserId = String(nextTurn.userId || "").trim();
    if (!prevUserId || !nextUserId || prevUserId !== nextUserId) return false;

    const prevCaptureReason = String(prevTurn.captureReason || "").trim();
    const nextCaptureReason = String(nextTurn.captureReason || "").trim();
    if (!prevCaptureReason || !nextCaptureReason || prevCaptureReason !== nextCaptureReason) return false;

    const prevQueuedAt = Number(prevTurn.queuedAt || 0);
    const nextQueuedAt = Number(nextTurn.queuedAt || 0);
    if (!prevQueuedAt || !nextQueuedAt) return false;
    if (nextQueuedAt - prevQueuedAt > STT_TURN_COALESCE_WINDOW_MS) return false;

    const prevBuffer = Buffer.isBuffer(prevTurn.pcmBuffer) ? prevTurn.pcmBuffer : null;
    const nextBuffer = Buffer.isBuffer(nextTurn.pcmBuffer) ? nextTurn.pcmBuffer : null;
    if (!prevBuffer?.length || !nextBuffer?.length) return false;
    if (prevBuffer.length + nextBuffer.length > STT_TURN_COALESCE_MAX_BYTES) return false;

    return true;
  }

  queueSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer || !pcmBuffer.length) return;

    const pendingQueue = this.getPendingSttTurnQueue(session);
    const queuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt: Date.now()
    };

    if (session.sttTurnDrainActive) {
      const lastQueuedTurn = pendingQueue[pendingQueue.length - 1] || null;
      if (this.shouldCoalesceSttTurn(lastQueuedTurn, queuedTurn)) {
        lastQueuedTurn.pcmBuffer = Buffer.concat([lastQueuedTurn.pcmBuffer, queuedTurn.pcmBuffer]);
        lastQueuedTurn.captureReason = queuedTurn.captureReason;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "stt_pipeline_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: lastQueuedTurn.pcmBuffer.length,
            queueDepth: pendingQueue.length
          }
        });
        return;
      }

      if (pendingQueue.length >= STT_TURN_QUEUE_MAX) {
        const droppedTurn = pendingQueue.shift();
        if (droppedTurn) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "stt_pipeline_turn_superseded",
            metadata: {
              sessionId: session.id,
              replacedCaptureReason: String(droppedTurn.captureReason || "stream_end"),
              replacingCaptureReason: String(captureReason || "stream_end"),
              replacedQueueAgeMs: Math.max(0, Date.now() - Number(droppedTurn.queuedAt || Date.now())),
              maxQueueDepth: STT_TURN_QUEUE_MAX
            }
          });
        }
      }
      pendingQueue.push(queuedTurn);
      this.syncPendingSttTurnCount(session);
      return;
    }

    if (pendingQueue.length > 0) {
      if (pendingQueue.length >= STT_TURN_QUEUE_MAX) {
        pendingQueue.shift();
      }
      pendingQueue.push(queuedTurn);
      const nextTurn = pendingQueue.shift();
      if (!nextTurn) return;
      this.drainSttPipelineTurnQueue(nextTurn).catch(() => undefined);
      return;
    }

    this.drainSttPipelineTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainSttPipelineTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (session.sttTurnDrainActive) return;
    const pendingQueue = this.getPendingSttTurnQueue(session);

    session.sttTurnDrainActive = true;
    this.syncPendingSttTurnCount(session);
    let turn = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runSttPipelineTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `stt_pipeline_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const nextTurn = pendingQueue.shift();
        turn = nextTurn || null;
        this.syncPendingSttTurnCount(session);
      }
    } finally {
      session.sttTurnDrainActive = false;
      if (session.ending) {
        session.pendingSttTurnsQueue = [];
      } else {
        const pendingTurn = pendingQueue.shift();
        if (pendingTurn) {
          this.syncPendingSttTurnCount(session);
          this.drainSttPipelineTurnQueue(pendingTurn).catch(() => undefined);
        }
      }
      this.syncPendingSttTurnCount(session);
    }
  }

  async runSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end", queuedAt = 0 }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer?.length) return;
    if (!this.llm?.transcribeAudio || !this.llm?.synthesizeSpeech) return;

    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const pendingQueueDepth = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue.length : 0;
    const staleTurn = queueWaitMs >= STT_TURN_STALE_SKIP_MS;
    if (staleTurn && pendingQueueDepth > 1) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "stt_pipeline_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length,
          droppedBeforeAsr: true
        }
      });
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const consumedByMusicMode = await this.maybeHandleMusicPlaybackTurn({
      session,
      settings,
      userId,
      pcmBuffer,
      captureReason,
      source: "stt_pipeline"
    });
    if (consumedByMusicMode) return;

    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const sttSettings = settings?.voice?.sttPipeline || {};
    const transcriptionModelPrimary =
      String(sttSettings?.transcriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const sampleRateHz = 24000;
    const silenceGate = this.evaluatePcmSilenceGate({
      pcmBuffer,
      sampleRateHz
    });
    const clipDurationMs = silenceGate.clipDurationMs;
    if (silenceGate.drop) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_silence_gate",
        metadata: {
          sessionId: session.id,
          source: "stt_pipeline",
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: pcmBuffer.length,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          queueWaitMs,
          pendingQueueDepth
        }
      });
      return;
    }
    let transcriptionModelFallback = null;
    let transcriptionPlanReason = "configured_model";
    if (transcriptionModelPrimary === "gpt-4o-mini-transcribe") {
      transcriptionModelFallback = "whisper-1";
      transcriptionPlanReason = "mini_with_full_fallback_runtime";
    }
    let usedFallbackModelForTranscript = false;

    let transcript = await this.transcribePcmTurn({
      session,
      userId,
      pcmBuffer,
      model: transcriptionModelPrimary,
      sampleRateHz,
      captureReason,
      traceSource: "voice_stt_pipeline_turn",
      errorPrefix: "stt_pipeline_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_stt_transcription_empty",
      emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
      asrLanguage: asrLanguageGuidance.language,
      asrPrompt: asrLanguageGuidance.prompt
    });
    if (
      !transcript &&
      transcriptionModelFallback &&
      transcriptionModelFallback !== transcriptionModelPrimary
    ) {
      transcript = await this.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: transcriptionModelFallback,
        sampleRateHz,
        captureReason,
        traceSource: "voice_stt_pipeline_turn_fallback",
        errorPrefix: "stt_pipeline_transcription_fallback_failed",
        emptyTranscriptRuntimeEvent: "voice_stt_transcription_empty",
        emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
        suppressEmptyTranscriptLogs: true,
        asrLanguage: asrLanguageGuidance.language,
        asrPrompt: asrLanguageGuidance.prompt
      });
      if (transcript) {
        usedFallbackModelForTranscript = true;
      }
    }
    if (!transcript) return;
    if (
      this.shouldDropFallbackLowSignalTurn({
        transcript,
        usedFallbackModel: usedFallbackModelForTranscript,
        silenceGate,
        captureReason
      })
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_low_signal_fallback",
        metadata: {
          sessionId: session.id,
          source: "stt_pipeline",
          captureReason: String(captureReason || "stream_end"),
          transcript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary,
          transcriptionModelFallback,
          transcriptionUsedFallbackModel: true
        }
      });
      return;
    }
    if (session.ending) return;

    this.touchActivity(session.guildId, settings);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "stt_pipeline_transcript",
      metadata: {
        sessionId: session.id,
        captureReason: String(captureReason || "stream_end"),
        transcript,
        transcriptionModelPrimary,
        transcriptionModelFallback,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason,
        clipDurationMs
      }
    });
    const persistSttTranscriptTurn = this.shouldPersistUserTranscriptTimelineTurn({
      session,
      settings,
      transcript
    });
    if (persistSttTranscriptTurn) {
      this.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: transcript
      });

      this.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript,
        source: "voice_stt_pipeline_ingest",
        captureReason,
        errorPrefix: "voice_stt_memory_ingest_failed"
      });
    }
    if (staleTurn) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "stt_pipeline_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length,
          droppedBeforeAsr: false
        }
      });
      return;
    }

    const turnDecision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript,
      source: "stt_pipeline",
      transcriptionContext: {
        usedFallbackModel: usedFallbackModelForTranscript,
        captureReason: String(captureReason || "stream_end"),
        clipDurationMs
      }
    });
    if (turnDecision.directAddressed && session && !session.ending) {
      session.lastDirectAddressAt = Date.now();
      session.lastDirectAddressUserId = userId;
    }
    const turnVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: turnDecision?.voiceAddressing,
      directAddressed: Boolean(turnDecision.directAddressed),
      directedConfidence: Number(turnDecision.directAddressConfidence),
      source: "decision",
      reason: turnDecision.reason
    });
    this.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId,
      text: turnDecision.transcript || transcript,
      addressing: turnVoiceAddressing
    });
    const turnAddressingState = this.buildVoiceAddressingState({
      session,
      userId
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "stt_pipeline",
        captureReason: String(captureReason || "stream_end"),
        allow: Boolean(turnDecision.allow),
        reason: turnDecision.reason,
        participantCount: Number(turnDecision.participantCount || 0),
        directAddressed: Boolean(turnDecision.directAddressed),
        talkingTo: turnVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(turnVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(turnVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        addressingSource: turnVoiceAddressing?.source || null,
        addressingReason: turnVoiceAddressing?.reason || null,
        currentSpeakerTarget: turnAddressingState?.currentSpeakerTarget || null,
        currentSpeakerDirectedConfidence: Number.isFinite(
          Number(turnAddressingState?.currentSpeakerDirectedConfidence)
        )
          ? Number(clamp(Number(turnAddressingState.currentSpeakerDirectedConfidence), 0, 1).toFixed(3))
          : 0,
        transcript: turnDecision.transcript || transcript || null,
        transcriptionModelPrimary,
        transcriptionModelFallback,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason,
        clipDurationMs,
        asrSkippedShortClip: false,
        conversationState: turnDecision.conversationContext?.engagementState || null,
        conversationEngaged: Boolean(turnDecision.conversationContext?.engaged),
        engagedWithCurrentSpeaker: Boolean(turnDecision.conversationContext?.engagedWithCurrentSpeaker),
        recentAssistantReply: Boolean(turnDecision.conversationContext?.recentAssistantReply),
        msSinceAssistantReply: Number.isFinite(turnDecision.conversationContext?.msSinceAssistantReply)
          ? Math.round(turnDecision.conversationContext.msSinceAssistantReply)
          : null,
        msSinceDirectAddress: Number.isFinite(turnDecision.conversationContext?.msSinceDirectAddress)
          ? Math.round(turnDecision.conversationContext.msSinceDirectAddress)
          : null,
        msSinceInboundAudio: Number.isFinite(turnDecision.msSinceInboundAudio)
          ? Math.round(turnDecision.msSinceInboundAudio)
          : null,
        requiredSilenceMs: Number.isFinite(turnDecision.requiredSilenceMs)
          ? Math.round(turnDecision.requiredSilenceMs)
          : null,
        retryAfterMs: Number.isFinite(turnDecision.retryAfterMs)
          ? Math.round(turnDecision.retryAfterMs)
          : null,
        error: turnDecision.error || null
      }
    });
    if (!turnDecision.allow) {
      if (
        turnDecision.reason === "bot_turn_open" ||
        turnDecision.reason === "awaiting_non_direct_silence_window"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: turnDecision.transcript || transcript,
          captureReason,
          source: "stt_pipeline",
          directAddressed: Boolean(turnDecision.directAddressed),
          deferReason: turnDecision.reason,
          flushDelayMs: turnDecision.retryAfterMs
        });
      }
      return;
    }

    await this.runSttPipelineReply({
      session,
      settings,
      userId,
      transcript,
      directAddressed: Boolean(turnDecision.directAddressed),
      directAddressConfidence: Number(turnDecision.directAddressConfidence),
      conversationContext: turnDecision.conversationContext || null
    });
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
    const sessionTiming = this.buildVoiceSessionTimingContext(session);
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
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
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
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
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
    latencyContext = null
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
    const sessionTiming = this.buildVoiceSessionTimingContext(session);
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
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
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
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
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
      void this.prepareRealtimeTurnContext({
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
    const playbackResult = await this.playVoiceReplyInOrder({
      session,
      settings,
      spokenText: playbackPlan.spokenText,
      playbackSteps: playbackPlan.steps,
      source: `${String(source || "realtime")}:reply`,
      preferRealtimeUtterance: true,
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

  scheduleResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    if (session.responseFlushTimer) {
      clearTimeout(session.responseFlushTimer);
    }

    session.responseFlushTimer = setTimeout(() => {
      session.responseFlushTimer = null;
      this.flushResponseFromBufferedAudio({ session, userId });
    }, RESPONSE_FLUSH_DEBOUNCE_MS);
  }

  flushResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    const now = Date.now();
    const msSinceLastRequest = now - Number(session.lastResponseRequestAt || 0);
    if (msSinceLastRequest < MIN_RESPONSE_REQUEST_GAP_MS) {
      const waitMs = Math.max(20, MIN_RESPONSE_REQUEST_GAP_MS - msSinceLastRequest);
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, waitMs);
      return;
    }

    // Don't commit/request while users are still actively streaming audio chunks.
    // This avoids partial-turn commits that can return no-audio responses.
    if (Number(session.userCaptures?.size || 0) > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.isBargeInOutputSuppressed(session)) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked) {
      this.scheduleResponseFromBufferedAudio({
        session,
        userId: session.pendingResponse?.userId || userId
      });
      return;
    }

    const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (pendingInputBytes < minCommitBytes) {
      return;
    }

    if (this.getRealtimeTurnBacklogSize(session) > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.isRealtimeResponseActive(session)) {
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, OPENAI_ACTIVE_RESPONSE_RETRY_MS);
      return;
    }

    try {
      session.realtimeClient.commitInputAudioBuffer();
      session.pendingRealtimeInputBytes = 0;
      // When a provider supports textInput and the session is NOT using native
      // reply, the bridge path sends requestTextUtterance instead of response.create.
      const emitCreateEvent =
        !providerSupports(session.mode || "", "textInput") || this.shouldUseNativeRealtimeReply({ session });
      const created = this.createTrackedAudioResponse({
        session,
        userId,
        source: "turn_flush",
        resetRetryState: true,
        emitCreateEvent
      });
      if (!created) {
        this.scheduleResponseFromBufferedAudio({ session, userId });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }
  }

  createTrackedAudioResponse({
    session,
    userId = null,
    source = "turn_flush",
    resetRetryState = false,
    emitCreateEvent = true,
    interruptionPolicy = undefined,
    utteranceText = undefined,
    latencyContext = undefined
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    // Any fresh bot response supersedes older deferred voice intents.
    this.clearAllDeferredVoiceActions(session);
    if (emitCreateEvent && this.isRealtimeResponseActive(session)) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "response_create_skipped_active_response",
        metadata: {
          sessionId: session.id,
          source: String(source || "turn_flush")
        }
      });
      return false;
    }
    if (emitCreateEvent) {
      session.realtimeClient.createAudioResponse();
    }

    const now = Date.now();
    if (isRealtimeMode(session.mode)) {
      session.lastOpenAiAssistantAudioItemId = null;
      session.lastOpenAiAssistantAudioItemContentIndex = 0;
      session.lastOpenAiAssistantAudioItemReceivedMs = 0;
    }
    const requestId = Number(session.nextResponseRequestId || 0) + 1;
    session.nextResponseRequestId = requestId;
    const previous = session.pendingResponse;
    const interruptionPolicySeed =
      interruptionPolicy === undefined
        ? previous?.interruptionPolicy || session.activeReplyInterruptionPolicy
        : interruptionPolicy;
    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicySeed);
    const utteranceTextSeed = utteranceText === undefined ? previous?.utteranceText || "" : utteranceText || "";
    const normalizedUtteranceText =
      normalizeVoiceText(utteranceTextSeed, STT_REPLY_MAX_CHARS) || null;
    const latencyContextSeed =
      latencyContext === undefined
        ? previous?.latencyContext || null
        : latencyContext;
    const normalizedLatencyContext =
      latencyContextSeed && typeof latencyContextSeed === "object"
        ? {
          finalizedAtMs: Math.max(0, Number(latencyContextSeed.finalizedAtMs || 0)),
          asrStartedAtMs: Math.max(0, Number(latencyContextSeed.asrStartedAtMs || 0)),
          asrCompletedAtMs: Math.max(0, Number(latencyContextSeed.asrCompletedAtMs || 0)),
          generationStartedAtMs: Math.max(0, Number(latencyContextSeed.generationStartedAtMs || 0)),
          replyRequestedAtMs: Math.max(
            0,
            Number(latencyContextSeed.replyRequestedAtMs || 0)
          ) || now,
          audioStartedAtMs: Math.max(0, Number(latencyContextSeed.audioStartedAtMs || 0)),
          source: String(latencyContextSeed.source || source || "turn_flush"),
          captureReason: String(latencyContextSeed.captureReason || "").trim() || null,
          queueWaitMs: Number.isFinite(Number(latencyContextSeed.queueWaitMs))
            ? Math.max(0, Math.round(Number(latencyContextSeed.queueWaitMs)))
            : null,
          pendingQueueDepth: Number.isFinite(Number(latencyContextSeed.pendingQueueDepth))
            ? Math.max(0, Math.round(Number(latencyContextSeed.pendingQueueDepth)))
            : null
        }
        : null;

    session.pendingResponse = {
      requestId,
      userId: userId || previous?.userId || null,
      requestedAt: now,
      retryCount: resetRetryState ? 0 : Number(previous?.retryCount || 0),
      hardRecoveryAttempted: resetRetryState ? false : Boolean(previous?.hardRecoveryAttempted),
      source: String(source || "turn_flush"),
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: normalizedInterruptionPolicy,
      utteranceText: normalizedUtteranceText,
      latencyContext: normalizedLatencyContext
    };
    session.lastResponseRequestAt = now;
    this.setActiveReplyInterruptionPolicy(session, normalizedInterruptionPolicy);
    this.clearResponseSilenceTimers(session);
    this.armResponseSilenceWatchdog({
      session,
      requestId,
      userId: session.pendingResponse.userId
    });
    return true;
  }

  pendingResponseHasAudio(session, pendingResponse = session?.pendingResponse) {
    if (!session || !pendingResponse) return false;
    const requestedAt = Number(pendingResponse.requestedAt || 0);
    if (!requestedAt) return false;
    return Number(session.lastAudioDeltaAt || 0) >= requestedAt;
  }

  clearResponseSilenceTimers(session) {
    if (!session) return;
    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
      session.responseWatchdogTimer = null;
    }
    if (session.responseDoneGraceTimer) {
      clearTimeout(session.responseDoneGraceTimer);
      session.responseDoneGraceTimer = null;
    }
  }

  clearPendingResponse(session) {
    if (!session) return;
    this.clearResponseSilenceTimers(session);

    if (session.openAiPendingToolAbortControllers) {
      for (const controller of session.openAiPendingToolAbortControllers.values()) {
        try {
          controller.abort("Pending response cleared");
        } catch {
          // ignore
        }
      }
      session.openAiPendingToolAbortControllers.clear();
    }

    session.pendingResponse = null;
    this.maybeClearActiveReplyInterruptionPolicy(session);
    this.recheckDeferredVoiceActions({
      session,
      reason: "pending_response_cleared"
    });
  }

  isRealtimeResponseActive(session) {
    if (!session || !isRealtimeMode(session.mode)) return false;
    const checker = session.realtimeClient?.isResponseInProgress;
    if (typeof checker !== "function") return false;
    try {
      return Boolean(checker.call(session.realtimeClient));
    } catch {
      return false;
    }
  }

  armResponseSilenceWatchdog({ session, requestId, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!Number.isFinite(Number(requestId)) || Number(requestId) <= 0) return;

    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
    }

    session.responseWatchdogTimer = setTimeout(() => {
      session.responseWatchdogTimer = null;
      if (!session || session.ending) return;
      const pending = session.pendingResponse;
      if (!pending) return;
      if (Number(pending.requestId || 0) !== Number(requestId)) return;
      if (this.pendingResponseHasAudio(session, pending)) {
        this.clearPendingResponse(session);
        return;
      }
      this.handleSilentResponse({
        session,
        userId: pending.userId || userId,
        trigger: "watchdog"
      }).catch(() => undefined);
    }, RESPONSE_SILENCE_RETRY_DELAY_MS);
  }

  async handleSilentResponse({
    session,
    userId = null,
    trigger = "watchdog",
    responseId = null,
    responseStatus = null
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const pending = session.pendingResponse;
    if (!pending) return;
    if (pending.handlingSilence) return;
    if (this.pendingResponseHasAudio(session, pending)) {
      this.clearPendingResponse(session);
      return;
    }

    pending.handlingSilence = true;
    this.clearResponseSilenceTimers(session);

    if (Number(session.userCaptures?.size || 0) > 0) {
      pending.handlingSilence = false;
      this.armResponseSilenceWatchdog({
        session,
        requestId: pending.requestId,
        userId: pending.userId || userId
      });
      return;
    }

    const resolvedUserId = pending.userId || userId || this.client.user?.id || null;
    const setHandlingDone = () => {
      const active = session.pendingResponse;
      if (active && Number(active.requestId || 0) === Number(pending.requestId || 0)) {
        active.handlingSilence = false;
      }
    };

    if (pending.retryCount < MAX_RESPONSE_SILENCE_RETRIES) {
      pending.retryCount += 1;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_retry",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          maxRetries: MAX_RESPONSE_SILENCE_RETRIES,
          responseRequestedAt: pending.requestedAt,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "silent_retry",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_retry_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    if (!pending.hardRecoveryAttempted) {
      pending.hardRecoveryAttempted = true;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_hard_recovery",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
        const minCommitBytes = getRealtimeCommitMinimumBytes(
          session.mode,
          Number(session.realtimeInputSampleRateHz) || 24000
        );
        if (pendingInputBytes >= minCommitBytes) {
          session.realtimeClient.commitInputAudioBuffer();
          session.pendingRealtimeInputBytes = 0;
        }
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "hard_recovery",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_hard_recovery_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    this.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId,
      content: "response_silent_fallback",
      metadata: {
        sessionId: session.id,
        requestId: pending.requestId,
        retryCount: pending.retryCount,
        hardRecoveryAttempted: pending.hardRecoveryAttempted,
        trigger,
        responseId,
        responseStatus
      }
    });
    this.clearPendingResponse(session);
    // Drop this stuck turn and keep the VC session alive; a fresh user turn can recover.
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

    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    if (session.botTurnResetTimer) clearTimeout(session.botTurnResetTimer);
    if (session.botDisconnectTimer) clearTimeout(session.botDisconnectTimer);
    if (session.responseFlushTimer) clearTimeout(session.responseFlushTimer);
    if (session.responseWatchdogTimer) clearTimeout(session.responseWatchdogTimer);
    if (session.responseDoneGraceTimer) clearTimeout(session.responseDoneGraceTimer);
    if (session.realtimeInstructionRefreshTimer) clearTimeout(session.realtimeInstructionRefreshTimer);
    if (session.openAiToolResponseDebounceTimer) clearTimeout(session.openAiToolResponseDebounceTimer);
    if (session.voiceLookupBusyAnnounceTimer) clearTimeout(session.voiceLookupBusyAnnounceTimer);
    this.clearVoiceThoughtLoopTimer(session);
    session.thoughtLoopBusy = false;
    session.pendingResponse = null;
    session.sttTurnDrainActive = false;
    session.pendingSttTurnsQueue = [];
    session.pendingSttTurns = 0;
    session.pendingRealtimeTurns = [];
    if (session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }
    this.clearAllDeferredVoiceActions(session);
    session.awaitingToolOutputs = false;
    session.openAiPendingToolCalls = new Map();
    session.openAiToolCallExecutions = new Map();
    session.openAiTurnContextRefreshState = null;
    session.lastRequestedRealtimeUtterance = null;
    session.activeReplyInterruptionPolicy = null;
    session.voiceLookupBusyAnnounceTimer = null;
    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;
    this.resetBotAudioPlayback(session);

    for (const capture of session.userCaptures.values()) {
      if (capture.idleFlushTimer) {
        clearTimeout(capture.idleFlushTimer);
      }
      if (capture.maxFlushTimer) {
        clearTimeout(capture.maxFlushTimer);
      }
      if (capture.speakingEndFinalizeTimer) {
        clearTimeout(capture.speakingEndFinalizeTimer);
      }
      if (capture.bargeInAssertTimer) {
        clearTimeout(capture.bargeInAssertTimer);
      }
    }
    session.userCaptures.clear();
    await this.closeAllOpenAiAsrSessions(session, "session_end");
    await this.closeOpenAiSharedAsrSession(session, "session_end");

    for (const cleanup of session.cleanupHandlers || []) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }

    try {
      await session.realtimeClient?.close?.();
    } catch {
      // ignore
    }

    // Destroy subprocess — this handles connection teardown, audio player
    // stop, and all stream cleanup inside the Node.js subprocess.
    try {
      await session.subprocessClient?.destroy();
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
        this.scheduleRealtimeInstructionRefresh({
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
            this.scheduleRealtimeInstructionRefresh({
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
          }).catch(() => undefined);
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
      this.scheduleRealtimeInstructionRefresh({
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
    const memoryEnabled = Boolean(settings?.memory?.enabled);
    const soundboardEnabled = Boolean(settings?.voice?.soundboard?.enabled);
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
}


export {
  parseVoiceDecisionContract,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
