import { buildVoiceReplyScopeKey } from "../../tools/activeReplyRegistry.ts";
import { getResolvedVoiceGenerationBinding, getVoiceStreamWatchSettings } from "../../settings/agentStack.ts";
import { clamp, deepMerge } from "../../utils.ts";
import { normalizeVoiceText, resolveVoiceSettingsSnapshot } from "../voiceSessionHelpers.ts";
import {
  STREAM_WATCH_NOTE_LINE_MAX_CHARS,
  resolveStreamWatchNoteSettings,
  supportsStreamWatchCommentary,
  type StreamWatchManager,
  type StreamWatchSession
} from "../voiceStreamWatch.ts";

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;

type StreamWatchCommentaryTriggerReason = "share_start" | "change_detected" | "interval";

const STREAM_WATCH_COMMENTARY_TRIGGER_PRIORITY: Record<StreamWatchCommentaryTriggerReason, number> = {
  share_start: 3,
  change_detected: 2,
  interval: 1
};

function resolvePreferredStreamWatchCommentaryTrigger(
  a: StreamWatchCommentaryTriggerReason | null,
  b: StreamWatchCommentaryTriggerReason | null
): StreamWatchCommentaryTriggerReason | null {
  if (!a) return b;
  if (!b) return a;
  return STREAM_WATCH_COMMENTARY_TRIGGER_PRIORITY[a] >= STREAM_WATCH_COMMENTARY_TRIGGER_PRIORITY[b] ? a : b;
}

function readStreamWatchCommentaryTriggerReason(value: unknown): StreamWatchCommentaryTriggerReason | null {
  const normalized = String(value || "").trim();
  if (normalized === "share_start" || normalized === "change_detected" || normalized === "interval") {
    return normalized;
  }
  return null;
}

function resolveStreamWatchCommentarySettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  return {
    enabled:
      streamWatchSettings.autonomousCommentaryEnabled !== undefined
        ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
        : true,
    intervalSeconds: clamp(
      Number(streamWatchSettings.commentaryIntervalSeconds) || 15,
      5,
      120
    ),
    changeThreshold: clamp(
      Number(streamWatchSettings.changeThreshold) || 0.01,
      0.005,
      1.0
    ),
    changeMinIntervalSeconds: clamp(
      Number(streamWatchSettings.changeMinIntervalSeconds) || 2,
      1,
      30
    ),
    provider: String(streamWatchSettings.commentaryProvider || "").trim(),
    model: String(streamWatchSettings.commentaryModel || "").trim()
  };
}

export function getStreamWatchChangeState(session: StreamWatchSession, settings = null) {
  const noteSettings = resolveStreamWatchNoteSettings(settings);
  const latestChangeScore = Number(session.streamWatch?.latestChangeScore || 0);
  const latestEmaChangeScore = Number(session.streamWatch?.latestEmaChangeScore || 0);
  const isSceneCut = Boolean(session.streamWatch?.latestIsSceneCut);
  const significantChange =
    isSceneCut ||
    latestChangeScore >= noteSettings.changeThreshold ||
    latestEmaChangeScore >= noteSettings.changeThreshold;
  const staticMotion =
    !isSceneCut &&
    latestChangeScore < noteSettings.staticFloor &&
    latestEmaChangeScore < noteSettings.staticFloor;
  return {
    latestChangeScore,
    latestEmaChangeScore,
    isSceneCut,
    significantChange,
    staticMotion
  };
}

function isStreamWatchPlaybackBusy(session) {
  if (!session || session.ending) return false;
  if (session.botTurnOpen) return true;
  const streamBuffered = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
  return streamBuffered > 0;
}

function hasPendingDeferredVoiceTurns(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  const deferredTurns = manager.deferredActionQueue?.getDeferredQueuedUserTurns?.(session);
  return Array.isArray(deferredTurns) && deferredTurns.length > 0;
}

function hasActiveVoiceGeneration(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  if (session.inFlightAcceptedBrainTurn && typeof session.inFlightAcceptedBrainTurn === "object") {
    return true;
  }
  try {
    return Boolean(manager.activeReplies?.has?.(buildVoiceReplyScopeKey(session.id)));
  } catch {
    return false;
  }
}

