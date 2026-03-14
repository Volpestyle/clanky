# Clankvox Screen Watch — Session Handoff (March 14, 2026)

## What Happened This Session

A refactoring pass on `voice_conn.rs` broke audio receive, then a deep debugging session uncovered and fixed a chain of issues through the entire screen watch pipeline. By the end, native Discord Go Live screen watch is working end to end: DAVE video decrypt, H264 decode, vision analysis, and proactive spoken commentary.

### Fixes Landed (5 commits)

1. **Transport crypto AAD mismatch** — `decrypt()` was using `parse_rtp_header`'s `header_size` as the AEAD AAD boundary, but `rtpsize` modes only authenticate the fixed header + CSRC + 4-byte extension prefix. Extension body is ciphertext. Every packet silently failed decrypt.

2. **Inbound RTCP filtering** — RTCP packets (PT 72-76, RFC 5761 mux) were hitting the RTP decrypt path and failing. Now filtered early in the UDP recv loop.

3. **MediaSinkWants OP15 format** — Refactored payload dropped `streams` and `pixelCounts` in favor of a flat map. Discord didn't recognize it and sent lowest quality video with sparse keyframes. Restored the original `{"any", "streams", "pixelCounts"}` structure.

4. **DAVE video decrypt** — SPS+PPS were prepended to frames BEFORE DAVE decrypt, shifting the byte offsets that the DAVE trailer's unencrypted ranges reference. Moved prepend to AFTER decrypt. DAVE video decrypt now works for Go Live streams.

5. **H264 keyframe detection** — Removed SPS (NAL type 7) from the `keyframe` flag since SPS+PPS are now prepended to every frame post-decrypt. This was causing every frame to bypass the 2fps rate limiter.

