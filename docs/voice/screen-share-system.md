# Screen Share System

Complete documentation of the screen share pipeline: session lifecycle, frame processing, and how the agent sees and reasons about what's on screen.

See also: [`docs/public-https-entrypoint-spec.md`](../public-https-entrypoint-spec.md) (public URL gating).
Native Discord receive status: [`../native-discord-screen-share.md`](../native-discord-screen-share.md)
Cross-cutting settings contract: [`../settings.md`](../settings.md)

Persistence, preset inheritance, dashboard envelope shape, and save/version semantics live in [`../settings.md`](../settings.md). This document covers the screen-share pipeline and the stream-watch settings that shape voice-local visual context.

## Design Philosophy

Screen sharing gives the agent eyes. The architecture follows the same autonomy principle as the rest of the system: **give the agent rich context and let it decide what to do.**

A human sitting next to someone sharing their screen would:
- See the screen continuously
- Remember what they saw before (temporal awareness)
- Decide when to comment, ask a question, or stay quiet
- Reference earlier screen states in conversation ("you changed that function signature from before")

The agent should work the same way. Two independent, always-on layers feed into the brain's normal context:

```
Every frame → Scanner (cheap/fast model) → rolling temporal notes
                                                    ↓
                                             always in voice prompt

Every voice turn during active screenshare:
    brain sees = latest raw frame + rolling notes + conversation
    brain decides what to say (or [SKIP])

Autonomous commentary (silence / scene change):
    brain gets frame + notes, decides whether to speak
```

**Scanner** builds temporal awareness — "they switched from VS Code to the browser", "new error dialog appeared", "they've been on this settings page for 30 seconds."

**Direct frame** gives visual accuracy — the model sees exactly what's on screen right now.

These are **orthogonal, not mutually exclusive.** The scanner always runs to build rolling context. The brain always sees the current frame when generating a reply. The brain decides whether and how to reference what it sees.

## Architecture Overview

![Screen Share System Diagram](../diagrams/screen-share-system.png)

<!-- source: docs/diagrams/screen-share-system.mmd -->

