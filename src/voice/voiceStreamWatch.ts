import { clamp } from "../utils.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import {
  getBotName,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding,
  getVoiceStreamWatchSettings
} from "../settings/agentStack.ts";
import {
  buildStreamKey,
  getStreamByUserAndGuild,
  requestStreamWatch,
  streamHasCredentials,
  type GoLiveStream,
  type StreamDiscoveryState
} from "../selfbot/streamDiscovery.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import {
  clearNativeDiscordScreenShareState,
  ensureNativeDiscordScreenShareState,
  removeNativeDiscordVideoSharer
} from "./nativeDiscordScreenShare.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";

type StreamWatchSession = {
  id?: string | null;
  guildId?: string | null;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  mode?: string | null;
  ending?: boolean;
  settingsSnapshot?: Record<string, unknown> | null;
  streamWatch?: Record<string, unknown> | null;
  nativeScreenShare?: Record<string, unknown> | null;
  voxClient?: {
    subscribeUserVideo?: (payload: Record<string, unknown>) => void;
    unsubscribeUserVideo?: (userId: string) => void;
    streamWatchConnect?: (payload: {
      endpoint: string;
      token: string;
      serverId: string;
      sessionId: string;
      userId: string;
      daveChannelId: string;
    }) => void;
    streamWatchDisconnect?: (reason?: string | null) => void;
    getLastVoiceSessionId?: () => string | null;
  } | null;
  botTurnOpen?: boolean;
  botAudioStream?: { writableLength?: number } | null;
  inFlightAcceptedBrainTurn?: object | null;
  pendingFileAsrTurns?: number;
  realtimeTurnDrainActive?: boolean;
  pendingRealtimeTurns?: unknown[] | null;
  realtimeClient?: {
    appendInputVideoFrame?: (payload: { mimeType: string; dataBase64: string }) => void;
  } | null;
  userCaptures?: Map<string, unknown>;
  pendingResponse?: unknown;
  lastInboundAudioAt?: number;
  [key: string]: unknown;
};

type StreamWatchManager = {
  client: {
    user?: { id?: string | null; username?: string | null } | null;
    guilds: {
      cache: Map<string, {
        channels?: {
          cache?: Map<string, {
            members?: {
              has?: (userId: string) => boolean;
            } | null;
          }>;
        } | null;
        members?: {
          me?: {
            voice?: {
              sessionId?: string | null;
            } | null;
          } | null;
        } | null;
      }>;
    };
  };
  llm?: {
    isProviderConfigured?: (provider: string) => boolean;
    generate?: (payload: Record<string, unknown>) => Promise<{
      text?: string | null;
      provider?: string | null;
      model?: string | null;
    } | null>;
  } | null;
  memory?: {
    ingestMessage?: (payload: Record<string, unknown>) => Promise<unknown>;
    rememberDirectiveLineDetailed?: (payload: Record<string, unknown>) => Promise<{
      ok?: boolean;
      reason?: string | null;
    } | null>;
  } | null;
  resolveVoiceSpeakerName: (session: StreamWatchSession, userId?: string | null) => string | null;
  sessions: Map<string, StreamWatchSession>;
  store: {
    getSettings: () => Record<string, unknown> | null;
    logAction: (entry: Record<string, unknown>) => void;
  };
  streamDiscovery?: StreamDiscoveryState | null;
  touchActivity: (guildId: string, resolvedSettings?: Record<string, unknown> | null) => void;
  composeOperationalMessage?: (payload: Record<string, unknown>) => Promise<string | null>;
  deferredActionQueue?: {
    getDeferredQueuedUserTurns?: (session: StreamWatchSession) => unknown[] | null;
  } | null;
  getOutputChannelState?: (session: StreamWatchSession) => { locked?: boolean } | null;
  runRealtimeBrainReply?: (payload: Record<string, unknown>) => Promise<unknown>;
  activeReplies?: {
    has?: (scopeKey: string) => boolean;
  } | null;
};

const STREAM_WATCH_AUDIO_QUIET_WINDOW_MS = 2200;
const SCANNER_RECENT_TRANSCRIPT_MAX_TURNS = 3;
const SCANNER_RECENT_TRANSCRIPT_MAX_CHARS = 200;

