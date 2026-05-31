# Vision-ops spec — `@clanky/browser-bridge` v0.3.0

> This document is the **single source of truth** for two parallel sub-agent implementations. The wire protocol and op shapes below are pinned — both sides must match exactly.

## v0.4.0 changes (supersedes parts of this spec)

The v0.3.0 spec below is kept for the wire-protocol/handshake reference, but these decisions changed in v0.4.0:

- **`read_text` is now in scope** (was "out of scope"). Op `read_text { tabId, maxChars? }` → `{ tabId, url, title, text, length, truncated }`, implemented in the extension via `chrome.scripting.executeScript` (manifest gained the `scripting` permission). No debugger attach, so no yellow bar. HTTP route `POST /read-text`, client `browserReadText`, tool `browser_read_text`.
- **Coordinate system corrected.** The v0.3.0 claim that screenshot pixels equal CSS input pixels with "no devicePixelRatio adjustment" is false on HiDPI/Retina displays: `captureVisibleTab` returns the display's backing-store pixels (e.g. 2x), and `window.devicePixelRatio` does **not** reliably reveal the factor under emulated viewports. `screenshot` now reads the CSS viewport (`innerWidth`/`innerHeight` via `chrome.scripting`) and **downscales the PNG to CSS pixels** before returning, so screenshot pixels == CDP input pixels again. Result adds `capturedWidth`, `capturedHeight`, `devicePixelRatio`, `url`, `title`.
- **Extension version handshake.** The `hello` message now includes `version` (`chrome.runtime.getManifest().version`). The daemon tracks it per client, computes `stale` against the packaged manifest version, and exposes `expectedExtensionVersion` + `extensions[]` on `/healthz` and in `state.json`. `web_backend_status` surfaces a `staleExtension` warning so an un-reloaded extension is diagnosable instead of failing with a bare `unknown op`.
- **Duplicate-connection fix.** `connect()` in `background.js` now holds a synchronous `connecting` guard so overlapping triggers (onStartup/onInstalled/alarm/initial) cannot each open a socket while the first awaits `loadConfig()`.

## v0.6.0 changes (selector + extraction op set; supersedes parts of this spec)

Driving by screenshot coordinates alone proved brittle — eyeballed coordinates miss targets, and `read_text` can't return links/structure. v0.6.0 adds a selector/extraction layer and fixes input fidelity. Each op is wired end to end (extension `dispatch()` → `src/server.ts` route → `src/client.ts` helper → `src/index.ts` export → `agent-tools.ts` tool → `handlers.ts`).

New ops:

- `query { tabId, selector, all?, scrollIntoView? }` → `{ found, count, element | elements }` with each element as `{ tag, rect: { x, y, width, height, centerX, centerY }, text, value, href, visible, inViewport }`. `chrome.scripting`, no debugger bar. `rect` is CSS pixels — `centerX`/`centerY` feed `click` directly. Routes `POST /query`, client `browserQuery`, tool `browser_query`.
- `eval { tabId, expression, awaitPromise? }` → `{ tabId, value }`. CDP `Runtime.evaluate` in the page main world (wrapped as an IIFE, `returnByValue`, `awaitPromise`); throws surface the exception string. The power tool for structured extraction and reading page state. `POST /eval`, `browserEval`, `browser_eval`.
- `fill { tabId, selector, value }` → `{ tabId, selector, value }`. Focuses and sets the value via the native setter (React-safe) and fires `input` + `change`; `value:""` clears. The reliable clear/replace primitive. `POST /fill`, `browserFill`, `browser_fill`.
- `wait_for { tabId, selector?, jsCondition?, readyState?, visible?, timeoutMs?, pollMs? }` → `{ tabId, ok, waitedMs, timedOut }`. Extension-side poll loop (caps at 30s) so callers can stop guessing with `wait` after navigation. `POST /wait-for`, `browserWaitFor`, `browser_wait_for`.
- `back` / `forward` / `reload { tabId, bypassCache? }` → `{ tabId, url, title }` via `chrome.tabs.goBack`/`goForward`/`reload`. Like `navigate`, they return on initiate. `POST /tabs/back|forward|reload`, `browserBack`/`browserForward`/`browserReload`.
- `hover { tabId, x, y }` → `{ ok: true }`. CDP `Input.dispatchMouseEvent` `mouseMoved` to update hover state (reveals `:hover` menus/tooltips). `POST /input/hover`, `browserHover`, `browser_hover`.

Fidelity fixes:

- **Enter submits forms.** `key` now sends `text: "\r"` on the Enter keyDown so CDP emits a DOM `keypress`, which is what triggers implicit form submission (and textarea newlines). Without it, Enter fired keydown/keyup but no keypress and forms never submitted.
- **`double_click` fires `dblclick`.** It now dispatches two full press/release pairs (clickCount 1 then 2) instead of one pair with `clickCount: 2`, so the renderer synthesizes a real `dblclick`. Mouse events also carry the `buttons` bitmask.
- **Single-char shortcuts.** `key` derives `code`/`windowsVirtualKeyCode` for `a`–`z`/`0`–`9` and drops `text` when a command modifier is held, improving accelerator fidelity. (Note: browser-level accelerators like ⌘A are still not delivered to the page through CDP — use `fill` to clear/replace fields.)
- **Live stale detection.** The daemon re-reads the packaged manifest version on each `/healthz`, so upgrading the package no longer requires a daemon restart for stale detection to be accurate.

Known limitations: `query`/`eval`/`read_text`/`fill` target the **top frame only**; for `<iframe>` content, open the frame's `src` as its own tab. Browser accelerators (⌘A/⌘C) are not delivered via CDP.

## Goal

Add a minimum vision-driven op set so an external client (Clanky tools) can drive the user's actual browser using screenshots + coordinates instead of selectors.

## Architecture (unchanged)

```
Clanky tool ──HTTP──▶ daemon ◀──WebSocket── extension SW ──CDP──▶ tab
                     127.0.0.1:41783
```

## Op set (final)

All ops below are exposed to **both** the external HTTP client and the WebSocket extension transport, **except** `wait`, which is daemon-only.

| Op | Params | Result | Owner | Notes |
|---|---|---|---|---|
| `screenshot` | `{ tabId?: number }` | `{ tabId, dataUrl, width, height }` | Both | `dataUrl` = `data:image/png;base64,...`. If `tabId` is provided, activates that tab before capture because `chrome.tabs.captureVisibleTab` captures the active tab in a window. If no `tabId`, captures the active tab in the focused window. Width/height are decoded from the PNG. No CDP attach needed. |
| `list_tabs` | `{}` | `{ tabs: Array<{ tabId, url, title, active, windowId }> }` | Both | `chrome.tabs.query({})`. No CDP attach needed. |
| `navigate` | `{ tabId?: number, url: string }` | `{ tabId, url }` | Both | If no `tabId`, opens a new tab. Validate URL like existing `open_tab` (`http(s)`, `about:`, `chrome://`). No CDP attach needed. |
| `close_tab` | `{ tabId: number }` | `{ ok: true }` | Both | `chrome.tabs.remove(tabId)`. No CDP attach needed. |
| `click` | `{ tabId: number, x: number, y: number, button?: "left" \| "right" \| "middle", clickCount?: number }` | `{ ok: true }` | Both | CSS pixels of visible viewport. Sends CDP `Input.dispatchMouseEvent` mousePressed + mouseReleased. Defaults: `button="left"`, `clickCount=1`. |
| `double_click` | `{ tabId: number, x: number, y: number, button?: "left" \| "right" \| "middle" }` | `{ ok: true }` | Both | Convenience for `click` with `clickCount=2`. Implemented in the extension as a single CDP pair with `clickCount: 2`. |
| `type` | `{ tabId: number, text: string }` | `{ ok: true }` | Both | CDP `Input.insertText` — works for text fields, not special keys. |
| `key` | `{ tabId: number, key: string, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean } }` | `{ ok: true }` | Both | `key` matches DOM `KeyboardEvent.key` ("Enter", "Tab", "Escape", "ArrowLeft", "a", etc.). CDP `Input.dispatchKeyEvent` keyDown + keyUp. Modifier bitmask: ctrl=2, shift=8, alt=1, meta=4 (sum them). |
| `scroll` | `{ tabId: number, x: number, y: number, deltaX: number, deltaY: number }` | `{ ok: true }` | Both | CDP `Input.dispatchMouseEvent` type `mouseWheel` at (x,y) with deltaX/deltaY. |
| `wait` | `{ ms: number }` | `{ ok: true, waitedMs: number }` | **Daemon only** | Server-side `setTimeout`. Cap at 30_000 ms; reject larger. No WS round-trip. |

Plus existing `open_tab` — kept as-is for backward compat.

## Wire protocol (pinned — both sides must match exactly)

Already in use, just being extended. The daemon's existing `dispatch()` in `server.ts:177` already handles this shape; do not change it.

**Daemon → extension:**
```json
{ "id": <number>, "op": "<op-name>", "<paramKey>": <value>, ... }
```

Every param from the op table above is sent as a top-level field on this message (not nested under a `params` key).

**Extension → daemon (success):**
```json
{ "id": <number>, "ok": true, "result": <result-object> }
```

**Extension → daemon (failure):**
```json
{ "id": <number>, "ok": false, "error": "<message>" }
```

Errors should be plain strings — the daemon wraps them.

