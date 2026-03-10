# Voice Client and Reply Orchestration

> **Scope:** Realtime brain client lifecycle and reply dispatch — from WebSocket connection through turn queueing, admission gating, pipeline execution, deferred turns, and supersede logic.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Output and barge-in: [`voice-output-and-barge-in.md`](voice-output-and-barge-in.md)
> Capture and ASR: [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)

---

## Part 1: Realtime Client

This part defines the realtime client lifecycle — how the bot connects to the AI provider (OpenAI, xAI, Gemini, ElevenLabs) for voice generation, manages instructions and tools, and handles the event stream that drives the assistant output state machine. Tool execution and context assembly stay shared across providers; the client adapter only translates provider protocol into the common runtime surface.

## 1. Source of Truth

The `VoiceSession` owns the realtime client reference in `session.realtimeClient`. The client type depends on the resolved runtime mode.

External systems provide events but do not own client state:

- The AI provider sends WebSocket events (audio deltas, response lifecycle, tool calls, errors).
- The `replyManager` derives assistant output state transitions from those events.
- The `instructionManager` manages instruction/tool refresh scheduling.

Code:

- `src/voice/openaiRealtimeClient.ts` — OpenAI Realtime API client
- `src/voice/xaiRealtimeClient.ts` — xAI realtime client
- `src/voice/geminiRealtimeClient.ts` — Gemini Live API client
- `src/voice/elevenLabsRealtimeClient.ts` — ElevenLabs conversational AI client
- `src/voice/realtimeClientCore.ts` — shared WebSocket utilities
- `src/voice/sessionLifecycle.ts` — event binding (`bindRealtimeHandlers`)
- `src/voice/voiceJoinFlow.ts` — client creation and session initialization
- `src/voice/instructionManager.ts` — instruction/tool refresh
- `src/voice/replyManager.ts` — response tracking, output state sync

## 2. Client Types and Capabilities

| Mode | Client Class | `textInput` | `updateInstructions` | `updateTools` | `cancelResponse` | `perUserAsr` | `sharedAsr` |
|---|---|---|---|---|---|---|---|
| `openai_realtime` | `OpenAiRealtimeClient` | yes | yes | yes | yes | yes | yes |
| `voice_agent` | `XaiRealtimeClient` | yes | yes | yes | yes | yes | yes |
| `gemini_realtime` | `GeminiRealtimeClient` | yes | yes (local only) | — | — | — | yes |
| `elevenlabs_realtime` | `ElevenLabsRealtimeClient` | yes | — | — | — | — | yes |

Capability checks use `providerSupports(mode, capability)` in `src/voice/voiceModes.ts`.

For text-mediated sessions (`bridge`, `brain`), the ASR bridge is still OpenAI-backed today even when the speaking/reasoning provider is xAI, Gemini, or ElevenLabs.

## 3. Lifecycle Phases

The realtime client has a simpler lifecycle than the ASR bridge — there is **no automatic reconnection**. Fatal errors end the session.

| Phase | Meaning |
|---|---|
| `creating` | Client instantiated, WebSocket not yet opened |
| `connecting` | `client.connect()` called, WebSocket opening (10s timeout) |
| `connected` | WebSocket open, `session.update` sent, ready for audio/text |
| `closed` | WebSocket closed (1000 normal close or error). Session ends. |

### Creation (`voiceJoinFlow.ts`)

The runtime mode determines which client class is instantiated. The subprocess (`ClankvoxClient`) is spawned **in parallel** with the API connect call for latency optimization.

### Connection

`client.connect()` calls `openRealtimeSocket()` which creates a WebSocket with a 10-second timeout, then `markRealtimeConnected()` sets connection metadata.

### No Automatic Reconnection

On socket close or fatal error, `endSession()` is called. Only specific recoverable errors are handled gracefully:

- `conversation_already_has_active_response` — not fatal
- `input_audio_buffer_commit_empty` — not fatal

