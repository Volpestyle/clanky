import { estimateUsdCost } from "../pricing.ts";
import {
  getReplyGenerationSettings,
  getVoiceRuntimeConfig
} from "../settings/agentStack.ts";
import type {
  AssistantOutputState,
  ReplyOutputLockState,
  TtsPlaybackState
} from "./assistantOutputState.ts";
import {
  TTS_PLAYBACK_STATE,
  buildReplyOutputLockState,
  createAssistantOutputState,
  getAssistantOutputActivityAt,
  normalizeAssistantOutputState,
  normalizeTtsPlaybackState,
  patchAssistantOutputState,
  syncAssistantOutputStateRecord
} from "./assistantOutputState.ts";
import {
  ACTIVITY_TOUCH_THROTTLE_MS,
  BOT_TURN_SILENCE_RESET_MS,
  CLANKVOX_TTS_TELEMETRY_STALE_MS,
  MAX_RESPONSE_SILENCE_RETRIES,
  RESPONSE_DONE_SILENCE_GRACE_MS,
  RESPONSE_SILENCE_RETRY_DELAY_MS,
  STT_REPLY_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import {
  getRealtimeCommitMinimumBytes,
  isRealtimeMode,
  normalizeVoiceText,
  parseResponseDoneId,
  parseResponseDoneModel,
  parseResponseDoneStatus,
  parseResponseDoneUsage,
  resolveRealtimeProvider
} from "./voiceSessionHelpers.ts";
import type {
  MusicPlaybackPhase,
  VoiceSession
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseShouldLockOutput
} from "./voiceSessionTypes.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { GreetingManager } from "./greetingManager.ts";

type ReplyManagerSettings = Record<string, unknown> | null;

type ReplyManagerStoreLike = {
  getSettings: () => ReplyManagerSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
    usdCost?: number;
  }) => void;
};

export interface ReplyManagerHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: ReplyManagerStoreLike;
  musicPlayer?: {
    resume?: () => void;
  } | null;
  bargeInController: Pick<
    BargeInController,
    "clearBargeInOutputSuppression" | "isBargeInOutputSuppressed"
  >;
  touchActivity: (guildId: string, settings?: ReplyManagerSettings) => void;
  logVoiceLatencyStage: (payload: Record<string, unknown>) => void;
  normalizeReplyInterruptionPolicy: (rawPolicy?: unknown) => unknown;
  setActiveReplyInterruptionPolicy: (session: VoiceSession, policy?: unknown) => void;
  maybeClearActiveReplyInterruptionPolicy: (session: VoiceSession) => void;
  deferredActionQueue: Pick<
    DeferredActionQueue,
    | "getDeferredQueuedUserTurns"
    | "scheduleDeferredVoiceActionRecheck"
    | "recheckDeferredVoiceActions"
    | "clearAllDeferredVoiceActions"
  >;
  greetingManager: Pick<GreetingManager, "maybeFireJoinGreetingOpportunity" | "clearJoinGreetingOpportunity">;
  hasReplayBlockingActiveCapture: (session: VoiceSession) => boolean;
  endSession: (args: {
    guildId: string;
    reason?: string;
    announcement?: string;
    settings?: ReplyManagerSettings;
  }) => Promise<unknown>;
  scheduleBotSpeechMusicUnduck: (
    session: VoiceSession,
    settings?: ReplyManagerSettings,
    delayMs?: number
  ) => void;
  getMusicPhase: (session: VoiceSession) => MusicPlaybackPhase;
  setMusicPhase: (session: VoiceSession, phase: MusicPlaybackPhase) => void;
  haltSessionOutputForMusicPlayback: (session: VoiceSession, reason?: string) => void;
}

export class ReplyManager {
  constructor(private readonly host: ReplyManagerHost) {}

