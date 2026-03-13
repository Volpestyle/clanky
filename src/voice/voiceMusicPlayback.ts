import { ChatInputCommandInteraction } from "discord.js";
import {
  getMusicResumeStateSnapshot,
  hasKnownMusicResumeState,
  noteMusicResumeRequest,
  setKnownMusicQueuePausedState
} from "./musicResumeState.ts";
import { normalizeInlineText, STT_TRANSCRIPT_MAX_CHARS, resolveVoiceAsrLanguageGuidance } from "./voiceSessionHelpers.ts";
import {
  getResolvedVoiceMusicBrainBinding,
  isVoiceMusicBrainEnabled,
  getVoiceConversationPolicy,
  getVoiceStreamWatchSettings,
  getVoiceRuntimeConfig
} from "../settings/agentStack.ts";
import { normalizeStreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";
import { sendOperationalMessage } from "./voiceOperationalMessaging.ts";
import { getMusicWakeFollowupState } from "./musicWakeLatch.ts";
import { resolveTurnTranscriptionPlan, transcribePcmTurnWithPlan } from "./voiceDecisionRuntime.ts";
import { VOICE_TOOL_SCHEMAS, toAnthropicTool } from "../tools/sharedToolSchemas.ts";
import {
  executeReplyTool,
  type ReplyToolContext,
  type ReplyToolRuntime
} from "../tools/replyTools.ts";
import type { ToolLoopContentBlock, ToolLoopMessage } from "../llm/serviceShared.ts";
import { RECENT_ENGAGEMENT_WINDOW_MS } from "./voiceSessionManager.constants.ts";

import { clamp } from "../utils.ts";
import type { BargeInController } from "./bargeInController.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { MusicPlaybackProvider } from "./musicPlayback.ts";
import type { DiscordMusicPlayer } from "./musicPlayer.ts";
import type { MusicSearchProvider } from "./musicSearch.ts";
import type { ReplyManager } from "./replyManager.ts";
import { resolveVoiceDirectAddressSignal } from "./voiceAddressing.ts";

// English-only fallback/fast-path heuristics for obvious music control turns.
// These are lightweight transport shortcuts, not the main conversational brain.
const EN_MUSIC_STOP_VERB_RE = /\b(?:stop|halt|end|quit|shut\s*off)\b/i;
const EN_MUSIC_PAUSE_VERB_RE = /\b(?:pause)\b/i;
const EN_MUSIC_RESUME_VERB_RE = /\b(?:resume|unpause|continue)\b/i;
const EN_MUSIC_RESUME_PRONOUN_RE = /\b(?:resume|unpause|continue)\s+it\b/i;
const EN_MUSIC_RESUME_PLAY_CURRENT_RE =
  /\bplay\s+(?:it|this(?:\s+(?:song|track|music|playback))?|the\s+(?:song|track|music|playback))(?:\s+(?:again|back(?:\s+up)?))?(?:\s+(?:please|plz|now))?\s*$/i;
const EN_MUSIC_SKIP_VERB_RE = /\b(?:skip|next)\b/i;
const EN_MUSIC_CUE_RE = /\b(?:music|musik|song|songs|track|tracks|playback|playing)\b/i;
const EN_MUSIC_PLAY_VERB_RE = /\b(?:play|start|queue|put\s+on|spin)\b/i;
const EN_MUSIC_PLAY_QUERY_RE =
  /\b(?:play|start|queue|put\s+on|spin)\s+(.+?)\b(?:in\s+vc|in\s+the\s+vc|in\s+voice|in\s+discord|right\s+now|rn|please|plz)?$/i;
const EN_MUSIC_QUERY_TRAILING_NOISE_RE =
  /\b(?:in\s+vc|in\s+the\s+vc|in\s+voice|in\s+discord|right\s+now|rn|please|plz|for\s+me|for\s+us|for\s+everyone|for\s+everybody|for\s+the\s+chat|thanks?)\b/gi;
const EN_MUSIC_QUERY_MEDIA_WORD_RE = /\b(?:music|musik|song|songs|track|tracks)\b/gi;
const EN_MUSIC_QUERY_EMPTY_RE = /^(?:something|anything|some|a|the|please|plz)$/i;
const COMPACT_MUSIC_CONTROL_NOISE_RE =
  /\b(?:the|this|current|my|our|your|music|musik|song|songs|track|tracks|playback|playing|please|plz|now)\b/g;
const MUSIC_DISAMBIGUATION_MAX_RESULTS = 5;
const MUSIC_DISAMBIGUATION_TTL_MS = 10 * 60 * 1000;
const VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK = 5;
const VOICE_MUSIC_BRAIN_MAX_STEPS = 4;
const VOICE_MUSIC_BRAIN_MAX_OUTPUT_TOKENS = 120;
const VOICE_MUSIC_BRAIN_RECENT_TURN_MAX_CHARS = 180;
const VOICE_MUSIC_BRAIN_TOOL_NAMES = new Set([
  "music_search",
  "music_play",
  "video_search",
  "video_play",
  "music_queue_add",
  "music_queue_next",
  "media_stop",
  "media_pause",
  "media_resume",
  "media_skip",
  "media_now_playing"
]);
const VOICE_MUSIC_BRAIN_TOOL_DEFINITIONS = VOICE_TOOL_SCHEMAS
  .filter((schema) => VOICE_MUSIC_BRAIN_TOOL_NAMES.has(schema.name))
  .map((schema) => toAnthropicTool(schema));

import type {
  MusicSelectionResult,
  MusicDisambiguationPayload,
  MusicTextRequestPayload,
  MusicTextCommandMessage,
  MusicPlaybackPhase,
  MusicPauseReason,
  MusicReplyHandoffMode,
  VoiceSession,
  VoiceSessionMusicState
} from "./voiceSessionTypes.ts";
import {
  musicPhaseIsActive,
  musicPhaseCanResume,
  musicPhaseCanPause,
  musicPhaseShouldAllowDucking,
  musicPhaseShouldForceCommandOnly
} from "./voiceSessionTypes.ts";

type MusicPlaybackSettings = Record<string, unknown> | null;
type VoiceMusicBrainDecision = "consumed" | "pass";
type VoiceMusicControlCommand = "stop" | "pause" | "resume" | "skip";

type MusicPlaybackStoreLike = {
  getSettings: () => MusicPlaybackSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
    usdCost?: number | null;
  }) => void;
};

type MusicRuntimeSessionLike = {
  ending?: boolean;
  id?: string;
  guildId?: string;
  textChannelId?: string | null;
  voiceChannelId?: string | null;
  settingsSnapshot?: MusicPlaybackSettings;
  lastRealtimeToolCallerUserId?: string | null;
  botSpeechMusicUnduckTimer?: ReturnType<typeof setTimeout> | null;
  voiceCommandState?: {
    userId: string | null;
    domain: string | null;
    intent: string | null;
    startedAt: number;
    expiresAt: number;
  } | null;
  music?: VoiceSessionMusicState | null;
  musicQueueState?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type MusicPlaybackLogArgs = Parameters<MusicPlaybackStoreLike["logAction"]>[0];

export interface MusicPlaybackHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
    channels: {
      fetch: (channelId: string) => Promise<unknown>;
    };
    guilds: {
      cache: {
        get: (guildId: string) => unknown;
      };
    };
  };
  sessions: Map<string, VoiceSession>;
  store: MusicPlaybackStoreLike;
  llm?: {
    transcribeAudio?: unknown;
    chatWithTools?: (args: {
      provider?: string;
      model?: string;
      systemPrompt: string;
      messages: ToolLoopMessage[];
      tools: Array<{
        name: string;
        description: string;
        input_schema: {
          type: "object";
          properties: Record<string, unknown>;
          required?: string[];
          additionalProperties?: boolean;
        };
        strict?: boolean;
      }>;
      maxOutputTokens?: number;
      temperature?: number;
      trace?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<{
      content: ToolLoopContentBlock[];
      stopReason: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
      };
      costUsd: number;
    }>;
  } | null;
  replyManager: Pick<ReplyManager, "clearPendingResponse" | "hasBufferedTtsPlayback" | "schedulePausedReplyMusicResume">;
  bargeInController: Pick<BargeInController, "clearBargeInOutputSuppression">;
  deferredActionQueue: Pick<DeferredActionQueue, "clearAllDeferredVoiceActions">;
  beginVoiceCommandSession: (args: {
    session?: MusicRuntimeSessionLike | null;
    userId?: string | null;
    domain?: string | null;
    intent?: string | null;
    ttlMs?: number | null;
  }) => unknown;
  clearVoiceCommandSession: (
    session: MusicRuntimeSessionLike | null | undefined
  ) => void;
  musicPlayer?: Pick<DiscordMusicPlayer, "duck" | "unduck" | "play" | "stop" | "pause" | "resume"> | null;
  musicPlayback?: Pick<MusicPlaybackProvider, "provider" | "isConfigured" | "startPlayback" | "stopPlayback"> | null;
  musicSearch?: Pick<MusicSearchProvider, "isConfigured" | "search"> | null;
  maybeClearActiveReplyInterruptionPolicy: (session: MusicRuntimeSessionLike | null | undefined) => void;
  abortActiveInboundCaptures: (args: {
    session: VoiceSession;
    reason?: string;
  }) => void;
  composeOperationalMessage?: (args: {
    settings?: MusicPlaybackSettings;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    event?: string;
    reason?: string | null;
    details?: Record<string, unknown>;
    allowSkip?: boolean;
  }) => Promise<unknown> | unknown;
  transcribePcmTurn: (args: {
    session: VoiceSession;
    userId: string;
    pcmBuffer: Buffer;
    model: string;
    sampleRateHz?: number;
    captureReason?: string;
    traceSource?: string;
    errorPrefix?: string;
    emptyTranscriptRuntimeEvent?: string;
    emptyTranscriptErrorStreakThreshold?: number;
    suppressEmptyTranscriptLogs?: boolean;
    asrLanguage?: string;
    asrPrompt?: string;
  }) => Promise<string>;
  hasBotNameCueForTranscript: (args?: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  }) => boolean;
  hasPendingMusicDisambiguationForUser?: (
    session: MusicRuntimeSessionLike,
    userId?: string | null
  ) => boolean;
  isMusicDisambiguationResolutionTurn: (
    session: MusicRuntimeSessionLike,
    userId?: string | null,
    transcript?: string
  ) => boolean;
  maybeHandlePendingMusicDisambiguationTurn: (args: {
    session?: MusicRuntimeSessionLike | null;
    settings?: MusicPlaybackSettings;
    userId?: string | null;
    transcript?: string;
    reason?: string;
    source?: string;
    channel?: unknown;
    channelId?: string | null;
    messageId?: string | null;
    mustNotify?: boolean;
  }) => Promise<boolean>;
  playVoiceQueueTrackByIndex: (args: {
    session: MusicRuntimeSessionLike | null | undefined;
    settings?: MusicPlaybackSettings;
    index: number;
  }) => Promise<unknown>;
  requestStopMusic: (args: {
    message?: unknown;
    guildId?: string | null;
    channel?: unknown;
    channelId?: string | null;
    requestedByUserId?: string | null;
    settings?: MusicPlaybackSettings | null;
    reason?: string;
    source?: string;
    requestText?: string;
    clearQueue?: boolean;
    mustNotify?: boolean;
  }) => Promise<unknown>;
  requestJoin?: (args: {
    message: {
      guild: unknown;
      guildId: string;
      channel: unknown;
      channelId: string;
      id: string | null;
      author: {
        id: string;
        username: string;
      };
      member: {
        id: string;
        displayName?: string | null;
        user?: {
          username?: string | null;
          bot?: boolean | null;
        } | null;
        voice?: {
          channel?: unknown | null;
        } | null;
      } | null;
    };
    settings: MusicPlaybackSettings;
    intentConfidence?: number | null;
  }) => Promise<boolean>;
  buildVoiceToolCallbacks?: (args: {
    session: VoiceSession;
    settings?: MusicPlaybackSettings;
  }) => NonNullable<ReplyToolRuntime["voiceSession"]>;
}

type SlashMusicVoiceMemberLike = {
  id: string;
  displayName?: string | null;
  user?: {
    username?: string | null;
    bot?: boolean | null;
  } | null;
  voice?: {
    channel?: unknown | null;
  } | null;
};

function ephemeralReply(content: string) {
  return {
    content,
    flags: ["Ephemeral"] as const
  };
}

