/**
 * Unified ASR bridge — handles both per-user and shared transcription modes
 * through a single code path with mode-specific branching where necessary.
 */
import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";
import {
  resolveVoiceAsrLanguageGuidance,
  normalizeVoiceText,
  normalizeInlineText,
  getRealtimeCommitMinimumBytes
} from "./voiceSessionHelpers.ts";
import {
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeTranscriptionModel
} from "./realtimeProviderNormalization.ts";
import {
  OPENAI_ASR_SESSION_IDLE_TTL_MS,
  OPENAI_ASR_TRANSCRIPT_STABLE_MS,
  OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS
} from "./voiceSessionManager.constants.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

// Re-export the STT_TRANSCRIPT_MAX_CHARS that callers use alongside ASR results.
export { STT_TRANSCRIPT_MAX_CHARS } from "./voiceSessionHelpers.ts";

// ── Types ────────────────────────────────────────────────────────────

export type AsrBridgeMode = "per_user" | "shared";

/**
 * Explicit lifecycle phase for an ASR bridge session.
 *
 * Transition rules:
 *   idle → connecting        ensureAsrSessionConnected starts a new connection
 *   connecting → ready       WebSocket opens and connectedAt is set
 *   ready → committing       commitAsrUtterance begins
 *   committing → ready       commit completes or fails
 *   ready|committing → closing   teardown begins
 *   closing → idle           WebSocket closes and state is cleaned up
 */
export type AsrBridgePhase = "idle" | "connecting" | "ready" | "committing" | "closing";

// ── Phase query helpers ──────────────────────────────────────────────
// These are the ONLY way consuming code should ask questions about ASR
// bridge lifecycle state. They replace the old `closing` / `isCommittingAsr`
// boolean checks.

/** The bridge can accept audio (connected and not tearing down). */
export function asrPhaseCanAcceptAudio(phase: AsrBridgePhase): boolean {
  return phase === "ready" || phase === "committing";
}

/** The bridge has an active WebSocket connection. */
export function asrPhaseIsConnected(phase: AsrBridgePhase): boolean {
  return phase === "ready" || phase === "committing" || phase === "closing";
}

/** The bridge can start a new commit. */
export function asrPhaseCanCommit(phase: AsrBridgePhase): boolean {
  return phase === "ready";
}

/** The bridge is tearing down (replaces `closing` boolean). */
export function asrPhaseIsClosing(phase: AsrBridgePhase): boolean {
  return phase === "closing";
}

/** The bridge is in the middle of a commit (replaces `isCommittingAsr` boolean). */
export function asrPhaseIsCommitting(phase: AsrBridgePhase): boolean {
  return phase === "committing";
}

export interface AsrUtteranceState {
  id: number;
  startedAt: number;
  bytesSent: number;
  partialText: string;
  finalSegments: string[];
  finalSegmentEntries: AsrFinalSegmentEntry[];
  lastUpdateAt: number;
}

export interface AsrFinalSegmentEntry {
  itemId: string;
  previousItemId: string | null;
  text: string;
  receivedAt: number;
  logprobs: Array<{ token: string; logprob: number; bytes: number[] | null }> | null;
}

export interface AsrPendingAudioChunk {
  utteranceId: number;
  chunk: Buffer;
}

export interface AsrPendingCommitRequest {
  id: string;
  userId: string;
  requestedAt: number;
}

export interface AsrPendingCommitResolver {
  id: string;
  userId: string | null;
  commitRequestId: string | null;
  resolve: (itemId: string) => void;
}

/** State fields common to both modes. */
export interface AsrBridgeState {
  phase: AsrBridgePhase;
  userId: string | null;
  client: OpenAiRealtimeTranscriptionClient | null;
  connectPromise: Promise<void> | null;
  committingUtteranceId: number;
  pendingAudioChunks: AsrPendingAudioChunk[];
  pendingAudioBytes: number;
  connectedAt: number;
  lastAudioAt: number;
  lastTranscriptAt: number;
  lastPartialLogAt: number;
  lastPartialText: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  utterance: AsrUtteranceState;
  // Shared-mode only fields (unused/empty in per_user mode)
  itemIdToUserId: Map<string, string>;
  finalTranscriptsByItemId: Map<string, string>;
  pendingCommitResolvers: AsrPendingCommitResolver[];
  pendingCommitRequests: AsrPendingCommitRequest[];
  consecutiveEmptyCommits: number;
}

export interface AsrCommitResult {
  transcript: string;
  asrStartedAtMs: number;
  asrCompletedAtMs: number;
  transcriptionModelPrimary: string;
  transcriptionModelFallback: string | null;
  transcriptionPlanReason: string;
  usedFallbackModel: boolean;
  captureReason: string;
  transcriptLogprobs: Array<{ token: string; logprob: number; bytes: number[] | null }> | null;
}

/** Dependencies injected by the session manager. */
export interface AsrBridgeDeps {
  session: VoiceSession;
  appConfig: { openaiApiKey: string; [key: string]: unknown };
  store: {
    logAction: (entry: {
      kind: string;
      guildId: string;
      channelId: string;
      userId?: string | null;
      content: string;
      metadata?: Record<string, unknown>;
    }) => void;
    getSettings: () => Record<string, unknown> | null;
  };
  botUserId: string | null;
  resolveVoiceSpeakerName: (session: VoiceSession, userId: string | null) => string;
}

// ── State creation ───────────────────────────────────────────────────

// Circuit breaker: after this many consecutive empty commits with
// substantial audio, force-reconnect the ASR session.
const ASR_EMPTY_COMMIT_RECONNECT_THRESHOLD = 3;
const ASR_EMPTY_COMMIT_MIN_BYTES = 48_000; // ~1s of 24kHz PCM16

