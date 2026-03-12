# Native Discord Screen Share

> **Scope:** What "native Discord screen-share watching" means, what Discord exposes today, what `clankvox` already implements, and what is still missing before Clanker Conk can receive Discord screen shares directly.
> Existing share-link system: [`voice/screen-share-system.md`](voice/screen-share-system.md)
> Voice transport stack: [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md)
> Cross-cutting settings contract: [`settings.md`](settings.md)

This document separates two different products that are easy to blur together:

- **Native Discord screen-share receive**: the bot joins a voice channel and directly subscribes to a user's Discord Go Live / video stream through Discord's voice/media protocol.
- **Link-based screen watch**: the bot sends a share link, the user opens a browser page, `getDisplayMedia()` captures the screen, and frames are POSTed into Clanker Conk.

Clanker Conk currently supports the second product. It does not yet support the first one.

## Status Summary

Status validated on **March 12, 2026**.

Discord's public developer documentation now clearly acknowledges video-related voice protocol surface:

- the voice state object includes `self_stream` and `self_video`
- the voice connections protocol history mentions video support
- the voice protocol documentation covers DAVE end-to-end encryption for voice and video media

Official references:

- [Discord Voice Resource docs](https://docs.discord.com/developers/resources/voice)
- [Discord Voice Connections docs](https://docs.discord.com/developers/topics/voice-connections)

However, Discord still does **not** document a simple high-level bot API that looks like "subscribe to user X's active screen share and receive decoded frames." The protocol surface exists; the bot-ready product surface still appears to be low-level and custom.

That means native screen-share receive should be treated as:

- **possible in principle**
- **high-effort in implementation**
- **higher-risk than normal Discord voice audio receive**

## Current Product In This Repo

The current screen-share feature is intentionally **not** native Discord video subscription.

Canonical flow:

1. The bot offers a screen-share link.
2. The user opens `/share/:token`.
3. The browser captures the screen with `getDisplayMedia()`.
4. JPEG keyframes are POSTed to `/api/voice/share-session/:token/frame`.
5. The voice brain receives the latest frame plus rolling visual notes.

See [`voice/screen-share-system.md`](voice/screen-share-system.md) for the full architecture.

This design avoids depending on undocumented or lightly-documented Discord-native video receive behavior while still giving the agent visual context.

## What `clankvox` Already Has

`clankvox` already implements a meaningful part of the substrate a native solution would need:

- Discord voice WebSocket and UDP transport
- SSRC mapping for speaking users
- DAVE session setup, transition handling, and decrypt recovery
- inbound RTP parsing
- outbound RTP send for bot audio
- Rust-side capture/playback supervision

Important local code paths:

- `src/voice/clankvox/src/voice_conn.rs`
- `src/voice/clankvox/src/dave.rs`
- `src/voice/clankvox/src/capture_supervisor.rs`
- `src/voice/clankvox/src/ipc.rs`
- `src/voice/clankvox/src/ipc_protocol.rs`

In other words: `clankvox` is not missing the entire transport layer. It already owns a substantial amount of the low-level Discord voice stack.

## What `clankvox` Does Not Yet Implement

Despite that substrate, the current implementation is still **audio-only** at the receive boundary.

### 1. Receive events are audio-only

The core receive event enum only exposes:

- `Ready`
- `SsrcUpdate`
- `ClientDisconnect`
- `OpusReceived`
- `DaveReady`
- `Disconnected`

There is no `VideoReceived`, `StreamFrameReceived`, or equivalent event in the Rust transport.

### 2. Non-Opus RTP payloads are dropped

The UDP receive loop explicitly accepts only payload type `120` and drops anything else as non-Opus RTP.

That is the strongest signal that native Discord video frames are not yet being handled in the live transport.

### 3. DAVE decrypt is hard-coded to audio media

`DaveManager::decrypt()` currently decrypts with `MediaType::AUDIO`.

There is no parallel video-media decrypt path today.

### 4. Stream metadata is not consumed

The handshake tests show that `clankvox` can buffer an `op: 18` payload with a `streams` field while waiting for the normal voice handshake messages.

That is useful, but it is not the same thing as implementing stream subscription. Today, that stream metadata is buffered/replayed and then falls through the normal opcode handling path because there is no stream-management implementation attached to it.

### 5. IPC to the parent process is audio-only

The Rust subprocess emits and accepts audio-oriented IPC messages such as:

- `UserAudio`
- `UserAudioEnd`
- playback `Audio`

There is no IPC contract for video frames, stream subscriptions, video keyframes, codec metadata, or decoded image output.

### 6. No video decode pipeline exists

Even if encrypted video packets were successfully received, the repo does not yet contain a native Discord video pipeline for:

- stream selection / quality negotiation
- RTP depacketization for video
- codec-specific reassembly
- frame decode into image data
- backpressure and frame-dropping policy for inference use

## Practical Conclusion

The correct statement is:

> `clankvox` already has much of the low-level Discord voice transport and DAVE foundation that a native screen-share receiver would need, but it does not yet implement native Discord video subscription or frame receive.

That is materially different from saying either:

- "we have nothing"
- "we already support native Discord screen shares"

Both extremes are inaccurate.

## Why The Repo Still Uses The Share-Link Path

The share-link path is still the canonical product for Clanker Conk because it is:

- explicit and understandable for users
- provider-agnostic
- stable across Discord client/protocol changes
- easy to convert into vision-model inputs
- easy to rate-limit and inspect
- much cheaper to debug than a custom Discord-native video stack

This is aligned with the broader product principle in this repo: give the agent rich context without hardcoding brittle behaviors around a vendor-specific media path.

## What Native Support Would Require

If we decide to pursue native Discord screen-share receive in `clankvox`, the missing work is roughly:

1. **Stream discovery and subscription**
   Handle Discord's video/stream metadata and whatever sink/subscription messages are required to request a specific user's active stream.
2. **Video media receive path**
   Accept non-Opus RTP payloads instead of dropping them immediately.
3. **Video DAVE decrypt**
   Add decrypt paths for the appropriate non-audio media type.
4. **Depacketization and decode**
   Reassemble codec payloads into frames that can be decoded into images.
5. **Frame selection policy**
   Decide whether the bot wants full-rate video, keyframes only, or a sampled watch stream.
6. **Rust-to-parent IPC**
   Add a video frame/event contract to move decoded images or compressed frames into the Node process.
7. **Inference-facing adaptation**
   Rate-limit, resize, summarize, and persist frames in a way that fits the existing stream-watch pipeline.

This is feasible engineering work, but it is a new subsystem, not a small patch.

## Recommendation

The current recommendation is:

- keep the existing link-based screen-share system as the canonical shipping feature
- treat native Discord screen-share receive as an experimental transport project inside `clankvox`
- only rename the product to imply "native Discord stream watching" after the transport, decrypt, decode, and frame-ingest path actually exist end to end

## Product Language

Until native receive exists, prefer product language like:

- "share your screen with me"
- "open a screen-share link"
- "let me watch your screen"

Avoid claiming:

- "I joined your Discord stream"
- "I can watch Discord screen shares natively"

Those claims overstate the current implementation.
