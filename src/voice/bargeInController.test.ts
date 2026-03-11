import { test } from "bun:test";
import assert from "node:assert/strict";
import { BargeInController, type ReplyInterruptionPolicy } from "./bargeInController.ts";
import {
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_MIN_SPEECH_MS
} from "./voiceSessionManager.constants.ts";
import type { OutputChannelState, VoiceSession } from "./voiceSessionTypes.ts";

type BargeInTestSession = VoiceSession & {
  __testOutputState?: OutputChannelState;
  __testBufferedBotSpeech?: boolean;
  __testLiveAudioStreaming?: boolean;
};

function createOutputState(overrides: Partial<OutputChannelState> = {}): OutputChannelState {
  return {
    phase: "response_pending",
    locked: true,
    lockReason: "pending_response",
    musicActive: false,
    captureBlocking: false,
    bargeInSuppressed: false,
    turnBacklog: 0,
    toolCallsRunning: false,
    botTurnOpen: false,
    bufferedBotSpeech: false,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    streamBufferedBytes: 0,
    deferredBlockReason: null,
    ...overrides
  };
}

function createSession(overrides: Partial<BargeInTestSession> = {}): BargeInTestSession {
  const outputState = overrides.__testOutputState || createOutputState({
    botTurnOpen: Boolean(overrides.botTurnOpen),
    bufferedBotSpeech: Boolean(overrides.__testBufferedBotSpeech),
    pendingResponse: Boolean(overrides.pendingResponse),
    openAiActiveResponse: false,
    awaitingToolOutputs: false
  });
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
    startedAt: 0,
    lastActivityAt: 0,
    maxEndsAt: null,
    inactivityEndsAt: null,
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
      phaseEnteredAt: 0,
      lastSyncedAt: 0,
      requestId: null,
      ttsPlaybackState: "idle",
      ttsBufferedSamples: 0,
      lastTrigger: null
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
      pendingPlatform: null,
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
    settingsSnapshot: null,
    cleanupHandlers: [],
    ending: false,
    playerState: null,
    botTurnOpenAt: 0,
    __testOutputState: outputState,
    __testBufferedBotSpeech: Boolean(overrides.__testBufferedBotSpeech),
    __testLiveAudioStreaming: Boolean(overrides.__testLiveAudioStreaming),
    ...overrides
  } as BargeInTestSession;
}

function createController() {
  return new BargeInController({
    client: { user: { id: "bot-1" } },
    store: { logAction() {} },
    replyManager: {
      hasRecentAssistantAudioDelta(session) {
        return Boolean((session as BargeInTestSession).__testLiveAudioStreaming);
      },
      hasBufferedTtsPlayback(session) {
        return Boolean((session as BargeInTestSession).__testBufferedBotSpeech);
      }
    },
    getOutputChannelState(session) {
      return (session as BargeInTestSession).__testOutputState || createOutputState();
    },
    normalizeReplyInterruptionPolicy(rawPolicy) {
      return rawPolicy ? rawPolicy as ReplyInterruptionPolicy : null;
    },
    isUserAllowedToInterruptReply({ policy, userId } = {}) {
      if (!policy) return false;
      if (policy.scope === "anyone") return true;
      if (policy.scope === "speaker") return String(policy.allowedUserId || "") === String(userId || "");
      if (policy.scope === "none") return false;
      return true;
    }
  });
}

function createAssertiveCapture(overrides: Record<string, number | null> = {}) {
  const minCaptureBytes = Math.ceil((24_000 * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000);
  return {
    bytesSent: minCaptureBytes + 1_000,
    startedAt: Date.now() - 2_000,
    speakingEndFinalizeTimer: null,
    signalSampleCount: 24_000,
    signalActiveSampleCount: 1_920,
    signalPeakAbs: 4_096,
    signalSumSquares: 0,
    ...overrides
  };
}

test("shouldBargeIn blocks pre-audio pending responses before any assistant audio arrives", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: false,
    pendingResponse: { requestId: 3, audioReceivedAt: 0 },
    __testOutputState: createOutputState({ locked: true, botTurnOpen: false, pendingResponse: true })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-1",
    captureState: createAssertiveCapture()
  });

  assert.deepEqual(result, { allowed: false });
});

test("shouldBargeIn allows buffered subprocess drain interruption for the active speaker", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: false,
    pendingResponse: {
      requestId: 4,
      audioReceivedAt: Date.now() - 250,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1"
      }
    },
    __testBufferedBotSpeech: true,
    __testOutputState: createOutputState({
      phase: "speaking_buffered",
      lockReason: "bot_audio_buffered",
      botTurnOpen: false,
      bufferedBotSpeech: true,
      pendingResponse: true
    })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-1",
    captureState: createAssertiveCapture()
  });

  assert.equal(result.allowed, true);
  assert.equal(typeof result.minCaptureBytes, "number");
  assert.ok((result.minCaptureBytes || 0) > 0);
});

test("shouldBargeIn allows buffered subprocess drain interruption after pending response settles", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: false,
    pendingResponse: null,
    activeReplyInterruptionPolicy: {
      assertive: true,
      scope: "speaker",
      allowedUserId: "user-1"
    },
    __testBufferedBotSpeech: true,
    __testOutputState: createOutputState({
      phase: "speaking_buffered",
      lockReason: "bot_audio_buffered",
      botTurnOpen: false,
      bufferedBotSpeech: true,
      pendingResponse: false
    })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-1",
    captureState: createAssertiveCapture()
  });

  assert.equal(result.allowed, true);
  assert.equal(typeof result.minCaptureBytes, "number");
  assert.ok((result.minCaptureBytes || 0) > 0);
});

test("shouldBargeIn blocks likely echo during the initial bot audio guard window", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS + 25,
    pendingResponse: { requestId: 5, audioReceivedAt: Date.now() - 100 },
    __testLiveAudioStreaming: true,
    __testOutputState: createOutputState({
      phase: "speaking_live",
      lockReason: "bot_audio_live",
      botTurnOpen: true,
      pendingResponse: true
    })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-1",
    captureState: createAssertiveCapture()
  });

  assert.deepEqual(result, { allowed: false });
});

test("shouldBargeIn requires assertive signal during active bot speech", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS - 25,
    pendingResponse: { requestId: 6, audioReceivedAt: Date.now() - 100 },
    __testLiveAudioStreaming: true,
    __testOutputState: createOutputState({
      phase: "speaking_live",
      lockReason: "bot_audio_live",
      botTurnOpen: true,
      pendingResponse: true
    })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-1",
    captureState: createAssertiveCapture({ signalActiveSampleCount: 960, signalPeakAbs: 1_024 })
  });

  assert.deepEqual(result, { allowed: false });
});

test("shouldBargeIn blocks non-speakers when interruption scope is speaker", () => {
  const controller = createController();
  const session = createSession({
    botTurnOpen: true,
    botTurnOpenAt: Date.now() - BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS - 25,
    pendingResponse: {
      requestId: 7,
      audioReceivedAt: Date.now() - 100,
      interruptionPolicy: {
        assertive: true,
        scope: "speaker",
        allowedUserId: "user-1",
      }
    },
    __testLiveAudioStreaming: true,
    __testOutputState: createOutputState({
      phase: "speaking_live",
      lockReason: "bot_audio_live",
      botTurnOpen: true,
      pendingResponse: true
    })
  });

  const result = controller.shouldBargeIn({
    session,
    userId: "user-2",
    captureState: createAssertiveCapture()
  });

  assert.deepEqual(result, { allowed: false });
});
