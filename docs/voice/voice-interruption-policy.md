# Voice Interruption Policy

> **Scope:** Voice barge-in rules and noise rejection gates — can this user interrupt right now, and should this audio reach the brain.
> Operator-facing activity paths and setting map: [`clanker-activity.md`](../clanker-activity.md)
> Voice pipeline stages, providers, and per-stage settings: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)

Controls whether users can barge-in (interrupt) the bot while it is speaking.

## Dashboard Setting

The **single authority** for interruption policy is `voice.conversationPolicy.defaultInterruptionMode`:

| Mode | Effect |
|------|--------|
| `"anyone"` | Anyone can interrupt the bot (default) |
| `"speaker"` | Only the person the bot is talking to can interrupt |
| `"none"` | Nobody can interrupt the bot |

There are no per-reply overrides. The dashboard setting applies uniformly to all replies.

**Exception:** Callers of `requestRealtimePromptUtterance()` can pass an explicit `interruptionPolicy` object for specific utterances (e.g. music error announcements that must not be cut off). This is a per-utterance parameter, not an automatic override.

## Policy Object

```ts
{
  assertive: boolean;   // true = policy is active (false/null = anyone can interrupt)
  scope: "none" | "speaker";
  allowedUserId?: string; // only used when scope = "speaker"
}
```

## Decision Logic

`isUserAllowedToInterruptReply({ policy, userId })` in `src/voice/voiceSessionManager.ts`:

1. Policy is `null` or `assertive` is falsy → **anyone can interrupt**.
2. `scope === "none"` → **nobody can interrupt**.
3. `scope === "speaker"` → only `allowedUserId` can interrupt; everyone else is blocked.

## Policy Resolution

`resolveReplyInterruptionPolicy()` resolves the effective policy for a reply:

1. If an explicit policy is provided (e.g. from `requestRealtimePromptUtterance`), use it.
2. Otherwise, read the dashboard setting:
   - `"anyone"` → return `null` (no restriction)
   - `"speaker"` → return `{ assertive: true, scope: "speaker", allowedUserId }` using the current speaker's ID
   - `"none"` → return `{ assertive: true, scope: "none", allowedUserId: null }`

## Why We Handle Barge-In Ourselves

OpenAI's Realtime API has built-in interruption handling — when VAD detects user speech during a response, it cancels the response and auto-truncates unplayed audio. But this only works when audio flows directly through OpenAI's channels:

- **WebRTC**: Server manages the output audio buffer and knows playback position — auto-truncates on interruption.
- **WebSocket with direct audio**: Server VAD sees `input_audio_buffer` speech, cancels the in-progress response.

Our bot does not use OpenAI's media channel for the actual bot reply. Audio I/O goes through Discord, not OpenAI:

1. **Input**: User audio arrives as Opus packets from Discord's voice gateway → decoded/resampled locally → streamed to separate ASR sessions for transcription/VAD → forwarded to the brain as **text** via `conversation.item.create`.
2. **Output**: Brain generates audio → streamed to the Rust subprocess → encoded to Opus → sent to Discord voice.

OpenAI VAD does hear the user on the transcription websocket, but that ASR session is not the output-owning realtime response session. It can help confirm speech promotion and turn boundaries, but it still does not know what portion of the bot's Discord playback has been heard. It therefore cannot safely own interruption/truncation of Discord-side bot speech by itself.

So we implement barge-in manually via `shouldBargeIn()` → `interruptBotSpeechForBargeIn()`.

### Two Distinct Concerns

The system separates two questions:

1. **"Is the output channel busy?"** — `isBargeInInterruptTargetActive()` in `bargeInController.ts`. Checks whether the bot is occupying the audio channel (pending response, active generation, subprocess playing). This is the precondition. It relies on the canonical `assistantOutput.phase` defined in `docs/voice/voice-output-state-machine.md`.

2. **"Should we interrupt right now?"** — `shouldBargeIn()`. The output lock being held doesn't mean the user is interrupting. The bot might not have started speaking, might be draining cached frames from a completed response, or the user might have been talking before the response was created. These gates narrow the decision to match the actual intent: **the user is intentionally talking over active bot speech**.

### Gate Checks (`shouldBargeIn`)

```
User audio arrives during output lock
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Pre-audio guard                                          │
│    Condition: botTurnOpen=false AND botTurnOpenAt=0          │
│    Blocks unless pendingResponse.audioReceivedAt > 0         │
│    Why: User can't interrupt something they haven't heard.   │
│    Scenario: User speaking while waiting for tool call,      │
│    new response just created but no audio generated yet.     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Active flow guard                                         │
│    Condition: !isAudioActivelyFlowing AND !botTurnOpen        │
│    Blocks: always                                            │
│    Why: Bot finished generating audio, subprocess is just    │
│    draining buffered Opus frames. Response is effectively    │
│    complete — barge-in would truncate a finished sentence.   │
│    isAudioActivelyFlowing = audio delta within last 200ms.   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Echo guard                                                │
│    Condition: botTurnOpenAt > 0 AND age < 1500ms             │
│    Blocks: always                                            │
│    Why: Bot's own audio echoing through user's mic.          │
│    Constant: BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS (1500)        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Assertiveness check                                       │
│    Min capture: BARGE_IN_MIN_SPEECH_MS (700ms) of audio      │
│    Signal gate: isCaptureSignalAssertive (not near-silent)   │
│    Bot speaking: isCaptureSignalAssertiveDuringBotSpeech     │
│      peak ≥ 0.05, active ratio ≥ 0.06 (stricter)            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Interruption policy check                                 │
│    isUserAllowedToInterruptReply({ policy, userId })         │
│    See "Decision Logic" section above.                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼  ALLOWED → interruptBotSpeechForBargeIn()
```

