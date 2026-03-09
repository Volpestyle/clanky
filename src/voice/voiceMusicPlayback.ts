import { ChatInputCommandInteraction } from "discord.js";
import { normalizeInlineText, STT_TRANSCRIPT_MAX_CHARS, isVoiceTurnAddressedToBot, resolveVoiceAsrLanguageGuidance } from "./voiceSessionHelpers.ts";
import { getVoiceConversationPolicy, getVoiceRuntimeConfig } from "../settings/agentStack.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";

import { clamp } from "../utils.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { MusicPlaybackProvider } from "./musicPlayback.ts";
import type { DiscordMusicPlayer } from "./musicPlayer.ts";
import type { MusicSearchProvider } from "./musicSearch.ts";
import type { ReplyManager } from "./replyManager.ts";

// English-only fallback/fast-path heuristics for obvious music control turns.
// These are convenience shortcuts, not the primary music-command decision logic.
export const EN_MUSIC_STOP_VERB_RE = /\b(?:stop|halt|end|quit|shut\s*off)\b/i;
export const EN_MUSIC_PAUSE_VERB_RE = /\b(?:pause)\b/i;
export const EN_MUSIC_RESUME_VERB_RE = /\b(?:resume|unpause|continue)\b/i;
export const EN_MUSIC_RESUME_PRONOUN_RE = /\b(?:resume|unpause|continue)\s+it\b/i;
export const EN_MUSIC_RESUME_PLAY_CURRENT_RE =
  /\bplay\s+(?:it|this(?:\s+(?:song|track|music|playback))?|the\s+(?:song|track|music|playback))(?:\s+(?:again|back(?:\s+up)?))?(?:\s+(?:please|plz|now))?\s*$/i;
export const EN_MUSIC_SKIP_VERB_RE = /\b(?:skip|next)\b/i;
export const EN_MUSIC_CUE_RE = /\b(?:music|song|songs|track|tracks|playback|playing)\b/i;
export const EN_MUSIC_PLAY_VERB_RE = /\b(?:play|start|queue|put\s+on|spin)\b/i;
export const EN_MUSIC_PLAY_QUERY_RE =
  /\b(?:play|start|queue|put\s+on|spin)\s+(.+?)\b(?:in\s+vc|in\s+the\s+vc|in\s+voice|in\s+discord|right\s+now|rn|please|plz)?$/i;
export const EN_MUSIC_QUERY_TRAILING_NOISE_RE =
  /\b(?:in\s+vc|in\s+the\s+vc|in\s+voice|in\s+discord|right\s+now|rn|please|plz|for\s+me|for\s+us|for\s+everyone|for\s+everybody|for\s+the\s+chat|thanks?)\b/gi;
export const EN_MUSIC_QUERY_MEDIA_WORD_RE = /\b(?:music|song|songs|track|tracks)\b/gi;
export const EN_MUSIC_QUERY_EMPTY_RE = /^(?:something|anything|some|a|the|please|plz)$/i;
export const MUSIC_DISAMBIGUATION_MAX_RESULTS = 5;
export const MUSIC_DISAMBIGUATION_TTL_MS = 10 * 60 * 1000;
export const VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK = 5;
const VOICE_COMMAND_SESSION_TTL_MS = 20 * 1000;

import type {
  MusicSelectionResult,
  MusicDisambiguationPayload,
  MusicTextRequestPayload,
  MusicTextCommandMessage,
  MusicPlaybackPhase,
  MusicPauseReason,
  VoiceSession,
  VoiceSessionMusicState
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseCanResume,
  musicPhaseCanPause,
  musicPhaseShouldAllowDucking,
  musicPhaseShouldForceCommandOnly
} from "./voiceSessionTypes.ts";

type MusicPlaybackSettings = Record<string, unknown> | null;

type MusicPlaybackStoreLike = {
  getSettings: () => MusicPlaybackSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type MusicRuntimeSessionLike = {
  ending?: boolean;
  id?: string;
  guildId?: string;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  settingsSnapshot?: MusicPlaybackSettings;
  lastRealtimeToolCallerUserId?: string | null;
  botSpeechMusicUnduckTimer?: ReturnType<typeof setTimeout> | null;
  voiceCommandState?: {
    userId: string | null;
    domain: string | null;
    intent: string | null;
    startedAt: number;
    expiresAt: number;
  } | null;
  music?: VoiceSessionMusicState | null;
  musicQueueState?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type MusicPlaybackLogArgs = Parameters<MusicPlaybackStoreLike["logAction"]>[0];

export interface MusicPlaybackHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
    channels: {
      fetch: (channelId: string) => Promise<unknown>;
    };
    guilds: {
      cache: {
        get: (guildId: string) => unknown;
      };
    };
  };
  sessions: Map<string, VoiceSession>;
  store: MusicPlaybackStoreLike;
  llm?: {
    transcribeAudio?: unknown;
  } | null;
  replyManager: Pick<ReplyManager, "clearPendingResponse" | "hasBufferedTtsPlayback">;
  bargeInController: Pick<BargeInController, "clearBargeInOutputSuppression">;
  deferredActionQueue: Pick<DeferredActionQueue, "clearAllDeferredVoiceActions">;
  musicPlayer?: Pick<DiscordMusicPlayer, "duck" | "unduck" | "play" | "stop" | "pause" | "resume"> | null;
  musicPlayback?: Pick<MusicPlaybackProvider, "provider" | "isConfigured" | "startPlayback" | "stopPlayback"> | null;
  musicSearch?: Pick<MusicSearchProvider, "isConfigured" | "search"> | null;
  maybeClearActiveReplyInterruptionPolicy: (session: MusicRuntimeSessionLike | null | undefined) => void;
  abortActiveInboundCaptures: (args: {
    session: VoiceSession;
    reason?: string;
  }) => void;
  composeOperationalMessage?: (args: {
    settings?: MusicPlaybackSettings;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string;
    reason?: string | null;
    details?: Record<string, unknown>;
    allowSkip?: boolean;
  }) => Promise<unknown> | unknown;
  transcribePcmTurn: (args: {
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
  }) => Promise<string>;
  hasBotNameCueForTranscript: (args?: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  }) => boolean;
  isMusicDisambiguationResolutionTurn: (
    session: MusicRuntimeSessionLike,
    userId?: string | null,
    transcript?: string
  ) => boolean;
  maybeHandlePendingMusicDisambiguationTurn: (args: {
    session?: MusicRuntimeSessionLike | null;
    settings?: MusicPlaybackSettings;
    userId?: string | null;
    transcript?: string;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  }) => Promise<boolean>;
  playVoiceQueueTrackByIndex: (args: {
    session: MusicRuntimeSessionLike | null | undefined;
    settings?: MusicPlaybackSettings;
    index: number;
  }) => Promise<unknown>;
  requestStopMusic: (args: {
    message?: unknown;
    guildId?: string | null;
    channel?: unknown;
    channelId?: string | null;
    requestedByUserId?: string | null;
    settings?: MusicPlaybackSettings | null;
    reason?: string;
    source?: string;
    requestText?: string;
    clearQueue?: boolean;
    mustNotify?: boolean;
  }) => Promise<unknown>;
}

function logMusicAction(
  manager: MusicPlaybackHost,
  entry: MusicPlaybackLogArgs
) {
  manager.store.logAction(entry);
}

function beginVoiceCommandSession(
  session: VoiceSession | null | undefined,
  {
    userId = null,
    domain = "voice",
    intent = "followup",
    ttlMs = VOICE_COMMAND_SESSION_TTL_MS
  }: {
    userId?: string | null;
    domain?: string | null;
    intent?: string | null;
    ttlMs?: number | null;
  } = {}
) {
  if (!session || session.ending) return null;
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;
  const now = Date.now();
  const durationMs = clamp(Math.round(Number(ttlMs) || VOICE_COMMAND_SESSION_TTL_MS), 3_000, 120_000);
  const next = {
    userId: normalizedUserId,
    domain: normalizeInlineText(domain, 40) || "voice",
    intent: normalizeInlineText(intent, 80) || "followup",
    startedAt: now,
    expiresAt: now + durationMs
  };
  session.voiceCommandState = next;
  return next;
}

function clearVoiceCommandSession(session: VoiceSession | null | undefined) {
  if (!session || typeof session !== "object") return;
  session.voiceCommandState = null;
}

