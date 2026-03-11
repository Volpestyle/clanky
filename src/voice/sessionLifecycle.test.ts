import { test } from "bun:test";
import assert from "node:assert/strict";
import { createVoiceTestManager, createVoiceTestSettings as createCanonicalVoiceTestSettings } from "./voiceTestHarness.ts";
import { normalizeLegacyTestSettingsInput } from "../testSettings.ts";
import { deepMerge } from "../utils.ts";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";

const LEGACY_VOICE_KEYS = [
  "mode",
  "voiceProvider",
  "brainProvider",
  "generationLlm",
  "replyDecisionLlm",
  "asrEnabled",
  "asrLanguageMode",
  "asrLanguageHint",
  "allowedVoiceChannelIds",
  "blockedVoiceChannelIds",
  "blockedVoiceUserIds",
  "maxSessionMinutes",
  "inactivityLeaveSeconds",
  "maxSessionsPerDay",
  "maxConcurrentSessions",
  "ambientReplyEagerness",
  "commandOnlyMode",
  "allowNsfwHumor",
  "textOnlyMode",
  "defaultInterruptionMode",
  "replyPath",
  "ttsMode",
  "operationalMessages",
  "streamingEnabled",
  "streamingEagerFirstChunkChars",
  "streamingMaxBufferChars",
  "thoughtEngine",
  "musicDucking",
  "intentConfidenceThreshold",
  "openaiRealtime",
  "xai",
  "elevenLabsRealtime",
  "geminiRealtime",
  "openaiAudioApi"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createVoiceTestSettings(overrides: Record<string, unknown> = {}) {
  const canonicalOverrides: Record<string, unknown> = { ...overrides };
  const legacyOverrides: Record<string, unknown> = {};

  if (isRecord(canonicalOverrides.voice)) {
    const canonicalVoice = { ...canonicalOverrides.voice };
    const legacyVoice: Record<string, unknown> = {};
    for (const key of LEGACY_VOICE_KEYS) {
      if (key in canonicalVoice) {
        legacyVoice[key] = canonicalVoice[key];
        delete canonicalVoice[key];
      }
    }

    if (Object.keys(legacyVoice).length > 0) {
      legacyOverrides.voice = legacyVoice;
    }
    if (Object.keys(canonicalVoice).length > 0) {
      canonicalOverrides.voice = canonicalVoice;
    } else {
      delete canonicalOverrides.voice;
    }
  }

  const normalizedLegacy =
    Object.keys(legacyOverrides).length > 0 ? normalizeLegacyTestSettingsInput(legacyOverrides) : {};
  return createCanonicalVoiceTestSettings(deepMerge(normalizedLegacy, canonicalOverrides));
}

test("bindRealtimeHandlers logs OpenAI realtime response.done usage cost", () => {
  const runtimeLogs = [];
  const handlerMap = new Map();
  const manager = createVoiceTestManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };

  const session = {
    id: "session-realtime-cost-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingResponse: null,
    responseDoneGraceTimer: null,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        ambientReplyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        },
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient: {
      sessionConfig: {
        model: "gpt-realtime-mini"
      },
      on(eventName, handler) {
        handlerMap.set(eventName, handler);
      },
      off(eventName, handler) {
        if (handlerMap.get(eventName) === handler) {
          handlerMap.delete(eventName);
        }
      }
    },
    cleanupHandlers: []
  };

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  const onResponseDone = handlerMap.get("response_done");
  assert.equal(typeof onResponseDone, "function");
  onResponseDone({
    type: "response.done",
    response: {
      id: "resp_001",
      status: "completed",
      model: "gpt-realtime-mini",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        input_token_details: {
          cached_tokens: 100,
          audio_tokens: 700,
          text_tokens: 300
        },
        output_token_details: {
          audio_tokens: 350,
          text_tokens: 150
        }
      }
    }
  });

  assert.equal(runtimeLogs.length, 1);
  assert.equal(runtimeLogs[0]?.kind, "voice_runtime");
  assert.equal(runtimeLogs[0]?.content, "openai_realtime_response_done");
  assert.equal(runtimeLogs[0]?.usdCost, 0.001806);
  assert.equal(runtimeLogs[0]?.metadata?.responseModel, "gpt-realtime-mini");
  assert.deepEqual(runtimeLogs[0]?.metadata?.responseUsage, {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    cacheReadTokens: 100,
    inputAudioTokens: 700,
    inputTextTokens: 300,
    outputAudioTokens: 350,
    outputTextTokens: 150
  });
});

