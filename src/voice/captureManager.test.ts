import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { createTestSettings } from "../testSettings.ts";
import {
  BARGE_IN_MIN_SPEECH_MS,
  CAPTURE_MAX_DURATION_MS,
  CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS,
  VOICE_TURN_PROMOTION_MIN_CLIP_MS
} from "./voiceSessionManager.constants.ts";
import { getOrCreatePerUserAsrState } from "./voiceAsrBridge.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

function makeMonoPcm16(sampleCount: number, amplitude: number) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm.writeInt16LE(amplitude, i * 2);
  }
  return pcm;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createManager() {
  const logs: Array<Record<string, unknown>> = [];
  const touchCalls: Array<Record<string, unknown>> = [];

  const manager = new VoiceSessionManager({
    client: {
      on() {},
      off() {},
      channels: { async fetch() { return null; } },
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      user: { id: "bot-user", username: "clanker conk" }
    },
    store: {
      logAction(entry: Record<string, unknown>) {
        logs.push(entry);
      },
      getSettings() {
        return createTestSettings({
          identity: {
            botName: "clanker conk"
          },
          voice: {
            enabled: true,
            conversationPolicy: {
              replyPath: "brain"
            }
          }
        });
      }
    },
    appConfig: { openaiApiKey: "test-openai-key" },
    llm: {
      isAsrReady() {
        return true;
      },
      isSpeechSynthesisReady() {
        return true;
      },
      async generate() {
        return { text: "ok" };
      }
    },
    memory: null
  });

  manager.touchActivity = (guildId, settings) => {
    touchCalls.push({ guildId, settings });
  };
  manager.turnProcessor.queueRealtimeTurn = () => true;
  manager.turnProcessor.queueFileAsrTurn = () => true;

  return { manager, logs, touchCalls };
}

function createSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  const now = Date.now();
  return {
    id: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    requestedByUserId: "user-1",
    mode: "openai_realtime",
    realtimeProvider: "openai",
    realtimeInputSampleRateHz: 24_000,
    realtimeOutputSampleRateHz: 24_000,
    recentVoiceTurns: [],
    transcriptTurns: [],
    modelContextSummary: { generation: null, decider: null },
    voxClient: null,
    realtimeClient: null,
    startedAt: now - 60_000,
    lastActivityAt: now - 2_000,
    maxEndsAt: now + 60_000,
    inactivityEndsAt: now + 60_000,
    maxTimer: null,
    inactivityTimer: null,
    botTurnResetTimer: null,
    botTurnOpen: false,
    bargeInSuppressionUntil: 0,
    bargeInSuppressedAudioChunks: 0,
    bargeInSuppressedAudioBytes: 0,
    lastBotActivityTouchAt: 0,
    responseFlushTimer: null,
    responseWatchdogTimer: null,
    responseDoneGraceTimer: null,
    botDisconnectTimer: null,
    lastResponseRequestAt: 0,
    lastAudioDeltaAt: 0,
    lastAssistantReplyAt: 0,
    lastDirectAddressAt: 0,
    lastDirectAddressUserId: null,
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    lastInboundAudioAt: 0,
    realtimeReplySupersededCount: 0,
    pendingRealtimeInputBytes: 0,
    nextResponseRequestId: 1,
    pendingResponse: null,
    activeReplyInterruptionPolicy: null,
    lastRequestedRealtimeUtterance: null,
    pendingFileAsrTurns: 0,
    fileAsrTurnDrainActive: false,
    pendingFileAsrTurnsQueue: [],
    realtimeTurnDrainActive: false,
    pendingRealtimeTurns: [],
    openAiAsrSessions: new Map(),
    perUserAsrEnabled: false,
    sharedAsrEnabled: false,
    openAiSharedAsrState: null,
    openAiPerUserAsrModel: "",
    openAiPerUserAsrLanguage: "",
    openAiPerUserAsrPrompt: "",
    realtimePendingToolCalls: new Map(),
    realtimeToolCallExecutions: new Map(),
    realtimeToolResponseDebounceTimer: null,
    realtimeCompletedToolCallIds: new Map(),
    lastRealtimeAssistantAudioItemId: null,
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 0,
    realtimeToolDefinitions: [],
    lastRealtimeToolHash: "",
    lastRealtimeToolRefreshAt: 0,
    lastRealtimeToolCallerUserId: null,
    awaitingToolOutputs: false,
    toolCallEvents: [],
    mcpStatus: [],
    toolMusicTrackCatalog: new Map(),
    memoryWriteWindow: [],
    voiceCommandState: null,
    musicQueueState: { tracks: [], cursor: -1, version: 0 },
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
    thoughtLoopTimer: null,
    thoughtLoopBusy: false,
    nextThoughtAt: 0,
    lastThoughtAttemptAt: 0,
    lastThoughtSpokenAt: 0,
    userCaptures: new Map(),
    streamWatch: {
      active: false,
      targetUserId: null,
      requestedByUserId: null,
      channelId: null,
      startedAt: 0,
      commentPending: false,
      lastFrameAt: 0,
      lastCommentaryAt: 0,
      lastCommentaryNote: null,
      lastMemoryRecapAt: 0,
      lastMemoryRecapText: null,
      lastMemoryRecapDurableSaved: false,
      lastMemoryRecapReason: null,
      latestFrameAt: 0,
      latestFrameMimeType: null,
      latestFrameDataBase64: null,
      acceptedFrameCountInWindow: 0,
      frameWindowStartedAt: 0,
      lastBrainContextAt: 0,
      lastBrainContextProvider: null,
      lastBrainContextModel: null,
      brainContextEntries: [],
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
    soundboard: { playCount: 0, lastPlayedAt: 0 },
    latencyStages: [],
    membershipEvents: [],
    baseVoiceInstructions: "",
    lastRealtimeInstructions: "",
    lastRealtimeInstructionsAt: 0,
    realtimeInstructionRefreshTimer: null,
    realtimeTurnContextRefreshState: { pending: false, lastStartedAt: 0, lastCompletedAt: 0, lastSkippedReason: null },
    settingsSnapshot: createTestSettings({
      identity: {
        botName: "clanker conk"
      },
      voice: {
        enabled: true,
        transcription: {
          enabled: true
        },
        conversationPolicy: {
          replyPath: "brain"
        }
      }
    }),
    cleanupHandlers: [],
    ending: false,
    deferredVoiceActions: {},
    deferredVoiceActionTimers: {},
    ...overrides
  } as VoiceSession;
}

