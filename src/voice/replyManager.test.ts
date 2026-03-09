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
    openAiToolCallExecutions: new Map(),
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

function createReplyManagerHarness() {
  const logs = [];
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
    musicPlayer: null,
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
    hasReplayBlockingActiveCapture() {
      return false;
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
    haltSessionOutputForMusicPlayback() {},
    drainPendingRealtimeAssistantUtterances() {
      return false;
    }
  });

  return { replyManager, logs };
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