async function resolveSlashMusicVoiceMember(
  interaction: ChatInputCommandInteraction
): Promise<SlashMusicVoiceMemberLike> {
  const guild = interaction.guild;
  const user = interaction.user;
  const interactionMember = interaction.member;
  if (interactionMember && typeof interactionMember === "object" && "voice" in interactionMember) {
    const memberLike = interactionMember as SlashMusicVoiceMemberLike;
    if (memberLike.voice?.channel) {
      return {
        id: String(memberLike.id || user.id),
        displayName: memberLike.displayName || user.username,
        user: memberLike.user || {
          username: user.username,
          bot: user.bot
        },
        voice: {
          channel: memberLike.voice.channel
        }
      };
    }
  }

  const cachedMember = guild?.members?.cache?.get?.(user.id) as SlashMusicVoiceMemberLike | undefined;
  if (cachedMember?.voice?.channel) {
    return {
      id: String(cachedMember.id || user.id),
      displayName: cachedMember.displayName || user.username,
      user: cachedMember.user || {
        username: user.username,
        bot: user.bot
      },
      voice: {
        channel: cachedMember.voice.channel
      }
    };
  }

  if (typeof guild?.members?.fetch === "function") {
    try {
      const fetchedMember = await guild.members.fetch(user.id);
      if (fetchedMember?.voice?.channel) {
        return {
          id: String(fetchedMember.id || user.id),
          displayName: fetchedMember.displayName || user.username,
          user: fetchedMember.user || {
            username: user.username,
            bot: user.bot
          },
          voice: {
            channel: fetchedMember.voice.channel
          }
        };
      }
    } catch {
      // Fall through to the voice-state fallback below.
    }
  }

  const voiceChannel = guild?.voiceStates?.cache?.get?.(user.id)?.channel || null;
  return {
    id: user.id,
    displayName: user.username,
    user: {
      username: user.username,
      bot: user.bot
    },
    voice: {
      channel: voiceChannel
    }
  };
}

function logMusicAction(
  manager: MusicPlaybackHost,
  entry: MusicPlaybackLogArgs
) {
  manager.store.logAction(entry);
}

function clearToolMusicQueueState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const queueState = ensureToolMusicQueueState(manager, session);
  if (!queueState) return null;
  queueState.tracks = [];
  queueState.nowPlayingIndex = null;
  queueState.isPaused = false;
  return queueState;
}

function logMusicResumeUnavailable(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  source: string,
  phase: string
) {
  const snapshot = getMusicResumeStateSnapshot(session);
  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session?.guildId,
    channelId: session?.textChannelId,
    userId: manager.client.user?.id || null,
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

export function ensureSessionMusicState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  void manager;
  if (!session || typeof session !== "object") return null;
  if (session.music && typeof session.music === "object") return session.music;
  session.music = {
    phase: "idle" as const,
    ducked: false,
    pauseReason: null,
    replyHandoffMode: null,
    replyHandoffRequestedByUserId: null,
    replyHandoffSource: null,
    replyHandoffAt: 0,
    startedAt: 0,
    stoppedAt: 0,
    provider: null,
    source: null,
    lastTrackId: null,
    lastTrackTitle: null,
    lastTrackArtists: [],
    lastTrackUrl: null,
    lastPlaybackUrl: null,
    lastPlaybackResolvedDirectUrl: false,
    lastQuery: null,
    lastRequestedByUserId: null,
    lastRequestText: null,
    lastCommandAt: 0,
    lastCommandReason: null,
    pendingQuery: null,
    pendingPlatform: "auto",
    pendingAction: "play_now",
    pendingResults: [],
    pendingRequestedByUserId: null,
    pendingRequestedAt: 0
  };
  return session.music;
}

export function snapshotMusicRuntimeState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const music = ensureSessionMusicState(manager, session);
  const queueState = ensureToolMusicQueueState(manager, session);
  if (!music) return null;
  return {
    phase: music.phase || "idle",
    active: musicPhaseIsActive(music.phase || "idle"),
    pauseReason: music.pauseReason || null,
    replyHandoffMode: music.replyHandoffMode || null,
    replyHandoffRequestedByUserId: music.replyHandoffRequestedByUserId || null,
    replyHandoffSource: music.replyHandoffSource || null,
    replyHandoffAt: Number(music.replyHandoffAt || 0) > 0
      ? new Date(Number(music.replyHandoffAt)).toISOString()
      : null,
    provider: music.provider || null,
    source: music.source || null,
    startedAt: music.startedAt > 0 ? new Date(music.startedAt).toISOString() : null,
    stoppedAt: music.stoppedAt > 0 ? new Date(music.stoppedAt).toISOString() : null,
    lastTrackId: music.lastTrackId || null,
    lastTrackTitle: music.lastTrackTitle || null,
    lastTrackArtists: Array.isArray(music.lastTrackArtists) ? music.lastTrackArtists : [],
    lastTrackUrl: music.lastTrackUrl || null,
    lastPlaybackUrl: music.lastPlaybackUrl || null,
    lastPlaybackResolvedDirectUrl: Boolean(music.lastPlaybackResolvedDirectUrl),
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
    disambiguationActive: isMusicDisambiguationActive(manager, music),
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
}

/** Get the current music playback phase (single source of truth). */
export function getMusicPhase(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
): MusicPlaybackPhase {
  const music = ensureSessionMusicState(manager, session);
  return music?.phase ?? "idle";
}

/**
 * Set the music playback phase.
 * ALL music state transitions MUST go through this function.
 */
export function setMusicPhase(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  phase: MusicPlaybackPhase,
  pauseReason: MusicPauseReason = null
): void {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.phase = phase;
  music.pauseReason = pauseReason;
  if (music.replyHandoffMode === "pause" && phase !== "paused_wake_word") {
    music.replyHandoffMode = null;
    music.replyHandoffRequestedByUserId = null;
    music.replyHandoffSource = null;
    music.replyHandoffAt = 0;
  }
  if (
    music.replyHandoffMode === "duck" &&
    phase !== "playing" &&
    phase !== "loading"
  ) {
    music.replyHandoffMode = null;
    music.replyHandoffRequestedByUserId = null;
    music.replyHandoffSource = null;
    music.replyHandoffAt = 0;
  }
}

export function setPendingMusicReplyHandoff(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  {
    mode,
    requestedByUserId = null,
    source = null
  }: {
    mode: MusicReplyHandoffMode;
    requestedByUserId?: string | null;
    source?: string | null;
  }
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return null;
  music.replyHandoffMode = mode;
  music.replyHandoffRequestedByUserId = String(requestedByUserId || "").trim() || null;
  music.replyHandoffSource = String(source || "").trim() || null;
  music.replyHandoffAt = Date.now();
  return music;
}

export function clearPendingMusicReplyHandoff(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return null;
  music.replyHandoffMode = null;
  music.replyHandoffRequestedByUserId = null;
  music.replyHandoffSource = null;
  music.replyHandoffAt = 0;
  return music;
}

function formatVoiceMusicBrainTrack(
  track: {
    title?: string | null;
    artist?: string | null;
    artists?: string[];
    id?: string | null;
  } | null | undefined
) {
  const title = String(track?.title || "").trim();
  if (!title) return null;
  const artists = Array.isArray(track?.artists)
    ? track.artists.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const artist = artists.length > 0
    ? artists.join(", ")
    : String(track?.artist || "").trim();
  const id = String(track?.id || "").trim();
  return `${title}${artist ? ` - ${artist}` : ""}${id ? ` [selection_id: ${id}]` : ""}`;
}

function buildVoiceMusicBrainRecentContextLines(
  session: VoiceSession,
  userId: string | null,
  transcript: string
) {
  const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
  if (turns.length <= 0) return [];

  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedCurrentTranscript = normalizeInlineText(transcript, VOICE_MUSIC_BRAIN_RECENT_TURN_MAX_CHARS);
  let lastAssistantReply: string | null = null;
  let previousSpeakerTurn: string | null = null;
  let previousSpeakerLabel: string | null = null;
  let lastUserTurnFallback: string | null = null;
  let lastUserTurnFallbackLabel: string | null = null;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const text = normalizeInlineText(turn?.text || "", VOICE_MUSIC_BRAIN_RECENT_TURN_MAX_CHARS);
    if (!text) continue;

    if (!lastAssistantReply && turn?.role === "assistant") {
      lastAssistantReply = text;
    }

    if (turn?.role === "user") {
      const speakerLabel = String(turn?.speakerName || "this speaker").trim() || "this speaker";
      if (!lastUserTurnFallback && text !== normalizedCurrentTranscript) {
        lastUserTurnFallback = text;
        lastUserTurnFallbackLabel = speakerLabel;
      }
      if (
        !previousSpeakerTurn &&
        normalizedUserId &&
        String(turn?.userId || "").trim() === normalizedUserId &&
        text !== normalizedCurrentTranscript
      ) {
        previousSpeakerTurn = text;
        previousSpeakerLabel = speakerLabel;
      }
    }

    if (lastAssistantReply && (previousSpeakerTurn || (!normalizedUserId && lastUserTurnFallback))) {
      break;
    }
  }

  const lines: string[] = [];
  if (lastAssistantReply) {
    lines.push(`- Last assistant reply: ${lastAssistantReply}`);
  }
  if (previousSpeakerTurn) {
    lines.push(`- Previous turn from this speaker (${previousSpeakerLabel || "this speaker"}): ${previousSpeakerTurn}`);
  } else if (lastUserTurnFallback) {
    lines.push(`- Previous user turn (${lastUserTurnFallbackLabel || "someone"}): ${lastUserTurnFallback}`);
  }
  return lines;
}

function buildVoiceMusicBrainSystemPrompt(
  manager: MusicPlaybackHost,
  {
    session,
    settings,
    userId,
    transcript,
    directAddressedToBot,
    musicWakeLatched,
    pausedWakeWordOwnerFollowup,
    passiveWakeFollowupAllowed,
    interruptedReplyOwnerFollowup,
    currentPhase,
    source
  }: {
    session: VoiceSession;
    settings: MusicPlaybackSettings;
    userId: string | null;
    transcript: string;
    directAddressedToBot: boolean;
    musicWakeLatched: boolean;
    pausedWakeWordOwnerFollowup: boolean;
    passiveWakeFollowupAllowed: boolean;
    interruptedReplyOwnerFollowup: boolean;
    currentPhase: MusicPlaybackPhase;
    source: string;
  }
) {
  const musicSnapshot = snapshotMusicRuntimeState(manager, session);
  const currentTrack =
    musicSnapshot?.queueState &&
    Number.isInteger(musicSnapshot.queueState.nowPlayingIndex) &&
    Number(musicSnapshot.queueState.nowPlayingIndex) >= 0
      ? musicSnapshot.queueState.tracks[Number(musicSnapshot.queueState.nowPlayingIndex)] || null
      : null;
  const upcomingTracks = Array.isArray(musicSnapshot?.queueState?.tracks)
    && Number.isInteger(musicSnapshot.queueState.nowPlayingIndex)
      ? musicSnapshot.queueState.tracks.slice(Number(musicSnapshot.queueState.nowPlayingIndex) + 1, Number(musicSnapshot.queueState.nowPlayingIndex) + 4)
      : [];
  const lines = [
    "You are the bot's tiny live music command brain for voice chat while music context is active.",
    "Only decide whether this looks like a real playback-control or disambiguation turn that the music layer should consume now.",
    "Use the provided music tools only when the user is actually asking to control playback, queue, search, pause, resume, skip, or stop music.",
    "If tools fully handle the turn or the turn should stay swallowed as a music-side command, finish with exactly [CONSUMED].",
    "If this should go to the main voice brain instead, finish with exactly [PASS].",
    "Return only one final token: [CONSUMED] or [PASS]. No extra text.",
    "Do not choose duck or pause floor-shaping here. Wake-word and conversational turns belong to the main voice brain.",
    "If the user is asking an opinion, making normal conversation, or otherwise not clearly issuing a music-side command, use [PASS].",
    "",
    "Turn context:",
    `- Heard: ${transcript}`,
    `- Source: ${source}`,
    `- Directly addressed to bot: ${directAddressedToBot ? "yes" : "no"}`,
    `- Music wake latch open: ${musicWakeLatched ? "yes" : "no"}`,
    `- Wake-word follow-up owned by this speaker: ${pausedWakeWordOwnerFollowup ? "yes" : "no"}`,
    `- Passive wake follow-up allowed: ${passiveWakeFollowupAllowed ? "yes" : "no"}`,
    `- Recent interrupted-reply follow-up from this speaker: ${interruptedReplyOwnerFollowup ? "yes" : "no"}`,
    `- Current music phase: ${currentPhase}`
  ];
  const recentContextLines = buildVoiceMusicBrainRecentContextLines(session, userId, transcript);
  if (recentContextLines.length > 0) {
    lines.push(...recentContextLines);
  }
  if (musicSnapshot?.replyHandoffMode === "pause") {
    lines.push("- Runtime already paused music for the current reply handoff.");
  } else if (musicSnapshot?.replyHandoffMode === "duck") {
    lines.push("- Runtime plans to duck music under the current reply handoff.");
  }
  const currentTrackLine = formatVoiceMusicBrainTrack(currentTrack);
  if (currentTrackLine) {
    lines.push(`- Current track: ${currentTrackLine}`);
  }
  const lastTrackLine = formatVoiceMusicBrainTrack({
    id: musicSnapshot?.lastTrackId || null,
    title: musicSnapshot?.lastTrackTitle || null,
    artists: Array.isArray(musicSnapshot?.lastTrackArtists) ? musicSnapshot.lastTrackArtists : []
  });
  if (lastTrackLine && lastTrackLine !== currentTrackLine) {
    lines.push(`- Last track: ${lastTrackLine}`);
  }
  if (upcomingTracks.length > 0) {
    lines.push(`- Queue depth: ${Math.max(0, Number(musicSnapshot?.queueState?.tracks?.length || 0))}`);
    for (const [index, track] of upcomingTracks.entries()) {
      const line = formatVoiceMusicBrainTrack(track);
      if (line) {
        lines.push(`- Upcoming ${index + 1}: ${line}`);
      }
    }
  }
  if (musicSnapshot?.lastCommandReason) {
    lines.push(`- Last music action: ${String(musicSnapshot.lastCommandReason)}`);
  }
  if (musicSnapshot?.lastQuery) {
    lines.push(`- Last music query: ${String(musicSnapshot.lastQuery)}`);
  }
  const musicBrainBinding = getResolvedVoiceMusicBrainBinding(settings);
  lines.push(`- Music brain model context: ${musicBrainBinding.provider}:${musicBrainBinding.model}`);
  return lines.join("\n");
}