> **Note:** This "no reconnection" policy applies to the main realtime brain client. The ASR bridge (documented in [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)) has its own reconnection behavior — its circuit breaker reconnects after 3 consecutive empty commits.

### Teardown

1. `session.ending = true`
2. Clear all timers (`clearSessionRuntimeTimers`)
3. Clear runtime state (`clearSessionRuntimeState`)
4. Close ASR sessions
5. Run cleanup handlers (remove event listeners)
6. `session.realtimeClient?.close()` — sends `ws.close(1000, "session_ended")` with 1.5s terminate fallback
7. `session.voxClient?.destroy()`

## 4. Event Binding

`bindRealtimeHandlers()` in `sessionLifecycle.ts` binds 7 events from the realtime client:

| Event | Handler | Purpose | Output State Machine Effect |
|---|---|---|---|
| `audio_delta` | `onAudioDelta` | Forward base64 audio to clankvox for Discord playback. Handle barge-in suppression and music ducking. | `syncAssistantOutputState("audio_delta")` |
| `transcript` | `onTranscript` | Log transcripts, record voice turns, parse inline soundboard directives out of assistant output transcripts, and capture requested refs without leaving control markup in stored speech text. | — |
| `error_event` | `onErrorEvent` | Check if error is recoverable. End session if not. | — |
| `socket_closed` | `onSocketClosed` | End session with reason `"realtime_socket_closed"`. | Session ends |
| `socket_error` | `onSocketError` | Log error only (does NOT end session by itself). | — |
| `response_done` | `onResponseDone` | Delegate to `replyManager.handleResponseDone()`. Handle silent response recovery, cost logging, music unduck scheduling. | `syncAssistantOutputState("response_done_*")` |
| `event` | `onEvent` | Raw event passthrough. Track assistant audio items, dispatch tool call events. | Various via tool call lifecycle |

All listeners are tracked in `session.cleanupHandlers` and removed during teardown.

## 5. Instruction and Tool Refresh

### Instruction Refresh (`instructionManager.ts`)

- `scheduleRealtimeInstructionRefresh()` — debounced timer
- `refreshRealtimeInstructions()` — builds instructions, calls `realtimeClient.updateInstructions()` if text changed (provider must support `updateInstructions`)
- `prepareRealtimeTurnContext()` — builds memory slice (user facts, conversation history, web lookups, guidance facts, relevant behavioral memory), then refreshes instructions
- `queueRealtimeTurnContextRefresh()` — serialized async queue preventing concurrent refreshes

Refresh triggers: session start, music idle/error, voice membership changes, channel changes, turn context updates.

Music prompt context stays available while playback is idle when the session still has meaningful music state. Realtime instructions include the current/last known track, exact reusable `selection_id` values for current/last/queued tracks, queued tracks, last action, and last query so the model can reason about replay and queue followups directly from prompt context.

### Tool Refresh (`voiceToolCallInfra.ts`)

- `refreshRealtimeTools()` — rebuilds provider-safe tool definitions from the shared registry, then sends `session.update` if the tool hash changed (provider must support `updateTools`)
- Called at session start and during instruction refresh
- Runs only for `session.realtimeToolOwnership === "provider_native"` sessions. Full-brain transport sessions skip provider-native tool registration entirely.

## 6. Response Tracking

### `pendingResponse` (`VoicePendingResponse`)

Tracks the in-flight assistant response:

| Field | Purpose |
|---|---|
| `requestId` | Monotonic ID from `nextResponseRequestId` |
| `source` | Origin: `"user_turn"`, `"text_utterance"`, `"prompt_utterance"`, `"silent_retry"`, etc. |
| `requestedAt` | Timestamp of request |
| `audioReceivedAt` | First audio delta timestamp (0 until audio arrives) |
| `interruptionPolicy` | Who can interrupt this response |
| `trackedResponseId` | Provider-specific response ID |

### Response Lifecycle

