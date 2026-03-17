import { normalizeSkipSentinel } from "./botHelpers.ts";
import { sanitizeBotText } from "../utils.ts";
import type { BotContext } from "./botContext.ts";
import { resolveNativeDiscordScreenWatchTarget, listActiveNativeDiscordScreenSharers } from "../voice/nativeDiscordScreenShare.ts";
import { hasNativeDiscordVideoDecoderSupport } from "../voice/nativeDiscordVideoDecoder.ts";
import {
  resolveOperationalChannel as resolveOperationalChannelForVoiceOperationalMessaging,
  sendToChannel as sendToChannelForVoiceOperationalMessaging
} from "../voice/voiceOperationalMessaging.ts";

const SCREEN_WATCH_MESSAGE_MAX_CHARS = 420;
const SCREEN_WATCH_INTENT_THRESHOLD = 0.66;
const SCREEN_WATCH_EXPLICIT_REQUEST_RE =
  /\b(?:screen\s*share|share\s*(?:my|the)?\s*screen|watch\s*(?:my|the)?\s*screen|see\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*screen|look\s*at\s*(?:my|the)?\s*stream|watch\s*(?:my|the)?\s*stream)\b/i;

export type ScreenWatchLinkCapability = {
  enabled?: boolean;
  status?: string;
  publicUrl?: string;
  reason?: string | null;
};

export type ScreenWatchLinkSessionResult = {
  ok: boolean;
  reason?: string;
  shareUrl?: string;
  expiresInMinutes?: number;
  reused?: boolean;
  targetUserId?: string | null;
};

export type ScreenWatchSessionManagerLike = {
  getLinkCapability?: () => ScreenWatchLinkCapability;
  createSession?: (payload: {
    guildId: string;
    channelId: string | null;
    requesterUserId: string;
    requesterDisplayName?: string;
    targetUserId?: string | null;
    source?: string;
  }) => Promise<ScreenWatchLinkSessionResult>;
};

export type ScreenShareSessionManagerLike = ScreenWatchSessionManagerLike;

type ScreenWatchMessageLike = {
  guild?: {
    members?: {
      cache?: {
        get: (id: string) => {
          displayName?: string;
          user?: {
            username?: string;
          } | null;
        } | undefined;
      } | null;
    } | null;
  } | null;
  guildId?: string | null;
  channelId?: string | null;
  id?: string | null;
  content?: string | null;
  author?: {
    id?: string | null;
    username?: string | null;
  } | null;
  member?: {
    displayName?: string | null;
    user?: {
      username?: string | null;
    } | null;
  } | null;
};

type ScreenWatchVoiceSessionLike = {
  id?: string | null;
  ending?: boolean;
  mode?: string | null;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  settingsSnapshot?: Record<string, unknown> | null;
  streamWatch?: {
    active?: boolean;
    targetUserId?: string | null;
    latestFrameMimeType?: string | null;
    latestFrameDataBase64?: string | null;
  } | null;
  nativeScreenShare?: {
    sharers?: Map<string, {
      userId: string;
      codec?: string | null;
    }>;
    transportStatus?: string | null;
    lastDecodeSuccessAt?: number;
  } | null;
  goLiveStream?: {
    active?: boolean;
    streamKey?: string | null;
    targetUserId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
  } | null;
  goLiveStreams?: Map<string, {
    active?: boolean;
    streamKey?: string | null;
    targetUserId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    discoveredAt?: number;
    credentialsReceivedAt?: number;
  }> | null;
} | null;

type ScreenWatchParticipantLike = {
  userId?: string | null;
  displayName?: string | null;
};

type ScreenWatchTargetCandidate = {
  userId: string;
  displayName: string;
  username: string | null;
  activeSharer: boolean;
  lastFrameAt: number;
};

export interface ScreenShareRuntime extends BotContext {
  readonly screenShareSessionManager: ScreenWatchSessionManagerLike | null;
  readonly voiceSessionManager?: {
    getSession?: (guildId: string) => ScreenWatchVoiceSessionLike;
    getVoiceChannelParticipants?: (session: NonNullable<ScreenWatchVoiceSessionLike>) => ScreenWatchParticipantLike[];
    hasNativeDiscordVideoDecoderSupport?: () => boolean;
    isUserInSessionVoiceChannel?: (payload: {
      session: NonNullable<ScreenWatchVoiceSessionLike>;
      userId: string;
    }) => boolean;
    supportsStreamWatchCommentary?: (
      session: NonNullable<ScreenWatchVoiceSessionLike>,
      settings?: Record<string, unknown> | null
    ) => boolean;
    enableWatchStreamForUser?: (payload: {
      guildId: string;
      requesterUserId: string;
      targetUserId?: string | null;
      settings?: Record<string, unknown> | null;
      source?: string;
    }) => Promise<{
      ok: boolean;
      reason?: string;
      targetUserId?: string;
      fallback?: string;
      reused?: boolean;
      frameReady?: boolean;
    }>;
  } | null;
  composeVoiceOperationalMessage: (payload: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string;
    reason?: string | null;
    details?: Record<string, unknown>;
    maxOutputChars?: number;
    allowSkip?: boolean;
  }) => Promise<string>;
  composeScreenShareOfferMessage?: (payload: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    linkUrl: string;
    expiresInMinutes?: number;
    explicitRequest?: boolean;
    intentRequested?: boolean;
    confidence?: number;
    source?: string;
  }) => Promise<string>;
  composeScreenShareUnavailableMessage?: (payload: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    reason?: string;
    source?: string;
  }) => Promise<string>;
  resolveOperationalChannel?: (
    channel: unknown,
    channelId: string | null,
    meta?: {
      guildId?: string | null;
      userId?: string | null;
      messageId?: string | null;
      event?: string | null;
      reason?: string | null;
    }
  ) => Promise<unknown>;
  sendToChannel?: (
    channel: unknown,
    text: string,
    meta?: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      messageId?: string | null;
      event?: string | null;
      reason?: string | null;
    }
  ) => Promise<boolean>;
}

function supportsNativeDiscordVideoDecode(runtime: ScreenShareRuntime) {
  if (typeof runtime.voiceSessionManager?.hasNativeDiscordVideoDecoderSupport === "function") {
    return Boolean(runtime.voiceSessionManager.hasNativeDiscordVideoDecoderSupport());
  }
  return hasNativeDiscordVideoDecoderSupport();
}

function isScreenWatchEnabled(settings: Record<string, unknown> | null | undefined) {
  const voiceSettings =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? Reflect.get(settings, "voice")
      : null;
  const streamWatchSettings =
    voiceSettings && typeof voiceSettings === "object" && !Array.isArray(voiceSettings)
      ? Reflect.get(voiceSettings, "streamWatch")
      : null;
  return Boolean(
    streamWatchSettings &&
    typeof streamWatchSettings === "object" &&
    !Array.isArray(streamWatchSettings) &&
    Reflect.get(streamWatchSettings, "enabled")
  );
}