test("bindRealtimeHandlers persists only final realtime transcript events", () => {
  const runtimeLogs = [];
  const handlerMap = new Map();
  const manager = createVoiceTestManager();
  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };

  const session = {
    id: "session-realtime-transcript-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    pendingRealtimeInputBytes: 1024,
    pendingResponse: null,
    responseDoneGraceTimer: null,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        ambientReplyEagerness: 60,
        replyDecisionLlm: {
          provider: "anthropic",
          model: "claude-haiku-4-5"
        },
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient: {
      sessionConfig: {
        model: "gpt-realtime-mini"
      },
      on(eventName, handler) {
        handlerMap.set(eventName, handler);
      },
      off(eventName, handler) {
        if (handlerMap.get(eventName) === handler) {
          handlerMap.delete(eventName);
        }
      }
    },
    cleanupHandlers: []
  };

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  const onTranscript = handlerMap.get("transcript");
  assert.equal(typeof onTranscript, "function");
  onTranscript({
    text: "yo",
    eventType: "response.output_audio_transcript.delta"
  });
  onTranscript({
    text: "yo what's good",
    eventType: "response.output_audio_transcript.done"
  });

  const transcriptLogs = runtimeLogs.filter(
    (row) => row?.kind === "voice_runtime" && row?.content === "openai_realtime_transcript"
  );
  assert.equal(transcriptLogs.length, 1);
  assert.equal(transcriptLogs[0]?.metadata?.transcript, "yo what's good");
  assert.equal(
    transcriptLogs[0]?.metadata?.transcriptEventType,
    "response.output_audio_transcript.done"
  );
  assert.equal(transcriptLogs[0]?.metadata?.transcriptSource, "output");
  assert.equal(session.pendingRealtimeInputBytes, 0);
});

