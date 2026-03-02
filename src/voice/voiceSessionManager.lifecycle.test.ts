import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createBotAudioPlaybackStream } from "./voiceSessionHelpers.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  AUDIO_PLAYBACK_STREAM_OVERFLOW_BYTES,
  BARGE_IN_FULL_OVERRIDE_MIN_MS,
  BARGE_IN_MIN_SPEECH_MS,
  DISCORD_PCM_FRAME_BYTES
} from "./voiceSessionManager.constants.ts";

function createManager() {
  const messages = [];
  const endCalls = [];
  const touchCalls = [];
  const offCalls = [];
  const logs = [];

  const client = {
    on() {},
    off(eventName) {
      offCalls.push(eventName);
    },
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };

  const manager = new VoiceSessionManager({
    client,
    store: {
      logAction(entry) {
        logs.push(entry);
      },
      getSettings() {
        return {
          botName: "clanker conk"
        };
      }
    },
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

  manager.sendOperationalMessage = async (payload) => {
    messages.push(payload);
  };
  manager.endSession = async (payload) => {
    endCalls.push(payload);
  };
  manager.touchActivity = (guildId, settings) => {
    touchCalls.push({ guildId, settings });
  };

  return {
    manager,
    messages,
    endCalls,
    touchCalls,
    offCalls,
    logs
  };
}

function createMessage(overrides = {}) {
  return {
    guild: {
      id: "guild-1"
    },
    channel: {
      id: "text-1"
    },
    channelId: "text-1",
    author: {
      id: "user-1"
    },
    id: "msg-1",
    ...overrides
  };
}

function createSession(overrides = {}) {
  const now = Date.now();
  return {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    startedAt: now - 60_000,
    lastActivityAt: now - 2_000,
    maxEndsAt: now + 120_000,
    inactivityEndsAt: now + 45_000,
    userCaptures: new Map(),
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    mode: "stt_pipeline",
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      ingestedFrameCount: 0
    },
    music: {
      active: false,
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
      pendingPlatform: "auto",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    pendingSttTurns: 0,
    recentVoiceTurns: [],
    membershipEvents: [],
    cleanupHandlers: [],
    realtimeProvider: null,
    realtimeInputSampleRateHz: 24000,
    realtimeOutputSampleRateHz: 24000,
    realtimeClient: null,
    activeReplyInterruptionPolicy: null,
    pendingBargeInRetry: null,
    lastRequestedRealtimeUtterance: null,
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true
      }
    },
    ...overrides
  };
}

test("getRuntimeState summarizes STT and realtime sessions", () => {
  const { manager } = createManager();
  const now = Date.now();
  manager.client.users.cache.set("user-a", {
    id: "user-a",
    username: "alice"
  });

  manager.sessions.set(
    "guild-1",
    createSession({
      id: "stt-session",
      mode: "stt_pipeline",
      pendingSttTurns: 2,
      recentVoiceTurns: [{ role: "user", text: "hello" }],
      userCaptures: new Map([["user-a", {}]])
    })
  );
  manager.sessions.set(
    "guild-2",
    createSession({
      id: "realtime-session",
      guildId: "guild-2",
      voiceChannelId: "voice-2",
      textChannelId: "text-2",
      mode: "openai_realtime",
      streamWatch: {
        active: true,
        targetUserId: "user-z",
        requestedByUserId: "user-mod",
        lastFrameAt: now - 2_000,
        lastCommentaryAt: now - 4_000,
        latestFrameAt: now - 2_000,
        latestFrameMimeType: "image/png",
        latestFrameDataBase64: "AAAAAA==",
        frameWindowStartedAt: now - 15_000,
        acceptedFrameCountInWindow: 5,
        lastBrainContextAt: now - 3_000,
        lastBrainContextProvider: "anthropic",
        lastBrainContextModel: "claude-vision",
        brainContextEntries: [
          {
            text: "enemy near top left minimap",
            at: now - 3_000,
            provider: "anthropic",
            model: "claude-vision",
            speakerName: "streamer"
          }
        ],
        ingestedFrameCount: 8
      },
      realtimeProvider: "openai",
      realtimeClient: {
        getState() {
          return { connected: true };
        }
      },
      recentVoiceTurns: [{ role: "user", text: "yo" }]
    })
  );

  const runtime = manager.getRuntimeState();
  assert.equal(runtime.activeCount, 2);

  const stt = runtime.sessions.find((row) => row.sessionId === "stt-session");
  assert.equal(stt?.stt?.pendingTurns, 2);
  assert.equal(stt?.realtime, null);
  assert.equal(stt?.activeCaptures?.length, 1);
  assert.equal(stt?.activeCaptures?.[0]?.userId, "user-a");
  assert.equal(stt?.activeCaptures?.[0]?.displayName, "alice");

  const realtime = runtime.sessions.find((row) => row.sessionId === "realtime-session");
  assert.equal(realtime?.realtime?.provider, "openai");
  assert.equal(realtime?.realtime?.replySuperseded, 0);
  assert.deepEqual(realtime?.realtime?.state, { connected: true });
  assert.equal(realtime?.streamWatch?.latestFrameMimeType, "image/png");
  assert.equal(realtime?.streamWatch?.acceptedFrameCountInWindow, 5);
  assert.equal(realtime?.streamWatch?.brainContextCount, 1);
  assert.equal(realtime?.streamWatch?.visualFeed?.length, 1);
  assert.equal(realtime?.streamWatch?.visualFeed?.[0]?.text, "enemy near top left minimap");
  assert.equal(realtime?.streamWatch?.brainContextPayload?.notes?.length, 1);
});

test("resolveSpeakingEndFinalizeDelayMs preserves baseline delays in low-load rooms", () => {
  const { manager } = createManager();
  const session = createSession({
    userCaptures: new Map([["speaker-1", {}]]),
    pendingSttTurns: 0
  });

  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 120
    }),
    420
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 600
    }),
    220
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session,
      captureAgeMs: 1200
    }),
    800
  );
});

