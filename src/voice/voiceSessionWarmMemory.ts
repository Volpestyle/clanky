/**
 * Warm memory system for voice sessions.
 *
 * Maintains a hot working set of memory context between turns so that
 * same-topic turns skip durable retrieval entirely.  Drift detection uses
 * cosine similarity between each turn's embedding and a running topic
 * fingerprint (exponential moving average of recent turn embeddings).
 *
 * The embedding used for drift detection is the *same* embedding that the
 * voice memory ingest pipeline already computes — no additional API calls.
 *
 * Architecture:
 *   Turn 1 (cold): full retrieval, stores warm snapshot + topic fingerprint
 *   Turn 2+:       cosine(turnEmbedding, fingerprint) → drift check
 *                  no drift  → reuse warm snapshot (zero retrieval latency)
 *                  drift     → full retrieval, update warm snapshot + fingerprint
 */

import type { MemoryFactRow } from "../store/storeMemory.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface TopicFingerprint {
  /** Running centroid embedding vector (exponential moving average). */
  embedding: number[];
  /** Embedding model used (must match for comparison). */
  model: string;
  /** Number of turns that have contributed to this fingerprint. */
  turnCount: number;
  /** Timestamp of last update. */
  updatedAt: number;
}

export interface WarmMemorySnapshot {
  /** The continuity result from loadConversationContinuityContext. */
  continuity: {
    memorySlice: {
      participantProfiles?: unknown[];
      userFacts?: MemoryFactRow[];
      relevantFacts?: MemoryFactRow[];
      guidanceFacts?: MemoryFactRow[];
      selfFacts?: MemoryFactRow[];
      loreFacts?: MemoryFactRow[];
    };
    recentConversationHistory: unknown[];
  };
  /** Behavioral facts array. */
  behavioralFacts: MemoryFactRow[];
  /** Whether behavioral facts came from session cache. */
  usedCachedBehavioralFacts: boolean;
  /** When this snapshot was captured. */
  capturedAt: number;
  /** The transcript that produced this snapshot (for logging). */
  sourceTranscript: string;
}