function isStreamLinkFallbackEnabled(runtime: ScreenShareRuntime) {
  return runtime.appConfig?.streamLinkFallbackEnabled !== false;
}

function safeUrlHost(rawUrl: string) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}

function normalizeScreenWatchTargetToken(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  if (mentionMatch?.[1]) {
    return mentionMatch[1];
  }
  return raw.replace(/^@+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getRuntimeDisplayName(runtime: ScreenShareRuntime, guildId: string, userId: string) {
  const guild = runtime.client.guilds.cache.get(guildId) || null;
  return (
    guild?.members?.cache?.get(userId)?.displayName ||
    guild?.members?.cache?.get(userId)?.user?.username ||
    runtime.client.users?.cache?.get(userId)?.username ||
    ""
  );
}

function getRuntimeUsername(runtime: ScreenShareRuntime, guildId: string, userId: string) {
  const guild = runtime.client.guilds.cache.get(guildId) || null;
  return (
    guild?.members?.cache?.get(userId)?.user?.username ||
    runtime.client.users?.cache?.get(userId)?.username ||
    null
  );
}

function candidateMatchesTarget(candidate: ScreenWatchTargetCandidate, normalizedTarget: string) {
  if (!normalizedTarget) return false;
  if (candidate.userId === normalizedTarget) return true;
  return [
    normalizeScreenWatchTargetToken(candidate.displayName),
    normalizeScreenWatchTargetToken(candidate.username)
  ].includes(normalizedTarget);
}

function buildScreenWatchTargetCandidates(
  runtime: ScreenShareRuntime,
  session: ScreenWatchVoiceSessionLike,
  guildId: string
) {
  const candidates = new Map<string, ScreenWatchTargetCandidate>();
  const voiceManager = runtime.voiceSessionManager;
  const activeSharers = listActiveNativeDiscordScreenSharers(session);

  const upsertCandidate = (
    userId: string | null | undefined,
    patch: Partial<ScreenWatchTargetCandidate> = {}
  ) => {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;
    const existing = candidates.get(normalizedUserId);
    const displayNameFromRuntime = getRuntimeDisplayName(runtime, guildId, normalizedUserId);
    const usernameFromRuntime = getRuntimeUsername(runtime, guildId, normalizedUserId);
    const nextValue: ScreenWatchTargetCandidate = {
      userId: normalizedUserId,
      displayName:
        String(patch.displayName || existing?.displayName || displayNameFromRuntime || normalizedUserId).trim() ||
        normalizedUserId,
      username:
        String(patch.username || existing?.username || usernameFromRuntime || "").trim() || null,
      activeSharer: Boolean(existing?.activeSharer || patch.activeSharer),
      lastFrameAt: Math.max(0, Number(patch.lastFrameAt ?? existing?.lastFrameAt ?? 0))
    };
    candidates.set(normalizedUserId, nextValue);
  };

  const participants =
    session &&
    typeof voiceManager?.getVoiceChannelParticipants === "function"
      ? voiceManager.getVoiceChannelParticipants(session)
      : [];
  for (const participant of Array.isArray(participants) ? participants : []) {
    upsertCandidate(participant?.userId, {
      displayName: String(participant?.displayName || "").trim() || undefined
    });
  }

  for (const sharer of activeSharers) {
    upsertCandidate(sharer.userId, {
      activeSharer: true,
      lastFrameAt: Number(sharer.lastFrameAt || sharer.updatedAt || 0)
    });
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.activeSharer !== right.activeSharer) {
      return left.activeSharer ? -1 : 1;
    }
    if (left.lastFrameAt !== right.lastFrameAt) {
      return right.lastFrameAt - left.lastFrameAt;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

function listDiscoveredGoLiveBootstrapStreams(session: ScreenWatchVoiceSessionLike) {
  const goLiveStreams = session?.goLiveStreams;
  if (goLiveStreams instanceof Map && goLiveStreams.size > 0) {
    return [...goLiveStreams.values()].filter((stream) => String(stream?.targetUserId || "").trim());
  }
  const legacyStream = session?.goLiveStream;
  return legacyStream && String(legacyStream.targetUserId || "").trim()
    ? [legacyStream]
    : [];
}

function getDiscoveredGoLiveBootstrapTargetUserIds(session: ScreenWatchVoiceSessionLike) {
  return listDiscoveredGoLiveBootstrapStreams(session).map((stream) => String(stream?.targetUserId || "").trim()).filter(Boolean);
}

function getDiscoveredGoLiveBootstrapStreamForUser(
  session: ScreenWatchVoiceSessionLike,
  targetUserId: string | null | undefined
) {
  const normalizedTargetUserId = String(targetUserId || "").trim();
  if (!normalizedTargetUserId) return null;
  return listDiscoveredGoLiveBootstrapStreams(session).find(
    (stream) => String(stream?.targetUserId || "").trim() === normalizedTargetUserId
  ) || null;
}

function resolveRequestedScreenWatchTarget(
  runtime: ScreenShareRuntime,
  {
    session,
    guildId,
    target
  }: {
    session: ScreenWatchVoiceSessionLike;
    guildId: string;
    target: string | null | undefined;
  }
) {
  const normalizedTarget = normalizeScreenWatchTargetToken(target);
  if (!normalizedTarget) {
    return {
      targetUserId: null,
      activeSharer: false,
      reason: "requested_target_missing"
    };
  }

  const candidates = buildScreenWatchTargetCandidates(runtime, session, guildId);
  const activeMatches = candidates.filter(
    (candidate) => candidate.activeSharer && candidateMatchesTarget(candidate, normalizedTarget)
  );
  if (activeMatches.length === 1) {
    return {
      targetUserId: activeMatches[0]?.userId || null,
      activeSharer: true,
      reason: "requested_target_active_discord_screen_share"
    };
  }
  if (activeMatches.length > 1) {
    return {
      targetUserId: null,
      activeSharer: false,
      reason: "requested_target_ambiguous"
    };
  }

  const participantMatches = candidates.filter((candidate) => candidateMatchesTarget(candidate, normalizedTarget));
  if (participantMatches.length === 1) {
    return {
      targetUserId: participantMatches[0]?.userId || null,
      activeSharer: Boolean(participantMatches[0]?.activeSharer),
      reason: participantMatches[0]?.activeSharer
        ? "requested_target_active_discord_screen_share"
        : "requested_target_in_voice_channel"
    };
  }
  if (participantMatches.length > 1) {
    return {
      targetUserId: null,
      activeSharer: false,
      reason: "requested_target_ambiguous"
    };
  }

  return {
    targetUserId: null,
    activeSharer: false,
    reason: "requested_target_not_in_voice_session"
  };
}

function logNativeScreenWatchStartFailed(
  runtime: ScreenShareRuntime,
  {
    guildId,
    channelId = null,
    requesterUserId,
    session = null,
    source = "screen_watch_request",
    transcript = "",
    requestedTargetUserId = null,
    selectionReason = null,
    reason = "native_screen_watch_unavailable",
    fallback = null
  }: {
    guildId: string;
    channelId?: string | null;
    requesterUserId: string;
    session?: ScreenWatchVoiceSessionLike;
    source?: string;
    transcript?: string;
    requestedTargetUserId?: string | null;
    selectionReason?: string | null;
    reason?: string | null;
    fallback?: string | null;
  }
) {
  const activeSharers = listActiveNativeDiscordScreenSharers(session);
  const goLiveBootstrapTargetUserIds = getDiscoveredGoLiveBootstrapTargetUserIds(session);
  const goLiveBootstrapTargetUserId = goLiveBootstrapTargetUserIds.length === 1
    ? goLiveBootstrapTargetUserIds[0] || null
    : null;
  runtime.store.logAction({
    kind: "voice_runtime",
    guildId,
    channelId,
    userId: requesterUserId,
    content: "screen_watch_native_start_failed",
    metadata: {
      sessionId: String(session?.id || "").trim() || null,
      source: String(source || "screen_watch_request"),
      transcript: String(transcript || "").slice(0, 220),
      requestedTargetUserId: String(requestedTargetUserId || "").trim() || null,
      selectionReason: String(selectionReason || "").trim() || null,
      reason: String(reason || "native_screen_watch_unavailable").trim() || "native_screen_watch_unavailable",
      fallback: String(fallback || "").trim() || null,
      nativeActiveSharerCount: activeSharers.length,
      nativeActiveSharerUserIds: activeSharers.map((entry) => entry.userId),
      goLiveStreamUserId: goLiveBootstrapTargetUserId,
      goLiveStreamUserIds: goLiveBootstrapTargetUserIds,
      goLiveStreamCredentialsReady: goLiveBootstrapTargetUserIds.some((userId) =>
        Boolean(getDiscoveredGoLiveBootstrapStreamForUser(session, userId)?.active)
      ),
      nativeDecoderSupported: supportsNativeDiscordVideoDecode(runtime),
      runtimeMode: String(session?.mode || "").trim() || null,
      voiceChannelId: String(session?.voiceChannelId || "").trim() || null
    }
  });
}

function getLinkScreenWatchCapability(
  runtime: ScreenShareRuntime,
  {
    settings = null
  }: {
    settings?: Record<string, unknown> | null;
  } = {}
) {
  const manager = runtime.screenShareSessionManager;
  const resolvedSettings = settings || runtime.store.getSettings();
  const enabled = isScreenWatchEnabled(resolvedSettings);
  const capability =
    manager && typeof manager.getLinkCapability === "function"
      ? manager.getLinkCapability()
      : null;
  const supported = Boolean(manager && typeof manager.getLinkCapability === "function");

  if (!enabled) {
    return {
      supported,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: String(capability?.publicUrl || "").trim(),
      reason: "stream_watch_disabled"
    };
  }

  if (!isStreamLinkFallbackEnabled(runtime)) {
    return {
      supported,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "stream_link_fallback_disabled"
    };
  }

  if (!manager || typeof manager.getLinkCapability !== "function") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "share_link_unavailable"
    };
  }

  const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
  const linkEnabled = Boolean(capability?.enabled);
  const available = linkEnabled && status === "ready";
  const rawReason = String(capability?.reason || "").trim().toLowerCase();
  return {
    supported: true,
    enabled: linkEnabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "share_link_unavailable"
  };
}

function getDirectScreenWatchCapability(
  runtime: ScreenShareRuntime,
  {
    settings = null,
    guildId = null,
    requesterUserId = null
  }: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    requesterUserId?: string | null;
  } = {}
) {
  const voiceManager = runtime.voiceSessionManager;
  const resolvedSettings = settings || runtime.store.getSettings();
  const enabled = isScreenWatchEnabled(resolvedSettings);
  if (!voiceManager || typeof voiceManager.getSession !== "function") {
    return {
      supported: false,
      enabled,
      available: false,
      status: enabled ? "unavailable" : "disabled",
      reason: "native_screen_watch_unavailable"
    };
  }

  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterUserId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedRequesterUserId) {
    return {
      supported: true,
      enabled,
      available: false,
      status: "unavailable",
      reason: "screen_watch_context_unavailable"
    };
  }

  const session = voiceManager.getSession(normalizedGuildId);
  if (!session || session.ending) {
    return {
      supported: true,
      enabled,
      available: false,
      status: "offline",
      reason: "session_not_found"
    };
  }

  if (!enabled) {
    return {
      supported: true,
      enabled: false,
      available: false,
      status: "disabled",
      reason: "stream_watch_disabled"
    };
  }

  if (!supportsNativeDiscordVideoDecode(runtime)) {
    return {
      supported: true,
      enabled,
      available: false,
      status: "unavailable",
      reason: "native_discord_video_decode_unavailable",
      activeSharerCount: 0,
      activeSharerUserIds: []
    };
  }

  if (
    typeof voiceManager.isUserInSessionVoiceChannel === "function" &&
    !voiceManager.isUserInSessionVoiceChannel({
      session,
      userId: normalizedRequesterUserId
    })
  ) {
    return {
      supported: true,
      enabled,
      available: false,
      status: "unavailable",
      reason: "requester_not_in_same_vc"
    };
  }

  if (
    typeof voiceManager.supportsStreamWatchCommentary === "function" &&
    !voiceManager.supportsStreamWatchCommentary(session, resolvedSettings)
  ) {
    return {
      supported: true,
      enabled,
      available: false,
      status: "unavailable",
      reason: "stream_watch_provider_unavailable"
    };
  }

  const activeSharers = listActiveNativeDiscordScreenSharers(session);
  const targetSelection = resolveNativeDiscordScreenWatchTarget({
    session,
    requesterUserId: normalizedRequesterUserId
  });
  const nativeTargetingAvailable = activeSharers.length > 0;
  const goLiveBootstrapTargetUserIds = getDiscoveredGoLiveBootstrapTargetUserIds(session);
  const goLiveBootstrapTargetUserId = goLiveBootstrapTargetUserIds.length === 1
    ? goLiveBootstrapTargetUserIds[0] || null
    : null;
  const goLiveBootstrapAvailable = goLiveBootstrapTargetUserIds.length > 0;
  const available = nativeTargetingAvailable || goLiveBootstrapAvailable;

  return {
    supported: true,
    enabled,
    available,
    status: available ? "ready" : "unavailable",
    reason:
      nativeTargetingAvailable && !targetSelection.targetUserId
        ? "explicit_target_supported"
        : targetSelection.targetUserId
          ? null
          : goLiveBootstrapAvailable
            ? null
            : targetSelection.reason,
    activeSharerCount: activeSharers.length,
    activeSharerUserIds: activeSharers.map((entry) => entry.userId),
    goLiveStreamUserId: goLiveBootstrapTargetUserId,
    goLiveStreamUserIds: goLiveBootstrapTargetUserIds
  };
}

