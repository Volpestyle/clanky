/**
 * Stream discovery — tracks Go Live streams via gateway dispatch events.
 *
 * The selfbot receives VOICE_STATE_UPDATE, STREAM_CREATE, STREAM_SERVER_UPDATE,
 * and STREAM_DELETE dispatch events on its gateway connection. This module
 * maintains a registry of active Go Live streams and their credentials, and
 * provides helpers for sending STREAM_CREATE (OP18), STREAM_DELETE (OP19),
 * STREAM_WATCH (OP20), and STREAM_SET_PAUSED (OP22).
 *
 * This is the control-plane layer. The media-plane transport (clankvox stream
 * watch connection) is a separate concern built on top of the credentials
 * discovered here.
 */
import type { VoiceSessionGoLiveStreamMap, VoiceSessionGoLiveStreamState } from "../voice/voiceSessionTypes.ts";
import { onRawDispatch, sendGatewayPayload, type GatewayDispatchClientLike } from "./selfbotPatches.ts";

export type StreamDiscoveryClientLike = GatewayDispatchClientLike;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Go Live stream discovered via gateway dispatch. */
export interface GoLiveStream {
  streamKey: string;
  userId: string;
  guildId: string;
  channelId: string;
  /** From STREAM_CREATE — identifies the stream server for media connection. */
  rtcServerId: string | null;
  /** From STREAM_SERVER_UPDATE — stream media endpoint. */
  endpoint: string | null;
  /** From STREAM_SERVER_UPDATE — stream auth token. */
  token: string | null;
  /** When we first learned about this stream. */
  discoveredAt: number;
  /** When STREAM_SERVER_UPDATE arrived with credentials. */
  credentialsReceivedAt: number | null;
}

/** Top-level stream discovery state. */
export interface StreamDiscoveryState {
  /** Active streams keyed by streamKey (e.g. "guild:123:456:789"). */
  streams: Map<string, GoLiveStream>;
  /** Stream key we're currently watching (sent STREAM_WATCH for). */
  watchingStreamKey: string | null;
  /** When we sent the STREAM_WATCH request. */
  watchRequestedAt: number | null;
}

/** Callbacks fired when stream state changes. */
export interface StreamDiscoveryCallbacks {
  /** Fired when VOICE_STATE_UPDATE self_stream=true is detected (early Go Live signal). */
  onGoLiveDetected?: (info: { userId: string; guildId: string; channelId: string }) => void;
  /** Fired when VOICE_STATE_UPDATE self_stream=false is detected before stream deletion arrives. */
  onGoLiveEnded?: (info: { userId: string; guildId: string; channelId: string | null }) => void;
  onStreamDiscovered?: (stream: GoLiveStream) => void;
  onStreamCredentialsReceived?: (stream: GoLiveStream) => void;
  onStreamDeleted?: (stream: GoLiveStream) => void;
  onLog?: (action: string, detail: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Gateway dispatch event shapes (subset of what Discord sends)
// ---------------------------------------------------------------------------

interface VoiceStateUpdateDispatch {
  user_id: string;
  guild_id?: string;
  channel_id?: string | null;
  self_stream?: boolean;
}

interface StreamCreateDispatch {
  stream_key: string;
  rtc_server_id?: string;
  region?: string;
  viewer_ids?: string[];
}

interface StreamServerUpdateDispatch {
  stream_key: string;
  endpoint: string;
  token: string;
}

interface StreamDeleteDispatch {
  stream_key: string;
  reason?: string;
  unavailable?: boolean;
}

/** Subset of GUILD_CREATE dispatch — we only need voice_states. */
interface GuildCreateVoiceState {
  user_id: string;
  channel_id?: string | null;
  self_stream?: boolean;
}

interface GuildCreateDispatch {
  id: string; // guild_id
  voice_states?: GuildCreateVoiceState[];
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function toVoiceStateUpdateDispatch(data: Record<string, unknown>): VoiceStateUpdateDispatch {
  return {
    user_id: String(data.user_id || "").trim(),
    guild_id: normalizeOptionalString(data.guild_id),
    channel_id: normalizeNullableString(data.channel_id),
    self_stream: normalizeOptionalBoolean(data.self_stream)
  };
}

function toStreamCreateDispatch(data: Record<string, unknown>): StreamCreateDispatch {
  return {
    stream_key: String(data.stream_key || "").trim(),
    rtc_server_id: normalizeOptionalString(data.rtc_server_id),
    region: normalizeOptionalString(data.region),
    viewer_ids: normalizeStringList(data.viewer_ids)
  };
}

function toStreamServerUpdateDispatch(data: Record<string, unknown>): StreamServerUpdateDispatch {
  return {
    stream_key: String(data.stream_key || "").trim(),
    endpoint: String(data.endpoint || "").trim(),
    token: String(data.token || "").trim()
  };
}

function toStreamDeleteDispatch(data: Record<string, unknown>): StreamDeleteDispatch {
  return {
    stream_key: String(data.stream_key || "").trim(),
    reason: normalizeOptionalString(data.reason),
    unavailable: normalizeOptionalBoolean(data.unavailable)
  };
}

function toGuildCreateDispatch(data: Record<string, unknown>): GuildCreateDispatch {
  const voiceStatesRaw = Array.isArray(data.voice_states) ? data.voice_states : [];
  const voice_states = voiceStatesRaw
    .filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        user_id: String(row.user_id || "").trim(),
        channel_id: normalizeNullableString(row.channel_id),
        self_stream: normalizeOptionalBoolean(row.self_stream)
      };
    });

