import { getCompactedSessionSummaryContext } from "./voiceContextCompaction.ts";
import { getNativeDiscordScreenSharePromptEntries } from "./nativeDiscordScreenShare.ts";
import { formatVoiceToolResultSummary } from "./voiceToolResultSummary.ts";
import type { VoiceRealtimeToolSettings, VoiceSession, VoiceToolCallEvent } from "./voiceSessionTypes.ts";

type StreamWatchPromptContext = {
  prompt?: string;
  notes?: string[];
  active?: boolean;
  lastAt?: number;
  provider?: string | null;
  model?: string | null;
};

type ScreenShareCapabilityLike = {
  available?: boolean;
  supported?: boolean;
  enabled?: boolean;
  status?: string | null;
  reason?: string | null;
  publicUrl?: string | null;
  nativeSupported?: boolean;
  nativeEnabled?: boolean;
  nativeAvailable?: boolean;
  nativeStatus?: string | null;
  nativeReason?: string | null;
  linkSupported?: boolean;
  linkEnabled?: boolean;
  linkFallbackAvailable?: boolean;
  linkStatus?: string | null;
  linkReason?: string | null;
  transport?: string | null;
};

type VoiceChannelParticipant = {
  userId: string;
  displayName: string;
};

type VoiceMembershipPromptEntry = {
  userId: string;
  displayName: string;
  eventType: string;
  at: number;
  ageMs: number;
};

type VoiceChannelEffectPromptEntry = {
  userId: string;
  displayName: string;
  channelId: string;
  guildId: string;
  effectType: string;
  soundId: string | null;
  soundName: string | null;
  soundVolume: number | null;
  emoji: string | null;
  animationType: number | null;
  animationId: number | null;
  at: number;
  ageMs: number;
  summary: string;
};

