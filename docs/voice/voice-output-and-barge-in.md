# Voice Output and Barge-In

> **Scope:** Assistant reply/output lifecycle and barge-in interruption handling — output phase state machine, acoustic gating, interrupt execution, and post-interruption recovery.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Capture and ASR: [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)
> Reply orchestration: [`voice-client-and-reply-orchestration.md`](voice-client-and-reply-orchestration.md)
> Explicit cancel commands ("stop", "cancel"): [`cancel.md`](../cancel.md)

---

# Part 1: Output State Machine

This document defines the canonical assistant output state machine for voice sessions.
The goal is to prevent stale "bot is still speaking" locks when OpenAI realtime,
the Bun session manager, and `clankvox` disagree about whether playback has actually
finished.

![Voice Assistant Output State](../diagrams/voice-assistant-output-state.png)

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
| `botTurnOpen` | heuristic/guard | short echo and barge-in guard only |
| `lastAudioDeltaAt` | heuristic | recency/latency hint only |
| `playbackArmed` | bootstrap hint | subprocess readiness/join-greeting bootstrap |

Ground truth for output locks is `assistantOutput.phase` and `bot_audio_buffered`. The heuristic signals above are secondary guards.

Wake-word music handoff rule:

- if music was auto-paused because the user addressed the bot (`paused_wake_word`), auto-resume happens only after the assistant reply has actually drained from `clankvox`
- `response.done` is not sufficient on its own because realtime generation can finish while buffered TTS is still playing locally
- the handoff also waits for the short `botTurnOpen` guard to clear before resuming music
- wake-word pause and explicit music pause/resume preserve the existing music subprocess when it is still alive; resume should continue the current pipeline rather than rebuilding from the original URL
- when the music subprocess has already finished but `clankvox` still holds buffered music PCM, wake-word pause suppresses that local buffer instead of deleting it, and resume continues draining the preserved buffer from the current position
- `clankvox` intentionally caps music prefetch to a short live window so the subprocess stays close to Discord playback instead of racing an entire track into memory
- ducking is gain-only; duck/unduck lowers or restores music volume without pausing or restarting the track

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
- silence-gated or near-silent captures should not keep deferred turn flushing blocked once they are the only remaining captures

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

---

# Part 2: Barge-In System

## 7. Design Philosophy

Barge-in sits at the intersection of two concerns:

1. **Acoustic gating** — Is someone actually trying to talk over the bot, or is it echo/noise/breathing? This is deterministic. Humans don't reason about signal-to-noise ratios; neither should the model.

2. **Post-interruption recovery** — What does the bot do after being interrupted? This is a *conversational* decision. The agent should reason about it, not a state machine.

The system keeps acoustic detection fast and deterministic, but gives the agent ownership of what happens next.

## 8. Why We Handle Barge-In Ourselves

OpenAI's Realtime API has built-in interruption handling, but it only works when audio flows directly through OpenAI's channels (WebRTC or WebSocket with direct audio). Our bot routes audio through Discord:

- **Input:** User audio → Discord voice gateway → decoded locally → streamed to ASR as text → forwarded to the brain via `conversation.item.create`.
- **Output:** Brain generates audio → Rust subprocess (clankvox) → encoded to Opus → Discord voice.

OpenAI cannot see Discord playback position or control Discord output. So we implement barge-in manually.

## 9. Default Interruption Policy

**Default: `"speaker"`** — the person the bot is responding to can interrupt. Others cannot. If the reply is not tied to a specific user, interruption stays disabled.

| Mode | Effect |
|------|--------|
| `"speaker"` | Only the person the bot is talking to can interrupt (default) |
| `"anyone"` | Anyone in the channel can interrupt the bot |
| `"none"` | Nobody can interrupt the bot |

Setting: `voice.conversationPolicy.defaultInterruptionMode`

Rationale: A real person in a conversation can be interrupted by the person they're talking to. That's natural. But random bystanders cutting in mid-sentence is not — it's rude and disruptive in a group setting. `"speaker"` mirrors how human conversations work.

### Per-Utterance Override

Callers of `requestRealtimePromptUtterance()` can pass an explicit `interruptionPolicy` for specific utterances. Example: a session-ending goodbye that must complete, or a music error announcement.

