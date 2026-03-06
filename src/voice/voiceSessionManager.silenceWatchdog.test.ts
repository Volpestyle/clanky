import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createTestSettings } from "../testSettings.ts";

function createManager() {
  const logs = [];
  const client = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };
  const store = {
    logAction(entry) {
      logs.push(entry);
    },
    getSettings() {
      return createTestSettings({
        botName: "clanker conk"
      });
    }
  };

  const manager = new VoiceSessionManager({
    client,
    store,
    appConfig: {},
    llm: {
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory: null
  });

  return { manager, logs };
}

function createRealtimeSession(overrides = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    mode: "openai_realtime",
    ending: false,
    realtimeInputSampleRateHz: 24_000,
    realtimeOutputSampleRateHz: 24_000,
    pendingRealtimeInputBytes: 0,
    nextResponseRequestId: 0,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    lastInboundAudioAt: 0,
    responseWatchdogTimer: null,
    responseDoneGraceTimer: null,
    pendingResponse: null,
    userCaptures: new Map(),
    settingsSnapshot: createTestSettings({
      botName: "clanker conk"
    }),
    realtimeClient: {
      createAudioResponse() {},
      commitInputAudioBuffer() {},
      isResponseInProgress() {
        return false;
      }
    },
    ...overrides
  };
}

test("flushResponseFromBufferedAudio emits response.create for OpenAI native reply turns", () => {
  const { manager } = createManager();
  const commits = [];
  const creates = [];
  const session = createRealtimeSession({
    pendingRealtimeInputBytes: 5_000,
    settingsSnapshot: createTestSettings({
      botName: "clanker conk",
      voice: {
        replyPath: "native"
      }
    }),
    realtimeClient: {
      createAudioResponse() {
        creates.push("create");
      },
      commitInputAudioBuffer() {
        commits.push("commit");
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  manager.flushResponseFromBufferedAudio({
    session,
    userId: "speaker-native"
  });

  assert.equal(commits.length, 1);
  assert.equal(creates.length, 1);
  assert.equal(Number(session.pendingResponse?.requestId || 0) > 0, true);
});

test("flushResponseFromBufferedAudio skips response.create for OpenAI brain reply turns", () => {
  const { manager } = createManager();
  const commits = [];
  const creates = [];
  const session = createRealtimeSession({
    pendingRealtimeInputBytes: 5_000,
    settingsSnapshot: createTestSettings({
      botName: "clanker conk",
      voice: {
        replyPath: "brain",
        brainProvider: "anthropic"
      }
    }),
    realtimeClient: {
      createAudioResponse() {
        creates.push("create");
      },
      commitInputAudioBuffer() {
        commits.push("commit");
      },
      isResponseInProgress() {
        return false;
      }
    }
  });

  manager.flushResponseFromBufferedAudio({
    session,
    userId: "speaker-brain"
  });

  assert.equal(commits.length, 1);
  assert.equal(creates.length, 0);
  assert.equal(Number(session.pendingResponse?.requestId || 0) > 0, true);
});

test("silent response triggers retry and rearms watchdog", async () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 8,
      userId: "speaker-8",
      requestedAt: Date.now() - 8_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  manager.createTrackedAudioResponse = () => false;
  let rearmArgs = null;
  manager.armResponseSilenceWatchdog = (args) => {
    rearmArgs = args;
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse?.retryCount, 1);
  assert.equal(rearmArgs?.requestId, 8);
  assert.equal(logs.some((entry) => String(entry.content).includes("response_silent_retry")), true);
});

test("audio arrival clears watchdog and pending response", () => {
  const { manager } = createManager();
  const requestedAt = Date.now() - 1_500;
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 9,
      userId: "user-9",
      requestedAt,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    lastAudioDeltaAt: requestedAt + 1
  });

  const originalSetTimeout = globalThis.setTimeout;
  let scheduledFn = null;
  globalThis.setTimeout = (fn) => {
    scheduledFn = fn;
    return { id: "watchdog" };
  };
  try {
    manager.armResponseSilenceWatchdog({
      session,
      requestId: 9,
      userId: "user-9"
    });
    scheduledFn();
    assert.equal(session.pendingResponse, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("max retries ends session when retry path throws", async () => {
  const { manager, logs } = createManager();
  const session = createRealtimeSession({
    pendingResponse: {
      requestId: 10,
      userId: "speaker-10",
      requestedAt: Date.now() - 10_000,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  manager.createTrackedAudioResponse = () => {
    throw new Error("retry create failed");
  };
  const endCalls = [];
  manager.endSession = async (payload) => {
    endCalls.push(payload);
  };

  await manager.handleSilentResponse({
    session,
    userId: "fallback-user",
    trigger: "watchdog"
  });

  assert.equal(session.pendingResponse, null);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "response_stalled");
  assert.equal(logs.some((entry) => String(entry.content).includes("response_retry_failed")), true);
});
