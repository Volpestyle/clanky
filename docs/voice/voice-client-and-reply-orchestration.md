# Voice Client and Reply Orchestration

> **Scope:** Realtime brain client lifecycle and reply dispatch — from WebSocket connection through turn queueing, admission gating, pipeline execution, deferred turns, and supersede logic.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Output and barge-in: [`voice-output-and-barge-in.md`](voice-output-and-barge-in.md)
> Capture and ASR: [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)
> Cross-cutting settings contract: [`../reference/settings.md`](../reference/settings.md)

---

## Part 1: Realtime Client

Persistence, preset inheritance, dashboard envelope shape, and save/version semantics live in [`../reference/settings.md`](../reference/settings.md). This document covers the runtime orchestration path and the voice-local settings that affect client lifecycle and reply dispatch.

This part defines the realtime transport lifecycle — how the bot connects to provider-native runtimes (OpenAI, xAI, Gemini) when they exist, and how full-brain runtimes like ElevenLabs still flow through the shared reply/orchestration surface. Tool execution and context assembly stay shared across providers; the client adapter only translates provider protocol into the common runtime surface.

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
- `src/voice/elevenLabsRealtimeClient.ts` — ElevenLabs WebSocket TTS streaming client
- `src/llm/audioService.ts` — provider-backed API TTS and file-turn transcription adapters
- `src/voice/realtimeClientCore.ts` — shared WebSocket utilities
- `src/voice/sessionLifecycle.ts` — event binding (`bindRealtimeHandlers`)
- `src/voice/voiceJoinFlow.ts` — client creation and session initialization
- `src/voice/instructionManager.ts` — instruction/tool refresh
- `src/voice/voiceMemoryContext.ts` — shared continuity + behavioral-memory loader for realtime and brain turns
- `src/voice/voiceTurnContext.ts` — shared prompt-facing live room snapshot builder
- `src/voice/voiceToolResultSummary.ts` — canonical compact tool-result summary formatter
- `src/voice/replyManager.ts` — response tracking, output state sync

## 2. Client Types and Capabilities

| Mode | Client Class | `textInput` | `updateInstructions` | `updateTools` | `cancelResponse` | `interrupt acceptance` | `perUserAsr` | `sharedAsr` |
|---|---|---|---|---|---|---|---|---|
| `openai_realtime` | `OpenAiRealtimeClient` | yes | yes | yes | yes | immediate provider ack | yes | yes |
| `voice_agent` | `XaiRealtimeClient` | yes | yes | yes | yes | immediate provider ack | yes | yes |
| `gemini_realtime` | `GeminiRealtimeClient` | yes | yes (local only) | — | — | local cut + async confirmation | — | yes |
| `elevenlabs_realtime` | `ElevenLabsRealtimeClient` | yes | — | — | — | local cut + async confirmation | — | yes |

Capability checks use `providerSupports(mode, capability)` in `src/voice/voiceModes.ts`.

For text-mediated sessions, the OpenAI ASR bridge still powers `bridge` mode and the optional bridge-style ASR lane in `brain` mode. ElevenLabs speech output is rendered through a persistent WebSocket connection to the ElevenLabs TTS streaming API (`/v1/text-to-speech/{voice_id}/stream-input`). Text chunks are sent as the brain LLM generates them, and audio chunks stream back for playback. ElevenLabs can also be selected for file-turn transcription on the full-brain path.

## 3. Lifecycle Phases

Provider-native realtime clients have a simpler lifecycle than the ASR bridge — there is **no automatic reconnection**. Fatal errors end the session.

| Phase | Meaning |
|---|---|
| `creating` | Client instantiated, WebSocket not yet opened |
| `connecting` | `client.connect()` called, WebSocket opening (10s timeout) |
| `connected` | WebSocket open, `session.update` sent, ready for audio/text |
| `closed` | WebSocket closed (1000 normal close or error). Session ends. |

### Creation (`voiceJoinFlow.ts`)

The runtime mode determines which client class is instantiated. The subprocess (`ClankvoxClient`) is spawned **in parallel** with the API connect call for latency optimization.

After a successful join, `voiceJoinFlow.ts` emits a synthetic `"[YOU joined the voice channel]"` runtime event through the same admission pipeline the bot uses for other room events. The classifier prompt treats that event as the bot's own arrival, so self-join greeting bias uses the explicit "you just joined" guidance instead of the generic "someone joined or left" branch.