export function createAsrBridgeState(): AsrBridgeState {
  return {
    phase: "idle",
    userId: null,
    client: null,
    connectPromise: null,
    committingUtteranceId: 0,
    pendingAudioChunks: [],
    pendingAudioBytes: 0,
    connectedAt: 0,
    lastAudioAt: 0,
    lastTranscriptAt: 0,
    lastPartialLogAt: 0,
    lastPartialText: "",
    idleTimer: null,
    utterance: createAsrUtteranceState(),
    itemIdToUserId: new Map(),
    finalTranscriptsByItemId: new Map(),
    pendingCommitResolvers: [],
    pendingCommitRequests: [],
    consecutiveEmptyCommits: 0
  };
}

function createAsrUtteranceState(prevId = 0): AsrUtteranceState {
  return {
    id: prevId + 1,
    startedAt: Date.now(),
    bytesSent: 0,
    partialText: "",
    finalSegments: [],
    finalSegmentEntries: [],
    lastUpdateAt: 0
  };
}

// ── Per-user state management (Map<userId, state>) ───────────────────

export function getOrCreatePerUserAsrState(
  session: VoiceSession,
  userId: string
): AsrBridgeState | null {
  if (!session || session.ending) return null;
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;
  if (!(session.openAiAsrSessions instanceof Map)) {
    session.openAiAsrSessions = new Map();
  }
  const existing = session.openAiAsrSessions.get(normalizedUserId);
  if (existing && typeof existing === "object") return existing as AsrBridgeState;
  const state = createAsrBridgeState();
  state.userId = normalizedUserId;
  session.openAiAsrSessions.set(normalizedUserId, state);
  return state;
}

// ── Shared state management (single state on session) ────────────────

export function getOrCreateSharedAsrState(session: VoiceSession): AsrBridgeState | null {
  if (!session || session.ending) return null;
  if (!session.openAiSharedAsrState) {
    session.openAiSharedAsrState = createAsrBridgeState();
  }
  return session.openAiSharedAsrState as AsrBridgeState;
}

// ── Resolve ASR state for mode ───────────────────────────────────────

function getAsrState(
  mode: AsrBridgeMode,
  session: VoiceSession,
  userId: string
): AsrBridgeState | null {
  if (mode === "per_user") return getOrCreatePerUserAsrState(session, userId);
  return getOrCreateSharedAsrState(session);
}

// ── Shared helpers ───────────────────────────────────────────────────

const STT_TRANSCRIPT_MAX_CHARS_LOCAL = 2000;
const MAX_MAP_SIZE = 320;

function createAsrRuntimeLogger(deps: AsrBridgeDeps, logUserId: string) {
  return ({ level, event, metadata }: { level: string; event: string; metadata?: Record<string, unknown> | null }) => {
    deps.store.logAction({
      kind: level === "warn" ? "voice_error" : "voice_runtime",
      guildId: deps.session.guildId,
      channelId: deps.session.textChannelId,
      userId: String(logUserId || "").trim() || deps.botUserId || null,
      content: event,
      metadata: {
        sessionId: deps.session.id,
        ...(metadata && typeof metadata === "object" ? metadata : {})
      }
    });
  };
}

function resolveAsrModelParams(session: VoiceSession, settings: Record<string, unknown> | null) {
  const resolvedSettings = settings || session.settingsSnapshot || {};
  const voiceAsrGuidance = resolveVoiceAsrLanguageGuidance(resolvedSettings);
  const rawModel = String(
    session.openAiPerUserAsrModel ||
    (resolvedSettings as Record<string, unknown>)?.voice?.["openaiRealtime"]?.["inputTranscriptionModel"] ||
    OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
  )
    .trim()
    .slice(0, 120);
  const normalizedModel = normalizeOpenAiRealtimeTranscriptionModel(
    rawModel,
    OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
  );
  const language = String(
    session.openAiPerUserAsrLanguage || voiceAsrGuidance.language || ""
  )
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .slice(0, 24);
  const prompt = String(session.openAiPerUserAsrPrompt || voiceAsrGuidance.prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return { normalizedModel, language, prompt };
}

function pruneMap(map: Map<string, unknown>, maxSize = MAX_MAP_SIZE) {
  if (map.size <= maxSize) return;
  const overflow = map.size - maxSize;
  let dropped = 0;
  for (const key of map.keys()) {
    map.delete(key);
    dropped += 1;
    if (dropped >= overflow) break;
  }
}

// ── Logprobs collection from segment entries ─────────────────────────

function collectSegmentLogprobs(
  entries: AsrFinalSegmentEntry[] | null | undefined
): Array<{ token: string; logprob: number; bytes: number[] | null }> | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const collected: Array<{ token: string; logprob: number; bytes: number[] | null }> = [];
  for (const entry of entries) {
    if (!Array.isArray(entry?.logprobs)) continue;
    for (const lp of entry.logprobs) {
      if (lp && typeof lp.logprob === "number") {
        collected.push(lp);
      }
    }
  }
  return collected.length > 0 ? collected : null;
}

// ── Segment ordering (topological sort by previousItemId) ────────────

export function orderAsrFinalSegments(entries: AsrFinalSegmentEntry[]): string[] {
  const normalizedEntries = Array.isArray(entries)
    ? entries
      .map((entry, index) => ({
        itemId: normalizeInlineText(entry?.itemId, 180),
        previousItemId: normalizeInlineText(entry?.previousItemId, 180) || null,
        text: normalizeVoiceText(entry?.text || "", STT_TRANSCRIPT_MAX_CHARS_LOCAL),
        receivedAt: Math.max(0, Number(entry?.receivedAt || 0)),
        index
      }))
      .filter((entry) => entry.itemId && entry.text)
    : [];
  if (normalizedEntries.length <= 1) {
    return normalizedEntries.map((entry) => entry.text);
  }

  const byId = new Map<string, (typeof normalizedEntries)[number]>();
  for (const entry of normalizedEntries) {
    byId.set(entry.itemId, entry);
  }
  const sorted = [...byId.values()].sort((a, b) => {
    const delta = Number(a.receivedAt || 0) - Number(b.receivedAt || 0);
    if (delta !== 0) return delta;
    return Number(a.index || 0) - Number(b.index || 0);
  });

  const placed = new Set<string>();
  const ordered: string[] = [];
  while (ordered.length < sorted.length) {
    let progressed = false;
    for (const entry of sorted) {
      if (placed.has(entry.itemId)) continue;
      const previousItemId = String(entry.previousItemId || "");
      if (!previousItemId || !byId.has(previousItemId) || placed.has(previousItemId)) {
        placed.add(entry.itemId);
        ordered.push(entry.text);
        progressed = true;
      }
    }
    if (progressed) continue;
    // Fall back to arrival order if chain is incomplete/cyclic.
    for (const entry of sorted) {
      if (placed.has(entry.itemId)) continue;
      placed.add(entry.itemId);
      ordered.push(entry.text);
    }
  }

  return ordered;
}

