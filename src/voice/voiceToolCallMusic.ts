import { clamp } from "../utils.ts";
import {
  getMusicResumeStateSnapshot,
  hasKnownMusicResumeState,
  noteMusicResumeRequest,
  setKnownMusicQueuePausedState
} from "./musicResumeState.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import {
  clearBotSpeechMusicUnduckTimer,
  clearPendingMusicReplyHandoff,
  findPendingMusicSelectionById,
  getMusicPhase,
  getMusicDisambiguationPromptContext,
  releaseBotSpeechMusicDuck,
  setMusicPhase,
  setPendingMusicReplyHandoff,
  setMusicDisambiguationState
} from "./voiceMusicPlayback.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";
import { musicPhaseCanResume, musicPhaseIsActive } from "./voiceSessionTypes.ts";
import type { MusicSelectionResult, VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

function hasFullVoiceSessionShape(session: ToolRuntimeSession | null | undefined): session is VoiceSession {
  return Boolean(
    session &&
      typeof session === "object" &&
      typeof session.id === "string" &&
      typeof session.guildId === "string" &&
      typeof session.voiceChannelId === "string" &&
      typeof session.ending === "boolean"
  );
}

type VoiceMusicToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
  signal?: AbortSignal;
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

function logMusicResumeUnavailable(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined,
  source: string,
  phase: string
) {
  const snapshot = getMusicResumeStateSnapshot(session);
  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    userId: session?.lastRealtimeToolCallerUserId || manager.client.user?.id || null,
    content: "voice_music_resume_unavailable",
    metadata: {
      sessionId: session?.id || null,
      source,
      phase,
      hasQueuedTrack: snapshot.hasQueuedTrack,
      hasRememberedTrack: snapshot.hasRememberedTrack,
      queueNowPlayingIndex: snapshot.queueNowPlayingIndex,
      queueTrackId: snapshot.queueTrackId,
      rememberedTrackId: snapshot.rememberedTrackId,
      rememberedTrackUrl: snapshot.rememberedTrackUrl
    }
  });
}

function clearUnavailableMusicResumeState(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined,
  source: string,
  phase: string
) {
  if (session) {
    setMusicPhase(manager, session, "idle");
    clearPendingMusicReplyHandoff(manager, session);
    setKnownMusicQueuePausedState(session, false);
  }
  logMusicResumeUnavailable(manager, session, source, phase);
  return {
    ok: false as const,
    error: "media_resume_unavailable" as const,
    phase: session ? getMusicPhase(manager, session) : "idle",
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

function getToolMusicCatalog(manager: VoiceToolCallManager, session: ToolRuntimeSession | null | undefined) {
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
    runtimeSession.toolMusicTrackCatalog = catalog;
  }
  return {
    runtimeSession,
    catalog
  };
}

function buildMusicToolTrackResult(track: MusicSelectionResult | MusicQueueTrack) {
  const durationMs = "durationSeconds" in track
    ? Number.isFinite(Number(track.durationSeconds))
      ? Math.max(0, Math.round(Number(track.durationSeconds) * 1000))
      : null
    : track.durationMs;
  const platform = "platform" in track ? track.platform : "youtube";
  const externalUrl = "externalUrl" in track ? track.externalUrl : null;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationMs,
    source: platform === "soundcloud" ? "sc" : "yt",
    platform,
    streamUrl: externalUrl || null
  };
}

function buildMusicToolOptionResult(track: MusicSelectionResult) {
  const base = buildMusicToolTrackResult(track);
  return {
    selection_id: track.id,
    ...base
  };
}

function searchVoiceMusicCatalog(
  manager: VoiceToolCallManager,
  {
    session,
    query,
    platform,
    maxResults
  }: {
    session?: ToolRuntimeSession | null;
    query: string;
    platform: "youtube" | "soundcloud" | "auto";
    maxResults: number;
  }
) {
  const { catalog } = getToolMusicCatalog(manager, session);
  return manager.musicSearch.search(query, { platform, limit: maxResults }).then((searchResponse) => {
    const results = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .slice(0, maxResults)
      .map((row) => normalizeMusicSearchResult(manager, row))
      .filter((entry): entry is MusicSelectionResult => Boolean(entry));
    for (const result of results) {
      catalog.set(result.id, result);
    }
    return {
      catalog,
      results
    };
  });
}