function clearToolMusicQueueState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const queueState = ensureToolMusicQueueState(manager, session);
  if (!queueState) return null;
  queueState.tracks = [];
  queueState.nowPlayingIndex = null;
  queueState.isPaused = false;
  return queueState;
}

export function ensureSessionMusicState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  void manager;
  if (!session || typeof session !== "object") return null;
  if (session.music && typeof session.music === "object") return session.music;
  session.music = {
    phase: "idle" as const,
    ducked: false,
    pauseReason: null,
    startedAt: 0,
    stoppedAt: 0,
    provider: null,
    source: null,
    lastTrackId: null,
    lastTrackTitle: null,
    lastTrackArtists: [],
    lastTrackUrl: null,
    lastQuery: null,
    lastRequestedByUserId: null,
    lastRequestText: null,
    lastCommandAt: 0,
    lastCommandReason: null,
    pendingQuery: null,
    pendingPlatform: "auto",
    pendingAction: "play_now",
    pendingResults: [],
    pendingRequestedByUserId: null,
    pendingRequestedAt: 0
  };
  return session.music;
}

export function snapshotMusicRuntimeState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const music = ensureSessionMusicState(manager, session);
  const queueState = ensureToolMusicQueueState(manager, session);
  if (!music) return null;
  return {
    phase: music.phase || "idle",
    active: musicPhaseIsActive(music.phase || "idle"),
    provider: music.provider || null,
    source: music.source || null,
    startedAt: music.startedAt > 0 ? new Date(music.startedAt).toISOString() : null,
    stoppedAt: music.stoppedAt > 0 ? new Date(music.stoppedAt).toISOString() : null,
    lastTrackId: music.lastTrackId || null,
    lastTrackTitle: music.lastTrackTitle || null,
    lastTrackArtists: Array.isArray(music.lastTrackArtists) ? music.lastTrackArtists : [],
    lastTrackUrl: music.lastTrackUrl || null,
    lastQuery: music.lastQuery || null,
    lastRequestedByUserId: music.lastRequestedByUserId || null,
    lastRequestText: music.lastRequestText || null,
    lastCommandAt: music.lastCommandAt > 0 ? new Date(music.lastCommandAt).toISOString() : null,
    lastCommandReason: music.lastCommandReason || null,
    pendingQuery: music.pendingQuery || null,
    pendingPlatform: music.pendingPlatform || null,
    pendingRequestedByUserId: music.pendingRequestedByUserId || null,
    pendingRequestedAt: music.pendingRequestedAt > 0 ? new Date(music.pendingRequestedAt).toISOString() : null,
    pendingResults: Array.isArray(music.pendingResults) ? music.pendingResults : [],
    disambiguationActive: isMusicDisambiguationActive(manager, music),
    queueState: queueState
      ? {
        tracks: queueState.tracks.map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist || null,
          source: track.source
        })),
        nowPlayingIndex: queueState.nowPlayingIndex,
        isPaused: queueState.isPaused,
        volume: queueState.volume
      }
      : null
  };
}

/** Get the current music playback phase (single source of truth). */
export function getMusicPhase(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
): MusicPlaybackPhase {
  const music = ensureSessionMusicState(manager, session);
  return music?.phase ?? "idle";
}

/**
 * Set the music playback phase.
 * ALL music state transitions MUST go through this function.
 */
export function setMusicPhase(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  phase: MusicPlaybackPhase,
  pauseReason: MusicPauseReason = null
): void {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.phase = phase;
  music.pauseReason = pauseReason;
}

export function isMusicPlaybackActive(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  return musicPhaseIsActive(getMusicPhase(manager, session));
}

export function isCommandOnlyActive(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  settings: MusicPlaybackSettings = null
) {
  const resolved = settings || session?.settingsSnapshot || manager.store.getSettings();
  if (getVoiceConversationPolicy(resolved).commandOnlyMode) return true;
  return musicPhaseShouldForceCommandOnly(getMusicPhase(manager, session));
}

export function resolveMusicDuckingConfig(
  manager: MusicPlaybackHost,
  settings: MusicPlaybackSettings = null
) {
  void manager;
  const resolved = settings || manager.store.getSettings();
  const voiceSettings =
    resolved && typeof resolved === "object" && "voice" in resolved && typeof resolved.voice === "object"
      ? (resolved.voice as Record<string, unknown>)
      : null;
  const musicDuckingSettings =
    voiceSettings &&
    "musicDucking" in voiceSettings &&
    typeof voiceSettings.musicDucking === "object"
      ? (voiceSettings.musicDucking as Record<string, unknown>)
      : null;
  const targetGainRaw = Number(musicDuckingSettings?.targetGain);
  const fadeMsRaw = Number(musicDuckingSettings?.fadeMs);
  return {
    targetGain: clamp(
      Number.isFinite(targetGainRaw) ? targetGainRaw : 0.15,
      0.05,
      1
    ),
    fadeMs: clamp(
      Number.isFinite(fadeMsRaw) ? Math.round(fadeMsRaw) : 300,
      0,
      5000
    )
  };
}

export function clearBotSpeechMusicUnduckTimer(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  void manager;
  if (!session) return;
  if (session.botSpeechMusicUnduckTimer) {
    clearTimeout(session.botSpeechMusicUnduckTimer);
    session.botSpeechMusicUnduckTimer = null;
  }
}

export async function engageBotSpeechMusicDuck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  { awaitFade = false } = {}
) {
  if (!session || session.ending) return false;
  if (!musicPhaseShouldAllowDucking(getMusicPhase(manager, session))) {
    session.botSpeechMusicDucked = false;
    return false;
  }
  clearBotSpeechMusicUnduckTimer(manager, session);
  const music = ensureSessionMusicState(manager, session);
  if (music?.ducked) {
    session.botSpeechMusicDucked = true;
    return true;
  }
  const { targetGain, fadeMs } = resolveMusicDuckingConfig(
    manager,
    settings || session.settingsSnapshot || manager.store.getSettings()
  );
  const duckPromise = manager.musicPlayer?.duck({ targetGain, fadeMs });
  if (music) music.ducked = true;
  session.botSpeechMusicDucked = true;
  if (awaitFade) {
    await duckPromise;
  }
  return true;
}

