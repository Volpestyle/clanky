import { test } from "bun:test";
import assert from "node:assert/strict";
import { createVoiceTestManager, createVoiceTestSettings } from "./voiceTestHarness.ts";

test("queueRealtimeTurn keeps only one merged pending turn while realtime drain is active", () => {
  const runtimeLogs = [];
  const manager = createVoiceTestManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  const session = {
    id: "session-queue-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: []
  };

  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1]),
    captureReason: "r1"
  });
  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([2]),
    captureReason: "r2"
  });
  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([3]),
    captureReason: "r3"
  });
  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([4]),
    captureReason: "r4"
  });

  assert.deepEqual(
    session.pendingRealtimeTurns.map((turn) => turn.captureReason),
    ["r4"]
  );
  assert.equal(Buffer.isBuffer(session.pendingRealtimeTurns[0]?.pcmBuffer), true);
  assert.equal(session.pendingRealtimeTurns[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4])), true);
  const coalescedLogs = runtimeLogs.filter(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_coalesced"
  );
  assert.equal(coalescedLogs.length > 0, true);
  assert.equal(coalescedLogs.at(-1)?.metadata?.maxQueueDepth, 1);
});

test("queueRealtimeTurn coalesces queued turns even when speaker or reason changes", () => {
  const manager = createVoiceTestManager();
  const session = {
    id: "session-queue-coalesce-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: []
  };

  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3]),
    captureReason: "speaking_end"
  });
  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-2",
    pcmBuffer: Buffer.from([4, 5]),
    captureReason: "idle_timeout"
  });

  assert.equal(session.pendingRealtimeTurns.length, 1);
  assert.equal(Buffer.isBuffer(session.pendingRealtimeTurns[0]?.pcmBuffer), true);
  assert.equal(session.pendingRealtimeTurns[0]?.pcmBuffer.equals(Buffer.from([1, 2, 3, 4, 5])), true);
  assert.equal(session.pendingRealtimeTurns[0]?.userId, "speaker-2");
  assert.equal(session.pendingRealtimeTurns[0]?.captureReason, "idle_timeout");
});

test("queueRealtimeTurn dedupes repeated transcript revisions for the same ASR utterance", () => {
  const manager = createVoiceTestManager();
  const session = {
    id: "session-queue-revision-dedupe-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: []
  };

  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    captureReason: "speaking_end",
    transcriptOverride: "Can you look up lawn mowers?",
    bridgeUtteranceId: 7
  });
  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    captureReason: "speaking_end",
    transcriptOverride: "Can you look up lawn mowers?",
    bridgeUtteranceId: 7
  });

  assert.equal(session.pendingRealtimeTurns.length, 1);
  assert.equal(session.pendingRealtimeTurns[0]?.transcriptOverride, "Can you look up lawn mowers?");
  assert.equal(session.pendingRealtimeTurns[0]?.bridgeRevision, 2);
});

test("queueRealtimeTurn revises an active ASR utterance before audio starts", async () => {
  const runtimeLogs = [];
  let releaseTranscription = () => {};
  const transcriptionGate = new Promise<void>((resolve) => {
    releaseTranscription = resolve;
  });
  const manager = createVoiceTestManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.transcribePcmTurn = async () => {
    await transcriptionGate;
    return "Um, can you look up...";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    throw new Error("superseded turn should not reach decision");
  };
  manager.runRealtimeBrainReply = async () => true;

  const session = {
    id: "session-active-revision-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeClient: {
      cancelActiveResponse() {
        return true;
      }
    },
    pendingResponse: null,
    botTurnOpen: false,
    lastAudioDeltaAt: 0,
    realtimeTurnDrainActive: true,
    pendingRealtimeTurns: [],
    recentVoiceTurns: [],
    membershipEvents: [],
    settingsSnapshot: createVoiceTestSettings(),
    activeRealtimeTurn: null
  };

  const turnRun = manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "max_duration",
    queuedAt: Date.now() - 50,
    bridgeUtteranceId: 21,
    bridgeRevision: 1
  });
  await Promise.resolve();

  manager.turnProcessor.queueRealtimeTurn({
    session,
    userId: "speaker-1",
    captureReason: "max_duration",
    transcriptOverride: "Um, can you look up... lawn mowers in Charlotte.",
    bridgeUtteranceId: 21
  });

  releaseTranscription();
  await turnRun;

  assert.equal(session.pendingRealtimeTurns.length, 1);
  assert.equal(
    session.pendingRealtimeTurns[0]?.transcriptOverride,
    "Um, can you look up... lawn mowers in Charlotte."
  );
  assert.equal(session.pendingRealtimeTurns[0]?.bridgeRevision, 2);
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_revised_pre_audio"),
    true
  );
  assert.equal(
    runtimeLogs.some((row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_superseded"),
    true
  );
});