function normalizeMusicSearchResult(
  manager: VoiceToolCallManager,
  row: {
    id: string;
    title: string;
    artist: string;
    platform: string;
    externalUrl?: string | null;
    durationSeconds?: number | null;
  }
) {
  return manager.normalizeMusicSelectionResult({
    id: row.id,
    title: row.title,
    artist: row.artist,
    platform: row.platform,
    externalUrl: row.externalUrl,
    durationSeconds: row.durationSeconds
  });
}

function resolveMusicPlaySelection(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined,
  selectionId: string,
  catalog: Map<string, unknown>
) {
  const pendingSelection = findPendingMusicSelectionById(manager, session, selectionId);
  if (pendingSelection) return pendingSelection;
  const catalogSelection = catalog.get(selectionId);
  if (isMusicSelectionResult(catalogSelection)) return catalogSelection;

  const queueState = manager.ensureToolMusicQueueState(session);
  const queuedTrack = Array.isArray(queueState?.tracks)
    ? queueState.tracks.find((track) => String(track?.id || "").trim() === selectionId) || null
    : null;
  if (queuedTrack?.id && queuedTrack.title) {
    return manager.normalizeMusicSelectionResult({
      id: queuedTrack.id,
      title: queuedTrack.title,
      artist: queuedTrack.artist || "",
      platform: queuedTrack.platform || "youtube",
      externalUrl: queuedTrack.externalUrl || null,
      durationSeconds: Number.isFinite(Number(queuedTrack.durationMs))
        ? Math.max(0, Math.round(Number(queuedTrack.durationMs) / 1000))
        : null
    });
  }

  const musicState = manager.ensureSessionMusicState(session);
  if (musicState?.lastTrackId === selectionId && musicState.lastTrackTitle) {
    return manager.normalizeMusicSelectionResult({
      id: musicState.lastTrackId,
      title: musicState.lastTrackTitle,
      artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : "",
      platform: String(musicState.provider || "").trim().toLowerCase() === "soundcloud" ? "soundcloud" : "youtube",
      externalUrl: musicState.lastTrackUrl || null,
      durationSeconds: null
    });
  }

  return null;
}