test("bindRealtimeHandlers drops late audio and transcripts for interrupted realtime output items", () => {
  const runtimeLogs = [];
  const forwardedAudio: Array<{ audioBase64: string; sampleRate: number }> = [];
  const manager = createVoiceTestManager();
  const realtimeClient = new OpenAiRealtimeClient({ apiKey: "test-key" });
  const audioDelta = "A".repeat(64);
  let markBotTurnOutCount = 0;

  manager.store.logAction = (row) => {
    runtimeLogs.push(row);
  };
  manager.getMusicPhase = () => "idle";
  manager.replyManager.markBotTurnOut = () => {
    markBotTurnOutCount += 1;
  };
  manager.replyManager.syncAssistantOutputState = () => {};
  manager.replyManager.pendingResponseHasAudio = () => false;

  const session = {
    id: "session-realtime-interrupted-item-drop-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    transcriptTurns: [],
    pendingRealtimeInputBytes: 0,
    pendingResponse: null,
    responseDoneGraceTimer: null,
    lastAudioDeltaAt: 0,
    lastRealtimeAssistantAudioItemId: null,
    lastRealtimeAssistantAudioItemContentIndex: 0,
    lastRealtimeAssistantAudioItemReceivedMs: 0,
    ignoredRealtimeAssistantOutputItemIds: new Map([["item_old", Date.now()]]),
    realtimeOutputSampleRateHz: 24000,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        ambientReplyEagerness: 60,
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    voxClient: {
      isAlive: true,
      sendAudio(audioBase64: string, sampleRate: number) {
        forwardedAudio.push({ audioBase64, sampleRate });
      }
    },
    realtimeClient,
    cleanupHandlers: []
  };

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  realtimeClient.handleIncoming(JSON.stringify({
    type: "response.output_audio.delta",
    item_id: "item_old",
    content_index: 0,
    delta: audioDelta
  }));
  realtimeClient.handleIncoming(JSON.stringify({
    type: "response.output_audio_transcript.done",
    item_id: "item_old",
    transcript: "old tail should stay cut"
  }));

  assert.equal(forwardedAudio.length, 0);
  assert.equal(markBotTurnOutCount, 0);
  assert.equal(session.lastAudioDeltaAt, 0);
  assert.equal(session.lastRealtimeAssistantAudioItemId, "item_old");
  assert.equal(session.lastRealtimeAssistantAudioItemReceivedMs, 0);
  assert.equal(session.transcriptTurns.length, 0);

  realtimeClient.handleIncoming(JSON.stringify({
    type: "response.output_audio.delta",
    item_id: "item_new",
    content_index: 0,
    delta: audioDelta
  }));
  realtimeClient.handleIncoming(JSON.stringify({
    type: "response.output_audio_transcript.done",
    item_id: "item_new",
    transcript: "fresh line"
  }));

  assert.equal(forwardedAudio.length, 1);
  assert.deepEqual(forwardedAudio[0], {
    audioBase64: audioDelta,
    sampleRate: 24000
  });
  assert.equal(markBotTurnOutCount, 1);
  assert.ok(session.lastAudioDeltaAt > 0);
  assert.ok(session.lastRealtimeAssistantAudioItemReceivedMs > 0);
  assert.equal(session.transcriptTurns.length, 1);
  assert.equal(session.transcriptTurns[0]?.role, "assistant");
  assert.equal(session.transcriptTurns[0]?.text, "fresh line");

  const transcriptLogs = runtimeLogs.filter(
    (row) => row?.kind === "voice_runtime" && row?.content === "openai_realtime_transcript"
  );
  assert.equal(transcriptLogs.length, 1);
  assert.equal(transcriptLogs[0]?.metadata?.transcript, "fresh line");
});

test("bindRealtimeHandlers requests OpenAI reply addressing for provider-native assistant replies", () => {
  const manager = createVoiceTestManager();
  const realtimeClient = new OpenAiRealtimeClient({ apiKey: "test-key" });
  let requestedArgs = null;
  realtimeClient.requestReplyAddressingClassification = (args) => {
    requestedArgs = args;
    return true;
  };

  const session = {
    id: "session-realtime-addressing-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    transcriptTurns: [],
    pendingRealtimeInputBytes: 1024,
    pendingResponse: {
      requestId: 7,
      userId: "speaker-1",
      source: "openai_realtime_text_turn",
      interruptionPolicy: null
    },
    responseDoneGraceTimer: null,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        replyPath: "bridge",
        ambientReplyEagerness: 60,
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient,
    cleanupHandlers: []
  };

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  realtimeClient.emit("transcript", {
    text: "what's up",
    eventType: "response.output_audio_transcript.done"
  });

  assert.ok(requestedArgs);
  assert.equal(requestedArgs.assistantText, "what's up");
  assert.equal(requestedArgs.currentSpeakerName, "speaker 1");
  assert.equal(requestedArgs.speakerUserId, "speaker-1");
  assert.equal(requestedArgs.requestId, 7);
  assert.equal(requestedArgs.responseSource, "openai_realtime_text_turn");
  assert.deepEqual(requestedArgs.participants, ["speaker 1", "speaker 2"]);
});

