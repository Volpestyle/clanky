# @clanky/browser-bridge

Lets the local Clanky agent control tabs in the user's real Chromium-based browser (Helium, Google Chrome, Brave) by pairing a local helper daemon with a Chrome MV3 extension over WebSocket.

This transport works in Helium (which strips `chrome.runtime.connectNative`) as well as in stock Chrome and Brave.

## Architecture

```
Clanky tool ──HTTP──▶ daemon ◀──WebSocket── extension SW ──chrome.tabs.create──▶ tab
                       127.0.0.1:<port>      (in Helium / Chrome / Brave)
```

- The daemon is a Node process started by `pnpm browser-bridge:serve`. It listens on `127.0.0.1:<port>` (default `41783`, override with `CLANKY_BROWSER_BRIDGE_PORT`) and accepts both:
  - Incoming HTTP from Clanky tools (`POST /tabs` etc.) authenticated with `X-Clanky-Token`.
  - Incoming WebSocket upgrades from the extension on `/agent?token=...`.
- The extension's service worker reads its bundled `config.json` (written at install time) for the daemon port and token, opens a WebSocket, and waits for ops. A 24s `chrome.alarms` watchdog keeps the SW from being killed during idle periods and reopens the socket if it drops.
- The daemon writes `~/.clanky/browser-bridge/state.json` (mode `0600`) with `{ port, pid, secret, browser, startedAt, connectedBrowsers }`. Clanky-side `browser_open_tab` reads the state to discover where to send commands. State is removed when the daemon exits.

## Install

```sh
pnpm browser-bridge:install
```

The installer:

1. Generates an extension RSA key in `~/.clanky/browser-bridge/extension-key.pem` (first run only) and derives a stable extension id.
2. Generates a 32-byte hex auth token (first run only) and writes both `~/.clanky/browser-bridge/config.json` (daemon) and `~/.clanky/browser-bridge/extension/config.json` (bundled with the extension).
3. Materializes the extension into `~/.clanky/browser-bridge/extension/` with the key baked into `manifest.json`.

Finish the install:

```sh
pnpm browser-bridge:serve
```

Leave that running, then load the unpacked extension in chrome://extensions → Load Unpacked → `~/.clanky/browser-bridge/extension`.

## Tools

Clanky's eve agent exposes these through the unified `browser_control` tool:
`browser_control({ op: "snapshot", params: { tabId: 1 } })`. The package
client helpers use `browserSnapshot(...)`-style names for direct TypeScript
callers.

Tabs & history:

- `browser_open_tab({ url, active? })` — opens a tab. Returns `{ tabId, url, windowId, active, browser }`.
- `browser_navigate({ url, tabId? })` — navigates a tab (opens one if `tabId` omitted). Returns when navigation is *initiated*, not loaded.
- `browser_list_tabs()` — returns `{ tabs: [{ tabId, url, title, active, windowId }] }`.
- `browser_close_tab({ tabId })`.
- `browser_back({ tabId })` / `browser_forward({ tabId })` / `browser_reload({ tabId, bypassCache? })` — history navigation. Like `navigate`, these return as navigation *initiates*; the echoed `url`/`title` may be the pre-navigation page, so follow with `browser_wait_for`.

Read & extract (via `chrome.scripting`, no debugger bar):

- `browserSnapshot({ tabId, maxTextChars?, maxLinks?, maxMedia?, maxElements? })` / `op: "snapshot"` — returns `{ tabId, url, title, text, length, truncated, viewport, links, media, elements, counts }`. `elements` includes visible/actionable links, buttons, inputs, selects, textareas, contenteditable nodes, and common ARIA controls with selectors plus CSS-pixel rects; use those `centerX`/`centerY` values directly with input ops.
- `browser_read_text({ tabId, maxChars? })` — returns `{ tabId, url, title, text, length, truncated }` where `text` is the rendered `document.body.innerText` (post-JS), truncated to `maxChars` (default 20000). Flat text only — no links or structure.
- `browser_query({ tabId, selector, all?, scrollIntoView? })` — locate elements by CSS selector. Returns `{ found, count, element | elements }` where each element is `{ tag, rect: { x, y, width, height, centerX, centerY }, text, value, href, visible, inViewport }`. `rect` is in CSS pixels — pass `centerX`/`centerY` straight to `browser_click`. The reliable alternative to eyeballing screenshot coordinates.
- `browser_fill({ tabId, selector, value })` — focus an input/textarea/select/contenteditable and set its value via the native setter, firing `input` + `change` (replaces existing text; `value:""` clears). Works with React-controlled inputs. Returns `{ tabId, selector, value }`.

Eval & sync:

- `browser_eval({ tabId, expression, awaitPromise? })` — evaluate a JS expression in the page main world via CDP and return its JSON-serializable value as `{ tabId, value }`. The power tool for structured extraction and reading page state; wrap multi-statement logic in an IIFE. Attaches the debugger (shows the yellow bar). Page exceptions are returned as an error.
- `browser_wait_for({ tabId, selector?, jsCondition?, readyState?, visible?, timeoutMs?, pollMs? })` — block until a condition holds: a selector matches (optionally visible), `document.readyState` reaches a level, or a JS condition is truthy. Returns `{ ok, waitedMs, timedOut }`. `timeoutMs` defaults to 10000, capped at 30000.

Vision + input (via `chrome.debugger` CDP; shows the yellow debugging bar):

- `browser_screenshot({ tabId? })` — returns `{ tabId, dataUrl, width, height, capturedWidth, capturedHeight, devicePixelRatio, url, title }`. The PNG is downscaled to the CSS viewport, so `width`/`height` (and the coordinates you read off it) match the CSS-pixel space used by the input ops — no devicePixelRatio math. Activates the target tab to capture it.
- `browser_click` / `browser_double_click({ tabId, x, y, button? })`, `browser_type({ tabId, text })`, `browser_key({ tabId, key, modifiers? })`, `browser_scroll({ tabId, x, y, deltaX, deltaY })`, `browser_hover({ tabId, x, y })` (updates hover state to reveal `:hover` menus/tooltips).
- `browser_wait({ ms })` — daemon-side sleep (≤30000 ms) between vision ops. Prefer `browser_wait_for` when you are waiting on the page rather than a fixed delay.

Input fidelity notes:

- `browser_type` uses CDP `Input.insertText`: it sets the value and fires `input` but **no** `keydown`/`keypress`. For per-key behavior use `browser_key`.
- `browser_key` with `key: "Enter"` fires a real `keypress`, so it triggers implicit form submission and textarea newlines.
- Browser accelerators like ⌘A / Ctrl+A are **not** delivered to the page through CDP. To clear or replace a field, use `browser_fill`, not select-all + retype.

The daemon advertises the connected extension's `version` and an `expectedExtensionVersion` (the packaged manifest version) on `GET /healthz` and in `state.json`, with a `stale` flag per connection. `browser_control` with `{"op":"status"}` surfaces this so a stale (un-reloaded) extension is diagnosable instead of failing with a bare `unknown op`. The daemon re-reads `expectedExtensionVersion` on each `/healthz`, so after upgrading this package you only need to reload the unpacked extension — the running daemon picks up the new packaged version on its own.

## Adding more tools

1. Add the op to `extension/background.js` `dispatch()` (and bump `extension/manifest.template.json` `version`).
2. Add a route in `src/server.ts` (HTTP side) and forward through `dispatch()` (WS side).
3. Add a typed client helper in `src/client.ts` and re-export it from `src/index.ts`.
4. Register the tool in `packages/clanky-core/src/agent-tools.ts` and wire the handler in `agents/clanky/src/handlers.ts`.

Keep ops idempotent and avoid blocking work in the service worker; MV3 SWs can be suspended at any time, and the alarm watchdog will reconnect rather than queue dropped work.

## Testing the extension end to end

Modern Chrome/Chromium (≈137+) has removed the `--load-extension` command-line switch, so you cannot side-load the unpacked extension into a headless Chrome you launch yourself. To exercise the real `background.js` against a live daemon without touching the user's browser, run an isolated daemon + a Playwright-driven Chromium that loads the extension:

```sh
# Isolated home + port so nothing collides with the user's real bridge:
CLANKY_HOME=/tmp/clanky-test-home CLANKY_BROWSER_BRIDGE_PORT=41799 pnpm browser-bridge:install
CLANKY_HOME=/tmp/clanky-test-home CLANKY_BROWSER_BRIDGE_PORT=41799 pnpm browser-bridge:serve &
```

```ts
// Playwright's bundled Chromium still honors --load-extension in a *headed* persistent context:
import { chromium } from "playwright";
const EXT = "/tmp/clanky-test-home/browser-bridge/extension";
const ctx = await chromium.launchPersistentContext("/tmp/clanky-pw-profile", {
  headless: false, // extensions/service workers + the debugger need headed mode
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ctx.waitForEvent("serviceworker"); // SW connects to the daemon on its own
```

Then drive the bridge with the typed client (`browserOpenTab`, `browserReadText`, …) passing `{ homeDir: "/tmp/clanky-test-home" }`, or hit the HTTP API directly with the token from `~/.clanky/.../config.json`.