// ── Shared-mode: resolve speaker from itemId mapping ─────────────────

export function resolveSharedAsrSpeakerUserId(opts: {
  asrState: AsrBridgeState;
  itemId: string;
  fallbackUserId: string | null;
  botUserId: string | null;
}): string | null {
  const normalizedItemId = normalizeInlineText(opts.itemId, 180);
  if (normalizedItemId && opts.asrState.itemIdToUserId instanceof Map) {
    const mappedUserId = String(opts.asrState.itemIdToUserId.get(normalizedItemId) || "").trim();
    if (mappedUserId) return mappedUserId;
  }
  const normalizedFallbackUserId = String(opts.fallbackUserId || "").trim();
  if (normalizedFallbackUserId) return normalizedFallbackUserId;
  const activeSharedUserId = String(opts.asrState.userId || "").trim();
  if (activeSharedUserId) return activeSharedUserId;
  return opts.botUserId || null;
}

// ── Shared-mode: committed item tracking & waiters ───────────────────

function prunePendingCommitRequests(asrState: AsrBridgeState, maxAgeMs = 30_000) {
  const requests = asrState.pendingCommitRequests;
  if (!requests.length) return requests;
  const maxAge = Math.max(1_000, Number(maxAgeMs) || 30_000);
  const now = Date.now();
  while (requests.length > 0) {
    const head = requests[0];
    const requestedAt = Math.max(0, Number(head?.requestedAt || 0));
    if (requestedAt > 0 && now - requestedAt <= maxAge) break;
    requests.shift();
  }
  return requests;
}

export function trackSharedAsrCommittedItem(
  asrState: AsrBridgeState,
  itemId: string,
  fallbackUserId: string | null = null
) {
  if (!(asrState.itemIdToUserId instanceof Map)) return;
  const normalizedItemId = normalizeInlineText(itemId, 180);
  if (!normalizedItemId) return;
  const pendingRequests = prunePendingCommitRequests(asrState);
  const commitRequest = pendingRequests.length > 0 ? pendingRequests.shift()! : null;
  const commitRequestUserId = String(commitRequest?.userId || "").trim();
  const mappedUserId = String(fallbackUserId || commitRequestUserId || "").trim();
  if (mappedUserId) {
    asrState.itemIdToUserId.set(normalizedItemId, mappedUserId);
    pruneMap(asrState.itemIdToUserId);
  }
  const resolvers = asrState.pendingCommitResolvers;
  if (!resolvers.length) return;
  const resolverIndex = mappedUserId
    ? resolvers.findIndex((entry) => String(entry?.userId || "").trim() === mappedUserId)
    : resolvers.findIndex((entry) => !String(entry?.userId || "").trim());
  if (resolverIndex < 0) return;
  const [resolver] = resolvers.splice(resolverIndex, 1);
  if (resolver && typeof resolver.resolve === "function") {
    resolver.resolve(normalizedItemId);
  }
}

function waitForSharedAsrCommittedItem(
  session: VoiceSession,
  asrState: AsrBridgeState,
  userId: string,
  commitRequestId: string
): Promise<string> {
  if (!session || session.ending || !asrState) return Promise.resolve("");
  const waitMs = Math.max(
    600,
    Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS) * 4
  );
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedCommitRequestId = String(commitRequestId || "").trim();
  return new Promise<string>((resolve) => {
    const resolvers = asrState.pendingCommitResolvers;
    const waiterId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const timeout = setTimeout(() => {
      const index = resolvers.findIndex((entry) => entry?.id === waiterId);
      if (index >= 0) resolvers.splice(index, 1);
      resolve("");
    }, waitMs);
    const waiter: AsrPendingCommitResolver = {
      id: waiterId,
      userId: normalizedUserId,
      commitRequestId: normalizedCommitRequestId || null,
      resolve: (itemId: string) => {
        clearTimeout(timeout);
        resolve(normalizeInlineText(itemId, 180) || "");
      }
    };
    resolvers.push(waiter);
  });
}

async function waitForSharedAsrTranscriptByItem(
  session: VoiceSession,
  asrState: AsrBridgeState,
  itemId: string
): Promise<string> {
  if (!session || session.ending || !asrState) return "";
  const normalizedItemId = normalizeInlineText(itemId, 180);
  if (!normalizedItemId) {
    return waitForAsrTranscriptSettle(session, asrState);
  }
  const stableWindowMs = Math.max(
    100,
    Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS)
  );
  const maxWaitMs = Math.max(
    stableWindowMs + 120,
    Number(session.openAiAsrTranscriptWaitMaxMs || OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS)
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= maxWaitMs) {
    if (session.ending) return "";
    const transcript = normalizeVoiceText(
      asrState.finalTranscriptsByItemId.get(normalizedItemId) || "",
      STT_TRANSCRIPT_MAX_CHARS_LOCAL
    );
    if (transcript) return transcript;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return normalizeVoiceText(
    asrState.finalTranscriptsByItemId.get(normalizedItemId) || "",
    STT_TRANSCRIPT_MAX_CHARS_LOCAL
  );
}

// ── Transcript settle (per-user mode, fallback for shared) ───────────

