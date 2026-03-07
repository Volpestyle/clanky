import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { CaptureManager } from "./captureManager.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createTestSettings } from "../testSettings.ts";
import {
  SYSTEM_SPEECH_OPPORTUNITY,
  SYSTEM_SPEECH_SOURCE
} from "./systemSpeechOpportunity.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  BARGE_IN_FULL_OVERRIDE_MIN_MS,
  BARGE_IN_MIN_SPEECH_MS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_TURN_PROMOTION_MIN_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import {
  beginAsrUtterance,
  commitAsrUtterance,
  getOrCreatePerUserAsrState,
  getOrCreateSharedAsrState,
  trackSharedAsrCommittedItem,
  tryHandoffSharedAsr
} from "./voiceAsrBridge.ts";
import type { AsrBridgeState } from "./voiceAsrBridge.ts";
import type { CaptureState, VoiceSession } from "./voiceSessionTypes.ts";

// Discord sends 48kHz stereo 16-bit PCM in 20ms frames = 3840 bytes
const DISCORD_PCM_FRAME_BYTES = 3840;

function makeMonoPcm16(sampleCount: number, amplitude: number) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm.writeInt16LE(amplitude, i * 2);
  }
  return pcm;
}

function makeSparseMonoPcm16(sampleCount: number, amplitude: number, activeEverySamples: number) {
  const pcm = Buffer.alloc(sampleCount * 2);
  const stride = Math.max(1, activeEverySamples);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = i % stride === 0 ? amplitude : 0;
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function seedReadyPerUserAsr(
  manager: VoiceSessionManager,
  session: ReturnType<typeof createSession>,
  userId: string
) {
  const appendedChunks: Buffer[] = [];
  const asrState = getOrCreatePerUserAsrState(session, userId);
  assert.ok(asrState);
  asrState.phase = "ready";
  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm(chunk: Buffer) {
      appendedChunks.push(chunk);
    },
    commitInputAudioBuffer() {}
  };
  return {
    asrState,
    appendedChunks,
    deps: manager.buildAsrBridgeDeps(session)
  };
}

function runSharedAsrHandoff(
  manager: VoiceSessionManager,
  session: ReturnType<typeof createSession>,
  beginCalls: Array<{ userId: string }>,
  appendCalls: Array<{ userId: string; pcmChunk: Buffer }>
) {
  return tryHandoffSharedAsr({
    session,
    asrState: session.openAiSharedAsrState as AsrBridgeState | null,
    deps: manager.buildAsrBridgeDeps(session),
    settings: session.settingsSnapshot,
    beginUtterance: (userId) => {
      beginCalls.push({ userId });
      return true;
    },
    appendAudio: (userId, pcmChunk) => {
      appendCalls.push({ userId, pcmChunk });
      return true;
    },
    releaseUser: () => {}
  });
}

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
    channels: {
      async fetch(channelId) {
        return {
          id: channelId,
          async send() {
            return true;
          }
        };
      }
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
        return createTestSettings({
          botName: "clanker conk",
          voice: {
            replyPath: "brain"
          }
        });
      }
    },
    appConfig: {
      openaiApiKey: "test-openai-key"
    },
    llm: {
      isAsrReady() {
        return true;
      },
      isSpeechSynthesisReady() {
        return true;
      },
      async generate() {
        return {
          text: "NO"
        };
      }
    },
    memory: null
  });

  manager.composeOperationalMessage = async (payload) => {
    messages.push(payload);
    return "ok";
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
      id: "text-1",
      async send() {
        return true;
      }
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
  const session = {
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
      phase: "idle",
      active: false,
      ducked: false,
      pauseReason: null,
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
    openAiToolCallExecutions: new Map(),
    voxClient: null,
    pendingSttTurns: 0,
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
    joinGreetingOpportunity: null,
    joinGreetingTimer: null,
    lastRequestedRealtimeUtterance: null,
    settingsSnapshot: createTestSettings({
      botName: "clanker conk",
      voice: {
        enabled: true,
        replyPath: "brain"
      }
    }),
    ...overrides
  };
  session.settingsSnapshot = createTestSettings(session.settingsSnapshot || {});
  return session;
}

