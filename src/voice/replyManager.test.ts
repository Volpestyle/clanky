import { test } from "bun:test";
import assert from "node:assert/strict";
import { ReplyManager } from "./replyManager.ts";

function createSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    mode: "openai_realtime",
    ending: false,
    botTurnOpen: false,
    botTurnOpenAt: 0,
    lastAudioDeltaAt: 0,
    lastResponseRequestAt: 0,
    pendingResponse: null,
    awaitingToolOutputs: false,
    realtimeToolCallExecutions: new Map(),
    userCaptures: new Map(),
    assistantOutput: {
      phase: "idle",
      reason: "idle",
      phaseEnteredAt: 0,
      lastSyncedAt: 0,
      requestId: null,
      ttsPlaybackState: "idle",
      ttsBufferedSamples: 0,
      lastTrigger: null
    },
    music: {
      phase: "idle",
      active: false,
      ducked: false,
      pauseReason: null
    },
    voxClient: null,
    realtimeClient: null,
    ...overrides
  };
}

function createReplyManagerHarness({ hasActiveCapture = false } = {}) {
  const logs = [];
  const resumeCalls = [];
  const haltCalls = [];
  let deferredTurnBlockingActiveCapture = Boolean(hasActiveCapture);
  const replyManager = new ReplyManager({
    client: { user: { id: "bot-user" } },
    store: {
      logAction(entry) {
        logs.push(entry);
      },
      getSettings() {
        return null;
      }
    },
    activeReplies: null,
    musicPlayer: {
      resume() {
        resumeCalls.push("resume");
      }
    },
    bargeInController: {
      clearBargeInOutputSuppression() {},
      isBargeInOutputSuppressed() {
        return false;
      }
    },
    touchActivity() {},
    logVoiceLatencyStage() {},
    normalizeReplyInterruptionPolicy(rawPolicy) {
      return rawPolicy || null;
    },
    resolveReplyInterruptionPolicy({ policy } = {}) {
      return policy || null;
    },
    setActiveReplyInterruptionPolicy() {},
    maybeClearActiveReplyInterruptionPolicy() {},
    deferredActionQueue: {
      getDeferredQueuedUserTurns() {
        return [];
      },
      scheduleDeferredVoiceActionRecheck() {},
      recheckDeferredVoiceActions() {},
      clearAllDeferredVoiceActions() {}
    },
    hasDeferredTurnBlockingActiveCapture() {
      return deferredTurnBlockingActiveCapture;
    },
    endSession: async () => true,
    scheduleBotSpeechMusicUnduck() {},
    getMusicPhase(session) {
      return session?.music?.phase || "idle";
    },
    setMusicPhase(session, phase) {
      if (session?.music) {
        session.music.phase = phase;
      }
    },
    haltSessionOutputForMusicPlayback(_session, reason) {
      haltCalls.push(String(reason || ""));
    },
    drainPendingRealtimeAssistantUtterances() {
      return false;
    }
  });

  return {
    replyManager,
    logs,
    resumeCalls,
    haltCalls,
    setHasDeferredTurnBlockingActiveCapture(value) {
      deferredTurnBlockingActiveCapture = Boolean(value);
    }
  };
}

