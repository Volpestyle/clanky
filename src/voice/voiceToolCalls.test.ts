import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  executeVoiceBrowserBrowseTool,
} from "./voiceToolCallAgents.ts";
import { executeLocalVoiceToolCall } from "./voiceToolCallDispatch.ts";
import {
  executeVoiceMusicPlayTool,
  executeVoiceMusicQueueNextTool,
  executeVoiceVideoPlayTool
} from "./voiceToolCallMusic.ts";
import { createTestSettings } from "../testSettings.ts";

test("executeLocalVoiceToolCall forwards browser abort signals to browser_browse", async () => {
  const controller = new AbortController();
  controller.abort("cancel voice browser task");

  let llmCalled = false;
  let browserCalled = false;
  const manager = {
    llm: {
      async chatWithTools() {
        llmCalled = true;
        return {
          content: [],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
          costUsd: 0
        };
      }
    },
    browserManager: {
      async open() {
        browserCalled = true;
        return "opened";
      },
      async close() {
        return undefined;
      }
    },
    store: {
      logAction() {
        return undefined;
      }
    }
  };

  const result = await executeLocalVoiceToolCall(manager, {
    session: {
      id: "voice-session-1",
      guildId: "guild-1",
      textChannelId: "channel-1",
      lastRealtimeToolCallerUserId: "user-1"
    },
    settings: createTestSettings({
      agentStack: {
        runtimeConfig: {
          browser: {
            localBrowserAgent: {
              maxStepsPerTask: 5,
              stepTimeoutMs: 10_000,
              execution: {
                mode: "dedicated_model",
                model: {
                  provider: "anthropic",
                  model: "claude-sonnet-4-5-20250929"
                }
              }
            }
          }
        }
      }
    }),
    toolName: "browser_browse",
    args: {
      query: "check example.com"
    },
    signal: controller.signal
  });

  assert.deepEqual(result, {
    ok: false,
    text: "",
    error: "Browser session cancelled."
  });
  assert.equal(llmCalled, false);
  assert.equal(browserCalled, false);
});

test("executeLocalVoiceToolCall aborts non-browser tools before dispatch", async () => {
  const controller = new AbortController();
  controller.abort("cancel voice web search");

  let searchCalled = false;
  const manager = {
    search: {
      async searchAndRead() {
        searchCalled = true;
        return { query: "ignored", results: [] };
      }
    }
  };

  await assert.rejects(
    executeLocalVoiceToolCall(manager, {
      session: {
        id: "voice-session-1",
        guildId: "guild-1",
        textChannelId: "channel-1",
        lastRealtimeToolCallerUserId: "user-1"
      },
      settings: createTestSettings({}),
      toolName: "web_search",
      args: {
        query: "latest rust news"
      },
      signal: controller.signal
    }),
    /AbortError/i
  );
  assert.equal(searchCalled, false);
});

test("executeVoiceBrowserBrowseTool omits session_id when the browser session completes", async () => {
  const sessions = new Map<string, {
    id: string;
    ownerUserId?: string | null;
    runTurn: () => Promise<{
      text: string;
      isError?: boolean;
      errorMessage?: string | null;
      sessionCompleted?: boolean;
    }>;
  }>();

  const manager = {
    subAgentSessions: {
      get(sessionId: string) {
        return sessions.get(sessionId);
      },
      register(session: { id: string; ownerUserId?: string | null; runTurn: () => Promise<{ text: string; sessionCompleted?: boolean }> }) {
        sessions.set(session.id, session);
      },
      remove(sessionId: string) {
        return sessions.delete(sessionId);
      }
    },
    createBrowserAgentSession() {
      return {
        id: "browser-session-1",
        ownerUserId: "user-1",
        async runTurn() {
          return {
            text: "Finished browsing.",
            sessionCompleted: true
          };
        }
      };
    }
  };

  const result = await executeVoiceBrowserBrowseTool(manager, {
    session: {
      id: "voice-session-1",
      guildId: "guild-1",
      textChannelId: "channel-1",
      lastRealtimeToolCallerUserId: "user-1"
    },
    settings: createTestSettings({}),
    args: {
      query: "finish and close"
    }
  });

  assert.deepEqual(result, {
    ok: true,
    text: "Finished browsing."
  });
  assert.equal(sessions.size, 0);
});