test("resolveSpeakingEndFinalizeDelayMs adapts delays when room load increases", () => {
  const { manager } = createManager();

  const busyRealtimeSession = createSession({
    mode: "openai_realtime",
    userCaptures: new Map([
      ["speaker-1", {}],
      ["speaker-2", {}]
    ]),
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: [{ userId: "speaker-3" }]
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: busyRealtimeSession,
      captureAgeMs: 500
    }),
    154
  );

  const heavySttSession = createSession({
    mode: "stt_pipeline",
    userCaptures: new Map([["speaker-1", {}]]),
    pendingSttTurns: 4
  });
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 150
    }),
    210
  );
  assert.equal(
    manager.resolveSpeakingEndFinalizeDelayMs({
      session: heavySttSession,
      captureAgeMs: 1400
    }),
    400
  );
});

test("maybeInterruptBotForAssertiveSpeech requires sustained capture bytes", () => {
  const { manager, logs } = createManager();
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: 4_000,
          speakingEndFinalizeTimer: null
        }
      ]
    ])
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech ignores non-target speaker under assertive reply policy", () => {
  const { manager, logs } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "user-1",
      reason: "engaged_continuation",
      source: "test"
    },
    userCaptures: new Map([
      [
        "user-2",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ])
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-2",
    source: "test_assertive_scope"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech blocks all interruptions when reply targets ALL", () => {
  const { manager, logs } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "all",
      allowedUserId: null,
      talkingTo: "ALL",
      reason: "assistant_target_all",
      source: "test"
    },
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ])
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test_all_scope"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech cuts playback after assertive speech", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  const cancelCalls = [];
  let streamDestroyed = false;
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: true,
    botTurnResetTimer: setTimeout(() => undefined, 10_000),
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ]),
    audioPlayer: {
      stop(force) {
        stopCalls.push(force);
      }
    },
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push("cancel");
        return true;
      }
    },
    botAudioStream: {
      destroy() {
        streamDestroyed = true;
      }
    },
    pendingResponse: {
      requestId: 9,
      requestedAt: Date.now() - 1200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test"
  });
  assert.equal(interrupted, true);
  assert.equal(session.botTurnOpen, false);
  assert.equal(session.botAudioStream, null);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0], true);
  assert.equal(cancelCalls.length, 1);
  assert.equal(streamDestroyed, true);
  assert.equal(Number(session.pendingResponse?.audioReceivedAt || 0) > 0, true);
  assert.equal(Number(session.bargeInSuppressionUntil || 0) > Date.now(), true);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.ok(interruptLog);
  assert.equal(interruptLog?.metadata?.responseCancelAttempted, true);
  assert.equal(interruptLog?.metadata?.responseCancelSucceeded, true);
  assert.equal(interruptLog?.metadata?.responseCancelError, null);
});

test("maybeInterruptBotForAssertiveSpeech ignores near-silent captures", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 120,
          signalPeakAbs: 220,
          speakingEndFinalizeTimer: null
        }
      ]
    ]),
    audioPlayer: {
      stop(force) {
        stopCalls.push(force);
      }
    },
    botAudioStream: {
      destroy() {}
    }
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(stopCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech ignores assertive captures in realtime mode", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ]),
    audioPlayer: {
      stop(force) {
        stopCalls.push(force);
      }
    },
    botAudioStream: {
      destroy() {}
    }
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test_realtime_mode"
  });
  assert.equal(interrupted, false);
  assert.equal(session.botTurnOpen, true);
  assert.equal(stopCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("maybeInterruptBotForAssertiveSpeech interrupts queued playback even when botTurnOpen already reset", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  let streamDestroyed = false;
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: false,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: minBytes + 2_400,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null
        }
      ]
    ]),
    audioPlayer: {
      stop(force) {
        stopCalls.push(force);
      }
    },
    botAudioStream: {
      writableLength: DISCORD_PCM_FRAME_BYTES * 4,
      destroy() {
        streamDestroyed = true;
      }
    }
  });

  const interrupted = manager.maybeInterruptBotForAssertiveSpeech({
    session,
    userId: "user-1",
    source: "test_queued_audio"
  });
  assert.equal(interrupted, true);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0], true);
  assert.equal(streamDestroyed, true);
  assert.equal(session.botAudioStream, null);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.source, "test_queued_audio");
});

test("interruptBotSpeechForBargeIn truncates OpenAI assistant audio to played duration", () => {
  const { manager, logs } = createManager();
  const truncateCalls = [];
  const streamBytes = DISCORD_PCM_FRAME_BYTES * 5;
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 12,
      utteranceText: "continuation"
    },
    lastOpenAiAssistantAudioItemId: "item_abc",
    lastOpenAiAssistantAudioItemContentIndex: 0,
    lastOpenAiAssistantAudioItemReceivedMs: 2000,
    audioPlayer: {
      stop() {}
    },
    botAudioStream: {
      writableLength: streamBytes,
      destroy() {}
    },
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      },
      truncateConversationItem(payload) {
        truncateCalls.push(payload);
        return true;
      }
    }
  });

  const interrupted = manager.interruptBotSpeechForBargeIn({
    session,
    userId: "user-1",
    source: "truncate_test"
  });

  assert.equal(interrupted, true);
  assert.equal(truncateCalls.length, 1);
  assert.equal(truncateCalls[0]?.itemId, "item_abc");
  assert.equal(truncateCalls[0]?.contentIndex, 0);
  // 2000ms received - 100ms unplayed (5 frames * 20ms) = 1900ms
  assert.equal(truncateCalls[0]?.audioEndMs, 1900);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.truncateAttempted, true);
  assert.equal(interruptLog?.metadata?.truncateSucceeded, true);
});