export interface WarmMemoryState {
  /** Current topic fingerprint. Null until first turn completes. */
  topicFingerprint: TopicFingerprint | null;
  /** Cached memory snapshot from the last completed turn. */
  snapshot: WarmMemorySnapshot | null;
  /** The last ingest embedding vector (captured from memory ingest). */
  lastIngestEmbedding: { embedding: number[]; model: string } | null;
  /** Promise for the in-flight ingest embedding (resolves with the vector). */
  pendingIngestEmbedding: Promise<{ embedding: number[]; model: string } | null> | null;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Cosine similarity above this → same topic, use warm memory. */
const SAME_TOPIC_THRESHOLD = 0.85;

/** Cosine similarity below this → definite drift, full retrieval. */
const DRIFT_THRESHOLD = 0.65;

/** Weight for user turns when updating the topic fingerprint. */
const USER_TURN_WEIGHT = 0.3;

/** Weight for bot turns when updating the topic fingerprint. */
const BOT_TURN_WEIGHT = 0.1;

/** Maximum age (ms) for a warm snapshot before forced refresh. */
const WARM_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ── Core Functions ───────────────────────────────────────────────────────

/**
 * Initialize a fresh warm memory state for a new session.
 */
export function createWarmMemoryState(): WarmMemoryState {
  return {
    topicFingerprint: null,
    snapshot: null,
    lastIngestEmbedding: null,
    pendingIngestEmbedding: null
  };
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector is empty or they differ in length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Determine whether the current turn represents a topic drift from the
 * warm memory state.
 *
 * Returns:
 *   "cold"      — no fingerprint yet (first turn), must do full retrieval
 *   "same"      — same topic, use warm snapshot
 *   "ambiguous"  — could go either way (conservative: treat as same)
 *   "drift"     — topic changed, must do full retrieval
 *   "stale"     — warm snapshot too old, refresh regardless
 */
export type DriftVerdict = "cold" | "same" | "ambiguous" | "drift" | "stale";

export function detectTopicDrift(
  state: WarmMemoryState,
  turnEmbedding: { embedding: number[]; model: string }
): { verdict: DriftVerdict; similarity: number } {
  // No fingerprint yet → cold start
  if (!state.topicFingerprint || !state.topicFingerprint.embedding.length) {
    return { verdict: "cold", similarity: 0 };
  }

  // Model mismatch → can't compare, treat as drift
  if (state.topicFingerprint.model !== turnEmbedding.model) {
    return { verdict: "drift", similarity: 0 };
  }

  // Warm snapshot too old → stale
  if (
    state.snapshot &&
    Date.now() - state.snapshot.capturedAt > WARM_SNAPSHOT_MAX_AGE_MS
  ) {
    return { verdict: "stale", similarity: 0 };
  }

  // No snapshot to reuse → need full retrieval anyway
  if (!state.snapshot) {
    return { verdict: "cold", similarity: 0 };
  }

  const similarity = cosineSimilarity(
    turnEmbedding.embedding,
    state.topicFingerprint.embedding
  );

  if (similarity >= SAME_TOPIC_THRESHOLD) {
    return { verdict: "same", similarity };
  }
  if (similarity < DRIFT_THRESHOLD) {
    return { verdict: "drift", similarity };
  }

  // Ambiguous zone — conservative: treat as same topic
  return { verdict: "ambiguous", similarity };
}

/**
 * Update the topic fingerprint with a new turn's embedding.
 *
 * Uses exponential moving average with different weights for user vs bot turns.
 * User turns get higher weight (0.3) because they drive topic direction.
 * Bot turns get lower weight (0.1) to avoid self-reinforcing recall.
 */
export function updateTopicFingerprint(
  state: WarmMemoryState,
  turnEmbedding: { embedding: number[]; model: string },
  source: "user" | "bot" = "user"
): void {
  const weight = source === "user" ? USER_TURN_WEIGHT : BOT_TURN_WEIGHT;
  const complementWeight = 1 - weight;

  if (
    !state.topicFingerprint ||
    !state.topicFingerprint.embedding.length ||
    state.topicFingerprint.model !== turnEmbedding.model
  ) {
    // First turn or model changed — set the fingerprint directly
    state.topicFingerprint = {
      embedding: [...turnEmbedding.embedding],
      model: turnEmbedding.model,
      turnCount: 1,
      updatedAt: Date.now()
    };
    return;
  }

  // Exponential moving average
  const prev = state.topicFingerprint.embedding;
  const curr = turnEmbedding.embedding;
  const updated = new Array(prev.length);

  for (let i = 0; i < prev.length; i++) {
    updated[i] = complementWeight * prev[i] + weight * (curr[i] ?? 0);
  }

  state.topicFingerprint.embedding = updated;
  state.topicFingerprint.turnCount += 1;
  state.topicFingerprint.updatedAt = Date.now();
}

/**
 * Store a warm memory snapshot on the session state after a successful
 * memory load + generation turn.
 */
export function captureWarmSnapshot(
  state: WarmMemoryState,
  snapshot: WarmMemorySnapshot
): void {
  state.snapshot = snapshot;
}

/**
 * Invalidate the warm memory snapshot.
 * Called when memory is written (memory_write tool), participants change, etc.
 */
export function invalidateWarmSnapshot(state: WarmMemoryState): void {
  state.snapshot = null;
}

/**
 * Check whether warm memory should be used for this turn.
 * Returns the warm snapshot if drift detection says we can reuse it,
 * or null if a full retrieval is needed.
 */
export function resolveWarmMemory(
  state: WarmMemoryState,
  turnEmbedding: { embedding: number[]; model: string } | null
): {
  snapshot: WarmMemorySnapshot | null;
  drift: DriftVerdict;
  similarity: number;
  reason: string;
} {
  if (!turnEmbedding || !turnEmbedding.embedding.length) {
    return {
      snapshot: null,
      drift: "cold",
      similarity: 0,
      reason: "no_turn_embedding"
    };
  }

  const { verdict, similarity } = detectTopicDrift(state, turnEmbedding);

  if (verdict === "same" || verdict === "ambiguous") {
    return {
      snapshot: state.snapshot,
      drift: verdict,
      similarity,
      reason: verdict === "same"
        ? "same_topic"
        : "ambiguous_conservative_reuse"
    };
  }

  return {
    snapshot: null,
    drift: verdict,
    similarity,
    reason: verdict
  };
}

// ── Export constants for testing ──────────────────────────────────────────

export const WARM_MEMORY_CONSTANTS = {
  SAME_TOPIC_THRESHOLD,
  DRIFT_THRESHOLD,
  USER_TURN_WEIGHT,
  BOT_TURN_WEIGHT,
  WARM_SNAPSHOT_MAX_AGE_MS
} as const;
