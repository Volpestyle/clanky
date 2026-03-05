import { test } from "bun:test";
import assert from "node:assert/strict";
import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";

test("OpenAiRealtimeTranscriptionClient sendSessionUpdate uses transcription session shape", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    inputAudioFormat: "pcm16",
    inputTranscriptionModel: "gpt-4o-mini-transcribe",
    inputTranscriptionLanguage: "en",
    inputTranscriptionPrompt: "Prefer English."
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.type, "session.update");
  assert.equal(outbound.session.type, "transcription");
  assert.equal(outbound.session.audio.input.format.type, "audio/pcm");
  assert.equal(outbound.session.audio.input.format.rate, 24000);
  assert.equal(outbound.session.audio.input.turn_detection, null);
  assert.equal(outbound.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(outbound.session.audio.input.transcription.language, "en");
  assert.equal(outbound.session.audio.input.transcription.prompt, "Prefer English.");
  assert.deepEqual(outbound.session.include, ["item.input_audio_transcription.logprobs"]);
});

test("OpenAiRealtimeTranscriptionClient keeps gpt-4o-transcribe as input transcription model", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    inputAudioFormat: "pcm16",
    inputTranscriptionModel: "gpt-4o-transcribe",
    inputTranscriptionLanguage: "en",
    inputTranscriptionPrompt: "Prefer English."
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.type, "session.update");
  assert.equal(outbound.session.audio.input.transcription.model, "gpt-4o-transcribe");
});

test("OpenAiRealtimeTranscriptionClient normalizes unsupported ASR model values", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    inputAudioFormat: "pcm16",
    inputTranscriptionModel: "not-a-real-model",
    inputTranscriptionLanguage: "en",
    inputTranscriptionPrompt: "Prefer English."
  };

  client.sendSessionUpdate();

  assert.ok(outbound);
  assert.equal(outbound.type, "session.update");
  assert.equal(outbound.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
});

test("OpenAiRealtimeTranscriptionClient emits transcript final flag by event type", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received = [];
  client.on("transcript", (payload) => {
    received.push(payload);
  });

  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello"
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello there"
    })
  );

  assert.equal(received.length, 2);
  assert.equal(received[0]?.text, "hello");
  assert.equal(received[0]?.final, false);
  assert.equal(received[0]?.itemId, null);
  assert.equal(received[0]?.previousItemId, null);
  assert.equal(received[1]?.text, "hello there");
  assert.equal(received[1]?.final, true);
  assert.equal(received[1]?.itemId, null);
  assert.equal(received[1]?.previousItemId, null);
});

test("OpenAiRealtimeTranscriptionClient carries item linkage metadata for transcript events", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received = [];
  client.on("transcript", (payload) => {
    received.push(payload);
  });

  client.handleIncoming(
    JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: "item_002",
      previous_item_id: "item_001"
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_002",
      transcript: "final transcript"
    })
  );

  assert.equal(received.length, 1);
  assert.equal(received[0]?.final, true);
  assert.equal(received[0]?.itemId, "item_002");
  assert.equal(received[0]?.previousItemId, "item_001");
});

test("OpenAiRealtimeTranscriptionClient completed events emit logprobs", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received: Record<string, unknown>[] = [];
  client.on("transcript", (payload: Record<string, unknown>) => {
    received.push(payload);
  });

  const logprobs = [
    { token: "hello", logprob: -0.3, bytes: null },
    { token: " there", logprob: -0.7, bytes: null }
  ];
  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello there",
      item_id: "item_010",
      logprobs
    })
  );

  assert.equal(received.length, 1);
  assert.equal(received[0]?.final, true);
  assert.deepEqual(received[0]?.logprobs, logprobs);
});

test("OpenAiRealtimeTranscriptionClient delta events emit null logprobs", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received: Record<string, unknown>[] = [];
  client.on("transcript", (payload: Record<string, unknown>) => {
    received.push(payload);
  });

  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "partial text"
    })
  );

  assert.equal(received.length, 1);
  assert.equal(received[0]?.final, false);
  assert.equal(received[0]?.logprobs, null);
});

test("OpenAiRealtimeTranscriptionClient completed events without logprobs emit null", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const received: Record<string, unknown>[] = [];
  client.on("transcript", (payload: Record<string, unknown>) => {
    received.push(payload);
  });

  client.handleIncoming(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "no logprobs here",
      item_id: "item_011"
    })
  );

  assert.equal(received.length, 1);
  assert.equal(received[0]?.final, true);
  assert.equal(received[0]?.logprobs, null);
});

test("OpenAiRealtimeTranscriptionClient buildRealtimeUrl uses transcription intent", () => {
  const client = new OpenAiRealtimeTranscriptionClient({ apiKey: "test-key" });
  const url = client.buildRealtimeUrl();
  assert.equal(url.includes("intent=transcription"), true);
  assert.equal(url.includes("model="), false);
});