function getRecentTranscriptSnippet(session: StreamWatchSession): string {
  const turns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
  const speechTurns = turns
    .filter((t): t is Record<string, unknown> =>
      t != null && typeof t === "object" && (!("kind" in t) || t.kind === "speech")
    )
    .slice(-SCANNER_RECENT_TRANSCRIPT_MAX_TURNS);
  if (speechTurns.length === 0) return "";
  const lines = speechTurns.map((t) => {
    const name = String(t.speakerName || t.role || "?").trim();
    const text = String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${name}: ${text}`;
  });
  const joined = lines.join(" | ");
  return joined.length > SCANNER_RECENT_TRANSCRIPT_MAX_CHARS
    ? joined.slice(0, SCANNER_RECENT_TRANSCRIPT_MAX_CHARS - 1) + "…"
    : joined;
}
const STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS = 420;
const STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS = 220;
const STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS = 72;
const DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT =
  "Write one short factual private note about the most salient visible state or change in this frame. Prioritize gameplay actions, objectives, outcomes, menus, or unusual/funny moments that could support a natural later comment. If the frame is mostly idle UI, lobby, desktop, or other non-gameplay context, say that plainly. Prefer what is newly different from the previous frame.";
const STREAM_WATCH_FRAME_ANALYSIS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    note: { type: "string" },
    urgency: { type: "string", enum: ["high", "low", "none"] }
  },
  required: ["note", "urgency"],
  additionalProperties: false
});
const STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    shouldStore: { type: "boolean" },
    recap: { type: "string" }
  },
  required: ["shouldStore", "recap"],
  additionalProperties: false
});

function resolveStreamWatchBrainContextSettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  const prompt = normalizeVoiceText(
    String(streamWatchSettings.brainContextPrompt || ""),
    STREAM_WATCH_BRAIN_CONTEXT_PROMPT_MAX_CHARS
  );

  return {
    enabled:
      streamWatchSettings.brainContextEnabled !== undefined
        ? Boolean(streamWatchSettings.brainContextEnabled)
        : true,
    minIntervalSeconds: clamp(
      Number(streamWatchSettings.brainContextMinIntervalSeconds) || 4,
      1,
      120
    ),
    maxEntries: clamp(
      Number(streamWatchSettings.brainContextMaxEntries) || 8,
      1,
      24
    ),
    prompt: prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT
  };
}

function getStreamWatchBrainContextEntries(session, maxEntries = 8) {
  const streamWatch = session?.streamWatch && typeof session.streamWatch === "object" ? session.streamWatch : {};
  const entries = Array.isArray(streamWatch.brainContextEntries) ? streamWatch.brainContextEntries : [];
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeVoiceText(entry.text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
      if (!text) return null;
      const atRaw = Number(entry.at);
      return {
        text,
        at: Number.isFinite(atRaw) ? Math.max(0, Math.round(atRaw)) : 0,
        provider: String(entry.provider || "").trim() || null,
        model: String(entry.model || "").trim() || null,
        speakerName: String(entry.speakerName || "").trim() || null
      };
    })
    .filter(Boolean)
    .slice(-boundedMax);
}

function getLatestStreamWatchBrainContextEntry(session) {
  const entries = getStreamWatchBrainContextEntries(session, 24);
  return entries[entries.length - 1] || null;
}

function resolveNativeDiscordVideoSubscriptionSettings(settings = null) {
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);
  const preferredPixelCountRaw = Number(streamWatchSettings.nativeDiscordPreferredPixelCount) || 0;
  return {
    maxFramesPerSecond: clamp(
      Number(streamWatchSettings.nativeDiscordMaxFramesPerSecond) || 2,
      1,
      10
    ),
    preferredQuality: clamp(
      Number(streamWatchSettings.nativeDiscordPreferredQuality) || 100,
      0,
      100
    ),
    preferredPixelCount:
      preferredPixelCountRaw > 0
        ? clamp(preferredPixelCountRaw, 64 * 64, 3840 * 2160)
        : 1280 * 720,
    preferredStreamType:
      String(streamWatchSettings.nativeDiscordPreferredStreamType || "screen")
        .trim()
        .toLowerCase() || null
  };
}

function getStreamDiscoveryState(manager: StreamWatchManager): StreamDiscoveryState | null {
  const state = manager.streamDiscovery;
  if (!state || typeof state !== "object") return null;
  return state.streams instanceof Map ? state : null;
}

function deriveStreamWatchDaveChannelId(rtcServerId: string | null | undefined): string | null {
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

function getCurrentVoiceSessionId(manager: StreamWatchManager, session): string | null {
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

function updateNativeDiscordStreamTransportState(session, {
  activeStreamKey,
  lastRtcServerId,
  lastStreamEndpoint,
  lastCredentialsReceivedAt,
  lastVoiceSessionId,
  transportStatus,
  transportReason,
  transportConnectedAt
}: {
  activeStreamKey?: string | null;
  lastRtcServerId?: string | null;
  lastStreamEndpoint?: string | null;
  lastCredentialsReceivedAt?: number;
  lastVoiceSessionId?: string | null;
  transportStatus?: string | null;
  transportReason?: string | null;
  transportConnectedAt?: number;
} = {}) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const now = Date.now();

  if (activeStreamKey !== undefined) {
    nativeScreenShare.activeStreamKey = String(activeStreamKey || "").trim() || null;
  }
  if (lastRtcServerId !== undefined) {
    nativeScreenShare.lastRtcServerId = String(lastRtcServerId || "").trim() || null;
  }
  if (lastStreamEndpoint !== undefined) {
    nativeScreenShare.lastStreamEndpoint = String(lastStreamEndpoint || "").trim() || null;
  }
  if (lastCredentialsReceivedAt !== undefined) {
    nativeScreenShare.lastCredentialsReceivedAt = Math.max(0, Math.floor(Number(lastCredentialsReceivedAt) || 0));
  }
  if (lastVoiceSessionId !== undefined) {
    nativeScreenShare.lastVoiceSessionId = String(lastVoiceSessionId || "").trim() || null;
  }
  if (transportStatus !== undefined) {
    nativeScreenShare.transportStatus = String(transportStatus || "").trim() || null;
    nativeScreenShare.transportUpdatedAt = now;
  }
  if (transportReason !== undefined) {
    nativeScreenShare.transportReason = String(transportReason || "").trim() || null;
  }
  if (transportConnectedAt !== undefined) {
    nativeScreenShare.transportConnectedAt = Math.max(0, Math.floor(Number(transportConnectedAt) || 0));
  }

  return nativeScreenShare;
}

function clearNativeDiscordStreamTransportState(session, reason: string | null = null) {
  return updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: null,
    lastRtcServerId: null,
    lastStreamEndpoint: null,
    lastCredentialsReceivedAt: 0,
    lastVoiceSessionId: null,
    transportStatus: null,
    transportReason: String(reason || "").trim() || null,
    transportConnectedAt: 0
  });
}

function resolveRequestedStream(session, targetUserId: string, discoveryState: StreamDiscoveryState | null) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  const normalizedGuildId = String(session?.guildId || "").trim();
  const normalizedVoiceChannelId = String(session?.voiceChannelId || "").trim();
  const discoveredStream =
    discoveryState && normalizedGuildId && normalizedTargetUserId
      ? getStreamByUserAndGuild(discoveryState, normalizedTargetUserId, normalizedGuildId)
      : null;
  if (discoveredStream?.streamKey) {
    return {
      streamKey: discoveredStream.streamKey,
      stream: discoveredStream
    };
  }
  if (!normalizedGuildId || !normalizedVoiceChannelId || !normalizedTargetUserId) {
    return {
      streamKey: null,
      stream: null
    };
  }
  return {
    streamKey: buildStreamKey(normalizedGuildId, normalizedVoiceChannelId, normalizedTargetUserId),
    stream: null
  };
}

function requestNativeDiscordStreamWatch(manager: StreamWatchManager, session, {
  targetUserId,
  source = "screen_share_link"
}: {
  targetUserId: string;
  source?: string | null;
}) {
  const discoveryState = getStreamDiscoveryState(manager);
  if (!discoveryState) {
    return {
      ok: false,
      reason: "stream_discovery_unavailable",
      fallback: "screen_share_link",
      stream: null as GoLiveStream | null
    };
  }

  const requested = resolveRequestedStream(session, targetUserId, discoveryState);
  if (!requested.streamKey) {
    return {
      ok: false,
      reason: "stream_key_unavailable",
      fallback: "screen_share_link",
      stream: null as GoLiveStream | null
    };
  }

  const watchRequested = requestStreamWatch(manager.client, discoveryState, requested.streamKey);
  if (!watchRequested) {
    return {
      ok: false,
      reason: "stream_watch_request_failed",
      fallback: "screen_share_link",
      stream: requested.stream
    };
  }

  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: requested.streamKey,
    transportStatus: "watch_requested",
    transportReason: null
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: targetUserId,
    content: "native_discord_stream_watch_requested",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      streamKey: requested.streamKey,
      hasDiscoveredStream: Boolean(requested.stream)
    }
  });

  return {
    ok: true,
    reason: "stream_watch_requested",
    fallback: null,
    stream: requested.stream
  };
}

function connectNativeDiscordStreamTransport(
  manager: StreamWatchManager,
  session,
  stream: GoLiveStream,
  {
    source = "stream_credentials_received"
  }: {
    source?: string | null;
  } = {}
) {
  if (!streamHasCredentials(stream)) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      transportStatus: "waiting_for_credentials",
      transportReason: null
    });
    return {
      ok: false,
      reason: "waiting_for_credentials"
    };
  }

  if (!session?.voxClient || typeof session.voxClient.streamWatchConnect !== "function") {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "transport_unavailable",
      transportReason: "stream_watch_connect_missing"
    });
    return {
      ok: false,
      reason: "stream_watch_transport_unavailable"
    };
  }

  const currentVoiceSessionId = getCurrentVoiceSessionId(manager, session);
  if (!currentVoiceSessionId) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      transportStatus: "waiting_for_voice_session",
      transportReason: null
    });
    return {
      ok: false,
      reason: "voice_session_id_unavailable"
    };
  }

  const daveChannelId = deriveStreamWatchDaveChannelId(stream.rtcServerId);
  if (!daveChannelId) {
    updateNativeDiscordStreamTransportState(session, {
      activeStreamKey: stream.streamKey,
      lastRtcServerId: stream.rtcServerId,
      lastStreamEndpoint: stream.endpoint,
      lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || 0),
      lastVoiceSessionId: currentVoiceSessionId,
      transportStatus: "invalid_dave_channel",
      transportReason: "rtc_server_id_derivation_failed"
    });
    return {
      ok: false,
      reason: "dave_channel_id_unavailable"
    };
  }

  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const alreadyCurrent =
    nativeScreenShare.activeStreamKey === stream.streamKey &&
    nativeScreenShare.lastRtcServerId === stream.rtcServerId &&
    nativeScreenShare.lastStreamEndpoint === stream.endpoint &&
    nativeScreenShare.lastVoiceSessionId === currentVoiceSessionId &&
    (nativeScreenShare.transportStatus === "connect_requested" ||
      nativeScreenShare.transportStatus === "connecting" ||
      nativeScreenShare.transportStatus === "ready");
  if (alreadyCurrent) {
    return {
      ok: true,
      reason: nativeScreenShare.transportStatus || "already_connected"
    };
  }

  session.voxClient.streamWatchConnect({
    endpoint: String(stream.endpoint || "").trim(),
    token: String(stream.token || "").trim(),
    serverId: String(stream.rtcServerId || "").trim(),
    sessionId: currentVoiceSessionId,
    userId: String(manager.client.user?.id || "").trim(),
    daveChannelId
  });

  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: stream.streamKey,
    lastRtcServerId: stream.rtcServerId,
    lastStreamEndpoint: stream.endpoint,
    lastCredentialsReceivedAt: Number(stream.credentialsReceivedAt || Date.now()),
    lastVoiceSessionId: currentVoiceSessionId,
    transportStatus: "connect_requested",
    transportReason: null
  });

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: stream.userId,
    content: "native_discord_stream_transport_connect_requested",
    metadata: {
      sessionId: session.id,
      source: String(source || "stream_credentials_received"),
      streamKey: stream.streamKey,
      rtcServerId: stream.rtcServerId,
      voiceSessionId: currentVoiceSessionId
    }
  });

  return {
    ok: true,
    reason: "stream_transport_connect_requested"
  };
}

function disconnectNativeDiscordStreamTransport(
  manager: StreamWatchManager,
  session,
  reason: string | null = null
) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const normalizedReason = String(reason || "").trim() || "stream_watch_stopped";

  if (session?.voxClient && typeof session.voxClient.streamWatchDisconnect === "function") {
    try {
      session.voxClient.streamWatchDisconnect(normalizedReason);
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: session.streamWatch?.targetUserId || manager.client.user?.id || null,
        content: `native_discord_stream_transport_disconnect_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: normalizedReason,
          streamKey: nativeScreenShare.activeStreamKey || null
        }
      });
    }
  }

  clearNativeDiscordStreamTransportState(session, normalizedReason);
}

