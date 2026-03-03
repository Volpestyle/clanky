# Rust Voice Subprocess Development Notes

Working document for the Rust voice subprocess rewrite. Tracks breakthroughs, blockers, and architectural decisions.

## Status: DAVE Integration Complete (v0.2.0)

The Rust voice subprocess now handles the full audio pipeline including DAVE E2EE. Songbird has been replaced with a custom voice connection layer that owns the voice WebSocket directly, giving us full control over DAVE opcode processing.

**Dependency chain:**
```
voice_subprocess v0.2.0
├── davey 0.1.2         (DAVE E2EE: MLS handshake, frame encrypt/decrypt)
├── audiopus 0.3.0-rc.0 (standalone Opus encode/decode)
├── tokio-tungstenite    (voice WebSocket client)
├── aes-gcm 0.10        (transport encryption: aead_aes256_gcm_rtpsize)
├── chacha20poly1305 0.10 (transport encryption fallback: aead_xchacha20_poly1305_rtpsize)
└── tokio + serde + tracing (runtime, IPC, logging)
```

## Architecture

### Why Not Songbird?

Songbird 0.5 handles voice connection, UDP/RTP, transport crypto, and Opus encode/decode. But it does NOT:
- Support DAVE voice gateway opcodes (21-31) — they arrive on the voice WebSocket that songbird owns
- Expose hooks between Opus encode and transport encrypt (where DAVE encryption must happen)
- Forward unknown voice WS opcodes via events

Since songbird doesn't expose the voice WebSocket or audio pipeline intercept points, **we replaced songbird's Driver entirely** with our own implementation that handles voice WS, UDP/RTP, transport crypto, and DAVE as an integrated stack.

### Module Structure

```
src/
  main.rs        — IPC types, audio conversion, Opus codec, state, message loop
  voice_conn.rs  — Voice WebSocket + UDP/RTP + transport crypto (AES-256-GCM + XChaCha20-Poly1305 RTP-size)
  dave.rs        — DaveSession lifecycle wrapper around the davey crate
```

### Audio Pipeline

```
Outbound (TTS/Music → Discord):
  IPC (mono i16 LE 24kHz)
  → resample to 48kHz mono
  → PCM buffer
  → [20ms tick] Opus encode (audiopus)
  → DAVE encrypt (davey, if session ready)
  → RTP framing (seq, timestamp, SSRC)
  → AES-256-GCM transport encrypt
  → UDP send

Inbound (Discord → ASR):
  UDP receive
  → AES-256-GCM transport decrypt
  → RTP parse (extract SSRC, payload)
  → DAVE decrypt (davey, using SSRC→userId mapping)
  → Opus decode (audiopus, stereo 48kHz)
  → downmix to mono, resample to 24kHz
  → base64 encode
  → IPC send as user_audio
```

### Voice WebSocket Protocol (v8)

The subprocess connects to Discord's voice WebSocket at `wss://{endpoint}/?v=8`, which enables DAVE support. The handshake flow:

1. **OP8 Hello** — receive heartbeat interval
2. **OP0 Identify** — send server_id, user_id, session_id, token, `max_dave_protocol_version: 1`
3. **OP2 Ready** — receive SSRC, UDP endpoint, encryption modes
4. **UDP IP Discovery** — STUN-like hole-punch to find external IP/port
5. **OP1 Select Protocol** — send external addr + selected transport mode (`aead_aes256_gcm_rtpsize` preferred, `aead_xchacha20_poly1305_rtpsize` required fallback)
6. **OP4 Session Description** — receive 32-byte AES secret key
7. Connection ready — emit `ready` to main process

For v8, heartbeats (OP3) and resume (OP7) should include `seq_ack` with the last sequence-numbered gateway message.

### DAVE Handshake (on voice WS, after connection)

DAVE opcodes are handled entirely within the subprocess. The main process is not involved.

| Step | Direction | Opcode | Action |
|------|-----------|--------|--------|
| 1 | Server→Client | OP24 (JSON) | Prepare epoch: initialize/update local DAVE epoch state |
| 2 | Server→Client | OP25 (binary) | MLS external sender package → `session.set_external_sender()` |
| 3 | Client→Server | OP26 (binary) | Send key package → `session.create_key_package()` |
| 4 | Server→Client | OP27 (binary) | MLS proposals → append/revoke, then build commit/welcome |
| 5 | Client→Server | OP28 (binary) | Send MLS commit (+ optional welcome) |
| 6 | Server→Client | OP29/OP30 (binary) | Announce winning commit / welcome → `process_commit()` / `process_welcome()` |
| 7 | Client→Server | OP23 (JSON) | Transition ready ACK for prepared transition |
| 8 | Server→Client | OP22 (JSON) | Execute transition; switch active protocol/epoch context |