function seedReadyPerUserAsr(manager: VoiceSessionManager, session: VoiceSession, userId: string) {
  const asrState = getOrCreatePerUserAsrState(session, userId);
  assert.ok(asrState);
  asrState.phase = "ready";
  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {}
  };
  return asrState;
}

test("resolveCaptureTurnPromotionReason requires matching server VAD utterance id and local thresholds", () => {
  const { manager } = createManager();
  const session = createSession();
  const asrState = seedReadyPerUserAsr(manager, session, "speaker-1");
  const capture = {
    userId: "speaker-1",
    asrUtteranceId: 9,
    bytesSent: Math.ceil((24_000 * 2 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000),
    signalSampleCount: 24_000,
    signalActiveSampleCount: 600,
    signalPeakAbs: 1024,
    signalSumSquares: 0
  };

  asrState.speechDetectedUtteranceId = 8;
  asrState.speechDetectedAt = Date.now();
  assert.equal(manager.resolveCaptureTurnPromotionReason({ session, capture }), null);

  asrState.speechDetectedUtteranceId = 9;
  capture.signalActiveSampleCount = 100;
  capture.signalPeakAbs = 200;
  assert.equal(manager.resolveCaptureTurnPromotionReason({ session, capture }), null);

  capture.signalActiveSampleCount = 600;
  capture.signalPeakAbs = 1024;
  assert.equal(manager.resolveCaptureTurnPromotionReason({ session, capture }), "server_vad_confirmed");
});

test("resolveCaptureTurnPromotionReason allows strong local promotion without server VAD", () => {
  const { manager } = createManager();
  const session = createSession();
  const capture = {
    userId: "speaker-1",
    asrUtteranceId: 0,
    bytesSent: Math.ceil((24_000 * 2 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000),
    signalSampleCount: 24_000,
    signalActiveSampleCount: 2_400,
    signalPeakAbs: 4096,
    signalSumSquares: 24_000 * 1024 * 1024
  };

  assert.equal(manager.resolveCaptureTurnPromotionReason({ session, capture }), "strong_local_audio");
});

test("startInboundCapture keeps local-only promotion from interrupting live bot speech until server VAD confirms", async () => {
  const { manager } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const interruptCalls: Array<Record<string, unknown>> = [];
  manager.interruptBotSpeechForBargeIn = (args) => {
    interruptCalls.push(args);
    return true;
  };

  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const now = Date.now();
  const session = createSession({
    mode: "openai_realtime",
    realtimeInputSampleRateHz: 24_000,
    botTurnOpen: true,
    botTurnOpenAt: now - 2_500,
    assistantOutput: {
      phase: "speaking_live",
      reason: "bot_audio_live",
      phaseEnteredAt: now - 1_000,
      lastSyncedAt: now - 1_000,
      requestId: 12,
      ttsPlaybackState: "playing",
      ttsBufferedSamples: 24_000,
      lastTrigger: "test_seed"
    },
    pendingResponse: {
      requestId: 12,
      requestedAt: now - 3_000,
      source: "voice_reply",
      handlingSilence: false,
      audioReceivedAt: now - 2_000,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "still talking",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    },
    voxClient
  });
  const asrState = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const firstChunk = makeMonoPcm16(
    Math.ceil((24_000 * (BARGE_IN_MIN_SPEECH_MS + 50)) / 1000),
    3000
  );
  voxClient.emit("userAudio", "speaker-1", firstChunk);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.asrUtteranceId, asrState.utterance.id);
  assert.equal(capture.promotionReason, "strong_local_audio");
  assert.equal(interruptCalls.length, 0);

  asrState.speechDetectedUtteranceId = capture.asrUtteranceId;
  asrState.speechDetectedAt = Date.now();

  const followupChunk = makeMonoPcm16(Math.ceil((24_000 * 120) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", followupChunk);
  await flushMicrotasks();

  assert.equal(interruptCalls.length, 1);
});

test("startInboundCapture aborts near-silence captures once they age past the early-abort window", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => false;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({ voxClient });

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  capture.startedAt = Date.now() - CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS - 25;

  const weakPcm = makeMonoPcm16(24_000, 64);
  voxClient.emit("userAudio", "speaker-1", weakPcm);
  await flushMicrotasks();

  assert.equal(session.userCaptures.has("speaker-1"), false);
  const droppedLog = logs.find((entry) => entry?.content === "voice_turn_dropped_provisional_capture");
  assert.ok(droppedLog);
  assert.equal(droppedLog?.metadata?.reason, "near_silence_early_abort");
});

test("startInboundCapture max duration timer finalizes long captures", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => false;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({ mode: "openai_realtime", voxClient });
  const scheduled: Array<{ delay: number; callback: () => void; cleared: boolean }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const record = {
      delay: Number(delay || 0),
      callback: callback as () => void,
      cleared: false
    };
    scheduled.push(record);
    // eslint-disable-next-line no-restricted-syntax
    return record as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    // eslint-disable-next-line no-restricted-syntax
    const record = handle as unknown as { cleared?: boolean };
    record.cleared = true;
  }) as typeof clearTimeout;

  try {
    manager.captureManager.startInboundCapture({
      session,
      userId: "speaker-1",
      settings: session.settingsSnapshot
    });
    const strongPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
    voxClient.emit("userAudio", "speaker-1", strongPcm);
    await flushMicrotasks();

    const maxTimer = scheduled.find((entry) => entry.delay === CAPTURE_MAX_DURATION_MS);
    assert.ok(maxTimer);
    maxTimer.callback();

    assert.equal(session.userCaptures.has("speaker-1"), false);
    const finalizedLog = logs.find((entry) => entry?.content === "voice_turn_finalized");
    assert.ok(finalizedLog);
    assert.equal(finalizedLog?.metadata?.reason, "max_duration");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("startInboundCapture recovers stashed preplay reply when per-user ASR ends empty", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    voxClient,
    supersededPrePlaybackReply: {
      userId: "speaker-1",
      transcript: "That was crazy, man.",
      pcmBuffer: null,
      source: "realtime",
      captureReason: "stream_end",
      directAddressed: false,
      queuedAt: Date.now() - 200,
      interruptionPolicy: null,
      supersededAt: Date.now() - 100,
      supersededByUserId: "speaker-1",
      supersededBySource: "realtime:generation_preflight"
    }
  });
  seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const strongPcm = makeMonoPcm16(
    Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000),
    3000
  );
  voxClient.emit("userAudio", "speaker-1", strongPcm);
  await flushMicrotasks();
  voxClient.emit("userAudioEnd", "speaker-1");
  await new Promise((resolve) => setTimeout(resolve, 2600));

  assert.equal(
    logs.some((entry) => entry?.content === "voice_activity_started"),
    true
  );
  assert.equal(session.supersededPrePlaybackReply, null);
  const queuedTurns = manager.deferredActionQueue.getDeferredQueuedUserTurns(session);
  assert.equal(queuedTurns.length, 1);
  assert.equal(queuedTurns[0]?.transcript, "That was crazy, man.");
  assert.equal(
    logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"),
    true
  );
  assert.equal(
    logs.some((entry) => entry?.content === "voice_preplay_reply_recovered"),
    true
  );
});