test("armAssertiveBargeIn schedules interrupt checks while buffered playback remains", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: false,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: DISCORD_PCM_FRAME_BYTES * 20,
          signalSampleCount: 24_000,
          signalActiveSampleCount: 1_680,
          signalPeakAbs: 5_400,
          speakingEndFinalizeTimer: null,
          bargeInAssertTimer: null
        }
      ]
    ]),
    botAudioStream: {
      writableLength: DISCORD_PCM_FRAME_BYTES * 8,
      destroyed: false,
      writableEnded: false,
      destroy() {}
    }
  });

  const callArgs = [];
  manager.maybeInterruptBotForAssertiveSpeech = (args) => {
    callArgs.push(args);
    return true;
  };

  manager.armAssertiveBargeIn({
    session,
    userId: "user-1",
    source: "queued_playback",
    delayMs: 20
  });

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(callArgs.length, 1);
  assert.equal(callArgs[0]?.source, "queued_playback");
  assert.equal(callArgs[0]?.userId, "user-1");
  const capture = session.userCaptures.get("user-1");
  assert.equal(capture?.bargeInAssertTimer, null);
});

test("isCaptureEligibleForActivityTouch requires both speech window and non-silent signal", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });
  const minSpeechBytes = Math.max(2, Math.ceil((24_000 * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000));

  const underWindowCapture = {
    bytesSent: Math.max(2, minSpeechBytes - 2),
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureEligibleForActivityTouch({
      session,
      capture: underWindowCapture
    }),
    false
  );

  const nearSilentCapture = {
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 120,
    signalPeakAbs: 150
  };
  assert.equal(
    manager.isCaptureEligibleForActivityTouch({
      session,
      capture: nearSilentCapture
    }),
    false
  );

  const speechLikeCapture = {
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureEligibleForActivityTouch({
      session,
      capture: speechLikeCapture
    }),
    true
  );
});

test("bindSessionHandlers does not touch activity on speaking.start before speech is confirmed", () => {
  const { manager, touchCalls } = createManager();
  const speaking = new EventEmitter();
  const connectionStateEmitter = new EventEmitter();
  const startCalls = [];
  const bargeCalls = [];
  manager.startInboundCapture = (payload) => {
    startCalls.push(payload);
  };
  manager.armAssertiveBargeIn = (payload) => {
    bargeCalls.push(payload);
  };

  const session = createSession({
    cleanupHandlers: [],
    connection: {
      receiver: { speaking },
      on: connectionStateEmitter.on.bind(connectionStateEmitter),
      off: connectionStateEmitter.off.bind(connectionStateEmitter)
    }
  });

  manager.bindSessionHandlers(session, session.settingsSnapshot);
  speaking.emit("start", "speaker-1");

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.userId, "speaker-1");
  assert.equal(bargeCalls.length, 1);
  assert.equal(touchCalls.length, 0);
});

test("bindSessionHandlers does not restart per-user OpenAI ASR on repeated speaking.start for same capture", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const speaking = new EventEmitter();
  const connectionStateEmitter = new EventEmitter();
  const beginCalls = [];
  manager.beginOpenAiAsrUtterance = (payload) => {
    beginCalls.push(payload);
  };
  manager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };
  manager.armAssertiveBargeIn = () => {};

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        brainProvider: "anthropic"
      }
    },
    connection: {
      receiver: { speaking },
      on: connectionStateEmitter.on.bind(connectionStateEmitter),
      off: connectionStateEmitter.off.bind(connectionStateEmitter)
    }
  });

  manager.bindSessionHandlers(session, session.settingsSnapshot);
  speaking.emit("start", "speaker-1");
  speaking.emit("start", "speaker-1");

  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-1");
});

test("bindSessionHandlers starts shared OpenAI ASR only for the first concurrent speaker", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const speaking = new EventEmitter();
  const connectionStateEmitter = new EventEmitter();
  const beginCalls = [];
  let activeAsrUserId = null;
  manager.beginOpenAiSharedAsrUtterance = (payload) => {
    beginCalls.push(payload);
    if (activeAsrUserId && activeAsrUserId !== payload.userId) return false;
    activeAsrUserId = payload.userId;
    return true;
  };
  manager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };
  manager.armAssertiveBargeIn = () => {};

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        brainProvider: "anthropic",
        realtimeReplyStrategy: "brain",
        openaiRealtime: {
          usePerUserAsrBridge: false
        }
      }
    },
    connection: {
      receiver: { speaking },
      on: connectionStateEmitter.on.bind(connectionStateEmitter),
      off: connectionStateEmitter.off.bind(connectionStateEmitter)
    }
  });

  manager.bindSessionHandlers(session, session.settingsSnapshot);
  speaking.emit("start", "speaker-1");
  speaking.emit("start", "speaker-2");

  assert.equal(beginCalls.length, 2);
  assert.equal(beginCalls[0]?.userId, "speaker-1");
  assert.equal(beginCalls[1]?.userId, "speaker-2");
});

test("shared ASR hands off to waiting speaker after commit", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls = [];
  const appendCalls = [];
  let activeAsrUserId = null;
  manager.beginOpenAiSharedAsrUtterance = (payload) => {
    beginCalls.push(payload);
    activeAsrUserId = payload.userId;
    return true;
  };
  manager.appendAudioToOpenAiSharedAsr = (payload) => {
    appendCalls.push(payload);
    return true;
  };
  manager.scheduleOpenAiSharedAsrSessionIdleClose = () => {};
  manager.shouldUseOpenAiSharedTranscription = () => true;

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      userId: null,
      client: null,
      closing: false,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      isCommittingAsr: false
    }
  });

  const pcmA = Buffer.alloc(960, 1);
  const pcmB = Buffer.alloc(960, 2);
  session.userCaptures.set("speaker-2", {
    userId: "speaker-2",
    bytesSent: pcmA.length + pcmB.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [pcmA, pcmB],
    speakingEndFinalizeTimer: null
  });

  const result = manager.tryHandoffSharedAsrToWaitingCapture({
    session,
    settings: session.settingsSnapshot
  });

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-2");
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[0]?.userId, "speaker-2");
  assert.deepEqual(appendCalls[0]?.pcmChunk, pcmA);
  assert.deepEqual(appendCalls[1]?.pcmChunk, pcmB);
  const handoffLog = logs.find((l) => l?.content === "openai_shared_asr_handoff");
  assert.equal(Boolean(handoffLog), true);
  assert.equal(handoffLog?.userId, "speaker-2");
});