Downgrades to non-E2EE are prepared with OP21 (Prepare Transition, e.g. protocol version 0), acknowledged with OP23, then executed via OP22.

Binary voice WS frames use `[seq?: u16 BE][opcode: u8][payload]`, where `seq` is present on server→client binary frames.

### Transport Encryption

Discord voice v8 uses RTP-size AEAD transport modes (`aead_aes256_gcm_rtpsize` preferred, `aead_xchacha20_poly1305_rtpsize` always supported):
- **Nonce**: 4-byte big-endian incrementing counter (`nonce_be`) with mode-specific expansion:
  - AES-256-GCM RTP-size: `[nonce_be(4), 0x00 * 8]` (12 bytes)
  - XChaCha20-Poly1305 RTP-size: `[nonce_be(4), 0x00 * 20]` (24 bytes)
- **AAD**: Full RTP header (12+ bytes)
- **Wire format**: `[RTP header | AES-GCM ciphertext + 16-byte tag | 4-byte nonce]`

### IPC Protocol (unchanged from v0.1)

Communication with the main Bun process uses JSON-line IPC over stdin/stdout. The subprocess emits stderr for logging (via tracing). All existing IPC messages are preserved — the main process does not need any DAVE-specific changes.

### Music Playback

Music uses `yt-dlp` piped through `ffmpeg` for decoding to raw PCM:
```sh
yt-dlp --no-warnings --quiet --no-playlist --extractor-args 'youtube:player_client=android' -f bestaudio/best -o - '<url>' | ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 1 pipe:1
```
The decoded PCM feeds into the same outbound audio buffer as TTS, so DAVE encryption is applied transparently.

## DAVE Voice Gateway Opcodes Reference

| Opcode | Name | Direction | Format |
|--------|------|-----------|--------|
| 21 | DaveProtocolPrepareTransition | Server → Client | JSON `{transition_id, protocol_version}` |
| 22 | DaveProtocolExecuteTransition | Server → Client | JSON `{transition_id}` |
| 23 | DaveProtocolTransitionReady | Client → Server | JSON `{transition_id}` |
| 24 | DaveProtocolPrepareEpoch | Server → Client | JSON `{transition_id, epoch, protocol_version}` |
| 25 | DaveMlsExternalSenderPackage | Server → Client | Binary |
| 26 | DaveMlsKeyPackage | Client → Server | Binary |
| 27 | DaveMlsProposals | Server → Client | Binary |
| 28 | DaveMlsCommitWelcome | Client → Server | Binary |
| 29 | DaveMlsAnnounceCommitTransition | Server → Client | Binary |
| 30 | DaveMlsWelcome | Server → Client | Binary |
| 31 | DaveMlsInvalidCommitWelcome | Client → Server | Binary |

## Findings Log

### 2026-03-02: Songbird has no DAVE support
- Songbird 0.5 only handles transport-level crypto (AES-256-GCM, XChaCha20)
- DAVE E2EE is a separate inner layer that songbird is unaware of
- `VoiceTick` decoded audio is garbage when DAVE is active (Opus frames are still encrypted)

### 2026-03-02: Self-audio feedback loop
- When the bot pre-arms voice playback, songbird sets speaking state to MICROPHONE
- The bot's own SSRC appears in VoiceTick.speaking, creating an infinite feedback loop
- **Fix**: Filter out the bot's own user ID in both speaking and audio handlers

### 2026-03-02: Stdout IPC contention from event handlers
- Multiple handlers calling `stdout().lock()` simultaneously caused contention
- **Fix**: Dedicated crossbeam IPC output channel with a single writer thread

### 2026-03-02: Opus build requires static compilation on arm64 macOS
- Homebrew opus at `/usr/local/Cellar/opus/1.6/` is x86_64, not arm64
- **Fix**: `OPUS_STATIC=1 OPUS_NO_PKG=1 cargo build --release`

### 2026-03-02: Gateway adapter proxy requires OP4 from subprocess
- The Rust subprocess must explicitly send `adapter_send` with OP4 payload
- Without this, the subprocess never receives voice_server/voice_state

### 2026-03-02: davey crate does NOT require patched OpenMLS for published version
- Published crate on crates.io (v0.1.2) pins `openmls = "=0.7.2"` and works out of the box
- Just `davey = "0.1.2"` in Cargo.toml — no patches needed

