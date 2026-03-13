import type {
  VoiceSession,
  VoiceSessionNativeScreenShareState,
  VoiceSessionNativeScreenShareSharerState,
  VoiceSessionNativeScreenShareStreamState
} from "./voiceSessionTypes.ts";
import type {
  ClankvoxUserVideoFrame,
  ClankvoxUserVideoState
} from "./clankvoxClient.ts";

type NativeDiscordScreenShareStreamLike = Partial<VoiceSessionNativeScreenShareStreamState>;

type NativeDiscordScreenShareSharerLike = Partial<
  Omit<VoiceSessionNativeScreenShareSharerState, "streams">
> & {
  userId?: string | null;
  codec?: string | null;
  streams?: NativeDiscordScreenShareStreamLike[] | null;
};

type NativeDiscordScreenShareSessionLike = {
  nativeScreenShare?: {
    sharers?: Map<string, NativeDiscordScreenShareSharerLike> | null;
    subscribedTargetUserId?: string | null;
    decodeInFlight?: boolean;
    lastDecodeAttemptAt?: number;
    lastDecodeSuccessAt?: number;
    lastDecodeFailureAt?: number;
    lastDecodeFailureReason?: string | null;
    ffmpegAvailable?: boolean | null;
    activeStreamKey?: string | null;
    lastRtcServerId?: string | null;
    lastStreamEndpoint?: string | null;
    lastCredentialsReceivedAt?: number;
    lastVoiceSessionId?: string | null;
    transportStatus?: string | null;
    transportReason?: string | null;
    transportUpdatedAt?: number;
    transportConnectedAt?: number;
  } | null;
};

function normalizeCodec(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function toPixelCount(width: number | null, height: number | null): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const normalizedWidth = Math.max(0, Math.floor(Number(width) || 0));
  const normalizedHeight = Math.max(0, Math.floor(Number(height) || 0));
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  return normalizedWidth * normalizedHeight;
}

function normalizeStreamState(stream: ClankvoxUserVideoState["streams"][number]): VoiceSessionNativeScreenShareStreamState {
  const width = Number.isFinite(Number(stream.maxResolution?.width))
    ? Math.max(0, Math.floor(Number(stream.maxResolution?.width)))
    : null;
  const height = Number.isFinite(Number(stream.maxResolution?.height))
    ? Math.max(0, Math.floor(Number(stream.maxResolution?.height)))
    : null;
  return {
    ssrc: Math.max(0, Math.floor(Number(stream.ssrc) || 0)),
    rtxSsrc: Number.isFinite(Number(stream.rtxSsrc)) ? Math.max(0, Math.floor(Number(stream.rtxSsrc))) : null,
    rid: String(stream.rid || "").trim() || null,
    quality: Number.isFinite(Number(stream.quality)) ? Math.max(0, Math.floor(Number(stream.quality))) : null,
    streamType: String(stream.streamType || "").trim().toLowerCase() || null,
    active: typeof stream.active === "boolean" ? stream.active : null,
    maxBitrate: Number.isFinite(Number(stream.maxBitrate)) ? Math.max(0, Math.floor(Number(stream.maxBitrate))) : null,
    maxFramerate: Number.isFinite(Number(stream.maxFramerate))
      ? Math.max(0, Math.floor(Number(stream.maxFramerate)))
      : null,
    width,
    height,
    resolutionType: String(stream.maxResolution?.type || "").trim().toLowerCase() || null,
    pixelCount: toPixelCount(width, height)
  };
}

