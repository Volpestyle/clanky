# Native Discord screenshare work-in-progress integration

This package adds a best-effort native Discord video receive path to `clankvox`.

## What is implemented

- Voice gateway video metadata handling:
  - OP12 / OP18 remote video state payload handling
  - OP14 session update / codec update handling
- Voice select-protocol video codec advertisement:
  - Opus audio
  - H264 video receive
  - VP8 video receive
- Media sink wants support:
  - OP15 `streams` / `pixelCounts`
  - runtime updates through a new `VoiceConnection::update_media_sink_wants(...)`
- Native inbound RTP video acceptance:
  - no longer hard-drops every non-Opus payload
  - recognizes H264 payload type 103 and VP8 payload type 105
- DAVE video decrypt path:
  - `DaveManager::decrypt_video(...)`
  - alternate RTP-extension fallback during frame recovery
  - best-effort SSRC remap after successful DAVE video decrypt
- Best-effort depacketization:
  - H264 single NAL, STAP-A, FU-A
  - VP8 payload descriptor stripping + frame reassembly
  - RTP sequence-gap reset to avoid cross-packet frame corruption
- New IPC contract for subscribing to remote user video and receiving frames.

## New inbound IPC messages

```json
{
  "type": "subscribe_user_video",
  "userId": "123456789012345678",
  "maxFramesPerSecond": 2,
  "preferredQuality": 100,
  "preferredPixelCount": 921600,
  "preferredStreamType": "screen"
}
```

```json
{
  "type": "unsubscribe_user_video",
  "userId": "123456789012345678"
}
```

## New outbound IPC messages

- `user_video_state`
- `user_video_frame`
- `user_video_end`

`user_video_frame.frameBase64` currently contains the compressed encoded frame payload, **not** a decoded bitmap:

- H264 frames are emitted as Annex-B byte streams
- VP8 frames are emitted as VP8 elementary bitstreams

That means your Bun runtime still needs to decode these into images before handing them to an image model, or transcode them into JPEG/PNG.

`user_video_frame` delivery is still best-effort. Frames now go through a dedicated bounded outbound video queue and can still be dropped under backpressure, but drops and recovery are logged instead of disappearing silently.

## Important current limitations

1. **Compile-tested in this environment, but not live-validated in this note.**
   - `cargo test` in `src/voice/clankvox` passes for this repo snapshot.
   - This note still does not claim a successful live Discord screenshare session end-to-end.
2. **No RTX retransmission handling yet.** RTX payload types are detected and ignored.
3. **No AV1 / H265 / VP9 receive path yet.**
4. **No decoded image pipeline in Rust yet.** Frames are emitted compressed.
5. **No multi-connection Go Live orchestration in this package.**
   - Discord Go Live / stream watching often requires a separate stream/server connection.
   - This package now has more of the low-level receive path, but your parent bot/runtime may still need to create a dedicated clankvox instance or separate connection flow for the stream voice server.
6. **Video-state semantics are best effort.** Discord's native stream metadata is still lightly documented and may vary by path/client.

## Files touched

- `src/voice_conn.rs`
- `src/dave.rs`
- `src/ipc.rs`
- `src/ipc_protocol.rs`
- `src/app_state.rs`
- `src/capture_supervisor.rs`
- `src/main.rs`
- `src/video.rs` (new)

## Suggested next step

Keep hardening the Bun-side native screen-watch path with live Discord validation, better decode/selection telemetry, and clearer product behavior around multi-sharer ambiguity.

## Review Pass 1

### 1. Critical: video depacketization currently happens before DAVE decrypt

In the UDP video path, `voice_conn.rs` currently feeds `primary_payload` into the video depacketizers before calling `decrypt_video(...)`.

That means the H264 FU-A / STAP-A parsing and VP8 payload-descriptor parsing are operating on still-encrypted bytes when DAVE is active. For DAVE-enabled video streams, this is not protocol-correct and can lead to misframed or dropped output before decrypt has a chance to recover anything.

### 2. High: no RTP sequence continuity handling for video

The receiver parses RTP sequence numbers, but the video depacketizers do not use them for gap or reorder detection.

Current consequence:

