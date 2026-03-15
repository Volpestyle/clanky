# Screen Watch System

Complete documentation of the screen watch pipeline: session lifecycle, transport selection, frame processing, and how the agent sees and reasons about what's on screen.

Canonical media hub: [`../capabilities/media.md`](../capabilities/media.md)
See also: [`../operations/public-https.md`](../operations/public-https.md) (public URL gating).
Native Discord receive status: [`discord-streaming.md`](discord-streaming.md)
Direct selfbot stream-watch plan: [`../archive/selfbot-stream-watch.md`](../archive/selfbot-stream-watch.md)
Cross-cutting settings contract: [`../reference/settings.md`](../reference/settings.md)

This document is about inbound screen/video watch. For the broader product-level media story, including music/video playback and outbound publish context, start at [`../capabilities/media.md`](../capabilities/media.md). The same selfbot stream-discovery control plane also supports outbound native self publish for music video relay and browser-session share; that sender path is documented in [`discord-streaming.md`](discord-streaming.md).

Persistence, preset inheritance, dashboard envelope shape, and save/version semantics live in [`../reference/settings.md`](../reference/settings.md). This document covers the screen-watch pipeline and the stream-watch settings that shape voice-local visual context.

## Design Philosophy

Screen sharing gives the agent eyes. The architecture follows the same autonomy principle as the rest of the system: **give the agent rich context and let it decide what to do.**

A human sitting next to someone sharing their screen would:
- See the screen continuously
- Remember what they saw before (temporal awareness)
- Decide when to comment, ask a question, or stay quiet
- Reference earlier screen states in conversation ("you changed that function signature from before")

The agent should work the same way. The `voice.streamWatch.brainContextMode` setting controls which of two vision pipelines is active:

### Direct mode (`"direct"` — default)

```
Every proactive turn → latest raw frame attached to the voice brain
    brain sees actual screen + conversation history
    brain writes [[NOTE:...]] self-observations for temporal continuity
    brain decides what to say (or [SKIP])
```

The brain sees the actual screen on every turn. It can record `[[NOTE:your observation]]` directives that persist as rolling self-notes (capped by `directMaxEntries`). More expensive per frame, but produces richer, more contextual reactions — and aligns with agent autonomy because the brain decides what is interesting, not a separate triage model.

### Scanner mode (`"context_brain"`)

```
Every frame → Scanner (cheap/fast model) → note + urgency (high/low/none)
    only high urgency → triggers a brain turn
    rolling notes always injected into voice prompt
```

A separate triage model analyzes each frame and classifies urgency. Only `high` urgency frames trigger a main brain turn. Lower cost per frame, but the brain sees summaries instead of the actual screen.

### Switching modes

The mode is configurable in the dashboard under **Screen watch vision mode** or via the `voice.streamWatch.brainContextMode` setting (`"direct"` or `"context_brain"`). The two modes are **mutually exclusive** — only one vision pipeline runs at a time.

## Architecture Overview

![Screen Watch System Diagram](../diagrams/screen-share-system.png)

<!-- source: docs/diagrams/screen-share-system.mmd -->

```
Discord VC user says "share my screen" / turns on webcam
         │
         ▼
  Selfbot reply pipeline / voice tool
  (start_screen_watch)
         │
         ▼
  Runtime chooses watch transport
  ├─ Native Go Live screen watch (preferred for screen shares)
  │  ├─ selfbot gateway resolves target + stream credentials
  │  ├─ clankvox opens native stream-watch transport (separate RTC connection)
  │  ├─ clankvox decrypts and depacketizes H264/VP8 video frames
  │  ├─ H264: persistent OpenH264 decoder in clankvox decodes to YUV, turbojpeg encodes to JPEG, sent as DecodedVideoFrame IPC
  │  ├─ VP8: raw bitstream forwarded to Bun for per-frame ffmpeg decode to JPEG
  │  └─ feed frames to the processing pipeline
  ├─ Webcam video watch (fallback when no Go Live stream)
  │  ├─ target user has webcam on but is not Go Live streaming
  │  ├─ webcam video arrives on the main voice connection (no separate transport)
  │  ├─ clankvox subscribes via OP15 media sink wants on the voice connection
  │  ├─ same H264 decode + JPEG + DecodedVideoFrame IPC pipeline
  │  └─ feed frames to the same processing pipeline
  └─ Share-link fallback
     ├─ ScreenShareSessionManager.createSession()
     ├─ bot sends /share/:token link
     ├─ browser getDisplayMedia() capture loop
     └─ POST /api/voice/share-session/:token/frame
```