function createInterruptedReplyAction(overrides = {}) {
  return {
    type: "interrupted_reply",
    goal: "complete_interrupted_reply",
    freshnessPolicy: "retry_then_regenerate",
    status: "scheduled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notBeforeAt: 0,
    expiresAt: Date.now() + 30_000,
    reason: "test",
    revision: 1,
    payload: {
      utteranceText: null,
      interruptedByUserId: null,
      interruptedAt: Date.now(),
      source: "voice_reply",
      interruptionPolicy: null
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
        lastCommentaryNote: "wild clutch moment on screen",
        lastMemoryRecapAt: now - 1_000,
        lastMemoryRecapText: "Streamer recently screen-shared a combat HUD and minimap pressure.",
        lastMemoryRecapDurableSaved: true,
        lastMemoryRecapReason: "share_page_stop",
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
  assert.equal(realtime?.streamWatch?.lastCommentaryNote, "wild clutch moment on screen");
  assert.equal(realtime?.streamWatch?.lastMemoryRecapText, "Streamer recently screen-shared a combat HUD and minimap pressure.");
  assert.equal(realtime?.streamWatch?.lastMemoryRecapDurableSaved, true);
  assert.equal(realtime?.streamWatch?.lastMemoryRecapReason, "share_page_stop");
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

test("shouldBargeIn requires sustained capture bytes", () => {
  const { manager } = createManager();
  const captureState = {
    bytesSent: 4_000,
    startedAt: Date.now() - 2_000,
    speakingEndFinalizeTimer: null,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400
  };
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: true,
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn ignores non-target speaker under assertive reply policy", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
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
    userCaptures: new Map([["user-2", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-2", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn blocks all interruptions when reply targets ALL", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    botTurnOpen: true,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "none",
      allowedUserId: null,
      talkingTo: "ALL",
      reason: "assistant_target_all",
      source: "test"
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn allows barge-in after assertive speech", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 9,
      requestedAt: Date.now() - 1200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, true);
  assert.equal(typeof result.minCaptureBytes, "number");
  assert.ok(result.minCaptureBytes > 0);
});

test("shouldBargeIn ignores near-silent captures", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 120,
    signalPeakAbs: 220,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    botTurnOpen: true,
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn does not interrupt music-only playback lock", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "openai_realtime",
    playerState: "playing",
    music: {
      phase: "playing",
      active: true,
      ducked: false,
      pauseReason: null,
      startedAt: Date.now() - 5_000,
      stoppedAt: 0,
      provider: "discord",
      source: "voice_tool_call",
      lastTrackId: "youtube:test",
      lastTrackTitle: "test track",
      lastTrackArtists: ["artist"],
      lastTrackUrl: "https://example.com",
      lastQuery: "test track",
      lastRequestedByUserId: "user-1",
      lastRequestText: "play test track",
      lastCommandAt: Date.now() - 5_000,
      lastCommandReason: "voice_tool_music_play",
      pendingQuery: null,
      pendingPlatform: "auto",
      pendingResults: [],
      pendingRequestedByUserId: null,
      pendingRequestedAt: 0
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn ignores buffered subprocess playback after live deltas stop", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 2_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: false,
    lastAudioDeltaAt: Date.now() - 2_000,
    pendingResponse: {
      requestId: 22,
      requestedAt: Date.now() - 500,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: Date.now() - 200
    },
    voxClient: {
      ttsBufferDepthSamples: 48_000
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("shouldBargeIn requires minimum capture age for STT pipeline", () => {
  const { manager } = createManager();
  const minBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  const captureState = {
    bytesSent: minBytes + 2_400,
    startedAt: Date.now() - 100,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_680,
    signalPeakAbs: 5_400,
    speakingEndFinalizeTimer: null
  };
  const session = createSession({
    mode: "stt_pipeline",
    botTurnOpen: true,
    pendingResponse: {
      requestId: 30,
      requestedAt: Date.now() - 200,
      retryCount: 0,
      hardRecoveryAttempted: false,
      source: "turn_flush",
      handlingSilence: false,
      audioReceivedAt: 0
    },
    userCaptures: new Map([["user-1", captureState]])
  });

  const result = manager.bargeInController.shouldBargeIn({ session, userId: "user-1", captureState });
  assert.equal(result.allowed, false);
});

test("interruptBotSpeechForBargeIn truncates OpenAI assistant audio to played duration", () => {
  const { manager, logs } = createManager();
  const truncateCalls = [];
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
  // Subprocess manages stream buffer; streamBufferedBytes is always 0
  assert.equal(truncateCalls[0]?.audioEndMs, 2000);
  const interruptLog = logs.find((entry) => entry?.content === "voice_barge_in_interrupt");
  assert.equal(Boolean(interruptLog), true);
  assert.equal(interruptLog?.metadata?.truncateAttempted, true);
  assert.equal(interruptLog?.metadata?.truncateSucceeded, true);
});

test("isCaptureConfirmedLiveSpeech requires both speech window and non-silent signal", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000
  });
  const minSpeechBytes = Math.max(2, Math.ceil((24_000 * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000));

  const underWindowCapture = {
    promotedAt: Date.now(),
    bytesSent: Math.max(2, minSpeechBytes - 2),
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: underWindowCapture
    }),
    false
  );

  const nearSilentCapture = {
    promotedAt: Date.now(),
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 120,
    signalPeakAbs: 150
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: nearSilentCapture
    }),
    false
  );

  const speechLikeCapture = {
    promotedAt: Date.now(),
    bytesSent: minSpeechBytes + 2,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_000,
    signalPeakAbs: 6_000
  };
  assert.equal(
    manager.isCaptureConfirmedLiveSpeech({
      session,
      capture: speechLikeCapture
    }),
    true
  );
});

test("bindSessionHandlers does not touch activity on speaking.start before speech is confirmed", () => {
  const { manager, touchCalls } = createManager();
  const voxClient = new EventEmitter();
  const startCalls = [];
  manager.captureManager.startInboundCapture = (payload) => {
    startCalls.push(payload);
  };

  const session = createSession({
    cleanupHandlers: [],
    voxClient,
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true
      }
    }
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.userId, "speaker-1");
  assert.equal(touchCalls.length, 0);
});

test("startInboundCapture drops provisional noise before activity promotion while streaming provisional ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const noisePcm = makeMonoPcm16(Math.ceil((24_000 * VOICE_SILENCE_GATE_MIN_CLIP_MS) / 1000), 64);
  voxClient.emit("userAudio", "speaker-1", noisePcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  capture.finalize("stream_end");

  assert.ok(Number(capture.asrUtteranceId || 0) > 0);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], noisePcm);
  assert.equal(touchCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_activity_started"), false);
  assert.equal(logs.some((entry) => entry?.content === "voice_turn_dropped_provisional_capture"), true);
  assert.equal(session.userCaptures.has("speaker-1"), false);
});

test("startInboundCapture promotes strong local speech while streaming per-user ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const speechPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", speechPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.asrUtteranceId, asrState.utterance.id);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], speechPcm);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "strong_local_audio");
  assert.equal(touchCalls.length, 1);
  const activityLog = logs.find((entry) => entry?.content === "voice_activity_started");
  assert.ok(activityLog);
  assert.equal(activityLog?.userId, "speaker-1");
});

test("startInboundCapture promotes modest speech once server VAD confirms the provisional capture", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.hasCaptureServerVadSpeech = () => true;
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const speechPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 700);
  voxClient.emit("userAudio", "speaker-1", speechPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.asrUtteranceId, asrState.utterance.id);
  assert.equal(appendedChunks.length, 1);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "server_vad_confirmed");
  assert.equal(touchCalls.length, 1);
  const activityLog = logs.find((entry) => entry?.content === "voice_activity_started");
  assert.ok(activityLog);
  assert.equal(activityLog?.metadata?.promotionServerVadConfirmed, true);
});

test("startInboundCapture keeps sparse spike noise provisional even while streaming provisional ASR audio", async () => {
  const { manager, logs, touchCalls } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });
  const { asrState, appendedChunks } = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const noisyPcm = makeSparseMonoPcm16(
    Math.ceil((24_000 * VOICE_TURN_PROMOTION_MIN_CLIP_MS) / 1000),
    1024,
    60
  );
  voxClient.emit("userAudio", "speaker-1", noisyPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(Number(capture.promotedAt || 0), 0);
  capture.finalize("stream_end");

  assert.ok(Number(capture.asrUtteranceId || 0) > 0);
  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], noisyPcm);
  assert.equal(touchCalls.length, 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_activity_started"), false);
  assert.equal(logs.some((entry) => entry?.content === "voice_turn_dropped_provisional_capture"), true);
});

test("bindSessionHandlers does not duplicate provisional capture creation for repeated speaking.start", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const voxClient = new EventEmitter();
  manager.captureManager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic"
      }
    },
    voxClient
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");
  voxClient.emit("speakingStart", "speaker-1");

  assert.equal(session.userCaptures.size, 1);
});

