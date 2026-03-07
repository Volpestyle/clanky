import {
  appendAudioToAsr,
  beginAsrUtterance,
  commitAsrUtterance,
  discardAsrUtterance,
  getOrCreatePerUserAsrState,
  getOrCreateSharedAsrState,
  releaseSharedAsrActiveUser,
  scheduleAsrIdleClose,
  tryHandoffSharedAsr,
  type AsrBridgeDeps,
  type AsrCommitResult
} from "./voiceAsrBridge.ts";
import {
  ACTIVITY_TOUCH_THROTTLE_MS,
  CAPTURE_IDLE_FLUSH_MS,
  CAPTURE_MAX_DURATION_MS,
  CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX,
  CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS,
  CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX,
  INPUT_SPEECH_END_SILENCE_MS,
  OPENAI_ASR_BRIDGE_MAX_WAIT_MS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS
} from "./voiceSessionManager.constants.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { GreetingManager } from "./greetingManager.ts";
import type { TurnProcessor } from "./turnProcessor.ts";
import type { CaptureState, VoiceSession } from "./voiceSessionTypes.ts";

type CaptureManagerSettings = Record<string, unknown> | null;

interface CaptureSignalMetrics {
  sampleCount: number;
  activeSampleRatio: number;
  peak: number;
  rms: number;
}

interface PcmSilenceGateResult extends CaptureSignalMetrics {
  clipDurationMs: number;
  drop: boolean;
}

type CaptureManagerStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface CaptureManagerHost {
  store: CaptureManagerStoreLike;
  bargeInController: Pick<BargeInController, "getCaptureSignalMetrics" | "shouldBargeIn">;
  turnProcessor: Pick<TurnProcessor, "queueRealtimeTurn" | "queueSttPipelineTurn">;
  shouldUsePerUserTranscription: (args: {
    session: VoiceSession;
    settings?: CaptureManagerSettings;
  }) => boolean;
  shouldUseSharedTranscription: (args: {
    session: VoiceSession;
    settings?: CaptureManagerSettings;
  }) => boolean;
  buildAsrBridgeDeps: (session: VoiceSession) => AsrBridgeDeps;
  hasReplayBlockingActiveCapture: (session: VoiceSession) => boolean;
  deferredActionQueue: Pick<DeferredActionQueue, "recheckDeferredVoiceActions">;
  greetingManager: Pick<GreetingManager, "maybeFireJoinGreetingOpportunity">;
  hasCaptureBeenPromoted: (capture: CaptureState) => boolean;
  resolveCaptureTurnPromotionReason: (args: {
    session: VoiceSession;
    capture: CaptureState;
  }) => string | null;
  hasCaptureServerVadSpeech: (args: {
    session: VoiceSession;
    capture: CaptureState;
  }) => boolean;
  cancelPendingSystemSpeechForUserSpeech: (args: {
    session: VoiceSession;
    userId?: string | null;
    captureState?: CaptureState | null;
    source?: string;
    now?: number;
  }) => boolean;
  touchActivity: (guildId: string, settings?: CaptureManagerSettings) => void;
  isCaptureConfirmedLiveSpeech: (args: {
    session: VoiceSession;
    capture: CaptureState;
  }) => boolean;
  interruptBotSpeechForBargeIn: (args: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
    minCaptureBytes?: number;
    captureState?: CaptureState | null;
  }) => boolean;
  evaluatePcmSilenceGate: (args: {
    pcmBuffer: Buffer;
    sampleRateHz?: number;
  }) => PcmSilenceGateResult;
  maybeHandleInterruptedReplyRecovery: (args: {
    session: VoiceSession;
    userId?: string | null;
    pcmBuffer?: Buffer | null;
    captureReason?: string;
  }) => boolean;
  queueRealtimeTurnFromAsrBridge: (args: {
    session: VoiceSession;
    userId: string;
    pcmBuffer?: Buffer | null;
    captureReason?: string;
    finalizedAt?: number;
    asrResult?: AsrCommitResult | null;
    source?: string;
  }) => boolean;
}

export class CaptureManager {
  constructor(private readonly host: CaptureManagerHost) {}

