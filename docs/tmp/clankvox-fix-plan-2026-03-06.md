# Clankvox Fix Plan — 2026-03-06

## Scope

- Package: `src/voice/clankvox`
- Basis: first-pass crate audit + second-pass audit focused on concurrency, unsafe, and error handling

## Priority Summary

### P0 — Fix now

1. **Make `VoiceConnection` shutdown real cancellation, not just a flag**
   - Problem:
     - `shutdown()` only flips an atomic flag.
     - background tasks are detached and not joined.
     - read loops only observe shutdown after waking from network I/O.
   - Risks:
     - stale websocket / UDP tasks outlive reconnects
     - duplicate or stale voice events
     - reconnect wedge when `voice_conn.is_some()` remains true
   - Files:
     - `src/voice/clankvox/src/voice_conn.rs:473`
     - `src/voice/clankvox/src/voice_conn.rs:494`
     - `src/voice/clankvox/src/voice_conn.rs:560`
     - `src/voice/clankvox/src/voice_conn.rs:581`
     - `src/voice/clankvox/src/voice_conn.rs:624`
     - `src/voice/clankvox/src/voice_conn.rs:746`
     - `src/voice/clankvox/src/voice_conn.rs:1350`
   - Concrete fix:
     - store `JoinHandle`s inside `VoiceConnection`
     - add active cancellation (`CancellationToken` or task abort)
     - actively close the connection resources on shutdown
     - wait for task termination before replacing `voice_conn`

2. **Unify terminal voice failures into one disconnect/reconnect path**
   - Problem:
     - `VoiceEvent::Error` is surfaced but does not tear down connection state or schedule reconnect.
     - write-loop failures exit silently.
     - UDP recv errors are retried forever.
   - Risks:
     - system can get stuck in a pseudo-connected state
     - `try_connect()` returns `AlreadyConnected` while transport is dead
   - Files:
     - `src/voice/clankvox/src/voice_conn.rs:792`
     - `src/voice/clankvox/src/voice_conn.rs:1315`
     - `src/voice/clankvox/src/voice_conn.rs:1322`
     - `src/voice/clankvox/src/voice_conn.rs:1354`
     - `src/voice/clankvox/src/main.rs:746`
     - `src/voice/clankvox/src/main.rs:766`
     - `src/voice/clankvox/src/main.rs:1151`
   - Concrete fix:
     - classify transport-loop exits as fatal unless clearly recoverable
     - emit one authoritative disconnect/fatal event
     - clear `voice_conn` and schedule reconnect from the same path

3. **Give ASR sessions explicit shutdown and task ownership**
   - Problem:
     - `DisconnectAsr` and replacement only remove the sender.
     - old ASR tasks can remain alive waiting on websocket input.
     - stale tasks can later emit misleading disconnect notifications.
   - Risks:
     - leaked live websocket sessions
     - external resource / billing leakage
     - false `AsrDisconnected` events after replacement
   - Files:
     - `src/voice/clankvox/src/main.rs:536`
     - `src/voice/clankvox/src/main.rs:543`
     - `src/voice/clankvox/src/main.rs:555`
     - `src/voice/clankvox/src/main.rs:827`
     - `src/voice/clankvox/src/asr.rs:97`
     - `src/voice/clankvox/src/asr.rs:124`
   - Concrete fix:
     - add an explicit `Shutdown` ASR command or cancellation token
     - make closed command channels terminate the task cleanly
     - store per-user task handles and abort/join them on disconnect/reconnect
     - only emit `AsrDisconnected` for the currently registered session

### P1 — Fix soon