Non-speech runtime events carry structured event context (`membership.join`, `membership.leave`, `screen_share.share_start`, etc.) alongside the readable transcript string. Prompt builders and classifiers branch on that structured context first; the transcript remains the human-readable surface for logs and history, not the source of truth.

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
| `transcript` | `onTranscript` | Log transcripts, record voice turns, and strip inline soundboard directives out of assistant output transcripts when compatibility fallback markup appears so stored speech text stays clean. | — |
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
- `prepareRealtimeTurnContext()` — loads the shared voice memory slice for the triggering user turn, caches it on the session, then refreshes instructions
- `queueRealtimeTurnContextRefresh()` — serialized async queue preventing concurrent refreshes

Refresh triggers: session start, music idle/error, voice membership changes, channel changes, turn context updates.

Realtime instruction refresh and full-brain generation now consume the same parity surfaces instead of assembling separate room snapshots:

- `loadSharedVoiceMemoryContext()` applies one continuity and behavioral-memory policy to both paths
- `buildSharedVoiceTurnContext()` builds one prompt-facing room snapshot for participant roster, membership/effect events, native sharers, screen-watch capability, stream-watch notes, compacted summary, music context, and recent tool outcomes
- the last loaded realtime memory slice is cached on `session.lastRealtimeMemorySlice` so later provider-native refreshes can reuse the same memory view until a newer turn context replaces it
- provider-native tool executions record the same compact structured tool summary shape that brain-path tool calls use, then schedule an instruction refresh so follow-up reasoning sees the result immediately

Music prompt context stays available while playback is idle when the session still has meaningful music state. Realtime instructions include the current/last known track, exact reusable `selection_id` values for current/last/queued tracks, queued tracks, last action, and last query so the model can reason about replay and queue followups directly from prompt context.
The shared live-music guidance is intentionally compact: the prompt includes one contextual quick-reaction hint when playback is still live without a handoff, plus one canonical `media_reply_handoff` capability rule in tooling policy. Both the full-brain voice prompt and realtime instruction refresh use that same wording so the model sees the playback semantics once per concern instead of repeated nudges in the same turn.

### Tool Refresh (`voiceToolCallInfra.ts`)

- `refreshRealtimeTools()` — rebuilds provider-safe tool definitions from the shared registry, then sends `session.update` if the tool hash changed (provider must support `updateTools`)
- Called at session start and during instruction refresh
- Runs only for `session.realtimeToolOwnership === "provider_native"` sessions. Full-brain transport sessions skip provider-native tool registration entirely.
- Provider-native tool completions also feed the shared structured result summary back into `session.toolCallEvents`, then request an instruction refresh so the provider-native model sees the same recent tool outcome trail that the brain path sees on its next turn

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

Completely different protocol. Uses `setup` message at connection, then `realtimeInput` with `activityStart`/`activityEnd`/`mediaChunks`. `updateInstructions()` only stores locally (no mid-session WebSocket update). `cancelActiveResponse()` returns false (unsupported immediate ack). Interrupt acceptance is `local_cut_async_confirmation`: the runtime can accept a locally committed cut immediately, and the client later emits `response_done` with `status: "interrupted"` when Gemini reports the turn was cut.

### ElevenLabs

TTS-only WebSocket client. Connects to `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` with model, output format, and API key as query/header params. First message initializes with `{ text: " ", voice_settings, generation_config }`. Subsequent text is sent as `{ text: "...", flush: true }` to trigger immediate audio generation. Server responds with `{ audio: "<base64>" }` chunks and `{ isFinal: true }` on completion. Audio input (ASR) is handled by a separate shared ASR bridge, not through the ElevenLabs WebSocket. No mid-session instruction or tool updates. `cancelActiveResponse()` returns false (mid-stream cancellation not supported). Interrupt acceptance is `local_cut_async_confirmation`.

## 8. Cross-Domain Interactions (Client)