function clearNativeDiscordSubscriptionState(session, targetUserId = null) {
  if (
    session?.nativeScreenShare &&
    typeof session.nativeScreenShare === "object" &&
    (!targetUserId || session.nativeScreenShare.subscribedTargetUserId === targetUserId)
  ) {
    session.nativeScreenShare.subscribedTargetUserId = null;
  }
}

function unsubscribeNativeDiscordVideo(manager: StreamWatchManager, session, targetUserId, reason) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (!session || !normalizedTargetUserId) {
    clearNativeDiscordSubscriptionState(session, normalizedTargetUserId);
    return;
  }

  try {
    if (typeof session.voxClient?.unsubscribeUserVideo === "function") {
      session.voxClient.unsubscribeUserVideo(normalizedTargetUserId);
    }
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedTargetUserId,
      content: `native_discord_video_unsubscribe_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        targetUserId: normalizedTargetUserId,
        reason: String(reason || "stream_watch_stop")
      }
    });
  } finally {
    clearNativeDiscordSubscriptionState(session, normalizedTargetUserId);
  }
}

function subscribeNativeDiscordVideo(
  manager: StreamWatchManager,
  session,
  settings,
  targetUserId,
  source
) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (!session || !normalizedTargetUserId || typeof session.voxClient?.subscribeUserVideo !== "function") {
    return;
  }

  const currentTargetUserId =
    session.nativeScreenShare && typeof session.nativeScreenShare === "object"
      ? String(session.nativeScreenShare.subscribedTargetUserId || "").trim() || null
      : null;
  if (currentTargetUserId && currentTargetUserId !== normalizedTargetUserId) {
    unsubscribeNativeDiscordVideo(manager, session, currentTargetUserId, "stream_watch_retarget");
  }

  const subscription = resolveNativeDiscordVideoSubscriptionSettings(settings);
  try {
    session.voxClient.subscribeUserVideo({
      userId: normalizedTargetUserId,
      maxFramesPerSecond: subscription.maxFramesPerSecond,
      preferredQuality: subscription.preferredQuality,
      preferredPixelCount: subscription.preferredPixelCount,
      preferredStreamType: subscription.preferredStreamType
    });
    if (session.nativeScreenShare && typeof session.nativeScreenShare === "object") {
      session.nativeScreenShare.subscribedTargetUserId = normalizedTargetUserId;
    }
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedTargetUserId,
      content: `native_discord_video_subscribe_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        targetUserId: normalizedTargetUserId,
        source: String(source || "screen_share_link")
      }
    });
  }
}

