# Clankvox Rust Subprocess — Review & Improvement Plan

**Date:** March 6, 2026
**Scope:** `src/voice/clankvox/` (Rust) + `src/voice/clankvoxClient.ts` (TS client)

---

## The Numbers

| Component | Lines |
|-----------|-------|
| `main.rs` | 2,299 |
| `voice_conn.rs` | 1,422 |
| `dave.rs` | 425 |
| **Total Rust** | **4,146** |
| `clankvoxClient.ts` (TS client) | 627 |
| `clankvoxClient.test.ts` | 139 |
| **Total system** | **4,912** |

The original codebase review reported 2,299 lines — that's just `main.rs`. The actual Rust codebase is **4,146 lines** across 3 files, nearly double what was reported.

---

## Grade: **B-**

---

## Architecture Overview

Clankvox is a standalone Rust process that handles the entire low-level voice pipeline:

1. **Discord Voice WebSocket** — full v8 protocol implementation (OP0 Identify through OP31 DAVE recovery)
2. **UDP RTP** — IP discovery, transport encryption (AES-256-GCM + XChaCha20-Poly1305), packet send/receive
3. **DAVE E2EE** — full MLS-based Discord Audio/Video Encryption via the `davey` crate, including transition management, welcome/commit processing, epoch reinit, and passthrough mode
4. **Opus codec** — encode outbound TTS/music, decode inbound user audio
5. **Audio mixing** — TTS + music buffers with gain envelope crossfading
6. **Music pipeline** — spawns yt-dlp | ffmpeg as a child process, reads raw PCM
7. **ASR** — OpenAI Realtime Transcription API via WebSocket, per-user sessions
8. **PCM resampling** — linear interpolation between arbitrary sample rates

### IPC Protocol (Bun <-> Rust)

- **Inbound** (Bun -> Rust): newline-delimited JSON on stdin
- **Outbound** (Rust -> Bun): length-prefixed binary frames on stdout, with format byte (0=JSON, 1=binary audio)
- Binary audio path avoids base64 encode/decode overhead for the hot path
- Bounded channel (512) with backpressure — drops frames rather than OOMing

---

## The Good

1. **Solid dependency choices.** `tokio` for async, `parking_lot` for fast mutexes, `crossbeam-channel` for thread-safe bounded queues, `anyhow` for error propagation. All idiomatic Rust.

2. **Only one `unsafe` block** (`main.rs:1122`) — a `libc::kill()` for SIGTERM on the music player child process. Reasonable use; the alternative (`Command::new("kill")`) spawns a whole process.

3. **The IPC writer is well-engineered.** Dedicated thread, bounded channel with backpressure, binary fast-path for audio frames with signal metadata (peak, active sample count) packed into a compact header.

4. **DAVE implementation is thorough.** Handles edge cases that many implementations miss: `AlreadyInGroup` during welcome processing, auto-execute of pending pv=0 downgrades after 3s timeout, passthrough mode during transitions, decrypt failure tracking with suppressed recovery to avoid 4006 disconnects.

5. **Audio pipeline is production-quality.** PCM buffer overflow protection (15s cap), trailing silence frames for smooth cutoff, partial TTS tail coalescing/flushing, gain envelope for smooth music volume transitions.

6. **Tests exist and are meaningful.** 7 unit tests in `main.rs` covering the mixer drain logic, music pipeline command construction, and TTS partial frame flushing. 3 tests in `clankvoxClient.test.ts` covering destroy lifecycle and telemetry.

---

## The Bad

### 1. `main.rs` is a monolith (2,299 lines)

The main loop (`main()`) is a single `tokio::select!` loop running from line 1298 to line 2242 — **944 lines** of deeply nested match arms in one function. It manages IPC message dispatch (16 message types), voice connection events, music pipeline events, ASR exit notifications, and the 20ms audio send tick.

Same god-function antipattern as `voiceSessionManager.ts`.

### 2. Music state is a 14-variable bag

```rust
music_player, music_active, music_paused, active_music_url,
active_music_resolved_direct_url, pending_music_url,
pending_music_received_at, pending_music_audio_seen,
pending_music_last_audio_at, pending_music_waiting_for_drain,
pending_music_drain_started_at, pending_music_first_pcm_at,
pending_music_resolved_direct_url, pending_music_stop
```

All loose `let mut` bindings in `main()`. The "reset all music state" block is copy-pasted **6 times**. A `MusicState` struct with a `reset()` method would eliminate this.

### 3. `#![allow(dead_code)]` at the top of `main.rs`

Silences the compiler's unused code warnings globally. Should be removed; dead code should be deleted, not suppressed.

### 4. `unwrap()` in `try_connect` on guarded-but-unproven invariants

`main.rs:2270-2282` — `pending.user_id.unwrap()`, `pending.endpoint.as_ref().unwrap()`, etc. "Safe" because `is_complete()` was checked, but the compiler doesn't know that. If the invariant ever breaks, the entire subprocess panics. Should use `let else` or propagate as `Result`.

### 5. No reconnect support

When the voice WebSocket closes (e.g., Discord sends 4006 after DAVE recovery), clankvox can't reconnect — it emits `Disconnected` and the TS side has to respawn the entire process.