| Direction | Interaction | Mechanism |
|---|---|---|
| Capture → Client | Forward raw PCM (native path) | `realtimeClient.appendInputAudioPcm()` |
| Capture → Client | Forward labeled transcript (bridge path) | `realtimeClient.requestTextUtterance()` |
| Reply Pipeline → Client | Play pre-generated exact-line speech | `requestRealtimeTextUtterance()` → provider playback method (`requestPlaybackUtterance()`) |
| Client → Output SM | Audio delta, response lifecycle events | `syncAssistantOutputState()` |
| Client → Barge-In | Attempt provider cut, then clear local playback/output state | `realtimeClient.cancelActiveResponse()`, `realtimeClient.truncateConversationItem()`, local playback reset |
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

The `TurnProcessor` owns turn queueing, transcript admission, addressing/logging, and dispatch for realtime turns, file-ASR turns, and deferred flushes. The `DeferredActionQueue` owns deferred action scheduling and dispatch. The `VoiceSessionManager` is the lifecycle host that exposes the runtime capabilities the turn processor calls into.

Code:

- `src/voice/turnProcessor.ts` — turn queueing, drain loops, shared post-transcript admission/dispatch, deferred flush execution
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
    → room-aware coalescing decision (see below)
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

### Room-Aware Turn Coalescing

When a turn finalizes and enters the queue, the system checks whether anyone else in the channel has an active capture (is currently speaking). This determines whether to drain immediately or hold:

| Condition | Behavior |
|---|---|
| No other active captures (room quiet) | Drain immediately — zero added latency |
| Other users still speaking | Hold turn in pending queue, wait for room to settle |
| Turn contains direct address (wake word) | Drain immediately regardless of other captures |
| Drain already active (processing prior turn) | Merge into pending queue entry (existing behavior) |

**Flush triggers** for held turns:

1. **Room went quiet** — when the last active capture finalizes (via `cleanupCapture`), any held turns flush together. This is the primary mechanism.
2. **Hard failsafe** — `REALTIME_TURN_COALESCE_WINDOW_MS` (10s) timeout prevents truly stuck turns if a capture never finalizes. Should never fire under normal operation since captures are capped at `CAPTURE_MAX_DURATION_MS` (8s) with idle/silence abort timers.

**`max_duration` exclusion**: when a capture finalizes due to hitting the 8s cap, the room-coalesce flush is *not* triggered. The user is still speaking; a new capture will start and eventually finalize with a real speech-end reason.

**Speaker-aware merging**: when turns from different speakers are merged during room coalescing, the `speakerTranscripts` array on `RealtimeQueuedTurn` preserves per-speaker attribution (`[{userId, transcript}]`). This flows through to conversation history recording (each speaker recorded separately) and provides the LLM with proper "who said what" context.

After capture/transcription, all three entry points converge on the same post-transcript helper in `turnProcessor.ts`:

- realtime turns after local/per-user ASR
- file-ASR turns after WAV transcription
- deferred bot-turn-open flushes after coalescing queued transcripts

That shared path performs the admission decision, addressing normalization, classifier snapshot logging, deferred requeue, and the final native-vs-bridge-vs-brain dispatch.

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
| 10 | Brain path after deterministic gates, generation-owned mode | allow (`"generation_decides"`) |
| 11 | Brain classifier mode after deterministic gates | classifier YES/NO |
| 12 | Bridge path after deterministic gates | classifier YES/NO |

Direct address feeds classifier/generation context and arms the music wake latch when music is active. Fresh wake-word turns pause active music immediately; while music is still `paused_wake_word`, ordinary follow-ups stay owned by that wake-word speaker. Once wake-word-paused music resumes after assistant playback drains, the renewed latch lets ordinary follow-ups continue without another wake word. The main reply brain still decides whether that admitted reply should be a quick line, a fuller answer, or silence. For ordinary replies spoken over already-playing music, the passive latch refreshes after assistant speech actually settles so the follow-up window is not consumed while buffered reply audio is still draining. Post-resume latch-open follow-ups snapshot that eligibility when the capture promotes, so a turn that started inside the window is still admitted even if finalization lands just after expiry. Those wake-word and latch-open conversational turns now go straight to the main reply brain. Same-speaker pending music-choice followups also stay in the ordinary reply path so the main brain can interpret the clarification against the active option list itself. If the dedicated music brain is enabled, it only sits in front of compact playback-control turns: exact single-word controls like `pause` or `skip` use an immediate fast path, and fuzzier control phrasing can still be consumed by the mini model with playback tools. If the dedicated music brain is disabled, even those control turns go straight to the main reply brain, which can ignore them with `[SKIP]`, answer normally, or use `media_reply_handoff` for temporary pause/duck floor control. That handoff is floor control, not a cue to monologue. In the shared attention model, this stage is the voice spoke's floor gate, not a separate conversational mind. Canonical music semantics live in [`music.md`](music.md). Eagerness `0` still flows through the admission prompt and classifier/generation outcome rather than acting as a standalone deny.

