import { getVoiceAdmissionSettings } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import type { MusicPlaybackPhase, VoiceSession } from "./voiceSessionTypes.ts";

const DEFAULT_MUSIC_WAKE_LATCH_SECONDS = 30;

type MusicWakeLatchSettings = Record<string, unknown> | null;
type MusicWakeLatchSessionLike = Partial<VoiceSession> | null | undefined;

function resolveMusicWakeLatchSeconds(settings: MusicWakeLatchSettings): number {
  return clamp(
    Number(getVoiceAdmissionSettings(settings).musicWakeLatchSeconds) || DEFAULT_MUSIC_WAKE_LATCH_SECONDS,
    5,
    60
  );
}

export function clearMusicWakeLatch(session: MusicWakeLatchSessionLike) {
  if (!session || typeof session !== "object") return;
  session.musicWakeLatchedUntil = 0;
  session.musicWakeLatchedByUserId = null;
}

function getMusicWakeLatchState(
  session: MusicWakeLatchSessionLike,
  now = Date.now()
) {
  const latchedUntil = Number(session?.musicWakeLatchedUntil || 0);
  if (!Number.isFinite(latchedUntil) || latchedUntil <= now) {
    if (latchedUntil > 0) {
      if (
        session &&
        typeof session === "object" &&
        session.music &&
        typeof session.music === "object" &&
        session.music.phase === "paused_wake_word"
      ) {
        session.musicWakeLatchedUntil = 0;
      } else {
        clearMusicWakeLatch(session);
      }
    }
    return {
      active: false,
      latchedUntil: 0,
      msUntilExpiry: null
    };
  }
  return {
    active: true,
    latchedUntil,
    msUntilExpiry: Math.max(0, Math.round(latchedUntil - now))
  };
}

export function getMusicWakeFollowupState(
  session: MusicWakeLatchSessionLike,
  userId: string | null = null,
  now = Date.now()
) {
  const latchState = getMusicWakeLatchState(session, now);
  const latchedUserId = String(session?.musicWakeLatchedByUserId || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const currentPhase: MusicPlaybackPhase =
    session &&
    typeof session === "object" &&
    session.music &&
    typeof session.music === "object"
      ? (String(session.music.phase || "idle").trim() || "idle") as MusicPlaybackPhase
      : "idle";
  const pausedWakeWordOwnerFollowup =
    latchState.active &&
    currentPhase === "paused_wake_word" &&
    latchedUserId !== null &&
    normalizedUserId === latchedUserId;
  const passiveWakeFollowupAllowed =
    latchState.active &&
    (
      currentPhase === "paused_wake_word"
        ? (latchedUserId ? pausedWakeWordOwnerFollowup : true)
        : true
    );
  return {
    ...latchState,
    currentPhase,
    latchedUserId,
    pausedWakeWordOwnerFollowup,
    passiveWakeFollowupAllowed
  };
}

export function touchMusicWakeLatch(
  session: MusicWakeLatchSessionLike,
  settings: MusicWakeLatchSettings,
  userId: string | null = null,
  now = Date.now()
) {
  if (!session || typeof session !== "object") return 0;
  const latchWindowMs = Math.round(resolveMusicWakeLatchSeconds(settings) * 1000);
  const nextLatchedUntil = now + latchWindowMs;
  session.musicWakeLatchedUntil = nextLatchedUntil;
  session.musicWakeLatchedByUserId = String(userId || "").trim() || null;
  return nextLatchedUntil;
}
