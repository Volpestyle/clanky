# Clankvox Screen Watch — Session Handoff (March 15, 2026)

## Session Summary (March 14-15 evening session)

Major progress on the screen watch pipeline. First-frame latency solved, module split done, vision scanner improved, DAVE diagnostics added. The remaining blocker is bimodal DAVE video decrypt reliability (~40% in bad sessions vs ~90% in good ones).

### Fixes Landed

1. **First-frame latency (18s → 1s)** — Thread `daveDecrypted` boolean through the pipeline (Rust → IPC → TypeScript). During bootstrap, skip passthrough frames that burn 2s ffmpeg timeouts.

2. **`decodeInFlight` blocking on vision model** — Release the decode gate after ffmpeg completes (~200ms), before the vision model ingest (~5-16s). Subsequent frames can now decode while the brain processes the previous one.

3. **Stream publish choppy playback** — Drain up to 4 video frames per 20ms tick instead of one. Prevents queue buildup when ffmpeg outputs in bursts.

4. **voice_conn.rs module split (4187 → 2747 lines)** — Extracted 7 focused modules: `transport_crypto.rs`, `rtp.rs`, `h264.rs`, `vp8.rs`, `video_state.rs`, `rtcp.rs`, `media_sink_wants.rs`. Deduplicated `MAX_VIDEO_FRAME_BYTES` and `find_next_start_code`.

5. **DAVE-ready PLI** — Send PLI/FIR immediately when DAVE session becomes ready, to get a fresh keyframe now that decryption actually works. Fixes the race where initial keyframe burst arrives before DAVE keys are ready.

6. **Periodic keyframe PLI** — Continue requesting keyframes every 4s after the first one. The per-frame ffmpeg decoder can only decode keyframes independently — without periodic PLIs, the vision scanner only ever sees one frame.

7. **ElevenLabs idle timeout reconnect** — Treat `input_timeout_exceeded` as recoverable. Attempt to reconnect the TTS WebSocket instead of killing the entire voice session.

8. **Vision scanner context window** — Scanner now sees rolling history of 8 previous observations with timestamps, not just the single previous note. Enables pattern detection and trend awareness for urgency decisions.

9. **Generous urgency threshold** — `high` urgency lowered from "dramatic events only" to "anything worth commenting on." The main brain still decides whether to actually speak.

10. **DAVE decrypt stats fix** — `decrypt_video_frame_candidates` was called on every RTP packet including mid-frame FU-A fragments (guaranteed `None`). Stats were inflated ~10x. Now skips the decrypt call entirely when no complete frame is assembled, also saving a mutex lock per fragment.

11. **DAVE trailer diagnostics** — Extract `truncated_nonce`, `supplemental_size`, and magic marker presence from the DAVE frame trailer on decrypt failure. Confirmed frame assembly is correct (has_marker=true on all failures).

### Current State

- **Screen watch pipeline:** Working end-to-end when DAVE cooperates (~90% success sessions)
- **First-frame latency:** ~1 second (DAVE-ready PLI → keyframe → ffmpeg → ingest)
- **Vision scanning:** Every 4 seconds via periodic PLI keyframe requests
- **Commentary:** Autonomous on `share_start` and `urgency=high` frames; main brain sees screen image + rolling context notes
- **ElevenLabs timeout:** Recoverable — reconnects instead of killing session

## Known Remaining Issues

### 1. Bimodal DAVE Video Decrypt Reliability

**The primary remaining blocker.** DAVE video decrypt success rate is bimodal across sessions:

| Category | DAVE Rate | PLI Works | Example Servers |
|----------|-----------|-----------|-----------------|
| Good sessions | 85-90% | Yes, keyframes arrive | c-atl06, c-atl10, c-atl11 |
| Bad sessions | ~40% | Often no keyframes | c-atl10, c-atl12, c-atl13 |

Same servers appear in both categories — it's not server-specific. The ~40% rate is consistent within bad sessions and doesn't improve over time.

#### What we confirmed:
- **Frame assembly is correct.** `has_marker=true` on every failure — the DAVE magic marker, truncated nonce, and supplemental bytes parse correctly.
- **Nonces are monotonically increasing** (2, 26, 256, 448, 683...) — no reordering.
- **Primary vs alternate candidate doesn't matter.** Swapping the extension-stripping order didn't change the rate (both variants fail at ~60%).
- **Audio decrypts fine** (99%+ success) on the same DAVE session — the CipherManager exists and has correct keys for audio.
- **The failure is at AES-GCM tag verification** — not nonce replay, not generation mismatch, not missing CipherManager.

