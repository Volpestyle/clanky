# Voice Reply Orchestration State Machine

> **Scope:** Reply dispatch — from admitted user turn to pipeline execution, including deferred turn queuing, retry, and supersede logic.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Assistant output lifecycle: [`voice-output-state-machine.md`](voice-output-state-machine.md)
> Audio capture lifecycle: [`voice-audio-capture-state-machine.md`](voice-audio-capture-state-machine.md)
> Barge-in policy: [`barge-in.md`](barge-in.md)

This document defines the reply orchestration subsystem — how admitted user turns are dispatched to the correct reply pipeline, how turns are deferred when the output channel is busy, and how interrupted replies are retried.

## 1. Source of Truth

Reply orchestration state lives on the `VoiceSession`:

- `session.pendingRealtimeTurns: RealtimeQueuedTurn[]` — queue of finalized realtime turns awaiting processing
- `session.realtimeTurnDrainActive: boolean` — whether the drain loop is running
- `session.pendingFileAsrTurnsQueue: FileAsrQueuedTurn[]` — queue of file-ASR turns awaiting processing
- `session.fileAsrTurnDrainActive: boolean` — whether the file-ASR drain loop is running
- `session.deferredVoiceActions: Record<DeferredVoiceActionType, DeferredVoiceAction>` — deferred action queue (interrupted replies, queued user turns)

The `TurnProcessor` owns turn queueing and drain logic. The `DeferredActionQueue` owns deferred action scheduling and dispatch. The `VoiceSessionManager` owns the reply pipeline caller methods.

Code:

- `src/voice/turnProcessor.ts` — turn queueing, drain loops, `runRealtimeTurn`, `runFileAsrTurn`
- `src/voice/voiceReplyDecision.ts` — reply admission gate (`evaluateVoiceReplyDecision`)
- `src/voice/voiceReplyPipeline.ts` — unified reply pipeline
- `src/voice/deferredActionQueue.ts` — deferred action management
- `src/voice/replyManager.ts` — response tracking, output state sync, deferred trigger
- `src/voice/voiceSessionManager.ts` — pipeline caller methods, barge-in, supersede

## 2. Turn Queue Lifecycle

Turns enter the system via two queues and are drained serially:

### Realtime Turn Queue

```
captureManager.finalizeUserTurn()
  → turnProcessor.queueRealtimeTurn()
    → coalesce within REALTIME_TURN_COALESCE_WINDOW_MS
    → drainRealtimeTurnQueue() (serial, one at a time)
      → runRealtimeTurn()
```

### File ASR Turn Queue

```
captureManager.finalizeUserTurn() (realtime session with `transcriptionMethod="file_wav"`)
  → turnProcessor.queueFileAsrTurn()
    → drainFileAsrTurnQueue() (serial)
      → runFileAsrTurn()
```

Turn coalescing: multiple turns arriving within the coalesce window are merged into a single turn with concatenated PCM and merged transcripts.

## 3. Reply Admission Gate

`evaluateVoiceReplyDecision()` in `voiceReplyDecision.ts` evaluates each turn against a deterministic gate sequence:

| Order | Gate | Result on Match |
|---|---|---|
| 1 | Missing transcript | deny |
| 2 | Pending command followup (music disambiguation) | allow |
| 3 | Output locked (not music-only) | deny (`"bot_turn_open"`, retry after 1400ms) |
| 4 | Command-only + direct address | allow |
| 5 | Command-only + not addressed | deny |
| 6 | Music playing + not awake | deny |
| 7 | Direct address fast path | allow |
| 8 | Eagerness disabled + no direct address | deny |
| 9 | Full-brain admission path (generation decides) | allow |
| 10 | No brain session | deny |
| 11 | Music playing + not awake (bridge) | deny |
| 12 | Generation-only admission mode | allow |

For bridge path turns that survive deterministic gates, `runVoiceReplyClassifier()` makes a YES/NO LLM call when `realtimeAdmissionMode === "hard_classifier"`.

## 4. Reply Dispatch (Three Mutually Exclusive Paths)

After admission, the turn processor dispatches based on mode:

| Path | Condition | Who generates text? | Who generates speech? | Uses `runVoiceReplyPipeline`? |
|---|---|---|---|---|
| **Native** | `shouldUseNativeRealtimeReply` | Realtime model (end-to-end) | Realtime model | No |
| **Bridge** (text→realtime) | `shouldUseRealtimeTranscriptBridge` | Realtime model (from forwarded text) | Realtime model | No |
| **Full Brain Reply** (realtime transport) | Default realtime with full-brain path | `generateVoiceTurn` (orchestrator LLM) | Realtime TTS or API TTS | Yes (`mode: "realtime_transport"`) |

### Native Path (`forwardRealtimeTurnAudio`)

Raw PCM forwarded to realtime client. The model handles understanding + audio generation end-to-end. Instruction context is refreshed non-blocking.

### Bridge Path (`forwardRealtimeTextTurnToBrain`)

Labeled transcript `(speakerName): text` sent to realtime provider. Cancels any in-flight response first. Instruction context refreshed **blocking** (awaits `prepareRealtimeTurnContext`).

### Brain Path (`runVoiceReplyPipeline`)

The unified pipeline: generate text via LLM, build playback plan, play via realtime TTS or API TTS. See `voice-provider-abstraction.md` §3 for detailed stage description.

In realtime sessions, this path can still deliver speech through the realtime client even when settings-level `voice.replyPath` is `"brain"`. Here `mode: "realtime_transport"` means "use realtime output transport for pre-generated text", not "use the transcript-to-realtime bridge path above". On OpenAI, these exact-line playback requests are sent out-of-band with tools disabled so pre-generated speech cannot start a second provider tool/reasoning loop.

## 5. Deferred Turn System

When a turn is denied with reason `"bot_turn_open"` (output channel busy), it is **deferred** rather than dropped.

### Queueing

`queueDeferredBotTurnOpenTurn()`:
1. Normalize transcript, ignore empty
2. Push `DeferredQueuedUserTurn` to the deferred action queue
3. Cap queue at `BOT_TURN_DEFERRED_QUEUE_MAX` (oldest dropped)
4. Schedule flush timer

### Flush Triggers

Deferred turns are flushed when the output channel becomes free:

| Trigger | Mechanism |
|---|---|
| `assistantOutput.phase` transitions to `idle` | `syncAssistantOutputState` schedules recheck with 0ms delay |
| `clearPendingResponse` called | `recheckDeferredVoiceActions` called directly |
| Scheduled timer fires | `scheduleDeferredVoiceActionRecheck` timeout |
| Empty ASR result on bridge commit | `recheckDeferredVoiceActions` called |

### `flushDeferredBotTurnOpenTurns()`

1. Check `getOutputChannelState` — if still locked or capture-blocking, reschedule and return
2. Clear the deferred action
3. Coalesce up to `BOT_TURN_DEFERRED_COALESCE_MAX` turns (direct-addressed get priority)
4. Concatenate PCM buffers
5. **Re-run the full admission gate** on the coalesced transcript
6. If denied again: re-queue
7. If allowed: dispatch to the correct pipeline (same mode-switching as normal turns)

### Capture Blocking

Active promoted captures block deferred turn flushing. `hasReplayBlockingActiveCapture` checks `session.userCaptures` for promoted captures with confirmed live speech. This prevents the bot from replying to a deferred turn while someone is still speaking.

Silence-only captures (very weak signal, never promoted) do NOT block deferred replay.

## 6. Interrupted Reply Retry (Barge-In Recovery)

When barge-in interrupts bot speech:

### Phase 1: Interrupt

`executeBargeInInterruptCommand`:
1. Cancel active realtime response
2. Reset bot audio playback
3. If cancel succeeded AND utterance text was in progress:
   - Create deferred action `"interrupted_reply"` with: utterance text, interrupting user ID, interruption policy
   - Set expiry: `BARGE_IN_RETRY_MAX_AGE_MS`
4. Set barge-in suppression window

### Phase 2: Recovery

