import { normalizeInlineText, STT_TRANSCRIPT_MAX_CHARS } from "./voiceSessionHelpers.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";
import { executeVoiceMusicQueueAddTool, executeVoiceMusicQueueNextTool } from "./voiceToolCallMusic.ts";
import { ensureSessionToolRuntimeState } from "./voiceToolCallToolRegistry.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import {
  applyOrchestratorOverrideSettings,
  getResolvedVoiceMusicBrainBinding
} from "../settings/agentStack.ts";
import type {
  MusicSelectionResult,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type VoiceMusicSettings = Record<string, unknown> | null;

type MusicPromptAction = "play_now" | "stop" | "pause" | "resume" | "skip" | null;

type MusicDisambiguationPromptContext = {
  active: true;
  query: string | null;
  platform: "youtube" | "soundcloud" | "discord" | "auto";
  action: "play_now" | "queue_next" | "queue_add";
  requestedByUserId: string | null;
  options: MusicSelectionResult[];
} | null;

type MusicRuntimeSnapshot = {
  active?: boolean;
  pauseReason?: string | null;
  replyHandoffMode?: string | null;
  replyHandoffRequestedByUserId?: string | null;
  replyHandoffSource?: string | null;
  replyHandoffAt?: string | null;
  lastTrackId?: string | null;
  lastTrackTitle?: string | null;
  lastTrackArtists?: string[] | null;
  lastCommandReason?: unknown;
  lastQuery?: string | null;
  queueState?: {
    tracks?: Array<{
      id?: string | null;
      title?: string | null;
      artist?: string | null;
    }>;
    nowPlayingIndex?: number | null;
    isPaused?: boolean;
  } | null;
} | null;

export type VoiceMusicDisambiguationHost = VoiceToolCallManager & {
  snapshotMusicRuntimeState: (
    session: VoiceToolRuntimeSessionLike | null | undefined
  ) => MusicRuntimeSnapshot;
  getMusicDisambiguationPromptContext: (
    session: VoiceToolRuntimeSessionLike | null | undefined
  ) => MusicDisambiguationPromptContext;
  isVoiceCommandSessionActiveForUser: (
    session: VoiceToolRuntimeSessionLike | null | undefined,
    userId: string,
    args?: { domain?: string | null }
  ) => boolean;
  clearMusicDisambiguationState: (
    session: VoiceToolRuntimeSessionLike | null | undefined
  ) => unknown;
  clearVoiceCommandSession: (
    session: VoiceToolRuntimeSessionLike | null | undefined
  ) => void;
  composeOperationalMessage?: (args: {
    settings?: VoiceMusicSettings;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string;
    reason?: string | null;
    details?: Record<string, unknown>;
    allowSkip?: boolean;
  }) => Promise<unknown> | unknown;
  llm?: {
    generate?: (args: {
      settings: VoiceMusicSettings;
      systemPrompt: string;
      userPrompt: string;
      contextMessages?: unknown[];
      jsonSchema?: string;
      trace?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<{
      text?: string | null;
      provider?: string | null;
      model?: string | null;
    }>;
  } | null;
};

const MUSIC_DISAMBIGUATION_RESOLVER_MAX_OUTPUT_TOKENS = 80;
const MUSIC_DISAMBIGUATION_RESOLVER_TRACE_SOURCE = "voice_music_disambiguation_resolver";

function buildMusicDisambiguationResolverJsonSchema(validSelectionIds: string[]) {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      selection_id: {
        type: "string",
        enum: [...validSelectionIds, ""]
      },
      reasoning: {
        type: "string"
      }
    },
    required: ["selection_id"]
  });
}

function buildMusicDisambiguationResolverSystemPrompt() {
  return [
    "You resolve a user's follow-up against a fixed list of music options that were already offered.",
    "Choose the existing selection_id the user most likely meant.",
    "Handle ordinal references, partial title or artist mentions, paraphrase, and small ASR mistakes.",
    "Only choose a selection_id when the user is clearly referring to one listed option.",
    "If the user is unclear or not selecting one listed option, return an empty selection_id.",
    "Never invent a selection_id.",
    "Return JSON only."
  ].join(" ");
}

function buildMusicDisambiguationResolverUserPrompt({
  query,
  transcript,
  options
}: {
  query?: string | null;
  transcript: string;
  options: MusicSelectionResult[];
}) {
  const optionLines = options
    .map((option, index) => {
      const title = String(option?.title || "").trim();
      const artist = String(option?.artist || "").trim();
      const id = String(option?.id || "").trim();
      return `${index + 1}. selection_id=${id}; title=${title || "unknown"}; artist=${artist || "unknown"}`;
    })
    .join("\n");
  return [
    `Original music query: ${String(query || "").trim() || "unknown"}`,
    `User follow-up: ${transcript}`,
    "Options:",
    optionLines
  ].join("\n");
}