function startVoicePlaybackRequest(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    query,
    selectedTrack,
    requestReason = "voice_tool_music_play",
    failureLogContent = "voice_tool_music_play_failed",
    resultFieldName = "track"
  }: {
    session: ToolRuntimeSession | null | undefined;
    settings?: VoiceRealtimeToolSettings | null;
    query?: string | null;
    selectedTrack: MusicSelectionResult;
    requestReason?: string;
    failureLogContent?: string;
    resultFieldName?: "track" | "video";
  }
) {
  const queueState = manager.ensureToolMusicQueueState(session);
  if (!queueState) return { ok: false, error: "queue_unavailable" };
  const replacementTrack = toMusicQueueTrack(selectedTrack);
  const trailingTracks = queueState.nowPlayingIndex == null
    ? []
    : queueState.tracks.slice(Math.max(0, queueState.nowPlayingIndex + 1));
  queueState.tracks = [replacementTrack, ...trailingTracks];
  queueState.nowPlayingIndex = 0;
  queueState.isPaused = false;
  const playbackQuery =
    normalizeInlineText(query || `${selectedTrack.title} ${selectedTrack.artist || ""}`, 120) ||
    normalizeInlineText(`${selectedTrack.title} ${selectedTrack.artist || ""}`, 120);

  if (session) {
    manager.setMusicPhase(session, "loading");
  }

  manager.requestPlayMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
    settings,
    query: playbackQuery,
    trackId: selectedTrack.id,
    searchResults: [selectedTrack],
    reason: requestReason,
    source: "voice_tool_call",
    mustNotify: false
  }).catch((error: unknown) => {
    manager.store.logAction({
      kind: "voice_error",
      guildId: String(session?.guildId || "").trim() || null,
      channelId: String(session?.textChannelId || "").trim() || null,
      userId: manager.client.user?.id || null,
      content: `${failureLogContent}: ${String(error instanceof Error ? error.message : error)}`,
      metadata: {
        sessionId: String(session?.id || "").trim() || null,
        trackId: selectedTrack.id
      }
    });
  });

  const resultItem = buildMusicToolTrackResult(replacementTrack);
  return {
    ok: true,
    status: "loading",
    query: playbackQuery || null,
    [resultFieldName]: resultItem,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicSearchTool(
  manager: VoiceToolCallManager,
  { session, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music search cancelled");
  const query = normalizeInlineText(args?.query, 180);
  if (!query) return { ok: false, tracks: [], error: "query_required" };
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  const { results } = await searchVoiceMusicCatalog(manager, {
    session,
    query,
    platform: "auto",
    maxResults
  });
  const tracks = results
    .map((normalized) => buildMusicToolTrackResult(normalized))
    .filter(Boolean);

  return { ok: true, query, tracks };
}

export async function executeVoiceVideoSearchTool(
  manager: VoiceToolCallManager,
  { session, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice video search cancelled");
  const query = normalizeInlineText(args?.query, 180);
  if (!query) return { ok: false, videos: [], error: "query_required" };
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  const { results } = await searchVoiceMusicCatalog(manager, {
    session,
    query,
    platform: "youtube",
    maxResults
  });
  const videos = results
    .map((normalized) => buildMusicToolTrackResult(normalized))
    .filter(Boolean);

  return { ok: true, query, videos };
}

async function resolveVoiceMusicQueueToolTracks(
  manager: VoiceToolCallManager,
  {
    session,
    args,
    action
  }: {
    session?: ToolRuntimeSession | null;
    args?: VoiceToolCallArgs;
    action: "queue_next" | "queue_add";
  }
): Promise<
  | {
    ok: true;
    query: string | null;
    resolvedTracks: MusicQueueTrack[];
  }
  | {
    ok: false;
    response: Record<string, unknown>;
  }
> {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = ensureSessionToolRuntimeState(manager, session);
  if (!queueState || !runtimeSession) {
    return {
      ok: false,
      response: { ok: false, queue_length: 0, added: [], error: "queue_unavailable" }
    };
  }

  const queueLength = queueState.tracks.length;
  const requestedTrackIds = Array.isArray(args?.tracks)
    ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
    : [];
  const query = normalizeInlineText(args?.query, 180);
  const selectionId = normalizeInlineText(args?.selection_id, 180);
  const platformToken = normalizeInlineText(args?.platform, 32)?.toLowerCase();
  const platform =
    platformToken === "youtube" || platformToken === "soundcloud" || platformToken === "auto"
      ? platformToken
      : "auto";
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, unknown>();
  if (!(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
    runtimeSession.toolMusicTrackCatalog = catalog;
  }

  if (requestedTrackIds.length > 0) {
    const resolvedTracks = resolveMusicCatalogTracks(catalog, requestedTrackIds);
    if (!resolvedTracks.length) {
      return {
        ok: false,
        response: { ok: false, queue_length: queueLength, added: [], error: "unknown_track_ids" }
      };
    }
    return { ok: true, query, resolvedTracks };
  }

  if (selectionId) {
    const selectedTrack = resolveMusicPlaySelection(manager, session, selectionId, catalog);
    if (selectedTrack) {
      catalog.set(selectedTrack.id, selectedTrack);
      return {
        ok: true,
        query,
        resolvedTracks: [toMusicQueueTrack(selectedTrack)]
      };
    }
    if (!query) {
      return {
        ok: false,
        response: { ok: false, queue_length: queueLength, added: [], error: "unknown_selection_id" }
      };
    }
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: String(session?.guildId || "").trim() || null,
      channelId: String(session?.textChannelId || "").trim() || null,
      userId: String(session?.lastRealtimeToolCallerUserId || "").trim() || null,
      content: "voice_tool_music_queue_selection_fallback",
      metadata: {
        sessionId: String(session?.id || "").trim() || null,
        action,
        selectionId,
        query,
        reason: "unknown_selection_id"
      }
    });
  }

  if (!query) {
    return {
      ok: false,
      response: { ok: false, queue_length: queueLength, added: [], error: "tracks_or_query_required" }
    };
  }

  const canSearch = Boolean(manager.musicSearch?.isConfigured?.()) && typeof manager.musicSearch?.search === "function";
  if (!canSearch) {
    return {
      ok: false,
      response: {
        ok: false,
        queue_length: queueLength,
        added: [],
        query,
        error: "search_unavailable"
      }
    };
  }

  const searchOutcome = await searchVoiceMusicCatalog(manager, {
    session,
    query,
    platform,
    maxResults
  });
  const results = searchOutcome.results;

  if (!results.length) {
    return {
      ok: false,
      response: {
        ok: false,
        status: "not_found",
        query,
        queue_length: queueLength,
        added: [],
        error: "no_results"
      }
    };
  }

  if (results.length > 1) {
    const requestedByUserId = session?.lastRealtimeToolCallerUserId || null;
    setMusicDisambiguationState(manager, {
      session,
      query,
      platform,
      action,
      results,
      requestedByUserId
    });
    if (requestedByUserId) {
      manager.beginVoiceCommandSession({
        session,
        userId: requestedByUserId,
        domain: "music",
        intent: "music_disambiguation"
      });
    }
    const disambiguation = getMusicDisambiguationPromptContext(manager, session);
    const options = Array.isArray(disambiguation?.options) && disambiguation.options.length > 0
      ? disambiguation.options
      : results;
    return {
      ok: false,
      response: {
        ok: true,
        status: "needs_disambiguation",
        query,
        queue_length: queueLength,
        added: [],
        options: options.map((entry) => buildMusicToolOptionResult(entry)),
        queue_state: manager.buildVoiceQueueStatePayload(session),
        instruction: "Ask the user which option they want, then call this tool again with selection_id set to the exact id of their choice. Do not re-search."
      }
    };
  }

  return {
    ok: true,
    query,
    resolvedTracks: [toMusicQueueTrack(results[0])]
  };
}

export async function executeVoiceMusicQueueAddTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music queue add cancelled");
  const queueState = manager.ensureToolMusicQueueState(session);
  if (!queueState) return { ok: false, queue_length: 0, added: [], error: "queue_unavailable" };
  const resolved = await resolveVoiceMusicQueueToolTracks(manager, {
    session,
    args,
    action: "queue_add"
  });
  if (resolved.ok === false) return resolved.response;
  const { query, resolvedTracks } = resolved;
  const wasEmpty = queueState.tracks.length === 0;
  const rawPos = args?.position;
  const parsedPos = rawPos === "end"
    ? undefined
    : typeof rawPos === "string" && /^\d+$/.test(rawPos)
      ? parseInt(rawPos, 10)
      : typeof rawPos === "number"
        ? rawPos
        : undefined;
  const insertAt = parsedPos != null
    ? clamp(Math.floor(parsedPos), 0, queueState.tracks.length)
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
    status: "queued",
    query,
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
  { session, settings, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music queue next cancelled");
  const queueState = manager.ensureToolMusicQueueState(session);
  if (!queueState) return { ok: false, queue_length: 0, added: [], error: "queue_unavailable" };
  const resolved = await resolveVoiceMusicQueueToolTracks(manager, {
    session,
    args,
    action: "queue_next"
  });
  if (resolved.ok === false) return resolved.response;
  const { query, resolvedTracks } = resolved;
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
    status: "queued_next",
    query,
    queue_length: queueState.tracks.length,
    added: resolvedTracks.map((entry) => entry.id),
    inserted_after_index: queueState.nowPlayingIndex,
    auto_playing: shouldAutoPlay,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicPlayTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music play cancelled");
  const query = normalizeInlineText(args?.query, 180);
  const selectionId = normalizeInlineText(args?.selection_id, 180);
  const platformToken = normalizeInlineText(args?.platform, 32)?.toLowerCase();
  const platform =
    platformToken === "youtube" || platformToken === "soundcloud" || platformToken === "auto"
      ? platformToken
      : "auto";
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  if (!query && !selectionId) return { ok: false, error: "query_or_selection_id_required" };

  const { catalog } = getToolMusicCatalog(manager, session);
  if (selectionId) {
    const selectedTrack = resolveMusicPlaySelection(manager, session, selectionId, catalog);
    if (selectedTrack) {
      catalog.set(selectedTrack.id, selectedTrack);
      return startVoicePlaybackRequest(manager, {
        session,
        settings,
        query,
        selectedTrack
      });
    }
    if (!query) return { ok: false, error: "unknown_selection_id" };
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: String(session?.guildId || "").trim() || null,
      channelId: String(session?.textChannelId || "").trim() || null,
      userId: String(session?.lastRealtimeToolCallerUserId || "").trim() || null,
      content: "voice_tool_music_play_selection_fallback",
      metadata: {
        sessionId: String(session?.id || "").trim() || null,
        selectionId,
        query,
        reason: "unknown_selection_id"
      }
    });
  }

  const canSearch = Boolean(manager.musicSearch?.isConfigured?.()) && typeof manager.musicSearch?.search === "function";
  if (!canSearch) {
    if (session) {
      manager.setMusicPhase(session, "loading");
    }
    manager.requestPlayMusic({
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
      settings,
      query,
      reason: "voice_tool_music_play",
      source: "voice_tool_call",
      mustNotify: false
    }).catch((error: unknown) => {
      manager.store.logAction({
        kind: "voice_error",
        guildId: String(session?.guildId || "").trim() || null,
        channelId: String(session?.textChannelId || "").trim() || null,
        userId: manager.client.user?.id || null,
        content: `voice_tool_music_play_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          sessionId: String(session?.id || "").trim() || null,
          query
        }
      });
    });
    return {
      ok: true,
      status: "loading",
      query,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }

  const { results } = await searchVoiceMusicCatalog(manager, {
    session,
    query,
    platform,
    maxResults
  });

  if (!results.length) {
    return {
      ok: false,
      status: "not_found",
      query,
      error: "no_results"
    };
  }

  if (results.length > 1) {
    const requestedByUserId = session?.lastRealtimeToolCallerUserId || null;
    setMusicDisambiguationState(manager, {
      session,
      query,
      platform,
      action: "play_now",
      results,
      requestedByUserId
    });
    if (requestedByUserId) {
      manager.beginVoiceCommandSession({
        session,
        userId: requestedByUserId,
        domain: "music",
        intent: "music_disambiguation"
      });
    }
    const disambiguation = getMusicDisambiguationPromptContext(manager, session);
    const options = Array.isArray(disambiguation?.options) && disambiguation.options.length > 0
      ? disambiguation.options
      : results;
    return {
      ok: true,
      status: "needs_disambiguation",
      query,
      options: options.map((entry) => buildMusicToolOptionResult(entry)),
      instruction: "Ask the user which option they want, then call this tool again with selection_id set to the exact id of their choice. Do not re-search."
    };
  }

  return startVoicePlaybackRequest(manager, {
    session,
    settings,
    query,
    selectedTrack: results[0]
  });
}

export async function executeVoiceVideoPlayTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice video play cancelled");
  const query = normalizeInlineText(args?.query, 180);
  const selectionId = normalizeInlineText(args?.selection_id, 180);
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  if (!query && !selectionId) return { ok: false, error: "query_or_selection_id_required" };

  const { catalog } = getToolMusicCatalog(manager, session);
  if (selectionId) {
    const selectedTrack = resolveMusicPlaySelection(manager, session, selectionId, catalog);
    if (selectedTrack) {
      catalog.set(selectedTrack.id, selectedTrack);
      if (hasFullVoiceSessionShape(session)) {
        session.streamPublishIntent = { mode: "video" };
      }
      return startVoicePlaybackRequest(manager, {
        session,
        settings,
        query,
        selectedTrack,
        requestReason: "voice_tool_video_play",
        failureLogContent: "voice_tool_video_play_failed",
        resultFieldName: "video"
      });
    }
    if (!query) return { ok: false, error: "unknown_selection_id" };
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: String(session?.guildId || "").trim() || null,
      channelId: String(session?.textChannelId || "").trim() || null,
      userId: String(session?.lastRealtimeToolCallerUserId || "").trim() || null,
      content: "voice_tool_video_play_selection_fallback",
      metadata: {
        sessionId: String(session?.id || "").trim() || null,
        selectionId,
        query,
        reason: "unknown_selection_id"
      }
    });
  }

  const canSearch = Boolean(manager.musicSearch?.isConfigured?.()) && typeof manager.musicSearch?.search === "function";
  if (!canSearch) {
    if (session) {
      manager.setMusicPhase(session, "loading");
    }
    if (hasFullVoiceSessionShape(session)) {
      session.streamPublishIntent = { mode: "video" };
    }
    manager.requestPlayMusic({
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
      settings,
      query,
      reason: "voice_tool_video_play",
      source: "voice_tool_call",
      mustNotify: false
    }).catch((error: unknown) => {
      manager.store.logAction({
        kind: "voice_error",
        guildId: String(session?.guildId || "").trim() || null,
        channelId: String(session?.textChannelId || "").trim() || null,
        userId: manager.client.user?.id || null,
        content: `voice_tool_video_play_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          sessionId: String(session?.id || "").trim() || null,
          query
        }
      });
    });
    return {
      ok: true,
      status: "loading",
      query,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }

  const { results } = await searchVoiceMusicCatalog(manager, {
    session,
    query,
    platform: "youtube",
    maxResults
  });

  if (!results.length) {
    return {
      ok: false,
      status: "not_found",
      query,
      error: "no_results"
    };
  }

  if (results.length > 1) {
    const requestedByUserId = session?.lastRealtimeToolCallerUserId || null;
    setMusicDisambiguationState(manager, {
      session,
      query,
      platform: "youtube",
      action: "play_now",
      results,
      requestedByUserId
    });
    if (requestedByUserId) {
      manager.beginVoiceCommandSession({
        session,
        userId: requestedByUserId,
        domain: "music",
        intent: "music_disambiguation"
      });
    }
    const disambiguation = getMusicDisambiguationPromptContext(manager, session);
    const options = Array.isArray(disambiguation?.options) && disambiguation.options.length > 0
      ? disambiguation.options
      : results;
    return {
      ok: true,
      status: "needs_disambiguation",
      query,
      options: options.map((entry) => buildMusicToolOptionResult(entry)),
      instruction: "Ask the user which option they want, then call this tool again with selection_id set to the exact id of their choice. Do not re-search."
    };
  }

  if (hasFullVoiceSessionShape(session)) {
    session.streamPublishIntent = { mode: "video" };
  }
  return startVoicePlaybackRequest(manager, {
    session,
    settings,
    query,
    selectedTrack: results[0],
    requestReason: "voice_tool_video_play",
    failureLogContent: "voice_tool_video_play_failed",
    resultFieldName: "video"
  });
}

