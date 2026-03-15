# DAVE Video Decrypt Failure — Investigation & Remediation

## Status: ROOT CAUSE FOUND AND FIXED — RTP padding not stripped from decrypted payloads

### Root Cause

RTP packets with padding (P bit = 1) include trailing pad bytes inside the encrypted envelope under Discord's `rtpsize` AEAD modes. After transport decryption, the padding bytes were left in the payload and fed to the H264 depacketizer. When padding appeared on FU-A middle fragments, the extra bytes were inserted into the middle of the reassembled encrypted frame body, corrupting the ciphertext and causing AES-GCM tag verification failure on ~50-60% of video frames.

### Fix

`strip_rtp_padding()` in `rtp.rs` reads the P bit from the RTP header (byte 0, bit 5) and strips trailing pad bytes from the decrypted payload before extension stripping and depacketization. Called on every packet in the UDP recv loop immediately after transport decryption.

### Discovery Path

Byte-level frame dumps (`ok_head`/`ok_tail` vs `fail_head`/`fail_tail`) revealed that successful frame #4 had `0e 0e 0e 0e...` (14 bytes of value `0x0e`) trailing after the DAVE `FA FA` marker — classic RFC 3550 RTP padding where the last byte is the pad count. The padded frame was silently passing through as "unencrypted" because `parse_frame` couldn't find the marker at `frame[len-2..]`. Meanwhile, frames where padding landed on middle FU-A fragments (not the last) had corrupted ciphertext and failed DAVE decrypt.

## What's Working

- **Persistent H264 decoder** in clankvox decodes non-IDR P-frames via OpenH264 with error concealment (`ERROR_CON_SLICE_COPY_CROSS_IDR`)
- **Raw API bypass** — OpenH264 Rust wrapper treats `dsDataErrorConcealed` (state 32) as fatal, but it means "decoded with concealment." We call the C API directly and accept concealed frames
- **JPEG encoding** via turbojpeg, base64 IPC to TypeScript, direct ingest to vision model — no ffmpeg subprocess
- **Frame diff scoring** (coarse luma grid, EMA smoothing, scene cut detection) for smart commentary triggers
- **Rate-limited emission** at configured FPS (default 2) while feeding every frame to the decoder to maintain reference state

## The Problem: DAVE Video Decrypt Failures

Consistent ~45-55% failure rate on video frame DAVE decryption across all sessions observed:

```
dave_video_decrypt_ok=1279  dave_video_decrypt_fail=1521  success_pct=45
```

The error: `no valid cryptor manager could be found for VIDEO`

### What this causes

When the decoder loses P-frames to DAVE failures, subsequent P-frames that reference the lost frames produce concealed (corrupted) output. The artifacts accumulate and persist until an IDR keyframe arrives (which Discord rarely sends). The bot sees "massive graphical corruption" and "abstract art" — it can identify the application but not fine details.

### What we know

- **Audio decrypts at 99%+** on the same DAVE session — keys and cipher manager are correct
- **Frame assembly is correct** — `has_marker=true` on all failures, nonces are monotonic
- **Primary vs alternate candidate doesn't matter** — both fail at the same rate
- **Not server-specific** — same failure rate across different Discord voice servers
- **The failure is at AES-GCM tag verification** — not nonce replay or generation mismatch
- **Pattern:** failures come in bursts of 3-10 consecutive packets, suggesting temporal correlation (possibly related to sender-side DAVE key rotation or RTP extension changes)

### Hypotheses investigated

#### 1. Depacketize-then-decrypt vs Decrypt-then-depacketize (NEW LEADING HYPOTHESIS)

The DAVE protocol spec describes: `encode → DAVE encrypt → packetize → SRTP encrypt → send` and the reverse `receive → SRTP decrypt → depacketize → DAVE decrypt → decode`. Our pipeline follows this spec.

However, an exhaustive code review reveals that if the **Discord desktop client encrypts at the per-RTP-packet level** (each individual RTP payload gets its own DAVE trailer) rather than per-frame, our depacketize-then-decrypt approach would produce corrupted frames. The depacketizer would assemble packets containing DAVE trailers, and the resulting "frame" would not match what any single encrypt call produced.

**Diagnostic deployed:** A per-packet DAVE marker probe (`clankvox_per_packet_dave_marker_probe`) checks the first 500 video RTP payloads for the `0xFA 0xFA` DAVE marker. If a significant percentage have markers, it confirms per-packet encryption.

**Fix deployed:** When an individual RTP payload has a DAVE marker, we now try per-packet DAVE decrypt BEFORE depacketization. If per-packet decrypt succeeds, the depacketizer receives plain H264 data, and the assembled frame bypasses frame-level DAVE decrypt. This "decrypt-then-depacketize" path coexists with the standard "depacketize-then-decrypt" path.

#### 2. Start code mismatch (ELIMINATED)

The DAVE `process_frame_h264` always writes 4-byte start codes (`00 00 00 01`), matching our `H264Depacketizer::append_start_code`. The spec explicitly states: "Any 3 byte start codes in the unencrypted sections of the frame are replaced with a 4 byte start code." Both sides agree.

#### 3. RTP extension stripping inconsistency (ELIMINATED)

Under Discord's `rtpsize` AEAD mode, the extension prefix is authenticated (AAD) and the extension body is encrypted with the media payload. Our `strip_rtp_extension_payload` correctly reads `ext_len` from the unencrypted extension prefix and strips that many words from the decrypted payload. This is consistent regardless of whether different packets in the same frame have different extension sizes.

#### 4. Nonce window / audio-video interleaving (ELIMINATED)