The live voice prompt now relies on deterministic direct-address and interruption context, not the older best-effort `"current speaker likely talking to"` hints derived from transcript history. Room-addressing guesses remain infrastructure metadata until reply-side addressing is produced explicitly.

For turns that survive deterministic gates, `runVoiceReplyClassifier()` runs whenever the effective admission mode resolves to classifier-first. `bridge` always resolves that way because it has no native `[SKIP]`. `brain` can opt into the same classifier-first cost gate with `classifier_gate`, while `generation_decides` keeps brain turns generation-owned. `native` stays generation-owned and does not use this text classifier path. The classifier token budget is provider-aware: OpenAI Responses bindings use at least `16` output tokens, and the GPT-5 family uses `64`, because smaller caps are rejected by the API.

## 14. Reply Dispatch (Three Mutually Exclusive Paths)

After admission, the shared turn processor dispatch helper chooses one of three mutually exclusive paths:

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

The unified pipeline: generate text via LLM, build playback plan, play via realtime TTS or API TTS. See [`voice-provider-abstraction.md`](voice-provider-abstraction.md) §3 for detailed stage description.

Before `generateVoiceTurn` runs, `voiceReplyPipeline.ts` now uses the same shared turn-context builder that realtime instruction refresh uses. Brain-path prompts therefore see the same normalized participant roster, native sharers, screen-watch capability, stream-watch notes, music state, compacted summary, and recent tool outcomes that provider-native realtime instructions see.

In realtime sessions, this path can still deliver speech through the realtime client even when settings-level `voice.conversationPolicy.replyPath` is `"brain"`. Here `mode: "realtime_transport"` means "use realtime output transport for pre-generated text", not "use the transcript-to-realtime bridge path above". On OpenAI, these exact-line playback requests are sent out-of-band with tools disabled so pre-generated speech cannot start a second provider tool/reasoning loop.

When Brain is paired with Realtime TTS and reply streaming is enabled, this
path can request speech incrementally from streamed generation chunks instead of
waiting for whole-reply playback. Streamed chunks still pass through the ordered
voice playback planner, so inline `[[SOUNDBOARD:<sound_ref>]]` directives can
land as `speech -> soundboard -> speech` beats without a second model turn. In
realtime mode those soundboard-bearing chunks act as strict output barriers:
earlier queued or buffered assistant audio must drain first, then the chunk's
ordered speech/soundboard steps run in sequence. Once the chunk's own speech
request has played, the follow-on soundboard beat is released by that request's
playback state rather than global tail flags such as `botTurnOpen`.
The chunker keeps the first streamed utterance sentence-coherent, waits for the
configured minimum completed sentences per chunk before normal dispatch
(`2` by default), and avoids shipping tiny post-first fragments as standalone
realtime playback turns. `maxBufferChars` and final flush still force output so
short endings and long run-ons do not hang behind the threshold forever.
This is a deliberate prosody tradeoff. The default brain-streaming path does
not optimize purely for the lowest possible first-byte latency. Realtime
exact-line playback turns each emitted chunk into its own spoken request, so
over-eager one-sentence or clause-sized dispatch can make the bot sound like it
is repeatedly restarting its thought instead of speaking one continuous idea. We
therefore bias the defaults toward a sentence-coherent first utterance and
fewer micro-turns, accepting some extra latency on slower model/tool loops in
exchange for more natural cadence.
Short follow-on leftovers are merged with adjacent speech before playback, so
the transport hears one continuous thought instead of a series of miniature
inference requests. OpenAI exact-line playback requests also carry
response-scoped verbatim speech instructions so session-level persona guidance
does not reinterpret a tiny playback turn as a fresh conversation. Once stream
generation ends, any still-queued streamed tail for that reply is collapsed
into one final playback turn before it reaches the realtime transport. Ordered
stream chunks that already expanded into `speech -> soundboard -> speech`
substeps are not collapsed, because their soundboard beats live in the ordered
playback plan rather than in the queued speech transport.

