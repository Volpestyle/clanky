import { test } from "bun:test";
import assert from "node:assert/strict";
import { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";

test("ElevenLabsRealtimeClient constructor initializes all state", () => {
  const client = new ElevenLabsRealtimeClient({
    apiKey: "test-key",
    baseUrl: "https://api.elevenlabs.io"
  });
  assert.equal(client.ws, null);
  assert.equal(client.connectedAt, 0);
  assert.equal(client.lastError, null);
  assert.equal(client.sessionConfig, null);
  assert.equal(client.activeResponseId, null);
});

test("ElevenLabsRealtimeClient requestPlaybackUtterance sets response state", () => {
  const client = new ElevenLabsRealtimeClient({
    apiKey: "test-key"
  });

  // Simulate connected WebSocket
  const sent: string[] = [];
  client.ws = {
    readyState: 1, // WebSocket.OPEN
    send(data: string) { sent.push(data); }
  } as { readyState: number; send: (data: string) => void };
  client.connectedAt = Date.now();

  client.requestPlaybackUtterance("Hello, world!");

  assert.equal(client.isResponseInProgress(), true);
  assert.ok(client.activeResponseId?.startsWith("el_utt_"));
  assert.equal(client.activeResponseStatus, "in_progress");
  assert.equal(sent.length, 1);

  const payload = JSON.parse(sent[0]);
  assert.equal(payload.text, "Hello, world! ");
  assert.equal(payload.flush, true);
});

test("ElevenLabsRealtimeClient requestTextUtterance delegates to requestPlaybackUtterance", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  const sent: string[] = [];
  client.ws = {
    readyState: 1,
    send(data: string) { sent.push(data); }
  } as { readyState: number; send: (data: string) => void };
  client.connectedAt = Date.now();

  client.requestTextUtterance("Test message");

  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]);
  assert.equal(payload.text, "Test message ");
  assert.equal(payload.flush, true);
});

test("ElevenLabsRealtimeClient handleIncoming emits audio_delta for audio chunks", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  const audioDeltas: string[] = [];
  client.on("audio_delta", (b64: string) => audioDeltas.push(b64));

  client.handleIncoming(JSON.stringify({ audio: "dGVzdA==" }));

  assert.equal(audioDeltas.length, 1);
  assert.equal(audioDeltas[0], "dGVzdA==");
});

test("ElevenLabsRealtimeClient handleIncoming emits response_done on isFinal", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  client["_responseInProgress"] = true;

  let responseDoneEmitted = false;
  client.on("response_done", () => { responseDoneEmitted = true; });

  client.handleIncoming(JSON.stringify({ isFinal: true }));

  assert.equal(responseDoneEmitted, true);
  assert.equal(client.isResponseInProgress(), false);
  assert.equal(client.activeResponseStatus, "completed");
});

test("ElevenLabsRealtimeClient handleIncoming emits error_event for errors", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  let errorEvent: any = null;
  client.on("error_event", (evt) => { errorEvent = evt; });

  client.handleIncoming(JSON.stringify({ error: "rate limit exceeded" }));

  assert.ok(errorEvent);
  assert.equal(errorEvent.message, "rate limit exceeded");
  assert.equal(client.lastError, "rate limit exceeded");
});

test("ElevenLabsRealtimeClient getInterruptAcceptanceMode returns local cut", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  assert.equal(client.getInterruptAcceptanceMode(), "local_cut_async_confirmation");
});

test("ElevenLabsRealtimeClient cancelActiveResponse returns false (not supported)", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  client["_responseInProgress"] = true;
  const result = client.cancelActiveResponse();
  assert.equal(result, false);
  assert.equal(client.isResponseInProgress(), false);
});

test("ElevenLabsRealtimeClient appendInputAudioPcm is a no-op", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  // Should not throw
  client.appendInputAudioPcm(Buffer.from([1, 2, 3]));
});

test("ElevenLabsRealtimeClient getState includes model and utterance count", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  client.sessionConfig = { model: "eleven_multilingual_v2" };

  const state = client.getState();
  assert.equal(state.model, "eleven_multilingual_v2");
  assert.equal(state.utteranceCount, 0);
  assert.equal(state.connected, false);
});