## Frame Processing Pipeline

```
  ┌──────────────┐
  │  FRAME IN    │
  └──────┬───────┘
         │
         ├────────────────────────────────────────────┐
         │                                            │
  ┌──────▼───────────────┐                   ┌───────▼────────┐
  │  SCANNER             │                   │  LATEST FRAME  │
  │  (cheap/fast model)  │                   │  (stored for   │
  │                      │                   │   brain access) │
  │  Produces:           │                   └───────┬────────┘
  │  - note (observation)│                           │
   │  - urgency level     │                           │
  └──────┬───────────────┘                           │
         │                                            │
  ┌──────▼───────────────┐                           │
  │  ROLLING NOTES       │                           │
  │  (brainContextEntries│                           │
  │   max 8, with aging) │                           │
  └──────┬───────────────┘                           │
         │                                            │
         └──────────────┬─────────────────────────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │  VOICE BRAIN        │
              │                     │
              │  Sees on ANY turn:  │
              │  - Current frame    │
              │  - Rolling notes    │
              │  - Conversation     │
              │                     │
              │  Decides:           │
              │  - Speak or [SKIP]  │
              │  - What to say      │
              │  - Reference screen │
              │    or ignore it     │
              └─────────┬───────────┘
                        │
                  on session end
              ┌─────────▼───────────┐
              │  SESSION RECAP      │
              │  (summarize notes   │
              │   into memory fact) │
              └─────────────────────┘
```

### Scanner (always-on background)

The scanner runs a cheap/fast model on ingested frames at a configurable interval (default every 4 seconds). It extracts a short observation note and an `urgency` level (`high`, `low`, or `none`). Notes accumulate in `brainContextEntries` (max 8 by default), with timestamps for aging.

The scanner also decides whether the current frame warrants unprompted commentary. When `urgency` is `high`, the system fires an autonomous brain turn — but the brain still decides whether to actually speak or `[SKIP]`. For `low` and `none` urgency, notes are stored for context but no autonomous turn fires.

Scanner provider and model are independently configurable (`brainContextProvider`, `brainContextModel`) and do not affect whether the brain sees raw frames.

### Brain frame access

During any voice turn while screen watch is active, the generation model receives:
- **Current raw frame** as an image input (the latest captured JPEG)
- **Rolling scanner notes** in the prompt context (timestamped observations)
- **Normal conversation context** (transcript, memory, tools, etc.)

This happens on ALL turns — user-initiated, autonomous commentary, tool follow-ups. The brain doesn't need a special trigger to see the screen. It always has access and decides what's relevant.

### Autonomous commentary triggers

Autonomous commentary fires when the scanner's vision model flags a frame as `urgency: "high"` — meaning something genuinely reaction-worthy happened (a dramatic gameplay moment, a visible error, a surprising event). The system also fires a one-time trigger on the first frame (`share_start`).

These triggers don't gate whether the brain speaks — they trigger a normal voice turn where the brain sees the frame + notes and decides whether to comment (or `[SKIP]`). The `autonomousCommentaryEnabled` setting controls whether these proactive triggers fire at all.

Commentary is subject to cost/safety gates (minimum cooldown, audio quiet window, no pending work) but the relevance decision lives in the vision model, not in deterministic rules. There is no silence-based trigger — the bot does not fill quiet moments just because it can.

Autonomous commentary is treated as optional speech, not as a normal conversational obligation:
- It does not start while another voice reply is already generating, draining, or deferred.
- If fresh user speech arrives before commentary audio begins, the commentary is dropped rather than requeued behind the user turn.
- Deferred stream-watch commentary keeps its original `stream_watch_brain_turn:*` source so the optional-speech interruption rules still apply after a flush delay.

### Session recap

When a watch session ends, the default text model summarizes the accumulated keyframe notes into a one-line memory fact for long-term context.

## Session Lifecycle

### Creation

