# Clankvox — Remaining Work

**Updated:** March 6, 2026 (post-reconciliation of `audit/rust-review` + `rust-review-20260306`)

---

## Completed in this round

The following items from the original remaining-work list have been **fully addressed**:

- **`unwrap()` in `try_connect`** — All bare `unwrap()` calls replaced with `let...else`
  patterns returning `TryConnectOutcome::MissingData`. Zero bare `.unwrap()` calls remain
  in the codebase. `PendingConnect` renamed to `PendingConnection`.
- **Type the TS client** — `clankvoxClient.ts` now has zero `any` types. Full discriminated
  union types (`ClankvoxCommand`), typed params (`ConnectAsrOptions`, `ClankvoxSpawnOptions`),
  structural guild type (`ClankvoxGuildLike`), and typed IPC error codes.
- **Structured IPC error codes** — `ErrorCode` enum on the Rust side (5 variants), matching
  `ClankvoxIpcErrorCode` union type on TS side, with `send_error(code, message)` helper.

---

## 1. Extract `main.rs` into `AppState` + handler functions (High Priority)

The `main()` function is **1,026 lines** with a **951-line `select!` loop** sharing **~22
mutable local variables**. This is the single biggest code quality issue in clankvox. It
carries `#[allow(clippy::too_many_lines)]` to suppress the pedantic warning.

### Why it's tricky

All the match arms mutate shared state in the same scope. The arms aren't independent —
for example, the IPC `SetMusic` handler writes to `music_state`, which the 20ms audio
tick arm reads to mix frames, which the voice event arm uses to decide whether to drain
buffers. Naively extracting functions hits borrow checker issues because multiple handlers
need `&mut` access to overlapping state.

### Recommended approach

1. **Create an `AppState` struct** that owns all the mutable state currently living as
   `let mut` bindings in `main()`:
   ```rust
   struct AppState {
       voice_conn: Option<VoiceConnection>,
       audio_pipeline: AudioPipeline,
       music_state: MusicState,
       ssrc_map: HashMap<u32, u64>,
       user_capture_states: HashMap<u64, UserCaptureState>,
       asr_txs: HashMap<u64, mpsc::UnboundedSender<AsrCommand>>,
       speaking_states: HashMap<u64, SpeakingState>,
       self_user_id: Option<u64>,
       pending_connection: PendingConnection,
       reconnect_deadline: Option<Instant>,
       reconnect_attempt: u32,
       buffer_depth_tick_counter: u32,
       buffer_depth_was_nonempty: bool,
       tts_playback_buffered: bool,
       // ... remaining locals
   }
   ```

2. **Extract handler methods on `AppState`:**
   - `handle_ipc_msg(&mut self, msg: InMsg, ...)` — dispatch the ~16 IPC message types
   - `handle_voice_event(&mut self, event: VoiceEvent, ...)` — handle voice connection events
   - `handle_asr_exit(&mut self, user_id: u64, reason: String)`
   - `on_audio_tick(&mut self)` — the 20ms send tick (mixing, encoding, sending)
   - `handle_reconnect(&mut self)` — reconnect timer expiry

3. **The `select!` loop shrinks to ~50 lines** — each arm calls one method on `&mut state`.

4. **Each handler becomes independently testable** — construct an `AppState` in a test,
   call the handler, assert on state changes.

### Watch out for

- The `send_msg` closure captures the IPC sender. It should become a field on `AppState`
  or a method, not a closure.
- Some arms spawn tasks (`tokio::spawn`) that hold references to channels. These channels
  should be fields on `AppState` rather than captured locals.
- The `voice_conn` is `Option<VoiceConnection>` and many arms do `if let Some(vc) = &mut voice_conn`.
  This pattern is fine on `AppState` — just `if let Some(vc) = &mut self.voice_conn`.
- Don't try to split into multiple structs prematurely. One `AppState` with methods is
  the right first step. Sub-structs can come later if needed.

### Validation

- All 20 existing tests must still pass
- Zero clippy warnings must be maintained (pedantic is configured in Cargo.toml)
- Manual smoke test in a voice channel to confirm no regressions

---

