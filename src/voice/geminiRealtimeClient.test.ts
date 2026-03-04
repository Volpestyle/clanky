import { test } from "bun:test";
import assert from "node:assert/strict";
import { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";

test("GeminiRealtimeClient builds websocket URL and normalizes model prefix", () => {
  const client = new GeminiRealtimeClient({
    apiKey: "gem-key",
    baseUrl: "http://example.com/custom/path"
  });
  const url = client.buildRealtimeUrl();
  assert.equal(
    url,
    "ws://example.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=gem-key"
  );

  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };
  client.sessionConfig = {
    model: "gemini-2.5-flash",
    voice: "Aoede",
    instructions: "brief",
    inputAudioMimeType: "audio/pcm;rate=16000",
    outputAudioMimeType: "audio/pcm;rate=24000"
  };
  client.sendSetup();

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]?.setup?.model, "models/gemini-2.5-flash");
});

test("GeminiRealtimeClient append/commit audio emits start, media, and end events", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  client.sessionConfig = {
    inputAudioMimeType: "audio/pcm;rate=16000"
  };

  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.appendInputAudioPcm(Buffer.from([1, 2, 3, 4, 5, 6]));
  client.appendInputAudioPcm(Buffer.from([7, 8, 9, 10, 11, 12]));
  client.commitInputAudioBuffer();

  assert.equal(outbound.length, 4);
  assert.deepEqual(outbound[0], {
    realtimeInput: {
      activityStart: {}
    }
  });
  assert.equal(outbound[1]?.realtimeInput?.mediaChunks?.[0]?.data, Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64"));
  assert.equal(outbound[2]?.realtimeInput?.mediaChunks?.[0]?.data, Buffer.from([7, 8, 9, 10, 11, 12]).toString("base64"));
  assert.deepEqual(outbound[3], {
    realtimeInput: {
      activityEnd: {}
    }
  });
});

test("GeminiRealtimeClient requestVideoCommentary sends user turn and tracks active response", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.requestVideoCommentary("what is on screen?");
  assert.equal(client.isResponseInProgress(), true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]?.clientContent?.turns?.[0]?.parts?.[0]?.text, "what is on screen?");
});

test("GeminiRealtimeClient cancelActiveResponse is a no-op", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  client.pendingResponseActive = true;

  const cancelled = client.cancelActiveResponse();

  assert.equal(cancelled, false);
  assert.equal(client.pendingResponseActive, true);
});

test("GeminiRealtimeClient handleIncoming emits setup, transcript, audio, done, and errors", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  const audio = [];
  const transcripts = [];
  const done = [];
  const errors = [];

  client.on("audio_delta", (chunk) => audio.push(chunk));
  client.on("transcript", (row) => transcripts.push(row));
  client.on("response_done", (event) => done.push(event));
  client.on("error_event", (event) => errors.push(event));

  client.handleIncoming(JSON.stringify({ setupComplete: {} }));
  assert.equal(client.setupComplete, true);

  client.pendingResponseActive = true;
  client.handleIncoming(
    JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: { data: "AUDIO64" },
              text: "spoken line"
            }
          ]
        },
        inputTranscription: { text: "input heard" },
        outputTranscription: { text: "output heard" },
        generationComplete: true
      }
    })
  );

  assert.deepEqual(audio, ["AUDIO64"]);
  assert.equal(transcripts.length, 3);
  assert.deepEqual(
    transcripts.map((row) => row.eventType),
    ["server_content_text", "input_audio_transcription", "output_audio_transcription"]
  );
  assert.equal(done.length, 1);
  assert.equal(done[0]?.response?.status, "completed");
  assert.equal(client.pendingResponseActive, false);

  client.lastOutboundEventType = "setup";
  client.lastOutboundEvent = { type: "setup" };
  client.recentOutboundEvents = [{ type: "setup" }];
  client.handleIncoming(
    JSON.stringify({
      error: {
        message: "bad request",
        code: 400,
        status: "INVALID_ARGUMENT"
      }
    })
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "bad request");
  assert.equal(errors[0]?.code, 400);
  assert.equal(errors[0]?.lastOutboundEventType, "setup");
});

test("GeminiRealtimeClient updateInstructions requires initialized session config", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  assert.throws(
    () => client.updateInstructions("new"),
    /session config is not initialized/i
  );

  client.sessionConfig = {
    model: "models/gemini-2.5-flash",
    instructions: "old"
  };
  client.updateInstructions("new prompt");
  assert.equal(client.sessionConfig.instructions, "new prompt");
});

test("GeminiRealtimeClient send throws when websocket is unavailable", () => {
  const client = new GeminiRealtimeClient({ apiKey: "gem-key" });
  assert.throws(
    () => client.send({ setup: {} }),
    /socket is not open/i
  );
});