- Triggered by: explicit user request (regex match on "share screen" etc.), model intent (confidence >= 0.66), or voice tool `start_screen_watch`
- `start_screen_watch` is the only model-facing action
- `start_screen_watch` can optionally include `{ target: "display name or user id" }` when the agent wants a specific Discord sharer
- Realtime instructions can already list active Discord sharers before a watch starts
- Runtime tries native Discord watch first through the selfbot's active voice session
- Native watch binds an explicit target first when one is provided and resolves cleanly
- An explicit target can use discovered Go Live state immediately, even before native video-state frames have populated the active-sharer roster
- Without an explicit target, native watch auto-binds only when runtime can identify a safe target:
  - requester has discovered Go Live state, even before credentials or frame-backed sharer state
  - requester is actively sharing
  - exactly one user is actively sharing
  - a single discovered Go Live target exists while the active-sharer roster is still empty
- If an explicit target resolves to someone in voice who is not actively sharing, link fallback can still target that user when `STREAM_LINK_FALLBACK=true`
- If native watch is unavailable, the runtime falls back to `ScreenShareSessionManager.createSession()`
- Fallback sessions reuse existing requester+target links when possible
- Set `STREAM_LINK_FALLBACK=false` to disable that fallback transport entirely and stay native-only

### Native Discord watch (Go Live + webcam)

Two transport modes exist for native Discord video:

**Go Live screen share** — the selfbot gateway tracks active sharers and stream credentials. `clankvox` opens a separate native `stream_watch` transport for the target user's active stream.
- For H264, `clankvox` maintains a persistent per-user OpenH264 decoder that accumulates reference frame state across all frames (IDR and P-frames). Decoded YUV is encoded to JPEG via turbojpeg and emitted as `DecodedVideoFrame` IPC messages with pre-encoded JPEG, width, height, and scene-cut metrics. JPEG emission is rate-limited to `nativeDiscordMaxFramesPerSecond` but the decoder sees every frame for state accumulation. The decoder auto-resets after 50 consecutive errors and sends PLI for recovery.
- For VP8, `clankvox` emits raw frame payloads through Bun IPC and Bun decodes sampled keyframes to JPEG via per-frame ffmpeg
- Decoded JPEGs (from either codec path) are forwarded into the existing stream-watch pipeline
- The latest decoded frame becomes normal voice-brain context on active turns
- Repeating `start_screen_watch` for the same native target reuses the active watch instead of reconnecting and preserves buffered frame context
- Successful native watch start can still be `waiting_for_frame_context`; runtime only reports `frameReady=true` once a decoded or buffered image frame exists for the watch session
- If multiple unrelated Discord sharers are active, the agent can pick one with `start_screen_watch({ target: "name" })`
- If multiple unrelated Discord sharers are active and no explicit target is provided, runtime does not guess a native target
- The same rolling-note scanner and commentary triggers apply regardless of transport
- Active native sharer metadata is prompt context, but image visibility still requires an active watch session
- Voice session tracks Go Live state in a `goLiveStream` field (active, streamKey, targetUserId, credentials) populated by stream discovery callbacks
- Link fallback is suppressed at two checkpoints when native watch is already active for the target (see `discord-streaming.md`)

**Webcam video** — when the target user has their webcam on but is NOT Go Live streaming, the system falls back to watching webcam video over the **main voice connection** (no separate transport needed):
- Go Live discovery fails (no stream key) → `enableWatchStreamForUser` checks if the target has a webcam stream via `sharerHasWebcamOnly()`
- If webcam detected, subscribes to the user's video on the main voice connection with `preferredStreamType: null` (accepts any stream type)
- Webcam video SSRC appears on the main voice UDP socket alongside audio
- clankvox sends OP15 media sink wants for the webcam SSRC on the voice connection (not stream_watch)
- The same H264 persistent decoder pipeline handles webcam frames
- Frames flow through the same `DecodedVideoFrame` IPC → `ingestStreamFrame` → vision model path
- Media sink wants are partitioned: screen SSRCs route to stream_watch, webcam SSRCs route to voice connection. Both can coexist.

### Share page fallback

- Route: `GET /share/:token`
- Browser-rendered HTML with embedded JS (no framework)
- `getDisplayMedia()` for screen/window/tab capture
- Capture loop: canvas -> JPEG -> POST to frame endpoint
- Countdown timer showing remaining session time
- Adaptive bitrate: downscale (0.82x) on `frame_too_large`, upscale (1.08x) after 20 successes

