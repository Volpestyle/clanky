# Clankvox Rust Subprocess — Audit Report (v2)

**Date:** March 6, 2026 (updated)
**Scope:** `src/voice/clankvox/` (Rust) + `src/voice/clankvoxClient.ts` (TS client)
**Edition:** Rust 2024 / MSRV 1.85
**Version:** 0.3.0

---

## The Numbers

| Component | Lines | Change |
|-----------|-------|--------|
| `voice_conn.rs` | 1,477 | +55 (tests, allows) |
| `main.rs` | 1,193 | -1,106 (modules extracted) |
| `dave.rs` | 455 | +30 (tests added) |
| `ipc.rs` | 435 | new module (was in main.rs) |
| `music.rs` | 422 | new module (was in main.rs) |
| `audio_pipeline.rs` | 394 | new module (was in main.rs) |
| `asr.rs` | 147 | new module (was in main.rs) |
| `capture.rs` | 41 | new module (was in main.rs) |
| **Total Rust** | **4,564** | +418 (tests, docs, allows) |
| `clankvoxClient.ts` (TS client) | 802 | +175 |
| `clankvoxClient.test.ts` | 172 | +33 |
| **Total system** | **~5,538** | |

---

## Grade: **B+**

Upgraded from **B-** (original review). The codebase has meaningfully improved since
the initial assessment through module extraction, typed IPC, bug fixes, and this audit's
clippy/edition cleanup.

---

## What Changed Since the B- Review

The original review (March 6, 2026) identified 14 improvement items. Here's the
current status:

### Resolved Before This Audit

| Original # | Issue | Status |
|------------|-------|--------|
| 1 | Shared Opus decoder across all SSRCs | **Fixed** — per-SSRC `HashMap<u32, OpusDecoder>` in `capture.rs` |
| 3 | `kill(pid)` instead of `killpg` | **Fixed** — `libc::killpg()` with proper SAFETY comment |
| 5 | 14 loose music variables, 6 copy-pasted resets | **Fixed** — `MusicState` struct in `music.rs` with `reset()` |
| 6 | `#![allow(dead_code)]` suppressing warnings | **Fixed** — removed, dead code deleted |
| 7 | `serde_json::Value` for voice gateway data | **Fixed** — typed `VoiceServerData` / `VoiceStateData` structs in `ipc.rs` |
| 9 | 2,299-line `main.rs` monolith | **Partially fixed** — extracted `ipc.rs`, `music.rs`, `audio_pipeline.rs`, `asr.rs`, `capture.rs`. `main.rs` down to 1,193 lines |

### Resolved During This Audit

| Item | What Changed |
|------|-------------|
| IPC writer silently drops write errors | `ipc.rs`: `let _ = out.write_all(...)` → proper error handling with `break` on write failure |
| `.expect()` on JSON values in ASR | `asr.rs`: replaced `serde_json::Value::as_object_mut().expect()` with direct `serde_json::Map` construction |
| Edition 2024 upgrade | `Cargo.toml`: edition `2021` → `2024`, `rust-version = "1.85"` |
| Lints configuration | `Cargo.toml`: `[lints.rust]` (unsafe_code = warn) and `[lints.clippy]` (all + pedantic with targeted allows) |
| Bulk clippy fixes | All files: `uninlined_format_args`, `redundant_closure_for_method_calls`, `unnecessary_map_or`, `implicit_clone`, `len_zero`, `manual_let_else` |
| VecDeque pre-allocation | `audio_pipeline.rs`: `with_capacity(48_000)` on both PCM buffers (~1s pre-allocated) |
| `unsafe` block documentation | `music.rs`: SAFETY comment expanded with full invariant documentation |

### Still Open