test("commitAsrUtterance marks per-user commit in-flight before awaiting connect", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    openAiAsrTranscriptStableMs: 1,
    openAiAsrTranscriptWaitMaxMs: 1
  });
  const userId = "speaker-1";
  const asrState = getOrCreatePerUserAsrState(session, userId);
  assert.ok(asrState);
  let clearCalls = 0;
  let commitCalls = 0;
  const client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {
      clearCalls += 1;
    },
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      commitCalls += 1;
    }
  };
  asrState.utterance = {
    id: 1,
    startedAt: Date.now() - 200,
    bytesSent: 9_600,
    partialText: "",
    finalSegments: [],
    finalSegmentEntries: [],
    lastUpdateAt: Date.now() - 10
  };
  asrState.pendingAudioChunks = [{ utteranceId: 1, chunk: Buffer.alloc(9_600, 1) }];
  asrState.pendingAudioBytes = 9_600;

  let resolveConnect: (() => void) | null = null;
  const connectGate = new Promise((resolve) => {
    resolveConnect = () => {
      resolve(undefined);
    };
  });
  asrState.connectPromise = connectGate;

  const commitPromise = commitAsrUtterance(
    "per_user",
    manager.buildAsrBridgeDeps(session),
    session.settingsSnapshot,
    userId,
    "speaking_end"
  );

  assert.equal(asrState.phase, "committing");
  assert.equal(asrState.committingUtteranceId, 1);

  beginAsrUtterance("per_user", session, manager.buildAsrBridgeDeps(session), session.settingsSnapshot, userId);
  assert.equal(clearCalls, 0);

  asrState.client = client;
  resolveConnect?.();
  await commitPromise;
  assert.equal(commitCalls, 1);
});

test("bindSessionHandlers defers shared OpenAI ASR start until speech is confirmed", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const voxClient = new EventEmitter();
  manager.captureManager.startInboundCapture = ({ session, userId }) => {
    if (!session.userCaptures.has(userId)) {
      session.userCaptures.set(userId, {
        speakingEndFinalizeTimer: null
      });
    }
  };

  const session = createSession({
    mode: "openai_realtime",
    cleanupHandlers: [],
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        asrEnabled: true,
        brainProvider: "anthropic",
        replyPath: "brain",
        openaiRealtime: {
          usePerUserAsrBridge: false
        }
      }
    },
    voxClient
  });

  manager.sessionLifecycle.bindSessionHandlers(session, session.settingsSnapshot);
  voxClient.emit("speakingStart", "speaker-1");
  voxClient.emit("speakingStart", "speaker-2");

  assert.equal(session.openAiSharedAsrState == null, true);
  assert.equal(session.userCaptures.size, 2);
});

test("shared ASR hands off to waiting speaker after commit", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  const pcmA = Buffer.alloc(960, 1);
  const pcmB = Buffer.alloc(960, 2);
  session.userCaptures.set("speaker-2", {
    userId: "speaker-2",
    promotedAt: Date.now(),
    bytesSent: pcmA.length + pcmB.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [pcmA, pcmB],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

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
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, false);
  assert.equal(beginCalls.length, 0);
  assert.equal(appendCalls.length, 0);
});

test("shared ASR handoff skips provisional captures that never promoted", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-provisional", {
    userId: "speaker-provisional",
    promotedAt: 0,
    bytesSent: 960,
    sharedAsrBytesSent: 0,
    pcmChunks: [Buffer.alloc(960, 7)],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, false);
  assert.equal(beginCalls.length, 0);
  assert.equal(appendCalls.length, 0);
});

test("shared ASR handoff skips captures that already had ASR audio", () => {
  const { manager } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-already-had-asr", {
    userId: "speaker-already-had-asr",
    promotedAt: Date.now(),
    bytesSent: 4800,
    sharedAsrBytesSent: 4800,
    pcmChunks: [Buffer.alloc(960, 3)],
    speakingEndFinalizeTimer: null
  });
  const freshPcm = Buffer.alloc(960, 4);
  session.userCaptures.set("speaker-fresh", {
    userId: "speaker-fresh",
    promotedAt: Date.now(),
    bytesSent: freshPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [freshPcm],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

  assert.equal(result, true);
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0]?.userId, "speaker-fresh");
  assert.equal(appendCalls.length, 1);
  assert.deepEqual(appendCalls[0]?.pcmChunk, freshPcm);
});

