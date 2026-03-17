import {
  getActivitySettings,
  getFollowupSettings,
  getVoiceConversationPolicy
} from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { isAbortError } from "../tools/browserTaskRuntime.ts";
import { getMusicWakeFollowupState } from "./musicWakeLatch.ts";
import {
  VOICE_GENERATION_ONLY_WATCHDOG_MS,
  VOICE_GENERATION_SOUNDBOARD_CANDIDATE_TIMEOUT_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  STT_CONTEXT_MAX_MESSAGES,
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
} from "./voiceSessionManager.constants.ts";
import {
  SOUNDBOARD_MAX_CANDIDATES,
  extractNoteDirectives,
  formatSoundboardCandidateLine,
  isRealtimeMode,
  normalizeVoiceAddressingTargetToken,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import { providerSupports } from "./voiceModes.ts";
import {
  normalizeSoundboardRefs as normalizeSoundboardRefsModule,
  resolveSoundboardCandidates as resolveSoundboardCandidatesModule
} from "./voiceSoundboard.ts";
import { setVoiceLivePromptSnapshot } from "./voicePromptState.ts";
import { buildSharedVoiceTurnContext } from "./voiceTurnContext.ts";

import { normalizeVoiceOutputLeaseMode } from "./voiceOutputLease.ts";
import { appendStreamWatchNoteEntry } from "./voiceStreamWatch.ts";
import {
  getCompactionCursor,
  maybeStartVoiceContextCompaction
} from "./voiceContextCompaction.ts";
import type { ReplyInterruptionPolicy } from "./bargeInController.ts";
import type {
  InFlightAcceptedBrainTurn,
  VoiceConversationContext,
  VoiceGenerationContextSnapshot,
  LoggedVoicePromptBundle,
  VoiceOutputLeaseMode,
  VoicePendingResponseLatencyContext,
  VoiceRuntimeEventContext,
  VoiceRealtimeToolSettings,
  VoiceSession
} from "./voiceSessionTypes.ts";
import { musicPhaseIsActive } from "./voiceSessionTypes.ts";
import type { VoiceSessionManager } from "./voiceSessionManager.ts";

type GeneratedPayload = {
  text?: string;
  /** Raw generation text before normalizeVoiceReplyText strips [[NOTE:...]] directives.
   *  Used by the pipeline to extract and store screen-watch notes. */
  rawText?: string;
  playedSoundboardRefs?: unknown[];
  streamedRequestedRealtimeUtterance?: boolean;
  usedWebSearchFollowup?: boolean;
  usedScreenShareOffer?: boolean;
  leaveVoiceChannelRequested?: boolean;
  voiceAddressing?: unknown;
  voiceOutputLeaseMode?: unknown;
  streamedSentenceCount?: number;
  generationContextSnapshot?: VoiceGenerationContextSnapshot | null;
  replyPrompts?: LoggedVoicePromptBundle | null;
};

type ContextMessage = {
  role: "assistant" | "user";
  content: string;
};

interface VoiceReplyPipelineParams {
  session: VoiceSession;
  settings: VoiceRealtimeToolSettings | null;
  userId: string | null;
  transcript: string;
  directAddressed?: boolean;
  directAddressConfidence?: number;
  conversationContext?: VoiceConversationContext | null;
  musicWakeFollowupEligibleAtCapture?: boolean;
  mode: "realtime_transport";
  source?: string;
  inputKind?: string;
  latencyContext?: VoicePendingResponseLatencyContext | null;
  frozenFrameSnapshot?: { mimeType: string; dataBase64: string } | null;
  runtimeEventContext?: VoiceRuntimeEventContext | null;
}

type VoiceReplyPipelineHost = Pick<VoiceSessionManager,
  | "buildVoiceConversationContext"
  | "buildVoiceReplyPlaybackPlan"
  | "buildVoiceToolCallbacks"
  | "collapsePendingRealtimeAssistantStreamTail"
  | "endSession"
  | "generateVoiceTurn"
  | "getRecentVoiceChannelEffectEvents"
  | "getRecentVoiceMembershipEvents"
  | "getStreamWatchNotesForPrompt"
  | "getVoiceChannelParticipants"
  | "logVoiceLatencyStage"
  | "maybeSupersedeRealtimeReplyBeforePlayback"
  | "maybeClearActiveReplyInterruptionPolicy"
  | "normalizeVoiceAddressingAnnotation"
  | "playVoiceReplyInOrder"
  | "recordVoiceTurn"
  | "resolveReplyInterruptionPolicy"
  | "requestRealtimeTextUtterance"
  | "schedulePassiveMusicWakeLatchRefresh"
  | "getMusicPhase"
  | "soundboardDirector"
  | "updateModelContextSummary"
  | "waitForLeaveDirectivePlayback"
> & {
  client: VoiceSessionManager["client"];
  instructionManager: VoiceSessionManager["instructionManager"];
  llm: VoiceSessionManager["llm"];
  sessionLifecycle: VoiceSessionManager["sessionLifecycle"];
  store: VoiceSessionManager["store"];
  activeReplies: VoiceSessionManager["activeReplies"];
};

function toGeneratedPayload(value: unknown): GeneratedPayload {
  if (value && typeof value === "object") {
    return value as GeneratedPayload;
  }
  return {
    text: typeof value === "string" ? value : "",
    playedSoundboardRefs: [],
    usedWebSearchFollowup: false,
    usedScreenShareOffer: false,
    leaveVoiceChannelRequested: false,
    voiceAddressing: null
  };
}

type VoiceGenerationTimeoutError = Error & {
  code?: string;
  stage?: string;
  timeoutMs?: number;
};

const VOICE_GENERATION_TIMEOUT_CODE = "voice_generation_timeout";

function createVoiceGenerationTimeoutError(stage: string, timeoutMs: number): VoiceGenerationTimeoutError {
  const error = new Error(`${stage} timed out after ${timeoutMs}ms.`) as VoiceGenerationTimeoutError;
  error.name = "TimeoutError";
  error.code = VOICE_GENERATION_TIMEOUT_CODE;
  error.stage = String(stage || "").trim() || "unknown";
  error.timeoutMs = Math.max(0, Math.round(Number(timeoutMs) || 0));
  return error;
}

function isVoiceGenerationTimeoutError(error: unknown): error is VoiceGenerationTimeoutError {
  return String((error as VoiceGenerationTimeoutError | null)?.code || "").trim() === VOICE_GENERATION_TIMEOUT_CODE;
}

async function waitForVoiceGenerationStage<T>({
  stage,
  timeoutMs,
  task
}: {
  stage: string;
  timeoutMs: number;
  task: Promise<T>;
}) {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createVoiceGenerationTimeoutError(stage, timeoutMs));
    }, Math.max(1, Math.round(Number(timeoutMs) || 1)));

    void task.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function normalizeAssistantReplyAddressing(
  host: Pick<VoiceReplyPipelineHost, "normalizeVoiceAddressingAnnotation">,
  rawAddressing: unknown
) {
  const normalizedRaw =
    rawAddressing && typeof rawAddressing === "object" && !Array.isArray(rawAddressing)
      ? rawAddressing as Record<string, unknown>
      : null;
  const talkingTo = normalizeVoiceAddressingTargetToken(String(normalizedRaw?.talkingTo || ""));
  if (!talkingTo) return null;
  return host.normalizeVoiceAddressingAnnotation({
    rawAddressing: { talkingTo },
    source: "generation",
    reason: "assistant_reply_target"
  });
}

