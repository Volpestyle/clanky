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