test("shared ASR handoff skips zero-audio captures and selects buffered speaker", () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  const beginCalls: Array<{ userId: string }> = [];
  const appendCalls: Array<{ userId: string; pcmChunk: Buffer }> = [];

  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0
    }
  });

  session.userCaptures.set("speaker-empty", {
    userId: "speaker-empty",
    promotedAt: Date.now(),
    bytesSent: 0,
    sharedAsrBytesSent: 0,
    pcmChunks: [],
    speakingEndFinalizeTimer: null
  });
  const bufferedPcm = Buffer.alloc(960, 7);
  session.userCaptures.set("speaker-buffered", {
    userId: "speaker-buffered",
    promotedAt: Date.now(),
    bytesSent: bufferedPcm.length,
    sharedAsrBytesSent: 0,
    pcmChunks: [bufferedPcm],
    speakingEndFinalizeTimer: null
  });

  const result = runSharedAsrHandoff(manager, session, beginCalls, appendCalls);

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
  createManager();
  const resolvedItemIds = [];
  const session = createSession({
    mode: "openai_realtime",
    openAiSharedAsrState: {
      phase: "ready",
      userId: null,
      client: null,
      utterance: null,
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
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

  trackSharedAsrCommittedItem(asrState as AsrBridgeState, "item-speaker-1");

  assert.deepEqual(resolvedItemIds, []);
  assert.equal(asrState.pendingCommitResolvers.length, 1);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-1"), "speaker-1");

  asrState.pendingCommitRequests.push({
    id: "request-speaker-2",
    userId: "speaker-2",
    requestedAt: Date.now()
  });
  trackSharedAsrCommittedItem(asrState as AsrBridgeState, "item-speaker-2");

  assert.deepEqual(resolvedItemIds, ["item-speaker-2"]);
  assert.equal(asrState.pendingCommitResolvers.length, 0);
  assert.equal(asrState.itemIdToUserId.get("item-speaker-2"), "speaker-2");
});

test("commitAsrUtterance (shared) preserves already-received final segments when commit item is empty", async () => {
  const logs: Record<string, unknown>[] = [];
  let commitCalls = 0;

  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    // Set very short wait times so the test doesn't block on commit/transcript polling
    openAiAsrTranscriptStableMs: 10,
    openAiAsrTranscriptWaitMaxMs: 50,
    openAiSharedAsrState: {
      phase: "ready",
      userId: "speaker-1",
      client: {
        ws: { readyState: 1 },
        commitInputAudioBuffer() {
          commitCalls += 1;
        }
      },
      connectPromise: null,
      connectedAt: Date.now(),
      lastAudioAt: 0,
      lastTranscriptAt: 0,
      lastPartialLogAt: 0,
      lastPartialText: "",
      idleTimer: null,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      committingUtteranceId: 0,
      pendingCommitResolvers: [],
      pendingCommitRequests: [],
      itemIdToUserId: new Map(),
      finalTranscriptsByItemId: new Map(),
      utterance: {
        id: 1,
        startedAt: Date.now() - 1_000,
        bytesSent: DISCORD_PCM_FRAME_BYTES * 2,
        partialText: "",
        finalSegments: ["What's goin'?"],
        finalSegmentEntries: [
          {
            itemId: "item_1",
            previousItemId: null,
            text: "What's goin'?",
            receivedAt: Date.now() - 300
          }
        ],
        lastUpdateAt: Date.now() - 300
      }
    }
  });

  const deps = {
    session,
    appConfig: { openaiApiKey: "test-openai-key" },
    store: {
      logAction(entry: Record<string, unknown>) { logs.push(entry); },
      getSettings() { return session.settingsSnapshot; }
    },
    botUserId: "bot-user",
    resolveVoiceSpeakerName: () => "speaker-1"
  };

  const result = await commitAsrUtterance("shared", deps, session.settingsSnapshot, "speaker-1", "stream_end");

  assert.equal(commitCalls, 1);
  assert.equal(result?.transcript, "What's goin'?");
  assert.equal(logs.some((entry) => entry?.content === "voice_realtime_transcription_empty"), false);
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
    deferredVoiceActions: {
      interrupted_reply: {
        type: "interrupted_reply",
        goal: "complete_interrupted_reply",
        freshnessPolicy: "retry_then_regenerate",
        status: "deferred",
        createdAt: Date.now() - 400,
        updatedAt: Date.now() - 400,
        notBeforeAt: 0,
        expiresAt: Date.now() + 5_000,
        reason: "barge_in_interrupt",
        revision: 1,
        payload: {
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
  assert.equal(Boolean(session.deferredVoiceActions?.interrupted_reply), false);
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
    deferredVoiceActions: {
      interrupted_reply: {
        type: "interrupted_reply",
        goal: "complete_interrupted_reply",
        freshnessPolicy: "retry_then_regenerate",
        status: "deferred",
        createdAt: Date.now() - 400,
        updatedAt: Date.now() - 400,
        notBeforeAt: 0,
        expiresAt: Date.now() + 5_000,
        reason: "barge_in_interrupt",
        revision: 1,
        payload: {
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
  assert.equal(Boolean(session.deferredVoiceActions?.interrupted_reply), false);
  const skipLog = logs.find((entry) => entry?.content === "voice_barge_in_retry_skipped_full_override");
  assert.equal(Boolean(skipLog), true);
});

test("playVoiceReplyInOrder does not fallback to TTS when realtime utterance fails", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  let ttsCalls = 0;

  manager.requestRealtimeTextUtterance = () => false;
  manager.speakVoiceLineWithTts = async () => {
    ttsCalls += 1;
    return true;
  };

  const result = await manager.playVoiceReplyInOrder({
    session,
    settings: session.settingsSnapshot,
    spokenText: "hello there",
    playbackSteps: [
      {
        type: "speech",
        text: "hello there"
      }
    ],
    source: "test_reply",
    preferRealtimeUtterance: true
  });

  assert.equal(result.completed, false);
  assert.equal(result.requestedRealtimeUtterance, false);
  assert.equal(result.spokeLine, false);
  assert.equal(ttsCalls, 0);
});

test("deliverVoiceThoughtCandidate does not fallback to TTS in realtime mode", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  let ttsCalls = 0;

  manager.requestRealtimeTextUtterance = () => false;
  manager.speakVoiceLineWithTts = async () => {
    ttsCalls += 1;
    return true;
  };

  const delivered = await manager.deliverVoiceThoughtCandidate({
    session,
    settings: session.settingsSnapshot,
    thoughtCandidate: "ambient thought"
  });

  assert.equal(delivered, false);
  assert.equal(ttsCalls, 0);
});

test("announceVoiceWebLookupBusy skips TTS fallback in realtime mode", async () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  let ttsCalls = 0;

  manager.requestRealtimePromptUtterance = () => false;
  manager.requestRealtimeTextUtterance = () => false;
  manager.generateVoiceLookupBusyLine = async () => "still looking";
  manager.speakVoiceLineWithTts = async () => {
    ttsCalls += 1;
    return true;
  };

  await manager.announceVoiceWebLookupBusy({
    session,
    settings: session.settingsSnapshot,
    userId: "user-1",
    query: "what happened"
  });

  assert.equal(ttsCalls, 0);
});

test("queueRealtimeTurnFromAsrBridge drops empty ASR transcript instead of queueing PCM", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
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
  assert.equal(queuedTurns.length, 0);
  const droppedLog = logs.find((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped");
  assert.equal(Boolean(droppedLog), true);
  assert.equal(droppedLog?.metadata?.source, "per_user");
  assert.equal(droppedLog?.metadata?.pcmBytes, pcmBuffer.length);
});

test("queueRealtimeTurnFromAsrBridge refires pending join greeting through brain strategy after empty ASR drop", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  const createdResponses = [];
  const brainReplies = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.replyManager.createTrackedAudioResponse = (payload) => {
    createdResponses.push(payload);
    return true;
  };
  manager.runRealtimeBrainReply = async (payload) => {
    brainReplies.push(payload);
    return true;
  };
  const session = createSession({
    mode: "openai_realtime",
    playbackArmed: true,
    startedAt: Date.now() - 2_000,
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        replyPath: "brain"
      }
    },
    joinGreetingOpportunity: {
      trigger: "capture_resolved",
      armedAt: Date.now() - 1_000,
      fireAt: Date.now() - 500,
      expiresAt: Date.now() + 5_000
    },
    lastOpenAiRealtimeInstructions: "ready",
    lastAssistantReplyAt: 0,
    userCaptures: new Map()
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
  assert.equal(queuedTurns.length, 0);
  assert.equal(createdResponses.length, 0);
  assert.equal(brainReplies.length, 1);
  assert.equal(brainReplies[0]?.source, SYSTEM_SPEECH_SOURCE.JOIN_GREETING);
  assert.equal(
    String(brainReplies[0]?.transcript || "").includes("Join greeting opportunity."),
    true
  );
  assert.equal(String(brainReplies[0]?.transcript || "").includes("[SKIP]"), false);
  assert.equal(brainReplies[0]?.inputKind, "event");
  assert.equal(brainReplies[0]?.forceSpokenOutput, true);
  assert.equal(session.joinGreetingOpportunity, null);
  assert.equal(Number(session.lastAssistantReplyAt || 0), 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_join_greeting_fired"), true);
  const firedLog = logs.find((entry) => entry?.content === "voice_join_greeting_fired");
  assert.equal(firedLog?.metadata?.strategy, "brain");
});

test("queueRealtimeTurnFromAsrBridge refires pending join greeting through native strategy after empty ASR drop", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  const createdResponses = [];
  const brainReplies = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
    queuedTurns.push(payload);
  };
  manager.replyManager.createTrackedAudioResponse = (payload) => {
    createdResponses.push(payload);
    return true;
  };
  manager.runRealtimeBrainReply = async (payload) => {
    brainReplies.push(payload);
    return true;
  };
  const session = createSession({
    mode: "openai_realtime",
    playbackArmed: true,
    startedAt: Date.now() - 2_000,
    settingsSnapshot: {
      botName: "clanker conk",
      voice: {
        enabled: true,
        replyPath: "native"
      }
    },
    joinGreetingOpportunity: {
      trigger: "capture_resolved",
      armedAt: Date.now() - 1_000,
      fireAt: Date.now() - 500,
      expiresAt: Date.now() + 5_000
    },
    lastOpenAiRealtimeInstructions: "ready",
    lastAssistantReplyAt: 0,
    userCaptures: new Map()
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
  assert.equal(queuedTurns.length, 0);
  assert.equal(createdResponses.length, 1);
  assert.equal(createdResponses[0]?.source, SYSTEM_SPEECH_SOURCE.JOIN_GREETING);
  assert.equal(brainReplies.length, 0);
  assert.equal(session.joinGreetingOpportunity, null);
  assert.equal(Number(session.lastAssistantReplyAt || 0), 0);
  assert.equal(logs.some((entry) => entry?.content === "voice_join_greeting_fired"), true);
  const firedLog = logs.find((entry) => entry?.content === "voice_join_greeting_fired");
  assert.equal(firedLog?.metadata?.strategy, "native");
});

test("createTrackedAudioResponse clears join greeting opportunity when newer bot speech starts", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    joinGreetingOpportunity: {
      trigger: "capture_resolved",
      armedAt: Date.now() - 1_000,
      fireAt: Date.now() - 500,
      expiresAt: Date.now() + 5_000
    }
  });

  const created = manager.replyManager.createTrackedAudioResponse({
    session,
    source: "openai_realtime_text_turn",
    emitCreateEvent: false
  });

  assert.equal(created, true);
  assert.equal(session.joinGreetingOpportunity, null);
  manager.replyManager.clearPendingResponse(session);
});

