import { PermissionFlagsBits, type ChatInputCommandInteraction, type VoiceChannelEffect } from "discord.js";
import { resolveMemoryToolNamespaceScope } from "../memory/memoryToolRuntime.ts";
import {
  getVoiceConversationPolicy,
  getVoiceRuntimeConfig,
} from "../settings/agentStack.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import { buildSingleTurnPromptLog } from "../promptLogging.ts";
import { clamp } from "../utils.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
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
  getStreamWatchNotesForPrompt,
  handleDiscoveredStreamCredentialsReceived,
  handleDiscoveredStreamDeleted,
  ingestStreamFrame,
  initializeStreamWatchState,
  isUserInSessionVoiceChannel,
  maybeTriggerStreamWatchCommentary,
  requestStopWatchingStream,
  requestStreamWatchStatus,
  requestWatchStream,
  resolveStreamWatchNoteModelSettings,
  stopWatchStreamForUser,
  supportsStreamWatchCommentary,
  supportsStreamWatchNotes
} from "./voiceStreamWatch.ts";
import {
  handleDiscoveredSelfStreamCredentialsReceived,
  handleDiscoveredSelfStreamDeleted,
  startMusicStreamPublish,
  startVisualizerStreamPublish,
  pauseMusicStreamPublish,
  stopMusicStreamPublish,
  startBrowserStreamPublish,
  stopBrowserStreamPublish
} from "./voiceStreamPublish.ts";
import { stopBrowserSessionStreamPublish } from "./voiceBrowserStreamPublish.ts";
import { setVoiceLivePromptSnapshot } from "./voicePromptState.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";
import {
  type AsrBridgeDeps,
  closeAllPerUserAsrSessions,
  closeSharedAsrSession,
  getOrCreatePerUserAsrState,
  getOrCreateSharedAsrState
} from "./voiceAsrBridge.ts";
import {
  buildRealtimeTextUtterancePrompt,
  encodePcm16MonoAsWav,
  formatVoiceChannelEffectSummary,
  inspectAsrTranscript,
  isRealtimeMode,
  normalizeVoiceRuntimeEventContext,
  normalizeInlineText,
  normalizeVoiceAddressingTargetToken,
  normalizeVoiceText,
  parseSoundboardDirectiveSequence,
  resolveTranscriberProvider,
  resolveVoiceApiTtsProvider,
  shortError
} from "./voiceSessionHelpers.ts";
import {
  normalizeRealtimeInterruptAcceptanceMode
} from "./realtimeInterruptAcceptance.ts";
import type { RealtimeInterruptAcceptanceMode } from "./realtimeInterruptAcceptance.ts";
import {
  analyzeMonoPcmSignal,
  estimateDiscordPcmPlaybackDurationMs as estimateDiscordPcmPlaybackDurationMsModule,
  estimatePcm16MonoDurationMs as estimatePcm16MonoDurationMsModule,
  evaluatePcmSilenceGate as evaluatePcmSilenceGateModule
} from "./voiceAudioAnalysis.ts";
import { logVoiceLatencyStage as logVoiceLatencyStageModule } from "./voiceLatencyTracker.ts";
import {
  annotateLatestVoiceTurnAddressing as annotateLatestVoiceTurnAddressingModule,
  buildVoiceAddressingState as buildVoiceAddressingStateModule,
  findLatestVoiceTurnIndex as findLatestVoiceTurnIndexModule,
  hasBotNameCueForTranscript as hasBotNameCueForTranscriptModule,
  mergeVoiceAddressingAnnotation as mergeVoiceAddressingAnnotationModule,
  normalizeVoiceAddressingAnnotation as normalizeVoiceAddressingAnnotationModule,
  resolveVoiceDirectAddressSignal
} from "./voiceAddressing.ts";
import {
  isAsrActive as isAsrActiveModule,
  resolveRealtimeToolOwnership as resolveRealtimeToolOwnershipModule,
  shouldHandleRealtimeFunctionCalls as shouldHandleRealtimeFunctionCallsModule,
  shouldRegisterRealtimeTools as shouldRegisterRealtimeToolsModule,
  shouldUseNativeRealtimeReply as shouldUseNativeRealtimeReplyModule,
  shouldUseTextMediatedRealtimeReply as shouldUseTextMediatedRealtimeReplyModule,
  shouldUsePerUserTranscription as shouldUsePerUserTranscriptionModule,
  shouldUseFileTurnTranscription as shouldUseFileTurnTranscriptionModule,
  shouldUseRealtimeTranscriptBridge as shouldUseRealtimeTranscriptBridgeModule,
  shouldUseSharedTranscription as shouldUseSharedTranscriptionModule
} from "./voiceConfigResolver.ts";
import {
  maybeTriggerAssistantDirectedSoundboard as maybeTriggerAssistantDirectedSoundboardModule,
  normalizeSoundboardRefs as normalizeSoundboardRefsModule
} from "./voiceSoundboard.ts";
import {
  completePendingMusicDisambiguationSelection as completePendingMusicDisambiguationSelectionModule,
  describeMusicPromptAction as describeMusicPromptActionModule,
  getMusicPromptContext as getMusicPromptContextModule,
  hasPendingMusicDisambiguationForUser as hasPendingMusicDisambiguationForUserModule,
  isMusicDisambiguationResolutionTurn as isMusicDisambiguationResolutionTurnModule,
  maybeHandlePendingMusicDisambiguationTurn as maybeHandlePendingMusicDisambiguationTurnModule,
  resolvePendingMusicDisambiguationSelection as resolvePendingMusicDisambiguationSelectionModule
} from "./voiceMusicDisambiguation.ts";
import {
  deliverVoiceThoughtCandidate as deliverVoiceThoughtCandidateModule,
  evaluateVoiceThoughtDecision as evaluateVoiceThoughtDecisionModule,
  generateVoiceThoughtCandidate as generateVoiceThoughtCandidateModule,
  loadVoiceThoughtMemoryFacts as loadVoiceThoughtMemoryFactsModule,
  resolveVoiceThoughtEngineConfig as resolveVoiceThoughtEngineConfigModule
} from "./voiceThoughtGeneration.ts";
import { buildVoiceRuntimeSnapshot } from "./voiceRuntimeSnapshot.ts";
import {
  isSystemSpeechOpportunitySource,
} from "./systemSpeechOpportunity.ts";
import { runVoiceReplyPipeline } from "./voiceReplyPipeline.ts";
import { requestJoin } from "./voiceJoinFlow.ts";
import { ASSISTANT_OUTPUT_PHASE } from "./assistantOutputState.ts";
import {
  buildVoiceConversationContext as buildVoiceConversationContextModule,
  evaluateVoiceReplyDecision as evaluateVoiceReplyDecisionModule
} from "./voiceReplyDecision.ts";
import {
  classifyVoiceInterruptBurst,
  hasObviousInterruptTakeoverBurst
} from "./voiceInterruptClassifier.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_SUPPRESSION_MAX_MS,
  BOT_DISCONNECT_GRACE_MS,
  BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
  BOT_TURN_DEFERRED_QUEUE_MAX,
  BOT_TURN_SILENCE_RESET_MS,
  INTERRUPTED_REALTIME_OUTPUT_IGNORE_TTL_MS,
  LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS,
  LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_POLL_MS,
  LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS,
  ORDERED_REALTIME_PLAYBACK_BARRIER_MAX_WAIT_MS,
  OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS,
  OPENAI_TOOL_RESPONSE_DEBOUNCE_MS,
  REALTIME_ASSISTANT_TTS_BACKPRESSURE_PAUSE_SAMPLES,
  REALTIME_ASSISTANT_TTS_BACKPRESSURE_RESUME_SAMPLES,
  RECENT_ENGAGEMENT_WINDOW_MS,
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
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_INTERRUPT_BURST_MAX_MS,
  VOICE_INTERRUPT_BURST_FINAL_QUIET_GAP_MS,
  VOICE_INTERRUPT_BURST_QUIET_GAP_MS,
  VOICE_INTERRUPT_DECISION_TTL_MS,
  VOICE_INTERRUPT_SPEECH_START_RECHECK_MS,
  VOICE_INTERRUPT_SPEECH_START_SUSTAIN_MS,
  VOICE_CHANNEL_EFFECT_EVENT_FRESH_MS,
  VOICE_CHANNEL_EFFECT_EVENT_MAX_TRACKED,
  VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT,
  VOICE_DECIDER_HISTORY_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_FRESH_MS,
  VOICE_MEMBERSHIP_EVENT_MAX_TRACKED,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
  VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
  VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS,
  VOICE_TURN_PROMOTION_ACTIVE_RATIO_MIN,
  VOICE_TURN_PROMOTION_MIN_CLIP_MS,
  VOICE_TURN_PROMOTION_PEAK_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_ACTIVE_RATIO_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_PEAK_MIN,
  VOICE_TURN_PROMOTION_STRONG_LOCAL_RMS_MIN,
  VOICE_TURN_MIN_ASR_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import { providerSupports } from "./voiceModes.ts";
import { executeRealtimeFunctionCall } from "./voiceToolCallInfra.ts";
import { hasNativeDiscordVideoDecoderSupport as hasNativeDiscordVideoDecoderSupportRuntime } from "./nativeDiscordVideoDecoder.ts";
import {
  executeVoiceMusicPlayTool,
  executeVoiceMusicQueueAddTool,
  executeVoiceMusicQueueNextTool,
  executeVoiceMusicSearchTool,
  executeVoiceVideoPlayTool,
  executeVoiceVideoSearchTool
} from "./voiceToolCallMusic.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import { executeLocalVoiceToolCall } from "./voiceToolCallDispatch.ts";
import type {
  CaptureState,
  LoggedVoicePromptBundle,
  OutputChannelState,
  RealtimeToolOwnership,
  VoiceInterruptOverlapBurstEntry,
  VoiceInterruptOverlapBurstState,
  VoiceInterruptOverlapDecision,
  VoiceInterruptOverlapUtteranceState,
  VoicePendingSpeechStartedInterrupt,
  VoicePendingInterruptBridgeTurn,
  VoiceRuntimeEventContext,
  VoiceQueuedRealtimeAssistantUtterance,
  VoiceSession
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseIsAudible,
} from "./voiceSessionTypes.ts";
import { BargeInController } from "./bargeInController.ts";
import { CaptureManager } from "./captureManager.ts";
import { DeferredActionQueue } from "./deferredActionQueue.ts";
import { InstructionManager } from "./instructionManager.ts";
import {
  hasActiveVoiceOutputLease,
  normalizeVoiceOutputLeaseMode,
  voiceOutputLeaseModesMatch
} from "./voiceOutputLease.ts";
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

const VOICE_COMMAND_SESSION_TTL_MS = 20 * 1000;
const VOICE_TOOL_FOLLOWUP_SESSION_TTL_MS = 10 * 1000;
const OPENAI_COMPLETED_TOOL_CALL_TTL_MS = 10 * 60 * 1000;
const OPENAI_COMPLETED_TOOL_CALL_MAX = 256;
const REALTIME_FUNCTION_CALL_ITEM_TYPES = new Set([
  "response.output_item.added",
  "response.output_item.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done"
]);

function resolveVoiceToolFollowupDomain(toolName: string | null = null) {
  const normalizedToolName = normalizeInlineText(toolName, 80)?.toLowerCase() || "";
  if (normalizedToolName.startsWith("music_")) return "music";
  return "tool";
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
  attentionMode: "ACTIVE" | "AMBIENT";
  currentSpeakerActive: boolean;
  recentAssistantReply: boolean;
  recentDirectAddress: boolean;
  sameAsRecentDirectAddress: boolean;
  msSinceAssistantReply: number | null;
  msSinceDirectAddress: number | null;
  activeCommandSpeaker?: string | null;
  activeCommandDomain?: string | null;
  activeCommandIntent?: string | null;
  msUntilCommandSessionExpiry?: number | null;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  interruptedAssistantReply?: {
    utteranceText: string;
    interruptedByUserId: string | null;
    interruptedBySpeakerName: string | null;
    interruptedAt: number;
    ageMs: number | null;
    source: string | null;
  } | null;
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
  runtimeEventContext?: VoiceRuntimeEventContext | null;
  replyPrompts?: LoggedVoicePromptBundle | null;
};

type VoiceTimelineTurn = {
  kind?: "speech";
  role: "assistant" | "user";
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  addressing?: VoiceAddressingAnnotation;
};

type VoiceTranscriptTimelineMembershipEntry = {
  kind: "membership";
  role: "user";
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  eventType: "join" | "leave";
  addressing?: VoiceAddressingAnnotation;
};

type VoiceTranscriptTimelineEffectEntry = {
  kind: "effect";
  role: "user";
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  effectType: "soundboard" | "emoji" | "unknown";
  summary: string;
  soundId: string | null;
  soundName: string | null;
  emoji: string | null;
  addressing?: VoiceAddressingAnnotation;
};

