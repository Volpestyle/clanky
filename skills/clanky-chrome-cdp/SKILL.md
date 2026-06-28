---
name: clanky-chrome-cdp
description: Legacy fallback note for Chrome DevTools Protocol work when the user already provides a running CDP endpoint.
when_to_use: Use only when the user explicitly asks for CDP or provides a running Chrome/Chromium remote-debugging endpoint. Prefer browser_control or Playwright for normal Clanky browsing.
allowed_tools: []
deps: []
---

# Chrome CDP

Clanky no longer ships CDP CLI scripts or a `chrome-remote-interface` dependency.
Do not claim `pnpm browser:cdp` or `pnpm browser:chrome-debug` exists in this
repo.

Prefer current surfaces:

- `browser_control` for the user's real browser through the browser-bridge extension.
- `web_render` / `web_capture_frames` for first-party rendered inspection.
- Playwright (`pnpm exec playwright ...`) for repeatable headless automation.

Use CDP only when the user explicitly exposes a local debugging endpoint, such as
`http://127.0.0.1:9222`, and the current task environment already has a CDP client
available outside this repo. Keep CDP ports local, do not attach to a personal
browser profile unless the user asked for it, and fall back to Playwright when CDP
is not specifically required.