test("cancelPendingSystemSpeechForUserSpeech clears pre-audio join greeting response", () => {
  const { manager, logs } = createManager();
  const cancelCalls = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    lastAudioDeltaAt: 0,
    pendingResponse: {
      requestId: 7,
      requestedAt: Date.now() + 5_000,
      source: `${SYSTEM_SPEECH_SOURCE.JOIN_GREETING}:speech_1`,
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "yo",
      latencyContext: null,
      userId: null,
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  const promotedAt = Date.now();
  const capture = {
    userId: "speaker-1",
    startedAt: promotedAt - 420,
    promotedAt,
    bytesSent: 24_000,
    signalSampleCount: 12_000,
    signalActiveSampleCount: 6_000,
    signalPeakAbs: 12_000,
    signalSumSquares: 12_000 * 12_000 * 12_000
  };

  const cancelled = manager.cancelPendingSystemSpeechForUserSpeech({
    session,
    userId: "speaker-1",
    captureState: capture,
    source: "capture_promoted",
    now: promotedAt
  });

  assert.equal(cancelled, true);
  assert.equal(session.pendingResponse, null);
  assert.equal(cancelCalls.length, 1);
  const cancelLog = logs.find((entry) => entry?.content === "voice_system_speech_cancelled_for_user_speech");
  assert.ok(cancelLog);
  assert.equal(cancelLog?.metadata?.pendingSource, `${SYSTEM_SPEECH_SOURCE.JOIN_GREETING}:speech_1`);
  assert.equal(cancelLog?.metadata?.opportunityType, SYSTEM_SPEECH_OPPORTUNITY.JOIN_GREETING);
  assert.equal(Boolean(cancelLog?.metadata?.responseCancelAttempted), true);
});

test("cancelPendingSystemSpeechForUserSpeech clears pre-audio thought response", () => {
  const { manager, logs } = createManager();
  const cancelCalls = [];
  const session = createSession({
    mode: "openai_realtime",
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    lastAudioDeltaAt: 0,
    pendingResponse: {
      requestId: 11,
      requestedAt: Date.now() + 5_000,
      source: SYSTEM_SPEECH_SOURCE.THOUGHT,
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: null,
      utteranceText: "wild thought",
      latencyContext: null,
      userId: null,
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  const promotedAt = Date.now();
  const capture = {
    userId: "speaker-1",
    startedAt: promotedAt - 420,
    promotedAt,
    bytesSent: 24_000,
    signalSampleCount: 12_000,
    signalActiveSampleCount: 6_000,
    signalPeakAbs: 12_000,
    signalSumSquares: 12_000 * 12_000 * 12_000
  };

  const cancelled = manager.cancelPendingSystemSpeechForUserSpeech({
    session,
    userId: "speaker-1",
    captureState: capture,
    source: "capture_promoted",
    now: promotedAt
  });

  assert.equal(cancelled, true);
  assert.equal(session.pendingResponse, null);
  assert.equal(cancelCalls.length, 1);
  const cancelLog = logs.find((entry) => entry?.content === "voice_system_speech_cancelled_for_user_speech");
  assert.ok(cancelLog);
  assert.equal(cancelLog?.metadata?.pendingSource, SYSTEM_SPEECH_SOURCE.THOUGHT);
  assert.equal(cancelLog?.metadata?.opportunityType, SYSTEM_SPEECH_OPPORTUNITY.THOUGHT);
  assert.equal(Boolean(cancelLog?.metadata?.responseCancelAttempted), true);
});

test("buildRealtimeInstructions does not inject join greeting prompt even when opportunity is armed", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime",
    startedAt: Date.now() - 2_000,
    joinGreetingOpportunity: {
      trigger: "capture_resolved",
      armedAt: Date.now() - 1_500,
      fireAt: Date.now() - 500,
      expiresAt: Date.now() + 5_000
    }
  });

  const instructions = manager.instructionManager.buildRealtimeInstructions({
    session,
    settings: session.settingsSnapshot,
    speakerUserId: null,
    transcript: "",
    memorySlice: null
  });

  assert.equal(instructions.includes("Re-evaluate whether a brief casual greeting still fits right now."), false);
  assert.equal(instructions.includes("You just joined this voice channel."), false);
});

test("queueRealtimeTurnFromAsrBridge drops empty ASR transcript for all capture reasons", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
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
  assert.equal(queuedTurns.length, 0);
  const droppedLogs = logs.filter((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped");
  assert.equal(droppedLogs.length, 3);
  assert.equal(droppedLogs.some((entry) => entry?.metadata?.captureReason === "receive_error"), true);
});

test("queueRealtimeTurnFromAsrBridge forwards transcript metadata when ASR transcript exists", () => {
  const { manager, logs } = createManager();
  const queuedTurns = [];
  manager.turnProcessor.queueRealtimeTurn = (payload) => {
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
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), false);
});

test("shared ASR bridge forwards recovered transcript after timeout instead of discarding it", async () => {
  const { manager, logs } = createManager();
  manager.appConfig.openaiApiKey = "test-openai-key";
  manager.shouldUseSharedTranscription = () => true;
  manager.evaluatePcmSilenceGate = () => ({
    drop: false,
    clipDurationMs: 480,
    rms: 0.2,
    peak: 0.4,
    activeSampleRatio: 0.4
  });
  manager.maybeHandleInterruptedReplyRecovery = () => false;

  const bridgedTurns = [];
  manager.queueRealtimeTurnFromAsrBridge = (payload) => {
    bridgedTurns.push(payload);
    return true;
  };

  const settings = createTestSettings({
    botName: "clanker conk",
    llm: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voice: {
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge",
        usePerUserAsrBridge: false
      }
    }
  });
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    cleanupHandlers: [],
    settingsSnapshot: settings,
    voxClient
  });

  const pcmBuffer = makeMonoPcm16(
    Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 80)) / 1000),
    3000
  );
  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings
  });

  const sharedAsrState = getOrCreateSharedAsrState(session);
  assert.ok(sharedAsrState);
  sharedAsrState.phase = "ready";
  sharedAsrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {
      setTimeout(() => {
        sharedAsrState.utterance.finalSegments = ["can i show you my screen?"];
        sharedAsrState.utterance.lastUpdateAt = Date.now();
      }, 750);
    }
  };
  voxClient.emit("userAudio", "speaker-1", pcmBuffer);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.ok(Number(capture.sharedAsrBytesSent || 0) > 0);
  const captureManager = manager.captureManager as CaptureManager & {
    runAsrBridgeCommit(args: {
      session: VoiceSession;
      userId: string;
      settings?: Record<string, unknown> | null;
      captureState: CaptureState;
      pcmBuffer: Buffer;
      captureReason: string;
      finalizedAt: number;
      useOpenAiPerUserAsr: boolean;
      useOpenAiSharedAsr: boolean;
    }): Promise<void>;
  };
  await captureManager.runAsrBridgeCommit({
    session,
    userId: "speaker-1",
    settings,
    captureState: capture,
    pcmBuffer,
    captureReason: "stream_end",
    finalizedAt: Date.now(),
    useOpenAiPerUserAsr: false,
    useOpenAiSharedAsr: true
  });

  assert.equal(bridgedTurns.length, 1);
  assert.equal(bridgedTurns[0]?.source, "shared");
  assert.equal(bridgedTurns[0]?.asrResult?.transcript, "can i show you my screen?");
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_timeout_fallback"), true);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_late_result_ignored"), false);
  assert.equal(logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"), false);
});