export async function waitForAsrTranscriptSettle(
  session: VoiceSession,
  asrState: AsrBridgeState,
  utterance: AsrUtteranceState | null = null
): Promise<string> {
  if (!session || session.ending || !asrState) return "";
  const trackedUtterance = utterance || asrState.utterance;
  const stableWindowMs = Math.max(
    100,
    Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS)
  );
  const maxWaitMs = Math.max(
    stableWindowMs + 120,
    Number(session.openAiAsrTranscriptWaitMaxMs || OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS)
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= maxWaitMs) {
    if (session.ending) return "";
    const now = Date.now();
    const lastUpdateAt = Math.max(0, Number(trackedUtterance?.lastUpdateAt || 0));
    const stable = lastUpdateAt > 0 ? now - lastUpdateAt >= stableWindowMs : false;
    const finalText = normalizeVoiceText(
      Array.isArray(trackedUtterance?.finalSegments)
        ? trackedUtterance.finalSegments.join(" ")
        : "",
      STT_TRANSCRIPT_MAX_CHARS_LOCAL
    );
    const partialText = normalizeVoiceText(
      trackedUtterance?.partialText || "",
      STT_TRANSCRIPT_MAX_CHARS_LOCAL
    );
    if (finalText && stable) return finalText;
    // Don't early-return partials — they're inherently incomplete.
    // A 120ms gap between partial updates is normal ASR batching,
    // not an indication the transcript is finished. Let the timeout
    // fallback (below) handle partials when no final arrives in time.
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  const finalText = normalizeVoiceText(
    Array.isArray(trackedUtterance?.finalSegments)
      ? trackedUtterance.finalSegments.join(" ")
      : "",
    STT_TRANSCRIPT_MAX_CHARS_LOCAL
  );
  if (finalText) return finalText;
  return normalizeVoiceText(trackedUtterance?.partialText || "", STT_TRANSCRIPT_MAX_CHARS_LOCAL);
}

// ── Wire client events (identical for both modes) ────────────────────

function wireClientEvents(
  mode: AsrBridgeMode,
  client: OpenAiRealtimeTranscriptionClient,
  asrState: AsrBridgeState,
  deps: AsrBridgeDeps,
  userId: string | null
) {
  const { session, store, botUserId, resolveVoiceSpeakerName: resolveSpeaker } = deps;

  // Shared mode: track committed items via the raw event stream
  if (mode === "shared") {
    client.on("event", (event: Record<string, unknown>) => {
      if (session.ending || !event || typeof event !== "object") return;
      if (event.type === "input_audio_buffer.committed") {
        trackSharedAsrCommittedItem(
          asrState,
          String((event as Record<string, string>).item_id || (event as Record<string, Record<string, string>>).item?.id || "")
        );
      }
    });
  }

  client.on("transcript", (payload: Record<string, unknown>) => {
    if (session.ending) return;
    const transcript = normalizeVoiceText(String(payload?.text || ""), STT_TRANSCRIPT_MAX_CHARS_LOCAL);
    if (!transcript) return;

    const eventType = String(payload?.eventType || "").trim();
    const isFinal = Boolean(payload?.final);
    const itemId = normalizeInlineText(payload?.itemId, 180);
    const previousItemId = normalizeInlineText(payload?.previousItemId, 180) || null;
    const now = Date.now();

    asrState.lastTranscriptAt = now;
    asrState.utterance.lastUpdateAt = now;

    if (isFinal) {
      if (itemId) {
        const entries = Array.isArray(asrState.utterance.finalSegmentEntries)
          ? asrState.utterance.finalSegmentEntries
          : [];
        const nextEntry: AsrFinalSegmentEntry = {
          itemId,
          previousItemId,
          text: transcript,
          receivedAt: now,
          logprobs: Array.isArray(payload?.logprobs) ? payload.logprobs : null
        };
        const existingIndex = entries.findIndex((entry) => String(entry?.itemId || "") === itemId);
        if (existingIndex >= 0) {
          entries[existingIndex] = nextEntry;
        } else {
          entries.push(nextEntry);
        }
        asrState.utterance.finalSegmentEntries = entries;
        asrState.utterance.finalSegments = orderAsrFinalSegments(entries);

        // Shared mode: also index final transcripts by itemId
        if (mode === "shared") {
          asrState.finalTranscriptsByItemId.set(itemId, transcript);
          pruneMap(asrState.finalTranscriptsByItemId);
        }
      } else {
        asrState.utterance.finalSegments.push(transcript);
      }
      asrState.utterance.partialText = "";
    } else {
      asrState.utterance.partialText = transcript;
    }

    // Resolve speaker: shared mode looks up by itemId mapping, per-user uses the userId directly
    let transcriptSpeakerUserId: string | null = userId ? String(userId).trim() : null;
    if (mode === "shared") {
      transcriptSpeakerUserId = resolveSharedAsrSpeakerUserId({
        asrState,
        itemId,
        fallbackUserId: asrState.userId,
        botUserId
      });
    }

    const speakerName = resolveSpeaker(session, transcriptSpeakerUserId) || "someone";
    const shouldLogPartial =
      !isFinal &&
      transcript !== asrState.lastPartialText &&
      now - Number(asrState.lastPartialLogAt || 0) >= 180;

    if (isFinal || shouldLogPartial) {
      if (!isFinal) {
        asrState.lastPartialLogAt = now;
        asrState.lastPartialText = transcript;
      }
      store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: transcriptSpeakerUserId ? String(transcriptSpeakerUserId).trim() : null,
        content: isFinal ? "openai_realtime_asr_final_segment" : "openai_realtime_asr_partial_segment",
        metadata: {
          sessionId: session.id,
          speakerName,
          transcript,
          eventType: eventType || null,
          itemId: itemId || null,
          previousItemId
        }
      });
    }
  });

  client.on("error_event", (payload: Record<string, unknown>) => {
    if (session.ending) return;
    const errorUserId = mode === "shared" ? asrState.userId : (userId ? String(userId).trim() : null);
    const code = String(payload?.code || "").trim() || null;
    const normalizedCode = String(code || "").trim().toLowerCase();
    const message = String(payload?.message || "unknown error");
    const isEmptyCommit = normalizedCode === "input_audio_buffer_commit_empty";
    store.logAction({
      kind: isEmptyCommit ? "voice_runtime" : "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: errorUserId || null,
      content: isEmptyCommit ? "openai_realtime_asr_commit_empty" : `openai_realtime_asr_error: ${message}`,
      metadata: {
        sessionId: session.id,
        code,
        param: (payload?.param as string) || null,
        message
      }
    });
  });

  client.on("socket_closed", (payload: Record<string, unknown>) => {
    if (session.ending) return;
    const closedUserId = mode === "shared" ? asrState.userId : (userId ? String(userId).trim() : null);
    store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: closedUserId || null,
      content: "openai_realtime_asr_socket_closed",
      metadata: {
        sessionId: session.id,
        code: Number(payload?.code || 0) || null,
        reason: String(payload?.reason || "").trim() || null
      }
    });
  });
}

