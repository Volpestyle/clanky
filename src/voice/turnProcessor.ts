import { getVoiceRuntimeConfig } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import type { ActiveReplyRegistry } from "../tools/activeReplyRegistry.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import {
  computeAsrTranscriptConfidence,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
import {
  MIN_RESPONSE_REQUEST_GAP_MS,
  OPENAI_ACTIVE_RESPONSE_RETRY_MS,
  REALTIME_TURN_COALESCE_MAX_BYTES,
  REALTIME_TURN_PENDING_MERGE_MAX_BYTES,
  REALTIME_TURN_QUEUE_MAX,
  REALTIME_TURN_STALE_SKIP_MS,
  RESPONSE_FLUSH_DEBOUNCE_MS,
  STT_TRANSCRIPT_MAX_CHARS,
  FILE_ASR_TURN_COALESCE_MAX_BYTES,
  FILE_ASR_TURN_COALESCE_WINDOW_MS,
  FILE_ASR_TURN_QUEUE_MAX,
  FILE_ASR_TURN_STALE_SKIP_MS,
  VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD,
  VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
  VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX,
  VOICE_FALLBACK_NOISE_GATE_PEAK_MAX,
  VOICE_FALLBACK_NOISE_GATE_RMS_MAX,
  VOICE_TURN_MIN_ASR_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import {
  getRealtimeCommitMinimumBytes,
  isRealtimeMode,
  isVoiceTurnAddressedToBot,
  normalizeVoiceText,
  resolveVoiceAsrLanguageGuidance
} from "./voiceSessionHelpers.ts";
import type { ReplyManager } from "./replyManager.ts";
import type {
  OutputChannelState,
  RealtimeQueuedTurn,
  FileAsrQueuedTurn,
  VoiceAddressingAnnotation,
  VoiceAddressingState,
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceSession,
  VoiceTranscriptLogprob
} from "./voiceSessionTypes.ts";
import { providerSupports } from "./voiceModes.ts";

type TurnProcessorSettings = Record<string, unknown> | null;

interface PcmSilenceGateResult {
  clipDurationMs: number;
  sampleCount: number;
  rms: number;
  peak: number;
  activeSampleRatio: number;
  drop: boolean;
}

interface TurnDecisionTranscriptionContext {
  usedFallbackModel?: boolean;
  captureReason?: string;
  clipDurationMs?: number;
}

interface QueueRealtimeTurnArgs {
  session: VoiceSession;
  userId: string;
  pcmBuffer?: Buffer | Uint8Array | null;
  captureReason?: string;
  finalizedAt?: number;
  transcriptOverride?: string;
  clipDurationMsOverride?: number;
  asrStartedAtMsOverride?: number;
  asrCompletedAtMsOverride?: number;
  transcriptionModelPrimaryOverride?: string | null;
  transcriptionModelFallbackOverride?: string | null;
  transcriptionPlanReasonOverride?: string;
  usedFallbackModelForTranscriptOverride?: boolean;
  transcriptLogprobsOverride?: VoiceTranscriptLogprob[] | null;
  bridgeUtteranceId?: number | null;
}

interface RunRealtimeTurnArgs extends QueueRealtimeTurnArgs {
  queuedAt?: number;
  bridgeRevision?: number;
  mergedTurnCount?: number;
  droppedHeadBytes?: number;
}

interface QueueFileAsrTurnArgs {
  session: VoiceSession;
  userId: string;
  pcmBuffer: Buffer;
  captureReason?: string;
}

interface RunFileAsrTurnArgs extends QueueFileAsrTurnArgs {
  queuedAt?: number;
}

interface MaybeHandleMusicPlaybackTurnArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string;
  pcmBuffer: Buffer;
  captureReason?: string;
  source: "realtime" | "file_asr";
  transcript?: string;
}

interface TranscribePcmTurnArgs {
  session: VoiceSession;
  userId: string;
  pcmBuffer: Buffer;
  model: string;
  sampleRateHz?: number;
  captureReason?: string;
  traceSource?: string;
  errorPrefix?: string;
  emptyTranscriptRuntimeEvent?: string;
  emptyTranscriptErrorStreakThreshold?: number;
  suppressEmptyTranscriptLogs?: boolean;
  asrLanguage?: string;
  asrPrompt?: string;
}

interface QueueVoiceMemoryIngestArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string;
  transcript: string;
  source?: string;
  captureReason?: string;
  errorPrefix?: string;
}

interface EvaluateVoiceReplyDecisionArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string;
  transcript: string;
  source: string;
  transcriptionContext?: TurnDecisionTranscriptionContext;
}

interface NormalizeVoiceAddressingAnnotationArgs {
  rawAddressing?: unknown;
  directAddressed?: boolean;
  directedConfidence?: number;
  source?: string;
  reason?: string;
}

interface AnnotateLatestVoiceTurnAddressingArgs {
  session: VoiceSession;
  role: "assistant" | "user";
  userId?: string | null;
  text: string;
  addressing: VoiceAddressingAnnotation | null;
}

interface QueueDeferredBotTurnOpenTurnArgs {
  session: VoiceSession;
  userId?: string | null;
  transcript?: string;
  pcmBuffer?: Buffer | null;
  captureReason?: string;
  source?: string;
  directAddressed?: boolean;
  deferReason?: string;
  flushDelayMs?: number | null;
}

interface ForwardRealtimeTurnAudioArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string | null;
  transcript?: string;
  pcmBuffer: Buffer;
  captureReason?: string;
}

interface ForwardRealtimeTextTurnToBrainArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string | null;
  transcript?: string;
  captureReason?: string;
  source?: string;
  directAddressed?: boolean;
  conversationContext?: VoiceConversationContext | null;
  latencyContext?: Record<string, unknown> | null;
}

interface RunRealtimeBrainReplyArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId: string | null;
  transcript?: string;
  inputKind?: string;
  directAddressed?: boolean;
  directAddressConfidence?: number;
  conversationContext?: VoiceConversationContext | null;
  source?: string;
  latencyContext?: Record<string, unknown> | null;
  forceSpokenOutput?: boolean;
  spokenOutputRetryCount?: number;
  frozenFrameSnapshot?: { mimeType: string; dataBase64: string } | null;
}