#### Hypotheses:
1. **Video uses a different encryption path than audio in the sender's DAVE implementation.** Audio is single-packet, video is multi-packet (FU-A fragments). The sender might encrypt video frames differently from how we reassemble them.
2. **The davey crate's nonce tracking (shared across audio+video) rejects some video nonces.** With audio at 50fps advancing `newest_processed_nonce` rapidly, late-arriving video nonces might fall outside the `missing_nonces` window. But `MAX_MISSING_NONCES=1000` should handle this.
3. **Frame-size-dependent issue.** Large frames (10-44KB, keyframes and complex P-frames) fail more often than small frames (100-2000 bytes). The `validate_encrypted_frame` check on the sender side might miss false H264 start codes deep in large ciphertext.

#### Next steps:
- **Fork or patch the davey crate** to add per-attempt logging inside `decrypt_impl`: log which step fails (`can_process_nonce`, `get_cipher`, or AES-GCM). This is the critical diagnostic gap.
- **Check if the ~40% success correlates with frame size.** Log frame bytes alongside success/failure to see if small frames decrypt and large ones don't.
- **Compare the sender's DAVE trailer structure with what `parse_frame` expects.** Capture raw frame bytes from a successful and failed decrypt and compare the trailer parsing.

### 2. Pre-existing Go Live Stream Detection

When the bot joins a voice channel where a user is already screen sharing, it doesn't detect the existing stream. The `stream_discovery_user_go_live` event only fires for NEW Go Live starts — not pre-existing ones.

**Fix:** On voice channel join, scan for existing Go Live streams via the Discord gateway's `GUILD_CREATE` voice state data or query the stream discovery cache.

### 3. Persistent ffmpeg Decoder (Deferred)

The per-frame `cat | ffmpeg` approach works but can only decode keyframes independently. P-frames need a reference frame. A persistent ffmpeg process maintaining H264 decode state would enable:
- Decoding P-frames (most frames) without keyframes
- Eliminating the ~200ms spawn overhead per frame
- Reducing PLI/keyframe dependency

This would make the periodic PLI mechanism unnecessary and solve the "bad server doesn't respond to PLI" problem.

## Key Files Reference

### Clankvox (Rust) — Post Module Split
- `src/voice_conn.rs` (2747 lines) — Orchestrator: WS/UDP loops, DAVE decrypt, depacketizer dispatch
- `src/transport_crypto.rs` — AES-256-GCM / XChaCha20 encrypt/decrypt
- `src/rtp.rs` — RTP header parsing/building, codec types, extension stripping
- `src/h264.rs` — H.264 FU-A/STAP-A depacketizer, Annex-B helpers
- `src/vp8.rs` — VP8 depacketizer
- `src/video_state.rs` — Video stream metadata, OP12/OP18 handling
- `src/rtcp.rs` — RTCP header building, protected packet construction
- `src/media_sink_wants.rs` — OP15 media sink wants payload
- `src/dave.rs` — DAVE encrypt/decrypt wrapper, diagnostic logging
- `src/capture_supervisor.rs` — Video subscriptions, frame forwarding, PLI/keyframe management

### Bun (TypeScript)
- `src/voice/sessionLifecycle.ts` — Video frame handler, decode gate, `daveDecrypted` bootstrap
- `src/voice/voiceStreamWatch.ts` — Vision scanner, commentary triggers, brain context
- `src/voice/nativeDiscordVideoDecoder.ts` — ffmpeg H264/VP8 decode
- `src/voice/elevenLabsRealtimeClient.ts` — TTS WebSocket with idle timeout handling

### External References
- `davey` crate (0.1.2) at `~/.cargo/registry/src/.../davey-0.1.2/`
  - `src/cryptor/decryptor.rs` — `decrypt_impl`, nonce tracking, CipherManager selection
  - `src/cryptor/cryptor_manager.rs` — `can_process_nonce`, `get_cipher`, generation wrapping
  - `src/cryptor/frame_processors.rs` — `parse_frame`, magic marker detection, trailer parsing
  - `src/cryptor/codec_utils.rs` — H264 encrypt with unencrypted ranges
