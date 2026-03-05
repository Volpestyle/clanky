Goal
The user asked for a review of the project's commit history to identify patterns, specifically flip-flopping bugs. After identifying 5 systems with recurring fix/break cycles, the user chose to tackle the music state machine first — replacing scattered booleans with an explicit state enum. That refactor is complete. The remaining 4 systems (ASR bridge, music gating, audio playback pipeline, join greeting) are queued for future work.
Instructions
- Follow AGENTS.md conventions (the project has detailed contributor guidelines)
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work and never revert files not explicitly changed for the current task
- The project uses Bun as runtime and test runner (bun test, bun run typecheck)
- TypeScript strict mode; run bun run typecheck (which runs bunx tsc -b --noEmit) to verify
- The user prefers LLM-driven decisions over hardcoded heuristics (documented pattern in codebase)
- When making design decisions, present options with tradeoffs and ask the user to choose
Discoveries
Codebase architecture
- This is a voice-first Discord bot ("clanker conk") with a Bun/TypeScript main process and a Rust subprocess handling audio (Opus encoding, RTP, DAVE E2EE)
- The voice session manager (voiceSessionManager.ts) is ~13,600 lines — the largest file
- Music playback flows: main process → IPC (JSON over stdin) → Rust subprocess → Discord UDP
- There are two ASR bridge implementations (per-user and shared) that are near-identical copies (~500 lines each) — a major duplication issue
5 identified flip-flop patterns (from commit history analysis)
1. ASR bridge (9 commits): Empty commit vs hallucination tradeoff. 17 tuning constants, implicit state machine across ~2500 lines. Root cause: can't distinguish "ASR buffer race lost audio" from "genuinely no speech."
2. Music gating (10 commits): Noise rejection vs command passthrough during music. English-only heuristic regex. An unused LLM classifier (evaluateMusicStopIntentFromTranscript) already exists but isn't wired in.
3. Music pause/resume state machine (6 commits): 7 booleans across 4 layers, no single source of truth. THIS WAS FIXED.
4. Audio playback pipeline (7 commits): Unbounded VecDeque<i16> PCM buffer in Rust subprocess with no backpressure. Caused an 18-second playback delay.
5. Join greeting (7 commits): Actually stable now — landed on a deferred-voice-action system with brain-routed firing. Only needs cleanup of 3 dead dashboard vestiges.
Key design decisions made
- Session owns all music state (not MusicPlayer class) — user chose this over MusicPlayer owning the enum
- Music state machine first — user chose this as the starting point over ASR bridge or audio pipeline
- A stale low_signal_without_direction gate was found in voiceReplyDecision.ts from another agent's reverted work — user confirmed it should be removed
Accomplished
Completed: Music state machine refactor
- Added MusicPlaybackPhase enum ("idle" | "loading" | "playing" | "paused" | "paused_wake_word" | "stopping") as single source of truth
- Added 7 derived query functions (musicPhaseIsActive, musicPhaseIsAudible, musicPhaseShouldLockOutput, musicPhaseShouldForceCommandOnly, musicPhaseCanResume, musicPhaseCanPause, musicPhaseShouldAllowDucking)
- Converted DiscordMusicPlayer from stateful class to stateless IPC proxy (removed _playing, _paused, _ducked)
- All mutation sites now use setMusicPhase() — centralized transitions
- Fixed /resume slash command (was broken — now checks musicPhaseCanResume and re-locks session)
- Fixed disambiguation selection blocked during music playback (reordered: command followup check now runs before output lock)
- Fixed ducking state desync
- All 167 tests pass, typecheck clean
- Documented in docs/tmp/2026-03-05-refactor.md
Not yet started (proposed in this conversation, user hasn't chosen to start)
1. ASR bridge: Unify per-user/shared implementations + explicit state machine + forward ambiguous transcripts to brain instead of dropping
2. Music gating: Enable the existing unused LLM classifier for ambiguous turns during music (Option A, aligns with codebase preference for LLM-driven decisions)
3. Audio pipeline: Add buffer depth IPC metric from Rust → main process, cap the pcm_buffer VecDeque, chunk TTS sends instead of single blob
4. Join greeting: Delete 3 dead dashboard vestiges (greetingTimerActive/greetingScheduled type fields, stale Mermaid diagram)
Relevant files / directories
Changed in this refactor
- src/voice/voiceSessionTypes.ts — MusicPlaybackPhase type, query functions, updated VoiceSessionMusicState interface
- src/voice/musicPlayer.ts — Converted to stateless IPC proxy
- src/voice/voiceMusicPlayback.ts — getMusicPhase(), setMusicPhase(), all mutation sites, /resume fix
- src/voice/voiceSessionManager.ts — All music state consumers updated to derive from phase
- src/voice/voiceReplyDecision.ts — Lock/command-only use phase queries, reordered followup vs lock check
- src/voice/voiceToolCalls.ts — music_resume handler simplified
- src/voice/voiceJoinFlow.ts — Session init includes phase/ducked/pauseReason
- src/voice/voiceSessionManager.lifecycle.test.ts — 3 tests updated for phase enum
- src/voice/voiceSessionManager.addressing.test.ts — 3 tests updated for new lock behavior
- docs/tmp/2026-03-05-refactor.md — Full refactor documentation
Read during analysis (not changed, but relevant for future work)
- src/voice/voiceSessionManager.constants.ts — 17 ASR tuning constants live here
- src/voice/voiceSessionHelpers.ts — ASR commit minimum bytes logic
- src/voice/voiceSubprocessClient.ts — IPC protocol to Rust subprocess
- src/voice/rust_subprocess/src/main.rs — Unbounded pcm_buffer VecDeque, 20ms tick drain
- src/voice/voiceRuntimeState.ts — Runtime state broadcast (uses snapshotMusicRuntimeState)
- src/voice/voiceToolCalls.test.ts — Music tool call tests (all passing)
- src/prompts/promptVoice.ts — Join greeting bias in brain-path prompts
- dashboard/src/hooks/useVoiceSSE.ts — Dead greetingTimerActive/greetingScheduled vestiges
- dashboard/src/components/VoiceMonitor.tsx — Dead greeting pills that never render
- docs/diagrams/voice-subprocess-architecture.mmd — Stale "3s timer" reference