function resolveAssistantReplyTargeting(
  host: Pick<VoiceReplyPipelineHost, "normalizeVoiceAddressingAnnotation" | "resolveReplyInterruptionPolicy">,
  {
    session,
    userId,
    rawAddressing
  }: {
    session: VoiceSession;
    userId: string | null;
    rawAddressing: unknown;
  }
) {
  const generatedVoiceAddressing = normalizeAssistantReplyAddressing(host, rawAddressing);
  const replyInterruptionPolicy: ReplyInterruptionPolicy | null = host.resolveReplyInterruptionPolicy({
    session,
    userId,
    talkingTo: generatedVoiceAddressing?.talkingTo || null,
    source: "assistant_reply_target",
    reason:
      generatedVoiceAddressing?.talkingTo === "ALL"
        ? "assistant_target_all"
        : generatedVoiceAddressing?.talkingTo
          ? "assistant_target_speaker"
          : "assistant_target_missing"
  });

  return {
    generatedVoiceAddressing,
    replyInterruptionPolicy
  };
}

function normalizeAssistantReplyOutputLeaseMode(rawOutputLeaseMode: unknown) {
  const normalizedRaw =
    rawOutputLeaseMode && typeof rawOutputLeaseMode === "object" && !Array.isArray(rawOutputLeaseMode)
      ? (rawOutputLeaseMode as Record<string, unknown>).mode
      : rawOutputLeaseMode;
  const normalizedMode = normalizeVoiceOutputLeaseMode(normalizedRaw);
  return normalizedMode === "ambient" ? null : normalizedMode;
}

function isScreenWatchQuestion(transcript: string, directAddressed: boolean) {
  const normalized = String(transcript || "").trim().toLowerCase();
  if (!normalized) return false;
  const explicitScreenQuestion =
    /\b(what(?:'s| is)? (?:on|in) (?:the )?(?:screen|stream|share)|what do you see|what can you see|can you see (?:my|the) (?:screen|stream|share)|look at (?:my|the) (?:screen|stream|share)|what(?:'s| is) happening on (?:my|the) (?:screen|stream|share))\b/i
      .test(normalized);
  if (explicitScreenQuestion) return true;
  if (!directAddressed) return false;
  return /\b(do you see|can you tell what|what am i looking at)\b/i.test(normalized);
}

function buildContextMessages(session: VoiceSession, normalizedTranscript: string) {
  const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
  const transcriptTurns = Array.isArray(session.transcriptTurns)
    ? session.transcriptTurns.filter((row) => row && typeof row === "object")
    : [];
  const compactionCursor = getCompactionCursor(session);
  const contextTurnRows = (
    compactionCursor > 0
      ? transcriptTurns.slice(compactionCursor)
      : transcriptTurns.slice(-STT_CONTEXT_MAX_MESSAGES)
  );
  if (contextTurnRows.length > 0 && contextTranscript) {
    for (let index = contextTurnRows.length - 1; index >= 0; index -= 1) {
      const row = contextTurnRows[index];
      if (!row || typeof row !== "object" || row.kind === "membership" || row.kind === "effect") {
        continue;
      }
      const lastRole = row?.role === "assistant" ? "assistant" : "user";
      const lastContent = normalizeVoiceText(row?.text, STT_REPLY_MAX_CHARS);
      if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
        contextTurnRows.splice(index, 1);
      }
      break;
    }
  }
  const contextTurns = contextTurnRows.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user" as const,
    kind: ("kind" in row ? row.kind : "speech") as string | undefined,
    content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS),
    at: Number(row?.at || 0)
  }));
  const contextMessages: ContextMessage[] = contextTurns
    .sort((a, b) => a.at - b.at)
    .slice(compactionCursor > 0 ? 0 : -STT_CONTEXT_MAX_MESSAGES)
    .map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.kind === "thought" ? `[thought: ${row.content}]` : row.content
    }))
    .filter((row): row is ContextMessage => Boolean(row.content));
  const contextMessageChars = contextMessages.reduce((total, row) => total + row.content.length, 0);
  return { contextMessages, contextMessageChars, contextTurns };
}

