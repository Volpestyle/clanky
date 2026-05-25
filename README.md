# Clanky

Clanky is a standalone personal Pi agent. It owns its persona, profile-local
state, memory, Linear stores, and bundled skills. It does not run its own
daemon, scheduler, HTTP server, WebSocket server, or multi-agent room
system.

AgentRoom is the room/runtime daemon. Clanky works naturally inside any
AgentRoom because AgentRoom can launch it as a normal Pi harness command and
audit the room send/read flow around it.

## Room And Chat Ownership

Two axes are independent. Full contract in `docs/AGENTROOM.md`.

- **Room participation.** Clanky can run outside AgentRoom or be launched into
  a room as a normal Pi harness.
- **Gateway ownership.** Each Discord conversation is owned either by Clanky
  directly or by the AgentRoom daemon. Agent-owned Discord keeps Clanky's own
  bot identity and token, even while Clanky participates in a room. Room-owned
  Discord uses the room connector bot and routes through AgentRoom.

For a personal Clanky, the intuitive setup is agent-owned Discord plus optional
AgentRoom participation for coordinating with other agents. For a shared
multi-agent public channel, use a room-owned connector with webhook attribution.
Agent-owned Discord starts when `CLANKY_DISCORD_TOKEN` is present and
`CLANKY_CHAT_GATEWAY_OWNER` is `agent` (the default).

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
`AGENTROOM_AGENT_ID`, `AGENTROOM_ROOM_ID`, and `AGENTROOM_ROLE`. These mark
room participation; they do not decide who owns Clanky's Discord identity.
Use `CLANKY_CHAT_GATEWAY_OWNER=room` or `CLANKY_CHAT_GATEWAY_OWNER=off` when a
launcher should suppress Clanky's agent-owned gateway.

Agent-owned Discord runtime env:

- `CLANKY_DISCORD_TOKEN`: Clanky's own Discord bot/user token.
- `CLANKY_DISCORD_CREDENTIAL_KIND`: `bot-token` (default) or `user-token`.
- `CLANKY_DISCORD_CONVERSATION_ID`: optional DM/channel/thread allowlist. When
  omitted, Clanky accepts DMs and messages that mention it.

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