- packet loss can silently produce corrupted frames
- out-of-order packets can be appended into the wrong frame
- marker-bit flushes can emit garbage while still looking "complete"

The notes already call out missing RTX handling, but the broader correctness gap is that ordinary packet-loss and reorder are not handled either.

### 3. High: partial video-state updates can desynchronize state from live SSRC routing

`apply_remote_video_state(...)` rebuilds the live `video_ssrc_map` from only the latest payload, while the higher-level capture state preserves previous stream descriptors when an update arrives with an empty `streams` list.

That can leave the parent process believing a video stream is still active while the UDP path has already dropped the relevant SSRC binding and starts discarding packets as unknown SSRCs.

### 4. High: session-reset teardown can leave stale video state behind

When the session ID changes, the connection is torn down via `clear_voice_connection()`, but that path does not currently clear `remote_video_states` or emit `UserVideoEnd`.

Current consequence:

- stale remote video state can survive reconnect
- the next `Ready` can replay OP15 sink-wants for dead SSRCs
- parent-side state can remain out of sync with the actual live connection

### 5. High: video DAVE recovery is much weaker than audio DAVE recovery

The audio path already contains fallback logic for alternate RTP-extension handling and SSRC drift, but the video path does not.

Current consequence:

- cases that audio can survive may black-hole video
- extension-stripping mismatches become hard frame loss
- SSRC drift is not corrected for video the way it is for audio

### 6. Medium: `user_video_frame` delivery is lossy and underdocumented

`UserVideoFrame` is routed through the lossy IPC lane and can be silently dropped under backpressure.

The current notes describe `user_video_frame` as if it were a straightforward outbound frame contract, but in practice it is best-effort delivery and long stretches of video can disappear before Node ever sees them.

### 7. Notes correction

The note that this work was "not compile-tested in this environment" is now stale for this repo snapshot.

`cargo test` in `src/voice/clankvox` passes. The bigger remaining gaps are live Discord validation, RTX support, decoded-image output, and broader targeted coverage for the video-specific paths.

## Review Pass 1 Follow-Up

### 1. Issue 1 status: investigated, no code change

After checking `davey` semantics, the current depacketize-then-`decrypt_video(...)` order appears intentional for Discord video DAVE, which operates on assembled codec frames rather than raw RTP payload fragments.

### 2. Issue 2 fixed: RTP sequence discontinuities reset partial video frames

H264 and VP8 depacketizers now track RTP sequence continuity per SSRC.

Packet loss or reordering now drops the partial frame instead of emitting a corrupted "complete" frame.

### 3. Issue 3 fixed: empty stream updates no longer desync SSRC routing from app state

`voice_conn` now preserves prior per-user stream descriptors when Discord sends an update that omits `streams`.

The live `video_ssrc_map` and the higher-level `remote_video_states` merge semantics now stay aligned.

### 4. Issue 4 fixed: session-ID reconnect teardown now clears transport-derived runtime state

Session churn now clears remote video state, SSRC maps, decoders, and speaking state before reconnect.

That prevents stale OP15 sink-wants and stale `user_video_state` from leaking across reconnects.

### 5. Issue 5 fixed: video DAVE recovery now mirrors the audio path more closely

Video receive now keeps a second depacketizer path for the alternate RTP-extension payload variant.

Successful video decrypt can now recover through alternate RTP-extension handling and best-effort SSRC remap.

### 6. Issue 6 improved: `user_video_frame` delivery is still lossy, but no longer silent and no longer shares the audio lane

Video frames now use a dedicated bounded outbound video queue.

Backpressure drops and recovery are logged so the parent process can correlate missing visual context with subprocess pressure.

### 7. Issue 7 fixed: the compile-tested note is corrected

`cargo test` in `src/voice/clankvox` passes after the review-pass fixes.

## March 14, 2026 — Transport and Decode Incident

A series of refactoring changes in `voice_conn.rs` broke the audio and video
receive paths. Root causes and fixes:

### 1. Transport crypto AAD mismatch (bot completely deaf)

