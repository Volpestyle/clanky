import { clamp } from "../utils.ts";
import { MUSIC_DISAMBIGUATION_MAX_RESULTS, MUSIC_DISAMBIGUATION_TTL_MS, normalizeInlineText, EN_MUSIC_STOP_VERB_RE, EN_MUSIC_CUE_RE, EN_MUSIC_PLAY_VERB_RE, EN_MUSIC_PLAY_QUERY_RE } from "./voiceSessionManager.ts";
import { STT_TRANSCRIPT_MAX_CHARS } from "./voiceSessionManager.constants.ts";

export function injectMusicMethods(target: any) {

      target.prototype.ensureSessionMusicState = function(session) {
    if (!session || typeof session !== "object") return null;
    const current = session.music && typeof session.music === "object" ? session.music : {};
    const next = {
      active: Boolean(current.active),
      startedAt: Math.max(0, Number(current.startedAt || 0)),
      stoppedAt: Math.max(0, Number(current.stoppedAt || 0)),
      provider: String(current.provider || "").trim() || null,
      source: String(current.source || "").trim() || null,
      lastTrackId: String(current.lastTrackId || "").trim() || null,
      lastTrackTitle: String(current.lastTrackTitle || "").trim() || null,
      lastTrackArtists: Array.isArray(current.lastTrackArtists)
        ? current.lastTrackArtists.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 8)
        : [],
      lastTrackUrl: String(current.lastTrackUrl || "").trim() || null,
      lastQuery: String(current.lastQuery || "").trim() || null,
      lastRequestedByUserId: String(current.lastRequestedByUserId || "").trim() || null,
      lastRequestText: String(current.lastRequestText || "").trim() || null,
      lastCommandAt: Math.max(0, Number(current.lastCommandAt || 0)),
      lastCommandReason: String(current.lastCommandReason || "").trim() || null,
      pendingQuery: String(current.pendingQuery || "").trim() || null,
      pendingPlatform: this.normalizeMusicPlatformToken(current.pendingPlatform, "auto"),
      pendingResults: Array.isArray(current.pendingResults)
        ? current.pendingResults
          .map((entry) => this.normalizeMusicSelectionResult(entry))
          .filter(Boolean)
          .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS)
        : [],
      pendingRequestedByUserId: String(current.pendingRequestedByUserId || "").trim() || null,
      pendingRequestedAt: Math.max(0, Number(current.pendingRequestedAt || 0))
    };
    session.music = next;
    return next;
      };

      target.prototype.snapshotMusicRuntimeState = function(session) {
    const music = this.ensureSessionMusicState(session);
    const queueState = this.ensureToolMusicQueueState(session);
    if (!music) return null;
    return {
      active: Boolean(music.active),
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
      disambiguationActive: this.isMusicDisambiguationActive(music),
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
      };

      target.prototype.isMusicPlaybackActive = function(session) {
    const music = this.ensureSessionMusicState(session);
    return Boolean(music?.active);
      };

      target.prototype.normalizeMusicPlatformToken = function(value: unknown = "", fallback: "youtube" | "soundcloud" | "discord" | "auto" | null = null) {
    const token = String(value || "")
      .trim()
      .toLowerCase();
    if (token === "youtube" || token === "soundcloud" || token === "discord" || token === "auto") {
      return token;
    }
    return fallback;
      };

      target.prototype.isMusicDisambiguationActive = function(musicState = null) {
    const music = musicState && typeof musicState === "object" ? musicState : null;
    if (!music) return false;
    const pendingAt = Math.max(0, Number(music.pendingRequestedAt || 0));
    if (!pendingAt) return false;
    const ageMs = Math.max(0, Date.now() - pendingAt);
    if (ageMs > MUSIC_DISAMBIGUATION_TTL_MS) return false;
    return Array.isArray(music.pendingResults) && music.pendingResults.length > 0;
      };

      target.prototype.clearMusicDisambiguationState = function(session) {
    const music = this.ensureSessionMusicState(session);
    if (!music) return;
    music.pendingQuery = null;
    music.pendingPlatform = "auto";
    music.pendingResults = [];
    music.pendingRequestedByUserId = null;
    music.pendingRequestedAt = 0;
      };

      target.prototype.findPendingMusicSelectionById = function(session, selectedResultId = "") {
    const music = this.ensureSessionMusicState(session);
    if (!music || !this.isMusicDisambiguationActive(music)) return null;
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
      };

      target.prototype.isLikelyMusicStopPhrase = function({ transcript = "", settings = null } = {}) {
    const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    if (!EN_MUSIC_STOP_VERB_RE.test(normalizedTranscript)) return false;
    if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
    if (this.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings })) return true;
    const tokenCount = normalizedTranscript.split(/\s+/).filter(Boolean).length;
    return tokenCount <= 3;
      };

      target.prototype.isLikelyMusicPlayPhrase = function({ transcript = "", settings = null } = {}) {
    const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    if (!EN_MUSIC_PLAY_VERB_RE.test(normalizedTranscript)) return false;
    if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
    return this.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings });
      };

      target.prototype.extractMusicPlayQuery = function(transcript = "") {
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
      .replace(/\b(?:in\s+vc|in\s+voice|in\s+discord|right\s+now|rn|please|plz|for\s+me|for\s+us|thanks?)\b/gi, " ")
      .replace(/\b(?:music|song|songs|track|tracks)\b/gi, " ")
      .replace(/[^\w\s'"&+-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return "";
    if (/^(?:something|anything|some|a|the|please|plz)$/i.test(cleaned)) return "";
    return cleaned.slice(0, 120);
      };

      target.prototype.haltSessionOutputForMusicPlayback = function(session, reason = "music_playback_started") {
    if (!session || session.ending) return;
    this.clearPendingResponse(session);
    this.resetBotAudioPlayback(session);
    this.clearBargeInOutputSuppression(session, "music_playback_started");
    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
      session.botTurnResetTimer = null;
    }
    session.botTurnOpen = false;
    session.pendingBargeInRetry = null;
    session.lastRequestedRealtimeUtterance = null;
    session.activeReplyInterruptionPolicy = null;
    session.pendingDeferredTurns = [];

    this.resetBotAudioPlayback(session);
    this.abortActiveInboundCaptures({
      session,
      reason: "music_playback_active"
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_music_output_halted",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "music_playback_started")
      }
    });
      };

      target.prototype.playMusicViaDiscord = async function(session: any, track: { id: string; title: string; artist: string; platform: string; externalUrl: string | null }) {
    if (!session?.guildId) {
      return { ok: false, error: "no session" };
    }

    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) {
      return { ok: false, error: "guild not found" };
    }

    if (!session.subprocessClient?.isAlive) {
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

    const result = await this.musicPlayer.play(searchResult);
    return { ok: result.ok, error: result.error };
      };

      target.prototype.executeVoiceMusicSearchTool = async function({ session, args }) {
    const query = normalizeInlineText(args?.query, 180);
    if (!query) {
      return {
        ok: false,
        tracks: [],
        error: "query_required"
      };
    }
    const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
    const searchResponse = await this.musicSearch.search(query, {
      platform: "auto",
      limit: maxResults
    });
    const runtimeSession = this.ensureSessionToolRuntimeState(session);
    const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
      ? runtimeSession.toolMusicTrackCatalog
      : new Map();
    if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
      runtimeSession.toolMusicTrackCatalog = catalog;
    }
    const tracks = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .slice(0, maxResults)
      .map((row) => {
        const normalized = this.normalizeMusicSelectionResult({
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

    return {
      ok: true,
      query,
      tracks
    };
      };

      target.prototype.executeVoiceMusicQueueAddTool = async function({ session, args }) {
    const queueState = this.ensureToolMusicQueueState(session);
    const runtimeSession = this.ensureSessionToolRuntimeState(session);
    if (!queueState || !runtimeSession) {
      return {
        ok: false,
        queue_length: 0,
        added: [],
        error: "queue_unavailable"
      };
    }
    const requestedTrackIds = Array.isArray(args?.tracks)
      ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
      : [];
    if (!requestedTrackIds.length) {
      return {
        ok: false,
        queue_length: queueState.tracks.length,
        added: [],
        error: "tracks_required"
      };
    }
    const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map ? runtimeSession.toolMusicTrackCatalog : new Map();
    const resolvedTracks = requestedTrackIds
      .map((trackId) => {
        const fromCatalog = catalog.get(trackId);
        if (!fromCatalog) return null;
        return {
          id: fromCatalog.id,
          title: fromCatalog.title,
          artist: fromCatalog.artist,
          durationMs: Number.isFinite(Number(fromCatalog.durationSeconds))
            ? Math.max(0, Math.round(Number(fromCatalog.durationSeconds) * 1000))
            : null,
          source: fromCatalog.platform === "soundcloud" ? "sc" : "yt",
          streamUrl: fromCatalog.externalUrl || null,
          platform: fromCatalog.platform,
          externalUrl: fromCatalog.externalUrl
        };
      })
      .filter(Boolean);
    if (!resolvedTracks.length) {
      return {
        ok: false,
        queue_length: queueState.tracks.length,
        added: [],
        error: "unknown_track_ids"
      };
    }

    const positionRaw = args?.position;
    const insertAt = typeof positionRaw === "number"
      ? clamp(Math.floor(Number(positionRaw)), 0, queueState.tracks.length)
      : queueState.tracks.length;
    queueState.tracks.splice(insertAt, 0, ...resolvedTracks);
    if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
      queueState.nowPlayingIndex = 0;
    }
    return {
      ok: true,
      queue_length: queueState.tracks.length,
      added: resolvedTracks.map((entry) => entry.id),
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
      };

      target.prototype.playVoiceQueueTrackByIndex = async function({ session, settings, index }) {
    const queueState = this.ensureToolMusicQueueState(session);
    if (!queueState) {
      return {
        ok: false,
        error: "queue_unavailable"
      };
    }
    const normalizedIndex = Number.isInteger(Number(index))
      ? clamp(Math.floor(Number(index)), 0, Math.max(0, queueState.tracks.length - 1))
      : queueState.nowPlayingIndex != null
        ? clamp(Math.floor(Number(queueState.nowPlayingIndex)), 0, Math.max(0, queueState.tracks.length - 1))
        : 0;
    const track = queueState.tracks[normalizedIndex];
    if (!track) {
      return {
        ok: false,
        error: "track_not_found"
      };
    }

    const selectedTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist || "Unknown",
      platform: this.normalizeMusicPlatformToken(track.platform, "youtube") || "youtube",
      externalUrl: track.externalUrl || track.streamUrl || null,
      durationSeconds: Number.isFinite(Number(track.durationMs))
        ? Math.max(0, Math.round(Number(track.durationMs) / 1000))
        : null
    };
    await this.requestPlayMusic({
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: session.lastOpenAiToolCallerUserId || null,
      settings,
      query: normalizeInlineText(`${track.title} ${track.artist || ""}`, 120),
      trackId: track.id,
      searchResults: [selectedTrack],
      reason: "voice_tool_music_play",
      source: "voice_tool_call",
      mustNotify: false
    });
    queueState.nowPlayingIndex = normalizedIndex;
    queueState.isPaused = false;
    return {
      ok: true,
      now_playing: {
        ...track
      },
      index: normalizedIndex
    };
      };

      target.prototype.buildVoiceQueueStatePayload = function(session) {
    const queueState = this.ensureToolMusicQueueState(session);
    if (!queueState) return null;
    return {
      guildId: queueState.guildId,
      voiceChannelId: queueState.voiceChannelId,
      tracks: queueState.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist || null,
        durationMs: track.durationMs,
        source: track.source,
        streamUrl: track.streamUrl || null
      })),
      nowPlayingIndex: queueState.nowPlayingIndex,
      isPaused: queueState.isPaused,
      volume: queueState.volume
    };
      };
}