### Interrupt Execution (`interruptBotSpeechForBargeIn`)

1. Sends `response.cancel` to the Realtime API to stop generation.
2. Sends `conversation.item.truncate` so the API's conversation history only contains what was actually spoken.
3. Calls `resetBotAudioPlayback()` to stop the subprocess audio player.
4. The canonical `assistantOutput.phase` will eventually transition to `idle` once the subprocess acknowledges the stop and telemetry drains.
5. Unducks music volume if it was reduced for bot speech.
6. **Post-cancel guard**: Checks `responseCancelSucceeded`. If the cancel failed (response already completed server-side due to event loop race), the interrupt only stops subprocess playback — it does NOT queue a retry utterance or set full suppression. This prevents phantom retries and audio suppression when the response was already done.
7. If cancel succeeded: queues a deferred `interrupted_reply` action and sets full barge-in suppression (`BARGE_IN_SUPPRESSION_MAX_MS`, 12s).
8. If cancel failed: sets short echo-guard suppression (`BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS`, 1.5s) only.

### Why the Event Loop Race Exists

The `response_done` WebSocket event and user audio IPC data are separate async event sources on the same event loop. If a user audio chunk arrives before the `response_done` handler clears `pendingResponse`, the output lock is still held and barge-in can fire on an already-completed response. The active flow guard (gate 2) catches most of these, and the post-cancel guard (step 6) handles any that slip through.

---

## `endSession(... announcement)` Note

There is a second, separate use of the word `announcement` in the voice codebase:

```ts
await manager.endSession({
  guildId: session.guildId,
  reason: "assistant_leave_directive",
  announcement: "wrapping up vc."
});
```

This is **not** a realtime spoken announcement object and it is **not** posted to Discord literally.

- `announcement: null` suppresses the session-end operational post entirely.
- Any other string becomes an `announcementHint` detail on the `voice_session_end` event.
- The text-channel message is then composed by the LLM from the event, reason, and details payload.
- Result: `"wrapping up vc."` means "generate a brief leaving-VC style message," not "send these exact words."

Relevant code paths:

- `src/voice/voiceSessionManager.ts` - forwards `announcementHint` to `sendOperationalMessage()` for `voice_session_end`
- `src/voice/voiceOperationalMessaging.ts` - applies operational-message verbosity/suppression rules
- `src/bot/voiceReplies.ts` - asks the LLM to generate the final user-facing text

---

## Noise Rejection Pipeline

Before a transcribed turn reaches the brain, it passes through a layered rejection pipeline in `runRealtimeTurn()` within `src/voice/turnProcessor.ts`. Each gate targets a different failure mode and operates on a specific code path. They are **not** redundant — removing any one gate leaves a class of bad input unfiltered.

### Gate Ordering (in execution order)

```
PCM audio arrives
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Silence Gate (PCM analysis)                          │
│    Path: all turns (before ASR)                         │
│    Signal: RMS, peak amplitude, active sample ratio     │
│    Drops: near-silent PCM (mic blips, Discord speaking  │
│           events with no actual audio)                  │
│    Log: voice_turn_dropped_silence_gate                 │
└─────────────────────────────────────────────────────────┘
    │
    ▼  ASR runs (either ASR bridge or local transcription)
    │
┌─────────────────────────────────────────────────────────┐
│ 2. Short Clip Skip                                      │
│    Path: local transcription (!hasTranscriptOverride)   │
│    Signal: PCM byte length < VOICE_TURN_MIN_ASR_CLIP_MS │
│    Drops: micro speaking_end clips that hallucinate     │
│    Log: realtime_turn_transcription_skipped_short_clip  │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 3. ASR Logprobs Confidence Gate                         │
│    Path: ASR bridge (hasTranscriptOverride = true)      │
│    Signal: mean logprob from OpenAI transcription       │
│    Threshold: VOICE_ASR_LOGPROB_CONFIDENCE_THRESHOLD    │
│              (-1.0 ≈ 37% per-token confidence)          │
│    Drops: hallucinated text from noise/breathing where  │
│           the ASR model produced text but was uncertain  │
│    Log: voice_turn_dropped_asr_low_confidence           │
│    Helper: computeAsrTranscriptConfidence()             │
│            in voiceDecisionRuntime.ts                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 4. ASR Bridge Fallback Hallucination Guard              │
│    Path: local transcription when ASR bridge was active │
│           but returned empty (!hasTranscriptOverride    │
│           && asrBridgeWasActive)                        │
│    Signal: silence metrics on short clips               │
│    Drops: hallucinated text from local ASR that ran     │
│           because the bridge commit race returned empty  │
│    Log: voice_turn_dropped_asr_bridge_fallback_         │
│         hallucination                                   │
└─────────────────────────────────────────────────────────┘
    │
    ▼
    Turn reaches the brain
```

### Why Each Gate Exists

| Gate | Code Path | What It Catches | Why Others Don't Cover It |
|------|-----------|-----------------|--------------------------|
| Silence gate | All | No-audio PCM blips | Runs before ASR — prevents wasting ASR calls |
| Short clip skip | Local ASR | Micro speaking_end clips | Content-agnostic; pure duration check |
| Logprobs confidence | ASR bridge | Hallucinated text with low model confidence | Silence gate already passed |
| Bridge fallback guard | Local ASR (bridge was active) | Hallucinations from bridge→local fallback race | Only fires when bridge returned empty and local ASR filled in |