4. **Make user capture subscription semantics explicit and correct**
   - Problem:
     - `unsubscribe_user` removes state, but incoming audio recreates it automatically.
     - one subscription also mutates future default capture settings globally.
   - Risks:
     - unsubscribe is ineffective
     - API behavior is surprising and hard to reason about
   - Files:
     - `src/voice/clankvox/src/main.rs:380`
     - `src/voice/clankvox/src/main.rs:400`
     - `src/voice/clankvox/src/main.rs:661`
     - `src/voice/clankvox/src/main.rs:723`
   - Concrete fix:
     - separate "subscription registry" from "active capture state"
     - only emit `UserAudio` / `UserAudioEnd` for subscribed users
     - stop using one user subscription to mutate global defaults for unrelated users

5. **Reject malformed Opus instead of turning parse failure into PLC**
   - Problem:
     - invalid Opus payloads become `None`, which decoder may treat as packet loss concealment.
   - Risks:
     - false `SpeakingStart`
     - fake `UserAudio` from corrupt frames
   - Files:
     - `src/voice/clankvox/src/main.rs:689`
     - `src/voice/clankvox/src/main.rs:695`
     - `src/voice/clankvox/src/main.rs:705`
   - Concrete fix:
     - fail fast if `OpusPacket::try_from(...)` fails
     - only allow PLC when packet loss is explicitly modeled, not for malformed payloads

6. **Remove blocking IPC sends from async hot paths**
   - Problem:
     - control messages use blocking `crossbeam::Sender::send` from async runtime paths.
   - Risks:
     - stdout/writer backpressure can stall heartbeats, reconnect handling, or control flow
   - Files:
     - `src/voice/clankvox/src/ipc.rs:249`
     - `src/voice/clankvox/src/ipc.rs:262`
   - Concrete fix:
     - move to non-blocking enqueue + dedicated writer bridge
     - or isolate blocking sends to a dedicated thread-facing boundary
     - define clear drop/backpressure behavior for each message class

### P2 — Cleanup after behavior is stable

7. **Reduce process-group signaling risk in music shutdown**
   - Problem:
     - `killpg` targets a cached PID / process group and can race child exit.
   - Risks:
     - PID reuse could signal the wrong process group
   - Files:
     - `src/voice/clankvox/src/music.rs:122`
     - `src/voice/clankvox/src/music.rs:280`
   - Concrete fix:
     - prefer owning and shutting down the actual child/pipeline supervisor directly
     - if keeping `killpg`, tighten synchronization around stop/wait and check return values
   - Note:
     - this is a real process-lifecycle risk, but not a Rust memory-unsoundness finding

8. **Fix remaining Clippy/test hygiene issues**
   - Problem:
     - `cargo clippy --all-targets -- -D warnings` currently fails on test code.
   - File:
     - `src/voice/clankvox/src/dave.rs:448`
   - Concrete fix:
     - replace unchecked `Instant - Duration` with checked subtraction or equivalent safe test setup

9. **Refactor `main.rs` into `AppState` after P0/P1 bugs are fixed**
   - Existing note:
     - `docs/tmp/clankvox-remaining-work.md`
   - Why after the bugs:
     - the refactor is still the right direction, but it should not preserve the current broken lifecycle semantics
   - Target outcome:
     - shrink the `select!` loop
     - centralize state transitions
     - make handlers directly testable

## Validation Plan

After each major fix group:

1. `cargo check --manifest-path src/voice/clankvox/Cargo.toml`
2. `cargo test --manifest-path src/voice/clankvox/Cargo.toml`
3. `cargo clippy --manifest-path src/voice/clankvox/Cargo.toml --all-targets -- -D warnings`

Additional targeted validation to add while fixing:

- voice reconnect / shutdown tests for old task termination
- ASR replacement / disconnect tests proving old sessions terminate
- capture subscription tests proving unsubscribe actually suppresses `UserAudio`
- malformed Opus tests proving bad payloads do not trigger speaking/audio

## Recommended Implementation Order

1. VoiceConnection cancellation + terminal error unification
2. ASR shutdown + task ownership
3. Capture subscription correctness
4. Malformed Opus handling
5. IPC backpressure redesign
6. Music process shutdown safety cleanup
7. `AppState` extraction / structural refactor