export function scheduleBotSpeechMusicUnduck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  delayMs = 0
) {
  if (!session || session.ending) return;
  const music = ensureSessionMusicState(manager, session);
  if (!session.botSpeechMusicDucked && !music?.ducked) return;
  clearBotSpeechMusicUnduckTimer(manager, session);
  const normalizedDelayMs = clamp(Math.round(Number(delayMs) || 0), 0, 15_000);
  session.botSpeechMusicUnduckTimer = setTimeout(() => {
    session.botSpeechMusicUnduckTimer = null;
    if (manager.replyManager.hasBufferedTtsPlayback(session) || Boolean(session.botTurnOpen)) {
      scheduleBotSpeechMusicUnduck(manager, session, settings, Math.min(200, normalizedDelayMs || 200));
      return;
    }
    releaseBotSpeechMusicDuck(manager, session, settings).catch((error) => {
      logMusicAction(manager, {
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `voice_music_unduck_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: "bot_speech_unduck_timer"
        }
      });
    });
  }, normalizedDelayMs);
}

export async function releaseBotSpeechMusicDuck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  { force = false } = {}
) {
  if (!session) return false;
  clearBotSpeechMusicUnduckTimer(manager, session);
  const music = ensureSessionMusicState(manager, session);
  const ducked = Boolean(music?.ducked) || Boolean(session.botSpeechMusicDucked);
  if (!ducked) {
    return false;
  }
  session.botSpeechMusicDucked = false;
  if (music) music.ducked = false;
  if (!force && !musicPhaseShouldAllowDucking(getMusicPhase(manager, session))) {
    return false;
  }
  const { fadeMs } = resolveMusicDuckingConfig(
    manager,
    settings || session.settingsSnapshot || manager.store.getSettings()
  );
  manager.musicPlayer?.unduck({ targetGain: 1, fadeMs });
  return true;
}

export function normalizeMusicPlatformToken(
  manager: MusicPlaybackHost,
  value: unknown = "",
  fallback: "youtube" | "soundcloud" | "discord" | "auto" | null = null
) {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (token === "youtube" || token === "soundcloud" || token === "discord" || token === "auto") {
    return token;
  }
  return fallback;
}

export function normalizeMusicSelectionResult(
  manager: MusicPlaybackHost,
  rawResult: Record<string, unknown> | null = null
): MusicSelectionResult | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const id = normalizeInlineText(rawResult.id, 180);
  const title = normalizeInlineText(rawResult.title, 220);
  const artist = normalizeInlineText(rawResult.artist, 220);
  const platform = normalizeMusicPlatformToken(manager, rawResult.platform, null);
  if (!id || !title || !artist || !platform) return null;
  const externalUrl = normalizeInlineText(rawResult.externalUrl || rawResult.url, 260) || null;
  const durationRaw = Number(rawResult.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.floor(durationRaw) : null;
  return {
    id,
    title,
    artist,
    platform,
    externalUrl,
    durationSeconds
  };
}

export function isMusicDisambiguationActive(
  manager: MusicPlaybackHost,
  musicState: VoiceSessionMusicState | null = null
) {
  const music = musicState && typeof musicState === "object" ? musicState : null;
  if (!music) return false;
  const pendingAt = Math.max(0, Number(music.pendingRequestedAt || 0));
  if (!pendingAt) return false;
  const ageMs = Math.max(0, Date.now() - pendingAt);
  if (ageMs > MUSIC_DISAMBIGUATION_TTL_MS) return false;
  return Array.isArray(music.pendingResults) && music.pendingResults.length > 0;
}

export function clearMusicDisambiguationState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.pendingQuery = null;
  music.pendingPlatform = "auto";
  music.pendingAction = "play_now";
  music.pendingResults = [];
  music.pendingRequestedByUserId = null;
  music.pendingRequestedAt = 0;
}

export function setMusicDisambiguationState(manager: MusicPlaybackHost, {
  session,
  query = "",
  platform = "auto",
  action = "play_now",
  results = [],
  requestedByUserId = null
}: MusicDisambiguationPayload = {}) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return null;
  const normalizedResults = (Array.isArray(results) ? results : [])
    .map((entry) => normalizeMusicSelectionResult(manager, entry))
    .filter(Boolean)
    .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
  if (!normalizedResults.length) {
    clearMusicDisambiguationState(manager, session);
    return null;
  }
  music.pendingQuery = normalizeInlineText(query, 120) || null;
  music.pendingPlatform = normalizeMusicPlatformToken(manager, platform, "auto");
  music.pendingAction =
    action === "queue_next" || action === "queue_add"
      ? action
      : "play_now";
  music.pendingResults = normalizedResults;
  music.pendingRequestedByUserId = String(requestedByUserId || "").trim() || null;
  music.pendingRequestedAt = Date.now();
  return music.pendingResults;
}

export function findPendingMusicSelectionById(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  selectedResultId = ""
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music || !isMusicDisambiguationActive(manager, music)) return null;
  const targetId = normalizeInlineText(selectedResultId, 180);
  if (!targetId) return null;
  const normalizedTarget = targetId.toLowerCase();
  return (
    (Array.isArray(music.pendingResults) ? music.pendingResults : []).find((entry) => {
      const entryId = String(entry?.id || "")
        .trim()
        .toLowerCase();
      return Boolean(entryId) && entryId === normalizedTarget;
    }) || null
  );
}

export function getMusicDisambiguationPromptContext(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
): {
  active: true;
  query: string | null;
  platform: "youtube" | "soundcloud" | "discord" | "auto";
  action: "play_now" | "queue_next" | "queue_add";
  requestedByUserId: string | null;
  options: MusicSelectionResult[];
} | null {
  const music = ensureSessionMusicState(manager, session);
  if (!music || !isMusicDisambiguationActive(manager, music)) return null;
  return {
    active: true,
    query: music.pendingQuery || null,
    platform: normalizeMusicPlatformToken(manager, music.pendingPlatform, "auto") || "auto",
    action:
      music.pendingAction === "queue_next" || music.pendingAction === "queue_add"
        ? music.pendingAction
        : "play_now",
    requestedByUserId: music.pendingRequestedByUserId || null,
    options: (Array.isArray(music.pendingResults) ? music.pendingResults : [])
      .map((entry) => normalizeMusicSelectionResult(manager, entry))
      .filter((entry): entry is MusicSelectionResult => Boolean(entry))
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS)
  };
}

export function ensureToolMusicQueueState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  if (!session || typeof session !== "object") return null;
  const current: Record<string, unknown> =
    session.musicQueueState && typeof session.musicQueueState === "object"
      ? session.musicQueueState
      : {};
  const tracks = Array.isArray(current.tracks) ? current.tracks : [];
  const normalizedTracks = tracks
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = normalizeInlineText(entry.id, 180);
      const title = normalizeInlineText(entry.title, 220);
      if (!id || !title) return null;
      return {
        id,
        title,
        artist: normalizeInlineText(entry.artist, 220) || null,
        durationMs: Number.isFinite(Number(entry.durationMs))
          ? Math.max(0, Math.round(Number(entry.durationMs)))
          : null,
        source:
          String(entry.source || "")
              .trim()
              .toLowerCase() === "sc"
              ? "sc"
              : "yt",
        streamUrl: normalizeInlineText(entry.streamUrl, 300) || null,
        platform: normalizeMusicPlatformToken(manager, entry.platform, "youtube") || "youtube",
        externalUrl: normalizeInlineText(entry.externalUrl, 300) || null
      };
    })
    .filter(Boolean);
  const normalizedNowPlayingIndexRaw = Number(current.nowPlayingIndex);
  const normalizedNowPlayingIndex =
    Number.isInteger(normalizedNowPlayingIndexRaw) &&
      normalizedNowPlayingIndexRaw >= 0 &&
      normalizedNowPlayingIndexRaw < normalizedTracks.length
      ? normalizedNowPlayingIndexRaw
      : null;
  const next = {
    guildId: String(session.guildId || "").trim(),
    voiceChannelId: String(session.voiceChannelId || "").trim(),
    tracks: normalizedTracks,
    nowPlayingIndex: normalizedNowPlayingIndex,
    isPaused: Boolean(current.isPaused),
    volume: Number.isFinite(Number(current.volume))
      ? clamp(Number(current.volume), 0, 1)
      : 1
  };
  session.musicQueueState = next;
  return next;
}

// All three music heuristics (stop, pause, skip) require verb + music cue word.
// Bot-name commands ("Clanker, stop") go through the directAddressedToBot → LLM path instead.
export function isLikelyMusicStopPhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_STOP_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

export function isLikelyMusicPausePhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_PAUSE_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

export function isLikelyMusicSkipPhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_SKIP_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

// Only checked when music is paused. Keep this conservative: explicit resume
// verbs are fine, and "play" only counts for current-track phrasings like
// "play it again" or "play this song".
export function isLikelyMusicResumePhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  const normalizedResumeTranscript = normalizedTranscript
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedResumeTranscript) return false;
  if (EN_MUSIC_RESUME_PLAY_CURRENT_RE.test(normalizedResumeTranscript)) return true;
  if (!EN_MUSIC_RESUME_VERB_RE.test(normalizedResumeTranscript)) return false;
  return EN_MUSIC_CUE_RE.test(normalizedResumeTranscript) || EN_MUSIC_RESUME_PRONOUN_RE.test(normalizedResumeTranscript);
}

export function isLikelyMusicPlayPhrase(
  manager: MusicPlaybackHost,
  { transcript = "", settings = null }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  if (!EN_MUSIC_PLAY_VERB_RE.test(normalizedTranscript)) return false;
  if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
  return manager.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings });
}

export function extractMusicPlayQuery(
  manager: MusicPlaybackHost,
  transcript = ""
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return "";

  const quotedMatch = normalizedTranscript.match(/["'“”]([^"'“”]{2,120})["'“”]/);
  if (quotedMatch && quotedMatch[1]) {
    return normalizeInlineText(quotedMatch[1], 120);
  }

  const playMatch = normalizedTranscript.match(EN_MUSIC_PLAY_QUERY_RE);
  const candidate = playMatch?.[1] ? String(playMatch[1]) : "";
  if (!candidate) return "";

  const cleaned = candidate
    .replace(EN_MUSIC_QUERY_TRAILING_NOISE_RE, " ")
    .replace(EN_MUSIC_QUERY_MEDIA_WORD_RE, " ")
    .replace(/[^\w\s'"&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  if (EN_MUSIC_QUERY_EMPTY_RE.test(cleaned)) return "";
  return cleaned.slice(0, 120);
}

export function haltSessionOutputForMusicPlayback(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  reason = "music_playback_started"
) {
  if (!session || session.ending) return;
  manager.replyManager.clearPendingResponse(session);
  // Clear main-process reply state WITHOUT sending stop_playback IPC —
  // the subprocess's handleMusicPlay already resets playback before
  // starting music. Sending stop_playback here would kill the music
  // process that just started.
  manager.maybeClearActiveReplyInterruptionPolicy(session);
  manager.bargeInController.clearBargeInOutputSuppression(session, "music_playback_started");
  if (session.botTurnResetTimer) {
    clearTimeout(session.botTurnResetTimer);
    session.botTurnResetTimer = null;
  }
  session.botTurnOpen = false;
  session.lastRequestedRealtimeUtterance = null;
  session.activeReplyInterruptionPolicy = null;
  manager.deferredActionQueue.clearAllDeferredVoiceActions(session);

  manager.abortActiveInboundCaptures({
    session,
    reason: "music_playback_active"
  });

  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "voice_music_output_halted",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "music_playback_started")
    }
  });
}

export async function requestPlayMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  query = "",
  trackId = null,
  platform = "auto",
  action = "play_now",
  searchResults = null,
  reason = "nl_play_music",
  source = "text_voice_intent",
  mustNotify = true
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const requestText = normalizeInlineText(message?.content || "", 220) || null;

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const playbackProviderConfigured = Boolean(manager.musicPlayback?.isConfigured?.());
  const resolvedPlatform = normalizeMusicPlatformToken(manager, platform, "auto");
  const resolvedQuery = normalizeInlineText(query || extractMusicPlayQuery(manager, message?.content || ""), 120) || "";
  const resolvedTrackId = normalizeInlineText(trackId, 180) || null;
  const normalizedProvidedResults = (Array.isArray(searchResults) ? searchResults : [])
    .map((entry) => normalizeMusicSelectionResult(manager, entry))
    .filter(Boolean)
    .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
  const disambiguationFromPrompt = getMusicDisambiguationPromptContext(manager, session);
  const requestStartedAt = Date.now();

  const requestDisambiguation = async (candidateResults = []) => {
    const options = candidateResults
      .map((entry) => normalizeMusicSelectionResult(manager, entry))
      .filter(Boolean)
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
    if (!options.length) return false;

    setMusicDisambiguationState(manager, {
      session,
      query: resolvedQuery,
      platform: resolvedPlatform,
      action: action === "queue_next" || action === "queue_add" ? action : "play_now",
      results: options,
      requestedByUserId: resolvedUserId
    });
    if (resolvedUserId) {
      beginVoiceCommandSession(session, {
        userId: resolvedUserId,
        domain: "music",
        intent:
          action === "queue_next" || action === "queue_add"
            ? `${action}_disambiguation`
            : "music_disambiguation"
      });
    }

    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId || manager.client.user?.id || null,
      content: "voice_music_disambiguation_required",
      metadata: {
        sessionId: session.id,
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        platform: resolvedPlatform || "auto",
        optionCount: options.length,
        options
      }
    });

    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "disambiguation_required",
      details: {
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        platform: resolvedPlatform || "auto",
        optionCount: options.length,
        options
      },
      mustNotify
    });
    return true;
  };

  let selectedResult = resolvedTrackId ? findPendingMusicSelectionById(manager, session, resolvedTrackId) : null;
  if (!selectedResult && resolvedTrackId) {
    selectedResult =
      normalizedProvidedResults.find((entry) => String(entry.id || "") === resolvedTrackId) ||
      (Array.isArray(disambiguationFromPrompt?.options)
        ? disambiguationFromPrompt.options.find((entry) => String(entry?.id || "") === resolvedTrackId)
        : null) ||
      null;
  }

  if (!resolvedTrackId && normalizedProvidedResults.length > 1) {
    const handled = await requestDisambiguation(normalizedProvidedResults);
    if (handled) return true;
  }
  if (!resolvedTrackId && !selectedResult && normalizedProvidedResults.length === 1) {
    selectedResult = normalizedProvidedResults[0];
  }

  if (!resolvedTrackId && !selectedResult && resolvedQuery && manager.musicSearch?.isConfigured?.()) {
    const resolvedSearchPlatform =
      resolvedPlatform === "youtube" || resolvedPlatform === "soundcloud"
        ? resolvedPlatform
        : "auto";
    const searchStartedAt = Date.now();
    const searchResponse = await manager.musicSearch.search(resolvedQuery, {
      platform: resolvedSearchPlatform,
      limit: MUSIC_DISAMBIGUATION_MAX_RESULTS
    });
    const normalizedSearchResults = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .map((entry) =>
        normalizeMusicSelectionResult(manager, {
          id: entry.id,
          title: entry.title,
          artist: entry.artist,
          platform: entry.platform,
          externalUrl: entry.externalUrl,
          durationSeconds: entry.durationSeconds
        })
      )
      .filter(Boolean)
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
    console.info(
      `[voiceMusic] search complete guildId=${resolvedGuildId} sessionId=${session.id} query=${JSON.stringify(resolvedQuery)} platform=${resolvedPlatform || "auto"} resultCount=${normalizedSearchResults.length} durationMs=${Date.now() - searchStartedAt}`
    );

    if (normalizedSearchResults.length > 1) {
      const handled = await requestDisambiguation(normalizedSearchResults);
      if (handled) return true;
    } else if (normalizedSearchResults.length === 1) {
      selectedResult = normalizedSearchResults[0];
    }
  }

  if (!selectedResult && !playbackProviderConfigured) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "music_provider_unconfigured",
      details: {
        provider: manager.musicPlayback?.provider || "none",
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        requestText
      },
      mustNotify
    });
    return true;
  }

  let playbackQuery = resolvedQuery;
  let playbackTrackId = resolvedTrackId;
  if (selectedResult) {
    const selectedId = String(selectedResult.id || "").trim();
    if (!selectedId) {
      playbackQuery = normalizeInlineText(`${selectedResult.title} ${selectedResult.artist}`, 120) || playbackQuery;
    } else {
      playbackTrackId = selectedId || playbackTrackId;
      if (!playbackQuery) {
        playbackQuery = normalizeInlineText(`${selectedResult.title} ${selectedResult.artist}`, 120);
      }
    }
  }

  const selectedResultPlatform = normalizeMusicPlatformToken(manager, selectedResult?.platform, null);
  const useDiscordStreaming = Boolean(
    selectedResult && (
      selectedResultPlatform === "youtube" ||
      selectedResultPlatform === "soundcloud" ||
      selectedResultPlatform === "discord"
    )
  );

  let playbackResult: { ok: boolean; provider: string; reason: string; message: string; status: number; track: { id: string; title: string; artistNames: string[]; externalUrl: string | null } | null; query: string | null } | null = null;

  if (useDiscordStreaming) {
    const discordResult = await playMusicViaDiscord(manager, session, selectedResult);
    if (!discordResult.ok) {
      logMusicAction(manager, {
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId || manager.client.user?.id || null,
        content: "voice_music_start_failed",
        metadata: {
          sessionId: session.id,
          provider: "discord",
          reason: discordResult.error || "discord_playback_failed",
          source: String(source || "text_voice_intent"),
          query: playbackQuery || null,
          requestedTrackId: selectedResult?.id || null,
          selectedResultId: selectedResult?.id || null,
          selectedResultPlatform: selectedResult?.platform || null,
          error: discordResult.error || null
        }
      });
      await sendOperationalMessage(manager, {
        channel: resolvedChannel,
        settings: resolvedSettings,
        guildId: resolvedGuildId,
        channelId: resolvedChannelId || session.textChannelId || null,
        userId: resolvedUserId || null,
        messageId: message?.id || null,
        event: "voice_music_request",
        reason: discordResult.error || "discord_playback_failed",
        details: {
          source: String(source || "text_voice_intent"),
          query: playbackQuery || null,
          selectedResultId: selectedResult?.id || null,
          selectedResultPlatform: selectedResult?.platform || null,
          provider: "discord",
          error: discordResult.error || null
        },
        mustNotify
      });
      return true;
    }
    playbackResult = {
      ok: true,
      provider: "discord",
      reason: "started",
      message: "playing",
      status: 200,
      track: {
        id: selectedResult.id,
        title: selectedResult.title,
        artistNames: selectedResult.artist ? [selectedResult.artist] : [],
        externalUrl: selectedResult.externalUrl
      },
      query: playbackQuery
    };
  } else {
    const playbackProvider = manager.musicPlayback;
    if (!playbackProvider?.startPlayback) {
      playbackResult = {
        ok: false,
        provider: manager.musicPlayback?.provider || "none",
        reason: "music_provider_unconfigured",
        message: "music playback provider not configured",
        status: 0,
        track: null,
        query: playbackQuery || null
      };
    } else {
      playbackResult = await playbackProvider.startPlayback({
        query: playbackQuery,
        trackId: playbackTrackId
      });
    }
  }
  if (!playbackResult.ok) {
    logMusicAction(manager, {
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId || manager.client.user?.id || null,
      content: "voice_music_start_failed",
      metadata: {
        sessionId: session.id,
        provider: playbackResult.provider,
        reason: playbackResult.reason,
        source: String(source || "text_voice_intent"),
        query: playbackResult.query || playbackQuery || null,
        requestedTrackId: playbackTrackId,
        selectedResultId: selectedResult?.id || null,
        selectedResultPlatform: selectedResult?.platform || null,
        status: Number(playbackResult.status || 0),
        message: playbackResult.message || null
      }
    });
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: playbackResult.reason || "music_playback_failed",
      details: {
        source: String(source || "text_voice_intent"),
        query: playbackResult.query || playbackQuery || null,
        requestedTrackId: playbackTrackId,
        selectedResultId: selectedResult?.id || null,
        selectedResultPlatform: selectedResult?.platform || null,
        provider: playbackResult.provider,
        status: Number(playbackResult.status || 0),
        error: playbackResult.message || null
      },
      mustNotify
    });
    return true;
  }

  if (music) {
    setMusicPhase(manager, session, "playing");
    music.startedAt = Date.now();
    music.stoppedAt = 0;
    music.provider = playbackResult.provider || null;
    music.source = String(source || "text_voice_intent");
    music.lastTrackId = playbackResult.track?.id || null;
    music.lastTrackTitle = playbackResult.track?.title || null;
    music.lastTrackArtists = Array.isArray(playbackResult.track?.artistNames)
      ? playbackResult.track.artistNames
      : [];
    music.lastTrackUrl = playbackResult.track?.externalUrl || null;
    music.lastQuery = playbackResult.query || playbackQuery || null;
    music.lastRequestedByUserId = resolvedUserId || null;
    music.lastRequestText = requestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_play_music");
    clearMusicDisambiguationState(manager, session);
    clearVoiceCommandSession(session);
  }

  haltSessionOutputForMusicPlayback(manager, session, "music_playback_started");
  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: "voice_music_started",
    metadata: {
      sessionId: session.id,
      provider: playbackResult.provider,
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_play_music"),
      query: playbackResult.query || playbackQuery || null,
      requestedTrackId: playbackTrackId,
      selectedResultId: selectedResult?.id || null,
      selectedResultPlatform: selectedResult?.platform || null,
      trackId: playbackResult.track?.id || null,
      trackTitle: playbackResult.track?.title || null,
      trackArtists: playbackResult.track?.artistNames || [],
      trackUrl: playbackResult.track?.externalUrl || null
    }
  });
  await sendOperationalMessage(manager, {
    channel: resolvedChannel,
    settings: resolvedSettings,
    guildId: resolvedGuildId,
    channelId: resolvedChannelId || session.textChannelId || null,
    userId: resolvedUserId || null,
    messageId: message?.id || null,
    event: "voice_music_request",
    reason: "started",
    details: {
      source: String(source || "text_voice_intent"),
      provider: playbackResult.provider,
      query: playbackResult.query || playbackQuery || null,
      requestedTrackId: playbackTrackId,
      selectedResultId: selectedResult?.id || null,
      selectedResultPlatform: selectedResult?.platform || null,
      trackTitle: playbackResult.track?.title || null,
      trackArtists: playbackResult.track?.artistNames || [],
      trackUrl: playbackResult.track?.externalUrl || null
    },
    mustNotify
  });
  console.info(
    `[voiceMusic] request complete guildId=${resolvedGuildId} sessionId=${session.id} provider=${playbackResult.provider} totalMs=${Date.now() - requestStartedAt} query=${JSON.stringify(playbackResult.query || playbackQuery || "")}`
  );
  return true;
}

export async function playMusicViaDiscord(
  manager: MusicPlaybackHost,
  session: VoiceSession,
  track: { id: string; title: string; artist: string; platform: string; externalUrl: string | null }
) {
  if (!session?.guildId) {
    return { ok: false, error: "no session" };
  }

  const guild = manager.client.guilds.cache.get(session.guildId);
  if (!guild) {
    return { ok: false, error: "guild not found" };
  }

  if (!session.voxClient?.isAlive) {
    return { ok: false, error: "not connected to voice" };
  }
  const musicPlayer = manager.musicPlayer;
  if (!musicPlayer?.play) {
    return { ok: false, error: "music player unavailable" };
  }

  const searchPlatform: "youtube" | "soundcloud" =
    track.platform === "soundcloud" ? "soundcloud" : "youtube";
  const searchResult = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    platform: searchPlatform,
    streamUrl: null,
    durationSeconds: null,
    thumbnailUrl: null,
    externalUrl: track.externalUrl || ""
  };

  const result = await musicPlayer.play(searchResult);
  return { ok: result.ok, error: result.error };
}

export async function requestStopMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  reason = "nl_stop_music",
  source = "text_voice_intent",
  requestText = "",
  clearQueue = false,
  mustNotify = true
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const normalizedRequestText = normalizeInlineText(requestText || message?.content || "", 220) || null;

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText: normalizedRequestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const prevPhase = getMusicPhase(manager, session);
  const wasActive = musicPhaseIsActive(prevPhase);
  const playerWasActive = wasActive;

  if (manager.musicPlayer) {
    manager.musicPlayer.stop();
  }

  const playbackResult = manager.musicPlayback?.isConfigured?.()
    ? await manager.musicPlayback.stopPlayback()
    : {
      ok: false,
      provider: manager.musicPlayback?.provider || "none",
      reason: "music_provider_unconfigured",
      message: "music provider not configured",
      status: 0,
      track: null,
      query: null
    };
  const usingDiscordPlayer =
    String(music?.provider || "")
      .trim()
      .toLowerCase() === "discord" || playerWasActive;
  const stopSucceeded = Boolean(playbackResult.ok) || !wasActive || usingDiscordPlayer;
  const resolvedProvider = usingDiscordPlayer
    ? "discord"
    : playbackResult.provider || manager.musicPlayback?.provider || "none";
  const stopResultReason =
    stopSucceeded && !playbackResult.ok
      ? usingDiscordPlayer
        ? "discord_player_stopped"
        : "already_stopped"
      : playbackResult.reason || null;
  if (music) {
    setMusicPhase(manager, session, "idle");
    music.stoppedAt = Date.now();
    if (!music.provider) {
      music.provider = resolvedProvider || null;
    }
    music.source = String(source || "text_voice_intent");
    music.lastRequestedByUserId = resolvedUserId || music.lastRequestedByUserId || null;
    music.lastRequestText = normalizedRequestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_stop_music");
    clearMusicDisambiguationState(manager, session);
  }
  if (clearQueue) {
    clearToolMusicQueueState(manager, session);
  }

  // No-op: subprocess manages its own audio pipeline after music stop.

  logMusicAction(manager, {
    kind: stopSucceeded ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: stopSucceeded ? "voice_music_stopped" : "voice_music_stop_failed",
    metadata: {
      sessionId: session.id,
      provider: resolvedProvider,
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_stop_music"),
      clearedQueue: Boolean(clearQueue),
      stopResultReason,
      status: Number(playbackResult.status || 0),
      error: stopSucceeded ? null : playbackResult.message || null,
      previouslyActive: wasActive,
      requestText: normalizedRequestText
    }
  });

  // When a voice tool triggers stop on already-idle music, suppress the
  // operational text-channel message entirely — the voice AI already
  // responds vocally and a text message like "nothing was playing" breaks
  // continuity.
  const suppressOperationalMessage =
    !wasActive && String(source || "") === "voice_tool_call";

  if (!suppressOperationalMessage) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: stopSucceeded ? (wasActive ? "stopped" : "already_stopped") : playbackResult.reason || "music_stop_failed",
      details: {
        source: String(source || "text_voice_intent"),
        clearedQueue: Boolean(clearQueue),
        provider: resolvedProvider,
        stopResultReason,
        status: Number(playbackResult.status || 0),
        error: stopSucceeded ? null : playbackResult.message || null,
        previouslyActive: wasActive,
        requestText: normalizedRequestText
      },
      mustNotify
    });
  }
  return true;
}

export async function requestPauseMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  reason = "nl_pause_music",
  source = "text_voice_intent",
  requestText = "",
  mustNotify = true
}: {
  message?: MusicTextCommandMessage | null;
  guildId?: string | null;
  channel?: unknown;
  channelId?: string | null;
  requestedByUserId?: string | null;
  settings?: Record<string, unknown> | null;
  reason?: string;
  source?: string;
  requestText?: string;
  mustNotify?: boolean;
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const normalizedRequestText = normalizeInlineText(requestText || message?.content || "", 220) || null;

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText: normalizedRequestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const currentPhase = getMusicPhase(manager, session);
  if (musicPhaseCanPause(currentPhase)) {
    manager.musicPlayer?.pause?.();
  }
  const canPause = musicPhaseCanPause(currentPhase) || currentPhase === "paused" || currentPhase === "paused_wake_word";
  if (!canPause) {
    return await requestStopMusic(manager, {
      message,
      guildId: resolvedGuildId,
      channel: resolvedChannel,
      channelId: resolvedChannelId || session.textChannelId || null,
      requestedByUserId: resolvedUserId,
      settings: resolvedSettings,
      reason: String(reason || "nl_pause_music"),
      source: String(source || "text_voice_intent"),
      requestText: normalizedRequestText || "",
      mustNotify
    });
  }

  if (music) {
    if (!music.provider) {
      music.provider = "discord";
    }
    // Transition to paused — session unlocks so the bot can converse,
    // but musicPhaseCanResume() returns true so /resume works.
    setMusicPhase(manager, session, "paused", "user_pause");
    music.source = String(source || "text_voice_intent");
    music.lastRequestedByUserId = resolvedUserId || music.lastRequestedByUserId || null;
    music.lastRequestText = normalizedRequestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_pause_music");
  }

  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: "voice_music_paused",
    metadata: {
      sessionId: session.id,
      provider: music?.provider || "discord",
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_pause_music"),
      requestText: normalizedRequestText
    }
  });

  await sendOperationalMessage(manager, {
    channel: resolvedChannel,
    settings: resolvedSettings,
    guildId: resolvedGuildId,
    channelId: resolvedChannelId || session.textChannelId || null,
    userId: resolvedUserId || null,
    messageId: message?.id || null,
    event: "voice_music_request",
    reason: "paused",
    details: {
      provider: music?.provider || "discord",
      source: String(source || "text_voice_intent"),
      requestText: normalizedRequestText
    },
    mustNotify
  });
  return true;
}

export async function maybeHandleMusicTextSelectionRequest(manager: MusicPlaybackHost, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session) return false;

  const disambiguation = getMusicDisambiguationPromptContext(manager, session);
  if (!disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
    return false;
  }

  const text = normalizeInlineText(message?.content || "", STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  return await manager.maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings: resolvedSettings,
    userId: message.author?.id || null,
    transcript: text,
    reason: "text_music_disambiguation_selection",
    source: "text_disambiguation_failsafe",
    channel: message.channel || null,
    channelId: message.channelId || session.textChannelId || null,
    messageId: message.id || null,
    mustNotify: true
  });
}

export async function maybeHandleMusicTextStopRequest(manager: MusicPlaybackHost, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session || !isMusicPlaybackActive(manager, session)) return false;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const text = normalizeInlineText(message?.content || "", STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;

  const hasMusicStopCue = isLikelyMusicStopPhrase(manager, {
    transcript: text,
    settings: resolvedSettings
  });
  if (!hasMusicStopCue) return false;

  await manager.requestStopMusic({
    message,
    settings: resolvedSettings,
    reason: "text_music_stop_failsafe",
    source: "text_failsafe",
    requestText: text,
    clearQueue: true,
    mustNotify: true
  });
  return true;
}


export async function maybeHandleMusicPlaybackTurn(manager: MusicPlaybackHost, {
  session,
  settings,
  userId,
  pcmBuffer,
  captureReason = "stream_end",
  source = "voice_turn",
  transcript: preTranscript = undefined as string | undefined
}) {
  if (!session || session.ending) return false;
  if (!isMusicPlaybackActive(manager, session)) return false;
  if (!pcmBuffer?.length && !preTranscript) return true;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();

  // When a bridge transcript is provided, skip the Whisper REST call entirely.
  let normalizedTranscript: string;
  if (preTranscript !== undefined) {
    normalizedTranscript = normalizeInlineText(preTranscript, STT_TRANSCRIPT_MAX_CHARS);
  } else {
    // Fallback: transcribe raw PCM via the file-WAV audio API path when no bridge transcript exists.
    if (!manager.llm?.transcribeAudio) {
      logMusicAction(manager, {
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_music_turn_ignored_no_asr",
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_turn"),
          captureReason: String(captureReason || "stream_end")
        }
      });
      return true;
    }

    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const sampleRateHz = source === "file_asr" ? 24000 : Number(session.realtimeInputSampleRateHz) || 24000;
    const voiceRuntime = getVoiceRuntimeConfig(settings);
    const preferredModel = voiceRuntime.openaiRealtime?.inputTranscriptionModel;
    const primaryModel = String(preferredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const fallbackModel = primaryModel === "gpt-4o-mini-transcribe" ? "whisper-1" : "";

    let transcript = await manager.transcribePcmTurn({
      session,
      userId,
      pcmBuffer,
      model: primaryModel,
      sampleRateHz,
      captureReason,
      traceSource: `voice_music_stop_${String(source || "voice_turn")}`,
      errorPrefix: "voice_music_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_music_transcription_empty",
      emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
      asrLanguage: asrLanguageGuidance.language,
      asrPrompt: asrLanguageGuidance.prompt
    });

    if (!transcript && fallbackModel && fallbackModel !== primaryModel) {
      transcript = await manager.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: fallbackModel,
        sampleRateHz,
        captureReason,
        traceSource: `voice_music_stop_${String(source || "voice_turn")}_fallback`,
        errorPrefix: "voice_music_transcription_fallback_failed",
        emptyTranscriptRuntimeEvent: "voice_music_transcription_empty",
        emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
        suppressEmptyTranscriptLogs: true,
        asrLanguage: asrLanguageGuidance.language,
        asrPrompt: asrLanguageGuidance.prompt
      });
    }

    normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  }
  if (!normalizedTranscript) {
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_turn_ignored_empty_transcript",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcriptSource: preTranscript !== undefined ? "bridge" : "whisper"
      }
    });
    return true;
  }
  const directAddressedToBot = isVoiceTurnAddressedToBot(normalizedTranscript, resolvedSettings);
  const disambiguationResolutionTurn = manager.isMusicDisambiguationResolutionTurn(
    session,
    userId,
    normalizedTranscript
  );
  const handledPendingDisambiguation = await manager.maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings: resolvedSettings,
    userId,
    transcript: normalizedTranscript,
    source: `voice_${String(source || "voice_turn")}`,
    channelId: session.textChannelId || null,
    mustNotify: false
  });
  if (handledPendingDisambiguation) {
    return true;
  }

  // Heuristic-only stop/pause/resume/skip detection — no LLM round-trip.
  // Each requires verb + music cue word (e.g. "stop music", "pause the song",
  // "play the song", "skip track"). Bot-name commands ("Clanker, stop") go
  // through the directAddressedToBot → LLM path instead.
  const currentPhase = getMusicPhase(manager, session);
  const shouldPause = isLikelyMusicPausePhrase(manager, { transcript: normalizedTranscript });
  const shouldStop = !shouldPause && isLikelyMusicStopPhrase(manager, { transcript: normalizedTranscript });
  const shouldResume = !shouldPause && !shouldStop
    && musicPhaseCanResume(currentPhase)
    && isLikelyMusicResumePhrase(manager, { transcript: normalizedTranscript });
  const shouldSkip = !shouldPause && !shouldStop && !shouldResume && isLikelyMusicSkipPhrase(manager, { transcript: normalizedTranscript });
  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId,
    content: "voice_music_stop_check",
    metadata: {
      sessionId: session.id,
      source: String(source || "voice_turn"),
      captureReason: String(captureReason || "stream_end"),
      transcript: normalizedTranscript,
      shouldStop,
      shouldPause,
      shouldResume,
      shouldSkip,
      directAddressedToBot,
      decisionReason: shouldPause
        ? "heuristic_pause"
        : shouldStop
          ? "heuristic_stop"
          : shouldResume
            ? "heuristic_resume"
            : shouldSkip
              ? "heuristic_skip"
              : directAddressedToBot
                ? "direct_address"
                : disambiguationResolutionTurn
                  ? "disambiguation"
                  : "swallowed"
    }
  });

  if (shouldPause) {
    await requestPauseMusic(manager, {
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: userId,
      settings: resolvedSettings,
      reason: "voice_music_pause_phrase",
      source: `voice_${String(source || "voice_turn")}`,
      requestText: normalizedTranscript,
      mustNotify: false
    });
    return true;
  }

  if (shouldStop) {
    await requestStopMusic(manager, {
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: userId,
      settings: resolvedSettings,
      reason: "voice_music_stop_phrase",
      source: `voice_${String(source || "voice_turn")}`,
      requestText: normalizedTranscript,
      clearQueue: true,
      mustNotify: false
    });
    return true;
  }

  if (shouldResume) {
    manager.musicPlayer?.resume?.();
    setMusicPhase(manager, session, "playing");
    haltSessionOutputForMusicPlayback(manager, session, "music_resumed_voice_heuristic");
    const queueState = ensureToolMusicQueueState(manager, session);
    if (queueState) queueState.isPaused = false;
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_resumed",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        reason: "voice_music_resume_phrase",
        requestText: normalizedTranscript
      }
    });
    return true;
  }

  if (shouldSkip) {
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState || queueState.nowPlayingIndex == null) {
      await requestStopMusic(manager, {
        guildId: session.guildId,
        channelId: session.textChannelId,
        requestedByUserId: userId,
        settings: resolvedSettings,
        reason: "voice_music_skip_phrase_no_queue",
        source: `voice_${String(source || "voice_turn")}`,
        requestText: normalizedTranscript,
        mustNotify: false
      });
    } else {
      const nextIndex = queueState.nowPlayingIndex + 1;
      await requestStopMusic(manager, {
        guildId: session.guildId,
        channelId: session.textChannelId,
        requestedByUserId: userId,
        settings: resolvedSettings,
        reason: "voice_music_skip_phrase",
        source: `voice_${String(source || "voice_turn")}`,
        requestText: normalizedTranscript,
        mustNotify: false
      });
      if (nextIndex < queueState.tracks.length) {
        await manager.playVoiceQueueTrackByIndex({ session, settings: resolvedSettings, index: nextIndex });
      } else {
        queueState.nowPlayingIndex = null;
        queueState.isPaused = false;
      }
    }
    return true;
  }

  if (directAddressedToBot || disambiguationResolutionTurn) {
    // Pause music so the output lock releases and the bot can respond.
    if (directAddressedToBot) {
      setMusicPhase(manager, session, "paused_wake_word", "wake_word");
      manager.musicPlayer?.pause?.();
      logMusicAction(manager, {
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_music_paused_for_wake_word",
        metadata: {
          sessionId: session.id,
          transcript: normalizedTranscript,
          source: String(source || "voice_turn")
        }
      });
    }
    return false;
  }

  return true;
}

export async function handleMusicSlashCommand(
  manager: MusicPlaybackHost,
  interaction: ChatInputCommandInteraction,
  settings: Record<string, unknown> | null
) {
  const guild = interaction.guild;
  const user = interaction.user;

  if (!guild) {
    await interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
    return;
  }

  type MusicSlashAction = "play_now" | "queue_add" | "queue_next";

  const formatTrackLabel = (track: { title?: string | null; artist?: string | null } | null | undefined) => {
    const title = String(track?.title || "").trim() || "Unknown track";
    const artist = String(track?.artist || "").trim();
    return artist ? `${title} - ${artist}` : title;
  };

  const formatDisambiguationReply = ({
    query,
    action,
    options
  }: {
    query: string;
    action: MusicSlashAction;
    options: MusicSelectionResult[];
  }) => {
    const actionLabel =
      action === "queue_next"
        ? "queue next"
        : action === "queue_add"
          ? "add to the queue"
          : "play";
    const optionsList = options
      .map((option, index) => `${index + 1}. ${formatTrackLabel(option)}`)
      .join("\n");
    return `Multiple results found for "${query}". Reply with the number to ${actionLabel}:\n${optionsList}`;
  };

  const formatQueueReply = (session: MusicRuntimeSessionLike) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    const musicState = ensureSessionMusicState(manager, session);
    if (!queueState || queueState.tracks.length === 0) {
      const lastTrack = musicState?.lastTrackTitle
        ? formatTrackLabel({
            title: musicState.lastTrackTitle,
            artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null
          })
        : null;
      return lastTrack ? `Queue is empty. Most recent track: ${lastTrack}` : "Queue is empty.";
    }

    const visibleTracks = queueState.tracks.slice(0, 10);
    const lines = visibleTracks.map((track, index) => {
      const prefix = index === queueState.nowPlayingIndex ? "[Now]" : `${index + 1}.`;
      return `${prefix} ${formatTrackLabel(track)}`;
    });
    const hiddenCount = Math.max(0, queueState.tracks.length - visibleTracks.length);
    const phase = getMusicPhase(manager, session);
    const stateLabel =
      phase === "paused" || phase === "paused_wake_word"
        ? "paused"
        : musicPhaseIsActive(phase)
          ? "playing"
          : "idle";
    const extraLine = hiddenCount > 0 ? `...and ${hiddenCount} more track${hiddenCount === 1 ? "" : "s"}.` : null;
    return [
      `Playback: ${stateLabel}`,
      `Queue (${queueState.tracks.length} track${queueState.tracks.length === 1 ? "" : "s"}):`,
      ...lines,
      extraLine
    ]
      .filter(Boolean)
      .join("\n");
  };

  const formatNowPlayingReply = (session: MusicRuntimeSessionLike) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    const nowTrack =
      queueState && queueState.nowPlayingIndex != null
        ? queueState.tracks[queueState.nowPlayingIndex] || null
        : null;
    const musicState = ensureSessionMusicState(manager, session);
    const phase = getMusicPhase(manager, session);
    const stateLabel =
      phase === "paused" || phase === "paused_wake_word"
        ? "Paused"
        : musicPhaseIsActive(phase)
          ? "Playing"
          : "Idle";
    if (nowTrack) {
      const queuedAfter = Math.max(0, queueState.tracks.length - (queueState.nowPlayingIndex ?? 0) - 1);
      return `${stateLabel}: ${formatTrackLabel(nowTrack)}${queuedAfter > 0 ? `\nUp next: ${queuedAfter} queued track${queuedAfter === 1 ? "" : "s"}.` : ""}`;
    }
    if (musicState?.lastTrackTitle) {
      return `${stateLabel}. Most recent track: ${formatTrackLabel({
        title: musicState.lastTrackTitle,
        artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null
      })}`;
    }
    return "Nothing is playing right now.";
  };

  const queueTrackForAction = async ({
    session,
    query,
    selectedTrack,
    action
  }: {
    session: VoiceSession;
    query: string;
    selectedTrack: MusicSelectionResult;
    action: MusicSlashAction;
  }) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState) {
      return { ok: false, reply: "Music queue is unavailable for this voice session." };
    }

    const normalizedPlatform = normalizeMusicPlatformToken(manager, selectedTrack.platform, "youtube") || "youtube";
    const queuedTrack = {
      id: selectedTrack.id,
      title: selectedTrack.title,
      artist: selectedTrack.artist || null,
      durationMs: Number.isFinite(Number(selectedTrack.durationSeconds))
        ? Math.max(0, Math.round(Number(selectedTrack.durationSeconds) * 1000))
        : null,
      source: normalizedPlatform === "soundcloud" ? "sc" : "yt",
      streamUrl: selectedTrack.externalUrl || null,
      platform: normalizedPlatform,
      externalUrl: selectedTrack.externalUrl || null
    };
    const requestedByUserId = user.id;
    const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();

    if (action === "play_now") {
      const trailingTracks = queueState.nowPlayingIndex == null
        ? []
        : queueState.tracks.slice(Math.max(0, queueState.nowPlayingIndex + 1));
      queueState.tracks = [queuedTrack, ...trailingTracks];
      queueState.nowPlayingIndex = 0;
      queueState.isPaused = false;

      await requestPlayMusic(manager, {
        guildId,
        channel: interaction.channel,
        channelId: interaction.channelId,
        requestedByUserId,
        settings: resolvedSettings,
        query,
        trackId: selectedTrack.id,
        searchResults: [selectedTrack],
        reason: "slash_command_music_play",
        source: "slash_command",
        mustNotify: false
      });
      return {
        ok: true,
        reply: `Playing: ${formatTrackLabel(selectedTrack)}`
      };
    }

    const wasEmpty = queueState.tracks.length === 0;
    const insertAt =
      action === "queue_next"
        ? queueState.nowPlayingIndex == null
          ? queueState.tracks.length
          : clamp(queueState.nowPlayingIndex + 1, 0, queueState.tracks.length)
        : queueState.tracks.length;
    queueState.tracks.splice(insertAt, 0, queuedTrack);
    if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
      queueState.nowPlayingIndex = 0;
    }

    const shouldAutoPlay =
      action === "queue_next"
        ? !isMusicPlaybackActive(manager, session) && !queueState.isPaused
        : wasEmpty && !isMusicPlaybackActive(manager, session) && !queueState.isPaused;

    if (shouldAutoPlay) {
      const playIndex =
        action === "queue_next"
          ? queueState.nowPlayingIndex ?? 0
          : queueState.nowPlayingIndex ?? 0;
      await manager.playVoiceQueueTrackByIndex({
        session,
        settings: resolvedSettings,
        index: playIndex
      });
      return {
        ok: true,
        reply: `Queue was idle. Now playing: ${formatTrackLabel(selectedTrack)}`
      };
    }

    return {
      ok: true,
      reply:
        action === "queue_next"
          ? `Queued next: ${formatTrackLabel(selectedTrack)}`
          : `Added to queue: ${formatTrackLabel(selectedTrack)}`
    };
  };

  const runQueryAction = async ({
    session,
    query,
    action
  }: {
    session: VoiceSession;
    query: string;
    action: MusicSlashAction;
  }) => {
    const resolvedQuery = normalizeInlineText(query, 180);
    if (!resolvedQuery) {
      return { ok: false, reply: "A song name or URL is required." };
    }

    const canSearch = Boolean(manager.musicSearch?.isConfigured?.()) && typeof manager.musicSearch?.search === "function";
    if (!canSearch) {
      if (action !== "play_now") {
        return {
          ok: false,
          reply: "Music search is not configured, so queue add/next needs to stay disabled for now."
        };
      }

      await requestPlayMusic(manager, {
        guildId,
        channel: interaction.channel,
        channelId: interaction.channelId,
        requestedByUserId: user.id,
        settings,
        query: resolvedQuery,
        reason: "slash_command_music_play",
        source: "slash_command",
        mustNotify: false
      });

      const updatedSession = manager.sessions.get(guildId);
      const disambiguation = updatedSession
        ? getMusicDisambiguationPromptContext(manager, updatedSession)
        : null;
      if (disambiguation?.active && disambiguation.options?.length > 0) {
        return {
          ok: true,
          reply: formatDisambiguationReply({
            query: disambiguation.query || resolvedQuery,
            action,
            options: disambiguation.options
          })
        };
      }

      return {
        ok: true,
        reply: `Playing: ${resolvedQuery}`
      };
    }

    const searchResponse = await manager.musicSearch.search(resolvedQuery, {
      platform: "auto",
      limit: MUSIC_DISAMBIGUATION_MAX_RESULTS
    });
    const results = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .map((row) =>
        normalizeMusicSelectionResult(manager, {
          id: row.id,
          title: row.title,
          artist: row.artist,
          platform: row.platform,
          externalUrl: row.externalUrl,
          durationSeconds: row.durationSeconds
        })
      )
      .filter((result): result is MusicSelectionResult => Boolean(result))
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);

    if (!results.length) {
      return {
        ok: false,
        reply: `No results found for "${resolvedQuery}".`
      };
    }

    if (results.length > 1) {
      setMusicDisambiguationState(manager, {
        session,
        query: resolvedQuery,
        platform: "auto",
        action,
        results,
        requestedByUserId: user.id
      });
      beginVoiceCommandSession(session, {
        userId: user.id,
        domain: "music",
        intent: action === "play_now" ? "music_disambiguation" : `${action}_disambiguation`
      });
      return {
        ok: true,
        reply: formatDisambiguationReply({
          query: resolvedQuery,
          action,
          options: results
        })
      };
    }

    clearMusicDisambiguationState(manager, session);
    clearVoiceCommandSession(session);
    return await queueTrackForAction({
      session,
      query: resolvedQuery,
      selectedTrack: results[0],
      action
    });
  };

  const guildId = guild.id;
  const session = manager.sessions.get(guildId);
  const subcommand = interaction.options.getSubcommand(true);

  if (!session) {
    await interaction.reply({ content: "No active voice session in this server.", ephemeral: true });
    return;
  }

  if (subcommand === "queue") {
    await interaction.reply(formatQueueReply(session));
    return;
  }

  if (subcommand === "now") {
    await interaction.reply(formatNowPlayingReply(session));
    return;
  }

  if (subcommand === "play" || subcommand === "add" || subcommand === "next") {
    const query = interaction.options.getString("query", true);
    await interaction.deferReply();
    const result = await runQueryAction({
      session,
      query,
      action:
        subcommand === "add"
          ? "queue_add"
          : subcommand === "next"
            ? "queue_next"
            : "play_now"
    });
    await interaction.editReply(result.reply);
    return;
  }

  if (subcommand === "stop") {
    if (!isMusicPlaybackActive(manager, session) && ensureToolMusicQueueState(manager, session)?.tracks.length === 0) {
      await interaction.reply({ content: "Nothing is playing and the queue is empty.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await requestStopMusic(manager, {
      guildId,
      channel: interaction.channel,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_stop",
      source: "slash_command",
      clearQueue: true,
      mustNotify: false
    });
    await interaction.editReply("Music stopped and the queue was cleared.");
    return;
  }

  if (subcommand === "pause") {
    const phase = getMusicPhase(manager, session);
    if (!musicPhaseCanPause(phase)) {
      await interaction.reply({ content: "No music is currently playing.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await requestPauseMusic(manager, {
      guildId,
      channel: interaction.channel,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_pause",
      source: "slash_command",
      mustNotify: false
    });
    await interaction.editReply("Music paused.");
    return;
  }

  if (subcommand === "resume") {
    const phase = getMusicPhase(manager, session);
    if (!musicPhaseCanResume(phase)) {
      await interaction.reply({ content: "No music is currently paused.", ephemeral: true });
      return;
    }
    manager.musicPlayer?.resume();
    setMusicPhase(manager, session, "playing");
    haltSessionOutputForMusicPlayback(manager, session, "music_resumed_slash_command");
    await interaction.reply("Music resumed.");
    return;
  }

  if (subcommand === "skip") {
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState || queueState.nowPlayingIndex == null) {
      await interaction.reply({ content: "No queued track is available to skip.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    const nextIndex = queueState.nowPlayingIndex + 1;
    await requestStopMusic(manager, {
      guildId,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_skip",
      source: "slash_command",
      mustNotify: false
    });
    if (nextIndex < queueState.tracks.length) {
      await manager.playVoiceQueueTrackByIndex({ session, settings, index: nextIndex });
      const nextTrack = queueState.tracks[nextIndex];
      await interaction.editReply(`Skipped. Now playing: ${formatTrackLabel(nextTrack)}`);
    } else {
      queueState.nowPlayingIndex = null;
      queueState.isPaused = false;
      await interaction.editReply("Skipped. Queue finished.");
    }
  }
}
