# Unified Stream Watch Pipeline

Status: proposed

References:
- [`docs/voice/screen-share-system.md`](../voice/screen-share-system.md)
- [`docs/voice/voice-client-and-reply-orchestration.md`](../voice/voice-client-and-reply-orchestration.md)
- `src/voice/voiceStreamWatch.ts` — frame ingestion, vision triage, commentary triggers
- `src/voice/voiceReplyPipeline.ts` — generation pipeline, frame/note injection
- `src/voice/clankvox/src/video_decoder.rs` — H264 decode, scene-cut metrics, change scores

## Problem

The screen watch system has two mutually exclusive modes (`direct` and `context_brain`) that each solve half the problem:

- **`context_brain`**: cheap vision model accumulates notes on a steady interval, but the main brain only fires on "high urgency" (rarely triggered in practice). Notes are always injected, but the brain almost never gets proactive commentary turns.
- **`direct`**: main brain sees raw frames on every proactive turn and writes `[[NOTE:...]]` inline, but note accumulation is blocked by the same gates that block commentary (audio quiet window, `hasQueuedVoiceWork`, `isStreamWatchPlaybackBusy`). During active conversation, notes go stale.

### Observed issues from log analysis (Mar 16 2026 sessions)

1. **Vision diff never triggers.** Change scores during a Terraria boss fight maxed at 0.016 against a threshold of 0.15. All 31 commentary turns across 3 sessions were interval-timer fires (`changeTriggered: false`). The clankvox diffing works — scores vary with screen activity — but the threshold is ~10x too high.

2. **Notes go stale during conversation.** The audio quiet window (2.2s) and `hasQueuedVoiceWork` gate block both commentary AND note accumulation in direct mode. During a 60-second stretch of active gaming chatter, Clanky's visual memory freezes.

3. **Voice replies carry unnecessary image weight.** Every voice turn during screen share attached the raw JPEG (~1500-2000 tokens), even conversational turns unrelated to the screen. Fixed in commit `52e35b6` — voice replies now only get rolling notes, not the image.

4. **Two modes, redundant settings.** Operators choose between two pipelines that have separate model configs, interval settings, and entry limits. The mental model is confusing and the modes don't compose.

## Design

Merge the two modes into a single pipeline with two decoupled loops:

```
┌─────────────────────────────────────────────────────┐
│                  FRAME INGESTION                     │
│  clankvox → DecodedVideoFrame IPC → ingestStreamFrame│
│  (2fps, rate-limited by maxFramesPerMinute)          │
└──────────────┬──────────────────────────┬────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────────┐   ┌──────────────────────┐
│     NOTE-TAKER LOOP      │   │   LATEST FRAME STORE │
│                          │   │   (always updated)    │
│  Adaptive interval:      │   └──────────┬───────────┘
│                          │              │
│  score >= changeThreshold│              │
│    → fire now (cooldown  │              │
│      permitting)         │              │
│  score < staticFloor     │              │
│    → idle interval (30s) │              │
│  otherwise               │              │
│    → normal interval(10s)│              │
│  scene cut               │              │
│    → fire immediately    │              │
│                          │              │
│  NOT gated by:           │              │
│  - Audio quiet window    │              │
│  - hasQueuedVoiceWork    │              │
│  - isStreamWatchPlayback │              │
│                          │              │
│  Throttled only by:      │              │
│  - Vision model latency  │              │
│    (natural backpressure)│              │
│  - Change cooldown (1s)  │              │
│                          │              │
│  Produces:               │              │
│  - Rolling notes         │              │
│  - Stored in             │              │
│    brainContextEntries   │              │
│  - Never speaks          │              │
└──────────┬───────────────┘              │
           │                              │
           ▼                              │
┌──────────────────────────────────────────▼──────────┐
│                    VOICE BRAIN                       │
│                                                      │
│  On user-speech turns:                               │
│  - Sees rolling notes (always fresh)                 │
│  - No image attached                                 │
│  - Responds to conversation naturally                │
│                                                      │
│  On commentary turns (proactive):                    │
│  - Sees rolling notes + current frame                │
│  - Gated by audio quiet window + interval            │
│  - Decides to speak or [SKIP]                        │
│  - Writes additional [[NOTE:...]] inline             │
│                                                      │
│  On direct-address about screen:                     │
│  - Sees rolling notes + current frame (re-attached)  │
│  - "what's on screen?" / "what do you see?"          │
└─────────────────────────────────────────────────────┘
```

### Note-taker loop

A standalone async loop that runs independently of the voice reply pipeline.

**Adaptive interval based on screen activity:**