When this tradeoff is too expensive for a specific deployment, the preferred
escape hatch is a turn-local timeout fallback that relaxes chunking after a
latency budget is exceeded. The default product stance is not to globally drop
sentence coherence just to chase the fastest possible first audio.
Spoken brain replies also begin with a hidden leading audience directive,
`[[TO:SPEAKER]]`, `[[TO:ALL]]`, or `[[TO:<participant display name>]]`, which
the runtime strips before any speech is played. This lets the brain declare who
it is addressing before the first audio chunk without wrapping the whole stream
in JSON. That same target feeds assistant-turn metadata and the ordinary
interruption target in `"speaker"` mode. If the brain omits the audience
directive, the reply stays untargeted; the runtime does not backfill a target
from user-turn direct-address heuristics.

OpenAI provider-native realtime replies use a different transport. Because the
provider owns the speech stream, the runtime does not try to hide a `[[TO:...]]`
prefix inside native audio. Instead, once the final assistant audio transcript
lands, the runtime fires a second out-of-band `response.create` on the same
session with `conversation: "none"` and `output_modalities: ["text"]`. That
side-channel returns one token: `SPEAKER`, `ALL`, an exact participant display
name, or `UNKNOWN`. The result never becomes speech and never enters the
default conversation; it patches the latest assistant turn's addressing and the
live `"speaker"` interruption target slightly after speech begins. Native `bridge`
and `native` reply paths use this side-channel. Full-brain replies do not.
Queued streamed utterances also respect local `clankvox` playback backlog
before they are handed to realtime TTS. The session keeps a higher-level text
queue for streamed chunks, pauses that queue once buffered TTS crosses roughly
3 seconds, and resumes draining once backlog falls back to roughly 1.5 seconds.
Raw PCM now follows the same product rule: generated speech stays durable above
`clankvox`, and the Bun-side client only feeds a short live playback window
into the Rust subprocess. Interruption clears queued speech; ordinary backlog
does not.
`clankvox` still keeps its own bounded safety buffer, but that cap is a
subprocess guard rather than the normal place where speech-loss policy is made.
See [`voice-provider-abstraction.md`](voice-provider-abstraction.md).

## 15. Deferred Turn System

When a turn is denied with reason `"bot_turn_open"` (output channel busy), it is **deferred** rather than dropped.

Exception: a direct wake-word / bot-name turn can preempt the output lock instead of joining the deferred queue when the current interruption mode allows it. In practice:

- `"speaker"` mode still lets the addressed speaker talk over the reply normally
- that same mode also lets anyone interrupt with an explicit wake word / bot alias
- `"none"` mode keeps both ordinary talk-over and wake-word interruption disabled

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
5. Call the same shared post-transcript helper used by realtime and file-ASR turns
6. **Re-run the full admission gate** on the coalesced transcript
7. If denied again: re-queue
8. If allowed: dispatch to the correct pipeline (same mode-switching as normal turns)

### Capture Blocking

Active promoted captures block deferred turn flushing. `hasDeferredTurnBlockingActiveCapture` checks `session.userCaptures` for promoted captures with confirmed live speech. This prevents the bot from replying to a deferred turn while someone is still speaking.

Silence-only captures (very weak signal, never promoted) do NOT block deferred turn flushing.

## 16. Interruption Recovery (Prompt-Driven)

In realtime `bridge` and `brain` sessions that use the ASR bridge, interruption is a three-step orchestration flow:

### Phase 0: Transcript Burst Arbitration

While assistant speech is active:
1. Partial and final ASR transcripts from non-target speakers are coalesced into a short overlap burst, while the current reply target keeps the privileged same-speaker interrupt path.
2. Obvious takeover phrases can resolve the burst immediately to `INTERRUPT`.
3. Obvious laughter, backchannel, and other low-signal overlap can resolve the burst immediately to `IGNORE`.
4. Ambiguous overlap is sent once to the interrupt classifier (when enabled; otherwise defaults to `IGNORE`).
5. Finalized ASR bridge turns are staged while the decision is pending.
6. `INTERRUPT` flushes the staged turn into the normal pipeline after cutting current assistant output.
7. `IGNORE` drops the staged turn entirely. The room reacted, but nobody actually took the floor.

Low-signal overlap therefore never reaches the normal turn queue and never creates fake interruption context.

