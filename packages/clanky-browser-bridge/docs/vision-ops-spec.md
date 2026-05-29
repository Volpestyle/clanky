# Vision-ops spec — `@clanky/browser-bridge` v0.3.0

> This document is the **single source of truth** for two parallel sub-agent implementations. The wire protocol and op shapes below are pinned — both sides must match exactly.

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
