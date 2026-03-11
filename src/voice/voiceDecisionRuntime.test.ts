import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  computeAsrTranscriptConfidence,
  parseVoiceThoughtDecisionContract,
  resolveTurnTranscriptionPlan,
  transcribePcmTurnWithPlan
} from "./voiceDecisionRuntime.ts";

test("parseVoiceThoughtDecisionContract parses strict JSON payloads", () => {
  const parsed = parseVoiceThoughtDecisionContract(
    JSON.stringify({
      allow: true,
      finalThought: "let's switch topics real quick",
      usedMemory: true,
      reason: "natural_memory_callback"
    })
  );

  assert.equal(parsed.confident, true);
  assert.equal(parsed.allow, true);
  assert.equal(parsed.finalThought, "let's switch topics real quick");
  assert.equal(parsed.usedMemory, true);
  assert.equal(parsed.reason, "natural_memory_callback");
});

test("parseVoiceThoughtDecisionContract parses YES/NO token fallback", () => {
  const parsed = parseVoiceThoughtDecisionContract(
    "YES: here's a cleaner line used_memory=true reason=rewrote_for_flow"
  );

  assert.equal(parsed.confident, true);
  assert.equal(parsed.allow, true);
  assert.equal(parsed.finalThought, "here's a cleaner line");
  assert.equal(parsed.usedMemory, true);
  assert.equal(parsed.reason, "rewrote_for_flow");
});

test("parseVoiceThoughtDecisionContract marks invalid output as not confident", () => {
  const parsed = parseVoiceThoughtDecisionContract("maybe");
  assert.equal(parsed.confident, false);
  assert.equal(parsed.allow, false);
  assert.equal(parsed.finalThought, "");
});

test("computeAsrTranscriptConfidence returns null for null/empty input", () => {
  assert.equal(computeAsrTranscriptConfidence(null), null);
  assert.equal(computeAsrTranscriptConfidence(undefined), null);
  assert.equal(computeAsrTranscriptConfidence([]), null);
});

test("computeAsrTranscriptConfidence computes mean, min, and count for valid logprobs", () => {
  const logprobs = [
    { token: "hello", logprob: -0.5, bytes: null },
    { token: " there", logprob: -1.5, bytes: null },
    { token: " friend", logprob: -0.2, bytes: null }
  ];
  const result = computeAsrTranscriptConfidence(logprobs);
  assert.ok(result);
  assert.equal(result.tokenCount, 3);
  assert.ok(Math.abs(result.meanLogprob - (-0.5 + -1.5 + -0.2) / 3) < 0.0001);
  assert.equal(result.minLogprob, -1.5);
});

test("computeAsrTranscriptConfidence skips entries with non-finite logprob", () => {
  const logprobs = [
    { token: "a", logprob: -0.8, bytes: null },
    { token: "b", logprob: NaN, bytes: null },
    { token: "c", logprob: -1.2, bytes: null }
  ];
  const result = computeAsrTranscriptConfidence(logprobs);
  assert.ok(result);
  assert.equal(result.tokenCount, 2);
  assert.ok(Math.abs(result.meanLogprob - (-0.8 + -1.2) / 2) < 0.0001);
  assert.equal(result.minLogprob, -1.2);
});

test("computeAsrTranscriptConfidence returns null when all entries have invalid logprob", () => {
  const logprobs = [
    { token: "x", logprob: NaN, bytes: null },
    { token: "y", logprob: Infinity, bytes: null }
  ];
  assert.equal(computeAsrTranscriptConfidence(logprobs), null);
});

test("computeAsrTranscriptConfidence threshold boundary: -1.0 is above threshold", () => {
  const logprobs = [
    { token: "hey", logprob: -1.0, bytes: null }
  ];
  const result = computeAsrTranscriptConfidence(logprobs);
  assert.ok(result);
  // -1.0 is exactly at threshold, NOT below it — should pass the gate
  assert.equal(result.meanLogprob >= -1.0, true);
});

test("computeAsrTranscriptConfidence hallucination scenario: very low logprobs", () => {
  const logprobs = [
    { token: "alright", logprob: -3.2, bytes: null },
    { token: " hit", logprob: -4.1, bytes: null },
    { token: " me", logprob: -2.8, bytes: null }
  ];
  const result = computeAsrTranscriptConfidence(logprobs);
  assert.ok(result);
  assert.equal(result.meanLogprob < -1.0, true);
});

test("resolveTurnTranscriptionPlan upgrades short realtime mini clips without fallback", () => {
  const plan = resolveTurnTranscriptionPlan({
    mode: "openai_realtime",
    configuredModel: "gpt-4o-mini-transcribe",
    pcmByteLength: 22080,
    sampleRateHz: 24000
  });

  assert.equal(plan.primaryModel, "gpt-4o-mini-transcribe");
  assert.equal(plan.fallbackModel, null);
  assert.equal(plan.reason, "short_clip_prefers_full_model");
});

test("resolveRealtimeTurnTranscriptionPlan keeps mini with a full-model fallback on longer clips", () => {
  const plan = resolveTurnTranscriptionPlan({
    mode: "openai_realtime",
    configuredModel: "gpt-4o-mini-transcribe",
    pcmByteLength: 160000,
    sampleRateHz: 24000
  });

  assert.equal(plan.primaryModel, "gpt-4o-mini-transcribe");
  assert.equal(plan.fallbackModel, "whisper-1");
  assert.equal(plan.reason, "mini_with_full_fallback");
});

test("resolveTurnTranscriptionPlan gives non-realtime mini turns the full fallback", () => {
  const plan = resolveTurnTranscriptionPlan({
    mode: "voice_agent",
    configuredModel: "gpt-4o-mini-transcribe"
  });

  assert.equal(plan.primaryModel, "gpt-4o-mini-transcribe");
  assert.equal(plan.fallbackModel, "whisper-1");
  assert.equal(plan.reason, "mini_with_full_fallback_runtime");
});

test("transcribePcmTurnWithPlan retries with the fallback model once", async () => {
  const models: string[] = [];
  const result = await transcribePcmTurnWithPlan({
    transcribe: async ({ model }) => {
      models.push(model);
      return model === "whisper-1" ? "stop music" : "";
    },
    session: { id: "session-1" },
    userId: "user-1",
    pcmBuffer: Buffer.from([1, 2, 3]),
    plan: {
      primaryModel: "gpt-4o-mini-transcribe",
      fallbackModel: "whisper-1",
      reason: "mini_with_full_fallback_runtime"
    },
    traceSource: "voice_music_stop_realtime",
    errorPrefix: "voice_music_transcription_failed"
  });

  assert.deepEqual(models, ["gpt-4o-mini-transcribe", "whisper-1"]);
  assert.equal(result.transcript, "stop music");
  assert.equal(result.usedFallbackModel, true);
  assert.equal(result.fallbackModel, "whisper-1");
  assert.equal(result.reason, "mini_with_full_fallback_runtime");
});
