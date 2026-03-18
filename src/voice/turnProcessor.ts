import { getVoiceRuntimeConfig } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import type { ActiveReplyRegistry } from "../tools/activeReplyRegistry.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import {
  computeAsrTranscriptConfidence,
  resolveTurnTranscriptionPlan,
  transcribePcmTurnWithPlan
} from "./voiceDecisionRuntime.ts";
import {
  BOT_TURN_DEFERRED_COALESCE_MAX,
  MIN_RESPONSE_REQUEST_GAP_MS,
  OPENAI_ACTIVE_RESPONSE_RETRY_MS,
  REALTIME_TURN_COALESCE_MAX_BYTES,
  REALTIME_TURN_COALESCE_WINDOW_MS,
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
  inspectAsrTranscript,
  isRealtimeMode,
  normalizeVoiceText,
  resolveTranscriberProvider,
  resolveVoiceAsrLanguageGuidance
} from "./voiceSessionHelpers.ts";
import { setVoiceLivePromptSnapshot } from "./voicePromptState.ts";
import type { ReplyInterruptionPolicy } from "./bargeInController.ts";
import type { ReplyManager } from "./replyManager.ts";
import type {
  DeferredQueuedUserTurn,
  OutputChannelState,
  RealtimeQueuedTurn,
  FileAsrQueuedTurn,
  SpeakerTranscript,
  VoiceAddressingAnnotation,
  VoiceAddressingState,
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceRuntimeEventContext,
  VoiceSession,
  VoiceTranscriptLogprob
} from "./voiceSessionTypes.ts";
import { providerSupports } from "./voiceModes.ts";
import { isSystemSpeechOpportunitySource } from "./systemSpeechOpportunity.ts";
import { resolveVoiceDirectAddressSignal } from "./voiceAddressing.ts";

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
  musicWakeFollowupEligibleAtCapture?: boolean;
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
  serverVadConfirmed?: boolean;
}

interface RunRealtimeTurnArgs extends QueueRealtimeTurnArgs {
  queuedAt?: number;
  replyScopeStartedAt?: number;
  bridgeRevision?: number;
  mergedTurnCount?: number;
  droppedHeadBytes?: number;
  speakerTranscripts?: SpeakerTranscript[] | null;
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
  musicWakeFollowupEligibleAtCapture?: boolean;
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
  speakerTranscripts?: SpeakerTranscript[] | null;
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

interface FlushDeferredBotTurnOpenTurnsArgs {
  session: VoiceSession;
  deferredTurns?: DeferredQueuedUserTurn[] | null;
  reason?: string;
}

interface VoiceTurnDecisionLogContext {
  queueWaitMs?: number | null;
  pendingQueueDepth?: number | null;
  transcriptionModelPrimary?: string | null;
  transcriptionModelFallback?: string | null;
  transcriptionUsedFallbackModel?: boolean;
  transcriptionPlanReason?: string | null;
  clipDurationMs?: number | null;
  asrSkippedShortClip?: boolean;
  deferredActionReason?: string | null;
  deferredTurnCount?: number | null;
  totalDeferredSpeakers?: number | null;
}

interface HandleResolvedVoiceTurnArgs {
  session: VoiceSession;
  settings: TurnProcessorSettings;
  userId?: string | null;
  transcript: string;
  source: string;
  captureReason?: string;
  pcmBuffer?: Buffer | null;
  musicWakeFollowupEligibleAtCapture?: boolean;
  transcriptionContext?: TurnDecisionTranscriptionContext;
  logContext?: VoiceTurnDecisionLogContext | null;
  bridgeSource?: string;
  latencyContext?: Record<string, unknown> | null;
  nativeCaptureReason?: string;
  allowReplyDispatch?: boolean;
  allowAuthorizedOutputLockInterrupt?: boolean;
  shouldAbortStage?: ((stage: "post_decision" | "pre_native_reply" | "pre_brain_forward" | "pre_brain_reply") => boolean) | null;
  /** Per-speaker transcript segments from cross-speaker room coalescing. */
  speakerTranscripts?: SpeakerTranscript[] | null;
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
  speakerTranscripts?: SpeakerTranscript[] | null;
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
  musicWakeFollowupEligibleAtCapture?: boolean;
  source?: string;
  latencyContext?: Record<string, unknown> | null;
  frozenFrameSnapshot?: { mimeType: string; dataBase64: string } | null;
  runtimeEventContext?: VoiceRuntimeEventContext | null;
  speakerTranscripts?: SpeakerTranscript[] | null;
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

interface TurnProcessorHost {
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
  maybeHandlePendingMusicDisambiguationTurn: (args: {
    session?: VoiceSession | null;
    settings?: TurnProcessorSettings;
    userId?: string | null;
    transcript?: string;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  }) => Promise<boolean> | boolean;
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
  getDeferredQueuedUserTurns: (session: VoiceSession) => DeferredQueuedUserTurn[];
  shouldUseNativeRealtimeReply: (args: {
    session: VoiceSession;
    settings?: TurnProcessorSettings;
  }) => boolean;
  queueDeferredBotTurnOpenTurn: (args: QueueDeferredBotTurnOpenTurnArgs) => void;
  scheduleDeferredBotTurnOpenFlush: (args: {
    session: VoiceSession;
    delayMs?: number;
    reason?: string;
  }) => void;
  clearDeferredQueuedUserTurns: (session: VoiceSession) => void;
  shouldDirectAddressedTurnInterruptReply: (args: {
    session: VoiceSession;
    directAddressed?: boolean;
    policy?: ReplyInterruptionPolicy | Record<string, unknown> | null;
  }) => boolean;
  isUserAllowedToInterruptReply: (args: {
    policy?: ReplyInterruptionPolicy | Record<string, unknown> | null;
    userId?: string | null;
  }) => boolean;
  interruptBotSpeechForDirectAddressedTurn: (args: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
  }) => boolean;
  interruptBotSpeechForOutputLockTurn: (args: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
  }) => boolean;
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
  getPendingRealtimeAssistantUtteranceCount: (session: VoiceSession) => number;
  clearPendingRealtimeAssistantUtterances: (session: VoiceSession, reason?: string) => number;
  clearVoiceCommandSession: (session: VoiceSession) => void;
  runRealtimeBrainReply: (args: RunRealtimeBrainReplyArgs) => Promise<boolean>;
  hasCommittedInterruptedBridgeTurn: (args: {
    session: VoiceSession;
    userId?: string | null;
    bridgeUtteranceId?: number | null;
  }) => boolean;
  touchActivity: (guildId: string, settings?: TurnProcessorSettings) => void;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  countHumanVoiceParticipants: (session: VoiceSession) => number;
  /** Returns true if any user *other than* excludeUserId has an active (non-finalized) capture. */
  hasOtherActiveCaptures: (session: VoiceSession, excludeUserId: string) => boolean;
  /** Drain any room-coalesce-held turns in the pending queue. */
  flushHeldRoomCoalesceTurns: (session: VoiceSession, reason?: string) => void;
  /** Resolve a userId to a human-readable display name for logging. */
  resolveVoiceSpeakerName: (session: VoiceSession, userId?: string | null) => string;
}

