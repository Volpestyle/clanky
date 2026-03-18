import { test } from "bun:test";
import assert from "node:assert/strict";
import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";
import {
  appendAudioToAsr,
  beginAsrUtterance,
  closeAllPerUserAsrSessions,
  closeSharedAsrSession,
  commitAsrUtterance,
  createAsrBridgeState,
  ensureAsrSessionConnected,
  getOrCreatePerUserAsrState,
  releaseSharedAsrActiveUser,
  tryHandoffSharedAsr
} from "./voiceAsrBridge.ts";
import type { AsrBridgeDeps, AsrBridgeState, AsrUtteranceState } from "./voiceAsrBridge.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

function createSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
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
    sharedAsrEnabled: true,
    openAiSharedAsrState: null,
    openAiPerUserAsrModel: "gpt-4o-mini-transcribe",
    openAiPerUserAsrLanguage: "en",
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
      lastNoteAt: 0,
      lastNoteProvider: null,
      lastNoteModel: null,
      noteEntries: [],
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
    settingsSnapshot: { voice: { enabled: true, asrEnabled: true } },
    cleanupHandlers: [],
    ending: false,
    ...overrides
  } as VoiceSession;
}

function createDeps(session: VoiceSession, logs: Array<Record<string, unknown>> = []): AsrBridgeDeps {
  return {
    session,
    appConfig: { openaiApiKey: "test-openai-key" },
    store: {
      logAction(entry) {
        logs.push(entry);
      },
      getSettings() {
        return session.settingsSnapshot || {};
      }
    },
    botUserId: "bot-user",
    resolveVoiceSpeakerName(_session, userId) {
      return userId || "someone";
    }
  };
}

async function withPatchedConnect<T>(run: () => Promise<T> | T) {
  const originalConnect = OpenAiRealtimeTranscriptionClient.prototype.connect;
  const originalClose = OpenAiRealtimeTranscriptionClient.prototype.close;

  OpenAiRealtimeTranscriptionClient.prototype.connect = async function patchedConnect() {
    this.ws = { readyState: 1 } as WebSocket;
  };
  OpenAiRealtimeTranscriptionClient.prototype.close = async function patchedClose() {
    this.ws = { readyState: 3 } as WebSocket;
  };

  try {
    return await run();
  } finally {
    OpenAiRealtimeTranscriptionClient.prototype.connect = originalConnect;
    OpenAiRealtimeTranscriptionClient.prototype.close = originalClose;
  }
}

test("shared ASR user lock blocks a second user until the active user releases it", async () => {
  await withPatchedConnect(async () => {
    const session = createSession();
    const deps = createDeps(session);

    assert.equal(beginAsrUtterance("shared", session, deps, session.settingsSnapshot, "speaker-1"), true);
    assert.equal(beginAsrUtterance("shared", session, deps, session.settingsSnapshot, "speaker-2"), false);

    releaseSharedAsrActiveUser(session, "speaker-1");

    assert.equal(beginAsrUtterance("shared", session, deps, session.settingsSnapshot, "speaker-2"), true);
  });
});

test("tryHandoffSharedAsr replays buffered PCM for the waiting promoted capture", () => {
  const logs: Array<Record<string, unknown>> = [];
  const session = createSession({
    openAiSharedAsrState: {
      ...createAsrBridgeState(),
      phase: "ready",
      userId: null
    }
  });
  const deps = createDeps(session, logs);
  const pcmA = Buffer.alloc(960, 1);
  const pcmB = Buffer.alloc(960, 2);
  session.userCaptures.set("speaker-2", {
    userId: "speaker-2",
    startedAt: Date.now() - 500,
    promotedAt: Date.now() - 200,
    promotionReason: "strong_local_audio",
    asrUtteranceId: 0,
    bytesSent: pcmA.length + pcmB.length,
    signalSampleCount: 0,
    signalActiveSampleCount: 0,
    signalPeakAbs: 0,
    signalSumSquares: 0,
    pcmChunks: [pcmA, pcmB],
    sharedAsrBytesSent: 0,
    lastActivityTouchAt: 0,
    idleFlushTimer: null,
    maxFlushTimer: null,
    speakingEndFinalizeTimer: null,
    finalize: null,
    abort: null,
    removeSubprocessListeners: null
  });

  const beginCalls: string[] = [];
  const appendCalls: Buffer[] = [];
  const handedOff = tryHandoffSharedAsr({
    session,
    asrState: session.openAiSharedAsrState,
    deps,
    settings: session.settingsSnapshot,
    beginUtterance(userId) {
      beginCalls.push(userId);
      return true;
    },
    appendAudio(_userId, chunk) {
      appendCalls.push(chunk);
      return true;
    },
    releaseUser() {}
  });

  assert.equal(handedOff, true);
  assert.deepEqual(beginCalls, ["speaker-2"]);
  assert.deepEqual(appendCalls, [pcmA, pcmB]);
  assert.equal(session.userCaptures.get("speaker-2")?.sharedAsrBytesSent, pcmA.length + pcmB.length);
  assert.equal(logs.some((entry) => entry.content === "openai_shared_asr_handoff"), true);
});