function parseMusicDisambiguationResolverResult(rawText: unknown, validSelectionIds: Set<string>) {
  const normalized = String(rawText || "").trim();
  if (!normalized) return null;
  const unwrapped = normalized.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(unwrapped);
    const selectionId = normalizeInlineText(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.selection_id ?? parsed.selectionId ?? ""
        : "",
      180
    );
    if (!selectionId) return "";
    return validSelectionIds.has(selectionId) ? selectionId : null;
  } catch {
    return null;
  }
}

export function describeMusicPromptAction(reason: unknown): MusicPromptAction {
  const normalizedReason = String(reason || "")
    .trim()
    .toLowerCase();
  if (!normalizedReason) return null;
  if (normalizedReason.includes("pause")) return "pause";
  if (normalizedReason.includes("resume")) return "resume";
  if (normalizedReason.includes("skip")) return "skip";
  if (normalizedReason.includes("stop") || normalizedReason === "session_end") return "stop";
  if (normalizedReason.includes("play")) return "play_now";
  return null;
}

export function getMusicPromptContext(
  host: VoiceMusicDisambiguationHost,
  session: VoiceToolRuntimeSessionLike | null | undefined
): {
  playbackState: "playing" | "paused" | "stopped" | "idle";
  replyHandoffMode: "duck" | "pause" | null;
  currentTrack: { id: string | null; title: string; artists: string[] } | null;
  lastTrack: { id: string | null; title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
  lastAction: MusicPromptAction;
  lastQuery: string | null;
} | null {
  const snapshot = host.snapshotMusicRuntimeState(session);
  if (!snapshot) return null;
  const queueTracks = Array.isArray(snapshot.queueState?.tracks) ? snapshot.queueState.tracks : [];
  const nowPlayingIndex = Number.isInteger(snapshot.queueState?.nowPlayingIndex)
    ? Number(snapshot.queueState?.nowPlayingIndex)
    : null;
  const currentQueueTrack =
    nowPlayingIndex != null && nowPlayingIndex >= 0 && nowPlayingIndex < queueTracks.length
      ? queueTracks[nowPlayingIndex]
      : null;
  const currentTrack = currentQueueTrack?.title
    ? {
      id: currentQueueTrack.id ? String(currentQueueTrack.id).trim() : null,
      title: currentQueueTrack.title,
      artists: currentQueueTrack.artist ? [currentQueueTrack.artist] : []
    }
    : snapshot.lastTrackTitle
      ? {
        id: snapshot.lastTrackId ? String(snapshot.lastTrackId).trim() : null,
        title: snapshot.lastTrackTitle,
        artists: Array.isArray(snapshot.lastTrackArtists) ? snapshot.lastTrackArtists : []
      }
      : null;
  const lastTrack = snapshot.lastTrackTitle
    ? {
      id: snapshot.lastTrackId ? String(snapshot.lastTrackId).trim() : null,
      title: snapshot.lastTrackTitle,
      artists: Array.isArray(snapshot.lastTrackArtists) ? snapshot.lastTrackArtists : []
    }
    : null;
  const upcomingTracks =
    nowPlayingIndex != null && nowPlayingIndex >= 0
      ? queueTracks.slice(nowPlayingIndex + 1)
      : queueTracks;
  let playbackState: "playing" | "paused" | "stopped" | "idle" = "idle";
  if (snapshot.queueState?.isPaused) {
    playbackState = "paused";
  } else if (snapshot.active) {
    playbackState = "playing";
  } else if (snapshot.lastCommandReason && describeMusicPromptAction(snapshot.lastCommandReason) === "stop") {
    playbackState = "stopped";
  }
  return {
    playbackState,
    replyHandoffMode:
      snapshot.replyHandoffMode === "duck" || snapshot.replyHandoffMode === "pause"
        ? snapshot.replyHandoffMode
        : null,
    currentTrack,
    lastTrack,
    queueLength: queueTracks.length,
    upcomingTracks: upcomingTracks
      .map((track) => ({
        id: track?.id ? String(track.id).trim() : null,
        title: String(track?.title || "").trim(),
        artist: track?.artist ? String(track.artist).trim() : null
      }))
      .filter((track) => track.title)
      .slice(0, 3),
    lastAction: describeMusicPromptAction(snapshot.lastCommandReason),
    lastQuery: snapshot.lastQuery || null
  };
}

export function hasPendingMusicDisambiguationForUser(
  host: VoiceMusicDisambiguationHost,
  session: VoiceToolRuntimeSessionLike | null | undefined,
  userId: string | null = null
) {
  const disambiguation = host.getMusicDisambiguationPromptContext(session);
  if (!disambiguation?.active) return false;
  const normalizedUserId = String(userId || "").trim();
  const requestedByUserId = String(disambiguation.requestedByUserId || "").trim();
  if (!normalizedUserId || !requestedByUserId) return false;
  return normalizedUserId === requestedByUserId;
}

export function resolvePendingMusicDisambiguationSelection(
  host: VoiceMusicDisambiguationHost,
  session: VoiceToolRuntimeSessionLike | null | undefined,
  transcript = ""
) {
  const disambiguation = host.getMusicDisambiguationPromptContext(session);
  if (!disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
    return null;
  }
  const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return null;
  const normalizedText = text.toLowerCase();
  const options = disambiguation.options;
  const parsedIndex = Number.parseInt(text, 10);
  if (Number.isFinite(parsedIndex) && String(parsedIndex) === text && parsedIndex >= 1) {
    return options[parsedIndex - 1] || null;
  }
  const ordinalIndexByToken = new Map<string, number>([
    ["first", 0],
    ["1st", 0],
    ["second", 1],
    ["2nd", 1],
    ["third", 2],
    ["3rd", 2],
    ["fourth", 3],
    ["4th", 3],
    ["fifth", 4],
    ["5th", 4]
  ]);
  for (const [token, optionIndex] of ordinalIndexByToken.entries()) {
    if (normalizedText.includes(token)) {
      return options[optionIndex] || null;
    }
  }

  const cleanedSelectionText = normalizedText
    .replace(/\b(?:the|one|version|song|track|by|please|plz|uh|um|like)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return options.find((entry) => {
    const idToken = String(entry?.id || "").trim().toLowerCase();
    if (idToken && normalizedText === idToken) return true;
    const artistToken = String(entry?.artist || "").trim().toLowerCase();
    const titleToken = String(entry?.title || "").trim().toLowerCase();
    const combined = `${titleToken} ${artistToken}`.trim();
    if (cleanedSelectionText && combined.includes(cleanedSelectionText)) return true;
    if (cleanedSelectionText && artistToken && cleanedSelectionText.includes(artistToken)) return true;
    if (cleanedSelectionText && titleToken && cleanedSelectionText.includes(titleToken)) return true;
    return false;
  }) || null;
}

async function resolvePendingMusicDisambiguationSelectionWithLlm(
  host: VoiceMusicDisambiguationHost,
  session: VoiceToolRuntimeSessionLike | null | undefined,
  transcript = "",
  settings: VoiceMusicSettings = null
) {
  const disambiguation = host.getMusicDisambiguationPromptContext(session);
  if (!session || !disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
    return null;
  }
  const llm = host.llm;
  if (!llm?.generate) return null;
  const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return null;

  const validSelectionIds = disambiguation.options
    .map((option) => normalizeInlineText(option?.id, 180))
    .filter((id): id is string => Boolean(id));
  if (!validSelectionIds.length) return null;

  const resolvedSettings =
    settings ||
    session.settingsSnapshot ||
    host.store.getSettings() ||
    null;
  const binding = getResolvedVoiceMusicBrainBinding(resolvedSettings);
  const llmSettings = applyOrchestratorOverrideSettings(resolvedSettings, {
    provider: binding.provider,
    model: binding.model,
    temperature: 0,
    maxOutputTokens: MUSIC_DISAMBIGUATION_RESOLVER_MAX_OUTPUT_TOKENS
  });
  const generation = await llm.generate({
    settings: llmSettings,
    systemPrompt: buildMusicDisambiguationResolverSystemPrompt(),
    userPrompt: buildMusicDisambiguationResolverUserPrompt({
      query: disambiguation.query || "",
      transcript: text,
      options: disambiguation.options
    }),
    contextMessages: [],
    jsonSchema: buildMusicDisambiguationResolverJsonSchema(validSelectionIds),
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId || null,
      userId: disambiguation.requestedByUserId || null,
      source: MUSIC_DISAMBIGUATION_RESOLVER_TRACE_SOURCE,
      reason: "pending_selection_resolution"
    }
  });
  const selectedId = parseMusicDisambiguationResolverResult(generation?.text, new Set(validSelectionIds));
  if (!selectedId) return null;
  return disambiguation.options.find((option) => String(option?.id || "").trim() === selectedId) || null;
}

export function isMusicDisambiguationResolutionTurn(
  host: VoiceMusicDisambiguationHost,
  session: VoiceToolRuntimeSessionLike | null | undefined,
  userId: string | null = null,
  transcript = ""
) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return false;
  if (!hasPendingMusicDisambiguationForUser(host, session, normalizedUserId)) {
    return false;
  }
  if (!host.isVoiceCommandSessionActiveForUser(session, normalizedUserId, { domain: "music" })) {
    return false;
  }
  const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;
  if (isCancelIntent(text)) {
    return true;
  }
  return Boolean(resolvePendingMusicDisambiguationSelection(host, session, text));
}