test("executeLocalVoiceToolCall applies a temporary pause reply handoff for the main brain", async () => {
  const scheduledResumeCalls: number[] = [];
  const pauseCalls: number[] = [];
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    tracks: [],
    nowPlayingIndex: 0,
    isPaused: false
  };
  const session = {
    id: "voice-session-handoff-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    voiceChannelId: "voice-1",
    ending: false,
    lastRealtimeToolCallerUserId: "user-1",
    music: {
      phase: "playing" as const,
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
      lastQuery: null,
      lastRequestedByUserId: null,
      lastRequestText: null,
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: "auto" as const,
      pendingAction: "play_now" as const,
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    }
  };

  const result = await executeLocalVoiceToolCall({
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => queueState,
    musicPlayer: {
      pause() {
        pauseCalls.push(1);
      }
    },
    replyManager: {
      schedulePausedReplyMusicResume(_session: unknown, delayMs?: number) {
        scheduledResumeCalls.push(Number(delayMs || 0));
      },
      hasBufferedTtsPlayback: () => false
    },
    store: {
      getSettings: () => createTestSettings({}),
      logAction() {
        return undefined;
      }
    }
  }, {
    session,
    settings: createTestSettings({}),
    toolName: "media_reply_handoff",
    args: {
      mode: "pause"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.mode, "pause");
  assert.equal(session.music?.phase, "paused_wake_word");
  assert.equal(session.music?.replyHandoffMode, "pause");
  assert.equal(queueState.isPaused, true);
  assert.equal(pauseCalls.length, 1);
  assert.deepEqual(scheduledResumeCalls, [200]);
});

test("executeLocalVoiceToolCall requests music resume without forcing playing state", async () => {
  const logs: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const resumeCalls: number[] = [];
  const haltCalls: string[] = [];
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    tracks: [
      {
        id: "youtube:track-1",
        title: "Simple and Clean",
        artist: "Utada Hikaru",
        durationMs: 240000,
        source: "yt" as const,
        streamUrl: "https://example.com/track",
        platform: "youtube" as const,
        externalUrl: "https://example.com/track"
      }
    ],
    nowPlayingIndex: 0,
    isPaused: true
  };
  const session = {
    id: "voice-session-resume-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    voiceChannelId: "voice-1",
    ending: false,
    lastRealtimeToolCallerUserId: "user-1",
    music: {
      phase: "paused" as const,
      ducked: false,
      pauseReason: "user_pause" as const,
      replyHandoffMode: null,
      replyHandoffRequestedByUserId: null,
      replyHandoffSource: null,
      replyHandoffAt: 0,
      startedAt: 0,
      stoppedAt: 0,
      provider: "youtube",
      source: "voice_tool_call",
      lastTrackId: "youtube:track-1",
      lastTrackTitle: "Simple and Clean",
      lastTrackArtists: ["Utada Hikaru"],
      lastTrackUrl: "https://example.com/track",
      lastQuery: "simple and clean",
      lastRequestedByUserId: "user-1",
      lastRequestText: "resume the music",
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: "auto" as const,
      pendingAction: "play_now" as const,
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    musicQueueState: queueState
  };

  const result = await executeLocalVoiceToolCall({
    ensureSessionMusicState: () => session.music,
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => ({ ...queueState }),
    setMusicPhase(_session: unknown, phase: string) {
      session.music.phase = phase as "idle" | "paused" | "paused_wake_word" | "playing" | "loading" | "stopping";
    },
    haltSessionOutputForMusicPlayback(_session: unknown, reason?: string) {
      haltCalls.push(String(reason || ""));
    },
    musicPlayer: {
      resume() {
        resumeCalls.push(1);
      }
    },
    store: {
      getSettings: () => createTestSettings({}),
      logAction(entry: { content: string; metadata?: Record<string, unknown> }) {
        logs.push(entry);
      }
    }
  }, {
    session,
    settings: createTestSettings({}),
    toolName: "media_resume",
    args: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "resume_requested");
  assert.equal(result.phase, "paused");
  assert.equal(session.music.phase, "paused");
  assert.equal(session.music.lastCommandReason, "voice_tool_media_resume");
  assert.equal(queueState.isPaused, true);
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(haltCalls, []);
  assert.equal(
    logs.some((entry) => entry.content === "voice_music_resume_unavailable"),
    false
  );
});

test("executeLocalVoiceToolCall clears stale paused music state when resume is unavailable", async () => {
  const logs: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const resumeCalls: number[] = [];
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    tracks: [],
    nowPlayingIndex: null,
    isPaused: true
  };
  const session = {
    id: "voice-session-resume-2",
    guildId: "guild-1",
    textChannelId: "channel-1",
    voiceChannelId: "voice-1",
    ending: false,
    lastRealtimeToolCallerUserId: "user-1",
    music: {
      phase: "paused" as const,
      ducked: false,
      pauseReason: "user_pause" as const,
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
      lastQuery: null,
      lastRequestedByUserId: null,
      lastRequestText: null,
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: "auto" as const,
      pendingAction: "play_now" as const,
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    musicQueueState: queueState
  };

  const result = await executeLocalVoiceToolCall({
    ensureSessionMusicState: () => session.music,
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => ({ ...queueState }),
    setMusicPhase(_session: unknown, phase: string) {
      session.music.phase = phase as "idle" | "paused" | "paused_wake_word" | "playing" | "loading" | "stopping";
    },
    haltSessionOutputForMusicPlayback() {
      throw new Error("halt should not run for unavailable resume");
    },
    musicPlayer: {
      resume() {
        resumeCalls.push(1);
      }
    },
    store: {
      getSettings: () => createTestSettings({}),
      logAction(entry: { content: string; metadata?: Record<string, unknown> }) {
        logs.push(entry);
      }
    }
  }, {
    session,
    settings: createTestSettings({}),
    toolName: "media_resume",
    args: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "media_resume_unavailable");
  assert.equal(result.phase, "idle");
  assert.equal(session.music.phase, "idle");
  assert.equal(queueState.isPaused, false);
  assert.equal(resumeCalls.length, 0);
  assert.equal(
    logs.some((entry) => entry.content === "voice_music_resume_unavailable"),
    true
  );
});

test("executeLocalVoiceToolCall keeps paused_wake_word until duck handoff playback is confirmed", async () => {
  const resumeCalls: number[] = [];
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    tracks: [
      {
        id: "youtube:track-1",
        title: "Simple and Clean",
        artist: "Utada Hikaru",
        durationMs: 240000,
        source: "yt" as const,
        streamUrl: "https://example.com/track",
        platform: "youtube" as const,
        externalUrl: "https://example.com/track"
      }
    ],
    nowPlayingIndex: 0,
    isPaused: true
  };
  const session = {
    id: "voice-session-handoff-2",
    guildId: "guild-1",
    textChannelId: "channel-1",
    voiceChannelId: "voice-1",
    ending: false,
    lastRealtimeToolCallerUserId: "user-1",
    music: {
      phase: "paused_wake_word" as const,
      ducked: false,
      pauseReason: "wake_word" as const,
      replyHandoffMode: "pause" as const,
      replyHandoffRequestedByUserId: "user-1",
      replyHandoffSource: "voice_tool_media_reply_handoff",
      replyHandoffAt: Date.now(),
      startedAt: 0,
      stoppedAt: 0,
      provider: "youtube",
      source: "voice_tool_call",
      lastTrackId: "youtube:track-1",
      lastTrackTitle: "Simple and Clean",
      lastTrackArtists: ["Utada Hikaru"],
      lastTrackUrl: "https://example.com/track",
      lastQuery: "simple and clean",
      lastRequestedByUserId: "user-1",
      lastRequestText: "keep it under me",
      lastCommandAt: 0,
      lastCommandReason: null,
      pendingQuery: null,
      pendingPlatform: "auto" as const,
      pendingAction: "play_now" as const,
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    musicQueueState: queueState
  };

  const result = await executeLocalVoiceToolCall({
    ensureSessionMusicState: () => session.music,
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => ({ ...queueState }),
    musicPlayer: {
      resume() {
        resumeCalls.push(1);
      }
    },
    replyManager: {
      schedulePausedReplyMusicResume() {
        throw new Error("duck handoff should not schedule pause resume");
      },
      hasBufferedTtsPlayback: () => false
    },
    store: {
      getSettings: () => createTestSettings({}),
      logAction() {
        return undefined;
      }
    }
  }, {
    session,
    settings: createTestSettings({}),
    toolName: "media_reply_handoff",
    args: {
      mode: "duck"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.mode, "duck");
  assert.equal(result.phase, "paused_wake_word");
  assert.equal(session.music?.phase, "paused_wake_word");
  assert.equal(session.music?.replyHandoffMode, "duck");
  assert.equal(session.music?.lastCommandReason, "media_resumed_reply_handoff_duck");
  assert.equal(queueState.isPaused, true);
  assert.equal(resumeCalls.length, 1);
});

// ---------------------------------------------------------------------------
// music_play non-blocking tests
// ---------------------------------------------------------------------------

function buildMusicPlayManager({
  requestPlayMusicImpl,
  searchResults = []
}: {
  requestPlayMusicImpl?: () => Promise<void>;
  searchResults?: Array<{
    id: string;
    title: string;
    artist: string;
    durationSeconds: number;
    platform: string;
    externalUrl: string;
  }>;
} = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const sessionMusicState = { phase: "idle" };

  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    tracks: [],
    nowPlayingIndex: null,
    isPaused: false
  };

  const track = {
    id: "track-abc",
    title: "Bad and Boujee",
    artist: "Migos",
    durationSeconds: 240,
    platform: "youtube",
    externalUrl: "https://example.com/track"
  };

  const catalog = new Map([[track.id, track]]);

  const session = {
    id: "voice-session-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    lastRealtimeToolCallerUserId: "user-1",
    toolMusicTrackCatalog: catalog,
    music: sessionMusicState
  };

  const manager = {
    client: {
      user: {
        id: "bot-user"
      }
    },
    ensureToolMusicQueueState: () => queueState,
    ensureSessionMusicState: () => ({
      lastTrackId: null,
      lastTrackTitle: null,
      lastTrackArtists: [],
      lastTrackUrl: null,
      provider: "youtube"
    }),
    buildVoiceQueueStatePayload: () => ({ guildId: "guild-1", tracks: [], nowPlayingIndex: 0, isPaused: false }),
    musicSearch: {
      isConfigured: () => true,
      search: async () => ({ results: searchResults })
    },
    normalizeMusicSelectionResult: (row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      title: String(row.title || ""),
      artist: String(row.artist || ""),
      platform: String(row.platform || "youtube"),
      externalUrl: String(row.externalUrl || ""),
      durationSeconds: Number(row.durationSeconds || 0)
    }),
    beginVoiceCommandSession: (...args: unknown[]) => { calls.push({ method: "beginVoiceCommandSession", args }); },
    clearVoiceCommandSession: (runtimeSession: unknown) => {
      const targetSession = runtimeSession as { voiceCommandState?: unknown } | null;
      if (targetSession && typeof targetSession === "object") {
        targetSession.voiceCommandState = null;
      }
      calls.push({ method: "clearVoiceCommandSession", args: [runtimeSession] });
    },
    setMusicPhase: (_session: unknown, phase: string) => {
      sessionMusicState.phase = phase;
      calls.push({ method: "setMusicPhase", args: [_session, phase] });
    },
    requestPlayMusic: requestPlayMusicImpl
      ? (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return requestPlayMusicImpl(); }
      : (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return Promise.resolve(); },
    requestRealtimePromptUtterance: (args: unknown) => { calls.push({ method: "requestRealtimePromptUtterance", args }); return true; },
    store: {
      logAction: (...args: unknown[]) => { calls.push({ method: "logAction", args }); }
    }
  };

  return { manager, session, calls, track, sessionMusicState };
}

test("music_play returns immediately with status loading for a direct match", async () => {
  let resolvePlayMusic: () => void;
  const playMusicPromise = new Promise<void>((r) => { resolvePlayMusic = r; });
  const directTrack = {
    id: "track-abc",
    title: "Bad and Boujee",
    artist: "Migos",
    durationSeconds: 240,
    platform: "youtube",
    externalUrl: "https://example.com/track"
  };

  const { manager, session, calls, sessionMusicState } = buildMusicPlayManager({
    requestPlayMusicImpl: () => playMusicPromise,
    searchResults: [directTrack]
  });

  const result = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { query: "bad and boujee" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");
  assert.equal(result.track.title, "Bad and Boujee");
  assert.equal(result.track.artist, "Migos");
  assert.equal(calls.filter((c) => c.method === "requestPlayMusic").length, 1);
  assert.equal(sessionMusicState.phase, "loading");

  const utteranceCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(utteranceCalls.length, 0);

  resolvePlayMusic!();
  await new Promise((r) => setTimeout(r, 10));

  const afterCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(afterCalls.length, 0);
});

test("video_play returns immediately with status loading for a direct YouTube match", async () => {
  let resolvePlayMusic: () => void;
  const playMusicPromise = new Promise<void>((r) => { resolvePlayMusic = r; });
  const directTrack = {
    id: "video-abc",
    title: "Rust MCP walkthrough",
    artist: "OpenClaw Labs",
    durationSeconds: 540,
    platform: "youtube",
    externalUrl: "https://youtube.com/watch?v=abc123"
  };

  const { manager, session, calls, sessionMusicState } = buildMusicPlayManager({
    requestPlayMusicImpl: () => playMusicPromise,
    searchResults: [directTrack]
  });
  let requestedPlatform: string | null = null;
  manager.musicSearch.search = async (_query: string, opts?: { platform?: string }) => {
    requestedPlatform = String(opts?.platform || "");
    return { results: [directTrack] };
  };

  const result = await executeVoiceVideoPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { query: "that rust mcp walkthrough video" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");
  assert.equal(result.video.title, "Rust MCP walkthrough");
  assert.equal(requestedPlatform, "youtube");
  assert.equal(calls.filter((c) => c.method === "requestPlayMusic").length, 1);
  assert.equal(sessionMusicState.phase, "loading");

  resolvePlayMusic!();
  await new Promise((r) => setTimeout(r, 10));
});

test("music_play falls back to query search when selection_id is unknown", async () => {
  const directTrack = {
    id: "track-abc",
    title: "Bad and Boujee",
    artist: "Migos",
    durationSeconds: 240,
    platform: "youtube",
    externalUrl: "https://example.com/track"
  };

  const { manager, session, calls, sessionMusicState } = buildMusicPlayManager({
    searchResults: [directTrack]
  });

  const result = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: {
      query: "bad and boujee",
      selection_id: "</antml :parameter>\n"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");
  assert.equal(result.track.id, "track-abc");
  assert.equal(result.track.title, "Bad and Boujee");
  assert.equal(calls.filter((entry) => entry.method === "requestPlayMusic").length, 1);
  assert.equal(sessionMusicState.phase, "loading");

  const fallbackLog = calls.find((entry) => {
    if (entry.method !== "logAction" || !Array.isArray(entry.args)) return false;
    const payload = entry.args[0];
    return Boolean(
      payload &&
      typeof payload === "object" &&
      (payload as { content?: unknown }).content === "voice_tool_music_play_selection_fallback"
    );
  });
  assert.equal(Boolean(fallbackLog), true);
});

test("music_play returns disambiguation options when search is ambiguous", async () => {
  const searchResults = [
    {
      id: "track-a",
      title: "Risk It All",
      artist: "Bruno Mars",
      durationSeconds: 201,
      platform: "youtube",
      externalUrl: "https://example.com/a"
    },
    {
      id: "track-b",
      title: "24K Magic",
      artist: "Bruno Mars",
      durationSeconds: 227,
      platform: "youtube",
      externalUrl: "https://example.com/b"
    }
  ];

  const { manager, session, calls } = buildMusicPlayManager({ searchResults });

  const result = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { query: "Bruno Mars" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "needs_disambiguation");
  assert.equal(Array.isArray(result.options), true);
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0]?.selection_id, "track-a");
  assert.equal(calls.filter((c) => c.method === "requestPlayMusic").length, 0);
  assert.equal(calls.filter((c) => c.method === "beginVoiceCommandSession").length, 1);
});

test("music_play resolves pending disambiguation by exact option title query without selection_id", async () => {
  const searchResults = [
    {
      id: "track-a",
      title: "Minecraft Winter Cabin Ambience | 6 Hours of Relaxing Snow Sounds & Cozy Fireplace",
      artist: "TICraft",
      durationSeconds: 21600,
      platform: "youtube",
      externalUrl: "https://example.com/a"
    },
    {
      id: "track-b",
      title: "Minecraft Winter Cabin w/ C418 Music | 8 Hours",
      artist: "CozyCraft",
      durationSeconds: 28800,
      platform: "youtube",
      externalUrl: "https://example.com/b"
    }
  ];

  const { manager, session, calls } = buildMusicPlayManager({ searchResults });
  const persistentMusicState = {
    phase: "idle",
    ducked: false,
    pauseReason: null,
    pendingQuery: null,
    pendingPlatform: "auto",
    pendingAction: "play_now",
    pendingResults: [] as unknown[],
    pendingRequestedByUserId: null,
    pendingRequestedAt: 0,
    lastTrackId: null,
    lastTrackTitle: null,
    lastTrackArtists: [] as string[],
    lastTrackUrl: null,
    provider: "youtube"
  };
  manager.ensureSessionMusicState = () => persistentMusicState;
  (session as Record<string, unknown>).music = persistentMusicState;
  let searchCallCount = 0;
  manager.musicSearch.search = async () => {
    searchCallCount += 1;
    return { results: searchResults };
  };

  const disambiguation = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { query: "winter cabin ambience" }
  });

  assert.equal(disambiguation.ok, true);
  assert.equal(disambiguation.status, "needs_disambiguation");
  assert.equal(searchCallCount, 1);
  assert.equal(persistentMusicState.pendingResults.length, 2);
  (session as { voiceCommandState?: unknown }).voiceCommandState = {
    userId: "user-1",
    domain: "music",
    intent: "music_disambiguation"
  };

  const resolved = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: {
      query: "Minecraft Winter Cabin Ambience | 6 Hours of Relaxing Snow Sounds & Cozy Fireplace"
    }
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, "loading");
  assert.equal(resolved.track.id, "track-a");
  assert.equal(searchCallCount, 1);
  assert.equal(calls.filter((entry) => entry.method === "requestPlayMusic").length, 1);
  assert.equal(persistentMusicState.pendingResults.length, 0);
  assert.equal(persistentMusicState.pendingQuery, null);
  assert.equal((session as { voiceCommandState?: unknown }).voiceCommandState, null);
  const resolvedQueryLog = calls.find((entry) => {
    if (entry.method !== "logAction" || !Array.isArray(entry.args)) return false;
    const payload = entry.args[0];
    return Boolean(
      payload &&
      typeof payload === "object" &&
      (payload as { content?: unknown }).content === "voice_tool_music_play_query_resolved_pending_selection"
    );
  });
  assert.equal(Boolean(resolvedQueryLog), true);
});

test("video_play returns disambiguation options when the YouTube request is ambiguous", async () => {
  const searchResults = [
    {
      id: "video-a",
      title: "MCP explained in 10 minutes",
      artist: "Tech Channel",
      durationSeconds: 600,
      platform: "youtube",
      externalUrl: "https://youtube.com/watch?v=video-a"
    },
    {
      id: "video-b",
      title: "MCP deep dive",
      artist: "Infra Channel",
      durationSeconds: 1200,
      platform: "youtube",
      externalUrl: "https://youtube.com/watch?v=video-b"
    }
  ];

  const { manager, session, calls } = buildMusicPlayManager({ searchResults });
  let requestedPlatform: string | null = null;
  manager.musicSearch.search = async (_query: string, opts?: { platform?: string }) => {
    requestedPlatform = String(opts?.platform || "");
    return { results: searchResults };
  };

  const result = await executeVoiceVideoPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { query: "find an mcp video" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "needs_disambiguation");
  assert.equal(Array.isArray(result.options), true);
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0]?.selection_id, "video-a");
  assert.equal(requestedPlatform, "youtube");
  assert.equal(calls.filter((c) => c.method === "requestPlayMusic").length, 0);
  assert.equal(calls.filter((c) => c.method === "beginVoiceCommandSession").length, 1);
});

