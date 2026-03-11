# Voice Capture and ASR Pipeline

> **Scope:** Per-user audio capture lifecycle and ASR transcription — from Discord speaking event through promotion, ASR bridge transcription, and handoff to the turn processor.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Output and barge-in: [`voice-output-and-barge-in.md`](voice-output-and-barge-in.md)
> Reply orchestration: [`voice-client-and-reply-orchestration.md`](voice-client-and-reply-orchestration.md)

---

# Part 1: Audio Capture

This part defines the per-user audio capture state machine. Each user who speaks in a voice session gets an independent `CaptureState` that tracks their audio from the first Discord speaking event through promotion, finalization, and handoff to the turn processor.

## 1. Source of Truth

The `VoiceSession` owns the authoritative capture state in `session.userCaptures: Map<string, CaptureState>`.

- A user has an active capture if and only if they have an entry in this map.
- There is no separate `speakingUsers` set — `userCaptures` is the single source of truth for who is currently being captured.
- `session.userCaptures.size` is the active capture count.

External systems provide signals but do not own capture state:

- `clankvox` subprocess provides `speakingStart`, `speakingEnd`, `userAudio`, `userAudioEnd` IPC events.
- OpenAI ASR provides `server_vad` speech detection confirmations.
- The capture manager derives one canonical lifecycle from those signals.

Code:

- `src/voice/captureManager.ts` — capture lifecycle, audio ingestion, promotion, finalization
- `src/voice/sessionLifecycle.ts` — speaking event handlers, timer management
- `src/voice/voiceSessionTypes.ts` — `CaptureState` and `VoiceSession` type definitions
- `src/voice/voiceAudioAnalysis.ts` — PCM signal analysis functions

## 2. Phases

Each `CaptureState` progresses through a linear lifecycle:

| Phase | Meaning | Key Indicator |
|---|---|---|
| `provisional` | Audio is being buffered but speech has not been confirmed | `promotedAt === 0` |
| `promoted` | Speech confirmed by server VAD or strong local signal; turn is "real" | `promotedAt > 0` |
| `finalizing` | Speaking ended; awaiting finalization timer or stream end | `speakingEndFinalizeTimer !== null` |
| `finalized` | Capture complete; PCM handed to turn processor | Entry removed from `userCaptures` |

A capture that never promotes is silently discarded — no ASR call, no LLM cost.

## 3. Authoritative vs Heuristic Signals

