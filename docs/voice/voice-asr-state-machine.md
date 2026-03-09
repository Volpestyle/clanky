# Voice ASR State Machine

> **Scope:** ASR session lifecycle — per-user and shared transcription client management, audio buffering, transcript resolution.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Audio capture lifecycle: [`voice-audio-capture-state-machine.md`](voice-audio-capture-state-machine.md)
> Turn processing and noise rejection: [`barge-in.md`](barge-in.md)

This document defines the ASR (Automatic Speech Recognition) bridge state machine. Each ASR bridge session (`AsrBridgeState`) manages a WebSocket connection to OpenAI's Realtime Transcription API, buffers audio during connection delays, and resolves transcripts for finalized captures.

## 1. Source of Truth

Each `VoiceSession` owns its ASR state through:

- `session.openAiAsrSessions: Map<string, AsrBridgeState>` — per-user ASR sessions (one WebSocket per active speaker)
- `session.openAiSharedAsrState: AsrBridgeState | null` — single shared ASR session (one WebSocket for all speakers)
- `session.perUserAsrEnabled: boolean` — snapshot at join time
- `session.sharedAsrEnabled: boolean` — snapshot at join time

The `AsrBridgeState` is the core per-session state object. It tracks the WebSocket lifecycle, audio buffering, utterance state, and transcript resolution.

Code:

- `src/voice/voiceAsrBridge.ts` — ASR session lifecycle, audio streaming, commit/transcript resolution
- `src/voice/openaiRealtimeTranscriptionClient.ts` — WebSocket client for OpenAI Realtime Transcription API
- `src/voice/voiceConfigResolver.ts` — ASR mode resolution from settings
- `src/voice/captureManager.ts` — integration between capture lifecycle and ASR

## 2. Phases

Each `AsrBridgeState` has a `phase` field tracking its WebSocket lifecycle:

| Phase | Meaning |
|---|---|
| `idle` | No WebSocket connection. Initial state and post-teardown state. |
| `connecting` | WebSocket is opening. Audio is buffered in `pendingAudioChunks`. |
| `ready` | WebSocket is open and accepting audio. Pending audio flushed on transition. |
| `committing` | A transcript commit is in progress (`commitInputAudioBuffer` sent, awaiting response). |
| `closing` | WebSocket is being torn down. |

Phase query helpers: `asrPhaseCanAcceptAudio` (connecting or ready), `asrPhaseIsConnected` (ready or committing), `asrPhaseCanCommit` (ready), `asrPhaseIsCommitting` (committing), `asrPhaseIsClosing` (closing).

## 3. Authoritative vs Heuristic Signals

| Signal | Role | Notes |
|---|---|---|
| `asrState.phase` | authoritative | Canonical WebSocket lifecycle phase. Guards all operations. |
| `asrState.userId` | authoritative (shared mode) | Active user lock. Only one user at a time can use the shared bridge. Null when unlocked. |
| `asrState.client` | authoritative | The `OpenAiRealtimeTranscriptionClient` instance. Null when idle. |
| `asrState.utterance` | authoritative | Current utterance state: `finalSegments`, `partialText`, `lastEventAt`. Updated by WebSocket transcript events. |
| `asrState.speechDetectedUtteranceId` | signal | Server VAD confirmation. Read by capture promotion logic. Must match `captureState.asrUtteranceId`. |
| `asrState.speechDetectedAt` | signal | Timestamp of server VAD speech detection. |
| `asrState.pendingAudioChunks` | buffer | Audio queued during `connecting` phase. Flushed on transition to `ready`. Capped at 10s (480,000 bytes). |
| `asrState.pendingAudioBytes` | buffer metric | Total bytes in pending buffer. Used for overflow trimming. |
| `asrState.committingUtteranceId` | guard | Ensures audio flush targets the correct utterance during commit. |
| `asrState.connectPromise` | deduplication | Prevents concurrent connect attempts. Multiple callers await the same promise. |
| `asrState.consecutiveEmptyCommits` | heuristic | Circuit breaker: after 3 consecutive empty commits with >1s audio, force-close and reconnect. |
| `asrState.idleTimer` | lifecycle timer | Closes the WebSocket after idle TTL expires. Cleared on new utterance begin. |