The `decrypt()` method was changed to delegate to `decrypt_with_aad(packet,
header_size)`, where `header_size` from `parse_rtp_header` includes the full
RTP extension body. Discord's `rtpsize` AEAD modes only authenticate the
fixed header + CSRC + 4-byte extension prefix as AAD — not the extension body.
Every packet failed transport decryption silently at `debug` level.

Fix: `decrypt()` recomputes AAD from raw packet bytes (`RTP_HEADER_LEN + cc*4
+ 4 if extension`), ignoring the `header_size` parameter. A regression test
(`rtp_decrypt_uses_correct_aad_when_extension_is_present`) catches future
breakage.

### 2. Inbound RTCP packets hitting RTP decrypt

Discord multiplexes RTCP on the same UDP socket (RFC 5761). Payload types
72-76 (RTCP SR/RR/SDES/BYE/APP) were fed into the RTP `decrypt()` path and
failed because RTCP has a different header/AAD layout. Fixed by filtering
RTCP packets early in the UDP recv loop.

### 3. MediaSinkWants OP15 format

The refactored OP15 payload dropped `streams` and `pixelCounts` in favor of a
flat `{"any": N, "ssrc": N}` map. Discord did not recognize this format and
sent video at the lowest quality with very sparse keyframes. Restored the
original `{"any": N, "streams": {...}, "pixelCounts": {...}}` structure.

### 4. H264 keyframe detection too strict

The refactored code only treated IDR slices (NAL type 5) as keyframes. Discord
H264 screen shares send SPS (NAL type 7) as sync points without IDR. Restored
SPS-as-keyframe detection. Also changed the depacketizer to always prepend
cached SPS+PPS to every emitted frame, since PLI/FIR RTCP feedback does not
work on the raw UDP protocol path (only on the WebRTC path used by
`Discord-video-stream`).

### 5. ffmpeg H264 raw demuxer EOF hang

ffmpeg 8.x's H264 raw demuxer (`-f h264`) hangs waiting for more data even
when reading from a file with a single access unit. Bun's `stdin.end()` also
does not reliably deliver EOF. Fixed by writing H264 to a temp file then
piping through `cat | ffmpeg -fflags +genpts -f h264 -i pipe:0`, which
guarantees clean pipe close.

### 6. DAVE video passthrough forwarding encrypted garbage

Go Live video frames fail DAVE decrypt with `UnencryptedWhenPassthroughDisabled`.
The passthrough path returned the raw (encrypted) bytes as if they were
cleartext H264. ffmpeg parsed valid NAL headers but hit garbage in slice bodies:
`deblocking_filter_idc out of range`, `cabac_init_idc overflow`, `reference
count overflow`.

Fix: video frames that fail DAVE decrypt are now dropped instead of passed
through. Screen watch relies on the initial unencrypted frames that arrive
during the DAVE session transition window after commit.

### Reference repo findings

Examined `Discord-video-stream` and `Discord-video-selfbot`:
- Neither handles OP15 or receives video (sender-only libraries)
- `Discord-video-stream` uses `protocol: "webrtc"` with SDP — PLI/FIR is
  handled by the native WebRTC stack, not manually crafted RTCP
- `Discord-video-selfbot` uses raw UDP and ignores all inbound packets
- Neither caches SPS/PPS or depacketizes H264 (no receive path)
- Voice gateway v7/v8, not v9

## Bun Integration Pass

The Bun runtime now consumes the native Discord video contract end to end:

- `clankvoxClient` supports `subscribe_user_video`, `unsubscribe_user_video`, `user_video_state`, `user_video_frame`, and `user_video_end`
- session state tracks active native Discord sharers in `nativeScreenShare`
- realtime instructions can mention who is actively sharing before any watch starts
- `start_screen_watch` now tries to bind to an actual active Discord sharer first
- Bun decodes sampled native H264/VP8 keyframes to JPEG with `ffmpeg`
- decoded JPEGs feed the existing `streamWatch` pipeline, scanner notes, and prompt image path

Important product distinction:

- active sharer metadata is prompt context
- actual frame visibility still starts only after `start_screen_watch`

Important runtime distinction:

- `clankvox` forwards encoded video payloads
- Bun performs JPEG decode and stream-watch ingest