function buildStreamWatchNotesText(session, maxEntries = 6) {
  return getStreamWatchBrainContextEntries(session, maxEntries)
    .slice(-Math.max(1, Number(maxEntries) || 6))
    .map((entry, index) => {
      const speakerPrefix = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${index + 1}. ${speakerPrefix}${entry.text}`;
    })
    .join("\n");
}

export function appendStreamWatchBrainContextEntry({
  session,
  text,
  at,
  provider = null,
  model = null,
  speakerName = null,
  maxEntries = 8
}) {
  if (!session) return null;
  const normalizedText = normalizeVoiceText(text, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!normalizedText) return null;
  const normalizedAt = Number.isFinite(Number(at)) ? Math.max(0, Math.round(Number(at))) : Date.now();
  const boundedMax = clamp(Number(maxEntries) || 8, 1, 24);
  const current = getStreamWatchBrainContextEntries(session, boundedMax);
  const last = current[current.length - 1] || null;
  const normalizedProvider = String(provider || "").trim() || null;
  const normalizedModel = String(model || "").trim() || null;
  const normalizedSpeakerName = String(speakerName || "").trim() || null;
  let nextEntries = current;

  if (last && last.text.toLowerCase() === normalizedText.toLowerCase()) {
    nextEntries = [
      ...current.slice(0, -1),
      {
        ...last,
        at: normalizedAt,
        provider: normalizedProvider || last.provider || null,
        model: normalizedModel || last.model || null,
        speakerName: normalizedSpeakerName || last.speakerName || null
      }
    ];
  } else {
    nextEntries = [
      ...current,
      {
        text: normalizedText,
        at: normalizedAt,
        provider: normalizedProvider,
        model: normalizedModel,
        speakerName: normalizedSpeakerName
      }
    ].slice(-boundedMax);
  }

  session.streamWatch = session.streamWatch || {};
  session.streamWatch.brainContextEntries = nextEntries;
  session.streamWatch.lastBrainContextAt = normalizedAt;
  session.streamWatch.lastBrainContextProvider = normalizedProvider;
  session.streamWatch.lastBrainContextModel = normalizedModel;
  return nextEntries[nextEntries.length - 1] || null;
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

async function sendStreamWatchOfflineMessage(manager: StreamWatchManager, { message, settings, guildId, requesterId }) {
  await sendOperationalMessage(manager, {
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "offline",
    details: {}
  });
}

async function resolveStreamWatchRequestContext(manager: StreamWatchManager, { message, settings }) {
  if (!message?.guild || !message?.channel) return null;
  const guildId = String(message.guild.id);
  const requesterId = String(message.author?.id || "").trim() || null;
  const session = manager.sessions.get(guildId);
  if (!session) {
    await sendStreamWatchOfflineMessage(manager, {
      message,
      settings,
      guildId,
      requesterId
    });
    return {
      handled: true
    };
  }
  return {
    handled: false,
    guildId,
    requesterId,
    session
  };
}

export async function requestWatchStream(manager: StreamWatchManager, { message, settings, targetUserId = null }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (String(message.member?.voice?.channelId || "") !== String(session.voiceChannelId || "")) {
    await sendOperationalMessage(manager, {
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "requester_not_in_same_vc",
      details: {
        voiceChannelId: session.voiceChannelId
      }
    });
    return true;
  }

  const streamWatchSettings = settings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    await sendOperationalMessage(manager, {
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_disabled",
      details: {}
    });
    return true;
  }

  if (!supportsStreamWatchCommentary(manager, session, settings)) {
    await sendOperationalMessage(manager, {
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "stream_watch_provider_unavailable",
      details: {
        mode: session.mode,
        realtimeProvider: session.realtimeProvider
      }
    });
    return true;
  }

  initializeStreamWatchState(manager, {
    session,
    requesterUserId: requesterId,
    targetUserId: String(targetUserId || requesterId || "").trim() || null
  });

  await sendOperationalMessage(manager, {
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_started",
    details: {
      targetUserId: session.streamWatch.targetUserId
    },
    mustNotify: false
  });
  return true;
}

export function initializeStreamWatchState(manager: StreamWatchManager, { session, requesterUserId, targetUserId = null }) {
  if (!session) return;
  session.streamWatch = session.streamWatch || {};
  clearNativeDiscordScreenShareState(session);
  session.streamWatch.active = true;
  session.streamWatch.targetUserId = String(targetUserId || requesterUserId || "").trim() || null;
  session.streamWatch.requestedByUserId = String(requesterUserId || "").trim() || null;
  session.streamWatch.lastFrameAt = 0;
  session.streamWatch.lastCommentaryAt = 0;
  session.streamWatch.lastCommentaryNote = null;
  session.streamWatch.lastMemoryRecapAt = 0;
  session.streamWatch.lastMemoryRecapText = null;
  session.streamWatch.lastMemoryRecapDurableSaved = false;
  session.streamWatch.lastMemoryRecapReason = null;
  session.streamWatch.lastBrainContextAt = 0;
  session.streamWatch.lastBrainContextProvider = null;
  session.streamWatch.lastBrainContextModel = null;
  session.streamWatch.brainContextEntries = [];
  session.streamWatch.ingestedFrameCount = 0;
  session.streamWatch.acceptedFrameCountInWindow = 0;
  session.streamWatch.frameWindowStartedAt = 0;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;
}

export function getStreamWatchBrainContextForPrompt(session, settings = null) {
  if (!session || session.ending) return null;
  const streamWatch = session.streamWatch || {};

  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;

  const entries = getStreamWatchBrainContextEntries(session, brainContextSettings.maxEntries);
  if (!entries.length) return null;

  const now = Date.now();
  const notes = entries
    .map((entry) => {
      const ageMs = Math.max(0, now - Number(entry.at || 0));
      const ageSeconds = Math.floor(ageMs / 1000);
      const ageLabel = ageSeconds <= 1 ? "just now" : `${ageSeconds}s ago`;
      const speakerLabel = entry.speakerName ? `${entry.speakerName}: ` : "";
      return `${speakerLabel}${entry.text} (${ageLabel})`;
    })
    .slice(-brainContextSettings.maxEntries);

  if (!notes.length) return null;

  const last = entries[entries.length - 1] || null;
  return {
    prompt: brainContextSettings.prompt,
    notes,
    lastAt: Number(last?.at || 0) || null,
    provider: last?.provider || streamWatch.lastBrainContextProvider || null,
    model: last?.model || streamWatch.lastBrainContextModel || null,
    active: Boolean(streamWatch.active)
  };
}

export function supportsStreamWatchCommentary(manager: StreamWatchManager, session, settings = null) {
  if (!session || session.ending) return false;
  if (!isRealtimeMode(session.mode)) return false;
  return supportsDirectVisionCommentary(manager, settings || session.settingsSnapshot || manager.store.getSettings());
}

export function supportsStreamWatchBrainContext(manager: StreamWatchManager, { session = null, settings = null } = {}) {
  if (!session || session.ending) return false;
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  return Boolean(resolveStreamWatchVisionProviderSettings(manager, settings));
}

export function resolveStreamWatchVisionProviderSettings(manager: StreamWatchManager, settings = null) {
  const llmSettings = getResolvedOrchestratorBinding(settings);
  const streamWatchSettings = getVoiceStreamWatchSettings(settings);

  const provider = String(streamWatchSettings.brainContextProvider || "").trim();
  const model = String(streamWatchSettings.brainContextModel || "").trim();

  if (!provider || !model) return null;
  if (!manager.llm?.isProviderConfigured?.(provider)) return null;

  return {
    ...llmSettings,
    provider,
    model,
    temperature: 0.3,
    maxOutputTokens: STREAM_WATCH_VISION_MAX_OUTPUT_TOKENS
  };
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

function supportsDirectVisionCommentary(manager: StreamWatchManager, settings = null) {
  if (!manager.llm || typeof manager.llm.generate !== "function") return false;
  const voiceBinding = getResolvedVoiceGenerationBinding(settings);
  return DIRECT_VISION_PROVIDERS.has(voiceBinding.provider);
}

async function generateVisionFallbackStreamWatchBrainContext(manager: StreamWatchManager, {
  session,
  settings,
  streamerUserId = null,
  frameMimeType = "image/jpeg",
  frameDataBase64 = ""
}) {
  if (!session || session.ending) return null;
  if (!manager.llm || typeof manager.llm.generate !== "function") return null;
  const normalizedFrame = String(frameDataBase64 || "").trim();
  if (!normalizedFrame) return null;

  const providerSettings = resolveStreamWatchVisionProviderSettings(manager, settings);
  if (!providerSettings) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  const previousNote = getLatestStreamWatchBrainContextEntry(session)?.text || "";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} preparing private stream-watch notes for your own voice brain.`,
    "You are looking at one still frame from a live stream.",
    "Never claim you cannot see the stream.",
    "Return strict JSON only.",
    "The note must be one short factual private note, max 16 words.",
    "urgency decides whether this frame warrants unprompted spoken commentary:",
    '"high" = something genuinely reaction-worthy happened that you would want to speak about unprompted — a dramatic moment, a visible error/crash, a funny or surprising event, a major state change like winning/losing/dying.',
    '"low" = the scene changed but nothing demands a spoken reaction right now.',
    '"none" = the frame is essentially the same as before, or is idle/static UI.',
    "Be conservative with high — most frames are none or low. Reserve high for moments a human spectator would genuinely react to out loud.",
    "Do not write dialogue or commands."
  ].join(" ");
  const recentTranscript = getRecentTranscriptSnippet(session);
  const userPromptParts = [
    `Frame from ${speakerName}'s stream.`,
    previousNote ? `Previous private note: ${previousNote}` : "Previous private note: none."
  ];
  if (recentTranscript) {
    userPromptParts.push(`Recent conversation: ${recentTranscript}`);
  }
  userPromptParts.push(
    String(brainContextSettings.prompt || DEFAULT_STREAM_WATCH_BRAIN_CONTEXT_PROMPT),
    "Focus only on what is visible now. Mention uncertainty briefly if needed."
  );
  const userPrompt = userPromptParts.join(" ");

  const generated = await manager.llm.generate({
    settings: {
      ...(settings || {}),
      llm: providerSettings
    },
    systemPrompt,
    userPrompt,
    imageInputs: [
      {
        mediaType: String(frameMimeType || "image/jpeg"),
        dataBase64: normalizedFrame
      }
    ],
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      source: "voice_stream_watch_brain_context"
    },
    jsonSchema: STREAM_WATCH_FRAME_ANALYSIS_JSON_SCHEMA
  });

  const rawText = String(generated?.text || "").trim();
  const parsed = safeJsonParseFromString(rawText, null);
  const parsedNote = parsed && typeof parsed === "object" ? parsed.note : "";
  const oneLine = String(parsedNote || rawText).split(/\r?\n/)[0] || "";
  const text = normalizeVoiceText(oneLine, STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!text) return null;
  const VALID_URGENCY_VALUES = ["high", "low", "none"];
  const rawUrgency = parsed && typeof parsed === "object" ? String(parsed.urgency || "").trim().toLowerCase() : "";
  const urgency = VALID_URGENCY_VALUES.includes(rawUrgency) ? rawUrgency : "none";
  return {
    text,
    urgency,
    provider: generated?.provider || providerSettings.provider || null,
    model: generated?.model || providerSettings.model || null
  };
}