test("shared ASR handoff skipped when no waiting captures", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls = [];
  manager.beginOpenAiSharedAsrUtterance = (payload) => {
    beginCalls.push(payload);
    return true;
  };
  manager.shouldUseOpenAiSharedTranscription = () => true;

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      userId: null,
      client: null,
      closing: false,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      isCommittingAsr: false
    }
  });

  const result = manager.tryHandoffSharedAsrToWaitingCapture({
    session,
    settings: session.settingsSnapshot
  });

  assert.equal(result, false);
  assert.equal(beginCalls.length, 0);
});

test("shared ASR handoff skips captures that already had ASR audio", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls = [];
  const appendCalls = [];
  manager.beginOpenAiSharedAsrUtterance = (payload) => {
    beginCalls.push(payload);
    return true;
  };
  manager.appendAudioToOpenAiSharedAsr = (payload) => {
    appendCalls.push(payload);
    return true;
  };
  manager.scheduleOpenAiSharedAsrSessionIdleClose = () => {};
  manager.shouldUseOpenAiSharedTranscription = () => true;

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      userId: null,
      client: null,
      closing: false,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      isCommittingAsr: false
    }
  });

  session.userCaptures.set("speaker-already-had-asr", {
    userId: "speaker-already-had-asr",
    bytesSent: 4800,
    sharedAsrBytesSent: 4800,
    pcmChunks: [Buffer.alloc(960, 3)],
    speakingEndFinalizeTimer: null
  });
  const freshPcm = Buffer.alloc(960, 4);
  session.userCaptures.set("speaker-fresh", {
    userId: "speaker-fresh",
    bytesSent: freshPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [freshPcm],
    speakingEndFinalizeTimer: null
  });

  const result = manager.tryHandoffSharedAsrToWaitingCapture({
    session,
    settings: session.settingsSnapshot
  });

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-fresh");
  assert.equal(appendCalls.length, 1);
  assert.deepEqual(appendCalls[0]?.pcmChunk, freshPcm);
});

test("shared ASR handoff skips zero-audio captures and selects buffered speaker", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls = [];
  const appendCalls = [];
  manager.beginOpenAiSharedAsrUtterance = (payload) => {
    beginCalls.push(payload);
    return true;
  };
  manager.appendAudioToOpenAiSharedAsr = (payload) => {
    appendCalls.push(payload);
    return true;
  };
  manager.shouldUseOpenAiSharedTranscription = () => true;

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      userId: null,
      client: null,
      closing: false,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      isCommittingAsr: false
    }
  });

  session.userCaptures.set("speaker-empty", {
    userId: "speaker-empty",
    bytesSent: 0,
    sharedAsrBytesSent: 0,
    pcmChunks: [],
    speakingEndFinalizeTimer: null
  });
  const bufferedPcm = Buffer.alloc(960, 7);
  session.userCaptures.set("speaker-buffered", {
    userId: "speaker-buffered",
    bytesSent: bufferedPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [bufferedPcm],
    speakingEndFinalizeTimer: null
  });

  const result = manager.tryHandoffSharedAsrToWaitingCapture({
    session,
    settings: session.settingsSnapshot
  });

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-buffered");
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0]?.userId, "speaker-buffered");
  assert.deepEqual(appendCalls[0]?.pcmChunk, bufferedPcm);
  const handoffLog = logs.find((l) => l?.content === "openai_shared_asr_handoff");
  assert.equal(handoffLog?.userId, "speaker-buffered");
});

test("shared ASR committed events resolve waiters by commit user instead of FIFO", () => {
  const { manager } = createManager();
  const resolvedItemIds = [];
  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      userId: null,
      client: null,
      closing: false,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      isCommittingAsr: false,
      itemIdToUserId: new Map(),
      finalTranscriptsByItemId: new Map(),
      pendingCommitResolvers: [],
      pendingCommitRequests: []
    }
  });
  const asrState = session.openAiSharedAsrState;
  asrState.pendingCommitResolvers.push({
    id: "waiter-speaker-2",
    userId: "speaker-2",
    resolve: (itemId) => {
      resolvedItemIds.push(String(itemId || ""));
    }
  });
  asrState.pendingCommitRequests.push({
    id: "request-speaker-1",
    userId: "speaker-1",
    requestedAt: Date.now()
  });

  manager.trackOpenAiSharedAsrCommittedItem({
    asrState,
    itemId: "item-speaker-1"
  });

  assert.deepEqual(resolvedItemIds, []);
  assert.equal(asrState.pendingCommitResolvers.length, 1);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-1"), "speaker-1");

  asrState.pendingCommitRequests.push({
    id: "request-speaker-2",
    userId: "speaker-2",
    requestedAt: Date.now()
  });
  manager.trackOpenAiSharedAsrCommittedItem({
    asrState,
    itemId: "item-speaker-2"
  });

  assert.deepEqual(resolvedItemIds, ["item-speaker-2"]);
  assert.equal(asrState.pendingCommitResolvers.length, 0);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-2"), "speaker-2");
});