test("runRealtimeTurn skips stale queued turns when newer backlog exists", async () => {
  let transcribeCalls = 0;
  let decisionCalls = 0;
  const runtimeLogs = [];
  const manager = createVoiceTestManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.transcribePcmTurn = async () => {
    transcribeCalls += 1;
    return "hello there";
  };
  manager.evaluateVoiceReplyDecision = async () => {
    decisionCalls += 1;
    return {
      allow: true,
      reason: "brain_decides",
      participantCount: 2,
      directAddressed: false,
      transcript: "hello there"
    };
  };

  const session = {
    id: "session-stale-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    pendingRealtimeTurns: [{ queuedAt: Date.now(), pcmBuffer: Buffer.from([9, 9]), captureReason: "speaking_end" }],
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: createVoiceTestSettings()
  };

  await manager.turnProcessor.runRealtimeTurn({
    session,
    userId: "speaker-1",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "speaking_end",
    queuedAt: Date.now() - 5_000
  });

  assert.equal(transcribeCalls, 0);
  assert.equal(decisionCalls, 0);
  const staleSkipLog = runtimeLogs.find(
    (row) => row?.kind === "voice_runtime" && row?.content === "realtime_turn_skipped_stale"
  );
  assert.equal(Boolean(staleSkipLog), true);
});

test("forwardRealtimeTextTurnToBrain waits for turn-context refresh before sending the utterance", async () => {
  const requestCalls = [];
  let releaseContextRefresh = () => undefined;
  const manager = createVoiceTestManager();
  manager.replyManager.createTrackedAudioResponse = () => true;
  manager.instructionManager.prepareRealtimeTurnContext = async () => {
    await new Promise((resolve) => {
      releaseContextRefresh = resolve;
    });
  };

  const session = {
    id: "session-forward-nonblocking-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeClient: {
      requestTextUtterance(promptText) {
        requestCalls.push(promptText);
      }
    },
    settingsSnapshot: createVoiceTestSettings()
  };

  const forwardCall = manager.forwardRealtimeTextTurnToBrain({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "what's up",
    captureReason: "stream_end",
    source: "realtime_transcript_turn",
    directAddressed: true
  });

  const result = await Promise.race([
    forwardCall,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 80))
  ]);

  assert.equal(result, "timeout");
  assert.equal(requestCalls.length, 0);
  releaseContextRefresh();
  assert.equal(await forwardCall, true);
  assert.equal(requestCalls.length, 1);
});

test("forwardRealtimeTurnAudio schedules response without waiting for turn-context refresh", async () => {
  let releaseContextRefresh = () => undefined;
  let scheduledCalls = 0;
  const manager = createVoiceTestManager();
  manager.instructionManager.prepareRealtimeTurnContext = async () => {
    await new Promise((resolve) => {
      releaseContextRefresh = resolve;
    });
  };
  manager.turnProcessor.scheduleResponseFromBufferedAudio = () => {
    scheduledCalls += 1;
  };

  const session = {
    id: "session-forward-audio-nonblocking-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 0,
    realtimeClient: {
      appendInputAudioPcm() {}
    },
    settingsSnapshot: createVoiceTestSettings()
  };

  const forwarded = await manager.forwardRealtimeTurnAudio({
    session,
    settings: session.settingsSnapshot,
    userId: "speaker-1",
    transcript: "hello",
    pcmBuffer: Buffer.from([1, 2, 3, 4]),
    captureReason: "stream_end"
  });

  assert.equal(forwarded, true);
  assert.equal(scheduledCalls, 1);
  releaseContextRefresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("shouldUsePerUserTranscription follows strategy and setting", () => {
  const manager = createVoiceTestManager();
  manager.appConfig.openaiApiKey = "test-key";

  const bridgeDisabledSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    }
  });
  const bridgeEnabledSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        usePerUserAsrBridge: true
      }
    }
  });
  const nativeSettings = createVoiceTestSettings({
    voice: {
      replyPath: "native",
      openaiRealtime: {
        usePerUserAsrBridge: true
      }
    }
  });
  const fileWavSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        transcriptionMethod: "file_wav",
        usePerUserAsrBridge: true
      }
    }
  });

  const session = {
    id: "session-openai-bridge-mode-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false
  };

  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: bridgeDisabledSettings }),
    false
  );
  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: bridgeEnabledSettings }),
    true
  );
  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: nativeSettings }),
    false
  );
  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: fileWavSettings }),
    false
  );
});

