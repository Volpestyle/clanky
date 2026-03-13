import type { Client } from "discord.js";
import { getVoiceStreamWatchSettings } from "../settings/agentStack.ts";
import { normalizeStreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";
import {
  buildStreamKey,
  requestStreamCreate,
  requestStreamDelete,
  setStreamPaused,
  streamHasCredentials,
  type GoLiveStream,
  type StreamDiscoveryState
} from "../selfbot/streamDiscovery.ts";
import type { VoiceSessionStreamPublishState } from "./voiceSessionTypes.ts";
import type { StreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";

type StreamPublishSession = {
  id?: string | null;
  guildId?: string | null;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  ending?: boolean;
  music?: {
    provider?: string | null;
    lastTrackUrl?: string | null;
    lastPlaybackUrl?: string | null;
    lastPlaybackResolvedDirectUrl?: boolean;
  } | null;
  streamPublish?: VoiceSessionStreamPublishState | null;
  voxClient?: {
    streamPublishConnect?: (payload: {
      endpoint: string;
      token: string;
      serverId: string;
      sessionId: string;
      userId: string;
      daveChannelId: string;
    }) => void;
    streamPublishDisconnect?: (reason?: string | null) => void;
    streamPublishPlay?: (url: string, resolvedDirectUrl: boolean) => void;
    streamPublishPlayVisualizer?: (
      url: string,
      resolvedDirectUrl: boolean,
      visualizerMode: Exclude<StreamWatchVisualizerMode, "off">
    ) => void;
    streamPublishBrowserStart?: (mimeType?: string) => void;
    streamPublishBrowserFrame?: (payload: {
      mimeType?: string;
      frameBase64: string;
      capturedAtMs?: number;
    }) => void;
    streamPublishStop?: () => void;
    streamPublishPause?: () => void;
    streamPublishResume?: () => void;
    getLastVoiceSessionId?: () => string | null;
  } | null;
};

type StreamPublishManager = {
  client: Client;
  sessions: Map<string, StreamPublishSession>;
  streamDiscovery?: StreamDiscoveryState | null;
  store: {
    getSettings: () => Record<string, unknown> | null;
    logAction: (entry: Record<string, unknown>) => void;
  };
};

const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;
type StreamPublishSourceKind = VoiceSessionStreamPublishState["sourceKind"];
type StreamPublishStartPlayback =
  | { kind: "url"; url: string; resolvedDirectUrl: boolean }
  | {
      kind: "visualizer";
      url: string;
      resolvedDirectUrl: boolean;
      visualizerMode: Exclude<StreamWatchVisualizerMode, "off">;
    }
  | { kind: "browser_session"; mimeType: string };
type StreamPublishSourceResolution =
  | {
      ok: true;
      reason: string;
      sourceKind: StreamPublishSourceKind;
      visualizerMode: StreamWatchVisualizerMode | null;
      sourceKey: string;
      sourceUrl: string | null;
      sourceLabel: string | null;
      playback: StreamPublishStartPlayback;
    }
  | {
      ok: false;
      reason: string;
      sourceKind: StreamPublishSourceKind;
      visualizerMode: StreamWatchVisualizerMode | null;
      sourceKey: string | null;
      sourceUrl: string | null;
      sourceLabel: string | null;
    };

export function createStreamPublishState(): VoiceSessionStreamPublishState {
  return {
    active: false,
    paused: false,
    streamKey: null,
    guildId: null,
    channelId: null,
    rtcServerId: null,
    endpoint: null,
    token: null,
    sourceKind: null,
    visualizerMode: null,
    sourceKey: null,
    sourceUrl: null,
    sourceLabel: null,
    discoveredAt: 0,
    credentialsReceivedAt: 0,
    requestedAt: 0,
    startedAt: 0,
    pausedAt: 0,
    stoppedAt: 0,
    lastVoiceSessionId: null,
    transportStatus: null,
    transportReason: null,
    transportUpdatedAt: 0,
    transportConnectedAt: 0
  };
}

export function ensureStreamPublishState(session: StreamPublishSession | null | undefined) {
  if (!session || typeof session !== "object") return null;
  const current =
    session.streamPublish && typeof session.streamPublish === "object"
      ? session.streamPublish
      : null;
  if (current) return current;
  const next = createStreamPublishState();
  session.streamPublish = next;
  return next;
}

function normalizeSourceUrl(url: unknown) {
  return String(url || "").trim() || null;
}

function getConfiguredVisualizerMode(manager: StreamPublishManager) {
  return normalizeStreamWatchVisualizerMode(
    getVoiceStreamWatchSettings(manager.store.getSettings()).visualizerMode
  );
}

function resolvePublishableMusicSource(
  manager: StreamPublishManager,
  session: StreamPublishSession | null | undefined
): StreamPublishSourceResolution {
  const visualizerMode = getConfiguredVisualizerMode(manager);
  const provider = String(session?.music?.provider || "").trim().toLowerCase();
  const trackUrl = normalizeSourceUrl(session?.music?.lastTrackUrl);
  const playbackUrl = normalizeSourceUrl(session?.music?.lastPlaybackUrl) || trackUrl;
  const playbackResolvedDirectUrl = Boolean(session?.music?.lastPlaybackResolvedDirectUrl);

  if (visualizerMode !== "off") {
    if (!playbackUrl) {
      return {
        ok: false,
        reason: "music_playback_url_missing",
        sourceKind: "music" as const,
        visualizerMode,
        sourceKey: null,
        sourceUrl: null,
        sourceLabel: null
      };
    }

    return {
      ok: true,
      reason: "music_visualizer_ready",
      sourceKind: "music" as const,
      visualizerMode,
      sourceKey: trackUrl || playbackUrl,
      sourceUrl: trackUrl || playbackUrl,
      sourceLabel: trackUrl || playbackUrl,
      playback: {
        kind: "visualizer",
        url: playbackUrl,
        resolvedDirectUrl: playbackResolvedDirectUrl,
        visualizerMode
      }
    };
  }

  if (!trackUrl) {
    return {
      ok: false,
      reason: "music_track_url_missing",
      sourceKind: "music" as const,
      visualizerMode,
      sourceKey: null as string | null,
      sourceUrl: null as string | null,
      sourceLabel: null as string | null
    };
  }

  try {
    const parsed = new URL(trackUrl);
    const isYouTubeHost = YOUTUBE_HOST_RE.test(parsed.hostname);
    if (provider === "youtube" || isYouTubeHost) {
      return {
        ok: true,
        reason: "youtube_track_url_ready",
        sourceKind: "music" as const,
        visualizerMode,
        sourceKey: trackUrl,
        sourceUrl: trackUrl,
        sourceLabel: trackUrl,
        playback: {
          kind: "url" as const,
          url: trackUrl,
          resolvedDirectUrl: false
        }
      };
    }
  } catch {
    // fall through to unsupported result below
  }

  return {
    ok: false,
    reason: "music_stream_publish_only_supports_youtube",
    sourceKind: "music" as const,
    visualizerMode,
    sourceKey: trackUrl,
    sourceUrl: trackUrl,
    sourceLabel: trackUrl
  };
}

function resolveBrowserSessionPublishSource({
  browserSessionId,
  currentUrl = null,
  mimeType = "image/png"
}: {
  browserSessionId: string;
  currentUrl?: string | null;
  mimeType?: string | null;
}): StreamPublishSourceResolution {
  const sourceKey = String(browserSessionId || "").trim();
  if (!sourceKey) {
    return {
      ok: false,
      reason: "browser_session_id_missing",
      sourceKind: "browser_session",
      visualizerMode: null,
      sourceKey: null,
      sourceUrl: normalizeSourceUrl(currentUrl),
      sourceLabel: null
    };
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase() || "image/png";
  if (normalizedMimeType !== "image/png") {
    return {
      ok: false,
      reason: "browser_stream_publish_only_supports_png",
      sourceKind: "browser_session",
      visualizerMode: null,
      sourceKey,
      sourceUrl: normalizeSourceUrl(currentUrl),
      sourceLabel: sourceKey
    };
  }

  const normalizedCurrentUrl = normalizeSourceUrl(currentUrl);
  return {
    ok: true,
    reason: "browser_session_ready",
    sourceKind: "browser_session",
    visualizerMode: null,
    sourceKey,
    sourceUrl: normalizedCurrentUrl,
    sourceLabel: normalizedCurrentUrl || sourceKey,
    playback: {
      kind: "browser_session",
      mimeType: normalizedMimeType
    }
  };
}

function getCurrentVoiceSessionId(manager: StreamPublishManager, session: StreamPublishSession) {
  const clientSessionId =
    session?.voxClient && typeof session.voxClient.getLastVoiceSessionId === "function"
      ? session.voxClient.getLastVoiceSessionId()
      : null;
  const normalizedClientSessionId = String(clientSessionId || "").trim();
  if (normalizedClientSessionId) return normalizedClientSessionId;

  const guild = manager.client.guilds.cache.get(String(session?.guildId || "").trim()) || null;
  const gatewayVoiceSessionId = String(guild?.members?.me?.voice?.sessionId || "").trim();
  return gatewayVoiceSessionId || null;
}

function deriveDaveChannelId(rtcServerId: string | null | undefined) {
  const normalizedRtcServerId = String(rtcServerId || "").trim();
  if (!normalizedRtcServerId) return null;
  try {
    const serverId = BigInt(normalizedRtcServerId);
    if (serverId <= 0n) return null;
    return String(serverId - 1n);
  } catch {
    return null;
  }
}

function getExpectedSelfStreamKey(manager: StreamPublishManager, session: StreamPublishSession) {
  const guildId = String(session?.guildId || "").trim();
  const channelId = String(session?.voiceChannelId || "").trim();
  const userId = String(manager.client.user?.id || "").trim();
  if (!guildId || !channelId || !userId) return null;
  return buildStreamKey(guildId, channelId, userId);
}

function getStreamDiscoveryState(manager: StreamPublishManager) {
  const state = manager.streamDiscovery;
  if (!state || typeof state !== "object") return null;
  return state.streams instanceof Map ? state : null;
}

function updateTransportState(
  session: StreamPublishSession,
  {
    streamKey,
    guildId,
    channelId,
    rtcServerId,
    endpoint,
    token,
    sourceKind,
    visualizerMode,
    sourceKey,
    sourceUrl,
    sourceLabel,
    discoveredAt,
    credentialsReceivedAt,
    requestedAt,
    startedAt,
    pausedAt,
    stoppedAt,
    lastVoiceSessionId,
    transportStatus,
    transportReason,
    transportConnectedAt,
    active,
    paused
  }: Partial<VoiceSessionStreamPublishState> = {}
) {
  const state = ensureStreamPublishState(session);
  if (!state) return null;
  const now = Date.now();

  if (streamKey !== undefined) state.streamKey = String(streamKey || "").trim() || null;
  if (guildId !== undefined) state.guildId = String(guildId || "").trim() || null;
  if (channelId !== undefined) state.channelId = String(channelId || "").trim() || null;
  if (rtcServerId !== undefined) state.rtcServerId = String(rtcServerId || "").trim() || null;
  if (endpoint !== undefined) state.endpoint = String(endpoint || "").trim() || null;
  if (token !== undefined) state.token = String(token || "").trim() || null;
  if (sourceKind !== undefined) {
    state.sourceKind = sourceKind === "music" || sourceKind === "browser_session" ? sourceKind : null;
  }
  if (visualizerMode !== undefined) {
    state.visualizerMode =
      visualizerMode === null ? null : normalizeStreamWatchVisualizerMode(visualizerMode);
  }
  if (sourceKey !== undefined) state.sourceKey = String(sourceKey || "").trim() || null;
  if (sourceUrl !== undefined) state.sourceUrl = normalizeSourceUrl(sourceUrl);
  if (sourceLabel !== undefined) state.sourceLabel = String(sourceLabel || "").trim() || null;
  if (discoveredAt !== undefined) state.discoveredAt = Math.max(0, Number(discoveredAt) || 0);
  if (credentialsReceivedAt !== undefined) {
    state.credentialsReceivedAt = Math.max(0, Number(credentialsReceivedAt) || 0);
  }
  if (requestedAt !== undefined) state.requestedAt = Math.max(0, Number(requestedAt) || 0);
  if (startedAt !== undefined) state.startedAt = Math.max(0, Number(startedAt) || 0);
  if (pausedAt !== undefined) state.pausedAt = Math.max(0, Number(pausedAt) || 0);
  if (stoppedAt !== undefined) state.stoppedAt = Math.max(0, Number(stoppedAt) || 0);
  if (lastVoiceSessionId !== undefined) {
    state.lastVoiceSessionId = String(lastVoiceSessionId || "").trim() || null;
  }
  if (transportStatus !== undefined) {
    state.transportStatus = String(transportStatus || "").trim() || null;
    state.transportUpdatedAt = now;
  }
  if (transportReason !== undefined) {
    state.transportReason = String(transportReason || "").trim() || null;
  }
  if (transportConnectedAt !== undefined) {
    state.transportConnectedAt = Math.max(0, Number(transportConnectedAt) || 0);
  }
  if (active !== undefined) state.active = Boolean(active);
  if (paused !== undefined) state.paused = Boolean(paused);

  return state;
}

function transportStatusHasExistingStreamControlPlane(status: string | null | undefined) {
  switch (String(status || "").trim()) {
    case "stream_requested":
    case "waiting_for_credentials":
    case "waiting_for_voice_session":
    case "invalid_dave_channel":
    case "transport_unavailable":
    case "connect_requested":
    case "connecting":
    case "ready":
    case "paused":
    case "resume_requested":
      return true;
    default:
      return false;
  }
}

function transportStatusNeedsDiscoveredStreamConnect(status: string | null | undefined) {
  switch (String(status || "").trim()) {
    case "":
    case "stream_requested":
    case "waiting_for_credentials":
    case "waiting_for_voice_session":
    case "invalid_dave_channel":
    case "transport_unavailable":
    case "stream_create_failed":
      return true;
    default:
      return false;
  }
}

function connectStreamPublishTransport(
  manager: StreamPublishManager,
  session: StreamPublishSession,
  stream: GoLiveStream,
  source = "stream_publish_credentials_received"
) {
  if (!streamHasCredentials(stream)) {
    updateTransportState(session, {
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      endpoint: stream.endpoint,
      token: stream.token,
      discoveredAt: stream.discoveredAt,
      credentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "waiting_for_credentials",
      transportReason: null
    });
    return {
      ok: false,
      reason: "waiting_for_stream_credentials"
    };
  }

  if (!session?.voxClient || typeof session.voxClient.streamPublishConnect !== "function") {
    updateTransportState(session, {
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      endpoint: stream.endpoint,
      token: stream.token,
      discoveredAt: stream.discoveredAt,
      credentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "transport_unavailable",
      transportReason: "stream_publish_connect_missing"
    });
    return {
      ok: false,
      reason: "stream_publish_transport_unavailable"
    };
  }

  const selfUserId = String(manager.client.user?.id || "").trim();
  const currentVoiceSessionId = getCurrentVoiceSessionId(manager, session);
  if (!selfUserId || !currentVoiceSessionId) {
    updateTransportState(session, {
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      endpoint: stream.endpoint,
      token: stream.token,
      discoveredAt: stream.discoveredAt,
      credentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "waiting_for_voice_session",
      transportReason: null
    });
    return {
      ok: false,
      reason: "voice_session_id_unavailable"
    };
  }

  const daveChannelId = deriveDaveChannelId(stream.rtcServerId);
  if (!daveChannelId) {
    updateTransportState(session, {
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      endpoint: stream.endpoint,
      token: stream.token,
      discoveredAt: stream.discoveredAt,
      credentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      lastVoiceSessionId: currentVoiceSessionId,
      transportStatus: "invalid_dave_channel",
      transportReason: "rtc_server_id_derivation_failed"
    });
    return {
      ok: false,
      reason: "dave_channel_id_unavailable"
    };
  }

  const state = ensureStreamPublishState(session);
  const alreadyCurrent =
    state?.streamKey === stream.streamKey &&
    state?.rtcServerId === stream.rtcServerId &&
    state?.endpoint === stream.endpoint &&
    state?.lastVoiceSessionId === currentVoiceSessionId &&
    (state.transportStatus === "connect_requested" ||
      state.transportStatus === "connecting" ||
      state.transportStatus === "ready");
  if (alreadyCurrent) {
    return {
      ok: true,
      reason: state?.transportStatus || "already_connected"
    };
  }

  session.voxClient.streamPublishConnect({
    endpoint: String(stream.endpoint || "").trim(),
    token: String(stream.token || "").trim(),
    serverId: String(stream.rtcServerId || "").trim(),
    sessionId: currentVoiceSessionId,
    userId: selfUserId,
    daveChannelId
  });

  updateTransportState(session, {
    streamKey: stream.streamKey,
    guildId: stream.guildId,
    channelId: stream.channelId,
    rtcServerId: stream.rtcServerId,
    endpoint: stream.endpoint,
    token: stream.token,
    discoveredAt: stream.discoveredAt,
    credentialsReceivedAt: Number(stream.credentialsReceivedAt || Date.now()),
    lastVoiceSessionId: currentVoiceSessionId,
    transportStatus: "connect_requested",
    transportReason: null
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: selfUserId,
    content: "music_stream_publish_transport_connect_requested",
    metadata: {
      sessionId: session.id,
      source,
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      daveChannelId,
      voiceSessionId: currentVoiceSessionId
    }
  });

  return {
    ok: true,
    reason: "stream_publish_transport_connect_requested"
  };
}

function startResolvedStreamPublish(
  manager: StreamPublishManager,
  session: StreamPublishSession,
  {
    sourceResolution,
    source = "stream_publish_requested",
    logContent = "stream_publish_requested"
  }: {
    sourceResolution: StreamPublishSourceResolution;
    source?: string | null;
    logContent?: string;
  }
) {
  const state = ensureStreamPublishState(session);
  if (!state || !sourceResolution.ok) {
    if (state) {
      updateTransportState(session, {
        active: false,
        paused: false,
        sourceKind: sourceResolution.sourceKind,
        visualizerMode: sourceResolution.visualizerMode,
        sourceKey: sourceResolution.sourceKey,
        sourceUrl: sourceResolution.sourceUrl,
        sourceLabel: sourceResolution.sourceLabel,
        transportStatus: "unsupported_source",
        transportReason: sourceResolution.reason
      });
    }
    return {
      ok: false,
      reason: sourceResolution.reason
    };
  }

  const expectedStreamKey = getExpectedSelfStreamKey(manager, session);
  const now = Date.now();
  const wasPaused = Boolean(state.paused);
  const sameSource =
    state.sourceKind === sourceResolution.sourceKind &&
    state.sourceKey === sourceResolution.sourceKey &&
    state.visualizerMode === sourceResolution.visualizerMode;
  const discoveryState = getStreamDiscoveryState(manager);
  const discoveredStream = expectedStreamKey
    ? discoveryState?.streams.get(expectedStreamKey) || null
    : null;
  const hasExistingStreamControlPlane =
    state.active &&
    state.streamKey === expectedStreamKey &&
    transportStatusHasExistingStreamControlPlane(state.transportStatus);
  const alreadyActive = state.active && !state.paused && sameSource && hasExistingStreamControlPlane;
  const shouldResumePlayback = wasPaused && sameSource;
  const shouldStartPlayback = !alreadyActive && !shouldResumePlayback;
  const shouldCreateStream = !hasExistingStreamControlPlane && !discoveredStream;

  updateTransportState(session, {
    active: true,
    paused: false,
    sourceKind: sourceResolution.sourceKind,
    visualizerMode: sourceResolution.visualizerMode,
    sourceKey: sourceResolution.sourceKey,
    sourceUrl: sourceResolution.sourceUrl,
    sourceLabel: sourceResolution.sourceLabel,
    streamKey: expectedStreamKey,
    guildId: session.guildId,
    channelId: session.voiceChannelId,
    requestedAt: now,
    startedAt: sameSource && state.startedAt ? state.startedAt : now,
    pausedAt: 0,
    stoppedAt: 0,
    transportStatus: alreadyActive
      ? state.transportStatus || "ready"
      : shouldResumePlayback && hasExistingStreamControlPlane
        ? "resume_requested"
        : hasExistingStreamControlPlane
          ? state.transportStatus || "ready"
          : "stream_requested",
    transportReason: null
  });

  if (session.voxClient) {
    if (shouldResumePlayback && typeof session.voxClient.streamPublishResume === "function") {
      session.voxClient.streamPublishResume();
    } else if (shouldStartPlayback) {
      if (
        sourceResolution.playback.kind === "url" &&
        typeof session.voxClient.streamPublishPlay === "function"
      ) {
        session.voxClient.streamPublishPlay(
          sourceResolution.playback.url,
          sourceResolution.playback.resolvedDirectUrl
        );
      } else if (
        sourceResolution.playback.kind === "visualizer" &&
        typeof session.voxClient.streamPublishPlayVisualizer === "function"
      ) {
        session.voxClient.streamPublishPlayVisualizer(
          sourceResolution.playback.url,
          sourceResolution.playback.resolvedDirectUrl,
          sourceResolution.playback.visualizerMode
        );
      } else if (
        sourceResolution.playback.kind === "browser_session" &&
        typeof session.voxClient.streamPublishBrowserStart === "function"
      ) {
        session.voxClient.streamPublishBrowserStart(sourceResolution.playback.mimeType);
      }
    }
  }

  if (shouldCreateStream) {
    if (!session.voiceChannelId || !requestStreamCreate(manager.client, {
      guildId: String(session.guildId || "").trim(),
      channelId: String(session.voiceChannelId || "").trim()
    })) {
      updateTransportState(session, {
        transportStatus: "stream_create_failed",
        transportReason: "stream_create_request_failed"
      });
      return {
        ok: false,
        reason: "stream_create_request_failed"
      };
    }
  }

  if (expectedStreamKey && (shouldCreateStream || shouldResumePlayback || !hasExistingStreamControlPlane)) {
    setStreamPaused(manager.client, expectedStreamKey, false);
  }

  if (
    discoveredStream &&
    (shouldCreateStream || transportStatusNeedsDiscoveredStreamConnect(state.transportStatus))
  ) {
    void connectStreamPublishTransport(manager, session, discoveredStream, source);
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: logContent,
    metadata: {
      sessionId: session.id,
      source,
      streamKey: expectedStreamKey,
      sourceKind: sourceResolution.sourceKind,
      visualizerMode: sourceResolution.visualizerMode,
      sourceKey: sourceResolution.sourceKey,
      sourceUrl: sourceResolution.sourceUrl,
      resumeRequested: wasPaused && sameSource,
      alreadyActive
    }
  });

  return {
    ok: true,
    reason: alreadyActive
      ? "stream_publish_already_active"
      : wasPaused && sameSource
        ? "stream_publish_resumed"
        : "stream_publish_requested"
  };
}

export function startMusicStreamPublish(
  manager: StreamPublishManager,
  {
    guildId,
    source = "music_player_state_playing"
  }: {
    guildId: string;
    source?: string | null;
  }
) {
  const session = manager.sessions.get(String(guildId || "").trim()) || null;
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  const sourceResolution = resolvePublishableMusicSource(manager, session);
  return startResolvedStreamPublish(manager, session, {
    sourceResolution,
    source,
    logContent: "music_stream_publish_requested"
  });
}

export function startBrowserStreamPublish(
  manager: StreamPublishManager,
  {
    guildId,
    browserSessionId,
    currentUrl = null,
    mimeType = "image/png",
    source = "browser_session_stream_publish"
  }: {
    guildId: string;
    browserSessionId: string;
    currentUrl?: string | null;
    mimeType?: string | null;
    source?: string | null;
  }
) {
  const session = manager.sessions.get(String(guildId || "").trim()) || null;
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  return startResolvedStreamPublish(manager, session, {
    sourceResolution: resolveBrowserSessionPublishSource({
      browserSessionId,
      currentUrl,
      mimeType
    }),
    source,
    logContent: "browser_stream_publish_requested"
  });
}

export function pauseMusicStreamPublish(
  manager: StreamPublishManager,
  {
    guildId,
    reason = "music_paused"
  }: {
    guildId: string;
    reason?: string | null;
  }
) {
  const session = manager.sessions.get(String(guildId || "").trim()) || null;
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  const state = ensureStreamPublishState(session);
  if (!state?.active) {
    return {
      ok: false,
      reason: "stream_publish_inactive"
    };
  }

  const now = Date.now();
  state.paused = true;
  state.pausedAt = now;
  state.transportStatus = "paused";
  state.transportReason = String(reason || "").trim() || null;
  state.transportUpdatedAt = now;

  if (state.streamKey) {
    setStreamPaused(manager.client, state.streamKey, true);
  }
  session.voxClient?.streamPublishPause?.();

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "music_stream_publish_paused",
    metadata: {
      sessionId: session.id,
      reason,
      streamKey: state.streamKey
    }
  });

  return {
    ok: true,
    reason: "stream_publish_paused"
  };
}