test("maybeHandleInterruptedReplyRecovery retries short barge-ins with the prior utterance", () => {
  const { manager, logs } = createManager();
  const retryCalls = [];
  manager.requestRealtimeTextUtterance = (payload) => {
    retryCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    pendingBargeInRetry: {
      utteranceText: "let me finish this thought",
      interruptedByUserId: "user-1",
      interruptedAt: Date.now() - 400,
      source: "test",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1"
      }
    }
  });

  const shortBargePcm = Buffer.alloc(24_000 * 2, 0);
  const handled = manager.maybeHandleInterruptedReplyRecovery({
    session,
    userId: "user-1",
    pcmBuffer: shortBargePcm,
    captureReason: "stream_end"
  });

  assert.equal(handled, true);
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0]?.text, "let me finish this thought");
  assert.equal(retryCalls[0]?.source, "barge_in_retry");
  assert.equal(session.pendingBargeInRetry, null);
  const retryLog = logs.find((entry) => entry?.content === "voice_barge_in_retry_requested");
  assert.equal(Boolean(retryLog), true);
});

test("maybeHandleInterruptedReplyRecovery treats long barge-ins as full override and reconsiders transcript", () => {
  const { manager, logs } = createManager();
  const retryCalls = [];
  manager.requestRealtimeTextUtterance = (payload) => {
    retryCalls.push(payload);
    return true;
  };

  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    pendingBargeInRetry: {
      utteranceText: "do not replay when fully barged in",
      interruptedByUserId: "user-1",
      interruptedAt: Date.now() - 400,
      source: "test",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1"
      }
    }
  });

  const longBargePcm = Buffer.alloc(Math.ceil((24_000 * 2 * (BARGE_IN_FULL_OVERRIDE_MIN_MS + 250)) / 1000), 0);
  const handled = manager.maybeHandleInterruptedReplyRecovery({
    session,
    userId: "user-1",
    pcmBuffer: longBargePcm,
    captureReason: "stream_end"
  });

  assert.equal(handled, false);
  assert.equal(retryCalls.length, 0);
  assert.equal(session.pendingBargeInRetry, null);
  const skipLog = logs.find((entry) => entry?.content === "voice_barge_in_retry_skipped_full_override");
  assert.equal(Boolean(skipLog), true);
});

test("enqueueDiscordPcmForPlayback pre-buffers then activates idle player", () => {
  const { manager } = createManager();
  const playCalls = [];
  let writeCalls = 0;
  const stream = createBotAudioPlaybackStream();
  const originalWrite = stream.write.bind(stream);
  stream.write = (...args) => {
    writeCalls += 1;
    return originalWrite(...args);
  };

  const session = createSession({
    audioPlayer: {
      state: {
        status: "idle"
      },
      play(resource) {
        playCalls.push(resource);
        this.state.status = "playing";
      }
    },
    connection: {
      subscribe() {}
    },
    botAudioStream: stream
  });

  // A single frame (1 Opus packet) doesn't meet the pre-buffer threshold.
  manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES, 5)
  });
  assert.equal(writeCalls, 1);
  assert.equal(playCalls.length, 0, "player should not activate below pre-buffer threshold");

  // Writing enough frames to meet the threshold triggers activation.
  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 5, 5)
  });
  assert.equal(queued, true);
  assert.equal(writeCalls, 2);
  assert.equal(playCalls.length, 1, "player should activate once queue reaches threshold");
  stream.destroy();
});

test("enqueueDiscordPcmForPlayback resets stream when overflow threshold exceeded", () => {
  const { manager } = createManager();
  let streamDestroyed = false;
  const session = createSession({
    audioPlayer: {
      state: { status: "playing" },
      play() {}
    },
    connection: {
      subscribe() {}
    },
    botAudioStream: {
      writableLength: AUDIO_PLAYBACK_STREAM_OVERFLOW_BYTES + 1,
      destroy() { streamDestroyed = true; },
      write: () => true
    }
  });

  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES, 5)
  });

  assert.equal(queued, true);
  assert.equal(streamDestroyed, true);
});

test("queueRealtimeTurnFromAsrBridge falls back to PCM when ASR transcript is empty", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime"
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 6);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, false);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.pcmBuffer, pcmBuffer);
  assert.equal(queuedTurns[0]?.captureReason, "stream_end");
  const fallbackLog = logs.find((entry) => entry?.content === "openai_realtime_asr_bridge_fallback_pcm");
  assert.equal(Boolean(fallbackLog), true);
  assert.equal(fallbackLog?.metadata?.source, "per_user");
});

test("queueRealtimeTurnFromAsrBridge forwards receive_error fallback audio when capture is sizable", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });

  const droppedNearSilence = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(DISCORD_PCM_FRAME_BYTES, 2),
    captureReason: "near_silence_early_abort",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });
  const droppedReceiveError = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 2),
    captureReason: "receive_error",
    finalizedAt: Date.now(),
    asrResult: null,
    source: "per_user_error"
  });
  const droppedTinyClip = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.alloc(1600, 2),
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: ""
    },
    source: "per_user"
  });

  assert.equal(droppedNearSilence, false);
  assert.equal(droppedReceiveError, false);
  assert.equal(droppedTinyClip, false);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.pcmBuffer?.length, DISCORD_PCM_FRAME_BYTES * 2);
  assert.equal(queuedTurns[0]?.captureReason, "receive_error");
  const droppedLogs = logs.filter((entry) => entry?.content === "openai_realtime_asr_bridge_fallback_dropped");
  assert.equal(droppedLogs.length, 2);
  const fallbackLog = logs.find((entry) => entry?.content === "openai_realtime_asr_bridge_fallback_pcm");
  assert.equal(Boolean(fallbackLog), true);
  assert.equal(fallbackLog?.metadata?.captureReason, "receive_error");
});