test("bindRealtimeHandlers patches assistant targeting and interruption policy from OpenAI reply addressing results", () => {
  const manager = createVoiceTestManager();
  const realtimeClient = new OpenAiRealtimeClient({ apiKey: "test-key" });
  realtimeClient.requestReplyAddressingClassification = () => true;
  manager.getOutputChannelState = () => ({
    phase: "speaking_buffered",
    locked: true,
    lockReason: "bot_audio_buffered",
    musicActive: false,
    captureBlocking: false,
    bargeInSuppressed: false,
    turnBacklog: 0,
    toolCallsRunning: false,
    botTurnOpen: true,
    bufferedBotSpeech: true,
    pendingResponse: true,
    openAiActiveResponse: false,
    awaitingToolOutputs: false,
    streamBufferedBytes: 0,
    deferredBlockReason: null
  });

  const session = {
    id: "session-realtime-addressing-2",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    transcriptTurns: [],
    pendingRealtimeInputBytes: 0,
    pendingResponse: {
      requestId: 11,
      userId: "speaker-1",
      source: "openai_realtime_text_turn",
      interruptionPolicy: manager.resolveReplyInterruptionPolicy({
        session: {
          guildId: "guild-1",
          voiceChannelId: "voice-1",
          ending: false,
          settingsSnapshot: createVoiceTestSettings({
            voice: {
              replyPath: "bridge"
            }
          })
        },
        userId: "speaker-1"
      })
    },
    activeReplyInterruptionPolicy: null,
    responseDoneGraceTimer: null,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        replyPath: "bridge",
        ambientReplyEagerness: 60,
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient,
    cleanupHandlers: []
  };
  session.activeReplyInterruptionPolicy = session.pendingResponse.interruptionPolicy;

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  realtimeClient.emit("transcript", {
    text: "what's up",
    eventType: "response.output_audio_transcript.done"
  });
  realtimeClient.emit("reply_addressing_result", {
    assistantText: "what's up",
    classifierText: "ALL",
    currentSpeakerName: "speaker 1",
    speakerUserId: "speaker-1",
    requestId: 11,
    responseSource: "openai_realtime_text_turn"
  });

  assert.equal(session.transcriptTurns.at(-1)?.role, "assistant");
  assert.equal(session.transcriptTurns.at(-1)?.text, "what's up");
  assert.equal(session.transcriptTurns.at(-1)?.addressing?.talkingTo, "ALL");
  assert.equal(session.pendingResponse?.interruptionPolicy?.scope, "none");
  assert.equal(session.pendingResponse?.interruptionPolicy?.talkingTo, "ALL");
  assert.equal(session.activeReplyInterruptionPolicy?.scope, "none");
  assert.equal(session.activeReplyInterruptionPolicy?.talkingTo, "ALL");
});

test("bindRealtimeHandlers skips OpenAI reply addressing side-channel for pre-generated playback utterances", () => {
  const manager = createVoiceTestManager();
  const realtimeClient = new OpenAiRealtimeClient({ apiKey: "test-key" });
  let requestCount = 0;
  realtimeClient.requestReplyAddressingClassification = () => {
    requestCount += 1;
    return true;
  };

  const session = {
    id: "session-realtime-addressing-3",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    recentVoiceTurns: [],
    transcriptTurns: [],
    pendingRealtimeInputBytes: 0,
    pendingResponse: {
      requestId: 12,
      userId: "speaker-1",
      source: "voice_prompt_utterance",
      interruptionPolicy: null
    },
    responseDoneGraceTimer: null,
    settingsSnapshot: createVoiceTestSettings({
      voice: {
        replyPath: "brain",
        ambientReplyEagerness: 60,
        openaiRealtime: {
          model: "gpt-realtime-mini"
        }
      }
    }),
    realtimeClient,
    cleanupHandlers: []
  };

  manager.sessionLifecycle.bindRealtimeHandlers(session, session.settingsSnapshot);

  realtimeClient.emit("transcript", {
    text: "already generated upstream",
    eventType: "response.output_audio_transcript.done"
  });

  assert.equal(requestCount, 0);
});