async function maybeRefreshStreamWatchBrainContext(manager: StreamWatchManager, {
  session,
  settings,
  streamerUserId = null,
  source = "api_stream_ingest"
}) {
  if (!session || session.ending) return null;
  if (!session.streamWatch?.active) return null;
  const brainContextSettings = resolveStreamWatchBrainContextSettings(settings);
  if (!brainContextSettings.enabled) return null;
  const now = Date.now();
  const minIntervalMs = brainContextSettings.minIntervalSeconds * 1000;
  if (now - Number(session.streamWatch.lastBrainContextAt || 0) < minIntervalMs) return null;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return null;
  const previousEntries = getStreamWatchBrainContextEntries(session, brainContextSettings.maxEntries);
  const previousLast = previousEntries[previousEntries.length - 1] || null;
  const generated = await generateVisionFallbackStreamWatchBrainContext(manager, {
    session,
    settings,
    streamerUserId,
    frameMimeType: session.streamWatch?.latestFrameMimeType || "image/jpeg",
    frameDataBase64: bufferedFrame
  });
  const note = normalizeVoiceText(generated?.text || "", STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS);
  if (!note) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || null;
  const stored = appendStreamWatchBrainContextEntry({
    session,
    text: note,
    at: now,
    provider: generated?.provider || null,
    model: generated?.model || null,
    speakerName,
    maxEntries: brainContextSettings.maxEntries
  });
  if (!stored) return null;

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "stream_watch_brain_context_updated",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      streamerUserId: streamerUserId || null,
      provider: generated?.provider || null,
      model: generated?.model || null,
      note: stored.text
    }
  });

  return {
    note: stored.text,
    urgency: String(generated?.urgency || "none"),
    provider: generated?.provider || null,
    model: generated?.model || null
  };
}

async function generateStreamWatchMemoryRecap(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  const notesText = buildStreamWatchNotesText(session, 6);
  if (!notesText) return null;
  const speakerName = manager.resolveVoiceSpeakerName(session, session.streamWatch?.targetUserId) || "the streamer";
  const systemPrompt = [
    `You are ${getPromptBotName(settings)} summarizing an ended screen-watch session for memory.`,
    "You will receive recent observations captured during one screen-watch session.",
    "Return strict JSON only.",
    "recap must be one concise grounded sentence, max 22 words.",
    "shouldStore should be true if the recap is useful future continuity for this conversation or likely relevant later.",
    "Avoid filler, speculation, and talk about the bot."
  ].join(" ");
  const userPromptParts = [
    `Speaker: ${speakerName}`,
    `Stop reason: ${String(reason || "watching_stopped")}`
  ];
  if (notesText) {
    userPromptParts.push("Recent screen observations:");
    userPromptParts.push(notesText);
  }
  const userPrompt = userPromptParts.join("\n");

  try {
    const generated = await manager.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        source: "voice_stream_watch_memory_recap"
      },
      jsonSchema: STREAM_WATCH_MEMORY_RECAP_JSON_SCHEMA
    });
    const parsed = safeJsonParseFromString(String(generated?.text || ""), null);
    const recap = normalizeVoiceText(parsed?.recap || "", 190);
    if (!recap) return null;
    return {
      recap,
      shouldStore: parsed?.shouldStore !== undefined ? Boolean(parsed.shouldStore) : true
    };
  } catch {
    const latestNote = getLatestStreamWatchBrainContextEntry(session)?.text || "";
    const recap = normalizeVoiceText(
      `${speakerName} recently screen-shared ${latestNote || "their current screen context"}.`,
      190
    );
    return recap
      ? {
          recap,
          shouldStore: true
        }
      : null;
  }
}