function getScreenWatchSession(
  runtime: ScreenShareRuntime,
  guildId: string
): NonNullable<ScreenWatchVoiceSessionLike> | null {
  const voiceManager = runtime.voiceSessionManager;
  if (!voiceManager || typeof voiceManager.getSession !== "function") return null;
  return voiceManager.getSession(String(guildId || "").trim()) || null;
}

function shouldSuppressLinkFallbackDueToNativeWatch(
  runtime: ScreenShareRuntime,
  {
    guildId,
    targetUserId = null
  }: {
    guildId: string;
    targetUserId?: string | null;
  }
) {
  const session = getScreenWatchSession(runtime, guildId);
  if (!session || session.ending) return false;

  const activeTargetUserId = String(session.streamWatch?.targetUserId || "").trim() || null;
  const normalizedTargetUserId = String(targetUserId || "").trim() || null;
  if (!session.streamWatch?.active || !activeTargetUserId) return false;
  if (normalizedTargetUserId && activeTargetUserId !== normalizedTargetUserId) return false;

  const transportStatus = String(session.nativeScreenShare?.transportStatus || "").trim().toLowerCase();
  const hasDecodedFrame = Number(session.nativeScreenShare?.lastDecodeSuccessAt || 0) > 0;
  const targetHasSharerState = listActiveNativeDiscordScreenSharers(session).some(
    (entry) => entry.userId === activeTargetUserId
  );

  return transportStatus === "ready" || hasDecodedFrame || targetHasSharerState;
}