6. **ffmpeg H264 decode** — `cat | ffmpeg` pipe for reliable EOF delivery (Bun's `stdin.end()` unreliable under load). Timeout reduced from 8s to 2s. Added passthrough frame validation (repeated-byte padding detection, SPS profile validation).

7. **Vision model default** — `brainContextModel` changed from `claude-opus-4-6` to `claude-sonnet-4-5` for the claude-oauth preset.

### Current State

- Audio capture and ASR: fully working
- Screen share: working end to end (DAVE decrypt, decode, vision analysis, commentary)
- First-frame latency: ~18 seconds (the main remaining issue)
- Subsequent frames: ~2fps rate-limited, decode in ~200-400ms each
- Proactive commentary: triggers on `share_start`, `scene_changed`, and `silence`
- Vision scanner: Sonnet at 4-second intervals (configurable)

## Known Remaining Issues

### 1. First-Frame Decode Latency (~18 seconds)

The first DAVE-decrypted IDR keyframe takes ~18 seconds to produce a decoded JPEG, while subsequent frames decode in ~200ms. The 2-second timeout means ~9 retry cycles before success.

**Root cause hypothesis:** The `pendingH264Decode` bootstrap path in `sessionLifecycle.ts` accumulates multiple access units before attempting decode. The first IDR triggers a decode, but by the time it starts, several DAVE-failed passthrough frames have been forwarded and are being processed first. Each passthrough frame hits the 2s timeout, and only after they're exhausted does the real IDR get decoded.

**Investigation path:**
- Add logging to see which specific frame is being decoded (keyframe vs P-frame)
- The `selectNativeDiscordH264BootstrapSequence` logic might be accumulating too many frames
- Consider skipping passthrough frames entirely during bootstrap (only decode DAVE-decrypted frames)

### 2. DAVE Video Decrypt Success Rate

DAVE decrypt works for some frames but not all. From the logs:
- Frames with `has_dave_marker=true` succeed ~30-50% of the time
- Some large frames (12-24KB) consistently fail both primary and fallback candidates
- Small frames (200-1000 bytes) succeed more reliably

#### Investigation Results (March 14, 2026)

**Architecture confirmed correct:** The stream watch transport has its own `stream_watch_dave: Arc<Mutex<Option<DaveManager>>>` (separate from the voice DAVE session). Each Go Live stream is its own MLS group with independent epochs. OP25/OP27/OP29/OP30 are all handled identically for all transport roles via `handle_binary_opcode`.

**Davey crate decrypt pipeline analyzed.** The full failure chain is:

| Failure Mode | davey Error | Likely Cause |
|---|---|---|
| No decryptor for user | `NoDecryptorForUser` | Streamer's user_id not in MLS group (welcome not processed, or user_id mismatch in video_ssrc_map binding) |
| Frame not encrypted + passthrough expired | `UnencryptedWhenPassthroughDisabled` | Frame lacks `0xFA 0xFA` magic marker — either genuinely unencrypted or depacketizer corruption (missing/extra bytes at frame end) |
| No valid cryptor found (manager_count=0) | `NoValidCryptorFound` | All CipherManagers expired — epoch transition happened but welcome/commit wasn't processed |
| No valid cryptor found (manager_count>0) | `NoValidCryptorFound` | AES-GCM-128 tag mismatch — wrong epoch key, frame corruption, or generation out of range |

**Most likely root causes for the 30-50% failure rate:**

1. **Epoch transition timing** — davey gives old CipherManagers a 10-second expiry (`RATCHET_EXPIRY`) when a new epoch arrives. If the sender's client transitions to the new epoch key before the bot processes the commit/welcome, frames encrypted with the new key will fail against all managers. This affects large frames disproportionately because they span more RTP packets and are more likely to straddle an epoch boundary.

2. **Depacketization corruption** — H264 depacketization (FU-A reassembly) may produce frames with incorrect byte boundaries. If the last 2 bytes of a reassembled frame aren't `0xFA 0xFA` (the DAVE magic marker), davey treats it as unencrypted. If the supplemental bytes (tag, nonce, unencrypted ranges) are shifted by even one byte, `parse_frame()` silently returns `encrypted=false`. This would affect larger frames more because they require more RTP fragment reassembly.

3. **RTP extension stripping ambiguity** — The `strip_rtp_extension_payload` function produces both a `primary_payload` (extension stripped) and a `fallback_payload` (extension body included). If the wrong payload variant is fed to the depacketizer, the DAVE trailer at the end of the assembled frame will be at the wrong offset. The code already tries both (primary and alternate candidates), but if both produce corrupted frames, decrypt fails.

**Diagnostic logging added:**
- `dave.rs`: `decrypt_media` now logs the specific error type (`NoDecryptorForUser` vs `NoValidCryptorFound`) with user_id, known_users, frame_bytes, pv, and consecutive failure count
- `voice_conn.rs` `decrypt_video_frame_candidates`: failure log now includes `frame_bytes`, `has_dave_marker`, `candidate_count`, `known_users`, and `pv`
- `voice_conn.rs` UDP recv loop: periodic `clankvox_dave_video_decrypt_stats` log (every 100 frames) with success/fail/passthrough counts and percentage
- `dave.rs` `log_decrypt_stats`: dumps davey-internal `DecryptionStats` per user (successes, failures, passthroughs, attempts, duration_us)
- `voice_conn.rs` OP29/OP30: logs `known_users` after successful commit/welcome processing to confirm streamer is in MLS group

**Next steps for further investigation:**
- Run with the new logging and analyze: is the failure `NoDecryptorForUser` (user_id not in group) or `NoValidCryptorFound` (key mismatch)?
- If `NoValidCryptorFound` with `manager_count > 0`: check whether `has_dave_marker=true` on failed frames — if true, the frame parsed as encrypted but the key was wrong (epoch transition issue). If false, depacketization is corrupting the frame tail.
- Check davey-internal stats: compare `attempts` vs `successes` — if attempts > successes consistently, the CipherManager exists but the key doesn't match, pointing to epoch key drift
- If `NoDecryptorForUser`: compare the user_id in the video_ssrc_map binding against the known_users logged after welcome — user_id mapping may be wrong

### 3. Persistent ffmpeg Decoder (Deferred)

Per-frame `cat | ffmpeg` spawns work but add ~200ms overhead per frame. A persistent ffmpeg process that reads a continuous H264 stream would eliminate spawn overhead. However, ffmpeg's H264 raw demuxer (`-f h264`) buffers internally and doesn't flush individual frames on stdin — it needs to see the next access unit's start code or EOF.

**Options explored:**
- Direct `stdin.write()` + `stdin.end()` — works in isolated tests but unreliable under Bun's event loop contention
- `image2pipe` output — hangs, same H264 demuxer issue
- FIFO-based approach — ffmpeg dies when the writer closes
- `-update 1` file output — works with cat pipe but ffmpeg exits after stdin closes

**Possible approaches not yet tried:**
- Use `-f mpegts` as an intermediary container (has proper framing)
- Use a native H264 decoder library in Rust (decode in clankvox, forward raw RGB/JPEG)
- Use `-re` flag or frame-rate limiting on the input side
- Pre-wrap each access unit in a minimal MP4/MPEG-TS container before writing to stdin

### 4. voice_conn.rs Module Split

The file is ~4200 lines covering transport crypto, RTP parsing, H264/VP8 depacketization, DAVE integration, video state management, RTCP generation, and UDP send/receive. A bad change in any of these can break everything (as demonstrated today).

**Proposed split:**
- `transport_crypto.rs` — `TransportCrypto`, `decrypt()`, `encrypt()`, AAD computation
- `rtp.rs` — `parse_rtp_header`, `build_rtp_header`, `strip_rtp_extension_payload`
- `h264_depacketizer.rs` — `H264Depacketizer`, SPS/PPS caching, Annex-B helpers
- `vp8_depacketizer.rs` — `Vp8Depacketizer`
- `video_state.rs` — `RemoteVideoTrackBinding`, `VideoStreamDescriptor`, OP12/OP18 parsing
- `rtcp.rs` — PLI/FIR/RR construction, `build_protected_rtcp_packet`
- `media_sink_wants.rs` — OP15 payload construction
- `voice_conn.rs` — WebSocket handling, UDP recv loop, event dispatch (the orchestrator)

### 5. WebRTC Protocol Path Evaluation

`Discord-video-stream` uses `protocol: "webrtc"` with SDP for stream connections. This gives:
- Native PLI/FIR support (WebRTC stack handles RTCP feedback)
- Potentially better DAVE video handling (WebRTC normalizes frame boundaries)
- RTX retransmission for free

clankvox uses `protocol: "udp"` which means manual RTP/RTCP handling and no PLI/FIR.

**Effort estimate:** Large. Would require:
- WebRTC stack integration (libwebrtc or a Rust WebRTC crate like `webrtc-rs`)
- SDP generation for `SelectProtocol`
- Reworking the UDP recv loop to use WebRTC's frame delivery callbacks
- DAVE integration through WebRTC's frame transform API

This would be a significant architectural change but would solve PLI/FIR, RTX, and potentially the DAVE video decrypt issues.

## Key Files Reference

### Clankvox (Rust)
- `src/voice_conn.rs` — Transport protocol core (4200 lines)
- `src/dave.rs` — DAVE encrypt/decrypt wrapper with passthrough validation
- `src/capture_supervisor.rs` — Video subscriptions, frame forwarding, rate limiting
- `src/connection_supervisor.rs` — Transport role lifecycle (voice, stream_watch, stream_publish)

### Bun (TypeScript)
- `src/voice/nativeDiscordVideoDecoder.ts` — ffmpeg H264/VP8 decode to JPEG
- `src/voice/nativeDiscordScreenShare.ts` — Active sharer tracking, target resolution, bootstrap sequence
- `src/voice/sessionLifecycle.ts` — Video frame handler (`onUserVideoFrame`), decode gate (`decodeInFlight`)
- `src/voice/voiceStreamWatch.ts` — Commentary triggers, vision scanner, brain context management
- `src/settings/settingsSchema.ts` — `brainContextModel`, `brainContextMinIntervalSeconds`, etc.

### Documentation
- `docs/voice/discord-streaming.md` — Canonical screen share doc
- `docs/operations/logging.md` — Video transport diagnostic workflow
- `docs/notes/NATIVE_SCREENSHARE_NOTES.md` — Incident history and review passes
- `src/voice/clankvox/docs/go-live.md` — Clankvox-local Go Live reference
- `src/voice/clankvox/README.md` — Known limitations

### External References
- `davey` crate (crates.io 0.1.2) — DAVE MLS E2EE. Cached at `~/.cargo/registry/src/.../davey-0.1.2/`
  - `src/cryptor/frame_processors.rs` — `parse_frame()` magic marker detection
  - `src/cryptor/decryptor.rs` — `decrypt()` passthrough logic
  - `src/cryptor/codec_utils.rs` — H264 encrypt with NAL-level unencrypted ranges
- `Discord-video-stream` (`../Discord-video-stream`) — WebRTC-based Go Live sender reference
- `Discord-video-selfbot` (`../Discord-video-selfbot`) — Raw UDP Go Live sender reference

## Priority Recommendation

1. **First-frame latency** — highest impact, moderate effort. The 18-second delay dominates the user experience. Start by investigating whether passthrough frames are clogging the bootstrap decode queue.

2. **voice_conn.rs split** — medium impact, moderate effort. Reduces blast radius of future transport changes. Good maintenance work.

3. **DAVE decrypt success rate** — medium impact, requires davey crate investigation. More frames decrypting = better image quality and fewer passthrough artifacts.

4. **Persistent decoder** — medium impact, high effort. The `cat | ffmpeg` approach works at ~200ms per frame. Worth exploring only after the first-frame latency is solved.

5. **WebRTC protocol path** — high impact, very high effort. Architectural change. Evaluate only after the simpler items are exhausted.