function hasQueuedVoiceWork(manager: StreamWatchManager, session) {
  if (!session || session.ending) return false;
  if (hasActiveVoiceGeneration(manager, session)) return true;
  if (Number(session.pendingFileAsrTurns || 0) > 0) return true;
  if (session.realtimeTurnDrainActive) return true;
  if (Array.isArray(session.pendingRealtimeTurns) && session.pendingRealtimeTurns.length > 0) return true;
  if (hasPendingDeferredVoiceTurns(manager, session)) return true;
  const outputChannelState = manager.getOutputChannelState?.(session);
  return Boolean(outputChannelState?.locked);
}

const DIRECT_VISION_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "claude-oauth",
  "openai-oauth",
  "codex-cli",
  "codex_cli_session",
  "xai"
]);

export function supportsDirectVisionCommentary(manager: StreamWatchManager, settings = null) {
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  const commentarySettings = resolveStreamWatchCommentarySettings(settings);
  const resolvedSettings =
    commentarySettings.provider && commentarySettings.model
      ? withStreamWatchCommentaryBinding(settings, {
          provider: commentarySettings.provider,
          model: commentarySettings.model
        })
      : settings;
  const voiceBinding = getResolvedVoiceGenerationBinding(resolvedSettings);
  return DIRECT_VISION_PROVIDERS.has(voiceBinding.provider);
}

function withStreamWatchCommentaryBinding(
  settings: Record<string, unknown> | null,
  binding: { provider: string; model: string }
) {
  return deepMerge(settings || {}, {
    agentStack: {
      runtimeConfig: {
        voice: {
          generation: {
            mode: "dedicated_model",
            model: {
              provider: binding.provider,
              model: binding.model
            }
          }
        }
      }
    }
  });
}

