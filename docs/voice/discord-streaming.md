# Native Discord Screen Share

> Scope: native Discord Go Live in this repo: inbound watch, outbound self publish, what is built, what is still open, and how the share-link fallback fits.
> Canonical media hub: [`../capabilities/media.md`](../capabilities/media.md)
> Product surface: [`screen-share-system.md`](screen-share-system.md)
> Transport stack: [`voice-provider-abstraction.md`](voice-provider-abstraction.md)
> Direct integration plan: [`../archive/selfbot-stream-watch.md`](../archive/selfbot-stream-watch.md)
> `clankvox` local docs: [`../../src/voice/clankvox/README.md`](../../src/voice/clankvox/README.md)
> Reference implementations: [`Discord-video-stream`](https://github.com/Discord-RE/Discord-video-stream), [`Discord-video-selfbot`](https://github.com/aiko-chan-ai/Discord-video-selfbot)

This repo supports native Discord Go Live in both directions:

- Native Discord screen watch: subscribe to an active Discord Go Live stream through Discord's voice media protocol.
- Native Discord self publish: create our own Go Live stream and send H264 video through the stream server connection.
- Share-link fallback: send `/share/:token`, capture with `getDisplayMedia()`, and POST JPEG frames back into the bot.

The model still only sees `start_screen_watch` for inbound visual context. Outbound publish is a runtime capability tied to the music pipeline, not a new conversational tool.

## Current Status

**Status validated March 13, 2026.**

The native Discord screen watch pipeline is built end to end in clankvox and Bun:

- selfbot gateway stream discovery for `VOICE_STATE_UPDATE.self_stream`,
  `STREAM_CREATE`, `STREAM_SERVER_UPDATE`, and `STREAM_DELETE`
- Gateway OP20 `STREAM_WATCH` request dispatch from the selfbot session
- `clankvox` `stream_watch` IPC + second transport role
- video receive, DAVE decrypt, H264/VP8 depacketization, IPC, ffmpeg decode, stream-watch ingest
- explicit-target native watch can start from discovered Go Live state before
  native video-state frames have populated the sharer list
- Bun normalizes H264 payloads to Annex-B before `ffmpeg` decode so length-prefixed
  AVC access units do not fail decode by shape alone

**Validated live** on the selfbot runtime (March 13, 2026):

- the selfbot receives stream discovery events
- `STREAM_WATCH` yields stream credentials
- Bun forwards those credentials into `clankvox`
- `clankvox` opens the second stream transport, completes the modern watcher handshake,
  reaches DAVE-ready, and forwards encrypted H264 frames back to Bun
- DAVE MLS E2EE decrypt produces valid H264 Annex-B frames
- ffmpeg decodes keyframes to JPEG successfully
- stream-watch brain context pipeline ingests frames and produces accurate visual commentary
- DAVE channel ID derivation (`BigInt(rtcServerId) - 1`) confirmed working
- two-checkpoint link fallback suppression prevents duplicate transports when native watch is active

The native Discord self-publish path is also built in code:

- selfbot gateway can send OP18 `STREAM_CREATE`, OP19 `STREAM_DELETE`, and OP22 `STREAM_SET_PAUSED`
- Bun tracks self stream discovery and routes self-owned credentials into a dedicated `stream_publish` transport role
- `clankvox` opens a second sender-side stream connection, advertises H264, encrypts video with DAVE, and packetizes outbound RTP
- Bun currently drives publish from two source families:
  - music/video relay: start on music play, pause on music pause, stop on music idle/error
  - browser-session share: explicit `share_browser_session` start/stop around an active browser session
- `voice.streamWatch.visualizerMode` controls how music publish renders:
  - `"cqt"` is the default and starts one shared `ffmpeg` pipeline inside `clankvox` that emits PCM for the main voice connection and H264 visualizer access units for Go Live
  - `stream_publish_play_visualizer` attaches the sender transport to that already-running visualizer feed instead of starting a second media fetch
  - `"off"` preserves the legacy URL-backed source-video relay path when a real source video track is preferred
- music publish is no longer limited to YouTube-backed video tracks when a visualizer is active; any playback URL the music pipeline already resolved for the active track can drive the visualizer

Sender-side live Discord validation is still pending in this repo snapshot. What is validated today is protocol shape, transport wiring, automated coverage for create/resume/switch control-plane behavior, browser-session frame forwarding coverage in Bun, and `cargo test` coverage inside `clankvox`.

The share-link fallback remains the recovery transport if native watch does not
connect or later becomes unhealthy. When the native `stream_watch` transport
fails or disconnects after start, Bun tears the native watch down and requests
the share-link path directly when requester + text-channel context are known.

### Link fallback suppression

When a native stream watch is active, the link fallback is suppressed at two
checkpoints inside `tryStartLinkFallback`:

1. **pre_create** — before creating the link session, check if native watch is
   already active for the target user with a ready transport or decoded frame
2. **post_compose** — after composing the link message but before sending, re-check
   in case native watch became ready during async link creation

This prevents the race where the voice brain's `start_screen_watch` tool call
resolves before stream credentials arrive, triggers a link fallback, and then
native watch connects 200ms later — resulting in both transports running in
parallel. `shouldSuppressLinkFallbackDueToNativeWatch` checks transport status,
decoded frame presence, or active sharer state.

`startVoiceScreenWatch` also accepts a `preferredTransport` parameter. Callers
can pass `"link"` to skip native entirely and go straight to the share-link
path — used for recovery when native transport fails after initial connection.

## Why The Regular Voice Connection Cannot See Go Live Streams

Discord uses a **dual-connection architecture** for Go Live:

```
┌─────────────────────────────────────────────────────────────┐
│  Regular Voice Connection                                   │
│  - Audio (Opus) send/receive                                │
│  - Speaking state (OP5)                                     │
│  - DAVE encryption                                          │
│  - No Go Live video SSRCs on the main voice leg             │
│  - No OP12 video state received                             │
│  - Endpoint: from VOICE_SERVER_UPDATE                       │
│  - Server ID: guild_id                                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Stream Connection (separate voice server)                  │
│  - Video frame send/receive                                 │
│  - Video SSRCs assigned in OP2 Ready streams[] array        │
│  - OP12 video state exchanged                               │
│  - OP15 media sink wants for quality negotiation            │
│  - Endpoint: from STREAM_SERVER_UPDATE                      │
│  - Server ID: rtc_server_id from STREAM_CREATE              │
└─────────────────────────────────────────────────────────────┘
```

Confirmed via live debugging in the older bot-token runtime on March 12, 2026:

- OP2 Ready on the main voice connection returned `video_ssrc=None`
- No OP12 or OP18 video state was ever sent to the main voice connection
- Adding `video: true` and `streams` to the main voice Identify payload did not change this
- Sending OP12 on the main voice connection did not change this either

The selfbot fork changes the account/control-plane model, not the fact that Go Live uses a separate stream server connection.

Go Live video state and video frames live on a separate stream server that requires its own connection.

## Discord Protocol: Go Live Stream Architecture

### Gateway events (main Discord gateway, not voice gateway)

These are standard Discord gateway dispatch events, not voice WebSocket opcodes:

| Gateway opcode | Event name | Direction | Purpose |
|---|---|---|---|
| 18 | `STREAM_CREATE` | Client → Server | Start a Go Live stream |
| 19 | `STREAM_DELETE` | Client → Server | Stop a Go Live stream |
| 20 | `STREAM_WATCH` | Client → Server | Subscribe to watch someone's stream |
| 22 | `STREAM_SET_PAUSED` | Client → Server | Pause/resume a stream |

Gateway dispatch events received from Discord:

| Event | Payload | Purpose |
|---|---|---|
| `STREAM_CREATE` | `{ stream_key, rtc_server_id }` | Stream created, provides stream server ID |
| `STREAM_SERVER_UPDATE` | `{ stream_key, endpoint, token }` | Stream server ready, provides connection credentials |
| `STREAM_DELETE` | `{ stream_key }` | Stream ended |
| `VOICE_STATE_UPDATE` | `{ ..., self_stream, self_video }` | User voice state, includes streaming flag |

### Stream key format

Stream keys identify a specific Go Live stream:

```
guild:<guildId>:<channelId>:<userId>    # Guild voice channel
call:<channelId>:<userId>               # DM / group call
```

### Voice gateway opcodes (on the stream connection)

These are the same opcodes as the regular voice connection but exchanged on the stream-specific voice server:

| Voice opcode | Name | Purpose |
|---|---|---|
| 0 | `IDENTIFY` | Authenticate with stream server |
| 1 | `SELECT_PROTOCOL` | Negotiate codecs and encryption |
| 2 | `READY` | Server assigns SSRCs (including video SSRCs in `streams[]`) |
| 4 | `SELECT_PROTOCOL_ACK` | Session description with encryption keys |
| 5 | `SPEAKING` | Signal speaking/streaming status (flag 2 = video) |
| 12 | `VIDEO` | Announce/receive video stream attributes |
| 15 | `MEDIA_SINK_WANTS` | Request specific video quality/SSRCs |

## Protocol Flow: Watching a Go Live Stream

### Sending (reference control-plane shape)

```
1. joinVoice()
   → Gateway OP4 VOICE_STATE_UPDATE { guild_id, channel_id }
   → Receive VOICE_STATE_UPDATE { session_id }
   → Receive VOICE_SERVER_UPDATE { endpoint, token }
   → Connect regular voice WebSocket to endpoint
   → Standard voice handshake (OP0→OP2→OP1→OP4)

2. createStream()
   → Gateway OP18 STREAM_CREATE { type, guild_id, channel_id }
   → Gateway OP22 STREAM_SET_PAUSED { stream_key, paused: false }
   → Receive STREAM_CREATE { stream_key, rtc_server_id }
   → Receive STREAM_SERVER_UPDATE { stream_key, endpoint, token }
   → Connect stream voice WebSocket to stream endpoint
   → Stream handshake: OP0 Identify with { server_id: rtc_server_id, video: true, streams: [...] }
   → OP2 Ready includes video SSRCs in streams[] array
   → OP12 VIDEO to announce stream attributes
   → Send video frames via RTP/UDP
```

### Publishing / sending (runtime flow)

```
1. A publishable source becomes active
   → music playback resolves a publishable source URL
   → if `voice.streamWatch.visualizerMode != "off"`, `music_play` starts one shared `ffmpeg` pipeline that emits both PCM audio and H264 visualizer video
   → if `voice.streamWatch.visualizerMode == "off"`, Bun keeps the legacy URL-backed source-video relay path
   → browser-session share resolves a live browser session key

2. Create or reuse self stream
   → If no self stream exists, send OP18 STREAM_CREATE
   → Send OP22 STREAM_SET_PAUSED { paused: false }
   → Wait for STREAM_CREATE + STREAM_SERVER_UPDATE discovery

3. Connect sender transport
   → Bun sends stream_publish_connect to clankvox
   → clankvox opens stream voice connection to stream endpoint
   → OP0 Identify uses rtc_server_id + main voice session_id
   → OP1 SelectProtocol advertises sender-side H264
   → OP12 VIDEO announces active screen stream attributes

4. Push media
   → visualizer-mode music publish sends `stream_publish_play_visualizer`
   → clankvox attaches the sender transport to the shared music visualizer H264 queue
   → legacy URL-backed music publish sends `stream_publish_play`
   → browser-session share sends stream_publish_browser_start + stream_publish_browser_frame payloads into clankvox
   → clankvox encodes or relays the active source to H264 Annex-B access units
   → DAVE encrypt + RTP packetize each access unit
   → OP5 speaking uses flag 2 on the stream connection

5. Pause / stop
   → music pause sends OP22 STREAM_SET_PAUSED { paused: true }
   → music resume reuses the same stream when discovery is still live
   → browser-session share stop sends OP19 STREAM_DELETE and tears the sender transport down
   → music stop/error/idle sends OP19 STREAM_DELETE and tears the sender transport down
```

### Receiving / watching (runtime flow)

```
1. Detect Go Live
   → Listen for VOICE_STATE_UPDATE with self_stream: true
   → OR listen for STREAM_CREATE dispatch event

2. Subscribe to stream
   → Gateway OP20 STREAM_WATCH { stream_key }
   → Receive STREAM_CREATE { stream_key, rtc_server_id }
   → Receive STREAM_SERVER_UPDATE { stream_key, endpoint, token }

3. Connect to stream server
   → Open second voice WebSocket to stream endpoint
   → OP0 Identify with { server_id: rtc_server_id, video: true, streams: [...] }
   → OP2 Ready assigns video SSRCs in streams[] array
   → OP12 VIDEO with video state from the streamer

4. Request video quality
   → OP15 MEDIA_SINK_WANTS with desired SSRCs and quality

5. Receive video frames
   → Encrypted RTP/UDP video packets arrive
   → DAVE decrypt → depacketize → decode → stream-watch pipeline
```

### OP0 Identify (stream connection)

```json
{
  "op": 0,
  "d": {
    "server_id": "<rtc_server_id from STREAM_CREATE>",
    "user_id": "<selfbot user id>",
    "session_id": "<session_id from VOICE_STATE_UPDATE>",
    "token": "<token from STREAM_SERVER_UPDATE>",
    "video": true,
    "streams": [{ "type": "screen", "rid": "100", "quality": 100 }],
    "max_dave_protocol_version": 1
  }
}
```

### OP2 Ready (stream connection response)

```json
{
  "op": 2,
  "d": {
    "ssrc": 12345,
    "ip": "1.2.3.4",
    "port": 50000,
    "modes": ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"],
    "streams": [
      {
        "type": "video",
        "rid": "100",
        "ssrc": 12346,
        "rtx_ssrc": 12347,
        "active": false,
        "quality": 100
      }
    ]
  }
}
```

Video SSRCs are in `d.streams[].ssrc`, not in a top-level `d.video_ssrc` field.

### Stream speaking flag

On the stream connection, speaking flag 2 indicates video (vs flag 1 for audio on the regular connection):

```json
{ "op": 5, "d": { "speaking": 2, "delay": 0, "ssrc": 12345 } }
```

## What Is Built

### Video receive pipeline (clankvox, Rust)

All of this is implemented and tested:

- OP12/OP18 remote video state parsing and tracking (`voice_conn.rs`)
- OP14 session/codec update handling (`voice_conn.rs`)
- OP15 media sink wants send (`voice_conn.rs`, `capture_supervisor.rs`)
- Video codec advertisement in SelectProtocol: H264, VP8 decode (`voice_conn.rs`)
- Non-Opus RTP acceptance: H264 (PT 103), VP8 (PT 105) (`voice_conn.rs`)
- DAVE video decrypt path (`dave.rs`)
- H264 depacketization: single NAL, STAP-A, FU-A (`video.rs`)
- VP8 depacketization: payload descriptor stripping, frame reassembly (`video.rs`)
- RTP sequence gap detection to prevent cross-packet frame corruption (`video.rs`)
- Video frame IPC: `UserVideoState`, `UserVideoFrame`, `UserVideoEnd` (`ipc.rs`)
- Dedicated bounded outbound video queue with backpressure logging (`ipc.rs`)
- Per-user video subscription management (`capture_supervisor.rs`)
- Remote video state merge semantics for partial updates (`capture_supervisor.rs`)
- Session reconnect teardown of stale video state (`capture_supervisor.rs`)

### Bun runtime integration

- `clankvoxClient.ts`: IPC for `subscribe_user_video`, `unsubscribe_user_video`, video events
- `nativeDiscordScreenShare.ts`: Active sharer tracking, target resolution
- `sessionLifecycle.ts`: Video state/frame/end event handlers
- `screenShare.ts`: Native-first with share-link fallback, telemetry
- `voiceStreamWatch.ts`: ffmpeg H264/VP8 keyframe decode to JPEG, stream-watch pipeline

### Video send pipeline (clankvox + Bun)

Implemented in code:

- `streamDiscovery.ts`: OP18/OP19/OP22 send helpers plus self stream discovery
- `voiceStreamPublish.ts`: session state, visualizer-aware source resolution, and self-stream connect orchestration
- `voiceBrowserStreamPublish.ts`: browser-session capture loop and frame forwarding into `clankvox`
- `sessionLifecycle.ts`: publish transport lifecycle, recovery, and stream discovery callbacks
- `clankvoxClient.ts`: `stream_publish_*` IPC commands, including `stream_publish_play_visualizer`, and transport state relay
- `clankvox`: sender-side `stream_publish` transport role, H264 codec negotiation, DAVE video encrypt, RTP packetization, shared music visualizer pipeline, legacy URL relay, and browser-frame encode path

Current rollout boundary:

- outbound publish is wired to music/video relay and explicit browser-session share, not a general-purpose arbitrary file/share tool
- music relay defaults to a shared audio visualizer (`voice.streamWatch.visualizerMode: "cqt"`) and only falls back to source-video relay when that setting is `"off"`
- sender transport is H264-only

### What is still open

1. **RTX retransmission receive** — the current UDP receive path still drops RTX packets, so packet-loss recovery remains limited until retransmission support lands
2. **Live sender validation** — the sender path is implemented, but this repo snapshot still needs Discord-live validation against a real selfbot session
3. **Broader publish surfaces** — outbound publish still centers on music lifecycle and explicit browser-session share; there is no general-purpose arbitrary file/share tool yet

## Implementation Plan

### Current Receive Flow

- Selfbot gateway records active Go Live streams and credentials in stream discovery state
- `start_screen_watch` requests OP20 `STREAM_WATCH` and records the expected stream key on the voice session
- If credentials are already present, Bun immediately sends `stream_watch_connect` to `clankvox`
- If credentials arrive later, discovery callbacks connect the `stream_watch` transport when `STREAM_SERVER_UPDATE` lands
- `clankvox` emits role-aware `transport_state`, `userVideoState`, `userVideoFrame`, and `userVideoEnd`
- Bun decodes sampled keyframes to JPEG and feeds them into the existing stream-watch commentary path
- `STREAM_DELETE` prunes the cached sharer and tears native watch down
- Native transport failure/disconnect tears native watch down and directly requests share-link fallback when requester + text-channel context exist

### Current Publish Flow

- music playback enters `playing`
- `voiceMusicPlayback.ts` resolves the playback URL for the active track and starts `music_play`
- if `voice.streamWatch.visualizerMode != "off"`, `music_play` starts a shared `ffmpeg` pipeline in `clankvox` that emits PCM audio plus H264 visualizer access units
- `voiceStreamPublish.ts` resolves a publishable source from session music state or an active browser-session share
- if no self stream exists yet, Bun sends OP18 `STREAM_CREATE`
- self stream discovery callbacks hand `STREAM_CREATE` / `STREAM_SERVER_UPDATE` credentials back into the owning voice session
- Bun sends `stream_publish_connect`, then either `stream_publish_play_visualizer` for shared visualizer mode or `stream_publish_play` for legacy URL relay
- `clankvox` starts or reuses the sender-side stream transport, marks video active, and sends H264 RTP frames
- music pause sends `stream_publish_pause` plus OP22 `paused: true`
- music resume reuses the live stream when possible instead of recreating it
- music idle/error/stop sends `stream_publish_stop`, `stream_publish_disconnect`, and OP19 `STREAM_DELETE`

## Product Behavior

The model still only sees `start_screen_watch`. Runtime resolves transport:

1. Check if target user has `self_stream: true` (Go Live active)
2. If yes → open stream connection, subscribe, receive native frames
3. If no → fall back to share-link path

The share-link fallback remains the recovery path when:

- The target user is not Go Live sharing
- Stream connection fails to establish
- Selfbot stream subscription fails or the native transport is unavailable
- Multiple sharers are active and target is ambiguous

## Settings

Native subscription tuning and music Go Live visualizer settings live under `voice.streamWatch`:

- `visualizerMode` (default: `"cqt"`)
- `nativeDiscordMaxFramesPerSecond` (default: 2)
- `nativeDiscordPreferredQuality` (default: 100)
- `nativeDiscordPreferredPixelCount` (default: 921600 / 1280x720)
- `nativeDiscordPreferredStreamType` (default: `"screen"`)

There is no separate standalone settings block for outbound native publish. Music playback reuses `voice.streamWatch.visualizerMode` to choose between the shared audio-visualizer path and the legacy source-video relay path.

## Observability

### Stream discovery layer (implemented)

- `native_discord_go_live_detected` — selfbot gateway saw `self_stream: true`
- `native_discord_stream_watch_requested` — Gateway OP20 sent
- `native_discord_stream_server_received` — `STREAM_SERVER_UPDATE` received
- `native_discord_stream_connection_started` — second clankvox connection opening

### Video receive pipeline (implemented)

- `clankvox_discord_video_state_observed` — voice connection saw OP12/OP18 video state
- `clankvox_native_video_state_received` — capture supervisor applied video state
- `clankvox_native_video_state_emitted` — state emitted over IPC to Bun
- `native_discord_screen_share_state_updated` — Bun updated active-sharer state
- `clankvox_native_video_subscribe_requested` — Rust accepted video subscription
- `clankvox_video_sink_wants_updated` — Rust recalculated OP15 media sink wants
- `clankvox_first_video_frame_forwarded` — first video frame forwarded to Bun
- `stream_watch_frame_ingested` — Bun ingested frame into stream-watch pipeline

### Failure diagnostics

- `screen_watch_native_start_failed` — native path failed, includes `reason`, `nativeActiveSharerCount`, `selectionReason`
- `screen_watch_link_fallback_started` — fell back to share-link, includes `nativeFailureReason`
- `native_discord_stream_transport_link_fallback_requested` — native transport degraded after start and Bun requested link-only recovery
- `native_discord_stream_transport_link_fallback_failed` — degraded native transport could not recover into the share-link path

## Risk Assessment

- **DAVE on stream connections.** Stream connections use DAVE channel ID `BigInt(rtc_server_id) - 1n`. Confirmed working live.
- **RTX loss recovery is still limited.** The receive path currently traces and drops RTX payloads; retransmission support remains future work.
- **Sender compatibility is narrower than receive.** Outbound publish is still H264-only and still centered on music lifecycle or browser-session share. `visualizerMode: "off"` also depends on a URL-backed source relay path being available.

## Reference: Discord-video-stream

The [`Discord-video-stream`](https://github.com/Discord-RE/Discord-video-stream) library implements the sending side of Go Live for selfbot accounts. Key observations:

- Uses `discord.js-selfbot-v13`, not regular `discord.js` — selfbot tokens may have different capabilities than bot tokens
- `VoiceConnection` for regular voice, `StreamConnection` for Go Live — both extend `BaseMediaConnection`
- Stream connection uses `rtc_server_id` from `STREAM_CREATE` as its `serverId`
- OP0 Identify always includes `video: true` and `streams: [{ type: "screen", rid: "100", quality: 100 }]`
- Video SSRCs come from `OP2 Ready d.streams[0].ssrc` and `d.streams[0].rtx_ssrc`, not `d.video_ssrc`
- Uses `protocol: "webrtc"` with SDP in SelectProtocol, not `protocol: "udp"`
- `STREAM_WATCH` (OP20) is defined but not implemented (library only sends, doesn't watch)
- Speaking flag 2 on the stream connection indicates video streaming

## Reference: Discord-video-selfbot

The [`Discord-video-selfbot`](https://github.com/aiko-chan-ai/Discord-video-selfbot) library is an older sender-side Go Live implementation. Useful observations:

- Uses a second `StreamConnection` for Go Live, separate from the main voice connection
- Fills the stream connection `serverId` from `STREAM_CREATE.rtc_server_id`
- Reuses the main voice `session_id` for the stream leg
- Uses `protocol: "udp"` with standard IP discovery and `SELECT_PROTOCOL`
- Does not implement `STREAM_WATCH` or inbound video receive
- Uses older `xsalsa20_*` encryption modes, so it is not a modern DAVE reference

## Product Language

Prefer:

- "start screen watch"
- "watch your screen"
- "I can start watching that share"
- For spoken voice replies, say "open the link I sent" or "open that screen-share link" instead of reading the full URL aloud.

Avoid:

- "I can already see your screen" unless frame context is actually active
- Reading full screen-share URLs, hostnames, or token strings aloud in voice
- "native Discord watch always works" because it depends on stream discovery working for the selfbot session
