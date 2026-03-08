import { test } from "bun:test";
import assert from "node:assert/strict";
import { createVoiceTestManager, createVoiceTestSettings } from "./voiceTestHarness.ts";

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
        replyEagerness: 60,
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
        replyEagerness: 60,
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