```ts
{
  assertive: boolean;    // true = policy is active
  scope: "none" | "speaker" | "anyone";
  allowedUserId?: string;  // only relevant when scope = "speaker"
}
```

If no interruption policy resolves for an utterance, barge-in is disabled.

### Agent-Influenced Policy

The generation model can signal interruption preference as part of its output. For example, a brief casual remark could be freely interruptible, while a detailed explanation the user asked for should be harder to cut off. The infrastructure exists; model-side integration is pending.

## 10. Acoustic Gating

All acoustic gates are deterministic. The agent has no input here — this is signal processing, not conversation.

### Gate Sequence

```
User audio arrives during output lock
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 1. Pre-audio guard                                          │
│    Bot hasn't produced any audio yet for this response.     │
│    User can't interrupt something they haven't heard.       │
│    Gate: pendingResponse.audioReceivedAt > 0                │
└────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 2. Echo guard                                               │
│    Bot just started speaking (< 1.5s ago).                  │
│    Audio is likely the bot's own voice through user's mic.  │
│    Constant: BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS (1500ms)     │
└────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 3. Active flow guard                                        │
│    No live audio streaming AND bot turn not open.           │
│    Bot finished generating — subprocess is just draining    │
│    buffered frames. Response is effectively complete.       │
│    Barge-in would truncate a finished sentence.             │
└────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 4. Minimum speech duration                                  │
│    User must have sent ≥ 700ms of audio.                    │
│    Prevents micro-blips from triggering interruption.       │
│    Constant: BARGE_IN_MIN_SPEECH_MS (700ms)                 │
└────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 5. Signal assertiveness                                     │
│    Basic: activeSampleRatio > 0.01, peak > 0.012           │
│    During bot speech (stricter): peak ≥ 0.05,              │
│    activeSampleRatio ≥ 0.06                                │
│    Prevents breathing/noise from triggering interrupt.      │
└────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 6. Interruption policy check                                │
│    Is this user allowed to interrupt right now?             │
│    Resolves per-utterance override → session policy →       │
│    dashboard default.                                       │
└────────────────────────────────────────────────────────────┘
    │
    ▼  ALLOWED → execute interrupt
```

### Why Each Gate Exists

| Gate | Catches | Why Others Don't Cover It |
|------|---------|--------------------------|
| Pre-audio | User speaking during tool call / before TTS starts | Policy check would pass, but nothing to interrupt yet |
| Echo guard | Bot's own audio leaking through user mic | Signal assertiveness alone can't distinguish echo from speech in first 1.5s |
| Active flow | Subprocess draining last few buffered frames | Output lock still held, but response is done — interrupting wastes completed audio |
| Min speech | Micro Discord speaking events, mouth opens | Assertiveness thresholds alone can't catch sub-700ms blips |
| Signal assertiveness | Breathing, background noise, quiet TV | Duration alone isn't enough — 700ms of breathing shouldn't interrupt |
| Policy check | Users who aren't part of the current exchange | Acoustic gates are user-agnostic — policy adds social context |

## 11. Interrupt Execution

When all gates pass:

1. **Cancel generation** — `response.cancel` to OpenAI Realtime API.
2. **Truncate conversation** — `conversation.item.truncate` so API history only contains what was actually spoken.
3. **Stop subprocess playback** — `resetBotAudioPlayback()` stops clankvox TTS.
4. **Close bot turn** — `botTurnOpen = false`, clear reset timer.
5. **Unduck music** — Release any music volume ducking immediately.
6. **Post-cancel guard** — Check `responseCancelSucceeded`:
   - **Cancel succeeded:** Store interruption context (what was being said, who interrupted, when) on the session for the next turn's prompt.
   - **Cancel failed** (response already completed server-side): No suppression needed — the response finished and the bot is immediately available for the next turn.

### Event Loop Race

`response_done` (WebSocket) and user audio (IPC) are separate async sources. A user audio chunk can arrive before `response_done` clears `pendingResponse`. The active flow guard catches most of these; the post-cancel guard handles the rest.

## 12. Post-Interruption Recovery (LLM-Driven)