// ── Connect ──────────────────────────────────────────────────────────

export async function ensureAsrSessionConnected(
  mode: AsrBridgeMode,
  deps: AsrBridgeDeps,
  settings: Record<string, unknown> | null,
  userId: string
): Promise<AsrBridgeState | null> {
  const { session, appConfig, store } = deps;
  if (!session || session.ending) return null;
  const asrState = getAsrState(mode, session, userId);
  if (!asrState || asrPhaseIsClosing(asrState.phase)) return null;

  const ws = asrState.client?.ws;
  if (ws && ws.readyState === 1) {
    // Ensure phase reflects the live connection
    if (asrState.phase === "idle" || asrState.phase === "connecting") {
      asrState.phase = "ready";
    }
    return asrState;
  }

  if (asrState.connectPromise) {
    await asrState.connectPromise.catch(() => undefined);
    return asrState.client ? asrState : null;
  }

  const resolvedSettings = settings || session.settingsSnapshot || store.getSettings();
  const { normalizedModel, language, prompt } = resolveAsrModelParams(session, resolvedSettings);
  const logUserId = mode === "shared" ? "shared_asr" : String(userId || "").trim();
  const runtimeLogger = createAsrRuntimeLogger(deps, logUserId);
  const client = new OpenAiRealtimeTranscriptionClient({
    apiKey: appConfig.openaiApiKey,
    logger: runtimeLogger
  });
  asrState.client = client;
  asrState.phase = "connecting";

  asrState.connectPromise = (async () => {
    wireClientEvents(mode, client, asrState, deps, userId);

    await client.connect({
      model: normalizedModel,
      inputAudioFormat: "pcm16",
      inputTranscriptionModel: normalizedModel,
      inputTranscriptionLanguage: language,
      inputTranscriptionPrompt: prompt
    });
    asrState.connectedAt = Date.now();
    asrState.phase = "ready";

    // Flush any audio that was buffered while connecting
    flushPendingAsrAudio(mode, session, deps, asrState, userId);
  })();

  try {
    await asrState.connectPromise;
    return asrState;
  } catch (error: unknown) {
    const errorUserId = mode === "shared" ? asrState.userId : String(userId || "").trim();
    store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: errorUserId || null,
      content: `openai_realtime_asr_connect_failed: ${String((error as Error)?.message || error)}`,
      metadata: { sessionId: session.id }
    });
    if (mode === "per_user") {
      await closePerUserAsrSession(session, deps, userId, "connect_failed");
    } else {
      await closeSharedAsrSession(session, deps, "connect_failed");
    }
    return null;
  } finally {
    asrState.connectPromise = null;
  }
}

// ── Flush pending audio ──────────────────────────────────────────────

export function flushPendingAsrAudio(
  mode: AsrBridgeMode,
  session: VoiceSession,
  deps: AsrBridgeDeps,
  asrState: AsrBridgeState | null = null,
  userId: string | null = null,
  utteranceId: number | null = null
) {
  const state = asrState || getAsrState(mode, session, userId || "");
  if (!state || asrPhaseIsClosing(state.phase)) return;
  const client = state.client;
  if (!client || !client.ws || client.ws.readyState !== 1) return;
  const targetUtteranceId = Math.max(
    0,
    Number(
      utteranceId !== null && utteranceId !== undefined
        ? utteranceId
        : state.utterance?.id || 0
    )
  );
  if (!targetUtteranceId) return;
  const committingUtteranceId = Math.max(0, Number(state.committingUtteranceId || 0));
  if (
    asrPhaseIsCommitting(state.phase) &&
    committingUtteranceId > 0 &&
    targetUtteranceId !== committingUtteranceId
  ) {
    return;
  }
  const chunks = state.pendingAudioChunks;
  if (!chunks.length) return;

  const remainingChunks: AsrPendingAudioChunk[] = [];
  let flushedBytes = 0;
  let flushedChunks = 0;
  let skippedUtteranceMismatch = 0;
  while (chunks.length > 0) {
    const entry = chunks.shift()!;
    if (!entry || !Buffer.isBuffer(entry.chunk)) continue;
    if (Number(entry.utteranceId || 0) !== targetUtteranceId) {
      remainingChunks.push(entry);
      skippedUtteranceMismatch += 1;
      continue;
    }
    try {
      client.appendInputAudioPcm(entry.chunk);
      flushedBytes += entry.chunk.length;
      flushedChunks += 1;
    } catch (error: unknown) {
      const errorUserId = mode === "shared" ? state.userId : (userId ? String(userId).trim() : null);
      deps.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: errorUserId || null,
        content: `openai_realtime_asr_audio_append_failed: ${String((error as Error)?.message || error)}`,
        metadata: { sessionId: session.id }
      });
      remainingChunks.push(entry);
      while (chunks.length > 0) {
        const pendingEntry = chunks.shift()!;
        if (!pendingEntry || !Buffer.isBuffer(pendingEntry.chunk)) continue;
        remainingChunks.push(pendingEntry);
      }
      break;
    }
  }
  state.pendingAudioChunks = remainingChunks;
  state.pendingAudioBytes = state.pendingAudioChunks.reduce(
    (total, pendingChunk) => total + Number(pendingChunk?.chunk?.length || 0),
    0
  );

  // Track cumulative flush stats on the state for periodic reporting.
  state._flushAccumBytes = Math.max(0, Number(state._flushAccumBytes || 0)) + flushedBytes;
  state._flushAccumChunks = Math.max(0, Number(state._flushAccumChunks || 0)) + flushedChunks;
  state._flushAccumSkipped = Math.max(0, Number(state._flushAccumSkipped || 0)) + skippedUtteranceMismatch;
  const lastFlushLogAt = Number(state._lastFlushLogAt || 0);
  const flushLogIntervalMs = 2000;
  const now = Date.now();
  if (
    (now - lastFlushLogAt >= flushLogIntervalMs && state._flushAccumBytes > 0) ||
    skippedUtteranceMismatch > 0
  ) {
    const logUserId = mode === "shared" ? state.userId : (userId ? String(userId).trim() : null);
    deps.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: logUserId || null,
      content: "openai_realtime_asr_audio_flushed",
      metadata: {
        sessionId: session.id,
        flushedBytes: state._flushAccumBytes,
        flushedChunks: state._flushAccumChunks,
        skippedUtteranceMismatch: state._flushAccumSkipped,
        remainingPendingBytes: state.pendingAudioBytes,
        targetUtteranceId,
        wsReadyState: client.ws?.readyState ?? null
      }
    });
    state._flushAccumBytes = 0;
    state._flushAccumChunks = 0;
    state._flushAccumSkipped = 0;
    state._lastFlushLogAt = now;
  }
}