function normalizeVoiceMusicBrainDecision(text: string): VoiceMusicBrainDecision | null {
  const normalized = String(text || "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "[CONSUMED]" || normalized === "CONSUMED") return "consumed";
  if (normalized === "[PASS]" || normalized === "PASS") return "pass";
  return null;
}

function normalizeVoiceMusicCommandTranscript(transcript: string) {
  return normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS)
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveCompactVoiceMusicControlCommand(
  transcript: string,
  currentPhase: MusicPlaybackPhase
): VoiceMusicControlCommand | null {
  const normalizedTranscript = normalizeVoiceMusicCommandTranscript(transcript);
  if (!normalizedTranscript) return null;
  const compactTranscript = normalizedTranscript
    .replace(COMPACT_MUSIC_CONTROL_NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedCompactTranscript =
    compactTranscript && compactTranscript.split(" ").length <= 2
      ? compactTranscript
      : normalizedTranscript;

  if (
    normalizedCompactTranscript === "stop" ||
    normalizedCompactTranscript === "halt" ||
    normalizedCompactTranscript === "end" ||
    normalizedCompactTranscript === "quit" ||
    normalizedCompactTranscript === "shut off"
  ) {
    return "stop";
  }
  if (normalizedCompactTranscript === "pause") {
    return "pause";
  }
  if (normalizedCompactTranscript === "skip" || normalizedCompactTranscript === "next") {
    return "skip";
  }
  if (
    (
      normalizedCompactTranscript === "resume" ||
      normalizedCompactTranscript === "unpause" ||
      normalizedCompactTranscript === "continue"
    )
    && musicPhaseCanResume(currentPhase)
  ) {
    return "resume";
  }
  return null;
}

function isLikelyVoiceMusicControlCommandTurn(
  manager: MusicPlaybackHost,
  {
    transcript,
    currentPhase
  }: {
    transcript: string;
    currentPhase: MusicPlaybackPhase;
  }
) {
  if (isLikelyMusicStopPhrase(manager, { transcript })) return true;
  if (isLikelyMusicPausePhrase(manager, { transcript })) return true;
  if (isLikelyMusicSkipPhrase(manager, { transcript })) return true;
  if (musicPhaseCanResume(currentPhase) && isLikelyMusicResumePhrase(manager, { transcript })) return true;
  return false;
}

async function executeCompactVoiceMusicControlCommand(
  manager: MusicPlaybackHost,
  {
    session,
    settings,
    userId,
    transcript,
    command,
    currentPhase,
    source
  }: {
    session: VoiceSession;
    settings: MusicPlaybackSettings;
    userId: string | null;
    transcript: string;
    command: VoiceMusicControlCommand;
    currentPhase: MusicPlaybackPhase;
    source: string;
  }
) {
  const normalizedUserId = String(userId || "").trim() || null;
  switch (command) {
    case "stop":
      await requestStopMusic(manager, {
        guildId: session.guildId,
        channelId: session.textChannelId || null,
        requestedByUserId: normalizedUserId,
        settings,
        reason: "voice_fast_path_stop",
        source,
        requestText: transcript,
        clearQueue: true,
        mustNotify: false
      });
      return true;
    case "pause":
      await requestPauseMusic(manager, {
        guildId: session.guildId,
        channelId: session.textChannelId || null,
        requestedByUserId: normalizedUserId,
        settings,
        reason: "voice_fast_path_pause",
        source,
        requestText: transcript,
        mustNotify: false
      });
      return true;
    case "resume": {
      if (!hasKnownMusicResumeState(session)) {
        setMusicPhase(manager, session, "idle");
        clearPendingMusicReplyHandoff(manager, session);
        setKnownMusicQueuePausedState(session, false);
        logMusicResumeUnavailable(manager, session, "music_resumed_fast_path", currentPhase);
        return true;
      }
      noteMusicResumeRequest(session, "music_resumed_fast_path");
      manager.musicPlayer?.resume?.();
      return true;
    }
    case "skip": {
      const queueState = ensureToolMusicQueueState(manager, session);
      if (!queueState || queueState.nowPlayingIndex == null) return false;
      const nextIndex = queueState.nowPlayingIndex + 1;
      await requestStopMusic(manager, {
        guildId: session.guildId,
        channelId: session.textChannelId || null,
        requestedByUserId: normalizedUserId,
        settings,
        reason: "voice_fast_path_skip",
        source,
        requestText: transcript,
        mustNotify: false
      });
      if (nextIndex < queueState.tracks.length) {
        await manager.playVoiceQueueTrackByIndex({ session, settings, index: nextIndex });
      } else {
        queueState.nowPlayingIndex = null;
        queueState.isPaused = false;
      }
      return true;
    }
  }
}

async function runVoiceMusicBrainDecision(
  manager: MusicPlaybackHost,
  {
    session,
    settings,
    userId,
    transcript,
    directAddressedToBot,
    musicWakeLatched,
    pausedWakeWordOwnerFollowup,
    passiveWakeFollowupAllowed,
    interruptedReplyOwnerFollowup,
    currentPhase,
    source
  }: {
    session: VoiceSession;
    settings: MusicPlaybackSettings;
    userId: string | null;
    transcript: string;
    directAddressedToBot: boolean;
    musicWakeLatched: boolean;
    pausedWakeWordOwnerFollowup: boolean;
    passiveWakeFollowupAllowed: boolean;
    interruptedReplyOwnerFollowup: boolean;
    currentPhase: MusicPlaybackPhase;
    source: string;
  }
) {
  const settingsRecord =
    settings && typeof settings === "object"
      ? settings
      : session.settingsSnapshot && typeof session.settingsSnapshot === "object"
        ? session.settingsSnapshot
        : manager.store.getSettings() && typeof manager.store.getSettings() === "object"
          ? manager.store.getSettings()
          : {};
  if (!isVoiceMusicBrainEnabled(settingsRecord)) {
    return {
      decision: "pass" as VoiceMusicBrainDecision,
      rawText: "",
      toolCallCount: 0,
      totalCostUsd: 0,
      steps: 0
    };
  }
  const binding = getResolvedVoiceMusicBrainBinding(settingsRecord);
  const llm = manager.llm;
  if (!llm?.chatWithTools || !manager.buildVoiceToolCallbacks) {
    return {
      decision: "pass" as VoiceMusicBrainDecision,
      rawText: "",
      toolCallCount: 0,
      totalCostUsd: 0,
      steps: 0
    };
  }

  const runtime: ReplyToolRuntime = {
    voiceSession: manager.buildVoiceToolCallbacks({ session, settings })
  };
  const toolContext: ReplyToolContext = {
    settings: settingsRecord,
    guildId: session.guildId,
    channelId: session.textChannelId || null,
    userId: String(userId || session.requestedByUserId || "voice-user"),
    sourceMessageId: session.id,
    sourceText: transcript,
    botUserId: String(manager.client.user?.id || "").trim() || undefined,
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId || null,
      userId,
      source: "voice_music_brain"
    }
  };

  const messages: ToolLoopMessage[] = [
    {
      role: "user",
      content: transcript
    }
  ];
  let step = 0;
  let toolCallCount = 0;
  let totalCostUsd = 0;
  let finalText = "";

  while (step < VOICE_MUSIC_BRAIN_MAX_STEPS) {
    step++;
    const response = await llm.chatWithTools({
      provider: binding.provider,
      model: binding.model,
      systemPrompt: buildVoiceMusicBrainSystemPrompt(manager, {
        session,
        settings,
        userId,
        transcript,
        directAddressedToBot,
        musicWakeLatched,
        pausedWakeWordOwnerFollowup,
        passiveWakeFollowupAllowed,
        interruptedReplyOwnerFollowup,
        currentPhase,
        source
      }),
      messages,
      tools: VOICE_MUSIC_BRAIN_TOOL_DEFINITIONS,
      maxOutputTokens: VOICE_MUSIC_BRAIN_MAX_OUTPUT_TOKENS,
      temperature: 0,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        source: "voice_music_brain"
      }
    });
    totalCostUsd += Number(response.costUsd || 0);
    messages.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter((block) => block.type === "tool_call");
    if (toolCalls.length <= 0) {
      finalText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      break;
    }

    const toolResults: ToolLoopContentBlock[] = [];
    for (const toolCall of toolCalls) {
      toolCallCount += 1;
      const result = await executeReplyTool(
        toolCall.name,
        toolCall.input,
        runtime,
        toolContext
      );
      toolResults.push({
        type: "tool_result",
        toolCallId: toolCall.id,
        content: result.content,
        isError: Boolean(result.isError)
      });
    }
    messages.push({
      role: "user",
      content: toolResults
    });
  }

  return {
    decision: normalizeVoiceMusicBrainDecision(finalText) || (toolCallCount > 0 ? "consumed" : "pass"),
    rawText: finalText,
    toolCallCount,
    totalCostUsd,
    steps: step
  };
}

function hasRecentInterruptedReplyFollowup(
  session: VoiceSession,
  userId?: string | null,
  now = Date.now()
) {
  if (!session || session.ending) return false;
  const interrupted = session.interruptedAssistantReply;
  if (!interrupted || typeof interrupted !== "object") return false;

  const normalizedUserId = String(userId || "").trim();
  const interruptedByUserId = String(interrupted.interruptedByUserId || "").trim();
  if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
    return false;
  }

  const interruptedAt = Math.max(0, Number(interrupted.interruptedAt || 0));
  if (!interruptedAt) return false;
  if (now - interruptedAt > RECENT_ENGAGEMENT_WINDOW_MS) {
    return false;
  }
  if (Math.max(0, Number(session.lastAssistantReplyAt || 0)) > interruptedAt) {
    return false;
  }

  return Boolean(normalizeInlineText(interrupted.utteranceText || "", STT_TRANSCRIPT_MAX_CHARS));
}

function isMusicPlaybackActive(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  return musicPhaseIsActive(getMusicPhase(manager, session));
}

export function isCommandOnlyActive(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  settings: MusicPlaybackSettings = null
) {
  const resolved = settings || session?.settingsSnapshot || manager.store.getSettings();
  if (getVoiceConversationPolicy(resolved).commandOnlyMode) return true;
  return musicPhaseShouldForceCommandOnly(getMusicPhase(manager, session));
}

export function resolveMusicDuckingConfig(
  manager: MusicPlaybackHost,
  settings: MusicPlaybackSettings = null
) {
  void manager;
  const resolved = settings || manager.store.getSettings();
  const voiceSettings =
    resolved && typeof resolved === "object" && "voice" in resolved && typeof resolved.voice === "object"
      ? (resolved.voice as Record<string, unknown>)
      : null;
  const musicDuckingSettings =
    voiceSettings &&
    "musicDucking" in voiceSettings &&
    typeof voiceSettings.musicDucking === "object"
      ? (voiceSettings.musicDucking as Record<string, unknown>)
      : null;
  const targetGainRaw = Number(musicDuckingSettings?.targetGain);
  const fadeMsRaw = Number(musicDuckingSettings?.fadeMs);
  return {
    targetGain: clamp(
      Number.isFinite(targetGainRaw) ? targetGainRaw : 0.15,
      0.05,
      1
    ),
    fadeMs: clamp(
      Number.isFinite(fadeMsRaw) ? Math.round(fadeMsRaw) : 300,
      0,
      5000
    )
  };
}

