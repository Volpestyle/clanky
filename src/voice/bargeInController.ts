import {
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN,
  BARGE_IN_BOT_SPEAKING_PEAK_MIN,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_STT_MIN_CAPTURE_AGE_MS,
  STT_REPLY_MAX_CHARS,
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_PEAK_MAX
} from "./voiceSessionManager.constants.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type { OutputChannelState, VoiceSession } from "./voiceSessionTypes.ts";

type BargeInStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type CaptureStateLike = {
  userId?: string | null;
  startedAt?: number;
  promotedAt?: number;
  bytesSent?: number;
  speakingEndFinalizeTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
  signalSampleCount?: number;
  signalActiveSampleCount?: number;
  signalPeakAbs?: number;
  signalSumSquares?: number;
};

type PendingResponseLike = {
  requestId?: number;
  utteranceText?: string | null;
  interruptionPolicy?: ReplyInterruptionPolicy | null;
  audioReceivedAt?: number;
};

export interface ReplyInterruptionPolicy {
  assertive: boolean;
  scope: string | null;
  allowedUserId: string | null;
  talkingTo: string | null;
  reason: string | null;
  source: string | null;
}

export type BargeInDecision =
  | { allowed: false }
  | {
    allowed: true;
    minCaptureBytes: number;
    interruptionPolicy: ReplyInterruptionPolicy | null;
  };

export interface CaptureSignalMetrics {
  sampleCount: number;
  activeSampleRatio: number;
  peak: number;
  rms: number;
}

export interface BargeInInterruptCommand {
  now: number;
  userId: string | null;
  source: string;
  pendingRequestId: number | null;
  minCaptureBytes: number;
  interruptionPolicy: ReplyInterruptionPolicy | null;
  retryUtteranceText: string | null;
  captureBytesSent: number | null;
  captureSignalPeak: number | null;
  captureSignalActiveSampleRatio: number | null;
  botTurnWasOpen: boolean;
  botTurnAgeMs: number | null;
}

export interface BargeInControllerHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: BargeInStoreLike;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  hasRecentAssistantAudioDelta: (session: VoiceSession) => boolean;
  hasBufferedTtsPlayback: (session: VoiceSession) => boolean;
  normalizeReplyInterruptionPolicy: (
    rawPolicy?: ReplyInterruptionPolicy | Record<string, unknown> | null
  ) => ReplyInterruptionPolicy | null;
  isUserAllowedToInterruptReply: (args?: {
    policy?: ReplyInterruptionPolicy | null;
    userId?: string | null;
  }) => boolean;
}

export class BargeInController {
  constructor(private readonly host: BargeInControllerHost) {}

  isBargeInOutputSuppressed(session: VoiceSession, now = Date.now()) {
    if (!session) return false;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return false;
    if (now < suppressedUntil) return true;
    this.clearBargeInOutputSuppression(session, "timeout");
    return false;
  }