test("music_play updates queue state synchronously before returning", async () => {
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    tracks: [
      { id: "old-1", title: "Old Track", artist: "Old Artist", durationMs: 180000, source: "yt", streamUrl: null, platform: "youtube", externalUrl: null },
      { id: "old-2", title: "Old Track 2", artist: "Old Artist 2", durationMs: 200000, source: "yt", streamUrl: null, platform: "youtube", externalUrl: null }
    ],
    nowPlayingIndex: 0,
    isPaused: true
  };

  const track = {
    id: "track-abc",
    title: "Bad and Boujee",
    artist: "Migos",
    durationSeconds: 240,
    platform: "youtube",
    externalUrl: "https://example.com/track"
  };

  const catalog = new Map([[track.id, track]]);

  const session = {
    id: "s1",
    guildId: "g1",
    textChannelId: "tc1",
    lastRealtimeToolCallerUserId: null,
    toolMusicTrackCatalog: catalog,
    music: {
      phase: "idle" as const,
      ducked: false,
      pauseReason: null
    }
  };

  const manager = {
    client: {
      user: {
        id: "bot-user"
      }
    },
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => null,
    musicSearch: {
      isConfigured: () => true,
      search: async () => ({ results: [] })
    },
    normalizeMusicSelectionResult: (row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      title: String(row.title || ""),
      artist: String(row.artist || ""),
      platform: String(row.platform || "youtube"),
      externalUrl: String(row.externalUrl || ""),
      durationSeconds: Number(row.durationSeconds || 0)
    }),
    beginVoiceCommandSession() {
      return undefined;
    },
    clearVoiceCommandSession(runtimeSession: unknown) {
      const targetSession = runtimeSession as { voiceCommandState?: unknown } | null;
      if (targetSession && typeof targetSession === "object") {
        targetSession.voiceCommandState = null;
      }
    },
    setMusicPhase(runtimeSession: unknown, phase: string) {
      const targetSession = runtimeSession as {
        music?: {
          phase?: "loading" | "playing" | "paused" | "paused_wake_word" | "idle" | "stopping";
          ducked?: boolean;
          pauseReason?: null;
        };
      } | null;
      if (targetSession?.music && typeof targetSession.music === "object") {
        targetSession.music.phase = phase as typeof targetSession.music.phase;
        return undefined;
      }
      targetSession!.music = {
        phase: phase as "loading" | "playing" | "paused" | "paused_wake_word" | "idle" | "stopping",
        ducked: false,
        pauseReason: null
      };
      return undefined;
    },
    requestPlayMusic: () => new Promise<void>(() => {}), // never resolves
    requestRealtimePromptUtterance: () => true,
    store: {
      logAction() {
        return undefined;
      }
    }
  };

  await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { selection_id: "track-abc" }
  });

  assert.equal(queueState.nowPlayingIndex, 0);
  assert.equal(queueState.isPaused, false);
  assert.equal(queueState.tracks[0].title, "Bad and Boujee");
  assert.equal(queueState.tracks[1].id, "old-2");
  assert.equal(queueState.tracks.length, 2);
  assert.equal(session.music?.phase, "loading");
});

