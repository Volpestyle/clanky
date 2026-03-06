import { ChatInputCommandInteraction } from "discord.js";
import { normalizeInlineText, STT_TRANSCRIPT_MAX_CHARS, isVoiceTurnAddressedToBot, resolveVoiceAsrLanguageGuidance } from "./voiceSessionHelpers.ts";
import { getVoiceRuntimeConfig } from "../settings/agentStack.ts";

import { clamp } from "lodash";

// English-only fallback/fast-path heuristics for obvious music control turns.
// These are convenience shortcuts, not the primary music-command decision logic.
export const EN_MUSIC_STOP_VERB_RE = /\b(?:stop|pause|halt|end|quit|shut\s*off)\b/i;
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

import type {
  MusicSelectionResult,
  MusicDisambiguationPayload,
  MusicTextRequestPayload,
  MusicTextCommandMessage,
  MusicPlaybackPhase,
  MusicPauseReason
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseCanResume,
  musicPhaseCanPause,
  musicPhaseShouldLockOutput
} from "./voiceSessionTypes.ts";
export function ensureSessionMusicState(manager: any, session) {
  void manager;
  if (!session || typeof session !== "object") return null;
  if (session.music && typeof session.music === "object") {
    // Ensure existing music state has the phase field (migration from pre-enum sessions).
    if (!session.music.phase) {
      session.music.phase = session.music.active ? "playing" : "idle";
      session.music.ducked = session.music.ducked ?? false;
      session.music.pauseReason = session.music.pauseReason ?? null;
    }
    return session.music;
  }
  session.music = {
    phase: "idle" as const,
    active: false,
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

export function snapshotMusicRuntimeState(manager: any, session) {
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
export function getMusicPhase(manager: any, session): MusicPlaybackPhase {
  const music = ensureSessionMusicState(manager, session);
  return music?.phase ?? "idle";
}

/**
 * Set the music playback phase and sync the deprecated `active` boolean.
 * ALL music state transitions MUST go through this function.
 */
export function setMusicPhase(
  manager: any,
  session,
  phase: MusicPlaybackPhase,
  pauseReason: MusicPauseReason = null
): void {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.phase = phase;
  music.pauseReason = pauseReason;
  // Sync deprecated boolean for any stragglers during migration
  music.active = musicPhaseIsActive(phase);
}

export function isMusicPlaybackActive(manager: any, session) {
  return musicPhaseIsActive(getMusicPhase(manager, session));
}

export function normalizeMusicPlatformToken(manager: any, value: unknown = "", fallback: "youtube" | "soundcloud" | "discord" | "auto" | null = null) {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (token === "youtube" || token === "soundcloud" || token === "discord" || token === "auto") {
    return token;
  }
  return fallback;
}

export function normalizeMusicSelectionResult(manager: any, rawResult: Record<string, unknown> | null = null): MusicSelectionResult | null {
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

export function isMusicDisambiguationActive(manager: any, musicState = null) {
  const music = musicState && typeof musicState === "object" ? musicState : null;
  if (!music) return false;
  const pendingAt = Math.max(0, Number(music.pendingRequestedAt || 0));
  if (!pendingAt) return false;
  const ageMs = Math.max(0, Date.now() - pendingAt);
  if (ageMs > MUSIC_DISAMBIGUATION_TTL_MS) return false;
  return Array.isArray(music.pendingResults) && music.pendingResults.length > 0;
}

export function clearMusicDisambiguationState(manager: any, session) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.pendingQuery = null;
  music.pendingPlatform = "auto";
  music.pendingAction = "play_now";
  music.pendingResults = [];
  music.pendingRequestedByUserId = null;
  music.pendingRequestedAt = 0;
}

export function setMusicDisambiguationState(manager: any, {
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

export function findPendingMusicSelectionById(manager: any, session, selectedResultId = "") {
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

export function getMusicDisambiguationPromptContext(manager: any, session): {
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

export function ensureToolMusicQueueState(manager: any, session) {
  if (!session || typeof session !== "object") return null;
  const current =
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

export function isLikelyMusicStopPhrase(manager: any, { transcript = "", settings = null } = {}) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  if (!EN_MUSIC_STOP_VERB_RE.test(normalizedTranscript)) return false;
  if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
  if (manager.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings })) return true;
  const tokenCount = normalizedTranscript.split(/\s+/).filter(Boolean).length;
  return tokenCount <= 3;
}

export function isLikelyMusicPlayPhrase(manager: any, { transcript = "", settings = null } = {}) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  if (!EN_MUSIC_PLAY_VERB_RE.test(normalizedTranscript)) return false;
  if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
  return manager.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings });
}

export function extractMusicPlayQuery(manager: any, transcript = "") {
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

export function haltSessionOutputForMusicPlayback(manager: any, session, reason = "music_playback_started") {
  if (!session || session.ending) return;
  manager.clearPendingResponse(session);
  // Clear main-process reply state WITHOUT sending stop_playback IPC —
  // the subprocess's handleMusicPlay already resets playback before
  // starting music. Sending stop_playback here would kill the music
  // process that just started.
  manager.maybeClearActiveReplyInterruptionPolicy(session);
  manager.clearBargeInOutputSuppression(session, "music_playback_started");
  if (session.botTurnResetTimer) {
    clearTimeout(session.botTurnResetTimer);
    session.botTurnResetTimer = null;
  }
  session.botTurnOpen = false;
  session.lastRequestedRealtimeUtterance = null;
  session.activeReplyInterruptionPolicy = null;
  manager.clearAllDeferredVoiceActions(session);

  manager.abortActiveInboundCaptures({
    session,
    reason: "music_playback_active"
  });

  manager.store.logAction({
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

export async function requestPlayMusic(manager: any, {
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
    await manager.sendOperationalMessage({
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
  const resolvedQuery = normalizeInlineText(query || manager.extractMusicPlayQuery(message?.content || ""), 120) || "";
  const resolvedTrackId = normalizeInlineText(trackId, 180) || null;
  const normalizedProvidedResults = (Array.isArray(searchResults) ? searchResults : [])
    .map((entry) => normalizeMusicSelectionResult(manager, entry))
    .filter(Boolean)
    .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
  const disambiguationFromPrompt = manager.getMusicDisambiguationPromptContext(session);
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
      manager.beginVoiceCommandSession({
        session,
        userId: resolvedUserId,
        domain: "music",
        intent:
          action === "queue_next" || action === "queue_add"
            ? `${action}_disambiguation`
            : "music_disambiguation"
      });
    }

    manager.store.logAction({
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

    await manager.sendOperationalMessage({
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
    const searchStartedAt = Date.now();
    const searchResponse = await manager.musicSearch.search(resolvedQuery, {
      platform: resolvedPlatform || "auto",
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
    await manager.sendOperationalMessage({
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
    const discordResult = await manager.playMusicViaDiscord(session, selectedResult);
    if (!discordResult.ok) {
      manager.store.logAction({
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
      await manager.sendOperationalMessage({
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
    playbackResult = await manager.musicPlayback.startPlayback({
      query: playbackQuery,
      trackId: playbackTrackId
    });
  }
  if (!playbackResult.ok) {
    manager.store.logAction({
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
    await manager.sendOperationalMessage({
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
    manager.clearVoiceCommandSession(session);
  }

  manager.haltSessionOutputForMusicPlayback(session, "music_playback_started");
  manager.store.logAction({
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
  await manager.sendOperationalMessage({
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

export async function playMusicViaDiscord(manager: any, session: any, track: { id: string; title: string; artist: string; platform: string; externalUrl: string | null }) {
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

  const searchResult = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    platform: track.platform as "youtube" | "soundcloud",
    streamUrl: null,
    durationSeconds: null,
    thumbnailUrl: null,
    externalUrl: track.externalUrl || ""
  };

  const result = await manager.musicPlayer.play(searchResult);
  return { ok: result.ok, error: result.error };
}

export async function requestStopMusic(manager: any, {
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
    await manager.sendOperationalMessage({
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
    manager.resetToolMusicQueueState(session);
  }

  // No-op: subprocess manages its own audio pipeline after music stop.

  manager.store.logAction({
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
    await manager.sendOperationalMessage({
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

export async function requestPauseMusic(manager: any, {
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
    await manager.sendOperationalMessage({
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
    return await manager.requestStopMusic({
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

  manager.store.logAction({
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

  await manager.sendOperationalMessage({
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

export async function maybeHandleMusicTextSelectionRequest(manager: any, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session) return false;

  const disambiguation = manager.getMusicDisambiguationPromptContext(session);
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

export async function maybeHandleMusicTextStopRequest(manager: any, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session || !manager.isMusicPlaybackActive(session)) return false;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const text = normalizeInlineText(message?.content || "", STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;

  const hasMusicStopCue = manager.isLikelyMusicStopPhrase({
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


export async function maybeHandleMusicPlaybackTurn(manager: any, {
  session,
  settings,
  userId,
  pcmBuffer,
  captureReason = "stream_end",
  source = "voice_turn",
  transcript: preTranscript = undefined as string | undefined
}) {
  if (!session || session.ending) return false;
  if (!manager.isMusicPlaybackActive(session)) return false;
  if (!pcmBuffer?.length && !preTranscript) return true;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();

  // When a bridge transcript is provided, skip the Whisper REST call entirely.
  let normalizedTranscript: string;
  if (preTranscript !== undefined) {
    normalizedTranscript = normalizeInlineText(preTranscript, STT_TRANSCRIPT_MAX_CHARS);
  } else {
    // Fallback: transcribe raw PCM via Whisper (stt_pipeline path or no bridge).
    if (!manager.llm?.transcribeAudio) {
      manager.store.logAction({
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
    const sampleRateHz = source === "stt_pipeline" ? 24000 : Number(session.realtimeInputSampleRateHz) || 24000;
    const voiceRuntime = getVoiceRuntimeConfig(settings);
    const preferredModel = source === "stt_pipeline"
      ? voiceRuntime.legacyVoiceStack?.sttPipeline?.transcriptionModel
      : voiceRuntime.openaiRealtime?.inputTranscriptionModel || voiceRuntime.legacyVoiceStack?.sttPipeline?.transcriptionModel;
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
    manager.store.logAction({
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

  // Heuristic-only stop detection — no LLM round-trip.
  // NOTE: isLikelyMusicStopPhrase uses English-only regex patterns (EN_MUSIC_STOP_VERB_RE,
  // EN_MUSIC_CUE_RE). Supporting other languages requires a dedicated locale-aware filter function.
  const shouldStop = manager.isLikelyMusicStopPhrase({
    transcript: normalizedTranscript,
    settings: resolvedSettings
  });
  manager.store.logAction({
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
      directAddressedToBot,
      decisionReason: shouldStop
        ? "heuristic_stop"
        : directAddressedToBot
          ? "direct_address"
          : disambiguationResolutionTurn
            ? "disambiguation"
            : "swallowed"
    }
  });

  if (!shouldStop) {
    if (directAddressedToBot || disambiguationResolutionTurn) {
      // Pause music so the output lock releases and the bot can respond.
      if (directAddressedToBot) {
        setMusicPhase(manager, session, "paused_wake_word", "wake_word");
        manager.musicPlayer?.pause?.();
        manager.store.logAction({
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

  await manager.requestStopMusic({
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

export async function handleMusicSlashCommand(manager: any, interaction: ChatInputCommandInteraction, settings: Record<string, unknown> | null) {
  const command = interaction.commandName;
  const guild = interaction.guild;
  const user = interaction.user;

  if (!guild) {
    await interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
    return;
  }

  const guildId = guild.id;
  const session = manager.sessions.get(guildId);

  if (command === "play") {
    const query = interaction.options.getString("query", true);
    await interaction.deferReply();
    await manager.requestPlayMusic({
      guildId,
      channel: interaction.channel,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      query,
      reason: "slash_command_play",
      source: "slash_command",
      mustNotify: false
    });

    const updatedSession = manager.sessions.get(guildId);
    if (updatedSession) {
      const disambiguation = manager.getMusicDisambiguationPromptContext(updatedSession);
      if (disambiguation?.active && disambiguation.options?.length > 0) {
        const optionsList = disambiguation.options
          .map((opt, i) => `${i + 1}. **${opt.title}** - ${opt.artist || "Unknown"}`)
          .join("\n");
        await interaction.editReply(
          `Multiple results found for "${disambiguation.query}". Reply with the number to select:\n${optionsList}`
        );
        return;
      }
      const music = ensureSessionMusicState(manager, updatedSession);
      if (musicPhaseIsActive(music?.phase ?? "idle")) {
        const nowPlaying = String(music.lastTrackTitle || "").trim() || query;
        await interaction.editReply(`Playing: ${nowPlaying}`);
        return;
      }
    }

    await interaction.editReply("Could not start music playback.");
  } else if (command === "stop") {
    if (!session || !manager.isMusicPlaybackActive(session)) {
      await interaction.reply({ content: "No music is currently playing.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await manager.requestStopMusic({
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
    await interaction.editReply("Music stopped.");
  } else if (command === "pause") {
    const phase = getMusicPhase(manager, session);
    if (!session || !musicPhaseCanPause(phase)) {
      await interaction.reply({ content: "No music is currently playing.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    await manager.requestPauseMusic({
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
  } else if (command === "resume") {
    const phase = getMusicPhase(manager, session);
    if (!session || !musicPhaseCanResume(phase)) {
      await interaction.reply({ content: "No music is currently playing or paused.", ephemeral: true });
      return;
    }
    manager.musicPlayer?.resume();
    setMusicPhase(manager, session, "playing");
    manager.haltSessionOutputForMusicPlayback(session, "music_resumed_slash_command");
    await interaction.reply("Music resumed.");
  } else if (command === "skip") {
    if (!session || !musicPhaseIsActive(getMusicPhase(manager, session))) {
      await interaction.reply({ content: "No music is currently playing.", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState || queueState.nowPlayingIndex == null) {
      await manager.requestStopMusic({
        guildId,
        channelId: interaction.channelId,
        requestedByUserId: user.id,
        settings,
        reason: "slash_command_skip_without_queue",
        source: "slash_command",
        mustNotify: false
      });
      await interaction.editReply("Skipped. No more tracks in queue.");
      return;
    }
    const nextIndex = queueState.nowPlayingIndex + 1;
    await manager.requestStopMusic({
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
      const title = nextTrack?.title || "next track";
      await interaction.editReply(`Skipped. Now playing: ${title}`);
    } else {
      queueState.nowPlayingIndex = null;
      queueState.isPaused = false;
      await interaction.editReply("Skipped. Queue finished.");
    }
  }
}