function normalizeSharerState(
  userId: string,
  sharer: NativeDiscordScreenShareSharerLike | null | undefined
): VoiceSessionNativeScreenShareSharerState {
  return {
    userId,
    audioSsrc: Number.isFinite(Number(sharer?.audioSsrc)) ? Math.max(0, Math.floor(Number(sharer?.audioSsrc))) : null,
    videoSsrc: Number.isFinite(Number(sharer?.videoSsrc)) ? Math.max(0, Math.floor(Number(sharer?.videoSsrc))) : null,
    codec: normalizeCodec(sharer?.codec),
    streams: Array.isArray(sharer?.streams)
      ? sharer.streams.map((stream) => ({
          ssrc: Number.isFinite(Number(stream?.ssrc)) ? Math.max(0, Math.floor(Number(stream?.ssrc))) : 0,
          rtxSsrc: Number.isFinite(Number(stream?.rtxSsrc)) ? Math.max(0, Math.floor(Number(stream?.rtxSsrc))) : null,
          rid: String(stream?.rid || "").trim() || null,
          quality: Number.isFinite(Number(stream?.quality)) ? Math.max(0, Math.floor(Number(stream?.quality))) : null,
          streamType: String(stream?.streamType || "").trim().toLowerCase() || null,
          active: typeof stream?.active === "boolean" ? stream.active : null,
          maxBitrate: Number.isFinite(Number(stream?.maxBitrate))
            ? Math.max(0, Math.floor(Number(stream?.maxBitrate)))
            : null,
          maxFramerate: Number.isFinite(Number(stream?.maxFramerate))
            ? Math.max(0, Math.floor(Number(stream?.maxFramerate)))
            : null,
          width: Number.isFinite(Number(stream?.width)) ? Math.max(0, Math.floor(Number(stream?.width))) : null,
          height: Number.isFinite(Number(stream?.height)) ? Math.max(0, Math.floor(Number(stream?.height))) : null,
          resolutionType: String(stream?.resolutionType || "").trim().toLowerCase() || null,
          pixelCount: Number.isFinite(Number(stream?.pixelCount))
            ? Math.max(0, Math.floor(Number(stream?.pixelCount)))
            : toPixelCount(
                Number.isFinite(Number(stream?.width)) ? Math.max(0, Math.floor(Number(stream?.width))) : null,
                Number.isFinite(Number(stream?.height)) ? Math.max(0, Math.floor(Number(stream?.height))) : null
              )
        }))
      : [],
    updatedAt: Number(sharer?.updatedAt || 0),
    lastFrameAt: Number(sharer?.lastFrameAt || 0),
    lastFrameCodec: normalizeCodec(sharer?.lastFrameCodec),
    lastFrameKeyframeAt: Number(sharer?.lastFrameKeyframeAt || 0)
  };
}

function normalizeSharersMap(
  sharers: Map<string, NativeDiscordScreenShareSharerLike> | null | undefined
): Map<string, VoiceSessionNativeScreenShareSharerState> {
  if (!(sharers instanceof Map)) {
    return new Map();
  }
  return new Map(
    [...sharers.entries()].map(([userId, sharer]) => {
      const normalizedUserId = String(userId || "").trim();
      return [normalizedUserId, normalizeSharerState(normalizedUserId, sharer)];
    })
  );
}

function streamLooksActive(
  stream: VoiceSessionNativeScreenShareStreamState | null | undefined
): boolean {
  if (!stream) return false;
  const hasVideoSsrc =
    Math.max(0, Math.floor(Number(stream.ssrc) || 0)) > 0 ||
    Math.max(0, Math.floor(Number(stream.rtxSsrc) || 0)) > 0;
  if (!hasVideoSsrc) return false;
  return stream.active !== false;
}

function sharerLooksActive(
  sharer: VoiceSessionNativeScreenShareSharerState | null | undefined
): boolean {
  if (!sharer) return false;
  if (Array.isArray(sharer.streams) && sharer.streams.length > 0) {
    return sharer.streams.some((stream) => streamLooksActive(stream));
  }
  return (
    Math.max(0, Math.floor(Number(sharer.videoSsrc) || 0)) > 0 &&
    Math.max(0, Math.floor(Number(sharer.lastFrameAt) || 0)) > 0
  );
}

export function createNativeDiscordScreenShareState(): VoiceSessionNativeScreenShareState {
  return {
    sharers: new Map(),
    subscribedTargetUserId: null,
    decodeInFlight: false,
    lastDecodeAttemptAt: 0,
    lastDecodeSuccessAt: 0,
    lastDecodeFailureAt: 0,
    lastDecodeFailureReason: null,
    ffmpegAvailable: null,
    activeStreamKey: null,
    lastRtcServerId: null,
    lastStreamEndpoint: null,
    lastCredentialsReceivedAt: 0,
    lastVoiceSessionId: null,
    transportStatus: null,
    transportReason: null,
    transportUpdatedAt: 0,
    transportConnectedAt: 0
  };
}