test("queueRealtimeTurnFromAsrBridge forwards transcript metadata when ASR transcript exists", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });
  const pcmBuffer = Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 4);

  const usedTranscript = manager.queueRealtimeTurnFromAsrBridge({
    session,
    userId: "speaker-1",
    pcmBuffer,
    captureReason: "speaking_end",
    finalizedAt: Date.now(),
    asrResult: {
      transcript: "hello from asr",
      asrStartedAtMs: 1000,
      asrCompletedAtMs: 1125,
      transcriptionModelPrimary: "gpt-4o-mini-transcribe",
      transcriptionModelFallback: "whisper-1",
      transcriptionPlanReason: "openai_realtime_per_user_transcription",
      usedFallbackModel: true
    },
    source: "per_user"
  });

  assert.equal(usedTranscript, true);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.transcriptOverride, "hello from asr");
  assert.equal(queuedTurns[0]?.transcriptionModelPrimaryOverride, "gpt-4o-mini-transcribe");
  assert.equal(queuedTurns[0]?.transcriptionModelFallbackOverride, "whisper-1");
  assert.equal(queuedTurns[0]?.transcriptionPlanReasonOverride, "openai_realtime_per_user_transcription");
  assert.equal(queuedTurns[0]?.usedFallbackModelForTranscriptOverride, true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_fallback_pcm"), false);
});

test("enqueueDiscordPcmForPlayback interrupts bot output when stream would overflow", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];
  let streamDestroyed = false;

  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: DISCORD_PCM_FRAME_BYTES * 12,
          signalSampleCount: 32_000,
          signalActiveSampleCount: 2_100,
          signalPeakAbs: 6_200
        }
      ]
    ]),
    audioPlayer: {
      state: { status: "playing" },
      stop(force) { stopCalls.push(force); }
    },
    connection: { subscribe() {} },
    botAudioStream: {
      writableLength: AUDIO_PLAYBACK_STREAM_OVERFLOW_BYTES - DISCORD_PCM_FRAME_BYTES,
      write() { return true; },
      destroy() { streamDestroyed = true; }
    },
    pendingResponse: {
      requestId: 17,
      requestedAt: Date.now() - 600,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    }
  });

  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 2)
  });

  assert.equal(queued, false);
  assert.equal(session.botTurnOpen, false);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0], true);
  assert.equal(streamDestroyed, true);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.source, "stream_overflow_guard");
});

test("enqueueDiscordPcmForPlayback does not interrupt for near-silent active capture", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];

  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([
      [
        "user-1",
        {
          bytesSent: DISCORD_PCM_FRAME_BYTES * 12,
          signalSampleCount: 32_000,
          signalActiveSampleCount: 220,
          signalPeakAbs: 180
        }
      ]
    ]),
    audioPlayer: {
      state: { status: "playing" },
      stop(force) { stopCalls.push(force); }
    },
    connection: { subscribe() {} },
    botAudioStream: {
      writableLength: AUDIO_PLAYBACK_STREAM_OVERFLOW_BYTES - DISCORD_PCM_FRAME_BYTES,
      write() { return true; },
      destroy() {}
    }
  });

  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 2)
  });

  assert.equal(queued, true);
  assert.equal(session.botTurnOpen, true);
  assert.equal(stopCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("enqueueDiscordPcmForPlayback overflow guard respects interruption policy speaker lock", () => {
  const { manager, logs } = createManager();
  const stopCalls = [];

  const session = createSession({
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "user-1"
    },
    userCaptures: new Map([
      [
        "user-2",
        {
          bytesSent: DISCORD_PCM_FRAME_BYTES * 40,
          signalSampleCount: 32_000,
          signalActiveSampleCount: 2_500,
          signalPeakAbs: 7_000
        }
      ]
    ]),
    audioPlayer: {
      state: { status: "playing" },
      stop(force) { stopCalls.push(force); }
    },
    connection: { subscribe() {} },
    botAudioStream: {
      writableLength: AUDIO_PLAYBACK_STREAM_OVERFLOW_BYTES - DISCORD_PCM_FRAME_BYTES,
      write() { return true; },
      destroy() {}
    }
  });

  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES * 2, 2)
  });

  assert.equal(queued, true);
  assert.equal(session.botTurnOpen, true);
  assert.equal(stopCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_barge_in_interrupt"), false);
});

test("enqueueDiscordPcmForPlayback lazily creates stream when botAudioStream is destroyed", () => {
  const { manager } = createManager();
  const session = createSession({
    audioPlayer: {
      state: { status: "idle" },
      play() { this.state.status = "playing"; }
    },
    connection: { subscribe() {} },
    botAudioStream: {
      destroyed: true,
      writableEnded: false,
      writableLength: 0
    }
  });

  const queued = manager.enqueueDiscordPcmForPlayback({
    session,
    discordPcm: Buffer.alloc(DISCORD_PCM_FRAME_BYTES, 3)
  });

  assert.equal(queued, true);
  assert.equal(Boolean(session.botAudioStream), true);
  assert.equal(session.botAudioStream.destroyed, false);
  session.botAudioStream.destroy();
});

test("bindBotAudioStreamLifecycle records stream close event", () => {
  const { manager, logs } = createManager();
  const stream = new PassThrough();
  const session = createSession();

  manager.bindBotAudioStreamLifecycle(session, {
    stream,
    source: "test_bind"
  });
  stream.emit("close");

  const lifecycleLog = logs.find(
    (entry) => entry?.content === "bot_audio_stream_lifecycle" && entry?.metadata?.source === "test_bind"
  );
  assert.equal(Boolean(lifecycleLog), true);
  assert.equal(lifecycleLog?.metadata?.event, "close");
});