type TurnProcessorStoreLike = {
  getSettings: () => TurnProcessorSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type TurnProcessorLlmLike = {
  isAsrReady?: () => boolean;
  transcribeAudio?: unknown;
  synthesizeSpeech?: unknown;
} | null;

export interface TurnProcessorHost {
  store: TurnProcessorStoreLike;
  llm?: TurnProcessorLlmLike;
  replyManager: Pick<
    ReplyManager,
    "clearPendingResponse" | "createTrackedAudioResponse" | "getOutputLockDebugMetadata" | "isRealtimeResponseActive"
  >;
  activeReplies?: ActiveReplyRegistry | null;
  maybeHandleMusicPlaybackTurn: (
    args: MaybeHandleMusicPlaybackTurnArgs
  ) => Promise<boolean> | boolean;
  evaluatePcmSilenceGate: (args: {
    pcmBuffer: Buffer;
    sampleRateHz?: number;
  }) => PcmSilenceGateResult;
  transcribePcmTurn: (args: TranscribePcmTurnArgs) => Promise<string>;
  shouldPersistUserTranscriptTimelineTurn: (args: {
    session: VoiceSession;
    settings?: TurnProcessorSettings;
    transcript?: string;
  }) => boolean;
  recordVoiceTurn: (
    session: VoiceSession,
    turn: {
      role: "assistant" | "user";
      userId?: string | null;
      text: string;
    }
  ) => void;
  queueVoiceMemoryIngest: (args: QueueVoiceMemoryIngestArgs) => void;
  evaluateVoiceReplyDecision: (
    args: EvaluateVoiceReplyDecisionArgs
  ) => Promise<VoiceReplyDecision>;
  normalizeVoiceAddressingAnnotation: (
    args: NormalizeVoiceAddressingAnnotationArgs
  ) => VoiceAddressingAnnotation | null;
  annotateLatestVoiceTurnAddressing: (args: AnnotateLatestVoiceTurnAddressingArgs) => void;
  buildVoiceAddressingState: (args: {
    session: VoiceSession;
    userId?: string | null;
    now?: number;
  }) => VoiceAddressingState | null;
  shouldUseNativeRealtimeReply: (args: {
    session: VoiceSession;
    settings?: TurnProcessorSettings;
  }) => boolean;
  queueDeferredBotTurnOpenTurn: (args: QueueDeferredBotTurnOpenTurnArgs) => void;
  clearDeferredQueuedUserTurns: (session: VoiceSession) => void;
  forwardRealtimeTurnAudio: (args: ForwardRealtimeTurnAudioArgs) => Promise<boolean>;
  shouldUseRealtimeTranscriptBridge: (args: {
    session: VoiceSession;
    settings?: TurnProcessorSettings;
  }) => boolean;
  forwardRealtimeTextTurnToBrain: (
    args: ForwardRealtimeTextTurnToBrainArgs
  ) => Promise<boolean>;
  requestRealtimePromptUtterance: (args: {
    session: VoiceSession;
    prompt: string;
    userId?: string | null;
    source?: string;
  }) => boolean;
  clearVoiceCommandSession: (session: VoiceSession) => void;
  runRealtimeBrainReply: (args: RunRealtimeBrainReplyArgs) => Promise<boolean>;
  touchActivity: (guildId: string, settings?: TurnProcessorSettings) => void;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  countHumanVoiceParticipants: (session: VoiceSession) => number;
}

export class TurnProcessor {
  constructor(private readonly host: TurnProcessorHost) {}

  private resolveActiveVoiceCommandState(session: VoiceSession) {
    const state =
      session?.voiceCommandState && typeof session.voiceCommandState === "object"
        ? session.voiceCommandState
        : null;
    if (!state) return null;
    const expiresAt = Number(state.expiresAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
      return null;
    }
    return state;
  }

  private buildVoiceCancelContext({
    session,
    userId = null,
    transcript = "",
    settings = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    transcript?: string;
    settings?: TurnProcessorSettings;
  }) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    const normalizedUserId = String(userId || "").trim() || null;
    const pendingResponse =
      session?.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
    const activeCommandState = this.resolveActiveVoiceCommandState(session);
    const outputChannelState = this.host.getOutputChannelState(session);
    const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
    const activeVoiceGeneration = Boolean(this.host.activeReplies?.has(voiceReplyScopeKey));
    const participantCount = Math.max(0, Number(this.host.countHumanVoiceParticipants(session) || 0));
    const pendingResponseOwnerUserId = String(pendingResponse?.userId || "").trim() || null;
    const lastRealtimeToolCallerUserId = String(session?.lastRealtimeToolCallerUserId || "").trim() || null;
    const commandOwnerUserId = String(activeCommandState?.userId || "").trim() || null;
    const ownerMatched = Boolean(
      normalizedUserId &&
      [pendingResponseOwnerUserId, lastRealtimeToolCallerUserId, commandOwnerUserId]
        .filter(Boolean)
        .some((ownerUserId) => ownerUserId === normalizedUserId)
    );
    const directAddressed = normalizedTranscript
      ? isVoiceTurnAddressedToBot(normalizedTranscript, settings)
      : false;
    const implicitSingleSpeakerStanding = participantCount > 0 && participantCount <= 1;
    const hasCancelableWork = Boolean(
      pendingResponse ||
      outputChannelState.pendingResponse ||
      outputChannelState.openAiActiveResponse ||
      outputChannelState.awaitingToolOutputs ||
      outputChannelState.toolCallsRunning ||
      activeVoiceGeneration ||
      activeCommandState
    );

    return {
      normalizedTranscript,
      pendingResponse,
      activeCommandState,
      outputChannelState,
      participantCount,
      pendingResponseOwnerUserId,
      lastRealtimeToolCallerUserId,
      commandOwnerUserId,
      ownerMatched,
      directAddressed,
      implicitSingleSpeakerStanding,
      speakerHasStanding: ownerMatched || directAddressed || implicitSingleSpeakerStanding,
      hasCancelableWork,
      activeVoiceGeneration
    };
  }

  private buildVoiceCancelAcknowledgementPrompt({
    transcript = "",
    cancelContext
  }: {
    transcript?: string;
    cancelContext: ReturnType<TurnProcessor["buildVoiceCancelContext"]>;
  }) {
    const pendingResponseSource = String(cancelContext.pendingResponse?.source || "").trim() || "none";
    const pendingUtterance =
      normalizeVoiceText(cancelContext.pendingResponse?.utteranceText || "", STT_TRANSCRIPT_MAX_CHARS) || "none";
    const activeCommand =
      cancelContext.activeCommandState
        ? `${String(cancelContext.activeCommandState.domain || "").trim() || "unknown"}:${String(cancelContext.activeCommandState.intent || "").trim() || "unknown"}`
        : "none";

    return [
      "A user just cancelled the work you were doing.",
      `User said: "${cancelContext.normalizedTranscript || normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS) || "stop"}".`,
      `Interrupted work: pending response source=${pendingResponseSource}; pending utterance=${pendingUtterance}; active response=${cancelContext.outputChannelState.openAiActiveResponse ? "yes" : "no"}; tool calls running=${cancelContext.outputChannelState.toolCallsRunning ? "yes" : "no"}; awaiting tool outputs=${cancelContext.outputChannelState.awaitingToolOutputs ? "yes" : "no"}; active command=${activeCommand}.`,
      "Acknowledge briefly in one short spoken sentence.",
      "Do not continue, restart, or summarize the cancelled task unless the user asks."
    ].join(" ");
  }

  private cancelRealtimeSessionWork({
    session,
    userId = null,
    transcript = "",
    source = "realtime",
    captureReason = "stream_end",
    cancelContext = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    transcript?: string;
    source?: string;
    captureReason?: string;
    cancelContext?: ReturnType<TurnProcessor["buildVoiceCancelContext"]> | null;
  }) {
    if (!session || session.ending) return;
    const resolvedCancelContext =
      cancelContext ||
      this.buildVoiceCancelContext({
        session,
        userId,
        transcript,
        settings: session.settingsSnapshot || this.host.store.getSettings()
      });
    let responseCancelSucceeded = false;
    let cancelAcknowledgementQueued = false;
    const cancelActiveResponse = session.realtimeClient?.cancelActiveResponse;
    if (typeof cancelActiveResponse === "function") {
      try {
        responseCancelSucceeded = Boolean(cancelActiveResponse.call(session.realtimeClient));
      } catch {
        responseCancelSucceeded = false;
      }
    }
    this.host.replyManager.clearPendingResponse(session);
    this.host.clearVoiceCommandSession(session);
    cancelAcknowledgementQueued = this.host.requestRealtimePromptUtterance({
      session,
      userId:
        userId ||
        resolvedCancelContext.pendingResponseOwnerUserId ||
        resolvedCancelContext.lastRealtimeToolCallerUserId ||
        resolvedCancelContext.commandOwnerUserId ||
        null,
      source: "voice_turn_cancel_acknowledgement",
      prompt: this.buildVoiceCancelAcknowledgementPrompt({
        transcript,
        cancelContext: resolvedCancelContext
      })
    });
    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_cancel_intent",
      metadata: {
        sessionId: session.id,
        source,
        captureReason,
        transcript: normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS) || null,
        hasCancelableWork: resolvedCancelContext.hasCancelableWork,
        speakerHasStanding: resolvedCancelContext.speakerHasStanding,
        ownerMatched: resolvedCancelContext.ownerMatched,
        directAddressed: resolvedCancelContext.directAddressed,
        implicitSingleSpeakerStanding: resolvedCancelContext.implicitSingleSpeakerStanding,
        participantCount: resolvedCancelContext.participantCount,
        pendingResponseOwnerUserId: resolvedCancelContext.pendingResponseOwnerUserId,
        lastRealtimeToolCallerUserId: resolvedCancelContext.lastRealtimeToolCallerUserId,
        commandOwnerUserId: resolvedCancelContext.commandOwnerUserId,
        responseCancelSucceeded,
        cancelAcknowledgementQueued
      }
    });
  }

  private maybeHandleVoiceCancelIntent({
    session,
    userId = null,
    transcript = "",
    settings = null,
    source = "realtime",
    captureReason = "stream_end"
  }: {
    session: VoiceSession;
    userId?: string | null;
    transcript?: string;
    settings?: TurnProcessorSettings;
    source?: "realtime" | "file_asr";
    captureReason?: string;
  }) {
    const cancelContext = this.buildVoiceCancelContext({
      session,
      userId,
      transcript,
      settings
    });
    if (!cancelContext.normalizedTranscript || !isCancelIntent(cancelContext.normalizedTranscript)) {
      return false;
    }
    if (!cancelContext.hasCancelableWork || !cancelContext.speakerHasStanding) {
      return false;
    }
    this.cancelRealtimeSessionWork({
      session,
      userId,
      transcript: cancelContext.normalizedTranscript,
      source,
      captureReason,
      cancelContext
    });
    return true;
  }

  private resolveMergedRealtimeTranscript(existingTranscript = "", incomingTranscript = "") {
    const existing = normalizeVoiceText(existingTranscript, STT_TRANSCRIPT_MAX_CHARS);
    const incoming = normalizeVoiceText(incomingTranscript, STT_TRANSCRIPT_MAX_CHARS);
    if (!existing) return incoming;
    if (!incoming) return existing;
    if (existing === incoming) return existing;
    if (incoming.startsWith(existing) || incoming.includes(existing)) return incoming;
    if (existing.startsWith(incoming) || existing.includes(incoming)) return existing;
    return normalizeVoiceText(`${existing} ${incoming}`, STT_TRANSCRIPT_MAX_CHARS);
  }

  private buildQueuedRealtimeTurn({
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
    usedFallbackModelForTranscriptOverride = false,
    transcriptLogprobsOverride = null,
    bridgeUtteranceId = null
  }: QueueRealtimeTurnArgs): RealtimeQueuedTurn | null {
    if (!session || session.ending) return null;
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const normalizedTranscriptOverride = normalizeVoiceText(transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedPcmBuffer.length && !normalizedTranscriptOverride) return null;
    const queuedAt = Date.now();
    const normalizedFinalizedAt = Math.max(0, Number(finalizedAt || 0)) || queuedAt;
    return {
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
      transcriptLogprobsOverride: Array.isArray(transcriptLogprobsOverride)
        ? transcriptLogprobsOverride
        : null,
      bridgeUtteranceId: Math.max(0, Number(bridgeUtteranceId || 0)) || null,
      bridgeRevision: 1,
      mergedTurnCount: 1,
      droppedHeadBytes: 0
    };
  }

  private buildRevisedRealtimeTurn(
    existingTurn: RealtimeQueuedTurn,
    incomingTurn: RealtimeQueuedTurn
  ): RealtimeQueuedTurn {
    const mergedTranscript = this.resolveMergedRealtimeTranscript(
      existingTurn.transcriptOverride || "",
      incomingTurn.transcriptOverride || ""
    );
    const existingLogprobs = Array.isArray(existingTurn.transcriptLogprobsOverride)
      ? existingTurn.transcriptLogprobsOverride
      : [];
    const incomingLogprobs = Array.isArray(incomingTurn.transcriptLogprobsOverride)
      ? incomingTurn.transcriptLogprobsOverride
      : [];
    const mergedLogprobs =
      existingLogprobs.length > 0 || incomingLogprobs.length > 0
        ? [...existingLogprobs, ...incomingLogprobs]
        : null;
    return {
      ...existingTurn,
      ...incomingTurn,
      pcmBuffer: incomingTurn.pcmBuffer.length > 0 ? incomingTurn.pcmBuffer : existingTurn.pcmBuffer,
      transcriptOverride: mergedTranscript || null,
      transcriptLogprobsOverride: mergedLogprobs,
      queuedAt: Math.max(0, Number(existingTurn.queuedAt || 0), Number(incomingTurn.queuedAt || 0)),
      finalizedAt: Math.max(0, Number(existingTurn.finalizedAt || 0), Number(incomingTurn.finalizedAt || 0)),
      bridgeUtteranceId:
        Math.max(0, Number(incomingTurn.bridgeUtteranceId || existingTurn.bridgeUtteranceId || 0)) || null,
      bridgeRevision: Math.max(1, Number(existingTurn.bridgeRevision || 1)) + 1
    };
  }

  private hasRealtimeOutputStarted(session: VoiceSession) {
    if (!session || session.ending) return false;
    const pending = session.pendingResponse;
    const pendingRequestedAt = Math.max(0, Number(pending?.requestedAt || 0));
    return (
      Boolean(session.botTurnOpen) ||
      (pendingRequestedAt > 0 && Number(session.lastAudioDeltaAt || 0) >= pendingRequestedAt)
    );
  }

  private queueRevisedRealtimeTurn(session: VoiceSession, revisedTurn: RealtimeQueuedTurn) {
    const pendingQueue = this.ensurePendingRealtimeTurnQueue(session);
    const pendingIndex = this.findPendingRealtimeTurnIndexByUtteranceId(
      pendingQueue,
      revisedTurn.bridgeUtteranceId
    );
    if (pendingIndex >= 0) {
      pendingQueue.splice(pendingIndex, 1, revisedTurn);
      return;
    }
    pendingQueue.unshift(revisedTurn);
  }

  private markRealtimeTurnSuperseded(session: VoiceSession, revisedTurn: RealtimeQueuedTurn) {
    if (!session || session.ending) return false;
    if (this.hasRealtimeOutputStarted(session)) {
      return false;
    }

    const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
    let responseCancelSucceeded = false;
    const cancelActiveResponse = session.realtimeClient?.cancelActiveResponse;
    if (typeof cancelActiveResponse === "function") {
      try {
        responseCancelSucceeded = Boolean(cancelActiveResponse.call(session.realtimeClient));
      } catch {
        responseCancelSucceeded = false;
      }
    }
    let activeReplyAbortCount = 0;
    if (session.pendingResponse && typeof session.pendingResponse === "object") {
      this.host.replyManager.clearPendingResponse(session);
    } else {
      activeReplyAbortCount = this.host.activeReplies?.abortAll(
        voiceReplyScopeKey,
        "Superseded by revised ASR transcript"
      ) || 0;
    }
    session.activeRealtimeTurn = revisedTurn;
    this.queueRevisedRealtimeTurn(session, revisedTurn);
    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: revisedTurn.userId,
      content: "realtime_turn_revised_pre_audio",
      metadata: {
        sessionId: session.id,
        captureReason: String(revisedTurn.captureReason || "stream_end"),
        bridgeUtteranceId: revisedTurn.bridgeUtteranceId,
        bridgeRevision: revisedTurn.bridgeRevision,
        responseCancelSucceeded,
        activeReplyAbortCount,
        queueDepth: this.ensurePendingRealtimeTurnQueue(session).length
      }
    });
    return true;
  }

  private isRealtimeTurnSuperseded(
    session: VoiceSession,
    bridgeUtteranceId: number | null,
    bridgeRevision: number
  ) {
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    if (!normalizedBridgeUtteranceId) return false;
    const activeTurn = session.activeRealtimeTurn && typeof session.activeRealtimeTurn === "object"
      ? session.activeRealtimeTurn
      : null;
    if (!activeTurn) return false;
    return (
      Number(activeTurn.bridgeUtteranceId || 0) === normalizedBridgeUtteranceId &&
      Number(activeTurn.bridgeRevision || 0) > Math.max(0, Number(bridgeRevision || 0))
    );
  }

  getRealtimeTurnBacklogSize(session: VoiceSession | null | undefined) {
    if (!session) return 0;
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns)
      ? session.pendingRealtimeTurns.length
      : 0;
    return Math.max(0, (session.realtimeTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  private findPendingRealtimeTurnIndexByUtteranceId(
    pendingQueue: RealtimeQueuedTurn[],
    bridgeUtteranceId: number | null
  ) {
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    if (!normalizedBridgeUtteranceId) return -1;
    return pendingQueue.findIndex(
      (turn) => Math.max(0, Number(turn?.bridgeUtteranceId || 0)) === normalizedBridgeUtteranceId
    );
  }

  mergeRealtimeQueuedTurn(
    existingTurn: RealtimeQueuedTurn | null | undefined,
    incomingTurn: RealtimeQueuedTurn | null | undefined
  ): RealtimeQueuedTurn | null {
    if (!existingTurn) return incomingTurn || null;
    if (!incomingTurn) return existingTurn;

    const existingBuffer = Buffer.isBuffer(existingTurn.pcmBuffer) ? existingTurn.pcmBuffer : Buffer.alloc(0);
    const incomingBuffer = Buffer.isBuffer(incomingTurn.pcmBuffer) ? incomingTurn.pcmBuffer : Buffer.alloc(0);
    const mergedTranscript = this.resolveMergedRealtimeTranscript(
      existingTurn.transcriptOverride || "",
      incomingTurn.transcriptOverride || ""
    );

    const incomingTranscript = normalizeVoiceText(incomingTurn.transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);

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

    const existingLogprobs = Array.isArray(existingTurn.transcriptLogprobsOverride)
      ? existingTurn.transcriptLogprobsOverride
      : [];
    const incomingLogprobs = Array.isArray(incomingTurn.transcriptLogprobsOverride)
      ? incomingTurn.transcriptLogprobsOverride
      : [];
    const mergedLogprobs =
      existingLogprobs.length > 0 || incomingLogprobs.length > 0
        ? [...existingLogprobs, ...incomingLogprobs]
        : null;
    const existingBridgeUtteranceId = Math.max(0, Number(existingTurn.bridgeUtteranceId || 0)) || null;
    const incomingBridgeUtteranceId = Math.max(0, Number(incomingTurn.bridgeUtteranceId || 0)) || null;
    const mergedBridgeUtteranceId =
      existingBridgeUtteranceId &&
      incomingBridgeUtteranceId &&
      existingBridgeUtteranceId === incomingBridgeUtteranceId
        ? existingBridgeUtteranceId
        : null;
    const mergedBridgeRevision = mergedBridgeUtteranceId
      ? Math.max(
        1,
        Number(existingTurn.bridgeRevision || 1),
        Number(incomingTurn.bridgeRevision || 1)
      )
      : 1;

    return {
      ...existingTurn,
      ...incomingTurn,
      pcmBuffer: mergedBuffer,
      transcriptOverride: mergedTranscript || null,
      transcriptLogprobsOverride: mergedLogprobs,
      queuedAt: Number(incomingTurn.queuedAt || Date.now()),
      finalizedAt: mergedFinalizedAt || 0,
      bridgeUtteranceId: mergedBridgeUtteranceId,
      bridgeRevision: mergedBridgeRevision,
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
    usedFallbackModelForTranscriptOverride = false,
    transcriptLogprobsOverride = null,
    bridgeUtteranceId = null
  }: QueueRealtimeTurnArgs) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const pendingQueue = this.ensurePendingRealtimeTurnQueue(session);
    const queuedTurn = this.buildQueuedRealtimeTurn({
      session,
      userId,
      pcmBuffer,
      captureReason,
      finalizedAt,
      transcriptOverride,
      clipDurationMsOverride,
      asrStartedAtMsOverride,
      asrCompletedAtMsOverride,
      transcriptionModelPrimaryOverride,
      transcriptionModelFallbackOverride,
      transcriptionPlanReasonOverride,
      usedFallbackModelForTranscriptOverride,
      transcriptLogprobsOverride,
      bridgeUtteranceId
    });
    if (!queuedTurn) return;

    const activeTurn = session.activeRealtimeTurn && typeof session.activeRealtimeTurn === "object"
      ? session.activeRealtimeTurn
      : null;
    if (
      activeTurn &&
      queuedTurn.bridgeUtteranceId &&
      Math.max(0, Number(activeTurn.bridgeUtteranceId || 0)) === queuedTurn.bridgeUtteranceId
    ) {
      const revisedTurn = this.buildRevisedRealtimeTurn(activeTurn, queuedTurn);
      const superseded = this.markRealtimeTurnSuperseded(session, revisedTurn);
      if (!superseded && this.hasRealtimeOutputStarted(session)) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_revision_ignored_after_output_start",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            bridgeUtteranceId: revisedTurn.bridgeUtteranceId,
            bridgeRevision: revisedTurn.bridgeRevision
          }
        });
      }
      return;
    }

    const pendingIndex = this.findPendingRealtimeTurnIndexByUtteranceId(
      pendingQueue,
      queuedTurn.bridgeUtteranceId
    );
    if (pendingIndex >= 0) {
      const existingPendingTurn = pendingQueue[pendingIndex];
      const revisedPendingTurn = this.buildRevisedRealtimeTurn(existingPendingTurn, queuedTurn);
      pendingQueue.splice(pendingIndex, 1, revisedPendingTurn);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_revised_pending",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          bridgeUtteranceId: revisedPendingTurn.bridgeUtteranceId,
          bridgeRevision: revisedPendingTurn.bridgeRevision,
          queueDepth: pendingQueue.length
        }
      });
      return;
    }

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
      this.spawnRealtimeTurnDrain(nextTurn, "pending_queue_merge");
      return;
    }

    const pcmBytes = queuedTurn.pcmBuffer?.length || 0;
    const skipCoalesce =
      pcmBytes >= REALTIME_TURN_COALESCE_MAX_BYTES ||
      session.ending;

    // Disabled to reduce end-of-turn latency. Keep the old hold path nearby so
    // we can restore it quickly if immediate draining proves too eager.
    // if (!skipCoalesce && REALTIME_TURN_COALESCE_WINDOW_MS > 0) {
    //   pendingQueue.push(queuedTurn);
    //   session.realtimeTurnCoalesceTimer = setTimeout(() => {
    //     session.realtimeTurnCoalesceTimer = null;
    //     if (session.ending) return;
    //     let turn = pendingQueue.shift() || null;
    //     while (pendingQueue.length > 0) {
    //       const next = pendingQueue.shift();
    //       if (!next) continue;
    //       turn = turn ? this.mergeRealtimeQueuedTurn(turn, next) : next;
    //     }
    //     if (turn) {
    //       this.spawnRealtimeTurnDrain(turn, "coalesce_window_flush");
    //     }
    //   }, REALTIME_TURN_COALESCE_WINDOW_MS);
    //   return;
    // }

    if (skipCoalesce && session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }

    this.spawnRealtimeTurnDrain(queuedTurn, "direct_queue_start");
  }

  private spawnRealtimeTurnDrain(turn: RealtimeQueuedTurn, trigger: string) {
    const session = turn?.session;
    void Promise.resolve(this.drainRealtimeTurnQueue(turn)).catch((error: unknown) => {
      if (!session) return;
      const pendingQueue = this.ensurePendingRealtimeTurnQueue(session);
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: turn.userId,
        content: `realtime_turn_queue_drain_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          trigger,
          captureReason: String(turn.captureReason || "stream_end"),
          pendingQueueDepth: pendingQueue.length
        }
      });
      if (session.ending) return;
      session.realtimeTurnDrainActive = false;
      const pending = pendingQueue.shift();
      if (pending) {
        this.spawnRealtimeTurnDrain(pending, "recovery_after_failure");
      }
    });
  }

  async drainRealtimeTurnQueue(initialTurn: RealtimeQueuedTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.realtimeTurnDrainActive) return;
    const pendingQueue = this.ensurePendingRealtimeTurnQueue(session);

    session.realtimeTurnDrainActive = true;
    let turn: RealtimeQueuedTurn | null = initialTurn;

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
          this.spawnRealtimeTurnDrain(pending, "finally_continue_pending");
        }
      }
    }
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
    usedFallbackModelForTranscriptOverride = false,
    transcriptLogprobsOverride = null,
    bridgeUtteranceId = null,
    bridgeRevision = 1,
    mergedTurnCount = 1,
    droppedHeadBytes = 0
  }: RunRealtimeTurnArgs) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
    const normalizedPcmBuffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const normalizedTranscriptOverride = normalizeVoiceText(transcriptOverride, STT_TRANSCRIPT_MAX_CHARS);
    const hasTranscriptOverride = Boolean(normalizedTranscriptOverride);
    if (!normalizedPcmBuffer?.length && !hasTranscriptOverride) return;
    const normalizedBridgeUtteranceId = Math.max(0, Number(bridgeUtteranceId || 0)) || null;
    const normalizedBridgeRevision = Math.max(1, Number(bridgeRevision || 1));
    const currentTurn: RealtimeQueuedTurn = {
      session,
      userId,
      pcmBuffer: normalizedPcmBuffer.length ? normalizedPcmBuffer : Buffer.alloc(0),
      captureReason,
      queuedAt: Math.max(0, Number(queuedAt || Date.now())) || Date.now(),
      finalizedAt: Math.max(0, Number(finalizedAt || 0)) || Math.max(0, Number(queuedAt || Date.now())) || Date.now(),
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
      transcriptLogprobsOverride: Array.isArray(transcriptLogprobsOverride)
        ? transcriptLogprobsOverride
        : null,
      bridgeUtteranceId: normalizedBridgeUtteranceId,
      bridgeRevision: normalizedBridgeRevision,
      mergedTurnCount: Math.max(1, Number(mergedTurnCount || 1)),
      droppedHeadBytes: Math.max(0, Number(droppedHeadBytes || 0))
    };
    const isSuperseded = (stage: string) => {
      const superseded = this.isRealtimeTurnSuperseded(
        session,
        normalizedBridgeUtteranceId,
        normalizedBridgeRevision
      );
      if (!superseded) return false;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_superseded",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          bridgeUtteranceId: normalizedBridgeUtteranceId,
          bridgeRevision: normalizedBridgeRevision,
          stage
        }
      });
      return true;
    };
    session.activeRealtimeTurn = currentTurn;
    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const finalizedAtMs = Math.max(0, Number(finalizedAt || 0)) || Math.max(0, Number(queuedAt || 0));

    try {
      if (this.host.activeReplies?.isStale(voiceReplyScopeKey, finalizedAtMs || Date.now())) {
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_skipped_cancelled",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            finalizedAtMs
          }
        });
        return;
      }
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
      const consumedByMusicMode = await this.host.maybeHandleMusicPlaybackTurn({
        session,
        settings,
        userId,
        pcmBuffer: normalizedPcmBuffer,
        captureReason,
        source: "realtime",
        transcript: normalizedTranscriptOverride || undefined
      });
      if (consumedByMusicMode) return;

      const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
      const voiceRuntime = getVoiceRuntimeConfig(settings);
      const preferredModel = voiceRuntime.openaiRealtime?.inputTranscriptionModel;
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
        : this.host.evaluatePcmSilenceGate({
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
        turnTranscript = await this.host.transcribePcmTurn({
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
          turnTranscript = await this.host.transcribePcmTurn({
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

      if (isSuperseded("post_transcription")) return;

      if (turnTranscript && this.maybeHandleVoiceCancelIntent({
        session,
        userId,
        transcript: turnTranscript,
        settings,
        source: "realtime",
        captureReason
      })) {
        return;
      }

      if (
        hasTranscriptOverride &&
        turnTranscript &&
        Array.isArray(transcriptLogprobsOverride) &&
        transcriptLogprobsOverride.length > 0
      ) {
        const confidence = computeAsrTranscriptConfidence(transcriptLogprobsOverride);
        if (confidence && confidence.meanLogprob < VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "voice_turn_dropped_asr_low_confidence",
            metadata: {
              sessionId: session.id,
              source: "realtime",
              captureReason: String(captureReason || "stream_end"),
              transcript: turnTranscript,
              meanLogprob: Number(confidence.meanLogprob.toFixed(4)),
              minLogprob: Number(confidence.minLogprob.toFixed(4)),
              tokenCount: confidence.tokenCount,
              threshold: VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD,
              clipDurationMs
            }
          });
          return;
        }
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

      if (isSuperseded("pre_persist")) return;

      const persistRealtimeTranscriptTurn = this.host.shouldPersistUserTranscriptTimelineTurn({
        session,
        settings,
        transcript: turnTranscript
      });
      if (turnTranscript && persistRealtimeTranscriptTurn) {
        this.host.recordVoiceTurn(session, {
          role: "user",
          userId,
          text: turnTranscript
        });
        this.host.queueVoiceMemoryIngest({
          session,
          settings,
          userId,
          transcript: turnTranscript,
          source: "voice_realtime_ingest",
          captureReason,
          errorPrefix: "voice_realtime_memory_ingest_failed"
        });
      }

      const decision = await this.host.evaluateVoiceReplyDecision({
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
      if (isSuperseded("post_decision")) return;
      if (decision.directAddressed && session && !session.ending) {
        session.lastDirectAddressAt = Date.now();
        session.lastDirectAddressUserId = userId;
      }
      const decisionVoiceAddressing = this.host.normalizeVoiceAddressingAnnotation({
        rawAddressing: decision?.voiceAddressing,
        directAddressed: Boolean(decision.directAddressed),
        directedConfidence: Number(decision.directAddressConfidence),
        source: "decision",
        reason: decision.reason
      });
      this.host.annotateLatestVoiceTurnAddressing({
        session,
        role: "user",
        userId,
        text: decision.transcript || turnTranscript,
        addressing: decisionVoiceAddressing
      });
      const decisionAddressingState = this.host.buildVoiceAddressingState({
        session,
        userId
      });
      const outputLockDebugMetadata = this.host.replyManager.getOutputLockDebugMetadata(
        session,
        decision.outputLockReason || null
      );

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
          ...outputLockDebugMetadata
        }
      });

      const useNativeRealtimeReply = this.host.shouldUseNativeRealtimeReply({ session, settings });
      if (!decision.allow) {
        if (decision.reason === "bot_turn_open") {
          this.host.queueDeferredBotTurnOpenTurn({
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

      // A new turn was allowed — drain any pending deferred turns so they don't
      // independently generate a second response. Their transcripts are already
      // in the conversation window from when they were first captured.
      this.host.clearDeferredQueuedUserTurns(session);

      if (useNativeRealtimeReply) {
        if (!normalizedPcmBuffer?.length) {
          return;
        }
        if (isSuperseded("pre_native_reply")) return;
        await this.host.forwardRealtimeTurnAudio({
          session,
          settings,
          userId,
          transcript: turnTranscript,
          pcmBuffer: normalizedPcmBuffer,
          captureReason
        });
        return;
      }

      if (this.host.shouldUseRealtimeTranscriptBridge({ session, settings })) {
        if (isSuperseded("pre_brain_forward")) return;
        await this.host.forwardRealtimeTextTurnToBrain({
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

      if (isSuperseded("pre_brain_reply")) return;
      await this.host.runRealtimeBrainReply({
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
    } finally {
      if (session.activeRealtimeTurn === currentTurn) {
        session.activeRealtimeTurn = null;
      }
    }
  }

  getPendingFileAsrTurnQueue(session: VoiceSession | null | undefined) {
    if (!session) return [];
    const pendingQueue = Array.isArray(session.pendingFileAsrTurnsQueue) ? session.pendingFileAsrTurnsQueue : [];
    if (!Array.isArray(session.pendingFileAsrTurnsQueue)) {
      session.pendingFileAsrTurnsQueue = pendingQueue;
    }
    return pendingQueue;
  }

  syncPendingFileAsrTurnCount(session: VoiceSession | null | undefined) {
    if (!session) return;
    const pendingQueueDepth = Array.isArray(session.pendingFileAsrTurnsQueue) ? session.pendingFileAsrTurnsQueue.length : 0;
    session.pendingFileAsrTurns = Math.max(0, (session.fileAsrTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  shouldCoalesceFileAsrTurn(
    prevTurn: FileAsrQueuedTurn | null | undefined,
    nextTurn: FileAsrQueuedTurn | null | undefined
  ) {
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
    if (nextQueuedAt - prevQueuedAt > FILE_ASR_TURN_COALESCE_WINDOW_MS) return false;

    const prevBuffer = Buffer.isBuffer(prevTurn.pcmBuffer) ? prevTurn.pcmBuffer : null;
    const nextBuffer = Buffer.isBuffer(nextTurn.pcmBuffer) ? nextTurn.pcmBuffer : null;
    if (!prevBuffer?.length || !nextBuffer?.length) return false;
    if (prevBuffer.length + nextBuffer.length > FILE_ASR_TURN_COALESCE_MAX_BYTES) return false;

    return true;
  }

  queueFileAsrTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }: QueueFileAsrTurnArgs) {
    if (!session || session.ending) return;
    if (!pcmBuffer || !pcmBuffer.length) return;

    const pendingQueue = this.getPendingFileAsrTurnQueue(session);
    const queuedTurn: FileAsrQueuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt: Date.now()
    };

    if (session.fileAsrTurnDrainActive) {
      const lastQueuedTurn = pendingQueue[pendingQueue.length - 1] || null;
      if (this.shouldCoalesceFileAsrTurn(lastQueuedTurn, queuedTurn)) {
        lastQueuedTurn.pcmBuffer = Buffer.concat([lastQueuedTurn.pcmBuffer, queuedTurn.pcmBuffer]);
        lastQueuedTurn.captureReason = queuedTurn.captureReason;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "file_asr_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: lastQueuedTurn.pcmBuffer.length,
            queueDepth: pendingQueue.length
          }
        });
        return;
      }

      if (pendingQueue.length >= FILE_ASR_TURN_QUEUE_MAX) {
        const droppedTurn = pendingQueue.shift();
        if (droppedTurn) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "file_asr_turn_superseded",
            metadata: {
              sessionId: session.id,
              replacedCaptureReason: String(droppedTurn.captureReason || "stream_end"),
              replacingCaptureReason: String(captureReason || "stream_end"),
              replacedQueueAgeMs: Math.max(0, Date.now() - Number(droppedTurn.queuedAt || Date.now())),
              maxQueueDepth: FILE_ASR_TURN_QUEUE_MAX
            }
          });
        }
      }
      pendingQueue.push(queuedTurn);
      this.syncPendingFileAsrTurnCount(session);
      return;
    }

    if (pendingQueue.length > 0) {
      if (pendingQueue.length >= FILE_ASR_TURN_QUEUE_MAX) {
        pendingQueue.shift();
      }
      pendingQueue.push(queuedTurn);
      const nextTurn = pendingQueue.shift();
      if (!nextTurn) return;
      this.spawnFileAsrTurnDrain(nextTurn, "pending_queue_merge");
      return;
    }

    this.spawnFileAsrTurnDrain(queuedTurn, "direct_queue_start");
  }

  private spawnFileAsrTurnDrain(turn: FileAsrQueuedTurn, trigger: string) {
    const session = turn?.session;
    void Promise.resolve(this.drainFileAsrTurnQueue(turn)).catch((error: unknown) => {
      if (!session) return;
      const pendingQueue = this.getPendingFileAsrTurnQueue(session);
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: turn.userId,
        content: `file_asr_turn_queue_drain_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          trigger,
          captureReason: String(turn.captureReason || "stream_end"),
          pendingQueueDepth: pendingQueue.length
        }
      });
      if (session.ending) return;
      session.fileAsrTurnDrainActive = false;
      this.syncPendingFileAsrTurnCount(session);
      const pendingTurn = pendingQueue.shift();
      if (pendingTurn) {
        this.syncPendingFileAsrTurnCount(session);
        this.spawnFileAsrTurnDrain(pendingTurn, "recovery_after_failure");
      }
    });
  }

  async drainFileAsrTurnQueue(initialTurn: FileAsrQueuedTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.fileAsrTurnDrainActive) return;
    const pendingQueue = this.getPendingFileAsrTurnQueue(session);

    session.fileAsrTurnDrainActive = true;
    this.syncPendingFileAsrTurnCount(session);
    let turn: FileAsrQueuedTurn | null = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runFileAsrTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `file_asr_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const nextTurn = pendingQueue.shift();
        turn = nextTurn || null;
        this.syncPendingFileAsrTurnCount(session);
      }
    } finally {
      session.fileAsrTurnDrainActive = false;
      if (session.ending) {
        session.pendingFileAsrTurnsQueue = [];
      } else {
        const pendingTurn = pendingQueue.shift();
        if (pendingTurn) {
          this.syncPendingFileAsrTurnCount(session);
          this.spawnFileAsrTurnDrain(pendingTurn, "finally_continue_pending");
        }
      }
      this.syncPendingFileAsrTurnCount(session);
    }
  }

  async runFileAsrTurn({
    session,
    userId,
    pcmBuffer,
    captureReason = "stream_end",
    queuedAt = 0
  }: RunFileAsrTurnArgs) {
    if (!session || session.ending) return;
    if (!pcmBuffer?.length) return;
    if (!this.llm?.transcribeAudio) return;
    const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
    if (this.host.activeReplies?.isStale(voiceReplyScopeKey, queuedAt || Date.now())) {
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "file_asr_turn_skipped_cancelled",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queuedAt: Number(queuedAt || 0) || null
        }
      });
      return;
    }

    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const pendingQueueDepth = Array.isArray(session.pendingFileAsrTurnsQueue) ? session.pendingFileAsrTurnsQueue.length : 0;
    const staleTurn = queueWaitMs >= FILE_ASR_TURN_STALE_SKIP_MS;
    if (staleTurn && pendingQueueDepth > 1) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "file_asr_turn_skipped_stale",
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
    const consumedByMusicMode = await this.host.maybeHandleMusicPlaybackTurn({
      session,
      settings,
      userId,
      pcmBuffer,
      captureReason,
      source: "file_asr"
    });
    if (consumedByMusicMode) return;

    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const transcriptionModelPrimary =
      String(getVoiceRuntimeConfig(settings).openaiRealtime?.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() ||
      "gpt-4o-mini-transcribe";
    const sampleRateHz = 24000;
    const silenceGate = this.host.evaluatePcmSilenceGate({
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
          source: "file_asr",
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

    let transcript = await this.host.transcribePcmTurn({
      session,
      userId,
      pcmBuffer,
      model: transcriptionModelPrimary,
      sampleRateHz,
      captureReason,
      traceSource: "voice_file_asr_turn",
      errorPrefix: "file_asr_transcription_failed",
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
      transcript = await this.host.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: transcriptionModelFallback,
        sampleRateHz,
        captureReason,
        traceSource: "voice_file_asr_turn_fallback",
        errorPrefix: "file_asr_transcription_fallback_failed",
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
    if (this.maybeHandleVoiceCancelIntent({
      session,
      userId,
      transcript,
      settings,
      source: "file_asr",
      captureReason
    })) {
      return;
    }
    if (session.ending) return;

    this.host.touchActivity(session.guildId, settings);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "file_asr_transcript",
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
    const persistFileAsrTranscriptTurn = this.host.shouldPersistUserTranscriptTimelineTurn({
      session,
      settings,
      transcript
    });
    if (persistFileAsrTranscriptTurn) {
      this.host.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: transcript
      });

      this.host.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript,
        source: "voice_file_asr_ingest",
        captureReason,
        errorPrefix: "voice_file_asr_memory_ingest_failed"
      });
    }
    if (staleTurn) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "file_asr_turn_skipped_stale",
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

    const turnDecision = await this.host.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript,
      source: "file_asr",
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
    const turnVoiceAddressing = this.host.normalizeVoiceAddressingAnnotation({
      rawAddressing: turnDecision?.voiceAddressing,
      directAddressed: Boolean(turnDecision.directAddressed),
      directedConfidence: Number(turnDecision.directAddressConfidence),
      source: "decision",
      reason: turnDecision.reason
    });
    this.host.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId,
      text: turnDecision.transcript || transcript,
      addressing: turnVoiceAddressing
    });
    const turnAddressingState = this.host.buildVoiceAddressingState({
      session,
      userId
    });
    const turnOutputLockDebugMetadata = this.host.replyManager.getOutputLockDebugMetadata(
      session,
      turnDecision.outputLockReason || null
    );

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "file_asr",
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
        outputLockReason: turnDecision.outputLockReason || null,
        classifierLatencyMs: Number.isFinite(turnDecision.classifierLatencyMs)
          ? Math.round(turnDecision.classifierLatencyMs)
          : null,
        classifierDecision: turnDecision.classifierDecision || null,
        classifierConfidence: Number.isFinite(turnDecision.classifierConfidence)
          ? Number(clamp(Number(turnDecision.classifierConfidence), 0, 1).toFixed(3))
          : null,
        classifierTarget: turnDecision.classifierTarget || null,
        classifierReason: turnDecision.classifierReason || null,
        musicWakeLatched: Boolean(turnDecision.conversationContext?.musicWakeLatched),
        musicWakeLatchedUntil: Number(session?.musicWakeLatchedUntil || 0) > 0
          ? new Date(Number(session.musicWakeLatchedUntil)).toISOString()
          : null,
        error: turnDecision.error || null,
        ...turnOutputLockDebugMetadata
      }
    });
    if (!turnDecision.allow) {
      if (turnDecision.reason === "bot_turn_open") {
        this.host.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: turnDecision.transcript || transcript,
          captureReason,
          source: "file_asr",
          directAddressed: Boolean(turnDecision.directAddressed),
          deferReason: turnDecision.reason,
          flushDelayMs: turnDecision.retryAfterMs
        });
      }
      return;
    }

    this.host.clearDeferredQueuedUserTurns(session);

    if (this.host.shouldUseRealtimeTranscriptBridge({ session, settings })) {
      await this.host.forwardRealtimeTextTurnToBrain({
        session,
        settings,
        userId,
        transcript,
        captureReason,
        source: "file_asr_transcript_turn",
        directAddressed: Boolean(turnDecision.directAddressed),
        conversationContext: turnDecision.conversationContext || null
      });
      return;
    }

    await this.host.runRealtimeBrainReply({
      session,
      settings,
      userId,
      transcript,
      directAddressed: Boolean(turnDecision.directAddressed),
      directAddressConfidence: Number(turnDecision.directAddressConfidence),
      conversationContext: turnDecision.conversationContext || null,
      source: "file_asr"
    });
  }

  scheduleResponseFromBufferedAudio({
    session,
    userId = null
  }: {
    session: VoiceSession;
    userId?: string | null;
  }) {
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

  flushResponseFromBufferedAudio({
    session,
    userId = null
  }: {
    session: VoiceSession;
    userId?: string | null;
  }) {
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

    const outputChannelState = this.host.getOutputChannelState(session);
    if (outputChannelState.captureBlocking) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (outputChannelState.bargeInSuppressed) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (outputChannelState.locked) {
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

    if (outputChannelState.turnBacklog > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.host.replyManager.isRealtimeResponseActive(session)) {
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, OPENAI_ACTIVE_RESPONSE_RETRY_MS);
      return;
    }

    try {
      session.realtimeClient.commitInputAudioBuffer();
      session.pendingRealtimeInputBytes = 0;
      const emitCreateEvent =
        !providerSupports(session.mode || "", "textInput") || this.host.shouldUseNativeRealtimeReply({ session });
      const created = this.host.replyManager.createTrackedAudioResponse({
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

  private ensurePendingRealtimeTurnQueue(session: VoiceSession) {
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }
    return pendingQueue;
  }

  private get store() {
    return this.host.store;
  }

  private get llm() {
    return this.host.llm ?? null;
  }
}
