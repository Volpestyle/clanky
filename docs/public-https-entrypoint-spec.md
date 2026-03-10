# Public HTTPS Entrypoint

## Purpose

The public HTTPS entrypoint exposes the local dashboard/API (`localhost:8787`) over public HTTPS via Cloudflare Quick Tunnel, enabling remote access to share links and stream-frame ingest endpoints.

## Scope
- Add optional runtime-managed public HTTPS entrypoint via Cloudflare Quick Tunnel (`cloudflared`).
- Expose tunnel state in API runtime responses.
- Provide operational knobs through environment variables.
- Keep frame ingest routes authenticated via either private admin token, public API token, or short-lived share-session token.

## Runtime Behavior

### 1. Optional Public HTTPS Runtime
When `PUBLIC_HTTPS_ENABLED=true`:
- Bun process starts a child process:
  - `cloudflared tunnel --url <target> --no-autoupdate`
- The system watches child output and extracts a `https://*.trycloudflare.com` URL.
- On URL discovery, runtime state switches to `ready`.

When disabled:
- Runtime state remains `disabled`.
- No child process is created.

### 2. Health and State Exposure
API surfaces:
- `GET /api/public-https`
- `GET /api/stats` includes `runtime.publicHttps`

State shape:
```json
{
  "enabled": true,
  "provider": "cloudflared",
  "status": "ready",
  "targetUrl": "http://127.0.0.1:8787",
  "publicUrl": "https://example.trycloudflare.com",
  "pid": 12345,
  "startedAt": "2026-02-27T12:34:56.789Z",
  "lastError": ""
}
```

`status` values:
- `disabled`
- `idle`
- `starting`
- `ready`
- `error`
- `stopped`

### 3. Public/Private Route Gating
- Tunnel-host requests are treated as public ingress traffic.
- Public ingress allowlist is intentionally narrow:
  - `POST /api/voice/stream-ingest/frame`
  - tokenized `POST /api/voice/share-session/:token/frame`
  - tokenized `POST /api/voice/share-session/:token/stop`
  - `GET /share/:token`
- Non-allowlisted API routes on tunnel host (without a valid token) return `404`.
- Dashboard UI/static routes on tunnel host return `404` unless they are tokenized share pages.
- Local dashboard browser login uses `POST /api/auth/session` to mint an HTTP-only signed session cookie.
- Dashboard auth-session routes are not exposed on the tunnel host.
- Public header-token routes (`/api/voice/stream-ingest/frame`) accept either:
  - `x-dashboard-token` matching `DASHBOARD_TOKEN`, or
  - `x-public-api-token` matching `PUBLIC_API_TOKEN`.
- If neither token is configured, header-token routes return `503`.
- Private/local admin routes require a dashboard session cookie or `x-dashboard-token` when public HTTPS is enabled.
- Remote admin API access over the tunnel continues to use `x-dashboard-token` directly; the browser-login flow stays local-only.
- Dashboard/API listener defaults to loopback host (`127.0.0.1`) unless explicitly overridden.
- Frame ingress applies fixed-window rate limiting and declared payload-size checks on public paths.

### 4. Failure Handling
- If `cloudflared` is missing or exits unexpectedly:
  - state becomes `error`
  - action log records `bot_error`
  - automatic retry runs after a short delay for runtime exits
  - spawn `ENOENT` (missing binary) blocks automatic retry until operator fixes config/binary and restarts

### 5. Shutdown Behavior
- On process shutdown:
  - bot disconnects
  - public HTTPS child process receives termination signal
  - dashboard server closes

## Configuration

Environment variables:
- `PUBLIC_HTTPS_ENABLED` (`true|false`, default `false`)
- `PUBLIC_HTTPS_TARGET_URL` (optional, default `http://127.0.0.1:${DASHBOARD_PORT}`)
- `PUBLIC_HTTPS_CLOUDFLARED_BIN` (optional, default `cloudflared`)
- `PUBLIC_API_TOKEN` (optional; enables public-header auth path for allowlisted ingest route)
- `DASHBOARD_HOST` (optional bind host, default `127.0.0.1`)
- `DASHBOARD_TOKEN` (required for private/admin APIs when `PUBLIC_HTTPS_ENABLED=true`)

## Security Model
- Public HTTPS entrypoint requires full API auth.
- Browser dashboard auth uses an HTTP-only signed cookie so the admin token is not stored in browser localStorage or replayed on every request.
- Stream ingest endpoint requires either private admin auth (`DASHBOARD_TOKEN`) or public ingress auth (`PUBLIC_API_TOKEN`).
- The tunnel URL should be treated as an untrusted public entrypoint; tokens must be kept secret.

## Observability
- Action stream includes:
  - `public_https_entrypoint_starting` (`bot_runtime`)
  - `public_https_entrypoint_ready` (`bot_runtime`)
  - spawn/exit/log failures (`bot_error`)
- Dashboard metrics include a `Public HTTPS` card showing current state/URL host.

## Setup

1. Install `cloudflared`.
2. Set `.env`:
   - `PUBLIC_HTTPS_ENABLED=true`
   - `DASHBOARD_TOKEN=<strong secret>` (required for private/admin APIs)
   - optionally `PUBLIC_API_TOKEN=<strong secret>` (for public-header ingress auth)
3. Start the bot: `bun run start`.
4. Confirm tunnel:
   - Dashboard `Public HTTPS` metric, or
   - `GET /api/public-https`.
5. The returned HTTPS origin is used for remote share workflows.