export function stopMusicStreamPublish(
  manager: StreamPublishManager,
  {
    guildId,
    reason = "music_stopped"
  }: {
    guildId: string;
    reason?: string | null;
  }
) {
  const session = manager.sessions.get(String(guildId || "").trim()) || null;
  if (!session) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  const state = ensureStreamPublishState(session);
  const streamKey = state?.streamKey || getExpectedSelfStreamKey(manager, session);
  const stoppedAt = Date.now();

  if (streamKey) {
    requestStreamDelete(manager.client, streamKey);
  }
  session.voxClient?.streamPublishStop?.();
  session.voxClient?.streamPublishDisconnect?.(String(reason || "").trim() || null);

  session.streamPublish = {
    ...createStreamPublishState(),
    stoppedAt,
    transportReason: String(reason || "").trim() || null,
    transportUpdatedAt: stoppedAt
  };

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "music_stream_publish_stopped",
    metadata: {
      sessionId: session.id,
      reason,
      streamKey
    }
  });

  return {
    ok: true,
    reason: "stream_publish_stopped"
  };
}

export function stopBrowserStreamPublish(
  manager: StreamPublishManager,
  {
    guildId,
    reason = "browser_stream_share_stopped"
  }: {
    guildId: string;
    reason?: string | null;
  }
) {
  const session = manager.sessions.get(String(guildId || "").trim()) || null;
  if (!session) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  const state = ensureStreamPublishState(session);
  const streamKey = state?.streamKey || getExpectedSelfStreamKey(manager, session);
  const stoppedAt = Date.now();

  if (streamKey) {
    requestStreamDelete(manager.client, streamKey);
  }
  session.voxClient?.streamPublishStop?.();
  session.voxClient?.streamPublishDisconnect?.(String(reason || "").trim() || null);

  session.streamPublish = {
    ...createStreamPublishState(),
    stoppedAt,
    transportReason: String(reason || "").trim() || null,
    transportUpdatedAt: stoppedAt
  };

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "browser_stream_publish_stopped",
    metadata: {
      sessionId: session.id,
      reason,
      streamKey
    }
  });

  return {
    ok: true,
    reason: "stream_publish_stopped"
  };
}

