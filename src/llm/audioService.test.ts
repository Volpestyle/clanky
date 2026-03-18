import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  synthesizeSpeech,
  transcribeAudio,
  type AudioServiceDeps
} from "./audioService.ts";

type LoggedAction = {
  kind: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  content?: string;
  metadata?: Record<string, unknown>;
  usdCost?: number;
};

class FakeRealtimeSocket extends EventEmitter {
  sentPayloads: string[] = [];
  closeCalls: Array<{ code: number; reason: string }> = [];
  onSend?: (payload: Record<string, unknown>) => void;

  constructor(onSend?: (payload: Record<string, unknown>) => void) {
    super();
    this.onSend = onSend;
  }

  send(payload: string) {
    this.sentPayloads.push(payload);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    this.onSend?.(parsed);
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
  }
}

function createAudioDeps(
  overrides: Partial<AudioServiceDeps> = {}
): { deps: AudioServiceDeps; logs: LoggedAction[] } {
  const logs: LoggedAction[] = [];
  const deps: AudioServiceDeps = {
    openai: null,
    elevenLabsApiKey: "test-elevenlabs-key",
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    ...overrides
  };
  return { deps, logs };
}

test("synthesizeSpeech uses the official ElevenLabs streaming endpoint contract", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | null = null;
  const { deps, logs } = createAudioDeps({
    fetchFn: async (input, init) => {
      seenUrl = String(input);
      seenInit = init ?? null;
      return new Response(Buffer.from([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream"
        }
      });
    }
  });

  const response = await synthesizeSpeech(deps, {
    provider: "elevenlabs",
    text: "  Hello   ElevenLabs  ",
    model: "eleven_multilingual_v2",
    voice: "voice_123",
    speed: 1.1,
    sampleRateHz: 22050,
    trace: {
      source: "unit_test"
    }
  });

  assert.deepEqual(response.audioBuffer, Buffer.from([1, 2, 3, 4]));
  assert.equal(response.model, "eleven_multilingual_v2");
  assert.equal(response.voice, "voice_123");
  assert.equal(response.responseFormat, "pcm");

  const url = new URL(seenUrl);
  assert.equal(url.origin, "https://api.elevenlabs.io");
  assert.equal(url.pathname, "/v1/text-to-speech/voice_123/stream");
  assert.equal(url.searchParams.get("output_format"), "pcm_22050");

  assert.equal(seenInit?.method, "POST");
  assert.deepEqual(seenInit?.headers, {
    "Content-Type": "application/json",
    "xi-api-key": "test-elevenlabs-key"
  });

  const body = JSON.parse(String(seenInit?.body || "{}")) as Record<string, unknown>;
  assert.deepEqual(body, {
    text: "Hello ElevenLabs",
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      speed: 1.1
    }
  });

  const ttsCall = logs.find((entry) => entry.kind === "tts_call");
  assert.equal(ttsCall?.metadata?.provider, "elevenlabs");
  assert.equal(ttsCall?.metadata?.outputFormat, "pcm_22050");
  assert.equal(ttsCall?.metadata?.sampleRateHz, 22050);
});

test("transcribeAudio uses the official ElevenLabs realtime speech-to-text websocket contract", async () => {
  let seenConnectArgs: Record<string, unknown> | null = null;
  let socket: FakeRealtimeSocket | null = null;
  const { deps, logs } = createAudioDeps({
    openWebSocket: async (args) => {
      seenConnectArgs = args as Record<string, unknown>;
      socket = new FakeRealtimeSocket((payload) => {
        if (payload.commit === true && socket) {
          queueMicrotask(() => {
            socket?.emit("message", JSON.stringify({
              message_type: "committed_transcript",
              text: "hello from elevenlabs"
            }));
          });
        }
      });
      return socket as never;
    }
  });

  const transcript = await transcribeAudio(deps, {
    provider: "elevenlabs",
    audioBytes: Buffer.from([0, 1, 2, 3]),
    fileName: "clip.pcm",
    model: "scribe_v1",
    language: "en-US",
    prompt: "  prior   context  ",
    sampleRateHz: 22050,
    trace: {
      source: "unit_test"
    }
  });

  assert.equal(transcript, "hello from elevenlabs");

  const url = new URL(String(seenConnectArgs?.url || ""));
  assert.equal(url.origin, "wss://api.elevenlabs.io");
  assert.equal(url.pathname, "/v1/speech-to-text/realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_22050");
  assert.equal(url.searchParams.get("commit_strategy"), "manual");
  assert.equal(url.searchParams.get("model_id"), "scribe_v1");
  assert.equal(url.searchParams.get("language_code"), "en-us");
  assert.deepEqual(seenConnectArgs?.headers, {
    "Content-Type": "application/json",
    "xi-api-key": "test-elevenlabs-key"
  });

  assert.equal(socket?.sentPayloads.length, 1);
  const sentPayload = JSON.parse(String(socket?.sentPayloads[0] || "{}")) as Record<string, unknown>;
  assert.deepEqual(sentPayload, {
    message_type: "input_audio_chunk",
    audio_base_64: Buffer.from([0, 1, 2, 3]).toString("base64"),
    commit: true,
    sample_rate: 22050,
    previous_text: "prior context"
  });
  assert.deepEqual(socket?.closeCalls, [
    {
      code: 1000,
      reason: "transcription_complete"
    }
  ]);

  const asrCall = logs.find((entry) => entry.kind === "asr_call");
  assert.equal(asrCall?.metadata?.provider, "elevenlabs");
  assert.equal(asrCall?.metadata?.model, "scribe_v1");
  assert.equal(asrCall?.metadata?.sampleRateHz, 22050);
});
