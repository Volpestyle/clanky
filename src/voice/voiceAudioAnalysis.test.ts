import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  analyzeMonoPcmSignal,
  estimateDiscordPcmPlaybackDurationMs,
  estimatePcm16MonoDurationMs,
  evaluatePcmSilenceGate
} from "./voiceAudioAnalysis.ts";

function pcm16(samples: number[]) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

describe("analyzeMonoPcmSignal", () => {
  test("calculates sample count, rms, peak, and active ratio for pcm16 audio", () => {
    const analysis = analyzeMonoPcmSignal(pcm16([16384, -16384]));

    assert.deepEqual(analysis, {
      sampleCount: 2,
      rms: 0.5,
      peak: 0.5,
      activeSampleRatio: 1
    });
  });

  test("ignores trailing odd bytes and accepts Uint8Array input", () => {
    const analysis = analyzeMonoPcmSignal(Uint8Array.from([0, 64, 255]));

    assert.deepEqual(analysis, {
      sampleCount: 1,
      rms: 0.5,
      peak: 0.5,
      activeSampleRatio: 1
    });
  });
});

describe("evaluatePcmSilenceGate", () => {
  test("drops sufficiently long near-silent clips", () => {
    const evaluation = evaluatePcmSilenceGate({
      pcmBuffer: Buffer.alloc(14_000)
    });

    assert.equal(evaluation.clipDurationMs, 292);
    assert.equal(evaluation.drop, true);
    assert.equal(evaluation.rms, 0);
    assert.equal(evaluation.peak, 0);
    assert.equal(evaluation.activeSampleRatio, 0);
  });

  test("keeps short clips even when they are silent", () => {
    const evaluation = evaluatePcmSilenceGate({
      pcmBuffer: Buffer.alloc(2_000)
    });

    assert.equal(evaluation.clipDurationMs, 42);
    assert.equal(evaluation.drop, false);
  });

  test("keeps long clips that exceed the silence thresholds", () => {
    const evaluation = evaluatePcmSilenceGate({
      pcmBuffer: pcm16(Array.from({ length: 7_000 }, () => 200))
    });

    assert.equal(evaluation.drop, false);
    assert.ok(evaluation.rms > 0.003);
    assert.equal(evaluation.activeSampleRatio, 1);
  });
});

describe("duration estimators", () => {
  test("estimates pcm16 mono duration with default and custom sample rates", () => {
    assert.equal(estimatePcm16MonoDurationMs(9_600), 200);
    assert.equal(estimatePcm16MonoDurationMs(3_200, 8_000), 200);
    assert.equal(estimatePcm16MonoDurationMs(-100), 0);
  });

  test("estimates discord playback duration from stereo 48 kHz pcm", () => {
    assert.equal(estimateDiscordPcmPlaybackDurationMs(38_400), 200);
    assert.equal(estimateDiscordPcmPlaybackDurationMs(-100), 0);
  });
});