export async function executeVoiceMusicStopTool(
  manager: VoiceToolCallManager,
  { session, settings, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music stop cancelled");
  await manager.requestStopMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
    settings,
    reason: "voice_tool_media_stop",
    source: "voice_tool_call",
    clearQueue: true,
    mustNotify: false
  });
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicPauseTool(
  manager: VoiceToolCallManager,
  { session, settings, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music pause cancelled");
  await manager.requestPauseMusic({
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
    settings,
    reason: "voice_tool_media_pause",
    source: "voice_tool_call",
    mustNotify: false
  });
  const queueState = manager.ensureToolMusicQueueState(session);
  if (queueState) queueState.isPaused = true;
  return { ok: true, queue_state: manager.buildVoiceQueueStatePayload(session) };
}

export async function executeVoiceMusicResumeTool(
  manager: VoiceToolCallManager,
  { session, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music resume cancelled");
  const currentPhase = session ? getMusicPhase(manager, session) : "idle";
  if (!musicPhaseCanResume(currentPhase)) {
    return {
      ok: false,
      error: "music_not_paused",
      phase: currentPhase,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (!hasKnownMusicResumeState(session)) {
    return clearUnavailableMusicResumeState(
      manager,
      session,
      "voice_tool_media_resume",
      currentPhase
    );
  }
  noteMusicResumeRequest(session, "voice_tool_media_resume");
  manager.musicPlayer?.resume?.();
  return {
    ok: true,
    status: "resume_requested",
    phase: session ? getMusicPhase(manager, session) : currentPhase,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicReplyHandoffTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music reply handoff cancelled");
  if (!session) {
    return { ok: false, error: "voice_session_unavailable" };
  }
  const modeToken = normalizeInlineText(args?.mode, 32)?.toLowerCase() || "";
  const mode =
    modeToken === "pause" || modeToken === "duck" || modeToken === "none"
      ? modeToken
      : null;
  if (!mode) {
    return { ok: false, error: "mode_required" };
  }

  const currentPhase = getMusicPhase(manager, session);
  const requestedByUserId = session.lastRealtimeToolCallerUserId || null;

  if (mode === "none") {
    clearPendingMusicReplyHandoff(manager, session);
    return {
      ok: true,
      mode,
      applied: true,
      phase: getMusicPhase(manager, session),
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }

  if (mode === "pause") {
    const canApplyPause =
      currentPhase === "playing" ||
      currentPhase === "loading" ||
      currentPhase === "paused_wake_word";
    if (!canApplyPause) {
      return {
        ok: true,
        mode,
        applied: false,
        reason: "music_not_audible",
        phase: currentPhase,
        queue_state: manager.buildVoiceQueueStatePayload(session)
      };
    }
    if (currentPhase === "playing" || currentPhase === "loading") {
      clearBotSpeechMusicUnduckTimer(manager, session);
      if (hasFullVoiceSessionShape(session)) {
        await releaseBotSpeechMusicDuck(manager, session, settings, { force: true });
      }
      manager.musicPlayer?.pause?.();
      setMusicPhase(manager, session, "paused_wake_word", "wake_word");
      const queueState = manager.ensureToolMusicQueueState(session);
      if (queueState) queueState.isPaused = true;
    }
    setPendingMusicReplyHandoff(manager, session, {
      mode: "pause",
      requestedByUserId,
      source: "voice_tool_media_reply_handoff"
    });
    manager.replyManager.schedulePausedReplyMusicResume(session, 200);
    return {
      ok: true,
      mode,
      applied: true,
      autoRestore: "resume",
      phase: getMusicPhase(manager, session),
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }

  const canApplyDuck =
    currentPhase === "playing" ||
    currentPhase === "loading" ||
    currentPhase === "paused_wake_word";
  if (!canApplyDuck) {
    return {
      ok: true,
      mode,
      applied: false,
      reason: "music_not_audible",
      phase: currentPhase,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (currentPhase === "paused_wake_word" && musicPhaseCanResume(currentPhase)) {
    if (!hasKnownMusicResumeState(session)) {
      const unavailable = clearUnavailableMusicResumeState(
        manager,
        session,
        "voice_tool_media_reply_handoff_duck",
        currentPhase
      );
      return {
        ...unavailable,
        mode,
        applied: false,
        reason: "media_resume_unavailable"
      };
    }
    noteMusicResumeRequest(session, "media_resumed_reply_handoff_duck");
    manager.musicPlayer?.resume?.();
  }
  setPendingMusicReplyHandoff(manager, session, {
    mode: "duck",
    requestedByUserId,
    source: "voice_tool_media_reply_handoff"
  });
  return {
    ok: true,
    mode,
    applied: true,
    autoRestore: "unduck",
    phase: getMusicPhase(manager, session),
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicSkipTool(
  manager: VoiceToolCallManager,
  { session, settings, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music skip cancelled");
  const queueState = manager.ensureToolMusicQueueState(session);
  if (!queueState || queueState.nowPlayingIndex == null) {
    await manager.requestStopMusic({
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
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
    requestedByUserId: session?.lastRealtimeToolCallerUserId || null,
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
  { session, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice music now playing cancelled");
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

export async function executeVoiceStreamVisualizerTool(
  manager: VoiceToolCallManager,
  { session, args, signal }: VoiceMusicToolOptions
) {
  throwIfAborted(signal, "Voice stream visualizer cancelled");
  const currentPhase = session ? getMusicPhase(manager, session) : "idle";
  if (!musicPhaseIsActive(currentPhase)) {
    return {
      ok: false,
      error: "music_not_active",
      reason: "stream_visualizer requires active music playback",
      phase: currentPhase
    };
  }

  const modeArg = normalizeInlineText(args?.mode, 32)?.toLowerCase() || null;
  const result = manager.startVisualizerStreamPublish({
    guildId: String(session?.guildId || "").trim(),
    visualizerMode: modeArg,
    source: "stream_visualizer_tool"
  });

  return {
    ok: Boolean(result?.ok),
    mode: modeArg || "default",
    reason: String(result?.reason || "").trim() || null
  };
}
