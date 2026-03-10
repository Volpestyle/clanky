import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import type { MusicSelectionResult } from "./voiceSessionTypes.ts";
import {
  completePendingMusicDisambiguationSelection,
  getMusicPromptContext,
  isMusicDisambiguationResolutionTurn,
  resolvePendingMusicDisambiguationSelection
} from "./voiceMusicDisambiguation.ts";

const OPTIONS: MusicSelectionResult[] = [
  {
    id: "track-1",
    title: "Midnight City",
    artist: "M83",
    platform: "youtube",
    externalUrl: null,
    durationSeconds: 250
  },
  {
    id: "track-2",
    title: "Genesis",
    artist: "Grimes",
    platform: "youtube",
    externalUrl: null,
    durationSeconds: 271
  },
  {
    id: "track-3",
    title: "Windowlicker",
    artist: "Aphex Twin",
    platform: "soundcloud",
    externalUrl: null,
    durationSeconds: 360
  }
];

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    settingsSnapshot: null,
    voiceCommandState: null,
    ...overrides
  };
}

function createDisambiguationHost({
  promptContext = null,
  snapshot = null,
  queueState = {
    tracks: [
      {
        id: "now-playing",
        title: "Current Song",
        artist: "Current Artist",
        source: "yt"
      }
    ],
    nowPlayingIndex: 0,
    isPaused: false
  },
  isVoiceCommandSessionActive = true
}: {
  promptContext?: Record<string, unknown> | null;
  snapshot?: Record<string, unknown> | null;
  queueState?: {
    tracks: Array<Record<string, unknown>>;
    nowPlayingIndex: number | null;
    isPaused: boolean;
  };
  isVoiceCommandSessionActive?: boolean;
} = {}) {
  const requestPlayCalls: Array<Record<string, unknown>> = [];
  const composeCalls: Array<Record<string, unknown>> = [];
  const sentMessages: string[] = [];
  const clearMusicDisambiguationSessions: unknown[] = [];
  const clearVoiceCommandSessions: unknown[] = [];

  const host = {
    appConfig: {},
    client: {
      user: {
        id: "bot-1"
      }
    },
    store: {
      logAction() {},
      getSettings() {
        return createTestSettings({});
      }
    },
    getMusicDisambiguationPromptContext() {
      return promptContext;
    },
    snapshotMusicRuntimeState() {
      return snapshot;
    },
    isVoiceCommandSessionActiveForUser() {
      return isVoiceCommandSessionActive;
    },
    clearMusicDisambiguationState(session: unknown) {
      clearMusicDisambiguationSessions.push(session);
      if (promptContext && typeof promptContext === "object") {
        promptContext.active = false;
      }
    },
    clearVoiceCommandSession(session: unknown) {
      clearVoiceCommandSessions.push(session);
    },
    async composeOperationalMessage(payload: Record<string, unknown>) {
      composeCalls.push(payload);
      return `queued ${String(payload.details?.trackId || "")}`.trim();
    },
    async requestPlayMusic(args: Record<string, unknown>) {
      requestPlayCalls.push(args);
      return { ok: true };
    },
    ensureToolMusicQueueState() {
      return queueState;
    },
    isMusicPlaybackActive() {
      return true;
    },
    async playVoiceQueueTrackByIndex() {
      throw new Error("should_not_autoplay_in_test");
    },
    buildVoiceQueueStatePayload() {
      return {
        tracks: queueState.tracks,
        nowPlayingIndex: queueState.nowPlayingIndex,
        isPaused: queueState.isPaused
      };
    }
  };

  const channel = {
    id: "text-1",
    async send(content: string) {
      sentMessages.push(content);
      return true;
    }
  };

  return {
    host,
    channel,
    queueState,
    requestPlayCalls,
    composeCalls,
    sentMessages,
    clearMusicDisambiguationSessions,
    clearVoiceCommandSessions
  };
}

test("getMusicPromptContext derives current playback, last action, and upcoming queue entries", () => {
  const { host } = createDisambiguationHost({
    snapshot: {
      active: true,
      lastTrackId: "track-1",
      lastTrackTitle: "Midnight City",
      lastTrackArtists: ["M83"],
      lastCommandReason: "voice_tool_music_play",
      lastQuery: "midnight city",
      queueState: {
        tracks: [
          { id: "track-1", title: "Midnight City", artist: "M83" },
          { id: "track-2", title: "Genesis", artist: "Grimes" },
          { id: "track-3", title: "Windowlicker", artist: "Aphex Twin" },
          { id: "track-4", title: "Hyperballad", artist: "Bjork" }
        ],
        nowPlayingIndex: 0,
        isPaused: false
      }
    }
  });

  const context = getMusicPromptContext(host, createSession());

  assert.deepEqual(context, {
    playbackState: "playing",
    currentTrack: {
      id: "track-1",
      title: "Midnight City",
      artists: ["M83"]
    },
    lastTrack: {
      id: "track-1",
      title: "Midnight City",
      artists: ["M83"]
    },
    queueLength: 4,
    upcomingTracks: [
      { id: "track-2", title: "Genesis", artist: "Grimes" },
      { id: "track-3", title: "Windowlicker", artist: "Aphex Twin" },
      { id: "track-4", title: "Hyperballad", artist: "Bjork" }
    ],
    lastAction: "play_now",
    lastQuery: "midnight city"
  });
});