test("bindBotAudioStreamLifecycle logs close event without auto-repair", () => {
  const { manager, logs } = createManager();
  const stream = new PassThrough();
  const session = createSession({
    botAudioStream: stream,
    botTurnOpen: false,
    pendingResponse: null,
    audioPlayer: {
      state: { status: "playing" },
      play() {}
    },
    connection: { subscribe() {} }
  });

  manager.bindBotAudioStreamLifecycle(session, {
    stream,
    source: "test_idle_close"
  });
  stream.emit("close");

  assert.equal(logs.some((entry) => entry?.content === "bot_audio_stream_lifecycle"), true);
  // Simplified lifecycle no longer attempts auto-repair
  assert.equal(logs.some((entry) => entry?.content === "bot_audio_stream_lifecycle_repair_attempted"), false);
});

test("bindBotAudioStreamLifecycle logs error event on stream", () => {
  const { manager, logs } = createManager();
  const stream = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    closed: false,
    writableLength: 0,
    destroy(error = null) {
      this.destroyed = true;
      if (error) this.emit("error", error);
      this.closed = true;
      this.emit("close");
    }
  });
  const session = createSession({
    botAudioStream: stream,
    botTurnOpen: true,
    pendingResponse: { requestId: 42 },
    audioPlayer: {
      state: { status: "playing" },
      play() {}
    },
    connection: { subscribe() {} }
  });

  manager.bindBotAudioStreamLifecycle(session, {
    stream,
    source: "test_active_error"
  });
  stream.destroy(new Error("Premature close"));

  const errorLog = logs.find(
    (entry) => entry?.content === "bot_audio_stream_lifecycle" && entry?.metadata?.event === "error"
  );
  assert.equal(Boolean(errorLog), true);
  assert.equal(errorLog?.metadata?.error, "Premature close");
});

test("evaluateVoiceThoughtLoopGate waits for silence window and queue cooldown", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 5_000,
    lastThoughtAttemptAt: 0
  });

  const blockedBySilence = manager.evaluateVoiceThoughtLoopGate({
    session,
    settings: {
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    },
    now
  });
  assert.equal(blockedBySilence.allow, false);
  assert.equal(blockedBySilence.reason, "silence_window_not_met");

  const allowed = manager.evaluateVoiceThoughtLoopGate({
    session: {
      ...session,
      lastActivityAt: now - 25_000
    },
    settings: {
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    },
    now
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, "ok");
});

test("maybeRunVoiceThoughtLoop speaks approved thought candidates", async () => {
  const { manager } = createManager();
  const now = Date.now();
  const settings = {
    botName: "clanker conk",
    voice: {
      enabled: true,
      replyEagerness: 100,
      thoughtEngine: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        eagerness: 100,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  };
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: now - 25_000,
    settingsSnapshot: settings
  });

  const scheduledDelays = [];
  manager.scheduleVoiceThoughtLoop = ({ delayMs }) => {
    scheduledDelays.push(delayMs);
  };
  manager.generateVoiceThoughtCandidate = async () => "did you know octopuses have three hearts";
  manager.evaluateVoiceThoughtDecision = async () => ({
    allow: true,
    reason: "llm_yes"
  });
  let delivered = 0;
  manager.deliverVoiceThoughtCandidate = async () => {
    delivered += 1;
    return true;
  };

  const originalRandom = Math.random;
  Math.random = () => 0.01;
  try {
    const ran = await manager.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, true);
    assert.equal(delivered, 1);
    assert.equal(session.lastThoughtSpokenAt > 0, true);
    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], 20_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("maybeRunVoiceThoughtLoop skips generation when eagerness probability roll fails", async () => {
  const { manager } = createManager();
  const settings = {
    botName: "clanker conk",
    voice: {
      enabled: true,
      replyEagerness: 10,
      thoughtEngine: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        eagerness: 10,
        minSilenceSeconds: 20,
        minSecondsBetweenThoughts: 20
      }
    }
  };
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: Date.now() - 25_000,
    settingsSnapshot: settings
  });

  manager.scheduleVoiceThoughtLoop = () => {};
  manager.generateVoiceThoughtCandidate = async () => {
    throw new Error("thought generation should not run when probability gate fails");
  };

  const originalRandom = Math.random;
  Math.random = () => 0.95;
  try {
    const ran = await manager.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger: "test"
    });
    assert.equal(ran, false);
    assert.equal(session.lastThoughtAttemptAt > 0, true);
  } finally {
    Math.random = originalRandom;
  }
});

test("requestStatus reports offline and online states", async () => {
  const { manager, messages } = createManager();

  const offline = await manager.requestStatus({
    message: createMessage(),
    settings: { voice: { enabled: true } }
  });
  assert.equal(offline, true);
  assert.equal(messages.at(-1)?.reason, "offline");

  manager.sessions.set(
    "guild-1",
    createSession({
      userCaptures: new Map([
        ["user-a", {}],
        ["user-b", {}]
      ]),
      streamWatch: {
        active: true,
        targetUserId: "user-a",
        requestedByUserId: "user-mod",
        lastFrameAt: Date.now() - 1_000,
        lastCommentaryAt: Date.now() - 2_000,
        ingestedFrameCount: 3
      },
      music: {
        active: true,
        provider: "youtube",
        lastTrackTitle: "lone star",
        lastTrackArtists: ["artist a"]
      }
    })
  );

  const online = await manager.requestStatus({
    message: createMessage({
      content: "clankie r u in vc rn?"
    }),
    settings: null
  });
  assert.equal(online, true);
  assert.equal(messages.at(-1)?.reason, "online");
  assert.equal(messages.at(-1)?.details?.activeCaptures, 2);
  assert.equal(messages.at(-1)?.details?.streamWatchActive, true);
  assert.equal(messages.at(-1)?.details?.musicActive, true);
  assert.equal(messages.at(-1)?.details?.musicProvider, "youtube");
  assert.equal(messages.at(-1)?.details?.musicTrackTitle, "lone star");
  assert.deepEqual(messages.at(-1)?.details?.musicTrackArtists, ["artist a"]);
  assert.equal(messages.at(-1)?.details?.requestText, "clankie r u in vc rn?");
});