function isNativeWatchFrameReady(
  runtime: ScreenShareRuntime,
  {
    guildId,
    targetUserId = null
  }: {
    guildId: string;
    targetUserId?: string | null;
  }
) {
  const session = getScreenWatchSession(runtime, guildId);
  if (!session || session.ending) return false;

  const activeTargetUserId = String(session.streamWatch?.targetUserId || "").trim() || null;
  const normalizedTargetUserId = String(targetUserId || "").trim() || activeTargetUserId;
  if (!normalizedTargetUserId) return false;
  if (activeTargetUserId && activeTargetUserId !== normalizedTargetUserId) return false;

  const latestFrameMimeType = String(session.streamWatch?.latestFrameMimeType || "").trim().toLowerCase();
  const latestFrameDataBase64 = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
  const hasBufferedFrame = latestFrameMimeType.startsWith("image/") && latestFrameDataBase64.length > 0;
  const hasDecodedFrame = Number(session.nativeScreenShare?.lastDecodeSuccessAt || 0) > 0;
  return hasBufferedFrame || hasDecodedFrame;
}

function buildNativeWatchAlreadyActiveResult(targetUserId: string | null, frameReady: boolean) {
  return {
    started: true,
    reused: true,
    appendText: "",
    transport: "native" as const,
    linkUrl: null,
    reason: frameReady ? "frame_context_ready" : "waiting_for_frame_context",
    targetUserId,
    frameReady
  };
}

async function tryStartNativeScreenWatch(
  runtime: ScreenShareRuntime,
  {
    settings = null,
    guildId,
    channelId = null,
    requesterUserId,
    targetUserId = null,
    requesterDisplayName = "",
    source = "screen_watch_request",
    transcript = ""
  }: {
    settings?: Record<string, unknown> | null;
    guildId: string;
    channelId?: string | null;
    requesterUserId: string;
    targetUserId?: string | null;
    requesterDisplayName?: string;
    source?: string;
    transcript?: string;
  }
): Promise<{
  started: boolean;
  reused?: boolean;
  reason?: string;
  fallback?: string | null;
  targetUserId?: string | null;
  transport?: "native";
  frameReady?: boolean;
}> {
  const voiceManager = runtime.voiceSessionManager;
  if (!voiceManager || typeof voiceManager.enableWatchStreamForUser !== "function") {
    logNativeScreenWatchStartFailed(runtime, {
      guildId,
      channelId,
      requesterUserId,
      source,
      transcript,
      requestedTargetUserId: targetUserId,
      reason: "native_screen_watch_unavailable"
    });
    return {
      started: false,
      reason: "native_screen_watch_unavailable"
    };
  }
  if (!supportsNativeDiscordVideoDecode(runtime)) {
    logNativeScreenWatchStartFailed(runtime, {
      guildId,
      channelId,
      requesterUserId,
      source,
      transcript,
      requestedTargetUserId: targetUserId,
      reason: "native_discord_video_decode_unavailable"
    });
    return {
      started: false,
      reason: "native_discord_video_decode_unavailable"
    };
  }

  const session =
    typeof voiceManager.getSession === "function"
      ? voiceManager.getSession(String(guildId || "").trim())
      : null;
  const normalizedTargetUserId = String(targetUserId || "").trim() || null;
  const activeSharers = listActiveNativeDiscordScreenSharers(session);
  const goLiveTargetUserIds = getDiscoveredGoLiveBootstrapTargetUserIds(session);
  const requesterGoLiveTargetUserId = goLiveTargetUserIds.includes(requesterUserId)
    ? requesterUserId
    : null;
  const activeTargetSelection = resolveNativeDiscordScreenWatchTarget({
    session,
    requesterUserId
  });
  let targetSelection = normalizedTargetUserId
    ? {
        targetUserId: normalizedTargetUserId,
        reason: "explicit_requested_target"
      }
    : requesterGoLiveTargetUserId
      ? {
          targetUserId: requesterGoLiveTargetUserId,
          reason: "requester_discovered_discord_go_live"
        }
    : activeTargetSelection.targetUserId
        ? activeTargetSelection
        : goLiveTargetUserIds.length === 1 && activeSharers.length <= 0
          ? {
              targetUserId: goLiveTargetUserIds[0] || null,
              reason: "discovered_discord_go_live"
            }
          : goLiveTargetUserIds.length > 1 && activeSharers.length <= 0
            ? {
                targetUserId: null,
                reason: "multiple_discovered_discord_go_live_streams"
              }
          : activeTargetSelection;
  if (!targetSelection.targetUserId) {
    logNativeScreenWatchStartFailed(runtime, {
      guildId,
      channelId,
      requesterUserId,
      session,
      source,
      transcript,
      requestedTargetUserId: normalizedTargetUserId,
      selectionReason: targetSelection.reason,
      reason: targetSelection.reason
    });
    return {
      started: false,
      reason: targetSelection.reason
    };
  }
  if (
    normalizedTargetUserId &&
    !activeSharers.some((entry) => entry.userId === normalizedTargetUserId) &&
    !getDiscoveredGoLiveBootstrapStreamForUser(session, normalizedTargetUserId)
  ) {
    logNativeScreenWatchStartFailed(runtime, {
      guildId,
      channelId,
      requesterUserId,
      session,
      source,
      transcript,
      requestedTargetUserId: normalizedTargetUserId,
      selectionReason: targetSelection.reason,
      reason: "requested_target_not_actively_sharing"
    });
    return {
      started: false,
      reason: "requested_target_not_actively_sharing",
      targetUserId: normalizedTargetUserId
    };
  }

  if (shouldSuppressLinkFallbackDueToNativeWatch(runtime, {
    guildId,
    targetUserId: targetSelection.targetUserId
  })) {
    return buildNativeWatchAlreadyActiveResult(
      targetSelection.targetUserId,
      isNativeWatchFrameReady(runtime, {
        guildId,
        targetUserId: targetSelection.targetUserId
      })
    );
  }

  const result = await voiceManager.enableWatchStreamForUser({
    guildId,
    requesterUserId,
    targetUserId: targetSelection.targetUserId,
    settings,
    source
  });
  if (!result?.ok) {
    logNativeScreenWatchStartFailed(runtime, {
      guildId,
      channelId,
      requesterUserId,
      session,
      source,
      transcript,
      requestedTargetUserId: normalizedTargetUserId || targetSelection.targetUserId,
      selectionReason: targetSelection.reason,
      reason: String(result?.reason || "native_screen_watch_unavailable"),
      fallback: String(result?.fallback || "").trim() || null
    });
    return {
      started: false,
      reason: String(result?.reason || "native_screen_watch_unavailable"),
      fallback: String(result?.fallback || "").trim() || null
    };
  }

  runtime.store.logAction({
    kind: "voice_runtime",
    guildId,
    channelId: null,
    userId: requesterUserId,
    content: "screen_watch_started_native",
    metadata: {
      source,
      requesterDisplayName,
      transcript: String(transcript || "").slice(0, 220),
      targetUserId: result?.targetUserId || targetSelection.targetUserId,
      explicitTargetRequested: Boolean(normalizedTargetUserId),
      selectionReason: targetSelection.reason,
      transport: "native",
      reused: Boolean(result?.reused),
      frameReady: Boolean(result?.frameReady)
    }
  });

  return {
    started: true,
    reused: Boolean(result?.reused),
    reason: String(result?.reason || "watching_started"),
    targetUserId: String(result?.targetUserId || targetSelection.targetUserId || "").trim() || null,
    transport: "native",
    frameReady: Boolean(result?.frameReady)
  };
}

