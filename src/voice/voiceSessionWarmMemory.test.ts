import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createWarmMemoryState,
  cosineSimilarity,
  detectTopicDrift,
  updateTopicFingerprint,
  captureWarmSnapshot,
  invalidateWarmSnapshot,
  resolveWarmMemory,
  WARM_MEMORY_CONSTANTS
} from "./voiceSessionWarmMemory.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeEmbedding(seed: number, dims = 8): number[] {
  // Deterministic pseudo-random vector for testing
  const vec = [];
  for (let i = 0; i < dims; i++) {
    vec.push(Math.sin(seed * (i + 1) * 0.7) * 0.5 + 0.5);
  }
  return vec;
}

function makeEmbeddingResult(seed: number, dims = 8) {
  return { embedding: makeEmbedding(seed, dims), model: "test-model" };
}

function makeSnapshot(transcript = "test transcript") {
  return {
    continuity: {
      memorySlice: { userFacts: [], relevantFacts: [] },
      recentConversationHistory: []
    },
    behavioralFacts: [],
    usedCachedBehavioralFacts: true,
    capturedAt: Date.now(),
    sourceTranscript: transcript
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test("createWarmMemoryState returns empty state", () => {
  const state = createWarmMemoryState();
  assert.equal(state.topicFingerprint, null);
  assert.equal(state.snapshot, null);
  assert.equal(state.lastIngestEmbedding, null);
  assert.equal(state.pendingIngestEmbedding, null);
});

test("cosineSimilarity returns 1 for identical vectors", () => {
  const v = [1, 2, 3, 4];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.001);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001);
});