| Original # | Issue | Priority | Notes |
|------------|-------|----------|-------|
| 2 | `unwrap()` in `try_connect` on guarded invariants | Medium | Still present in `main.rs`. `is_complete()` guard makes panics unlikely but the compiler can't prove it. Consider `let...else`. |
| 4 | `send_msg` control vs audio semantics | Low | Now documented with doc comments in `ipc.rs`. Control messages use `send()` (blocking), lossy messages use `try_send()`. The original concern was overstated — the current implementation already differentiates correctly via `force: bool`. |
| 8 | Type the TS client (`any` casts) | Medium | `guild: any`, `_handleMessage(msg: any)` still present in `clankvoxClient.ts` |
| 10 | Voice WebSocket reconnect | Low | Architectural limitation. The TS-side respawn approach works and is simpler to reason about. |
| 11 | Unit tests for `voice_conn.rs` and `dave.rs` | Improved | `voice_conn.rs` now has 5 tests (RTP header parsing, AES-256-GCM + XChaCha20 round-trip). `dave.rs` has 4 tests (transition management, pending downgrade timeout). Was 7 total → now 15. |

---

## Architecture Overview

Clankvox is a standalone Rust subprocess (8 source files) that handles the entire
low-level Discord voice pipeline:

1. **Discord Voice WebSocket** — full v8 protocol (OP0 Identify through OP31 DAVE recovery)
2. **UDP RTP** — IP discovery, transport encryption (AES-256-GCM + XChaCha20-Poly1305)
3. **DAVE E2EE** — MLS-based encryption via `davey` crate, transition management, passthrough
4. **Opus codec** — encode outbound TTS/music, decode inbound user audio (per-SSRC decoders)
5. **Audio mixing** — TTS + music with gain envelope crossfading at 20ms frame rate
6. **Music pipeline** — `yt-dlp | ffmpeg` child process, raw PCM streaming
7. **ASR** — OpenAI Realtime Transcription API, per-user WebSocket sessions
8. **PCM resampling** — linear interpolation between arbitrary sample rates

### IPC Protocol (Bun ↔ Rust)

- **Inbound** (Bun → Rust): newline-delimited JSON on stdin
- **Outbound** (Rust → Bun): length-prefixed binary frames on stdout (format byte: 0=JSON, 1=binary audio)
- Control messages use blocking `send()`, lossy audio uses `try_send()` with backpressure (512-capacity bounded channel)
- Writer now detects and breaks on write errors instead of silently ignoring them

### Module Structure (post-extraction)

```
src/
├── main.rs          (1,193)  Event loop, state machine, tokio::select!
├── voice_conn.rs    (1,477)  WebSocket + UDP + transport crypto + RTP
├── dave.rs            (455)  DAVE E2EE state machine
├── ipc.rs             (435)  IPC protocol, typed messages, writer thread
├── music.rs           (422)  MusicState, pipeline spawning, mixer
├── audio_pipeline.rs  (394)  TTS/music mixing, PCM buffers, send state
├── asr.rs             (147)  OpenAI Realtime ASR session management
└── capture.rs          (41)  Per-user audio capture state, Opus decoder
```

---

## Strengths

1. **Minimal unsafe.** One `unsafe` block in the entire codebase (`libc::killpg` in
   `music.rs`) with thorough SAFETY documentation.

2. **Zero clippy warnings** under `clippy::all` + `clippy::pedantic` (with justified
   targeted allows for audio-specific casts and hot-path function signatures).

3. **Edition 2024** with MSRV 1.85 — modern match ergonomics, latest language features.

4. **Solid dependency choices.** `tokio`, `parking_lot`, `crossbeam-channel`, `anyhow` —
   all idiomatic and battle-tested.

5. **DAVE implementation is thorough.** Handles `AlreadyInGroup`, pending pv=0 downgrades
   with 3s timeout, passthrough during transitions, decrypt failure suppression during
   epoch changes. 4 unit tests covering the state machine.

6. **Audio pipeline is production-quality.** PCM overflow protection (15s cap), trailing
   silence frames, partial TTS tail coalescing/flushing, gain envelope for smooth volume
   transitions, pre-allocated VecDeque buffers.

7. **IPC writer is well-engineered.** Dedicated thread, bounded channel with backpressure,
   binary fast-path for audio, proper write error detection and teardown.

8. **15 meaningful unit tests** covering transport crypto round-trips, RTP header
   parsing, DAVE state transitions, music pipeline command construction, audio mixer
   drain logic, and TTS partial frame flushing.

