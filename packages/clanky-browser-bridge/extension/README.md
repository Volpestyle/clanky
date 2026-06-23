# Clanky Browser Bridge — Extension

This is the source MV3 extension for the Clanky Browser Bridge. It is generated
at install time into `~/.clanky/browser-bridge/extension/` by
`pnpm browser-bridge:install`. Load that generated directory, not this source
directory, from `chrome://extensions` with Load Unpacked.

The generated extension config contains the bridge server URL and token. The
service worker connects to the local bridge over WebSocket at
`/agent?token=...`, then browser tool calls flow through the bridge HTTP API and
WebSocket session. There is no native-messaging host or stdio transport in the
current bridge.