  clearBargeInOutputSuppression(session: VoiceSession, reason = "cleared") {
    if (!session) return;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return;
    const droppedChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0));
    const droppedBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0));

    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    if (reason === "timeout" && droppedChunks <= 0 && droppedBytes <= 0) return;
    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.host.client.user?.id || null,
      content: "voice_barge_in_suppression_cleared",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "cleared"),
        droppedAudioChunks: droppedChunks,
        droppedAudioBytes: droppedBytes
      }
    });
  }

  isBargeInInterruptTargetActive(session: VoiceSession) {
    if (!session || session.ending) return false;
    if (this.isBargeInOutputSuppressed(session)) return false;
    const outputChannelState = this.host.getOutputChannelState(session);
    if (!outputChannelState.locked) return false;
    if (
      outputChannelState.musicActive &&
      !outputChannelState.botTurnOpen &&
      !outputChannelState.pendingResponse &&
      !outputChannelState.openAiActiveResponse
    ) {
      return false;
    }
    return true;
  }

  shouldBargeIn({
    session,
    userId,
    captureState
  }: {
    session: VoiceSession;
    userId?: string | null;
    captureState?: CaptureStateLike | null;
  }): BargeInDecision {
    if (!session || session.ending) return { allowed: false };
    if (!this.isBargeInInterruptTargetActive(session)) return { allowed: false };
    const botTurnOpenAt = Math.max(0, Number(session.botTurnOpenAt || 0));
    const liveAudioStreaming = this.host.hasRecentAssistantAudioDelta(session);
    const bufferedBotSpeech = this.host.hasBufferedTtsPlayback(session);

    if (!session.botTurnOpen && botTurnOpenAt <= 0) {
      const pendingResponse = this.getPendingResponse(session);
      const pendingEverProducedAudio = Math.max(0, Number(pendingResponse?.audioReceivedAt || 0)) > 0;
      if (!pendingEverProducedAudio) {
        return { allowed: false };
      }
    } else if (botTurnOpenAt > 0 && Date.now() - botTurnOpenAt < BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS) {
      return { allowed: false };
    }

    if (!liveAudioStreaming && bufferedBotSpeech) {
      return { allowed: false };
    }
    if (!liveAudioStreaming && !session.botTurnOpen) {
      return { allowed: false };
    }

    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return { allowed: false };
    if (captureState?.speakingEndFinalizeTimer) return { allowed: false };

    const pendingResponse = this.getPendingResponse(session);
    const interruptionPolicy = this.host.normalizeReplyInterruptionPolicy(
      pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    if (
      !this.host.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId: normalizedUserId
      })
    ) {
      return { allowed: false };
    }

    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));
    if (!isRealtimeMode(session.mode)) {
      const captureAgeMs = Math.max(0, Date.now() - Number(captureState?.startedAt || Date.now()));
      if (captureAgeMs < BARGE_IN_STT_MIN_CAPTURE_AGE_MS) return { allowed: false };
    }
    if (Math.max(0, Number(captureState?.bytesSent || 0)) < minCaptureBytes) return { allowed: false };
    if (!this.isCaptureSignalAssertive(captureState)) return { allowed: false };

    const botRecentlySpeaking = session.botTurnOpen || liveAudioStreaming || bufferedBotSpeech;
    if (botRecentlySpeaking && !this.isCaptureSignalAssertiveDuringBotSpeech(captureState)) {
      return { allowed: false };
    }

    return {
      allowed: true,
      minCaptureBytes,
      interruptionPolicy
    };
  }

  isCaptureSignalAssertive(capture: CaptureStateLike | null | undefined) {
    const signal = this.getCaptureSignalMetrics(capture);
    if (signal.sampleCount <= 0) return false;
    const nearSilentSignal =
      signal.activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX &&
      signal.peak <= VOICE_SILENCE_GATE_PEAK_MAX;
    return !nearSilentSignal;
  }

  isCaptureSignalAssertiveDuringBotSpeech(capture: CaptureStateLike | null | undefined) {
    const signal = this.getCaptureSignalMetrics(capture);
    if (signal.sampleCount <= 0) return false;
    return signal.activeSampleRatio >= BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN &&
      signal.peak >= BARGE_IN_BOT_SPEAKING_PEAK_MIN;
  }

  getCaptureSignalMetrics(capture: CaptureStateLike | null | undefined): CaptureSignalMetrics {
    if (!capture || typeof capture !== "object") {
      return {
        sampleCount: 0,
        activeSampleRatio: 0,
        peak: 0,
        rms: 0
      };
    }
    const sampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (sampleCount <= 0) {
      return {
        sampleCount,
        activeSampleRatio: 0,
        peak: 0,
        rms: 0
      };
    }
    const activeSampleCount = Math.max(0, Number(capture.signalActiveSampleCount || 0));
    const peakAbs = Math.max(0, Number(capture.signalPeakAbs || 0));
    const sumSquares = Math.max(0, Number(capture.signalSumSquares || 0));
    return {
      sampleCount,
      activeSampleRatio: activeSampleCount / sampleCount,
      peak: peakAbs / 32768,
      rms: Math.sqrt(sumSquares / sampleCount) / 32768
    };
  }

  buildInterruptBotSpeechForBargeInCommand({
    session,
    userId = null,
    source = "speaking_start",
    minCaptureBytes = 0,
    captureState = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
    minCaptureBytes?: number;
    captureState?: CaptureStateLike | null;
  }): BargeInInterruptCommand | null {
    if (!session || session.ending) return null;

    const now = Date.now();
    const pendingResponse = this.getPendingResponse(session);
    const interruptionPolicy = this.host.normalizeReplyInterruptionPolicy(
      pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    const retryUtteranceText =
      normalizeVoiceText(
        pendingResponse?.utteranceText || session.lastRequestedRealtimeUtterance?.utteranceText || "",
        STT_REPLY_MAX_CHARS
      ) || null;
    const signal = this.getCaptureSignalMetrics(captureState);
    const botTurnOpenAt = Math.max(0, Number(session.botTurnOpenAt || 0));

    return {
      now,
      userId: String(userId || "").trim() || null,
      source: String(source || "speaking_start"),
      pendingRequestId: Math.max(0, Number(pendingResponse?.requestId || 0)) || null,
      minCaptureBytes: Math.max(0, Number(minCaptureBytes || 0)),
      interruptionPolicy,
      retryUtteranceText,
      captureBytesSent: captureState ? Math.max(0, Number(captureState.bytesSent || 0)) : null,
      captureSignalPeak: captureState ? signal.peak : null,
      captureSignalActiveSampleRatio: captureState ? signal.activeSampleRatio : null,
      botTurnWasOpen: Boolean(session.botTurnOpen),
      botTurnAgeMs: botTurnOpenAt > 0 ? Math.max(0, now - botTurnOpenAt) : null
    };
  }

  private getPendingResponse(session: VoiceSession): PendingResponseLike | null {
    const pendingResponse = session.pendingResponse;
    if (!pendingResponse || typeof pendingResponse !== "object") return null;
    return pendingResponse;
  }
}
