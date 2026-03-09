import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ChatInputCommandInteraction } from "discord.js";

import {
  ensureSessionMusicState,
  getMusicDisambiguationPromptContext,
  handleMusicSlashCommand,
  isLikelyMusicResumePhrase,
  maybeHandleMusicPlaybackTurn,
  setMusicPhase
} from "./voiceMusicPlayback.ts";
import type { MusicPlaybackHost } from "./voiceMusicPlayback.ts";
import type { MusicSelectionResult, VoiceSession } from "./voiceSessionTypes.ts";

function createPlaybackHost() {
  const resumeCalls: string[] = [];
  const loggedEvents: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const manager: MusicPlaybackHost = {
    client: {
      user: { id: "bot-1" },
      channels: {
        fetch: async () => null
      },
      guilds: {
        cache: {
          get: () => null
        }
      }
    },
    sessions: new Map<string, VoiceSession>(),
    store: {
      getSettings: () => null,
      logAction: (entry) => {
        loggedEvents.push({
          content: entry.content,
          metadata: entry.metadata
        });
      }
    },
    llm: null,
    replyManager: {
      clearPendingResponse: () => {},
      hasBufferedTtsPlayback: () => false
    },
    bargeInController: {
      clearBargeInOutputSuppression: () => {}
    },
    deferredActionQueue: {
      clearAllDeferredVoiceActions: () => {}
    },
    musicPlayer: {
      duck: () => {},
      unduck: () => {},
      play: () => {},
      stop: () => {},
      pause: () => {},
      resume: () => {
        resumeCalls.push("resume");
      }
    },
    musicPlayback: null,
    musicSearch: null,
    composeOperationalMessage: async () => "",
    transcribePcmTurn: async () => "",
    hasBotNameCueForTranscript: () => false,
    isMusicDisambiguationResolutionTurn: () => false,
    maybeHandlePendingMusicDisambiguationTurn: async () => false,
    playVoiceQueueTrackByIndex: async () => {},
    requestStopMusic: async () => {},
    maybeClearActiveReplyInterruptionPolicy: () => {},
    abortActiveInboundCaptures: () => {}
  };

  return { manager, resumeCalls, loggedEvents };
}

function createPausedSession(manager: MusicPlaybackHost) {
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    botTurnResetTimer: null,
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:track-1",
          title: "That’s What I Like",
          artist: "Bruno Mars",
          source: "yt",
          platform: "youtube"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: true,
      volume: 1
    }
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "paused", "user_pause");
  return session;
}

test("isLikelyMusicResumePhrase matches paused current-track phrases without matching new-play requests", () => {
  const { manager } = createPlaybackHost();

  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Can you play the song again?" }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Okay, play this song." }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Resume the music" }), true);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Unpause it" }), true);

  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play Bruno Mars" }), false);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play the next song" }), false);
  assert.equal(isLikelyMusicResumePhrase(manager, { transcript: "Play another song" }), false);
});

test("maybeHandleMusicPlaybackTurn resumes paused music for current-track phrasing", async () => {
  const { manager, resumeCalls, loggedEvents } = createPlaybackHost();
  const session = createPausedSession(manager);

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "Can you play the song again?"
  });

  assert.equal(handled, true);
  assert.equal(resumeCalls.length, 1);
  assert.equal(session.music?.phase, "playing");
  assert.equal(session.musicQueueState?.isPaused, false);
  assert.equal(loggedEvents.some((entry) => entry.content === "voice_music_resumed"), true);
});

test("maybeHandleMusicPlaybackTurn does not auto-resume paused music for a new play request", async () => {
  const { manager, resumeCalls, loggedEvents } = createPlaybackHost();
  const session = createPausedSession(manager);

  await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "Play Bruno Mars"
  });

  assert.equal(resumeCalls.length, 0);
  assert.equal(session.music?.phase, "paused");
  assert.equal(session.musicQueueState?.isPaused, true);
  assert.equal(loggedEvents.some((entry) => entry.content === "voice_music_resumed"), false);
});

function createSlashInteraction(subcommand: string, query?: string) {
  const replies: string[] = [];
  const edits: string[] = [];
  let deferred = false;

  const interaction = {
    commandName: "music",
    guild: { id: "guild-1" },
    channel: { id: "text-1" },
    channelId: "text-1",
    user: { id: "user-1" },
    options: {
      getSubcommand() {
        return subcommand;
      },
      getString(name: string, required?: boolean) {
        if (name !== "query") return null;
        if (query) return query;
        if (required) throw new Error("missing query");
        return null;
      }
    },
    async reply(payload: string | { content?: string }) {
      replies.push(typeof payload === "string" ? payload : String(payload.content || ""));
      return null;
    },
    async deferReply() {
      deferred = true;
      return null;
    },
    async editReply(payload: string | { content?: string }) {
      edits.push(typeof payload === "string" ? payload : String(payload.content || ""));
      return null;
    }
  };

  return {
    interaction,
    replies,
    edits,
    get deferred() {
      return deferred;
    }
  };
}