test("getReplyOutputLockState locks output while music playback is active", () => {
  const { replyManager } = createReplyManagerHarness();
  const session = createSession({
    music: {
      phase: "playing",
      active: true
    }
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "music_playback_active");
  assert.equal(lockState.musicActive, true);
});

test("getReplyOutputLockState does not lock output when music is paused", () => {
  const { replyManager } = createReplyManagerHarness();
  const session = createSession({
    music: {
      phase: "paused",
      active: true
    }
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.musicActive, false);
});

test("getReplyOutputLockState locks output while clankvox still has queued speech", () => {
  const { replyManager } = createReplyManagerHarness();
  const session = createSession({
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      }
    }
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "bot_audio_buffered");
  assert.equal(lockState.bufferedBotSpeech, true);
});

test("getReplyOutputLockState ignores stale clankvox buffered telemetry", () => {
  const { replyManager } = createReplyManagerHarness();
  const session = createSession({
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return "buffered";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now() - 5_000;
      }
    }
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
});

test("getReplyOutputLockState ignores stale botTurnOpen when no output signals remain", () => {
  const { replyManager } = createReplyManagerHarness();
  const session = createSession({
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 5_000,
    lastAudioDeltaAt: Date.now() - 5_000
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
  assert.equal(lockState.botTurnOpen, true);
});

test("getReplyOutputLockState clears stale active realtime response once playback is idle", () => {
  const { replyManager, logs } = createReplyManagerHarness();
  let activeResponse = true;
  const session = createSession({
    lastResponseRequestAt: Date.now() - 10_000,
    realtimeClient: {
      isResponseInProgress() {
        return activeResponse;
      },
      clearActiveResponse() {
        activeResponse = false;
      }
    }
  });

  const lockState = replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
  assert.ok(
    logs.some((entry) => entry.content === "openai_realtime_active_response_cleared_stale"),
    "expected stale active-response recovery log"
  );
});

test("clearStaleRealtimeResponse skips clear when a fresh response replaced the stale one", () => {
  const { replyManager } = createReplyManagerHarness();
  let activeResponseId = "stale_resp_1";
  const session = createSession({
    lastResponseRequestAt: Date.now() - 10_000,
    realtimeClient: {
      activeResponseId,
      isResponseInProgress() {
        return Boolean(activeResponseId);
      },
      clearActiveResponse() {
        activeResponseId = null;
      }
    }
  });

  const cleared1 = replyManager.clearStaleRealtimeResponse(session, "stale_resp_1");
  assert.equal(cleared1, true);

  activeResponseId = "fresh_resp_2";
  session.realtimeClient.activeResponseId = "fresh_resp_2";

  const cleared2 = replyManager.clearStaleRealtimeResponse(session, "stale_resp_1");
  assert.equal(cleared2, false);
  assert.equal(activeResponseId, "fresh_resp_2");
});

test("handleResponseDone waits for buffered assistant playback before resuming wake-word-paused music", async () => {
  const { replyManager, resumeCalls, haltCalls } = createReplyManagerHarness();
  const requestedAt = Date.now() - 10;
  const initialLatchUntil = Date.now() + 1_000;
  const session = createSession({
    botTurnOpen: true,
    lastAudioDeltaAt: requestedAt,
    musicWakeLatchedUntil: initialLatchUntil,
    musicWakeLatchedByUserId: "user-1",
    pendingResponse: {
      requestId: 7,
      requestedAt,
      source: "realtime_transcript_turn",
      userId: "user-1",
      retryCount: 0
    },
    music: {
      phase: "paused_wake_word",
      active: true,
      ducked: false,
      pauseReason: "wake_word"
    },
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return this.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now();
      }
    }
  });

  replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp_123",
        status: "completed"
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(resumeCalls.length, 0);
  assert.equal(haltCalls.length, 0);
  assert.equal(session.music.phase, "paused_wake_word");

  session.botTurnOpen = false;
  session.voxClient.ttsBufferDepthSamples = 0;

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(haltCalls, ["music_resumed_after_wake_word"]);
  assert.equal(session.music.phase, "playing");
  assert.equal(Number(session.musicWakeLatchedUntil || 0) > initialLatchUntil, true);
  assert.equal(session.musicWakeLatchedByUserId, null);
});

test("markBotTurnOut refreshes passive music wake latch only after buffered reply playback settles", async () => {
  const { replyManager, resumeCalls, haltCalls, logs } = createReplyManagerHarness();
  const initialLatchUntil = Date.now() + 1_000;
  const session = createSession({
    botTurnOpen: true,
    lastAudioDeltaAt: Date.now() - 10,
    musicWakeLatchedUntil: initialLatchUntil,
    musicWakeLatchedByUserId: "user-1",
    pendingResponse: {
      requestId: 11,
      requestedAt: Date.now() - 10,
      source: "realtime_transcript_turn",
      userId: "user-1",
      retryCount: 0,
      musicWakeRefreshAfterSpeech: true
    },
    music: {
      phase: "playing",
      active: true,
      ducked: false,
      pauseReason: null
    },
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return this.ttsBufferDepthSamples > 0 ? "buffered" : "idle";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now();
      }
    }
  });

  replyManager.markBotTurnOut(session);

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(Number(session.musicWakeLatchedUntil || 0), initialLatchUntil);
  assert.equal(resumeCalls.length, 0);
  assert.equal(haltCalls.length, 0);

  session.botTurnOpen = false;
  session.pendingResponse = null;
  session.voxClient.ttsBufferDepthSamples = 0;

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(Number(session.musicWakeLatchedUntil || 0) > initialLatchUntil, true);
  assert.equal(session.musicWakeLatchedByUserId, "user-1");
  assert.equal(
    logs.some((entry) => entry.content === "voice_music_wake_latch_refreshed_after_reply"),
    true
  );
});