test("getReplyOutputLockState locks output while music playback is active", () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      active: true
    }
  });

  const lockState = manager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "music_playback_active");
  assert.equal(lockState.musicActive, true);
});

test("maybeHandleMusicTextStopRequest routes stop phrase from text chat", async () => {
  const { manager } = createManager();
  const stopCalls = [];
  manager.requestStopMusic = async (payload) => {
    stopCalls.push(payload);
    return true;
  };
  manager.sessions.set(
    "guild-1",
    createSession({
      music: {
        active: true
      }
    })
  );

  const handled = await manager.maybeHandleMusicTextStopRequest({
    message: createMessage({
      content: "clank stop music"
    }),
    settings: null
  });
  assert.equal(handled, true);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0]?.reason, "text_music_stop_failsafe");
});

test("maybeHandleMusicTextSelectionRequest routes numeric disambiguation picks", async () => {
  const { manager } = createManager();
  const playCalls = [];
  manager.requestPlayMusic = async (payload) => {
    playCalls.push(payload);
    return true;
  };
  manager.sessions.set(
    "guild-1",
    createSession({
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          },
          {
            id: "youtube:def222",
            title: "all caps",
            artist: "madvillain",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=def222",
            durationSeconds: 150
          }
        ]
      }
    })
  );

  const handled = await manager.maybeHandleMusicTextSelectionRequest({
    message: createMessage({
      content: "2"
    }),
    settings: null
  });
  assert.equal(handled, true);
  assert.equal(playCalls.length, 1);
  assert.equal(playCalls[0]?.trackId, "youtube:def222");
  assert.equal(playCalls[0]?.reason, "text_music_disambiguation_selection");
});

test("requestLeave sends not_in_voice or ends active session", async () => {
  const { manager, messages, endCalls } = createManager();

  const withoutSession = await manager.requestLeave({
    message: createMessage(),
    settings: {}
  });
  assert.equal(withoutSession, true);
  assert.equal(messages.at(-1)?.reason, "not_in_voice");

  manager.sessions.set("guild-1", createSession());
  const withSession = await manager.requestLeave({
    message: createMessage(),
    settings: {},
    reason: "manual_leave"
  });
  assert.equal(withSession, true);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]?.reason, "manual_leave");
});

test("withJoinLock serializes join operations per guild key", async () => {
  const { manager } = createManager();
  const order = [];

  const first = manager.withJoinLock("guild-1", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
    return "first";
  });
  const second = manager.withJoinLock("guild-1", async () => {
    order.push("second:run");
    return "second";
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second:run"]);
  assert.equal(manager.joinLocks.size, 0);
});

test("reconcileSettings ends blocked sessions and touches allowed sessions", async () => {
  const { manager, endCalls, touchCalls } = createManager();

  manager.sessions.set(
    "guild-blocked",
    createSession({
      guildId: "guild-blocked",
      voiceChannelId: "voice-blocked"
    })
  );
  manager.sessions.set(
    "guild-allowed",
    createSession({
      guildId: "guild-allowed",
      voiceChannelId: "voice-allowed"
    })
  );
  manager.sessions.set(
    "guild-not-allowlisted",
    createSession({
      guildId: "guild-not-allowlisted",
      voiceChannelId: "voice-other"
    })
  );

  await manager.reconcileSettings({
    voice: {
      enabled: true,
      blockedVoiceChannelIds: ["voice-blocked"],
      allowedVoiceChannelIds: ["voice-allowed"]
    }
  });

  assert.equal(endCalls.length, 2);
  assert.deepEqual(
    endCalls.map((entry) => entry.reason).sort(),
    ["settings_channel_blocked", "settings_channel_not_allowlisted"]
  );
  assert.equal(touchCalls.length, 1);
  assert.equal(touchCalls[0]?.guildId, "guild-allowed");
});

test("handleVoiceStateUpdate records join/leave membership events and refreshes realtime instructions", async () => {
  const { manager, logs } = createManager();
  const refreshCalls = [];
  manager.scheduleOpenAiRealtimeInstructionRefresh = (payload) => {
    refreshCalls.push(payload);
  };

  const session = createSession({
    mode: "openai_realtime",
    membershipEvents: []
  });
  manager.sessions.set("guild-1", session);

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  await manager.handleVoiceStateUpdate(
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: "voice-1",
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    },
    {
      id: "user-2",
      guild: { id: "guild-1" },
      channelId: null,
      member: {
        user: { bot: false, username: "bob_user" },
        displayName: "bob"
      }
    }
  );

  assert.equal(Array.isArray(session.membershipEvents), true);
  assert.equal(session.membershipEvents.length, 2);
  assert.equal(session.membershipEvents[0]?.eventType, "join");
  assert.equal(session.membershipEvents[1]?.eventType, "leave");
  assert.equal(session.membershipEvents[0]?.displayName, "bob");
  assert.equal(session.membershipEvents[1]?.displayName, "bob");

  assert.equal(refreshCalls.length, 2);
  assert.equal(refreshCalls[0]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[1]?.reason, "voice_membership_changed");
  assert.equal(refreshCalls[0]?.speakerUserId, "user-2");
  assert.equal(refreshCalls[1]?.speakerUserId, "user-2");

  const membershipLogs = logs.filter((entry) => entry?.content === "voice_membership_changed");
  assert.equal(membershipLogs.length, 2);
  assert.equal(membershipLogs[0]?.metadata?.eventType, "join");
  assert.equal(membershipLogs[1]?.metadata?.eventType, "leave");
});

test("dispose detaches handlers and clears join locks", async () => {
  const { manager, offCalls } = createManager();
  manager.joinLocks.set("guild-1", Promise.resolve());
  manager.sessions.set("guild-1", createSession());

  await manager.dispose("shutdown");

  assert.equal(offCalls.includes("voiceStateUpdate"), true);
  assert.equal(manager.joinLocks.size, 0);
});