1. `createTrackedAudioResponse()` — creates `pendingResponse`, triggers `syncAssistantOutputState("response_requested")`
2. Audio deltas arrive — `audioReceivedAt` set on first delta, triggers `syncAssistantOutputState("audio_delta")`
3. `handleResponseDone()` — response complete. If no audio was produced, triggers silent response recovery.
4. `clearPendingResponse()` — clears `pendingResponse`, triggers deferred action rechecks.

For provider-native realtime sessions, a single response can both speak and emit tool calls. When that happens, `handleResponseDone()` settles the finished spoken response without aborting the in-flight tool scope. The tool loop keeps its follow-up lease and can still issue the post-tool `response.create` that asks a disambiguation question or confirms the action result.

### Silent Response Recovery

If a tracked response produces no audio within the watchdog timeout:

1. Retry up to `MAX_RESPONSE_SILENCE_RETRIES` via `createTrackedAudioResponse(source: "silent_retry")`
2. After retries exhausted, attempt hard recovery (commit pending input audio, create fresh response)
3. If hard recovery also fails, `clearPendingResponse` cascades to deferred action rechecks

### Stale Response Detection

`isStaleRealtimeResponseAt` detects when `realtimeClient.isResponseInProgress()` reports active but the session's `pendingResponse` has been cleared or is stale. `syncAssistantOutputState` runs this periodically and emits `openai_realtime_active_response_cleared_stale`.

## 7. Provider-Specific Protocol Notes

### OpenAI

Full Realtime API: `session.update`, `input_audio_buffer.append/commit`, `response.create/cancel`, `conversation.item.create/truncate`. Session updates send `session.type = "realtime"` with nested `audio.input` / `audio.output` descriptors plus `output_modalities`. Tracks `activeResponseId`/`activeResponseStatus` with terminal status detection.

### xAI

Similar protocol to OpenAI but simpler. Uses boolean `_responseInProgress` instead of response ID tracking.

### Gemini

Completely different protocol. Uses `setup` message at connection, then `realtimeInput` with `activityStart`/`activityEnd`/`mediaChunks`. `updateInstructions()` only stores locally (no mid-session WebSocket update). `cancelActiveResponse()` returns false (unsupported).

### ElevenLabs

Agent-based model. Uses signed URL auth (`fetchSignedUrl`). Audio sent as `user_audio_chunk`. `ping`/`pong` keepalive. Instructions sent only at connect time; no mid-session updates. `cancelActiveResponse()` returns false.

## 8. Cross-Domain Interactions (Client)

| Direction | Interaction | Mechanism |
|---|---|---|
| Capture → Client | Forward raw PCM (native path) | `realtimeClient.appendInputAudioPcm()` |
| Capture → Client | Forward labeled transcript (bridge path) | `realtimeClient.requestTextUtterance()` |
| Reply Pipeline → Client | Play pre-generated exact-line speech | `requestRealtimeTextUtterance()` → provider playback method (`requestPlaybackUtterance()`) |
| Client → Output SM | Audio delta, response lifecycle events | `syncAssistantOutputState()` |
| Client → Barge-In | Cancel active response | `realtimeClient.cancelActiveResponse()`, `realtimeClient.truncateConversationItem()` |
| Client → Tool Dispatch | Function call events | `handleRealtimeFunctionCallEvent()` |
| Client → Subprocess | Audio for Discord playback | `voxClient.appendTtsAudio()` |
| Instruction Mgr → Client | Updated instructions/tools | `realtimeClient.updateInstructions()`, `session.update` with tools |

Providers expose the same two logical text paths even when the wire protocol differs. Forwarded user transcripts use the normal conversation flow so the realtime brain can reason over conversation state and call tools. Exact-line playback for already-generated bot speech goes through `requestPlaybackUtterance()` so playback does not re-enter tool planning or duplicate upstream work. OpenAI implements that as an out-of-band audio response with tools disabled; xAI currently uses a constrained text turn on the normal response lane.