test("music_queue_next resolves a direct query and inserts it after the current track", async () => {
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    tracks: [
      {
        id: "track-current",
        title: "Subwoofer Lullaby",
        artist: "C418",
        durationMs: 210000,
        source: "yt",
        streamUrl: null,
        platform: "youtube",
        externalUrl: null
      }
    ],
    nowPlayingIndex: 0,
    isPaused: false,
    volume: 1
  };
  const queuedTrack = {
    id: "track-kh",
    title: "Dearly Beloved",
    artist: "Yoko Shimomura",
    durationSeconds: 150,
    platform: "youtube",
    externalUrl: "https://example.com/kh"
  };
  const calls: Array<{ method: string; args: unknown }> = [];
  const session = {
    id: "voice-session-queue-next-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    lastRealtimeToolCallerUserId: "user-1",
    toolMusicTrackCatalog: new Map<string, unknown>()
  };

  const manager = {
    client: {
      user: {
        id: "bot-user"
      }
    },
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => ({
      guildId: queueState.guildId,
      voiceChannelId: queueState.voiceChannelId,
      tracks: queueState.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
        source: track.source,
        streamUrl: track.streamUrl
      })),
      nowPlayingIndex: queueState.nowPlayingIndex,
      isPaused: queueState.isPaused,
      volume: queueState.volume
    }),
    musicSearch: {
      isConfigured: () => true,
      search: async () => ({ results: [queuedTrack] })
    },
    normalizeMusicSelectionResult: (row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      title: String(row.title || ""),
      artist: String(row.artist || ""),
      platform: String(row.platform || "youtube"),
      externalUrl: String(row.externalUrl || ""),
      durationSeconds: Number(row.durationSeconds || 0)
    }),
    beginVoiceCommandSession: (...args: unknown[]) => {
      calls.push({ method: "beginVoiceCommandSession", args });
    },
    setMusicPhase() {
      return undefined;
    },
    isMusicPlaybackActive: () => true,
    playVoiceQueueTrackByIndex: async () => {
      calls.push({ method: "playVoiceQueueTrackByIndex", args: [] });
      return { ok: true };
    },
    ensureSessionMusicState: () => ({
      lastTrackId: null,
      lastTrackTitle: null,
      lastTrackArtists: [],
      lastTrackUrl: null,
      provider: "youtube"
    }),
    requestPlayMusic: async () => undefined,
    requestRealtimePromptUtterance: () => true,
    store: {
      getSettings: () => null,
      logAction: (...args: unknown[]) => {
        calls.push({ method: "logAction", args });
      }
    }
  };

  const result = await executeVoiceMusicQueueNextTool(manager, {
    session,
    settings: createTestSettings({}),
    args: {
      query: "Kingdom Hearts Dearly Beloved Yoko Shimomura"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "queued_next");
  assert.equal(result.query, "Kingdom Hearts Dearly Beloved Yoko Shimomura");
  assert.deepEqual(result.added, ["track-kh"]);
  assert.equal(queueState.tracks.length, 2);
  assert.equal(queueState.tracks[1]?.id, "track-kh");
  assert.equal(queueState.nowPlayingIndex, 0);
  assert.equal(calls.some((entry) => entry.method === "beginVoiceCommandSession"), false);
});

