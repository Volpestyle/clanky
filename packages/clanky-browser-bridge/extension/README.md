# Clanky Browser Bridge — Extension

This is the MV3 extension that pairs with the Clanky native messaging host. It is generated at install time into `~/.clanky/browser-bridge/extension/` by `pnpm browser-bridge:install`. Load that generated directory (not this source directory) via chrome://extensions → Load Unpacked.

The extension keeps a Native Messaging connection open to `com.clanky.browser_bridge`. When the local Clanky agent calls `browser_open_tab`, the native host forwards the request over stdio and the service worker opens the tab.
