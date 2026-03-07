# Voice Output State Machine

> Scope: assistant reply/output lifecycle after a voice turn has already been admitted.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Barge-in and echo policy: [`voice-interruption-policy.md`](voice-interruption-policy.md)
> Runtime log workflow: [`logs.md`](logs.md)

This document defines the canonical assistant output state machine for voice sessions.
The goal is to prevent stale "bot is still speaking" locks when OpenAI realtime,
the Bun session manager, and `clankvox` disagree about whether playback has actually
finished.

![Voice Assistant Output State](diagrams/voice-assistant-output-state.png)

<!-- source: docs/diagrams/voice-assistant-output-state.mmd -->

## 1. Source of Truth

The Bun `VoiceSession` owns the authoritative assistant output phase in
`assistantOutput`.

External systems do not own reply/output state:

- OpenAI realtime provides signals such as active response status, tool calls, and audio deltas.
- `clankvox` provides playback lifecycle signals such as `tts_playback_state` and `buffer_depth`.
- The session manager derives one canonical phase from those signals and uses that phase for output locking.

Code:

- `src/voice/assistantOutputState.ts`
- `src/voice/voiceSessionManager.ts`
- `src/voice/clankvoxClient.ts`
- `src/voice/clankvox/src/main.rs`

## 2. Phases

| Phase | Meaning | Canonical lock reason |
|---|---|---|
| `idle` | no reply is pending and no playback is active | `idle` |
| `response_pending` | a response is pending or OpenAI still reports an active response | `pending_response` or `openai_active_response` |
| `awaiting_tool_outputs` | tool calls are running and the reply cannot continue yet | `awaiting_tool_outputs` |
| `speaking_live` | realtime audio deltas are actively arriving | `bot_audio_live` |
| `speaking_buffered` | live deltas stopped, but `clankvox` still has buffered speech | `bot_audio_buffered` |

`music_playback_active` is **not** a phase in this state machine. Music playback is an orthogonal lock managed by `MusicPlaybackPhase`; it is composed with the assistant output phase at the `buildReplyOutputLockState` layer (`locked = musicActive || phase !== idle`).

Only one helper should translate these phases into reply output lock decisions:

- `buildReplyOutputLockState(...)` in `src/voice/assistantOutputState.ts`

## 3. Authoritative vs Heuristic Signals

| Signal | Role | Notes |
|---|---|---|
| `assistantOutput.phase` | authoritative | canonical output phase used for locking |
| `pendingResponse` | signal | contributes to `response_pending` |
| `realtimeClient.isResponseInProgress()` | signal | contributes to `response_pending`; can be stale and may need recovery |
| `clankvox tts_playback_state` | signal | authoritative subprocess playback hint while telemetry is fresh |
| `clankvox buffer_depth` | signal | authoritative buffered speech hint while telemetry is fresh |
| `botTurnOpen` | heuristic/guard | short echo and barge-in guard only; not the source of truth for output locks |
| `lastAudioDeltaAt` | heuristic | recency/latency hint only; not the source of truth for output locks |
| `playbackArmed` | bootstrap hint | subprocess readiness/join-greeting bootstrap; not part of the output phase model |

Freshness rule:

- positive `clankvox` buffered-playback telemetry is not durable truth forever
- if buffer-depth / playback-state updates stop arriving, stale positive TTS telemetry is treated as expired and the assistant output phase can return to `idle`
- this prevents missed final drain events from pinning `outputLockReason=bot_audio_buffered`

## 4. Transition Rules

| Event | From | To |
|---|---|---|
| reply requested | `idle` | `response_pending` |
| tool call emitted | `response_pending` | `awaiting_tool_outputs` |
| tool outputs submitted / follow-up requested | `awaiting_tool_outputs` | `response_pending` |
| request cancelled or session ends | `awaiting_tool_outputs` | `idle` |
| first audio delta arrives | `response_pending` | `speaking_live` |
| audio deltas stop but buffered speech remains | `speaking_live` | `speaking_buffered` |
| `clankvox` reports drained / idle | `speaking_buffered` | `idle` |
| silent response cleared | `response_pending` | `idle` |
| stale realtime active response recovered | `response_pending` | `idle` |
| barge-in or forced stop | `speaking_live` / `speaking_buffered` | `idle` |

## 5. Incident Debugging

When a turn is transcribed correctly but the bot does not answer:

1. Check `voice_turn_addressing`.
2. Treat top-level `reason="bot_turn_open"` as a coarse public label only.
3. Use `outputLockReason` as the real blocker.
4. Correlate with `openai_realtime_response_done`, `bot_audio_started`, and `openai_realtime_active_response_cleared_stale`.
5. If a deferred turn is queued, verify whether there is a real active capture or only a silence-only capture that should not block replay.

Interpretation:

- `outputLockReason=bot_audio_buffered`: `clankvox` still has queued speech or the last positive playback telemetry has not gone stale yet.
- `outputLockReason=pending_response`: Bun still has a pending reply.
- `outputLockReason=openai_active_response`: OpenAI realtime still reports an active response.
- `outputLockReason=awaiting_tool_outputs`: tool execution is the blocker.
- `outputLockReason=music_playback_active`: this is not a reply-output bug; music is intentionally locking output.

Deferred replay rule:

- queued user turns should wait for assertive live speech, not merely for the existence of a capture object
- silence-gated or near-silent captures should not keep deferred replay blocked once they are the only remaining captures

## 6. Regression Tests

These cases should remain covered:

- stale `botTurnOpen` should not lock output after playback ends
- stale OpenAI active response should be cleared once playback is idle
- explicit `clankvox` TTS lifecycle should move the phase between buffered and idle
- stale positive `clankvox` telemetry should not keep output locked indefinitely
- `response.done` before subprocess drain should still keep output locked until drain completes
- queued user turns should ignore silence-only active captures but still wait on unresolved live captures

Current coverage:

- `src/voice/assistantOutputState.test.ts`
- `src/voice/voiceSessionManager.lifecycle.test.ts`