### Frame ingest

- Route: `POST /api/voice/share-session/:token/frame`
- Validates token, session TTL, and voice presence on every frame
- Auto-stops session if requester or target leaves VC
- Request: `{ mimeType: "image/jpeg", dataBase64: "...", source: "share_page" }`
- Response: `{ accepted: true/false, reason: "ok" | "frame_too_large" | ... }`

### Expiration

- Default TTL: 12 minutes (configurable 2-30 via `publicShareSessionTtlMinutes`)
- Max active sessions: 240

## Settings Reference

All under `voice.streamWatch`:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master toggle for screen watch, including native Discord receive and fallback capture |
| `brainContextMode` | `"direct"` | Vision pipeline mode: `"direct"` (brain sees raw frames) or `"context_brain"` (scanner triage) |
| `brainContextEnabled` | `true` | (context_brain mode) Run scanner and inject rolling notes into voice prompt |
| `brainContextProvider` | `"claude-oauth"` | LLM provider for background frame scanner |
| `brainContextModel` | `"claude-opus-4-6"` | Model for background frame scanner |
| `brainContextMinIntervalSeconds` | `2` | Min seconds between scanner updates |
| `brainContextMaxEntries` | `8` | (context_brain mode) Max rolling notes kept in brain context |
| `directMinIntervalSeconds` | `8` | (direct mode) Min seconds between direct brain turns (3-120) |
| `directMaxEntries` | `12` | (direct mode) Max rolling `[[NOTE:...]]` self-note buffer size (1-24) |
| `directChangeThreshold` | `0.15` | (direct mode) Coarse visual-change score that can trigger an earlier brain turn |
| `directChangeMinIntervalSeconds` | `4` | (direct mode) Cooldown for change-triggered brain turns |
| `nativeDiscordMaxFramesPerSecond` | `2` | Max native Discord frames requested while a native watch is active |
| `nativeDiscordPreferredQuality` | `100` | Preferred Discord stream quality hint for native subscriptions |
| `nativeDiscordPreferredPixelCount` | `921600` | Preferred native target resolution hint (`1280x720`) |
| `nativeDiscordPreferredStreamType` | `"screen"` | Preferred native Discord stream type hint |
| `autonomousCommentaryEnabled` | `true` | Fire proactive brain turns on scene change / silence |
| `minCommentaryIntervalSeconds` | `6` | Min seconds between autonomous commentary triggers |
| `maxFramesPerMinute` | `180` | Rate limit on frames admitted into the inference pipeline |
| `maxFrameBytes` | `350000` | Max frame payload size admitted into the inference pipeline |
| `keyframeIntervalMs` | `1200` | Fallback browser capture interval (500-2000) |
| `sharePageMaxWidthPx` | `960` | Fallback browser capture max width (640-1920) |
| `sharePageJpegQuality` | `0.6` | Fallback browser capture JPEG quality (0.5-0.75) |

Environment flags that shape the transport layer:

| Variable | Default | Description |
|---------|---------|-------------|
| `STREAM_LINK_FALLBACK` | `true` | Master env gate for the share-link transport. Set `false` to disable link creation, link recovery, and link capability reporting while keeping native Go Live watch enabled. |

The `brainContextMode` setting (`"direct"` or `"context_brain"`) determines which vision pipeline is active. In `direct` mode the brain sees raw frames; in `context_brain` mode the scanner builds temporal notes and only high-urgency frames trigger a brain turn. See the Design Philosophy section above for details on each mode.

The native Discord tuning fields above are canonical `voice.streamWatch` settings. They are currently used by runtime and persisted through the settings model, but they are not yet surfaced as dedicated dashboard controls.

If those native fields are absent, runtime uses these defaults:

- 2 fps max
- prefer `screen` streams
- prefer roughly 1280x720 target pixel count

