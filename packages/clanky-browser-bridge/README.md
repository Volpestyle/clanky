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
4. Cleans up any stale `com.clanky.browser_bridge.json` native messaging manifests written by older versions of this package.

Finish the install:

```sh
pnpm browser-bridge:serve
```

Leave that running, then load the unpacked extension in chrome://extensions → Load Unpacked → `~/.clanky/browser-bridge/extension`.

## Tools

- `browser_open_tab({ url, active? })` — opens a tab. Returns `{ tabId, url, windowId, active, browser }`.

## Adding more tools

1. Add the op to `extension/background.js` `dispatch()`.
2. Add a route in `src/server.ts` (HTTP side) and forward through `dispatch()` (WS side).
3. Add a typed client helper in `src/client.ts`.
4. Register the tool in `packages/clanky-core/src/agent-tools.ts`.

Keep ops idempotent and avoid blocking work in the service worker; MV3 SWs can be suspended at any time, and the alarm watchdog will reconnect rather than queue dropped work.