## 4. Transition Rules

| Event | From | To |
|---|---|---|
| `ensureAsrSessionConnected` called | `idle` | `connecting` |
| WebSocket opens, session.update sent | `connecting` | `ready` |
| `commitAsrUtterance` called | `ready` | `committing` |
| Transcript resolved (or timeout) | `committing` | `ready` |
| `closePerUserAsrSession` / `closeSharedAsrSession` called | any | `closing` |
| WebSocket closed, cleanup complete | `closing` | `idle` |
| Idle TTL timer fires | `ready` | `closing` → `idle` |
| Circuit breaker (3 consecutive empty commits) | `committing` | `closing` → `idle` → `connecting` → `ready` (reconnect) |

## 5. Per-User vs Shared Mode

### Per-User Mode (`perUserAsrEnabled`)

- One `AsrBridgeState` per active speaker in `openAiAsrSessions` map
- Audio streams immediately from capture start (provisional audio is included)
- Each user's ASR session is independent — no contention
- Idle sessions are closed after `OPENAI_ASR_SESSION_IDLE_TTL_MS`
- Sessions are eagerly pre-connected on session start for the initial speaker

### Shared Mode (`sharedAsrEnabled`)

- Single `AsrBridgeState` in `openAiSharedAsrState`
- User locking: `asrState.userId` acts as a mutex — only one user at a time
- Audio streaming begins only after capture promotion (not during provisional phase)
- Commit uses a different path: `commitInputAudioBuffer` → `waitForSharedAsrCommittedItem` (promise-based waiter) → `waitForSharedAsrTranscriptByItem` (polls `finalTranscriptsByItemId`)
- After commit, `releaseSharedAsrActiveUser` unlocks, then `tryHandoffSharedAsr` checks for other promoted captures waiting
- Handoff replays buffered PCM chunks from the waiting capture

### Mode Selection (`voiceConfigResolver.ts`)

Per-user requires ALL of: session active, provider supports `perUserAsr`, OpenAI API key, not text-only mode, `transcriptionMethod === "realtime_bridge"`, reply path is text-mediated (`bridge` or `brain`), `usePerUserAsrBridge === true`.

Shared requires ALL of: session active, provider supports `sharedAsr` (all providers), OpenAI API key, not text-only mode, `transcriptionMethod === "realtime_bridge"`, reply path is text-mediated (`bridge` or `brain`), per-user is NOT enabled.

## 6. Audio Buffering

Audio arrives via `appendAudioToAsr` on every `onUserAudio` chunk:

1. If phase is `connecting`: queue as `AsrPendingAudioChunk` with utterance ID, cap at 10s
2. If phase is `ready`: attempt flush via `flushPendingAsrAudio`, then send directly
3. If phase is `committing`: queue for next utterance (utterance ID mismatch guard prevents mixing)

`flushPendingAsrAudio` sends all pending chunks to the WebSocket client, matching utterance IDs. Chunks for stale utterances are skipped.

## 7. Transcript Resolution

### Per-User Commit Flow

1. `commitAsrUtterance` called with finalized capture's PCM
2. Phase: `ready` → `committing`
3. Flush remaining pending audio
4. Call `client.commitInputAudioBuffer()`
5. `waitForAsrTranscriptSettle`: poll `utterance.finalSegments` until stable or timeout
6. Build `AsrCommitResult` with transcript, timing, model info, logprobs
7. Phase: `committing` → `ready`
8. Schedule idle close timer

### Shared Commit Flow

1. Validate user lock matches
2. Register `pendingCommitRequest` with user ID
3. Call `client.commitInputAudioBuffer()`
4. `waitForSharedAsrCommittedItem`: await promise resolved by `input_audio_buffer.committed` event
5. `waitForSharedAsrTranscriptByItem`: poll `finalTranscriptsByItemId` for committed item's transcript
6. Build `AsrCommitResult`
7. Release user lock
8. `tryHandoffSharedAsr`: scan for other promoted captures waiting