  startInboundCapture({
    session,
    userId,
    settings = session?.settingsSnapshot
  }: {
    session: VoiceSession;
    userId: string;
    settings?: CaptureManagerSettings;
  }) {
    if (!session || !userId) return;
    if (session.userCaptures.has(userId)) return;
    const useOpenAiPerUserAsr = this.host.shouldUsePerUserTranscription({
      session,
      settings
    });
    const useOpenAiSharedAsr = this.host.shouldUseSharedTranscription({
      session,
      settings
    });

    const sampleRate = isRealtimeMode(session.mode) ? Number(session.realtimeInputSampleRateHz) || 24000 : 24000;
    session.voxClient?.subscribeUser(userId, INPUT_SPEECH_END_SILENCE_MS, sampleRate);

    const captureState: CaptureState = {
      userId,
      startedAt: Date.now(),
      promotedAt: 0,
      promotionReason: null,
      asrUtteranceId: 0,
      bytesSent: 0,
      signalSampleCount: 0,
      signalActiveSampleCount: 0,
      signalPeakAbs: 0,
      signalSumSquares: 0,
      pcmChunks: [],
      sharedAsrBytesSent: 0,
      lastActivityTouchAt: 0,
      idleFlushTimer: null,
      maxFlushTimer: null,
      speakingEndFinalizeTimer: null,
      finalize: null,
      abort: null,
      removeSubprocessListeners: null
    };

    session.userCaptures.set(userId, captureState);
    const asrDeps = this.host.buildAsrBridgeDeps(session);
    const beginSharedAsrUtterance = (targetUserId: string) =>
      beginAsrUtterance("shared", session, asrDeps, settings || null, targetUserId);
    const appendToSharedAsr = (targetUserId: string, pcmChunk: Buffer) =>
      appendAudioToAsr("shared", session, asrDeps, settings || null, targetUserId, pcmChunk);
    const scheduleSharedAsrIdleClose = () => {
      scheduleAsrIdleClose("shared", session, asrDeps, "");
    };
    const releaseSharedAsrUser = (targetUserId: string | null = userId) => {
      releaseSharedAsrActiveUser(session, targetUserId);
    };
    const tryHandoffSharedAsrToWaitingCapture = () => {
      const asrState = getOrCreateSharedAsrState(session);
      return tryHandoffSharedAsr({
        session,
        asrState,
        deps: asrDeps,
        settings: settings || null,
        beginUtterance: beginSharedAsrUtterance,
        appendAudio: appendToSharedAsr,
        releaseUser: (targetUserId) => releaseSharedAsrUser(targetUserId)
      });
    };

    if (useOpenAiPerUserAsr) {
      beginAsrUtterance("per_user", session, asrDeps, settings || null, userId);
      const asrState = getOrCreatePerUserAsrState(session, userId);
      captureState.asrUtteranceId = Math.max(0, Number(asrState?.utterance?.id || 0));
    }

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
      try {
        current.removeSubprocessListeners?.();
      } catch {
        // ignore
      }
    };

    const maybeTriggerDeferredActions = () => {
      if (!this.host.hasReplayBlockingActiveCapture(session)) {
        this.host.deferredActionQueue.recheckDeferredVoiceActions({ session, reason: "capture_resolved" });
        this.host.greetingManager.maybeFireJoinGreetingOpportunity(session, "capture_resolved");
      }
    };