test("getMusicPromptContext keeps the last known track visible while playback is idle", () => {
  const { host } = createDisambiguationHost({
    snapshot: {
      active: false,
      lastTrackId: "track-1",
      lastTrackTitle: "Midnight City",
      lastTrackArtists: ["M83"],
      lastCommandReason: null,
      lastQuery: "midnight city",
      queueState: {
        tracks: [],
        nowPlayingIndex: null,
        isPaused: false
      }
    }
  });

  const context = getMusicPromptContext(host, createSession());

  assert.deepEqual(context, {
    playbackState: "idle",
    currentTrack: {
      id: "track-1",
      title: "Midnight City",
      artists: ["M83"]
    },
    lastTrack: {
      id: "track-1",
      title: "Midnight City",
      artists: ["M83"]
    },
    queueLength: 0,
    upcomingTracks: [],
    lastAction: null,
    lastQuery: "midnight city"
  });
});

test("resolvePendingMusicDisambiguationSelection supports ordinal and title matching", () => {
  const promptContext = {
    active: true,
    query: "electronic",
    platform: "youtube",
    action: "play_now",
    requestedByUserId: "user-1",
    options: OPTIONS
  };
  const { host } = createDisambiguationHost({
    promptContext
  });

  assert.equal(
    resolvePendingMusicDisambiguationSelection(host, createSession(), "second one please")?.id,
    "track-2"
  );
  assert.equal(
    resolvePendingMusicDisambiguationSelection(host, createSession(), "windowlicker by aphex twin")?.id,
    "track-3"
  );
});

test("isMusicDisambiguationResolutionTurn requires the requesting user and an active music command session", () => {
  const promptContext = {
    active: true,
    query: "electronic",
    platform: "youtube",
    action: "play_now",
    requestedByUserId: "user-1",
    options: OPTIONS
  };
  const activeHost = createDisambiguationHost({
    promptContext,
    isVoiceCommandSessionActive: true
  }).host;
  const inactiveHost = createDisambiguationHost({
    promptContext,
    isVoiceCommandSessionActive: false
  }).host;
  const session = createSession();

  assert.equal(
    isMusicDisambiguationResolutionTurn(activeHost, session, "user-1", "never mind"),
    true
  );
  assert.equal(
    isMusicDisambiguationResolutionTurn(activeHost, session, "user-2", "2"),
    false
  );
  assert.equal(
    isMusicDisambiguationResolutionTurn(inactiveHost, session, "user-1", "2"),
    false
  );
});

test("completePendingMusicDisambiguationSelection delegates play_now requests to requestPlayMusic", async () => {
  const promptContext = {
    active: true,
    query: "midnight city",
    platform: "youtube",
    action: "play_now",
    requestedByUserId: "user-1",
    options: OPTIONS
  };
  const { host, requestPlayCalls, clearMusicDisambiguationSessions, clearVoiceCommandSessions } = createDisambiguationHost({
    promptContext
  });
  const session = createSession({
    settingsSnapshot: createTestSettings({})
  });

  const handled = await completePendingMusicDisambiguationSelection(host, {
    session,
    settings: createTestSettings({}),
    userId: "user-1",
    selected: OPTIONS[0],
    source: "voice_disambiguation"
  });

  assert.equal(handled, true);
  assert.equal(requestPlayCalls.length, 1);
  assert.deepEqual(requestPlayCalls[0], {
    guildId: "guild-1",
    channel: null,
    channelId: "text-1",
    requestedByUserId: "user-1",
    settings: createTestSettings({}),
    query: "midnight city",
    platform: "youtube",
    trackId: "track-1",
    searchResults: OPTIONS,
    reason: "voice_music_disambiguation_selection",
    source: "voice_disambiguation",
    mustNotify: false
  });
  assert.deepEqual(clearMusicDisambiguationSessions, []);
  assert.deepEqual(clearVoiceCommandSessions, []);
});

test("completePendingMusicDisambiguationSelection queues the chosen track next and sends an operational message", async () => {
  const promptContext = {
    active: true,
    query: "genesis",
    platform: "youtube",
    action: "queue_next",
    requestedByUserId: "user-1",
    options: OPTIONS
  };
  const {
    host,
    channel,
    queueState,
    composeCalls,
    sentMessages,
    clearMusicDisambiguationSessions,
    clearVoiceCommandSessions
  } = createDisambiguationHost({
    promptContext
  });
  const settings = createTestSettings({});
  const session = createSession({
    settingsSnapshot: settings
  });

  const handled = await completePendingMusicDisambiguationSelection(host, {
    session,
    settings,
    userId: "user-1",
    selected: OPTIONS[1],
    channel,
    messageId: "msg-1",
    source: "voice_disambiguation"
  });

  assert.equal(handled, true);
  assert.equal(queueState.tracks[1]?.id, "track-2");
  assert.equal(session.toolMusicTrackCatalog.get("track-2")?.title, "Genesis");
  assert.equal(clearMusicDisambiguationSessions.length, 1);
  assert.equal(clearVoiceCommandSessions.length, 1);
  assert.equal(composeCalls.length, 1);
  assert.equal(composeCalls[0]?.reason, "queued_next");
  assert.deepEqual(composeCalls[0]?.details, {
    source: "voice_disambiguation",
    query: "genesis",
    trackId: "track-2",
    trackTitle: "Genesis",
    trackArtists: ["Grimes"]
  });
  assert.deepEqual(sentMessages, ["queued track-2"]);
});