// ── Begin utterance ──────────────────────────────────────────────────

export function beginAsrUtterance(
  mode: AsrBridgeMode,
  session: VoiceSession,
  deps: AsrBridgeDeps,
  settings: Record<string, unknown> | null,
  userId: string
): boolean {
  if (!session || session.ending) return false;
  const asrState = getAsrState(mode, session, userId);
  const normalizedUserId = String(userId || "").trim();
  if (!asrState || !normalizedUserId) return false;
  if (asrPhaseIsClosing(asrState.phase)) return false;

  // Shared mode: user lock — only one user can use the shared bridge at a time
  if (mode === "shared") {
    if (asrState.userId && asrState.userId !== normalizedUserId) return false;
    asrState.userId = normalizedUserId;
  }

  if (asrState.idleTimer) {
    clearTimeout(asrState.idleTimer);
    asrState.idleTimer = null;
  }

  asrState.utterance = createAsrUtteranceState(asrState.utterance?.id || 0);
  asrState.lastPartialText = "";
  asrState.lastPartialLogAt = 0;

  void ensureAsrSessionConnected(mode, deps, settings, userId);
  return true;
}

// ── Append audio ─────────────────────────────────────────────────────

export function appendAudioToAsr(
  mode: AsrBridgeMode,
  session: VoiceSession,
  deps: AsrBridgeDeps,
  settings: Record<string, unknown> | null,
  userId: string,
  pcmChunk: Buffer
): boolean {
  if (!session || session.ending) return false;
  const asrState = getAsrState(mode, session, userId);
  const normalizedUserId = String(userId || "").trim();
  if (!asrState || asrPhaseIsClosing(asrState.phase) || !normalizedUserId) return false;

  // Shared mode: user lock
  if (mode === "shared") {
    if (!asrState.userId) {
      asrState.userId = normalizedUserId;
    } else if (asrState.userId !== normalizedUserId) {
      return false;
    }
  }

  const chunk = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk || []);
  if (!chunk.length) return false;
  asrState.lastAudioAt = Date.now();
  asrState.utterance.bytesSent = Math.max(0, Number(asrState.utterance?.bytesSent || 0)) + chunk.length;
  const utteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
  if (!utteranceId) return false;
  const queuedChunk: AsrPendingAudioChunk = { utteranceId, chunk };

  asrState.pendingAudioChunks.push(queuedChunk);
  asrState.pendingAudioBytes = Math.max(0, Number(asrState.pendingAudioBytes || 0)) + chunk.length;
  const maxBufferedBytes = 24_000 * 2 * 10;
  if (asrState.pendingAudioBytes > maxBufferedBytes && asrState.pendingAudioChunks.length > 1) {
    while (asrState.pendingAudioChunks.length > 1 && asrState.pendingAudioBytes > maxBufferedBytes) {
      const dropped = asrState.pendingAudioChunks.shift();
      asrState.pendingAudioBytes = Math.max(
        0,
        asrState.pendingAudioBytes - Number(dropped?.chunk?.length || 0)
      );
    }
  }

  void ensureAsrSessionConnected(mode, deps, settings, userId).then((state) => {
    if (!state) return;
    flushPendingAsrAudio(mode, session, deps, state, userId, utteranceId);
  });
  return true;
}

// ── Commit utterance ─────────────────────────────────────────────────

