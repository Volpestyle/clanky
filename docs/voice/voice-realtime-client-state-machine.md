# Voice Realtime Client State Machine

> **Scope:** Realtime brain client lifecycle — WebSocket connection to the AI provider for audio generation, event handling, instruction/tool refresh.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Assistant output lifecycle: [`voice-output-state-machine.md`](voice-output-state-machine.md)
> Barge-in policy: [`barge-in.md`](barge-in.md)

This document defines the realtime client lifecycle — how the bot connects to the AI provider (OpenAI, xAI, Gemini, ElevenLabs) for voice generation, manages instructions and tools, and handles the event stream that drives the assistant output state machine. Tool execution and context assembly stay shared across providers; the client adapter only translates provider protocol into the common runtime surface.

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
| `transcript` | `onTranscript` | Log transcripts, record voice turns, trigger soundboard from output transcripts. | — |
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
- `prepareRealtimeTurnContext()` — builds memory slice (user facts, conversation history, web lookups, adaptive directives), then refreshes instructions
- `queueRealtimeTurnContextRefresh()` — serialized async queue preventing concurrent refreshes

Refresh triggers: session start, music idle/error, voice membership changes, channel changes, turn context updates.

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

### Silent Response Recovery

If a tracked response produces no audio within the watchdog timeout:

1. Retry up to `MAX_RESPONSE_SILENCE_RETRIES` via `createTrackedAudioResponse(source: "silent_retry")`
2. After retries exhausted, attempt hard recovery (commit pending input audio, create fresh response)
3. If hard recovery also fails, `clearPendingResponse` cascades to deferred action rechecks

### Stale Response Detection

`isStaleRealtimeResponseAt` detects when `realtimeClient.isResponseInProgress()` reports active but the session's `pendingResponse` has been cleared or is very old. `syncAssistantOutputState` runs this periodically and emits `openai_realtime_active_response_cleared_stale`.

## 7. Provider-Specific Protocol Notes

### OpenAI

Full Realtime API: `session.update`, `input_audio_buffer.append/commit`, `response.create/cancel`, `conversation.item.create/truncate`. Tracks `activeResponseId`/`activeResponseStatus` with terminal status detection.

### xAI

Similar protocol to OpenAI but simpler. Uses boolean `_responseInProgress` instead of response ID tracking.

### Gemini

Completely different protocol. Uses `setup` message at connection, then `realtimeInput` with `activityStart`/`activityEnd`/`mediaChunks`. `updateInstructions()` only stores locally (no mid-session WebSocket update). `cancelActiveResponse()` returns false (unsupported).

### ElevenLabs

Agent-based model. Uses signed URL auth (`fetchSignedUrl`). Audio sent as `user_audio_chunk`. `ping`/`pong` keepalive. Instructions sent only at connect time; no mid-session updates. `cancelActiveResponse()` returns false.

## 8. Cross-Domain Interactions

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

## 9. Incident Debugging

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

## 10. Regression Tests

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