test("handleResponseDone keeps wake-word-paused music paused while an interrupting capture is still active", async () => {
  const {
    replyManager,
    resumeCalls,
    haltCalls,
    setHasDeferredTurnBlockingActiveCapture
  } = createReplyManagerHarness({ hasActiveCapture: true });
  const requestedAt = Date.now() - 10;
  const session = createSession({
    botTurnOpen: false,
    lastAudioDeltaAt: requestedAt,
    pendingResponse: {
      requestId: 8,
      requestedAt,
      source: "realtime_transcript_turn",
      userId: "user-1",
      retryCount: 0
    },
    music: {
      phase: "paused_wake_word",
      active: true,
      ducked: false,
      pauseReason: "wake_word"
    },
    voxClient: {
      ttsBufferDepthSamples: 0,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return "idle";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now();
      }
    }
  });

  replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp_456",
        status: "completed"
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(resumeCalls.length, 0);
  assert.equal(haltCalls.length, 0);
  assert.equal(session.music.phase, "paused_wake_word");

  setHasDeferredTurnBlockingActiveCapture(false);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(haltCalls, ["music_resumed_after_wake_word"]);
  assert.equal(session.music.phase, "playing");
});

test("handleResponseDone keeps wake-word-paused music paused while a followup turn is still processing", async () => {
  const { replyManager, resumeCalls, haltCalls } = createReplyManagerHarness();
  const requestedAt = Date.now() - 10;
  const session = createSession({
    botTurnOpen: false,
    lastAudioDeltaAt: requestedAt,
    pendingResponse: {
      requestId: 9,
      requestedAt,
      source: "realtime_transcript_turn",
      userId: "user-1",
      retryCount: 0
    },
    music: {
      phase: "paused_wake_word",
      active: true,
      ducked: false,
      pauseReason: "wake_word"
    },
    activeRealtimeTurn: {
      userId: "user-1",
      pcmBuffer: Buffer.alloc(24_000),
      queuedAt: Date.now(),
      captureReason: "stream_end",
      finalizedAt: Date.now(),
      processing: true
    },
    voxClient: {
      ttsBufferDepthSamples: 0,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return "idle";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now();
      }
    }
  });

  replyManager.handleResponseDone({
    session,
    event: {
      type: "response.done",
      response: {
        id: "resp_789",
        status: "completed"
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(resumeCalls.length, 0);
  assert.equal(haltCalls.length, 0);
  assert.equal(session.music.phase, "paused_wake_word");

  session.activeRealtimeTurn = null;

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(haltCalls, ["music_resumed_after_wake_word"]);
  assert.equal(session.music.phase, "playing");
});

test("schedulePausedReplyMusicResume waits for an in-flight accepted brain turn to finish", async () => {
  const { replyManager, resumeCalls, haltCalls } = createReplyManagerHarness();
  const session = createSession({
    botTurnOpen: false,
    music: {
      phase: "paused_wake_word",
      active: true,
      ducked: false,
      pauseReason: "wake_word"
    },
    inFlightAcceptedBrainTurn: {
      transcript: "say something",
      userId: "user-1",
      pcmBuffer: null,
      source: "voice_reply_pipeline",
      acceptedAt: Date.now(),
      phase: "generation_only",
      captureReason: "stream_end",
      directAddressed: true
    },
    voxClient: {
      ttsBufferDepthSamples: 0,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      },
      getTtsPlaybackState() {
        return "idle";
      },
      getTtsTelemetryUpdatedAt() {
        return Date.now();
      }
    }
  });

  replyManager.schedulePausedReplyMusicResume(session, 25);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resumeCalls.length, 0);
  assert.equal(haltCalls.length, 0);
  assert.equal(session.music.phase, "paused_wake_word");

  session.inFlightAcceptedBrainTurn = null;

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(haltCalls, ["music_resumed_after_wake_word"]);
  assert.equal(session.music.phase, "playing");
});
