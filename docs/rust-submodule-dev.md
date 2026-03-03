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
  voice_conn.rs  — Voice WebSocket + UDP/RTP + transport crypto (AES-256-GCM)
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
5. **OP1 Select Protocol** — send external addr + `aead_aes256_gcm_rtpsize` mode
6. **OP4 Session Description** — receive 32-byte AES secret key
7. Connection ready — emit `ready` to main process

### DAVE Handshake (on voice WS, after connection)

DAVE opcodes are handled entirely within the subprocess. The main process is not involved.

| Step | Direction | Opcode | Action |
|------|-----------|--------|--------|
| 1 | Server→Client | OP21 (JSON) | Prepare epoch: create DaveSession |
| 2 | Server→Client | OP25 (binary) | MLS external sender → `session.set_external_sender()` |
| 3 | Client→Server | OP26 (binary) | Send key package → `session.create_key_package()` |
| 4 | Server→Client | OP27 (binary) | MLS proposals → `session.process_proposals()` |
| 5 | Client→Server | OP28 (binary) | Send commit → from process_proposals result |
| 6 | Server→Client | OP29/OP30 (binary) | Announce commit / Welcome → `session.process_commit()` / `session.process_welcome()` |
| 7 | Server→Client | OP23 (JSON) | Execute transition → DAVE session is now active |

Binary voice WS frames use a 1-byte opcode prefix followed by the MLS payload.

### Transport Encryption

Discord voice v8 uses `aead_aes256_gcm_rtpsize`:
- **Nonce**: 4-byte big-endian incrementing counter, padded to 12 bytes (`[nonce_be(4), 0x00 * 8]`)
- **AAD**: Full RTP header (12+ bytes)
- **Wire format**: `[RTP header | AES-GCM ciphertext + 16-byte tag | 4-byte nonce]`

### IPC Protocol (unchanged from v0.1)

Communication with the main Bun process uses JSON-line IPC over stdin/stdout. The subprocess emits stderr for logging (via tracing). All existing IPC messages are preserved — the main process does not need any DAVE-specific changes.

### Music Playback

Music uses `yt-dlp` piped through `ffmpeg` for decoding to raw PCM:
```sh
yt-dlp -q -f bestaudio -o - '<url>' | ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 1 pipe:1
```
The decoded PCM feeds into the same outbound audio buffer as TTS, so DAVE encryption is applied transparently.

## DAVE Voice Gateway Opcodes Reference

| Opcode | Name | Direction | Format |
|--------|------|-----------|--------|
| 21 | dave_protocol_prepare_epoch | Server → Client | JSON |
| 22 | dave_protocol_prepare_transition | Server → Client | JSON |
| 23 | dave_protocol_execute_transition | Server → Client | JSON |
| 24 | dave_protocol_prepare_epoch | Server → Client | JSON |
| 25 | dave_mls_external_sender_package | Server → Client | Binary |
| 26 | dave_mls_key_package | Client → Server | Binary |
| 27 | dave_mls_proposals | Server → Client | Binary |
| 28 | dave_mls_commit_welcome | Client → Server | Binary |
| 29 | dave_mls_announce_commit_transition | Server → Client | Binary |
| 30 | dave_mls_welcome | Server → Client | Binary |
| 31 | dave_mls_invalid_commit_welcome | Client → Server | Binary |

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
  - *These metadata bytes must be stripped before passing data to `davey`, and the `transition_id` must be used to reply with `OP32 DaveTransitionReady`.*
- **Latency Issue Context:** For DAVE E2EE to succeed, the `DaveManager` must transmit the OP26 KeyPackage immediately after connection establishment, and must carefully parse incoming binary frames by skipping the 2-byte seq prefix.