    const appendBufferedCaptureToAsr = () => {
      if (useOpenAiPerUserAsr || !useOpenAiSharedAsr) return;
      let appendedBytes = 0;
      for (const chunk of captureState.pcmChunks) {
        if (!Buffer.isBuffer(chunk) || !chunk.length) continue;
        const appended = appendToSharedAsr(userId, chunk);
        if (appended) appendedBytes += chunk.length;
      }
      if (appendedBytes > 0) {
        captureState.sharedAsrBytesSent =
          Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) + appendedBytes;
      }
    };

    const promoteCapture = (now = Date.now()) => {
      if (this.host.hasCaptureBeenPromoted(captureState)) return true;
      const promotionReason = this.host.resolveCaptureTurnPromotionReason({
        session,
        capture: captureState
      });
      if (!promotionReason) return false;
      const signal = this.host.bargeInController.getCaptureSignalMetrics(captureState);
      captureState.promotedAt = now;
      captureState.promotionReason = String(promotionReason);
      this.host.cancelPendingSystemSpeechForUserSpeech({
        session,
        userId,
        captureState,
        source: "capture_promoted",
        now
      });
      if (useOpenAiSharedAsr) {
        beginSharedAsrUtterance(userId);
      }
      appendBufferedCaptureToAsr();
      session.lastInboundAudioAt = now;
      captureState.lastActivityTouchAt = now;
      this.host.touchActivity(session.guildId, settings);
      this.host.store.logAction({
        kind: "voice_turn_in",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_activity_started",
        metadata: {
          sessionId: session.id,
          promotionReason: captureState.promotionReason,
          promotionDelayMs: Math.max(0, now - Number(captureState.startedAt || now)),
          promotionBytes: Math.max(0, Number(captureState.bytesSent || 0)),
          promotionServerVadConfirmed: this.host.hasCaptureServerVadSpeech({
            session,
            capture: captureState
          }),
          promotionPeak: signal.peak,
          promotionRms: signal.rms,
          promotionActiveSampleRatio: signal.activeSampleRatio
        }
      });
      return true;
    };

    let captureFinalized = false;
    const finalizeUserTurn = (reason = "stream_end") => {
      if (captureFinalized) return;
      captureFinalized = true;
      const finalizedAt = Date.now();
      const captureDurationMs = Math.max(0, finalizedAt - captureState.startedAt);
      const signal = this.host.bargeInController.getCaptureSignalMetrics(captureState);

      if (!this.host.hasCaptureBeenPromoted(captureState) && Number(captureState.bytesSent || 0) > 0 && !session.ending) {
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "voice_turn_dropped_provisional_capture",
          metadata: {
            sessionId: session.id,
            reason: String(reason || "stream_end"),
            bytesSent: Number(captureState.bytesSent || 0),
            durationMs: captureDurationMs,
            peak: signal.peak,
            rms: signal.rms,
            activeSampleRatio: signal.activeSampleRatio
          }
        });
        cleanupCapture();
        maybeTriggerDeferredActions();
        if (useOpenAiPerUserAsr) {
          discardAsrUtterance("per_user", session, userId);
          scheduleAsrIdleClose("per_user", session, asrDeps, userId);
        } else if (useOpenAiSharedAsr) {
          releaseSharedAsrUser();
          if (!tryHandoffSharedAsrToWaitingCapture()) {
            scheduleSharedAsrIdleClose();
          }
        }
        return;
      }

      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_finalized",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "stream_end"),
          bytesSent: captureState.bytesSent,
          durationMs: captureDurationMs
        }
      });

      if (captureState.bytesSent <= 0 || session.ending) {
        this.host.store.logAction({
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
        maybeTriggerDeferredActions();
        if (useOpenAiPerUserAsr) {
          discardAsrUtterance("per_user", session, userId);
          scheduleAsrIdleClose("per_user", session, asrDeps, userId);
        } else if (useOpenAiSharedAsr) {
          releaseSharedAsrUser();
          if (!tryHandoffSharedAsrToWaitingCapture()) {
            scheduleSharedAsrIdleClose();
          }
        }
        return;
      }

      const pcmBuffer = Buffer.concat(captureState.pcmChunks);
      const sampleRateHz = isRealtimeMode(session.mode)
        ? Number(session.realtimeInputSampleRateHz) || 24000
        : 24000;
      const silenceGate = this.host.evaluatePcmSilenceGate({ pcmBuffer, sampleRateHz });
      const audioDurationMs = silenceGate.clipDurationMs;
      const isBurstArtifact = audioDurationMs > 200 && captureDurationMs < audioDurationMs * 0.25;

      if (silenceGate.drop) {
        this.host.store.logAction({
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
        maybeTriggerDeferredActions();
        if (useOpenAiPerUserAsr) {
          discardAsrUtterance("per_user", session, userId);
          scheduleAsrIdleClose("per_user", session, asrDeps, userId);
        } else if (useOpenAiSharedAsr) {
          releaseSharedAsrUser();
          scheduleSharedAsrIdleClose();
        }
        return;
      }

      if (isBurstArtifact) {
        this.host.store.logAction({
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
        this.host.turnProcessor.queueSttPipelineTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
        return;
      }

      const handledInterruptedReply = this.host.maybeHandleInterruptedReplyRecovery({
        session,
        userId,
        pcmBuffer,
        captureReason: reason
      });
      if (!handledInterruptedReply && (useOpenAiPerUserAsr || useOpenAiSharedAsr)) {
        void this.runAsrBridgeCommit({
          session,
          userId,
          settings,
          captureState,
          pcmBuffer,
          captureReason: reason,
          finalizedAt,
          useOpenAiPerUserAsr,
          useOpenAiSharedAsr
        });
        return;
      }
      if (!handledInterruptedReply) {
        this.host.turnProcessor.queueRealtimeTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason,
          finalizedAt
        });
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

    const onUserAudio = (audioUserId: string, pcmBase64: Buffer | string) => {
      if (String(audioUserId || "") !== userId) return;
      const now = Date.now();
      let normalizedPcm: Buffer;
      try {
        if (Buffer.isBuffer(pcmBase64)) {
          normalizedPcm = pcmBase64;
        } else {
          normalizedPcm = Buffer.from(String(pcmBase64 || ""), "base64");
        }
      } catch (error) {
        this.host.store.logAction({
          kind: "voice_warn",
          guildId: session.guildId,
          channelId: session.textChannelId,
          content: "invalid_pcm_base64_from_subprocess",
          metadata: {
            userId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        return;
      }
      if (!normalizedPcm.length) return;
      captureState.bytesSent += normalizedPcm.length;
      const sampleCount = Math.floor(normalizedPcm.length / 2);
      if (sampleCount > 0) {
        let peakAbs = Math.max(0, Number(captureState.signalPeakAbs || 0));
        let activeSamples = 0;
        let sumSquares = Math.max(0, Number(captureState.signalSumSquares || 0));
        for (let offset = 0; offset + 1 < normalizedPcm.length; offset += 2) {
          const sample = normalizedPcm.readInt16LE(offset);
          const absSample = Math.abs(sample);
          if (absSample > peakAbs) peakAbs = absSample;
          if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
            activeSamples += 1;
          }
          sumSquares += sample * sample;
        }
        captureState.signalSampleCount = Math.max(0, Number(captureState.signalSampleCount || 0)) + sampleCount;
        captureState.signalActiveSampleCount =
          Math.max(0, Number(captureState.signalActiveSampleCount || 0)) + activeSamples;
        captureState.signalPeakAbs = peakAbs;
        captureState.signalSumSquares = sumSquares;
      }
      captureState.pcmChunks.push(normalizedPcm);
      if (useOpenAiPerUserAsr) {
        appendAudioToAsr("per_user", session, asrDeps, settings || null, userId, normalizedPcm);
      }
      const wasPromoted = this.host.hasCaptureBeenPromoted(captureState);
      if (!wasPromoted) {
        promoteCapture(now);
      }
      const isPromoted = this.host.hasCaptureBeenPromoted(captureState);
      if (isPromoted && wasPromoted && useOpenAiSharedAsr) {
        const appendedToSharedAsr = appendToSharedAsr(userId, normalizedPcm);
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

      if (isPromoted) {
        session.lastInboundAudioAt = now;
        if (
          this.host.isCaptureConfirmedLiveSpeech({ session, capture: captureState }) &&
          now - captureState.lastActivityTouchAt >= ACTIVITY_TOUCH_THROTTLE_MS
        ) {
          this.host.touchActivity(session.guildId, settings);
          captureState.lastActivityTouchAt = now;
        }
      }

      const bargeDecision = this.host.bargeInController.shouldBargeIn({ session, userId, captureState });
      if (bargeDecision.allowed) {
        this.host.interruptBotSpeechForBargeIn({
          session,
          userId,
          source: "speaking_data",
          minCaptureBytes: bargeDecision.minCaptureBytes || 0,
          captureState
        });
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
        }
      }
    };

    captureState.finalize = finalizeUserTurn;
    captureState.abort = (reason = "capture_suppressed") => {
      if (captureFinalized) return;
      captureFinalized = true;
      this.host.store.logAction({
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
      maybeTriggerDeferredActions();
      if (useOpenAiPerUserAsr) {
        scheduleAsrIdleClose("per_user", session, asrDeps, userId);
      } else if (useOpenAiSharedAsr) {
        releaseSharedAsrUser();
        if (!tryHandoffSharedAsrToWaitingCapture()) {
          scheduleSharedAsrIdleClose();
        }
      }
    };
    captureState.maxFlushTimer = setTimeout(() => {
      finalizeUserTurn("max_duration");
    }, CAPTURE_MAX_DURATION_MS);

    const onUserAudioEnd = (audioUserId: string) => {
      if (String(audioUserId || "") !== userId) return;
      if (!captureFinalized) {
        finalizeUserTurn("stream_end");
      }
    };

    let listenersRemoved = false;
    const removeListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      session.voxClient?.off("userAudio", onUserAudio);
      session.voxClient?.off("userAudioEnd", onUserAudioEnd);
    };
    captureState.removeSubprocessListeners = removeListeners;

    if (session.voxClient) {
      session.voxClient.on("userAudio", onUserAudio);
      session.voxClient.on("userAudioEnd", onUserAudioEnd);
      session.cleanupHandlers.push(removeListeners);
    }
  }

  private async runAsrBridgeCommit({
    session,
    userId,
    settings,
    captureState,
    pcmBuffer,
    captureReason,
    finalizedAt,
    useOpenAiPerUserAsr,
    useOpenAiSharedAsr
  }: {
    session: VoiceSession;
    userId: string;
    settings?: CaptureManagerSettings;
    captureState: CaptureState;
    pcmBuffer: Buffer;
    captureReason: string;
    finalizedAt: number;
    useOpenAiPerUserAsr: boolean;
    useOpenAiSharedAsr: boolean;
  }) {
    const asrMode = useOpenAiPerUserAsr ? "per_user" : "shared";
    const asrSource = useOpenAiPerUserAsr ? "per_user" : "shared";
    const asrDeps = this.host.buildAsrBridgeDeps(session);

    if (useOpenAiSharedAsr) {
      const hasSharedAsrAudio = Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) > 0;
      if (!hasSharedAsrAudio) {
        this.host.turnProcessor.queueRealtimeTurn({
          session,
          userId,
          pcmBuffer,
          captureReason,
          finalizedAt
        });
        return;
      }
      const sharedAsrState = getOrCreateSharedAsrState(session);
      if (sharedAsrState) {
        sharedAsrState.phase = "committing";
      }
    }

    const asrBridgeMaxWaitMs = Math.max(120, Number(OPENAI_ASR_BRIDGE_MAX_WAIT_MS) || 700);
    let bridgeForwarded = false;
    const forwardAsrBridgeTurn = (asrResult: AsrCommitResult | null, source: string) => {
      if (bridgeForwarded || session.ending) return false;
      const queued = this.host.queueRealtimeTurnFromAsrBridge({
        session,
        userId,
        pcmBuffer,
        captureReason,
        finalizedAt,
        asrResult,
        source
      });
      if (queued) bridgeForwarded = true;
      return queued;
    };

    const fallbackTimer = setTimeout(() => {
      if (bridgeForwarded || session.ending) return;
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "openai_realtime_asr_bridge_timeout_fallback",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          source: asrSource,
          waitMs: asrBridgeMaxWaitMs
        }
      });
    }, asrBridgeMaxWaitMs);

    try {
      const asrResult = asrMode === "per_user"
        ? await commitAsrUtterance("per_user", asrDeps, settings || null, userId, captureReason)
        : await commitAsrUtterance("shared", asrDeps, settings || null, userId, captureReason);
      clearTimeout(fallbackTimer);
      const commitTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);

      if (commitTranscript) {
        const forwarded = forwardAsrBridgeTurn(asrResult, asrSource);
        if (forwarded) return;
      }

      if (!bridgeForwarded && !session.ending) {
        const lateAsrState = asrMode === "per_user"
          ? getOrCreatePerUserAsrState(session, userId)
          : getOrCreateSharedAsrState(session);
        const trackedUtterance = lateAsrState?.utterance;
        if (trackedUtterance) {
          const lateDeadlineMs = Date.now() + 1500;
          while (Date.now() < lateDeadlineMs && !bridgeForwarded && !session.ending) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            if (lateAsrState?.utterance !== trackedUtterance) break;
            const lateFinal = normalizeVoiceText(
              Array.isArray(trackedUtterance.finalSegments)
                ? trackedUtterance.finalSegments.join(" ")
                : "",
              STT_TRANSCRIPT_MAX_CHARS
            );
            if (lateFinal) {
              const lateForwarded = forwardAsrBridgeTurn(
                {
                  ...(asrResult || {
                    transcript: "",
                    asrStartedAtMs: 0,
                    asrCompletedAtMs: 0,
                    transcriptionModelPrimary: "",
                    transcriptionModelFallback: null,
                    transcriptionPlanReason: "",
                    usedFallbackModel: false,
                    captureReason,
                    transcriptLogprobs: null
                  }),
                  transcript: lateFinal
                },
                `${asrSource}_late_streaming`
              );
              if (lateForwarded) {
                this.host.store.logAction({
                  kind: "voice_runtime",
                  guildId: session.guildId,
                  channelId: session.textChannelId,
                  userId,
                  content: "openai_realtime_asr_bridge_late_streaming_recovered",
                  metadata: {
                    sessionId: session.id,
                    captureReason: String(captureReason || "stream_end"),
                    source: asrSource,
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

      if (!bridgeForwarded) {
        forwardAsrBridgeTurn(asrResult, asrSource);
      }
      const lateTranscript = normalizeVoiceText(asrResult?.transcript || "", STT_TRANSCRIPT_MAX_CHARS);
      if (!lateTranscript) return;
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "openai_realtime_asr_bridge_late_result_ignored",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          source: asrSource,
          transcriptChars: lateTranscript.length
        }
      });
    } catch (error) {
      clearTimeout(fallbackTimer);
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `openai_realtime_asr_turn_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end")
        }
      });
      forwardAsrBridgeTurn(null, `${asrSource}_error`);
    }
  }
}