H264 frames are decoded in-process by a persistent OpenH264 decoder in `clankvox` (Rust). The decoder maintains reference frame state across calls, so all frames — IDR keyframes and non-IDR P-frames — are fed to the decoder for state accumulation. JPEG emission is rate-limited to `nativeDiscordMaxFramesPerSecond`, but the decoder processes every frame to keep its reference state current. Decoded YUV is encoded to JPEG via turbojpeg and sent as `DecodedVideoFrame` IPC messages. Per-user decoder state is stored in `AppState.user_video_decoders`. The decoder auto-resets after 50 consecutive decode errors and sends PLI to request a fresh keyframe for recovery.
VP8 frames use per-frame ffmpeg decode on the Bun side (keyframe-only sampling).
If a native watch attaches mid-stream, `clankvox` reasserts Discord sink-wants and sends protected RTCP receiver-report / PLI / FIR feedback packets until the first renderable keyframe arrives so the H264 decoder can initialize reference state.
Those Discord sink-wants are a flat OP15 map with `any` and per-SSRC numeric quality entries, matching the desktop client wire shape.
Each new watch session resets native frame-readiness state. `frameReady=true` means current-session pixels are available, not stale success from an older watch.

## Dashboard visibility

The Voice tab mirrors the screen-watch pipeline as live state, not just action logs:

- **Keyframe Analyses** shows the per-frame scanner outputs that were saved into `brainContextEntries`.
- **Voice Context Builder** shows the configured scanner guidance prompt plus the accumulated notes currently eligible for injection into voice prompts.
- **Saved Screen Moments** shows durable screen moments the main voice brain decided to keep during the session.

This separates "what the scanner saw" from "what context the VC brain currently has available," which makes it easier to debug whether a bad screen-watch comment came from frame analysis, prompt compaction, or the main brain turn itself.

## API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/voice/share-session` | POST | `DASHBOARD_TOKEN` | Create tokenized session |
| `/api/voice/share-session/:token/frame` | POST | Token | Ingest frame |
| `/api/voice/share-session/:token/stop` | POST | Token | Stop session |
| `/share/:token` | GET | Public | Browser capture page |

## Voice Tool

**Name:** `start_screen_watch`
- Optional parameter: `{ target?: string }`
- `target` can be a display name, username, Discord mention, or Discord user id
- If `target` resolves to one active sharer, runtime watches that share
- If `target` resolves to a voice participant who is not actively sharing but has their webcam on, runtime watches the webcam video over the main voice connection
- If `target` resolves to a voice participant who is not actively sharing and has no webcam, runtime can still open the share-link fallback for that user when `STREAM_LINK_FALLBACK=true`
- If no `target` is provided, runtime only auto-picks when the requester is sharing or exactly one sharer is active
- If multiple sharers are active and no `target` is provided, runtime refuses instead of guessing
- Only available when `screenShareAvailable = true`
- Returns `{ ok, started, reused, reason, frameReady, transport, targetUserId, linkUrl, expiresInMinutes }`
- Native success reasons are `frame_context_ready` when a decoded or buffered frame already exists, or `waiting_for_frame_context` when transport is active but pixels are not ready yet

## Security Model

- Capability-token auth: share session token grants access to that session only
- Voice presence validated on every frame ingest
- Tokens are 18-byte random base64url, never logged in full
- Sessions auto-expire after TTL
- Session creation requires `DASHBOARD_TOKEN` (admin auth)
- Public URL gating defined in [`../operations/public-https.md`](../operations/public-https.md)

## Key Source Files

| File | Purpose |
|------|---------|
| `src/voice/voiceStreamWatch.ts` | Frame processing, scanner, commentary triggers, native transport lifecycle |
| `src/services/screenShareSessionManager.ts` | Fallback share-link manager and share page HTML |
| `src/bot/screenShare.ts` | Bot integration, native-first transport selection, fallback suppression |
| `src/voice/clankvox/src/video_decoder.rs` | Persistent OpenH264 H264 decoder, turbojpeg JPEG encode, scene-cut metrics |
| `src/voice/nativeDiscordVideoDecoder.ts` | VP8 keyframe decode to JPEG via ffmpeg (H264 is decoded in-process by clankvox) |
| `src/voice/nativeDiscordScreenShare.ts` | Active sharer tracking, target resolution, `sharerHasWebcamOnly()` webcam detection |
| `src/selfbot/streamDiscovery.ts` | Go Live stream discovery state, stream key management |
| `src/voice/voiceReplyPipeline.ts` | Frame + notes passed to brain generation |
| `src/prompts/promptVoice.ts` | Screen context in voice prompts |
| `src/dashboard/routesVoice.ts` | API endpoints |
| `src/settings/settingsSchema.ts` | Stream watch settings |
