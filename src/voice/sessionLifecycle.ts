import {
  getVoiceChannelPolicy,
  getVoiceSessionLimits,
  getVoiceSettings
} from "../settings/agentStack.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import { clamp } from "../utils.ts";
import {
  getRealtimeRuntimeLabel,
  isFinalRealtimeTranscriptEventType,
  isRecoverableRealtimeError,
  isRealtimeMode,
  normalizeInlineText,
  normalizeVoiceAddressingTargetToken,
  parseRealtimeErrorPayload,
  parseSoundboardDirectiveSequence,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import {
  INTERRUPTED_REALTIME_OUTPUT_IGNORE_TTL_MS,
  MAX_INACTIVITY_SECONDS,
  MAX_MAX_SESSION_MINUTES,
  MIN_INACTIVITY_SECONDS,
  MIN_MAX_SESSION_MINUTES,
  OPENAI_REALTIME_MAX_SESSION_MINUTES,
  VOICE_INACTIVITY_WARNING_SECONDS,
  VOICE_MAX_DURATION_WARNING_SECONDS
} from "./voiceSessionManager.constants.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { CaptureManager } from "./captureManager.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { InstructionManager } from "./instructionManager.ts";
import type { ReplyManager } from "./replyManager.ts";
import type { ThoughtEngine } from "./thoughtEngine.ts";
import type { VoiceSessionManager } from "./voiceSessionManager.ts";
import { ensureAsrSessionConnected } from "./voiceAsrBridge.ts";
import {
  applyNativeDiscordVideoState,
  ensureNativeDiscordScreenShareState,
  listActiveNativeDiscordScreenSharers,
  recordNativeDiscordVideoFrame,
  removeNativeDiscordVideoSharer
} from "./nativeDiscordScreenShare.ts";
import {
  decodeNativeDiscordVideoFrameToStillImage,
  hasNativeDiscordVideoDecoderSupport
} from "./nativeDiscordVideoDecoder.ts";
import { ensureStreamPublishState } from "./voiceStreamPublish.ts";
import {
  maybeTriggerAssistantDirectedSoundboard,
  normalizeSoundboardRefs
} from "./voiceSoundboard.ts";
import {
  setKnownMusicQueuePausedState
} from "./musicResumeState.ts";
import { touchMusicWakeLatch } from "./musicWakeLatch.ts";
import {
  resolveRealtimeToolOwnership,
  shouldHandleRealtimeFunctionCalls as shouldHandleRealtimeFunctionCallsModule,
  shouldRegisterRealtimeTools as shouldRegisterRealtimeToolsModule
} from "./voiceConfigResolver.ts";
import { refreshRealtimeTools } from "./voiceToolCallInfra.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";
import { musicPhaseShouldAllowDucking, type VoiceSession } from "./voiceSessionTypes.ts";
import { providerSupports } from "./voiceModes.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";

type SessionLifecycleHost = VoiceToolCallManager & Pick<
  VoiceSessionManager,
  | "annotateLatestVoiceTurnAddressing"
  | "buildAsrBridgeDeps"
  | "clearVoiceThoughtLoopTimer"
  | "engageBotSpeechMusicDuck"
  | "estimatePcm16MonoDurationMs"
  | "drainPendingRealtimeAssistantUtterances"
  | "getOutputChannelState"
  | "getMusicPhase"
  | "getVoiceChannelParticipants"
  | "handleRealtimeFunctionCallEvent"
  | "isAsrActive"
  | "musicPlayer"
  | "normalizeVoiceAddressingAnnotation"
  | "recordVoiceTurn"
  | "resolveReplyInterruptionPolicy"
  | "resolveVoiceSpeakerName"
  | "resolveSpeakingEndFinalizeDelayMs"
  | "sessions"
  | "startMusicStreamPublish"
  | "stopBrowserSessionStreamPublish"
  | "pauseMusicStreamPublish"
  | "stopMusicStreamPublish"
  | "setActiveReplyInterruptionPolicy"
  | "startVoiceScreenWatch"
  | "stopWatchStreamForUser"
  | "shouldUsePerUserTranscription"
  | "soundboardDirector"
  | "touchActivity"
  | "ingestStreamFrame"
> & {
  bargeInController: Pick<BargeInController, "isBargeInOutputSuppressed">;
  captureManager: Pick<CaptureManager, "startInboundCapture">;
  instructionManager: Pick<InstructionManager, "scheduleRealtimeInstructionRefresh">;
  deferredActionQueue: Pick<DeferredActionQueue, "clearAllDeferredVoiceActions">;
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
const OPENAI_REALTIME_ASSISTANT_OUTPUT_STATE_TTL_MS = 10 * 60 * 1000;
const OPENAI_REALTIME_REPLY_ADDRESSING_ELIGIBLE_SOURCES = new Set([
  "turn_flush",
  "openai_realtime_text_turn",
  "tool_call_followup",
  "silent_retry",
  "hard_recovery"
]);
const OPENAI_REALTIME_ASSISTANT_OUTPUT_EVENT_TYPES = new Set([
  "response.output_audio.delta",
  "response.output_audio.done",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.output_text.delta",
  "response.output_text.done"
]);

function parseRealtimeResponseId(session: VoiceSession, event: Record<string, unknown> | null | undefined) {
  if (!event || typeof event !== "object") return null;
  const response =
    event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : null;
  const eventItem =
    event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
  const outputItem =
    event.output_item && typeof event.output_item === "object"
      ? (event.output_item as Record<string, unknown>)
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

function shouldRequestOpenAiRealtimeReplyAddressing(session: VoiceSession) {
  if (!session || session.ending) return false;
  if (String(session.mode || "").trim().toLowerCase() !== "openai_realtime") return false;
  const pending = session.pendingResponse && typeof session.pendingResponse === "object"
    ? session.pendingResponse
    : null;
  if (!pending) return false;
  const normalizedSource = String(pending.source || "").trim().toLowerCase();
  if (!OPENAI_REALTIME_REPLY_ADDRESSING_ELIGIBLE_SOURCES.has(normalizedSource)) return false;
  return true;
}

function parseReplyAddressingClassifierToken(value: unknown) {
  const firstLine = String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (!firstLine) return null;
  const stripped = firstLine
    .replace(/^`+|`+$/g, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/[.!,;:]+$/g, "")
    .trim();
  if (!stripped) return null;
  const normalizedUpper = stripped.toUpperCase();
  if (
    normalizedUpper === "UNKNOWN" ||
    normalizedUpper === "NONE" ||
    normalizedUpper === "NULL" ||
    normalizedUpper === "UNTARGETED"
  ) {
    return null;
  }
  return stripped.slice(0, 80);
}

function buildAssistantReplyTargetReason(talkingTo: string | null) {
  if (!talkingTo) return "assistant_target_missing";
  return talkingTo === "ALL" ? "assistant_target_all" : "assistant_target_speaker";
}

function pruneIgnoredRealtimeAssistantOutputItems(session: VoiceSession, now = Date.now()) {
  const ignoredItems = session.ignoredRealtimeAssistantOutputItemIds;
  if (!(ignoredItems instanceof Map) || ignoredItems.size === 0) {
    return null;
  }

  for (const [itemId, ignoredAt] of ignoredItems.entries()) {
    if (
      !itemId ||
      now - Math.max(0, Number(ignoredAt || 0)) > INTERRUPTED_REALTIME_OUTPUT_IGNORE_TTL_MS
    ) {
      ignoredItems.delete(itemId);
    }
  }

  return ignoredItems.size > 0 ? ignoredItems : null;
}

function shouldIgnoreRealtimeAssistantOutputItem(
  session: VoiceSession,
  itemId: unknown,
  now = Date.now()
) {
  const normalizedItemId = normalizeInlineText(itemId, 180);
  if (!normalizedItemId) return false;
  const ignoredItems = pruneIgnoredRealtimeAssistantOutputItems(session, now);
  return Boolean(ignoredItems?.has(normalizedItemId));
}

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

      await this.refreshSessionRuntimeForSettings(session, settings);
    }
  }

  private async refreshSessionRuntimeForSettings(session: VoiceSession, settings: SessionLifecycleSettings) {
    if (!session || session.ending) return;

    session.realtimeToolOwnership = resolveRealtimeToolOwnership({
      settings,
      mode: session.mode
    });

    this.clearSessionRuntimeTimers(session);
    this.startSessionTimers(session, settings);

    const refreshedRealtimeTools =
      Boolean(session.realtimeClient) &&
      (shouldRegisterRealtimeToolsModule({ session, settings }) ||
        (Array.isArray(session.realtimeToolDefinitions) && session.realtimeToolDefinitions.length > 0) ||
        Boolean(String(session.lastRealtimeToolHash || "")));
    if (refreshedRealtimeTools) {
      await refreshRealtimeTools(this.host, {
        session: session as RefreshRealtimeToolsSession,
        settings,
        reason: "settings_reconcile"
      });
    }

    const scheduledInstructionRefresh = providerSupports(session.mode || "", "updateInstructions");
    if (scheduledInstructionRefresh) {
      this.host.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings,
        reason: "settings_reconcile"
      });
    }

    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.host.client.user?.id || null,
      content: "voice_session_settings_reconciled",
      metadata: {
        sessionId: session.id,
        refreshedRealtimeTools,
        scheduledInstructionRefresh,
        maxSessionMinutes: Number(getVoiceSessionLimits(settings).maxSessionMinutes) || null
      }
    });
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
    if (shouldRegisterRealtimeToolsModule({ session, settings: resolvedSettings })) {
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
    if (session.realtimeToolResponseDebounceTimer) clearTimeout(session.realtimeToolResponseDebounceTimer);
    if (session.realtimeTurnCoalesceTimer) {
      clearTimeout(session.realtimeTurnCoalesceTimer);
      session.realtimeTurnCoalesceTimer = null;
    }
    for (const pendingInterrupt of session.pendingSpeechStartedInterrupts?.values?.() || []) {
      if (pendingInterrupt?.timer) {
        clearTimeout(pendingInterrupt.timer);
      }
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
    this.host.clearVoiceThoughtLoopTimer(session);
    session.thoughtLoopBusy = false;
    session.pendingAmbientThought = null;
    session.pendingResponse = null;
    session.fileAsrTurnDrainActive = false;
    session.pendingFileAsrTurnsQueue = [];
    session.pendingFileAsrTurns = 0;
    session.pendingRealtimeTurns = [];
    session.activeRealtimeTurn = null;
    session.pendingRealtimeAssistantUtterances = [];
    session.realtimeAssistantUtteranceBackpressureActive = false;
    session.pendingSpeechStartedInterrupts?.clear?.();
    this.host.deferredActionQueue.clearAllDeferredVoiceActions(session);
    if (session.realtimeToolOwnership === "provider_native") {
      session.awaitingToolOutputs = false;
      session.realtimePendingToolCalls = new Map();
      session.realtimeToolCallExecutions = new Map();
    }
    session.realtimeTurnContextRefreshState = null;
    session.lastRequestedRealtimeUtterance = null;
    session.interruptedAssistantReply = null;
    session.activeReplyInterruptionPolicy = null;
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
      if (this.host.isMusicPlaybackActive(session)) {
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: null,
          content: "voice_inactivity_deferred_media_active",
          metadata: {
            sessionId: session.id,
            musicPhase: this.host.getMusicPhase(session),
            inactivitySeconds
          }
        });
        this.touchActivity(String(session.guildId), resolvedSettings);
        return;
      }
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
      const previousMusicPhase = this.host.getMusicPhase(session);
      session.playerState = status;
      if (status === "playing") {
        session.lastActivityAt = Date.now();
        this.touchActivity(String(session.guildId));
        if (previousMusicPhase === "paused" || previousMusicPhase === "paused_wake_word") {
          this.host.setMusicPhase(session, "playing");
          setKnownMusicQueuePausedState(session, false);
          const music = this.host.ensureSessionMusicState(session);
          const resumeReason = String(music?.lastCommandReason || "").trim() || null;
          if (resumeReason === "music_resumed_after_wake_word") {
            const settings = session.settingsSnapshot || this.host.store.getSettings();
            touchMusicWakeLatch(session, settings, null);
          }
          if (resumeReason && resumeReason !== "media_resumed_reply_handoff_duck") {
            this.host.haltSessionOutputForMusicPlayback(
              session,
              resumeReason === "voice_tool_media_resume" ? "music_resumed" : resumeReason
            );
          }
        }
        const intent = session.streamPublishIntent;
        if (intent) {
          session.streamPublishIntent = null;
          void Promise.resolve(
            this.host.startMusicStreamPublish({
              guildId: session.guildId,
              source: "music_player_state_playing",
              forceMode: "video"
            })
          ).catch((error) => {
            this.logAsyncFailure({
              session,
              content: "music_stream_publish_start_failed",
              error,
              metadata: {
                status
              }
            });
          });
        }
      } else if (status === "paused") {
        void Promise.resolve(
          this.host.pauseMusicStreamPublish({
            guildId: session.guildId,
            reason: "music_player_state_paused"
          })
        ).catch((error) => {
          this.logAsyncFailure({
            session,
            content: "music_stream_publish_pause_failed",
            error,
            metadata: {
              status
            }
          });
        });
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
    };

    const onMusicIdle = () => {
      session.streamPublishIntent = null;
      this.host.setMusicPhase(session, "idle");
      setKnownMusicQueuePausedState(session, false);
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
      void Promise.resolve(
        this.host.stopMusicStreamPublish({
          guildId: session.guildId,
          reason: "music_idle"
        })
      ).catch((error) => {
        this.logAsyncFailure({
          session,
          content: "music_stream_publish_stop_failed",
          error,
          metadata: {
            source: "music_idle"
          }
        });
      });
      this.host.replyManager.syncAssistantOutputState(session, "music_idle");
    };

    const onMusicError = () => {
      session.streamPublishIntent = null;
      this.host.setMusicPhase(session, "idle");
      setKnownMusicQueuePausedState(session, false);
      const music = this.host.ensureSessionMusicState(session);
      if (music) {
        music.stoppedAt = Date.now();
        music.ducked = false;
      }
      this.host.musicPlayer?.clearCurrentTrack?.();
      void Promise.resolve(
        this.host.stopMusicStreamPublish({
          guildId: session.guildId,
          reason: "music_error"
        })
      ).catch((error) => {
        this.logAsyncFailure({
          session,
          content: "music_stream_publish_stop_failed",
          error,
          metadata: {
            source: "music_error"
          }
        });
      });
      this.host.replyManager.syncAssistantOutputState(session, "music_error");
    };

    const onBufferDepth = (_ttsSamples) => {
      this.host.replyManager.syncAssistantOutputState(session, "vox_buffer_depth");
      this.host.drainPendingRealtimeAssistantUtterances(session, "vox_buffer_depth");
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

  trackRealtimeAssistantAudioEvent(session: VoiceSession, event: Record<string, unknown> | null | undefined) {
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
    const previousItemId = String(session.lastRealtimeAssistantAudioItemId || "");
    const previousContentIndex = Math.max(0, Number(session.lastRealtimeAssistantAudioItemContentIndex || 0));
    if (itemId !== previousItemId || contentIndex !== previousContentIndex) {
      session.lastRealtimeAssistantAudioItemReceivedMs = 0;
    }
    session.lastRealtimeAssistantAudioItemId = itemId;
    session.lastRealtimeAssistantAudioItemContentIndex = contentIndex;
  }

  trackRealtimeResponseOutputEvent(
    session: VoiceSession,
    event: Record<string, unknown> | null | undefined,
    settings: SessionLifecycleSettings = session.settingsSnapshot
  ) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!shouldHandleRealtimeFunctionCallsModule({ session, settings })) return;
    if (!event || typeof event !== "object") return;

    const eventType = String(event.type || "").trim();
    let producedAssistantOutput = OPENAI_REALTIME_ASSISTANT_OUTPUT_EVENT_TYPES.has(eventType);
    if (!producedAssistantOutput && (eventType === "response.output_item.added" || eventType === "response.output_item.done")) {
      const eventItem =
        event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      const outputItem =
        event.output_item && typeof event.output_item === "object"
          ? (event.output_item as Record<string, unknown>)
          : null;
      const item = eventItem || outputItem;
      producedAssistantOutput = String(item?.type || "").trim().toLowerCase() === "message";
    }
    if (!producedAssistantOutput) return;

    const responseId = parseRealtimeResponseId(session, event);
    if (!responseId) return;
    const responseOutputState = session.realtimeResponsesWithAssistantOutput instanceof Map
      ? session.realtimeResponsesWithAssistantOutput
      : new Map<string, number>();
    session.realtimeResponsesWithAssistantOutput = responseOutputState;
    const now = Date.now();
    responseOutputState.set(responseId, now);
    for (const [trackedResponseId, trackedAt] of responseOutputState.entries()) {
      if (now - Number(trackedAt || 0) > OPENAI_REALTIME_ASSISTANT_OUTPUT_STATE_TTL_MS) {
        responseOutputState.delete(trackedResponseId);
      }
    }
  }

  bindRealtimeHandlers(session: VoiceSession, settings: SessionLifecycleSettings = session.settingsSnapshot) {
    if (!session?.realtimeClient) return;
    const runtimeLabel = getRealtimeRuntimeLabel(session.mode);

    const onAudioDelta = (audioBase64) => {
      const b64Str = String(audioBase64 || "");
      if (!b64Str.length) return;
      const padding = b64Str.endsWith("==") ? 2 : b64Str.endsWith("=") ? 1 : 0;
      const pcmByteLength = Math.floor((b64Str.length * 3) / 4) - padding;
      if (pcmByteLength <= 0) return;
      const now = Date.now();
      if (
        isRealtimeMode(session.mode) &&
        shouldIgnoreRealtimeAssistantOutputItem(session, session.lastRealtimeAssistantAudioItemId, now)
      ) {
        return;
      }

      const sampleRate = Number(session.realtimeOutputSampleRateHz) || 24000;

      if (isRealtimeMode(session.mode) && session.lastRealtimeAssistantAudioItemId) {
        session.lastRealtimeAssistantAudioItemReceivedMs = Math.max(
          0,
          Number(session.lastRealtimeAssistantAudioItemReceivedMs || 0)
        ) + this.host.estimatePcm16MonoDurationMs(pcmByteLength, sampleRate);
      }

      if (this.host.bargeInController.isBargeInOutputSuppressed(session)) {
        session.lastAudioDeltaAt = now;
        session.bargeInSuppressedAudioChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0)) + 1;
        session.bargeInSuppressedAudioBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0)) + pcmByteLength;
        const pending = session.pendingResponse;
        if (pending && typeof pending === "object") {
          pending.audioReceivedAt = Number(session.lastAudioDeltaAt || now);
          pending.audioSuppressedBytes = Math.max(0, Number(pending.audioSuppressedBytes || 0)) + pcmByteLength;
          pending.audioSuppressedChunks = Math.max(0, Number(pending.audioSuppressedChunks || 0)) + 1;
        }
        this.host.replyManager.syncAssistantOutputState(session, "audio_delta_suppressed");
        return;
      }

      session.lastAudioDeltaAt = now;

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

      // Track per-utterance audio delivery telemetry
      const pending = session.pendingResponse;
      if (pending && typeof pending === "object") {
        pending.audioDeliveredBytes = Math.max(0, Number(pending.audioDeliveredBytes || 0)) + pcmByteLength;
        pending.audioDeliveredChunks = Math.max(0, Number(pending.audioDeliveredChunks || 0)) + 1;
        if (!pending.firstAudioAt) {
          pending.firstAudioAt = now;
        }
      }

      this.host.replyManager.markBotTurnOut(session, settings);
      this.host.replyManager.syncAssistantOutputState(session, "audio_delta");
      if (isRealtimeMode(session.mode)) {
        session.pendingRealtimeInputBytes = 0;
      }

      if (this.host.replyManager.pendingResponseHasAudio(session)) {
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
      const transcriptItemId =
        payload && typeof payload === "object" ? normalizeInlineText(payload.itemId, 180) : null;
      if (
        transcriptSource === "output" &&
        transcriptItemId &&
        shouldIgnoreRealtimeAssistantOutputItem(session, transcriptItemId)
      ) {
        return;
      }
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

      if (
        transcriptSource === "output" &&
        transcriptForLogs &&
        finalTranscriptEvent &&
        transcriptEventType === "response.output_audio_transcript.done" &&
        shouldRequestOpenAiRealtimeReplyAddressing(session) &&
        session.realtimeClient instanceof OpenAiRealtimeClient
      ) {
        const pending = session.pendingResponse && typeof session.pendingResponse === "object"
          ? session.pendingResponse
          : null;
        const speakerUserId = String(pending?.userId || "").trim() || null;
        const currentSpeakerName = speakerUserId
          ? this.host.resolveVoiceSpeakerName(session, speakerUserId) || ""
          : "";
        const participants = this.host.getVoiceChannelParticipants(session)
          .map((participant) => String(participant?.displayName || "").trim())
          .filter(Boolean);
        const requested = session.realtimeClient.requestReplyAddressingClassification({
          assistantText: transcriptForLogs,
          currentSpeakerName,
          speakerUserId,
          requestId: pending?.requestId || null,
          responseSource: pending?.source || null,
          participants,
          botName: getPromptBotName(resolvedSettings)
        });
        if (requested) {
          this.host.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: this.host.client.user?.id || null,
            content: "openai_realtime_reply_addressing_requested",
            metadata: {
              sessionId: session.id,
              requestId: pending?.requestId || null,
              responseSource: pending?.source || null,
              currentSpeakerName: currentSpeakerName || null,
              assistantTextChars: transcriptForLogs.length,
              participantCount: participants.length
            }
          });
        }
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

    // Track whether the ElevenLabs WS closed due to an idle timeout so the
    // socket_closed handler can attempt a reconnect instead of ending the session.
    let elevenLabsIdleTimeoutPending = false;

    const onErrorEvent = (errorPayload) => {
      if (session.ending) return;
      const details = parseRealtimeErrorPayload(errorPayload);
      const normalizedMessage = String(details.message || "").trim().toLowerCase();

      // ElevenLabs input_timeout_exceeded: the TTS WebSocket idled because
      // there was nothing to say.  This is normal during screen watch or
      // any period of active listening.  Mark it so the socket_closed
      // handler can reconnect instead of killing the session.
      if (normalizedMessage.includes("input_timeout_exceeded")) {
        elevenLabsIdleTimeoutPending = true;
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
          content: `${runtimeLabel}_idle_timeout: will reconnect on next utterance`,
          metadata: { sessionId: session.id }
        });
        return;
      }

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

      // If the close was triggered by an ElevenLabs idle timeout, don't
      // kill the session.  The TTS client will reconnect lazily when the
      // bot next needs to speak.
      if (elevenLabsIdleTimeoutPending) {
        elevenLabsIdleTimeoutPending = false;
        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
          content: `${runtimeLabel}_socket_closed_idle_timeout_reconnectable`,
          metadata: { sessionId: session.id, code, reason }
        });
        // Attempt to reconnect the ElevenLabs TTS client in the background.
        // The session stays alive — audio capture, screen watch, etc. continue.
        if (session.realtimeClient && typeof session.realtimeClient.connect === "function") {
          void (async () => {
            try {
              await session.realtimeClient.connect(session.realtimeClient.sessionConfig || {});
              this.host.store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: this.host.client.user?.id || null,
                content: `${runtimeLabel}_idle_timeout_reconnected`,
                metadata: { sessionId: session.id }
              });
            } catch (reconnectError) {
              this.host.store.logAction({
                kind: "voice_error",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: this.host.client.user?.id || null,
                content: `${runtimeLabel}_idle_timeout_reconnect_failed: ${String((reconnectError as Error)?.message || reconnectError)}`,
                metadata: { sessionId: session.id }
              });
              // Reconnect failed — end session as fallback
              this.fireAndForgetEndSession(session, {
                guildId: session.guildId,
                reason: "realtime_reconnect_failed",
                announcement: "lost voice connection, leaving vc.",
                settings
              }, "realtime_reconnect_failed");
            }
          })();
        }
        return;
      }

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

    const onReplyAddressingResult = (payload) => {
      if (!session || session.ending) return;
      if (!payload || typeof payload !== "object") return;
      const assistantText = String(payload.assistantText || "").trim();
      if (!assistantText) return;
      const classifierText = String(payload.classifierText || "").trim();
      const currentSpeakerName = String(payload.currentSpeakerName || "").trim();
      const rawTarget = parseReplyAddressingClassifierToken(classifierText);
      const resolvedTalkingTo =
        String(rawTarget || "").trim().toUpperCase() === "SPEAKER"
          ? currentSpeakerName || "SPEAKER"
          : normalizeVoiceAddressingTargetToken(rawTarget || "") || null;
      const normalizedAddressing = resolvedTalkingTo
        ? this.host.normalizeVoiceAddressingAnnotation({
          rawAddressing: { talkingTo: resolvedTalkingTo },
          source: "openai_realtime_reply_target",
          reason: "assistant_reply_target"
        })
        : null;
      if (normalizedAddressing) {
        this.host.annotateLatestVoiceTurnAddressing({
          session,
          role: "assistant",
          userId: this.host.client.user?.id || null,
          text: assistantText,
          addressing: normalizedAddressing
        });
      }

      const speakerUserId = String(payload.speakerUserId || "").trim() || null;
      const requestId = Number.isFinite(Number(payload.requestId))
        ? Math.max(0, Math.floor(Number(payload.requestId)))
        : null;
      const nextPolicy = this.host.resolveReplyInterruptionPolicy({
        session,
        userId: speakerUserId,
        talkingTo: normalizedAddressing?.talkingTo || null,
        source: "assistant_reply_target",
        reason: buildAssistantReplyTargetReason(normalizedAddressing?.talkingTo || null)
      });
      const currentPending = session.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
      const currentOutputState = this.host.getOutputChannelState(session);
      const requestStillCurrent =
        requestId != null &&
        currentPending &&
        Number(currentPending.requestId || 0) === requestId;
      if (requestStillCurrent) {
        currentPending.interruptionPolicy = nextPolicy;
        this.host.setActiveReplyInterruptionPolicy(session, nextPolicy);
      } else if (!currentPending && currentOutputState.locked) {
        this.host.setActiveReplyInterruptionPolicy(session, nextPolicy);
      }

      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
        content: "openai_realtime_reply_addressing_resolved",
        metadata: {
          sessionId: session.id,
          requestId,
          responseSource: String(payload.responseSource || "").trim() || null,
          classifierText: classifierText || null,
          talkingTo: normalizedAddressing?.talkingTo || null,
          policyScope: nextPolicy?.scope || null,
          policyAllowedUserId: nextPolicy?.allowedUserId || null
        }
      });
    };

    const onEvent = (event) => {
      if (!session || session.ending) return;
      if (!event || typeof event !== "object") return;
      if (!isRealtimeMode(session.mode)) return;
      this.trackRealtimeResponseOutputEvent(session, event, settings);
      this.trackRealtimeAssistantAudioEvent(session, event);
      if (shouldHandleRealtimeFunctionCallsModule({ session, settings })) {
        this.host.handleRealtimeFunctionCallEvent({
          session,
          settings,
          event
        }).catch((error) => {
          this.host.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: this.host.client.user?.id || null,
            content: `realtime_tool_event_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        });
      }
    };

    session.realtimeClient.on("audio_delta", onAudioDelta);
    session.realtimeClient.on("transcript", onTranscript);
    session.realtimeClient.on("error_event", onErrorEvent);
    session.realtimeClient.on("socket_closed", onSocketClosed);
    session.realtimeClient.on("socket_error", onSocketError);
    session.realtimeClient.on("response_done", onResponseDone);
    session.realtimeClient.on("reply_addressing_result", onReplyAddressingResult);
    session.realtimeClient.on("event", onEvent);

    session.cleanupHandlers.push(() => {
      session.realtimeClient.off("audio_delta", onAudioDelta);
      session.realtimeClient.off("transcript", onTranscript);
      session.realtimeClient.off("error_event", onErrorEvent);
      session.realtimeClient.off("socket_closed", onSocketClosed);
      session.realtimeClient.off("socket_error", onSocketError);
      session.realtimeClient.off("response_done", onResponseDone);
      session.realtimeClient.off("reply_addressing_result", onReplyAddressingResult);
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
      this.host.store.logAction({kind: "voice_error", content: "clankvox_subprocess_crashed", metadata: { code, signal, guildId: session.guildId, sessionId: session.id }});
      this.fireAndForgetEndSession(session, {
        guildId: session.guildId,
        reason: "subprocess_crashed",
        announcement: "voice subprocess crashed, i'm out.",
        settings
      }, "vox_subprocess_crashed");
    };

    const onTransportState = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const transportRole = String(payload.role || "").trim();
      if (transportRole === "stream_publish") {
        const streamPublish = ensureStreamPublishState(session);
        if (!streamPublish) return;

        const transportStatus = String(payload.status || "").trim() || null;
        const transportReason = String(payload.reason || "").trim() || null;
        const now = Date.now();
        streamPublish.transportStatus = transportStatus;
        streamPublish.transportReason = transportReason;
        streamPublish.transportUpdatedAt = now;
        if (transportStatus === "ready") {
          streamPublish.transportConnectedAt = now;
        }

        this.host.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
          content: "stream_publish_transport_state_updated",
          metadata: {
            sessionId: session.id,
            status: transportStatus,
            reason: transportReason,
            streamKey: streamPublish.streamKey || null,
            sourceKind: streamPublish.sourceKind || null,
            sourceKey: streamPublish.sourceKey || null,
            sourceUrl: streamPublish.sourceUrl || null
          }
        });

        if (
          streamPublish.active &&
          (transportStatus === "failed" || transportStatus === "disconnected")
        ) {
          const stopReason =
            transportStatus === "failed"
              ? "stream_publish_transport_failed"
              : "stream_publish_transport_disconnected";
          const stopPromise =
            streamPublish.sourceKind === "browser_session"
              ? this.host.stopBrowserSessionStreamPublish({
                  guildId: session.guildId,
                  reason: stopReason
                })
              : Promise.resolve(
                  this.host.stopMusicStreamPublish({
                    guildId: session.guildId,
                    reason: stopReason
                  })
                );
          void Promise.resolve(stopPromise).catch((error) => {
            this.logAsyncFailure({
              session,
              content: "stream_publish_transport_recovery_failed",
              error,
              metadata: {
                status: transportStatus,
                reason: transportReason
              }
            });
          });
        }
        return;
      }
      if (transportRole !== "stream_watch") return;

      const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
      const transportStatus = String(payload.status || "").trim() || null;
      const transportReason = String(payload.reason || "").trim() || null;
      const now = Date.now();
      nativeScreenShare.transportStatus = transportStatus;
      nativeScreenShare.transportReason = transportReason;
      nativeScreenShare.transportUpdatedAt = now;
      if (transportStatus === "ready") {
        nativeScreenShare.transportConnectedAt = now;
      }

      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: session.streamWatch?.targetUserId || this.host.client.user?.id || null,
        content: "native_discord_stream_transport_state_updated",
        metadata: {
          sessionId: session.id,
          status: transportStatus,
          reason: transportReason,
          streamKey: nativeScreenShare.activeStreamKey || null,
          targetUserId: session.streamWatch?.targetUserId || null
        }
      });

      if (
        session.streamWatch?.active &&
        (transportStatus === "failed" || transportStatus === "disconnected")
      ) {
        const recoveryReason =
          transportStatus === "failed"
            ? "native_discord_stream_transport_failed"
            : "native_discord_stream_transport_disconnected";
        const recoveryRequesterUserId =
          String(session.streamWatch.requestedByUserId || session.streamWatch.targetUserId || "").trim() || null;
        const recoveryTargetUserId = String(session.streamWatch.targetUserId || "").trim() || null;
        const recoveryChannelId = String(session.textChannelId || "").trim() || null;

        void (async () => {
          const stopResult = await this.host.stopWatchStreamForUser({
            guildId: session.guildId,
            targetUserId: recoveryTargetUserId,
            settings,
            reason: recoveryReason
          });

          if (!stopResult?.ok) {
            this.host.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: recoveryChannelId,
              userId: recoveryRequesterUserId || recoveryTargetUserId || this.host.client.user?.id || null,
              content: "native_discord_stream_transport_link_fallback_skipped",
              metadata: {
                sessionId: session.id,
                status: transportStatus,
                reason: transportReason,
                recoveryReason,
                targetUserId: recoveryTargetUserId,
                requesterUserId: recoveryRequesterUserId,
                stopReason: String(stopResult?.reason || "watch_stop_failed")
              }
            });
            return;
          }

          if (!recoveryRequesterUserId || !recoveryChannelId) {
            this.host.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: recoveryChannelId,
              userId: recoveryRequesterUserId || recoveryTargetUserId || this.host.client.user?.id || null,
              content: "native_discord_stream_transport_link_fallback_skipped",
              metadata: {
                sessionId: session.id,
                status: transportStatus,
                reason: transportReason,
                recoveryReason,
                targetUserId: recoveryTargetUserId,
                requesterUserId: recoveryRequesterUserId,
                missingTextChannel: !recoveryChannelId,
                missingRequesterUserId: !recoveryRequesterUserId
              }
            });
            return;
          }

          if (this.host.appConfig?.streamLinkFallbackEnabled === false) {
            this.host.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: recoveryChannelId,
              userId: recoveryRequesterUserId,
              content: "native_discord_stream_transport_link_fallback_skipped",
              metadata: {
                sessionId: session.id,
                status: transportStatus,
                reason: transportReason,
                recoveryReason,
                targetUserId: recoveryTargetUserId,
                requesterUserId: recoveryRequesterUserId,
                skipReason: "stream_link_fallback_disabled"
              }
            });
            return;
          }

          this.host.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: recoveryChannelId,
            userId: recoveryRequesterUserId,
            content: "native_discord_stream_transport_link_fallback_requested",
            metadata: {
              sessionId: session.id,
              status: transportStatus,
              reason: transportReason,
              recoveryReason,
              targetUserId: recoveryTargetUserId,
              requesterUserId: recoveryRequesterUserId
            }
          });

          const fallbackResult = await this.host.startVoiceScreenWatch({
            settings,
            guildId: session.guildId,
            channelId: recoveryChannelId,
            requesterUserId: recoveryRequesterUserId,
            targetUserId: recoveryTargetUserId,
            source: recoveryReason,
            preferredTransport: "link",
            nativeFailureReason: recoveryReason
          });

          if (!fallbackResult?.started) {
            this.host.store.logAction({
              kind: "voice_runtime",
              guildId: session.guildId,
              channelId: recoveryChannelId,
              userId: recoveryRequesterUserId,
              content: "native_discord_stream_transport_link_fallback_failed",
              metadata: {
                sessionId: session.id,
                status: transportStatus,
                reason: transportReason,
                recoveryReason,
                targetUserId: recoveryTargetUserId,
                requesterUserId: recoveryRequesterUserId,
                fallbackReason: String(fallbackResult?.reason || "screen_watch_unavailable")
              }
            });
          }
        })().catch((error) => {
          this.logAsyncFailure({
            session,
            content: "native_discord_stream_transport_stop_failed",
            error,
            metadata: {
              status: transportStatus,
              reason: transportReason
            }
          });
        });
      }
    };

    if (session.voxClient) {
      session.voxClient.on("connectionState", onConnectionState);
      session.voxClient.on("transportState", onTransportState);
      session.voxClient.on("crashed", onCrashed);
      session.cleanupHandlers.push(() => {
        session.voxClient?.off("connectionState", onConnectionState);
        session.voxClient?.off("transportState", onTransportState);
        session.voxClient?.off("crashed", onCrashed);
      });
    }

    const onSpeakingStart = (userId) => {
      if (String(userId || "") === String(this.host.client.user?.id || "")) return;
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

    const onUserVideoState = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const normalizedUserId = String(payload.userId || "").trim();
      if (!normalizedUserId) return;

      const updatedState = applyNativeDiscordVideoState(session, payload);
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "native_discord_screen_share_state_updated",
        metadata: {
          sessionId: session.id,
          codec: updatedState.codec,
          streamCount: updatedState.streams.length,
          activeSharerCount: listActiveNativeDiscordScreenSharers(session).length,
          targetUserId: session.streamWatch?.targetUserId || null
        }
      });
      this.host.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings,
        reason: "native_discord_screen_share_state"
      });
    };

    const onUserVideoEnd = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const normalizedUserId = String(payload.userId || "").trim();
      if (!normalizedUserId) return;

      const removedState = removeNativeDiscordVideoSharer(session, normalizedUserId);
      this.host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "native_discord_screen_share_ended",
        metadata: {
          sessionId: session.id,
          codec: removedState?.codec || null,
          ssrc: Number.isFinite(Number(payload.ssrc)) ? Math.max(0, Math.floor(Number(payload.ssrc))) : null,
          activeSharerCount: listActiveNativeDiscordScreenSharers(session).length,
          targetUserId: session.streamWatch?.targetUserId || null
        }
      });
      this.host.instructionManager.scheduleRealtimeInstructionRefresh({
        session,
        settings,
        reason: "native_discord_screen_share_ended"
      });

      if (session.streamWatch?.active && String(session.streamWatch.targetUserId || "") === normalizedUserId) {
        void this.host.stopWatchStreamForUser({
          guildId: session.guildId,
          targetUserId: normalizedUserId,
          settings,
          reason: "native_discord_screen_share_ended"
        }).catch((error) => {
          this.logAsyncFailure({
            session,
            content: "native_discord_screen_share_stop_failed",
            error,
            metadata: {
              targetUserId: normalizedUserId
            }
          });
        });
      }
    };

    // Handler for raw video frames (VP8 only — H264 is now decoded in
    // Rust by the persistent decoder and arrives as `decodedVideoFrame`).
    const onUserVideoFrame = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const normalizedUserId = String(payload.userId || "").trim();
      if (!normalizedUserId) return;

      recordNativeDiscordVideoFrame(session, payload);
      if (!session.streamWatch?.active) return;
      if (String(session.streamWatch.targetUserId || "") !== normalizedUserId) return;

      const codec = String(payload.codec || "").trim().toLowerCase() || null;

      // H264 is handled by the persistent Rust decoder — skip raw H264 frames.
      if (codec === "h264") return;

      // VP8 path: require keyframes for per-frame ffmpeg decode.
      if (!payload.keyframe) return;

      const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
      nativeScreenShare.ffmpegAvailable = hasNativeDiscordVideoDecoderSupport();
      if (!nativeScreenShare.ffmpegAvailable) {
        if (nativeScreenShare.lastDecodeFailureReason !== "ffmpeg_not_installed") {
          nativeScreenShare.lastDecodeFailureAt = Date.now();
          nativeScreenShare.lastDecodeFailureReason = "ffmpeg_not_installed";
          this.host.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: "native_discord_video_decode_unavailable",
            metadata: { sessionId: session.id, codec }
          });
        }
        return;
      }

      if (nativeScreenShare.decodeInFlight) return;

      nativeScreenShare.lastDecodeAttemptAt = Date.now();
      nativeScreenShare.decodeInFlight = true;
      void (async () => {
        let decoded: { mimeType: string; dataBase64: string } | null = null;
        try {
          decoded = await decodeNativeDiscordVideoFrameToStillImage({
            codec: payload.codec,
            frameBase64: payload.frameBase64,
            rtpTimestamp: payload.rtpTimestamp
          });
          nativeScreenShare.lastDecodeSuccessAt = Date.now();
          nativeScreenShare.lastDecodeFailureReason = null;
        } catch (error) {
          const errorMessage = String((error as Error)?.message || error);
          nativeScreenShare.lastDecodeFailureAt = Date.now();
          nativeScreenShare.lastDecodeFailureReason = errorMessage;
          this.host.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: `native_discord_video_decode_failed: ${errorMessage}`,
            metadata: {
              sessionId: session.id,
              codec,
              keyframe: Boolean(payload.keyframe),
              rtpTimestamp: Number.isFinite(Number(payload.rtpTimestamp))
                ? Math.max(0, Math.floor(Number(payload.rtpTimestamp)))
                : null,
              frameBytes: Buffer.from(String(payload.frameBase64 || "").trim(), "base64").length
            }
          });
        } finally {
          nativeScreenShare.decodeInFlight = false;
        }

        if (!decoded) return;
        try {
          const ingestResult = await this.host.ingestStreamFrame({
            guildId: session.guildId,
            streamerUserId: normalizedUserId,
            mimeType: decoded.mimeType,
            dataBase64: decoded.dataBase64,
            source: `native_discord_video:${codec || "unknown"}`,
            settings
          });
          if (!ingestResult?.accepted) {
            const ingestReason = String(ingestResult?.reason || "").trim().toLowerCase();
            if (ingestReason && ingestReason !== "watch_not_active" && ingestReason !== "target_user_mismatch") {
              this.host.store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: normalizedUserId,
                content: "native_discord_video_frame_rejected",
                metadata: { sessionId: session.id, reason: ingestReason, codec }
              });
            }
          }
        } catch (ingestError) {
          this.host.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: `native_discord_video_ingest_failed: ${String((ingestError as Error)?.message || ingestError)}`,
            metadata: { sessionId: session.id, codec }
          });
        }
      })();
    };

    // Handler for pre-decoded video frames from the persistent Rust H264
    // decoder.  These arrive as JPEG — no ffmpeg subprocess needed.
    const onDecodedVideoFrame = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const normalizedUserId = String(payload.userId || "").trim();
      if (!normalizedUserId) return;
      if (!session.streamWatch?.active) return;
      if (String(session.streamWatch.targetUserId || "") !== normalizedUserId) return;

      const jpegBase64 = String(payload.jpegBase64 || "").trim();
      if (!jpegBase64) return;

      const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
      nativeScreenShare.lastDecodeSuccessAt = Date.now();
      nativeScreenShare.lastDecodeFailureReason = null;

      void (async () => {
        try {
          const ingestResult = await this.host.ingestStreamFrame({
            guildId: session.guildId,
            streamerUserId: normalizedUserId,
            mimeType: "image/jpeg",
            dataBase64: jpegBase64,
            source: "native_discord_video:h264:persistent_decoder",
            settings,
            changeScore: typeof payload.changeScore === "number" ? payload.changeScore : undefined,
            emaChangeScore: typeof payload.emaChangeScore === "number" ? payload.emaChangeScore : undefined,
            isSceneCut: typeof payload.isSceneCut === "boolean" ? payload.isSceneCut : undefined
          });
          if (!ingestResult?.accepted) {
            const ingestReason = String(ingestResult?.reason || "").trim().toLowerCase();
            if (ingestReason && ingestReason !== "watch_not_active" && ingestReason !== "target_user_mismatch") {
              this.host.store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: normalizedUserId,
                content: "native_discord_decoded_frame_rejected",
                metadata: {
                  sessionId: session.id,
                  reason: ingestReason,
                  width: payload.width,
                  height: payload.height
                }
              });
            }
          }
        } catch (ingestError) {
          this.host.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: `native_discord_decoded_frame_ingest_failed: ${String((ingestError as Error)?.message || ingestError)}`,
            metadata: { sessionId: session.id }
          });
        }
      })();
    };

    if (session.voxClient) {
      session.voxClient.on("speakingStart", onSpeakingStart);
      session.voxClient.on("speakingEnd", onSpeakingEnd);
      session.voxClient.on("clientDisconnect", onClientDisconnect);
      session.voxClient.on("userVideoState", onUserVideoState);
      session.voxClient.on("userVideoFrame", onUserVideoFrame);
      session.voxClient.on("decodedVideoFrame", onDecodedVideoFrame);
      session.voxClient.on("userVideoEnd", onUserVideoEnd);
      session.cleanupHandlers.push(() => {
        session.voxClient?.off("speakingStart", onSpeakingStart);
        session.voxClient?.off("speakingEnd", onSpeakingEnd);
        session.voxClient?.off("clientDisconnect", onClientDisconnect);
        session.voxClient?.off("userVideoState", onUserVideoState);
        session.voxClient?.off("userVideoFrame", onUserVideoFrame);
        session.voxClient?.off("decodedVideoFrame", onDecodedVideoFrame);
        session.voxClient?.off("userVideoEnd", onUserVideoEnd);
      });
    }
  }
}
