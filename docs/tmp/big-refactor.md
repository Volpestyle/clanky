# Big Refactor: Voice System Cleanup

## Goal

The user asked for a review of the project's commit history to identify patterns, specifically flip-flopping bugs. After identifying **5 systems** with recurring fix/break cycles, the user chose to tackle the **music state machine first** — replacing scattered booleans with an explicit state enum. That refactor is complete. The remaining 4 systems (ASR bridge, music gating, audio playback pipeline, join greeting) are queued for future work.

---

## Instructions

- Follow `AGENTS.md` conventions (the project has detailed contributor guidelines)
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work and **never revert files not explicitly changed** for the current task
- The project uses **Bun** as runtime and test runner (`bun test`, `bun run typecheck`)
- TypeScript strict mode; run `bun run typecheck` (which runs `bunx tsc -b --noEmit`) to verify
- The user prefers **LLM-driven decisions** over hardcoded heuristics (documented pattern in codebase)
- When making design decisions, present options with tradeoffs and ask the user to choose

---

## Discoveries

### Codebase Architecture

- Voice-first Discord bot ("clanker conk") with a **Bun/TypeScript** main process and a **Rust subprocess** handling audio (Opus encoding, RTP, DAVE E2EE)
- `voiceSessionManager.ts` is ~13,600 lines — the largest file
- Music playback flow: `main process → IPC (JSON over stdin) → Rust subprocess → Discord UDP`
- Two ASR bridge implementations (per-user and shared) are near-identical copies (~500 lines each) — a major duplication issue

### 5 Identified Flip-Flop Patterns (from commit history)

| # | System | Commits | Root Cause |
|---|--------|---------|------------|
| 1 | **ASR bridge** | 9 | Can't distinguish "ASR buffer race lost audio" from "genuinely no speech." 17 tuning constants, implicit state machine across ~2500 lines. |
| 2 | **Music gating** | 10 | Noise rejection vs. command passthrough during music. English-only heuristic regex. An unused LLM classifier (`evaluateMusicStopIntentFromTranscript`) exists but isn't wired in. |
| 3 | **Music pause/resume state machine** | 6 | 7 booleans across 4 layers, no single source of truth. **✅ FIXED.** |
| 4 | **Audio playback pipeline** | 7 | Unbounded `VecDeque<i16>` PCM buffer in Rust subprocess with no backpressure. Caused an 18-second playback delay. **✅ FIXED (phase 1).** Buffer capped, depth metrics added. Chunked sends deferred pending real-world metrics. |
| 5 | **Join greeting / deferred actions** | 7 | Actually stable — landed on a deferred-voice-action system with brain-routed firing. **✅ FIXED.** Generalized gating layer, deleted dead dashboard vestiges. |

### Key Design Decisions Made

- **Session owns all music state** (not `MusicPlayer` class) — user chose this over `MusicPlayer` owning the enum
- **Music state machine first** — user chose this as the starting point over ASR bridge or audio pipeline
- A stale `low_signal_without_direction` gate was found in `voiceReplyDecision.ts` from another agent's reverted work — user confirmed it should be removed

---

## Status

### ✅ Completed: Music State Machine Refactor

- Added `MusicPlaybackPhase` enum (`"idle" | "loading" | "playing" | "paused" | "paused_wake_word" | "stopping"`) as single source of truth
- Added 7 derived query functions:
  - `musicPhaseIsActive`
  - `musicPhaseIsAudible`
  - `musicPhaseShouldLockOutput`
  - `musicPhaseShouldForceCommandOnly`
  - `musicPhaseCanResume`
  - `musicPhaseCanPause`
  - `musicPhaseShouldAllowDucking`
- Converted `DiscordMusicPlayer` from stateful class to **stateless IPC proxy** (removed `_playing`, `_paused`, `_ducked`)
- All mutation sites now use `setMusicPhase()` — centralized transitions
- Fixed `/resume` slash command (was broken — now checks `musicPhaseCanResume` and re-locks session)
- Fixed disambiguation selection blocked during music playback (reordered: command followup check now runs before output lock)
- Fixed ducking state desync
- All **167 tests pass**, typecheck clean
- Documented in `docs/tmp/2026-03-05-refactor.md`

### ✅ Completed: Deferred Voice Action Generalization

- Extracted `canFireDeferredAction()` — shared gating layer returns `string | null` (block reason or null)
- Covers: session validity, expiry, `notBeforeAt` floor, active captures, pending response, active realtime response, awaiting tool outputs, running tool calls
- Rewrote `recheckDeferredVoiceActions()` — switch dispatch with shared block-reason handling replaces per-type if/else chains
- Renamed `recheckDeferred*` methods → `fireDeferred*` (fire-logic only, no duplicated gating)
- Deleted `scheduleJoinGreetingGrace()` — inlined into generic `scheduleDeferredVoiceActionRecheck()`
- Generalized trigger points: `maybeTriggerJoinGreeting` → `maybeTriggerDeferredActions` (rechecks all pending actions)
- Removed join_greeting `preferredTypes` restriction from empty ASR bridge drop
- Deleted dead dashboard vestiges (`greetingScheduled`/`greetingTimerActive` type fields, never-rendering greeting pills in VoiceMonitor)
- Fixed stale "3s timer" → "2.5s grace" in Mermaid diagram
- Added 12 unit tests for `canFireDeferredAction()` covering all block reasons
- All **176 tests pass**, typecheck clean