### 2026-03-02: Architecture decision — replace songbird
- Songbird does not expose the voice WebSocket or hooks between Opus encode and transport encrypt
- No way to intercept DAVE opcodes or inject DAVE-encrypted frames without forking songbird
- Decision: replace songbird's Driver with custom voice WS + UDP + transport crypto
- Keep the same IPC protocol so the main process needs no changes

### 2026-03-03: DAVE WebSocket Nuances and Handshake Blockers
- **`max_dave_protocol_version`:** Discord voice servers *will not* initiate the DAVE MLS handshake unless the client includes `"max_dave_protocol_version": 1` in the initial `OP0 Identify` JSON payload.
- **Client OP26 Initiation:** Discord's DAVE documentation implies the server begins the handshake (by sending OP21 / OP25). While the server does send OP21 (`dave_protocol_prepare_epoch`), it waits for the client to send an **`OP26 DaveMlsKeyPackage`** binary WS frame before it will reply with `OP25 DaveMlsExternalSender`.
- **Binary WebSocket Frame Structure:** Beware: Discord Voice WebSocket binary frames (`OP25`, `OP27`, etc) do **not** just start with a 1-byte opcode. Discord prepends a **2-byte Big Endian sequence number** to every incoming binary frame. The format is `[ seq (2 bytes BE) | opcode (1 byte) | payload (N bytes) ]`.
- **DAVE Payload Metadata:** Beyond the sequence number and opcode, several DAVE opcodes prepend their own metadata to the payload before the TLS-encoded bytes:
  - `OP27 Proposals` prepends a 1-byte `optype` (0 for Append, 1 for Revoke). The rest of the payload is the proposals TLS string.
  - `OP29 Announce Commit` and `OP30 Welcome` prepend a 2-byte Big Endian `transition_id`. The rest is the commit or welcome TLS string.
  - *These metadata bytes must be stripped before passing data to `davey`, and the `transition_id` must be used to reply with `OP23 DaveTransitionReady`.*
- **Latency Issue Context:** For DAVE E2EE to succeed, the `DaveManager` must transmit the OP26 KeyPackage immediately after connection establishment, and must carefully parse incoming binary frames by skipping the 2-byte seq prefix.

### 2026-03-03: DAVE decrypt failures — missing OP22/OP30 handling
- **Symptom**: `NoValidCryptorFound` and `UnencryptedWhenPassthroughDisabled` errors on inbound audio
- **Root cause 1**: OP21 (Prepare Transition) was completely ignored — no OP23 response sent. Discord waits for OP23 before sending OP22 (Execute Transition), so transitions stalled and keys diverged.
- **Root cause 2**: OP30 (Welcome) failure (`AlreadyInGroup`) sent OP23 anyway instead of triggering recovery. discord.js calls `recoverFromInvalidTransition()` which reinits the session and sends OP31 + OP26.
- **Root cause 3**: No decrypt failure recovery — discord.js tracks consecutive failures and after 36 packets reinitializes the DAVE session.
- **Fix**: Implemented full transition lifecycle matching discord.js: OP21→OP23 response, OP22 execute, OP29/OP30 with pending transitions and recovery, UDP recv failure tracking with OP31+OP26 reinit.

### 2026-03-03: OP30 AlreadyInGroup causes WebSocket 4006
- **Symptom**: After implementing OP30 recovery, Discord closes the WebSocket with `code=4006 reason=Session is no longer valid` immediately after the bot sends OP31+OP26.
- **Root cause**: When the bot is the committer (processed OP27 proposals → sent OP28 commit), it already joined the MLS group via its own commit (OP29). The subsequent OP30 Welcome is redundant and `process_welcome()` returns `AlreadyInGroup`. This is **expected behavior**, not an MLS failure. Triggering `recoverFromInvalidTransition()` (OP31+OP26) for this benign error causes Discord to invalidate the session.
- **Fix**: Check the error message for `AlreadyInGroup` before deciding on recovery. For `AlreadyInGroup`, treat it as success and store the pending transition. Only trigger reinit+OP31+OP26 for genuine MLS failures.