The davey `Encryptor` uses a single `truncated_nonce` counter shared between audio and video. The `Decryptor` has a single `CipherManager` per user with shared nonce tracking. The `MAX_MISSING_NONCES=1000` window provides ~12 seconds of slack at 80 nonces/sec (50 audio + 30 video). Video frames that take time to assemble from FU-A fragments would still have their nonces in the missing_nonces window.

However, if the Discord client uses **separate** nonce counters per media type (separate encryptors for audio and video), the nonces would collide. Audio nonce N and video nonce N would be the same value, and the nonce replay protection would reject the video nonce after audio nonce N was processed. This would cause near-100% failure (not 45-55%), so it doesn't fully explain the observed rate — unless the counters are close but offset.

#### 5. SPS/PPS prepend timing (ALREADY FIXED)

The `H264Depacketizer` deliberately does NOT prepend cached SPS/PPS before DAVE decrypt, as this would shift the byte offsets that the DAVE trailer's unencrypted ranges reference. SPS+PPS prepend happens AFTER DAVE decrypt in the UDP recv loop (voice_conn.rs:2685-2691).

#### 6. Frame processor tag leak (ELIMINATED)

The davey `InboundFrameProcessor` pool reuses processors. `clear()` doesn't clear `self.tag`, but `parse_frame` reassigns it unconditionally. If `parse_frame` fails early, `encrypted` stays false and `decrypt_impl` is never called. No stale tag leak.

### Enhanced diagnostic logging deployed

The failed decrypt log now includes:
- `trailer_supp_size`: the supplemental bytes size from the DAVE trailer
- `internal_marker_count`: count of `0xFA 0xFA` sequences within the frame body — if > 1, the sender encrypted per-NAL or per-packet and our assembly concatenated multiple DAVE trailers
- `trailer_hex_tail`: hex dump of the last 24 bytes for trailer inspection
- `frame_hex_head`: hex dump of the first 24 bytes for start-code/NAL header inspection

## Changes Made

### voice_conn.rs (udp_recv_loop)

1. **Per-packet DAVE marker probe**: Checks first 500 video RTP payloads for `0xFA 0xFA` markers, logs hit rate as `clankvox_per_packet_dave_marker_probe`
2. **Per-packet DAVE decrypt path**: When a packet has a DAVE marker, attempts DAVE decrypt on the individual payload before depacketization. If successful, feeds decrypted H264 to the depacketizer. Assembled frames from per-packet-decrypted payloads bypass frame-level DAVE decrypt.
3. **Enhanced failure diagnostics**: Frame-level DAVE decrypt failures now log trailer hex, frame head hex, supplemental size, and internal marker count.

### capture_supervisor.rs

4. **PLI interval halved**: `PERIODIC_KEYFRAME_PLI_INTERVAL_MS` reduced from 4000ms to 2000ms. With ~45-55% frame loss from DAVE failures, the H264 reference chain accumulates corruption quickly. More frequent IDR keyframes via PLI requests help the decoder resync faster.

## Next Steps

1. **Deploy and observe** the per-packet DAVE marker probe. If `clankvox_per_packet_dave_marker_probe` shows a high hit rate (>30%), per-packet encryption is confirmed and the decrypt-then-depacketize path should resolve most failures.
2. **If per-packet probe shows low hit rate**, the issue is elsewhere. Next step would be to fork/patch the davey crate to log exactly which `decrypt_impl` step fails (can_process_nonce vs get_cipher vs AES-GCM) and whether the nonce values suggest separate audio/video counters.
3. **Monitor internal_marker_count** in the enhanced failure logs. If consistently >1 on failed frames, it confirms the assembled frame contains multiple DAVE trailers from per-packet encryption.
4. **Consider** requesting fixed keyframe intervals via Discord's `fixed_keyframe_interval` experiment flag.

## Key Files

| File | Role |
|------|------|
| `src/voice/clankvox/src/video_decoder.rs` | Persistent H264 decoder with raw OpenH264 API, error concealment, YUV→RGB→JPEG |
| `src/voice/clankvox/src/capture_supervisor.rs` | H264 path routing, decoder lifecycle, rate-limited JPEG emission |
| `src/voice/clankvox/src/ipc.rs` | `DecodedVideoFrame` IPC message variant |
| `src/voice/clankvox/src/dave.rs` | DAVE decrypt wrapper, diagnostic logging |
| `src/voice/clankvox/src/voice_conn.rs` | Frame depacketization, NAL diagnostics, DAVE decrypt dispatch, per-packet probe |
| `src/voice/sessionLifecycle.ts` | `onDecodedVideoFrame` handler, JPEG ingest to vision model |
| `src/voice/clankvoxClient.ts` | `decoded_video_frame` IPC parser |
| `davey` crate (external, `~/.cargo/registry/src/.../davey-0.1.2/`) | DAVE protocol implementation |
| `davey` codec_utils.rs | H264 unencrypted range computation, start code handling |
| `davey` frame_processors.rs | DAVE trailer parsing, authenticated/ciphertext split, frame reconstruction |
| `davey` decryptor.rs | Per-user decrypt orchestration, nonce window, cipher manager iteration |

## Bugs Found During This Investigation

1. **Case mismatch** (`capture_supervisor.rs`): `codec == "h264"` vs `VideoCodecKind::H264::as_str()` returning `"H264"`. Fixed with `eq_ignore_ascii_case`.
2. **OpenH264 wrapper overly strict**: `NativeErrorExt::ok()` treats any non-zero `DECODING_STATE` as error, including `dsDataErrorConcealed` (32) which means "decoded with concealment." Fixed by calling raw C API directly.