async function persistStreamWatchRecapToMemory(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped"
}) {
  if (!session || session.ending) return null;
  if (!settings?.memory?.enabled) return null;
  if (!manager.memory || typeof manager.memory !== "object") return null;
  if (typeof manager.memory.ingestMessage !== "function") return null;

  const recap = await generateStreamWatchMemoryRecap(manager, {
    session,
    settings,
    reason
  });
  if (!recap?.recap) return null;

  const messageId = `voice-screen-share-recap-${session.id}-${Date.now()}`;
  const authorId = String(manager.client.user?.id || "bot");
  const authorName = String(getBotName(settings) || manager.client.user?.username || "bot");
  const logContent = normalizeVoiceText(`Screen share recap: ${recap.recap}`, 320);
  if (logContent) {
    await manager.memory.ingestMessage({
      messageId,
      authorId,
      authorName,
      content: logContent,
      isBot: true,
      settings,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: authorId,
        source: "voice_stream_watch_memory_recap"
      }
    });
  }

  let durableSaved = false;
  if (recap.shouldStore && typeof manager.memory.rememberDirectiveLineDetailed === "function") {
    const saved = await manager.memory.rememberDirectiveLineDetailed({
      line: recap.recap,
      sourceMessageId: messageId,
      userId: authorId,
      guildId: session.guildId,
      channelId: session.textChannelId,
      sourceText: recap.recap,
      scope: "lore",
      validationMode: "strict"
    });
    durableSaved = Boolean(saved?.ok);
  }

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: authorId,
    content: "stream_watch_memory_recap_saved",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "watching_stopped"),
      recap: recap.recap,
      durableSaved
    }
  });

  session.streamWatch.lastMemoryRecapAt = Date.now();
  session.streamWatch.lastMemoryRecapText = recap.recap;
  session.streamWatch.lastMemoryRecapDurableSaved = durableSaved;
  session.streamWatch.lastMemoryRecapReason = String(reason || "watching_stopped");

  return {
    recap: recap.recap,
    durableSaved
  };
}

async function finalizeStreamWatchState(manager: StreamWatchManager, {
  session,
  settings,
  reason = "watching_stopped",
  preserveBrainContext = true,
  persistMemory = true
}) {
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const memoryRecap = persistMemory
    ? await persistStreamWatchRecapToMemory(manager, {
        session,
        settings: resolvedSettings,
        reason
      })
    : null;
  const previousTargetUserId = String(session.streamWatch?.targetUserId || "").trim() || null;

  unsubscribeNativeDiscordVideo(manager, session, previousTargetUserId, reason);
  disconnectNativeDiscordStreamTransport(manager, session, reason);

  session.streamWatch.active = false;
  session.streamWatch.targetUserId = null;
  session.streamWatch.requestedByUserId = null;
  session.streamWatch.latestFrameMimeType = null;
  session.streamWatch.latestFrameDataBase64 = "";
  session.streamWatch.latestFrameAt = 0;

  if (!preserveBrainContext) {
    session.streamWatch.lastBrainContextAt = 0;
    session.streamWatch.lastBrainContextProvider = null;
    session.streamWatch.lastBrainContextModel = null;
    session.streamWatch.brainContextEntries = [];
  }

  return {
    ok: true,
    reason: "watching_stopped",
    memoryRecap
  };
}

export function isUserInSessionVoiceChannel(manager: StreamWatchManager, { session, userId }) {
  const normalizedUserId = String(userId || "").trim();
  if (!session || !normalizedUserId) return false;
  const guild = manager.client.guilds.cache.get(String(session.guildId || "")) || null;
  const voiceChannel = guild?.channels?.cache?.get(String(session.voiceChannelId || "")) || null;
  return Boolean(voiceChannel?.members?.has?.(normalizedUserId));
}

export function isStreamWatchFrameReady(session) {
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  if (Number(nativeScreenShare.lastDecodeSuccessAt || 0) > 0) {
    return true;
  }
  const latestFrameMimeType = String(session?.streamWatch?.latestFrameMimeType || "").trim().toLowerCase();
  const latestFrameDataBase64 = String(session?.streamWatch?.latestFrameDataBase64 || "").trim();
  return latestFrameMimeType.startsWith("image/") && latestFrameDataBase64.length > 0;
}

function canReuseActiveStreamWatch(session, targetUserId: string) {
  if (!session?.streamWatch?.active) return false;
  const activeTargetUserId = String(session.streamWatch?.targetUserId || "").trim();
  if (!activeTargetUserId || activeTargetUserId !== targetUserId) return false;

  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const transportStatus = String(nativeScreenShare.transportStatus || "").trim().toLowerCase();
  if (["waiting_for_credentials", "connect_requested", "connecting", "ready"].includes(transportStatus)) {
    return true;
  }

  if (isStreamWatchFrameReady(session)) {
    return true;
  }

  return listActiveNativeDiscordScreenSharers(session).some((entry) => entry.userId === targetUserId);
}

function getStreamWatchReadinessResult(session, targetUserId: string) {
  const frameReady = isStreamWatchFrameReady(session);
  return {
    ok: true,
    reused: true,
    frameReady,
    reason: frameReady ? "frame_context_ready" : "waiting_for_frame_context",
    targetUserId: String(session?.streamWatch?.targetUserId || targetUserId).trim() || targetUserId
  };
}

export async function enableWatchStreamForUser(manager: StreamWatchManager, {
  guildId,
  requesterUserId,
  targetUserId = null,
  settings = null,
  source = "screen_share_link"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedRequesterId) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }

  if (!isUserInSessionVoiceChannel(manager, { session, userId: normalizedRequesterId })) {
    return {
      ok: false,
      reason: "requester_not_in_same_vc"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      ok: false,
      reason: "stream_watch_disabled"
    };
  }

  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      ok: false,
      reason: "stream_watch_provider_unavailable"
    };
  }

  const resolvedTarget = String(targetUserId || normalizedRequesterId).trim() || normalizedRequesterId;
  if (canReuseActiveStreamWatch(session, resolvedTarget)) {
    subscribeNativeDiscordVideo(manager, session, resolvedSettings, resolvedTarget, source);
    const reusedResult = getStreamWatchReadinessResult(session, resolvedTarget);
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedRequesterId,
      content: "stream_watch_reused_programmatic",
      metadata: {
        sessionId: session.id,
        source: String(source || "screen_share_link"),
        targetUserId: reusedResult.targetUserId,
        frameReady: reusedResult.frameReady,
        streamKey: ensureNativeDiscordScreenShareState(session).activeStreamKey || null,
        transportStatus: ensureNativeDiscordScreenShareState(session).transportStatus || null
      }
    });
    return reusedResult;
  }
  if (
    session.streamWatch?.active &&
    String(session.streamWatch.targetUserId || "").trim() &&
    String(session.streamWatch.targetUserId || "").trim() !== resolvedTarget
  ) {
    await finalizeStreamWatchState(manager, {
      session,
      settings: resolvedSettings,
      reason: "stream_watch_retargeted",
      preserveBrainContext: true,
      persistMemory: true
    });
  }

  initializeStreamWatchState(manager, {
    session,
    requesterUserId: normalizedRequesterId,
    targetUserId: resolvedTarget
  });
  const nativeTransportRequest = requestNativeDiscordStreamWatch(manager, session, {
    targetUserId: resolvedTarget,
    source
  });
  if (!nativeTransportRequest.ok) {
    return {
      ok: false,
      reason: nativeTransportRequest.reason,
      fallback: nativeTransportRequest.fallback
    };
  }
  if (nativeTransportRequest.stream && streamHasCredentials(nativeTransportRequest.stream)) {
    const connectResult = connectNativeDiscordStreamTransport(manager, session, nativeTransportRequest.stream, {
      source
    });
    if (!connectResult.ok) {
      return {
        ok: false,
        reason: connectResult.reason,
        fallback: "screen_share_link"
      };
    }
  } else {
    updateNativeDiscordStreamTransportState(session, {
      transportStatus: "waiting_for_credentials",
      transportReason: null
    });
  }
  subscribeNativeDiscordVideo(manager, session, resolvedSettings, resolvedTarget, source);
  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedRequesterId,
    content: "stream_watch_enabled_programmatic",
    metadata: {
      sessionId: session.id,
      source: String(source || "screen_share_link"),
      targetUserId: resolvedTarget,
      streamKey: ensureNativeDiscordScreenShareState(session).activeStreamKey || null,
      transportStatus: ensureNativeDiscordScreenShareState(session).transportStatus || null
    }
  });

  const frameReady = isStreamWatchFrameReady(session);
  return {
    ok: true,
    reused: false,
    frameReady,
    reason: frameReady ? "frame_context_ready" : "waiting_for_frame_context",
    targetUserId: session.streamWatch?.targetUserId || resolvedTarget
  };
}