export async function completePendingMusicDisambiguationSelection(
  host: VoiceMusicDisambiguationHost,
  {
    session,
    settings,
    userId = null,
    selected,
    reason = "voice_music_disambiguation_selection",
    source = "voice_disambiguation",
    channel = null,
    channelId = null,
    messageId = null,
    mustNotify = false
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: VoiceMusicSettings;
    userId?: string | null;
    selected?: MusicSelectionResult | null;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  } = {}
) {
  const disambiguation = host.getMusicDisambiguationPromptContext(session);
  if (!session || !disambiguation?.active || !selected) return false;
  const resolvedSettings = settings || session.settingsSnapshot || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const action = disambiguation.action || "play_now";
  if (action === "play_now") {
    await host.requestPlayMusic({
      guildId: session.guildId,
      channel,
      channelId: channelId || session.textChannelId || null,
      requestedByUserId: normalizedUserId,
      settings: resolvedSettings,
      query: disambiguation.query || "",
      platform: disambiguation.platform || "auto",
      trackId: selected.id,
      searchResults: disambiguation.options,
      reason,
      source,
      mustNotify
    });
    return true;
  }

  const runtimeSession = ensureSessionToolRuntimeState(host, session);
  const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map<string, MusicSelectionResult>();
  if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
    runtimeSession.toolMusicTrackCatalog = catalog;
  }
  catalog.set(selected.id, selected);
  host.clearMusicDisambiguationState(session);
  if (action === "queue_next") {
    await executeVoiceMusicQueueNextTool(host, {
      session,
      settings: resolvedSettings,
      args: {
        tracks: [selected.id]
      }
    });
  } else {
    await executeVoiceMusicQueueAddTool(host, {
      session,
      settings: resolvedSettings,
      args: {
        tracks: [selected.id],
        position: "end"
      }
    });
  }
  host.clearVoiceCommandSession(session);
  await sendOperationalMessage(host, {
    channel,
    settings: resolvedSettings,
    guildId: session.guildId,
    channelId: channelId || session.textChannelId || null,
    userId: normalizedUserId,
    messageId,
    event: "voice_music_request",
    reason: action === "queue_next" ? "queued_next" : "queued",
    details: {
      source,
      query: disambiguation.query || null,
      trackId: selected.id,
      trackTitle: selected.title,
      trackArtists: selected.artist ? [selected.artist] : []
    },
    mustNotify
  });
  return true;
}