test("evaluateVoiceThoughtLoopGate waits for silence window and queue cooldown", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 5_000,
    lastThoughtAttemptAt: 0
  });

  const blockedBySilence = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session,
    settings: createTestSettings({
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });
  assert.equal(blockedBySilence.allow, false);
  assert.equal(blockedBySilence.reason, "silence_window_not_met");

  const allowed = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session: {
      ...session,
      lastActivityAt: now - 25_000
    },
    settings: createTestSettings({
      voice: {
        replyEagerness: 100,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, "ok");
});

test("evaluateVoiceThoughtLoopGate blocks thoughts in command-only mode", () => {
  const { manager } = createManager();
  const now = Date.now();
  const session = createSession({
    lastActivityAt: now - 25_000,
    lastThoughtAttemptAt: 0
  });

  const blocked = manager.thoughtEngine.evaluateVoiceThoughtLoopGate({
    session,
    settings: createTestSettings({
      voice: {
        commandOnlyMode: true,
        thoughtEngine: {
          enabled: true,
          eagerness: 100,
          minSilenceSeconds: 20,
          minSecondsBetweenThoughts: 20
        }
      }
    }),
    now
  });

  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, "command_only_mode");
});

test("maybeRunVoiceThoughtLoop speaks approved thought candidates", async () => {
  const { manager } = createManager();
  const now = Date.now();
  const settings = createTestSettings({
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
  });
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: now - 25_000,
    settingsSnapshot: settings
  });

  const scheduledDelays = [];
  manager.thoughtEngine.scheduleVoiceThoughtLoop = ({ delayMs }) => {
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
    const ran = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
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
  const settings = createTestSettings({
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
  });
  const session = createSession({
    mode: "stt_pipeline",
    lastActivityAt: Date.now() - 25_000,
    settingsSnapshot: settings
  });

  manager.thoughtEngine.scheduleVoiceThoughtLoop = () => {};
  manager.generateVoiceThoughtCandidate = async () => {
    throw new Error("thought generation should not run when probability gate fails");
  };

  const originalRandom = Math.random;
  Math.random = () => 0.95;
  try {
    const ran = await manager.thoughtEngine.maybeRunVoiceThoughtLoop({
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
      phase: "playing",
      active: true
    }
  });

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "music_playback_active");
  assert.equal(lockState.musicActive, true);
});

test("getReplyOutputLockState does not lock output when music is paused", () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      phase: "paused",
      active: true
    }
  });

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.musicActive, false);
});

test("getReplyOutputLockState locks output while clankvox still has queued speech", () => {
  const { manager } = createManager();
  const session = createSession({
    botTurnOpen: false,
    voxClient: {
      ttsBufferDepthSamples: 24_000,
      getTtsBufferDepthSamples() {
        return this.ttsBufferDepthSamples;
      }
    }
  });

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "bot_audio_buffered");
  assert.equal(lockState.bufferedBotSpeech, true);
});