export class TurnProcessor {
  constructor(private readonly host: TurnProcessorHost) {}

  private reserveRealtimeTurnScopeStartedAt() {
    return this.host.activeReplies?.reserveTimestamp?.() || Date.now();
  }

  private roundUnitInterval(value: unknown, fallback: number | null = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Number(clamp(numeric, 0, 1).toFixed(3));
  }

  private buildVoiceTurnAddressingMetadata({
    session,
    decision,
    decisionVoiceAddressing,
    decisionAddressingState,
    outputLockDebugMetadata,
    source,
    captureReason,
    transcript,
    logContext = null,
    speakerTranscripts = null
  }: {
    session: VoiceSession;
    decision: VoiceReplyDecision;
    decisionVoiceAddressing: VoiceAddressingAnnotation | null;
    decisionAddressingState: VoiceAddressingState | null;
    outputLockDebugMetadata: Record<string, unknown>;
    source: string;
    captureReason?: string;
    transcript: string;
    logContext?: VoiceTurnDecisionLogContext | null;
    speakerTranscripts?: SpeakerTranscript[] | null;
  }) {
    // When multiple speakers are coalesced, format `heard` with per-speaker
    // attribution so log consumers see who said what instead of a flat string.
    const hasCrossSpeaker = Array.isArray(speakerTranscripts) && speakerTranscripts.length > 1;
    let heardValue: string | null = transcript || null;
    let heardPerSpeaker: { speakerName: string; userId: string; transcript: string }[] | undefined;
    if (hasCrossSpeaker) {
      const segments = speakerTranscripts!
        .filter((s) => s && s.transcript)
        .map((s) => {
          const name = this.host.resolveVoiceSpeakerName(session, s.userId) || s.userId || "someone";
          return { speakerName: name, userId: s.userId, transcript: s.transcript };
        });
      if (segments.length > 0) {
        heardValue = segments.map((s) => `[${s.speakerName}]: ${s.transcript}`).join(" | ");
        heardPerSpeaker = segments;
      }
    }

    return {
      sessionId: session.id,
      mode: session.mode,
      source,
      captureReason: String(captureReason || "stream_end"),
      queueWaitMs:
        Number.isFinite(Number(logContext?.queueWaitMs)) ? Math.round(Number(logContext?.queueWaitMs)) : undefined,
      allow: Boolean(decision.allow),
      reason: decision.reason,
      participantCount: Number(decision.participantCount || 0),
      directAddressed: Boolean(decision.directAddressed),
      talkingTo: decisionVoiceAddressing?.talkingTo || null,
      directedConfidence: this.roundUnitInterval(decisionVoiceAddressing?.directedConfidence, 0),
      addressingSource: decisionVoiceAddressing?.source || null,
      addressingReason: decisionVoiceAddressing?.reason || null,
      currentSpeakerTarget: decisionAddressingState?.currentSpeakerTarget || null,
      currentSpeakerDirectedConfidence: this.roundUnitInterval(
        decisionAddressingState?.currentSpeakerDirectedConfidence,
        0
      ),
      heard: heardValue,
      transcriptChars: transcript ? transcript.length : 0,
      speakerCount: hasCrossSpeaker ? speakerTranscripts!.length : undefined,
      heardPerSpeaker: heardPerSpeaker || undefined,
      transcriptionModelPrimary: logContext?.transcriptionModelPrimary || undefined,
      transcriptionModelFallback: logContext?.transcriptionModelFallback ?? undefined,
      transcriptionUsedFallbackModel:
        logContext?.transcriptionUsedFallbackModel !== undefined
          ? Boolean(logContext.transcriptionUsedFallbackModel)
          : undefined,
      transcriptionPlanReason: logContext?.transcriptionPlanReason || undefined,
      clipDurationMs:
        Number.isFinite(Number(logContext?.clipDurationMs)) ? Math.round(Number(logContext?.clipDurationMs)) : undefined,
      asrSkippedShortClip:
        logContext?.asrSkippedShortClip !== undefined ? Boolean(logContext.asrSkippedShortClip) : undefined,
      deferredActionReason: logContext?.deferredActionReason || undefined,
      deferredTurnCount:
        Number.isFinite(Number(logContext?.deferredTurnCount))
          ? Math.round(Number(logContext?.deferredTurnCount))
          : undefined,
      pendingQueueDepth:
        Number.isFinite(Number(logContext?.pendingQueueDepth))
          ? Math.round(Number(logContext?.pendingQueueDepth))
          : undefined,
      attentionMode: decision.conversationContext?.attentionMode || null,
      currentSpeakerActive: Boolean(decision.conversationContext?.currentSpeakerActive),
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
      classifierConfidence: this.roundUnitInterval(decision.classifierConfidence, null),
      classifierTarget: decision.classifierTarget || null,
      classifierReason: decision.classifierReason || null,
      replyPrompts: decision.replyPrompts || null,
      musicWakeLatched: Boolean(decision.conversationContext?.musicWakeLatched),
      musicWakeLatchedUntil: Number(session?.musicWakeLatchedUntil || 0) > 0
        ? new Date(Number(session.musicWakeLatchedUntil)).toISOString()
        : null,
      error: decision.error || null,
      ...outputLockDebugMetadata
    };
  }