**This is where agent autonomy applies.** After a successful interrupt, the interrupted context is handed to the generation model for the next turn. The model decides what to do:

1. The interruption context is stored on the session:
   - What the bot was saying when interrupted (partial utterance text)
   - Who interrupted
   - When the interruption happened

2. When the interrupting user's turn is processed through the normal pipeline, the generation prompt includes this context:
   - *"You were interrupted while saying: '...' by [user]. They then said: '...'"*

3. The generation model decides what to do:
   - **Resume** — If the interruption was brief/accidental ("uh huh"), continue where it left off.
   - **Adapt** — If the user changed direction ("actually, play rock instead"), respond to the new request.
   - **Drop** — If the original response is no longer relevant, start fresh.

### Suppression Window

After a successful interrupt, barge-in is suppressed for **4 seconds**. This prevents:
- The bot's interrupted audio echoing back and re-triggering
- Rapid oscillation between interrupt → retry → interrupt

4 seconds is enough for the interrupted audio to drain and the echo to clear, without locking the user out of a second legitimate interruption.

## 13. Constants Reference

| Constant | Value | Purpose |
|----------|-------|---------|
| `BARGE_IN_MIN_SPEECH_MS` | 700ms | Minimum user audio to trigger interrupt |
| `BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS` | 1500ms | Grace period after bot TTS starts |
| `BARGE_IN_STT_MIN_CAPTURE_AGE_MS` | 500ms | Min capture age for non-realtime modes |
| `BARGE_IN_SUPPRESSION_MAX_MS` | 4000ms | Post-interrupt suppression window |
| `BARGE_IN_BOT_SPEAKING_PEAK_MIN` | 0.05 | Stricter peak threshold during bot speech |
| `BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN` | 0.06 | Stricter active ratio during bot speech |
| `VOICE_SILENCE_GATE_RMS_MAX` | 0.003 | Basic silence RMS threshold |
| `VOICE_SILENCE_GATE_PEAK_MAX` | 0.012 | Basic silence peak threshold |
| `VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX` | 0.01 | Basic silence active ratio threshold |

## 14. Implementation Files

| File | Role |
|------|------|
| `src/voice/bargeInController.ts` | Acoustic gate sequence, signal metrics, interrupt command builder |
| `src/voice/voiceSessionManager.ts` | Policy resolution, interrupt execution, suppression management |
| `src/voice/replyManager.ts` | Output lock state, buffer depth checks |
| `src/voice/captureManager.ts` | Audio capture, barge-in trigger on `userAudio` event |
| `src/voice/voiceSessionManager.constants.ts` | All timing constants |
| `src/settings/settingsSchema.ts` | `voice.conversationPolicy.defaultInterruptionMode` |

## 15. Noise Rejection Pipeline

Before a transcribed turn reaches the brain, it passes through a layered rejection pipeline in `runRealtimeTurn()` within `src/voice/turnProcessor.ts`. These gates are upstream of barge-in — they determine whether audio becomes a turn at all.

```
PCM audio arrives
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Silence Gate (PCM analysis, before ASR)               │
│    Drops near-silent PCM (mic blips, empty speaking      │
│    events). RMS ≤ 0.003, peak ≤ 0.012, active ratio     │
│    ≤ 0.01.                                               │
└─────────────────────────────────────────────────────────┘
    │
    ▼  ASR runs
    │
┌─────────────────────────────────────────────────────────┐
│ 2. Short Clip Skip (local ASR only)                      │
│    Drops micro clips < VOICE_TURN_MIN_ASR_CLIP_MS that  │
│    hallucinate transcript junk.                          │
└─────────────────────────────────────────────────────────┘
    │
┌─────────────────────────────────────────────────────────┐
│ 3. ASR Logprobs Confidence Gate (ASR bridge only)        │
│    Drops hallucinated text with mean logprob below       │
│    threshold (-1.0 ≈ 37% per-token confidence).         │
└─────────────────────────────────────────────────────────┘
    │
┌─────────────────────────────────────────────────────────┐
│ 4. Bridge Fallback Hallucination Guard                   │
│    Drops hallucinated text from local ASR that ran       │
│    because the bridge returned empty (race condition).   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
    Turn reaches the brain
```