async function composeScreenWatchStartedMessage(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    source = "message_event",
    targetUserId = null,
    transport = "native"
  }: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    source?: string;
    targetUserId?: string | null;
    transport?: "native" | "link";
  }
) {
  const composed = await runtime.composeVoiceOperationalMessage({
    settings,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    messageId: message.id || null,
    event: "voice_stream_watch_request",
    reason: "watching_started",
    details: {
      source: String(source || "message_event"),
      targetUserId,
      transport
    },
    maxOutputChars: SCREEN_WATCH_MESSAGE_MAX_CHARS
  });

  const normalized = sanitizeBotText(
    normalizeSkipSentinel(String(composed || "")),
    SCREEN_WATCH_MESSAGE_MAX_CHARS
  );
  if (!normalized || normalized === "[SKIP]") return "";
  return normalized;
}

async function tryStartLinkFallback(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    guildId,
    channelId,
    requesterUserId,
    targetUserId = null,
    requesterDisplayName = "",
    transcript = "",
    source = "message_event",
    explicitRequest = false,
    intentRequested = false,
    confidence = 0,
    sendToChannelOnResult = false,
    nativeFailureReason = null
  }: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    guildId: string;
    channelId: string;
    requesterUserId: string;
    targetUserId?: string | null;
    requesterDisplayName?: string;
    transcript?: string;
    source?: string;
    explicitRequest?: boolean;
    intentRequested?: boolean;
    confidence?: number;
    sendToChannelOnResult?: boolean;
    nativeFailureReason?: string | null;
  }
): Promise<{
  started: boolean;
  reused?: boolean;
  appendText: string;
  transport: "native" | "link" | null;
  linkUrl: string | null;
  expiresInMinutes?: number | null;
  reason: string;
  targetUserId?: string | null;
} | null> {
  const requestedTargetUserId = String(targetUserId || requesterUserId || "").trim() || requesterUserId;
  if (!isStreamLinkFallbackEnabled(runtime)) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId: requesterUserId,
      content: "screen_watch_link_fallback_skipped",
      metadata: {
        source,
        targetUserId: requestedTargetUserId,
        explicitRequest,
        intentRequested,
        nativeFailureReason: String(nativeFailureReason || "").trim() || null,
        skipReason: "stream_link_fallback_disabled"
      }
    });
    return null;
  }

  const manager = runtime.screenShareSessionManager;
  if (!manager || typeof manager.createSession !== "function") return null;

  if (shouldSuppressLinkFallbackDueToNativeWatch(runtime, {
    guildId,
    targetUserId: requestedTargetUserId
  })) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId: requesterUserId,
      content: "screen_watch_link_fallback_cancelled_native_active",
      metadata: {
        source,
        targetUserId: requestedTargetUserId,
        nativeFailureReason: String(nativeFailureReason || "").trim() || null,
        stage: "pre_create"
      }
    });
    return buildNativeWatchAlreadyActiveResult(
      requestedTargetUserId,
      isNativeWatchFrameReady(runtime, {
        guildId,
        targetUserId: requestedTargetUserId
      })
    );
  }

  const resolveChannel =
    runtime.resolveOperationalChannel ||
    ((channel: unknown, resolvedChannelId: string | null, meta) =>
      resolveOperationalChannel(runtime, channel, resolvedChannelId, meta));
  const sendMessage =
    runtime.sendToChannel ||
    ((channel: unknown, text: string, meta) => sendToChannel(runtime, channel, text, meta));
  const composeOfferMessage =
    runtime.composeScreenShareOfferMessage ||
    ((payload) => composeScreenShareOfferMessage(runtime, payload));
  const composeUnavailableMessage =
    runtime.composeScreenShareUnavailableMessage ||
    ((payload) => composeScreenWatchUnavailableMessage(runtime, payload));

  const created = await manager.createSession({
    guildId,
    channelId,
    requesterUserId,
    requesterDisplayName,
    targetUserId: requestedTargetUserId,
    source
  });

  if (!created?.ok) {
    const unavailableReason = String(created?.reason || "share_link_unavailable");
    const appendText = explicitRequest
      ? await composeUnavailableMessage({
        message,
        settings,
        reason: unavailableReason,
        source
      })
      : "";
    if (sendToChannelOnResult && appendText) {
      const channel = await resolveChannel(null, channelId, {
        guildId,
        userId: requesterUserId,
        messageId: message.id || null,
        event: "voice_stream_watch_request",
        reason: unavailableReason
      });
      if (channel) {
        await sendMessage(channel, appendText, {
          guildId,
          channelId,
          userId: requesterUserId,
          messageId: message.id || null,
          event: "voice_stream_watch_request",
          reason: unavailableReason
        });
      }
    }
    return {
      started: false,
      appendText,
      transport: null,
      linkUrl: null,
      reason: unavailableReason
    };
  }

  const linkUrl = String(created?.shareUrl || "").trim();
  const expiresInMinutes = Number(created?.expiresInMinutes || 0);
  if (!linkUrl) {
    return {
      started: false,
      appendText: "",
      transport: null,
      linkUrl: null,
      reason: "missing_share_url"
    };
  }

  if (created?.reused) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId: requesterUserId,
      content: "screen_watch_link_reused",
      metadata: {
        source,
        transcript: String(transcript || "").slice(0, 220),
        targetUserId: String(created?.targetUserId || targetUserId || requesterUserId || "").trim() || null,
        expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
        linkHost: safeUrlHost(linkUrl),
        transport: "link",
        nativeFailureReason: String(nativeFailureReason || "").trim() || null
      }
    });
    return {
      started: true,
      reused: true,
      appendText: "",
      transport: "link",
      linkUrl,
      expiresInMinutes,
      reason: "already_active_session"
    };
  }

  const appendText = await composeOfferMessage({
    message,
    settings,
    linkUrl,
    expiresInMinutes,
    explicitRequest,
    intentRequested,
    confidence,
    source
  });
  if (shouldSuppressLinkFallbackDueToNativeWatch(runtime, {
    guildId,
    targetUserId: requestedTargetUserId
  })) {
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId: requesterUserId,
      content: "screen_watch_link_fallback_cancelled_native_active",
      metadata: {
        source,
        targetUserId: requestedTargetUserId,
        nativeFailureReason: String(nativeFailureReason || "").trim() || null,
        stage: "post_compose"
      }
    });
    return buildNativeWatchAlreadyActiveResult(
      requestedTargetUserId,
      isNativeWatchFrameReady(runtime, {
        guildId,
        targetUserId: requestedTargetUserId
      })
    );
  }
  if (!appendText) {
    return {
      started: false,
      appendText: "",
      transport: null,
      linkUrl,
      expiresInMinutes,
      reason: "offer_message_empty"
    };
  }

  if (sendToChannelOnResult) {
    const channel = await resolveChannel(null, channelId, {
      guildId,
      userId: requesterUserId,
      messageId: message.id || null,
      event: "voice_screen_share_offer",
      reason: "link_fallback"
    });
    if (!channel) {
      return {
        started: false,
        appendText: "",
        transport: null,
        linkUrl,
        expiresInMinutes,
        reason: "channel_unavailable"
      };
    }

    const sent = await sendMessage(channel, appendText, {
      guildId,
      channelId,
      userId: requesterUserId,
      messageId: message.id || null,
      event: "voice_screen_share_offer",
      reason: "link_fallback"
    });
    if (!sent) {
      return {
        started: false,
        appendText: "",
        transport: null,
        linkUrl,
        expiresInMinutes,
        reason: "offer_message_send_failed"
      };
    }
  }

  runtime.store.logAction({
    kind: "voice_runtime",
    guildId,
    channelId,
    userId: requesterUserId,
    content: "screen_watch_link_fallback_started",
    metadata: {
      source,
      transcript: String(transcript || "").slice(0, 220),
      explicitRequest,
      intentRequested,
      confidence,
      targetUserId: String(created?.targetUserId || targetUserId || requesterUserId || "").trim() || null,
      expiresInMinutes: Number.isFinite(expiresInMinutes) ? expiresInMinutes : null,
      linkHost: safeUrlHost(linkUrl),
      transport: "link",
      nativeFailureReason: String(nativeFailureReason || "").trim() || null
    }
  });

  return {
    started: true,
    appendText: sendToChannelOnResult ? "" : appendText,
    transport: "link",
    linkUrl,
    expiresInMinutes,
    reason: "started"
  };
}