```
Discord VC user says "share my screen"
         │
         ▼
  Reply pipeline / voice tool
  (offer_screen_share_link)
         │
         ▼
  ScreenShareSessionManager.createSession()
  ├─ Validate VC presence (requester + target in same channel)
  ├─ Generate 18-byte base64url token
  ├─ Enable stream-watch for target user
  └─ Return share URL
         │
         ▼
  Bot sends link to Discord text channel
         │
         ▼
  User clicks link → browser opens /share/:token
         │
         ▼
  Share page capture loop (every keyframeIntervalMs):
  ├─ getDisplayMedia() → canvas → JPEG encode
  ├─ POST /api/voice/share-session/:token/frame
  └─ Adaptive bitrate (downscale on error, upscale after 20 success)
         │
         ▼
  ScreenShareSessionManager.ingestFrameByToken()
  ├─ Validate token + voice presence on every frame
  ├─ Rearm stream-watch if needed
  └─ Feed to frame processing pipeline
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
  │  - sceneChanged bool │                           │
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

The scanner runs a cheap/fast model on ingested frames at a configurable interval (default every 4 seconds). It extracts a short observation note and a `sceneChanged` flag. Notes accumulate in `brainContextEntries` (max 8 by default), with timestamps for aging.

The scanner does NOT decide whether the brain should speak. Its job is observation only — building the temporal context that lets the brain say things like "oh you're back on the code editor" or "looks like that error is gone now."

Scanner provider and model are independently configurable (`brainContextProvider`, `brainContextModel`) and do not affect whether the brain sees raw frames.

### Brain frame access

During any voice turn while screenshare is active, the generation model receives:
- **Current raw frame** as an image input (the latest captured JPEG)
- **Rolling scanner notes** in the prompt context (timestamped observations)
- **Normal conversation context** (transcript, memory, tools, etc.)

This happens on ALL turns — user-initiated, autonomous commentary, tool follow-ups. The brain doesn't need a special trigger to see the screen. It always has access and decides what's relevant.

### Autonomous commentary triggers

When nobody is speaking, the system periodically checks whether to fire a brain turn with the current frame. Triggers:

- **Scene change** — scanner flagged `sceneChanged: true`
- **Extended silence** — no speech for 10+ seconds while frames are arriving
- **First frame** — initial share start

These triggers don't gate whether the brain speaks — they trigger a normal voice turn where the brain sees the frame + notes and decides whether to comment (or `[SKIP]`). The `autonomousCommentaryEnabled` setting controls whether these proactive triggers fire at all.

Autonomous commentary is treated as optional speech, not as a normal conversational obligation:
- It does not start while another voice reply is already generating, draining, or deferred.
- If fresh user speech arrives before commentary audio begins, the commentary is dropped rather than requeued behind the user turn.
- Deferred stream-watch commentary keeps its original `stream_watch_brain_turn:*` source so the optional-speech interruption rules still apply after a flush delay.

### Session recap

When a share session ends, the default text model summarizes the accumulated keyframe notes into a one-line memory fact for long-term context.

## Session Lifecycle

### Creation

- Triggered by: explicit user request (regex match on "share screen" etc.), model intent (confidence >= 0.66), or voice tool `offer_screen_share_link`
- `ScreenShareSessionManager.createSession()` generates a token and URL
- Reuses existing sessions for same requester+target pair
- Auto-enables stream-watch for the target user

### Share page

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
| `enabled` | `true` | Master toggle for stream frame ingest |
| `brainContextEnabled` | `true` | Run scanner and inject rolling notes into voice prompt |
| `brainContextProvider` | `"claude-oauth"` | LLM provider for background frame scanner |
| `brainContextModel` | `"claude-opus-4-6"` | Model for background frame scanner |
| `brainContextMinIntervalSeconds` | `4` | Min seconds between scanner updates |
| `brainContextMaxEntries` | `8` | Max rolling notes kept in brain context |
| `autonomousCommentaryEnabled` | `true` | Fire proactive brain turns on scene change / silence |
| `minCommentaryIntervalSeconds` | `8` | Min seconds between autonomous commentary triggers |
| `maxFramesPerMinute` | `180` | Rate limit on ingested frames |
| `maxFrameBytes` | `350000` | Max JPEG payload size per frame |
| `keyframeIntervalMs` | `1200` | Capture interval for share page (500-2000) |
| `sharePageMaxWidthPx` | `960` | Max capture width (640-1920) |
| `sharePageJpegQuality` | `0.6` | JPEG quality (0.5-0.75) |

Both layers are always active — there is no routing decision between "direct to brain" and "scanner generated." The brain always sees the frame; the scanner always builds temporal notes.

## Dashboard visibility

The Voice tab mirrors the screen-share pipeline as live state, not just action logs:

- **Keyframe Analyses** shows the per-frame scanner outputs that were saved into `brainContextEntries`.
- **Voice Context Builder** shows the configured scanner guidance prompt plus the accumulated notes currently eligible for injection into voice prompts.
- **Saved Screen Moments** shows durable screen moments the main voice brain decided to keep during the session.

This separates "what the scanner saw" from "what context the VC brain currently has available," which makes it easier to debug whether a bad screen-share comment came from frame analysis, prompt compaction, or the main brain turn itself.

## API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/voice/share-session` | POST | `DASHBOARD_TOKEN` | Create tokenized session |
| `/api/voice/share-session/:token/frame` | POST | Token | Ingest frame |
| `/api/voice/share-session/:token/stop` | POST | Token | Stop session |
| `/share/:token` | GET | Public | Browser capture page |

## Voice Tool

**Name:** `offer_screen_share_link`
- No parameters
- Only available when `screenShareAvailable = true`
- Returns `{ ok, offered, reused, reason, linkUrl, expiresInMinutes }`

## Security Model

- Capability-token auth: share session token grants access to that session only
- Voice presence validated on every frame ingest
- Tokens are 18-byte random base64url, never logged in full
- Sessions auto-expire after TTL
- Session creation requires `DASHBOARD_TOKEN` (admin auth)
- Public URL gating defined in [`docs/public-https-entrypoint-spec.md`](../public-https-entrypoint-spec.md)

## Key Source Files

| File | Purpose |
|------|---------|
| `src/voice/voiceStreamWatch.ts` | Frame processing, scanner, commentary triggers |
| `src/services/screenShareSessionManager.ts` | Session manager, share page HTML |
| `src/bot/screenShare.ts` | Bot integration, intent detection, link offering |
| `src/voice/voiceReplyPipeline.ts` | Frame + notes passed to brain generation |
| `src/prompts/promptVoice.ts` | Screen context in voice prompts |
| `src/dashboard/routesVoice.ts` | API endpoints |
| `src/settings/settingsSchema.ts` | Stream watch settings |