test("getReplyOutputLockState ignores stale clankvox buffered telemetry", () => {
  const { manager } = createManager();
  const session = createSession({
    botTurnOpen: false,
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

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
});

test("getReplyOutputLockState ignores stale botTurnOpen when no output signals remain", () => {
  const { manager } = createManager();
  const session = createSession({
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - 5_000,
    lastAudioDeltaAt: Date.now() - 5_000
  });

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
  assert.equal(lockState.botTurnOpen, true);
});

test("getOutputChannelState mirrors lock state for music playback", () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      phase: "playing",
      active: true
    }
  });

  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.locked, true);
  assert.equal(outputChannelState.lockReason, "music_playback_active");
  assert.equal(outputChannelState.musicActive, true);
  assert.equal(outputChannelState.deferredBlockReason, null);
});

test("getOutputChannelState surfaces deferred blockers and turn backlog", () => {
  const { manager } = createManager();
  const session = createSession({
    pendingSttTurns: 2,
    awaitingToolOutputs: true,
    openAiToolCallExecutions: new Map([["call-1", Promise.resolve()]]),
    userCaptures: new Map([[
      "user-a",
      {
        userId: "user-a",
        bytesSent: 0,
        signalSampleCount: 0,
        speakingEndFinalizeTimer: null
      }
    ]])
  });

  const outputChannelState = manager.getOutputChannelState(session);
  assert.equal(outputChannelState.captureBlocking, true);
  assert.equal(outputChannelState.turnBacklog, 2);
  assert.equal(outputChannelState.awaitingToolOutputs, true);
  assert.equal(outputChannelState.toolCallsRunning, true);
  assert.equal(outputChannelState.deferredBlockReason, "active_captures");
});

test("getReplyOutputLockState clears stale active realtime response once playback is idle", () => {
  const { manager, logs } = createManager();
  let activeResponse = true;
  const session = createSession({
    mode: "openai_realtime",
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

  const lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
  assert.ok(
    logs.some((entry) => entry.content === "openai_realtime_active_response_cleared_stale"),
    "expected stale active-response recovery log"
  );
});

test("bindVoxHandlers tracks explicit tts playback lifecycle from clankvox", () => {
  const { manager } = createManager();
  let playbackState: "idle" | "buffered" = "idle";
  const voxClient = new EventEmitter() as EventEmitter & {
    ttsBufferDepthSamples: number;
    getPlaybackArmedReason: () => string | null;
    getTtsPlaybackState: () => "idle" | "buffered";
    off: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
  };
  voxClient.ttsBufferDepthSamples = 0;
  voxClient.getPlaybackArmedReason = () => null;
  voxClient.getTtsPlaybackState = () => playbackState;
  const session = createSession({
    voxClient
  });

  manager.sessionLifecycle.bindVoxHandlers(session);
  playbackState = "buffered";
  voxClient.emit("ttsPlaybackState", "buffered");

  let lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, true);
  assert.equal(lockState.reason, "bot_audio_buffered");
  assert.equal(lockState.phase, "speaking_buffered");

  playbackState = "idle";
  voxClient.emit("ttsPlaybackState", "idle");
  lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
  assert.equal(lockState.phase, "idle");
});

test("resetBotAudioPlayback clears cached clankvox playback telemetry immediately", () => {
  const { manager } = createManager();
  let playbackState: "idle" | "buffered" = "buffered";
  const voxClient = {
    isAlive: true,
    ttsBufferDepthSamples: 24_000,
    stopPlayback() {},
    clearTtsPlaybackTelemetry() {
      playbackState = "idle";
      voxClient.ttsBufferDepthSamples = 0;
    },
    getTtsPlaybackState() {
      return playbackState;
    }
  };
  const session = createSession({
    voxClient
  });

  let lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.reason, "bot_audio_buffered");

  manager.replyManager.resetBotAudioPlayback(session);
  lockState = manager.replyManager.getReplyOutputLockState(session);
  assert.equal(lockState.locked, false);
  assert.equal(lockState.reason, "idle");
});

test("bot speech music duck helpers use configured gain and release after inactivity", async () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      phase: "playing",
      active: true,
      ducked: false,
      pauseReason: null
    }
  });
  const settings = {
    voice: {
      enabled: true,
      musicDucking: {
        targetGain: 0.22,
        fadeMs: 120
      }
    }
  };
  const duckCalls = [];
  const unduckCalls = [];

  manager.musicPlayer = {
    async duck(options) {
      duckCalls.push(options);
    },
    unduck(options) {
      unduckCalls.push(options);
    }
  };

  const engaged = await manager.engageBotSpeechMusicDuck(session, settings, { awaitFade: true });
  assert.equal(engaged, true);
  assert.equal(session.botSpeechMusicDucked, true);
  assert.equal(session.music.ducked, true);
  assert.deepEqual(duckCalls[0], {
    targetGain: 0.22,
    fadeMs: 120
  });

  manager.scheduleBotSpeechMusicUnduck(session, settings, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(session.botSpeechMusicDucked, false);
  assert.equal(session.music.ducked, false);
  assert.deepEqual(unduckCalls[0], {
    targetGain: 1,
    fadeMs: 120
  });
});