### 2026-03-03: DAVE decrypt failures — missing OP22/OP30 handling
- **Symptom**: `NoValidCryptorFound` and `UnencryptedWhenPassthroughDisabled` errors on inbound audio
- **Root cause 1**: OP22 (Prepare Transition) was completely ignored — no OP32 response sent. Discord waits for OP32 before sending OP23 (Execute Transition), so transitions stalled and keys diverged.
- **Root cause 2**: OP30 (Welcome) failure (`AlreadyInGroup`) sent OP32 anyway instead of triggering recovery. discord.js calls `recoverFromInvalidTransition()` which reinits the session and sends OP31 + OP26.
- **Root cause 3**: No decrypt failure recovery — discord.js tracks consecutive failures and after 36 packets reinitializes the DAVE session.
- **Fix**: Implemented full transition lifecycle matching discord.js: OP22→OP32 response, OP23 execute, OP29/OP30 with pending transitions and recovery, UDP recv failure tracking with OP31+OP26 reinit.

### 2026-03-03: OP30 AlreadyInGroup causes WebSocket 4006
- **Symptom**: After implementing OP30 recovery, Discord closes the WebSocket with `code=4006 reason=Session is no longer valid` immediately after the bot sends OP31+OP26.
- **Root cause**: When the bot is the committer (processed OP27 proposals → sent OP28 commit), it already joined the MLS group via its own commit (OP29). The subsequent OP30 Welcome is redundant and `process_welcome()` returns `AlreadyInGroup`. This is **expected behavior**, not an MLS failure. Triggering `recoverFromInvalidTransition()` (OP31+OP26) for this benign error causes Discord to invalidate the session.
- **Fix**: Check the error message for `AlreadyInGroup` before deciding on recovery. For `AlreadyInGroup`, treat it as success and store the pending transition. Only trigger reinit+OP31+OP26 for genuine MLS failures.

### 2026-03-03: Transition ACK alignment with discord.js
- **Symptom**: Voice join succeeds, but inbound audio logs repeated `NoValidCryptorFound`, `UnencryptedWhenPassthroughDisabled`, and `Opus(InvalidPacket)` with no OP23 transition execution observed.
- **Root cause 1**: Rust diverged from current `discord.js` behavior. For successful non-zero OP29/OP30 transitions, `discord.js` sends `OP32 DaveTransitionReady`, but Rust only sent OP32 from OP22.
- **Root cause 2**: Transition `id=0` was being stored as pending after commit/welcome processing. That leaves stale pending state and suppresses decrypt-failure recovery logic.
- **Root cause 3**: Some live sessions never emit OP23 after OP22 downgrade prepare. Keeping `protocol_version=1` indefinitely in that case causes continuous DAVE decrypt failures on plaintext user audio.
- **Root cause 4**: Non-Opus RTP payload types were not filtered before decode, so non-audio packets could reach Opus decode.
- **Root cause 5**: Transport AAD sizing assumed fixed RTP header lengths and ignored CSRC count, causing intermittent AES-GCM decrypt failures on packets with variable header structure.
- **Root cause 6**: Bypassing DAVE `decrypt` early when `protocol_version=0` broke the DAVE passthrough window where the other side is still sending encrypted packets during transition. DAVE's `decrypt` intrinsically handles passthrough and auto-strips encryption when ready.
- **Root cause 7**: The extension length logic was incorrectly reading the length from the encrypted payload bytes instead of looking up the unencrypted AAD portion first.
- **Root cause 8**: DAVE `encrypt_opus` was still applying DAVE encryption to outbound audio (TTS) even after `protocol_version=0` (downgrade) was executed, making the bot inaudible to others.
- **Fix**: (1) Send OP32 for successful non-zero OP29/OP30 transitions, (2) treat transition `id=0` as immediate (do not keep it pending), (3) auto-execute non-zero `pv=0` downgrades after OP22 while still sending OP32 (fallback for missing OP23), (4) drop non-Opus RTP payload types before decode, (5) compute transport AAD from RTP header flags + CSRC count with stricter extension bounds checks, (6) realigned `can_decrypt` logic strictly with `discord.js` (`session.ready && (pv !== 0 || session.canPassthrough(userId))`), (7) correctly extract the extension length by reading the length directly from the unencrypted `packet` buffer instead of looking for it inside the already-decrypted payload body, and (8) correctly skip `encrypt_opus` when `protocol_version == 0` so TTS audio is sent in plaintext when DAVE is disabled.

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