This is the most significant architectural limitation.

### 6. No Cargo tests for `voice_conn.rs` or `dave.rs`

All 7 Rust tests are in `main.rs` for the audio mixer. The voice connection handshake, RTP handling, transport crypto, and DAVE state machine have zero unit tests.

---

## Red Flags

1. **Shared Opus decoder across all SSRCs.** `main.rs:1276-1277` creates a single `OpusDecoder` used for all inbound user audio. Opus decoders maintain internal state (PLC, bandwidth estimation). Interleaving frames from different users corrupts this state, causing audio artifacts. Each SSRC should have its own decoder.

2. **`send_msg` silently drops all message types.** Uses `try_send` on the bounded channel — if full, messages including `Error`, `ConnectionState`, and `AsrTranscript` are silently dropped. Control messages should use blocking send or at minimum log when dropped.

3. **`serde_json::Value` for voice gateway data.** `InMsg::VoiceServer { data: Value }` and `InMsg::VoiceState { data: Value }` accept arbitrary JSON with no type safety. Field extraction via `.get("endpoint").and_then(|v| v.as_str())` — a typo is a silent `None`.

4. **Music player `kill()` doesn't kill the process group.** The `sh -c "yt-dlp ... | ffmpeg ..."` pipeline creates a process group. `kill(pid, SIGTERM)` only signals the shell, not ffmpeg. Should use `killpg` or negative PID.

---

## TS-Side Client (`clankvoxClient.ts` — 627 lines)

**Grade: B+**

The TS client is cleaner than most of the TS codebase:
- Proper lifecycle management with `destroy()` that sends gateway leave, graceful SIGTERM with 250ms timeout, then SIGKILL at 5s
- Static `liveClients` set with process exit handler to SIGKILL orphaned children
- Binary stdout framing parser handles partial reads correctly
- Audio batching (5ms timer) to reduce IPC overhead

**Issues:**
- `guild: any` — untyped
- `_handleMessage(msg: any)` — untyped message dispatch
- `connectAsr` params are untyped
- No reconnect on crash — `crashed` event is emitted but the caller has to handle restart

---

## Improvement Plan (Prioritized)

### Phase 1: Bug Fixes (High Impact, Low Effort)

| # | Task | Why | Effort |
|---|------|-----|--------|
| 1 | **Per-SSRC Opus decoders** | Shared decoder corrupts internal state when interleaving frames from different users. Real audio quality bug. | Small — HashMap<u32, OpusDecoder> keyed by SSRC |
| 2 | **Replace `unwrap()` in `try_connect`** with `let Some(...) = ... else { return }` | Subprocess panics if invariant breaks | Tiny |
| 3 | **Use `killpg` for music pipeline** | `kill(pid)` only kills the shell, not ffmpeg in the pipeline | Tiny — change `libc::kill` to `libc::killpg` |
| 4 | **Differentiate control vs audio in `send_msg`** | Control messages (`Error`, `ConnectionState`, `AsrTranscript`) should not be silently dropped | Small — use `send` (blocking) for non-audio, keep `try_send` for audio |

### Phase 2: Code Quality (Medium Effort)

| # | Task | Why | Effort |
|---|------|-----|--------|
| 5 | **Extract `MusicState` struct** with `reset()` method | 14 loose variables, 6 copy-pasted reset blocks | Medium |
| 6 | **Remove `#![allow(dead_code)]`** and delete actual dead code | Suppresses useful compiler warnings | Tiny |
| 7 | **Type voice gateway IPC messages** | Replace `serde_json::Value` with proper structs for `VoiceServer` and `VoiceState` data | Small |
| 8 | **Type the TS client** | Replace `any` in `guild`, `_handleMessage`, `connectAsr` params | Small |

### Phase 3: Architecture (High Effort, High Value)

| # | Task | Why | Effort |
|---|------|-----|--------|
| 9 | **Break `main.rs` into modules** | 944-line main loop is a god-function. Extract: `ipc.rs` (message dispatch), `music.rs` (music state machine), `audio_pipeline.rs` (send state + mixing), `capture.rs` (user audio capture + speaking detection) | Large |
| 10 | **Add voice WebSocket reconnect** | Currently any WS disruption requires full process restart. Most significant architectural gap. | Large |
| 11 | **Add unit tests for `voice_conn.rs` and `dave.rs`** | Transport crypto and DAVE state machine are complex and untested | Medium |

### Phase 4: Future Improvements

| # | Task | Why | Effort |
|---|------|-----|--------|
| 12 | **CI build step for clankvox binary** | Currently built locally, no automated build | Medium |
| 13 | **Structured IPC error reporting** | Currently just string messages — add error codes for the TS side to react to specific failure modes | Medium |
| 14 | **Backpressure-aware stdin reader** | Potential deadlock if main loop stalls and TS side is blocked on stdout in the same event loop tick | Medium |

---

## Summary

For 11 days of work, shipping a custom Rust Discord voice client with DAVE E2EE, transport crypto, opus codec, audio mixing, music playback, and ASR — and having it actually work — is genuinely impressive. The code quality is a solid notch above the TS monoliths. The shared Opus decoder (#1) is the most urgent bug fix, and voice WS reconnect (#10) is the most impactful architectural improvement.