test("appendAudioToAsr drops the oldest buffered chunks when pending audio exceeds the 10s cap", async () => {
  await withPatchedConnect(async () => {
    const session = createSession();
    const deps = createDeps(session);
    beginAsrUtterance("per_user", session, deps, session.settingsSnapshot, "speaker-1");
    const asrState = getOrCreatePerUserAsrState(session, "speaker-1")!;

    const chunkA = Buffer.alloc(200_000, 1);
    const chunkB = Buffer.alloc(200_000, 2);
    const chunkC = Buffer.alloc(200_000, 3);
    appendAudioToAsr("per_user", session, deps, session.settingsSnapshot, "speaker-1", chunkA);
    appendAudioToAsr("per_user", session, deps, session.settingsSnapshot, "speaker-1", chunkB);
    appendAudioToAsr("per_user", session, deps, session.settingsSnapshot, "speaker-1", chunkC);

    assert.equal(asrState.pendingAudioChunks.length, 2);
    assert.deepEqual(asrState.pendingAudioChunks.map((entry) => entry.chunk), [chunkB, chunkC]);
    assert.equal(asrState.pendingAudioBytes, chunkB.length + chunkC.length);
  });
});

test("appendAudioToAsr buffers during connecting and flushes once the connection becomes ready", async () => {
  const session = createSession();
  const deps = createDeps(session);
  const asrState = getOrCreatePerUserAsrState(session, "speaker-1")!;
  const appendedChunks: Buffer[] = [];
  let resolveConnect: (() => void) | null = null;

  asrState.phase = "connecting";
  asrState.client = {
    ws: { readyState: 0 },
    appendInputAudioPcm(chunk: Buffer) {
      appendedChunks.push(chunk);
    }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as OpenAiRealtimeTranscriptionClient;
  asrState.connectPromise = new Promise<void>((resolve) => {
    resolveConnect = () => {
      asrState.client!.ws = { readyState: 1 } as WebSocket;
      asrState.phase = "ready";
      resolve();
    };
  });

  const pcm = Buffer.alloc(9_600, 4);
  const appended = appendAudioToAsr("per_user", session, deps, session.settingsSnapshot, "speaker-1", pcm);
  assert.equal(appended, true);
  assert.equal(asrState.pendingAudioBytes, pcm.length);
  assert.equal(appendedChunks.length, 0);

  resolveConnect?.();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(appendedChunks.length, 1);
  assert.deepEqual(appendedChunks[0], pcm);
  assert.equal(asrState.pendingAudioBytes, 0);
});

test("commitAsrUtterance keeps per-user final transcripts attached to the committed utterance after a new capture starts", async () => {
  await withPatchedConnect(async () => {
    const logs: Array<Record<string, unknown>> = [];
    const session = createSession({
      openAiAsrTranscriptStableMs: 5,
      openAiAsrTranscriptWaitMaxMs: 120
    } as Partial<VoiceSession>);
    const deps = createDeps(session, logs);

    assert.equal(beginAsrUtterance("per_user", session, deps, session.settingsSnapshot, "speaker-1"), true);
    const asrState = await ensureAsrSessionConnected("per_user", deps, session.settingsSnapshot, "speaker-1");
    assert.ok(asrState?.client);
    assert.ok(asrState?.utterance);
    asrState!.utterance.bytesSent = 48_000;

    const client = asrState!.client!;
    client.commitInputAudioBuffer = () => {
      setTimeout(() => {
        client.handleIncoming(JSON.stringify({
          type: "input_audio_buffer.committed",
          item_id: "item_1"
        }));
        beginAsrUtterance("per_user", session, deps, session.settingsSnapshot, "speaker-1");
      }, 5);
      setTimeout(() => {
        client.handleIncoming(JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_1",
          transcript: "Yo, give me some sound effects."
        }));
      }, 15);
    };

    const result = await commitAsrUtterance("per_user", deps, session.settingsSnapshot, "speaker-1", "stream_end");

    assert.equal(result?.transcript, "Yo, give me some sound effects.");
    assert.equal(logs.some((entry) => entry.content === "voice_realtime_transcription_empty"), false);
  });
});

test("per-user auto-committed item binds to the active utterance before explicit commit starts", async () => {
  await withPatchedConnect(async () => {
    const logs: Array<Record<string, unknown>> = [];
    const session = createSession();
    const deps = createDeps(session, logs);

    assert.equal(beginAsrUtterance("per_user", session, deps, session.settingsSnapshot, "speaker-1"), true);
    const asrState = await ensureAsrSessionConnected("per_user", deps, session.settingsSnapshot, "speaker-1");
    assert.ok(asrState?.client);
    assert.ok(asrState?.utterance);

    const previousUtterance: AsrUtteranceState = {
      id: 7,
      startedAt: Date.now() - 1_000,
      bytesSent: 48_000,
      partialText: "",
      finalSegments: ["previous turn"],
      finalSegmentEntries: [],
      lastUpdateAt: Date.now() - 500
    };
    asrState!.committedItemUtterances.set("item_prev", previousUtterance);

    const currentUtterance = asrState!.utterance;
    const client = asrState!.client!;
    client.handleIncoming(JSON.stringify({
      type: "input_audio_buffer.speech_stopped",
      audio_end_ms: 22112,
      item_id: "item_current"
    }));
    client.handleIncoming(JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "item_current",
      previous_item_id: "item_prev"
    }));
    client.handleIncoming(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_current",
      transcript: "All right, stop music."
    }));

    assert.deepEqual(currentUtterance.finalSegments, ["All right, stop music."]);
    assert.deepEqual(previousUtterance.finalSegments, ["previous turn"]);
    assert.equal(logs.some((entry) => entry.content === "openai_realtime_asr_final_segment"), true);
  });
});

