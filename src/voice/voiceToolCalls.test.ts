import { test } from "bun:test";
import assert from "node:assert/strict";
import { executeLocalVoiceToolCall, executeVoiceMusicPlayTool } from "./voiceToolCalls.ts";
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
      browser: {
        maxStepsPerTask: 5,
        stepTimeoutMs: 10_000,
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929"
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

  const manager = {
    client: {
      user: {
        id: "bot-user"
      }
    },
    ensureToolMusicQueueState: () => queueState,
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
    requestPlayMusic: requestPlayMusicImpl
      ? (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return requestPlayMusicImpl(); }
      : (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return Promise.resolve(); },
    requestRealtimePromptUtterance: (args: unknown) => { calls.push({ method: "requestRealtimePromptUtterance", args }); return true; },
    store: {
      logAction: (...args: unknown[]) => { calls.push({ method: "logAction", args }); }
    }
  };

  const session = {
    id: "voice-session-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    lastRealtimeToolCallerUserId: "user-1",
    toolMusicTrackCatalog: catalog
  };

  return { manager, session, calls, track };
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

  const { manager, session, calls } = buildMusicPlayManager({
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

  const utteranceCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(utteranceCalls.length, 0);

  resolvePlayMusic!();
  await new Promise((r) => setTimeout(r, 10));

  const afterCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(afterCalls.length, 0);
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
    requestPlayMusic: () => new Promise<void>(() => {}), // never resolves
    requestRealtimePromptUtterance: () => true,
    store: {
      logAction() {
        return undefined;
      }
    }
  };

  await executeVoiceMusicPlayTool(manager, {
    session: {
      id: "s1",
      guildId: "g1",
      textChannelId: "tc1",
      lastRealtimeToolCallerUserId: null,
      toolMusicTrackCatalog: catalog
    },
    settings: createTestSettings({}),
    args: { selection_id: "track-abc" }
  });

  assert.equal(queueState.nowPlayingIndex, 0);
  assert.equal(queueState.isPaused, false);
  assert.equal(queueState.tracks[0].title, "Bad and Boujee");
  assert.equal(queueState.tracks[1].id, "old-2");
  assert.equal(queueState.tracks.length, 2);
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
    session: {
      id: "s-last",
      guildId: "g1",
      textChannelId: "tc1",
      lastRealtimeToolCallerUserId: "user-1",
      toolMusicTrackCatalog: new Map()
    },
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