function createSlashSession(overrides: Partial<VoiceSession> = {}) {
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    voiceChannelId: "voice-1",
    ending: false,
    settingsSnapshot: null,
    voxClient: {
      isAlive: true
    },
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [],
      nowPlayingIndex: null,
      isPaused: false,
      volume: 1
    },
    ...overrides
  } as VoiceSession;
  return session;
}

function createSlashPlaybackHost(searchResults: MusicSelectionResult[], sessionOverrides: Partial<VoiceSession> = {}) {
  const searchCalls: string[] = [];
  const discordPlayCalls: string[] = [];
  const queuePlayCalls: number[] = [];
  const logs: Array<{ content: string }> = [];

  const manager: MusicPlaybackHost = {
    client: {
      user: { id: "bot-1" },
      channels: {
        fetch: async () => null
      },
      guilds: {
        cache: {
          get: () => ({ id: "guild-1" })
        }
      }
    },
    sessions: new Map<string, VoiceSession>(),
    store: {
      getSettings: () => null,
      logAction: (entry) => {
        logs.push({ content: entry.content });
      }
    },
    llm: null,
    replyManager: {
      clearPendingResponse: () => {},
      hasBufferedTtsPlayback: () => false
    },
    bargeInController: {
      clearBargeInOutputSuppression: () => {}
    },
    deferredActionQueue: {
      clearAllDeferredVoiceActions: () => {}
    },
    musicPlayer: {
      duck: () => {},
      unduck: () => {},
      play: async (track) => {
        discordPlayCalls.push(String(track?.title || ""));
        return { ok: true, error: null, track: null };
      },
      stop: () => {},
      pause: () => {},
      resume: () => {}
    },
    musicPlayback: null,
    musicSearch: {
      isConfigured: () => true,
      search: async (query) => {
        searchCalls.push(query);
        return { results: searchResults };
      }
    },
    composeOperationalMessage: async () => "",
    transcribePcmTurn: async () => "",
    hasBotNameCueForTranscript: () => false,
    isMusicDisambiguationResolutionTurn: () => false,
    maybeHandlePendingMusicDisambiguationTurn: async () => false,
    playVoiceQueueTrackByIndex: async ({ session, index }) => {
      queuePlayCalls.push(index);
      if (session?.musicQueueState && typeof session.musicQueueState === "object") {
        const queueState = session.musicQueueState as {
          nowPlayingIndex: number | null;
          isPaused: boolean;
        };
        queueState.nowPlayingIndex = index;
        queueState.isPaused = false;
      }
      return { ok: true };
    },
    requestStopMusic: async () => {},
    maybeClearActiveReplyInterruptionPolicy: () => {},
    abortActiveInboundCaptures: () => {}
  };

  const session = createSlashSession(sessionOverrides);
  ensureSessionMusicState(manager, session);
  manager.sessions.set("guild-1", session);

  return {
    manager,
    session,
    searchCalls,
    discordPlayCalls,
    queuePlayCalls,
    logs
  };
}

test("music slash play updates queue state and starts playback through the queue-aware path", async () => {
  const track: MusicSelectionResult = {
    id: "youtube:track-1",
    title: "All Caps",
    artist: "MF DOOM",
    platform: "youtube",
    externalUrl: "https://youtube.com/watch?v=abc123",
    durationSeconds: 140
  };
  const { manager, session, discordPlayCalls, searchCalls } = createSlashPlaybackHost([track]);
  const slash = createSlashInteraction("play", "all caps");

  await handleMusicSlashCommand(manager, slash.interaction as ChatInputCommandInteraction, null);

  assert.equal(slash.deferred, true);
  assert.deepEqual(searchCalls, ["all caps"]);
  assert.equal(session.musicQueueState?.tracks.length, 1);
  assert.equal(session.musicQueueState?.tracks[0]?.title, "All Caps");
  assert.equal(session.musicQueueState?.nowPlayingIndex, 0);
  assert.equal(session.music?.phase, "playing");
  assert.equal(discordPlayCalls.length, 1);
  assert.equal(slash.edits[0], "Playing: All Caps - MF DOOM");
});