test("startInboundCapture replays interrupted assistant speech when per-user ASR ends empty", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const prompts: string[] = [];
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    voxClient,
    realtimeClient: {
      requestTextUtterance(prompt: string) {
        prompts.push(prompt);
      },
      isResponseInProgress() {
        return false;
      }
    },
    interruptedAssistantReply: {
      utteranceText: "no, wait, one more thing",
      interruptedByUserId: "speaker-1",
      interruptedAt: Date.now() - 200,
      source: "barge_in_interrupt",
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      }
    }
  });
  seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const strongPcm = makeMonoPcm16(
    Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000),
    3000
  );
  voxClient.emit("userAudio", "speaker-1", strongPcm);
  await flushMicrotasks();
  voxClient.emit("userAudioEnd", "speaker-1");
  await new Promise((resolve) => setTimeout(resolve, 2600));

  assert.deepEqual(prompts, [
    "Speak this exact line verbatim and nothing else: no, wait, one more thing"
  ]);
  assert.equal(session.pendingResponse?.utteranceText, "no, wait, one more thing");
  assert.equal(
    logs.some((entry) => entry?.content === "openai_realtime_asr_bridge_empty_dropped"),
    true
  );
  assert.equal(
    logs.some((entry) => entry?.content === "voice_interrupted_reply_recovered"),
    true
  );
});

