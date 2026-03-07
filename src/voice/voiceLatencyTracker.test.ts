import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildVoiceLatencyStageMetrics,
  computeLatencyMs
} from "./voiceLatencyTracker.ts";

describe("computeLatencyMs", () => {
  test("returns rounded elapsed milliseconds for valid timestamps", () => {
    assert.equal(computeLatencyMs(100.25, 160.75), 61);
  });

  test("returns null for non-finite, non-positive, or reversed timestamps", () => {
    assert.equal(computeLatencyMs(0, 100), null);
    assert.equal(computeLatencyMs(100, 99), null);
    assert.equal(computeLatencyMs(Number.NaN, 100), null);
    assert.equal(computeLatencyMs(100, Number.POSITIVE_INFINITY), null);
  });
});

describe("buildVoiceLatencyStageMetrics", () => {
  test("computes each stage from adjacent timestamps", () => {
    const metrics = buildVoiceLatencyStageMetrics({
      finalizedAtMs: 100,
      asrStartedAtMs: 140,
      asrCompletedAtMs: 220,
      generationStartedAtMs: 350,
      replyRequestedAtMs: 400,
      audioStartedAtMs: 455
    });

    assert.deepEqual(metrics, {
      finalizedToAsrStartMs: 40,
      asrToGenerationStartMs: 130,
      generationToReplyRequestMs: 50,
      replyRequestToAudioStartMs: 55
    });
  });

  test("computes each stage independently when some timestamps are missing or invalid", () => {
    const metrics = buildVoiceLatencyStageMetrics({
      finalizedAtMs: 100,
      asrStartedAtMs: 150,
      asrCompletedAtMs: 0,
      generationStartedAtMs: 260,
      replyRequestedAtMs: 310,
      audioStartedAtMs: 305
    });

    assert.deepEqual(metrics, {
      finalizedToAsrStartMs: 50,
      asrToGenerationStartMs: null,
      generationToReplyRequestMs: 50,
      replyRequestToAudioStartMs: null
    });
  });
});
