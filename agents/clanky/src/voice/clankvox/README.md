# clankvox

`clankvox` is Clanky's main Rust package for voice and media transport. It is
the native media plane Clanky delegates to when a platform needs realtime
sockets, codec work, packet timing, encryption, or low-level media telemetry.

ClankVox handles Discord voice and Go Live, and future platform-specific
voice/media transports should live at the same layer.

For Discord, it owns:

- main voice transport for audio send/receive
- Discord DAVE lifecycle and transport encryption
- Opus encode/decode and RTP/UDP packet handling
- capture events for ASR and speaking state
- outbound playback for TTS and music
- native Go Live stream watch receive
- native Go Live stream publish send
- JSON-line IPC with the Clanky Node runtime

Clanky still owns gateway/session control, orchestration, tools, prompts,
settings, and product behavior. `clankvox` is deliberately the transport/media
layer, not a second application runtime.

## Discord Roles

`clankvox` runs three Discord transport roles:

- `voice`: the normal Discord voice connection for audio capture and playback
- `stream_watch`: a second stream-server connection for inbound Go Live video receive
- `stream_publish`: a second stream-server connection for outbound Go Live video send

The `voice` role is always the anchor session. The stream roles are optional and
are started by Clanky when Discord stream discovery produces the needed
credentials. Future platform transports can add their own roles while keeping
product policy in Clanky and media mechanics in `clankvox`.

## Runtime Shape

The process entrypoint is [src/main.rs](./src/main.rs).

At startup `clankvox`:

1. installs rustls crypto
2. starts a single IPC writer and an IPC reader
3. creates shared `AppState`
4. enters one `tokio::select!` loop
5. multiplexes:
   - inbound IPC commands from Clanky
   - voice events from `voice_conn`
   - music events from the ffmpeg/yt-dlp pipeline
   - a reconnect timer
   - a 20ms send tick for live audio/video pacing

Most behavior is split across supervisor-style modules:

- [src/app_state.rs](./src/app_state.rs): shared state and transport slots
- [src/connection_supervisor.rs](./src/connection_supervisor.rs): connect/disconnect and reconnect control
- [src/capture_supervisor.rs](./src/capture_supervisor.rs): inbound audio/video events and subscriptions
- [src/playback_supervisor.rs](./src/playback_supervisor.rs): TTS/music playback and periodic send tick
- [src/stream_publish.rs](./src/stream_publish.rs): outbound Go Live sender pipeline
- [src/voice_conn.rs](./src/voice_conn.rs): Discord voice/stream transport, WebSocket, UDP, RTP, codec negotiation, DAVE, packetization
- [src/dave.rs](./src/dave.rs): `davey` wrapper and role-specific encryption/decryption helpers
- [src/ipc.rs](./src/ipc.rs): Clanky <-> Rust message contracts

## What To Read

- [docs/architecture.md](./docs/architecture.md): process model, ownership boundaries, transport roles, IPC, module map
- [docs/audio-pipeline.md](./docs/audio-pipeline.md): capture, TTS, music, playback pacing, telemetry
- [docs/go-live.md](./docs/go-live.md): native screen watch, native self publish, stream discovery, sender/receiver flows
- [docs/development.md](./docs/development.md): build/test commands, logs, and where to make changes

## Build And Test

From this directory:

```sh
cargo test
```

Release build on this repo normally uses static opus:

```sh
OPUS_STATIC=1 OPUS_NO_PKG=1 cargo build --release
```

From the repo root, the package wrapper uses:

```sh
pnpm voice:build
```

## Discord Product Boundaries

ClankVox is Clanky's main package for native voice/media transports; Discord
voice and Go Live are the implemented transport family.

The Go Live sender path is exposed through a narrow URL-first voice media
surface:

- normal music playback is voice audio only and works with bot-token voice
- outbound publish is driven by TypeScript orchestration through `stream_publish_*` IPC and Discord gateway OP18/OP19/OP22
- Realtime-facing source gate is resolved http(s) URLs; search and disambiguation should go through Pi/skills before media playback
- video URL publish can optionally start a parallel music/audio pipeline so the voice channel hears the video while Go Live shows it
- visualizer publish can show active music over Go Live
- sender transport is H264-only
- live sender validation on Discord is still separate from the non-live smoke coverage already in place

Inbound native screen watch is already integrated end to end through `stream_watch`.

## Known Limitations

- **DAVE video decrypt on Go Live.** DAVE video decrypt works at near 100% on the main voice connection (after the RTP padding strip fix in `rtp.rs`). Go Live streams are a separate problem: the `davey` crate returns `UnencryptedWhenPassthroughDisabled` for every Go Live video frame, but those frames are actually encrypted. Video frames that fail DAVE decrypt are dropped. Screen watch relies on the unencrypted frames that arrive during the DAVE session transition window. Fixing Go Live requires either updating `davey` to handle Go Live video DAVE framing, or switching to the WebRTC protocol path.
- **PLI/FIR does not work.** Discord's media server does not process RTCP PLI/FIR feedback from raw UDP peers (only from WebRTC peers). PLI/FIR packets are still sent as a best-effort hint (periodic, after decoder reset, after DAVE ready), but keyframes cannot be requested on demand. The H264 depacketizer compensates by always prepending cached SPS+PPS to every emitted frame (after DAVE decrypt), and the persistent OpenH264 decoder processes all frames (IDR + P-frames) for reference state accumulation.
- **VP8 ffmpeg decode EOF.** VP8 still uses per-frame ffmpeg decode on the Clanky side. The ffmpeg raw demuxer hangs on single-frame input; Clanky works around this by piping through `cat | ffmpeg -fflags +genpts -f ivf -i pipe:0`. H264 decode is handled entirely in-process by clankvox's persistent OpenH264 decoder and does not use ffmpeg.

## Related Top-Level Docs

These local docs consolidate the transport/media-plane parts of several repo docs. The product-facing and cross-runtime docs still live at the repo root:

- [../../../docs/voice/discord-streaming.md](../../../docs/voice/discord-streaming.md)
- [../../../docs/archive/selfbot-stream-watch.md](../../../docs/archive/selfbot-stream-watch.md)
- [../../../docs/voice/voice-provider-abstraction.md](../../../docs/voice/voice-provider-abstraction.md)
- [../../../docs/architecture/overview.md](../../../docs/architecture/overview.md)
- [../../../docs/notes/rust-submodule-dev.md](../../../docs/notes/rust-submodule-dev.md)