## Coordinate system

CSS pixels of the **visible viewport** (top-left = `(0, 0)`). This matches what `captureVisibleTab` returns. The model receives a screenshot and emits coordinates in that screenshot's pixel space. CDP `Input.dispatchMouseEvent` uses CSS pixels by default — no devicePixelRatio adjustment.

## CDP lifecycle (extension owner)

- Maintain a `Set<tabId>` of attached tabs in `background.js`.
- `_ensureAttached(tabId)` lazily calls `chrome.debugger.attach({ tabId }, "1.3")` on first input op for that tab.
- `chrome.tabs.onRemoved` → remove from set (Chrome auto-detaches).
- `chrome.debugger.onDetach` listener → remove from set (e.g. user clicked "Cancel" on the yellow bar).
- Only input ops require attach: `click`, `double_click`, `type`, `key`, `scroll`.
- `screenshot`, `list_tabs`, `navigate`, `close_tab`, `open_tab` do **not** require attach.
- Yellow "extension is debugging this tab" bar is expected and desirable (user-visible trust signal).

## Manifest changes (`extension/manifest.template.json`)

```diff
- "version": "0.2.0",
+ "version": "0.3.0",
- "permissions": ["tabs", "alarms"],
+ "permissions": ["tabs", "alarms", "debugger"],
- "host_permissions": ["ws://127.0.0.1/*", "wss://127.0.0.1/*"],
+ "host_permissions": ["ws://127.0.0.1/*", "wss://127.0.0.1/*", "<all_urls>"],
```

`<all_urls>` is required for `captureVisibleTab` on arbitrary URLs. `debugger` is required for CDP input dispatch.

## Timeouts (daemon `dispatch(op, params, timeoutMs)`)

- `screenshot`, `click`, `double_click`, `type`, `key`, `scroll`, `list_tabs`, `close_tab`: **5_000 ms**
- `navigate`: **15_000 ms**
- `open_tab`: **15_000 ms** (unchanged)
- `wait`: not applicable (daemon-only)

## HTTP routes (Agent B)

All require `X-Clanky-Token` header (existing auth pattern, `server.ts:103`). All accept POST with JSON body matching the op params.

- `POST /screenshot`
- `POST /tabs/list`
- `POST /tabs/navigate`
- `POST /tabs/close`
- `POST /input/click`
- `POST /input/double-click`
- `POST /input/type`
- `POST /input/key`
- `POST /input/scroll`
- `POST /wait` (daemon-only, no WS forward)

Existing `POST /tabs` (open_tab) stays.

## Tool registrations (Agent B)

Add tools in `clanky-core/src/agent-tools.ts` modeled after `browser_open_tab` at line 3016. Names (snake_case for tools):

- `browser_screenshot`
- `browser_list_tabs`
- `browser_navigate`
- `browser_close_tab`
- `browser_click`
- `browser_double_click`
- `browser_type`
- `browser_key`
- `browser_scroll`
- `browser_wait`

Each gets a TypeBox schema (modeled after `browserOpenTabSchema` at line 225) and a handler entry. Wire handlers in `clanky/src/handlers.ts` modeled after the `browserOpenTab` entry at line 107.

Prompt snippets should make clear these target **the user's real browser** and the model should pair `browser_screenshot` with coordinate-based input ops.

## Files & ownership (no overlap between agents)

**Agent A (extension):**
- `clanky-pi/packages/clanky-browser-bridge/extension/background.js`
- `clanky-pi/packages/clanky-browser-bridge/extension/manifest.template.json`
- `clanky-pi/packages/clanky-browser-bridge/package.json` (bump version → `0.3.0`)
- `clanky-pi/packages/clanky-browser-bridge/extension/README.md` (only if user-facing instructions change)

**Agent B (server + client + tools):**
- `clanky-pi/packages/clanky-browser-bridge/src/server.ts` (HTTP routes per op + `wait` handler)
- `clanky-pi/packages/clanky-browser-bridge/src/client.ts` (typed helpers + new exports)
- `clanky-pi/packages/clanky-browser-bridge/src/index.ts` (re-exports)
- `clanky-pi/packages/clanky-core/src/agent-tools.ts` (TypeBox schemas + tool registrations)
- `clanky-pi/agents/clanky/src/handlers.ts` (handler wiring)

**Both agents share nothing but the wire protocol above and this spec file.**

## Out of scope (do not build)

- DOM/selector ops (`get_text`, `querySelector`, etc.) — vision-only for now
- Multi-monitor / off-screen capture
- Element-finding by description (Stagehand-style) — explicitly deferred
- Refactoring existing `open_tab` op
- `web_backend_status` updates (will follow once ops land)
- Tests — manual smoke only for v0.3.0
- Top-level README/docs updates (separate task)
