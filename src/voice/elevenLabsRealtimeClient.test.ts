import { test } from "bun:test";
import assert from "node:assert/strict";
import { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";

test("ElevenLabsRealtimeClient sendConversationInitiation includes prompt override when present", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  let outbound = null;
  client.send = (payload) => {
    outbound = payload;
  };
  client.sessionConfig = {
    agentId: "agent_123",
    instructions: "Keep replies short.",
    inputSampleRateHz: 16000,
    outputSampleRateHz: 16000
  };

  client.sendConversationInitiation();

  assert.ok(outbound);
  assert.equal(outbound.type, "conversation_initiation_client_data");
  assert.equal(outbound.conversation_config_override.agent.prompt.prompt, "Keep replies short.");
});

test("ElevenLabsRealtimeClient buffers audio chunks until commit and can nudge response creation", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.appendInputAudioPcm(Buffer.from([1, 2, 3, 4, 5, 6]));
  client.appendInputAudioBase64("B64_CHUNK");
  client.commitInputAudioBuffer();
  client.createAudioResponse();

  assert.equal(outbound.length, 3);
  assert.equal(outbound[0]?.user_audio_chunk, Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64"));
  assert.equal(outbound[1]?.user_audio_chunk, "B64_CHUNK");
  assert.equal(outbound[2]?.type, "user_activity");
});

test("ElevenLabsRealtimeClient cancelActiveResponse is a no-op", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  assert.equal(client.cancelActiveResponse(), false);
});

test("ElevenLabsRealtimeClient handleIncoming maps metadata, audio, transcripts, ping, and interruptions", () => {
  const client = new ElevenLabsRealtimeClient({ apiKey: "test-key" });
  client.sessionConfig = {
    agentId: "agent_123",
    instructions: "",
    inputSampleRateHz: 16000,
    outputSampleRateHz: 16000
  };

  const outbound = [];
  const audio = [];
  const transcripts = [];
  const done = [];

  client.send = (payload) => {
    outbound.push(payload);
  };
  client.on("audio_delta", (chunk) => audio.push(chunk));
  client.on("transcript", (row) => transcripts.push(row));
  client.on("response_done", (event) => done.push(event));

  client.handleIncoming(
    JSON.stringify({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata: {
        conversation_id: "conv_abc",
        user_input_audio_format: "pcm_16000",
        agent_output_audio_format: "pcm_22050"
      }
    })
  );
  assert.equal(client.sessionId, "conv_abc");
  assert.equal(client.sessionConfig.inputSampleRateHz, 16000);
  assert.equal(client.sessionConfig.outputSampleRateHz, 22050);

  client.handleIncoming(
    JSON.stringify({
      type: "audio",
      audio_event: {
        audio_base_64: "AUDIO64"
      }
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "user_transcript",
      user_transcription_event: {
        user_transcript: "yo bot"
      }
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "agent_response",
      agent_response_event: {
        agent_response: "what's good"
      }
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "agent_response_correction",
      agent_response_correction_event: {
        corrected_agent_response: "what is good"
      }
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "ping",
      ping_event: {
        event_id: 99
      }
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "interruption"
    })
  );

  assert.deepEqual(audio, ["AUDIO64"]);
  assert.deepEqual(
    transcripts.map((row) => row.eventType),
    ["user_transcript", "agent_response", "agent_response_correction"]
  );
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]?.type, "pong");
  assert.equal(outbound[0]?.event_id, "99");
  assert.equal(done.length, 1);
  assert.equal(done[0]?.response?.status, "interrupted");
});
