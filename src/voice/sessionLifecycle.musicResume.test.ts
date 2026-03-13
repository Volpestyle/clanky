import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createTestSettings } from "../testSettings.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

class FakeVoxClient extends EventEmitter {
  isAlive = true;
  ttsBufferDepthSamples = 0;

  getPlaybackArmedReason() {
    return null;
  }

  getTtsPlaybackState() {
    return "idle" as const;
  }

  getTtsTelemetryUpdatedAt() {
    return Date.now();
  }
}

function createManagerHarness() {
  const haltCalls: string[] = [];
  const logs: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const client = {
    on() {},
    off() {},
    user: { id: "bot-1" },
    channels: {
      fetch: async () => null
    },
    guilds: {
      cache: {
        get: () => null
      }
    }
  };
  const manager = new VoiceSessionManager({
    client,
    store: {
      getSettings: () => createTestSettings({}),
      logAction(entry) {
        logs.push({
          content: entry.content,
          metadata: entry.metadata
        });
      }
    },
    appConfig: {}
  });

  manager.haltSessionOutputForMusicPlayback = (_session, reason = "music_playback_started") => {
    haltCalls.push(String(reason || "music_playback_started"));
  };
  manager.replyManager.syncAssistantOutputState = () => {};
  manager.instructionManager.scheduleRealtimeInstructionRefresh = () => {};
  manager.drainPendingRealtimeAssistantUtterances = () => false;
  manager.musicPlayer.clearCurrentTrack = () => {};

  return {
    manager,
    haltCalls,
    logs
  };
}

function createSession(overrides: Partial<VoiceSession> = {}) {
  const now = Date.now();
  const session = {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    startedAt: now - 60_000,
    lastActivityAt: now - 5_000,
    maxEndsAt: now + 120_000,
    inactivityEndsAt: now + 45_000,
    userCaptures: new Map(),
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    mode: "openai_realtime",
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    },
    music: {
      phase: "paused_wake_word",
      ducked: false,
      pauseReason: "wake_word",
      replyHandoffMode: "pause",
      replyHandoffRequestedByUserId: "user-1",
      replyHandoffSource: "voice_tool_media_reply_handoff",
      replyHandoffAt: now - 500,
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
      lastCommandAt: now - 100,
      lastCommandReason: "music_resumed_after_wake_word",
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingAction: "play_now",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:track-1",
          title: "Simple and Clean",
          artist: "Utada Hikaru",
          durationMs: 240000,
          source: "yt",
          streamUrl: "https://example.com/track",
          platform: "youtube",
          externalUrl: "https://example.com/track"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: true,
      volume: 1
    },
    assistantOutput: {
      phase: "idle",
      reason: "idle",
      phaseEnteredAt: now,
      lastSyncedAt: now,
      requestId: null,
      ttsPlaybackState: "idle",
      ttsBufferedSamples: 0,
      lastTrigger: "test_seed"
    },
    botTurnOpen: false,
    botTurnOpenAt: 0,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    pendingResponse: null,
    awaitingToolOutputs: false,
    realtimeToolCallExecutions: new Map(),
    voxClient: new FakeVoxClient(),
    pendingFileAsrTurns: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    cleanupHandlers: [],
    realtimeProvider: null,
    realtimeInputSampleRateHz: 24000,
    realtimeOutputSampleRateHz: 24000,
    realtimeClient: null,
    activeReplyInterruptionPolicy: null,
    deferredVoiceActions: {},
    deferredVoiceActionTimers: {},
    lastRequestedRealtimeUtterance: null,
    pendingRealtimeAssistantUtterances: [],
    realtimeAssistantUtteranceBackpressureActive: false,
    settingsSnapshot: createTestSettings({
      botName: "clanky",
      voice: {
        enabled: true,
        replyPath: "brain"
      }
    }),
    ...overrides
  } as VoiceSession;
  return session;
}

test("bindVoxHandlers confirms wake-word resume only when playback actually reaches playing", () => {
  const { manager, haltCalls } = createManagerHarness();
  const initialLatchUntil = Date.now() + 1_000;
  const session = createSession({
    musicWakeLatchedUntil: initialLatchUntil,
    musicWakeLatchedByUserId: "user-1"
  });

  manager.sessionLifecycle.bindVoxHandlers(session);
  session.voxClient?.emit("playerState", "playing");

  assert.equal(session.music.phase, "playing");
  assert.equal(session.musicQueueState?.isPaused, false);
  assert.deepEqual(haltCalls, ["music_resumed_after_wake_word"]);
  assert.equal(Number(session.musicWakeLatchedUntil || 0) > initialLatchUntil, true);
  assert.equal(session.musicWakeLatchedByUserId, null);
});

test("bindVoxHandlers confirms duck handoff resume without re-halting output", () => {
  const { manager, haltCalls } = createManagerHarness();
  const initialLatchUntil = Date.now() + 1_000;
  const session = createSession({
    musicWakeLatchedUntil: initialLatchUntil,
    musicWakeLatchedByUserId: "user-1",
    music: {
      phase: "paused_wake_word",
      ducked: false,
      pauseReason: "wake_word",
      replyHandoffMode: "duck",
      replyHandoffRequestedByUserId: "user-1",
      replyHandoffSource: "voice_tool_media_reply_handoff",
      replyHandoffAt: Date.now() - 500,
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
      lastCommandAt: Date.now() - 100,
      lastCommandReason: "media_resumed_reply_handoff_duck",
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingAction: "play_now",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    }
  });

  manager.sessionLifecycle.bindVoxHandlers(session);
  session.voxClient?.emit("playerState", "playing");

  assert.equal(session.music.phase, "playing");
  assert.equal(session.music.replyHandoffMode, "duck");
  assert.equal(session.musicQueueState?.isPaused, false);
  assert.deepEqual(haltCalls, []);
  assert.equal(Number(session.musicWakeLatchedUntil || 0), initialLatchUntil);
  assert.equal(session.musicWakeLatchedByUserId, "user-1");
});

test("bindVoxHandlers clears paused queue state when music becomes idle", () => {
  const { manager } = createManagerHarness();
  const session = createSession({
    music: {
      phase: "paused",
      ducked: false,
      pauseReason: "user_pause",
      replyHandoffMode: null,
      replyHandoffRequestedByUserId: null,
      replyHandoffSource: null,
      replyHandoffAt: 0,
      startedAt: 0,
      stoppedAt: 0,
      provider: "youtube",
      source: "slash_command",
      lastTrackId: "youtube:track-1",
      lastTrackTitle: "Simple and Clean",
      lastTrackArtists: ["Utada Hikaru"],
      lastTrackUrl: "https://example.com/track",
      lastQuery: "simple and clean",
      lastRequestedByUserId: "user-1",
      lastRequestText: "pause music",
      lastCommandAt: Date.now() - 100,
      lastCommandReason: "slash_command_pause",
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingAction: "play_now",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    }
  });

  manager.sessionLifecycle.bindVoxHandlers(session);
  session.voxClient?.emit("musicIdle");

  assert.equal(session.music.phase, "idle");
  assert.equal(session.musicQueueState?.isPaused, false);
});