export function getVoiceScreenWatchCapability(
  runtime: ScreenShareRuntime,
  {
    settings = null,
    guildId = null,
    channelId: _channelId = null,
    requesterUserId = null
  }: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
  } = {}
) {
  const directCapability = getDirectScreenWatchCapability(runtime, {
    settings,
    guildId,
    requesterUserId
  });
  const linkCapability = getLinkScreenWatchCapability(runtime, { settings });
  const available = directCapability.available || linkCapability.available;
  const enabled = directCapability.enabled || linkCapability.enabled;
  const supported = directCapability.supported || linkCapability.supported;
  const supportedCapabilities = [directCapability, linkCapability].filter((capability) => capability.supported);

  if (!supported) {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_watch_unavailable",
      transport: "none",
      nativeSupported: false,
      nativeEnabled: false,
      nativeAvailable: false,
      nativeStatus: "disabled",
      nativeReason: "screen_watch_unavailable",
      linkSupported: false,
      linkEnabled: false,
      linkFallbackAvailable: false,
      linkStatus: "disabled",
      linkReason: "share_link_unavailable",
      activeSharerCount: 0,
      activeSharerUserIds: []
    };
  }

  const selectedUnavailableCapability =
    supportedCapabilities.find((capability) => {
      const status = String(capability.status || "").trim().toLowerCase();
      return Boolean(status) && !["disabled", "unavailable", "offline"].includes(status);
    }) ||
    supportedCapabilities.find((capability) => capability.enabled) ||
    supportedCapabilities[0] ||
    null;
  const selectedUnavailableStatus =
    String(selectedUnavailableCapability?.status || "unavailable").trim().toLowerCase() || "unavailable";
  const selectedUnavailableReason =
    String(
      selectedUnavailableCapability?.reason ||
      selectedUnavailableCapability?.status ||
      "unavailable"
    )
      .trim()
      .toLowerCase() || "unavailable";
  const nativeStatus =
    String(directCapability.status || (directCapability.enabled ? "unavailable" : "disabled"))
      .trim()
      .toLowerCase() || "disabled";
  const nativeReason =
    directCapability.available
      ? null
      : String(directCapability.reason || nativeStatus || "unavailable").trim().toLowerCase() ||
        nativeStatus ||
        "unavailable";
  const linkStatus =
    String(linkCapability.status || (linkCapability.enabled ? "unavailable" : "disabled"))
      .trim()
      .toLowerCase() || "disabled";
  const linkReason =
    linkCapability.available
      ? null
      : String(linkCapability.reason || linkStatus || "unavailable").trim().toLowerCase() ||
        linkStatus ||
        "unavailable";

  return {
    supported,
    enabled,
    available,
    status: available ? "ready" : selectedUnavailableStatus,
    publicUrl: String(linkCapability.publicUrl || "").trim(),
    reason: available ? null : selectedUnavailableReason,
    transport: directCapability.available ? "native" : linkCapability.available ? "link" : "none",
    nativeSupported: Boolean(directCapability.supported),
    nativeEnabled: Boolean(directCapability.enabled),
    nativeAvailable: directCapability.available,
    nativeStatus,
    nativeReason,
    linkSupported: Boolean(linkCapability.supported),
    linkEnabled: Boolean(linkCapability.enabled),
    linkFallbackAvailable: linkCapability.available,
    linkStatus,
    linkReason,
    activeSharerCount: Math.max(0, Number(directCapability.activeSharerCount || 0)),
    activeSharerUserIds: Array.isArray(directCapability.activeSharerUserIds)
      ? directCapability.activeSharerUserIds.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
    goLiveStreamUserId: String(directCapability.goLiveStreamUserId || "").trim() || null
  };
}