### 2026-03-03: Transition ACK alignment with discord.js
- **Symptom**: Voice join succeeds, but inbound audio logs repeated `NoValidCryptorFound`, `UnencryptedWhenPassthroughDisabled`, and `Opus(InvalidPacket)` with no OP23 transition execution observed.
- **Root cause 1**: Rust diverged from current `discord.js` behavior. For successful non-zero OP29/OP30 transitions, `discord.js` sends `OP23 DaveTransitionReady`, but Rust only sent OP23 from OP21.
- **Root cause 2**: Transition `id=0` was being stored as pending after commit/welcome processing. That leaves stale pending state and suppresses decrypt-failure recovery logic.
- **Root cause 3**: Some live sessions never emit OP23 after OP22 downgrade prepare. Keeping `protocol_version=1` indefinitely in that case causes continuous DAVE decrypt failures on plaintext user audio.
- **Root cause 4**: Non-Opus RTP payload types were not filtered before decode, so non-audio packets could reach Opus decode.
- **Root cause 5**: Transport AAD sizing assumed fixed RTP header lengths and ignored CSRC count, causing intermittent AES-GCM decrypt failures on packets with variable header structure.
- **Root cause 6**: Bypassing DAVE `decrypt` early when `protocol_version=0` broke the DAVE passthrough window where the other side is still sending encrypted packets during transition. DAVE's `decrypt` intrinsically handles passthrough and auto-strips encryption when ready.
- **Root cause 7**: The extension length logic was incorrectly reading the length from the encrypted payload bytes instead of looking up the unencrypted AAD portion first.
- **Root cause 8**: DAVE `encrypt_opus` was still applying DAVE encryption to outbound audio (TTS) even after `protocol_version=0` (downgrade) was executed, making the bot inaudible to others.
- **Fix**: (1) Send OP23 for successful non-zero OP29/OP30 transitions, (2) treat transition `id=0` as immediate (do not keep it pending), (3) auto-execute non-zero `pv=0` downgrades after OP21 while still sending OP23 (fallback for missing OP22), (4) drop non-Opus RTP payload types before decode, (5) compute transport AAD from RTP header flags + CSRC count with stricter extension bounds checks, (6) realigned `can_decrypt` logic strictly with `discord.js` (`session.ready && (pv !== 0 || session.canPassthrough(userId))`), (7) correctly extract the extension length by reading the length directly from the unencrypted `packet` buffer instead of looking for it inside the already-decrypted payload body, and (8) correctly skip `encrypt_opus` when `protocol_version == 0` so TTS audio is sent in plaintext when DAVE is disabled.

### 2026-03-03: DAVE text opcode mapping was wrong — inbound audio completely broken
- **Symptom**: Bot could never decrypt inbound user audio. `NoValidCryptorFound` on every packet, OP23 "execute transition" never arrived. After auto-execute workaround, `Opus(InvalidPacket)` on every frame.
- **Root cause**: The voice WS text opcode handlers had opcodes 21–24 mapped incorrectly:
  - OP21 was handled as `PrepareEpoch` (should be `DavePrepareTransition`)
  - OP22 was handled as `PrepareTransition` (should be `DaveExecuteTransition`)
  - OP23 was handled as `ExecuteTransition` (should be `DaveTransitionReady`, client→server only)
  - OP24 was not handled (should be `DavePrepareEpoch`)
- **Effect 1**: OP21 (`DavePrepareTransition` with `{transition_id, protocol_version}`) was silently dropped by the old PrepareEpoch handler because `protocol_version=0` failed the `if pv > 0` check. The bot never prepared for the transition.
- **Effect 2**: OP22 (`DaveExecuteTransition` with `{transition_id}`) was misinterpreted as PrepareTransition. The bot called `prepare_transition()` with `pv=0` (missing field defaulted) instead of `execute_transition()`. The transition was never finalized.
- **Effect 3**: The bot was sending OP32 (non-existent opcode) instead of OP23 (`DaveTransitionReady`) to acknowledge transitions. Discord ignored the OP32 and never sent `DaveExecuteTransition` for subsequent transitions.
- **Fix**: Corrected opcode mapping to match `discord-api-types/voice/v8`: OP21=PrepareTransition, OP22=ExecuteTransition, OP23=TransitionReady (client→server), OP24=PrepareEpoch. Updated all OP32 sends to OP23.

### 2026-03-03: Long-lived call regression — plaintext frames during pv=1
- **Symptom**: Join/greeting/transcription worked, then after ~20-60s inbound user audio dropped with repeated `UnencryptedWhenPassthroughDisabled` and `no magic marker` logs.
- **Root cause**: Live sessions can intermittently deliver plaintext Opus frames while the local DAVE session still reports `protocol_version=1`. Strictly treating `UnencryptedWhenPassthroughDisabled` as fatal caused sustained frame drops.
- **Fix**: In `DaveManager::decrypt`, treat `DecryptorDecryptError::UnencryptedWhenPassthroughDisabled` as passthrough (`Ok(frame.to_vec())`) for pv>0 as well, resetting consecutive failure count.