---

## Remaining Concerns

### Medium Priority

1. **`main.rs` is still 1,193 lines.** The `main()` function's `tokio::select!` loop is
   ~900 lines of tightly coupled state management. This is a conscious design choice for a
   real-time event loop where arms share mutable state, but it makes the function hard to
   navigate. Future work could extract handler functions that take `&mut AppState`.

2. **`unwrap()` in `try_connect`** (main.rs). `pending.user_id.unwrap()` and
   `pending.endpoint.as_ref().unwrap()` after `is_complete()` check. The invariant holds in
   practice but isn't provable to the compiler. `let...else` with an error log would be
   strictly safer.

3. **TS client still uses `any`** for `guild`, `_handleMessage(msg)`, and `connectAsr`
   params. These should be typed.

### Low Priority

4. **No reconnect support.** Voice WebSocket closure requires full process restart via
   the TS parent, losing all in-flight state (ASR sessions, music position, DAVE epoch,
   per-SSRC decoders, audio buffers). Users hear a gap during respawn. Rare enough in
   production that it hasn't been prioritized, but it's an architectural limitation,
   not a deliberate design choice.

5. **Linear interpolation resampling** (`capture.rs`). Adequate for speech but not
   ideal for music. A polyphase or sinc resampler would produce better results if music
   capture becomes a use case.

6. **No structured error codes in IPC.** Errors are string messages. Typed error codes
   would let the TS side react to specific failure modes programmatically.

---

## Changes Made in This Audit

### Cargo.toml
- Edition `2021` → `2024`
- Version `0.2.0` → `0.3.0`
- Added `rust-version = "1.85"`
- Added `[lints.rust]`: `unsafe_code = "warn"`
- Added `[lints.clippy]`: `all` + `pedantic` with targeted allows for audio-specific patterns

### ipc.rs
- Fixed IPC writer to detect and break on write errors (was `let _ = out.write_all(...)`)
- Added doc comments clarifying control vs lossy message semantics
- Added `#[allow(clippy::struct_field_names)]` on `VoiceStateData`

### asr.rs
- Replaced `.expect()` on `serde_json::Value::as_object_mut()` with direct `serde_json::Map` construction
- Converted `match` to `let...else`

### music.rs
- Enhanced SAFETY comment on `unsafe killpg` with full invariant documentation
- Fixed edition 2024 match ergonomics
- Converted `match` to `let...else`

### dave.rs
- Fixed edition 2024 reference pattern in `.find()` closure

### voice_conn.rs
- Added justified `#[allow]` for `large_enum_variant`, `too_many_arguments`, `too_many_lines`
- Converted multiple `match`/`if let..else` to `let...else`

### main.rs
- Added justified `#[allow(clippy::too_many_lines)]` on `main()`
- Moved `const` before `let` statements (items_after_statements)
- Merged identical match arms
- Renamed `new_sid`/`old_sid`/`new_uid` to descriptive names
- Converted remaining `if let...else` to `let...else`

### audio_pipeline.rs
- Added `with_capacity(48_000)` to both `VecDeque` buffers

### All files
- Bulk clippy auto-fixes: `uninlined_format_args`, `redundant_closure_for_method_calls`,
  `unnecessary_map_or` → `is_none_or`/`is_some_and`, `implicit_clone`, `len_zero` → `is_empty`

---

## Summary

The clankvox codebase has matured significantly since the original B- assessment. Module
extraction reduced `main.rs` from 2,299 to 1,193 lines. Per-SSRC Opus decoders,
`MusicState` struct, typed IPC messages, and `killpg` fixes addressed the most critical
issues. This audit added edition 2024, pedantic clippy with zero warnings, IPC write error
handling, eliminated `.expect()` panic risks, and pre-allocated audio buffers.

The remaining concerns are structural (large event loop, TS-side `any` types, no reconnect)
rather than correctness or safety issues. For a ~4,500-line real-time voice engine handling
Discord's full voice protocol stack including DAVE E2EE, the code quality is solid.
