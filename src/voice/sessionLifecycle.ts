import {
  getVoiceChannelPolicy,
  getVoiceSessionLimits,
  getVoiceSettings
} from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import {
  getRealtimeRuntimeLabel,
  isFinalRealtimeTranscriptEventType,
  isRecoverableRealtimeError,
  isRealtimeMode,
  normalizeInlineText,
  parseRealtimeErrorPayload,
  parseSoundboardDirectiveSequence,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import {
  MAX_INACTIVITY_SECONDS,
  MAX_MAX_SESSION_MINUTES,
  MIN_INACTIVITY_SECONDS,
  MIN_MAX_SESSION_MINUTES,
  OPENAI_REALTIME_MAX_SESSION_MINUTES,
  VOICE_INACTIVITY_WARNING_SECONDS,
  VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS,
  VOICE_MAX_DURATION_WARNING_SECONDS
} from "./voiceSessionManager.constants.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { CaptureManager } from "./captureManager.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { GreetingManager } from "./greetingManager.ts";
import type { InstructionManager } from "./instructionManager.ts";
import type { ReplyManager } from "./replyManager.ts";
import type { ThoughtEngine } from "./thoughtEngine.ts";
import type { VoiceSessionManager } from "./voiceSessionManager.ts";
import { ensureAsrSessionConnected } from "./voiceAsrBridge.ts";
import {
  maybeTriggerAssistantDirectedSoundboard,
  normalizeSoundboardRefs
} from "./voiceSoundboard.ts";
import { refreshRealtimeTools } from "./voiceToolCallInfra.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";
import { musicPhaseShouldAllowDucking, type VoiceSession } from "./voiceSessionTypes.ts";
import { providerSupports } from "./voiceModes.ts";

type SessionLifecycleHost = VoiceToolCallManager & Pick<
  VoiceSessionManager,
  | "buildAsrBridgeDeps"
  | "clearVoiceThoughtLoopTimer"
  | "engageBotSpeechMusicDuck"
  | "estimatePcm16MonoDurationMs"
  | "getMusicPhase"
  | "handleOpenAiRealtimeFunctionCallEvent"
  | "isAsrActive"
  | "isInboundCaptureSuppressed"
  | "musicPlayer"
  | "recordVoiceTurn"
  | "resolveSpeakingEndFinalizeDelayMs"
  | "sessions"
  | "shouldUsePerUserTranscription"
  | "soundboardDirector"
  | "touchActivity"
> & {
  bargeInController: Pick<BargeInController, "isBargeInOutputSuppressed">;
  captureManager: Pick<CaptureManager, "startInboundCapture">;
  instructionManager: Pick<InstructionManager, "scheduleRealtimeInstructionRefresh">;
  deferredActionQueue: Pick<DeferredActionQueue, "clearAllDeferredVoiceActions">;
  greetingManager: Pick<GreetingManager, "armJoinGreetingOpportunity" | "clearJoinGreetingOpportunity">;
  replyManager: Pick<
    ReplyManager,
    | "armResponseSilenceWatchdog"
    | "clearPendingResponse"
    | "clearResponseSilenceTimers"
    | "handleResponseDone"
    | "isRealtimeResponseActive"
    | "markBotTurnOut"
    | "pendingResponseHasAudio"
    | "resetBotAudioPlayback"
    | "syncAssistantOutputState"
  >;
  thoughtEngine: Pick<ThoughtEngine, "scheduleVoiceThoughtLoop">;
};

type SessionLifecycleSettings = VoiceSession["settingsSnapshot"];
type RefreshRealtimeToolsArgs = NonNullable<Parameters<typeof refreshRealtimeTools>[1]>;
type RefreshRealtimeToolsSession = RefreshRealtimeToolsArgs["session"];
type EndSessionArgs = Parameters<SessionLifecycleHost["endSession"]>[0];

export class SessionLifecycle {
  constructor(private readonly host: SessionLifecycleHost) {}

  private logAsyncFailure({
    session,
    content,
    error,
    metadata = {},
    userId = this.host.client.user?.id || null
  }: {
    session: VoiceSession;
    content: string;
    error: unknown;
    metadata?: Record<string, unknown>;
    userId?: string | null;
  }) {
    this.host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: `${content}: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        ...metadata
      }
    });
  }

  private fireAndForgetEndSession(
    session: VoiceSession,
    args: EndSessionArgs,
    source: string
  ) {
    void this.host.endSession(args).catch((error) => {
      this.logAsyncFailure({
        session,
        content: "voice_end_session_dispatch_failed",
        error,
        metadata: {
          source,
          reason: String(args?.reason || "unknown")
        }
      });
    });
  }

  async reconcileSettings(settings: SessionLifecycleSettings) {
    const voiceEnabled = Boolean(getVoiceSettings(settings).enabled);
    const voiceChannelPolicy = getVoiceChannelPolicy(settings);
    const allowlist = new Set(voiceChannelPolicy.allowedChannelIds || []);
    const blocklist = new Set(voiceChannelPolicy.blockedChannelIds || []);

    for (const session of [...this.host.sessions.values()]) {
      session.settingsSnapshot = settings || session.settingsSnapshot;

      if (!voiceEnabled) {
        await this.host.endSession({
          guildId: session.guildId,
          reason: "settings_disabled",
          announcement: "voice mode was disabled, leaving vc.",
          settings
        });
        continue;
      }

      if (blocklist.has(session.voiceChannelId)) {
        await this.host.endSession({
          guildId: session.guildId,
          reason: "settings_channel_blocked",
          announcement: "this vc is now blocked for me, leaving.",
          settings
        });
        continue;
      }

      if (allowlist.size > 0 && !allowlist.has(session.voiceChannelId)) {
        await this.host.endSession({
          guildId: session.guildId,
          reason: "settings_channel_not_allowlisted",
          announcement: "this vc is no longer allowlisted, leaving.",
          settings
        });
        continue;
      }

      this.host.touchActivity(session.guildId, settings);
    }
  }

  startSessionTimers(session: VoiceSession, settings: SessionLifecycleSettings) {
    const voiceSessionLimits = getVoiceSessionLimits(settings);
    const maxSessionMinutesCap = isRealtimeMode(session?.mode)
      ? OPENAI_REALTIME_MAX_SESSION_MINUTES
      : MAX_MAX_SESSION_MINUTES;
    const maxSessionMinutes = clamp(
      Number(voiceSessionLimits.maxSessionMinutes) || 30,
      MIN_MAX_SESSION_MINUTES,
      maxSessionMinutesCap
    );
    const maxDurationMs = maxSessionMinutes * 60_000;

    session.maxEndsAt = Date.now() + maxDurationMs;
    session.maxTimer = setTimeout(() => {
      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "max_duration",
        announcement: `max session time (${maxSessionMinutes}m) reached, leaving vc.`,
        settings
      }, "max_duration_timer");
    }, maxDurationMs);

    this.host.touchActivity(session.guildId, settings);
  }

  async attachSessionRuntime({
    session,
    settings = session?.settingsSnapshot,
    initialSpeakerUserId = null
  }: {
    session: VoiceSession;
    settings?: SessionLifecycleSettings;
    initialSpeakerUserId?: string | null;
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.host.store.getSettings();
    this.bindVoxHandlers(session);
    this.host.musicPlayer?.setVoxClient?.(session.voxClient);
    this.bindSessionHandlers(session, resolvedSettings);
    if (isRealtimeMode(session.mode)) {
      this.bindRealtimeHandlers(session, resolvedSettings);
    }
    if (providerSupports(session.mode || "", "updateTools")) {
      await refreshRealtimeTools(this.host, {
        session: session as RefreshRealtimeToolsSession,
        settings: resolvedSettings,
        reason: "session_start"
      });
    }
    if (providerSupports(session.mode || "", "updateInstructions")) {
      this.host.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings: resolvedSettings,
        reason: "session_start"
      });
    }
    this.startSessionTimers(session, resolvedSettings);

    if (
      session.perUserAsrEnabled &&
      this.host.shouldUsePerUserTranscription({ session, settings: resolvedSettings }) &&
      initialSpeakerUserId
    ) {
      void ensureAsrSessionConnected(
        "per_user",
        this.host.buildAsrBridgeDeps(session),
        resolvedSettings,
        initialSpeakerUserId
      ).catch((error) => {
        this.logAsyncFailure({
          session,
          content: "voice_asr_session_connect_failed",
          error,
          metadata: {
            source: "session_start",
            speakerUserId: initialSpeakerUserId
          },
          userId: initialSpeakerUserId
        });
      });
    }
  }

  clearSessionRuntimeTimers(session: VoiceSession | null | undefined) {
    if (!session) return;
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
    if (session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }

    for (const capture of session.userCaptures?.values?.() || []) {
      if (capture.idleFlushTimer) {
        clearTimeout(capture.idleFlushTimer);
      }
      if (capture.maxFlushTimer) {
        clearTimeout(capture.maxFlushTimer);
      }
      if (capture.speakingEndFinalizeTimer) {
        clearTimeout(capture.speakingEndFinalizeTimer);
      }
    }
  }

  clearSessionRuntimeState(session: VoiceSession | null | undefined) {
    if (!session) return;
    this.host.greetingManager.clearJoinGreetingOpportunity(session);
    this.host.clearVoiceThoughtLoopTimer(session);
    session.thoughtLoopBusy = false;
    session.pendingResponse = null;
    session.sttTurnDrainActive = false;
    session.pendingSttTurnsQueue = [];
    session.pendingSttTurns = 0;
    session.pendingRealtimeTurns = [];
    this.host.deferredActionQueue.clearAllDeferredVoiceActions(session);
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
    session.botTurnOpenAt = 0;
    this.host.replyManager.resetBotAudioPlayback(session);
    session.userCaptures?.clear?.();
  }

  runSessionCleanupHandlers(session: VoiceSession | null | undefined) {
    if (!session) return;
    for (const cleanup of session.cleanupHandlers || []) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    session.cleanupHandlers = [];
  }

  touchActivity(guildId: string, settings?: SessionLifecycleSettings) {
    const session = this.host.sessions.get(String(guildId));
    if (!session) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.host.store.getSettings();
    const voiceSessionLimits = getVoiceSessionLimits(resolvedSettings);

    const inactivitySeconds = clamp(
      Number(voiceSessionLimits.inactivityLeaveSeconds) || 300,
      MIN_INACTIVITY_SECONDS,
      MAX_INACTIVITY_SECONDS
    );

    session.lastActivityAt = Date.now();
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);

    session.inactivityEndsAt = Date.now() + inactivitySeconds * 1000;
    session.inactivityTimer = setTimeout(() => {
      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "inactivity_timeout",
        announcement: `no one talked for ${inactivitySeconds}s, leaving vc.`,
        settings: resolvedSettings
      }, "inactivity_timer");
    }, inactivitySeconds * 1000);

    this.host.thoughtEngine.scheduleVoiceThoughtLoop({
      session,
      settings: resolvedSettings
    });
  }

  buildVoiceSessionTimingContext(session: VoiceSession | null | undefined) {
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

  bindVoxHandlers(session: VoiceSession) {
    if (!session?.voxClient) return;

    const onPlayerState = (status) => {
      session.playerState = status;
      if (status === "playing") {
        session.lastActivityAt = Date.now();
      }
      this.host.replyManager.syncAssistantOutputState(session, "vox_player_state");
    };

    const onError = (message) => {
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
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
      this.host.replyManager.syncAssistantOutputState(session, "vox_playback_armed");
      if (reason !== "connection_ready") return;
      this.host.greetingManager.armJoinGreetingOpportunity(session, {
        trigger: "connection_ready"
      });
    };

    const onMusicIdle = () => {
      this.host.setMusicPhase(session, "idle");
      const music = this.host.ensureSessionMusicState(session);
      if (music) {
        music.stoppedAt = Date.now();
        music.ducked = false;
      }
      this.host.musicPlayer?.clearCurrentTrack?.();
      this.host.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings: session.settingsSnapshot || this.host.store.getSettings(),
        reason: "music_idle"
      });
      this.host.replyManager.syncAssistantOutputState(session, "music_idle");
    };

    const onMusicError = () => {
      this.host.setMusicPhase(session, "idle");
      const music = this.host.ensureSessionMusicState(session);
      if (music) {
        music.stoppedAt = Date.now();
        music.ducked = false;
      }
      this.host.musicPlayer?.clearCurrentTrack?.();
      this.host.replyManager.syncAssistantOutputState(session, "music_error");
    };

    const onBufferDepth = (_ttsSamples) => {
      this.host.replyManager.syncAssistantOutputState(session, "vox_buffer_depth");
    };

    const onTtsPlaybackState = (_status) => {
      this.host.replyManager.syncAssistantOutputState(session, "vox_tts_playback_state");
    };

    session.voxClient.on("playerState", onPlayerState);
    session.voxClient.on("playbackArmed", onPlaybackArmed);
    session.voxClient.on("bufferDepth", onBufferDepth);
    session.voxClient.on("ttsPlaybackState", onTtsPlaybackState);
    session.voxClient.on("musicIdle", onMusicIdle);
    session.voxClient.on("musicError", onMusicError);
    session.voxClient.on("error", onError);

    const armedReason = session.voxClient.getPlaybackArmedReason?.();
    if (armedReason) {
      onPlaybackArmed(armedReason);
    }
    onTtsPlaybackState(session.voxClient.getTtsPlaybackState?.() || "idle");
    onBufferDepth(session.voxClient.ttsBufferDepthSamples || 0);

    session.cleanupHandlers.push(() => {
      session.voxClient?.off("playerState", onPlayerState);
      session.voxClient?.off("playbackArmed", onPlaybackArmed);
      session.voxClient?.off("bufferDepth", onBufferDepth);
      session.voxClient?.off("ttsPlaybackState", onTtsPlaybackState);
      session.voxClient?.off("musicIdle", onMusicIdle);
      session.voxClient?.off("musicError", onMusicError);
      session.voxClient?.off("error", onError);
    });
  }

  trackOpenAiRealtimeAssistantAudioEvent(session: VoiceSession, event: Record<string, unknown> | null | undefined) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!event || typeof event !== "object") return;
    const eventType = String(event.type || "").trim();
    if (eventType !== "response.output_audio.delta" && eventType !== "response.output_audio.done") return;

    const eventItem =
      event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
    const outputItem =
      event.output_item && typeof event.output_item === "object"
        ? (event.output_item as Record<string, unknown>)
        : null;
    const itemId = normalizeInlineText(event.item_id || eventItem?.id || outputItem?.id, 180);
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

  bindRealtimeHandlers(session: VoiceSession, settings: SessionLifecycleSettings = session.settingsSnapshot) {
    if (!session?.realtimeClient) return;
    ensureSessionToolRuntimeState(this.host, session);
    const runtimeLabel = getRealtimeRuntimeLabel(session.mode);

    const onAudioDelta = (audioBase64) => {
      const b64Str = String(audioBase64 || "");
      if (!b64Str.length) return;
      const padding = b64Str.endsWith("==") ? 2 : b64Str.endsWith("=") ? 1 : 0;
      const pcmByteLength = Math.floor((b64Str.length * 3) / 4) - padding;
      if (pcmByteLength <= 0) return;

      const sampleRate = Number(session.realtimeOutputSampleRateHz) || 24000;

      if (isRealtimeMode(session.mode) && session.lastOpenAiAssistantAudioItemId) {
        session.lastOpenAiAssistantAudioItemReceivedMs = Math.max(
          0,
          Number(session.lastOpenAiAssistantAudioItemReceivedMs || 0)
        ) + this.host.estimatePcm16MonoDurationMs(pcmByteLength, sampleRate);
      }

      if (this.host.bargeInController.isBargeInOutputSuppressed(session)) {
        session.lastAudioDeltaAt = Date.now();
        session.bargeInSuppressedAudioChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0)) + 1;
        session.bargeInSuppressedAudioBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0)) + pcmByteLength;
        const pending = session.pendingResponse;
        if (pending && typeof pending === "object") {
          pending.audioReceivedAt = Number(session.lastAudioDeltaAt || Date.now());
        }
        this.host.replyManager.syncAssistantOutputState(session, "audio_delta_suppressed");
        return;
      }

      session.lastAudioDeltaAt = Date.now();

      if (musicPhaseShouldAllowDucking(this.host.getMusicPhase(session))) {
        this.host.engageBotSpeechMusicDuck(
          session,
          session.settingsSnapshot || this.host.store.getSettings()
        ).catch((error) => {
          this.logAsyncFailure({
            session,
            content: "voice_music_duck_failed",
            error,
            metadata: {
              source: "audio_delta"
            }
          });
        });
      }

      if (!session.voxClient?.isAlive) return;
      try {
        session.voxClient.sendAudio(b64Str, sampleRate);
      } catch {
        return;
      }

      this.host.replyManager.markBotTurnOut(session, settings);
      this.host.replyManager.syncAssistantOutputState(session, "audio_delta");
      if (isRealtimeMode(session.mode)) {
        session.pendingRealtimeInputBytes = 0;
      }

      if (this.host.replyManager.pendingResponseHasAudio(session)) {
        const pending = session.pendingResponse;
        if (pending) {
          pending.audioReceivedAt = session.lastAudioDeltaAt;
        }
        this.host.replyManager.clearResponseSilenceTimers(session);
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
      const requestedSoundboardRefs = normalizeSoundboardRefs(parsedDirective?.references || []);
      if (finalTranscriptEvent) {
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
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
      const resolvedSettings = settings || session.settingsSnapshot || this.host.store.getSettings();
      if (
        transcriptSource === "output" &&
        transcriptForLogs &&
        finalTranscriptEvent
      ) {
        this.host.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.host.client.user?.id || null,
          text: transcriptForLogs
        });
      }

      if (transcriptSource === "output" && requestedSoundboardRefs.length > 0 && finalTranscriptEvent) {
        (async () => {
          let directiveIndex = 0;
          for (const requestedRef of requestedSoundboardRefs) {
            directiveIndex += 1;
            await maybeTriggerAssistantDirectedSoundboard(this.host, {
              session,
              settings: resolvedSettings,
              userId: this.host.client.user?.id || null,
              transcript: transcriptForLogs || transcript,
              requestedRef,
              source: `realtime_output_transcript_${directiveIndex}`
            });
          }
        })().catch((error) => {
          this.logAsyncFailure({
            session,
            content: "voice_soundboard_directive_failed",
            error,
            metadata: {
              transcriptEventType: transcriptEventType || null,
              requestedSoundboardRefs
            }
          });
        });
      }
    };

    const onErrorEvent = (errorPayload) => {
      if (session.ending) return;
      const details = parseRealtimeErrorPayload(errorPayload);
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
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
        const hasActiveResponse = this.host.replyManager.isRealtimeResponseActive(session);
        session.pendingRealtimeInputBytes = 0;
        const pending = session.pendingResponse;
        if (
          normalizedCode === "input_audio_buffer_commit_empty" &&
          pending &&
          !hasActiveResponse &&
          !this.host.replyManager.pendingResponseHasAudio(session, pending)
        ) {
          this.host.replyManager.clearPendingResponse(session);
        } else if (isActiveResponseCollision && pending) {
          pending.handlingSilence = false;
          this.host.replyManager.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId
          });
        }
        return;
      }

      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "realtime_runtime_error",
        announcement: "voice runtime hit an error, leaving vc.",
        settings
      }, "realtime_error_event");
    };

    const onSocketClosed = (closeInfo) => {
      if (session.ending) return;
      const code = Number(closeInfo?.code || 0) || null;
      const reason = String(closeInfo?.reason || "").trim() || null;
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
        content: `${runtimeLabel}_socket_closed`,
        metadata: {
          sessionId: session.id,
          code,
          reason
        }
      });

      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "realtime_socket_closed",
        announcement: "lost realtime voice runtime, leaving vc.",
        settings
      }, "realtime_socket_closed");
    };

    const onSocketError = (socketError) => {
      if (session.ending) return;
      const message = String(socketError?.message || "unknown socket error");
      this.host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
        content: `${runtimeLabel}_socket_error: ${message}`,
        metadata: {
          sessionId: session.id
        }
      });
    };

    const onResponseDone = (event) => {
      this.host.replyManager.handleResponseDone({
        session,
        event,
        settings,
        runtimeLabel
      });
    };

    const onEvent = (event) => {
      if (!session || session.ending) return;
      if (!event || typeof event !== "object") return;
      if (!isRealtimeMode(session.mode)) return;
      this.trackOpenAiRealtimeAssistantAudioEvent(session, event);
      this.host.handleOpenAiRealtimeFunctionCallEvent({
        session,
        settings,
        event
      }).catch((error) => {
        this.host.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
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

  bindSessionHandlers(session: VoiceSession, settings: SessionLifecycleSettings) {
    const onConnectionState = (status) => {
      if (session.ending) return;
      if (status === "destroyed" || status === "disconnected") {
        this.fireAndForgetEndSession(session, {
          guildId: session.guildId,
          reason: "connection_lost",
          announcement: "voice connection dropped, i'm out.",
          settings
        }, "voice_connection_state");
      }
    };

    const onCrashed = ({ code, signal }) => {
      if (session.ending) return;
      console.error(
        `[voiceSessionManager] subprocess crashed code=${code} signal=${signal} guild=${session.guildId}`
      );
      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "subprocess_crashed",
        announcement: "voice subprocess crashed, i'm out.",
        settings
      }, "vox_subprocess_crashed");
    };

    if (session.voxClient) {
      session.voxClient.on("connectionState", onConnectionState);
      session.voxClient.on("crashed", onCrashed);
      session.cleanupHandlers.push(() => {
        session.voxClient?.off("connectionState", onConnectionState);
        session.voxClient?.off("crashed", onCrashed);
      });
    }

    const onSpeakingStart = (userId) => {
      if (String(userId || "") === String(this.host.client.user?.id || "")) return;
      if (this.host.isInboundCaptureSuppressed(session)) {
        const now = Date.now();
        if (now - Number(session.lastSuppressedCaptureLogAt || 0) >= VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS) {
          session.lastSuppressedCaptureLogAt = now;
          this.host.store.logAction({
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
      if (!this.host.isAsrActive(session, settings)) return;
      const normalizedUserId = String(userId || "");
      const activeCapture = session.userCaptures.get(normalizedUserId);
      if (activeCapture?.speakingEndFinalizeTimer) {
        clearTimeout(activeCapture.speakingEndFinalizeTimer);
        activeCapture.speakingEndFinalizeTimer = null;
      }
      this.host.captureManager.startInboundCapture({
        session,
        userId: normalizedUserId,
        settings
      });
    };

    const onSpeakingEnd = (userId) => {
      if (String(userId || "") === String(this.host.client.user?.id || "")) return;
      const capture = session.userCaptures.get(String(userId || ""));
      if (!capture || typeof capture.finalize !== "function") return;
      if (capture.speakingEndFinalizeTimer) return;
      const captureAgeMs = Math.max(0, Date.now() - Number(capture.startedAt || Date.now()));
      const finalizeDelayMs = this.host.resolveSpeakingEndFinalizeDelayMs({
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
      if (normalizedUserId === String(this.host.client.user?.id || "")) return;
      const capture = session.userCaptures?.get?.(normalizedUserId);
      if (!capture) return;
      if (capture.speakingEndFinalizeTimer) {
        clearTimeout(capture.speakingEndFinalizeTimer);
        capture.speakingEndFinalizeTimer = null;
      }
      if (typeof capture.finalize === "function") {
        capture.finalize("client_disconnect");
      }
    };

    if (session.voxClient) {
      session.voxClient.on("speakingStart", onSpeakingStart);
      session.voxClient.on("speakingEnd", onSpeakingEnd);
      session.voxClient.on("clientDisconnect", onClientDisconnect);
      session.cleanupHandlers.push(() => {
        session.voxClient?.off("speakingStart", onSpeakingStart);
        session.voxClient?.off("speakingEnd", onSpeakingEnd);
        session.voxClient?.off("clientDisconnect", onClientDisconnect);
      });
    }
  }
}