## 9. Incident Debugging (Client)

When the bot connects but produces no audio:

1. Check WebSocket state — is `realtimeClient.ws?.readyState` open?
2. Check `pendingResponse` — was a response created? Check `source` and `requestedAt`.
3. Check for `error_event` — the provider may have rejected the request.
4. Check silent response recovery — did the watchdog fire? How many retries?
5. Check stale response detection — `openai_realtime_active_response_cleared_stale` suggests a hung response.

When instructions/tools are stale:

1. Check `lastRealtimeInstructionsAt` — when was the last instruction refresh?
2. Check `lastRealtimeToolHash` — did the tool hash change detection work?
3. Check provider capabilities — Gemini/ElevenLabs don't support mid-session instruction updates.

## 10. Regression Tests (Client)

These cases should remain covered:

- Non-recoverable errors end the session
- Recoverable errors (`conversation_already_has_active_response`) do not end the session
- Silent response watchdog triggers retry after timeout
- Stale active response detection clears hung state
- Instruction refresh deduplication prevents concurrent updates
- Tool hash change detection avoids unnecessary `session.update` calls
- Barge-in cancels active response and truncates conversation item (OpenAI-specific)
- Session teardown closes WebSocket with 1.5s terminate fallback

Current coverage:

- `src/voice/voiceSessionManager.lifecycle.test.ts` (integration scenarios)

---

## Part 2: Reply Orchestration

This part defines the reply orchestration subsystem — how admitted user turns are dispatched to the correct reply pipeline, how turns are deferred when the output channel is busy, and how barge-in hands interruption context into the next normal turn.

The orchestration layer handles infrastructure (queuing, output lock, deferred flush) — all conversational decisions (what to say, whether to speak, how to handle interrupted context) are owned by the generation model. See `AGENTS.md` — Agent Autonomy section.

## 11. Source of Truth (Reply Orchestration)

Reply orchestration state lives on the `VoiceSession`:

- `session.pendingRealtimeTurns: RealtimeQueuedTurn[]` — queue of finalized realtime turns awaiting processing
- `session.realtimeTurnDrainActive: boolean` — whether the drain loop is running
- `session.pendingFileAsrTurnsQueue: FileAsrQueuedTurn[]` — queue of file-ASR turns awaiting processing
- `session.fileAsrTurnDrainActive: boolean` — whether the file-ASR drain loop is running
- `session.deferredVoiceActions: Record<DeferredVoiceActionType, DeferredVoiceAction>` — deferred action queue (queued user turns only)

The `TurnProcessor` owns turn queueing and drain logic. The `DeferredActionQueue` owns deferred action scheduling and dispatch. The `VoiceSessionManager` owns the reply pipeline caller methods.

Code:

- `src/voice/turnProcessor.ts` — turn queueing, drain loops, `runRealtimeTurn`, `runFileAsrTurn`
- `src/voice/voiceReplyDecision.ts` — reply admission gate (`evaluateVoiceReplyDecision`)
- `src/voice/voiceReplyPipeline.ts` — unified reply pipeline
- `src/voice/deferredActionQueue.ts` — deferred action management
- `src/voice/replyManager.ts` — response tracking, output state sync, deferred trigger
- `src/voice/voiceSessionManager.ts` — pipeline caller methods, barge-in, supersede

## 12. Turn Queue Lifecycle

Turns enter the system via two queues and are drained serially:

### Realtime Turn Queue

