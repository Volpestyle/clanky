# Voice Audio Capture State Machine

> **Scope:** Per-user audio capture lifecycle — from Discord speaking event to finalized voice turn.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Barge-in and echo policy: [`barge-in.md`](barge-in.md)
> Assistant output lifecycle: [`voice-output-state-machine.md`](voice-output-state-machine.md)

This document defines the per-user audio capture state machine. Each user who speaks in a voice session gets an independent `CaptureState` that tracks their audio from the first Discord speaking event through promotion, finalization, and handoff to the turn processor.

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
| `asrState.speechDetectedUtteranceId` | signal (from ASR) | Server VAD confirmation. Contributes to `server_vad_confirmed` promotion. Must match `captureState.asrUtteranceId`. |
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

- Cancels pending system speech (thoughts) that hasn't produced audio yet
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

## 6. Cross-Domain State Reads

The capture subsystem reads state from other subsystems at these points:

| Subsystem | State Read | Where | Purpose |
|---|---|---|---|
| Assistant Output | `assistantOutput.phase` via `getOutputChannelState` | `onSpeakingStart` (suppression check) | Don't start captures during web lookup busy |
| Assistant Output | `botTurnOpen`, `botTurnOpenAt` | `bargeInController.shouldBargeIn` | Echo guard — don't barge in within 1500ms of bot speech start |
| Assistant Output | `hasRecentAssistantAudioDelta`, `hasBufferedTtsPlayback` | `bargeInController.shouldBargeIn` | Check if bot is actively streaming audio |
| Music | `musicActive` via `getOutputChannelState` | `bargeInController.isBargeInInterruptTargetActive` | Don't trigger barge-in on music-only output |
| ASR Bridge | `speechDetectedUtteranceId`, `speechDetectedAt` | `hasCaptureServerVadSpeech` | Server VAD confirmation for promotion |
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

→ `turnProcessor.queueFileAsrTurn({ session, userId, pcmBuffer, captureReason })`

### Realtime Mode (with ASR bridge)

→ `captureManager.runAsrBridgeCommit()` → `commitAsrUtterance()` → `queueRealtimeTurnFromAsrBridge()` → `turnProcessor.queueRealtimeTurn()` with transcript overrides

### Realtime Mode (without ASR bridge)

→ `turnProcessor.queueRealtimeTurn({ session, userId, pcmBuffer, captureReason })` (turn processor runs its own ASR)

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
4. If none of the above, check `voice_activity_started` for promotion confirmation, then look downstream at noise rejection gates (logprob confidence, bridge fallback hallucination).

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