export async function startVoiceScreenWatch(
  runtime: ScreenShareRuntime,
  {
    settings = null,
    guildId = null,
    channelId = null,
    requesterUserId = null,
    target = null,
    targetUserId = null,
    transcript = "",
    source = "voice_turn_directive",
    preferredTransport = "native",
    nativeFailureReason = null,
    signal
  }: {
    settings?: Record<string, unknown> | null;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
    target?: string | null;
    targetUserId?: string | null;
    transcript?: string;
    source?: string;
    preferredTransport?: "native" | "link" | null;
    nativeFailureReason?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<{
  started: boolean;
  reused?: boolean;
  transport?: "native" | "link";
  reason?: string;
  linkUrl?: string | null;
  expiresInMinutes?: number | null;
  targetUserId?: string | null;
  fallback?: string | null;
  frameReady?: boolean;
}> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("AbortError: Screen watch start cancelled");
  }
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedRequesterUserId = String(requesterUserId || "").trim();
  if (!normalizedGuildId || !normalizedRequesterUserId) {
    return {
      started: false,
      reason: "invalid_context"
    };
  }

  const resolvedSettings = settings || runtime.store.getSettings();
  if (!isScreenWatchEnabled(resolvedSettings)) {
    return {
      started: false,
      reason: "stream_watch_disabled"
    };
  }
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedTarget = String(target || "").trim().replace(/\s+/g, " ").slice(0, 120) || null;
  const normalizedTargetUserId = String(targetUserId || "").trim() || null;
  const preferredTransportMode =
    String(preferredTransport || "native").trim().toLowerCase() === "link" ? "link" : "native";
  const guild = runtime.client.guilds.cache.get(normalizedGuildId) || null;
  const requesterDisplayName =
    guild?.members?.cache?.get(normalizedRequesterUserId)?.displayName ||
    guild?.members?.cache?.get(normalizedRequesterUserId)?.user?.username ||
    runtime.client.users?.cache?.get(normalizedRequesterUserId)?.username ||
    "unknown";
  const syntheticMessage: ScreenWatchMessageLike = {
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    id: null,
    author: {
      id: normalizedRequesterUserId,
      username: requesterDisplayName
    },
    member: {
      displayName: requesterDisplayName
    }
  };
  const eventSource = String(source || "voice_turn_directive").trim().slice(0, 80) || "voice_turn_directive";
  const session =
    typeof runtime.voiceSessionManager?.getSession === "function"
      ? runtime.voiceSessionManager.getSession(normalizedGuildId)
      : null;
  const requestedTargetResolution = !normalizedTargetUserId && normalizedTarget
    ? resolveRequestedScreenWatchTarget(runtime, {
        session,
        guildId: normalizedGuildId,
        target: normalizedTarget
      })
    : null;
  const requestedTargetUserId =
    normalizedTargetUserId || String(requestedTargetResolution?.targetUserId || "").trim() || null;
  if (!normalizedTargetUserId && normalizedTarget && !requestedTargetUserId) {
    return {
      started: false,
      reason: String(requestedTargetResolution?.reason || "requested_target_not_in_voice_session"),
      targetUserId: null
    };
  }

  if (preferredTransportMode === "link") {
    if (!isStreamLinkFallbackEnabled(runtime)) {
      runtime.store.logAction({
        kind: "voice_runtime",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId || null,
        userId: normalizedRequesterUserId,
        content: "screen_watch_link_fallback_skipped",
        metadata: {
          source: eventSource,
          targetUserId: requestedTargetUserId,
          nativeFailureReason: String(nativeFailureReason || "").trim() || null,
          skipReason: "stream_link_fallback_disabled",
          preferredTransport: "link"
        }
      });
      return {
        started: false,
        reason: "stream_link_fallback_disabled",
        targetUserId: requestedTargetUserId
      };
    }

    if (!normalizedChannelId) {
      return {
        started: false,
        reason: "screen_watch_channel_unavailable",
        targetUserId: requestedTargetUserId
      };
    }

    const fallbackStart = await tryStartLinkFallback(runtime, {
      message: syntheticMessage,
      settings: resolvedSettings,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      requesterUserId: normalizedRequesterUserId,
      targetUserId: requestedTargetUserId,
      requesterDisplayName,
      transcript,
      source: eventSource,
      explicitRequest: true,
      intentRequested: true,
      confidence: 1,
      sendToChannelOnResult: true,
      nativeFailureReason: String(nativeFailureReason || "").trim() || "native_transport_unhealthy"
    });
    if (fallbackStart) return fallbackStart;

    return {
      started: false,
      reason: "screen_watch_unavailable",
      targetUserId: requestedTargetUserId
    };
  }

  const directStart = await tryStartNativeScreenWatch(runtime, {
    settings: resolvedSettings,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    requesterUserId: normalizedRequesterUserId,
    targetUserId: requestedTargetUserId,
    requesterDisplayName,
    source: eventSource,
    transcript
  });
  if (directStart?.started) {
    return directStart;
  }
  if (!normalizedTarget && String(directStart?.reason || "").trim() === "multiple_active_discord_screen_shares") {
    return directStart;
  }
  if (!normalizedChannelId) {
    return {
      started: false,
      reason: directStart?.reason || "screen_watch_channel_unavailable"
    };
  }

  const fallbackStart = await tryStartLinkFallback(runtime, {
    message: syntheticMessage,
    settings: resolvedSettings,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    requesterUserId: normalizedRequesterUserId,
    targetUserId: requestedTargetUserId,
    requesterDisplayName,
    transcript,
    source: eventSource,
    explicitRequest: true,
    intentRequested: true,
    confidence: 1,
    sendToChannelOnResult: true,
    nativeFailureReason: String(directStart?.reason || "").trim() || null
  });
  if (fallbackStart) return fallbackStart;

  return {
    started: false,
    reason: directStart?.reason || (normalizedChannelId ? "screen_watch_unavailable" : "screen_watch_channel_unavailable")
  };
}