test("server-vad-confirmed capture cancels pending pre-audio normal reply", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const cancelCalls: boolean[] = [];
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    voxClient,
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    pendingResponse: {
      requestId: 7,
      requestedAt: Date.now(),
      source: "realtime:speech_1",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "yo",
      latencyContext: null,
      userId: null,
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  const asrState = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });
  asrState.speechDetectedUtteranceId = asrState.utterance.id;
  asrState.speechDetectedAt = Date.now();

  const strongPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", strongPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "server_vad_confirmed");
  assert.equal(session.pendingResponse, null);
  assert.equal(cancelCalls.length, 1);
  const cancelLog = logs.find((entry) => entry?.content === "voice_preplay_reply_superseded_for_user_speech");
  assert.ok(cancelLog);
  assert.equal(cancelLog?.metadata?.pendingSource, "realtime:speech_1");
  assert.equal(cancelLog?.metadata?.opportunityType, null);
});

test("promoting a local-only strong-audio capture does not cancel pending pre-audio reply before server VAD confirmation", async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const cancelCalls: boolean[] = [];
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    voxClient,
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    pendingResponse: {
      requestId: 7,
      requestedAt: Date.now(),
      source: "realtime:speech_1",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "yo",
      latencyContext: null,
      userId: null,
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });

  const strongPcm = makeMonoPcm16(
    Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000),
    3000
  );
  voxClient.emit("userAudio", "speaker-1", strongPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.ok(Number(capture.promotedAt || 0) > 0);
  assert.equal(capture.promotionReason, "strong_local_audio");
  assert.ok(session.pendingResponse);
  assert.equal(cancelCalls.length, 0);
  assert.equal(
    logs.some((entry) => entry?.content === "voice_preplay_reply_superseded_for_user_speech"),
    false
  );
});

test(
  "server-vad-confirmed capture cancels pending pre-audio tool followup and preserves owner followup admission",
  async () => {
  const { manager, logs } = createManager();
  manager.shouldUsePerUserTranscription = () => true;
  const cancelCalls: boolean[] = [];
  const voxClient = new EventEmitter();
  voxClient.subscribeUser = () => {};
  const session = createSession({
    voxClient,
    realtimeClient: {
      cancelActiveResponse() {
        cancelCalls.push(true);
        return true;
      }
    },
    voiceCommandState: {
      userId: "speaker-1",
      domain: "tool",
      intent: "tool_followup",
      startedAt: Date.now(),
      expiresAt: Date.now() + 10_000
    },
    pendingResponse: {
      requestId: 8,
      requestedAt: Date.now(),
      source: "tool_call_followup",
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "speaker-1"
      },
      utteranceText: "which one did you want?",
      latencyContext: null,
      userId: "speaker-1",
      retryCount: 0,
      hardRecoveryAttempted: false
    }
  });
  const asrState = seedReadyPerUserAsr(manager, session, "speaker-1");

  manager.captureManager.startInboundCapture({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot
  });
  asrState.speechDetectedUtteranceId = asrState.utterance.id;
  asrState.speechDetectedAt = Date.now();

  const strongPcm = makeMonoPcm16(Math.ceil((24_000 * (VOICE_TURN_PROMOTION_MIN_CLIP_MS + 40)) / 1000), 3000);
  voxClient.emit("userAudio", "speaker-1", strongPcm);
  await flushMicrotasks();

  const capture = session.userCaptures.get("speaker-1");
  assert.ok(capture);
  assert.equal(capture.promotionReason, "server_vad_confirmed");
  assert.equal(session.pendingResponse, null);
  assert.equal(cancelCalls.length, 1);
  assert.equal(manager.ensureVoiceCommandState(session)?.intent, "tool_followup");

  const decision = await manager.evaluateVoiceReplyDecision({
    session,
    userId: "speaker-1",
    settings: session.settingsSnapshot,
    transcript: "yeah do that"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "owned_tool_followup");
  const cancelLog = logs.find((entry) => entry?.content === "voice_preplay_reply_superseded_for_user_speech");
  assert.ok(cancelLog);
  assert.equal(cancelLog?.metadata?.pendingSource, "tool_call_followup");
});