### ✅ Completed: Audio Pipeline Backpressure (Phase 1)

- Capped `pcm_buffer` at 240,000 samples (5s @ 48kHz) in Rust `push_pcm()` — drops oldest on overflow
- Added `BufferDepth` IPC message (`ttsSamples`, `musicSamples`) emitted every 500ms when buffers non-empty
- TS side: `voiceSubprocessClient` handles `buffer_depth`, exposes `ttsBufferDepthSamples` + `getTtsBufferDepthSeconds()`
- **Deferred to phase 2:** Chunked TTS sends — need real-world buffer depth metrics to inform pacing (drain rate is 960 samples/20ms tick, pacing should match that, not an arbitrary constant)
- Typecheck clean, `cargo check` clean

### ⏳ Not Yet Started (proposed, user hasn't chosen to start)

1. **ASR bridge** — Unify per-user/shared implementations + explicit state machine + forward ambiguous transcripts to brain instead of dropping
2. **Music gating** — Enable the existing unused LLM classifier for ambiguous turns during music (Option A, aligns with codebase preference for LLM-driven decisions)
3. **Audio pipeline phase 2** — Chunked TTS sends paced by buffer depth metrics (pending real-world data from phase 1)

---

## Relevant Files

### Changed in This Refactor

| File | What Changed |
|------|-------------|
| `src/voice/voiceSessionTypes.ts` | `MusicPlaybackPhase` type, query functions, updated `VoiceSessionMusicState` interface |
| `src/voice/musicPlayer.ts` | Converted to stateless IPC proxy |
| `src/voice/voiceMusicPlayback.ts` | `getMusicPhase()`, `setMusicPhase()`, all mutation sites, `/resume` fix |
| `src/voice/voiceSessionManager.ts` | All music state consumers updated to derive from phase |
| `src/voice/voiceReplyDecision.ts` | Lock/command-only use phase queries, reordered followup vs lock check |
| `src/voice/voiceToolCalls.ts` | `music_resume` handler simplified |
| `src/voice/voiceJoinFlow.ts` | Session init includes `phase`/`ducked`/`pauseReason` |
| `src/voice/voiceSessionManager.lifecycle.test.ts` | 3 tests updated for phase enum |
| `src/voice/voiceSessionManager.addressing.test.ts` | 3 tests updated for new lock behavior |
| `docs/tmp/2026-03-05-refactor.md` | Full refactor documentation |

### Changed in Deferred Action Refactor

| File | What Changed |
|------|-------------|
| `src/voice/voiceSessionManager.ts` | `canFireDeferredAction()`, switch-based `recheckDeferredVoiceActions()`, renamed `fireDeferred*` methods, deleted `scheduleJoinGreetingGrace()`, generalized trigger points |
| `src/voice/voiceSessionManager.lifecycle.test.ts` | 12 new `canFireDeferredAction()` unit tests |
| `dashboard/src/hooks/useVoiceSSE.ts` | Removed dead `greetingScheduled`/`greetingTimerActive` type fields |
| `dashboard/src/components/VoiceMonitor.tsx` | Removed dead greeting pill elements |
| `docs/diagrams/voice-subprocess-architecture.mmd` | Fixed stale "3s timer" → "2.5s grace" |

### Changed in Audio Pipeline Refactor (Phase 1)

| File | What Changed |
|------|-------------|
| `src/voice/rust_subprocess/src/main.rs` | `BufferDepth` OutMsg variant, `MAX_PCM_BUFFER_SAMPLES` cap, drop-oldest in `push_pcm()`, periodic depth reporting in 20ms tick loop |
| `src/voice/voiceSubprocessClient.ts` | `buffer_depth` IPC handler, `ttsBufferDepthSamples` field, `getTtsBufferDepthSeconds()` accessor |
| `src/voice/voiceSessionManager.ts` | Updated `enqueueChunkedTtsPcmForPlayback()` comment to document Rust-side cap |

### Read During Analysis (not changed, relevant for future work)

| File | Notes |
|------|-------|
| `src/voice/voiceSessionManager.constants.ts` | 17 ASR tuning constants live here |
| `src/voice/voiceSessionHelpers.ts` | ASR commit minimum bytes logic |
| `src/voice/voiceRuntimeState.ts` | Runtime state broadcast (uses `snapshotMusicRuntimeState`) |
| `src/voice/voiceToolCalls.test.ts` | Music tool call tests (all passing) |
| `src/prompts/promptVoice.ts` | Join greeting bias in brain-path prompts |