type MusicPromptContext = {
  playbackState: "playing" | "paused" | "stopped" | "idle";
  replyHandoffMode: "duck" | "pause" | null;
  currentTrack: { id: string | null; title: string; artists: string[] } | null;
  lastTrack: { id: string | null; title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
  lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
  lastQuery: string | null;
};

export interface NormalizedVoiceScreenWatchCapability {
  supported: boolean;
  enabled: boolean;
  available: boolean;
  status: string;
  publicUrl: string;
  reason: string | null;
  nativeSupported: boolean;
  nativeEnabled: boolean;
  nativeAvailable: boolean;
  nativeStatus: string;
  nativeReason: string | null;
  linkSupported: boolean;
  linkEnabled: boolean;
  linkFallbackAvailable: boolean;
  linkStatus: string;
  linkReason: string | null;
}

export interface VoiceTurnToolOutcomeContext {
  callId: string;
  toolName: string;
  toolType: "function" | "mcp";
  success: boolean;
  startedAt: string;
  completedAt: string | null;
  runtimeMs: number | null;
  ageMs: number | null;
  outputSummary: VoiceToolCallEvent["outputSummary"];
  error: string | null;
}

export interface SharedVoiceTurnContext {
  participantRoster: VoiceChannelParticipant[];
  recentMembershipEvents: VoiceMembershipPromptEntry[];
  recentVoiceEffectEvents: VoiceChannelEffectPromptEntry[];
  screenWatchCapability: NormalizedVoiceScreenWatchCapability;
  nativeDiscordSharers: ReturnType<typeof getNativeDiscordScreenSharePromptEntries>;
  streamWatchNotes: StreamWatchPromptContext | null;
  recentToolOutcomes: VoiceTurnToolOutcomeContext[];
  recentToolOutcomeLines: string[];
  compactedSessionSummary: ReturnType<typeof getCompactedSessionSummaryContext>;
  musicContext: MusicPromptContext | null;
}

export interface SharedVoiceTurnContextHost {
  resolveVoiceSpeakerName: (session: VoiceSession, userId?: string | null) => string;
  getStreamWatchNotesForPrompt: (
    session: VoiceSession,
    settings?: VoiceRealtimeToolSettings | null
  ) => StreamWatchPromptContext | null;
  getVoiceScreenWatchCapability: (args?: {
    settings?: VoiceRealtimeToolSettings | null;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
  }) => ScreenShareCapabilityLike | null;
  getVoiceChannelParticipants: (session: VoiceSession) => VoiceChannelParticipant[];
  getRecentVoiceMembershipEvents: (
    session: VoiceSession,
    args?: { now?: number; maxItems?: number }
  ) => VoiceMembershipPromptEntry[];
  getRecentVoiceChannelEffectEvents: (
    session: VoiceSession,
    args?: { now?: number; maxItems?: number }
  ) => VoiceChannelEffectPromptEntry[];
  getMusicPromptContext?: (session: VoiceSession) => MusicPromptContext | null;
}

export function normalizeVoiceScreenWatchCapability(
  capability: ScreenShareCapabilityLike | null | undefined
): NormalizedVoiceScreenWatchCapability {
  if (!capability || typeof capability !== "object") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_watch_capability_unavailable",
      nativeSupported: false,
      nativeEnabled: false,
      nativeAvailable: false,
      nativeStatus: "disabled",
      nativeReason: "screen_watch_capability_unavailable",
      linkSupported: false,
      linkEnabled: false,
      linkFallbackAvailable: false,
      linkStatus: "disabled",
      linkReason: "share_link_unavailable"
    };
  }
  const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
  const enabled = Boolean(capability?.enabled);
  const available = capability?.available === undefined ? enabled && status === "ready" : Boolean(capability.available);
  const rawReason = String(capability?.reason || "").trim().toLowerCase();
  const supported =
    capability?.supported === undefined
      ? rawReason !== "screen_watch_unavailable"
      : Boolean(capability.supported);
  const nativeStatus = String(capability?.nativeStatus || "disabled").trim().toLowerCase() || "disabled";
  const nativeEnabled =
    capability?.nativeEnabled === undefined
      ? enabled
      : Boolean(capability.nativeEnabled);
  const nativeSupported =
    capability?.nativeSupported === undefined
      ? supported
      : Boolean(capability.nativeSupported);
  const nativeAvailable =
    capability?.nativeAvailable === undefined
      ? Boolean(capability?.transport === "native" && available)
      : Boolean(capability.nativeAvailable);
  const rawNativeReason = String(capability?.nativeReason || "").trim().toLowerCase();
  const linkStatus = String(capability?.linkStatus || "disabled").trim().toLowerCase() || "disabled";
  const linkEnabled = Boolean(capability?.linkEnabled);
  const linkSupported = Boolean(capability?.linkSupported);
  const linkFallbackAvailable =
    capability?.linkFallbackAvailable === undefined
      ? Boolean(capability?.transport === "link" && available)
      : Boolean(capability.linkFallbackAvailable);
  const rawLinkReason = String(capability?.linkReason || "").trim().toLowerCase();

  return {
    supported,
    enabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "unavailable",
    nativeSupported,
    nativeEnabled,
    nativeAvailable,
    nativeStatus,
    nativeReason: nativeAvailable ? null : rawNativeReason || nativeStatus || "unavailable",
    linkSupported,
    linkEnabled,
    linkFallbackAvailable,
    linkStatus,
    linkReason: linkFallbackAvailable ? null : rawLinkReason || linkStatus || "unavailable"
  };
}

function formatRelativeAge(ageMs: number | null) {
  if (!Number.isFinite(Number(ageMs))) return null;
  const normalizedAgeMs = Math.max(0, Math.round(Number(ageMs) || 0));
  if (normalizedAgeMs < 1_000) return "just now";
  if (normalizedAgeMs < 60_000) return `${Math.max(1, Math.round(normalizedAgeMs / 1_000))}s ago`;
  return `${Math.max(1, Math.round(normalizedAgeMs / 60_000))}m ago`;
}

