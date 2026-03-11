import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ChatInputCommandInteraction } from "discord.js";

import {
  ensureSessionMusicState,
  getMusicDisambiguationPromptContext,
  handleMusicSlashCommand,
  maybeHandleMusicPlaybackTurn,
  setMusicPhase
} from "./voiceMusicPlayback.ts";
import type { MusicPlaybackHost } from "./voiceMusicPlayback.ts";
import type { MusicSelectionResult, VoiceSession } from "./voiceSessionTypes.ts";

function createDedicatedMusicBrainSettings() {
  return {
    agentStack: {
      runtimeConfig: {
        voice: {
          musicBrain: {
            mode: "dedicated_model",
            model: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest"
            }
          }
        }
      }
    }
  };
}

function createPlaybackHost({
  musicBrainResponses = [],
  voiceToolCallbacks = {}
}: {
  musicBrainResponses?: Array<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
    >;
    costUsd?: number;
  }>;
  voiceToolCallbacks?: Partial<ReturnType<MusicPlaybackHost["buildVoiceToolCallbacks"]>>;
} = {}) {
  const pauseCalls: string[] = [];
  const stopCalls: string[] = [];
  const resumeCalls: string[] = [];
  const toolCalls: Array<{ tool: string; args?: unknown }> = [];
  const loggedEvents: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const musicBrainPrompts: string[] = [];
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
    llm: {
      async chatWithTools(args) {
        musicBrainPrompts.push(String(args.systemPrompt || ""));
        const next = musicBrainResponses.shift();
        return {
          content: next?.content || [{ type: "text", text: "[PASS]" }],
          stopReason: "end_turn",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0
          },
          costUsd: Number(next?.costUsd || 0)
        };
      }
    },
    replyManager: {
      clearPendingResponse: () => {},
      hasBufferedTtsPlayback: () => false,
      schedulePausedReplyMusicResume: () => {}
    },
    bargeInController: {
      clearBargeInOutputSuppression: () => {}
    },
    deferredActionQueue: {
      clearAllDeferredVoiceActions: () => {}
    },
    beginVoiceCommandSession: () => null,
    clearVoiceCommandSession: () => {},
    musicPlayer: {
      duck: () => {},
      unduck: () => {},
      play: () => {},
      stop: () => {
        stopCalls.push("stop");
      },
      pause: () => {
        pauseCalls.push("pause");
      },
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
    abortActiveInboundCaptures: () => {},
    buildVoiceToolCallbacks: () => ({
      musicSearch: async (query: string, limit: number) => {
        toolCalls.push({ tool: "musicSearch", args: { query, limit } });
        return { ok: true };
      },
      musicPlay: async (query: string, selectionId?: string | null, platform?: string | null) => {
        toolCalls.push({ tool: "musicPlay", args: { query, selectionId, platform } });
        return { ok: true };
      },
      musicQueueAdd: async (trackIds: string[], position?: number | "end") => {
        toolCalls.push({ tool: "musicQueueAdd", args: { trackIds, position } });
        return { ok: true };
      },
      musicQueueNext: async (trackIds: string[]) => {
        toolCalls.push({ tool: "musicQueueNext", args: { trackIds } });
        return { ok: true };
      },
      musicStop: async () => {
        toolCalls.push({ tool: "musicStop" });
        return { ok: true };
      },
      musicPause: async () => {
        toolCalls.push({ tool: "musicPause" });
        return { ok: true };
      },
      musicResume: async () => {
        toolCalls.push({ tool: "musicResume" });
        return { ok: true };
      },
      musicReplyHandoff: async (mode: "pause" | "duck" | "none") => {
        toolCalls.push({ tool: "musicReplyHandoff", args: { mode } });
        return { ok: true, mode };
      },
      musicSkip: async () => {
        toolCalls.push({ tool: "musicSkip" });
        return { ok: true };
      },
      musicNowPlaying: async () => {
        toolCalls.push({ tool: "musicNowPlaying" });
        return { ok: true };
      },
      playSoundboard: async () => ({ ok: true }),
      setScreenNote: async () => ({ ok: true }),
      setScreenMoment: async () => ({ ok: true }),
      leaveVoiceChannel: async () => ({ ok: true }),
      ...voiceToolCallbacks
    })
  };

  return { manager, pauseCalls, stopCalls, resumeCalls, toolCalls, loggedEvents, musicBrainPrompts };
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

