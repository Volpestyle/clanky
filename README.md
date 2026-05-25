# Clanky

Clanky is a standalone personal Pi agent. It owns its persona, profile-local
state, memory, Linear stores, and bundled skills. It does not run its own
daemon, messaging gateway, scheduler, HTTP server, WebSocket server, or
multi-agent room system.

AgentRoom is the room/runtime daemon. Clanky works naturally inside any
AgentRoom because AgentRoom can launch it as a normal Pi harness command and
audit the room send/read flow around it.

## Layout

- `agents/clanky` is the runnable `@clanky/agent` package and `clanky` bin.
- `packages/clanky-core` contains Clanky memory, Linear stores, profile paths,
  state storage, skills loading, and model-facing tools.
- `skills/` contains bundled Clanky skills.
- `agents/clanky/persona/SELF.md` is the static persona injected into Pi's
  system prompt.

## Local Development

```bash
pnpm install
pnpm check
pnpm smoke
pnpm clanky --help
```

Run the local interactive Pi surface:

```bash
pnpm clanky
pnpm clanky --profile personal --home ~/.clanky --cwd .
```

Smoke tests are non-live and isolate profile state in temporary directories:

```bash
pnpm smoke:clanky
pnpm smoke:agent-tools
```

## AgentRoom

From any initialized AgentRoom room, launch Clanky as an external Pi harness:

```bash
agent-room launch clanky --harness pi --command clanky --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

The `clanky` command must be available in the runtime environment. For local
development, run AgentRoom from a shell where this checkout's bin is on `PATH`,
or use a wrapper command that enters this checkout before starting Clanky.

AgentRoom supplies room/runtime environment variables such as `AGENTROOM`,
`AGENTROOM_AGENT_ID`, `AGENTROOM_ROOM_ID`, and `AGENTROOM_ROLE`. Clanky does
not need AgentRoom as a package dependency; it just runs as a Pi agent process
inside the room.

See `docs/AGENTROOM.md` for the integration contract.

## State

By default, Clanky stores profile state under `~/.clanky`. Use `--home` and
`--profile` to isolate runs:

```bash
pnpm clanky --home ./.clanky --profile work
```

The self-memory tool writes profile-local notes under the resolved profile
directory. The static persona markdown in `agents/clanky/persona/SELF.md`
remains the source for startup identity.