function logReplySkipped({
  host,
  params,
  replyText,
  replyPrompts,
  usedWebSearchFollowup,
  usedScreenShareOffer,
  generatedVoiceAddressing,
  leaveVoiceChannelRequested,
  resolvedConversationContext,
  contextMessages,
  contextTurns,
  contextMessageChars
}: {
  host: VoiceReplyPipelineHost;
  params: VoiceReplyPipelineParams;
  replyText: string;
  replyPrompts: LoggedVoicePromptBundle | null;
  usedWebSearchFollowup: boolean;
  usedScreenShareOffer: boolean;
  generatedVoiceAddressing: ReturnType<VoiceReplyPipelineHost["normalizeVoiceAddressingAnnotation"]>;
  leaveVoiceChannelRequested: boolean;
  resolvedConversationContext: VoiceConversationContext | null;
  contextMessages: ContextMessage[];
  contextTurns: Array<Record<string, unknown>>;
  contextMessageChars: number;
}) {
  const skipCause = !replyText
    ? "empty_reply_text"
    : replyText === "[SKIP]"
      ? "model_skip"
      : "no_playback_steps";
  host.store.logAction({
    kind: "voice_runtime",
    guildId: params.session.guildId,
    channelId: params.session.textChannelId,
    userId: host.client.user?.id || null,
    content: "realtime_reply_skipped",
    metadata: {
      sessionId: params.session.id,
      mode: params.session.mode,
      source: String(params.source || params.mode),
      usedWebSearchFollowup,
      usedScreenShareOffer,
      talkingTo: generatedVoiceAddressing?.talkingTo || null,
      directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
        ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
        : 0,
      soundboardRefs: [],
      leaveVoiceChannelRequested,
      skipCause,
      replyTextPreview: replyText ? replyText.slice(0, 220) : null,
      replyPrompts,
      attentionMode: resolvedConversationContext?.attentionMode || null,
      currentSpeakerActive: Boolean(resolvedConversationContext?.currentSpeakerActive),
      contextTurnsSent: contextMessages.length,
      contextTurnsAvailable: contextTurns.length,
      contextCharsSent: contextMessageChars
    }
  });
}

