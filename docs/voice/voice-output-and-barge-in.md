# Voice Output and Barge-In

> **Scope:** Assistant reply/output lifecycle and barge-in interruption handling — output phase state machine, acoustic gating, interrupt execution, and post-interruption recovery.
> Voice pipeline stages: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Capture and ASR: [`voice-capture-and-asr-pipeline.md`](voice-capture-and-asr-pipeline.md)
> Reply orchestration: [`voice-client-and-reply-orchestration.md`](voice-client-and-reply-orchestration.md)
> Music behavior: [`music.md`](music.md)
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

Wake-word music handoff summary:

- `paused_wake_word` auto-resume waits for real playback drain and output-clear conditions, not just `response.done`
- while `paused_wake_word` is active, ordinary follow-ups stay scoped to the wake-word speaker who opened that pause
- after resume, wake-latch follow-ups return to the music decision layer rather than staying in a hardcoded pause path

Canonical music semantics and the pause/duck/latch diagram live in [`music.md`](music.md).

Freshness rule:

- positive `clankvox` buffered-playback telemetry is not durable truth forever
- locally queued TTS above `clankvox` still counts as buffered assistant output until it is played or explicitly interrupted
- if buffer-depth / playback-state updates stop arriving, stale positive TTS telemetry is treated as expired and the assistant output phase can return to `idle`
- this prevents missed final drain events from pinning `outputLockReason=bot_audio_buffered`

Telemetry note:

- `clankvox` still sends `buffer_depth` IPC samples on a periodic cadence while output buffers are non-empty so the Bun side can keep assistant output state fresh
- the raw `clankvox_buffer_depth` Rust log is `DEBUG` for periodic samples (`periodic_nonempty`, `periodic_drained`) and stays `INFO` for anomalous cases such as `audio_send_state_missing`

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
4. If you need the exact user wording in realtime bridge mode, correlate `voice_turn_addressing` with `openai_realtime_asr_final_segment`; the addressing log keeps transcript length, not duplicate transcript text.
5. Correlate with `openai_realtime_response_done`, `bot_audio_started`, and `openai_realtime_active_response_cleared_stale`.
6. If a deferred turn is queued, verify whether there is a real active capture or only a silence-only capture that should not block replay.

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

1. **Floor-taking detection** — Is someone actually trying to take the floor, or is the room just reacting? In ASR-bridge sessions this is decided from short transcript bursts, not raw overlap PCM alone.

2. **Post-interruption recovery** — What does the bot do after being interrupted? This is a *conversational* decision. The agent should reason about it, not a state machine.

The system keeps infrastructure decisions deterministic, but gives the agent ownership of what happens next once a real interrupt exists.

## 8. Why We Handle Barge-In Ourselves

OpenAI's Realtime API has built-in interruption handling, but it only works when audio flows directly through OpenAI's channels (WebRTC or WebSocket with direct audio). Our bot routes audio through Discord:

- **Input:** User audio → Discord voice gateway → decoded locally → streamed to ASR as text → forwarded to the brain via `conversation.item.create`.
- **Output:** Brain generates audio → Rust subprocess (clankvox) → encoded to Opus → Discord voice.

OpenAI cannot see Discord playback position or control Discord output. So we implement barge-in manually.

## 9. Default Interruption Policy

**Default: `"speaker"`** — the person the bot is responding to can interrupt. Others cannot through plain talk-over. A direct wake-word / bot-name turn can still cut in.

| Mode | Effect |
|------|--------|
| `"speaker"` | Ordinary talk-over is bound to the assistant reply target. If the reply targets one participant, only that person can interrupt. If the reply targets `ALL` or the target cannot be resolved, ordinary talk-over stays closed. A wake-word / bot-name turn from anyone can still interrupt. |
| `"anyone"` | Anyone in the channel can interrupt the bot. Wake-word / bot-name turns also interrupt. |
| `"none"` | Nobody can interrupt the bot, including wake-word / bot-name turns. |

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

The same rule applies before playback starts. A promoted live capture only
supersedes preplay generation when that user is already allowed by the
reply's interruption policy. Untargeted join greetings, optional system speech,
and other replies with no resolved speaker stay protected from random channel
noise until a real authorized interruption exists.

### Wake-Word Override During Output Lock

Wake-word interruption is a transcript-level override, separate from the fast acoustic barge-in gate:

- if a finalized turn comes from the user currently allowed by the active interruption policy, it may also cut through `bot_turn_open` without repeating the bot name
- if a finalized turn is directly addressed to the bot by wake word / bot alias, it may cut through `bot_turn_open`
- in `"speaker"` mode this lets non-speakers say the bot's name to interrupt
- in `"none"` mode the override stays disabled