test("shouldUseSharedTranscription follows strategy and setting", () => {
  const manager = createVoiceTestManager();
  manager.appConfig.openaiApiKey = "test-key";

  const bridgeDisabledSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    }
  });
  const bridgeEnabledSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        usePerUserAsrBridge: true
      }
    }
  });
  const nativeSettings = createVoiceTestSettings({
    voice: {
      replyPath: "native",
      openaiRealtime: {
        usePerUserAsrBridge: false
      }
    }
  });
  const fileWavSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        transcriptionMethod: "file_wav",
        usePerUserAsrBridge: false
      }
    }
  });

  const session = {
    id: "session-openai-shared-bridge-mode-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false
  };

  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: bridgeDisabledSettings }),
    true
  );
  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: bridgeEnabledSettings }),
    false
  );
  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: nativeSettings }),
    false
  );
  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: fileWavSettings }),
    false
  );
});

test("isAsrActive returns false when textOnlyMode is enabled", () => {
  const manager = createVoiceTestManager();

  const normalSettings = createVoiceTestSettings({
    voice: { asrEnabled: true, textOnlyMode: false }
  });
  const textOnlySettings = createVoiceTestSettings({
    voice: { asrEnabled: true, textOnlyMode: true }
  });
  const asrDisabledSettings = createVoiceTestSettings({
    voice: { asrEnabled: false, textOnlyMode: false }
  });

  const session = {
    id: "session-text-only-asr-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    settingsSnapshot: null
  };

  assert.equal(manager.isAsrActive(session, normalSettings), true);
  assert.equal(manager.isAsrActive(session, textOnlySettings), false);
  assert.equal(manager.isAsrActive(session, asrDisabledSettings), false);
});

test("shouldUsePerUserTranscription returns false when textOnlyMode is enabled", () => {
  const manager = createVoiceTestManager();
  manager.appConfig.openaiApiKey = "test-key";

  const normalSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: { usePerUserAsrBridge: true },
      textOnlyMode: false
    }
  });
  const textOnlySettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: { usePerUserAsrBridge: true },
      textOnlyMode: true
    }
  });

  const session = {
    id: "session-text-only-per-user-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false
  };

  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: normalSettings }),
    true
  );
  assert.equal(
    manager.shouldUsePerUserTranscription({ session, settings: textOnlySettings }),
    false
  );
});

test("shouldUseSharedTranscription returns false when textOnlyMode is enabled", () => {
  const manager = createVoiceTestManager();
  manager.appConfig.openaiApiKey = "test-key";

  const normalSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: { usePerUserAsrBridge: false },
      textOnlyMode: false
    }
  });
  const textOnlySettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: { usePerUserAsrBridge: false },
      textOnlyMode: true
    }
  });

  const session = {
    id: "session-text-only-shared-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false
  };

  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: normalSettings }),
    true
  );
  assert.equal(
    manager.shouldUseSharedTranscription({ session, settings: textOnlySettings }),
    false
  );
});

test("shouldUseRealtimeTranscriptBridge follows replyPath, not transcription method", () => {
  const manager = createVoiceTestManager();
  const session = {
    id: "session-openai-transcript-bridge-mode-test",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false
  };

  const bridgeRealtimeSettings = createVoiceTestSettings({
    voice: {
      replyPath: "bridge",
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge"
      }
    }
  });
  const bridgeFileWavSettings = createVoiceTestSettings({
    voice: {
      replyPath: "bridge",
      openaiRealtime: {
        transcriptionMethod: "file_wav"
      }
    }
  });
  const fullBrainSettings = createVoiceTestSettings({
    voice: {
      replyPath: "brain",
      openaiRealtime: {
        transcriptionMethod: "realtime_bridge"
      }
    }
  });

  assert.equal(
    manager.shouldUseRealtimeTranscriptBridge({ session, settings: bridgeRealtimeSettings }),
    true
  );
  assert.equal(
    manager.shouldUseRealtimeTranscriptBridge({ session, settings: bridgeFileWavSettings }),
    true
  );
  assert.equal(
    manager.shouldUseRealtimeTranscriptBridge({ session, settings: fullBrainSettings }),
    false
  );
});
