import { test } from "bun:test";
import assert from "node:assert/strict";
import { executeLocalVoiceToolCall, executeVoiceMusicPlayNowTool } from "./voiceToolCalls.ts";
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
      lastOpenAiToolCallerUserId: "user-1"
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

// ---------------------------------------------------------------------------
// music_play_now non-blocking tests
// ---------------------------------------------------------------------------

function buildMusicPlayNowManager({
  requestPlayMusicImpl
}: {
  requestPlayMusicImpl?: () => Promise<void>;
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
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => ({ guildId: "guild-1", tracks: [], nowPlayingIndex: 0, isPaused: false }),
    requestPlayMusic: requestPlayMusicImpl
      ? (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return requestPlayMusicImpl(); }
      : (...args: unknown[]) => { calls.push({ method: "requestPlayMusic", args }); return Promise.resolve(); },
    requestRealtimePromptUtterance: (args: unknown) => { calls.push({ method: "requestRealtimePromptUtterance", args }); return true; }
  };

  const session = {
    id: "voice-session-1",
    guildId: "guild-1",
    textChannelId: "channel-1",
    lastOpenAiToolCallerUserId: "user-1",
    toolMusicTrackCatalog: catalog
  };

  return { manager, session, calls, track };
}

test("music_play_now returns immediately with status loading", async () => {
  let resolvePlayMusic: () => void;
  const playMusicPromise = new Promise<void>((r) => { resolvePlayMusic = r; });

  const { manager, session, calls } = buildMusicPlayNowManager({
    requestPlayMusicImpl: () => playMusicPromise
  });

  const result = await executeVoiceMusicPlayNowTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { track_id: "track-abc" }
  });

  // Tool returns immediately — requestPlayMusic has NOT resolved yet
  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");
  assert.equal(result.track.title, "Bad and Boujee");
  assert.equal(result.track.artist, "Migos");

  // requestRealtimePromptUtterance should NOT have been called yet
  const utteranceCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(utteranceCalls.length, 0);

  // Now let the background download complete
  resolvePlayMusic!();
  await new Promise((r) => setTimeout(r, 10));

  // Now the "now playing" utterance should have fired
  const afterCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(afterCalls.length, 1);
  const utteranceArgs = afterCalls[0].args as { prompt: string; source: string };
  assert.match(utteranceArgs.prompt, /Bad and Boujee/);
  assert.match(utteranceArgs.prompt, /now playing/);
  assert.equal(utteranceArgs.source, "music_now_playing");
});

test("music_play_now injects error utterance when download fails", async () => {
  const { manager, session, calls } = buildMusicPlayNowManager({
    requestPlayMusicImpl: () => Promise.reject(new Error("yt-dlp timed out"))
  });

  const result = await executeVoiceMusicPlayNowTool(manager, {
    session,
    settings: createTestSettings({}),
    args: { track_id: "track-abc" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "loading");

  // Let the rejected promise propagate through .catch()
  await new Promise((r) => setTimeout(r, 10));

  const utteranceCalls = calls.filter((c) => c.method === "requestRealtimePromptUtterance");
  assert.equal(utteranceCalls.length, 1);
  const utteranceArgs = utteranceCalls[0].args as { prompt: string; source: string };
  assert.match(utteranceArgs.prompt, /failed to load/);
  assert.match(utteranceArgs.prompt, /yt-dlp timed out/);
  assert.equal(utteranceArgs.source, "music_play_failed");
});

test("music_play_now updates queue state synchronously before returning", async () => {
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
    ensureToolMusicQueueState: () => queueState,
    buildVoiceQueueStatePayload: () => null,
    requestPlayMusic: () => new Promise<void>(() => {}), // never resolves
    requestRealtimePromptUtterance: () => true
  };

  await executeVoiceMusicPlayNowTool(manager, {
    session: {
      id: "s1",
      guildId: "g1",
      textChannelId: "tc1",
      lastOpenAiToolCallerUserId: null,
      toolMusicTrackCatalog: catalog
    },
    settings: createTestSettings({}),
    args: { track_id: "track-abc" }
  });

  // Queue should have been updated synchronously
  assert.equal(queueState.nowPlayingIndex, 0);
  assert.equal(queueState.isPaused, false);
  assert.equal(queueState.tracks[0].title, "Bad and Boujee");
  // old-2 should be preserved (was after nowPlayingIndex)
  assert.equal(queueState.tracks[1].id, "old-2");
  assert.equal(queueState.tracks.length, 2);
});