### Phase 1: Interrupt

`executeBargeInInterruptCommand`:
1. Attempt the provider-native cut path when the runtime supports it (`cancelActiveResponse()`, `truncateConversationItem()`)
2. Resolve the provider's interrupt acceptance mode:
   - `immediate_provider_ack` means the interrupt is accepted only when the provider acknowledges the cut immediately
   - `local_cut_async_confirmation` means the interrupt is accepted once local playback/output state is authoritatively cut, with the later provider event acting as confirmation
3. Reset bot audio playback and clear output-lock state locally
4. If `interruptAccepted` is true and utterance text was in progress:
   - Store interruption context on the session: interrupted utterance text, interrupting user ID, timestamp, source
5. If the provider gave no immediate ack but the runtime still accepted the local cut:
   - keep recovery state
   - mark confirmation as pending in runtime logs
   - still fall back to the short echo guard rather than the long cancel-confirmed suppression window
6. If truncate identified a live assistant output item:
   - Store that `item_id` in a short-lived ignored-output map on the session
   - Drop any later audio deltas or final output transcripts for that exact item
   - Allow newer assistant output items to play immediately
7. Set barge-in suppression window

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
  → if newer finalized input exists: skip generation, let newer turn process
```

This reuses the queued-turn inspection logic that stage 3 uses, but runs it before paying for an LLM call. Log: `voice_generation_superseded_pre_generation`.

### Stage 2: Abortable generation

Voice generation registers an active reply and passes an `AbortSignal` to the LLM call, enabling mid-generation cancellation when newer speech arrives.

The plumbing exists and is ready to wire for voice:

- `ActiveReplyRegistry.begin()` creates an `AbortController` per reply scope (`activeReplyRegistry.ts`)
- `llm.generate()` accepts a `signal` parameter and threads it to the service layer
- Text replies already use this path (`replyPipeline.ts`)

The active reply handle is created immediately after the generation-preflight supersede check and before the expensive prompt/context work begins. That closes the gap where a late same-utterance ASR revision could arrive after admission but before generation had anything abortable.

Generation prep is also bounded. Soundboard-candidate lookup, continuity/history loading, and behavioral-memory loading each have deterministic fallback deadlines, and a generation-only watchdog aborts any admitted turn that never escapes the pre-playback `generation_only` phase. Slow prep should degrade context quality, not wedge the room.

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

Same-utterance late ASR revisions are treated as replacements, not as brand-new stale work. When the turn processor aborts a pre-audio generation because a newer revision of the same bridge utterance arrived, the revised turn is replayed with a fresh reply-scope timestamp before it re-enters the queue. That keeps the stale-cutoff safety from cancelling the corrected replacement.

**Cleanup on abort:** Catch `AbortError`, log `voice_generation_aborted_superseded`, skip playback, let the newer turn proceed through the queue drain, and keep watchdog/timer cleanup nonfatal so the abort does not escape as a process-level crash.

### Stage 3: Pre-playback supersede

`maybeSupersedeRealtimeReplyBeforePlayback` runs before each speech playback step:

- Checks if newer finalized realtime turns are queued **from the same speaker the bot is replying to**
- Only the reply target can supersede a pending reply. Ambient chatter from other participants does not invalidate a response generated for a specific person. This mirrors the `"speaker"` barge-in policy: the person the bot is talking to owns the conversational context that the reply was generated against, so only they can invalidate it by saying something new.
- Queued turns are only counted as interrupting if they pass the PCM silence gate, a server-VAD speech confirmation check (when the ASR bridge was active), AND the speaker identity check. Non-speech audio like humming, coughing, or laughing does not supersede a pending reply. Speech from other participants is tracked for observability (`pendingOtherSpeakerQueueDepth`) but does not trigger supersede.
- If interrupting turns exist and no active/proposed output lease exists: abandon the stale reply (`completed: false`), let the newer content process
- If the pending reply carries `[[LEASE:ASSERTIVE]]` or `[[LEASE:ATOMIC]]`: keep the older reply for a short bounded pre-audio lease window until first audio starts

This is the final safety net for anything that slips through stages 1 and 2.

**`TO:ALL` and bot-initiated replies:** When `replyUserId` is null — for bot-initiated events (join greetings), system events, or `[[TO:ALL]]` replies where no single triggering user exists — supersede is disabled entirely via the queue check. The bot committed to saying something and will finish it. Direct-address / wake-word interrupts still work through the transcript interrupt path, so humans can always say "hey clanky stop" to cut a runaway `TO:ALL` reply. The agent should use `TO:ALL` judiciously — it's a strong commitment to hold the floor against all ambient chatter.

Raw live captures and pre-audio `speech_started` events do not steal the floor
by themselves. Before assistant audio starts, filler noise, backchannel, and
same-speaker half-starts are treated as non-turns unless they become a real
admitted newer turn. Once assistant audio is actually playing, the ordinary
interruption flow takes over.

The lease mechanism is intentionally narrow:

- it is model-requested metadata, not a hardcoded speech trigger
- pre-audio: it blocks supersede and output-lock interruption until first audio
- post-audio: it extends barge-in immunity so the reply's point can land (assertive: 2 s, atomic: 4 s from first audio), after which ordinary interruption policy takes over
- the runtime still owns the duration cap and release semantics

### Behavior summary

| Scenario | Stage | What happens |
|---|---|---|
| Reply target corrects before generation starts | 1 | Skip generation, let newer turn process |
| Reply target corrects during generation | 2 | Abort LLM call, skip playback |
| Reply target comments before first audio | 3 | No special hold; old reply only loses if a newer finalized turn from the same speaker is admitted |
| Reply target corrects after generation, before playback | 3 | Drop at playback gate |
| Other participant chats during generation | — | Not counted as interrupting; bot reply proceeds |
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
   - If not, inspect `voice_generation_prep_stage` and `voice_generation_watchdog_timeout` first. These distinguish prep fallback from a real generation failure.
3. Check `pendingResponse` — was a tracked response created?
4. Check for supersede — was the reply abandoned for newer input?

When deferred turns never flush:

1. Check `deferredVoiceActions` — is the action present?
2. Check `getOutputChannelState().deferredBlockReason` — what's blocking? (`"output_locked"`, `"active_captures"`, `"barge_in_suppressed"`)
3. Check `expiresAt` — did the action expire before the output channel freed up?
4. Check `hasDeferredTurnBlockingActiveCapture` — is a weak/silent capture incorrectly blocking?

When post-barge-in recovery feels wrong:

1. Check `session.interruptedAssistantReply` — was context actually stored?
2. Check the interrupt runtime log metadata, especially `interruptAcceptanceMode`, `interruptAccepted`, `responseCancelSucceeded`, `truncateSucceeded`, and `providerInterruptConfirmationPending`
3. Check whether a newer assistant reply cleared applicability (`lastAssistantReplyAt > interruptedAt`)
4. If the follow-up ASR was empty or unclear, inspect `voice_interrupt_unclear_turn_handoff_requested` and `voice_interrupt_unclear_turn_handoff_skipped` — only a committed interrupt on that exact bridge utterance should hand interruption context back to the voice brain instead of replaying the cut line directly
5. Inspect the generated prompt — did it include the interruption recovery section from `buildVoiceTurnPrompt`?

## 21. Regression Tests (Reply Orchestration)

These cases should remain covered:

- Denied turns with `"bot_turn_open"` reason are deferred, not dropped
- Deferred turns flush when `assistantOutput.phase` transitions to `idle`
- Active promoted captures block deferred turn flushing
- Silence-only captures do NOT block deferred turn flushing
- Coalesced deferred turns re-run the full admission gate
- Barge-in stores interruption context when `interruptAccepted` is true for both immediate-ack and async-confirmation providers
- Prompt generation receives interruption recovery context on the interrupting user's next turn
- Empty or unclear ASR after a committed barge-in on that exact bridge utterance hands interruption context back to the voice brain
- Pre-generation gate skips generation when newer finalized turn exists
- Aborted generation produces no playback and no conversation window entry
- Abort cleanup does not corrupt session state
- Pre-playback supersede (stage 3) abandons stale replies for newer input
- Pre-audio noise or same-speaker backchannel does not create a special hold path
- Silent response recovery retries and then hard-recovers
- Deferred action expiry clears stale actions

Current coverage:

- `src/voice/voiceSessionManager.lifecycle.test.ts` (integration scenarios)
- `src/voice/voiceToolCallMemory.test.ts` (memory tool execution)
