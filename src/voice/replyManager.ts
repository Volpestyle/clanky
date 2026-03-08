import { estimateUsdCost } from "../llm/pricing.ts";
import type { ActiveReplyRegistry } from "../tools/activeReplyRegistry.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
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
import type { BargeInController, ReplyInterruptionPolicy } from "./bargeInController.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";

type ReplyManagerSettings = Record<string, unknown> | null;

interface SilentResponseRecoveryArgs {
  session: VoiceSession;
  userId?: string | null;
  trigger?: string;
  responseId?: string | null;
  responseStatus?: string | null;
}

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
  activeReplies?: ActiveReplyRegistry | null;
  musicPlayer?: {
    resume?: () => void;
  } | null;
  bargeInController: Pick<
    BargeInController,
    "clearBargeInOutputSuppression" | "isBargeInOutputSuppressed"
  >;
  touchActivity: (guildId: string, settings?: ReplyManagerSettings) => void;
  logVoiceLatencyStage: (payload: Record<string, unknown>) => void;
  normalizeReplyInterruptionPolicy: (
    rawPolicy?: ReplyInterruptionPolicy | Record<string, unknown> | null
  ) => ReplyInterruptionPolicy | null;
  setActiveReplyInterruptionPolicy: (
    session: VoiceSession,
    policy?: ReplyInterruptionPolicy | Record<string, unknown> | null
  ) => void;
  maybeClearActiveReplyInterruptionPolicy: (session: VoiceSession) => void;
  deferredActionQueue: Pick<
    DeferredActionQueue,
    | "getDeferredQueuedUserTurns"
    | "scheduleDeferredVoiceActionRecheck"
    | "recheckDeferredVoiceActions"
    | "clearAllDeferredVoiceActions"
  >;
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

  /**
   * Check whether the OpenAI realtime active response is stale (no recent
   * activity for longer than RESPONSE_DONE_SILENCE_GRACE_MS). This is a
   * pure read — no side effects. Call clearStaleRealtimeResponse() to
   * actually clear it.
   *
   * Use isStaleRealtimeResponseAt() to pass a shared snapshot timestamp
   * when the caller also uses that timestamp for derivation.
   */
  isStaleRealtimeResponse(session: VoiceSession) {
    return this.isStaleRealtimeResponseAt(session, Date.now());
  }

  isStaleRealtimeResponseAt(session: VoiceSession, now: number) {
    if (!session || session.ending) return false;
    if (!this.isRealtimeResponseActive(session)) return false;

    const lastRelevantAt = Math.max(
      0,
      Number(session.lastResponseRequestAt || 0),
      Number(session.lastAudioDeltaAt || 0),
      getAssistantOutputActivityAt(session.assistantOutput)
    );
    if (!lastRelevantAt) return false;
    const staleAgeMs = Math.max(0, now - lastRelevantAt);
    return staleAgeMs >= RESPONSE_DONE_SILENCE_GRACE_MS;
  }

  getActiveResponseId(session: VoiceSession): string | null {
    const realtimeClient = session?.realtimeClient;
    if (
      !realtimeClient ||
      typeof realtimeClient !== "object" ||
      !("activeResponseId" in realtimeClient)
    ) {
      return null;
    }
    return realtimeClient.activeResponseId
      ? String(realtimeClient.activeResponseId)
      : null;
  }

  /**
   * Clear a stale OpenAI realtime active response. Idempotent and
   * best-effort — safe to call even if the response was already cleared
   * or the client state changed since the staleness check.
   *
   * When expectedResponseId is provided, the clear is skipped if the
   * current active response ID no longer matches (a fresh response
   * started since the staleness check).
   */
  clearStaleRealtimeResponse(session: VoiceSession, expectedResponseId: string | null = null) {
    if (!session || session.ending) return false;

    const realtimeClient = session.realtimeClient;
    if (
      !realtimeClient ||
      typeof realtimeClient !== "object" ||
      !("clearActiveResponse" in realtimeClient) ||
      typeof realtimeClient.clearActiveResponse !== "function"
    ) {
      return false;
    }

    // If we captured a specific response ID at check time, only clear
    // if it still matches. A different ID means a new response started.
    if (expectedResponseId) {
      const currentId = this.getActiveResponseId(session);
      if (currentId && currentId !== expectedResponseId) return false;
    }

    const lastRelevantAt = Math.max(
      0,
      Number(session.lastResponseRequestAt || 0),
      Number(session.lastAudioDeltaAt || 0)
    );
    const staleAgeMs = Math.max(0, Date.now() - lastRelevantAt);

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
    const now = Date.now();
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
    const openAiActiveResponse = this.isRealtimeResponseActive(session);
    const bufferedStateAgeMs = Math.max(0, now - Number(state.phaseEnteredAt || 0));

    // Compute stale-response eligibility BEFORE derivation, since derivation
    // will overwrite phaseEnteredAt and make the staleness check see "just started".
    // Capture the responseId now so clearStaleRealtimeResponse only clears
    // this specific response, not a fresh one that started in the meantime.
    const staleResponseId = openAiActiveResponse
      ? this.getActiveResponseId(session)
      : null;
    const staleResponseEligible =
      openAiActiveResponse &&
      !pendingResponse &&
      !awaitingToolOutputs &&
      !liveAudioStreaming &&
      !bufferedBotSpeech &&
      this.isStaleRealtimeResponseAt(session, now);

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
      now,
      trigger,
      liveAudioStreaming,
      pendingResponse: Boolean(pendingResponse),
      openAiActiveResponse: staleResponseEligible ? false : openAiActiveResponse,
      awaitingToolOutputs,
      requestId: pendingResponse?.requestId || state.requestId || null,
      ttsPlaybackState,
      ttsBufferedSamples: bufferedSamples
    });
    session.assistantOutput = nextState;

    // Clear stale OpenAI active response AFTER phase derivation.
    // We pre-computed eligibility above so the derivation already excluded
    // the stale signal; now perform the actual side-effect cleanup.
    // Pass the captured responseId so we only clear the response we deemed
    // stale, not a fresh one that may have started since the check.
    if (staleResponseEligible) {
      this.clearStaleRealtimeResponse(session, staleResponseId);
    }

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

  private resetPendingResponse({
    session,
    abortActiveReplies = false,
    abortPendingToolCalls = false,
    trigger = "pending_response_cleared",
    recheckDeferredActions = false
  }: {
    session: VoiceSession;
    abortActiveReplies?: boolean;
    abortPendingToolCalls?: boolean;
    trigger?: string;
    recheckDeferredActions?: boolean;
  }) {
    if (!session) return;
    this.clearResponseSilenceTimers(session);
    if (abortActiveReplies && this.host.activeReplies) {
      const voiceReplyScopeKey = buildVoiceReplyScopeKey(session.id);
      this.host.activeReplies.abortAll(voiceReplyScopeKey, "Pending response cleared");
    }

    if (abortPendingToolCalls && session.openAiPendingToolAbortControllers) {
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
    this.syncAssistantOutputState(session, trigger);
    this.host.maybeClearActiveReplyInterruptionPolicy(session);
    if (recheckDeferredActions) {
      this.host.deferredActionQueue.recheckDeferredVoiceActions({
        session,
        reason: "pending_response_cleared"
      });
    }
  }

  clearPendingResponse(session: VoiceSession) {
    this.resetPendingResponse({
      session,
      abortActiveReplies: true,
      abortPendingToolCalls: true,
      trigger: "pending_response_cleared",
      recheckDeferredActions: true
    });
  }

  settlePendingResponse(session: VoiceSession, trigger = "pending_response_settled") {
    this.resetPendingResponse({
      session,
      abortActiveReplies: false,
      abortPendingToolCalls: false,
      trigger,
      recheckDeferredActions: false
    });
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
      this.spawnSilentResponseRecovery({
        session,
        userId: pending.userId || userId,
        trigger: "watchdog"
      });
    }, RESPONSE_SILENCE_RETRY_DELAY_MS);
  }

  private spawnSilentResponseRecovery({
    session,
    userId = null,
    trigger = "watchdog",
    responseId = null,
    responseStatus = null
  }: SilentResponseRecoveryArgs) {
    void Promise.resolve(this.handleSilentResponse({
      session,
      userId,
      trigger,
      responseId,
      responseStatus
    })).catch((error: unknown) => {
      const active = session.pendingResponse;
      if (active) {
        active.handlingSilence = false;
      }
      const resolvedUserId = active?.userId || userId || this.botUserId;
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: `response_silent_recovery_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          requestId: Number(active?.requestId || 0) || null,
          trigger,
          responseId,
          responseStatus
        }
      });
      if (session.ending || !isRealtimeMode(session.mode) || !active) return;
      if (this.pendingResponseHasAudio(session, active)) {
        this.clearPendingResponse(session);
        return;
      }
      this.armResponseSilenceWatchdog({
        session,
        requestId: active.requestId,
        userId: active.userId || userId
      });
    });
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
    interruptionPolicy?: ReplyInterruptionPolicy | Record<string, unknown> | null;
    utteranceText?: string | null;
    latencyContext?: Record<string, unknown> | null;
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    this.host.deferredActionQueue.clearAllDeferredVoiceActions(session);
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
  }: SilentResponseRecoveryArgs) {
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
      this.settlePendingResponse(session, "response_done_tool_calls_in_flight");
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
      this.spawnSilentResponseRecovery({
        session,
        userId: responseUserId,
        trigger: "response_done",
        responseId,
        responseStatus
      });
    }, RESPONSE_DONE_SILENCE_GRACE_MS);
  }

  private get botUserId() {
    return this.host.client.user?.id || null;
  }
}