```
every frame arrival:
  if scene cut:
    fire immediately (cooldown permitting)
  else if changeScore >= changeThreshold (0.01):
    fire immediately (cooldown permitting)
  else if changeScore < staticFloor (0.005):
    use idle interval — noteIdleIntervalSeconds (30s)
  else:
    use normal interval — noteIntervalSeconds (10s)
```

The interval adapts to what's on screen. An active boss fight ticks every 10s (or faster on big visual changes). A game lobby with ambient particle effects stretches to 30s. A completely static screen also uses 30s. The static floor filters out ambient motion (cursor blinks, subtle animations, screensaver-style effects) that produce nonzero change scores but aren't worth a vision call when the last note is still fresh.

**What it does NOT care about:**
- Whether anyone is talking (no audio quiet window)
- Whether the bot is speaking or generating (no `hasQueuedVoiceWork`)
- Whether playback is active (no `isStreamWatchPlaybackBusy`)

**What throttles it:**
- Natural backpressure: `await` the vision model call before allowing the next one. Can't fire faster than the model responds.
- Change-triggered cooldown (`changeMinIntervalSeconds`, default 2s) prevents rapid-fire on sustained high-change content
- `maxFramesPerMinute` still applies at the frame ingestion layer

**What it produces:**
- A short observation note appended to `brainContextEntries`
- No urgency classification needed — the note-taker doesn't decide whether to trigger commentary
- No speech, no output lock interaction, no playback

**Note lifecycle (already implemented):**
When notes exceed `maxNoteEntries`, the oldest entries are evicted into `pendingCompactionNotes`. The existing context compaction system (`voiceContextCompaction.ts`) folds these into the running `compactedContextSummary` alongside conversation turns. So temporal continuity is preserved even as the rolling buffer turns over — the summary retains the arc ("started in lobby, fought Eye of Cthulhu, respecced to mage") while recent notes keep granular detail ("Duke Fishron at 43k HP, dodging tornado").

**Model:** Configurable separately (`noteProvider`, `noteModel`). Should be cheap and fast — haiku-class or flash-class. The prompt is the same context_brain triage prompt minus the urgency field: just "describe what you see in one line."

### Commentary loop

The existing proactive commentary mechanism, simplified:

**When it fires:**
- Steady interval (`commentaryIntervalSeconds`, default ~15-20s)
- Change-triggered early fire (using the same change scores, with a separate commentary cooldown)
- First frame (`share_start`)

**Gated by (same as today):**
- Audio quiet window (2.2s since last inbound audio)
- No pending voice work (`hasQueuedVoiceWork`)
- No active playback (`isStreamWatchPlaybackBusy`)
- `autonomousCommentaryEnabled` toggle

**What it sees:**
- Fresh rolling notes from the note-taker (always up to date, even during active conversation)
- Current raw frame (image attached for commentary turns only)
- Full conversation context

**What it produces:**
- Spoken commentary or `[SKIP]`
- Additional `[[NOTE:...]]` inline observations (stored alongside note-taker notes)

### Voice reply turns (user speech)

No change from the current post-`52e35b6` behavior:

- Rolling notes injected via `streamWatchBrainContext` (always fresh now thanks to decoupled note-taker)
- No image attached
- If the user directly asks about the screen ("what's on screen?", "what do you see?"), re-attach the current frame

The screen-question detection can be a simple heuristic or left to the model's reasoning — the notes should be sufficient for most cases, and the frame re-attach is a nice-to-have optimization.

## Settings Consolidation

### Removed settings (after migration)
- `brainContextMode` — no longer two modes
- `brainContextEnabled` — notes always run when screen watch is active
- `directMinIntervalSeconds` — replaced by `commentaryIntervalSeconds`
- `directMaxEntries` — replaced by `maxNoteEntries`
- `directChangeThreshold` — replaced by unified `changeThreshold`
- `directChangeMinIntervalSeconds` — replaced by `changeMinIntervalSeconds`
- `brainContextMinIntervalSeconds` — replaced by `noteMinIntervalSeconds`
- `brainContextMaxEntries` — replaced by `maxNoteEntries`
- `minCommentaryIntervalSeconds` — replaced by `commentaryIntervalSeconds`

### New unified settings