This is intentionally narrower than full `"anyone"` talk-over. In `"speaker"` mode, the current reply target can interrupt with an ordinary finalized follow-up, while a non-speaker still needs an actual wake-word turn.

### Agent-Influenced Policy

Full-brain spoken replies declare who they target inline with the hidden
`[[TO:...]]` audience directive before speech playback begins. OpenAI
provider-native realtime replies resolve the same target through a parallel,
text-only out-of-band response on the same session shortly after the final
assistant audio transcript lands. In `"speaker"` mode, that assistant-side
target becomes the ordinary talk-over target:

- target = one participant → that person can interrupt through ordinary talk-over
- target = `ALL` → ordinary talk-over stays closed
- target missing or unresolved → ordinary talk-over stays closed

When full-brain reply streaming is enabled, the stream parser resolves that
leading `[[TO:...]]` directive before the first spoken chunk is dispatched, so
the very first realtime utterance already carries the correct interruption
policy.

OpenAI provider-native replies still start with the provisional reply-owner
policy so speech is not delayed; once the side-channel target resolves, the
active interruption policy is patched to the real assistant target. Wake-word /
bot-name interruption remains a separate transcript-level override in
`"speaker"` mode, so anyone can still cut in by explicitly addressing the bot.
Finer model-driven interruptibility preferences beyond reply targeting are
still future work.

### ASR-Bridge Transcript Bursts

When a realtime `bridge` or `brain` session is using the OpenAI ASR bridge, live overlap audio no longer hard-cuts playback by itself. The runtime first asks whether the room is actually taking the floor.

Flow while assistant speech is active:

1. A non-empty partial or final ASR transcript from an authorized speaker opens an overlap burst.
2. Later transcript updates replace the latest text for that utterance while the burst stays open.
3. The burst closes on either:
   - a short quiet gap (`VOICE_INTERRUPT_BURST_QUIET_GAP_MS = 360ms`)
   - the max burst window (`VOICE_INTERRUPT_BURST_MAX_MS = 1500ms`)
4. Resolution order:
   - obvious takeover text like `wait`, `hold on`, `stop`, or explicit cancel intent interrupts immediately
   - obvious low-signal text like laughter, backchannel, and tiny acknowledgements is ignored immediately
   - ambiguous short overlap is sent once to the dedicated interrupt classifier, which must answer `INTERRUPT` or `IGNORE`
5. While the decision is pending, finalized ASR turns for that utterance are staged instead of being forwarded to the normal turn queue.
6. If the burst resolves to `INTERRUPT`, the runtime executes the normal output-lock interrupt, stores interruption context if the reply was actually cut, and flushes the staged turn into the normal pipeline.
7. If the burst resolves to `IGNORE`, the staged turn is dropped and no interrupt is recorded. Filler, laughter, and room noise do not become user turns.

The interrupt classifier binding comes from `agentStack.overrides.voiceInterruptClassifier` and is exposed in the dashboard as the voice-mode "Interrupt classifier" provider/model controls. If no dedicated override exists, it falls back to the preset interrupt classifier, then the admission classifier, then the orchestrator.

## 10. Acoustic Gating
All acoustic gates are deterministic. The agent has no input here. In ASR-bridge sessions, these gates still control capture promotion, echo guards, and whether audio is worth transcribing, but transcript bursts own the actual floor-transfer decision. Raw acoustic barge-in remains the direct interrupt path for sessions that are not using transcript-overlap interrupts.

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
│    Buffered subprocess drain still counts as audible output │
│    even after the provider response has already settled.    │
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
│ 3. Output-present guard                                     │
│    No live audio streaming, no open bot turn, and no        │
│    buffered TTS playback.                                   │
│    There is nothing audible left to interrupt.              │
│    Buffered subprocess playback still counts as live        │
│    interruptible assistant output.                          │
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
| Output-present | Pre-audio / stale-lock states with no remaining speech | Output lock alone is not enough — the user needs audible assistant output to interrupt |
| Min speech | Micro Discord speaking events, mouth opens | Assertiveness thresholds alone can't catch sub-700ms blips |
| Signal assertiveness | Breathing, background noise, quiet TV | Duration alone isn't enough — 700ms of breathing shouldn't interrupt |
| Local-only promotion confirmation | Strong local audio that looks interrupt-worthy before Realtime VAD has confirmed speech | Local fallback keeps capture responsive, but live assistant playback should wait for speech confirmation before cutting out |
| Policy check | Users who aren't part of the current exchange | Acoustic gates are user-agnostic — policy adds social context |

Local-only promotion rule:

- `strong_local_audio` can promote a capture before Realtime VAD confirms speech so the turn can keep collecting audio immediately
- that local-only promotion still warms ASR state, but it does not supersede preplay reply generation until Realtime VAD confirms the same utterance
- while assistant audio is already playing, barge-in stays blocked for that capture until Realtime VAD confirms the same utterance
- once the utterance is VAD-confirmed, ordinary interruption policy applies to the already-live capture

## 11. Interrupt Execution

When a realtime interrupt is committed, either from the direct acoustic path or from a transcript-overlap burst that resolved to `INTERRUPT`:

1. **Cancel generation** — `response.cancel` to OpenAI Realtime API.
2. **Truncate conversation** — `conversation.item.truncate` so API history only contains what was actually spoken.
3. **Clear queued utterances** — Pending realtime assistant chunks are dropped so old speech cannot resume after the cut.
4. **Stop subprocess playback** — `resetBotAudioPlayback()` stops clankvox TTS and clears buffered playback telemetry.
5. **Close bot turn** — `botTurnOpen = false`, clear reset timer.
6. **Unduck music** — Release any music volume ducking immediately.
7. **Interruption context guard** — Check whether the live reply was actually cut:
   - **`response.cancel` succeeded:** Store interruption context (what was being said, who interrupted, when) on the session for the next turn's prompt.
   - **`conversation.item.truncate` succeeded but `response.cancel` did not:** Still store interruption context. The spoken reply was cut and is recoverable even if the provider reports the response as already finished server-side.
   - **Neither cancel nor truncate succeeded:** Do not create interruption recovery state.
8. **Suppression guard** — Keep the long post-barge-in suppression window only when `response.cancel` succeeded. Truncate-only cuts still fall back to the short echo guard.
9. **Interrupted item quarantine** — When `conversation.item.truncate` names a live output item, stash that `item_id` on the session. Any later audio deltas or final assistant transcripts for that exact item are dropped until the short quarantine TTL expires, so already-cancelled speech cannot leak back into local playback or transcript history.

### Event Loop Race

`response_done` (WebSocket) and user audio (IPC) are separate async sources. A user audio chunk can arrive before `response_done` clears `pendingResponse`. The pre-audio and output-present guards catch the "nothing audible left" cases; the post-cancel guard handles the rest.

Late provider chunks for the just-truncated output item are handled separately from barge-in suppression. The runtime drops those stale chunks by exact `item_id`, so the next legitimate reply can start immediately without replaying the cancelled tail.

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

If the interrupting capture later finalizes with an empty ASR result, the runtime does not synthesize a fake user turn. It directly replays the interrupted assistant line with `requestRealtimeTextUtterance(...)`. Empty post-barge-in audio is treated as nonverbal noise or abandonment, not as a new conversational input.

Low-signal overlap that resolves to `IGNORE` never reaches this recovery path, because the runtime never commits a real interrupt in the first place.

### Suppression Window

After a successful **acoustic barge-in**, barge-in is suppressed for **4 seconds**. This prevents:
- The bot's interrupted audio echoing back and re-triggering
- Rapid oscillation between interrupt → retry → interrupt

4 seconds is enough for the interrupted audio to drain and the echo to clear, without locking the user out of a second legitimate interruption.

Wake-word / bot-name output-lock interrupts do **not** use this suppression window. Those happen after the turn transcript is already finalized, so the bot can cut over and answer immediately.

## 13. Constants Reference

| Constant | Value | Purpose |
|----------|-------|---------|
| `BARGE_IN_MIN_SPEECH_MS` | 700ms | Minimum user audio to trigger interrupt |
| `BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS` | 1500ms | Grace period after bot TTS starts |
| `BARGE_IN_STT_MIN_CAPTURE_AGE_MS` | 500ms | Min capture age for non-realtime modes |
| `BARGE_IN_SUPPRESSION_MAX_MS` | 4000ms | Post-interrupt suppression window |
| `VOICE_INTERRUPT_BURST_QUIET_GAP_MS` | 360ms | Quiet-gap close for overlap bursts |
| `VOICE_INTERRUPT_BURST_MAX_MS` | 1500ms | Max coalescing window for overlap bursts |
| `VOICE_INTERRUPT_DECISION_TTL_MS` | 30000ms | TTL for recent overlap decisions and staged turn bookkeeping |
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
| `src/voice/voiceInterruptClassifier.ts` | Transcript-burst heuristics and `INTERRUPT` / `IGNORE` classifier call |
| `src/voice/replyManager.ts` | Output lock state, buffer depth checks |
| `src/voice/captureManager.ts` | Audio capture, promotion, and live barge-in gating fallback on `userAudio` |
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