type VoiceTranscriptTimelineEntry =
  | VoiceTimelineTurn
  | VoiceTranscriptTimelineMembershipEntry
  | VoiceTranscriptTimelineEffectEntry;

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
  outputSummary: Record<string, unknown> | string | null;
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
  realtimeToolOwnership?: RealtimeToolOwnership | null;
  realtimeClient?: object | null;
  mcpStatus?: VoiceMcpServerStatus[];
  settingsSnapshot?: VoiceRealtimeToolSettings | null;
  realtimeToolDefinitions?: VoiceRealtimeToolDescriptor[];
  lastRealtimeToolHash?: string | null;
  lastRealtimeToolRefreshAt?: number | null;
  guildId?: string;
  textChannelId?: string;
  id?: string;
  realtimeToolResponseDebounceTimer?: ReturnType<typeof setTimeout> | null;
  realtimeToolCallExecutions?: Map<string, { startedAtMs: number; toolName: string }>;
  realtimePendingToolCalls?: Map<string, {
    callId: string;
    name: string;
    argumentsText: string;
    responseId?: string | null;
    done: boolean;
    startedAtMs: number;
    sourceEventType: string;
  }>;
  realtimePendingToolAbortControllers?: Map<string, AbortController>;
  realtimeResponsesWithAssistantOutput?: Map<string, number>;
  realtimeToolFollowupNeeded?: boolean;
  toolMusicTrackCatalog?: Map<string, unknown>;
  memoryWriteWindow?: number[];
  toolCallEvents?: VoiceToolCallEvent[];
  musicQueueState?: Record<string, unknown> | null;
  lastRealtimeToolCallerUserId?: string | null;
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
  activeReplies;
  composeOperationalMessage;
  generateVoiceTurn;
  getVoiceScreenWatchCapabilityHook;
  startVoiceScreenWatchHook;
  streamDiscovery;
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
  instructionManager;
  replyManager;
  sessionLifecycle;
  thoughtEngine;
  turnProcessor;
  onVoiceStateUpdate;
  onVoiceChannelEffectSend;

  constructor({
    client,
    store,
    appConfig,
    llm = null,
    memory = null,
    search = null,
    browserManager = null,
    activeReplies = null,
    composeOperationalMessage = null,
    generateVoiceTurn = null,
    getVoiceScreenWatchCapability = null,
    startVoiceScreenWatch = null,
    streamDiscovery = null
  }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
    this.llm = llm || null;
    this.memory = memory || null;
    this.search = search || null;
    this.browserManager = browserManager || null;
    this.activeReplies = activeReplies || null;
    this.composeOperationalMessage =
      typeof composeOperationalMessage === "function" ? composeOperationalMessage : null;
    this.generateVoiceTurn = typeof generateVoiceTurn === "function" ? generateVoiceTurn : null;
    this.getVoiceScreenWatchCapabilityHook =
      typeof getVoiceScreenWatchCapability === "function" ? getVoiceScreenWatchCapability : null;
    this.startVoiceScreenWatchHook =
      typeof startVoiceScreenWatch === "function" ? startVoiceScreenWatch : null;
    this.streamDiscovery = streamDiscovery || null;
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
    this.musicPlayer.logAction = (entry) => this.store.logAction(entry);
    this.bargeInController = new BargeInController(this);
    this.captureManager = new CaptureManager(this);
    this.deferredActionQueue = new DeferredActionQueue(this);
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
    this.onVoiceChannelEffectSend = (voiceChannelEffect: VoiceChannelEffect) => {
      this.handleVoiceChannelEffectSend(voiceChannelEffect).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: voiceChannelEffect?.guild?.id || null,
          channelId: voiceChannelEffect?.channelId || null,
          userId: this.client.user?.id || null,
          content: `voice_channel_effect_send: ${String((error as Error)?.message || error)}`
        });
      });
    };

    this.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
    this.client.on("voiceChannelEffectSend", this.onVoiceChannelEffectSend);
  }

  getSessionById(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return null;
    for (const session of this.sessions.values()) {
      if (String(session?.id || "") === normalizedSessionId) {
        return session;
      }
    }
    return null;
  }

  getSessionFactProfileSlice({ session, userId = null }) {
    const normalizedUserId = String(userId || "").trim();
    const guildProfile = session?.guildFactProfile || null;
    const participants = this.getVoiceChannelParticipants(session);
    const participantProfiles = participants.map((participant) => {
      const participantUserId = String(participant?.userId || "").trim();
      const profile = participantUserId ? session?.factProfiles?.get?.(participantUserId) || null : null;
      return {
        userId: participantUserId,
        displayName: String(participant?.displayName || participantUserId).trim() || participantUserId,
        isPrimary: participantUserId === normalizedUserId,
        facts: Array.isArray(profile?.userFacts) ? profile.userFacts : [],
        guidanceFacts: Array.isArray(profile?.guidanceFacts) ? profile.guidanceFacts : []
      };
    });
    const primaryProfile = participantProfiles.find((entry) => entry.isPrimary) || participantProfiles[0] || null;
    const selfFacts = Array.isArray(guildProfile?.selfFacts) ? guildProfile.selfFacts : [];
    const loreFacts = Array.isArray(guildProfile?.loreFacts) ? guildProfile.loreFacts : [];
    const guidanceFacts = [
      ...(Array.isArray(guildProfile?.guidanceFacts) ? guildProfile.guidanceFacts : []),
      ...participantProfiles.flatMap((entry) => Array.isArray(entry.guidanceFacts) ? entry.guidanceFacts : [])
    ];
    const secondaryFacts = participantProfiles
      .filter((entry) => !entry.isPrimary)
      .flatMap((entry) => entry.facts.slice(0, 3));
    return {
      participantProfiles,
      selfFacts,
      loreFacts,
      userFacts: Array.isArray(primaryProfile?.facts) ? primaryProfile.facts : [],
      relevantFacts: [...secondaryFacts, ...selfFacts, ...loreFacts],
      guidanceFacts
    };
  }

  primeSessionFactProfiles(session) {
    if (!session || session.ending || !this.memory) return;
    this.refreshSessionGuildFactProfile(session);
    const participants = this.getVoiceChannelParticipants(session);
    for (const participant of participants) {
      this.refreshSessionUserFactProfile(session, participant.userId);
    }
  }

  refreshSessionUserFactProfile(session, userId) {
    if (!session || session.ending || typeof this.memory?.loadUserFactProfile !== "function") return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;
    const profile = this.memory.loadUserFactProfile({
      userId: normalizedUserId,
      guildId: session.guildId
    });
    session.factProfiles.set(normalizedUserId, {
      userFacts: Array.isArray(profile?.userFacts) ? profile.userFacts : [],
      guidanceFacts: Array.isArray(profile?.guidanceFacts) ? profile.guidanceFacts : [],
      loadedAt: Date.now()
    });
  }

  refreshSessionGuildFactProfile(session) {
    if (!session || session.ending || typeof this.memory?.loadGuildFactProfile !== "function") return;
    const profile = this.memory.loadGuildFactProfile({ guildId: session.guildId });
    session.guildFactProfile = {
      selfFacts: Array.isArray(profile?.selfFacts) ? profile.selfFacts : [],
      loreFacts: Array.isArray(profile?.loreFacts) ? profile.loreFacts : [],
      guidanceFacts: Array.isArray(profile?.guidanceFacts) ? profile.guidanceFacts : [],
      loadedAt: Date.now()
    };
  }

  getVoiceScreenWatchCapability({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null
  } = {}) {
    if (typeof this.getVoiceScreenWatchCapabilityHook === "function") {
      return (
        this.getVoiceScreenWatchCapabilityHook({
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
          reason: "screen_watch_unavailable"
        }
      );
    }
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_watch_unavailable"
    };
  }

  async startVoiceScreenWatch({
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    target = null,
    targetUserId = null,
    transcript = "",
    source = "voice_realtime_tool_call",
    preferredTransport = "native",
    nativeFailureReason = null
  } = {}) {
    if (typeof this.startVoiceScreenWatchHook !== "function") {
      return {
        started: false,
        reason: "screen_watch_unavailable"
      };
    }
    return (
      await this.startVoiceScreenWatchHook({
        settings,
        guildId,
        channelId,
        requesterUserId,
        target,
        targetUserId,
        transcript,
        source,
        preferredTransport,
        nativeFailureReason
      })
    ) || {
      started: false,
      reason: "screen_watch_unavailable"
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
    return buildVoiceRuntimeSnapshot(this.sessions, {
      client: this.client,
      replyManager: this.replyManager,
      deferredActionQueue: this.deferredActionQueue,
      getVoiceChannelParticipants: (session) => this.getVoiceChannelParticipants(session),
      getRecentVoiceMembershipEvents: (session, args) => this.getRecentVoiceMembershipEvents(session, args),
      buildVoiceConversationContext: (args) => this.buildVoiceConversationContext(args),
      buildVoiceAddressingState: (args) => this.buildVoiceAddressingState(args),
      getStreamWatchNotesForPrompt: (session, settings) => this.getStreamWatchNotesForPrompt(session, settings),
      snapshotMusicRuntimeState: (session) => this.snapshotMusicRuntimeState(session)
    });
  }

  async requestJoin({ message, settings, intentConfidence = null }) {
    return await requestJoin(this, { message, settings, intentConfidence });
  }

  async requestLeave({ message, settings, reason = "nl_leave" }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    if (!this.sessions.has(guildId)) {
      await sendOperationalMessage(this, {
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
      await sendOperationalMessage(this, {
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

    await sendOperationalMessage(this, {
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
    replyHandoffMode: "duck" | "pause" | null;
    currentTrack: { id: string | null; title: string; artists: string[] } | null;
    lastTrack: { id: string | null; title: string; artists: string[] } | null;
    queueLength: number;
    upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
    lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
    lastQuery: string | null;
  } | null {
    return getMusicPromptContextModule(this, session);
  }

  describeMusicPromptAction(reason: unknown): "play_now" | "stop" | "pause" | "resume" | "skip" | null {
    return describeMusicPromptActionModule(reason);
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

  schedulePassiveMusicWakeLatchRefresh({
    session,
    settings = null,
    userId = null
  }) {
    this.replyManager.schedulePassiveMusicWakeLatchRefresh(
      session,
      settings || session?.settingsSnapshot || this.store.getSettings(),
      userId
    );
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
    return isAsrActiveModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings()
    });
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
    return hasBotNameCueForTranscriptModule({
      transcript,
      settings: settings || this.store.getSettings()
    });
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

  async playMusicViaDiscord(
    session: VoiceSession,
    track: Pick<MusicSelectionResult, "id" | "title" | "artist" | "platform" | "externalUrl">
  ) {
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
    return hasPendingMusicDisambiguationForUserModule(this, session, userId);
  }

  isMusicDisambiguationResolutionTurn(session, userId = null, transcript = "") {
    return isMusicDisambiguationResolutionTurnModule(this, session, userId, transcript);
  }

  resolvePendingMusicDisambiguationSelection(session, transcript = "") {
    return resolvePendingMusicDisambiguationSelectionModule(this, session, transcript);
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
    return await completePendingMusicDisambiguationSelectionModule(this, {
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      userId,
      selected,
      reason,
      source,
      channel,
      channelId,
      messageId,
      mustNotify
    });
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
    return await maybeHandlePendingMusicDisambiguationTurnModule(this, {
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      userId,
      transcript,
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
    musicWakeFollowupEligibleAtCapture = false,
    transcript = undefined as string | undefined
  }) {
    return await maybeHandleMusicPlaybackTurnRuntime(this, {
      session,
      settings,
      userId,
      pcmBuffer,
      captureReason,
      source,
      musicWakeFollowupEligibleAtCapture,
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

  supportsStreamWatchNotes({ session = null, settings = null } = {}) {
    return supportsStreamWatchNotes(this, { session, settings });
  }

  resolveStreamWatchNoteModelSettings(settings = null) {
    return resolveStreamWatchNoteModelSettings(this, settings);
  }

  getStreamWatchNotesForPrompt(session, settings = null) {
    return getStreamWatchNotesForPrompt(session, settings);
  }

  isUserInSessionVoiceChannel({ session, userId }) {
    return isUserInSessionVoiceChannel(this, { session, userId });
  }

  hasNativeDiscordVideoDecoderSupport() {
    return hasNativeDiscordVideoDecoderSupportRuntime();
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

  startMusicStreamPublish({ guildId, source = "music_player_state_playing", forceMode }: { guildId: string; source?: string | null; forceMode?: "video" | "visualizer" }) {
    return startMusicStreamPublish(this, {
      guildId,
      source,
      forceMode
    });
  }

  startVisualizerStreamPublish({ guildId, visualizerMode, source = "stream_visualizer_tool" }: { guildId: string; visualizerMode?: string | null; source?: string | null }) {
    return startVisualizerStreamPublish(this, {
      guildId,
      visualizerMode,
      source
    });
  }

  startBrowserStreamPublish({
    guildId,
    browserSessionId,
    currentUrl = null,
    mimeType = "image/png",
    source = "browser_session_stream_publish"
  }: {
    guildId: string;
    browserSessionId: string;
    currentUrl?: string | null;
    mimeType?: string | null;
    source?: string | null;
  }) {
    return startBrowserStreamPublish(this, {
      guildId,
      browserSessionId,
      currentUrl,
      mimeType,
      source
    });
  }

  pauseMusicStreamPublish({ guildId, reason = "music_paused" }) {
    return pauseMusicStreamPublish(this, {
      guildId,
      reason
    });
  }

  stopMusicStreamPublish({ guildId, reason = "music_stopped" }) {
    return stopMusicStreamPublish(this, {
      guildId,
      reason
    });
  }

  stopBrowserStreamPublish({
    guildId,
    reason = "browser_stream_share_stopped"
  }: {
    guildId: string;
    reason?: string | null;
  }) {
    return stopBrowserStreamPublish(this, {
      guildId,
      reason
    });
  }

  async stopBrowserSessionStreamPublish({
    guildId,
    reason = "browser_stream_share_stopped"
  }: {
    guildId: string;
    reason?: string | null;
  }) {
    return await stopBrowserSessionStreamPublish(this, {
      guildId,
      reason
    });
  }

  handleDiscoveredStreamCredentialsReceived({ stream }) {
    return handleDiscoveredStreamCredentialsReceived(this, { stream });
  }

  async handleDiscoveredStreamDeleted({ stream, settings = null }) {
    return await handleDiscoveredStreamDeleted(this, { stream, settings });
  }

  handleDiscoveredSelfStreamCredentialsReceived({ stream }) {
    return handleDiscoveredSelfStreamCredentialsReceived(this, { stream });
  }

  handleDiscoveredSelfStreamDeleted({ stream }) {
    return handleDiscoveredSelfStreamDeleted(this, { stream });
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
    settings = null,
    changeScore = undefined as number | undefined,
    emaChangeScore = undefined as number | undefined,
    isSceneCut = undefined as boolean | undefined
  }) {
    return await ingestStreamFrame(this, {
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings,
      changeScore,
      emaChangeScore,
      isSceneCut
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
    if (this.onVoiceChannelEffectSend) {
      this.client.off("voiceChannelEffectSend", this.onVoiceChannelEffectSend);
      this.onVoiceChannelEffectSend = null;
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

    try {
      await previous;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: key,
        channelId: null,
        userId: null,
        content: `voice_join_lock_previous_failed: ${String(error?.message || error)}`,
        metadata: {
          scope: "withJoinLock"
        }
      });
    }
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

  normalizeReplyInterruptionPolicy(rawPolicy = null) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : null;
    if (!policy) return null;

    const scopeRaw = String(policy.scope || "")
      .trim()
      .toLowerCase();
    const scope: "none" | "speaker" | "anyone" =
      scopeRaw === "none"
        ? "none"
        : scopeRaw === "anyone"
          ? "anyone"
          : "speaker";
    const allowedUserId = String(policy.allowedUserId || "").trim() || null;
    const talkingTo = normalizeVoiceAddressingTargetToken(policy.talkingTo || "") || null;
    const source =
      String(policy.source || "")
        .replace(/\s+/g, "_")
        .trim()
        .toLowerCase()
        .slice(0, 48) || null;
    const reason =
      String(policy.reason || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140) || null;
    const assertive =
      policy.assertive === undefined
        ? scope !== "speaker" || Boolean(allowedUserId)
        : Boolean(policy.assertive);
    if (!assertive) return null;
    if (scope === "speaker" && !allowedUserId) return null;

    return {
      assertive: true as const,
      scope,
      allowedUserId: scope === "speaker" ? allowedUserId : null,
      ...(talkingTo ? { talkingTo } : {}),
      ...(source ? { source } : {}),
      ...(reason ? { reason } : {})
    };
  }

  normalizeVoiceParticipantLookupKey(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  resolveReplyInterruptionTargetUserId({
    session = null,
    userId = null,
    talkingTo = null
  } = {}) {
    if (!session || session.ending) return null;

    const normalizedTarget = normalizeVoiceAddressingTargetToken(talkingTo || "");
    if (!normalizedTarget || normalizedTarget === "ALL") return null;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedBotUserId = String(this.client.user?.id || "").trim() || null;
    if (
      (normalizedTarget.toUpperCase() === "ME" || normalizedTarget.toUpperCase() === "SPEAKER") &&
      normalizedUserId &&
      (!normalizedBotUserId || normalizedUserId !== normalizedBotUserId)
    ) {
      return normalizedUserId;
    }

    const normalizedTargetLookup = this.normalizeVoiceParticipantLookupKey(normalizedTarget);
    if (!normalizedTargetLookup) return null;
    const speakerName = normalizedUserId ? this.resolveVoiceSpeakerName(session, normalizedUserId) : "";
    if (
      normalizedUserId &&
      this.normalizeVoiceParticipantLookupKey(speakerName) === normalizedTargetLookup &&
      (!normalizedBotUserId || normalizedUserId !== normalizedBotUserId)
    ) {
      return normalizedUserId;
    }

    const participants = this.getVoiceChannelParticipants(session)
      .filter((participant) => {
        const participantUserId = String(participant?.userId || "").trim();
        if (!participantUserId) return false;
        if (normalizedBotUserId && participantUserId === normalizedBotUserId) return false;
        return this.normalizeVoiceParticipantLookupKey(participant?.displayName || "") === normalizedTargetLookup;
      });
    if (participants.length === 1) {
      return String(participants[0]?.userId || "").trim() || null;
    }
    if (participants.length > 1 && normalizedUserId) {
      const speakerMatch = participants.find((participant) => participant.userId === normalizedUserId);
      if (speakerMatch) {
        return String(speakerMatch.userId || "").trim() || null;
      }
    }

    return null;
  }

  getDefaultReplyInterruptionMode(settings = null) {
    const resolvedSettings = settings || this.store.getSettings();
    const configuredMode = String(
      getVoiceConversationPolicy(resolvedSettings).defaultInterruptionMode ||
      DEFAULT_SETTINGS.voice.conversationPolicy.defaultInterruptionMode
    )
      .trim()
      .toLowerCase();
    if (configuredMode === "speaker") return "speaker";
    if (configuredMode === "none") return "none";
    return "anyone";
  }

  resolveReplyInterruptionPolicy({
    session = null,
    userId = null,
    policy = null,
    talkingTo = null,
    source = null,
    reason = null
  } = {}) {
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(policy);
    if (normalizedPolicy) return normalizedPolicy;
    if (!session || session.ending) return null;

    const defaultMode = this.getDefaultReplyInterruptionMode(session.settingsSnapshot || this.store.getSettings());
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedBotUserId = String(this.client.user?.id || "").trim() || null;
    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(talkingTo || "") || null;
    const effectiveTalkingTo =
      normalizedTalkingTo &&
      (normalizedTalkingTo.toUpperCase() === "ME" || normalizedTalkingTo.toUpperCase() === "SPEAKER")
        ? this.resolveVoiceSpeakerName(session, normalizedUserId) || normalizedTalkingTo
        : normalizedTalkingTo;

    if (defaultMode === "none") {
      return this.normalizeReplyInterruptionPolicy({
        assertive: true,
        scope: "none",
        allowedUserId: null,
        ...(effectiveTalkingTo ? { talkingTo: effectiveTalkingTo } : {}),
        ...(source ? { source } : {}),
        ...(reason ? { reason } : {})
      });
    }

    if (defaultMode === "anyone") {
      return this.normalizeReplyInterruptionPolicy({
        assertive: true,
        scope: "anyone",
        allowedUserId: null,
        ...(effectiveTalkingTo ? { talkingTo: effectiveTalkingTo } : {}),
        ...(source ? { source } : {}),
        ...(reason ? { reason } : {})
      });
    }

    if (!effectiveTalkingTo && source === "assistant_reply_target") {
      return this.normalizeReplyInterruptionPolicy({
        assertive: true,
        scope: "none",
        allowedUserId: null,
        source,
        reason: reason || "assistant_target_missing"
      });
    }

    if (effectiveTalkingTo === "ALL") {
      return this.normalizeReplyInterruptionPolicy({
        assertive: true,
        scope: "none",
        allowedUserId: null,
        talkingTo: effectiveTalkingTo,
        source,
        reason: reason || "assistant_target_all"
      });
    }

    if (effectiveTalkingTo) {
      const resolvedTargetUserId = this.resolveReplyInterruptionTargetUserId({
        session,
        userId: normalizedUserId,
        talkingTo: effectiveTalkingTo
      });
      if (!resolvedTargetUserId || (normalizedBotUserId && resolvedTargetUserId === normalizedBotUserId)) {
        return this.normalizeReplyInterruptionPolicy({
          assertive: true,
          scope: "none",
          allowedUserId: null,
          talkingTo: effectiveTalkingTo,
          source,
          reason: reason || "assistant_target_unresolved"
        });
      }

      return this.normalizeReplyInterruptionPolicy({
        assertive: true,
        scope: "speaker",
        allowedUserId: resolvedTargetUserId,
        talkingTo: effectiveTalkingTo,
        source,
        reason: reason || "assistant_target_speaker"
      });
    }

    // "speaker" only becomes interruptible when the reply is actually tied to a
    // specific non-bot user. Untargeted replies intentionally stay closed.
    if (
      (!normalizedUserId || (normalizedBotUserId && normalizedUserId === normalizedBotUserId))
    ) {
      return null;
    }

    return this.normalizeReplyInterruptionPolicy({
      assertive: true,
      scope: "speaker",
      allowedUserId: normalizedUserId,
      ...(source ? { source } : {}),
      ...(reason ? { reason } : {})
    });
  }

  isUserAllowedToInterruptReply({
    policy = null,
    userId = null
  } = {}) {
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(policy);
    // Closed by default: a missing/invalid policy does not imply open barge-in.
    if (!normalizedPolicy?.assertive) return false;
    if (normalizedPolicy.scope === "none") return false;
    if (normalizedPolicy.scope === "anyone") return true;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    return normalizedUserId === String(normalizedPolicy.allowedUserId || "");
  }

  shouldDirectAddressedTurnInterruptReply({
    session = null,
    directAddressed = false,
    policy = null
  } = {}) {
    if (!session || session.ending || !directAddressed) return false;
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(
      policy ||
      session.pendingResponse?.interruptionPolicy ||
      session.activeReplyInterruptionPolicy ||
      null
    );
    if (normalizedPolicy?.scope === "none") {
      const defaultMode = this.getDefaultReplyInterruptionMode(session.settingsSnapshot || this.store.getSettings());
      const normalizedReason = String(normalizedPolicy.reason || "").trim().toLowerCase();
      const isSpeakerScopedTargetClosure =
        defaultMode === "speaker" &&
        (normalizedReason === "assistant_target_all" || normalizedReason === "assistant_target_unresolved");
      if (!isSpeakerScopedTargetClosure) return false;
    }
    if (normalizedPolicy?.scope === "speaker" || normalizedPolicy?.scope === "anyone") {
      return true;
    }
    const defaultMode = this.getDefaultReplyInterruptionMode(session.settingsSnapshot || this.store.getSettings());
    return defaultMode === "speaker" || defaultMode === "anyone";
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
    const asrState = getOrCreatePerUserAsrState(session, normalizedUserId);
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

  isCaptureBlockingDeferredTurnFlush({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    const bytesSent = Math.max(0, Number(capture.bytesSent || 0));
    const signalSampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (!capture.speakingEndFinalizeTimer && bytesSent <= 0 && signalSampleCount <= 0) {
      return true;
    }
    if (!this.hasCaptureBeenPromoted(capture)) return false;
    return this.isCaptureConfirmedLiveSpeech({ session, capture });
  }

  hasDeferredTurnBlockingActiveCapture(session) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) {
      return false;
    }
    for (const capture of session.userCaptures.values()) {
      if (this.isCaptureBlockingDeferredTurnFlush({ session, capture })) {
        return true;
      }
    }
    return false;
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
      const latestItemId = String(session.lastRealtimeAssistantAudioItemId || "").trim();
      if (latestItemId) {
        truncateAttempted = true;
        truncateItemId = latestItemId;
        truncateContentIndex = Math.max(0, Number(session.lastRealtimeAssistantAudioItemContentIndex || 0));
        const estimatedReceivedMs = Math.max(0, Number(session.lastRealtimeAssistantAudioItemReceivedMs || 0));
        const reportedBufferedSamples = this.replyManager.getClankvoxReportedTtsBufferedSamples(session, {
          requireFresh: true
        });
        const estimatedUnplayedMs =
          reportedBufferedSamples != null
            ? Math.max(0, Math.round((reportedBufferedSamples / 48_000) * 1000))
            : estimateDiscordPcmPlaybackDurationMsModule(0);
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

  resolveRealtimeInterruptAcceptanceMode(session: VoiceSession): RealtimeInterruptAcceptanceMode {
    const getInterruptAcceptanceMode = session?.realtimeClient?.getInterruptAcceptanceMode;
    if (typeof getInterruptAcceptanceMode !== "function") {
      return "immediate_provider_ack";
    }
    try {
      return normalizeRealtimeInterruptAcceptanceMode(
        getInterruptAcceptanceMode.call(session.realtimeClient)
      );
    } catch {
      return "immediate_provider_ack";
    }
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

  interruptBotSpeechForDirectAddressedTurn({
    session,
    userId = null,
    source = "direct_address_output_lock"
  }) {
    return this.interruptBotSpeechForOutputLockTurn({
      session,
      userId,
      source,
      logContent: "voice_direct_address_interrupt",
      stateTrigger: "direct_address_interrupt"
    });
  }

  interruptBotSpeechForOutputLockTurn({
    session,
    userId = null,
    source = "output_lock_interrupt",
    logContent = "voice_output_lock_interrupt",
    stateTrigger = "output_lock_interrupt"
  }) {
    if (hasActiveVoiceOutputLease({ session })) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session?.guildId,
        channelId: session?.textChannelId,
        userId: userId || this.client.user?.id || null,
        content: "voice_output_lock_interrupt_blocked_output_lease",
        metadata: {
          sessionId: session?.id || null,
          source: String(source || "output_lock_interrupt"),
          stateTrigger: String(stateTrigger || "output_lock_interrupt"),
          requestId: Number(session?.outputLease?.requestId || session?.pendingResponse?.requestId || 0) || null,
          leaseMode:
            String(
              session?.outputLease?.mode ||
              session?.pendingResponse?.outputLeaseMode ||
              ""
            ).trim() || null
        }
      });
      return false;
    }
    const command = this.bargeInController.buildInterruptBotSpeechForBargeInCommand({
      session,
      userId,
      source,
      minCaptureBytes: 0,
      captureState: null
    });
    if (!command) return false;
    return this.executeInterruptBotSpeechCommand({
      session,
      command,
      logContent,
      applyBargeInSuppression: false,
      stateTrigger
    });
  }

  executeBargeInInterruptCommand({ session, command }) {
    return this.executeInterruptBotSpeechCommand({
      session,
      command,
      logContent: "voice_barge_in_interrupt",
      applyBargeInSuppression: true,
      stateTrigger: "barge_in_interrupt"
    });
  }

  executeInterruptBotSpeechCommand({
    session,
    command,
    logContent = "voice_barge_in_interrupt",
    applyBargeInSuppression = true,
    stateTrigger = "barge_in_interrupt"
  }) {
    if (!session || session.ending || !command) return false;
    const interruptAcceptanceMode = this.resolveRealtimeInterruptAcceptanceMode(session);
    const cancelTelemetry = this.cancelRealtimeResponseForBargeIn(session);
    this.clearPendingRealtimeAssistantUtterances(session, String(stateTrigger || "barge_in_interrupt"));
    const activeReplyAbortCount =
      this.activeReplies?.abortAll(
        buildVoiceReplyScopeKey(session.id),
        "Voice output interrupted"
      ) || 0;

    this.replyManager.resetBotAudioPlayback(session);
    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
      session.botTurnResetTimer = null;
    }
    session.botTurnOpen = false;
    session.botTurnOpenAt = 0;
    this.replyManager.syncAssistantOutputState(session, String(stateTrigger || "barge_in_interrupt"));

    // Unduck music immediately when speech is interrupted so the user hears the room state.
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
          source: String(stateTrigger || "barge_in_interrupt")
        }
      });
    });

    if (session.pendingResponse && typeof session.pendingResponse === "object") {
      session.lastAudioDeltaAt = Math.max(Number(session.lastAudioDeltaAt || 0), command.now);
      session.pendingResponse.audioReceivedAt = Number(session.lastAudioDeltaAt || command.now);
    }

    const responseWasActuallyCancelled = Boolean(cancelTelemetry.responseCancelSucceeded);
    const responseWasActuallyInterrupted =
      responseWasActuallyCancelled ||
      Boolean(cancelTelemetry.truncateSucceeded);
    const localPlaybackCutCommitted = true;
    const interruptAccepted =
      interruptAcceptanceMode === "local_cut_async_confirmation"
        ? localPlaybackCutCommitted
        : responseWasActuallyInterrupted;
    const providerInterruptConfirmationPending =
      interruptAcceptanceMode === "local_cut_async_confirmation" &&
      localPlaybackCutCommitted &&
      !responseWasActuallyInterrupted;
    const storeInterruptedAssistantReply =
      interruptAccepted &&
      Boolean(command.interruptedUtteranceText);
    session.interruptedAssistantReply = storeInterruptedAssistantReply
      ? {
        utteranceText: String(command.interruptedUtteranceText || ""),
        interruptedByUserId: command.userId,
        interruptedAt: command.now,
        source: command.source,
        interruptionPolicy: command.interruptionPolicy || null
      }
      : null;
    const ignoredInterruptedOutputItemId =
      cancelTelemetry.truncateSucceeded && cancelTelemetry.truncateItemId
        ? String(cancelTelemetry.truncateItemId).trim()
        : "";
    if (ignoredInterruptedOutputItemId) {
      const ignoredItems =
        session.ignoredRealtimeAssistantOutputItemIds instanceof Map
          ? session.ignoredRealtimeAssistantOutputItemIds
          : new Map<string, number>();
      session.ignoredRealtimeAssistantOutputItemIds = ignoredItems;
      ignoredItems.set(ignoredInterruptedOutputItemId, command.now);
      for (const [itemId, ignoredAt] of ignoredItems.entries()) {
        if (
          !itemId ||
          command.now - Math.max(0, Number(ignoredAt || 0)) > INTERRUPTED_REALTIME_OUTPUT_IGNORE_TTL_MS
        ) {
          ignoredItems.delete(itemId);
        }
      }
    }

    session.bargeInSuppressionUntil = applyBargeInSuppression
      ? responseWasActuallyCancelled
        ? command.now + BARGE_IN_SUPPRESSION_MAX_MS
        : command.now + BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS
      : 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: command.userId,
      content: String(logContent || "voice_barge_in_interrupt"),
      metadata: {
        sessionId: session.id,
        source: command.source,
        streamBufferedBytesDropped: 0,
        pendingRequestId: command.pendingRequestId,
        minCaptureBytes: command.minCaptureBytes,
        suppressionMs: applyBargeInSuppression
          ? responseWasActuallyCancelled
            ? BARGE_IN_SUPPRESSION_MAX_MS
            : BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS
          : 0,
        bargeInSuppressionApplied: Boolean(applyBargeInSuppression),
        captureSignalPeak: command.captureSignalPeak,
        captureSignalActiveSampleRatio: command.captureSignalActiveSampleRatio,
        captureBytesSent: command.captureBytesSent,
        botTurnOpen: command.botTurnWasOpen,
        botTurnAgeMs: command.botTurnAgeMs,
        interruptAcceptanceMode,
        localPlaybackCutCommitted,
        interruptAccepted,
        providerInterruptConfirmationPending,
        ignoredInterruptedOutputItemId: ignoredInterruptedOutputItemId || null,
        storedInterruptionContext: storeInterruptedAssistantReply,
        interruptedUtteranceLength: command.interruptedUtteranceText?.length || 0,
        activeReplyAbortCount,
        ...cancelTelemetry,
        truncateContentIndex: cancelTelemetry.truncateAttempted ? cancelTelemetry.truncateContentIndex : null,
        truncateAudioEndMs: cancelTelemetry.truncateAttempted ? cancelTelemetry.truncateAudioEndMs : null
      }
    });
    return interruptAccepted;
  }

  getOutputChannelState(session): OutputChannelState {
    const replyOutputLockState = this.replyManager.getReplyOutputLockState(session);
    const sessionInactive = !session || session.ending;
    const captureBlocking =
      !sessionInactive &&
      Number(session.userCaptures?.size || 0) > 0 &&
      this.hasDeferredTurnBlockingActiveCapture(session);
    const toolCallsRunning =
      !sessionInactive &&
      session.realtimeToolCallExecutions instanceof Map &&
      session.realtimeToolCallExecutions.size > 0;
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

    // Queue generated PCM into the clankvox client. The Bun-side client keeps
    // durable TTS backlog and only feeds a short near-term window into the
    // Rust subprocess; interruption/stop is the discard point, not age.
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
      this.turnProcessor.getRealtimeTurnBacklogSize(session) + Number(session.pendingFileAsrTurns || 0)
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
    const fileAsrTurnBacklog = Number(session?.pendingFileAsrTurns || 0);
    const turnBacklog = Math.max(0, realtimeTurnBacklog, fileAsrTurnBacklog);

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
    return resolveVoiceThoughtEngineConfigModule(settings || this.store.getSettings());
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

  async generateVoiceThoughtCandidate({
    session,
    settings,
    config,
    trigger = "timer",
    pendingThought = null
  }) {
    return generateVoiceThoughtCandidateModule(this, {
      session,
      settings,
      config,
      trigger,
      pendingThought
    });
  }

  async loadVoiceThoughtMemoryFacts({
    session,
    settings,
    thoughtCandidate
  }) {
    return loadVoiceThoughtMemoryFactsModule(this, {
      session,
      settings,
      thoughtCandidate
    });
  }

  async evaluateVoiceThoughtDecision({
    session,
    settings,
    thoughtCandidate,
    memoryFacts = [],
    topicalityBias = null,
    pendingThought = null
  }) {
    return evaluateVoiceThoughtDecisionModule(this, {
      session,
      settings,
      thoughtCandidate,
      memoryFacts,
      topicalityBias,
      pendingThought
    });
  }

  async deliverVoiceThoughtCandidate({
    session,
    settings,
    thoughtCandidate,
    trigger = "timer"
  }) {
    return deliverVoiceThoughtCandidateModule(this, {
      session,
      settings,
      thoughtCandidate,
      trigger
    });
  }

  getPendingRealtimeAssistantUtterances(session) {
    if (!session || session.ending) return [];
    if (Array.isArray(session.pendingRealtimeAssistantUtterances)) {
      return session.pendingRealtimeAssistantUtterances;
    }
    session.pendingRealtimeAssistantUtterances = [];
    return session.pendingRealtimeAssistantUtterances;
  }

  getPendingRealtimeAssistantUtteranceCount(session) {
    return this.getPendingRealtimeAssistantUtterances(session).length;
  }

  buildRealtimeAssistantUtteranceBlockerSummary(
    session,
    {
      queueDepth = 0,
      includeQueuedUtterances = false,
      backpressureActive = false,
      bufferedSamples = 0
    }: {
      queueDepth?: number | null;
      includeQueuedUtterances?: boolean;
      backpressureActive?: boolean;
      bufferedSamples?: number | null;
    } = {}
  ) {
    const normalizedQueueDepth = Number.isFinite(Number(queueDepth))
      ? Math.max(0, Math.round(Number(queueDepth)))
      : 0;
    const pendingResponse = Boolean(session?.pendingResponse && typeof session.pendingResponse === "object");
    const activeResponse = Boolean(session && this.replyManager.isRealtimeResponseActive(session));
    const deferredActiveCapture = Boolean(session && this.hasDeferredTurnBlockingActiveCapture(session));
    const outputState = session ? this.getOutputChannelState(session) : null;
    const blockers: string[] = [];
    if (includeQueuedUtterances && normalizedQueueDepth > 0) {
      blockers.push("queued_utterances");
    }
    if (activeResponse) blockers.push("active_response");
    if (pendingResponse) blockers.push("pending_response");
    // active_capture is no longer a blocker — the bot should speak while
    // humans are talking.  Deferred capture state is still tracked for
    // observability but does not block utterance drain.
    if (backpressureActive) blockers.push("tts_backpressure");

    return {
      blockers,
      activeResponse,
      pendingResponse,
      pendingResponseRequestId: Number(session?.pendingResponse?.requestId || 0) || null,
      pendingResponseSource: String(session?.pendingResponse?.source || "").trim() || null,
      deferredActiveCapture,
      backpressureActive: Boolean(backpressureActive),
      ttsBufferedSamples: Math.max(0, Number(bufferedSamples || 0)),
      outputLocked: Boolean(outputState?.locked),
      outputLockReason: outputState?.lockReason || null,
      botTurnOpen: Boolean(outputState?.botTurnOpen),
      bufferedBotSpeech: Boolean(outputState?.bufferedBotSpeech),
      openAiActiveResponse: Boolean(outputState?.openAiActiveResponse),
      awaitingToolOutputs: Boolean(outputState?.awaitingToolOutputs),
      toolCallsRunning: Boolean(outputState?.toolCallsRunning),
      deferredBlockReason: outputState?.deferredBlockReason || null
    };
  }

  maybeLogRealtimeAssistantUtteranceDrainBlocked(
    session,
    {
      reason = "response_done",
      source = null,
      queueDepth = 0,
      backpressureActive = false,
      bufferedSamples = 0
    }: {
      reason?: string;
      source?: string | null;
      queueDepth?: number | null;
      backpressureActive?: boolean;
      bufferedSamples?: number | null;
    } = {}
  ) {
    if (!session || session.ending || !isRealtimeMode(session.mode)) return false;

    const summary = this.buildRealtimeAssistantUtteranceBlockerSummary(session, {
      queueDepth,
      includeQueuedUtterances: false,
      backpressureActive,
      bufferedSamples
    });
    if (!summary.blockers.length) {
      session.lastRealtimeAssistantUtteranceDrainBlockSignature = null;
      return false;
    }

    const signature = JSON.stringify({
      reason: String(reason || "response_done"),
      source: String(source || "").trim() || null,
      queueDepth: Number.isFinite(Number(queueDepth)) ? Math.max(0, Math.round(Number(queueDepth))) : 0,
      blockers: summary.blockers,
      outputLockReason: summary.outputLockReason,
      deferredBlockReason: summary.deferredBlockReason,
      pendingResponseRequestId: summary.pendingResponseRequestId,
      pendingResponseSource: summary.pendingResponseSource,
      backpressureActive: summary.backpressureActive,
      ttsBufferedSamples: summary.ttsBufferedSamples
    });
    if (session.lastRealtimeAssistantUtteranceDrainBlockSignature === signature) {
      return true;
    }
    session.lastRealtimeAssistantUtteranceDrainBlockSignature = signature;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_assistant_utterance_drain_blocked",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "response_done"),
        source: String(source || "").trim() || null,
        queueDepth: Number.isFinite(Number(queueDepth)) ? Math.max(0, Math.round(Number(queueDepth))) : 0,
        ...summary
      }
    });
    return true;
  }

  collapsePendingRealtimeAssistantStreamTail({
    session,
    source = "voice_reply"
  }: {
    session?: VoiceSession | null;
    source?: string;
  } = {}) {
    if (!session || session.ending) return 0;
    const normalizedSource = String(source || "").trim();
    if (!normalizedSource) return 0;

    const queue = this.getPendingRealtimeAssistantUtterances(session);
    if (queue.length < 2) return 0;

    const sourcePrefix = `${normalizedSource}:stream_chunk_`;
    const lastEntry = queue[queue.length - 1];
    if (!this.isCollapsibleQueuedStreamTailEntry(lastEntry, sourcePrefix)) {
      return 0;
    }

    let tailStartIndex = queue.length - 1;
    while (tailStartIndex > 0) {
      const previousEntry = queue[tailStartIndex - 1];
      const currentEntry = queue[tailStartIndex];
      if (!this.canCollapseQueuedStreamTailEntries(previousEntry, currentEntry, sourcePrefix)) {
        break;
      }
      tailStartIndex -= 1;
    }

    const tailEntries = queue.slice(tailStartIndex);
    if (tailEntries.length < 2) return 0;

    const mergedEntry = this.mergeQueuedRealtimeAssistantUtterances(tailEntries);
    if (!mergedEntry) return 0;

    queue.splice(tailStartIndex, tailEntries.length, mergedEntry);
    this.syncRealtimeAssistantUtteranceBackpressure(session, {
      queueDepth: queue.length,
      source: mergedEntry.source,
      trigger: "stream_completed_tail_collapse"
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_assistant_utterance_tail_collapsed",
      metadata: {
        sessionId: session.id,
        source: normalizedSource,
        mergedTailCount: tailEntries.length,
        collapsedChunkCount: tailEntries.length - 1,
        queueDepth: queue.length,
        utteranceChars: mergedEntry.utteranceText?.length || 0
      }
    });
    return tailEntries.length - 1;
  }

  syncRealtimeAssistantUtteranceBackpressure(
    session,
    {
      queueDepth = null,
      source = null,
      trigger = "realtime_assistant_utterance_backpressure"
    } = {}
  ) {
    const pauseSamples = REALTIME_ASSISTANT_TTS_BACKPRESSURE_PAUSE_SAMPLES;
    const resumeSamples = REALTIME_ASSISTANT_TTS_BACKPRESSURE_RESUME_SAMPLES;
    if (!session || session.ending || !isRealtimeMode(session.mode)) {
      return {
        active: false,
        bufferedSamples: 0,
        queueDepth: 0,
        pauseSamples,
        resumeSamples
      };
    }

    const normalizedQueueDepth = Number.isFinite(Number(queueDepth))
      ? Math.max(0, Math.round(Number(queueDepth)))
      : this.getPendingRealtimeAssistantUtterances(session).length;
    const bufferedSamples = Math.max(0, Number(this.replyManager.getBufferedTtsSamples(session) || 0));
    const wasActive = Boolean(session.realtimeAssistantUtteranceBackpressureActive);
    const nextActive =
      normalizedQueueDepth <= 0
        ? false
        : wasActive
          ? bufferedSamples > resumeSamples
          : bufferedSamples >= pauseSamples;

    session.realtimeAssistantUtteranceBackpressureActive = nextActive;

    if (wasActive !== nextActive) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: nextActive
          ? "realtime_assistant_utterance_backpressure_on"
          : "realtime_assistant_utterance_backpressure_off",
        metadata: {
          sessionId: session.id,
          trigger: String(trigger || "realtime_assistant_utterance_backpressure"),
          source: String(source || "").trim() || null,
          queueDepth: normalizedQueueDepth,
          ttsBufferedSamples: bufferedSamples,
          ttsBufferedMs: Math.round(bufferedSamples / 48),
          pauseThresholdMs: Math.round(pauseSamples / 48),
          resumeThresholdMs: Math.round(resumeSamples / 48)
        }
      });
    }

    return {
      active: nextActive,
      bufferedSamples,
      queueDepth: normalizedQueueDepth,
      pauseSamples,
      resumeSamples
    };
  }

  clearPendingRealtimeAssistantUtterances(session, reason = "cleared") {
    if (!session) return 0;
    const queue = this.getPendingRealtimeAssistantUtterances(session);
    const clearedCount = queue.length;
    if (!clearedCount) return 0;
    // Capture source summary of dropped utterances before clearing
    const droppedSources: string[] = [];
    let droppedTextChars = 0;
    for (const entry of queue) {
      droppedSources.push(String(entry.source || "unknown"));
      droppedTextChars += entry.utteranceText ? entry.utteranceText.length : 0;
    }
    session.pendingRealtimeAssistantUtterances = [];
    session.lastRealtimeAssistantUtteranceDrainBlockSignature = null;
    this.syncRealtimeAssistantUtteranceBackpressure(session, {
      queueDepth: 0,
      trigger: `queue_cleared:${String(reason || "cleared")}`
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_assistant_utterance_queue_cleared",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "cleared"),
        clearedCount,
        droppedSources: droppedSources.length <= 10 ? droppedSources : droppedSources.slice(0, 10),
        droppedTextChars
      }
    });
    return clearedCount;
  }

  drainPendingRealtimeAssistantUtterances(session, reason = "response_done") {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;

    const queue = this.getPendingRealtimeAssistantUtterances(session);
    const next = queue[0];
    if (!next) {
      session.lastRealtimeAssistantUtteranceDrainBlockSignature = null;
      return false;
    }
    const backpressure = this.syncRealtimeAssistantUtteranceBackpressure(session, {
      queueDepth: queue.length,
      source: next.source,
      trigger: reason
    });
    const blockers = this.buildRealtimeAssistantUtteranceBlockerSummary(session, {
      queueDepth: queue.length,
      includeQueuedUtterances: false,
      backpressureActive: backpressure.active,
      bufferedSamples: backpressure.bufferedSamples
    });
    if (blockers.blockers.length > 0) {
      this.maybeLogRealtimeAssistantUtteranceDrainBlocked(session, {
        reason,
        source: next.source,
        queueDepth: queue.length,
        backpressureActive: backpressure.active,
        bufferedSamples: backpressure.bufferedSamples
      });
      return false;
    }

    queue.shift();
    session.lastRealtimeAssistantUtteranceDrainBlockSignature = null;

    const requested = this.sendRealtimePromptUtterance({
      session,
      prompt: next.prompt,
      userId: next.userId,
      source: next.source,
      interruptionPolicy: next.interruptionPolicy,
      outputLeaseMode: next.outputLeaseMode || null,
      latencyContext: next.latencyContext,
      utteranceText: next.utteranceText,
      musicWakeRefreshAfterSpeech: Boolean(next.musicWakeRefreshAfterSpeech)
    });
    if (!requested) {
      queue.unshift(next);
      this.maybeLogRealtimeAssistantUtteranceDrainBlocked(session, {
        reason: `${String(reason || "response_done")}:send_failed`,
        source: next.source,
        queueDepth: queue.length,
        backpressureActive: false,
        bufferedSamples: backpressure.bufferedSamples
      });
      return false;
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_assistant_utterance_queue_drained",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "response_done"),
        source: next.source,
        remainingQueueDepth: queue.length
      }
    });
    return true;
  }

  async waitForOrderedRealtimePlaybackBarrier({
    session,
    source = "voice_reply"
  }: {
    session?: VoiceSession | null;
    source?: string;
  } = {}) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return true;

    const deadlineAt = Date.now() + ORDERED_REALTIME_PLAYBACK_BARRIER_MAX_WAIT_MS;
    while (!session.ending) {
      const queue = this.getPendingRealtimeAssistantUtterances(session);
      const outputState = this.getOutputChannelState(session);
      const backpressure = this.syncRealtimeAssistantUtteranceBackpressure(session, {
        queueDepth: Math.max(1, queue.length + 1),
        source,
        trigger: "ordered_playback_barrier"
      });
      const ready =
        queue.length === 0 &&
        !outputState.pendingResponse &&
        !outputState.openAiActiveResponse &&
        !outputState.botTurnOpen &&
        !outputState.bufferedBotSpeech &&
        !backpressure.active;
      if (ready) return true;

      if (!outputState.pendingResponse && !outputState.openAiActiveResponse && queue.length > 0 && !backpressure.active) {
        this.drainPendingRealtimeAssistantUtterances(session, "ordered_playback_barrier");
      }

      if (Date.now() >= deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, LEAVE_DIRECTIVE_PLAYBACK_POLL_MS));
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "ordered_realtime_playback_barrier_timeout",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_reply"),
        queueDepth: this.getPendingRealtimeAssistantUtterances(session).length,
        pendingResponse: Boolean(session.pendingResponse),
        openAiActiveResponse: this.replyManager.isRealtimeResponseActive(session),
        botTurnOpen: Boolean(session.botTurnOpen),
        bufferedBotSpeech: this.replyManager.hasBufferedTtsPlayback(session)
      }
    });
    return false;
  }

  sendRealtimePromptUtterance({
    session,
    prompt,
    userId = null,
    source = "voice_prompt_utterance",
    interruptionPolicy = null,
    outputLeaseMode = null,
    latencyContext = null,
    utteranceText = null,
    musicWakeRefreshAfterSpeech = false
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    const requestPlaybackUtterance =
      typeof realtimeClient?.requestPlaybackUtterance === "function"
        ? realtimeClient.requestPlaybackUtterance.bind(realtimeClient)
        : typeof realtimeClient?.requestTextUtterance === "function"
          ? realtimeClient.requestTextUtterance.bind(realtimeClient)
          : null;
    if (!requestPlaybackUtterance) return false;

    const normalizedInterruptionPolicy = this.resolveReplyInterruptionPolicy({
      session,
      userId,
      policy: interruptionPolicy,
    });
    const normalizedOutputLeaseMode = normalizeVoiceOutputLeaseMode(outputLeaseMode);
    const effectiveOutputLeaseMode =
      session.botTurnOpen ? "ambient" : normalizedOutputLeaseMode;
    const normalizedUtteranceText =
      utteranceText === null
        ? null
        : normalizeVoiceText(String(utteranceText || ""), STT_REPLY_MAX_CHARS) || null;

    try {
      requestPlaybackUtterance(prompt);
      this.replyManager.createTrackedAudioResponse({
        session,
        userId: userId || this.client.user?.id || null,
        source,
        resetRetryState: true,
        emitCreateEvent: false,
        interruptionPolicy: normalizedInterruptionPolicy,
        outputLeaseMode: effectiveOutputLeaseMode,
        utteranceText: normalizedUtteranceText,
        latencyContext,
        musicWakeRefreshAfterSpeech
      });
      session.lastRequestedRealtimeUtterance = {
        utteranceText: normalizedUtteranceText,
        requestedAt: Date.now(),
        source: String(source || "voice_prompt_utterance"),
        interruptionPolicy: normalizedInterruptionPolicy,
        outputLeaseMode: effectiveOutputLeaseMode
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

  requestRealtimePromptUtterance({
    session,
    prompt,
    userId = null,
    source = "voice_prompt_utterance",
    interruptionPolicy = null,
    outputLeaseMode = null,
    latencyContext = null,
    utteranceText = null,
    musicWakeRefreshAfterSpeech = false
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    if (
      !realtimeClient ||
      (
        typeof realtimeClient.requestPlaybackUtterance !== "function" &&
        typeof realtimeClient.requestTextUtterance !== "function"
      )
    ) {
      return false;
    }

    const utterancePrompt = String(prompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, STT_REPLY_MAX_CHARS + 420);
    if (!utterancePrompt) return false;
    const normalizedInterruptionPolicy = this.resolveReplyInterruptionPolicy({
      session,
      userId,
      policy: interruptionPolicy,
    });
    const normalizedOutputLeaseMode = normalizeVoiceOutputLeaseMode(outputLeaseMode);
    const effectiveOutputLeaseMode =
      session.botTurnOpen ? "ambient" : normalizedOutputLeaseMode;
    const normalizedUtteranceText =
      utteranceText === null
        ? null
        : normalizeVoiceText(String(utteranceText || ""), STT_REPLY_MAX_CHARS) || null;
    const queue = this.getPendingRealtimeAssistantUtterances(session);
    const queuedUtterance = {
      prompt: utterancePrompt,
      utteranceText: normalizedUtteranceText,
      userId: userId || this.client.user?.id || null,
      source: String(source || "voice_prompt_utterance"),
      queuedAt: Date.now(),
      interruptionPolicy: normalizedInterruptionPolicy,
      outputLeaseMode: effectiveOutputLeaseMode,
      musicWakeRefreshAfterSpeech: Boolean(musicWakeRefreshAfterSpeech),
      latencyContext:
        latencyContext && typeof latencyContext === "object"
          ? {
            finalizedAtMs: Math.max(0, Number(latencyContext.finalizedAtMs || 0)),
            asrStartedAtMs: Math.max(0, Number(latencyContext.asrStartedAtMs || 0)),
            asrCompletedAtMs: Math.max(0, Number(latencyContext.asrCompletedAtMs || 0)),
            generationStartedAtMs: Math.max(0, Number(latencyContext.generationStartedAtMs || 0)),
            replyRequestedAtMs: Math.max(0, Number(latencyContext.replyRequestedAtMs || 0)),
            audioStartedAtMs: Math.max(0, Number(latencyContext.audioStartedAtMs || 0)),
            source: String(latencyContext.source || source || "voice_prompt_utterance"),
            captureReason: String(latencyContext.captureReason || "").trim() || null,
            queueWaitMs: Number.isFinite(Number(latencyContext.queueWaitMs))
              ? Math.max(0, Math.round(Number(latencyContext.queueWaitMs)))
              : null,
            pendingQueueDepth: Number.isFinite(Number(latencyContext.pendingQueueDepth))
              ? Math.max(0, Math.round(Number(latencyContext.pendingQueueDepth)))
              : null
          }
          : null
    };
    // Queue only when the bot's own prior speech is still in flight.
    // Active user captures are NOT a blocker — the bot should be able to
    // speak while humans are talking, just like a real person in a call.
    // The agent already decides *whether* to speak via [SKIP]; infrastructure
    // should not prevent it from speaking once that decision is made.
    const shouldQueueBecauseOutstandingReply =
      queue.length > 0 ||
      this.replyManager.isRealtimeResponseActive(session) ||
      (session.pendingResponse && typeof session.pendingResponse === "object");
    const backpressure = this.syncRealtimeAssistantUtteranceBackpressure(session, {
      queueDepth: queue.length + 1,
      source: queuedUtterance.source,
      trigger: shouldQueueBecauseOutstandingReply ? "request_queued" : "request_immediate"
    });
    const queueBlockers = this.buildRealtimeAssistantUtteranceBlockerSummary(session, {
      queueDepth: queue.length,
      includeQueuedUtterances: true,
      backpressureActive: backpressure.active,
      bufferedSamples: backpressure.bufferedSamples
    });

    if (shouldQueueBecauseOutstandingReply || backpressure.active) {
      queue.push(queuedUtterance);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "realtime_assistant_utterance_queued",
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_prompt_utterance"),
          queueDepthBeforeEnqueue: Math.max(0, queue.length - 1),
          queueDepth: queue.length,
          blockers: queueBlockers.blockers,
          activeResponse: queueBlockers.activeResponse,
          pendingResponse: queueBlockers.pendingResponse,
          pendingResponseRequestId: queueBlockers.pendingResponseRequestId,
          pendingResponseSource: queueBlockers.pendingResponseSource,
          deferredActiveCapture: queueBlockers.deferredActiveCapture,
          backpressureActive: backpressure.active,
          ttsBufferedSamples: backpressure.bufferedSamples,
          outputLocked: queueBlockers.outputLocked,
          outputLockReason: queueBlockers.outputLockReason,
          botTurnOpen: queueBlockers.botTurnOpen,
          bufferedBotSpeech: queueBlockers.bufferedBotSpeech,
          openAiActiveResponse: queueBlockers.openAiActiveResponse,
          awaitingToolOutputs: queueBlockers.awaitingToolOutputs,
          toolCallsRunning: queueBlockers.toolCallsRunning,
          deferredBlockReason: queueBlockers.deferredBlockReason
        }
      });
      return true;
    }

    return this.sendRealtimePromptUtterance({
      session,
      prompt: utterancePrompt,
      userId,
      source,
      interruptionPolicy,
      outputLeaseMode: normalizedOutputLeaseMode,
      latencyContext,
      utteranceText: normalizedUtteranceText,
      musicWakeRefreshAfterSpeech
    });
  }

  requestRealtimeTextUtterance({
    session,
    text,
    userId = null,
    source = "voice_text_utterance",
    interruptionPolicy = null,
    outputLeaseMode = null,
    latencyContext = null,
    musicWakeRefreshAfterSpeech = false
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
      outputLeaseMode,
      latencyContext,
      utteranceText: normalizedLine,
      musicWakeRefreshAfterSpeech
    });
  }

  private isCollapsibleQueuedStreamTailEntry(
    entry: VoiceQueuedRealtimeAssistantUtterance | undefined,
    sourcePrefix: string
  ) {
    if (!entry || typeof entry !== "object") return false;
    const source = String(entry.source || "");
    if (!source.startsWith(sourcePrefix)) return false;
    const sourceSuffix = source.slice(sourcePrefix.length);
    if (!/^\d+$/.test(sourceSuffix)) return false;
    return Boolean(normalizeVoiceText(entry.utteranceText || "", STT_REPLY_MAX_CHARS));
  }

  private canCollapseQueuedStreamTailEntries(
    earlierEntry: VoiceQueuedRealtimeAssistantUtterance | undefined,
    laterEntry: VoiceQueuedRealtimeAssistantUtterance | undefined,
    sourcePrefix: string
  ) {
    if (!this.isCollapsibleQueuedStreamTailEntry(earlierEntry, sourcePrefix)) return false;
    if (!this.isCollapsibleQueuedStreamTailEntry(laterEntry, sourcePrefix)) return false;
    return (
      String(earlierEntry?.userId || "") === String(laterEntry?.userId || "") &&
      Boolean(earlierEntry?.musicWakeRefreshAfterSpeech) === Boolean(laterEntry?.musicWakeRefreshAfterSpeech) &&
      this.replyInterruptionPoliciesMatch(earlierEntry?.interruptionPolicy || null, laterEntry?.interruptionPolicy || null) &&
      voiceOutputLeaseModesMatch(earlierEntry?.outputLeaseMode || null, laterEntry?.outputLeaseMode || null)
    );
  }

  private mergeQueuedRealtimeAssistantUtterances(
    entries: VoiceQueuedRealtimeAssistantUtterance[]
  ): VoiceQueuedRealtimeAssistantUtterance | null {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const firstEntry = entries[0];
    const queuedAtValues = entries
      .map((entry) => Math.max(0, Number(entry?.queuedAt || 0)))
      .filter((value) => value > 0);
    const combinedText = normalizeVoiceText(
      entries
        .map((entry) => String(entry?.utteranceText || "").trim())
        .filter(Boolean)
        .join(" "),
      STT_REPLY_MAX_CHARS
    );
    if (!combinedText) return null;

    const prompt = buildRealtimeTextUtterancePrompt(combinedText, STT_REPLY_MAX_CHARS);
    if (!prompt) return null;

    return {
      ...firstEntry,
      prompt,
      utteranceText: combinedText,
      queuedAt: queuedAtValues.length ? Math.min(...queuedAtValues) : Math.max(0, Number(firstEntry?.queuedAt || 0)),
      latencyContext: entries.find((entry) => entry?.latencyContext)?.latencyContext || null,
      musicWakeRefreshAfterSpeech: entries.some((entry) => Boolean(entry?.musicWakeRefreshAfterSpeech))
    };
  }

  private replyInterruptionPoliciesMatch(leftPolicy: unknown, rightPolicy: unknown) {
    const left = this.normalizeReplyInterruptionPolicy(leftPolicy);
    const right = this.normalizeReplyInterruptionPolicy(rightPolicy);
    if (!left && !right) return true;
    if (!left || !right) return false;
    return (
      left.assertive === right.assertive &&
      left.scope === right.scope &&
      left.allowedUserId === right.allowedUserId &&
      (left.talkingTo || null) === (right.talkingTo || null) &&
      (left.source || null) === (right.source || null) &&
      (left.reason || null) === (right.reason || null)
    );
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
      if (!normalized || !/\w/.test(normalized)) return;
      // [SKIP] is a first-class "choose silence" signal — never speak it.
      if (/^\[SKIP\]$/i.test(normalized.trim())) return;
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

    for (const reference of normalizeSoundboardRefsModule(trailingSoundboardRefs)) {
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
    finalizedAfterMs = 0,
    replyUserId = null
  }: {
    session?: VoiceSession | null;
    finalizedAfterMs?: number;
    replyUserId?: string | null;
  } = {}) {
    const pendingQueue = Array.isArray(session?.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!pendingQueue.length) {
      return {
        pendingInterruptingQueueDepth: 0,
        pendingNearSilentQueueDepth: 0,
        pendingUnconfirmedSpeechQueueDepth: 0,
        pendingOtherSpeakerQueueDepth: 0,
        totalPendingRealtimeQueueDepth: 0,
        consideredPendingRealtimeQueueDepth: 0,
        oldestConsideredFinalizedAt: null,
        newestConsideredFinalizedAt: null
      };
    }

    const finalizedAfter = Math.max(0, Number(finalizedAfterMs || 0));
    const normalizedReplyUserId = String(replyUserId || "").trim() || null;
    const sampleRateHz = Number(session?.realtimeInputSampleRateHz) || 24000;
    let pendingInterruptingQueueDepth = 0;
    let pendingNearSilentQueueDepth = 0;
    let pendingUnconfirmedSpeechQueueDepth = 0;
    let pendingOtherSpeakerQueueDepth = 0;
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
      // If ASR bridge was active (bridgeUtteranceId present) but server VAD
      // never confirmed speech, this is likely non-speech audio (humming,
      // coughing, laughing). Don't let it supersede a pending reply.
      // We trust VAD over ASR transcript here because Whisper hallucinates
      // text on non-speech audio (humming produced 37 chars of junk).
      if (queuedTurn.bridgeUtteranceId && !queuedTurn.serverVadConfirmed) {
        pendingUnconfirmedSpeechQueueDepth += 1;
        continue;
      }
      // Only the person the bot is replying to can supersede the reply.
      // Ambient chatter from other participants should not invalidate a
      // response the bot generated for a specific person. This mirrors
      // the "speaker" barge-in policy: only the reply target can take the
      // floor. Turns from other speakers are tracked for observability
      // but do not count as interrupting.
      if (normalizedReplyUserId) {
        const turnUserId = String(queuedTurn.userId || "").trim();
        if (turnUserId && turnUserId !== normalizedReplyUserId) {
          pendingOtherSpeakerQueueDepth += 1;
          continue;
        }
      }
      pendingInterruptingQueueDepth += 1;
    }

    return {
      pendingInterruptingQueueDepth,
      pendingNearSilentQueueDepth,
      pendingUnconfirmedSpeechQueueDepth,
      pendingOtherSpeakerQueueDepth,
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
    outputLeaseMode = null,
    replyUserId = null
  } = {}) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const normalizedOutputLeaseMode = normalizeVoiceOutputLeaseMode(outputLeaseMode);
    const effectiveOutputLeaseMode =
      session.botTurnOpen ? "ambient" : normalizedOutputLeaseMode;
    if (
      effectiveOutputLeaseMode !== "ambient" ||
      hasActiveVoiceOutputLease({
        session,
        requestId: Number(session.pendingResponse?.requestId || 0) || null
      })
    ) {
      return false;
    }
    const generationStartedAt = Math.max(0, Number(generationStartedAtMs || 0));
    // Only the person who triggered this reply can supersede it,
    // mirroring the "speaker" barge-in policy. Ambient chatter from
    // other participants does not invalidate a targeted response.
    // When replyUserId is null (e.g. bot-initiated greetings, system
    // events), nobody supersedes via the queue — the bot says what it
    // intended. Direct-address / wake-word interrupts still work
    // through the transcript interrupt path.
    const normalizedReplyUserId = String(replyUserId || "").trim() || null;
    if (!normalizedReplyUserId) return false;
    const pendingSummary = this.summarizeRealtimeInterruptingQueue({
      session,
      finalizedAfterMs: generationStartedAt,
      replyUserId: normalizedReplyUserId
    });
    const hasInterruptingNewerInput = pendingSummary.pendingInterruptingQueueDepth > 0;
    if (!hasInterruptingNewerInput) return false;
    const supersedeReason = "newer_finalized_realtime_turn";

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
        replyUserId: String(replyUserId || "").trim() || null,
        generationStartedAt: generationStartedAt > 0 ? generationStartedAt : null,
        pendingRealtimeQueueDepth: pendingSummary.pendingInterruptingQueueDepth,
        pendingOtherSpeakerQueueDepth: pendingSummary.pendingOtherSpeakerQueueDepth,
        totalPendingRealtimeQueueDepth: pendingSummary.totalPendingRealtimeQueueDepth,
        consideredPendingRealtimeQueueDepth: pendingSummary.consideredPendingRealtimeQueueDepth,
        pendingNearSilentQueueDepth: pendingSummary.pendingNearSilentQueueDepth,
        pendingUnconfirmedSpeechQueueDepth: pendingSummary.pendingUnconfirmedSpeechQueueDepth,
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
    outputLeaseMode = null,
    latencyContext = null,
    musicWakeRefreshAfterSpeech = false,
    replyUserId = null
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
    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicy);
    let speechStep = 0;
    let soundboardStep = 0;
    let spokeLine = false;
    let requestedRealtimeUtterance = false;
    let playedSoundboardCount = 0;
    let completed = true;
    let localSpeechPolicyActivated = false;

    // Use the triggering speaker for supersede checks so only turns from
    // the same person can invalidate a reply, mirroring barge-in semantics.
    // Falls back to the interruption policy's allowedUserId if not provided.
    const supersedeReplyUserId =
      String(replyUserId || "").trim() ||
      normalizedInterruptionPolicy?.allowedUserId ||
      null;

    if (preferRealtimeUtterance && requiresOrderedPlayback) {
      const barrierReady = await this.waitForOrderedRealtimePlaybackBarrier({
        session,
        source: String(source || "voice_reply")
      });
      if (!barrierReady) {
        return {
          completed: false,
          spokeLine: false,
          requestedRealtimeUtterance: false,
          playedSoundboardCount: 0
        };
      }
    }

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
              outputLeaseMode,
              replyUserId: supersedeReplyUserId
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
            outputLeaseMode,
            latencyContext,
            musicWakeRefreshAfterSpeech
          });
          if (requested) {
            const targetRequestId = Number(session.pendingResponse?.requestId || 0) || null;
            spokeLine = true;
            requestedRealtimeUtterance = true;
            if (requiresOrderedPlayback) {
              await this.waitForLeaveDirectivePlayback({
                session,
                expectRealtimeAudio: true,
                source: speechSource,
                targetRequestId
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
              outputLeaseMode,
              replyUserId: supersedeReplyUserId
            })
          ) {
            completed = false;
            break;
          }
          completed = false;
          break;
        }
        if (!localSpeechPolicyActivated) {
          this.setActiveReplyInterruptionPolicy(session, normalizedInterruptionPolicy);
          localSpeechPolicyActivated = true;
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
        await maybeTriggerAssistantDirectedSoundboardModule(this, {
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

    if (localSpeechPolicyActivated && !spokeLine) {
      this.maybeClearActiveReplyInterruptionPolicy(session);
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
    source = "leave_directive",
    targetRequestId = null
  }) {
    if (!session || session.ending) return;
    const hasPlaybackSignals =
      typeof session.botTurnOpen === "boolean" ||
      (expectRealtimeAudio && session.pendingResponse && typeof session.pendingResponse === "object");
    if (!hasPlaybackSignals) return;

    const waitStartedAt = Date.now();
    const normalizedTargetRequestId =
      Number.isFinite(Number(targetRequestId)) && Number(targetRequestId) > 0
        ? Math.round(Number(targetRequestId))
        : null;
    let audioRequestedAt = Math.max(
      0,
      normalizedTargetRequestId && Number(session.pendingResponse?.requestId || 0) === normalizedTargetRequestId
        ? Number(session.pendingResponse?.requestedAt || 0)
        : 0,
      normalizedTargetRequestId ? 0 : Number(session.pendingResponse?.requestedAt || 0),
      normalizedTargetRequestId ? 0 : Number(session.lastResponseRequestAt || 0)
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
      const assistantOutput = this.replyManager.syncAssistantOutputState(session, "leave_directive_playback_wait");
      const botTurnOpen = Boolean(session.botTurnOpen);
      const bufferedBotSpeech = this.replyManager.hasBufferedTtsPlayback(session);
      const pending = session.pendingResponse;
      const pendingRequestId = Number(pending?.requestId || 0) || null;
      const targetPending =
        normalizedTargetRequestId == null ? Boolean(pending) : pendingRequestId === normalizedTargetRequestId;
      const targetOutputSpeaking =
        normalizedTargetRequestId != null &&
        Number(assistantOutput?.requestId || 0) === normalizedTargetRequestId &&
        (
          assistantOutput?.phase === ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE ||
          assistantOutput?.phase === ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED
        );
      if (targetPending && Number(pending?.requestedAt || 0) > 0) {
        audioRequestedAt = Math.max(audioRequestedAt, Number(pending?.requestedAt || 0));
      }
      const pendingHasAudio =
        pending && targetPending ? this.replyManager.pendingResponseHasAudio(session, pending) : false;
      const hasPostRequestAudio = Number(session.lastAudioDeltaAt || 0) >= audioRequestedAt;

      const playbackObserved =
        normalizedTargetRequestId == null
          ? botTurnOpen || bufferedBotSpeech || pendingHasAudio || hasPostRequestAudio
          : pendingHasAudio || hasPostRequestAudio || targetOutputSpeaking;
      if (playbackObserved) {
        observedPlayback = true;
      }

      const targetSettled = normalizedTargetRequestId == null
        ? !botTurnOpen && !bufferedBotSpeech
        : observedPlayback &&
          !targetPending &&
          !targetOutputSpeaking;
      if (targetSettled) {
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
    // Active user captures no longer block bot speech — the bot speaks
    // when it has something to say, even while humans are talking.
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;
    if (!this.llm?.synthesizeSpeech) return false;

    const voiceRuntime = getVoiceRuntimeConfig(settings);
    const ttsProvider = resolveVoiceApiTtsProvider(settings);
    const apiSpeechSettings = voiceRuntime.openaiAudioApi;
    const elevenLabsSpeechSettings = voiceRuntime.elevenLabsRealtime;
    const ttsModel =
      ttsProvider === "elevenlabs"
        ? String(elevenLabsSpeechSettings?.ttsModel || "eleven_multilingual_v2").trim() || "eleven_multilingual_v2"
        : String(apiSpeechSettings?.ttsModel || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const ttsVoice =
      ttsProvider === "elevenlabs"
        ? String(elevenLabsSpeechSettings?.voiceId || "").trim()
        : String(apiSpeechSettings?.ttsVoice || "alloy").trim() || "alloy";
    const ttsSpeedRaw = Number(apiSpeechSettings?.ttsSpeed);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw) ? ttsSpeedRaw : 1;
    const ttsSampleRateHz =
      ttsProvider === "elevenlabs"
        ? Number(elevenLabsSpeechSettings?.outputSampleRateHz) || Number(session.realtimeOutputSampleRateHz) || 24000
        : 24000;
    const ttsBaseUrl =
      ttsProvider === "elevenlabs"
        ? String(elevenLabsSpeechSettings?.apiBaseUrl || "").trim() || undefined
        : undefined;

    let ttsPcm = Buffer.alloc(0);
    try {
      const tts = await this.llm.synthesizeSpeech({
        text: line,
        provider: ttsProvider,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
        responseFormat: "pcm",
        sampleRateHz: ttsSampleRateHz,
        ...(ttsBaseUrl ? { baseUrl: ttsBaseUrl } : {}),
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
      inputSampleRateHz: ttsSampleRateHz
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
    return shouldUsePerUserTranscriptionModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      hasOpenAiApiKey: Boolean(this.appConfig?.openaiApiKey)
    });
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
    return shouldUseSharedTranscriptionModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      hasOpenAiApiKey: Boolean(this.appConfig?.openaiApiKey)
    });
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
    return shouldUseRealtimeTranscriptBridgeModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings()
    });
  }

  shouldUseFileTurnTranscription({
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
    return shouldUseFileTurnTranscriptionModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings()
    });
  }

  shouldUseTranscriptOverlapInterrupts({
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
    const resolvedSettings = settings || session?.settingsSnapshot || this.store.getSettings();
    return this.shouldUsePerUserTranscription({ session, settings: resolvedSettings }) ||
      this.shouldUseSharedTranscription({ session, settings: resolvedSettings });
  }

  ensureInterruptDecisionMap(session: VoiceSession) {
    if (!(session.interruptDecisionsByUtteranceId instanceof Map)) {
      session.interruptDecisionsByUtteranceId = new Map();
    }
    return session.interruptDecisionsByUtteranceId as Map<number, VoiceInterruptOverlapUtteranceState>;
  }

  ensurePendingSpeechStartedInterruptMap(session: VoiceSession) {
    if (!(session.pendingSpeechStartedInterrupts instanceof Map)) {
      session.pendingSpeechStartedInterrupts = new Map();
    }
    return session.pendingSpeechStartedInterrupts as Map<number, VoicePendingSpeechStartedInterrupt>;
  }

  ensurePendingInterruptBridgeTurnMap(session: VoiceSession) {
    if (!(session.pendingInterruptBridgeTurns instanceof Map)) {
      session.pendingInterruptBridgeTurns = new Map();
    }
    return session.pendingInterruptBridgeTurns as Map<number, VoicePendingInterruptBridgeTurn>;
  }

  isProtectedInterruptDecisionSource(source: string | null | undefined) {
    const normalizedSource = String(source || "").trim().toLowerCase();
    return (
      normalizedSource === "speech_started_sustained" ||
      normalizedSource === "transcript_direct_address"
    );
  }

  isRetryableSpeechStartedInterruptReason(reason: string | null | undefined) {
    const normalizedReason = String(reason || "").trim().toLowerCase();
    // echo_guard_active is intentionally NOT retryable: it means "this is
    // probably the bot's own audio echoing back."  If we retry, the sustain
    // loop just waits out the guard window and then fires — defeating the
    // entire purpose of echo protection.  A denied echo guard should
    // terminate the sustain attempt so the bot can finish speaking.
    return (
      normalizedReason === "insufficient_capture_bytes" ||
      normalizedReason === "capture_signal_not_assertive" ||
      normalizedReason === "capture_signal_not_assertive_during_bot_speech" ||
      normalizedReason === "capture_too_young_for_buffered_playback"
    );
  }

  schedulePendingSpeechStartedInterruptCommit({
    session,
    utteranceId,
    reason = "sustain_window",
    delayMs = VOICE_INTERRUPT_SPEECH_START_SUSTAIN_MS
  }: {
    session: VoiceSession;
    utteranceId: number;
    reason?: string;
    delayMs?: number;
  }) {
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!session || session.ending || !normalizedUtteranceId) return false;
    const pendingSpeechStarts = this.ensurePendingSpeechStartedInterruptMap(session);
    const pendingInterrupt = pendingSpeechStarts.get(normalizedUtteranceId) || null;
    if (!pendingInterrupt) return false;
    if (pendingInterrupt.timer) {
      clearTimeout(pendingInterrupt.timer);
    }
    pendingInterrupt.timer = setTimeout(() => {
      void this.commitPendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason
      });
    }, Math.max(0, Number(delayMs || 0)));
    return true;
  }

  resolveCurrentInterruptibleOutputBinding(session: VoiceSession) {
    if (!session || session.ending) {
      return {
        assistantRequestId: null,
        assistantItemId: null
      };
    }
    const assistantOutput = this.replyManager.syncAssistantOutputState(session, "interrupt_binding_probe");
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    return {
      assistantRequestId: pendingRequestId || Number(assistantOutput?.requestId || 0) || null,
      assistantItemId: normalizeInlineText(session.lastRealtimeAssistantAudioItemId, 180) || null
    };
  }

  doesInterruptOverlapBurstStillMatchCurrentOutput(
    session: VoiceSession,
    burst: VoiceInterruptOverlapBurstState | null | undefined
  ) {
    if (!burst) return false;
    if (!this.hasInterruptibleAssistantOutput(session)) return false;
    const currentBinding = this.resolveCurrentInterruptibleOutputBinding(session);
    const trackedRequestId = Number(burst.assistantRequestId || 0) || null;
    const trackedItemId = normalizeInlineText(burst.assistantItemId, 180) || null;
    const requestMatches =
      trackedRequestId != null &&
      currentBinding.assistantRequestId != null &&
      trackedRequestId === currentBinding.assistantRequestId;
    const itemMatches =
      Boolean(trackedItemId) &&
      Boolean(currentBinding.assistantItemId) &&
      trackedItemId === currentBinding.assistantItemId;
    if (trackedRequestId != null || trackedItemId) {
      return requestMatches || itemMatches;
    }
    return true;
  }

  releasePendingSpeechStartedInterrupt({
    session,
    utteranceId,
    reason,
    flushPendingTurn = false
  }: {
    session: VoiceSession;
    utteranceId: number;
    reason: string;
    flushPendingTurn?: boolean;
  }) {
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!session || session.ending || !normalizedUtteranceId) return false;
    const pendingSpeechStarts = this.ensurePendingSpeechStartedInterruptMap(session);
    const pendingInterrupt = pendingSpeechStarts.get(normalizedUtteranceId) || null;
    if (!pendingInterrupt) return false;
    if (pendingInterrupt.timer) {
      clearTimeout(pendingInterrupt.timer);
    }
    pendingSpeechStarts.delete(normalizedUtteranceId);

    const decisions = this.ensureInterruptDecisionMap(session);
    const currentDecision = decisions.get(normalizedUtteranceId);
    if (
      currentDecision?.decision === "pending" &&
      String(currentDecision.source || "").trim().toLowerCase() === "speech_started_pending"
    ) {
      decisions.delete(normalizedUtteranceId);
    }

    let flushedPendingTurn = false;
    if (flushPendingTurn) {
      const pendingTurns = this.ensurePendingInterruptBridgeTurnMap(session);
      const pendingTurn = pendingTurns.get(normalizedUtteranceId) || null;
      if (pendingTurn) {
        pendingTurns.delete(normalizedUtteranceId);
        this.forwardRealtimeTurnFromAsrBridge({
          session,
          ...pendingTurn
        });
        flushedPendingTurn = true;
      }
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: pendingInterrupt.userId,
      content: "voice_interrupt_speech_started_released",
      metadata: {
        sessionId: session.id,
        utteranceId: normalizedUtteranceId,
        speakerName: pendingInterrupt.speakerName,
        reason: String(reason || "released"),
        flushedPendingTurn
      }
    });
    return flushedPendingTurn;
  }

  commitPendingSpeechStartedInterrupt({
    session,
    utteranceId,
    reason = "sustain_window"
  }: {
    session: VoiceSession;
    utteranceId: number;
    reason?: string;
  }) {
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!session || session.ending || !normalizedUtteranceId) return false;
    const pendingSpeechStarts = this.ensurePendingSpeechStartedInterruptMap(session);
    const pendingInterrupt = pendingSpeechStarts.get(normalizedUtteranceId) || null;
    if (!pendingInterrupt) return false;

    if (!this.hasInterruptibleAssistantOutput(session)) {
      this.releasePendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason: "assistant_output_finished",
        flushPendingTurn: true
      });
      return false;
    }

    const normalizedPendingUserId = String(pendingInterrupt.userId || "").trim() || null;
    const perUserAsrState = normalizedPendingUserId
      ? getOrCreatePerUserAsrState(session, normalizedPendingUserId)
      : null;
    const sharedAsrState = getOrCreateSharedAsrState(session);
    const matchingAsrState = (
      perUserAsrState &&
      Math.max(0, Number(perUserAsrState.speechDetectedUtteranceId || 0)) === normalizedUtteranceId
    )
      ? perUserAsrState
      : (
        sharedAsrState &&
        String(sharedAsrState.userId || "").trim() === normalizedPendingUserId &&
        Math.max(0, Number(sharedAsrState.speechDetectedUtteranceId || 0)) === normalizedUtteranceId
      )
        ? sharedAsrState
        : null;
    const providerSpeechStillActive = Boolean(
      matchingAsrState?.speechActive &&
      Math.max(0, Number(matchingAsrState?.speechDetectedUtteranceId || 0)) === normalizedUtteranceId
    );
    const localCaptureState =
      normalizedPendingUserId && session.userCaptures instanceof Map
        ? session.userCaptures.get(normalizedPendingUserId) || null
        : null;
    const localCaptureStillActive = Boolean(
      localCaptureState &&
      this.hasCaptureBeenPromoted(localCaptureState) &&
      Math.max(0, Number(localCaptureState.asrUtteranceId || 0)) === normalizedUtteranceId &&
      Math.max(0, Number(localCaptureState.bytesSent || 0)) > 0
    );
    const speechStillActive = providerSpeechStillActive || localCaptureStillActive;
    if (!speechStillActive) {
      this.releasePendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason: "speech_no_longer_active",
        flushPendingTurn: true
      });
      return false;
    }

    const captureState =
      normalizedPendingUserId && session.userCaptures instanceof Map
        ? session.userCaptures.get(normalizedPendingUserId) || null
        : null;
    const bargeEvaluation = this.bargeInController.evaluateBargeInDecision({
      session,
      userId: normalizedPendingUserId,
      captureState
    });
    if (!bargeEvaluation.allowed) {
      if (this.isRetryableSpeechStartedInterruptReason(bargeEvaluation.reason)) {
        const rescheduled = this.schedulePendingSpeechStartedInterruptCommit({
          session,
          utteranceId: normalizedUtteranceId,
          reason: "recheck_window",
          delayMs: VOICE_INTERRUPT_SPEECH_START_RECHECK_MS
        });
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: pendingInterrupt.userId,
          content: "voice_interrupt_speech_started_retry_scheduled",
          metadata: {
            sessionId: session.id,
            utteranceId: normalizedUtteranceId,
            speakerName: pendingInterrupt.speakerName,
            reason: bargeEvaluation.reason,
            retryAfterMs: VOICE_INTERRUPT_SPEECH_START_RECHECK_MS,
            minCaptureBytes: bargeEvaluation.minCaptureBytes,
            captureAgeMs: bargeEvaluation.captureAgeMs,
            captureBytesSent: bargeEvaluation.captureBytesSent,
            signalPeak: bargeEvaluation.signal.peak,
            signalRms: bargeEvaluation.signal.rms,
            signalActiveSampleRatio: bargeEvaluation.signal.activeSampleRatio,
            providerSpeechStillActive,
            localCaptureStillActive,
            outputLockReason: bargeEvaluation.outputState.lockReason,
            outputBotTurnOpen: bargeEvaluation.outputState.botTurnOpen,
            outputBufferedBotSpeech: bargeEvaluation.outputState.bufferedBotSpeech,
            outputPendingResponse: bargeEvaluation.outputState.pendingResponse,
            outputOpenAiActiveResponse: bargeEvaluation.outputState.openAiActiveResponse,
            rescheduled
          }
        });
        if (rescheduled) {
          return false;
        }
      }
      const hasStagedPendingTurn = this.ensurePendingInterruptBridgeTurnMap(session).has(normalizedUtteranceId);
      this.releasePendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason: `interrupt_commit_ineligible:${String(bargeEvaluation.reason || "unknown")}`,
        flushPendingTurn: hasStagedPendingTurn
      });
      return false;
    }

    if (pendingInterrupt.timer) {
      clearTimeout(pendingInterrupt.timer);
      pendingInterrupt.timer = null;
    }
    pendingSpeechStarts.delete(normalizedUtteranceId);

    const interrupted = this.interruptBotSpeechForOutputLockTurn({
      session,
      userId: pendingInterrupt.userId,
      source: "asr_speech_started_sustain"
    });
    if (!interrupted) {
      this.releasePendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason: "interrupt_commit_failed",
        flushPendingTurn: true
      });
      return false;
    }

    this.clearInterruptOverlapBurst(session);
    const decisions = this.ensureInterruptDecisionMap(session);
    decisions.set(normalizedUtteranceId, {
      transcript: "",
      decision: "interrupt",
      decidedAt: Date.now(),
      source: "speech_started_sustained",
      burstId: 0
    });
    this.flushPendingInterruptBridgeTurns({
      session,
      utteranceIds: [normalizedUtteranceId],
      burstId: 0
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: pendingInterrupt.userId,
      content: "voice_interrupt_on_speech_started_sustain",
      metadata: {
        sessionId: session.id,
        utteranceId: normalizedUtteranceId,
        speakerName: pendingInterrupt.speakerName,
        reason: String(reason || "sustain_window"),
        audioStartMs: pendingInterrupt.audioStartMs,
        itemId: pendingInterrupt.itemId,
        eventType: pendingInterrupt.eventType,
        sustainMs: Math.max(0, Date.now() - Math.max(0, Number(pendingInterrupt.startedAt || 0))),
        speechStillActiveSource: providerSpeechStillActive
          ? "provider_speech_started"
          : localCaptureStillActive
            ? "local_capture"
            : "unknown"
      }
    });
    return true;
  }

  hasCommittedInterruptedBridgeTurn({
    session,
    userId = null,
    bridgeUtteranceId = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    bridgeUtteranceId?: number | null;
  }) {
    if (!session || session.ending) return false;
    const normalizedUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    if (!normalizedUtteranceId) return false;
    const currentDecision = this.ensureInterruptDecisionMap(session).get(normalizedUtteranceId);
    if (currentDecision?.decision !== "interrupt") return false;
    const interruptedReply =
      session.interruptedAssistantReply && typeof session.interruptedAssistantReply === "object"
        ? session.interruptedAssistantReply
        : null;
    if (!interruptedReply) return false;
    const normalizedUserId = String(userId || "").trim() || null;
    const interruptedByUserId = String(interruptedReply.interruptedByUserId || "").trim() || null;
    if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
      return false;
    }
    const interruptedAt = Math.max(0, Number(interruptedReply.interruptedAt || 0));
    if (!interruptedAt) return false;
    if (Date.now() - interruptedAt > RECENT_ENGAGEMENT_WINDOW_MS) return false;
    return Math.max(0, Number(session.lastAssistantReplyAt || 0)) <= interruptedAt;
  }

  handoffInterruptedTurnToVoiceBrain({
    session,
    userId = null,
    reason = "interrupt_unclear",
    source = "interrupted_turn_handoff",
    bridgeUtteranceId = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    reason?: string;
    source?: string;
    bridgeUtteranceId?: number | null;
  }) {
    if (!session || session.ending) return false;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    const logSkippedHandoff = (skipReason: string) => {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_interrupt_unclear_turn_handoff_skipped",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "interrupt_unclear"),
          source: String(source || "interrupted_turn_handoff"),
          bridgeUtteranceId: normalizedBridgeUtteranceId,
          skipReason
        }
      });
    };
    if (!normalizedUserId) {
      logSkippedHandoff("missing_user_id");
      return false;
    }
    if (!normalizedBridgeUtteranceId) {
      logSkippedHandoff("missing_bridge_utterance_id");
      return false;
    }
    if (!this.hasCommittedInterruptedBridgeTurn({
      session,
      userId: normalizedUserId,
      bridgeUtteranceId: normalizedBridgeUtteranceId
    })) {
      logSkippedHandoff("missing_committed_interrupt_turn");
      return false;
    }
    const speakerName = this.resolveVoiceSpeakerName(session, normalizedUserId) || "someone";
    void this.fireVoiceRuntimeEvent({
      session,
      settings: session.settingsSnapshot || this.store.getSettings(),
      userId: normalizedUserId,
      transcript: `[${speakerName} interrupted you, but their words were unclear.]`,
      source,
      runtimeEventContext: {
        category: "generic",
        eventType: String(reason || "interrupt_unclear"),
        actorUserId: normalizedUserId,
        actorDisplayName: speakerName,
        actorRole: "other"
      }
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      content: "voice_interrupt_unclear_turn_handoff_requested",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "interrupt_unclear"),
        source: String(source || "interrupted_turn_handoff"),
        speakerName,
        bridgeUtteranceId: normalizedBridgeUtteranceId
      }
    });
    return true;
  }

  clearInterruptOverlapBurst(session: VoiceSession) {
    const burst = session.interruptOverlapBurst && typeof session.interruptOverlapBurst === "object"
      ? session.interruptOverlapBurst
      : null;
    if (!burst) return null;
    if (burst.quietTimer) {
      clearTimeout(burst.quietTimer);
      burst.quietTimer = null;
    }
    if (burst.maxTimer) {
      clearTimeout(burst.maxTimer);
      burst.maxTimer = null;
    }
    session.interruptOverlapBurst = null;
    return burst;
  }

  pruneInterruptOverlapState(session: VoiceSession, now = Date.now()) {
    const decisions = this.ensureInterruptDecisionMap(session);
    const pendingTurns = this.ensurePendingInterruptBridgeTurnMap(session);
    for (const [utteranceId, state] of decisions.entries()) {
      if (now - Math.max(0, Number(state?.decidedAt || 0)) <= VOICE_INTERRUPT_DECISION_TTL_MS) continue;
      decisions.delete(utteranceId);
      pendingTurns.delete(utteranceId);
    }
  }

  hasInterruptibleAssistantOutput(session: VoiceSession) {
    if (!session || session.ending) return false;
    const assistantOutput = this.replyManager.syncAssistantOutputState(session, "interrupt_overlap_probe");
    const assistantSpeaking =
      assistantOutput?.phase === ASSISTANT_OUTPUT_PHASE.SPEAKING_LIVE ||
      assistantOutput?.phase === ASSISTANT_OUTPUT_PHASE.SPEAKING_BUFFERED;
    const pending = session.pendingResponse && typeof session.pendingResponse === "object"
      ? session.pendingResponse
      : null;
    const pendingHasAudio = pending ? this.replyManager.pendingResponseHasAudio(session, pending) : false;
    return Boolean(session.botTurnOpen) ||
      pendingHasAudio ||
      this.replyManager.hasBufferedTtsPlayback(session) ||
      assistantSpeaking;
  }

  ensurePendingSpeechStartedInterruptFromLocalCapture({
    session,
    userId = null,
    captureState = null,
    source = "local_capture_overlap"
  }: {
    session: VoiceSession;
    userId?: string | null;
    captureState?: CaptureState | null;
    source?: string;
  }) {
    if (!session || session.ending || !captureState) return false;
    const normalizedUserId = String(userId || captureState.userId || "").trim() || null;
    if (!normalizedUserId) return false;
    const utteranceId = Math.max(0, Number(captureState.asrUtteranceId || 0)) || null;
    if (!utteranceId) return false;
    const currentDecision = this.ensureInterruptDecisionMap(session).get(utteranceId);
    if (currentDecision?.decision === "interrupt" || currentDecision?.decision === "ignore") {
      return false;
    }
    if (this.ensurePendingSpeechStartedInterruptMap(session).has(utteranceId)) {
      return true;
    }

    return this.handleAsrBridgeSpeechStarted({
      session,
      userId: normalizedUserId,
      speakerName: this.resolveVoiceSpeakerName(session, normalizedUserId),
      utteranceId,
      audioStartMs: null,
      itemId: null,
      eventType: String(source || "local_capture_overlap")
    });
  }

  handleAsrBridgeSpeechStarted({
    session,
    userId = null,
    speakerName = "someone",
    utteranceId = 0,
    audioStartMs = null,
    itemId = null,
    eventType = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    speakerName?: string;
    utteranceId?: number;
    audioStartMs?: number | null;
    itemId?: string | null;
    eventType?: string | null;
  }) {
    if (!session || session.ending) return false;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!normalizedUserId || !normalizedUtteranceId) return false;
    if (!this.shouldUseTranscriptOverlapInterrupts({ session })) return false;

    const captureState =
      session.userCaptures instanceof Map
        ? session.userCaptures.get(normalizedUserId) || null
        : null;
    if (!this.hasInterruptibleAssistantOutput(session)) return false;

    const interruptionPolicy =
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy || null;
    if (
      !this.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId: normalizedUserId
      })
    ) {
      return false;
    }

    const bargeEvaluation = this.bargeInController.evaluateBargeInDecision({
      session,
      userId: normalizedUserId,
      captureState
    });
    const shouldArmPendingInterrupt =
      bargeEvaluation.allowed ||
      this.isRetryableSpeechStartedInterruptReason(bargeEvaluation.reason);
    if (!shouldArmPendingInterrupt) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_interrupt_speech_started_ignored",
        metadata: {
          sessionId: session.id,
          utteranceId: normalizedUtteranceId,
          speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
          audioStartMs: Number.isFinite(Number(audioStartMs))
            ? Math.max(0, Math.round(Number(audioStartMs)))
            : null,
          itemId: normalizeInlineText(itemId, 180) || null,
          eventType: String(eventType || "").trim() || null,
          reason: bargeEvaluation.reason,
          minCaptureBytes: bargeEvaluation.minCaptureBytes,
          captureAgeMs: bargeEvaluation.captureAgeMs,
          captureBytesSent: bargeEvaluation.captureBytesSent,
          signalPeak: bargeEvaluation.signal.peak,
          signalRms: bargeEvaluation.signal.rms,
          signalActiveSampleRatio: bargeEvaluation.signal.activeSampleRatio,
          outputLockReason: bargeEvaluation.outputState.lockReason,
          outputBotTurnOpen: bargeEvaluation.outputState.botTurnOpen,
          outputBufferedBotSpeech: bargeEvaluation.outputState.bufferedBotSpeech,
          outputPendingResponse: bargeEvaluation.outputState.pendingResponse,
          outputOpenAiActiveResponse: bargeEvaluation.outputState.openAiActiveResponse,
          interruptionPolicyScope: interruptionPolicy?.scope || null,
          interruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null
        }
      });
      return false;
    }

    this.releasePendingSpeechStartedInterrupt({
      session,
      utteranceId: normalizedUtteranceId,
      reason: "replaced_by_new_speech_start",
      flushPendingTurn: false
    });
    const pendingSpeechStarts = this.ensurePendingSpeechStartedInterruptMap(session);
    pendingSpeechStarts.set(normalizedUtteranceId, {
      userId: normalizedUserId,
      speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
      utteranceId: normalizedUtteranceId,
      startedAt: Date.now(),
      audioStartMs: Number.isFinite(Number(audioStartMs))
        ? Math.max(0, Math.round(Number(audioStartMs)))
        : null,
      itemId: normalizeInlineText(itemId, 180) || null,
      eventType: String(eventType || "").trim() || null,
      timer: null
    });
    this.schedulePendingSpeechStartedInterruptCommit({
      session,
      utteranceId: normalizedUtteranceId,
      reason: "sustain_window",
      delayMs: VOICE_INTERRUPT_SPEECH_START_SUSTAIN_MS
    });
    const decisions = this.ensureInterruptDecisionMap(session);
    decisions.set(normalizedUtteranceId, {
      transcript: "",
      decision: "pending",
      decidedAt: Date.now(),
      source: "speech_started_pending",
      burstId: 0
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      content: "voice_interrupt_speech_started_pending",
      metadata: {
        sessionId: session.id,
        utteranceId: normalizedUtteranceId,
        speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
        audioStartMs: Number.isFinite(Number(audioStartMs))
          ? Math.max(0, Math.round(Number(audioStartMs)))
          : null,
        itemId: normalizeInlineText(itemId, 180) || null,
        eventType: String(eventType || "").trim() || null,
        interruptionPolicyScope: interruptionPolicy?.scope || null,
        interruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null,
        initialReason: bargeEvaluation.allowed ? null : bargeEvaluation.reason,
        minCaptureBytes: bargeEvaluation.minCaptureBytes,
        captureBytesSent: bargeEvaluation.captureBytesSent,
        sustainMs: VOICE_INTERRUPT_SPEECH_START_SUSTAIN_MS
      }
    });
    return true;
  }

  handleAsrBridgeSpeechStopped({
    session,
    utteranceId = 0
  }: {
    session: VoiceSession;
    userId?: string | null;
    speakerName?: string;
    utteranceId?: number;
    audioEndMs?: number | null;
    itemId?: string | null;
    eventType?: string | null;
  }) {
    if (!session || session.ending) return false;
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!normalizedUtteranceId) return false;
    return this.releasePendingSpeechStartedInterrupt({
      session,
      utteranceId: normalizedUtteranceId,
      reason: "speech_stopped_before_sustain",
      flushPendingTurn: true
    });
  }

  resolveCurrentInterruptibleUtteranceText(session: VoiceSession) {
    const pendingText = normalizeVoiceText(session.pendingResponse?.utteranceText || "", STT_REPLY_MAX_CHARS);
    if (pendingText) return pendingText;
    const lastRequestedText = normalizeVoiceText(session.lastRequestedRealtimeUtterance?.utteranceText || "", STT_REPLY_MAX_CHARS);
    if (lastRequestedText) return lastRequestedText;
    return normalizeVoiceText(session.interruptedAssistantReply?.utteranceText || "", STT_REPLY_MAX_CHARS);
  }

  stagePendingInterruptBridgeTurn({
    session,
    userId,
    pcmBuffer,
    captureReason,
    finalizedAt,
    musicWakeFollowupEligibleAtCapture,
    bridgeUtteranceId,
    asrResult,
    source,
    serverVadConfirmed
  }: VoicePendingInterruptBridgeTurn & {
    session: VoiceSession;
  }) {
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    if (!normalizedBridgeUtteranceId) return;
    const pendingTurns = this.ensurePendingInterruptBridgeTurnMap(session);
    pendingTurns.set(normalizedBridgeUtteranceId, {
      userId,
      pcmBuffer,
      captureReason,
      finalizedAt,
      musicWakeFollowupEligibleAtCapture,
      bridgeUtteranceId: normalizedBridgeUtteranceId,
      asrResult,
      source,
      serverVadConfirmed: Boolean(serverVadConfirmed)
    });
  }

  discardPendingInterruptBridgeTurns({
    session,
    utteranceIds,
    burstId,
    reason
  }: {
    session: VoiceSession;
    utteranceIds: number[];
    burstId: number;
    reason: string;
  }) {
    const pendingTurns = this.ensurePendingInterruptBridgeTurnMap(session);
    const decisions = this.ensureInterruptDecisionMap(session);
    let droppedCount = 0;
    for (const utteranceId of utteranceIds) {
      const currentState = decisions.get(utteranceId);
      if (currentState && Number(currentState.burstId || 0) > burstId) continue;
      if (pendingTurns.delete(utteranceId)) {
        droppedCount += 1;
      }
    }
    if (droppedCount > 0) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: null,
        content: "openai_realtime_asr_bridge_interrupt_ignored",
        metadata: {
          sessionId: session.id,
          burstId,
          droppedCount,
          reason: String(reason || "ignore")
        }
      });
    }
  }

  flushPendingInterruptBridgeTurns({
    session,
    utteranceIds,
    burstId
  }: {
    session: VoiceSession;
    utteranceIds: number[];
    burstId: number;
  }) {
    const pendingTurns = this.ensurePendingInterruptBridgeTurnMap(session);
    const decisions = this.ensureInterruptDecisionMap(session);
    for (const utteranceId of [...utteranceIds].sort((a, b) => a - b)) {
      const currentState = decisions.get(utteranceId);
      if (currentState && Number(currentState.burstId || 0) > burstId) continue;
      const pendingTurn = pendingTurns.get(utteranceId);
      if (!pendingTurn) continue;
      pendingTurns.delete(utteranceId);
      this.forwardRealtimeTurnFromAsrBridge({
        session,
        ...pendingTurn
      });
    }
  }

  async resolveInterruptOverlapBurst(session: VoiceSession, reason = "quiet_gap") {
    if (!session || session.ending) return;
    const burst = this.clearInterruptOverlapBurst(session);
    if (!burst || burst.evaluating || burst.entries.length === 0) return;
    burst.evaluating = true;
    const settings = session.settingsSnapshot || this.store.getSettings();
    const decisions = this.ensureInterruptDecisionMap(session);
    const interruptionPolicy =
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy || null;
    const traceUserId =
      [...burst.entries]
        .reverse()
        .map((entry) => String(entry.userId || "").trim() || null)
        .find(Boolean) || null;
    const classifierEnabled = getVoiceConversationPolicy(settings).useInterruptClassifier !== false;
    const result = await classifyVoiceInterruptBurst(this, {
      session,
      settings,
      interruptedUtteranceText:
        normalizeVoiceText(burst.assistantUtteranceText || "", STT_REPLY_MAX_CHARS) ||
        this.resolveCurrentInterruptibleUtteranceText(session),
      entries: burst.entries,
      traceUserId,
      skipLlm: !classifierEnabled
    });
    const decidedAt = Date.now();
    const latestTranscriptByUtteranceId = new Map<number, string>();
    for (const entry of burst.entries) {
      latestTranscriptByUtteranceId.set(
        entry.utteranceId,
        normalizeVoiceText(entry.transcript, STT_REPLY_MAX_CHARS)
      );
    }

    if (result.decision === "interrupt" && !this.doesInterruptOverlapBurstStillMatchCurrentOutput(session, burst)) {
      const currentBinding = this.resolveCurrentInterruptibleOutputBinding(session);
      for (const utteranceId of burst.utteranceIds) {
        const currentState = decisions.get(utteranceId);
        if (this.isProtectedInterruptDecisionSource(currentState?.source)) continue;
        if (currentState && Number(currentState.burstId || 0) > burst.id) continue;
        decisions.set(utteranceId, {
          transcript: latestTranscriptByUtteranceId.get(utteranceId) || currentState?.transcript || "",
          decision: "ignore",
          decidedAt,
          source: "stale_output_forwarded",
          burstId: burst.id
        });
      }
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: traceUserId,
        content: "voice_interrupt_overlap_burst_stale_output_forwarded",
        metadata: {
          sessionId: session.id,
          burstId: burst.id,
          reason: String(reason || "quiet_gap"),
          burstAssistantRequestId: burst.assistantRequestId,
          burstAssistantItemId: burst.assistantItemId,
          currentAssistantRequestId: currentBinding.assistantRequestId,
          currentAssistantItemId: currentBinding.assistantItemId,
          utteranceIds: burst.utteranceIds
        }
      });
      this.flushPendingInterruptBridgeTurns({
        session,
        utteranceIds: burst.utteranceIds,
        burstId: burst.id
      });
      return;
    }

    for (const utteranceId of burst.utteranceIds) {
      const currentState = decisions.get(utteranceId);
      if (this.isProtectedInterruptDecisionSource(currentState?.source)) continue;
      if (currentState && Number(currentState.burstId || 0) > burst.id) continue;
      decisions.set(utteranceId, {
        transcript: latestTranscriptByUtteranceId.get(utteranceId) || currentState?.transcript || "",
        decision: result.decision,
        decidedAt,
        source: result.source,
        burstId: burst.id
      });
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: traceUserId,
      content: "voice_interrupt_overlap_burst_resolved",
      metadata: {
        sessionId: session.id,
        burstId: burst.id,
        reason: String(reason || "quiet_gap"),
        decision: result.decision,
        source: result.source,
        latencyMs: Math.max(0, Number(result.latencyMs || 0)),
        utteranceIds: burst.utteranceIds,
        entryCount: burst.entries.length
      }
    });

    if (result.decision === "interrupt") {
      // Only allow the interrupt if at least one burst entry comes from a
      // user authorized by the active reply's interruption policy.  In a
      // multi-person VC, someone saying "wait" to another participant
      // should not cut the bot's reply to a different listener.
      const interruptUserId =
        [...burst.entries]
          .reverse()
          .map((entry) => String(entry.userId || "").trim() || null)
          .find((candidate) =>
            Boolean(candidate) &&
            this.isUserAllowedToInterruptReply({
              policy: interruptionPolicy,
              userId: candidate
            })
          ) ||
        null;
      const interrupted = interruptUserId
        ? this.interruptBotSpeechForOutputLockTurn({
          session,
          userId: interruptUserId,
          source: `asr_overlap_burst:${String(reason || "quiet_gap")}`
        })
        : false;
      if (!interrupted) {
        for (const utteranceId of burst.utteranceIds) {
          const currentState = decisions.get(utteranceId);
          if (this.isProtectedInterruptDecisionSource(currentState?.source)) continue;
          if (currentState && Number(currentState.burstId || 0) > burst.id) continue;
          decisions.set(utteranceId, {
            transcript: latestTranscriptByUtteranceId.get(utteranceId) || currentState?.transcript || "",
            decision: "ignore",
            decidedAt,
            source: "interrupt_uncommitted_forwarded",
            burstId: burst.id
          });
        }
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: interruptUserId,
          content: "voice_interrupt_overlap_burst_uncommitted_forwarded",
          metadata: {
            sessionId: session.id,
            burstId: burst.id,
            reason: String(reason || "quiet_gap"),
            source: result.source,
            utteranceIds: burst.utteranceIds
          }
        });
      }
      this.flushPendingInterruptBridgeTurns({
        session,
        utteranceIds: burst.utteranceIds,
        burstId: burst.id
      });
      return;
    }

    this.discardPendingInterruptBridgeTurns({
      session,
      utteranceIds: burst.utteranceIds,
      burstId: burst.id,
      reason: result.source
    });
  }

  handleAsrBridgeTranscriptOverlapSegment({
    session,
    userId = null,
    speakerName = "someone",
    transcript = "",
    utteranceId = 0,
    isFinal = false,
    eventType = null,
    itemId = null,
    previousItemId = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    speakerName?: string;
    transcript?: string;
    utteranceId?: number;
    isFinal?: boolean;
    eventType?: string | null;
    itemId?: string | null;
    previousItemId?: string | null;
  }) {
    if (!session || session.ending) return;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    const normalizedUtteranceId = Math.max(0, Number(utteranceId || 0)) || null;
    if (!normalizedTranscript || !normalizedUtteranceId) return;
    if (!this.shouldUseTranscriptOverlapInterrupts({ session })) return;
    if (!this.hasInterruptibleAssistantOutput(session)) return;

    const normalizedUserId = String(userId || "").trim() || null;
    this.pruneInterruptOverlapState(session);
    const decisions = this.ensureInterruptDecisionMap(session);
    const existingState = decisions.get(normalizedUtteranceId);
    if (existingState?.decision === "interrupt" && this.isProtectedInterruptDecisionSource(existingState.source)) {
      return;
    }
    if (
      existingState &&
      existingState.decision !== "pending" &&
      existingState.transcript === normalizedTranscript
    ) {
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const interruptionPolicy =
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy || null;
    const directAddressSignal = resolveVoiceDirectAddressSignal({
      transcript: normalizedTranscript,
      settings
    });
    if (
      directAddressSignal.directAddressed &&
      this.shouldDirectAddressedTurnInterruptReply({
        session,
        directAddressed: true,
        policy: interruptionPolicy
      })
    ) {
      this.releasePendingSpeechStartedInterrupt({
        session,
        utteranceId: normalizedUtteranceId,
        reason: "direct_address_override",
        flushPendingTurn: false
      });
      const interrupted = this.interruptBotSpeechForDirectAddressedTurn({
        session,
        userId: normalizedUserId,
        source: "asr_transcript_direct_address"
      });
      if (!interrupted) return;
      this.clearInterruptOverlapBurst(session);
      decisions.set(normalizedUtteranceId, {
        transcript: normalizedTranscript,
        decision: "interrupt",
        decidedAt: Date.now(),
        source: "transcript_direct_address",
        burstId: 0
      });
      this.flushPendingInterruptBridgeTurns({
        session,
        utteranceIds: [normalizedUtteranceId],
        burstId: 0
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_interrupt_on_transcript_direct_address",
        metadata: {
          sessionId: session.id,
          utteranceId: normalizedUtteranceId,
          speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
          transcript: normalizedTranscript,
          eventType: String(eventType || "").trim() || null,
          itemId: normalizeInlineText(itemId, 180) || null
        }
      });
      return;
    }

    if (
      this.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId: normalizedUserId
      }) &&
      existingState?.decision === "pending"
    ) {
      decisions.set(normalizedUtteranceId, {
        ...existingState,
        transcript: normalizedTranscript,
        decidedAt: Date.now()
      });
      return;
    }

    const useInterruptClassifier = getVoiceConversationPolicy(settings).useInterruptClassifier !== false;
    if (!useInterruptClassifier && interruptionPolicy?.scope === "speaker") {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_interrupt_overlap_skipped_classifier_disabled",
        metadata: {
          sessionId: session.id,
          utteranceId: normalizedUtteranceId,
          speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
          transcript: normalizedTranscript
        }
      });
      return;
    }

    let burst = session.interruptOverlapBurst && typeof session.interruptOverlapBurst === "object"
      ? session.interruptOverlapBurst
      : null;
    if (!burst || burst.evaluating) {
      const currentBinding = this.resolveCurrentInterruptibleOutputBinding(session);
      const nextBurstId = Math.max(0, Number(session.nextInterruptBurstId || 0)) + 1;
      session.nextInterruptBurstId = nextBurstId;
      burst = {
        id: nextBurstId,
        openedAt: Date.now(),
        lastTranscriptAt: Date.now(),
        assistantUtteranceText: this.resolveCurrentInterruptibleUtteranceText(session),
        assistantRequestId: currentBinding.assistantRequestId,
        assistantItemId: currentBinding.assistantItemId,
        quietTimer: null,
        maxTimer: null,
        evaluating: false,
        entries: [],
        utteranceIds: []
      };
      session.interruptOverlapBurst = burst;
    }

    const nextEntry: VoiceInterruptOverlapBurstEntry = {
      userId: normalizedUserId,
      speakerName: normalizeInlineText(speakerName, 80) || this.resolveVoiceSpeakerName(session, normalizedUserId),
      transcript: normalizedTranscript,
      utteranceId: normalizedUtteranceId,
      isFinal: Boolean(isFinal),
      receivedAt: Date.now(),
      eventType: String(eventType || "").trim() || null,
      itemId: normalizeInlineText(itemId, 180) || null,
      previousItemId: normalizeInlineText(previousItemId, 180) || null
    };
    const existingEntryIndex = burst.entries.findIndex((entry) => entry.utteranceId === normalizedUtteranceId);
    if (existingEntryIndex >= 0) {
      burst.entries[existingEntryIndex] = nextEntry;
    } else {
      burst.entries.push(nextEntry);
    }
    if (!burst.utteranceIds.includes(normalizedUtteranceId)) {
      burst.utteranceIds.push(normalizedUtteranceId);
    }
    burst.lastTranscriptAt = Date.now();
    if (!burst.assistantUtteranceText) {
      burst.assistantUtteranceText = this.resolveCurrentInterruptibleUtteranceText(session);
    }

    decisions.set(normalizedUtteranceId, {
      transcript: normalizedTranscript,
      decision: "pending",
      decidedAt: Date.now(),
      source: "burst_open",
      burstId: burst.id
    });

    if (burst.quietTimer) {
      clearTimeout(burst.quietTimer);
    }
    const quietDelayMs = isFinal
      ? VOICE_INTERRUPT_BURST_FINAL_QUIET_GAP_MS
      : VOICE_INTERRUPT_BURST_QUIET_GAP_MS;
    burst.quietTimer = setTimeout(() => {
      void this.resolveInterruptOverlapBurst(session, "quiet_gap");
    }, quietDelayMs);
    if (!burst.maxTimer) {
      burst.maxTimer = setTimeout(() => {
        void this.resolveInterruptOverlapBurst(session, "max_window");
      }, VOICE_INTERRUPT_BURST_MAX_MS);
    }

    if (hasObviousInterruptTakeoverBurst(burst.entries)) {
      void this.resolveInterruptOverlapBurst(session, "fast_takeover");
    }
  }

  forwardRealtimeTurnFromAsrBridge({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    finalizedAt = 0,
    musicWakeFollowupEligibleAtCapture = false,
    bridgeUtteranceId = null,
    asrResult = null,
    source = "unknown",
    serverVadConfirmed = false
  }: {
    session: VoiceSession;
    userId: string;
    pcmBuffer?: Buffer | null;
    captureReason?: string;
    finalizedAt?: number;
    musicWakeFollowupEligibleAtCapture?: boolean;
    bridgeUtteranceId?: number | null;
    asrResult?: {
      transcript?: string | null;
      asrStartedAtMs?: number | null;
      asrCompletedAtMs?: number | null;
      transcriptionModelPrimary?: string | null;
      transcriptionModelFallback?: string | null;
      transcriptionPlanReason?: string | null;
      usedFallbackModel?: boolean;
      transcriptLogprobs?: unknown[] | null;
    } | null;
    source?: string;
    serverVadConfirmed?: boolean;
  }) {
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const transcriptGuard = inspectAsrTranscript(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
    const transcript = transcriptGuard.malformed ? "" : transcriptGuard.transcript;
    const clipDurationMs = this.estimatePcm16MonoDurationMs(
      normalizedPcmBuffer.length,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    this.turnProcessor.queueRealtimeTurn({
      session,
      userId,
      captureReason,
      finalizedAt,
      musicWakeFollowupEligibleAtCapture,
      bridgeUtteranceId: Math.max(0, Number(bridgeUtteranceId || 0)) || null,
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
        : null,
      serverVadConfirmed: Boolean(serverVadConfirmed)
    });
    return true;
  }

  // ── ASR bridge deps factory & delegation ─────────────────────────────

  buildAsrBridgeDeps(session): AsrBridgeDeps {
    return {
      session,
      appConfig: this.appConfig,
      store: this.store,
      botUserId: this.client.user?.id || null,
      resolveVoiceSpeakerName: (s, userId) => this.resolveVoiceSpeakerName(s, userId),
      handleSpeechStarted: (payload) => this.handleAsrBridgeSpeechStarted(payload),
      handleSpeechStopped: (payload) => this.handleAsrBridgeSpeechStopped(payload),
      handleTranscriptOverlapSegment: (payload) => this.handleAsrBridgeTranscriptOverlapSegment(payload)
    };
  }

  queueRealtimeTurnFromAsrBridge({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    finalizedAt = 0,
    musicWakeFollowupEligibleAtCapture = false,
    bridgeUtteranceId = null,
    asrResult = null,
    source = "unknown",
    serverVadConfirmed = false
  }) {
    if (!session || session.ending) return false;
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    const committedInterruptedTurn = this.hasCommittedInterruptedBridgeTurn({
      session,
      userId,
      bridgeUtteranceId: normalizedBridgeUtteranceId
    });
    const transcriptGuard = inspectAsrTranscript(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
    const transcript = transcriptGuard.malformed ? "" : transcriptGuard.transcript;
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
        content: transcriptGuard.malformed
          ? "openai_realtime_asr_bridge_control_token_dropped"
          : "openai_realtime_asr_bridge_empty_dropped",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          source: String(source || "unknown"),
          pcmBytes: normalizedPcmBuffer.length,
          clipDurationMs,
          asrResultAvailable: Boolean(asrResult),
          controlTokenCount: transcriptGuard.controlTokenCount,
          reservedAudioMarkerCount: transcriptGuard.reservedAudioMarkerCount
        }
      });
      const handedOffInterruptedTurn = this.handoffInterruptedTurnToVoiceBrain({
        session,
        userId,
        bridgeUtteranceId: normalizedBridgeUtteranceId,
        reason: committedInterruptedTurn
          ? transcriptGuard.malformed
            ? "control_token_asr_bridge_drop_after_interrupt"
            : "empty_asr_bridge_drop_after_interrupt"
          : transcriptGuard.malformed
            ? "control_token_asr_bridge_drop"
            : "empty_asr_bridge_drop",
        source: committedInterruptedTurn
          ? "interrupted_empty_asr_bridge_turn"
          : transcriptGuard.malformed
            ? "control_token_asr_bridge_turn"
            : "unclear_empty_asr_bridge_turn"
      });
      const noTurnResolutionReason = transcriptGuard.malformed
        ? "control_token_asr_bridge_drop"
        : "empty_asr_bridge_drop";
      this.deferredActionQueue.recheckDeferredVoiceActions({
        session,
        reason: noTurnResolutionReason
      });
      if (!handedOffInterruptedTurn) {
        this.drainPendingRealtimeAssistantUtterances(session, noTurnResolutionReason);
      }
      return Boolean(handedOffInterruptedTurn);
    }

    if (
      normalizedBridgeUtteranceId &&
      this.shouldUseTranscriptOverlapInterrupts({ session }) &&
      this.hasInterruptibleAssistantOutput(session)
    ) {
      const decisions = this.ensureInterruptDecisionMap(session);
      const interruptionPolicy =
        session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy || null;
      const settings = session.settingsSnapshot || this.store.getSettings();
      const directAddressSignal = resolveVoiceDirectAddressSignal({
        transcript,
        settings
      });
      let currentDecision = decisions.get(normalizedBridgeUtteranceId);
      if (
        directAddressSignal.directAddressed &&
        (!currentDecision || currentDecision.decision === "pending")
      ) {
        this.handleAsrBridgeTranscriptOverlapSegment({
          session,
          userId,
          speakerName: this.resolveVoiceSpeakerName(session, userId),
          transcript,
          utteranceId: normalizedBridgeUtteranceId,
          isFinal: true,
          eventType: "bridge_commit",
          itemId: null,
          previousItemId: null
        });
        currentDecision = decisions.get(normalizedBridgeUtteranceId);
      }
      const committedInterrupt = currentDecision?.decision === "interrupt";
      const policyAllowedSpeaker = this.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId
      });
      const hasPendingSpeechStartedInterrupt = this.ensurePendingSpeechStartedInterruptMap(session).has(
        normalizedBridgeUtteranceId
      );
      if (
        !committedInterrupt &&
        !policyAllowedSpeaker &&
        (!currentDecision || currentDecision.transcript !== transcript)
      ) {
        this.handleAsrBridgeTranscriptOverlapSegment({
          session,
          userId,
          speakerName: this.resolveVoiceSpeakerName(session, userId),
          transcript,
          utteranceId: normalizedBridgeUtteranceId,
          isFinal: true,
          eventType: "bridge_commit",
          itemId: null,
          previousItemId: null
        });
        currentDecision = decisions.get(normalizedBridgeUtteranceId);
      }
      if (currentDecision?.decision === "pending") {
        this.stagePendingInterruptBridgeTurn({
          session,
          userId,
          pcmBuffer: normalizedPcmBuffer,
          captureReason,
          finalizedAt,
          musicWakeFollowupEligibleAtCapture,
          bridgeUtteranceId: normalizedBridgeUtteranceId,
          asrResult,
          source,
          serverVadConfirmed: Boolean(serverVadConfirmed)
        });
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "openai_realtime_asr_bridge_interrupt_pending",
          metadata: {
            sessionId: session.id,
            bridgeUtteranceId: normalizedBridgeUtteranceId,
            source: String(source || "unknown"),
            decisionSource: currentDecision?.source || null,
            pendingSpeechStartedInterrupt: hasPendingSpeechStartedInterrupt
          }
        });
        return false;
      }
      if (currentDecision?.decision === "ignore") {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "openai_realtime_asr_bridge_interrupt_ignored",
          metadata: {
            sessionId: session.id,
            bridgeUtteranceId: normalizedBridgeUtteranceId,
            source: String(source || "unknown")
          }
        });
        this.ensurePendingInterruptBridgeTurnMap(session).delete(normalizedBridgeUtteranceId);
        return false;
      }
    }

    return this.forwardRealtimeTurnFromAsrBridge({
      session,
      userId,
      pcmBuffer: normalizedPcmBuffer,
      captureReason,
      finalizedAt,
      musicWakeFollowupEligibleAtCapture,
      bridgeUtteranceId: normalizedBridgeUtteranceId,
      asrResult,
      source,
      serverVadConfirmed: Boolean(serverVadConfirmed)
    });
  }

  estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
    return estimatePcm16MonoDurationMsModule(pcmByteLength, sampleRateHz);
  }

  evaluatePcmSilenceGate({ pcmBuffer, sampleRateHz = 24000 }) {
    return evaluatePcmSilenceGateModule({
      pcmBuffer,
      sampleRateHz
    });
  }

  logVoiceLatencyStage(payload = null) {
    return logVoiceLatencyStageModule(this, {
      ...(payload && typeof payload === "object" ? payload : {}),
      botUserId: this.client.user?.id || null
    });
  }

  shouldUseTextMediatedRealtimeReply({ session, settings = null }) {
    return shouldUseTextMediatedRealtimeReplyModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings()
    });
  }

  resolveRealtimeToolOwnership({ session, settings = null, mode = null }) {
    return resolveRealtimeToolOwnershipModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      mode
    });
  }

  shouldRegisterRealtimeTools({ session, settings = null, mode = null }) {
    return shouldRegisterRealtimeToolsModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      mode
    });
  }

  shouldHandleRealtimeFunctionCalls({ session, settings = null, mode = null }) {
    return shouldHandleRealtimeFunctionCallsModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings(),
      mode
    });
  }

  shouldUseNativeRealtimeReply({ session, settings = null }) {
    return shouldUseNativeRealtimeReplyModule({
      session,
      settings: settings || session?.settingsSnapshot || this.store.getSettings()
    });
  }

  clearDeferredQueuedUserTurns(session) {
    if (!session || session.ending) return;
    this.deferredActionQueue.clearDeferredVoiceAction(session, "queued_user_turns");
  }

  getDeferredQueuedUserTurns(session) {
    if (!session || session.ending) return [];
    return this.deferredActionQueue.getDeferredQueuedUserTurns(session);
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
    const normalizedFlushDelayMs = flushDelayMs != null && Number.isFinite(Number(flushDelayMs))
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
    return this.turnProcessor.flushDeferredBotTurnOpenTurns({
      session,
      deferredTurns,
      reason
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
    conversationContext: _conversationContext = null,
    latencyContext = null,
    speakerTranscripts = null
  }) {
    if (!session || session.ending) return false;
    if (!providerSupports(session.mode || "", "textInput")) return false;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    if (!session.realtimeClient || typeof session.realtimeClient.requestTextUtterance !== "function") {
      return false;
    }

    const normalizedUserId = String(userId || "").trim() || null;
    if (normalizedUserId) {
      session.lastRealtimeToolCallerUserId = normalizedUserId;
    }

    const speakerName =
      this.resolveVoiceSpeakerName(session, normalizedUserId) || normalizedUserId || "someone";

    // For cross-speaker coalesced turns, format each speaker's contribution
    // separately so the realtime model sees proper attribution.
    let labeledTranscript: string;
    if (Array.isArray(speakerTranscripts) && speakerTranscripts.length > 1) {
      labeledTranscript = normalizeVoiceText(
        speakerTranscripts
          .filter((s) => s && s.transcript)
          .map((s) => {
            const name = this.resolveVoiceSpeakerName(session, s.userId) || "someone";
            return `(${name}): ${s.transcript}`;
          })
          .join("\n"),
        STT_REPLY_MAX_CHARS
      );
    } else {
      labeledTranscript = normalizeVoiceText(
        `(${speakerName}): ${normalizedTranscript}`,
        STT_REPLY_MAX_CHARS
      );
    }
    if (!labeledTranscript) return false;

    // Cancel any in-flight response so the model sees all user messages and
    // generates a single contextual reply instead of queuing separate responses.
    this.clearPendingRealtimeAssistantUtterances(session, "new_user_turn");
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

    try {
      await this.instructionManager.prepareRealtimeTurnContext({
        session,
        settings,
        userId: normalizedUserId,
        transcript: normalizedTranscript,
        captureReason
      });
      const promptLog = buildSingleTurnPromptLog({
        systemPrompt: String(session.lastRealtimeInstructions || session.baseVoiceInstructions || "").trim(),
        userPrompt: labeledTranscript
      });
      setVoiceLivePromptSnapshot(session, "bridge", {
        replyPrompts: promptLog,
        source: String(source || "openai_realtime_text_turn")
      });
      session.realtimeClient.requestTextUtterance(labeledTranscript);
      this.replyManager.createTrackedAudioResponse({
        session,
        userId: normalizedUserId,
        source: String(source || "openai_realtime_text_turn"),
        resetRetryState: true,
        emitCreateEvent: false,
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
          transcriptChars: normalizedTranscript.length,
          labeledTranscriptChars: labeledTranscript.length,
          speakerName,
          replyPrompts: promptLog
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
    source = "voice_file_asr_ingest",
    captureReason = "stream_end",
    errorPrefix = "voice_file_asr_memory_ingest_failed"
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
        isBot: false,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: String(source || "voice_file_asr_ingest")
        }
      })
      .catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId || null,
          content: `${String(errorPrefix || "voice_file_asr_memory_ingest_failed")}: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end")
          }
        });
      });

    if (session) {
      const trackedPromise = ingestPromise.finally(() => {
        if (session.pendingMemoryIngest === trackedPromise) {
          session.pendingMemoryIngest = null;
        }
      });
      session.pendingMemoryIngest = trackedPromise;

      // Pre-compute the query embedding for this transcript so it's cached
      // before the generation pipeline needs it.  Also stores the vector on
      // the session for topic-drift detection (warm memory system).
      if (
        session.warmMemory &&
        this.memory &&
        typeof this.memory.getQueryEmbeddingForRetrieval === "function"
      ) {
        const transcriptForKey = normalizedTranscript;
        const embeddingPromise = this.memory
          .getQueryEmbeddingForRetrieval({
            queryText: normalizedTranscript,
            settings,
            trace: {
              guildId: session.guildId,
              channelId: session.textChannelId,
              userId: normalizedUserId,
              source: "voice_ingest_precompute"
            }
          })
          .then((result) => {
            if (result?.embedding?.length && result?.model) {
              const entry = {
                transcript: transcriptForKey,
                embedding: result.embedding,
                model: result.model
              };
              session.warmMemory.lastIngestEmbedding = entry;
              return entry;
            }
            return null;
          })
          .catch(() => null);
        session.warmMemory.pendingIngestEmbedding = embeddingPromise;
      }
    }
  }

  buildVoiceConversationContext({
    session = null,
    userId = null,
    directAddressed = false,
    participantCount = null,
    now = Date.now()
  } = {}): VoiceConversationContext {
    return buildVoiceConversationContextModule(this, {
      session,
      userId,
      directAddressed,
      participantCount,
      now
    });
  }

  async evaluateVoiceReplyDecision({
    session,
    settings,
    userId,
    transcript,
    inputKind = "transcript",
    source = "realtime",
    transcriptionContext = null,
    runtimeEventContext = null,
    speakerTranscripts = null
  }): Promise<VoiceReplyDecision> {
    return evaluateVoiceReplyDecisionModule(this, {
      session,
      settings,
      userId,
      transcript,
      inputKind,
      source,
      transcriptionContext,
      runtimeEventContext,
      speakerTranscripts
    });
  }

  async fireVoiceRuntimeEvent({
    session,
    settings,
    userId = null,
    transcript = "",
    source = "voice_runtime_event",
    runtimeEventContext = null
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);

    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript,
      inputKind: "event",
      source,
      runtimeEventContext: normalizedRuntimeEventContext
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_runtime_event_decision",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        inputKind: "event",
        source,
        transcript: decision.transcript || transcript || null,
        runtimeEventContext: decision.runtimeEventContext || normalizedRuntimeEventContext,
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0)
      }
    });

    if (!decision.allow) return false;

    await this.runRealtimeBrainReply({
      session,
      settings,
      userId,
      transcript,
      inputKind: "event",
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      source,
      runtimeEventContext: decision.runtimeEventContext || normalizedRuntimeEventContext
    });

    return true;
  }

  formatVoiceDecisionHistory(session, maxTurns = 6, maxTotalChars = VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS) {
    const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const membershipEvents = Array.isArray(session?.membershipEvents) ? session.membershipEvents : [];
    const voiceChannelEffects = Array.isArray(session?.voiceChannelEffects) ? session.voiceChannelEffects : [];
    const botUserId = String(this.client.user?.id || "").trim();

    if (!turns.length && !membershipEvents.length && !voiceChannelEffects.length) return "";

    // Build timeline entries from voice turns
    const turnEntries = turns
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((turn) => {
        const role = turn?.role === "assistant" ? "assistant" : "user";
        const text = normalizeVoiceText(turn?.text || "", VOICE_DECIDER_HISTORY_MAX_CHARS);
        if (!text) return null;
        const speaker =
          role === "assistant"
            ? "YOU"
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
          ? turn?.role === "assistant"
            ? ` [to ${talkingTo}]`
            : ` [to ${talkingTo}; confidence ${directedConfidence.toFixed(2)}]`
          : "";
        return {
          at: Number(turn?.at || 0),
          line: `${speaker}: "${text}"${addressingSuffix}`
        };
      })
      .filter((entry): entry is { at: number; line: string } => entry !== null);

    // Build timeline entries from membership events (join/leave)
    const membershipEntries = membershipEvents
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((event) => {
        const eventUserId = String(event?.userId || "").trim();
        const name = eventUserId && botUserId && eventUserId === botUserId
          ? "YOU"
          : String(event?.displayName || "someone").trim();
        const type = String(event?.eventType || "").trim();
        if (type !== "join" && type !== "leave") return null;
        return {
          at: Number(event?.at || 0),
          line: `[${name} ${type === "join" ? "joined" : "left"} the voice channel]`
        };
      })
      .filter((entry): entry is { at: number; line: string } => entry !== null);

    const effectEntries = voiceChannelEffects
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((event) => {
        const summary = formatVoiceChannelEffectSummary(event);
        if (!summary) return null;
        return {
          at: Number(event?.at || 0),
          line: `[${summary}]`
        };
      })
      .filter((entry): entry is { at: number; line: string } => entry !== null);

    // Merge and sort by timestamp
    const allEntries = [...turnEntries, ...membershipEntries, ...effectEntries]
      .sort((a, b) => a.at - b.at)
      .slice(-Math.max(1, Number(maxTurns) || 6));

    const boundedLines = [];
    let totalChars = 0;
    for (let index = allEntries.length - 1; index >= 0; index -= 1) {
      const entry = allEntries[index];
      if (!entry?.line) continue;
      const delimiterChars = boundedLines.length > 0 ? 1 : 0;
      const projectedChars = totalChars + delimiterChars + entry.line.length;
      if (projectedChars > Math.max(120, Number(maxTotalChars) || VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS)) {
        break;
      }
      boundedLines.push(entry.line);
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
    return normalizeVoiceAddressingAnnotationModule({
      rawAddressing,
      directAddressed,
      directedConfidence,
      source,
      reason
    });
  }

  mergeVoiceAddressingAnnotation(
    existing: VoiceAddressingAnnotation | null = null,
    incoming: VoiceAddressingAnnotation | null = null
  ): VoiceAddressingAnnotation | null {
    return mergeVoiceAddressingAnnotationModule(existing, incoming);
  }

  findLatestVoiceTurnIndex(rows, { role = "user", userId = null, text = null, textMaxChars = STT_TRANSCRIPT_MAX_CHARS }) {
    return findLatestVoiceTurnIndexModule(rows, {
      role,
      userId,
      text,
      textMaxChars
    });
  }

  annotateLatestVoiceTurnAddressing({
    session = null,
    role = "user",
    userId = null,
    text = "",
    addressing = null
  } = {}) {
    return annotateLatestVoiceTurnAddressingModule({
      session,
      role,
      userId,
      text,
      addressing
    });
  }

  buildVoiceAddressingState({
    session = null,
    userId = null,
    now = Date.now(),
    maxItems = 6
  } = {}): VoiceAddressingState | null {
    return buildVoiceAddressingStateModule({
      session,
      userId,
      now,
      maxItems
    });
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

    const messageId = `voice-assistant-${String(session.id || "session")}-${String(createdAtMs)}`;
    const botName = getPromptBotName(session.settingsSnapshot || this.store.getSettings());

    this.store.recordMessage({
      messageId,
      createdAt: createdAtMs,
      guildId: String(session.guildId || "").trim() || null,
      channelId: normalizedChannelId,
      authorId: botUserId,
      authorName: botName,
      isBot: true,
      content: normalizedText,
      referencedMessageId: null
    });

    if (this.memory && typeof this.memory.ingestMessage === "function") {
      this.memory.ingestMessage({
        messageId,
        authorId: botUserId,
        authorName: botName,
        content: normalizedText,
        isBot: true,
        settings: session.settingsSnapshot || this.store.getSettings(),
        trace: {
          guildId: String(session.guildId || "").trim() || null,
          channelId: normalizedChannelId,
          userId: botUserId,
          source: "voice_assistant_timeline_ingest"
        }
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: botUserId || null,
          content: `voice_assistant_memory_ingest_failed: ${String(error?.message || error)}`,
          metadata: { sessionId: session.id }
        });
      });
    }
  }

  appendTranscriptTimelineEntry(session, entry: VoiceTranscriptTimelineEntry | null = null) {
    if (!session || session.ending || !entry) return;
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    session.transcriptTurns = [
      ...transcriptTurns,
      entry
    ].slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS);
  }

  recordVoiceTurn(session, { role = "user", userId = null, text = "", addressing = null } = {}) {
    if (!session || session.ending) return;
    const normalizedContextText = normalizeVoiceText(text, VOICE_DECIDER_HISTORY_MAX_CHARS);
    const normalizedTranscriptText = normalizeVoiceText(text, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedContextText || !normalizedTranscriptText) return;

    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const turns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
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
      kind: "speech",
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
      kind: "speech",
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
    this.appendTranscriptTimelineEntry(session, transcriptTurnEntry);
    if (normalizedRole === "user") {
      this.thoughtEngine.markPendingAmbientThoughtStale(session, {
        userId: normalizedUserId,
        reason: "new_user_turn",
        now: nextAt
      });
    }
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

  hasOtherActiveCaptures(session, excludeUserId) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) {
      return false;
    }
    const normalizedExclude = String(excludeUserId || "").trim();
    for (const [captureUserId] of session.userCaptures.entries()) {
      if (String(captureUserId || "").trim() !== normalizedExclude) {
        return true;
      }
    }
    return false;
  }

  flushHeldRoomCoalesceTurns(session, reason = "room_quiet") {
    this.turnProcessor.flushHeldRoomCoalesceTurns(session, reason);
  }

  extractRealtimeFunctionCallEnvelope(event) {
    if (!event || typeof event !== "object") return null;
    const eventType = String(event.type || "").trim();
    if (!REALTIME_FUNCTION_CALL_ITEM_TYPES.has(eventType)) return null;

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

  resolveRealtimeResponseId(session, event) {
    if (!session || !event || typeof event !== "object") return null;
    const response =
      event.response && typeof event.response === "object" ? event.response : null;
    const eventItem =
      event.item && typeof event.item === "object" ? event.item : null;
    const outputItem =
      event.output_item && typeof event.output_item === "object"
        ? event.output_item
        : null;
    const directId = normalizeInlineText(
      event.response_id || event.responseId || response?.id || eventItem?.response_id || outputItem?.response_id,
      180
    );
    if (directId) return directId;
    const realtimeClient = session.realtimeClient;
    if (!realtimeClient || typeof realtimeClient !== "object" || !("activeResponseId" in realtimeClient)) return null;
    return normalizeInlineText(realtimeClient.activeResponseId, 180) || null;
  }

  hasRealtimeAssistantOutputForResponse(session, responseId = "") {
    const normalizedResponseId = normalizeInlineText(responseId, 180);
    if (!session || !normalizedResponseId) return false;
    const responseOutputState = session.realtimeResponsesWithAssistantOutput;
    if (!(responseOutputState instanceof Map)) return false;
    return responseOutputState.has(normalizedResponseId);
  }

  scheduleRealtimeToolFollowupResponse({
    session,
    userId = null,
    startedAtMs = 0,
    requestFollowup = false,
    toolName = null
  }: {
    session?: VoiceSession | VoiceToolRuntimeSessionLike | null;
    userId?: string | null;
    startedAtMs?: number;
    requestFollowup?: boolean;
    toolName?: string | null;
  } = {}) {
    if (!session || session.ending) return;
    if (!this.shouldHandleRealtimeFunctionCalls({ session })) return;
    if (requestFollowup) {
      session.realtimeToolFollowupNeeded = true;
    }
    if (session.realtimeToolResponseDebounceTimer) {
      clearTimeout(session.realtimeToolResponseDebounceTimer);
      session.realtimeToolResponseDebounceTimer = null;
    }

    session.realtimeToolResponseDebounceTimer = setTimeout(() => {
      session.realtimeToolResponseDebounceTimer = null;
      if (!session || session.ending) return;
      if (
        this.activeReplies?.isStale(buildVoiceReplyScopeKey(session.id), startedAtMs)
      ) {
        session.awaitingToolOutputs = false;
        session.realtimeToolFollowupNeeded = false;
        this.replyManager.syncAssistantOutputState(session, "tool_outputs_cancelled");
        return;
      }
      if (session.realtimeToolCallExecutions instanceof Map && session.realtimeToolCallExecutions.size > 0) return;
      session.awaitingToolOutputs = false;
      this.replyManager.syncAssistantOutputState(session, "tool_outputs_ready");
      const followupNeeded = Boolean(session.realtimeToolFollowupNeeded);
      session.realtimeToolFollowupNeeded = false;
      const followupUserId = userId || session.lastRealtimeToolCallerUserId || null;
      const activeCommandState = this.ensureVoiceCommandState(session);
      if (!followupNeeded) {
        if (activeCommandState?.intent === "tool_followup") {
          this.clearVoiceCommandSession(session);
        }
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "realtime_tool_followup_not_required",
          metadata: {
            sessionId: session.id
          }
        });
        return;
      }

      const created = this.replyManager.createTrackedAudioResponse({
        session,
        userId: userId || session.lastRealtimeToolCallerUserId || null,
        source: "tool_call_followup",
        resetRetryState: true,
        emitCreateEvent: true
      });
      if (created) {
        const nextCommandState = this.ensureVoiceCommandState(session);
        const canAdoptToolFollowupLease =
          Boolean(followupUserId) &&
          (!nextCommandState || nextCommandState.intent === "tool_followup");
        if (canAdoptToolFollowupLease) {
          this.beginVoiceCommandSession({
            session,
            userId: followupUserId,
            domain: resolveVoiceToolFollowupDomain(toolName),
            intent: "tool_followup",
            ttlMs: VOICE_TOOL_FOLLOWUP_SESSION_TTL_MS
          });
        }
        return;
      }
      if (this.ensureVoiceCommandState(session)?.intent === "tool_followup") {
        this.clearVoiceCommandSession(session);
      }
      {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "realtime_tool_followup_skipped",
          metadata: {
            sessionId: session.id
          }
        });
        this.replyManager.syncAssistantOutputState(session, "tool_followup_skipped");
      }
    }, OPENAI_TOOL_RESPONSE_DEBOUNCE_MS);
  }

  async handleRealtimeFunctionCallEvent({ session, settings, event }) {
    if (!session || session.ending) return;
    if (!this.shouldHandleRealtimeFunctionCalls({ session, settings })) return;
    const envelope = this.extractRealtimeFunctionCallEnvelope(event);
    if (!envelope) return;
    const runtimeSession = ensureSessionToolRuntimeState(this, session);
    if (!runtimeSession) return;

    const pendingCalls = runtimeSession.realtimePendingToolCalls;
    const completedCalls = runtimeSession.realtimeCompletedToolCallIds;
    const executions = runtimeSession.realtimeToolCallExecutions;
    const responseId = this.resolveRealtimeResponseId(session, event);
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
        runtimeSession.realtimeCompletedToolCallIds = new Map(prunedEntries);
      }
    }

    const existing = pendingCalls.get(normalizedCallId) || null;
    const pendingCall = existing && typeof existing === "object"
      ? existing
      : {
        callId: normalizedCallId,
        name: normalizedName || "",
        argumentsText: "",
        responseId,
        done: false,
        startedAtMs: Date.now(),
        sourceEventType: envelope.eventType
      };
    if (normalizedName && !pendingCall.name) {
      pendingCall.name = normalizedName;
    }
    if (responseId) {
      pendingCall.responseId = responseId;
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

    await executeRealtimeFunctionCall(this, {
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
      actorUserId: session?.lastRealtimeToolCallerUserId || null,
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
      requestedByUserId: session.lastRealtimeToolCallerUserId || null,
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
    ensureSessionToolRuntimeState(this, session);
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

  getRecentVoiceChannelEffectEvents(
    session,
    { now = Date.now(), maxItems = VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT } = {}
  ) {
    const events = Array.isArray(session?.voiceChannelEffects) ? session.voiceChannelEffects : [];
    const normalizedNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const boundedMax = clamp(
      Math.floor(Number(maxItems) || VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT),
      1,
      VOICE_CHANNEL_EFFECT_EVENT_MAX_TRACKED
    );

    return events
      .map((entry) => {
        const at = Number(entry?.at || 0);
        if (!Number.isFinite(at) || at <= 0) return null;
        const displayName = String(entry?.displayName || "")
          .trim()
          .slice(0, 80) || "unknown";
        const effectType = String(entry?.effectType || "")
          .trim()
          .toLowerCase();
        const soundId = String(entry?.soundId || "").trim() || null;
        const soundName = String(entry?.soundName || "").trim().slice(0, 80) || null;
        const emoji = String(entry?.emoji || "").trim().slice(0, 80) || null;
        const soundVolumeRaw = Number(entry?.soundVolume);
        const animationTypeRaw = Number(entry?.animationType);
        const animationIdRaw = Number(entry?.animationId);
        const normalizedEntry = {
          userId: String(entry?.userId || "").trim(),
          displayName,
          channelId: String(entry?.channelId || "").trim(),
          guildId: String(entry?.guildId || "").trim(),
          effectType:
            effectType === "soundboard" || effectType === "emoji"
              ? effectType
              : "unknown",
          soundId,
          soundName,
          soundVolume: Number.isFinite(soundVolumeRaw) ? soundVolumeRaw : null,
          emoji,
          animationType: Number.isFinite(animationTypeRaw) ? animationTypeRaw : null,
          animationId: Number.isFinite(animationIdRaw) ? animationIdRaw : null,
          at,
          ageMs: Math.max(0, normalizedNow - at),
          summary: ""
        };
        normalizedEntry.summary = formatVoiceChannelEffectSummary(normalizedEntry, {
          includeTiming: false
        });
        return normalizedEntry;
      })
      .filter((entry) => entry && entry.ageMs <= VOICE_CHANNEL_EFFECT_EVENT_FRESH_MS)
      .slice(-boundedMax);
  }

  recordVoiceChannelEffectEvent(
    session,
    {
      userId,
      displayName = "",
      channelId = "",
      guildId = "",
      effectType = "unknown",
      soundId = null,
      soundName = null,
      soundVolume = null,
      emoji = null,
      animationType = null,
      animationId = null,
      at = Date.now()
    }: {
      userId?: string | null;
      displayName?: string;
      channelId?: string;
      guildId?: string;
      effectType?: string;
      soundId?: string | null;
      soundName?: string | null;
      soundVolume?: number | null;
      emoji?: string | null;
      animationType?: number | null;
      animationId?: number | null;
      at?: number;
    } = {}
  ) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return null;

    const voiceChannelEffects = Array.isArray(session.voiceChannelEffects) ? session.voiceChannelEffects : [];
    if (!Array.isArray(session.voiceChannelEffects)) {
      session.voiceChannelEffects = voiceChannelEffects;
    }

    const eventAt = Number.isFinite(Number(at)) ? Math.max(0, Number(at)) : Date.now();
    const normalizedDisplayName =
      String(displayName || "").trim() || this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown";
    const normalizedEffectType = String(effectType || "")
      .trim()
      .toLowerCase();
    const resolvedEffectType =
      normalizedEffectType === "soundboard" || normalizedEffectType === "emoji"
        ? normalizedEffectType
        : "unknown";
    const normalizedSoundId = String(soundId || "").trim() || null;
    const normalizedSoundName = String(soundName || "").trim().slice(0, 80) || null;
    const normalizedEmoji = String(emoji || "").trim().slice(0, 80) || null;
    const normalizedChannelId = String(channelId || session.voiceChannelId || "").trim();
    const normalizedGuildId = String(guildId || session.guildId || "").trim();
    const previous = voiceChannelEffects[voiceChannelEffects.length - 1];
    const duplicate =
      previous &&
      String(previous.userId || "").trim() === normalizedUserId &&
      String(previous.effectType || "").trim().toLowerCase() === resolvedEffectType &&
      String(previous.soundId || "").trim() === String(normalizedSoundId || "") &&
      String(previous.emoji || "").trim() === String(normalizedEmoji || "") &&
      eventAt - Number(previous.at || 0) <= 1500;
    if (duplicate) {
      return null;
    }

    const eventRow = {
      userId: normalizedUserId,
      displayName: normalizedDisplayName.slice(0, 80),
      channelId: normalizedChannelId,
      guildId: normalizedGuildId,
      effectType: resolvedEffectType,
      soundId: normalizedSoundId,
      soundName: normalizedSoundName,
      soundVolume: Number.isFinite(Number(soundVolume)) ? Number(soundVolume) : null,
      emoji: normalizedEmoji,
      animationType: Number.isFinite(Number(animationType)) ? Number(animationType) : null,
      animationId: Number.isFinite(Number(animationId)) ? Number(animationId) : null,
      at: eventAt
    };
    voiceChannelEffects.push(eventRow);
    if (voiceChannelEffects.length > VOICE_CHANNEL_EFFECT_EVENT_MAX_TRACKED) {
      session.voiceChannelEffects = voiceChannelEffects.slice(-VOICE_CHANNEL_EFFECT_EVENT_MAX_TRACKED);
    } else {
      session.voiceChannelEffects = voiceChannelEffects;
    }
    const summary = formatVoiceChannelEffectSummary(eventRow);
    const timelineText = summary
      ? normalizeVoiceText(
        `[Voice effect] ${summary}`,
        STT_TRANSCRIPT_MAX_CHARS
      )
      : "";
    if (timelineText) {
      this.appendTranscriptTimelineEntry(session, {
        kind: "effect",
        role: "user",
        userId: normalizedUserId,
        speakerName: normalizedDisplayName.slice(0, 80),
        text: timelineText,
        at: eventAt,
        effectType: resolvedEffectType,
        summary,
        soundId: normalizedSoundId,
        soundName: normalizedSoundName,
        emoji: normalizedEmoji
      });
    }
    return eventRow;
  }

  async handleVoiceChannelEffectSend(voiceChannelEffect: VoiceChannelEffect) {
    const guildId = String(voiceChannelEffect?.guild?.id || "").trim();
    if (!guildId) return;
    const session = this.getSession(guildId);
    if (!session || session.ending) return;
    if (String(voiceChannelEffect?.channelId || "") !== String(session.voiceChannelId || "")) return;

    const effectType = voiceChannelEffect?.soundId ? "soundboard" : voiceChannelEffect?.emoji ? "emoji" : "unknown";
    const soundName = String(voiceChannelEffect?.soundboardSound?.name || "").trim() || null;
    const emoji = voiceChannelEffect?.emoji
      ? typeof voiceChannelEffect.emoji.toString === "function"
        ? String(voiceChannelEffect.emoji.toString()).trim()
        : String(voiceChannelEffect.emoji.name || "").trim() || null
      : null;
    const displayName =
      String(session?.guildId || "") && voiceChannelEffect?.guild?.members?.cache?.get(String(voiceChannelEffect.userId || ""))
        ?.displayName || this.resolveVoiceSpeakerName(session, String(voiceChannelEffect.userId || "")) || "unknown";
    const eventRow = this.recordVoiceChannelEffectEvent(session, {
      userId: String(voiceChannelEffect.userId || "").trim(),
      displayName,
      channelId: String(voiceChannelEffect.channelId || "").trim(),
      guildId,
      effectType,
      soundId: voiceChannelEffect.soundId == null ? null : String(voiceChannelEffect.soundId),
      soundName,
      soundVolume: voiceChannelEffect.soundVolume,
      emoji,
      animationType: voiceChannelEffect.animationType == null ? null : Number(voiceChannelEffect.animationType),
      animationId: voiceChannelEffect.animationId == null ? null : Number(voiceChannelEffect.animationId),
      at: Date.now()
    });
    if (!eventRow) return;

    if (String(eventRow.userId || "").trim() && String(eventRow.userId || "").trim() !== String(this.client.user?.id || "").trim()) {
      this.thoughtEngine.markPendingAmbientThoughtStale(session, {
        userId: eventRow.userId,
        reason: "voice_effect",
        now: eventRow.at
      });
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId: session.textChannelId,
      userId: String(voiceChannelEffect.userId || "").trim() || null,
      content: "voice_channel_effect_send",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        voiceChannelId: session.voiceChannelId,
        effectType: eventRow.effectType,
        summary: formatVoiceChannelEffectSummary(eventRow),
        soundId: eventRow.soundId,
        soundName: eventRow.soundName,
        soundVolume: eventRow.soundVolume,
        emoji: eventRow.emoji,
        animationType: eventRow.animationType,
        animationId: eventRow.animationId
      }
    });
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
    const timelineText = normalizeVoiceText(
      `[${eventRow.displayName} ${normalizedEventType === "join" ? "joined" : "left"} the voice channel]`,
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (timelineText) {
      this.appendTranscriptTimelineEntry(session, {
        kind: "membership",
        role: "user",
        userId: normalizedUserId,
        speakerName: eventRow.displayName,
        text: timelineText,
        at: eventAt,
        eventType: normalizedEventType
      });
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

  async runRealtimeBrainReply({
    session,
    settings,
    userId,
    transcript = "",
    inputKind = "transcript",
    directAddressed = false,
    directAddressConfidence = Number.NaN,
    conversationContext = null,
    musicWakeFollowupEligibleAtCapture = false,
    source = "realtime",
    latencyContext = null,
    frozenFrameSnapshot = null,
    runtimeEventContext = null,
    speakerTranscripts = null
  }) {
    // For cross-speaker coalesced turns, format the transcript with per-speaker
    // attribution so the generation model sees who said what.
    const formattedTranscript =
      Array.isArray(speakerTranscripts) && speakerTranscripts.length > 1
        ? speakerTranscripts
          .filter((s) => s && s.transcript)
          .map((s) => {
            const name = this.resolveVoiceSpeakerName(session, s.userId) || "someone";
            return `[${name}]: "${s.transcript}"`;
          })
          .join("\n") || transcript
        : transcript;

    return await runVoiceReplyPipeline(this, {
      session,
      settings,
      userId,
      transcript: formattedTranscript,
      inputKind,
      directAddressed,
      directAddressConfidence,
      conversationContext,
      musicWakeFollowupEligibleAtCapture,
      mode: "realtime_transport",
      source,
      latencyContext,
      frozenFrameSnapshot,
      runtimeEventContext
    });
  }

  async transcribePcmTurn({
    session,
    userId,
    pcmBuffer,
    model,
    sampleRateHz = 24000,
    captureReason = "stream_end",
    traceSource = "voice_file_asr_turn",
    errorPrefix = "file_asr_transcription_failed",
    emptyTranscriptRuntimeEvent = "voice_transcription_empty",
    emptyTranscriptErrorStreakThreshold = 1,
    suppressEmptyTranscriptLogs = false,
    asrLanguage = "",
    asrPrompt = ""
  }) {
    if (!this.llm?.transcribeAudio || !pcmBuffer?.length) return "";
    const resolvedSettings = session?.settingsSnapshot || null;
    const transcriberProvider = resolveTranscriberProvider(resolvedSettings);
    const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
    const elevenLabsSettings = voiceRuntime.elevenLabsRealtime;
    const resolvedModel =
      transcriberProvider === "elevenlabs"
        ? String(model || elevenLabsSettings?.transcriptionModel || "").trim()
        : String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const source = String(traceSource || "voice_file_asr_turn");
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
        provider: transcriberProvider,
        model: resolvedModel,
        language: asrLanguage,
        prompt: asrPrompt,
        sampleRateHz,
        ...(transcriberProvider === "elevenlabs"
          ? {
              baseUrl: String(elevenLabsSettings?.apiBaseUrl || "").trim() || undefined
            }
          : {}),
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
            ? `${String(errorPrefix || "file_asr_transcription_failed")}: ${message}`
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
        content: `${String(errorPrefix || "file_asr_transcription_failed")}: ${message}`,
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
    const asrDeps = this.buildAsrBridgeDeps(session);
    await closeAllPerUserAsrSessions(session, asrDeps, "session_end");
    await closeSharedAsrSession(session, asrDeps, "session_end");
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

    if (this.memory && typeof this.memory.runVoiceSessionMicroReflection === "function") {
      void this.memory.runVoiceSessionMicroReflection({
        guildId: session.guildId,
        channelId: session.textChannelId,
        sessionId: session.id,
        settings: settings || session.settingsSnapshot,
        startedAtMs: session.startedAt,
        transcriptTurns: Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [],
        pendingMemoryIngest: session.pendingMemoryIngest || null
      }).catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          content: `memory_voice_micro_reflection: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            reason
          }
        });
      });
    }

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
      await sendOperationalMessage(this, {
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
        if (movedIntoSession) {
          this.refreshSessionUserFactProfile(session, stateUserId);
        } else if (movedOutOfSession) {
          session.factProfiles?.delete?.(stateUserId);
        }
        // Participant change invalidates warm memory snapshot since it
        // contains participant-dependent fact profiles and behavioral context.
        if (session.warmMemory?.snapshot) {
          session.warmMemory.snapshot = null;
        }
        const recordedEvent = this.recordVoiceMembershipEvent({
          session,
          userId: stateUserId,
          eventType: movedIntoSession ? "join" : "leave",
          displayName: stateMember?.displayName || stateMember?.user?.globalName || stateMember?.user?.username || ""
        });
        if (recordedEvent) {
          this.thoughtEngine.markPendingAmbientThoughtStale(session, {
            userId: recordedEvent.userId,
            reason: recordedEvent.eventType === "join" ? "member_join" : "member_leave",
            now: recordedEvent.at
          });
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

          if (recordedEvent.displayName) {
            void this.fireVoiceRuntimeEvent({
              session,
              settings: session.settingsSnapshot || this.store.getSettings(),
              userId: stateUserId,
              transcript: movedIntoSession
                ? `[${recordedEvent.displayName} joined the voice channel]`
                : `[${recordedEvent.displayName} left the voice channel]`,
              source: movedIntoSession ? "member_join_greeting" : "member_leave_acknowledgment",
              runtimeEventContext: {
                category: "membership",
                eventType: movedIntoSession ? "join" : "leave",
                actorUserId: recordedEvent.userId,
                actorDisplayName: recordedEvent.displayName,
                actorRole: "other"
              }
            });
          }
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
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    if (subcommandGroup === "music") {
      return await this.handleMusicSlashCommand(interaction, settings);
    }

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
    if (!isRealtimeMode(session.mode)) {
      await interaction.reply({ content: "The /clank say command is only available in realtime voice sessions.", ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand !== "say") {
      await interaction.reply({ content: "Unsupported /clank command.", ephemeral: true });
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
        source: "slash_command_clank_say"
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

    const conversationContext = this.buildVoiceConversationContext({
      session,
      userId,
      directAddressed: true
    });
    if (
      this.shouldUseNativeRealtimeReply({ session, settings: resolvedSettings }) ||
      this.shouldUseRealtimeTranscriptBridge({ session, settings: resolvedSettings })
    ) {
      await this.forwardRealtimeTextTurnToBrain({
        session,
        settings: resolvedSettings,
        userId,
        transcript: normalizedText,
        source,
        directAddressed: true,
        conversationContext
      });
      return;
    }

    await this.runRealtimeBrainReply({
      session,
      settings: resolvedSettings,
      userId,
      transcript: normalizedText,
      directAddressed: true,
      directAddressConfidence: 1.0,
      conversationContext,
      source
    });
  }

  buildVoiceToolCallbacks({ session, settings }) {
    return {
      musicSearch: (query: string, limit: number) =>
        executeVoiceMusicSearchTool(this, { session, args: { query, max_results: limit } }),
      musicPlay: (query: string, selectionId?: string | null, platform?: string | null) =>
        executeVoiceMusicPlayTool(this, {
          session,
          settings,
          args: {
            query,
            selection_id: selectionId,
            platform
          }
        }),
      videoSearch: (query: string, limit: number) =>
        executeVoiceVideoSearchTool(this, { session, args: { query, max_results: limit } }),
      videoPlay: (query: string, selectionId?: string | null) =>
        executeVoiceVideoPlayTool(this, {
          session,
          settings,
          args: {
            query,
            selection_id: selectionId
          }
        }),
      musicQueueAdd: (args: {
        tracks?: string[];
        query?: string;
        selection_id?: string | null;
        position?: number | "end";
        platform?: string | null;
        max_results?: number;
      }) =>
        executeVoiceMusicQueueAddTool(this, { session, settings, args }),
      musicQueueNext: (args: {
        tracks?: string[];
        query?: string;
        selection_id?: string | null;
        platform?: string | null;
        max_results?: number;
      }) =>
        executeVoiceMusicQueueNextTool(this, { session, settings, args }),
      musicStop: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "media_stop", args: {} }),
      musicPause: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "media_pause", args: {} }),
      musicResume: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "media_resume", args: {} }),
      musicReplyHandoff: (mode: "pause" | "duck" | "none") =>
        executeLocalVoiceToolCall(this, {
          session,
          settings,
          toolName: "media_reply_handoff",
          args: { mode }
        }),
      musicSkip: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "media_skip", args: {} }),
      musicNowPlaying: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "media_now_playing", args: {} }),
      stopVideoShare: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "stop_video_share", args: {} }),
      playSoundboard: async (refs: string[], transcript: string) => {
        const normalizedRefs = (Array.isArray(refs) ? refs : [])
          .map((entry) => String(entry || "").trim().slice(0, 180))
          .filter(Boolean)
          .slice(0, 10);
        for (const requestedRef of normalizedRefs) {
          await maybeTriggerAssistantDirectedSoundboardModule(this, {
            session,
            settings,
            userId: this.client.user?.id || null,
            transcript,
            requestedRef,
            source: "voice_reply_tool_play_soundboard"
          });
        }
        return {
          ok: normalizedRefs.length > 0,
          played: normalizedRefs
        };
      },
      leaveVoiceChannel: () =>
        executeLocalVoiceToolCall(this, { session, settings, toolName: "leave_voice_channel", args: {} })
    };
  }
}