export function handleDiscoveredSelfStreamCredentialsReceived(
  manager: StreamPublishManager,
  {
    stream
  }: {
    stream: GoLiveStream;
  }
) {
  const selfUserId = String(manager.client.user?.id || "").trim();
  if (!selfUserId || String(stream?.userId || "").trim() !== selfUserId) {
    return {
      ok: false,
      reason: "not_self_stream"
    };
  }

  const session = manager.sessions.get(String(stream.guildId || "").trim()) || null;
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  updateTransportState(session, {
    streamKey: stream.streamKey,
    guildId: stream.guildId,
    channelId: stream.channelId,
    rtcServerId: stream.rtcServerId,
    endpoint: stream.endpoint,
    token: stream.token,
    discoveredAt: stream.discoveredAt,
    credentialsReceivedAt: Number(stream.credentialsReceivedAt || 0)
  });

  const state = ensureStreamPublishState(session);
  if (!state?.active || !state.sourceKey) {
    return {
      ok: true,
      reason: "self_stream_discovered_without_active_publish"
    };
  }

  return connectStreamPublishTransport(manager, session, stream);
}

export function handleDiscoveredSelfStreamDeleted(
  manager: StreamPublishManager,
  {
    stream
  }: {
    stream: GoLiveStream;
  }
) {
  const selfUserId = String(manager.client.user?.id || "").trim();
  if (!selfUserId || String(stream?.userId || "").trim() !== selfUserId) {
    return {
      ok: false,
      reason: "not_self_stream"
    };
  }

  const session = manager.sessions.get(String(stream.guildId || "").trim()) || null;
  if (!session) {
    return {
      ok: false,
      reason: "voice_session_missing"
    };
  }

  session.voxClient?.streamPublishDisconnect?.("stream_deleted");
  session.streamPublish = {
    ...createStreamPublishState(),
    stoppedAt: Date.now(),
    transportReason: "stream_deleted",
    transportUpdatedAt: Date.now()
  };

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: selfUserId,
    content: "music_stream_publish_deleted",
    metadata: {
      sessionId: session.id,
      streamKey: stream.streamKey
    }
  });

  return {
    ok: true,
    reason: "self_stream_deleted"
  };
}