### The `AsrCommitResult`

```typescript
{
  transcript: string;
  asrStartedAtMs: number;
  asrCompletedAtMs: number;
  transcriptionModelPrimary: string;
  transcriptionModelFallback: string | null;
  transcriptionPlanReason: string;
  usedFallbackModel: boolean;
  captureReason: string;
  transcriptLogprobs: Array<{token, logprob, bytes}> | null;
}
```

This flows through `queueRealtimeTurnFromAsrBridge` into the turn processor as `*Override` fields on `RealtimeQueuedTurn`, skipping the turn processor's own ASR.

## 8. Cross-Domain State Reads

| Subsystem | State Read | Where | Purpose |
|---|---|---|---|
| Capture Manager | `capture.promotedAt` | `tryHandoffSharedAsr` | Only hand off to promoted captures |
| Capture Manager | `capture.sharedAsrBytesSent` | `tryHandoffSharedAsr` | Skip captures that already sent shared ASR audio |
| Capture Manager | `capture.pcmChunks` | `tryHandoffSharedAsr` | Replay buffered audio during handoff |
| Capture Manager | `capture.bytesSent` | `tryHandoffSharedAsr` | Skip captures with no audio |
| Session Lifecycle | `session.ending` | All ASR operations | Abort on session teardown |
| Session Config | `session.realtimeInputSampleRateHz` | `commitAsrUtterance` | PCM duration estimation |
| Settings | `voiceRuntime.openaiRealtime.*` | `resolveAsrModelParams` | Model, language, prompt configuration |
| App Config | `appConfig.openaiApiKey` | `ensureAsrSessionConnected` | API key for WebSocket auth |

## 9. Client Events

The `OpenAiRealtimeTranscriptionClient` emits:

| Event | Handler | Effect on ASR State |
|---|---|---|
| `transcript` | `wireClientEvents` | Updates `utterance.finalSegments` / `partialText`, sets `lastTranscriptAt`. Shared mode: populates `finalTranscriptsByItemId`. |
| `speech_started` | `wireClientEvents` | Sets `speechDetectedAt`, `speechDetectedUtteranceId`, `speechActive = true`. Used by capture promotion. |
| `speech_stopped` | `wireClientEvents` | Sets `speechActive = false`. |
| `error_event` | `wireClientEvents` | Logs error. May trigger session close depending on severity. |
| `socket_closed` | `wireClientEvents` | Transitions phase to `idle`. Clears client reference. |

## 10. Incident Debugging

When ASR produces no transcript for audible speech:

1. Check `phase` — was the session in `ready` state? If `connecting`, audio may have overflowed the 10s buffer.
2. Check `committingUtteranceId` — did it match the current utterance? Stale utterance ID = audio sent to wrong commit.
3. Check `consecutiveEmptyCommits` — circuit breaker may have fired, triggering reconnect.
4. Check logprob confidence — transcript may have been produced but dropped by `VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD`.

When shared ASR hangs:

1. Check `asrState.userId` — is the user lock stuck? A capture that failed to release would block all subsequent users.
2. Check `pendingCommitResolvers` — are there unresolved promises waiting for `committed` events?
3. Check `tryHandoffSharedAsr` — did the handoff scan find the waiting capture?

## 11. Regression Tests

These cases should remain covered:

- Audio buffered during `connecting` phase is flushed on transition to `ready`
- Buffer overflow at 10s cap drops oldest chunks, not newest
- Per-user sessions close after idle TTL
- Shared mode user lock prevents concurrent access
- Shared mode handoff replays buffered PCM to the next user
- Circuit breaker reconnects after 3 consecutive empty commits
- `speechDetectedUtteranceId` only confirms promotion for the matching capture
- Session teardown closes all ASR sessions cleanly
- Logprob confidence gating drops low-confidence transcripts downstream

Current coverage:

- `src/voice/voiceConfigResolver.test.ts` (mode resolution)
- `src/voice/voiceSessionManager.lifecycle.test.ts` (integration scenarios)