test("maybeHandleMusicPlaybackTurn lets the music brain consume a fuzzy playback command with tools", async () => {
  const { manager, toolCalls } = createPlaybackHost({
    musicBrainResponses: [
      {
        content: [
          {
            type: "tool_call",
            id: "tool-1",
            name: "music_pause",
            input: {}
          }
        ]
      },
      {
        content: [{ type: "text", text: "[CONSUMED]" }]
      }
    ]
  });
  const session = createPausedSession(manager);

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "pause the music"
  });

  assert.equal(handled, true);
  assert.deepEqual(toolCalls.map((entry) => entry.tool), ["musicPause"]);
});

test("maybeHandleMusicPlaybackTurn fast-paths exact compact playback commands before the music brain", async () => {
  const { manager, pauseCalls, loggedEvents, musicBrainPrompts } = createPlaybackHost();
  const session = {
    id: "session-playing-pause",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1"
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");
  manager.sessions.set(session.guildId, session as VoiceSession);

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "pause"
  });

  assert.equal(handled, true);
  assert.equal(session.music?.phase, "paused");
  assert.equal(session.music?.replyHandoffMode, null);
  assert.equal(pauseCalls.length, 1);
  assert.equal(musicBrainPrompts.length, 0);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "fast_path_pause");
});

test("maybeHandleMusicPlaybackTurn sends direct-addressed music turns to the main brain", async () => {
  const { manager, pauseCalls, musicBrainPrompts, loggedEvents } = createPlaybackHost();
  const session = {
    id: "session-playing-duck",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: null
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "hey clanker what do you think about kanye"
  });

  assert.equal(handled, false);
  assert.equal(session.music?.phase, "playing");
  assert.equal(session.music?.replyHandoffMode, null);
  assert.equal(pauseCalls.length, 0);
  assert.equal(musicBrainPrompts.length, 0);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "main_brain_decides");
  assert.equal(stopCheckEvent?.metadata?.gateDecisionReason, "direct_address");
});

test("maybeHandleMusicPlaybackTurn sends latch-open followups to the main brain", async () => {
  const { manager, loggedEvents, musicBrainPrompts } = createPlaybackHost();
  const session = {
    id: "session-playing-pass",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1"
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "paused_wake_word", "wake_word");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "wait actually what about kanye"
  });

  assert.equal(handled, false);
  assert.equal(session.music?.replyHandoffMode, null);
  assert.equal(musicBrainPrompts.length, 0);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "main_brain_decides");
  assert.equal(stopCheckEvent?.metadata?.gateDecisionReason, "paused_wake_word_owner");
});

test("maybeHandleMusicPlaybackTurn gives the music brain a tiny slice of recent dialogue context", async () => {
  const { manager, musicBrainPrompts } = createPlaybackHost({
    musicBrainResponses: [
      {
        content: [{ type: "text", text: "[PASS]" }]
      }
    ]
  });
  const session = {
    id: "session-playing-recent-context",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1",
    recentVoiceTurns: [
      {
        role: "user",
        userId: "user-1",
        speakerName: "vuhlp",
        text: "what do you think about yeat",
        at: Date.now() - 3_000
      },
      {
        role: "assistant",
        userId: "bot-1",
        speakerName: "YOU",
        text: "oh Yeat? yeah he goes crazy",
        at: Date.now() - 2_000
      },
      {
        role: "user",
        userId: "user-2",
        speakerName: "someone else",
        text: "random cross talk",
        at: Date.now() - 1_000
      }
    ]
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "paused_wake_word", "wake_word");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "pause the music after this one"
  });

  assert.equal(handled, false);
  assert.equal(musicBrainPrompts.length > 0, true);
  const prompt = musicBrainPrompts[0] || "";
  assert.equal(prompt.includes("- Last assistant reply: oh Yeat? yeah he goes crazy"), true);
  assert.equal(prompt.includes("- Previous turn from this speaker (vuhlp): what do you think about yeat"), true);
  assert.equal(prompt.includes("random cross talk"), false);
});

test("maybeHandleMusicPlaybackTurn teaches the music brain to stay command-scoped", async () => {
  const { manager, musicBrainPrompts } = createPlaybackHost({
    musicBrainResponses: [
      {
        content: [{ type: "text", text: "[PASS]" }]
      }
    ]
  });
  const session = {
    id: "session-playing-direct-address-guidance",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1"
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: createDedicatedMusicBrainSettings(),
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "pause the music after this verse"
  });

  const prompt = musicBrainPrompts[0] || "";
  assert.equal(
    prompt.includes("Only decide whether this looks like a real playback-control or disambiguation turn"),
    true
  );
  assert.equal(
    prompt.includes("Do not choose duck or pause floor-shaping here. Wake-word and conversational turns belong to the main voice brain."),
    true
  );
});