When the interrupting user's capture completes:
1. `recheckDeferredVoiceActions` with `preferredTypes: ["interrupted_reply"]`
2. `fireDeferredInterruptedReply` checks:
   - Same user who interrupted?
   - Barge-in duration >= `BARGE_IN_FULL_OVERRIDE_MIN_MS`? → skip retry (user's new speech supersedes)
   - Otherwise: re-send interrupted utterance text via `requestRealtimeTextUtterance` with original interruption policy

## 7. Generation Supersede Guard (3-Stage)

Three layers prevent the bot from generating or speaking replies to stale input. This handles cases where the user finishes a sentence then corrects themselves ("play Drake... actually no play Kendrick").

For the related problem of mid-sentence cutoff at the 8s `max_duration` cap, see [`voice-audio-capture-state-machine.md` §7 (max_duration as Chunking)](voice-audio-capture-state-machine.md).

### Stage 1: Pre-generation gate

Before calling `generateVoiceTurn` in `voiceReplyPipeline.ts`, check whether newer input has arrived that supersedes this turn:

```
pre-generation check:
  → summarizeRealtimeInterruptingQueue({ session, finalizedAfterMs: turnFinalizedAt })
  → summarizeRealtimeInterruptingLiveCaptures({ session })
  → if either has content: skip generation, let newer turn process
```

Reuses the same queue/live-capture inspection logic that stage 3 already uses, but runs it before paying for an LLM call. Log: `voice_generation_superseded_pre_generation`.

### Pre-play Supersede Requeue

When user speech interrupts an in-flight generation that hasn't produced audio yet (`phase === "generation_only"`), the system may **requeue** the interrupted turn so it can be retried after the user finishes speaking. This prevents dropping legitimate user turns that were just slow to generate.

**Requeue eligibility** (`cancelPendingPrePlaybackReplyForUserSpeech`):

- Active reply was aborted (`activeReplyAbortCount > 0`)
- In-flight turn exists and is in `generation_only` phase (no tool side effects)
- Turn age < `PREPLAY_SUPERSEDE_REQUEUE_MAX_AGE_MS`
- Turn has a transcript
- Turn did NOT originate from a deferred flush (prevents zombie loops)
- Turn is NOT a bot-initiated event (`bot_join_greeting`, `member_join_greeting`)

**Bot-initiated event exclusion:** Synthetic events like join greetings are not real user speech — they become stale the moment a user speaks over them. Requeuing them produces zombie turns that race with the user's actual input, causing the bot to greet after the user has already started a conversation. These are dropped, not requeued.

### Stage 2: Abortable generation

Voice generation registers an active reply and passes an `AbortSignal` to the LLM call, enabling mid-generation cancellation when newer speech arrives.

The plumbing exists but is not yet wired for voice:

- `ActiveReplyRegistry.begin()` creates an `AbortController` per reply scope (`activeReplyRegistry.ts`)
- `llm.generate()` accepts a `signal` parameter and threads it to the service layer
- Text replies already use this path (`replyPipeline.ts`)

**Wiring:**

```typescript
const replyScopeKey = `voice:${session.id}`;
const activeReply = bot.activeReplies.begin(replyScopeKey, "voice-generation");
const signal = activeReply.abortController.signal;

const generation = await runtime.llm.generate({
  // ... existing params
  signal,
});
```

**Abort trigger:** When a new turn is queued via `queueRealtimeTurn()` and a voice generation is in-flight for the same session, abort the in-flight generation via `activeReply.abortController.abort()`.

**Cleanup on abort:** Catch `AbortError`, log `voice_generation_aborted_superseded`, skip playback, let the newer turn proceed through the queue drain.

### Stage 3: Pre-playback supersede (existing)

`maybeSupersedeRealtimeReplyBeforePlayback` runs before each speech playback step:

- Checks if newer finalized realtime turns are queued
- Checks if newer promoted live captures exist (for system speech)
- If either: abandon the stale reply (`completed: false`), let the newer content process

This is the final safety net for anything that slips through stages 1 and 2.

### Behavior summary

| Scenario | Stage | What happens |
|---|---|---|
| User corrects before generation starts | 1 | Skip generation, let newer turn process |
| User corrects during generation | 2 | Abort LLM call, skip playback |
| User corrects after generation, before playback | 3 | Drop at playback gate |
| Clean short sentence, no correction | — | Normal path, no gating triggered |

## 8. Cross-Domain State Reads

| Subsystem | State Read | Purpose |
|---|---|---|
| **Assistant Output** | `assistantOutput.phase`, `buildReplyOutputLockState()` | Output lock check: is the channel busy? |
| **Capture Manager** | `session.userCaptures`, `hasReplayBlockingActiveCapture()` | Are active captures blocking deferred replay? |
| **Music** | `getMusicPhase()`, `musicPhaseShouldLockOutput()`, `musicPhaseShouldForceCommandOnly()` | Music output lock, command-only mode during playback |
| **ASR** | `transcriptOverride`, `transcriptLogprobs` | Pre-computed transcript from ASR bridge |
| **Barge-In** | `isBargeInOutputSuppressed()` | Is outbound audio suppressed after barge-in? |
| **Engagement** | `lastDirectAddressAt`, `lastDirectAddressUserId`, `voiceCommandState` | Addressing and engagement context for admission |
| **Realtime Client** | `isResponseInProgress()`, `activeResponseId` | Stale response detection |
| **Tool Execution** | `realtimeToolCallExecutions.size` | Tool calls blocking output? |

## 9. Deferred Action Priority

When multiple deferred actions are pending, `recheckDeferredVoiceActions` processes them in priority order:

1. `"interrupted_reply"` — highest priority (restore interrupted bot speech)
2. `"queued_user_turns"` — lower priority (process backlogged user input)

Each action has a `notBeforeAt` timestamp and an `expiresAt` deadline. `canFireDeferredAction` checks:
- Session active?
- Action expired? (if so, clear it)
- `notBeforeAt` in the future? (if so, reschedule timer)
- Output channel blocked? (if so, wait)

## 10. Incident Debugging

When a user turn is admitted but the bot doesn't reply:

1. Check which dispatch path was taken (native, bridge, brain reply)
2. For full-brain replies: check `runVoiceReplyPipeline` — did `generateVoiceTurn` produce content?
3. Check `pendingResponse` — was a tracked response created?
4. Check for supersede — was the reply abandoned for newer input?

When deferred turns never replay:

1. Check `deferredVoiceActions` — is the action present?
2. Check `getOutputChannelState().deferredBlockReason` — what's blocking? (`"output_locked"`, `"active_captures"`, `"barge_in_suppressed"`)
3. Check `expiresAt` — did the action expire before the output channel freed up?
4. Check `hasReplayBlockingActiveCapture` — is a weak/silent capture incorrectly blocking?

When barge-in retry produces stale content:

1. Check `BARGE_IN_RETRY_MAX_AGE_MS` — did the retry fire within the age limit?
2. Check `BARGE_IN_FULL_OVERRIDE_MIN_MS` — was the barge-in long enough to qualify as full override?
3. Check if the original utterance text is still relevant (supersede logic should catch this)

## 11. Regression Tests

These cases should remain covered:

- Denied turns with `"bot_turn_open"` reason are deferred, not dropped
- Deferred turns flush when `assistantOutput.phase` transitions to `idle`
- Active promoted captures block deferred replay
- Silence-only captures do NOT block deferred replay
- Coalesced deferred turns re-run the full admission gate
- Barge-in creates `"interrupted_reply"` deferred action when cancel succeeds
- Full override barge-in (long enough duration) skips retry
- Pre-generation gate skips generation when newer finalized turn exists
- Pre-generation gate skips generation when live promoted capture exists
- Aborted generation produces no playback and no conversation window entry
- Abort cleanup does not corrupt session state
- Bot-initiated events (`bot_join_greeting`, `member_join_greeting`) are NOT requeued when user speaks over them
- Pre-playback supersede (stage 3) abandons stale replies for newer input
- Silent response recovery retries and then hard-recovers
- Deferred action expiry clears stale actions

Current coverage:

- `src/voice/voiceSessionManager.lifecycle.test.ts` (integration scenarios)
- `src/voice/voiceToolCallMemory.test.ts` (memory tool execution)