export async function commitAsrUtterance(
  mode: AsrBridgeMode,
  deps: AsrBridgeDeps,
  settings: Record<string, unknown> | null,
  userId: string,
  captureReason = "stream_end"
): Promise<AsrCommitResult | null> {
  const { session, store } = deps;
  if (!session || session.ending) return null;
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  // For shared mode, connect first then validate the user lock
  let asrState: AsrBridgeState | null;
  if (mode === "shared") {
    asrState = await ensureAsrSessionConnected(mode, deps, settings, normalizedUserId);
    if (!asrState || asrPhaseIsClosing(asrState.phase)) return null;
    if (asrState.userId && asrState.userId !== normalizedUserId) return null;
    asrState.userId = normalizedUserId;
  } else {
    asrState = getAsrState(mode, session, normalizedUserId);
    if (!asrState || asrPhaseIsClosing(asrState.phase)) return null;
  }

  const trackedUtterance = asrState.utterance;
  const trackedUtteranceId = Math.max(0, Number(trackedUtterance?.id || 0));
  if (!trackedUtteranceId) return null;

  const transcriptionModelPrimary = normalizeOpenAiRealtimeTranscriptionModel(
    session.openAiPerUserAsrModel,
    OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
  );
  const planReason = mode === "per_user"
    ? "openai_realtime_per_user_transcription"
    : "openai_realtime_shared_transcription";
  const utteranceBytesSent = Math.max(0, Number(trackedUtterance?.bytesSent || 0));
  const minCommitBytes = getRealtimeCommitMinimumBytes(
    session.mode,
    Number(session.realtimeInputSampleRateHz) || 24000
  );

  if (utteranceBytesSent < minCommitBytes) {
    if (utteranceBytesSent > 0) {
      store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "openai_realtime_asr_commit_skipped_small_buffer",
        metadata: {
          sessionId: session.id,
          utteranceBytesSent,
          minCommitBytes,
          captureReason: String(captureReason || "stream_end")
        }
      });
    }
    // Mode-specific cleanup for small buffer skip
    if (mode === "per_user") {
      scheduleAsrIdleClose(mode, session, deps, normalizedUserId);
    } else {
      if (asrState.userId === normalizedUserId) asrState.userId = null;
    }
    return {
      transcript: "",
      asrStartedAtMs: 0,
      asrCompletedAtMs: 0,
      transcriptionModelPrimary,
      transcriptionModelFallback: null,
      transcriptionPlanReason: planReason,
      usedFallbackModel: false,
      captureReason: String(captureReason || "stream_end"),
      transcriptLogprobs: null
    };
  }

  // Per-user: connect now (shared already connected above)
  if (mode === "per_user") {
    asrState.phase = "committing";
    asrState.committingUtteranceId = trackedUtteranceId;
    const connectedState = await ensureAsrSessionConnected(mode, deps, settings, normalizedUserId);
    if (!connectedState || connectedState !== asrState || asrPhaseIsClosing(asrState.phase)) {
      asrState.phase = "ready";
      asrState.committingUtteranceId = 0;
      return null;
    }
  } else {
    asrState.phase = "committing";
    asrState.committingUtteranceId = trackedUtteranceId;
  }

  flushPendingAsrAudio(mode, session, deps, asrState, normalizedUserId, trackedUtteranceId);

  const asrStartedAtMs = Date.now();
  try {
    if (mode === "shared") {
      // Shared mode: register commit request, commit, wait for item mapping + transcript
      const commitRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      prunePendingCommitRequests(asrState);
      asrState.pendingCommitRequests.push({
        id: commitRequestId,
        userId: normalizedUserId,
        requestedAt: Date.now()
      });
      asrState.client?.commitInputAudioBuffer?.();
      const committedItemId = await waitForSharedAsrCommittedItem(
        session, asrState, normalizedUserId, commitRequestId
      );
      const transcript = await waitForSharedAsrTranscriptByItem(
        session, asrState, committedItemId
      );
      const asrCompletedAtMs = Date.now();

      if (asrState.utterance === trackedUtterance) trackedUtterance.bytesSent = 0;
      if (asrState.userId === normalizedUserId) asrState.userId = null;

      // Shared-mode streaming fallback when committed buffer was empty
      let resolvedTranscript = transcript;
      if (!resolvedTranscript && trackedUtterance) {
        const streamingFinal = normalizeVoiceText(
          Array.isArray(trackedUtterance.finalSegments) ? trackedUtterance.finalSegments.join(" ") : "",
          STT_TRANSCRIPT_MAX_CHARS_LOCAL
        );
        const streamingPartial = normalizeVoiceText(
          trackedUtterance.partialText || "",
          STT_TRANSCRIPT_MAX_CHARS_LOCAL
        );
        resolvedTranscript = streamingFinal || streamingPartial;
        if (resolvedTranscript) {
          store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: "openai_realtime_asr_streaming_fallback_used",
            metadata: {
              sessionId: session.id,
              transcriptChars: resolvedTranscript.length,
              source: streamingFinal ? "final_segments" : "partial_text",
              captureReason: String(captureReason || "stream_end")
            }
          });
        }
      }

      if (!resolvedTranscript) {
        store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript: resolvedTranscript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: planReason,
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end"),
        transcriptLogprobs: collectSegmentLogprobs(trackedUtterance?.finalSegmentEntries)
      };
    } else {
      // Per-user mode: commit and wait for transcript settle
      asrState.client?.commitInputAudioBuffer?.();
      const transcript = await waitForAsrTranscriptSettle(session, asrState, trackedUtterance);
      const asrCompletedAtMs = Date.now();

      scheduleAsrIdleClose(mode, session, deps, normalizedUserId);
      if (trackedUtterance) trackedUtterance.bytesSent = 0;

      // Circuit breaker: track consecutive empty commits with substantial audio.
      // A silently dead WebSocket will produce zero transcripts indefinitely.
      if (!transcript && utteranceBytesSent >= ASR_EMPTY_COMMIT_MIN_BYTES) {
        asrState.consecutiveEmptyCommits = Math.max(0, Number(asrState.consecutiveEmptyCommits || 0)) + 1;
        if (asrState.consecutiveEmptyCommits >= ASR_EMPTY_COMMIT_RECONNECT_THRESHOLD) {
          asrState.consecutiveEmptyCommits = 0;
          store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            content: "openai_realtime_asr_circuit_breaker_reconnect",
            metadata: {
              sessionId: session.id,
              threshold: ASR_EMPTY_COMMIT_RECONNECT_THRESHOLD,
              captureReason: String(captureReason || "stream_end")
            }
          });
          // Force-close the dead session; next capture will reconnect.
          void closePerUserAsrSession(session, deps, normalizedUserId, "circuit_breaker").catch(() => undefined);
        }
      } else if (transcript) {
        asrState.consecutiveEmptyCommits = 0;
      }

      if (!transcript) {
        store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: planReason,
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end"),
        transcriptLogprobs: collectSegmentLogprobs(trackedUtterance?.finalSegmentEntries)
      };
    }
  } catch (error: unknown) {
    store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      content: `openai_realtime_asr_commit_failed: ${String((error as Error)?.message || error)}`,
      metadata: { sessionId: session.id }
    });
    return null;
  } finally {
    // Transition back to ready unless we're already closing/idle
    if (asrState.phase === "committing") {
      asrState.phase = "ready";
    }
    asrState.committingUtteranceId = 0;
    const activeUtteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
    if (activeUtteranceId > 0) {
      flushPendingAsrAudio(mode, session, deps, asrState, normalizedUserId, activeUtteranceId);
    }
  }
}