export function buildRecentVoiceToolOutcomeContext(
  session: VoiceSession | null | undefined,
  {
    now = Date.now(),
    maxItems = 4
  }: {
    now?: number;
    maxItems?: number;
  } = {}
) {
  const events = Array.isArray(session?.toolCallEvents) ? session.toolCallEvents : [];
  return events
    .slice(-Math.max(1, Math.round(Number(maxItems) || 4)))
    .map((entry) => {
      const completedAt = String(entry?.completedAt || "").trim() || null;
      const startedAt = String(entry?.startedAt || "").trim();
      const completedAtMs = completedAt ? Date.parse(completedAt) : Number.NaN;
      const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
      const referenceAtMs = Number.isFinite(completedAtMs) ? completedAtMs : startedAtMs;
      return {
        callId: String(entry?.callId || "").trim(),
        toolName: String(entry?.toolName || "").trim(),
        toolType: entry?.toolType === "mcp" ? "mcp" : "function",
        success: Boolean(entry?.success),
        startedAt,
        completedAt,
        runtimeMs: Number.isFinite(Number(entry?.runtimeMs)) ? Math.round(Number(entry.runtimeMs)) : null,
        ageMs: Number.isFinite(referenceAtMs) ? Math.max(0, now - referenceAtMs) : null,
        outputSummary: entry?.outputSummary ?? null,
        error: String(entry?.error || "").trim() || null
      } satisfies VoiceTurnToolOutcomeContext;
    })
    .filter((entry) => entry.toolName);
}

export function formatRecentVoiceToolOutcomeLine(entry: VoiceTurnToolOutcomeContext) {
  const timing = formatRelativeAge(entry.ageMs);
  const outcome = entry.success ? "succeeded" : "failed";
  const summary = formatVoiceToolResultSummary(entry.outputSummary, 220);
  const parts = [
    `${entry.toolName} ${outcome}`,
    timing ? `(${timing})` : null,
    summary ? `summary=${summary}` : null,
    entry.error && (!summary || !summary.includes(entry.error)) ? `error=${entry.error}` : null
  ].filter(Boolean);
  return parts.join(" ");
}

export function buildSharedVoiceTurnContext(
  host: SharedVoiceTurnContextHost,
  {
    session,
    settings = null,
    speakerUserId = null,
    now = Date.now(),
    maxParticipants = 8,
    maxMembershipEvents = 6,
    maxVoiceEffects = 6,
    maxToolOutcomes = 4
  }: {
    session: VoiceSession;
    settings?: VoiceRealtimeToolSettings | null;
    speakerUserId?: string | null;
    now?: number;
    maxParticipants?: number;
    maxMembershipEvents?: number;
    maxVoiceEffects?: number;
    maxToolOutcomes?: number;
  }
): SharedVoiceTurnContext {
  const participantRoster = host.getVoiceChannelParticipants(session).slice(0, Math.max(1, Math.round(Number(maxParticipants) || 8)));
  const recentMembershipEvents = host.getRecentVoiceMembershipEvents(session, {
    now,
    maxItems: Math.max(1, Math.round(Number(maxMembershipEvents) || 6))
  });
  const recentVoiceEffectEvents = host.getRecentVoiceChannelEffectEvents(session, {
    now,
    maxItems: Math.max(1, Math.round(Number(maxVoiceEffects) || 6))
  });
  const screenWatchCapability = normalizeVoiceScreenWatchCapability(
    host.getVoiceScreenWatchCapability({
      settings,
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      requesterUserId: speakerUserId || null
    })
  );
  const nativeDiscordSharers = getNativeDiscordScreenSharePromptEntries(
    session,
    (currentSession, userId) => host.resolveVoiceSpeakerName(currentSession, userId)
  );
  const streamWatchNotes = host.getStreamWatchNotesForPrompt(session, settings) || null;
  const recentToolOutcomes = buildRecentVoiceToolOutcomeContext(session, {
    now,
    maxItems: maxToolOutcomes
  });

  return {
    participantRoster,
    recentMembershipEvents,
    recentVoiceEffectEvents,
    screenWatchCapability,
    nativeDiscordSharers,
    streamWatchNotes,
    recentToolOutcomes,
    recentToolOutcomeLines: recentToolOutcomes.map((entry) => formatRecentVoiceToolOutcomeLine(entry)).filter(Boolean),
    compactedSessionSummary: getCompactedSessionSummaryContext(session),
    musicContext: typeof host.getMusicPromptContext === "function"
      ? host.getMusicPromptContext(session)
      : null
  };
}
