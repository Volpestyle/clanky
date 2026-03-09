# Barge-In System

> **Scope:** How the bot handles being interrupted in voice, and what happens after.
> Related: [`voice-output-state-machine.md`](voice-output-state-machine.md) · [`voice-reply-orchestration-state-machine.md`](voice-reply-orchestration-state-machine.md) · [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Explicit cancel commands ("stop", "cancel"): [`cancel.md`](../cancel.md)

## Design Philosophy

Barge-in sits at the intersection of two concerns:

1. **Acoustic gating** — Is someone actually trying to talk over the bot, or is it echo/noise/breathing? This is deterministic. Humans don't reason about signal-to-noise ratios; neither should the model.

2. **Post-interruption recovery** — What does the bot do after being interrupted? This is a *conversational* decision. The agent should reason about it, not a state machine.

The system keeps acoustic detection fast and deterministic, but gives the agent ownership of what happens next.

## Why We Handle Barge-In Ourselves

OpenAI's Realtime API has built-in interruption handling, but it only works when audio flows directly through OpenAI's channels (WebRTC or WebSocket with direct audio). Our bot routes audio through Discord:

- **Input:** User audio → Discord voice gateway → decoded locally → streamed to ASR as text → forwarded to the brain via `conversation.item.create`.
- **Output:** Brain generates audio → Rust subprocess (clankvox) → encoded to Opus → Discord voice.

OpenAI cannot see Discord playback position or control Discord output. So we implement barge-in manually.

## Default Interruption Policy

**Default: `"speaker"`** — the person the bot is responding to can interrupt. Others cannot.

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
  assertive: boolean;    // true = policy is active (false/null = anyone can interrupt)
  scope: "none" | "speaker";
  allowedUserId?: string;  // only relevant when scope = "speaker"
}
```

### Agent-Influenced Policy

The generation model can signal interruption preference as part of its output. For example, a brief casual remark could be freely interruptible, while a detailed explanation the user asked for should be harder to cut off. The infrastructure exists; model-side integration is pending.

## Acoustic Gating

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

## Interrupt Execution

When all gates pass:

1. **Cancel generation** — `response.cancel` to OpenAI Realtime API.
2. **Truncate conversation** — `conversation.item.truncate` so API history only contains what was actually spoken.
3. **Stop subprocess playback** — `resetBotAudioPlayback()` stops clankvox TTS.
4. **Close bot turn** — `botTurnOpen = false`, clear reset timer.
5. **Unduck music** — Release any music volume ducking immediately.
6. **Post-cancel guard** — Check `responseCancelSucceeded`:
   - **Cancel succeeded:** Store interruption context (what was being said, who interrupted, when) on the session for the next turn's prompt.
   - **Cancel failed** (response already completed server-side): Set short echo-guard suppression (1.5s). No recovery needed — the response finished.

### Event Loop Race

`response_done` (WebSocket) and user audio (IPC) are separate async sources. A user audio chunk can arrive before `response_done` clears `pendingResponse`. The active flow guard catches most of these; the post-cancel guard handles the rest.

## Post-Interruption Recovery (LLM-Driven)

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

After a failed cancel (response already done): **1.5 seconds** echo guard only.

## Constants Reference

| Constant | Value | Purpose |
|----------|-------|---------|
| `BARGE_IN_MIN_SPEECH_MS` | 700ms | Minimum user audio to trigger interrupt |
| `BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS` | 1500ms | Grace period after bot TTS starts |
| `BARGE_IN_STT_MIN_CAPTURE_AGE_MS` | 500ms | Min capture age for non-realtime modes |
| `BARGE_IN_SUPPRESSION_MAX_MS` | 4000ms | Post-interrupt suppression window |
| `BARGE_IN_BOT_SPEAKING_PEAK_MIN` | 0.05 | Stricter peak threshold during bot speech |
| `BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN` | 0.06 | Stricter active ratio during bot speech |
| `VOICE_SILENCE_GATE_PEAK_MAX` | 0.012 | Basic silence peak threshold |
| `VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX` | 0.01 | Basic silence active ratio threshold |

## Implementation Files

| File | Role |
|------|------|
| `src/voice/bargeInController.ts` | Acoustic gate sequence, signal metrics, interrupt command builder |
| `src/voice/voiceSessionManager.ts` | Policy resolution, interrupt execution, suppression management |
| `src/voice/replyManager.ts` | Output lock state, buffer depth checks |
| `src/voice/captureManager.ts` | Audio capture, barge-in trigger on `userAudio` event |
| `src/voice/voiceSessionManager.constants.ts` | All timing constants |
| `src/settings/settingsSchema.ts` | `voice.conversationPolicy.defaultInterruptionMode` |

## Noise Rejection Pipeline

Before a transcribed turn reaches the brain, it passes through a layered rejection pipeline in `runRealtimeTurn()` within `src/voice/turnProcessor.ts`. These gates are upstream of barge-in — they determine whether audio becomes a turn at all.

```
PCM audio arrives
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Silence Gate (PCM analysis, before ASR)               │
│    Drops near-silent PCM (mic blips, empty speaking      │
│    events). RMS, peak, active sample ratio.              │
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