| Signal | Role | Notes |
|---|---|---|
| `captureState.promotedAt` | authoritative | `0` = provisional, `> 0` = promoted. The single source of truth for promotion status. |
| `captureState.bytesSent` | authoritative | Total PCM bytes accumulated. Used for minimum clip duration checks. |
| `captureState.signalPeakAbs` | authoritative | Peak absolute sample value (monotonic max). Promotion and barge-in input. |
| `captureState.signalActiveSampleCount` / `signalSampleCount` | authoritative | Active sample ratio = `activeSampleCount / sampleCount`. Core promotion metric. |
| `captureState.signalSumSquares` | authoritative | RMS computation input. |
| `captureState.pcmChunks` | authoritative | Raw PCM buffer array. Concatenated on finalization. |
| `asrState.speechDetectedUtteranceId` | signal (from ASR) | Server VAD confirmation. Contributes to `server_vad_confirmed` promotion. Must match `captureState.asrUtteranceId`. See [Part 2, Section 13](#13-authoritative-vs-heuristic-signals-1). |
| `asrState.speechDetectedAt` | signal (from ASR) | Timestamp of server VAD speech detection. |
| `speakingEndFinalizeTimer` | lifecycle timer | Adaptive delay between Discord `speakingEnd` and capture finalization. Not a state indicator. |
| `idleFlushTimer` | lifecycle timer | Fires when no audio arrives for a threshold period. |
| `maxFlushTimer` | lifecycle timer | Hard cap at `CAPTURE_MAX_DURATION_MS` (8s). Prevents unbounded captures. |
| `session.lastInboundAudioAt` | derived | Updated on promotion and subsequent audio. Used by reply decision for silence timing. Not part of capture state. |

## 4. Promotion Signals

Promotion is evaluated on every incoming audio chunk in `onUserAudio`. Two independent signals can trigger promotion:

| Signal | Criteria | Constants |
|---|---|---|
| `server_vad_confirmed` | Server VAD fired for this utterance (`speechDetectedUtteranceId === captureState.asrUtteranceId`) AND `activeSampleRatio >= 0.02` AND `peak >= 0.016` AND `bytesSent >= minPromotionBytes` | `VOICE_TURN_PROMOTION_ACTIVE_RATIO_MIN` (0.02), `VOICE_TURN_PROMOTION_PEAK_MIN` (0.016), `VOICE_TURN_PROMOTION_MIN_CLIP_MS` (420) |
| `strong_local_audio` | `activeSampleRatio >= 0.06` AND `peak >= 0.04` AND `rms >= 0.004` AND `bytesSent >= minPromotionBytes` | `VOICE_TURN_PROMOTION_STRONG_LOCAL_ACTIVE_RATIO_MIN` (0.06), `VOICE_TURN_PROMOTION_STRONG_LOCAL_PEAK_MIN` (0.04), `VOICE_TURN_PROMOTION_STRONG_LOCAL_RMS_MIN` (0.004) |

The hybrid design is deliberate:

- Server VAD rejects ambient noise (TV, room noise) better than fixed local thresholds
- Local fallback ensures clearly strong speech promotes even if server VAD is delayed
- `server_vad_confirmed` has lower local thresholds because the server already validated speech

Promotion side effects:

- May cancel pending pre-audio system speech, but local-only `strong_local_audio` promotion waits for Realtime VAD confirmation before it can supersede preplay reply generation
- Begins shared ASR utterance (if shared ASR mode) and flushes buffered PCM
- Updates `session.lastInboundAudioAt`
- Emits `voice_activity_started` log event

## 5. Transition Rules

| Event | From | To |
|---|---|---|
| `clankvox` `speakingStart` | (no capture) | `provisional` |
| Audio chunk with promotion criteria met | `provisional` | `promoted` |
| `clankvox` `speakingEnd` (arms finalize timer) | `promoted` | `finalizing` |
| `clankvox` `speakingStart` again (same user, clears timer) | `finalizing` | `promoted` |
| New `userAudio` during finalize timer (clears timer) | `finalizing` | `promoted` |
| Finalize timer fires | `finalizing` | `finalized` → turn processor |
| `clankvox` `userAudioEnd` | `promoted` / `finalizing` | `finalized` → turn processor |
| Idle flush timer fires | `promoted` | `finalized` → turn processor |
| Max duration timer fires (8s) | any active | ASR commit → transcript banked (no generation) |
| Near-silence early abort (age >= 1s, signal below threshold) | `provisional` | discarded |
| `clankvox` `speakingEnd` timer fires on unpromotable capture | `provisional` | discarded |
| Explicit abort (`abortActiveInboundCaptures`) | any active | discarded |
| `clankvox` `clientDisconnect` | any active | `finalized` (if promoted) or discarded |
| `clankvox` `speakingEnd` (no promotion, discard) | `provisional` | discarded |

### Discard conditions (never reaches turn processor)

| Condition | Log Event |
|---|---|
| Never promoted (signal too weak for any promotion signal) | `voice_turn_dropped_provisional_capture` |
| Zero bytes sent (no audio data received) | `voice_turn_skipped_empty_capture` |
| Silence gate (aggregated PCM fails RMS/peak/activeRatio thresholds) | `voice_turn_dropped_silence_gate` |
| Near-silence early abort (age >= 1s, very low signal) | `voice_turn_dropped_provisional_capture` with `near_silence_early_abort` reason |

The silence gate's `VOICE_SILENCE_GATE_MIN_CLIP_MS` (280ms) and promotion's `VOICE_TURN_PROMOTION_MIN_CLIP_MS` (420ms) serve different purposes: the silence gate asks "is this audio at all?" and drops pure silence before wasting an ASR call, while promotion asks "is this speech worth processing as a turn?" A 300ms clip of faint noise correctly passes the silence gate (it's not silent) but correctly fails promotion (it's not a real utterance).

## 6. Cross-Domain State Reads

The capture subsystem reads state from other subsystems at these points:

| Subsystem | State Read | Where | Purpose |
|---|---|---|---|
| Assistant Output | `assistantOutput.phase` via `getOutputChannelState` | `onSpeakingStart` (suppression check) | Don't start captures during web lookup busy |
| Assistant Output | `botTurnOpen`, `botTurnOpenAt` | `bargeInController.shouldBargeIn` | Echo guard — don't barge in within 1500ms of bot speech start |
| Assistant Output | `hasRecentAssistantAudioDelta`, `hasBufferedTtsPlayback` | `bargeInController.shouldBargeIn` | Check if bot is actively streaming audio |
| Music | `musicActive` via `getOutputChannelState` | `bargeInController.isBargeInInterruptTargetActive` | Don't trigger barge-in on music-only output |
| ASR Bridge | `speechDetectedUtteranceId`, `speechDetectedAt` | `hasCaptureServerVadSpeech` | Server VAD confirmation for promotion. See [Part 2, Section 13](#13-authoritative-vs-heuristic-signals-1). |
| Session Lifecycle | `session.ending` | All capture operations | Bail out when session is ending |
| Session Identity | `client.user?.id` | `onSpeakingStart` | Ignore bot's own speaking events |
| Barge-In | `bargeInSuppressionUntil` | `isBargeInOutputSuppressed` | Suppress outbound audio after barge-in |

### Timing-sensitivity notes

All signal metrics (`bytesSent`, `signalSampleCount`, `signalActiveSampleCount`, `signalPeakAbs`, `signalSumSquares`) are updated **synchronously** in the `onUserAudio` hot path. This is essential because:

- Promotion checks run on the same tick as audio accumulation
- Barge-in signal assertions read these metrics synchronously
- Multiple users can have overlapping audio chunks on the same event loop tick

## 7. The Turn Output

When a promoted capture finalizes, the concatenated PCM buffer is routed based on session mode:

### Realtime Session With File ASR Override

> `turnProcessor.queueFileAsrTurn({ session, userId, pcmBuffer, captureReason })`

### Realtime Mode (with ASR bridge)

> `captureManager.runAsrBridgeCommit()` → `commitAsrUtterance()` → `queueRealtimeTurnFromAsrBridge()` → `turnProcessor.queueRealtimeTurn()` with transcript overrides

Per-user ASR keeps the provider's committed realtime `item_id` bound to the utterance object that issued the commit. Late final transcript events therefore stay attached to the correct committed turn even if a fresh provisional capture starts before the provider finishes streaming the transcript.

See [Part 2: ASR Bridge](#part-2-asr-bridge) for the full commit and transcript resolution flow.

### Realtime Mode (without ASR bridge)

> `turnProcessor.queueRealtimeTurn({ session, userId, pcmBuffer, captureReason })` (turn processor runs its own ASR)

The `RealtimeQueuedTurn` contains the PCM buffer, capture metadata, and (if ASR bridge was active) pre-computed transcript, logprobs, and timing data.

### max_duration as Chunking (Not Turn Boundary)

`max_duration` finalization commits the ASR audio buffer to get a transcript back, but does NOT push the turn into the generation queue. Instead, the transcript is banked and merged with subsequent chunks until a real speech-end signal arrives.

**Flow:**
```
max_duration fires
  → ASR commit → transcript banked in accumulator
  → DO NOT queue for generation
  → wait for next finalization event

next finalization (stream_end / speaking_end / another max_duration)
  → if stream_end or speaking_end:
      → merge accumulated transcripts + this chunk's transcript
      → turnProcessor.queueRealtimeTurn() with merged transcript
  → if another max_duration:
      → bank this chunk too, keep waiting
```

**Key behaviors:**

- `max_duration` commits to ASR are still sent — the OpenAI buffer needs to be committed so transcription can run. This is the "chunking" role.
- Banked transcripts are stored per-user on the capture or ASR bridge state. Each chunk's transcript is appended in order.
- Only a real speech-end signal (`stream_end`, `speaking_end`, `userAudioEnd`) triggers generation with the merged transcript.
- If the user disconnects or session ends, banked transcripts are flushed as a final turn.
- The `captureReason` on the queued turn should reflect the final trigger (e.g., `stream_end`), not `max_duration`.

**Edge cases:**

- User speaks for 20s (two max_duration chunks + stream_end): three ASR commits, three partial transcripts banked, one merged turn queued on stream_end.
- User speaks for 8s and goes silent (max_duration, then idle flush): max_duration banks, idle flush triggers generation with accumulated content.
- User speaks for 8s and disconnects: max_duration banks, disconnect flushes as final turn.

**Motivation:** Without this, a user mid-sentence at the 8s cap gets a reply to an incomplete utterance:

```
01:06:36  voice_turn_finalized    reason=max_duration   transcript="Um, can you play me..."
01:06:37  voice_turn_addressing   allow=true            (generation starts on incomplete sentence)
01:06:40  voice_turn_finalized    reason=stream_end     transcript="On eBay"  (continuation arrives)
01:06:40  realtime_reply_requested  replyText="oh yeah what do you want me to throw on"
                                    (bot replies to fragment, ignores real intent)
```

## 8. Speaking End Debounce

The `speakingEndFinalizeTimer` uses an adaptive delay (`resolveSpeakingEndFinalizeDelayMs`) that scales based on system load:

- More active captures → longer delay (avoids premature finalization during multi-speaker crosstalk)
- Turn backlog → longer delay (system is busy processing previous turns)
- Base delay is short for responsive single-speaker interaction

If `speakingStart` fires again for the same user, or new `userAudio` arrives during the timer window, the timer is cleared and the capture continues accumulating audio.

## 9. Incident Debugging

When a user speaks but no turn reaches the brain:

1. Check for `voice_turn_dropped_provisional_capture` — the capture never promoted. Look at promotion thresholds vs actual signal metrics.
2. Check for `voice_turn_dropped_silence_gate` — the aggregated PCM was too quiet.
3. Check for `voice_turn_skipped_empty_capture` — no audio data was received from the subprocess.
4. If a promoted turn still shows `voice_realtime_transcription_empty`, inspect `trackedUtteranceId`, `activeUtteranceId`, `finalSegmentCount`, and `partialChars` on that event before blaming provisional capture. A later provisional drop can belong to a different weak follow-on capture.
5. If none of the above, check `voice_activity_started` for promotion confirmation, then look downstream at noise rejection gates (logprob confidence, bridge fallback hallucination).

When captures are too aggressive (noise triggers turns):

1. Check promotion reason — `strong_local_audio` with low actual signal suggests threshold tuning needed.
2. Check if server VAD is active — `server_vad_confirmed` should catch most ambient noise.
3. Check near-silence early abort — if not firing, the thresholds may need lowering.

## 10. Regression Tests

These cases should remain covered:

- Provisional captures that never promote should be silently discarded without ASR cost
- `server_vad_confirmed` promotion requires both server VAD match AND local signal thresholds
- `strong_local_audio` promotion fires without server VAD when signal is clearly strong
- `speakingEnd` → `speakingStart` within debounce window continues the same capture
- Max duration timer (8s) commits ASR but banks transcript without queuing generation
- Banked transcripts merge correctly on subsequent stream_end
- Multiple max_duration chunks accumulate and merge in order
- Idle flush after max_duration triggers generation with banked content
- Disconnect after max_duration flushes banked content
- Near-silence early abort fires at 1s for very weak signal
- Promoted captures that fail silence gate are still dropped (redundant safety net)
- `abortActiveInboundCaptures` cleanly tears down all active captures
- System speech (thoughts) is cancelled on capture promotion

Current coverage:

- `src/voice/voiceAudioAnalysis.test.ts` (signal analysis functions)
- `src/voice/voiceSessionManager.lifecycle.test.ts` (integration scenarios)

---

# Part 2: ASR Bridge

This part defines the ASR (Automatic Speech Recognition) bridge state machine. Each ASR bridge session (`AsrBridgeState`) manages a WebSocket connection to OpenAI's Realtime Transcription API, buffers audio during connection delays, and resolves transcripts for finalized captures.

## 11. Source of Truth

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

## 12. Phases

Each `AsrBridgeState` has a `phase` field tracking its WebSocket lifecycle:

| Phase | Meaning |
|---|---|
| `idle` | No WebSocket connection. Initial state and post-teardown state. |
| `connecting` | WebSocket is opening. Audio is buffered in `pendingAudioChunks`. |
| `ready` | WebSocket is open and accepting audio. Pending audio flushed on transition. |
| `committing` | A transcript commit is in progress (`commitInputAudioBuffer` sent, awaiting response). |
| `closing` | WebSocket is being torn down. |

Phase query helpers: `asrPhaseCanAcceptAudio` (connecting or ready), `asrPhaseIsConnected` (ready or committing), `asrPhaseCanCommit` (ready), `asrPhaseIsCommitting` (committing), `asrPhaseIsClosing` (closing).

## 13. Authoritative vs Heuristic Signals

| Signal | Role | Notes |
|---|---|---|
| `asrState.phase` | authoritative | Canonical WebSocket lifecycle phase. Guards all operations. |
| `asrState.userId` | authoritative (shared mode) | Active user lock. Only one user at a time can use the shared bridge. Null when unlocked. |
| `asrState.client` | authoritative | The `OpenAiRealtimeTranscriptionClient` instance. Null when idle. |
| `asrState.utterance` | authoritative | Current utterance state: `finalSegments`, `partialText`, `lastEventAt`. Updated by WebSocket transcript events. |
| `asrState.speechDetectedUtteranceId` | signal | Server VAD confirmation. Read by capture promotion logic (see [Section 4](#4-promotion-signals)). Must match `captureState.asrUtteranceId`. |
| `asrState.speechDetectedAt` | signal | Timestamp of server VAD speech detection. |
| `asrState.pendingAudioChunks` | buffer | Audio queued during `connecting` phase. Flushed on transition to `ready`. Capped at 10s (480,000 bytes). |
| `asrState.pendingAudioBytes` | buffer metric | Total bytes in pending buffer. Used for overflow trimming. |
| `asrState.committingUtteranceId` | guard | Ensures audio flush targets the correct utterance during commit. |
| `asrState.connectPromise` | deduplication | Prevents concurrent connect attempts. Multiple callers await the same promise. |
| `asrState.consecutiveEmptyCommits` | heuristic | Circuit breaker: after 3 consecutive empty commits with >1s audio, force-close and reconnect. |
| `asrState.idleTimer` | lifecycle timer | Closes the WebSocket after idle TTL expires. Cleared on new utterance begin. |

## 14. Transition Rules

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

ASR bridge session updates use `session.update` with `session.type = "transcription"` and nested `audio.input` fields for format, noise reduction, turn detection, and transcription. Configured `g711_ulaw` and `g711_alaw` inputs are mapped to OpenAI's `audio/pcmu` and `audio/pcma` media descriptors.

## 15. Per-User vs Shared Mode

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

## 16. Audio Buffering

Audio arrives via `appendAudioToAsr` on every `onUserAudio` chunk:

1. If phase is `connecting`: queue as `AsrPendingAudioChunk` with utterance ID, cap at 10s
2. If phase is `ready`: attempt flush via `flushPendingAsrAudio`, then send directly
3. If phase is `committing`: queue for next utterance (utterance ID mismatch guard prevents mixing)

`flushPendingAsrAudio` sends all pending chunks to the WebSocket client, matching utterance IDs. Chunks for stale utterances are skipped.

## 17. Transcript Resolution

### Per-User Commit Flow

1. `commitAsrUtterance` called with finalized capture's PCM
2. Phase: `ready` → `committing`
3. Flush remaining pending audio
4. Call `client.commitInputAudioBuffer()`
5. `waitForAsrTranscriptSettle`: poll `utterance.finalSegments` until stable or timeout
6. Build `AsrCommitResult` with transcript, timing, model info, logprobs
7. Phase: `committing` → `ready`
8. Schedule idle close timer

If the commit times out empty but the same utterance produces a late final segment shortly after, the capture manager still watches that committed utterance object during the late-recovery window. A new provisional utterance for the same speaker does not cancel recovery of the older committed transcript.

If that late-recovery window also ends empty, both bridge empty-drop paths recover any stashed preplay-superseded turn before returning. If no preplay-superseded turn exists but the same speaker had just barge-interrupted a live reply, the runtime replays that interrupted assistant line directly. Empty newer speech is treated as noise or abandonment, not as durable reason to lose the older admitted turn.

If that late transcript revises a turn that has already been admitted but has not started audio yet, the turn processor replaces the older queued turn in place and replays the corrected revision with a fresh reply scope. The corrected utterance is treated as the same turn becoming more complete, not as stale newer work that should be dropped.

Per-user item association follows the committed `item_id` first. When OpenAI server VAD auto-commits a turn before local capture finalization enters `committing`, the bridge still binds that `item_id` to the current active utterance. This prevents a final transcript such as `"stop music"` from being misattached to an older turn through `previous_item_id`.

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

This flows through `queueRealtimeTurnFromAsrBridge` into the turn processor as `*Override` fields on `RealtimeQueuedTurn`, skipping the turn processor's own ASR. See [Section 7](#7-the-turn-output) for the full routing.

Canonical policy note:

- raw PCM transcription plan selection is shared across realtime turn processing, file-ASR turns, and music-command interception
- `gpt-4o-mini-transcribe` keeps the short-clip no-fallback optimization only for `openai_realtime`
- otherwise the mini model gets a single full-model fallback to `whisper-1`

## 18. Cross-Domain State Reads

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

## 19. Client Events

The `OpenAiRealtimeTranscriptionClient` emits:

| Event | Handler | Effect on ASR State |
|---|---|---|
| `transcript` | `wireClientEvents` | Updates `utterance.finalSegments` / `partialText`, sets `lastTranscriptAt`. Shared mode: populates `finalTranscriptsByItemId`. |
| `speech_started` | `wireClientEvents` | Sets `speechDetectedAt`, `speechDetectedUtteranceId`, `speechActive = true`. Used by capture promotion (see [Section 4](#4-promotion-signals)). |
| `speech_stopped` | `wireClientEvents` | Sets `speechActive = false`. |
| `error_event` | `wireClientEvents` | Logs error. May trigger session close depending on severity. |
| `socket_closed` | `wireClientEvents` | Transitions phase to `idle`. Clears client reference. |

## 20. Incident Debugging

When ASR produces no transcript for audible speech:

1. Check `phase` — was the session in `ready` state? If `connecting`, audio may have overflowed the 10s buffer.
2. Check `committingUtteranceId` — did it match the current utterance? Stale utterance ID = audio sent to wrong commit.
3. Check `consecutiveEmptyCommits` — circuit breaker may have fired, triggering reconnect.
4. Check logprob confidence — transcript may have been produced but dropped by `VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD`.

When shared ASR hangs:

1. Check `asrState.userId` — is the user lock stuck? A capture that failed to release would block all subsequent users.
2. Check `pendingCommitResolvers` — are there unresolved promises waiting for `committed` events?
3. Check `tryHandoffSharedAsr` — did the handoff scan find the waiting capture?

## 21. Regression Tests

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
- `src/voice/voiceAsrBridge.test.ts` (per-user/server-VAD item binding and bridge lifecycle)