export function clearBotSpeechMusicUnduckTimer(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  void manager;
  if (!session) return;
  if (session.botSpeechMusicUnduckTimer) {
    clearTimeout(session.botSpeechMusicUnduckTimer);
    session.botSpeechMusicUnduckTimer = null;
  }
}

export async function engageBotSpeechMusicDuck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  { awaitFade = false } = {}
) {
  if (!session || session.ending) return false;
  if (!musicPhaseShouldAllowDucking(getMusicPhase(manager, session))) {
    session.botSpeechMusicDucked = false;
    return false;
  }
  clearBotSpeechMusicUnduckTimer(manager, session);
  const music = ensureSessionMusicState(manager, session);
  if (music?.ducked) {
    session.botSpeechMusicDucked = true;
    return true;
  }
  const { targetGain, fadeMs } = resolveMusicDuckingConfig(
    manager,
    settings || session.settingsSnapshot || manager.store.getSettings()
  );
  const duckPromise = manager.musicPlayer?.duck({ targetGain, fadeMs });
  if (music) music.ducked = true;
  session.botSpeechMusicDucked = true;
  if (awaitFade) {
    await duckPromise;
  }
  return true;
}

export function scheduleBotSpeechMusicUnduck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  delayMs = 0
) {
  if (!session || session.ending) return;
  const music = ensureSessionMusicState(manager, session);
  if (!session.botSpeechMusicDucked && !music?.ducked) return;
  clearBotSpeechMusicUnduckTimer(manager, session);
  const normalizedDelayMs = clamp(Math.round(Number(delayMs) || 0), 0, 15_000);
  session.botSpeechMusicUnduckTimer = setTimeout(() => {
    session.botSpeechMusicUnduckTimer = null;
    if (manager.replyManager.hasBufferedTtsPlayback(session) || Boolean(session.botTurnOpen)) {
      scheduleBotSpeechMusicUnduck(manager, session, settings, Math.min(200, normalizedDelayMs || 200));
      return;
    }
    releaseBotSpeechMusicDuck(manager, session, settings).catch((error) => {
      logMusicAction(manager, {
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `voice_music_unduck_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: "bot_speech_unduck_timer"
        }
      });
    });
  }, normalizedDelayMs);
}

export async function releaseBotSpeechMusicDuck(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  settings: MusicPlaybackSettings = null,
  { force = false } = {}
) {
  if (!session) return false;
  clearBotSpeechMusicUnduckTimer(manager, session);
  const music = ensureSessionMusicState(manager, session);
  const ducked = Boolean(music?.ducked) || Boolean(session.botSpeechMusicDucked);
  if (!ducked) {
    return false;
  }
  session.botSpeechMusicDucked = false;
  if (music) music.ducked = false;
  if (music?.replyHandoffMode === "duck") {
    clearPendingMusicReplyHandoff(manager, session);
  }
  if (!force && !musicPhaseShouldAllowDucking(getMusicPhase(manager, session))) {
    return false;
  }
  const { fadeMs } = resolveMusicDuckingConfig(
    manager,
    settings || session.settingsSnapshot || manager.store.getSettings()
  );
  manager.musicPlayer?.unduck({ targetGain: 1, fadeMs });
  return true;
}

export function normalizeMusicPlatformToken(
  manager: MusicPlaybackHost,
  value: unknown = "",
  fallback: "youtube" | "soundcloud" | "discord" | "auto" | null = null
) {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (token === "youtube" || token === "soundcloud" || token === "discord" || token === "auto") {
    return token;
  }
  return fallback;
}

export function normalizeMusicSelectionResult(
  manager: MusicPlaybackHost,
  rawResult: Record<string, unknown> | null = null
): MusicSelectionResult | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const id = normalizeInlineText(rawResult.id, 180);
  const title = normalizeInlineText(rawResult.title, 220);
  const artist = normalizeInlineText(rawResult.artist, 220);
  const platform = normalizeMusicPlatformToken(manager, rawResult.platform, null);
  if (!id || !title || !artist || !platform) return null;
  const externalUrl = normalizeInlineText(rawResult.externalUrl || rawResult.url, 260) || null;
  const durationRaw = Number(rawResult.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.floor(durationRaw) : null;
  return {
    id,
    title,
    artist,
    platform,
    externalUrl,
    durationSeconds
  };
}

export function isMusicDisambiguationActive(
  manager: MusicPlaybackHost,
  musicState: VoiceSessionMusicState | null = null
) {
  const music = musicState && typeof musicState === "object" ? musicState : null;
  if (!music) return false;
  const pendingAt = Math.max(0, Number(music.pendingRequestedAt || 0));
  if (!pendingAt) return false;
  const ageMs = Math.max(0, Date.now() - pendingAt);
  if (ageMs > MUSIC_DISAMBIGUATION_TTL_MS) return false;
  return Array.isArray(music.pendingResults) && music.pendingResults.length > 0;
}

export function clearMusicDisambiguationState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return;
  music.pendingQuery = null;
  music.pendingPlatform = "auto";
  music.pendingAction = "play_now";
  music.pendingResults = [];
  music.pendingRequestedByUserId = null;
  music.pendingRequestedAt = 0;
}

export function setMusicDisambiguationState(manager: MusicPlaybackHost, {
  session,
  query = "",
  platform = "auto",
  action = "play_now",
  results = [],
  requestedByUserId = null
}: MusicDisambiguationPayload = {}) {
  const music = ensureSessionMusicState(manager, session);
  if (!music) return null;
  const normalizedResults = (Array.isArray(results) ? results : [])
    .map((entry) => normalizeMusicSelectionResult(manager, entry))
    .filter(Boolean)
    .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
  if (!normalizedResults.length) {
    clearMusicDisambiguationState(manager, session);
    return null;
  }
  music.pendingQuery = normalizeInlineText(query, 120) || null;
  music.pendingPlatform = normalizeMusicPlatformToken(manager, platform, "auto");
  music.pendingAction =
    action === "queue_next" || action === "queue_add"
      ? action
      : "play_now";
  music.pendingResults = normalizedResults;
  music.pendingRequestedByUserId = String(requestedByUserId || "").trim() || null;
  music.pendingRequestedAt = Date.now();
  return music.pendingResults;
}

export function findPendingMusicSelectionById(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined,
  selectedResultId = ""
) {
  const music = ensureSessionMusicState(manager, session);
  if (!music || !isMusicDisambiguationActive(manager, music)) return null;
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
}

export function getMusicDisambiguationPromptContext(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
): {
  active: true;
  query: string | null;
  platform: "youtube" | "soundcloud" | "discord" | "auto";
  action: "play_now" | "queue_next" | "queue_add";
  requestedByUserId: string | null;
  options: MusicSelectionResult[];
} | null {
  const music = ensureSessionMusicState(manager, session);
  if (!music || !isMusicDisambiguationActive(manager, music)) return null;
  return {
    active: true,
    query: music.pendingQuery || null,
    platform: normalizeMusicPlatformToken(manager, music.pendingPlatform, "auto") || "auto",
    action:
      music.pendingAction === "queue_next" || music.pendingAction === "queue_add"
        ? music.pendingAction
        : "play_now",
    requestedByUserId: music.pendingRequestedByUserId || null,
    options: (Array.isArray(music.pendingResults) ? music.pendingResults : [])
      .map((entry) => normalizeMusicSelectionResult(manager, entry))
      .filter((entry): entry is MusicSelectionResult => Boolean(entry))
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS)
  };
}

export function ensureToolMusicQueueState(
  manager: MusicPlaybackHost,
  session: MusicRuntimeSessionLike | null | undefined
) {
  if (!session || typeof session !== "object") return null;
  const current: Record<string, unknown> =
    session.musicQueueState && typeof session.musicQueueState === "object"
      ? session.musicQueueState
      : {};
  const tracks = Array.isArray(current.tracks) ? current.tracks : [];
  const normalizedTracks = tracks
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = normalizeInlineText(entry.id, 180);
      const title = normalizeInlineText(entry.title, 220);
      if (!id || !title) return null;
      return {
        id,
        title,
        artist: normalizeInlineText(entry.artist, 220) || null,
        durationMs: Number.isFinite(Number(entry.durationMs))
          ? Math.max(0, Math.round(Number(entry.durationMs)))
          : null,
        source:
          String(entry.source || "")
              .trim()
              .toLowerCase() === "sc"
              ? "sc"
              : "yt",
        streamUrl: normalizeInlineText(entry.streamUrl, 300) || null,
        platform: normalizeMusicPlatformToken(manager, entry.platform, "youtube") || "youtube",
        externalUrl: normalizeInlineText(entry.externalUrl, 300) || null
      };
    })
    .filter(Boolean);
  const normalizedNowPlayingIndexRaw =
    typeof current.nowPlayingIndex === "number" ? current.nowPlayingIndex : null;
  const normalizedNowPlayingIndex =
    Number.isInteger(normalizedNowPlayingIndexRaw) &&
      normalizedNowPlayingIndexRaw >= 0 &&
      normalizedNowPlayingIndexRaw < normalizedTracks.length
      ? normalizedNowPlayingIndexRaw
      : null;
  const next = {
    guildId: String(session.guildId || "").trim(),
    voiceChannelId: String(session.voiceChannelId || "").trim(),
    tracks: normalizedTracks,
    nowPlayingIndex: normalizedNowPlayingIndex,
    isPaused: Boolean(current.isPaused),
    volume: Number.isFinite(Number(current.volume))
      ? clamp(Number(current.volume), 0, 1)
      : 1
  };
  session.musicQueueState = next;
  return next;
}

// All three music heuristics (stop, pause, skip) require verb + music cue word.
// Bot-name commands ("Clanker, stop") go through the directAddressedToBot → LLM path instead.
export function isLikelyMusicStopPhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_STOP_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

function isLikelyMusicPausePhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_PAUSE_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

function isLikelyMusicSkipPhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  return EN_MUSIC_SKIP_VERB_RE.test(normalizedTranscript) && EN_MUSIC_CUE_RE.test(normalizedTranscript);
}

// Only checked when music is paused. Keep this conservative: explicit resume
// verbs are fine, and "play" only counts for current-track phrasings like
// "play it again" or "play this song".
function isLikelyMusicResumePhrase(
  _manager: MusicPlaybackHost,
  { transcript = "" }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  const normalizedResumeTranscript = normalizedTranscript
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedResumeTranscript) return false;
  if (EN_MUSIC_RESUME_PLAY_CURRENT_RE.test(normalizedResumeTranscript)) return true;
  if (!EN_MUSIC_RESUME_VERB_RE.test(normalizedResumeTranscript)) return false;
  return EN_MUSIC_CUE_RE.test(normalizedResumeTranscript) || EN_MUSIC_RESUME_PRONOUN_RE.test(normalizedResumeTranscript);
}

export function isLikelyMusicPlayPhrase(
  manager: MusicPlaybackHost,
  { transcript = "", settings = null }: {
    transcript?: string;
    settings?: MusicPlaybackSettings;
  } = {}
) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;
  if (!EN_MUSIC_PLAY_VERB_RE.test(normalizedTranscript)) return false;
  if (EN_MUSIC_CUE_RE.test(normalizedTranscript)) return true;
  return manager.hasBotNameCueForTranscript({ transcript: normalizedTranscript, settings });
}

export function extractMusicPlayQuery(
  manager: MusicPlaybackHost,
  transcript = ""
) {
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
    .replace(EN_MUSIC_QUERY_TRAILING_NOISE_RE, " ")
    .replace(EN_MUSIC_QUERY_MEDIA_WORD_RE, " ")
    .replace(/[^\w\s'"&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  if (EN_MUSIC_QUERY_EMPTY_RE.test(cleaned)) return "";
  return cleaned.slice(0, 120);
}

function normalizeMusicTurnAcceptedAt(value: unknown) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.max(0, Math.floor(numericValue))
    : null;
}

function findNewerPrePlaybackTurnForMusicStart(
  session: VoiceSession | null | undefined,
  originAcceptedAt: unknown
) {
  if (!session || session.ending) return null;
  const normalizedOriginAcceptedAt = normalizeMusicTurnAcceptedAt(originAcceptedAt);
  if (!normalizedOriginAcceptedAt) return null;
  const inFlightTurn = session.inFlightAcceptedBrainTurn;
  if (!inFlightTurn) return null;
  const inFlightAcceptedAt = normalizeMusicTurnAcceptedAt(inFlightTurn.acceptedAt);
  if (!inFlightAcceptedAt || inFlightAcceptedAt <= normalizedOriginAcceptedAt) return null;
  const normalizedPhase = String(inFlightTurn.phase || "").trim().toLowerCase();
  if (normalizedPhase !== "generation_only" && normalizedPhase !== "tool_call_started") {
    return null;
  }
  return {
    originAcceptedAt: normalizedOriginAcceptedAt,
    inFlightAcceptedAt,
    inFlightPhase: normalizedPhase
  };
}

export function haltSessionOutputForMusicPlayback(
  manager: MusicPlaybackHost,
  session: VoiceSession | null | undefined,
  reason = "music_playback_started",
  {
    originAcceptedAt = null
  }: {
    originAcceptedAt?: number | null;
  } = {}
) {
  if (!session || session.ending) return;
  const preservedTurn = findNewerPrePlaybackTurnForMusicStart(session, originAcceptedAt);
  if (preservedTurn) {
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "voice_music_output_halt_preserved_newer_turn",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "music_playback_started"),
        originAcceptedAt: preservedTurn.originAcceptedAt,
        inFlightAcceptedAt: preservedTurn.inFlightAcceptedAt,
        inFlightPhase: preservedTurn.inFlightPhase
      }
    });
    return;
  }
  manager.replyManager.clearPendingResponse(session);
  // Clear main-process reply state WITHOUT sending stop_playback IPC —
  // the subprocess's handleMusicPlay already resets playback before
  // starting music. Sending stop_playback here would kill the music
  // process that just started.
  manager.maybeClearActiveReplyInterruptionPolicy(session);
  manager.bargeInController.clearBargeInOutputSuppression(session, "music_playback_started");
  if (session.botTurnResetTimer) {
    clearTimeout(session.botTurnResetTimer);
    session.botTurnResetTimer = null;
  }
  session.botTurnOpen = false;
  session.lastRequestedRealtimeUtterance = null;
  session.activeReplyInterruptionPolicy = null;
  manager.deferredActionQueue.clearAllDeferredVoiceActions(session);

  manager.abortActiveInboundCaptures({
    session,
    reason: "music_playback_active"
  });

  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "voice_music_output_halted",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "music_playback_started")
    }
  });
}

export async function requestPlayMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  query = "",
  trackId = null,
  platform = "auto",
  action = "play_now",
  searchResults = null,
  reason = "nl_play_music",
  source = "text_voice_intent",
  originAcceptedAt = null,
  mustNotify = true
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const requestText = normalizeInlineText(message?.content || "", 220) || null;
  const resolvedOriginAcceptedAt =
    normalizeMusicTurnAcceptedAt(originAcceptedAt) ||
    (
      String(source || "").trim().toLowerCase() === "voice_tool_call"
        ? normalizeMusicTurnAcceptedAt(session?.inFlightAcceptedBrainTurn?.acceptedAt)
        : null
    );

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const playbackProviderConfigured = Boolean(manager.musicPlayback?.isConfigured?.());
  const resolvedPlatform = normalizeMusicPlatformToken(manager, platform, "auto");
  const resolvedQuery = normalizeInlineText(query || extractMusicPlayQuery(manager, message?.content || ""), 120) || "";
  const resolvedTrackId = normalizeInlineText(trackId, 180) || null;
  const normalizedProvidedResults = (Array.isArray(searchResults) ? searchResults : [])
    .map((entry) => normalizeMusicSelectionResult(manager, entry))
    .filter(Boolean)
    .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
  const disambiguationFromPrompt = getMusicDisambiguationPromptContext(manager, session);
  const requestStartedAt = Date.now();

  const requestDisambiguation = async (candidateResults = []) => {
    const options = candidateResults
      .map((entry) => normalizeMusicSelectionResult(manager, entry))
      .filter(Boolean)
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
    if (!options.length) return false;

    setMusicDisambiguationState(manager, {
      session,
      query: resolvedQuery,
      platform: resolvedPlatform,
      action: action === "queue_next" || action === "queue_add" ? action : "play_now",
      results: options,
      requestedByUserId: resolvedUserId
    });
    if (resolvedUserId) {
      manager.beginVoiceCommandSession({
        session,
        userId: resolvedUserId,
        domain: "music",
        intent:
          action === "queue_next" || action === "queue_add"
            ? `${action}_disambiguation`
            : "music_disambiguation"
      });
    }

    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId || manager.client.user?.id || null,
      content: "voice_music_disambiguation_required",
      metadata: {
        sessionId: session.id,
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        platform: resolvedPlatform || "auto",
        optionCount: options.length,
        options
      }
    });

    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "disambiguation_required",
      details: {
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        platform: resolvedPlatform || "auto",
        optionCount: options.length,
        options
      },
      mustNotify
    });
    return true;
  };

  let selectedResult = resolvedTrackId ? findPendingMusicSelectionById(manager, session, resolvedTrackId) : null;
  if (!selectedResult && resolvedTrackId) {
    selectedResult =
      normalizedProvidedResults.find((entry) => String(entry.id || "") === resolvedTrackId) ||
      (Array.isArray(disambiguationFromPrompt?.options)
        ? disambiguationFromPrompt.options.find((entry) => String(entry?.id || "") === resolvedTrackId)
        : null) ||
      null;
  }

  if (!resolvedTrackId && normalizedProvidedResults.length > 1) {
    const handled = await requestDisambiguation(normalizedProvidedResults);
    if (handled) return true;
  }
  if (!resolvedTrackId && !selectedResult && normalizedProvidedResults.length === 1) {
    selectedResult = normalizedProvidedResults[0];
  }

  if (!resolvedTrackId && !selectedResult && resolvedQuery && manager.musicSearch?.isConfigured?.()) {
    const resolvedSearchPlatform =
      resolvedPlatform === "youtube" || resolvedPlatform === "soundcloud"
        ? resolvedPlatform
        : "auto";
    const searchStartedAt = Date.now();
    const searchResponse = await manager.musicSearch.search(resolvedQuery, {
      platform: resolvedSearchPlatform,
      limit: MUSIC_DISAMBIGUATION_MAX_RESULTS
    });
    const normalizedSearchResults = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .map((entry) =>
        normalizeMusicSelectionResult(manager, {
          id: entry.id,
          title: entry.title,
          artist: entry.artist,
          platform: entry.platform,
          externalUrl: entry.externalUrl,
          durationSeconds: entry.durationSeconds
        })
      )
      .filter(Boolean)
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);
    console.info(
      `[voiceMusic] search complete guildId=${resolvedGuildId} sessionId=${session.id} query=${JSON.stringify(resolvedQuery)} platform=${resolvedPlatform || "auto"} resultCount=${normalizedSearchResults.length} durationMs=${Date.now() - searchStartedAt}`
    );

    if (normalizedSearchResults.length > 1) {
      const handled = await requestDisambiguation(normalizedSearchResults);
      if (handled) return true;
    } else if (normalizedSearchResults.length === 1) {
      selectedResult = normalizedSearchResults[0];
    }
  }

  if (!selectedResult && !playbackProviderConfigured) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "music_provider_unconfigured",
      details: {
        provider: manager.musicPlayback?.provider || "none",
        source: String(source || "text_voice_intent"),
        query: resolvedQuery || null,
        requestText
      },
      mustNotify
    });
    return true;
  }

  let playbackQuery = resolvedQuery;
  let playbackTrackId = resolvedTrackId;
  if (selectedResult) {
    const selectedId = String(selectedResult.id || "").trim();
    if (!selectedId) {
      playbackQuery = normalizeInlineText(`${selectedResult.title} ${selectedResult.artist}`, 120) || playbackQuery;
    } else {
      playbackTrackId = selectedId || playbackTrackId;
      if (!playbackQuery) {
        playbackQuery = normalizeInlineText(`${selectedResult.title} ${selectedResult.artist}`, 120);
      }
    }
  }

  const selectedResultPlatform = normalizeMusicPlatformToken(manager, selectedResult?.platform, null);
  const useDiscordStreaming = Boolean(
    selectedResult && (
      selectedResultPlatform === "youtube" ||
      selectedResultPlatform === "soundcloud" ||
      selectedResultPlatform === "discord"
    )
  );
  const willAttemptPlayback = Boolean(selectedResult || playbackProviderConfigured);
  if (music && willAttemptPlayback) {
    setMusicPhase(manager, session, "loading");
  }

  let playbackResult: { ok: boolean; provider: string; reason: string; message: string; status: number; track: { id: string; title: string; artistNames: string[]; externalUrl: string | null } | null; query: string | null } | null = null;
  let playbackUrlForState: string | null = null;
  let playbackResolvedDirectUrlForState = false;

  if (useDiscordStreaming) {
    const discordResult = await playMusicViaDiscord(manager, session, selectedResult);
    if (!discordResult.ok) {
      if (music) {
        setMusicPhase(manager, session, "idle");
      }
      logMusicAction(manager, {
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId || manager.client.user?.id || null,
        content: "voice_music_start_failed",
        metadata: {
          sessionId: session.id,
          provider: "discord",
          reason: discordResult.error || "discord_playback_failed",
          source: String(source || "text_voice_intent"),
          query: playbackQuery || null,
          requestedTrackId: selectedResult?.id || null,
          selectedResultId: selectedResult?.id || null,
          selectedResultPlatform: selectedResult?.platform || null,
          error: discordResult.error || null
        }
      });
      await sendOperationalMessage(manager, {
        channel: resolvedChannel,
        settings: resolvedSettings,
        guildId: resolvedGuildId,
        channelId: resolvedChannelId || session.textChannelId || null,
        userId: resolvedUserId || null,
        messageId: message?.id || null,
        event: "voice_music_request",
        reason: discordResult.error || "discord_playback_failed",
        details: {
          source: String(source || "text_voice_intent"),
          query: playbackQuery || null,
          selectedResultId: selectedResult?.id || null,
          selectedResultPlatform: selectedResult?.platform || null,
          provider: "discord",
          error: discordResult.error || null
        },
        mustNotify
      });
      return true;
    }
    playbackResult = {
      ok: true,
      provider: "discord",
      reason: "started",
      message: "playing",
      status: 200,
      track: {
        id: selectedResult.id,
        title: selectedResult.title,
        artistNames: selectedResult.artist ? [selectedResult.artist] : [],
        externalUrl: selectedResult.externalUrl
      },
      query: playbackQuery
    };
    if (music) {
      playbackUrlForState = discordResult.playbackUrl || selectedResult.externalUrl || null;
      playbackResolvedDirectUrlForState = Boolean(discordResult.resolvedDirectUrl);
    }
  } else {
    const playbackProvider = manager.musicPlayback;
    if (!playbackProvider?.startPlayback) {
      playbackResult = {
        ok: false,
        provider: manager.musicPlayback?.provider || "none",
        reason: "music_provider_unconfigured",
        message: "music playback provider not configured",
        status: 0,
        track: null,
        query: playbackQuery || null
      };
    } else {
      playbackResult = await playbackProvider.startPlayback({
        query: playbackQuery,
        trackId: playbackTrackId
      });
    }
  }
  if (!playbackResult.ok) {
    if (music) {
      setMusicPhase(manager, session, "idle");
    }
    logMusicAction(manager, {
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId || manager.client.user?.id || null,
      content: "voice_music_start_failed",
      metadata: {
        sessionId: session.id,
        provider: playbackResult.provider,
        reason: playbackResult.reason,
        source: String(source || "text_voice_intent"),
        query: playbackResult.query || playbackQuery || null,
        requestedTrackId: playbackTrackId,
        selectedResultId: selectedResult?.id || null,
        selectedResultPlatform: selectedResult?.platform || null,
        status: Number(playbackResult.status || 0),
        message: playbackResult.message || null
      }
    });
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: playbackResult.reason || "music_playback_failed",
      details: {
        source: String(source || "text_voice_intent"),
        query: playbackResult.query || playbackQuery || null,
        requestedTrackId: playbackTrackId,
        selectedResultId: selectedResult?.id || null,
        selectedResultPlatform: selectedResult?.platform || null,
        provider: playbackResult.provider,
        status: Number(playbackResult.status || 0),
        error: playbackResult.message || null
      },
      mustNotify
    });
    return true;
  }

  if (music) {
    setMusicPhase(manager, session, "playing");
    clearPendingMusicReplyHandoff(manager, session);
    music.startedAt = Date.now();
    music.stoppedAt = 0;
    music.provider = playbackResult.provider || null;
    music.source = String(source || "text_voice_intent");
    music.lastTrackId = playbackResult.track?.id || null;
    music.lastTrackTitle = playbackResult.track?.title || null;
    music.lastTrackArtists = Array.isArray(playbackResult.track?.artistNames)
      ? playbackResult.track.artistNames
      : [];
    music.lastTrackUrl = playbackResult.track?.externalUrl || null;
    music.lastPlaybackUrl = playbackUrlForState || playbackResult.track?.externalUrl || null;
    music.lastPlaybackResolvedDirectUrl = playbackResolvedDirectUrlForState;
    music.lastQuery = playbackResult.query || playbackQuery || null;
    music.lastRequestedByUserId = resolvedUserId || null;
    music.lastRequestText = requestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_play_music");
    clearMusicDisambiguationState(manager, session);
    manager.clearVoiceCommandSession(session);
  }

  haltSessionOutputForMusicPlayback(manager, session, "music_playback_started", {
    originAcceptedAt: resolvedOriginAcceptedAt
  });
  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: "voice_music_started",
    metadata: {
      sessionId: session.id,
      provider: playbackResult.provider,
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_play_music"),
      query: playbackResult.query || playbackQuery || null,
      requestedTrackId: playbackTrackId,
      selectedResultId: selectedResult?.id || null,
      selectedResultPlatform: selectedResult?.platform || null,
      trackId: playbackResult.track?.id || null,
      trackTitle: playbackResult.track?.title || null,
      trackArtists: playbackResult.track?.artistNames || [],
      trackUrl: playbackResult.track?.externalUrl || null
    }
  });
  // When the command came from a voice tool call, the voice reply path
  // handles confirmation — skip the redundant text-channel message.
  if (String(source || "") !== "voice_tool_call") {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "started",
      details: {
        source: String(source || "text_voice_intent"),
        provider: playbackResult.provider,
        query: playbackResult.query || playbackQuery || null,
        requestedTrackId: playbackTrackId,
        selectedResultId: selectedResult?.id || null,
        selectedResultPlatform: selectedResult?.platform || null,
        trackTitle: playbackResult.track?.title || null,
        trackArtists: playbackResult.track?.artistNames || [],
        trackUrl: playbackResult.track?.externalUrl || null
      },
      mustNotify
    });
  }
  console.info(
    `[voiceMusic] request complete guildId=${resolvedGuildId} sessionId=${session.id} provider=${playbackResult.provider} totalMs=${Date.now() - requestStartedAt} query=${JSON.stringify(playbackResult.query || playbackQuery || "")}`
  );
  return true;
}

export async function playMusicViaDiscord(
  manager: MusicPlaybackHost,
  session: VoiceSession,
  track: { id: string; title: string; artist: string; platform: string; externalUrl: string | null }
) {
  if (!session?.guildId) {
    return {
      ok: false,
      error: "no session",
      playbackUrl: null,
      resolvedDirectUrl: false
    };
  }

  const guild = manager.client.guilds.cache.get(session.guildId);
  if (!guild) {
    return {
      ok: false,
      error: "guild not found",
      playbackUrl: null,
      resolvedDirectUrl: false
    };
  }

  if (!session.voxClient?.isAlive) {
    return {
      ok: false,
      error: "not connected to voice",
      playbackUrl: null,
      resolvedDirectUrl: false
    };
  }
  const musicPlayer = manager.musicPlayer;
  if (!musicPlayer?.play) {
    return {
      ok: false,
      error: "music player unavailable",
      playbackUrl: null,
      resolvedDirectUrl: false
    };
  }
  const streamWatchSettings = getVoiceStreamWatchSettings(
    session.settingsSnapshot || manager.store.getSettings()
  );

  const searchPlatform: "youtube" | "soundcloud" =
    track.platform === "soundcloud" ? "soundcloud" : "youtube";
  const searchResult = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    platform: searchPlatform,
    streamUrl: null,
    durationSeconds: null,
    thumbnailUrl: null,
    externalUrl: track.externalUrl || ""
  };

  const result = await musicPlayer.play(searchResult, {
    visualizerMode: normalizeStreamWatchVisualizerMode(streamWatchSettings.visualizerMode)
  });
  return {
    ok: result.ok,
    error: result.error,
    playbackUrl: result.playbackUrl,
    resolvedDirectUrl: result.resolvedDirectUrl
  };
}

export async function requestStopMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  reason = "nl_stop_music",
  source = "text_voice_intent",
  requestText = "",
  clearQueue = false,
  mustNotify = true
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const normalizedRequestText = normalizeInlineText(requestText || message?.content || "", 220) || null;

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText: normalizedRequestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const prevPhase = getMusicPhase(manager, session);
  const wasActive = musicPhaseIsActive(prevPhase);
  const playerWasActive = wasActive;

  if (manager.musicPlayer) {
    manager.musicPlayer.stop();
  }

  const playbackResult = manager.musicPlayback?.isConfigured?.()
    ? await manager.musicPlayback.stopPlayback()
    : {
      ok: false,
      provider: manager.musicPlayback?.provider || "none",
      reason: "music_provider_unconfigured",
      message: "music provider not configured",
      status: 0,
      track: null,
      query: null
    };
  const usingDiscordPlayer =
    String(music?.provider || "")
      .trim()
      .toLowerCase() === "discord" || playerWasActive;
  const stopSucceeded = Boolean(playbackResult.ok) || !wasActive || usingDiscordPlayer;
  const resolvedProvider = usingDiscordPlayer
    ? "discord"
    : playbackResult.provider || manager.musicPlayback?.provider || "none";
  const stopResultReason =
    stopSucceeded && !playbackResult.ok
      ? usingDiscordPlayer
        ? "discord_player_stopped"
        : "already_stopped"
      : playbackResult.reason || null;
  if (music) {
    setMusicPhase(manager, session, "idle");
    clearPendingMusicReplyHandoff(manager, session);
    music.stoppedAt = Date.now();
    if (!music.provider) {
      music.provider = resolvedProvider || null;
    }
    music.source = String(source || "text_voice_intent");
    music.lastRequestedByUserId = resolvedUserId || music.lastRequestedByUserId || null;
    music.lastRequestText = normalizedRequestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_stop_music");
    clearMusicDisambiguationState(manager, session);
  }
  if (clearQueue) {
    clearToolMusicQueueState(manager, session);
  }

  // No-op: subprocess manages its own audio pipeline after music stop.

  logMusicAction(manager, {
    kind: stopSucceeded ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: stopSucceeded ? "voice_music_stopped" : "voice_music_stop_failed",
    metadata: {
      sessionId: session.id,
      provider: resolvedProvider,
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_stop_music"),
      clearedQueue: Boolean(clearQueue),
      stopResultReason,
      status: Number(playbackResult.status || 0),
      error: stopSucceeded ? null : playbackResult.message || null,
      previouslyActive: wasActive,
      requestText: normalizedRequestText
    }
  });

  // When the command came from a voice tool call, the voice reply path
  // handles confirmation — skip the redundant text-channel message.
  const suppressOperationalMessage =
    String(source || "") === "voice_tool_call";

  if (!suppressOperationalMessage) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: stopSucceeded ? (wasActive ? "stopped" : "already_stopped") : playbackResult.reason || "music_stop_failed",
      details: {
        source: String(source || "text_voice_intent"),
        clearedQueue: Boolean(clearQueue),
        provider: resolvedProvider,
        stopResultReason,
        status: Number(playbackResult.status || 0),
        error: stopSucceeded ? null : playbackResult.message || null,
        previouslyActive: wasActive,
        requestText: normalizedRequestText
      },
      mustNotify
    });
  }
  return true;
}

export async function requestPauseMusic(manager: MusicPlaybackHost, {
  message = null,
  guildId = null,
  channel = null,
  channelId = null,
  requestedByUserId = null,
  settings = null,
  reason = "nl_pause_music",
  source = "text_voice_intent",
  requestText = "",
  mustNotify = true
}: {
  message?: MusicTextCommandMessage | null;
  guildId?: string | null;
  channel?: unknown;
  channelId?: string | null;
  requestedByUserId?: string | null;
  settings?: Record<string, unknown> | null;
  reason?: string;
  source?: string;
  requestText?: string;
  mustNotify?: boolean;
} = {}) {
  const resolvedGuildId = String(guildId || message?.guild?.id || message?.guildId || "").trim();
  if (!resolvedGuildId) return false;
  const session = manager.sessions.get(resolvedGuildId);
  const resolvedChannel = channel || message?.channel || null;
  const resolvedChannelIdFromChannel =
    resolvedChannel && typeof resolvedChannel === "object" && "id" in resolvedChannel
      ? String((resolvedChannel as { id?: string | null }).id || "").trim()
      : "";
  const resolvedChannelId = String(
    channelId || message?.channelId || resolvedChannelIdFromChannel || session?.textChannelId || ""
  ).trim();
  const resolvedUserId = String(requestedByUserId || message?.author?.id || "").trim() || null;
  const resolvedSettings = settings || session?.settingsSnapshot || manager.store.getSettings();
  const normalizedRequestText = normalizeInlineText(requestText || message?.content || "", 220) || null;

  if (!session) {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "not_in_voice",
      details: {
        source: String(source || "text_voice_intent"),
        requestText: normalizedRequestText
      },
      mustNotify
    });
    return true;
  }

  const music = ensureSessionMusicState(manager, session);
  const currentPhase = getMusicPhase(manager, session);
  if (musicPhaseCanPause(currentPhase)) {
    manager.musicPlayer?.pause?.();
  }
  const canPause = musicPhaseCanPause(currentPhase) || currentPhase === "paused" || currentPhase === "paused_wake_word";
  if (!canPause) {
    return await requestStopMusic(manager, {
      message,
      guildId: resolvedGuildId,
      channel: resolvedChannel,
      channelId: resolvedChannelId || session.textChannelId || null,
      requestedByUserId: resolvedUserId,
      settings: resolvedSettings,
      reason: String(reason || "nl_pause_music"),
      source: String(source || "text_voice_intent"),
      requestText: normalizedRequestText || "",
      mustNotify
    });
  }

  if (music) {
    if (!music.provider) {
      music.provider = "discord";
    }
    // Transition to paused — session unlocks so the bot can converse,
    // but musicPhaseCanResume() returns true so /resume works.
    setMusicPhase(manager, session, "paused", "user_pause");
    clearPendingMusicReplyHandoff(manager, session);
    music.source = String(source || "text_voice_intent");
    music.lastRequestedByUserId = resolvedUserId || music.lastRequestedByUserId || null;
    music.lastRequestText = normalizedRequestText;
    music.lastCommandAt = Date.now();
    music.lastCommandReason = String(reason || "nl_pause_music");
  }

  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: resolvedUserId || manager.client.user?.id || null,
    content: "voice_music_paused",
    metadata: {
      sessionId: session.id,
      provider: music?.provider || "discord",
      source: String(source || "text_voice_intent"),
      reason: String(reason || "nl_pause_music"),
      requestText: normalizedRequestText
    }
  });

  // When the command came from a voice tool call, the voice reply path
  // handles confirmation — skip the redundant text-channel message.
  if (String(source || "") !== "voice_tool_call") {
    await sendOperationalMessage(manager, {
      channel: resolvedChannel,
      settings: resolvedSettings,
      guildId: resolvedGuildId,
      channelId: resolvedChannelId || session.textChannelId || null,
      userId: resolvedUserId || null,
      messageId: message?.id || null,
      event: "voice_music_request",
      reason: "paused",
      details: {
        provider: music?.provider || "discord",
        source: String(source || "text_voice_intent"),
        requestText: normalizedRequestText
      },
      mustNotify
    });
  }
  return true;
}

export async function maybeHandleMusicTextSelectionRequest(manager: MusicPlaybackHost, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session) return false;

  const disambiguation = getMusicDisambiguationPromptContext(manager, session);
  if (!disambiguation?.active || !Array.isArray(disambiguation.options) || !disambiguation.options.length) {
    return false;
  }

  const text = normalizeInlineText(message?.content || "", STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  return await manager.maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings: resolvedSettings,
    userId: message.author?.id || null,
    transcript: text,
    reason: "text_music_disambiguation_selection",
    source: "text_disambiguation_failsafe",
    channel: message.channel || null,
    channelId: message.channelId || session.textChannelId || null,
    messageId: message.id || null,
    mustNotify: true
  });
}

export async function maybeHandleMusicTextStopRequest(manager: MusicPlaybackHost, {
  message = null,
  settings = null
}: MusicTextRequestPayload = {}) {
  if (!message?.guild) return false;
  const guildId = String(message.guild.id || message.guildId || "").trim();
  if (!guildId) return false;
  const session = manager.sessions.get(guildId);
  if (!session || !isMusicPlaybackActive(manager, session)) return false;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const text = normalizeInlineText(message?.content || "", STT_TRANSCRIPT_MAX_CHARS);
  if (!text) return false;

  const hasMusicStopCue = isLikelyMusicStopPhrase(manager, {
    transcript: text,
    settings: resolvedSettings
  });
  if (!hasMusicStopCue) return false;

  await manager.requestStopMusic({
    message,
    settings: resolvedSettings,
    reason: "text_music_stop_failsafe",
    source: "text_failsafe",
    requestText: text,
    clearQueue: true,
    mustNotify: true
  });
  return true;
}


export async function maybeHandleMusicPlaybackTurn(manager: MusicPlaybackHost, {
  session,
  settings,
  userId,
  pcmBuffer,
  captureReason = "stream_end",
  source = "voice_turn",
  musicWakeFollowupEligibleAtCapture = false,
  transcript: preTranscript = undefined as string | undefined
}) {
  if (!session || session.ending) return false;
  if (!isMusicPlaybackActive(manager, session)) return false;
  if (!pcmBuffer?.length && !preTranscript) return true;

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();

  // When a bridge transcript is provided, skip the Whisper REST call entirely.
  let normalizedTranscript: string;
  if (preTranscript !== undefined) {
    normalizedTranscript = normalizeInlineText(preTranscript, STT_TRANSCRIPT_MAX_CHARS);
  } else {
    // Fallback: transcribe raw PCM via the file-WAV audio API path when no bridge transcript exists.
    if (!manager.llm?.transcribeAudio) {
      logMusicAction(manager, {
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_music_turn_ignored_no_asr",
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_turn"),
          captureReason: String(captureReason || "stream_end")
        }
      });
      return true;
    }

    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const sampleRateHz = source === "file_asr" ? 24000 : Number(session.realtimeInputSampleRateHz) || 24000;
    const voiceRuntime = getVoiceRuntimeConfig(settings);
    const preferredModel = voiceRuntime.openaiRealtime?.inputTranscriptionModel;
    const transcriptionPlan = resolveTurnTranscriptionPlan({
      mode: session.mode,
      configuredModel: preferredModel,
      pcmByteLength: pcmBuffer.length,
      sampleRateHz
    });
    const transcriptionResult = await transcribePcmTurnWithPlan({
      transcribe: manager.transcribePcmTurn,
      session,
      userId,
      pcmBuffer,
      plan: transcriptionPlan,
      sampleRateHz,
      captureReason,
      traceSource: `voice_music_stop_${String(source || "voice_turn")}`,
      errorPrefix: "voice_music_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_music_transcription_empty",
      emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
      asrLanguage: asrLanguageGuidance.language,
      asrPrompt: asrLanguageGuidance.prompt
    });

    normalizedTranscript = normalizeInlineText(transcriptionResult.transcript, STT_TRANSCRIPT_MAX_CHARS);
  }
  if (!normalizedTranscript) {
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_turn_ignored_empty_transcript",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcriptSource: preTranscript !== undefined ? "bridge" : "whisper"
      }
    });
    return true;
  }
  const directAddressSignal = resolveVoiceDirectAddressSignal({
    transcript: normalizedTranscript,
    settings: resolvedSettings
  });
  const directAddressedToBot = directAddressSignal.directAddressed;
  const nameCueDetected = directAddressSignal.nameCueDetected;
  const normalizedUserId = String(userId || "").trim() || null;
  const wakeFollowupState = getMusicWakeFollowupState(session, normalizedUserId);
  const currentPhase = wakeFollowupState.currentPhase;
  const latchedUserId = wakeFollowupState.latchedUserId;
  const currentWakeLatched = wakeFollowupState.active;
  const pausedWakeWordOwnerFollowup = wakeFollowupState.pausedWakeWordOwnerFollowup;
  const passiveWakeFollowupAllowed =
    wakeFollowupState.passiveWakeFollowupAllowed ||
    Boolean(musicWakeFollowupEligibleAtCapture);
  const interruptedReplyOwnerFollowup = hasRecentInterruptedReplyFollowup(session, normalizedUserId);
  const pendingMusicDisambiguation =
    getMusicDisambiguationPromptContext(manager, session);
  const pendingMusicDisambiguationFollowup =
    Boolean(normalizedUserId) &&
    (
      manager.hasPendingMusicDisambiguationForUser?.(session, normalizedUserId) ??
      Boolean(
        pendingMusicDisambiguation?.active &&
        String(pendingMusicDisambiguation.requestedByUserId || "").trim() ===
        normalizedUserId
      )
    );
  const musicWakeLatched =
    currentWakeLatched ||
    Boolean(musicWakeFollowupEligibleAtCapture);
  const mainBrainEligible =
    directAddressedToBot ||
    nameCueDetected ||
    passiveWakeFollowupAllowed ||
    interruptedReplyOwnerFollowup ||
    pendingMusicDisambiguationFollowup;
  const disambiguationResolutionTurn = manager.isMusicDisambiguationResolutionTurn(
    session,
    userId,
    normalizedTranscript
  );
  const musicBrainEnabled = isVoiceMusicBrainEnabled(resolvedSettings);
  const compactControlCommand =
    musicBrainEnabled && !directAddressedToBot && !nameCueDetected
      ? resolveCompactVoiceMusicControlCommand(normalizedTranscript, currentPhase)
      : null;
  const controlCommandCandidate =
    !directAddressedToBot &&
    !nameCueDetected &&
    isLikelyVoiceMusicControlCommandTurn(manager, {
      transcript: normalizedTranscript,
      currentPhase
    });
  const shouldConsultMusicBrain =
    musicBrainEnabled &&
    !compactControlCommand &&
    controlCommandCandidate;
  const gateDecisionReason = directAddressedToBot
    ? "direct_address"
    : nameCueDetected
      ? "name_cue"
    : pendingMusicDisambiguationFollowup
      ? "pending_command_followup"
      : compactControlCommand
        ? `fast_path_${compactControlCommand}`
      : controlCommandCandidate
        ? "music_control_candidate"
      : pausedWakeWordOwnerFollowup
        ? "paused_wake_word_owner"
        : passiveWakeFollowupAllowed
          ? (currentWakeLatched ? "wake_latch_open" : "wake_latch_capture_open")
          : interruptedReplyOwnerFollowup
            ? "interrupted_reply_followup"
          : "swallowed";

  if (compactControlCommand) {
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_stop_check",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcript: normalizedTranscript,
        currentPhase,
        musicWakeLatched,
        musicWakeCurrentLatched: currentWakeLatched,
        musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
        musicWakeLatchedByUserId: latchedUserId,
        interruptedReplyOwnerFollowup,
        pausedWakeWordOwnerFollowup,
        directAddressedToBot,
        nameCueDetected,
        disambiguationResolutionTurn,
        compactControlCommand,
        musicBrainEnabled: true,
        decisionReason: gateDecisionReason
      }
    });
    return await executeCompactVoiceMusicControlCommand(manager, {
      session,
      settings: resolvedSettings,
      userId: normalizedUserId,
      transcript: normalizedTranscript,
      command: compactControlCommand,
      currentPhase,
      source: `voice_fast_path:${String(source || "voice_turn")}`
    });
  }

  if (mainBrainEligible && !controlCommandCandidate) {
    clearPendingMusicReplyHandoff(manager, session);
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_stop_check",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcript: normalizedTranscript,
        currentPhase,
        musicWakeLatched,
        musicWakeCurrentLatched: currentWakeLatched,
        musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
        musicWakeLatchedByUserId: latchedUserId,
        interruptedReplyOwnerFollowup,
        pausedWakeWordOwnerFollowup,
        directAddressedToBot,
        nameCueDetected,
        pendingMusicDisambiguationFollowup,
        disambiguationResolutionTurn,
        gateDecisionReason,
        musicBrainEnabled,
        decisionReason: "main_brain_decides"
      }
    });
    return false;
  }

  if (!musicBrainEnabled && controlCommandCandidate) {
    clearPendingMusicReplyHandoff(manager, session);
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_stop_check",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcript: normalizedTranscript,
        currentPhase,
        musicWakeLatched,
        musicWakeCurrentLatched: currentWakeLatched,
        musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
        musicWakeLatchedByUserId: latchedUserId,
        interruptedReplyOwnerFollowup,
        pausedWakeWordOwnerFollowup,
        directAddressedToBot,
        nameCueDetected,
        pendingMusicDisambiguationFollowup,
        disambiguationResolutionTurn,
        gateDecisionReason,
        musicBrainEnabled: false,
        decisionReason: "main_brain_decides"
      }
    });
    return false;
  }

  if (!shouldConsultMusicBrain) {
    clearPendingMusicReplyHandoff(manager, session);
    logMusicAction(manager, {
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_music_stop_check",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        captureReason: String(captureReason || "stream_end"),
        transcript: normalizedTranscript,
        currentPhase,
        musicWakeLatched,
        musicWakeCurrentLatched: currentWakeLatched,
        musicWakeFollowupEligibleAtCapture: Boolean(musicWakeFollowupEligibleAtCapture),
        musicWakeLatchedByUserId: latchedUserId,
        interruptedReplyOwnerFollowup,
        pausedWakeWordOwnerFollowup,
        directAddressedToBot,
        nameCueDetected,
        pendingMusicDisambiguationFollowup,
        disambiguationResolutionTurn,
        gateDecisionReason,
        decisionReason: gateDecisionReason
      }
    });
    return true;
  }

  const musicBrainDecision = await runVoiceMusicBrainDecision(manager, {
    session,
    settings: resolvedSettings,
    userId: normalizedUserId,
      transcript: normalizedTranscript,
      directAddressedToBot,
      musicWakeLatched,
      pausedWakeWordOwnerFollowup,
      passiveWakeFollowupAllowed,
      interruptedReplyOwnerFollowup,
    currentPhase,
    source: String(source || "voice_turn")
  });

  const resolvedBrainDecision = musicBrainDecision.decision;
  const decisionReason =
    resolvedBrainDecision === "consumed"
      ? "music_brain_consumed"
      : "music_brain_pass";
  logMusicAction(manager, {
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId,
    content: "voice_music_stop_check",
    metadata: {
      sessionId: session.id,
      source: String(source || "voice_turn"),
      captureReason: String(captureReason || "stream_end"),
      transcript: normalizedTranscript,
      currentPhase,
      musicWakeLatched,
      musicWakeLatchedByUserId: latchedUserId,
      interruptedReplyOwnerFollowup,
      pausedWakeWordOwnerFollowup,
      directAddressedToBot,
      nameCueDetected,
      pendingMusicDisambiguationFollowup,
      disambiguationResolutionTurn,
      gateDecisionReason,
      musicBrainDecision: resolvedBrainDecision,
      musicBrainRawText: musicBrainDecision.rawText || null,
      musicBrainToolCalls: Number(musicBrainDecision.toolCallCount || 0),
      musicBrainCostUsd: Number(musicBrainDecision.totalCostUsd || 0) || 0,
      decisionReason
    },
    usdCost: musicBrainDecision.totalCostUsd || undefined
  });

  if (resolvedBrainDecision === "consumed") {
    clearPendingMusicReplyHandoff(manager, session);
    return true;
  }

  clearPendingMusicReplyHandoff(manager, session);
  return false;
}

export async function handleMusicSlashCommand(
  manager: MusicPlaybackHost,
  interaction: ChatInputCommandInteraction,
  settings: Record<string, unknown> | null
) {
  const guild = interaction.guild;
  const user = interaction.user;

  if (!guild) {
    await interaction.reply(ephemeralReply("This command must be used in a server."));
    return;
  }

  type MusicSlashAction = "play_now" | "queue_add" | "queue_next";

  const formatTrackLabel = (track: { title?: string | null; artist?: string | null } | null | undefined) => {
    const title = String(track?.title || "").trim() || "Unknown track";
    const artist = String(track?.artist || "").trim();
    return artist ? `${title} - ${artist}` : title;
  };

  const formatDisambiguationReply = ({
    query,
    action,
    options
  }: {
    query: string;
    action: MusicSlashAction;
    options: MusicSelectionResult[];
  }) => {
    const actionLabel =
      action === "queue_next"
        ? "queue next"
        : action === "queue_add"
          ? "add to the queue"
          : "play";
    const optionsList = options
      .map((option, index) => `${index + 1}. ${formatTrackLabel(option)}`)
      .join("\n");
    return `Multiple results found for "${query}". Reply with the number to ${actionLabel}:\n${optionsList}`;
  };

  const formatQueueReply = (session: MusicRuntimeSessionLike) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    const musicState = ensureSessionMusicState(manager, session);
    if (!queueState || queueState.tracks.length === 0) {
      const lastTrack = musicState?.lastTrackTitle
        ? formatTrackLabel({
            title: musicState.lastTrackTitle,
            artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null
          })
        : null;
      return lastTrack ? `Queue is empty. Most recent track: ${lastTrack}` : "Queue is empty.";
    }

    const visibleTracks = queueState.tracks.slice(0, 10);
    const lines = visibleTracks.map((track, index) => {
      const prefix = index === queueState.nowPlayingIndex ? "[Now]" : `${index + 1}.`;
      return `${prefix} ${formatTrackLabel(track)}`;
    });
    const hiddenCount = Math.max(0, queueState.tracks.length - visibleTracks.length);
    const phase = getMusicPhase(manager, session);
    const stateLabel =
      phase === "paused" || phase === "paused_wake_word"
        ? "paused"
        : musicPhaseIsActive(phase)
          ? "playing"
          : "idle";
    const extraLine = hiddenCount > 0 ? `...and ${hiddenCount} more track${hiddenCount === 1 ? "" : "s"}.` : null;
    return [
      `Playback: ${stateLabel}`,
      `Queue (${queueState.tracks.length} track${queueState.tracks.length === 1 ? "" : "s"}):`,
      ...lines,
      extraLine
    ]
      .filter(Boolean)
      .join("\n");
  };

  const formatNowPlayingReply = (session: MusicRuntimeSessionLike) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    const nowTrack =
      queueState && queueState.nowPlayingIndex != null
        ? queueState.tracks[queueState.nowPlayingIndex] || null
        : null;
    const musicState = ensureSessionMusicState(manager, session);
    const phase = getMusicPhase(manager, session);
    const stateLabel =
      phase === "paused" || phase === "paused_wake_word"
        ? "Paused"
        : musicPhaseIsActive(phase)
          ? "Playing"
          : "Idle";
    if (nowTrack) {
      const queuedAfter = Math.max(0, queueState.tracks.length - (queueState.nowPlayingIndex ?? 0) - 1);
      return `${stateLabel}: ${formatTrackLabel(nowTrack)}${queuedAfter > 0 ? `\nUp next: ${queuedAfter} queued track${queuedAfter === 1 ? "" : "s"}.` : ""}`;
    }
    if (musicState?.lastTrackTitle) {
      return `${stateLabel}. Most recent track: ${formatTrackLabel({
        title: musicState.lastTrackTitle,
        artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null
      })}`;
    }
    return "Nothing is playing right now.";
  };

  const queueTrackForAction = async ({
    session,
    query,
    selectedTrack,
    action
  }: {
    session: VoiceSession;
    query: string;
    selectedTrack: MusicSelectionResult;
    action: MusicSlashAction;
  }) => {
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState) {
      return { ok: false, reply: "Music queue is unavailable for this voice session." };
    }

    const normalizedPlatform = normalizeMusicPlatformToken(manager, selectedTrack.platform, "youtube") || "youtube";
    const queuedTrack = {
      id: selectedTrack.id,
      title: selectedTrack.title,
      artist: selectedTrack.artist || null,
      durationMs: Number.isFinite(Number(selectedTrack.durationSeconds))
        ? Math.max(0, Math.round(Number(selectedTrack.durationSeconds) * 1000))
        : null,
      source: normalizedPlatform === "soundcloud" ? "sc" : "yt",
      streamUrl: selectedTrack.externalUrl || null,
      platform: normalizedPlatform,
      externalUrl: selectedTrack.externalUrl || null
    };
    const requestedByUserId = user.id;
    const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();

    if (action === "play_now") {
      const trailingTracks = queueState.nowPlayingIndex == null
        ? []
        : queueState.tracks.slice(Math.max(0, queueState.nowPlayingIndex + 1));
      queueState.tracks = [queuedTrack, ...trailingTracks];
      queueState.nowPlayingIndex = 0;
      queueState.isPaused = false;

      await requestPlayMusic(manager, {
        guildId,
        channel: interaction.channel,
        channelId: interaction.channelId,
        requestedByUserId,
        settings: resolvedSettings,
        query,
        trackId: selectedTrack.id,
        searchResults: [selectedTrack],
        reason: "slash_command_music_play",
        source: "slash_command",
        mustNotify: false
      });
      return {
        ok: true,
        reply: `Playing: ${formatTrackLabel(selectedTrack)}`
      };
    }

    const wasEmpty = queueState.tracks.length === 0;
    const insertAt =
      action === "queue_next"
        ? queueState.nowPlayingIndex == null
          ? queueState.tracks.length
          : clamp(queueState.nowPlayingIndex + 1, 0, queueState.tracks.length)
        : queueState.tracks.length;
    queueState.tracks.splice(insertAt, 0, queuedTrack);
    if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
      queueState.nowPlayingIndex = 0;
    }

    const shouldAutoPlay =
      action === "queue_next"
        ? !isMusicPlaybackActive(manager, session) && !queueState.isPaused
        : wasEmpty && !isMusicPlaybackActive(manager, session) && !queueState.isPaused;

    if (shouldAutoPlay) {
      const playIndex =
        action === "queue_next"
          ? queueState.nowPlayingIndex ?? 0
          : queueState.nowPlayingIndex ?? 0;
      await manager.playVoiceQueueTrackByIndex({
        session,
        settings: resolvedSettings,
        index: playIndex
      });
      return {
        ok: true,
        reply: `Queue was idle. Now playing: ${formatTrackLabel(selectedTrack)}`
      };
    }

    return {
      ok: true,
      reply:
        action === "queue_next"
          ? `Queued next: ${formatTrackLabel(selectedTrack)}`
          : `Added to queue: ${formatTrackLabel(selectedTrack)}`
    };
  };

  const runQueryAction = async ({
    session,
    query,
    action
  }: {
    session: VoiceSession;
    query: string;
    action: MusicSlashAction;
  }) => {
    const resolvedQuery = normalizeInlineText(query, 180);
    if (!resolvedQuery) {
      return { ok: false, reply: "A song name or URL is required." };
    }

    const canSearch = Boolean(manager.musicSearch?.isConfigured?.()) && typeof manager.musicSearch?.search === "function";
    if (!canSearch) {
      if (action !== "play_now") {
        return {
          ok: false,
          reply: "Music search is not configured, so queue add/next needs to stay disabled for now."
        };
      }

      await requestPlayMusic(manager, {
        guildId,
        channel: interaction.channel,
        channelId: interaction.channelId,
        requestedByUserId: user.id,
        settings,
        query: resolvedQuery,
        reason: "slash_command_music_play",
        source: "slash_command",
        mustNotify: false
      });

      const updatedSession = manager.sessions.get(guildId);
      const disambiguation = updatedSession
        ? getMusicDisambiguationPromptContext(manager, updatedSession)
        : null;
      if (disambiguation?.active && disambiguation.options?.length > 0) {
        return {
          ok: true,
          reply: formatDisambiguationReply({
            query: disambiguation.query || resolvedQuery,
            action,
            options: disambiguation.options
          })
        };
      }

      return {
        ok: true,
        reply: `Playing: ${resolvedQuery}`
      };
    }

    const searchResponse = await manager.musicSearch.search(resolvedQuery, {
      platform: "auto",
      limit: MUSIC_DISAMBIGUATION_MAX_RESULTS
    });
    const results = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
      .map((row) =>
        normalizeMusicSelectionResult(manager, {
          id: row.id,
          title: row.title,
          artist: row.artist,
          platform: row.platform,
          externalUrl: row.externalUrl,
          durationSeconds: row.durationSeconds
        })
      )
      .filter((result): result is MusicSelectionResult => Boolean(result))
      .slice(0, MUSIC_DISAMBIGUATION_MAX_RESULTS);

    if (!results.length) {
      return {
        ok: false,
        reply: `No results found for "${resolvedQuery}".`
      };
    }

    if (results.length > 1) {
      setMusicDisambiguationState(manager, {
        session,
        query: resolvedQuery,
        platform: "auto",
        action,
        results,
        requestedByUserId: user.id
      });
      manager.beginVoiceCommandSession({
        session,
        userId: user.id,
        domain: "music",
        intent: action === "play_now" ? "music_disambiguation" : `${action}_disambiguation`
      });
      return {
        ok: true,
        reply: formatDisambiguationReply({
          query: resolvedQuery,
          action,
          options: results
        })
      };
    }

    clearMusicDisambiguationState(manager, session);
    manager.clearVoiceCommandSession(session);
    return await queueTrackForAction({
      session,
      query: resolvedQuery,
      selectedTrack: results[0],
      action
    });
  };

  const guildId = guild.id;
  const subcommand = interaction.options.getSubcommand(true);
  const getActiveSession = () => {
    const existing = manager.sessions.get(guildId);
    return existing && !existing.ending ? existing : null;
  };
  const ensureSlashPlaybackSession = async () => {
    const existing = getActiveSession();
    if (existing) {
      return existing;
    }
    if (typeof manager.requestJoin !== "function" || !interaction.channel) {
      logMusicAction(manager, {
        kind: "voice_runtime",
        guildId,
        channelId: interaction.channelId,
        userId: user.id,
        content: "slash_music_session_bootstrap",
        metadata: {
          subcommand,
          outcome: typeof manager.requestJoin !== "function" ? "join_unavailable" : "channel_unavailable"
        }
      });
      return null;
    }

    const member = await resolveSlashMusicVoiceMember(interaction);
    const joinHandled = await manager.requestJoin({
      message: {
        guild,
        guildId,
        channel: interaction.channel,
        channelId: interaction.channelId,
        id: null,
        author: {
          id: user.id,
          username: user.username
        },
        member
      },
      settings,
      intentConfidence: 1
    });
    const joinedSession = getActiveSession();
    logMusicAction(manager, {
      kind: joinedSession ? "voice_runtime" : "voice_error",
      guildId,
      channelId: interaction.channelId,
      userId: user.id,
      content: "slash_music_session_bootstrap",
      metadata: {
        subcommand,
        joinHandled,
        joined: Boolean(joinedSession),
        requesterVoiceChannelId: String((member.voice?.channel as { id?: string | null } | null)?.id || "") || null
      }
    });
    return joinedSession;
  };
  let session = getActiveSession();

  if (subcommand === "play" || subcommand === "add" || subcommand === "next") {
    const query = interaction.options.getString("query", true);
    await interaction.deferReply();
    session = session || await ensureSlashPlaybackSession();
    if (!session) {
      await interaction.editReply(
        "I couldn't start a voice session for music playback. Join a voice channel first, or check the channel for the join failure."
      );
      return;
    }
    const result = await runQueryAction({
      session,
      query,
      action:
        subcommand === "add"
          ? "queue_add"
          : subcommand === "next"
            ? "queue_next"
            : "play_now"
    });
    await interaction.editReply(result.reply);
    return;
  }

  if (!session) {
    await interaction.reply(ephemeralReply("No active voice session in this server."));
    return;
  }

  if (subcommand === "queue") {
    await interaction.reply(formatQueueReply(session));
    return;
  }

  if (subcommand === "now") {
    await interaction.reply(formatNowPlayingReply(session));
    return;
  }

  if (subcommand === "stop") {
    if (!isMusicPlaybackActive(manager, session) && ensureToolMusicQueueState(manager, session)?.tracks.length === 0) {
      await interaction.reply(ephemeralReply("Nothing is playing and the queue is empty."));
      return;
    }
    await interaction.deferReply();
    await requestStopMusic(manager, {
      guildId,
      channel: interaction.channel,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_stop",
      source: "slash_command",
      clearQueue: true,
      mustNotify: false
    });
    await interaction.editReply("Music stopped and the queue was cleared.");
    return;
  }

  if (subcommand === "pause") {
    const phase = getMusicPhase(manager, session);
    if (!musicPhaseCanPause(phase)) {
      await interaction.reply(ephemeralReply("No music is currently playing."));
      return;
    }
    await interaction.deferReply();
    await requestPauseMusic(manager, {
      guildId,
      channel: interaction.channel,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_pause",
      source: "slash_command",
      mustNotify: false
    });
    await interaction.editReply("Music paused.");
    return;
  }

  if (subcommand === "resume") {
    const phase = getMusicPhase(manager, session);
    if (!musicPhaseCanResume(phase)) {
      await interaction.reply(ephemeralReply("No music is currently paused."));
      return;
    }
    if (!hasKnownMusicResumeState(session)) {
      setMusicPhase(manager, session, "idle");
      clearPendingMusicReplyHandoff(manager, session);
      setKnownMusicQueuePausedState(session, false);
      logMusicResumeUnavailable(manager, session, "music_resumed_slash_command", phase);
      await interaction.reply(ephemeralReply("No paused track can be resumed."));
      return;
    }
    noteMusicResumeRequest(session, "music_resumed_slash_command");
    manager.musicPlayer?.resume();
    await interaction.reply("Resuming music.");
    return;
  }

  if (subcommand === "skip") {
    const queueState = ensureToolMusicQueueState(manager, session);
    if (!queueState || queueState.nowPlayingIndex == null) {
      await interaction.reply(ephemeralReply("No queued track is available to skip."));
      return;
    }
    await interaction.deferReply();
    const nextIndex = queueState.nowPlayingIndex + 1;
    await requestStopMusic(manager, {
      guildId,
      channelId: interaction.channelId,
      requestedByUserId: user.id,
      settings,
      reason: "slash_command_skip",
      source: "slash_command",
      mustNotify: false
    });
    if (nextIndex < queueState.tracks.length) {
      await manager.playVoiceQueueTrackByIndex({ session, settings, index: nextIndex });
      const nextTrack = queueState.tracks[nextIndex];
      await interaction.editReply(`Skipped. Now playing: ${formatTrackLabel(nextTrack)}`);
    } else {
      queueState.nowPlayingIndex = null;
      queueState.isPaused = false;
      await interaction.editReply("Skipped. Queue finished.");
    }
  }
}