// ── Idle close scheduling ────────────────────────────────────────────

export function scheduleAsrIdleClose(
  mode: AsrBridgeMode,
  session: VoiceSession,
  deps: AsrBridgeDeps,
  userId: string
) {
  if (!session || session.ending) return;
  const asrState = getAsrState(mode, session, userId);
  if (!asrState) return;
  if (asrState.idleTimer) {
    clearTimeout(asrState.idleTimer);
    asrState.idleTimer = null;
  }
  const ttlMs = Math.max(
    1_000,
    Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
  );
  asrState.idleTimer = setTimeout(() => {
    asrState.idleTimer = null;
    if (mode === "per_user") {
      closePerUserAsrSession(session, deps, userId, "idle_ttl").catch(() => undefined);
    } else {
      closeSharedAsrSession(session, deps, "idle_ttl").catch(() => undefined);
    }
  }, ttlMs);
}

// ── Close sessions ───────────────────────────────────────────────────

export async function closePerUserAsrSession(
  session: VoiceSession,
  deps: AsrBridgeDeps,
  userId: string,
  reason = "manual"
) {
  if (!session) return;
  if (!(session.openAiAsrSessions instanceof Map)) return;
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;
  const state = session.openAiAsrSessions.get(normalizedUserId) as AsrBridgeState | undefined;
  if (!state) return;
  state.phase = "closing";

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  session.openAiAsrSessions.delete(normalizedUserId);

  try {
    await state.client?.close?.();
  } catch {
    // ignore
  }
  state.phase = "idle";

  deps.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: normalizedUserId,
    content: "openai_realtime_asr_session_closed",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "manual")
    }
  });
}

export async function closeAllPerUserAsrSessions(
  session: VoiceSession,
  deps: AsrBridgeDeps,
  reason = "session_end"
) {
  if (!session) return;
  if (!(session.openAiAsrSessions instanceof Map)) return;
  if (session.openAiAsrSessions.size <= 0) return;
  const userIds = [...session.openAiAsrSessions.keys()];
  for (const userId of userIds) {
    await closePerUserAsrSession(session, deps, String(userId), reason);
  }
}

export async function closeSharedAsrSession(
  session: VoiceSession,
  deps: AsrBridgeDeps,
  reason = "manual"
) {
  if (!session) return;
  const state = session.openAiSharedAsrState as AsrBridgeState | null;
  if (!state) return;
  state.phase = "closing";

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  // Drain pending commit resolvers
  while (state.pendingCommitResolvers.length > 0) {
    const entry = state.pendingCommitResolvers.shift();
    if (entry && typeof entry.resolve === "function") {
      entry.resolve("");
    }
  }
  session.openAiSharedAsrState = null;

  try {
    await state.client?.close?.();
  } catch {
    // ignore
  }
  state.phase = "idle";

  deps.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: String(state.userId || "").trim() || null,
    content: "openai_realtime_asr_session_closed",
    metadata: {
      sessionId: session.id,
      reason: String(reason || "manual")
    }
  });
}

// ── Shared-mode: release active user + handoff ───────────────────────

export function releaseSharedAsrActiveUser(session: VoiceSession, userId: string | null = null) {
  if (!session || session.ending) return;
  const asrState = session.openAiSharedAsrState as AsrBridgeState | null;
  if (!asrState) return;
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId || String(asrState.userId || "").trim() === normalizedUserId) {
    asrState.userId = null;
  }
}

/**
 * After a shared-mode user releases the lock, try to hand the bridge
 * off to another user who has audio buffered but hasn't started shared
 * ASR streaming yet.
 *
 * The `beginUtterance` and `appendAudio` callbacks let the session
 * manager delegate to the unified bridge functions (which need deps and
 * settings that only the session manager has).
 */
export function tryHandoffSharedAsr(opts: {
  session: VoiceSession;
  asrState: AsrBridgeState | null;
  deps: AsrBridgeDeps;
  settings: Record<string, unknown> | null;
  beginUtterance: (userId: string) => boolean;
  appendAudio: (userId: string, pcmChunk: Buffer) => boolean;
  releaseUser: (userId: string) => void;
}): boolean {
  const { session, asrState, deps, beginUtterance, appendAudio, releaseUser } = opts;
  if (!session || session.ending) return false;
  if (!asrState || asrPhaseIsClosing(asrState.phase)) return false;
  if (asrState.userId) return false;

  for (const [candidateUserId, captureState] of session.userCaptures) {
    if (!captureState || !candidateUserId) continue;
    if (Math.max(0, Number(captureState.promotedAt || 0)) <= 0) continue;
    if (Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) > 0) continue;
    if (Math.max(0, Number(captureState.bytesSent || 0)) <= 0) continue;

    const began = beginUtterance(candidateUserId);
    if (!began) continue;

    const chunks = Array.isArray(captureState.pcmChunks) ? captureState.pcmChunks : [];
    if (chunks.length <= 0) {
      releaseUser(candidateUserId);
      continue;
    }
    let replayedChunks = 0;
    let replayedBytes = 0;
    for (const chunk of chunks) {
      if (!chunk || !chunk.length) continue;
      const appended = appendAudio(candidateUserId, chunk);
      if (appended) {
        replayedChunks += 1;
        replayedBytes += chunk.length;
        captureState.sharedAsrBytesSent =
          Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) + chunk.length;
      }
    }
    if (replayedChunks <= 0 || replayedBytes <= 0) {
      releaseUser(candidateUserId);
      continue;
    }

    deps.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: candidateUserId,
      content: "openai_shared_asr_handoff",
      metadata: {
        sessionId: session.id,
        replayedChunks,
        replayedBytes
      }
    });
    return true;
  }
  return false;
}