export function ensureNativeDiscordScreenShareState(
  session: NativeDiscordScreenShareSessionLike | null | undefined
): VoiceSessionNativeScreenShareState {
  if (!session) {
    return createNativeDiscordScreenShareState();
  }
  const current = session.nativeScreenShare;
  const state =
    current && typeof current === "object"
      ? current as VoiceSessionNativeScreenShareState
      : createNativeDiscordScreenShareState();
  state.sharers = normalizeSharersMap(current?.sharers);
  state.subscribedTargetUserId = String(current?.subscribedTargetUserId || "").trim() || null;
  state.decodeInFlight = Boolean(current?.decodeInFlight);
  state.lastDecodeAttemptAt = Number(current?.lastDecodeAttemptAt || 0);
  state.lastDecodeSuccessAt = Number(current?.lastDecodeSuccessAt || 0);
  state.lastDecodeFailureAt = Number(current?.lastDecodeFailureAt || 0);
  state.lastDecodeFailureReason = String(current?.lastDecodeFailureReason || "").trim() || null;
  state.ffmpegAvailable = typeof current?.ffmpegAvailable === "boolean" ? current.ffmpegAvailable : null;
  state.activeStreamKey = String(current?.activeStreamKey || "").trim() || null;
  state.lastRtcServerId = String(current?.lastRtcServerId || "").trim() || null;
  state.lastStreamEndpoint = String(current?.lastStreamEndpoint || "").trim() || null;
  state.lastCredentialsReceivedAt = Number(current?.lastCredentialsReceivedAt || 0);
  state.lastVoiceSessionId = String(current?.lastVoiceSessionId || "").trim() || null;
  state.transportStatus = String(current?.transportStatus || "").trim() || null;
  state.transportReason = String(current?.transportReason || "").trim() || null;
  state.transportUpdatedAt = Number(current?.transportUpdatedAt || 0);
  state.transportConnectedAt = Number(current?.transportConnectedAt || 0);
  session.nativeScreenShare = state;
  return state;
}

export function applyNativeDiscordVideoState(
  session: NativeDiscordScreenShareSessionLike,
  payload: ClankvoxUserVideoState
): VoiceSessionNativeScreenShareSharerState {
  const state = ensureNativeDiscordScreenShareState(session);
  const current = state.sharers.get(payload.userId);
  const nextValue: VoiceSessionNativeScreenShareSharerState = {
    userId: payload.userId,
    audioSsrc: Number.isFinite(Number(payload.audioSsrc)) ? Math.max(0, Math.floor(Number(payload.audioSsrc))) : null,
    videoSsrc: Number.isFinite(Number(payload.videoSsrc)) ? Math.max(0, Math.floor(Number(payload.videoSsrc))) : null,
    codec: normalizeCodec(payload.codec),
    streams: Array.isArray(payload.streams) ? payload.streams.map((entry) => normalizeStreamState(entry)) : [],
    updatedAt: Date.now(),
    lastFrameAt: Number(current?.lastFrameAt || 0),
    lastFrameCodec: normalizeCodec(current?.lastFrameCodec),
    lastFrameKeyframeAt: Number(current?.lastFrameKeyframeAt || 0)
  };
  state.sharers.set(nextValue.userId, nextValue);
  return nextValue;
}

export function removeNativeDiscordVideoSharer(
  session: NativeDiscordScreenShareSessionLike,
  userId: string | null | undefined
): VoiceSessionNativeScreenShareSharerState | null {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;
  const state = ensureNativeDiscordScreenShareState(session);
  const removed = state.sharers.get(normalizedUserId) || null;
  state.sharers.delete(normalizedUserId);
  if (state.subscribedTargetUserId === normalizedUserId) {
    state.subscribedTargetUserId = null;
  }
  return removed;
}

