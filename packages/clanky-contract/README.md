# @clanky/contract

Zod schemas plus their inferred TypeScript types for the Clanky wire contract:
the relay WebSocket protocol and the Eve session stream. This package lives in
`clanky-agent` because the agent owns the API; the React Native app consumes it
from the sibling checkout.

## Sources of truth

The canonical wire contract lives in the Clanky agent backend and is consumed by
both the relay implementation and the React Native client:

- `agent/channels/relay.ts` — op names, `dispatch()` results, and
  the streaming/control op handlers.
- Clanky agent Eve session routes — session HTTP shapes and NDJSON stream
  events.
- `../clanky-ios/apps/mobile/src/net` and `../clanky-ios/apps/mobile/src/eve` — the client-side transport
  usage this package validates.

Wire keys follow the source: herdr/relay ops are **snake_case**; Eve session
events, menu events, and Eve session HTTP shapes are **camelCase**.

## Layout

| Module         | Contents |
| -------------- | -------- |
| `json.ts`      | Recursive `JsonValue` for opaque herdr passthroughs. |
| `envelope.ts`  | `RelayRequest`, the `ready` frame, ack/error replies, stream frames, and the `RelayServerMessage` union. |
| `ops.ts`       | Per-op args, the `RELAY_OP_NAMES` catalog, `OP_RESULT_SCHEMAS` (result by op), and the `RelayRequestByOp` discriminated union. |
| `herdr.ts`     | Herdr entities (pane/tab/workspace/session), list envelopes, dispatch-op results, and `GET /relay/health`. |
| `streaming.ts` | `subscribe`/`attach` stream bodies: subscriptions, `PaneOutputFrame`, realtime herdr events. |
| `menu.ts`      | Native slash-command menu events and client responses. |
| `session.ts`   | The consumed subset of Eve session events, plus the Eve session HTTP request/response shapes. |

## Usage

```ts
import { RelayRequestByOpSchema, SessionEventSchema } from "@clanky/contract";

const req = RelayRequestByOpSchema.parse({ op: "start", args: { name: "w", argv: ["claude"] } });
const event = SessionEventSchema.parse(JSON.parse(ndjsonLine));
```

## Scripts

- `pnpm typecheck` — `tsc --noEmit` (standalone typecheck).
- `pnpm build` — emit `dist/` (`.js` + `.d.ts`). Source imports use explicit
  `.ts` extensions so Node's strip-types runtime and Metro resolve the same
  package entrypoint; emitted JS rewrites those imports to `.js`.