test("music slash add appends to the queue without interrupting current playback", async () => {
  const currentTrack: MusicSelectionResult = {
    id: "youtube:track-current",
    title: "Accordion",
    artist: "MF DOOM",
    platform: "youtube",
    externalUrl: "https://youtube.com/watch?v=current",
    durationSeconds: 120
  };
  const addedTrack: MusicSelectionResult = {
    id: "youtube:track-added",
    title: "Doomsday",
    artist: "MF DOOM",
    platform: "youtube",
    externalUrl: "https://youtube.com/watch?v=added",
    durationSeconds: 140
  };
  const { manager, session, queuePlayCalls } = createSlashPlaybackHost([addedTrack], {
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: currentTrack.id,
          title: currentTrack.title,
          artist: currentTrack.artist,
          durationMs: 120000,
          source: "yt",
          streamUrl: currentTrack.externalUrl,
          platform: "youtube",
          externalUrl: currentTrack.externalUrl
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    }
  });
  setMusicPhase(manager, session, "playing");
  const slash = createSlashInteraction("add", "doomsday");

  await handleMusicSlashCommand(manager, slash.interaction as ChatInputCommandInteraction, null);

  assert.equal(session.musicQueueState?.tracks.length, 2);
  assert.equal(session.musicQueueState?.tracks[1]?.title, "Doomsday");
  assert.equal(queuePlayCalls.length, 0);
  assert.equal(slash.edits[0], "Added to queue: Doomsday - MF DOOM");
});

test("music slash next inserts immediately after the current track", async () => {
  const nextTrack: MusicSelectionResult = {
    id: "youtube:track-next",
    title: "Rapp Snitch Knishes",
    artist: "MF DOOM",
    platform: "youtube",
    externalUrl: "https://youtube.com/watch?v=next",
    durationSeconds: 172
  };
  const { manager, session } = createSlashPlaybackHost([nextTrack], {
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:current",
          title: "Accordion",
          artist: "MF DOOM",
          durationMs: 120000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: null
        },
        {
          id: "youtube:later",
          title: "One Beer",
          artist: "MF DOOM",
          durationMs: 180000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: null
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    }
  });
  setMusicPhase(manager, session, "playing");
  const slash = createSlashInteraction("next", "rapp snitch knishes");

  await handleMusicSlashCommand(manager, slash.interaction as ChatInputCommandInteraction, null);

  assert.equal(session.musicQueueState?.tracks.length, 3);
  assert.equal(session.musicQueueState?.tracks[1]?.title, "Rapp Snitch Knishes");
  assert.equal(session.musicQueueState?.tracks[2]?.title, "One Beer");
  assert.equal(slash.edits[0], "Queued next: Rapp Snitch Knishes - MF DOOM");
});

test("music slash queue shows now-playing and queued tracks", async () => {
  const { manager, session } = createSlashPlaybackHost([], {
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:current",
          title: "Accordion",
          artist: "MF DOOM",
          durationMs: 120000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: null
        },
        {
          id: "youtube:queued",
          title: "Doomsday",
          artist: "MF DOOM",
          durationMs: 180000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: null
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    }
  });
  setMusicPhase(manager, session, "playing");
  const slash = createSlashInteraction("queue");

  await handleMusicSlashCommand(manager, slash.interaction as ChatInputCommandInteraction, null);

  assert.equal(slash.replies[0]?.includes("Queue (2 tracks):"), true);
  assert.equal(slash.replies[0]?.includes("[Now] Accordion - MF DOOM"), true);
  assert.equal(slash.replies[0]?.includes("2. Doomsday - MF DOOM"), true);
});

test("music slash add keeps queue disambiguation state when search is ambiguous", async () => {
  const results: MusicSelectionResult[] = [
    {
      id: "youtube:track-1",
      title: "All Caps",
      artist: "MF DOOM",
      platform: "youtube",
      externalUrl: "https://youtube.com/watch?v=1",
      durationSeconds: 140
    },
    {
      id: "youtube:track-2",
      title: "All Caps (Live)",
      artist: "Madvillain",
      platform: "youtube",
      externalUrl: "https://youtube.com/watch?v=2",
      durationSeconds: 200
    }
  ];
  const { manager, session } = createSlashPlaybackHost(results);
  const slash = createSlashInteraction("add", "all caps");

  await handleMusicSlashCommand(manager, slash.interaction as ChatInputCommandInteraction, null);

  const disambiguation = getMusicDisambiguationPromptContext(manager, session);
  assert.equal(disambiguation?.action, "queue_add");
  assert.equal(slash.edits[0]?.includes("Reply with the number to add to the queue"), true);
});