export async function maybeHandleScreenWatchIntent(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    replyDirective,
    source = "message_event"
  }: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    replyDirective?: {
      screenWatchIntent?: {
        action?: string;
        confidence?: number;
      } | null;
    } | null;
    source?: string;
  }
) {
  const empty = {
    started: false,
    appendText: "",
    transport: null,
    linkUrl: null,
    explicitRequest: false,
    intentRequested: false,
    confidence: 0,
    reason: null
  };

  const explicitRequest = SCREEN_WATCH_EXPLICIT_REQUEST_RE.test(String(message?.content || ""));
  const resolvedSettings = settings || runtime.store.getSettings();
  if (!message?.guildId || !message?.channelId) return empty;

  const intent = replyDirective?.screenWatchIntent || {};
  const intentRequested = intent?.action === "start_watch";
  const confidence = Number(intent?.confidence || 0);
  const intentAllowed = intentRequested && confidence >= SCREEN_WATCH_INTENT_THRESHOLD;
  if (!explicitRequest && !intentAllowed) return empty;
  if (!isScreenWatchEnabled(resolvedSettings)) {
    if (!explicitRequest) {
      return {
        ...empty,
        explicitRequest,
        intentRequested,
        confidence,
        reason: "stream_watch_disabled"
      };
    }
    return {
      ...empty,
      explicitRequest,
      intentRequested,
      confidence,
      reason: "stream_watch_disabled",
      appendText: await composeScreenWatchUnavailableMessage(runtime, {
        message,
        settings: resolvedSettings,
        reason: "stream_watch_disabled",
        source
      })
    };
  }

  const requesterUserId = String(message.author?.id || "").trim();
  const requesterDisplayName = String(message.member?.displayName || message.author?.username || "").trim();
  const directStart = await tryStartNativeScreenWatch(runtime, {
    settings: resolvedSettings,
    guildId: String(message.guildId || ""),
    channelId: String(message.channelId || ""),
    requesterUserId,
    requesterDisplayName,
    source: String(source || "message_event"),
    transcript: String(message.content || "")
  });
  if (directStart?.started) {
    const appendText = await composeScreenWatchStartedMessage(runtime, {
      message,
      settings: resolvedSettings,
      source,
      targetUserId: directStart.targetUserId || requesterUserId || null,
      transport: "native"
    });
    return {
      ...empty,
      started: true,
      appendText,
      transport: "native",
      explicitRequest,
      intentRequested,
      confidence,
      reason: String(directStart.reason || "watching_started")
    };
  }

  const fallbackStart = await tryStartLinkFallback(runtime, {
    message,
    settings: resolvedSettings,
    guildId: String(message.guildId || ""),
    channelId: String(message.channelId || ""),
    requesterUserId,
    requesterDisplayName,
    transcript: String(message.content || ""),
    source: String(source || "message_event"),
    explicitRequest,
    intentRequested,
    confidence,
    sendToChannelOnResult: false,
    nativeFailureReason: String(directStart?.reason || "").trim() || null
  });
  if (fallbackStart) {
    return {
      ...empty,
      ...fallbackStart,
      explicitRequest,
      intentRequested,
      confidence
    };
  }

  if (!explicitRequest) {
    return {
      ...empty,
      explicitRequest,
      intentRequested,
      confidence,
      reason: directStart?.reason || "screen_watch_unavailable"
    };
  }

  return {
    ...empty,
    explicitRequest,
    intentRequested,
    confidence,
    reason: directStart?.reason || "screen_watch_unavailable",
    appendText: await composeScreenWatchUnavailableMessage(runtime, {
      message,
      settings: resolvedSettings,
      reason: directStart?.reason || "screen_watch_unavailable",
      source
    })
  };
}

async function composeScreenShareOfferMessage(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    linkUrl,
    expiresInMinutes,
    explicitRequest = false,
    intentRequested = false,
    confidence = 0,
    source = "message_event"
  }: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    linkUrl: string;
    expiresInMinutes?: number;
    explicitRequest?: boolean;
    intentRequested?: boolean;
    confidence?: number;
    source?: string;
  }
) {
  const composed = await runtime.composeVoiceOperationalMessage({
    settings,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    messageId: message.id || null,
    event: "voice_screen_share_offer",
    reason: explicitRequest ? "explicit_request" : "proactive_offer",
    details: {
      linkUrl,
      expiresInMinutes,
      explicitRequest,
      intentRequested,
      confidence: Number(confidence || 0),
      source: String(source || "message_event")
    },
    maxOutputChars: SCREEN_WATCH_MESSAGE_MAX_CHARS
  });

  const normalized = sanitizeBotText(
    normalizeSkipSentinel(String(composed || "")),
    SCREEN_WATCH_MESSAGE_MAX_CHARS
  );
  if (!normalized || normalized === "[SKIP]") {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_message_empty",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  if (!String(normalized).includes(linkUrl)) {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_offer_message_missing_link",
      metadata: {
        explicitRequest,
        intentRequested,
        confidence: Number(confidence || 0),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  return normalized;
}

async function composeScreenWatchUnavailableMessage(
  runtime: ScreenShareRuntime,
  {
    message,
    settings,
    reason = "unavailable",
    source = "message_event"
  }: {
    message: ScreenWatchMessageLike;
    settings?: Record<string, unknown> | null;
    reason?: string;
    source?: string;
  }
) {
  const composed = await runtime.composeVoiceOperationalMessage({
    settings,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    messageId: message.id || null,
    event: "voice_stream_watch_request",
    reason: String(reason || "unavailable"),
    details: {
      source: String(source || "message_event"),
      unavailable: true
    },
    maxOutputChars: SCREEN_WATCH_MESSAGE_MAX_CHARS
  });

  const normalized = sanitizeBotText(
    normalizeSkipSentinel(String(composed || "")),
    SCREEN_WATCH_MESSAGE_MAX_CHARS
  );
  if (!normalized || normalized === "[SKIP]") {
    runtime.store.logAction({
      kind: "voice_error",
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      content: "screen_share_unavailable_message_empty",
      metadata: {
        reason: String(reason || "unavailable"),
        source: String(source || "message_event")
      }
    });
    return "";
  }
  return normalized;
}

async function resolveOperationalChannel(
  runtime: ScreenShareRuntime,
  channel: unknown,
  channelId: string | null,
  {
    guildId = null,
    userId = null,
    messageId = null,
    event = null,
    reason = null
  }: {
    guildId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string | null;
    reason?: string | null;
  } = {}
) {
  return await resolveOperationalChannelForVoiceOperationalMessaging(runtime, channel, channelId, {
    guildId,
    userId,
    messageId,
    event,
    reason
  });
}

async function sendToChannel(
  runtime: ScreenShareRuntime,
  channel: unknown,
  text: string,
  {
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = null,
    reason = null
  }: {
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string | null;
    reason?: string | null;
  } = {}
) {
  return await sendToChannelForVoiceOperationalMessaging(runtime, channel, text, {
    guildId,
    channelId,
    userId,
    messageId,
    event,
    reason
  });
}