## 2. Voice WebSocket reconnect improvements (Medium Priority, Medium Effort)

**What's already done:** Basic reconnect-with-exponential-backoff exists. When the voice
WebSocket disconnects, clankvox schedules a reconnect (1s base, doubling up to 16s) and
re-runs `try_connect()` with a full OP0 Identify handshake. Application state (ASR
sessions, user capture states) survives across reconnects.

### What's still missing

1. **OP7 Resume path** — Every reconnect does a full fresh handshake. Discord supports
   OP7 Resume for recoverable disconnects (close code 4015), which would be faster and
   preserve the UDP session. `voice_conn.rs` would need a separate resume path.
2. **Music state loss** — `music.reset()` is called on disconnect, dropping all music
   playback state. Users hear music stop on any WS blip. Options:
   - Track playback position and re-queue after reconnect
   - Buffer music PCM across reconnects (risky — can grow unbounded)
   - Accept the gap but auto-resume from last known URL + position
3. **DAVE epoch staleness** — The DAVE manager is preserved across reconnects but
   SSRC-keyed decrypt state becomes stale. After reconnect, new SSRCs may be assigned.
   Need to clear per-SSRC decrypt state on reconnect while preserving the DAVE epoch.
4. **State cleanup on disconnect** — `ssrc_map`, `opus_decoders`, and `speaking_states`
   are cleared on disconnect. This is correct (SSRCs change) but means the first few
   seconds after reconnect have no user-to-SSRC mapping until Speaking events arrive.

### Recommended approach

1. When the WebSocket closes with a resumable code (4015), attempt OP7 Resume
2. If resume fails or the close code is non-resumable, fall through to the existing
   full reconnect (OP0)
3. For music: track playback position, auto-resume after reconnect completes
4. Clear stale SSRC-keyed state (decoders, DAVE per-user keys) on reconnect

Estimate: 1-2 days (reduced from original 2-3 since basic reconnect infra exists).

---

## 3. Clippy suppression debt in `voice_conn.rs` (Low Priority)

Several functions carry `#[allow(clippy::too_many_lines)]` or `#[allow(clippy::too_many_arguments)]`
that mask decomposition opportunities:

- `VoiceConnection::connect()` — 216 lines (threshold: 100)
- `handle_text_opcode()` — too_many_arguments + too_many_lines
- `handle_binary_opcode()` — too_many_lines
- `udp_recv_loop()` — too_many_lines
- `MusicPlayer::start()` in `music.rs` — too_many_lines
- `MusicState` — `struct_excessive_bools`

These are less impactful than the `main.rs` AppState refactor (Item 1) and the functions
are at least already extracted from main. Decompose opportunistically, not as a dedicated
effort.

---

## 4. Raw `serde_json::Value` in `ws_read_loop` (Low Priority)

The reconciliation added typed deserialization structs for handshake payloads (`HelloPayload`,
`ReadyPayload`, `SessionDescriptionPayload`, `SpeakingPayload`, etc.). However, `ws_read_loop`
(voice_conn.rs) still parses top-level messages as raw `Value` and indexes with
`v["op"].as_u64()` / `v["seq"].as_i64()`. The `d` payload is then cloned via
`serde_json::from_value(d.clone())` in `handle_text_opcode`.

A typed top-level `VoiceMessage { op: u64, d: Value, seq: Option<i64> }` struct would
eliminate raw indexing and the clone. Low priority — it works correctly, just inconsistent
with the typed approach used downstream.

---

## 5. Linear interpolation resampling (Low Priority)

`capture.rs` uses linear interpolation for sample rate conversion. Adequate for speech
but introduces aliasing artifacts on music. A polyphase or sinc resampler (e.g., the
`rubato` crate) would be better if music capture becomes a use case. Not worth doing
unless the product requires it.

---

## Priority order

1. `AppState` refactor of `main.rs` — biggest code quality win, unlocks testability
2. Voice WS reconnect improvements — OP7 Resume + music preservation when audio gaps become a problem
3. Clippy suppression debt — decompose long functions in voice_conn.rs opportunistically
4. Typed ws_read_loop messages — consistency improvement
5. Resampler upgrade — do if/when music capture is needed