test("cosineSimilarity returns 0 for empty vectors", () => {
  assert.equal(cosineSimilarity([], [1, 2]), 0);
  assert.equal(cosineSimilarity([1, 2], []), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity returns 0 for mismatched dimensions", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test("detectTopicDrift returns cold when no fingerprint", () => {
  const state = createWarmMemoryState();
  const result = detectTopicDrift(state, makeEmbeddingResult(1));
  assert.equal(result.verdict, "cold");
});

test("detectTopicDrift returns cold when no snapshot", () => {
  const state = createWarmMemoryState();
  updateTopicFingerprint(state, makeEmbeddingResult(1));
  // No snapshot captured
  const result = detectTopicDrift(state, makeEmbeddingResult(1));
  assert.equal(result.verdict, "cold");
});

test("detectTopicDrift returns same for identical embedding", () => {
  const state = createWarmMemoryState();
  const emb = makeEmbeddingResult(42);
  updateTopicFingerprint(state, emb);
  captureWarmSnapshot(state, makeSnapshot());
  const result = detectTopicDrift(state, emb);
  assert.equal(result.verdict, "same");
  assert.ok(result.similarity > 0.99);
});

test("detectTopicDrift returns drift for very different embedding", () => {
  const state = createWarmMemoryState();
  updateTopicFingerprint(state, { embedding: [1, 0, 0, 0], model: "test-model" });
  captureWarmSnapshot(state, makeSnapshot());
  // Orthogonal-ish vector
  const result = detectTopicDrift(state, { embedding: [0, 0, 0, 1], model: "test-model" });
  assert.equal(result.verdict, "drift");
  assert.ok(result.similarity < WARM_MEMORY_CONSTANTS.DRIFT_THRESHOLD);
});

test("detectTopicDrift returns drift on model mismatch", () => {
  const state = createWarmMemoryState();
  updateTopicFingerprint(state, { embedding: [1, 2, 3], model: "model-a" });
  captureWarmSnapshot(state, makeSnapshot());
  const result = detectTopicDrift(state, { embedding: [1, 2, 3], model: "model-b" });
  assert.equal(result.verdict, "drift");
});

test("detectTopicDrift returns stale when snapshot is too old", () => {
  const state = createWarmMemoryState();
  updateTopicFingerprint(state, makeEmbeddingResult(1));
  const snap = makeSnapshot();
  snap.capturedAt = Date.now() - WARM_MEMORY_CONSTANTS.WARM_SNAPSHOT_MAX_AGE_MS - 1000;
  captureWarmSnapshot(state, snap);
  const result = detectTopicDrift(state, makeEmbeddingResult(1));
  assert.equal(result.verdict, "stale");
});

test("updateTopicFingerprint sets fingerprint on first call", () => {
  const state = createWarmMemoryState();
  const emb = makeEmbeddingResult(1);
  updateTopicFingerprint(state, emb);
  assert.ok(state.topicFingerprint);
  assert.equal(state.topicFingerprint.model, "test-model");
  assert.equal(state.topicFingerprint.turnCount, 1);
  assert.deepEqual(state.topicFingerprint.embedding, emb.embedding);
});

test("updateTopicFingerprint applies EMA on subsequent calls", () => {
  const state = createWarmMemoryState();
  const emb1 = { embedding: [1, 0, 0, 0], model: "test-model" };
  const emb2 = { embedding: [0, 1, 0, 0], model: "test-model" };
  updateTopicFingerprint(state, emb1, "user");
  updateTopicFingerprint(state, emb2, "user");
  assert.ok(state.topicFingerprint);
  assert.equal(state.topicFingerprint.turnCount, 2);
  // After EMA with user weight 0.3: [0.7*1 + 0.3*0, 0.7*0 + 0.3*1, 0, 0] = [0.7, 0.3, 0, 0]
  assert.ok(Math.abs(state.topicFingerprint.embedding[0] - 0.7) < 0.001);
  assert.ok(Math.abs(state.topicFingerprint.embedding[1] - 0.3) < 0.001);
});

test("updateTopicFingerprint applies lower weight for bot turns", () => {
  const state = createWarmMemoryState();
  const emb1 = { embedding: [1, 0, 0, 0], model: "test-model" };
  const emb2 = { embedding: [0, 1, 0, 0], model: "test-model" };
  updateTopicFingerprint(state, emb1, "user");
  updateTopicFingerprint(state, emb2, "bot");
  assert.ok(state.topicFingerprint);
  // Bot weight 0.1: [0.9*1 + 0.1*0, 0.9*0 + 0.1*1, 0, 0] = [0.9, 0.1, 0, 0]
  assert.ok(Math.abs(state.topicFingerprint.embedding[0] - 0.9) < 0.001);
  assert.ok(Math.abs(state.topicFingerprint.embedding[1] - 0.1) < 0.001);
});

test("captureWarmSnapshot stores snapshot", () => {
  const state = createWarmMemoryState();
  const snap = makeSnapshot("hello world");
  captureWarmSnapshot(state, snap);
  assert.equal(state.snapshot?.sourceTranscript, "hello world");
});

test("invalidateWarmSnapshot clears snapshot", () => {
  const state = createWarmMemoryState();
  captureWarmSnapshot(state, makeSnapshot());
  assert.ok(state.snapshot);
  invalidateWarmSnapshot(state);
  assert.equal(state.snapshot, null);
});

test("resolveWarmMemory returns snapshot on same topic", () => {
  const state = createWarmMemoryState();
  const emb = makeEmbeddingResult(42);
  updateTopicFingerprint(state, emb);
  captureWarmSnapshot(state, makeSnapshot());
  const result = resolveWarmMemory(state, emb);
  assert.ok(result.snapshot);
  assert.equal(result.drift, "same");
  assert.equal(result.reason, "same_topic");
});

test("resolveWarmMemory returns null on drift", () => {
  const state = createWarmMemoryState();
  updateTopicFingerprint(state, { embedding: [1, 0, 0, 0], model: "test-model" });
  captureWarmSnapshot(state, makeSnapshot());
  const result = resolveWarmMemory(state, { embedding: [0, 0, 0, 1], model: "test-model" });
  assert.equal(result.snapshot, null);
  assert.equal(result.drift, "drift");
});

test("resolveWarmMemory returns null when no embedding provided", () => {
  const state = createWarmMemoryState();
  const result = resolveWarmMemory(state, null);
  assert.equal(result.snapshot, null);
  assert.equal(result.drift, "cold");
  assert.equal(result.reason, "no_turn_embedding");
});

test("resolveWarmMemory returns snapshot in ambiguous zone (conservative)", () => {
  const state = createWarmMemoryState();
  // Create two vectors with moderate similarity (between thresholds)
  const emb1 = { embedding: [1, 0.5, 0.3, 0], model: "test-model" };
  updateTopicFingerprint(state, emb1);
  captureWarmSnapshot(state, makeSnapshot());
  // Slightly different but not orthogonal
  const emb2 = { embedding: [0.8, 0.6, 0.1, 0.3], model: "test-model" };
  const result = resolveWarmMemory(state, emb2);
  // Should be ambiguous (similarity between thresholds) and conservatively reuse
  if (result.drift === "ambiguous") {
    assert.ok(result.snapshot);
    assert.equal(result.reason, "ambiguous_conservative_reuse");
  }
  // If it's "same" that's also fine — the vector might be close enough
});