test("maybeHandleMusicPlaybackTurn routes eligible music turns to the main brain when the music brain is disabled", async () => {
  const { manager, musicBrainPrompts, loggedEvents } = createPlaybackHost();
  const session = {
    id: "session-main-brain-music-handoff",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1"
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: {
      agentStack: {
        runtimeConfig: {
          voice: {
            musicBrain: {
              mode: "disabled"
            }
          }
        }
      }
    },
    userId: "user-1",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "hey clanker what do you think about kanye"
  });

  assert.equal(handled, false);
  assert.equal(musicBrainPrompts.length, 0);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "main_brain_decides");
  assert.equal(stopCheckEvent?.metadata?.musicBrainEnabled, false);
});

test("maybeHandleMusicPlaybackTurn still swallows non-command chatter after the wake latch closes", async () => {
  const { manager, loggedEvents } = createPlaybackHost();
  const session = {
    id: "session-playing-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() - 1_000,
    musicWakeLatchedByUserId: null
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-2",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "what about the kids though"
  });

  assert.equal(handled, true);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "swallowed");
});

test("maybeHandleMusicPlaybackTurn honors a follow-up that began while the wake latch was open", async () => {
  const { manager, loggedEvents } = createPlaybackHost();
  const session = {
    id: "session-playing-capture-latch-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() - 1_000,
    musicWakeLatchedByUserId: null
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: {
      agentStack: {
        overrides: {
          voiceMusicBrain: {
            mode: "disabled"
          }
        }
      }
    },
    userId: "user-2",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "what about the kids though",
    musicWakeFollowupEligibleAtCapture: true
  });

  assert.equal(handled, false);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "main_brain_decides");
  assert.equal(stopCheckEvent?.metadata?.musicWakeCurrentLatched, false);
  assert.equal(stopCheckEvent?.metadata?.musicWakeFollowupEligibleAtCapture, true);
});

test("maybeHandleMusicPlaybackTurn lets recent same-speaker interrupted followups reach the main brain", async () => {
  const { manager, loggedEvents } = createPlaybackHost();
  const interruptedAt = Date.now() - 1_000;
  const session = {
    id: "session-playing-interrupted-followup-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    lastAssistantReplyAt: interruptedAt - 100,
    interruptedAssistantReply: {
      utteranceText: "the rest of the story",
      interruptedByUserId: "user-2",
      interruptedAt,
      source: "speaking_data"
    }
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "playing");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: {
      agentStack: {
        overrides: {
          voiceMusicBrain: {
            mode: "disabled"
          }
        }
      }
    },
    userId: "user-2",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "oh my god this is scary"
  });

  assert.equal(handled, false);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "main_brain_decides");
  assert.equal(stopCheckEvent?.metadata?.interruptedReplyOwnerFollowup, true);
});

test("maybeHandleMusicPlaybackTurn still swallows other-speaker chatter while music is paused for a wake word", async () => {
  const { manager, loggedEvents } = createPlaybackHost();
  const session = {
    id: "session-paused-wake-word-other",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    ending: false,
    musicWakeLatchedUntil: Date.now() + 10_000,
    musicWakeLatchedByUserId: "user-1"
  };
  ensureSessionMusicState(manager, session);
  setMusicPhase(manager, session, "paused_wake_word", "wake_word");

  const handled = await maybeHandleMusicPlaybackTurn(manager, {
    session,
    settings: null,
    userId: "user-2",
    pcmBuffer: Buffer.alloc(0),
    source: "realtime",
    transcript: "what about the kids though"
  });

  assert.equal(handled, true);
  const stopCheckEvent = loggedEvents.find((entry) => entry.content === "voice_music_stop_check");
  assert.equal(stopCheckEvent?.metadata?.decisionReason, "swallowed");
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
    beginVoiceCommandSession: () => null,
    clearVoiceCommandSession: () => {},
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
    abortActiveInboundCaptures: () => {},
    buildVoiceToolCallbacks: () => ({
      musicSearch: async () => ({ ok: true }),
      musicPlay: async () => ({ ok: true }),
      musicQueueAdd: async () => ({ ok: true }),
      musicQueueNext: async () => ({ ok: true }),
      musicStop: async () => ({ ok: true }),
      musicPause: async () => ({ ok: true }),
      musicResume: async () => ({ ok: true }),
      musicReplyHandoff: async () => ({ ok: true }),
      musicSkip: async () => ({ ok: true }),
      musicNowPlaying: async () => ({ ok: true }),
      playSoundboard: async () => ({ ok: true }),
      setScreenNote: async () => ({ ok: true }),
      setScreenMoment: async () => ({ ok: true }),
      leaveVoiceChannel: async () => ({ ok: true })
    })
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