  private async handleResolvedVoiceTurn({
    session,
    settings,
    userId = null,
    transcript,
    source,
    captureReason = "stream_end",
    pcmBuffer = null,
    transcriptionContext = {},
    logContext = null,
    bridgeSource = source,
    latencyContext = null,
    nativeCaptureReason = captureReason,
    musicWakeFollowupEligibleAtCapture = false,
    allowReplyDispatch = true,
    allowAuthorizedOutputLockInterrupt = true,
    shouldAbortStage = null,
    speakerTranscripts = null
  }: HandleResolvedVoiceTurnArgs) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);

    const decision = await this.host.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript: normalizedTranscript,
      source,
      transcriptionContext,
      speakerTranscripts
    });
    if (shouldAbortStage?.("post_decision")) return;

    if (decision.directAddressed && session && !session.ending) {
      session.lastDirectAddressAt = Date.now();
      session.lastDirectAddressUserId = userId;
    }
    const decisionTranscript = decision.transcript || normalizedTranscript;
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
      text: decisionTranscript,
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
    setVoiceLivePromptSnapshot(session, "classifier", {
      replyPrompts: decision.replyPrompts || null,
      source
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: this.buildVoiceTurnAddressingMetadata({
        session,
        decision,
        decisionVoiceAddressing,
        decisionAddressingState,
        outputLockDebugMetadata,
        source,
        captureReason,
        transcript: decisionTranscript,
        logContext,
        speakerTranscripts
      })
    });

    const interruptionPolicy =
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy || null;
    const directAddressOutputInterrupted =
      !decision.allow &&
      decision.reason === "bot_turn_open" &&
      Boolean(decision.directAddressed) &&
      this.host.shouldDirectAddressedTurnInterruptReply({
        session,
        directAddressed: Boolean(decision.directAddressed),
        policy: interruptionPolicy
      }) &&
      this.host.interruptBotSpeechForDirectAddressedTurn({
        session,
        userId,
        source
      });
    const authorizedSpeakerOutputInterrupted =
      !directAddressOutputInterrupted &&
      !decision.allow &&
      decision.reason === "bot_turn_open" &&
      allowAuthorizedOutputLockInterrupt &&
      this.host.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId
      }) &&
      this.host.interruptBotSpeechForOutputLockTurn({
        session,
        userId,
        source
      });

    if (!decision.allow && !directAddressOutputInterrupted && !authorizedSpeakerOutputInterrupted) {
      // Defer turns that were blocked by temporary conditions (bot speaking,
      // tool followup in progress) so they can be replayed when the blocker
      // clears. Turns blocked for other reasons (command_only, etc.) are
      // intentionally dropped — they weren't relevant enough to admit.
      const deferrableReason =
        decision.reason === "bot_turn_open" ||
        decision.reason === "owned_tool_followup_other_speaker_blocked";
      if (deferrableReason) {
        this.host.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: decisionTranscript,
          pcmBuffer: pcmBuffer?.length ? pcmBuffer : null,
          captureReason,
          source,
          directAddressed: Boolean(decision.directAddressed),
          deferReason: decision.reason,
          flushDelayMs: decision.retryAfterMs
        });
      }
      return;
    }

    this.host.clearDeferredQueuedUserTurns(session);

    if (!allowReplyDispatch) return;

    const useNativeRealtimeReply =
      isRealtimeMode(session.mode) && this.host.shouldUseNativeRealtimeReply({ session, settings });
    if (useNativeRealtimeReply) {
      if (!pcmBuffer?.length) return;
      if (shouldAbortStage?.("pre_native_reply")) return;
      await this.host.forwardRealtimeTurnAudio({
        session,
        settings,
        userId,
        transcript: normalizedTranscript,
        pcmBuffer,
        captureReason: nativeCaptureReason
      });
      return;
    }

    if (this.host.shouldUseRealtimeTranscriptBridge({ session, settings })) {
      if (shouldAbortStage?.("pre_brain_forward")) return;
      await this.host.forwardRealtimeTextTurnToBrain({
        session,
        settings,
        userId,
        transcript: normalizedTranscript,
        captureReason,
        source: bridgeSource,
        directAddressed: Boolean(decision.directAddressed),
        conversationContext: decision.conversationContext || null,
        latencyContext,
        speakerTranscripts
      });
      return;
    }

    if (shouldAbortStage?.("pre_brain_reply")) return;
    await this.host.runRealtimeBrainReply({
      session,
      settings,
      userId,
      transcript: normalizedTranscript,
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      musicWakeFollowupEligibleAtCapture,
      source,
      latencyContext,
      speakerTranscripts
    });
  }

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
    const queuedAssistantUtteranceCount = Math.max(
      0,
      Number(this.host.getPendingRealtimeAssistantUtteranceCount(session) || 0)
    );
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
    const directAddressSignal = normalizedTranscript
      ? resolveVoiceDirectAddressSignal({
        transcript: normalizedTranscript,
        settings
      })
      : {
        directAddressed: false,
        nameCueDetected: false,
        addressedOrNamed: false
      };
    const directAddressed = directAddressSignal.directAddressed;
    const nameCueDetected = directAddressSignal.nameCueDetected;
    const implicitSingleSpeakerStanding = participantCount > 0 && participantCount <= 1;
    const hasCancelableWork = Boolean(
      pendingResponse ||
      outputChannelState.pendingResponse ||
      outputChannelState.openAiActiveResponse ||
      outputChannelState.awaitingToolOutputs ||
      outputChannelState.toolCallsRunning ||
      activeVoiceGeneration ||
      activeCommandState ||
      queuedAssistantUtteranceCount > 0
    );

    return {
      normalizedTranscript,
      pendingResponse,
      activeCommandState,
      outputChannelState,
      participantCount,
      queuedAssistantUtteranceCount,
      pendingResponseOwnerUserId,
      lastRealtimeToolCallerUserId,
      commandOwnerUserId,
      ownerMatched,
      directAddressed,
      nameCueDetected,
      implicitSingleSpeakerStanding,
      speakerHasStanding: ownerMatched || directAddressSignal.addressedOrNamed || implicitSingleSpeakerStanding,
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
      `Interrupted work: pending response source=${pendingResponseSource}; pending utterance=${pendingUtterance}; active response=${cancelContext.outputChannelState.openAiActiveResponse ? "yes" : "no"}; queued speech=${cancelContext.queuedAssistantUtteranceCount > 0 ? "yes" : "no"}; tool calls running=${cancelContext.outputChannelState.toolCallsRunning ? "yes" : "no"}; awaiting tool outputs=${cancelContext.outputChannelState.awaitingToolOutputs ? "yes" : "no"}; active command=${activeCommand}.`,
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
    const clearedQueuedAssistantUtterances = this.host.clearPendingRealtimeAssistantUtterances(
      session,
      "voice_turn_cancel_intent"
    );
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
        nameCueDetected: resolvedCancelContext.nameCueDetected,
        implicitSingleSpeakerStanding: resolvedCancelContext.implicitSingleSpeakerStanding,
        participantCount: resolvedCancelContext.participantCount,
        pendingResponseOwnerUserId: resolvedCancelContext.pendingResponseOwnerUserId,
        lastRealtimeToolCallerUserId: resolvedCancelContext.lastRealtimeToolCallerUserId,
        commandOwnerUserId: resolvedCancelContext.commandOwnerUserId,
        queuedAssistantUtteranceCount: resolvedCancelContext.queuedAssistantUtteranceCount,
        clearedQueuedAssistantUtterances,
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

  private async maybeConsumePendingMusicDisambiguationCancel({
    session,
    settings = null,
    userId = null,
    transcript = "",
    source = "realtime"
  }: {
    session: VoiceSession;
    settings?: TurnProcessorSettings;
    userId?: string | null;
    transcript?: string;
    source?: "realtime" | "file_asr";
  }) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript || !isCancelIntent(normalizedTranscript)) return false;
    return await this.host.maybeHandlePendingMusicDisambiguationTurn({
      session,
      settings,
      userId,
      transcript: normalizedTranscript,
      source: `voice_${source}`,
      channelId: session.textChannelId || null,
      mustNotify: false
    });
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
    musicWakeFollowupEligibleAtCapture = false,
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
    serverVadConfirmed = false
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
      replyScopeStartedAt: this.reserveRealtimeTurnScopeStartedAt(),
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
      serverVadConfirmed: Boolean(serverVadConfirmed),
      musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
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
      replyScopeStartedAt: Math.max(
        0,
        Number(existingTurn.replyScopeStartedAt || 0),
        Number(incomingTurn.replyScopeStartedAt || 0)
      ),
      bridgeUtteranceId:
        Math.max(0, Number(incomingTurn.bridgeUtteranceId || existingTurn.bridgeUtteranceId || 0)) || null,
      bridgeRevision: Math.max(1, Number(existingTurn.bridgeRevision || 1)) + 1,
      serverVadConfirmed: Boolean(existingTurn.serverVadConfirmed || incomingTurn.serverVadConfirmed)
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
    revisedTurn.replyScopeStartedAt = this.reserveRealtimeTurnScopeStartedAt();
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

    // --- Speaker-aware merge ---
    // When turns from different speakers are merged (room coalescing),
    // preserve per-speaker transcript attribution so the downstream pipeline
    // can present "Speaker A said X / Speaker B said Y" to the LLM.
    const existingUserId = String(existingTurn.userId || "").trim();
    const incomingUserId = String(incomingTurn.userId || "").trim();
    const isCrossSpeaker = Boolean(existingUserId && incomingUserId && existingUserId !== incomingUserId);

    let mergedSpeakerTranscripts: SpeakerTranscript[] | null = null;
    if (isCrossSpeaker) {
      // Bootstrap from existing turn's speakerTranscripts or create initial entry.
      const existingSpeakers: SpeakerTranscript[] = Array.isArray(existingTurn.speakerTranscripts) && existingTurn.speakerTranscripts.length > 0
        ? [...existingTurn.speakerTranscripts]
        : existingTurn.transcriptOverride
          ? [{ userId: existingUserId, transcript: existingTurn.transcriptOverride }]
          : [];
      const incomingText = normalizeVoiceText(incomingTurn.transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
      if (incomingText) {
        // Append or coalesce with existing entry for the same speaker.
        const existingIdx = existingSpeakers.findIndex((s) => s.userId === incomingUserId);
        if (existingIdx >= 0) {
          const prev = existingSpeakers[existingIdx].transcript || "";
          existingSpeakers[existingIdx] = {
            userId: incomingUserId,
            transcript: prev ? `${prev} ${incomingText}` : incomingText
          };
        } else {
          existingSpeakers.push({ userId: incomingUserId, transcript: incomingText });
        }
      }
      mergedSpeakerTranscripts = existingSpeakers.length > 0 ? existingSpeakers : null;
    } else if (Array.isArray(existingTurn.speakerTranscripts) && existingTurn.speakerTranscripts.length > 0) {
      // Same speaker but existing turn already carries speakerTranscripts (prior cross-speaker merge).
      // Coalesce the incoming transcript into the matching speaker entry.
      mergedSpeakerTranscripts = [...existingTurn.speakerTranscripts];
      const incomingText = normalizeVoiceText(incomingTurn.transcriptOverride || "", STT_TRANSCRIPT_MAX_CHARS);
      if (incomingText) {
        const speakerIdx = mergedSpeakerTranscripts.findIndex((s) => s.userId === incomingUserId);
        if (speakerIdx >= 0) {
          const prev = mergedSpeakerTranscripts[speakerIdx].transcript || "";
          mergedSpeakerTranscripts[speakerIdx] = {
            userId: incomingUserId,
            transcript: prev ? `${prev} ${incomingText}` : incomingText
          };
        } else {
          mergedSpeakerTranscripts.push({ userId: incomingUserId, transcript: incomingText });
        }
      }
    }

    return {
      ...existingTurn,
      ...incomingTurn,
      // For cross-speaker merges, keep the existing (first) speaker as the primary userId.
      // The speakerTranscripts array carries the full attribution.
      userId: isCrossSpeaker ? existingUserId : incomingUserId || existingUserId,
      pcmBuffer: mergedBuffer,
      transcriptOverride: mergedTranscript || null,
      transcriptLogprobsOverride: mergedLogprobs,
      queuedAt: Number(incomingTurn.queuedAt || Date.now()),
      finalizedAt: mergedFinalizedAt || 0,
      replyScopeStartedAt: Math.max(
        0,
        Number(existingTurn.replyScopeStartedAt || 0),
        Number(incomingTurn.replyScopeStartedAt || 0)
      ),
      bridgeUtteranceId: mergedBridgeUtteranceId,
      bridgeRevision: mergedBridgeRevision,
      musicWakeFollowupEligibleAtCapture:
        Boolean(existingTurn.musicWakeFollowupEligibleAtCapture) ||
        Boolean(incomingTurn.musicWakeFollowupEligibleAtCapture),
      mergedTurnCount: Math.max(1, Number(existingTurn.mergedTurnCount || 1)) + 1,
      droppedHeadBytes,
      speakerTranscripts: mergedSpeakerTranscripts
    };
  }

  queueRealtimeTurn({
    session,
    userId,
    pcmBuffer = null,
    captureReason = "stream_end",
    finalizedAt = 0,
    musicWakeFollowupEligibleAtCapture = false,
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
    serverVadConfirmed = false
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
      musicWakeFollowupEligibleAtCapture,
      transcriptOverride,
      clipDurationMsOverride,
      asrStartedAtMsOverride,
      asrCompletedAtMsOverride,
      transcriptionModelPrimaryOverride,
      transcriptionModelFallbackOverride,
      transcriptionPlanReasonOverride,
      usedFallbackModelForTranscriptOverride,
      transcriptLogprobsOverride,
      bridgeUtteranceId,
      serverVadConfirmed
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
      // Merge the incoming turn into the pending queue.
      const firstPending = pendingQueue.shift() || queuedTurn;
      let mergedTurn = firstPending;
      while (pendingQueue.length > 0) {
        const pendingTurn = pendingQueue.shift();
        if (!pendingTurn) continue;
        mergedTurn = this.mergeRealtimeQueuedTurn(mergedTurn, pendingTurn);
      }
      if (firstPending !== queuedTurn) {
        mergedTurn = this.mergeRealtimeQueuedTurn(mergedTurn, queuedTurn);
      }
      if (!mergedTurn) return;

      // If other users are still speaking, keep holding — don't drain yet.
      // The room-quiet flush trigger (cleanupCapture) or safety timeout will
      // drain when the room settles.
      if (this.host.hasOtherActiveCaptures(session, mergedTurn.userId)) {
        pendingQueue.push(mergedTurn);
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_merged_still_holding",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            mergedTurnCount: Number(mergedTurn.mergedTurnCount || 1),
            activeCaptureCount: Number(session.userCaptures?.size || 0),
            pendingQueueDepth: 1
          }
        });
        return;
      }

      // Room is quiet — flush everything.
      if (session.realtimeTurnCoalesceTimer) {
        clearTimeout(session.realtimeTurnCoalesceTimer);
        session.realtimeTurnCoalesceTimer = null;
      }
      this.spawnRealtimeTurnDrain(mergedTurn, "pending_queue_merge");
      return;
    }

    const pcmBytes = queuedTurn.pcmBuffer?.length || 0;
    const skipCoalesce =
      pcmBytes >= REALTIME_TURN_COALESCE_MAX_BYTES ||
      session.ending;

    // --- Room-aware coalescing ---
    // If other users are still speaking, hold this turn so it can be merged with
    // subsequent turns. When the room goes quiet (last active capture finalizes),
    // the held turns are flushed together. Direct-addressed turns bypass the hold.
    if (!skipCoalesce && this.host.hasOtherActiveCaptures(session, userId)) {
      // Bypass: if the turn is directly addressed (wake word), drain immediately.
      const settings = session.settingsSnapshot || this.store.getSettings();
      const directAddressSignal = queuedTurn.transcriptOverride
        ? resolveVoiceDirectAddressSignal({
          transcript: queuedTurn.transcriptOverride,
          settings
        })
        : { directAddressed: false, nameCueDetected: false, addressedOrNamed: false };

      if (directAddressSignal.addressedOrNamed) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_room_coalesce_bypassed_direct_address",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            directAddressed: directAddressSignal.directAddressed,
            nameCueDetected: directAddressSignal.nameCueDetected
          }
        });
        this.spawnRealtimeTurnDrain(queuedTurn, "direct_address_bypass");
        return;
      }

      // Hold the turn — push to pending queue and start safety timeout.
      pendingQueue.push(queuedTurn);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_held_room_coalesce",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          activeCaptureCount: Number(session.userCaptures?.size || 0),
          pendingQueueDepth: pendingQueue.length
        }
      });
      // Hard failsafe: if a capture never finalizes despite the 8s max-duration
      // cap and idle/silence timers, drain after COALESCE_WINDOW_MS (10s) to
      // prevent truly stuck turns. Should never fire under normal operation.
      if (!session.realtimeTurnCoalesceTimer && REALTIME_TURN_COALESCE_WINDOW_MS > 0) {
        session.realtimeTurnCoalesceTimer = setTimeout(() => {
          session.realtimeTurnCoalesceTimer = null;
          this.flushHeldRoomCoalesceTurns(session, "room_coalesce_safety_timeout");
        }, REALTIME_TURN_COALESCE_WINDOW_MS);
      }
      return;
    }

    if (skipCoalesce && session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }

    this.spawnRealtimeTurnDrain(queuedTurn, "direct_queue_start");
  }

  /** Merge all pending held turns and drain. Called by the session manager when
   *  the room goes quiet and by the safety timeout when a held turn has waited
   *  too long. Owns the merge + drain mechanics so callers don't need to reach
   *  into queue internals. */
  flushHeldRoomCoalesceTurns(session: VoiceSession, trigger: string) {
    if (!session || session.ending) return;
    const pendingQueue = this.ensurePendingRealtimeTurnQueue(session);
    if (pendingQueue.length <= 0) return;
    if (session.realtimeTurnDrainActive) return;
    if (session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }
    let turn = pendingQueue.shift() || null;
    while (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      if (!next) continue;
      turn = turn ? this.mergeRealtimeQueuedTurn(turn, next) : next;
    }
    if (turn) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: turn.userId,
        content: "realtime_turn_room_coalesce_flushed",
        metadata: {
          sessionId: session.id,
          trigger,
          mergedTurnCount: Number(turn.mergedTurnCount || 1),
          combinedBytes: turn.pcmBuffer?.length || 0
        }
      });
      this.spawnRealtimeTurnDrain(turn, trigger);
    }
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
    replyScopeStartedAt = 0,
    musicWakeFollowupEligibleAtCapture = false,
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
    droppedHeadBytes = 0,
    serverVadConfirmed = false,
    speakerTranscripts = null
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
      replyScopeStartedAt: Math.max(
        0,
        Number(replyScopeStartedAt || 0)
      ) || this.reserveRealtimeTurnScopeStartedAt(),
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
      musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
      mergedTurnCount: Math.max(1, Number(mergedTurnCount || 1)),
      droppedHeadBytes: Math.max(0, Number(droppedHeadBytes || 0)),
      serverVadConfirmed: Boolean(serverVadConfirmed),
      speakerTranscripts: Array.isArray(speakerTranscripts) && speakerTranscripts.length > 0
        ? speakerTranscripts
        : null
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
      if (this.host.activeReplies?.isStale(
        voiceReplyScopeKey,
        Math.max(0, Number(currentTurn.replyScopeStartedAt || queuedAt || finalizedAtMs || Date.now()))
      )) {
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
        transcript: normalizedTranscriptOverride || undefined,
        musicWakeFollowupEligibleAtCapture
      });
      if (consumedByMusicMode) {
        return;
      }

      const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
      const voiceRuntime = getVoiceRuntimeConfig(settings);
      const transcriberProvider = resolveTranscriberProvider(settings);
      const preferredModel =
        transcriberProvider === "elevenlabs"
          ? voiceRuntime.elevenLabsRealtime?.transcriptionModel
          : voiceRuntime.openaiRealtime?.inputTranscriptionModel;
      const transcriptionModel =
        transcriberProvider === "elevenlabs"
          ? String(preferredModel || "").trim()
          : String(preferredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
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
        : resolveTurnTranscriptionPlan({
          mode: session.mode,
          provider: transcriberProvider,
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
      } else if (
        !hasTranscriptOverride &&
        (session.perUserAsrEnabled || session.sharedAsrEnabled)
      ) {
        // ASR bridge is enabled but no bridge transcript arrived. This means
        // the bridge wasn't connected yet or the capture was non-speech audio.
        // Drop the turn rather than falling back to file-based ASR which
        // hallucinates on ambient noise and music.
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_dropped_no_bridge_transcript",
          metadata: {
            sessionId: session.id,
            source: "realtime",
            captureReason: String(captureReason || "stream_end"),
            pcmBytes: normalizedPcmBuffer.length,
            clipDurationMs,
            rms: Number(silenceGate.rms.toFixed(6)),
            peak: Number(silenceGate.peak.toFixed(6)),
            activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
            serverVadConfirmed,
            bridgeUtteranceId: normalizedBridgeUtteranceId,
            queueWaitMs,
            pendingQueueDepth
          }
        });
        return;
      } else if (!hasTranscriptOverride && this.llm?.isAsrReady?.() && this.llm?.transcribeAudio) {
        // File-based ASR path: used when the ASR bridge is intentionally
        // disabled (e.g. transcriptionMethod: "file_wav" or no OpenAI API key).
        asrStartedAtMs = Date.now();
        const transcriptionResult = await transcribePcmTurnWithPlan({
          transcribe: (args) => this.host.transcribePcmTurn(args),
          session,
          userId,
          pcmBuffer: normalizedPcmBuffer,
          plan: transcriptionPlan,
          sampleRateHz,
          captureReason,
          traceSource: "voice_realtime_turn_decider",
          errorPrefix: "voice_realtime_transcription_failed",
          emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
          emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
          asrLanguage: asrLanguageGuidance.language,
          asrPrompt: asrLanguageGuidance.prompt
        });
        turnTranscript = transcriptionResult.transcript;
        resolvedFallbackModel = transcriptionResult.fallbackModel;
        resolvedTranscriptionPlanReason = transcriptionResult.reason;
        usedFallbackModelForTranscript = transcriptionResult.usedFallbackModel;
        asrCompletedAtMs = Date.now();
      }

      const realtimeTranscriptGuard = inspectAsrTranscript(turnTranscript, STT_TRANSCRIPT_MAX_CHARS);
      turnTranscript = realtimeTranscriptGuard.transcript;
      if (realtimeTranscriptGuard.malformed) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_dropped_asr_control_tokens",
          metadata: {
            sessionId: session.id,
            source: "realtime",
            captureReason: String(captureReason || "stream_end"),
            transcript: turnTranscript,
            controlTokenCount: realtimeTranscriptGuard.controlTokenCount,
            reservedAudioMarkerCount: realtimeTranscriptGuard.reservedAudioMarkerCount,
            clipDurationMs,
            hasTranscriptOverride,
            bridgeUtteranceId: normalizedBridgeUtteranceId
          }
        });
        return;
      }

      if (isSuperseded("post_transcription")) return;

      if (
        turnTranscript &&
        await this.maybeConsumePendingMusicDisambiguationCancel({
          session,
          settings,
          userId,
          transcript: turnTranscript,
          source: "realtime"
        })
      ) {
        return;
      }

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
          const committedInterruptedBridgeTurn =
            normalizedBridgeUtteranceId &&
            this.host.hasCommittedInterruptedBridgeTurn({
              session,
              userId,
              bridgeUtteranceId: normalizedBridgeUtteranceId
            });
          if (committedInterruptedBridgeTurn) {
            this.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: session.textChannelId,
              userId,
              content: "voice_turn_low_confidence_forwarded_after_interrupt",
              metadata: {
                sessionId: session.id,
                source: "realtime",
                captureReason: String(captureReason || "stream_end"),
                transcript: turnTranscript,
                meanLogprob: Number(confidence.meanLogprob.toFixed(4)),
                minLogprob: Number(confidence.minLogprob.toFixed(4)),
                tokenCount: confidence.tokenCount,
                threshold: VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD,
                clipDurationMs,
                bridgeUtteranceId: normalizedBridgeUtteranceId
              }
            });
          } else {
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
      // Cross-speaker merge: record each speaker's transcript separately for
      // proper conversation history attribution.
      const hasCrossSpeakerTranscripts =
        Array.isArray(speakerTranscripts) && speakerTranscripts.length > 1;
      if (turnTranscript && persistRealtimeTranscriptTurn) {
        if (hasCrossSpeakerTranscripts) {
          for (const segment of speakerTranscripts!) {
            if (!segment.transcript) continue;
            this.host.recordVoiceTurn(session, {
              role: "user",
              userId: segment.userId,
              text: segment.transcript
            });
          }
        } else {
          this.host.recordVoiceTurn(session, {
            role: "user",
            userId,
            text: turnTranscript
          });
        }
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

      await this.handleResolvedVoiceTurn({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        source: "realtime",
        captureReason,
        pcmBuffer: normalizedPcmBuffer,
        musicWakeFollowupEligibleAtCapture,
        transcriptionContext: {
          usedFallbackModel: usedFallbackModelForTranscript,
          captureReason: String(captureReason || "stream_end"),
          clipDurationMs
        },
        logContext: {
          queueWaitMs,
          pendingQueueDepth,
          transcriptionModelPrimary: transcriptionPlan.primaryModel,
          transcriptionModelFallback: resolvedFallbackModel || null,
          transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
          transcriptionPlanReason: resolvedTranscriptionPlanReason,
          clipDurationMs,
          asrSkippedShortClip: skipShortClipAsr
        },
        bridgeSource: "realtime_transcript_turn",
        allowAuthorizedOutputLockInterrupt:
          !this.host.shouldUseRealtimeTranscriptBridge({ session, settings }) &&
          !hasTranscriptOverride,
        latencyContext: {
          finalizedAtMs,
          asrStartedAtMs,
          asrCompletedAtMs,
          queueWaitMs,
          pendingQueueDepth,
          captureReason: String(captureReason || "stream_end")
        },
        shouldAbortStage: isSuperseded,
        speakerTranscripts: hasCrossSpeakerTranscripts ? speakerTranscripts : null
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
    const voiceRuntime = getVoiceRuntimeConfig(settings);
    const transcriberProvider = resolveTranscriberProvider(settings);
    const transcriptionModelPrimary =
      transcriberProvider === "elevenlabs"
        ? String(voiceRuntime.elevenLabsRealtime?.transcriptionModel || "").trim()
        : String(voiceRuntime.openaiRealtime?.inputTranscriptionModel || "gpt-4o-mini-transcribe").trim() ||
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
    const transcriptionPlan = resolveTurnTranscriptionPlan({
      mode: session.mode,
      provider: transcriberProvider,
      configuredModel: transcriptionModelPrimary,
      pcmByteLength: pcmBuffer.length,
      sampleRateHz
    });
    const transcriptionResult = await transcribePcmTurnWithPlan({
      transcribe: (args) => this.host.transcribePcmTurn(args),
      session,
      userId,
      pcmBuffer,
      plan: transcriptionPlan,
      sampleRateHz,
      captureReason,
      traceSource: "voice_file_asr_turn",
      errorPrefix: "file_asr_transcription_failed",
      emptyTranscriptRuntimeEvent: "file_asr_transcription_empty",
      emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
      asrLanguage: asrLanguageGuidance.language,
      asrPrompt: asrLanguageGuidance.prompt
    });
    const fileAsrTranscriptGuard = inspectAsrTranscript(
      transcriptionResult.transcript,
      STT_TRANSCRIPT_MAX_CHARS
    );
    const transcript = fileAsrTranscriptGuard.transcript;
    const transcriptionModelFallback = transcriptionResult.fallbackModel;
    const transcriptionPlanReason = transcriptionResult.reason;
    const usedFallbackModelForTranscript = transcriptionResult.usedFallbackModel;
    if (!transcript) return;
    if (fileAsrTranscriptGuard.malformed) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_asr_control_tokens",
        metadata: {
          sessionId: session.id,
          source: "file_asr",
          captureReason: String(captureReason || "stream_end"),
          transcript,
          controlTokenCount: fileAsrTranscriptGuard.controlTokenCount,
          reservedAudioMarkerCount: fileAsrTranscriptGuard.reservedAudioMarkerCount,
          clipDurationMs
        }
      });
      return;
    }
    if (await this.maybeConsumePendingMusicDisambiguationCancel({
      session,
      settings,
      userId,
      transcript,
      source: "file_asr"
    })) {
      return;
    }
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

    await this.handleResolvedVoiceTurn({
      session,
      settings,
      userId,
      transcript,
      source: "file_asr",
      captureReason,
      pcmBuffer,
      transcriptionContext: {
        usedFallbackModel: usedFallbackModelForTranscript,
        captureReason: String(captureReason || "stream_end"),
        clipDurationMs
      },
      logContext: {
        queueWaitMs,
        pendingQueueDepth,
        transcriptionModelPrimary,
        transcriptionModelFallback,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason,
        clipDurationMs,
        asrSkippedShortClip: false
      },
      bridgeSource: "file_asr_transcript_turn"
    });
  }

  async flushDeferredBotTurnOpenTurns({
    session,
    deferredTurns = null,
    reason = "bot_turn_open_deferred_flush"
  }: FlushDeferredBotTurnOpenTurnsArgs) {
    if (!session || session.ending) return;
    const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
    const pendingQueue = Array.isArray(deferredTurns)
      ? deferredTurns
      : this.host.getDeferredQueuedUserTurns(session).slice();
    if (!pendingQueue.length) return;

    const latestQueuedAt = pendingQueue.reduce((latest, entry) => {
      const queuedAt = Math.max(0, Number(entry?.queuedAt || 0));
      return queuedAt > latest ? queuedAt : latest;
    }, 0);
    if (this.host.activeReplies?.isStale(voiceReplyScopeKey, latestQueuedAt)) {
      if (!Array.isArray(deferredTurns)) {
        this.host.clearDeferredQueuedUserTurns(session);
      }
      return;
    }

    if (!Array.isArray(deferredTurns)) {
      const outputChannelState = this.host.getOutputChannelState(session);
      const hasEagerTurn = pendingQueue.some((t) => t?.directAddressed);
      const onlyLockedByMusic =
        outputChannelState.locked &&
        outputChannelState.musicActive &&
        outputChannelState.phase === "idle";
      const isLocked = outputChannelState.locked && !(onlyLockedByMusic && hasEagerTurn);

      if (isLocked || outputChannelState.captureBlocking) {
        this.host.scheduleDeferredBotTurnOpenFlush({ session, reason });
        return;
      }
      this.host.clearDeferredQueuedUserTurns(session);
    }

    // Group deferred turns by speaker so each person's speech is attributed
    // correctly. Direct-addressed turns from any speaker are processed first.
    // Within each speaker group, turns are coalesced (same-speaker merging is
    // fine — it's cross-speaker mashing that loses attribution).
    const recentTurns = pendingQueue.slice(-BOT_TURN_DEFERRED_COALESCE_MAX);
    const speakerGroups = new Map<string, typeof recentTurns>();
    for (const turn of recentTurns) {
      const speakerId = String(turn?.userId || "unknown").trim();
      const group = speakerGroups.get(speakerId) || [];
      group.push(turn);
      speakerGroups.set(speakerId, group);
    }

    // Sort speaker groups: direct-addressed first, then most recent
    const sortedGroups = [...speakerGroups.entries()].sort(([, turnsA], [, turnsB]) => {
      const aDirectAddress = turnsA.some((t) => t?.directAddressed);
      const bDirectAddress = turnsB.some((t) => t?.directAddressed);
      if (aDirectAddress && !bDirectAddress) return -1;
      if (!aDirectAddress && bDirectAddress) return 1;
      const aLatest = Math.max(...turnsA.map((t) => Number(t?.queuedAt || 0)));
      const bLatest = Math.max(...turnsB.map((t) => Number(t?.queuedAt || 0)));
      return bLatest - aLatest;
    });

    const settings = session.settingsSnapshot || this.store.getSettings();

    for (const [speakerId, speakerTurns] of sortedGroups) {
      if (session.ending) break;
      const directAddressedTurn = speakerTurns.find((entry) => entry?.directAddressed) || null;
      const latestTurn = directAddressedTurn || speakerTurns[speakerTurns.length - 1];
      const orderedTurns = directAddressedTurn
        ? [directAddressedTurn, ...speakerTurns.filter((entry) => entry !== directAddressedTurn)]
        : speakerTurns;
      const distinctSources = Array.from(
        new Set(
          orderedTurns
            .map((entry) => String(entry?.source || "").trim())
            .filter((entry): entry is string => entry.length > 0)
        )
      );
      const deferredReplySource =
        distinctSources.length === 1 && isSystemSpeechOpportunitySource(distinctSources[0])
          ? distinctSources[0]
          : "bot_turn_open_deferred_flush";
      const coalescedTranscript = normalizeVoiceText(
        orderedTurns
          .map((entry) => String(entry?.transcript || "").trim())
          .filter(Boolean)
          .join(" "),
        STT_TRANSCRIPT_MAX_CHARS
      );
      if (!coalescedTranscript) continue;

      const coalescedPcmBuffer = isRealtimeMode(session.mode)
        ? Buffer.concat(
          orderedTurns
            .map((entry) => (entry?.pcmBuffer?.length ? entry.pcmBuffer : null))
            .filter((entry): entry is Buffer => Boolean(entry))
        )
        : null;

      await this.handleResolvedVoiceTurn({
        session,
        settings,
        userId: latestTurn?.userId || speakerId,
        transcript: coalescedTranscript,
        source: deferredReplySource,
        captureReason: latestTurn?.captureReason || "stream_end",
        pcmBuffer: coalescedPcmBuffer,
        logContext: {
          deferredActionReason: reason,
          deferredTurnCount: speakerTurns.length,
          totalDeferredSpeakers: sortedGroups.length
        },
        bridgeSource: deferredReplySource,
        nativeCaptureReason: "bot_turn_open_deferred_flush",
        allowReplyDispatch: isRealtimeMode(session.mode)
      });
    }
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
