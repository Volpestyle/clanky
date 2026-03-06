# Screen Share Link

Updated: February 28, 2026

## Purpose

The screen-share link system enables the bot to send a temporary clickable link in Discord that opens a browser-based screen capture page. Captured frames are streamed back to the bot voice session for visual commentary.

## Runtime Flow

1. A channel member requests screen sharing, or the model determines a visual would be helpful.
2. The reply model sets `screenShareIntent.action=offer_link`.
3. The bot creates a short-lived tokenized share session via `ScreenShareSessionManager`.
4. The bot replies with a tokenized share URL:
   - Local fallback: `http://127.0.0.1:<DASHBOARD_PORT>/share/<token>`
   - Public tunnel (when enabled): `https://.../share/<token>`
5. The link opens a browser capture page; clicking `Start Sharing` begins frame transmission.
6. The browser posts display frames to `/api/voice/share-session/:token/frame`.
7. Frames are ingested through the existing stream-watch flow and the bot comments in the voice channel.

## Scope
- Structured reply support for `screenShareIntent`.
- Tokenized share-session manager with TTL.
- Public share page route (`/share/:token`).
- Token-auth frame ingest endpoints.
- Programmatic `watch_stream` arm on valid share session creation.

## Guardrails
- Share sessions expire automatically (default 12 minutes).
- Session creation requires current VC policy to pass:
  - active voice session in guild
  - requester in same VC
  - stream watch enabled
  - current voice session supports stream-watch commentary (`supportsStreamWatchCommentary`) — either native realtime frame commentary support or configured vision-fallback commentary
- Frame ingest revalidates requester/target VC presence and auto-stops the share session if either leaves.
- Commentary responses are tracked separately from conversation responses via `metadata: { source: "stream_watch_commentary" }`. New commentary is skipped while a previous one is in-flight, preventing stale frame descriptions from stacking up on the provider side.
- Public ingress route-gating and token/header auth rules are defined in `docs/public-https-entrypoint-spec.md`.
- When public HTTPS is disabled, share links are localhost-only and intended for the machine running the bot.

## Endpoints
- `POST /api/voice/share-session` (create tokenized session, admin/private auth path)
- `POST /api/voice/share-session/:token/frame` (token route)
- `POST /api/voice/share-session/:token/stop` (token route)
- `GET /share/:token` (browser capture page)

## Security Model
- Share-session token is capability-style auth for that single session route only.
- `PUBLIC_API_TOKEN` is still supported for direct frame-ingest routes outside share-session token URLs.
- `DASHBOARD_TOKEN` remains admin/private API auth.