```
captureManager.finalizeUserTurn()
  → turnProcessor.queueRealtimeTurn()
    → drain immediately unless another realtime turn is already pending/in flight
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

## 13. Reply Admission Gate

`evaluateVoiceReplyDecision()` in `voiceReplyDecision.ts` evaluates each turn against a deterministic gate sequence:

| Order | Gate | Result on Match |
|---|---|---|
| 1 | Missing transcript | deny |
| 2 | Pending command followup (music disambiguation) | allow |
| 3 | Output locked (not music-only) | deny (`"bot_turn_open"`, retry after 1400ms) |
| 4 | Owned tool followup by the same speaker | allow |
| 5 | Other-speaker cross-talk during owned tool followup | deny |
| 6 | Command-only + direct address | allow |
| 7 | Command-only + not addressed outside the latch window | deny |
| 8 | Music playing + wake latch inactive | deny |
| 9 | Native realtime path | allow (`"native_realtime"`) |
| 10 | Text/full-brain path with `generation_decides` | allow |
| 11 | Text/full-brain path with `classifier_gate` | classifier YES/NO |

Direct address feeds classifier/generation context and arms the music wake latch when music is active. Eagerness `0` still flows through the admission prompt and classifier/generation outcome rather than acting as a standalone deny.

For bridge path turns that survive deterministic gates, `runVoiceReplyClassifier()` makes a YES/NO LLM call when the canonical admission mode is `classifier_gate`. The classifier token budget is provider-aware: OpenAI Responses bindings use at least `16` output tokens, and the GPT-5 family uses `64`, because smaller caps are rejected by the API.

## 14. Reply Dispatch (Three Mutually Exclusive Paths)

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

In realtime sessions, this path can still deliver speech through the realtime client even when settings-level `voice.conversationPolicy.replyPath` is `"brain"`. Here `mode: "realtime_transport"` means "use realtime output transport for pre-generated text", not "use the transcript-to-realtime bridge path above". On OpenAI, these exact-line playback requests are sent out-of-band with tools disabled so pre-generated speech cannot start a second provider tool/reasoning loop.

When Brain is paired with Realtime TTS and reply streaming is enabled, this
path can request speech incrementally from streamed generation chunks instead of
waiting for whole-reply playback. Streamed chunks still pass through the ordered
voice playback planner, so inline `[[SOUNDBOARD:<sound_ref>]]` directives can
land as `speech -> soundboard -> speech` beats without a second model turn.
Queued streamed utterances also respect local `clankvox` playback backlog
before they are handed to realtime TTS. The session keeps a higher-level text
queue for streamed chunks, pauses that queue once buffered TTS crosses roughly
3 seconds, and resumes draining once backlog falls back to roughly 1.5 seconds.
This keeps streaming responsive without letting raw PCM backlog grow until the
Rust subprocess has to drop old audio.
See [`voice-provider-abstraction.md`](voice-provider-abstraction.md).

## 15. Deferred Turn System

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

Active promoted captures block deferred turn flushing. `hasDeferredTurnBlockingActiveCapture` checks `session.userCaptures` for promoted captures with confirmed live speech. This prevents the bot from replying to a deferred turn while someone is still speaking.

Silence-only captures (very weak signal, never promoted) do NOT block deferred turn flushing.

## 16. Barge-In Recovery (Prompt-Driven)

When barge-in interrupts bot speech:

### Phase 1: Interrupt

`executeBargeInInterruptCommand`:
1. Cancel active realtime response
2. Reset bot audio playback
3. If cancel succeeded AND utterance text was in progress:
   - Store interruption context on the session: interrupted utterance text, interrupting user ID, timestamp, source
4. If cancel failed because the provider had already completed:
   - Do not create recovery state
   - Fall back to the short echo guard only
5. Set barge-in suppression window

### Phase 2: Normal Turn Processing

When the interrupting user's next turn reaches the normal voice pipeline:
1. `buildVoiceConversationContext` attaches `interruptedAssistantReply` if:
   - It is the same user who interrupted
   - The interruption is still recent
   - No newer assistant reply has happened since
2. `buildVoiceTurnPrompt` includes:
   - What the bot was saying when interrupted
   - Who interrupted
   - What they said now
3. The generation model decides whether to resume, adapt, or drop the interrupted reply.

Deferred actions are only for queued user turns waiting on output availability. There is no deferred `"interrupted_reply"` action or auto-retry path.

## 17. Generation Supersede Guard (3-Stage)

Three layers prevent the bot from generating or speaking replies to stale input. This handles cases where the user finishes a sentence then corrects themselves ("play Drake... actually no play Kendrick").

For the related problem of mid-sentence cutoff at the 8s `max_duration` cap, see [`voice-capture-and-asr-pipeline.md` §7 (max_duration as Chunking)](voice-capture-and-asr-pipeline.md).

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

The plumbing exists and is ready to wire for voice:

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

## 18. Cross-Domain State Reads (Reply Orchestration)

| Subsystem | State Read | Purpose |
|---|---|---|
| **Assistant Output** | `assistantOutput.phase`, `buildReplyOutputLockState()` | Output lock check: is the channel busy? |
| **Capture Manager** | `session.userCaptures`, `hasDeferredTurnBlockingActiveCapture()` | Are active captures blocking deferred turn flushing? |
| **Music** | `getMusicPhase()`, `musicPhaseShouldLockOutput()`, `musicPhaseShouldForceCommandOnly()` | Music output lock, command-only mode during playback |
| **ASR** | `transcriptOverride`, `transcriptLogprobs` | Pre-computed transcript from ASR bridge |
| **Barge-In** | `isBargeInOutputSuppressed()` | Is outbound audio suppressed after barge-in? |
| **Engagement** | `lastDirectAddressAt`, `lastDirectAddressUserId`, `voiceCommandState` | Addressing and engagement context for admission |
| **Realtime Client** | `isResponseInProgress()`, `activeResponseId` | Stale response detection |
| **Tool Execution** | `realtimeToolCallExecutions.size` | Tool calls blocking output? |

## 19. Deferred Action Priority

When multiple deferred actions are pending, `recheckDeferredVoiceActions` processes them in priority order:

1. `"queued_user_turns"` — process backlogged user input once output is actually free

Each action has a `notBeforeAt` timestamp and an `expiresAt` deadline. `canFireDeferredAction` checks:
- Session active?
- Action expired? (if so, clear it)
- `notBeforeAt` in the future? (if so, reschedule timer)
- Output channel blocked? (if so, wait)

## 20. Incident Debugging (Reply Orchestration)

When a user turn is admitted but the bot doesn't reply:

1. Check which dispatch path was taken (native, bridge, brain reply)
2. For full-brain replies: check `runVoiceReplyPipeline` — did `generateVoiceTurn` produce content?
3. Check `pendingResponse` — was a tracked response created?
4. Check for supersede — was the reply abandoned for newer input?

When deferred turns never flush:

1. Check `deferredVoiceActions` — is the action present?
2. Check `getOutputChannelState().deferredBlockReason` — what's blocking? (`"output_locked"`, `"active_captures"`, `"barge_in_suppressed"`)
3. Check `expiresAt` — did the action expire before the output channel freed up?
4. Check `hasDeferredTurnBlockingActiveCapture` — is a weak/silent capture incorrectly blocking?

When post-barge-in recovery feels wrong:

1. Check `session.interruptedAssistantReply` — was context actually stored?
2. Check whether cancel really succeeded — failed cancel intentionally skips recovery context
3. Check whether a newer assistant reply cleared applicability (`lastAssistantReplyAt > interruptedAt`)
4. Inspect the generated prompt — did it include the interruption recovery section from `buildVoiceTurnPrompt`?

## 21. Regression Tests (Reply Orchestration)

These cases should remain covered:

- Denied turns with `"bot_turn_open"` reason are deferred, not dropped
- Deferred turns flush when `assistantOutput.phase` transitions to `idle`
- Active promoted captures block deferred turn flushing
- Silence-only captures do NOT block deferred turn flushing
- Coalesced deferred turns re-run the full admission gate
- Barge-in stores interruption context when cancel succeeds
- Prompt generation receives interruption recovery context on the interrupting user's next turn
- There is no deferred interrupted-reply auto-retry path
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