| Setting | Default | Description |
|---------|---------|-------------|
| `noteProvider` | `"claude-oauth"` | LLM provider for note-taker vision calls |
| `noteModel` | `"claude-haiku-3-5"` | Model for note-taker (cheap/fast) |
| `noteIntervalSeconds` | `10` | Normal interval for note-taker ticks (3-120) |
| `noteIdleIntervalSeconds` | `30` | Interval when screen is static / ambient motion only (10-120) |
| `staticFloor` | `0.005` | Change scores below this are treated as static (0.001-0.05) |
| `maxNoteEntries` | `12` | Max rolling notes kept in brain context (1-24) |
| `changeThreshold` | `0.01` | Visual change score that triggers immediate note-taker tick (0.005-1.0). Based on observed data: Terraria boss fights peak at ~0.016, idle screens ~0.001. Start low and tune up if too chatty. |
| `changeMinIntervalSeconds` | `2` | Cooldown between change-triggered note ticks (1-30) |
| `commentaryIntervalSeconds` | `15` | Min seconds between proactive commentary turns (5-120) |
| `commentaryProvider` | (inherit voice) | LLM provider for commentary brain turns |
| `commentaryModel` | (inherit voice) | Model for commentary brain turns |
| `autonomousCommentaryEnabled` | `true` | Master toggle for proactive commentary |

Retained unchanged: `enabled`, `maxFramesPerMinute`, `maxFrameBytes`, `keyframeIntervalMs`, `nativeDiscordMaxFramesPerSecond`, `nativeDiscordPreferredQuality`, `nativeDiscordPreferredPixelCount`, `nativeDiscordPreferredStreamType`, `sharePageMaxWidthPx`, `sharePageJpegQuality`.

## Implementation Plan

### Phase 1: Decouple note-taker from commentary gates

1. Extract the note-taker into its own async loop function (`runNoteTakerLoop`) that:
   - Runs on a `setInterval` / frame-driven timer
   - Calls the vision model with the current frame
   - Appends the result to `brainContextEntries`
   - Has no interaction with the output lock, voice work queue, or audio quiet window
   - Awaits each vision call before allowing the next (natural backpressure)
   - Skips calls when change score is near zero and interval hasn't elapsed

2. Start the note-taker loop when screen watch activates, stop it when screen watch ends.

3. Remove the note-accumulation responsibility from `maybeTriggerDirectStreamWatchBrainTurn` and `maybeTriggerStreamWatchCommentary`.

### Phase 2: Lower vision diff threshold

1. Change `directChangeThreshold` default from `0.15` to `0.04`
2. Validate against log data from live sessions — the Terraria boss fight scores (0.001-0.016) suggest 0.04 would catch scene transitions and major gameplay changes while ignoring minor character animations

### Phase 3: Simplify commentary triggers

1. Remove `brainContextMode` switch — one pipeline, always
2. Commentary fires on interval + change trigger, gated by audio quiet window + voice work gates
3. Commentary always attaches the current frame (it's the only turn type that does)
4. Remove the urgency classification from the note-taker — it just takes notes

### Phase 4: Settings migration and documentation

1. Map old settings to new settings with backward compat normalization
2. Update dashboard UI to reflect unified pipeline
3. Update `docs/voice/screen-share-system.md` — document the note lifecycle end-to-end: note-taker → rolling buffer (12 recent) → eviction → `pendingCompactionNotes` → compaction into session summary → summary injected into all prompts. This is currently undocumented in the canonical doc.

### Phase 5: Screen-question frame re-attach (optional)

1. Detect when a directly-addressed voice turn is asking about the screen
2. Re-attach the current frame for that specific reply
3. This is a nice-to-have — the rolling notes should cover most cases

## Key Source Files to Change

| File | Changes |
|------|---------|
| `src/voice/voiceStreamWatch.ts` | New `runNoteTakerLoop`, simplify commentary triggers, remove mode switch |
| `src/voice/voiceReplyPipeline.ts` | Already done (image drop). Optional: screen-question frame re-attach |
| `src/settings/settingsSchema.ts` | New unified settings, deprecate old mode-specific settings |
| `src/store/normalize/voice.ts` | Migration normalization for old settings |
| `src/voice/voiceSessionManager.ts` | Start/stop note-taker loop on watch lifecycle |
| `docs/voice/screen-share-system.md` | Update to reflect unified pipeline |
| `dashboard/src/` | Update stream watch settings UI |

## Open Questions

1. **Note-taker prompt:** Should it be the same as the current context_brain triage prompt (one-line observation), or should we give it more structure (e.g. "what changed since last note")?

2. **Note deduplication:** The current system evicts old entries by count. Should the note-taker also skip storing a note if it's semantically identical to the most recent one? (Cheap heuristic: exact string match after normalization.)

3. **Commentary interval tuning:** Current direct mode fires every ~8-10s (though gates delay it). With fresh notes always available, commentary can be less frequent. 15-20s default feels right for "reacting to what's happening" without being chatty, but this needs live tuning.

4. **Frame re-attach for screen questions:** Is simple keyword detection ("what's on screen", "what do you see", "look at") sufficient, or should the addressing classifier handle this?