test("music_play resolves selection_id from saved last-track state when the catalog is empty", async () => {
  const queueState = {
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    tracks: [],
    nowPlayingIndex: null,
    isPaused: false
  };
  const calls: { method: string; args: unknown }[] = [];
  const session = {
    id: "s-last",
    guildId: "g1",
    textChannelId: "tc1",
    lastRealtimeToolCallerUserId: "user-1",
    toolMusicTrackCatalog: new Map(),
    music: {
      phase: "idle" as const,
      ducked: false,
      pauseReason: null
    }
  };

  const manager = {
    client: {
      user: {
        id: "bot-user"
      }
    },
    ensureToolMusicQueueState: () => queueState,
    ensureSessionMusicState: () => ({
      lastTrackId: "track-last",
      lastTrackTitle: "Midnight City",
      lastTrackArtists: ["M83"],
      lastTrackUrl: "https://example.com/midnight-city",
      provider: "discord"
    }),
    buildVoiceQueueStatePayload: () => null,
    musicSearch: {
      isConfigured: () => true,
      search: async () => ({ results: [] })
    },
    normalizeMusicSelectionResult: (row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      title: String(row.title || ""),
      artist: String(row.artist || ""),
      platform: String(row.platform || "youtube"),
      externalUrl: String(row.externalUrl || ""),
      durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds || 0)
    }),
    beginVoiceCommandSession() {
      return undefined;
    },
    clearVoiceCommandSession(runtimeSession: unknown) {
      const targetSession = runtimeSession as { voiceCommandState?: unknown } | null;
      if (targetSession && typeof targetSession === "object") {
        targetSession.voiceCommandState = null;
      }
    },
    setMusicPhase(runtimeSession: unknown, phase: string) {
      const targetSession = runtimeSession as {
        music?: {
          phase?: "loading" | "playing" | "paused" | "paused_wake_word" | "idle" | "stopping";
          ducked?: boolean;
          pauseReason?: null;
        };
      } | null;
      if (targetSession?.music && typeof targetSession.music === "object") {
        targetSession.music.phase = phase as typeof targetSession.music.phase;
        return undefined;
      }
      return undefined;
    },
    requestPlayMusic: (...args: unknown[]) => {
      calls.push({ method: "requestPlayMusic", args });
      return Promise.resolve();
    },
    requestRealtimePromptUtterance: () => true,
    store: {
      logAction() {
        return undefined;
      }
    }
  };

  const result = await executeVoiceMusicPlayTool(manager, {
    session,
    settings: createTestSettings({}),
    args: {
      query: "midnight city m83",
      selection_id: "track-last"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");
  assert.equal(result.track.id, "track-last");
  assert.equal(result.track.title, "Midnight City");
  assert.equal(calls.length, 1);
});