test("ASR bridge drops provider control-token transcripts before storing utterance text", async () => {
  await withPatchedConnect(async () => {
    const logs: Array<Record<string, unknown>> = [];
    const session = createSession();
    const deps = createDeps(session, logs);

    assert.equal(beginAsrUtterance("per_user", session, deps, session.settingsSnapshot, "speaker-1"), true);
    const asrState = await ensureAsrSessionConnected("per_user", deps, session.settingsSnapshot, "speaker-1");
    assert.ok(asrState?.client);

    asrState!.client!.handleIncoming(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "<|vq_lbr_audio_58759|>"
    }));
    asrState!.client!.handleIncoming(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "<|audio_future3|><|vq_lbr_audio_58759|>"
    }));

    assert.equal(asrState!.utterance.partialText, "");
    assert.deepEqual(asrState!.utterance.finalSegments, []);
    const droppedLogs = logs.filter((entry) => entry.content === "openai_realtime_asr_control_token_transcript_dropped");
    assert.equal(droppedLogs.length, 2);
    assert.equal(logs.some((entry) => entry.content === "openai_realtime_asr_final_segment"), false);
  });
});

test("commitAsrUtterance trips the empty-commit circuit breaker after three substantial empty commits", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const session = createSession({
    openAiAsrTranscriptStableMs: 1,
    openAiAsrTranscriptWaitMaxMs: 1
  } as Partial<VoiceSession>);
  const deps = createDeps(session, logs);
  const asrState = getOrCreatePerUserAsrState(session, "speaker-1")!;
  let closeCalls = 0;

  asrState.phase = "ready";
  asrState.client = {
    ws: { readyState: 1 },
    clearInputAudioBuffer() {},
    appendInputAudioPcm() {},
    commitInputAudioBuffer() {},
    async close() {
      closeCalls += 1;
    }
  // eslint-disable-next-line no-restricted-syntax
  } as unknown as OpenAiRealtimeTranscriptionClient;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    asrState.utterance.id = attempt + 1;
    asrState.utterance.startedAt = Date.now() - 500;
    asrState.utterance.bytesSent = 48_000;
    asrState.utterance.partialText = "";
    asrState.utterance.finalSegments = [];
    asrState.utterance.finalSegmentEntries = [];
    asrState.utterance.lastUpdateAt = 0;
    const result = await commitAsrUtterance("per_user", deps, session.settingsSnapshot, "speaker-1", "stream_end");
    assert.equal(result?.transcript, "");
    if (attempt < 2) {
      assert.equal(asrState.consecutiveEmptyCommits, attempt + 1);
      assert.equal(closeCalls, 0);
    }
  }

  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(session.openAiAsrSessions.has("speaker-1"), false);
  assert.equal(logs.some((entry) => entry.content === "openai_realtime_asr_circuit_breaker_reconnect"), true);
});

test("closeAllPerUserAsrSessions logs per_user scope metadata", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const session = createSession();
  const deps = createDeps(session, logs);

  session.openAiAsrSessions.set("speaker-1", {
    phase: "ready",
    idleTimer: null,
    client: {
      async close() {}
    }
  } as AsrBridgeState);

  await closeAllPerUserAsrSessions(session, deps, "session_end");

  const closeLog = logs.find((entry) => entry.content === "openai_realtime_asr_session_closed");
  const metadata = (closeLog?.metadata ?? {}) as Record<string, unknown>;
  assert.ok(closeLog);
  assert.equal(metadata.sessionScope, "per_user");
  assert.equal(metadata.reason, "session_end");
});

test("closeSharedAsrSession logs shared scope metadata", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const session = createSession();
  const deps = createDeps(session, logs);

  session.openAiSharedAsrState = {
    phase: "ready",
    idleTimer: null,
    pendingCommitResolvers: [],
    userId: "speaker-2",
    client: {
      async close() {}
    }
  } as AsrBridgeState;

  await closeSharedAsrSession(session, deps, "session_end");

  const closeLog = logs.find((entry) => entry.content === "openai_realtime_asr_session_closed");
  const metadata = (closeLog?.metadata ?? {}) as Record<string, unknown>;
  assert.ok(closeLog);
  assert.equal(metadata.sessionScope, "shared");
  assert.equal(metadata.reason, "session_end");
});