export function clearNativeDiscordScreenShareState(session: NativeDiscordScreenShareSessionLike | null | undefined): void {
  if (!session) return;
  const state = ensureNativeDiscordScreenShareState(session);
  state.sharers = new Map();
  state.subscribedTargetUserId = null;
  state.decodeInFlight = false;
  state.lastDecodeAttemptAt = 0;
  state.lastDecodeSuccessAt = 0;
  state.lastDecodeFailureAt = 0;
  state.lastDecodeFailureReason = null;
  state.ffmpegAvailable = null;
  state.activeStreamKey = null;
  state.lastRtcServerId = null;
  state.lastStreamEndpoint = null;
  state.lastCredentialsReceivedAt = 0;
  state.lastVoiceSessionId = null;
  state.transportStatus = null;
  state.transportReason = null;
  state.transportUpdatedAt = 0;
  state.transportConnectedAt = 0;
}

export function recordNativeDiscordVideoFrame(
  session: NativeDiscordScreenShareSessionLike,
  payload: Pick<ClankvoxUserVideoFrame, "userId" | "codec" | "keyframe">
): VoiceSessionNativeScreenShareSharerState | null {
  const normalizedUserId = String(payload.userId || "").trim();
  if (!normalizedUserId) return null;
  const state = ensureNativeDiscordScreenShareState(session);
  const current = state.sharers.get(normalizedUserId);
  if (!current) return null;
  const now = Date.now();
  const nextValue: VoiceSessionNativeScreenShareSharerState = {
    ...current,
    lastFrameAt: now,
    lastFrameCodec: normalizeCodec(payload.codec),
    lastFrameKeyframeAt: payload.keyframe ? now : current.lastFrameKeyframeAt
  };
  state.sharers.set(normalizedUserId, nextValue);
  return nextValue;
}

export function listActiveNativeDiscordScreenSharers(
  session: NativeDiscordScreenShareSessionLike | null | undefined
): VoiceSessionNativeScreenShareSharerState[] {
  const state = ensureNativeDiscordScreenShareState(session || null);
  return [...state.sharers.values()]
    .filter((entry) => sharerLooksActive(entry))
    .sort((left, right) => {
      const leftAt = Number(left.lastFrameAt || left.updatedAt || 0);
      const rightAt = Number(right.lastFrameAt || right.updatedAt || 0);
      return rightAt - leftAt;
    });
}

export function resolveNativeDiscordScreenWatchTarget({
  session,
  requesterUserId = null
}: {
  session: NativeDiscordScreenShareSessionLike | null | undefined;
  requesterUserId?: string | null;
}) {
  const normalizedRequesterUserId = String(requesterUserId || "").trim() || null;
  const sharers = listActiveNativeDiscordScreenSharers(session);
  if (sharers.length <= 0) {
    return {
      targetUserId: null,
      reason: "no_active_discord_screen_share"
    };
  }
  if (normalizedRequesterUserId && sharers.some((entry) => entry.userId === normalizedRequesterUserId)) {
    return {
      targetUserId: normalizedRequesterUserId,
      reason: "requester_active_discord_screen_share"
    };
  }
  if (sharers.length === 1) {
    return {
      targetUserId: sharers[0]?.userId || null,
      reason: "single_active_discord_screen_share"
    };
  }
  return {
    targetUserId: null,
    reason: "multiple_active_discord_screen_shares"
  };
}

export function getNativeDiscordScreenSharePromptEntries(
  session: VoiceSession | null | undefined,
  resolveVoiceSpeakerName: (session: VoiceSession, userId?: string | null) => string
) {
  if (!session) return [];
  return listActiveNativeDiscordScreenSharers(session).map((entry) => {
    const displayName = resolveVoiceSpeakerName(session, entry.userId) || entry.userId;
    const preferredStream =
      entry.streams.find((stream) => stream.active !== false) ||
      entry.streams[0] ||
      null;
    return {
      userId: entry.userId,
      displayName,
      codec: normalizeCodec(entry.codec),
      streamType: preferredStream?.streamType || null,
      quality: preferredStream?.quality ?? null,
      pixelCount: preferredStream?.pixelCount ?? null,
      width: preferredStream?.width ?? null,
      height: preferredStream?.height ?? null,
      lastFrameAt: Number(entry.lastFrameAt || 0),
      updatedAt: Number(entry.updatedAt || 0)
    };
  });
}
