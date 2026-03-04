import { test } from "bun:test";
import assert from "node:assert/strict";
import { XaiRealtimeClient } from "./xaiRealtimeClient.ts";

test("XaiRealtimeClient requestTextUtterance sends text item then audio response request", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.requestTextUtterance("say this");

  assert.equal(outbound.length, 2);
  assert.equal(outbound[0]?.type, "conversation.item.create");
  assert.equal(outbound[0]?.item?.type, "message");
  assert.equal(outbound[0]?.item?.role, "user");
  assert.equal(outbound[0]?.item?.content?.[0]?.type, "input_text");
  assert.equal(outbound[0]?.item?.content?.[0]?.text, "say this");
  assert.equal(outbound[1]?.type, "response.create");
  assert.deepEqual(outbound[1]?.response?.modalities, ["audio", "text"]);
});

test("XaiRealtimeClient appendInputAudioPcm encodes and sends audio chunk", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.appendInputAudioPcm(Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]?.type, "input_audio_buffer.append");
  assert.equal(outbound[0]?.audio, Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64"));
});

test("XaiRealtimeClient cancelActiveResponse sends response.cancel", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  const cancelled = client.cancelActiveResponse();

  assert.equal(cancelled, true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]?.type, "response.cancel");
});

test("XaiRealtimeClient handleIncoming emits audio, transcript, response_done, and error metadata", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  const audioChunks = [];
  const transcripts = [];
  const done = [];
  const errors = [];

  client.on("audio_delta", (chunk) => audioChunks.push(chunk));
  client.on("transcript", (row) => transcripts.push(row));
  client.on("response_done", (event) => done.push(event));
  client.on("error_event", (event) => errors.push(event));

  client.handleIncoming(
    JSON.stringify({
      type: "response.audio.delta",
      delta: "AUDIO_BASE64"
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "response.text.done",
      text: "spoken text"
    })
  );
  client.handleIncoming(
    JSON.stringify({
      type: "response.done",
      response: {
        id: "resp-1",
        status: "completed"
      }
    })
  );

  assert.deepEqual(audioChunks, ["AUDIO_BASE64"]);
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0]?.text, "spoken text");
  assert.equal(done.length, 1);
  assert.equal(done[0]?.response?.id, "resp-1");

  client.lastOutboundEventType = "session.update";
  client.lastOutboundEvent = { type: "session.update" };
  client.recentOutboundEvents = [{ type: "session.update" }];
  client.handleIncoming(
    JSON.stringify({
      type: "error",
      error: {
        message: "invalid input",
        code: "bad_request",
        param: "session"
      }
    })
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "invalid input");
  assert.equal(errors[0]?.code, "bad_request");
  assert.equal(errors[0]?.param, "session");
  assert.equal(errors[0]?.lastOutboundEventType, "session.update");
});

test("XaiRealtimeClient send records outbound state and requires open socket", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  assert.throws(
    () => client.send({ type: "response.create" }),
    /socket is not open/i
  );

  let sentPayload = null;
  client.ws = {
    readyState: 1,
    send(raw) {
      sentPayload = JSON.parse(raw);
    }
  };
  client.send({
    type: "response.create",
    response: {
      modalities: ["audio", "text"]
    }
  });

  assert.equal(sentPayload?.type, "response.create");
  assert.equal(client.lastOutboundEventType, "response.create");
  assert.equal(Array.isArray(client.recentOutboundEvents), true);
  assert.equal(client.recentOutboundEvents.length, 1);
});