### 2026-03-03: ASR capture gaps when speaking events are missed
- **Symptom**: User could speak and davey ratchet logs appeared, but no new `voice_activity_started`/ASR turn followed; session logged `voice_turn_finalized bytesSent=0` and `voice_turn_skipped_empty_capture`.
- **Root cause**: The JS session manager started captures only from `speaking_start`. In some runs, `user_audio` frames arrived without a matching `speaking_start`, so no capture/ASR bridge was opened.
- **Fix**: Added a `userAudio` fallback in `voiceSessionManager` that starts capture when audio arrives for a user with no active capture (`voice_capture_started_from_audio_fallback`).

## Reliability Gaps vs discord.js (Hardening Plan)

The current stack is stable enough for live use, but we still rely on a few compatibility fallbacks that indicate architectural gaps versus `discord.js` reliability.

### Key Gaps

1. **Voice lifecycle modeled as event handlers, not a strict state machine**
   - Today: join/ready/speaking/capture behavior is spread across WS handlers, UDP loops, and JS session manager callbacks.
   - Gap: ordering-sensitive behavior can drift (e.g., audio frames before speaking events).
   - Target: explicit per-session state machine (`connecting -> ready -> active -> recovering -> draining -> idle`) with deterministic transitions.

2. **Capture bootstrap depended on OP5 speaking events**
   - Today: primary capture start was `speaking_start`, with `user_audio` fallback added later.
   - Gap: OP5 is not a hard ordering guarantee; missing/late OP5 can drop ASR turns.
   - Target: audio-first capture bootstrap (`user_audio` is source of truth), OP5 used as a timing hint only.

3. **Participant and mapping model not yet a single source of truth**
   - Today: multiple places infer active speaker identity from `ssrc -> user_id`, speaking updates, and capture maps.
   - Gap: stale/missing mapping windows still occur under churn.
   - Target: canonical participant state with: `{user_id, ssrcs, speaking, last_audio_at, last_speaking_at, stream_state}` and TTL-based cleanup.

4. **Ordering variance tolerance still partly heuristic**
   - Today: several safeguards recover after divergence (decrypt passthrough, fallback capture, transition recovery).
   - Gap: correctness depends on fallback logic more than first-path deterministic handling.
   - Target: first-path behavior that is naturally order-tolerant; keep fallbacks as guardrails, not primary path.

5. **Operational surface lacks clear subsystem ownership boundaries**
   - Today: Rust and JS both influence when turns start/stop and when playback/capture are armed.
   - Gap: cross-boundary races are harder to reason about.
   - Target: Rust owns transport/crypto/packet validity; JS owns turn semantics and conversational policy; interface events become minimal and idempotent.

### Hardening Priorities

1. **Promote audio-first capture to canonical behavior**
   - Keep `speaking_start` as advisory signal; never require it for capture correctness.

2. **Implement explicit participant state manager**
   - Centralize SSRC/speaking/lifecycle and expose one read model to capture and decrypt paths.

3. **Formalize session state machine transitions**
   - Add transition guards, invariant checks, and structured logs for state transitions.

4. **Reduce fallback-only paths over time**
   - As first-path robustness improves, shrink opportunistic heuristics and keep only essential recovery mechanisms.

5. **Add targeted golden tests for ordering variance**
   - Cases: `user_audio` before OP5, missing OP5, delayed OP22, plaintext bursts in pv=1, SSRC remap churn.

### Practical Rule Going Forward

When `discord.js` and Rust behavior diverge, prefer the `discord.js` lifecycle model unless we have a clear protocol-level reason not to. In practice, this means modeling voice state as a robust state machine, maintaining mature participant/mapping state, and explicitly tolerating event ordering variance instead of assuming ideal sequencing.

### 2026-03-03: YouTube SABR/403 failures in Rust music pipeline
- **Symptom**: Music started, then subprocess exited with `status 183`; stderr showed YouTube SABR warning and `HTTP Error 403` from `yt-dlp`.
- **Root cause**: YouTube `web` client formats can be SABR-restricted and intermittently unavailable to default `yt-dlp` extraction path.
- **Fix**: Updated Rust music pipeline invocation to match the hardened Node path: `--extractor-args 'youtube:player_client=android' --no-playlist --no-warnings --quiet -f bestaudio/best`, and captured stderr tail for actionable diagnostics.

## Build Commands

```sh
# Build the Rust subprocess
cd src/voice/rust_subprocess
OPUS_STATIC=1 OPUS_NO_PKG=1 cargo build --release

# Or via package.json
bun run build:voice

# Run with debug logging
AUDIO_DEBUG=1 RUST_LOG=debug bun start
```