export async function requestStopWatchingStream(manager: StreamWatchManager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  if (!session.streamWatch?.active) {
    await sendOperationalMessage(manager, {
      channel: message.channel,
      settings,
      guildId,
      channelId: message.channelId,
      userId: requesterId,
      messageId: message.id,
      event: "voice_stream_watch_request",
      reason: "already_stopped",
      details: {},
      mustNotify: false
    });
    return true;
  }

  const stopResult = await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason: "watching_stopped",
    preserveBrainContext: true,
    persistMemory: true
  });

  await sendOperationalMessage(manager, {
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "watching_stopped",
    details: {},
    mustNotify: false
  });
  return Boolean(stopResult?.ok);
}

export async function stopWatchStreamForUser(manager: StreamWatchManager, {
  guildId,
  requesterUserId = null,
  targetUserId = null,
  settings = null,
  reason = "screen_share_session_stopped"
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      ok: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      ok: false,
      reason: "session_not_found"
    };
  }
  if (!session.streamWatch?.active) {
    return {
      ok: false,
      reason: "already_stopped"
    };
  }

  const normalizedRequesterId = String(requesterUserId || "").trim();
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (
    normalizedRequesterId &&
    session.streamWatch?.requestedByUserId &&
    String(session.streamWatch.requestedByUserId) !== normalizedRequesterId
  ) {
    return {
      ok: false,
      reason: "requester_mismatch"
    };
  }
  if (
    normalizedTargetUserId &&
    session.streamWatch?.targetUserId &&
    String(session.streamWatch.targetUserId) !== normalizedTargetUserId
  ) {
    return {
      ok: false,
      reason: "target_user_mismatch"
    };
  }

  return await finalizeStreamWatchState(manager, {
    session,
    settings,
    reason,
    preserveBrainContext: true,
    persistMemory: true
  });
}

export function handleDiscoveredStreamCredentialsReceived(
  manager: StreamWatchManager,
  {
    stream
  }: {
    stream: GoLiveStream;
  }
) {
  const normalizedGuildId = String(stream?.guildId || "").trim();
  const normalizedUserId = String(stream?.userId || "").trim();
  if (!normalizedGuildId || !normalizedUserId) return false;

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending || !session.streamWatch?.active) return false;
  if (String(session.streamWatch.targetUserId || "").trim() !== normalizedUserId) return false;

  connectNativeDiscordStreamTransport(manager, session, stream, {
    source: "stream_credentials_received"
  });
  return true;
}

export async function handleDiscoveredStreamDeleted(
  manager: StreamWatchManager,
  {
    stream,
    settings = null
  }: {
    stream: GoLiveStream;
    settings?: Record<string, unknown> | null;
  }
) {
  const normalizedGuildId = String(stream?.guildId || "").trim();
  const normalizedUserId = String(stream?.userId || "").trim();
  if (!normalizedGuildId || !normalizedUserId) return false;

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending || !session.streamWatch?.active) return false;
  if (String(session.streamWatch.targetUserId || "").trim() !== normalizedUserId) return false;

  removeNativeDiscordVideoSharer(session, normalizedUserId);
  updateNativeDiscordStreamTransportState(session, {
    activeStreamKey: stream.streamKey,
    transportStatus: "stream_deleted",
    transportReason: null
  });

  await stopWatchStreamForUser(manager, {
    guildId: normalizedGuildId,
    targetUserId: normalizedUserId,
    settings,
    reason: "native_discord_stream_deleted"
  });
  return true;
}

export async function requestStreamWatchStatus(manager: StreamWatchManager, { message, settings }) {
  const context = await resolveStreamWatchRequestContext(manager, { message, settings });
  if (!context) return false;
  if (context.handled) return true;
  const { guildId, session, requesterId } = context;

  const streamWatch = session.streamWatch || {};
  const nativeScreenShare = ensureNativeDiscordScreenShareState(session);
  const lastFrameAgoSec = Number(streamWatch.lastFrameAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastFrameAt || 0)) / 1000))
    : null;
  const lastCommentaryAgoSec = Number(streamWatch.lastCommentaryAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastCommentaryAt || 0)) / 1000))
    : null;
  const lastBrainContextAgoSec = Number(streamWatch.lastBrainContextAt || 0)
    ? Math.max(0, Math.floor((Date.now() - Number(streamWatch.lastBrainContextAt || 0)) / 1000))
    : null;

  await sendOperationalMessage(manager, {
    channel: message.channel,
    settings,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    messageId: message.id,
    event: "voice_stream_watch_request",
    reason: "status",
    details: {
      active: Boolean(streamWatch.active),
      mode: session.mode,
      targetUserId: streamWatch.targetUserId || null,
      lastFrameAgoSec,
      lastCommentaryAgoSec,
      lastBrainContextAgoSec,
      ingestedFrameCount: Number(streamWatch.ingestedFrameCount || 0),
      activeStreamKey: nativeScreenShare.activeStreamKey || null,
      transportStatus: nativeScreenShare.transportStatus || null,
      transportReason: nativeScreenShare.transportReason || null
    }
  });
  return true;
}

