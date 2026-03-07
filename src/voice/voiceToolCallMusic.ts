import { clamp } from "../utils.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import type { MusicSelectionResult, VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceMusicToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
};
type MusicQueueTrack = {
  id: string;
  title: string;
  artist: string;
  durationMs: number | null;
  source: "yt" | "sc";
  streamUrl: string | null;
  platform: MusicSelectionResult["platform"];
  externalUrl: string | null;
};
function isMusicSelectionResult(value: unknown): value is MusicSelectionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.artist === "string" &&
    (candidate.platform === "youtube" ||
      candidate.platform === "soundcloud" ||
      candidate.platform === "discord" ||
      candidate.platform === "auto")
  );
}
function toMusicQueueTrack(track: MusicSelectionResult): MusicQueueTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationMs: Number.isFinite(Number(track.durationSeconds))
      ? Math.max(0, Math.round(Number(track.durationSeconds) * 1000))
      : null,
    source: track.platform === "soundcloud" ? "sc" : "yt",
    streamUrl: track.externalUrl || null,
    platform: track.platform,
    externalUrl: track.externalUrl
  };
}
function resolveMusicCatalogTracks(catalog: Map<string, unknown>, trackIds: string[]) {
  return trackIds
    .map((trackId) => {
      const track = catalog.get(trackId);
      return isMusicSelectionResult(track) ? toMusicQueueTrack(track) : null;
    })
    .filter((entry): entry is MusicQueueTrack => Boolean(entry));
}

export async function executeVoiceMusicSearchTool(
  manager: VoiceToolCallManager,
  { session, args }: VoiceMusicToolOptions
) {
  const query = normalizeInlineText(args?.query, 180);
  if (!query) return { ok: false, tracks: [], error: "query_required" };
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  const searchResponse = await manager.musicSearch.search(query, { platform: "auto", limit: maxResults });
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
    runtimeSession.toolMusicTrackCatalog = catalog;
  }
  const tracks = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
    .slice(0, maxResults)
    .map((row) => {
      const normalized = manager.normalizeMusicSelectionResult({
        id: row.id,
        title: row.title,
        artist: row.artist,
        platform: row.platform,
        externalUrl: row.externalUrl,
        durationSeconds: row.durationSeconds
      });
      if (!normalized) return null;
      catalog.set(normalized.id, normalized);
      return {
        id: normalized.id,
        title: normalized.title,
        artist: normalized.artist,
        durationMs: Number.isFinite(Number(normalized.durationSeconds))
          ? Math.max(0, Math.round(Number(normalized.durationSeconds) * 1000))
          : null,
        source: normalized.platform === "soundcloud" ? "sc" : "yt",
        streamUrl: normalized.externalUrl || null
      };
    })
    .filter(Boolean);

  return { ok: true, query, tracks };
}

export async function executeVoiceMusicQueueAddTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceMusicToolOptions
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  if (!queueState || !runtimeSession) return { ok: false, queue_length: 0, added: [], error: "queue_unavailable" };
  const requestedTrackIds = Array.isArray(args?.tracks)
    ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
    : [];
  if (!requestedTrackIds.length) return { ok: false, queue_length: queueState.tracks.length, added: [], error: "tracks_required" };
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  const resolvedTracks = resolveMusicCatalogTracks(catalog, requestedTrackIds);
  if (!resolvedTracks.length) return { ok: false, queue_length: queueState.tracks.length, added: [], error: "unknown_track_ids" };
  const wasEmpty = queueState.tracks.length === 0;
  const insertAt = typeof args?.position === "number"
    ? clamp(Math.floor(Number(args.position)), 0, queueState.tracks.length)
    : queueState.tracks.length;
  queueState.tracks.splice(insertAt, 0, ...resolvedTracks);
  if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
    queueState.nowPlayingIndex = 0;
  }
  const shouldAutoPlay = wasEmpty && !manager.isMusicPlaybackActive(session) && !queueState.isPaused;
  if (shouldAutoPlay && settings) {
    const playIndex = queueState.nowPlayingIndex ?? 0;
    manager.playVoiceQueueTrackByIndex({ session, settings, index: playIndex }).catch((error) => {
      manager.store.logAction({
        kind: "voice_error",
        guildId: String(session?.guildId || "").trim() || null,
        channelId: String(session?.textChannelId || "").trim() || null,
        userId: manager.client.user?.id || null,
        content: `voice_music_queue_autoplay_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: String(session?.id || "").trim() || null,
          playIndex,
          queueLength: queueState.tracks.length
        }
      });
    });
  }

  return {
    ok: true,
    queue_length: queueState.tracks.length,
    added: resolvedTracks.map((entry) => entry.id),
    auto_playing: shouldAutoPlay,
    queue_state: {
      tracks: queueState.tracks.map((entry) => ({
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
        source: entry.source
      })),
      nowPlayingIndex: queueState.nowPlayingIndex,
      isPaused: queueState.isPaused
    }
  };
}

export async function executeVoiceMusicQueueNextTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceMusicToolOptions
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  if (!queueState || !runtimeSession) return { ok: false, queue_length: 0, added: [], error: "queue_unavailable" };
  const requestedTrackIds = Array.isArray(args?.tracks)
    ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
    : [];
  if (!requestedTrackIds.length) return { ok: false, queue_length: queueState.tracks.length, added: [], error: "tracks_required" };
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  const resolvedTracks = resolveMusicCatalogTracks(catalog, requestedTrackIds);
  if (!resolvedTracks.length) return { ok: false, queue_length: queueState.tracks.length, added: [], error: "unknown_track_ids" };
  const insertAt = queueState.nowPlayingIndex == null
    ? queueState.tracks.length
    : clamp(queueState.nowPlayingIndex + 1, 0, queueState.tracks.length);
  queueState.tracks.splice(insertAt, 0, ...resolvedTracks);
  if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
    queueState.nowPlayingIndex = 0;
  }
  const shouldAutoPlay = !manager.isMusicPlaybackActive(session) && !queueState.isPaused;
  if (shouldAutoPlay && settings) {
    await manager.playVoiceQueueTrackByIndex({ session, settings, index: queueState.nowPlayingIndex ?? 0 });
  }

  return {
    ok: true,
    queue_length: queueState.tracks.length,
    added: resolvedTracks.map((entry) => entry.id),
    inserted_after_index: queueState.nowPlayingIndex,
    auto_playing: shouldAutoPlay,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicPlayNowTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceMusicToolOptions
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  const trackId = normalizeInlineText(args?.track_id, 180);
  if (!queueState || !runtimeSession) return { ok: false, error: "queue_unavailable" };
  if (!trackId) return { ok: false, error: "track_id_required" };

  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  const selectedTrack = catalog.get(trackId);
  if (!isMusicSelectionResult(selectedTrack)) return { ok: false, error: "unknown_track_id" };
  const replacementTrack = toMusicQueueTrack(selectedTrack);
  const trailingTracks = queueState.nowPlayingIndex == null
    ? []
    : queueState.tracks.slice(Math.max(0, queueState.nowPlayingIndex + 1));
  queueState.tracks = [replacementTrack, ...trailingTracks];
  queueState.nowPlayingIndex = 0;
  queueState.isPaused = false;
  const trackInfo = { title: selectedTrack.title, artist: selectedTrack.artist };
  manager.requestPlayMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastOpenAiToolCallerUserId || null,
    settings,
    query: normalizeInlineText(`${selectedTrack.title} ${selectedTrack.artist || ""}`, 120),
    trackId: selectedTrack.id,
    searchResults: [selectedTrack],
    reason: "voice_tool_music_play_now",
    source: "voice_tool_call",
    mustNotify: false
  })
    .then(() => {
      manager.requestRealtimePromptUtterance({
        session,
        prompt: `(system: "${trackInfo.title}" by ${trackInfo.artist} is now playing)`,
        source: "music_now_playing",
        interruptionPolicy: {
          assertive: true,
          scope: "speaker",
          allowedUserId: session?.lastOpenAiToolCallerUserId || null,
          reason: "announcement",
          source: "music_now_playing"
        }
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      manager.requestRealtimePromptUtterance({
        session,
        prompt: `(system: failed to load "${trackInfo.title}" — ${message})`,
        source: "music_play_failed",
        interruptionPolicy: { assertive: true, scope: "none", reason: "announcement", source: "music_play_failed" }
      });
    });
  return {
    ok: true,
    status: "loading",
    track: {
      id: replacementTrack.id,
      title: replacementTrack.title,
      artist: replacementTrack.artist,
      source: replacementTrack.source
    },
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicStopTool(
  manager: VoiceToolCallManager,
  { session, settings }: VoiceMusicToolOptions
) {
  await manager.requestStopMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastOpenAiToolCallerUserId || null,
    settings,
    reason: "voice_tool_music_stop",
    source: "voice_tool_call",
    clearQueue: true,
    mustNotify: false
  });
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicPauseTool(
  manager: VoiceToolCallManager,
  { session, settings }: VoiceMusicToolOptions
) {
  await manager.requestPauseMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastOpenAiToolCallerUserId || null,
    settings,
    reason: "voice_tool_music_pause",
    source: "voice_tool_call",
    mustNotify: false
  });
  const queueState = manager.ensureToolMusicQueueState(session);
  if (queueState) queueState.isPaused = true;
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicResumeTool(
  manager: VoiceToolCallManager,
  { session }: VoiceMusicToolOptions
) {
  manager.musicPlayer?.resume?.();
  manager.setMusicPhase(session, "playing");
  manager.haltSessionOutputForMusicPlayback(session, "music_resumed");
  const queueState = manager.ensureToolMusicQueueState(session);
  if (queueState) queueState.isPaused = false;
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicSkipTool(
  manager: VoiceToolCallManager,
  { session, settings }: VoiceMusicToolOptions
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  if (!queueState || queueState.nowPlayingIndex == null) {
    await manager.requestStopMusic({
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      requestedByUserId: session?.lastOpenAiToolCallerUserId || null,
      settings,
      reason: "voice_tool_music_skip_without_queue",
      source: "voice_tool_call",
      mustNotify: false
    });
    return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
  }
  const nextIndex = queueState.nowPlayingIndex + 1;
  await manager.requestStopMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastOpenAiToolCallerUserId || null,
    settings,
    reason: "voice_tool_music_skip",
    source: "voice_tool_call",
    mustNotify: false
  });
  if (nextIndex < queueState.tracks.length) {
    return manager.playVoiceQueueTrackByIndex({ session, settings, index: nextIndex });
  }
  queueState.nowPlayingIndex = null;
  queueState.isPaused = false;
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicNowPlayingTool(
  manager: VoiceToolCallManager,
  { session }: VoiceMusicToolOptions
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const nowTrack = queueState && queueState.nowPlayingIndex != null
    ? queueState.tracks[queueState.nowPlayingIndex] || null
    : null;
  const musicState = manager.ensureSessionMusicState(session);
  return {
    ok: true,
    now_playing: nowTrack
      ? { ...nowTrack }
      : musicState?.lastTrackTitle
        ? {
            id: musicState.lastTrackId || null,
            title: musicState.lastTrackTitle,
            artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null,
            source: String(musicState.provider || "").trim().toLowerCase() === "discord" ? "yt" : "yt",
            streamUrl: musicState.lastTrackUrl || null
          }
        : null,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}