test("scheduleBotSpeechMusicUnduck waits for buffered tts playback to drain", async () => {
  const { manager } = createManager();
  const session = createSession({
    botSpeechMusicDucked: true,
    voxClient: {
      ttsBufferDepthSamples: 24_000
    },
    music: {
      phase: "playing",
      active: true,
      ducked: true,
      pauseReason: null
    }
  });
  const settings = {
    voice: {
      enabled: true,
      musicDucking: {
        targetGain: 0.22,
        fadeMs: 120
      }
    }
  };
  const unduckCalls = [];

  manager.musicPlayer = {
    unduck(options) {
      unduckCalls.push(options);
    }
  };

  manager.scheduleBotSpeechMusicUnduck(session, settings, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unduckCalls.length, 0);

  session.voxClient.ttsBufferDepthSamples = 0;
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(session.botSpeechMusicDucked, false);
  assert.equal(session.music.ducked, false);
  assert.deepEqual(unduckCalls[0], {
    targetGain: 1,
    fadeMs: 120
  });
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

test("maybeHandlePendingMusicDisambiguationTurn ignores non-requesting speakers", async () => {
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
        pendingAction: "play_now",
        pendingRequestedByUserId: "user-1",
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

  const handled = await manager.maybeHandlePendingMusicDisambiguationTurn({
    session: manager.sessions.get("guild-1"),
    settings: null,
    userId: "user-2",
    transcript: "2",
    source: "voice_disambiguation"
  });

  assert.equal(handled, false);
  assert.equal(playCalls.length, 0);
});

test("maybeHandlePendingMusicDisambiguationTurn clears pending state on cancel", async () => {
  const { manager, messages } = createManager();
  manager.sessions.set(
    "guild-1",
    createSession({
      voiceCommandState: {
        userId: "user-1",
        domain: "music",
        intent: "music_disambiguation",
        startedAt: Date.now(),
        expiresAt: Date.now() + 10_000
      },
      music: {
        pendingQuery: "all caps",
        pendingPlatform: "auto",
        pendingAction: "play_now",
        pendingRequestedByUserId: "user-1",
        pendingRequestedAt: Date.now(),
        pendingResults: [
          {
            id: "youtube:abc111",
            title: "all caps",
            artist: "mf doom",
            platform: "youtube",
            externalUrl: "https://youtube.com/watch?v=abc111",
            durationSeconds: 140
          }
        ]
      }
    })
  );

  const session = manager.sessions.get("guild-1");
  const handled = await manager.maybeHandlePendingMusicDisambiguationTurn({
    session,
    settings: null,
    userId: "user-1",
    transcript: "never mind",
    source: "voice_disambiguation",
    mustNotify: true
  });

  assert.equal(handled, true);
  assert.equal(manager.getMusicDisambiguationPromptContext(session), null);
  assert.equal(manager.ensureVoiceCommandState(session), null);
  assert.equal(messages.at(-1)?.reason, "disambiguation_cancelled");
});

test("requestStopMusic clears queue state when clearQueue is true", async () => {
  const { manager } = createManager();
  const session = createSession({
    music: {
      active: true,
      provider: "discord"
    },
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:abc111",
          title: "all caps",
          artist: "mf doom",
          durationMs: 140000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: "https://youtube.com/watch?v=abc111"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    }
  });
  manager.sessions.set("guild-1", session);

  await manager.requestStopMusic({
    guildId: "guild-1",
    requestedByUserId: "user-1",
    settings: null,
    reason: "test_stop",
    source: "test",
    clearQueue: true,
    mustNotify: false
  });

  assert.equal(session.musicQueueState.tracks.length, 0);
  assert.equal(session.musicQueueState.nowPlayingIndex, null);
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

  await manager.reconcileSettings(createTestSettings({
    voice: {
      enabled: true,
      blockedVoiceChannelIds: ["voice-blocked"],
      allowedVoiceChannelIds: ["voice-allowed"]
    }
  }));

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
  manager.instructionManager.scheduleRealtimeInstructionRefresh = (payload) => {
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

// ---------------------------------------------------------------------------
// canFireDeferredAction — generic gating layer
// ---------------------------------------------------------------------------

test("canFireDeferredAction returns null (can fire) when session is valid and output channel is clear", () => {
  const { manager } = createManager();
  const session = createSession({ mode: "openai_realtime" });
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, null);
});

test("canFireDeferredAction returns 'session_inactive' when session is null", () => {
  const { manager } = createManager();
  const result = manager.deferredActionQueue.canFireDeferredAction(null, createInterruptedReplyAction());
  assert.equal(result, "session_inactive");
});

test("canFireDeferredAction returns 'session_inactive' when session.ending is true", () => {
  const { manager } = createManager();
  const session = createSession({ ending: true });
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "session_inactive");
});

test("canFireDeferredAction returns 'no_action' when action is null", () => {
  const { manager } = createManager();
  const session = createSession();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, null);
  assert.equal(result, "no_action");
});

test("canFireDeferredAction returns 'expired' when expiresAt is in the past", () => {
  const { manager } = createManager();
  const session = createSession();
  const action = createInterruptedReplyAction({
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    expiresAt: Date.now() - 1_000
  });
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "expired");
});

test("canFireDeferredAction returns 'not_before_at' when notBeforeAt is in the future", () => {
  const { manager } = createManager();
  const session = createSession();
  const action = createInterruptedReplyAction({
    notBeforeAt: Date.now() + 5_000
  });
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "not_before_at");
});

test("canFireDeferredAction returns 'active_captures' when user captures are in progress", () => {
  const { manager } = createManager();
  const session = createSession();
  session.userCaptures.set("user-1", { startedAt: Date.now() });
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "active_captures");
});

test("canFireDeferredAction ignores silence-only captures for queued user turns", () => {
  const { manager } = createManager();
  const session = createSession({
    mode: "openai_realtime"
  });
  session.userCaptures.set("user-1", {
    userId: "user-1",
    startedAt: Date.now() - 1_000,
    bytesSent: 48_000,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 0,
    signalPeakAbs: 0
  });
  const action = {
    type: "queued_user_turns",
    status: "scheduled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notBeforeAt: 0,
    expiresAt: Date.now() + 30_000,
    reason: "test",
    revision: 1,
    payload: {
      turns: [],
      nextFlushAt: Date.now()
    }
  };

  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, null);
});

test("canFireDeferredAction returns 'pending_response' when session has pendingResponse", () => {
  const { manager } = createManager();
  const session = createSession({ pendingResponse: { id: "resp-1" } });
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "pending_response");
});

test("canFireDeferredAction returns 'active_response' when realtime response is active", () => {
  const { manager } = createManager();
  const session = createSession({ mode: "openai_realtime" });
  manager.replyManager.isRealtimeResponseActive = () => true;
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "active_response");
});

test("canFireDeferredAction returns 'awaiting_tool_outputs' when tools are pending", () => {
  const { manager } = createManager();
  const session = createSession({ awaitingToolOutputs: true });
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "awaiting_tool_outputs");
});

test("canFireDeferredAction returns 'tool_calls_running' when openAiToolCallExecutions is non-empty", () => {
  const { manager } = createManager();
  const session = createSession();
  session.openAiToolCallExecutions = new Map([["call-1", {}]]);
  const action = createInterruptedReplyAction();
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "tool_calls_running");
});

test("canFireDeferredAction treats expiresAt=0 as no expiry", () => {
  const { manager } = createManager();
  const session = createSession();
  const action = createInterruptedReplyAction({
    expiresAt: 0
  });
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, null);
});

test("canFireDeferredAction checks blockers in priority order (captures before pending_response)", () => {
  const { manager } = createManager();
  const session = createSession({ pendingResponse: { id: "resp-1" } });
  session.userCaptures.set("user-1", { startedAt: Date.now() });
  const action = createInterruptedReplyAction();
  // Should return the first blocker hit: active_captures
  const result = manager.deferredActionQueue.canFireDeferredAction(session, action);
  assert.equal(result, "active_captures");
});