  ensureAssistantOutputState(session: VoiceSession): AssistantOutputState | null {
    if (!session || session.ending) return null;
    const now = Date.now();
    const existing =
      session.assistantOutput && typeof session.assistantOutput === "object"
        ? session.assistantOutput
        : null;
    if (existing) {
      const normalized = normalizeAssistantOutputState(existing, { now });
      session.assistantOutput = normalized;
      return normalized;
    }

    const seeded = createAssistantOutputState({ now, trigger: "session_seed" });
    session.assistantOutput = seeded;
    return seeded;
  }

  patchAssistantOutputTelemetry(
    session: VoiceSession,
    metadata: {
      trigger?: string | null;
      requestId?: number | null;
      ttsPlaybackState?: string | null;
      ttsBufferedSamples?: number | null;
    } = {}
  ) {
    const state = this.ensureAssistantOutputState(session);
    if (!state) return null;
    const nextState = patchAssistantOutputState(state, {
      now: Date.now(),
      trigger: metadata.trigger,
      requestId: metadata.requestId,
      ttsPlaybackState: metadata.ttsPlaybackState,
      ttsBufferedSamples: metadata.ttsBufferedSamples
    });
    session.assistantOutput = nextState;
    return nextState;
  }

  getSessionTtsPlaybackState(
    session: VoiceSession,
    fallbackState: AssistantOutputState | null = null
  ): TtsPlaybackState {
    if (!session || session.ending) return TTS_PLAYBACK_STATE.IDLE;
    const telemetryFresh = this.isClankvoxTtsTelemetryFresh(session);
    const bufferedSamples = this.getBufferedTtsSamples(session);
    const voxPlaybackState = session.voxClient?.getTtsPlaybackState?.();
    if (typeof voxPlaybackState === "string") {
      if (!telemetryFresh) {
        return TTS_PLAYBACK_STATE.IDLE;
      }
      if (bufferedSamples > 0) {
        return TTS_PLAYBACK_STATE.BUFFERED;
      }
      return normalizeTtsPlaybackState(voxPlaybackState);
    }
    return normalizeTtsPlaybackState(fallbackState?.ttsPlaybackState);
  }

  getClankvoxReportedTtsPlaybackState(session: VoiceSession) {
    if (!session || session.ending) return null;
    const playbackState = session.voxClient?.getTtsPlaybackState?.();
    if (typeof playbackState !== "string") return null;
    return normalizeTtsPlaybackState(playbackState);
  }

  getClankvoxReportedTtsBufferedSamples(session: VoiceSession) {
    if (!session || session.ending) return null;
    const voxClient = session.voxClient;
    if (!voxClient || typeof voxClient !== "object") return null;
    const rawBufferedSamples =
      typeof voxClient.getTtsBufferDepthSamples === "function"
        ? Number(voxClient.getTtsBufferDepthSamples())
        : Number(voxClient.ttsBufferDepthSamples || 0);
    if (!Number.isFinite(rawBufferedSamples)) return null;
    return Math.max(0, Math.round(rawBufferedSamples));
  }

  getClankvoxTtsTelemetryAgeMs(session: VoiceSession) {
    if (!session || session.ending) return null;
    const updatedAt = Number(session.voxClient?.getTtsTelemetryUpdatedAt?.() || 0);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    return Math.max(0, Date.now() - updatedAt);
  }

  isClankvoxTtsTelemetryFresh(session: VoiceSession) {
    const telemetryAgeMs = this.getClankvoxTtsTelemetryAgeMs(session);
    if (telemetryAgeMs == null) return true;
    return telemetryAgeMs <= CLANKVOX_TTS_TELEMETRY_STALE_MS;
  }