  return {
    id: String(data.id || "").trim(),
    voice_states
  };
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function createStreamDiscoveryState(): StreamDiscoveryState {
  return {
    streams: new Map(),
    watchingStreamKey: null,
    watchRequestedAt: null,
  };
}

/** Create default (inactive) Go Live stream state for a voice session. */
export function createGoLiveStreamState(): VoiceSessionGoLiveStreamState {
  return {
    active: false,
    streamKey: null,
    targetUserId: null,
    guildId: null,
    channelId: null,
    rtcServerId: null,
    endpoint: null,
    token: null,
    discoveredAt: 0,
    credentialsReceivedAt: 0,
  };
}

/** Build active Go Live stream state from a discovered stream with credentials. */
export function buildGoLiveStreamStateFromStream(
  stream: GoLiveStream
): VoiceSessionGoLiveStreamState {
  return {
    active: Boolean(stream.endpoint && stream.token && stream.rtcServerId),
    streamKey: stream.streamKey,
    targetUserId: stream.userId,
    guildId: stream.guildId,
    channelId: stream.channelId,
    rtcServerId: stream.rtcServerId,
    endpoint: stream.endpoint,
    token: stream.token,
    discoveredAt: stream.discoveredAt,
    credentialsReceivedAt: stream.credentialsReceivedAt ?? 0,
  };
}

type GoLiveSessionLike = {
  goLiveStream?: VoiceSessionGoLiveStreamState | null;
  goLiveStreams?: VoiceSessionGoLiveStreamMap | null;
  streamWatch?: {
    active?: boolean;
    targetUserId?: string | null;
  } | null;
} | null | undefined;

export function ensureGoLiveStreamsMap(session: GoLiveSessionLike): VoiceSessionGoLiveStreamMap {
  if (!session) return new Map();
  if (!(session.goLiveStreams instanceof Map)) {
    session.goLiveStreams = new Map();
  }
  return session.goLiveStreams;
}

export function listSessionGoLiveStreams(session: GoLiveSessionLike): VoiceSessionGoLiveStreamState[] {
  if (!session) return [];
  if (session.goLiveStreams instanceof Map) {
    return [...session.goLiveStreams.values()];
  }
  const legacy = session.goLiveStream;
  if (!legacy) return [];
  if (!String(legacy.streamKey || legacy.targetUserId || "").trim()) return [];
  return [legacy];
}

function rankGoLiveStreamState(
  stream: VoiceSessionGoLiveStreamState,
  preferredTargetUserId: string | null
): number {
  const normalizedPreferredTargetUserId = String(preferredTargetUserId || "").trim() || null;
  const normalizedTargetUserId = String(stream.targetUserId || "").trim() || null;
  let score = 0;
  if (normalizedPreferredTargetUserId && normalizedTargetUserId === normalizedPreferredTargetUserId) score += 100;
  if (stream.active) score += 10;
  if (stream.credentialsReceivedAt > 0) score += 5;
  if (stream.discoveredAt > 0) score += 1;
  return score;
}

export function syncPrimaryGoLiveStream(
  session: GoLiveSessionLike,
  preferredTargetUserId: string | null = null
): VoiceSessionGoLiveStreamState {
  if (!session) return createGoLiveStreamState();
  const streams = listSessionGoLiveStreams(session);
  if (streams.length <= 0) {
    const empty = createGoLiveStreamState();
    session.goLiveStream = empty;
    return empty;
  }

  const watchTargetUserId =
    session.streamWatch?.active && String(session.streamWatch?.targetUserId || "").trim()
      ? String(session.streamWatch?.targetUserId || "").trim()
      : null;
  const effectivePreferredTargetUserId = watchTargetUserId || String(preferredTargetUserId || "").trim() || null;
  const nextPrimary = [...streams].sort((left, right) => {
    const rankDiff = rankGoLiveStreamState(right, effectivePreferredTargetUserId)
      - rankGoLiveStreamState(left, effectivePreferredTargetUserId);
    if (rankDiff !== 0) return rankDiff;
    const discoveredAtDiff = Number(right.discoveredAt || 0) - Number(left.discoveredAt || 0);
    if (discoveredAtDiff !== 0) return discoveredAtDiff;
    return String(left.targetUserId || "").localeCompare(String(right.targetUserId || ""));
  })[0] || createGoLiveStreamState();
  session.goLiveStream = nextPrimary;
  return nextPrimary;
}

export function upsertSessionGoLiveStream(
  session: GoLiveSessionLike,
  stream: VoiceSessionGoLiveStreamState,
  preferredTargetUserId: string | null = null
): VoiceSessionGoLiveStreamState {
  if (!session) return createGoLiveStreamState();
  const streamKey = String(stream.streamKey || "").trim();
  const targetUserId = String(stream.targetUserId || "").trim();
  const mapKey = streamKey || targetUserId;
  if (!mapKey) return syncPrimaryGoLiveStream(session, preferredTargetUserId);
  const goLiveStreams = ensureGoLiveStreamsMap(session);
  goLiveStreams.set(mapKey, stream);
  return syncPrimaryGoLiveStream(session, preferredTargetUserId || targetUserId || null);
}

export function removeSessionGoLiveStream(
  session: GoLiveSessionLike,
  {
    streamKey = null,
    targetUserId = null
  }: {
    streamKey?: string | null;
    targetUserId?: string | null;
  },
  preferredTargetUserId: string | null = null
): VoiceSessionGoLiveStreamState {
  if (!session) return createGoLiveStreamState();
  const normalizedStreamKey = String(streamKey || "").trim() || null;
  const normalizedTargetUserId = String(targetUserId || "").trim() || null;
  const goLiveStreams = ensureGoLiveStreamsMap(session);
  if (normalizedStreamKey) goLiveStreams.delete(normalizedStreamKey);
  if (normalizedTargetUserId) {
    for (const [mapKey, stream] of goLiveStreams.entries()) {
      if (String(stream.targetUserId || "").trim() === normalizedTargetUserId) {
        goLiveStreams.delete(mapKey);
      }
    }
  }
  return syncPrimaryGoLiveStream(session, preferredTargetUserId);
}

// ---------------------------------------------------------------------------
// Gateway event wiring
// ---------------------------------------------------------------------------

/**
 * Wire up raw gateway dispatch listeners for stream discovery.
 * Call this once after the client is ready.
 *
 * Returns a cleanup function that removes listeners (for teardown).
 */
export function setupStreamDiscovery(
  client: StreamDiscoveryClientLike,
  state: StreamDiscoveryState,
  callbacks: StreamDiscoveryCallbacks = {}
): () => void {
  const detachRawListeners = [
    onRawDispatch(client, "VOICE_STATE_UPDATE", (data) => {
      handleVoiceStateUpdate(state, toVoiceStateUpdateDispatch(data), callbacks);
    }),
    onRawDispatch(client, "STREAM_CREATE", (data) => {
      handleStreamCreate(state, toStreamCreateDispatch(data), callbacks);
    }),
    onRawDispatch(client, "STREAM_SERVER_UPDATE", (data) => {
      handleStreamServerUpdate(state, toStreamServerUpdateDispatch(data), callbacks);
    }),
    onRawDispatch(client, "STREAM_DELETE", (data) => {
      handleStreamDelete(state, toStreamDeleteDispatch(data), callbacks);
    }),

    // GUILD_CREATE fires on initial connect (and full reconnect) with the
    // complete voice_states array. Scan for users already Go Live streaming.
    onRawDispatch(client, "GUILD_CREATE", (data) => {
      handleGuildCreate(state, toGuildCreateDispatch(data), callbacks);
    })
  ];

  return () => {
    for (const detach of detachRawListeners) {
      detach();
    }
    state.streams.clear();
    state.watchingStreamKey = null;
    state.watchRequestedAt = null;
  };
}

// ---------------------------------------------------------------------------
// Dispatch handlers
// ---------------------------------------------------------------------------

/**
 * VOICE_STATE_UPDATE with self_stream indicates a user started/stopped Go Live.
 * We use this as an early signal — STREAM_CREATE follows with full metadata.
 */
function handleVoiceStateUpdate(
  state: StreamDiscoveryState,
  data: VoiceStateUpdateDispatch,
  callbacks: StreamDiscoveryCallbacks
): void {
  const log = callbacks.onLog ?? (() => {});
  if (!data.guild_id || !data.user_id) return;

  if (data.self_stream === true) {
    log("stream_discovery_user_go_live", {
      userId: data.user_id,
      guildId: data.guild_id,
      channelId: data.channel_id ?? null,
    });
    if (data.channel_id) {
      callbacks.onGoLiveDetected?.({
        userId: data.user_id,
        guildId: data.guild_id,
        channelId: data.channel_id,
      });
    }
  } else if (data.self_stream === false) {
    callbacks.onGoLiveEnded?.({
      userId: data.user_id,
      guildId: data.guild_id,
      channelId: data.channel_id ?? null,
    });
    // User stopped Go Live. STREAM_DELETE should follow, but we can
    // proactively mark any matching streams.
    for (const stream of state.streams.values()) {
      if (stream.userId === data.user_id && stream.guildId === data.guild_id) {
        log("stream_discovery_user_go_live_ended", {
          userId: data.user_id,
          guildId: data.guild_id,
          streamKey: stream.streamKey,
        });
      }
    }
  }
}

/**
 * STREAM_CREATE fires when a Go Live stream is created.
 * Contains the stream key, rtc_server_id, and region.
 */
function handleStreamCreate(
  state: StreamDiscoveryState,
  data: StreamCreateDispatch,
  callbacks: StreamDiscoveryCallbacks
): void {
  const log = callbacks.onLog ?? (() => {});
  if (!data.stream_key) return;

  const parsed = parseStreamKey(data.stream_key);
  if (!parsed) {
    log("stream_discovery_invalid_stream_key", { streamKey: data.stream_key });
    return;
  }

  const stream: GoLiveStream = {
    streamKey: data.stream_key,
    userId: parsed.userId,
    guildId: parsed.guildId,
    channelId: parsed.channelId,
    rtcServerId: data.rtc_server_id ?? null,
    endpoint: null,
    token: null,
    discoveredAt: Date.now(),
    credentialsReceivedAt: null,
  };

  state.streams.set(data.stream_key, stream);

  log("stream_discovery_stream_created", {
    streamKey: data.stream_key,
    userId: parsed.userId,
    guildId: parsed.guildId,
    channelId: parsed.channelId,
    rtcServerId: data.rtc_server_id ?? null,
    region: data.region ?? null,
  });

  callbacks.onStreamDiscovered?.(stream);
}

/**
 * STREAM_SERVER_UPDATE fires with the stream media endpoint and token.
 * These are the credentials needed for clankvox to open the stream transport.
 */
function handleStreamServerUpdate(
  state: StreamDiscoveryState,
  data: StreamServerUpdateDispatch,
  callbacks: StreamDiscoveryCallbacks
): void {
  const log = callbacks.onLog ?? (() => {});
  if (!data.stream_key) return;

  const stream = state.streams.get(data.stream_key);
  if (!stream) {
    log("stream_discovery_server_update_no_stream", {
      streamKey: data.stream_key,
    });
    return;
  }

  stream.endpoint = data.endpoint ?? null;
  stream.token = data.token ?? null;
  stream.credentialsReceivedAt = Date.now();

  log("stream_discovery_credentials_received", {
    streamKey: data.stream_key,
    userId: stream.userId,
    endpoint: data.endpoint ? `${data.endpoint.split(".")[0]}...` : null,
    hasToken: Boolean(data.token),
    rtcServerId: stream.rtcServerId,
    latencyMs: stream.discoveredAt ? Date.now() - stream.discoveredAt : null,
  });

  callbacks.onStreamCredentialsReceived?.(stream);
}

/**
 * STREAM_DELETE fires when a Go Live stream ends.
 */
function handleStreamDelete(
  state: StreamDiscoveryState,
  data: StreamDeleteDispatch,
  callbacks: StreamDiscoveryCallbacks
): void {
  const log = callbacks.onLog ?? (() => {});
  if (!data.stream_key) return;

  const stream = state.streams.get(data.stream_key);
  if (!stream) {
    log("stream_discovery_delete_unknown_stream", {
      streamKey: data.stream_key,
    });
    return;
  }

  state.streams.delete(data.stream_key);

  if (state.watchingStreamKey === data.stream_key) {
    state.watchingStreamKey = null;
    state.watchRequestedAt = null;
  }

  log("stream_discovery_stream_deleted", {
    streamKey: data.stream_key,
    userId: stream.userId,
    reason: data.reason ?? null,
    unavailable: data.unavailable ?? null,
    ageMs: Date.now() - stream.discoveredAt,
  });

  callbacks.onStreamDeleted?.(stream);
}

/**
 * GUILD_CREATE contains the full voice_states array for the guild.
 * On connect (or reconnect without RESUME), Discord sends this with all
 * users currently in voice channels. We scan for self_stream=true to
 * detect users who were already Go Live streaming before the bot connected.
 *
 * This closes the cold-start gap: if someone starts streaming before the bot
 * is online, we seed the same provisional state that handleVoiceStateUpdate
 * would have created, so the agent can later decide to watch.
 */
export function handleGuildCreate(
  _state: StreamDiscoveryState,
  data: GuildCreateDispatch,
  callbacks: StreamDiscoveryCallbacks
): void {
  const log = callbacks.onLog ?? (() => {});
  const guildId = String(data.id || "").trim();
  if (!guildId) return;

  const voiceStates = Array.isArray(data.voice_states) ? data.voice_states : [];
  if (voiceStates.length === 0) return;

  const existingStreamers: Array<{ userId: string; guildId: string; channelId: string }> = [];

  for (const vs of voiceStates) {
    if (vs.self_stream !== true) continue;

    const userId = String(vs.user_id || "").trim();
    const channelId = String(vs.channel_id || "").trim();
    if (!userId || !channelId) continue;

    existingStreamers.push({ userId, guildId, channelId });

    log("stream_discovery_existing_streamer_detected", {
      userId,
      guildId,
      channelId,
      source: "guild_create_voice_states",
    });

    // Fire the same callback that a live VOICE_STATE_UPDATE would trigger.
    // This seeds provisional goLiveStream state on the voice session so the
    // agent can later decide to watch via enableWatchStreamForUser().
    callbacks.onGoLiveDetected?.({ userId, guildId, channelId });
  }

  if (existingStreamers.length > 0) {
    log("stream_discovery_guild_create_scan_complete", {
      guildId,
      totalVoiceStates: voiceStates.length,
      existingStreamers: existingStreamers.length,
      streamerUserIds: existingStreamers.map((s) => s.userId),
    });
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Send OP18 STREAM_CREATE to publish our own Go Live stream.
 */
export function requestStreamCreate(
  client: StreamDiscoveryClientLike,
  {
    guildId,
    channelId,
    preferredRegion = null
  }: {
    guildId: string;
    channelId: string;
    preferredRegion?: string | null;
  }
): boolean {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedGuildId || !normalizedChannelId) return false;

  sendGatewayPayload(client, {
    op: 18,
    d: {
      type: "guild",
      guild_id: normalizedGuildId,
      channel_id: normalizedChannelId,
      preferred_region: String(preferredRegion || "").trim() || null,
    },
  });

  return true;
}

/**
 * Send OP19 STREAM_DELETE to stop publishing our own Go Live stream.
 */
export function requestStreamDelete(client: StreamDiscoveryClientLike, streamKey: string): boolean {
  const normalizedStreamKey = String(streamKey || "").trim();
  if (!normalizedStreamKey) return false;

  sendGatewayPayload(client, {
    op: 19,
    d: { stream_key: normalizedStreamKey },
  });

  return true;
}

/**
 * Send OP20 STREAM_WATCH to start watching a Go Live stream.
 * Discord should respond with STREAM_CREATE + STREAM_SERVER_UPDATE containing
 * the credentials we need for the stream transport.
 */
export function requestStreamWatch(
  client: StreamDiscoveryClientLike,
  state: StreamDiscoveryState,
  streamKey: string
): boolean {
  if (!streamKey) return false;

  sendGatewayPayload(client, {
    op: 20,
    d: { stream_key: streamKey },
  });

  state.watchingStreamKey = streamKey;
  state.watchRequestedAt = Date.now();
  return true;
}

/**
 * Send OP22 STREAM_SET_PAUSED to pause/unpause stream receive.
 */
export function setStreamPaused(
  client: StreamDiscoveryClientLike,
  streamKey: string,
  paused: boolean
): void {
  sendGatewayPayload(client, {
    op: 22,
    d: { stream_key: streamKey, paused },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get all currently active Go Live streams. */
export function getActiveStreams(state: StreamDiscoveryState): GoLiveStream[] {
  return [...state.streams.values()];
}

/** Find an active Go Live stream for a specific user. */
export function getStreamByUserId(
  state: StreamDiscoveryState,
  userId: string
): GoLiveStream | null {
  for (const stream of state.streams.values()) {
    if (stream.userId === userId) return stream;
  }
  return null;
}

/** Find an active Go Live stream for a specific user in a specific guild. */
export function getStreamByUserAndGuild(
  state: StreamDiscoveryState,
  userId: string,
  guildId: string
): GoLiveStream | null {
  for (const stream of state.streams.values()) {
    if (stream.userId === userId && stream.guildId === guildId) return stream;
  }
  return null;
}

/** Check if a stream has full credentials (endpoint + token) for media connection. */
export function streamHasCredentials(stream: GoLiveStream): boolean {
  return Boolean(stream.endpoint && stream.token && stream.rtcServerId);
}

/** Get the stream we're currently watching, if any. */
export function getWatchedStream(
  state: StreamDiscoveryState
): GoLiveStream | null {
  if (!state.watchingStreamKey) return null;
  return state.streams.get(state.watchingStreamKey) ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a Discord stream key like "guild:123:456:789" into components. */
export function parseStreamKey(
  streamKey: string
): { guildId: string; channelId: string; userId: string } | null {
  const parts = streamKey.split(":");
  if (parts.length < 4 || parts[0] !== "guild") return null;
  return {
    guildId: parts[1],
    channelId: parts[2],
    userId: parts[3],
  };
}

/** Build a stream key from components. */
export function buildStreamKey(
  guildId: string,
  channelId: string,
  userId: string
): string {
  return `guild:${guildId}:${channelId}:${userId}`;
}