export async function runVoiceReplyPipeline(
  host: VoiceReplyPipelineHost,
  params: VoiceReplyPipelineParams
): Promise<boolean> {
  const { session } = params;
  const source = String(params.source || params.mode).trim() || params.mode;
  if (!session || session.ending) return false;

  if (!isRealtimeMode(session.mode)) return false;
  if (typeof host.generateVoiceTurn !== "function") {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      content: "realtime_generation_unavailable",
      metadata: {
        sessionId: session.id,
        source
      }
    });
    return false;
  }

  const normalizedTranscript = normalizeVoiceText(params.transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;

  // Determine early whether this is a stream_watch commentary turn so we
  // can tag the ActiveReply and conditionally skip the image attachment.
  const isStreamWatchCommentaryTurn =
    params.inputKind === "event" &&
    Boolean(params.runtimeEventContext && (params.runtimeEventContext as unknown as { category?: string }).category === "screen_share");

  const currentMusicPhase = host.getMusicPhase(session);
  const musicWakeFollowupState = getMusicWakeFollowupState(session, params.userId || null);
  const shouldRefreshMusicWakeAfterSpeech =
    musicPhaseIsActive(currentMusicPhase) &&
    currentMusicPhase !== "paused_wake_word" &&
    (
      Boolean(params.directAddressed) ||
      Boolean(params.musicWakeFollowupEligibleAtCapture) ||
      musicWakeFollowupState.passiveWakeFollowupAllowed
    );

  const normalizedLatencyContext =
    params.latencyContext && typeof params.latencyContext === "object"
      ? params.latencyContext
      : null;
  const latencyFinalizedAtMs = Math.max(0, Number(normalizedLatencyContext?.finalizedAtMs || 0));
  const latencyAsrStartedAtMs = Math.max(0, Number(normalizedLatencyContext?.asrStartedAtMs || 0));
  const latencyAsrCompletedAtMs = Math.max(0, Number(normalizedLatencyContext?.asrCompletedAtMs || 0));
  const latencyQueueWaitMs = Number.isFinite(Number(normalizedLatencyContext?.queueWaitMs))
    ? Math.max(0, Math.round(Number(normalizedLatencyContext?.queueWaitMs)))
    : null;
  const latencyPendingQueueDepth = Number.isFinite(Number(normalizedLatencyContext?.pendingQueueDepth))
    ? Math.max(0, Math.round(Number(normalizedLatencyContext?.pendingQueueDepth)))
    : null;
  const latencyCaptureReason = String(normalizedLatencyContext?.captureReason || "").trim() || null;
  const prePlaybackInterruptionPolicy =
    params.inputKind === "event"
      ? null
      : host.resolveReplyInterruptionPolicy({
        session,
        userId: params.userId,
        source
      });
  const generationStartedAt = Date.now();
  const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
  const inFlightAcceptedBrainTurn: InFlightAcceptedBrainTurn = {
    transcript: normalizedTranscript,
    userId: params.userId || null,
    pcmBuffer: null,
    source,
    acceptedAt: generationStartedAt,
    phase: "generation_only",
    captureReason: String(params.latencyContext?.captureReason || params.source || "stream_end"),
    directAddressed: Boolean(params.directAddressed),
    interruptionPolicy: prePlaybackInterruptionPolicy,
    toolPhaseRecoveryEligible: false,
    toolPhaseRecoveryReason: null,
    toolPhaseLastToolName: null
  };
  session.inFlightAcceptedBrainTurn = inFlightAcceptedBrainTurn;
  const clearInFlightAcceptedBrainTurn = () => {
    if (session.inFlightAcceptedBrainTurn === inFlightAcceptedBrainTurn) {
      session.inFlightAcceptedBrainTurn = null;
    }
  };

  if (host.maybeSupersedeRealtimeReplyBeforePlayback({
    session,
    source: `${source}:generation_preflight`,
    generationStartedAtMs: latencyFinalizedAtMs || generationStartedAt,
    replyUserId: params.userId || null
  })) {
    clearInFlightAcceptedBrainTurn();
    return false;
  }
  const activeReply =
    host.activeReplies && voiceReplyScopeKey
      ? host.activeReplies.begin(voiceReplyScopeKey, "voice-generation", ["voice_generation"])
      : null;
  if (activeReply && session.inFlightAcceptedBrainTurn === inFlightAcceptedBrainTurn) {
    session.inFlightAcceptedBrainTurn.acceptedAt = activeReply.startedAt;
  }
  const generationSignal = activeReply?.abortController.signal;
  const generationInterrupted = () =>
    Boolean(
      session.ending ||
      generationSignal?.aborted ||
      (
        activeReply &&
        host.activeReplies?.isStale(voiceReplyScopeKey, activeReply.startedAt)
      )
    );

  void maybeStartVoiceContextCompaction(host, {
    session,
    settings: params.settings,
    source
  });

  const { contextMessages, contextMessageChars, contextTurns } = buildContextMessages(session, normalizedTranscript);
  host.updateModelContextSummary(session, "generation", {
    source,
    capturedAt: new Date().toISOString(),
    availableTurns: contextTurns.length,
    sentTurns: contextMessages.length,
    maxTurns: STT_CONTEXT_MAX_MESSAGES,
    contextChars: contextMessageChars,
    transcriptChars: normalizedTranscript.length,
    directAddressed: Boolean(params.directAddressed)
  });

  host.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: params.userId,
    content: "voice_generation_prep_stage",
    metadata: {
      sessionId: session.id,
      source,
      stage: "soundboard_candidates",
      state: "start",
      timeoutMs: VOICE_GENERATION_SOUNDBOARD_CANDIDATE_TIMEOUT_MS
    }
  });
  const soundboardCandidatesStartedAt = Date.now();
  let soundboardCandidateInfo: Awaited<ReturnType<typeof resolveSoundboardCandidatesModule>> | null = null;
  try {
    soundboardCandidateInfo = await waitForVoiceGenerationStage({
      stage: "soundboard_candidates",
      timeoutMs: VOICE_GENERATION_SOUNDBOARD_CANDIDATE_TIMEOUT_MS,
      task: resolveSoundboardCandidatesModule(host, {
        session,
        settings: params.settings
      })
    });
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      content: "voice_generation_prep_stage",
      metadata: {
        sessionId: session.id,
        source,
        stage: "soundboard_candidates",
        state: "ok",
        elapsedMs: Math.max(0, Date.now() - soundboardCandidatesStartedAt),
        candidateCount: Array.isArray(soundboardCandidateInfo?.candidates) ? soundboardCandidateInfo.candidates.length : 0
      }
    });
  } catch (error) {
    if (isAbortError(error) || generationInterrupted()) {
      throw error;
    }
    const timedOut = isVoiceGenerationTimeoutError(error);
    host.store.logAction({
      kind: timedOut ? "voice_runtime" : "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      content: timedOut ? "voice_generation_prep_stage" : `voice_generation_soundboard_candidates_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source,
        stage: "soundboard_candidates",
        state: timedOut ? "timeout" : "error",
        elapsedMs: Math.max(0, Date.now() - soundboardCandidatesStartedAt),
        timeoutMs: VOICE_GENERATION_SOUNDBOARD_CANDIDATE_TIMEOUT_MS,
        fallbackUsed: true,
        error: String((error as Error)?.message || error)
      }
    });
    soundboardCandidateInfo = null;
  }
  const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
    ? soundboardCandidateInfo.candidates
    : []
  )
    .map((entry) => formatSoundboardCandidateLine(entry))
    .filter(Boolean)
    .slice(0, SOUNDBOARD_MAX_CANDIDATES);

  const resolvedConversationContext =
    params.conversationContext && typeof params.conversationContext === "object"
      ? params.conversationContext
      : host.buildVoiceConversationContext({
        session,
        userId: params.userId,
        directAddressed: Boolean(params.directAddressed)
      });
  const sharedTurnContext = buildSharedVoiceTurnContext(host, {
    session,
    settings: params.settings,
    speakerUserId: params.userId,
    maxParticipants: REALTIME_CONTEXT_MEMBER_LIMIT,
    maxMembershipEvents: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
    maxVoiceEffects: VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT
  });
  const participantRoster = sharedTurnContext.participantRoster;
  const recentMembershipEvents = sharedTurnContext.recentMembershipEvents;
  const recentVoiceEffectEvents = sharedTurnContext.recentVoiceEffectEvents;
  const sessionTiming = host.sessionLifecycle.buildVoiceSessionTimingContext(session);
  const streamWatchNotes = sharedTurnContext.streamWatchNotes;

  // Only attach the raw image frame for stream_watch commentary turns.
  // User-speech voice replies still get the rolling [[NOTE:...]] context
  // (via streamWatchNotes above) but skip the image to cut ~1500-2000
  // tokens and halve generation latency.
  const shouldAttachStreamWatchFrame =
    isStreamWatchCommentaryTurn ||
    (session.streamWatch?.active && isScreenWatchQuestion(normalizedTranscript, Boolean(params.directAddressed)));
  const streamWatchLatestFrame = shouldAttachStreamWatchFrame
    ? (params.frozenFrameSnapshot?.dataBase64
        ? params.frozenFrameSnapshot
        : session.streamWatch?.active && session.streamWatch?.latestFrameDataBase64
          ? {
              mimeType: String(session.streamWatch.latestFrameMimeType || "image/jpeg"),
              dataBase64: String(session.streamWatch.latestFrameDataBase64)
            }
          : null)
    : null;
  const generationConversationContext = {
    ...(resolvedConversationContext || {}),
    sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
    sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
    streamWatchNotes,
    compactedSessionSummary: sharedTurnContext.compactedSessionSummary
  };

  const markInFlightAcceptedBrainTurnPhase = (phase: "generation_only" | "tool_call_started" | "playback_requested") => {
    if (session.inFlightAcceptedBrainTurn === inFlightAcceptedBrainTurn) {
      session.inFlightAcceptedBrainTurn.phase = phase;
    }
  };
  let generatedPayload: GeneratedPayload | null = null;
  let generationFinished = false;
  const voiceConversation = getVoiceConversationPolicy(params.settings);
  const followup = getFollowupSettings(params.settings);
  const useRealtimeTts = String(voiceConversation.ttsMode || "").trim().toLowerCase() !== "api";
  const streamingVoiceReplyEnabled =
    useRealtimeTts &&
    Boolean(voiceConversation.streaming?.enabled);
  let streamedReplyRequestedAt = 0;

  if (
    streamingVoiceReplyEnabled &&
    providerSupports(session.mode || "", "updateInstructions")
  ) {
    void host.instructionManager.prepareRealtimeTurnContext({
      session,
      settings: params.settings,
      userId: params.userId,
      transcript: normalizedTranscript,
      captureReason: source
    }).catch((error: unknown) => {
      host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: `openai_realtime_turn_context_refresh_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source
        }
      });
    });
  }
  try {
    const activity = getActivitySettings(params.settings);
    const generateVoiceTurnPromise = host.generateVoiceTurn({
      settings: params.settings,
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      transcript: normalizedTranscript,
      inputKind: params.inputKind || "transcript",
      directAddressed: Boolean(params.directAddressed),
      source,
      contextMessages,
      sessionId: session.id,
      isEagerTurn:
        !params.directAddressed &&
        !generationConversationContext?.currentSpeakerActive,
      voiceAmbientReplyEagerness: Number(voiceConversation.ambientReplyEagerness) || 0,
      responseWindowEagerness: Number(activity.responseWindowEagerness) || 0,
      conversationContext: generationConversationContext,
      runtimeEventContext: params.runtimeEventContext || null,
      sessionTiming,
      participantRoster,
      recentMembershipEvents,
      recentVoiceEffectEvents,
      recentToolOutcomes: sharedTurnContext.recentToolOutcomeLines,
      soundboardCandidates: soundboardCandidateLines,
      streamWatchLatestFrame,
      nativeDiscordSharers: sharedTurnContext.nativeDiscordSharers,
      webSearchTimeoutMs: Number(followup.toolBudget?.toolTimeoutMs),
      voiceToolCallbacks: host.buildVoiceToolCallbacks({ session, settings: params.settings }),
      onSpokenSentence: async ({
        text,
        index,
        voiceAddressing,
        voiceOutputLeaseMode
      }: {
        text: string;
        index: number;
        voiceAddressing?: { talkingTo: string | null } | null;
        voiceOutputLeaseMode?: VoiceOutputLeaseMode | null;
      }) => {
        if (generationInterrupted()) return false;
        const playbackPlan = host.buildVoiceReplyPlaybackPlan({
          replyText: String(text || ""),
          trailingSoundboardRefs: []
        });
        if (!playbackPlan.steps.length) return false;
        const { replyInterruptionPolicy: streamedReplyInterruptionPolicy } = resolveAssistantReplyTargeting(host, {
          session,
          userId: params.userId,
          rawAddressing: voiceAddressing || null
        });
        const streamedReplyOutputLeaseMode = normalizeAssistantReplyOutputLeaseMode(voiceOutputLeaseMode);
        const requestedAt = Date.now();
        const latencyContext =
          index === 0
            ? {
              finalizedAtMs: latencyFinalizedAtMs,
              asrStartedAtMs: latencyAsrStartedAtMs,
              asrCompletedAtMs: latencyAsrCompletedAtMs,
              generationStartedAtMs: generationStartedAt,
              replyRequestedAtMs: requestedAt,
              audioStartedAtMs: 0,
              source,
              captureReason: latencyCaptureReason,
              queueWaitMs: latencyQueueWaitMs,
              pendingQueueDepth: latencyPendingQueueDepth
            }
            : null;
        const playbackSource = `${source}:stream_chunk_${Math.max(0, Number(index || 0))}`;
        // Derive supersede user from the resolved addressing:
        // TO:ALL → null (un-supersedable by queue).
        // TO:specific-user → that user.  No addressing → triggering speaker.
        const streamSupersedeUserId =
          voiceAddressing?.talkingTo === "ALL"
            ? null
            : (streamedReplyInterruptionPolicy?.allowedUserId || params.userId || null);
        // Fast path: realtime utterance request (no soundboard, realtime TTS available)
        if (useRealtimeTts && playbackPlan.soundboardRefs.length === 0) {
          const normalizedText = normalizeVoiceText(playbackPlan.spokenText, STT_REPLY_MAX_CHARS);
          if (!normalizedText) return false;
          if (generationInterrupted()) return false;
          if (host.maybeSupersedeRealtimeReplyBeforePlayback({
            session,
            source: playbackSource,
            speechStep: index,
            generationStartedAtMs: generationStartedAt,
            outputLeaseMode: streamedReplyOutputLeaseMode,
            replyUserId: streamSupersedeUserId
          })) {
            return false;
          }
          const requested = host.requestRealtimeTextUtterance({
            session,
            text: normalizedText,
            userId: host.client.user?.id || null,
            source: playbackSource,
            interruptionPolicy: streamedReplyInterruptionPolicy,
            outputLeaseMode: streamedReplyOutputLeaseMode,
            latencyContext,
            musicWakeRefreshAfterSpeech: shouldRefreshMusicWakeAfterSpeech
          });
          if (requested && streamedReplyRequestedAt === 0) {
            streamedReplyRequestedAt = requestedAt;
            session.lastAssistantReplyAt = requestedAt;
            markInFlightAcceptedBrainTurnPhase("playback_requested");
          }
          return {
            accepted: requested,
            playedSoundboardRefs: [],
            requestedRealtimeUtterance: requested
          };
        }
        // Full playback path: API TTS or mixed speech+soundboard
        const playbackResult = await host.playVoiceReplyInOrder({
          session,
          settings: params.settings,
          spokenText: playbackPlan.spokenText,
          playbackSteps: playbackPlan.steps,
          source: playbackSource,
          preferRealtimeUtterance: useRealtimeTts,
          interruptionPolicy: streamedReplyInterruptionPolicy,
          outputLeaseMode: streamedReplyOutputLeaseMode,
          latencyContext,
          musicWakeRefreshAfterSpeech: shouldRefreshMusicWakeAfterSpeech,
          replyUserId: streamSupersedeUserId
        });
        if (generationInterrupted()) return false;
        const accepted = Boolean(playbackResult.completed) &&
          (Boolean(playbackResult.spokeLine) || Number(playbackResult.playedSoundboardCount || 0) > 0);
        if (accepted && streamedReplyRequestedAt === 0) {
          streamedReplyRequestedAt = requestedAt;
          session.lastAssistantReplyAt = requestedAt;
          markInFlightAcceptedBrainTurnPhase("playback_requested");
        }
        if (
          accepted &&
          shouldRefreshMusicWakeAfterSpeech &&
          playbackResult.spokeLine &&
          !playbackResult.requestedRealtimeUtterance
        ) {
          host.schedulePassiveMusicWakeLatchRefresh({
            session,
            settings: params.settings,
            userId: params.userId || null
          });
        }
        return {
          accepted,
          playedSoundboardRefs: playbackPlan.soundboardRefs.slice(
            0,
            Math.max(0, Number(playbackResult.playedSoundboardCount || 0))
          ),
          requestedRealtimeUtterance: Boolean(playbackResult.requestedRealtimeUtterance)
        };
      },
      streamingSentencesEnabled: streamingVoiceReplyEnabled,
      signal: generationSignal
    });
    const generationOnlyWatchdogPromise = new Promise<never>((_, reject) => {
      const watchdogTimer = setTimeout(() => {
        const currentPhase = session.inFlightAcceptedBrainTurn?.phase || null;
        if (
          session.inFlightAcceptedBrainTurn !== inFlightAcceptedBrainTurn ||
          currentPhase !== "generation_only" ||
          generationInterrupted()
        ) {
          return;
        }
        try {
          activeReply?.abortController.abort(`voice_generation_only_watchdog_timeout:${VOICE_GENERATION_ONLY_WATCHDOG_MS}`);
        } catch {
          // best-effort
        }
        host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: params.userId,
          content: "voice_generation_watchdog_timeout",
          metadata: {
            sessionId: session.id,
            source,
            phase: currentPhase,
            timeoutMs: VOICE_GENERATION_ONLY_WATCHDOG_MS,
            transcriptChars: normalizedTranscript.length
          }
        });
        reject(createVoiceGenerationTimeoutError("generation_only_watchdog", VOICE_GENERATION_ONLY_WATCHDOG_MS));
      }, VOICE_GENERATION_ONLY_WATCHDOG_MS);
      void generateVoiceTurnPromise.then(
        () => {
          clearTimeout(watchdogTimer);
        },
        () => {
          clearTimeout(watchdogTimer);
        }
      );
    });
    generatedPayload = toGeneratedPayload(await Promise.race([
      generateVoiceTurnPromise,
      generationOnlyWatchdogPromise
    ]));
    if (generatedPayload?.generationContextSnapshot) {
      session.lastGenerationContext = {
        ...generatedPayload.generationContextSnapshot,
        source,
        mode: session.mode || source
      };
    }
    generationFinished = true;
  } catch (error) {
    if (isAbortError(error) || generationInterrupted()) {
      return false;
    }
    if (isVoiceGenerationTimeoutError(error)) {
      return false;
    }
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      content: `realtime_generation_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source
      }
    });
    return false;
  } finally {
    host.activeReplies?.clear(activeReply);
    if (!generationFinished || generationInterrupted()) {
      clearInFlightAcceptedBrainTurn();
    }
  }

  if (generationInterrupted()) {
    clearInFlightAcceptedBrainTurn();
    return false;
  }

  if (streamedReplyRequestedAt > 0) {
    host.collapsePendingRealtimeAssistantStreamTail({
      session,
      source
    });
  }

  // Extract [[NOTE:...]] directives from the raw (pre-normalization) generation
  // text. normalizeVoiceReplyText strips notes to prevent TTS from reading them
  // aloud, so generatedPayload.text is already note-free. The rawText field
  // preserves the original output for note extraction and storage.
  const noteExtraction = extractNoteDirectives(generatedPayload?.rawText || generatedPayload?.text);
  const replyText = normalizeVoiceText(noteExtraction.text || "", STT_REPLY_MAX_CHARS);
  const playedSoundboardRefs = normalizeSoundboardRefsModule(generatedPayload?.playedSoundboardRefs);
  const streamedSentenceCount = Math.max(0, Number(generatedPayload?.streamedSentenceCount || 0));
  const streamedRequestedRealtimeUtterance = Boolean(generatedPayload?.streamedRequestedRealtimeUtterance);
  const usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
  const usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
  const leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
  const replyPrompts =
    generatedPayload?.replyPrompts && typeof generatedPayload.replyPrompts === "object"
      ? generatedPayload.replyPrompts
      : null;
  setVoiceLivePromptSnapshot(session, "generation", {
    replyPrompts,
    source
  });
  const {
    generatedVoiceAddressing,
    replyInterruptionPolicy
  } = resolveAssistantReplyTargeting(host, {
    session,
    userId: params.userId,
    rawAddressing: generatedPayload?.voiceAddressing
  });
  const replyOutputLeaseMode = normalizeAssistantReplyOutputLeaseMode(
    generatedPayload?.voiceOutputLeaseMode
  );
  if (session.inFlightAcceptedBrainTurn === inFlightAcceptedBrainTurn) {
    session.inFlightAcceptedBrainTurn.outputLeaseMode = replyOutputLeaseMode;
  }

  // Store any [[NOTE:...]] directives the brain wrote as private self-notes.
  // These persist as noteEntries and are injected into future turns
  // so the brain can maintain its own visual memory without a separate triage model.
  const storeExtractedNotes = () => {
    if (noteExtraction.notes.length === 0) return;
    if (!session.streamWatch?.active) return;
    const settingsObj = params.settings as Record<string, Record<string, Record<string, unknown>>> | null;
    const maxEntries = Number(settingsObj?.voice?.streamWatch?.maxNoteEntries) || 12;
    for (const note of noteExtraction.notes) {
      appendStreamWatchNoteEntry({
        session,
        text: note,
        at: Date.now(),
        provider: null,
        model: null,
        speakerName: null,
        maxEntries
      });
    }
  };

  const playbackPlan = host.buildVoiceReplyPlaybackPlan({
    replyText,
    trailingSoundboardRefs: []
  });
  if (!playbackPlan.spokenText && playedSoundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
    storeExtractedNotes();
    logReplySkipped({
      host,
      params: { ...params, source },
      replyText,
      usedWebSearchFollowup,
      usedScreenShareOffer,
      replyPrompts,
      generatedVoiceAddressing,
      leaveVoiceChannelRequested,
      resolvedConversationContext,
      contextMessages,
      contextTurns,
      contextMessageChars
    });
    clearInFlightAcceptedBrainTurn();
    return true;
  }

  if (
    !streamingVoiceReplyEnabled &&
    playbackPlan.spokenText &&
    providerSupports(session.mode || "", "updateInstructions")
  ) {
    void host.instructionManager.prepareRealtimeTurnContext({
      session,
      settings: params.settings,
      userId: params.userId,
      transcript: normalizedTranscript,
      captureReason: source
    }).catch((error: unknown) => {
      host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: `openai_realtime_turn_context_refresh_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source
        }
      });
    });
  }

  const streamedSpeechPlayed = streamedSentenceCount > 0;
  const replyRequestedAt = streamedReplyRequestedAt || Date.now();
  const replyLatencyContext = {
    finalizedAtMs: latencyFinalizedAtMs,
    asrStartedAtMs: latencyAsrStartedAtMs,
    asrCompletedAtMs: latencyAsrCompletedAtMs,
    generationStartedAtMs: generationStartedAt,
    replyRequestedAtMs: replyRequestedAt,
    audioStartedAtMs: 0,
    source,
    captureReason: latencyCaptureReason,
    queueWaitMs: latencyQueueWaitMs,
    pendingQueueDepth: latencyPendingQueueDepth
  };
  session.lastAssistantReplyAt = replyRequestedAt;

  const playbackSource = `${source}:reply`;
  if (!streamedSpeechPlayed && playbackPlan.steps.length > 0) {
    markInFlightAcceptedBrainTurnPhase("playback_requested");
  }
  const playbackResult = await (async () => {
    try {
      return streamedSpeechPlayed
        ? {
          completed: true,
          spokeLine: Boolean(playbackPlan.spokenText),
          requestedRealtimeUtterance: streamedRequestedRealtimeUtterance,
          playedSoundboardCount: playedSoundboardRefs.length
        }
        : await host.playVoiceReplyInOrder({
          session,
          settings: params.settings,
          spokenText: playbackPlan.spokenText,
          playbackSteps: playbackPlan.steps,
          source: playbackSource,
          preferRealtimeUtterance: useRealtimeTts,
          interruptionPolicy: replyInterruptionPolicy,
          outputLeaseMode: replyOutputLeaseMode,
          latencyContext: replyLatencyContext,
          musicWakeRefreshAfterSpeech: shouldRefreshMusicWakeAfterSpeech,
          // Derive supersede user from resolved addressing:
          // TO:ALL → null (un-supersedable). TO:specific or no addressing → triggering speaker.
          replyUserId: generatedVoiceAddressing?.talkingTo === "ALL"
            ? null
            : (replyInterruptionPolicy?.allowedUserId || params.userId || null)
        });
    } finally {
      clearInFlightAcceptedBrainTurn();
    }
  })();
  if (!playbackResult.completed) {
    if (playbackPlan.spokenText) {
      host.recordVoiceTurn(session, {
        role: "assistant",
        userId: host.client.user?.id || null,
        text: `[interrupted] ${playbackPlan.spokenText}`,
        addressing: generatedVoiceAddressing
      });
    }
    host.maybeClearActiveReplyInterruptionPolicy(session);
    return false;
  }

  const requestedRealtimeUtterance = Boolean(playbackResult.requestedRealtimeUtterance);
  if (
    shouldRefreshMusicWakeAfterSpeech &&
    playbackResult.spokeLine &&
    !requestedRealtimeUtterance
  ) {
    host.schedulePassiveMusicWakeLatchRefresh({
      session,
      settings: params.settings,
      userId: params.userId || null
    });
  }
  try {
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    host.logVoiceLatencyStage({
      session,
      userId: host.client.user?.id || null,
      stage: "reply_requested",
      source,
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
    if (playbackResult.spokeLine && !requestedRealtimeUtterance) {
      session.lastAudioDeltaAt = replyRequestedAt;
      session.lastAssistantReplyAt = replyRequestedAt;
    }
    if (playbackPlan.spokenText && !requestedRealtimeUtterance) {
      host.recordVoiceTurn(session, {
        role: "assistant",
        userId: host.client.user?.id || null,
        text: playbackPlan.spokenText,
        addressing: generatedVoiceAddressing
      });
    }
    storeExtractedNotes();
    const promptSizeSummary = (() => {
      if (!replyPrompts || typeof replyPrompts !== "object") return {};
      const rp = replyPrompts as Record<string, unknown>;
      const sysChars = typeof rp.systemPrompt === "string" ? rp.systemPrompt.length : 0;
      const userChars = typeof rp.initialUserPrompt === "string" ? rp.initialUserPrompt.length : 0;
      const toolsArr = Array.isArray(rp.tools) ? rp.tools : [];
      const toolDefChars = JSON.stringify(toolsArr).length;
      return {
        systemPromptChars: sysChars,
        userPromptChars: userChars,
        toolCount: toolsArr.length,
        toolDefinitionChars: toolDefChars,
        totalPromptChars: sysChars + userChars + contextMessageChars + toolDefChars
      };
    })();
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "realtime_reply_requested",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source,
        requestId: pendingRequestId,
        replyText: playbackPlan.spokenText || null,
        requestedRealtimeUtterance,
        soundboardRefs: streamedSpeechPlayed
          ? playedSoundboardRefs
          : [...playedSoundboardRefs, ...playbackPlan.soundboardRefs],
        playedSoundboardCount: Number(playbackResult.playedSoundboardCount || playedSoundboardRefs.length || 0),
        usedWebSearchFollowup,
        usedScreenShareOffer,
        talkingTo: generatedVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        leaveVoiceChannelRequested,
        replyPrompts,
        contextTurnsSent: contextMessages.length,
        contextTurnsAvailable: contextTurns.length,
        contextCharsSent: contextMessageChars,
        ...promptSizeSummary
      }
    });
  } catch (error) {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: `realtime_audio_write_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source
      }
    });
  }

  if (!leaveVoiceChannelRequested || session.ending) {
    return true;
  }

  if (playbackPlan.spokenText && playbackResult.spokeLine) {
    await host.waitForLeaveDirectivePlayback({
      session,
      expectRealtimeAudio: requestedRealtimeUtterance,
      source: `${source}:leave_directive`
    });
  }

  await host.endSession({
    guildId: session.guildId,
    reason: "assistant_leave_directive",
    requestedByUserId: host.client.user?.id || null,
    settings: params.settings,
    announcement: "wrapping up vc."
  }).catch((error: unknown) => {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: `assistant_leave_directive_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source
      }
    });
  });

  return true;
}