export async function ingestStreamFrame(manager: StreamWatchManager, {
  guildId,
  streamerUserId = null,
  mimeType = "image/jpeg",
  dataBase64 = "",
  source = "api_stream_ingest",
  settings = null
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    return {
      accepted: false,
      reason: "guild_id_required"
    };
  }

  const session = manager.sessions.get(normalizedGuildId);
  if (!session || session.ending) {
    return {
      accepted: false,
      reason: "session_not_found"
    };
  }

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};
  if (!streamWatchSettings.enabled) {
    return {
      accepted: false,
      reason: "stream_watch_disabled"
    };
  }
  if (!supportsStreamWatchCommentary(manager, session, resolvedSettings)) {
    return {
      accepted: false,
      reason: "provider_video_ingest_unavailable"
    };
  }

  const streamWatch = session.streamWatch || {};
  if (!streamWatch.active) {
    return {
      accepted: false,
      reason: "watch_not_active"
    };
  }

  const normalizedStreamerId = String(streamerUserId || "").trim() || null;
  if (streamWatch.targetUserId && !normalizedStreamerId) {
    return {
      accepted: false,
      reason: "streamer_user_id_required",
      targetUserId: streamWatch.targetUserId
    };
  }

  if (streamWatch.targetUserId && streamWatch.targetUserId !== normalizedStreamerId) {
    return {
      accepted: false,
      reason: "target_user_mismatch",
      targetUserId: streamWatch.targetUserId
    };
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  const allowedMimeType =
    normalizedMimeType === "image/jpeg" ||
    normalizedMimeType === "image/jpg" ||
    normalizedMimeType === "image/png" ||
    normalizedMimeType === "image/webp";
  if (!allowedMimeType) {
    return {
      accepted: false,
      reason: "invalid_mime_type"
    };
  }

  const normalizedFrame = String(dataBase64 || "").trim();
  if (!normalizedFrame) {
    return {
      accepted: false,
      reason: "frame_data_required"
    };
  }

  const maxFrameBytes = clamp(
    Number(streamWatchSettings.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );
  const approxBytes = Math.floor((normalizedFrame.length * 3) / 4);
  if (approxBytes > maxFrameBytes) {
    return {
      accepted: false,
      reason: "frame_too_large",
      maxFrameBytes
    };
  }

  const maxFramesPerMinute = clamp(
    Number(streamWatchSettings.maxFramesPerMinute) || 180,
    6,
    600
  );
  const now = Date.now();
  if (!streamWatch.frameWindowStartedAt || now - Number(streamWatch.frameWindowStartedAt) >= 60_000) {
    streamWatch.frameWindowStartedAt = now;
    streamWatch.acceptedFrameCountInWindow = 0;
  }
  if (Number(streamWatch.acceptedFrameCountInWindow || 0) >= maxFramesPerMinute) {
    return {
      accepted: false,
      reason: "frame_rate_limited",
      maxFramesPerMinute
    };
  }

  const realtimeClient = session.realtimeClient;
  const resolvedMimeType = normalizedMimeType === "image/jpg" ? "image/jpeg" : normalizedMimeType;
  if (realtimeClient && typeof realtimeClient.appendInputVideoFrame === "function") {
    try {
      realtimeClient.appendInputVideoFrame({
        mimeType: resolvedMimeType,
        dataBase64: normalizedFrame
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedStreamerId || manager.client.user?.id || null,
        content: `stream_watch_frame_ingest_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
      return {
        accepted: false,
        reason: "frame_ingest_failed"
      };
    }
  }
  streamWatch.latestFrameMimeType = resolvedMimeType;
  streamWatch.latestFrameDataBase64 = normalizedFrame;
  streamWatch.latestFrameAt = now;

  streamWatch.lastFrameAt = now;
  streamWatch.ingestedFrameCount = Number(streamWatch.ingestedFrameCount || 0) + 1;
  streamWatch.acceptedFrameCountInWindow = Number(streamWatch.acceptedFrameCountInWindow || 0) + 1;
  manager.touchActivity(session.guildId, resolvedSettings);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedStreamerId || manager.client.user?.id || null,
    content: "stream_watch_frame_ingested",
    metadata: {
      sessionId: session.id,
      source: String(source || "api_stream_ingest"),
      mimeType: resolvedMimeType,
      frameBytes: approxBytes,
      totalFrames: streamWatch.ingestedFrameCount
    }
  });

  await maybeTriggerStreamWatchCommentary(manager, {
    session,
    settings: resolvedSettings,
    streamerUserId: normalizedStreamerId,
    source
  });

  return {
    accepted: true,
    reason: "ok",
    targetUserId: streamWatch.targetUserId || null
  };
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

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const streamWatchSettings = resolvedSettings?.voice?.streamWatch || {};

  // Keep the rolling notes fresh; they become normal prompt context for any later brain turn.
  let brainContextUpdate = null;
  if (supportsStreamWatchBrainContext(manager, { session, settings: resolvedSettings })) {
    try {
      brainContextUpdate = await maybeRefreshStreamWatchBrainContext(manager, {
        session,
        settings: resolvedSettings,
        streamerUserId,
        source
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `stream_watch_brain_context_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "api_stream_ingest")
        }
      });
    }
  }

  const autonomousCommentaryEnabled =
    streamWatchSettings.autonomousCommentaryEnabled !== undefined
      ? Boolean(streamWatchSettings.autonomousCommentaryEnabled)
      : true;
  if (!autonomousCommentaryEnabled) return;
  if (typeof manager.runRealtimeBrainReply !== "function") return;

  if (session.userCaptures.size > 0) return;
  if (session.pendingResponse) return;
  if (isStreamWatchPlaybackBusy(session)) return;
  if (hasQueuedVoiceWork(manager, session)) return;

  const quietWindowMs = STREAM_WATCH_AUDIO_QUIET_WINDOW_MS;
  const now = Date.now();
  const sinceLastInboundAudio = now - Number(session.lastInboundAudioAt || 0);
  if (Number(session.lastInboundAudioAt || 0) > 0 && sinceLastInboundAudio < quietWindowMs) return;

  const minCommentaryIntervalSeconds = clamp(
    Number(streamWatchSettings.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  if (now - Number(session.streamWatch.lastCommentaryAt || 0) < minCommentaryIntervalSeconds * 1000) return;

  const firstFrameTriggered = Number(session.streamWatch.ingestedFrameCount || 0) <= 1;
  const urgencyTriggered = String(brainContextUpdate?.urgency || "none") === "high";

  if (!firstFrameTriggered && !urgencyTriggered) return;

  const bufferedFrame = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  if (!bufferedFrame) return;

  const frozenFrameSnapshot = {
    mimeType: String(session.streamWatch?.latestFrameMimeType || "image/jpeg"),
    dataBase64: bufferedFrame
  };
  const speakerName = manager.resolveVoiceSpeakerName(session, streamerUserId) || "the streamer";
  const latestBrainContextEntries = Array.isArray(session.streamWatch?.brainContextEntries)
    ? session.streamWatch.brainContextEntries
    : [];
  const latestNote = normalizeVoiceText(
    brainContextUpdate?.note ||
      latestBrainContextEntries[latestBrainContextEntries.length - 1]?.text ||
      "",
    STREAM_WATCH_BRAIN_CONTEXT_LINE_MAX_CHARS
  );
  const triggerReason = firstFrameTriggered ? "share_start" : "urgent";
  const normalizedStreamerUserId = String(streamerUserId || "").trim() || null;
  const botUserId = String(manager.client.user?.id || "").trim() || null;
  const transcript =
    triggerReason === "share_start"
      ? `[${speakerName} started screen sharing. You can see the latest frame.]`
      : `[${speakerName} is screen sharing. Something notable just happened on screen.]`;

  session.streamWatch.lastCommentaryAt = now;
  session.streamWatch.lastCommentaryNote = latestNote || null;

  void manager.runRealtimeBrainReply({
    session,
    settings: resolvedSettings,
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
      urgency: String(brainContextUpdate?.urgency || "none"),
      latestNote: latestNote || null
    }
  });
}