  getOutputLockDebugMetadata(session: VoiceSession, outputLockReason: string | null = null) {
    if (!session || session.ending) return {};
    if (String(outputLockReason || "").trim() !== "bot_audio_buffered") return {};
    const assistantOutput = this.ensureAssistantOutputState(session);
    const reportedTtsPlaybackState =
      this.getClankvoxReportedTtsPlaybackState(session) ||
      assistantOutput?.ttsPlaybackState ||
      null;
    const reportedTtsBufferedSamples = this.getClankvoxReportedTtsBufferedSamples(session);
    const telemetryAgeMs = this.getClankvoxTtsTelemetryAgeMs(session);
    return {
      outputLockPhase: assistantOutput?.phase || null,
      outputLockAssistantReason: assistantOutput?.reason || null,
      outputLockAssistantLastTrigger: assistantOutput?.lastTrigger || null,
      outputLockTtsPlaybackState: reportedTtsPlaybackState,
      outputLockTtsBufferedSamples: reportedTtsBufferedSamples,
      outputLockTtsTelemetryAgeMs: telemetryAgeMs == null ? null : Math.round(telemetryAgeMs),
      outputLockTtsTelemetryFresh: this.isClankvoxTtsTelemetryFresh(session)
    };
  }

  maybeClearStaleRealtimeResponseState(
    session: VoiceSession,
    { liveAudioStreaming = false, bufferedBotSpeech = false } = {}
  ) {
    if (!session || session.ending) return false;
    if (session.pendingResponse) return false;
    if (liveAudioStreaming || bufferedBotSpeech) return false;
    if (session.awaitingToolOutputs) return false;
    if (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0) {
      return false;
    }
    if (!this.isRealtimeResponseActive(session)) return false;

    const lastRelevantAt = Math.max(
      0,
      Number(session.lastResponseRequestAt || 0),
      Number(session.lastAudioDeltaAt || 0),
      getAssistantOutputActivityAt(session.assistantOutput)
    );
    if (!lastRelevantAt) return false;
    const staleAgeMs = Math.max(0, Date.now() - lastRelevantAt);
    if (staleAgeMs < RESPONSE_DONE_SILENCE_GRACE_MS) return false;

    const realtimeClient = session.realtimeClient;
    if (
      !realtimeClient ||
      typeof realtimeClient !== "object" ||
      !("clearActiveResponse" in realtimeClient) ||
      typeof realtimeClient.clearActiveResponse !== "function"
    ) {
      return false;
    }

    try {
      realtimeClient.clearActiveResponse();
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: "openai_realtime_active_response_cleared_stale",
        metadata: {
          sessionId: session.id,
          staleAgeMs
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  syncAssistantOutputState(session: VoiceSession, trigger = "state_sync") {
    const state = this.ensureAssistantOutputState(session);
    if (!state) return null;
    const previousPhase = String(state.phase || "idle");

    const liveAudioStreaming = this.hasRecentAssistantAudioDelta(session);
    const pendingResponse =
      session?.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
    const awaitingToolOutputs =
      session.awaitingToolOutputs ||
      (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0);
    const bufferedSamples = this.getBufferedTtsSamples(session);

    let ttsPlaybackState = this.getSessionTtsPlaybackState(session, state);

    let bufferedBotSpeech = ttsPlaybackState === TTS_PLAYBACK_STATE.BUFFERED || bufferedSamples > 0;
    this.maybeClearStaleRealtimeResponseState(session, {
      liveAudioStreaming,
      bufferedBotSpeech
    });
    const openAiActiveResponse = this.isRealtimeResponseActive(session);
    const bufferedStateAgeMs = Math.max(0, Date.now() - Number(state.phaseEnteredAt || 0));

    if (
      bufferedBotSpeech &&
      bufferedSamples <= 0 &&
      !liveAudioStreaming &&
      !pendingResponse &&
      !openAiActiveResponse &&
      bufferedStateAgeMs >= RESPONSE_DONE_SILENCE_GRACE_MS
    ) {
      ttsPlaybackState = TTS_PLAYBACK_STATE.IDLE;
      bufferedBotSpeech = false;
    }

    const nextState = syncAssistantOutputStateRecord(state, {
      now: Date.now(),
      trigger,
      liveAudioStreaming,
      pendingResponse: Boolean(pendingResponse),
      openAiActiveResponse,
      awaitingToolOutputs,
      requestId: pendingResponse?.requestId || state.requestId || null,
      ttsPlaybackState,
      ttsBufferedSamples: bufferedSamples
    });
    session.assistantOutput = nextState;
    if (
      previousPhase !== "idle" &&
      nextState.phase === "idle" &&
      this.host.deferredActionQueue.getDeferredQueuedUserTurns(session).length > 0
    ) {
      this.host.deferredActionQueue.scheduleDeferredVoiceActionRecheck(session, {
        type: "queued_user_turns",
        delayMs: 0,
        reason: "assistant_output_idle"
      });
    }
    return nextState;
  }

  hasRecentAssistantAudioDelta(session: VoiceSession) {
    if (!session || session.ending) return false;
    const msSinceLastDelta = Date.now() - Number(session.lastAudioDeltaAt || 0);
    return msSinceLastDelta < 200;
  }

  getBufferedTtsSamples(session: VoiceSession) {
    if (!session || session.ending) return 0;
    const voxClient = session.voxClient;
    if (!voxClient || typeof voxClient !== "object") return 0;
    if ("isAlive" in voxClient && voxClient.isAlive === false) return 0;
    const rawBufferedSamples =
      typeof voxClient.getTtsBufferDepthSamples === "function"
        ? Number(voxClient.getTtsBufferDepthSamples())
        : Number(voxClient.ttsBufferDepthSamples || 0);
    const bufferedSamples = Math.max(0, rawBufferedSamples);
    if (bufferedSamples <= 0) return 0;
    return this.isClankvoxTtsTelemetryFresh(session) ? bufferedSamples : 0;
  }

  hasBufferedTtsPlayback(session: VoiceSession) {
    const state = this.ensureAssistantOutputState(session);
    return (
      this.getBufferedTtsSamples(session) > 0 ||
      this.getSessionTtsPlaybackState(session, state) === TTS_PLAYBACK_STATE.BUFFERED
    );
  }

  resetBotAudioPlayback(session: VoiceSession) {
    if (!session) return;
    if (musicPhaseIsActive(this.host.getMusicPhase(session))) {
      try { session.voxClient?.stopTtsPlayback?.(); } catch { /* ignore */ }
    } else {
      try { session.voxClient?.stopPlayback?.(); } catch { /* ignore */ }
    }
    session.voxClient?.clearTtsPlaybackTelemetry?.();
    this.patchAssistantOutputTelemetry(session, {
      trigger: "reset_bot_audio_playback",
      ttsPlaybackState: TTS_PLAYBACK_STATE.IDLE,
      ttsBufferedSamples: 0
    });
    this.syncAssistantOutputState(session, "reset_bot_audio_playback");
    this.host.maybeClearActiveReplyInterruptionPolicy(session);
  }

  getReplyOutputLockState(session: VoiceSession): ReplyOutputLockState {
    if (!session || session.ending) {
      return {
        locked: true,
        reason: "session_inactive",
        phase: "idle",
        musicActive: false,
        botTurnOpen: false,
        bufferedBotSpeech: false,
        pendingResponse: false,
        openAiActiveResponse: false,
        awaitingToolOutputs: false,
        streamBufferedBytes: 0
      };
    }

    const streamBufferedBytes = 0;
    const musicActive = musicPhaseShouldLockOutput(this.host.getMusicPhase(session));
    const assistantOutput = this.syncAssistantOutputState(session, "reply_output_lock");
    const botTurnOpen = Boolean(session.botTurnOpen);
    const pendingResponse = Boolean(session.pendingResponse && typeof session.pendingResponse === "object");
    const openAiActiveResponse = this.isRealtimeResponseActive(session);
    const awaitingToolOutputs =
      session.awaitingToolOutputs ||
      (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0);
    return buildReplyOutputLockState({
      assistantOutput,
      musicActive,
      botTurnOpen,
      pendingResponse,
      openAiActiveResponse,
      awaitingToolOutputs,
      streamBufferedBytes
    });
  }

  markBotTurnOut(session: VoiceSession, settings = session.settingsSnapshot) {
    const now = Date.now();
    if (now - Number(session.lastBotActivityTouchAt || 0) >= ACTIVITY_TOUCH_THROTTLE_MS) {
      this.host.touchActivity(session.guildId, settings);
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
      this.host.logVoiceLatencyStage({
        session,
        userId: this.botUserId,
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
      session.botTurnOpenAt = now;
      session.lastAssistantReplyAt = now;
      this.host.store.logAction({
        kind: "voice_turn_out",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
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
      session.botTurnOpenAt = 0;
      session.botTurnResetTimer = null;
      this.syncAssistantOutputState(session, "bot_turn_reset");
      this.host.maybeClearActiveReplyInterruptionPolicy(session);
    }, BOT_TURN_SILENCE_RESET_MS);
  }

  pendingResponseHasAudio(session: VoiceSession, pendingResponse = session?.pendingResponse) {
    if (!session || !pendingResponse) return false;
    const requestedAt = Number(pendingResponse.requestedAt || 0);
    if (!requestedAt) return false;
    return Number(session.lastAudioDeltaAt || 0) >= requestedAt;
  }

  clearResponseSilenceTimers(session: VoiceSession) {
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

  clearPendingResponse(session: VoiceSession) {
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
    this.syncAssistantOutputState(session, "pending_response_cleared");
    this.host.maybeClearActiveReplyInterruptionPolicy(session);
    this.host.deferredActionQueue.recheckDeferredVoiceActions({
      session,
      reason: "pending_response_cleared"
    });
    this.host.greetingManager.maybeFireJoinGreetingOpportunity(session, "pending_response_cleared");
  }

  isRealtimeResponseActive(session: VoiceSession) {
    if (!session || !isRealtimeMode(session.mode)) return false;
    const realtimeClient = session.realtimeClient;
    if (
      !realtimeClient ||
      typeof realtimeClient !== "object" ||
      !("isResponseInProgress" in realtimeClient) ||
      typeof realtimeClient.isResponseInProgress !== "function"
    ) {
      return false;
    }
    try {
      return Boolean(realtimeClient.isResponseInProgress.call(realtimeClient));
    } catch {
      return false;
    }
  }

  armResponseSilenceWatchdog({
    session,
    requestId,
    userId = null
  }: {
    session: VoiceSession;
    requestId: number;
    userId?: string | null;
  }) {
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
      void Promise.resolve(this.handleSilentResponse({
        session,
        userId: pending.userId || userId,
        trigger: "watchdog"
      })).catch(() => undefined);
    }, RESPONSE_SILENCE_RETRY_DELAY_MS);
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
  }: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
    resetRetryState?: boolean;
    emitCreateEvent?: boolean;
    interruptionPolicy?: unknown;
    utteranceText?: string | null;
    latencyContext?: Record<string, unknown> | null;
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    this.host.deferredActionQueue.clearAllDeferredVoiceActions(session);
    this.host.greetingManager.clearJoinGreetingOpportunity(session);
    if (emitCreateEvent && this.isRealtimeResponseActive(session)) {
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
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
    const normalizedInterruptionPolicy = this.host.normalizeReplyInterruptionPolicy(interruptionPolicySeed);
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
    this.host.setActiveReplyInterruptionPolicy(session, normalizedInterruptionPolicy);
    this.clearResponseSilenceTimers(session);
    this.armResponseSilenceWatchdog({
      session,
      requestId,
      userId: session.pendingResponse.userId
    });
    this.syncAssistantOutputState(session, "response_requested");
    return true;
  }

  async handleSilentResponse({
    session,
    userId = null,
    trigger = "watchdog",
    responseId = null,
    responseStatus = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    trigger?: string;
    responseId?: string | null;
    responseStatus?: string | null;
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

    if (this.host.hasReplayBlockingActiveCapture(session)) {
      pending.handlingSilence = false;
      this.armResponseSilenceWatchdog({
        session,
        requestId: pending.requestId,
        userId: pending.userId || userId
      });
      return;
    }

    const resolvedUserId = pending.userId || userId || this.botUserId;
    const setHandlingDone = () => {
      const active = session.pendingResponse;
      if (active && Number(active.requestId || 0) === Number(pending.requestId || 0)) {
        active.handlingSilence = false;
      }
    };

    if (pending.retryCount < MAX_RESPONSE_SILENCE_RETRIES) {
      pending.retryCount += 1;
      this.host.store.logAction({
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
        this.host.store.logAction({
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
        await this.host.endSession({
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
      this.host.store.logAction({
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
        this.host.store.logAction({
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
        await this.host.endSession({
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

    this.host.store.logAction({
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
  }

  handleResponseDone({
    session,
    event,
    settings = null,
    runtimeLabel = "openai_realtime"
  }: {
    session: VoiceSession;
    event: Record<string, unknown>;
    settings?: ReplyManagerSettings;
    runtimeLabel?: string;
  }) {
    if (session.ending) return;
    const hadBargeSuppression = this.host.bargeInController.isBargeInOutputSuppressed(session);
    if (hadBargeSuppression) {
      this.host.bargeInController.clearBargeInOutputSuppression(session, "response_done");
    }
    const pending = session.pendingResponse;
    const responseId = parseResponseDoneId(event);
    const responseStatus = parseResponseDoneStatus(event);
    const responseUsage = parseResponseDoneUsage(event);
    const resolvedSettings = settings || session.settingsSnapshot || this.host.store.getSettings();
    const voiceRuntime = getVoiceRuntimeConfig(resolvedSettings);
    const replyGeneration = getReplyGenerationSettings(resolvedSettings);
    const realtimeProvider = resolveRealtimeProvider(session.mode);
    const realtimeClientSessionModel =
      session.realtimeClient &&
      typeof session.realtimeClient === "object" &&
      "sessionConfig" in session.realtimeClient &&
      session.realtimeClient.sessionConfig &&
      typeof session.realtimeClient.sessionConfig === "object"
        ? String(session.realtimeClient.sessionConfig.model || "").trim()
        : "";
    const resolvedResponseModel = isRealtimeMode(session.mode)
      ? parseResponseDoneModel(event) ||
      realtimeClientSessionModel ||
      String(voiceRuntime.openaiRealtime?.model || "gpt-realtime").trim() ||
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
          customPricing: replyGeneration.pricing
        })
        : 0;
    const hadAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;
    const hasInFlightToolCalls =
      session.awaitingToolOutputs ||
      (session.openAiToolCallExecutions instanceof Map && session.openAiToolCallExecutions.size > 0);

    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.botUserId,
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

    if (!pending) {
      this.syncAssistantOutputState(session, "response_done_without_pending");
      return;
    }

    if (hadAudio) {
      this.host.scheduleBotSpeechMusicUnduck(session, resolvedSettings, BOT_TURN_SILENCE_RESET_MS);

      const musicPhase = this.host.getMusicPhase(session);
      if (musicPhase === "paused_wake_word") {
        setTimeout(() => {
          if (session.ending) return;
          this.host.setMusicPhase(session, "playing");
          this.host.musicPlayer?.resume?.();
          this.host.haltSessionOutputForMusicPlayback(session, "music_resumed_after_wake_word");
        }, BOT_TURN_SILENCE_RESET_MS);
      }

      this.clearPendingResponse(session);
      this.syncAssistantOutputState(session, "response_done_had_audio");
      return;
    }

    if (hasInFlightToolCalls) {
      this.clearPendingResponse(session);
      this.syncAssistantOutputState(session, "response_done_tool_calls_in_flight");
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
        this.syncAssistantOutputState(session, "response_done_grace_audio_detected");
        return;
      }
      void Promise.resolve(this.handleSilentResponse({
        session,
        userId: responseUserId,
        trigger: "response_done",
        responseId,
        responseStatus
      })).catch(() => undefined);
    }, RESPONSE_DONE_SILENCE_GRACE_MS);
  }

  private get botUserId() {
    return this.host.client.user?.id || null;
  }
}