export async function maybeTriggerStreamWatchCommentary(manager: StreamWatchManager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return;
  if (!supportsStreamWatchCommentary(manager, session, settings)) return;
  if (!session.streamWatch?.active) return;
  const baseSettings = resolveVoiceSettingsSnapshot(manager.store, session, settings) as Record<string, unknown> | null;
  const commentarySettings = resolveStreamWatchCommentarySettings(baseSettings);
  if (!commentarySettings.enabled) return;
  if (typeof manager.runRealtimeBrainReply !== "function") return;

  const now = Date.now();
  const sinceLastCommentary = now - Number(session.streamWatch.lastCommentaryAt || 0);
  const firstFrameTriggered = Number(session.streamWatch.ingestedFrameCount || 0) <= 1;
  const intervalTriggered = sinceLastCommentary >= commentarySettings.intervalSeconds * 1000;
  const changeState = getStreamWatchChangeState(session, baseSettings);
  const changeTriggered =
    sinceLastCommentary >= commentarySettings.changeMinIntervalSeconds * 1000 &&
    changeState.significantChange;
  const immediateTriggerReason: StreamWatchCommentaryTriggerReason | null = firstFrameTriggered
    ? "share_start"
    : changeTriggered
      ? "change_detected"
      : intervalTriggered
        ? "interval"
        : null;
  const pendingTriggerReason = readStreamWatchCommentaryTriggerReason(
    session.streamWatch?.pendingCommentaryTriggerReason
  );
  if (!immediateTriggerReason && !pendingTriggerReason) return;

  const blockedReasons: string[] = [];
  if (session.pendingResponse) blockedReasons.push("pending_response");
  if (isStreamWatchPlaybackBusy(session)) blockedReasons.push("playback_busy");
  if (hasQueuedVoiceWork(manager, session)) blockedReasons.push("queued_voice_work");

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const sinceLastInboundAudio = now - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) {
    blockedReasons.push("audio_quiet_window");
  }

  if (blockedReasons.length > 0) {
    const deferredTriggerReason = resolvePreferredStreamWatchCommentaryTrigger(
      pendingTriggerReason,
      immediateTriggerReason
    );
    if (deferredTriggerReason) {
      const existingQueuedAt = Math.max(0, Number(session.streamWatch.pendingCommentaryQueuedAt || 0));
      session.streamWatch.pendingCommentaryTriggerReason = deferredTriggerReason;
      session.streamWatch.pendingCommentaryQueuedAt = existingQueuedAt > 0 ? existingQueuedAt : now;
      if (!String(session.streamWatch.pendingCommentarySource || "").trim()) {
        session.streamWatch.pendingCommentarySource = String(source || "api_stream_ingest");
      }
    }
    if (immediateTriggerReason) {
      manager.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: "stream_watch_commentary_deferred",
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest"),
          triggerReason: immediateTriggerReason,
          deferredTriggerReason,
          blockedReasons,
          firstFrameTriggered,
          intervalTriggered,
          changeTriggered,
          changeScore: changeState.latestChangeScore,
          emaChangeScore: changeState.latestEmaChangeScore,
          isSceneCut: changeState.isSceneCut
        }
      });
    }
    return;
  }

  const triggerReason = resolvePreferredStreamWatchCommentaryTrigger(
    pendingTriggerReason,
    immediateTriggerReason
  );
  if (!triggerReason) return;
  const deferredTriggerUsed = Boolean(
    pendingTriggerReason && (!immediateTriggerReason || triggerReason === pendingTriggerReason)
  );
  const deferredTriggerQueuedAt = Math.max(0, Number(session.streamWatch.pendingCommentaryQueuedAt || 0));
  const deferredTriggerWaitMs = deferredTriggerQueuedAt > 0 ? Math.max(0, now - deferredTriggerQueuedAt) : null;
  const deferredTriggerSource = String(session.streamWatch.pendingCommentarySource || "").trim() || null;

  session.streamWatch.pendingCommentaryTriggerReason = null;
  session.streamWatch.pendingCommentaryQueuedAt = 0;
  session.streamWatch.pendingCommentarySource = null;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return;

  const frozenFrameSnapshot = {
    mimeType: String(session.streamWatch?.latestFrameMimeType || "image/jpeg"),
    dataBase64: bufferedFrame
  };
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const latestNoteEntries = Array.isArray(session.streamWatch?.noteEntries) ? session.streamWatch.noteEntries : [];
  const latestNote = normalizeVoiceText(
    latestNoteEntries[latestNoteEntries.length - 1]?.text || "",
    STREAM_WATCH_NOTE_LINE_MAX_CHARS
  );
  const normalizedStreamerUserId = String(streamerUserId || "").trim() || null;
  const botUserId = String(manager.client.user?.id || "").trim() || null;
  const transcript =
    triggerReason === "share_start"
      ? `[${speakerName} started screen sharing. You can see the latest frame.]`
      : triggerReason === "change_detected"
        ? `[${speakerName} is screen sharing. Something notable just happened on screen.]`
        : `[A fresh frame from ${speakerName}'s screen share is available.]`;
  const resolvedCommentarySettings =
    commentarySettings.provider && commentarySettings.model
      ? withStreamWatchCommentaryBinding(baseSettings, {
          provider: commentarySettings.provider,
          model: commentarySettings.model
        })
      : baseSettings;

  session.streamWatch.lastCommentaryAt = now;
  session.streamWatch.lastCommentaryNote = latestNote || null;

  void manager.runRealtimeBrainReply({
    session,
    settings: resolvedCommentarySettings,
    userId: session.streamWatch.targetUserId || streamerUserId || manager.client.user?.id || null,
    transcript,
    inputKind: "event",
    directAddressed: false,
    source: `stream_watch_brain_turn:${triggerReason}`,
    frozenFrameSnapshot,
    runtimeEventContext: {
      category: "screen_share",
      eventType: triggerReason,
      actorUserId: normalizedStreamerUserId,
      actorDisplayName: speakerName,
      actorRole:
        normalizedStreamerUserId && botUserId && normalizedStreamerUserId === botUserId
          ? "self"
          : normalizedStreamerUserId
            ? "other"
            : "unknown",
      hasVisibleFrame: true
    }
  }).catch((error: unknown) => {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `stream_watch_commentary_request_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source: String(source || "api_stream_ingest"),
        triggerReason
      }
    });
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "stream_watch_commentary_requested",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      streamerUserId: streamerUserId || null,
      commentaryMode: "brain_turn",
      triggerReason,
      immediateTriggerReason: immediateTriggerReason || null,
      pendingTriggerReason: pendingTriggerReason || null,
      deferredTriggerUsed,
      deferredTriggerQueuedAt: deferredTriggerQueuedAt || null,
      deferredTriggerWaitMs,
      deferredTriggerSource,
      firstFrameTriggered,
      intervalTriggered,
      changeScore: changeState.latestChangeScore,
      emaChangeScore: changeState.latestEmaChangeScore,
      isSceneCut: changeState.isSceneCut,
      changeTriggered,
      commentaryProvider: commentarySettings.provider || null,
      commentaryModel: commentarySettings.model || null,
      latestNote: latestNote || null
    }
  });
}