export async function maybeHandlePendingMusicDisambiguationTurn(
  host: VoiceMusicDisambiguationHost,
  {
    session,
    settings,
    userId = null,
    transcript = "",
    reason = "voice_music_disambiguation_selection",
    source = "voice_disambiguation",
    channel = null,
    channelId = null,
    messageId = null,
    mustNotify = false
  }: {
    session?: VoiceToolRuntimeSessionLike | null;
    settings?: VoiceMusicSettings;
    userId?: string | null;
    transcript?: string;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  } = {}
) {
  const disambiguation = host.getMusicDisambiguationPromptContext(session);
  if (!session || !disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
    return false;
  }
  const normalizedUserId = String(userId || "").trim();
  const requestedByUserId = String(disambiguation.requestedByUserId || "").trim();
  if (!normalizedUserId) {
    return false;
  }
  if (requestedByUserId && normalizedUserId !== requestedByUserId) {
    return false;
  }
  const text = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;
  if (isCancelIntent(text)) {
    host.clearMusicDisambiguationState(session);
    host.clearVoiceCommandSession(session);
    await sendOperationalMessage(host, {
      channel,
      settings: settings || session.settingsSnapshot || null,
      guildId: session.guildId,
      channelId: channelId || session.textChannelId || null,
      userId: normalizedUserId,
      messageId,
      event: "voice_music_request",
      reason: "disambiguation_cancelled",
      details: {
        source,
        requestText: text
      },
      mustNotify
    });
    return true;
  }

  const selected =
    resolvePendingMusicDisambiguationSelection(host, session, text) ||
    await resolvePendingMusicDisambiguationSelectionWithLlm(
      host,
      session,
      text,
      settings || session.settingsSnapshot || null
    );
  if (!selected) return false;
  return await completePendingMusicDisambiguationSelection(host, {
    session,
    settings,
    userId: normalizedUserId,
    selected,
    reason,
    source,
    channel,
    channelId,
    messageId,
    mustNotify
  });
}
