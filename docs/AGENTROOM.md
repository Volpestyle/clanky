# AgentRoom Integration

Clanky is standalone. AgentRoom should treat it as an external Pi harness
command, not as source code vendored into the AgentRoom repository.

## Two Independent Axes

There are two independent choices for Clanky + chat gateways (Discord today,
others later):

1. **Room participation:** Clanky may run outside AgentRoom, or AgentRoom may
   launch it as a runtime-backed Pi harness.
2. **Gateway ownership:** each external chat conversation is owned either by
   Clanky directly or by the AgentRoom daemon.

These are separate axes. `AGENTROOM=1` means "Clanky is in a room"; it does
not mean "Clanky must surrender his Discord identity."

### Agent-owned Discord

Clanky imports `@agentroom/chat-discord` as a library and runs the gateway
in-process under his own bot token. Traffic flows directly Discord <->
Clanky. This works both outside a room and while Clanky is participating in
AgentRoom.

Use case: personal Clanky keeps his own Discord identity and DMs with the
human, while also using AgentRoom DMs/tasks/channels to coordinate with other
agents.

The runtime starts this gateway when `CLANKY_DISCORD_TOKEN` is present and
`CLANKY_CHAT_GATEWAY_OWNER=agent` (the default). Without
`CLANKY_DISCORD_CONVERSATION_ID`, Clanky handles Discord DMs and channel
messages that mention it. Set `CLANKY_DISCORD_CONVERSATION_ID` to bind one
specific DM, channel, or thread.

### Room-owned Discord

AgentRoom daemon owns the gateway and token for a particular Discord
conversation. The Discord identity is the room's connector bot, not any
individual Clanky. Inbound messages route to a configured target, often
`agent-stdin:clanky-lead`. Worker Clankies receive tasks and DMs from the
lead through AgentRoom's native messaging.

The gateway library is the same in both cases (`@agentroom/chat-discord`,
which implements `ChatGatewayProvider`). Only the lifecycle owner differs.

One Discord conversation should have exactly one owner. Do not point both an
agent-owned gateway and a room-owned gateway at the same channel or DM.

## Ownership

- Clanky owns persona, memory, profile state, Linear stores, skills, and Pi
  `InteractiveMode` wiring.
- AgentRoom owns rooms, runtime providers, task/event audit, send/read
  coordination, and room-owned chat gateway lifecycle.
- Clanky owns agent-owned chat gateway lifecycle for its own profile, whether
  or not it is also in a room.

## Token Ownership

The rule: **whoever runs the gateway owns the token.**

- Agent-owned: Clanky's profile holds Clanky's Discord bot token.
- Room-owned: AgentRoom holds the connector bot token.

Clanky must never read the room connector token. AgentRoom must never read
Clanky's profile token.

## Multi-Agent Topology

When AgentRoom fans one connector bot out to multiple Clankies, the gateway
posts outbound messages in Discord **webhook mode** so the same bot token
can send with per-message `username` and `avatar_url`. `clanky-lead`,
`clanky-impl-a`, and `clanky-reviewer` therefore appear as visually distinct
authors in the Discord channel without needing N bot accounts.

The lead/worker split is an AgentRoom concern, not a Clanky concern. Clanky
is always just "a Pi agent." The role comes from how AgentRoom routes
inbound traffic and assigns tasks; Clanky's binary and persona do not
change.

### Profile isolation

Multiple Clanky instances in the same workspace **must** use separate
`--profile <name>` flags, and typically `--home ./.clanky-room` for
room-scoped state, so memory, sessions, and Linear links do not collide.
Profiles are the only isolation boundary; sharing a profile across two live
Clankies is unsupported.

## Launch Contract

AgentRoom launches Clanky like any other runtime-backed agent:

```bash
agent-room launch clanky --harness pi --command clanky --cwd .
```

The runtime environment must resolve `clanky`. Valid setup options include:

- putting this checkout's `@clanky/agent` bin on `PATH`
- using a local wrapper script named `clanky`
- running from a dev shell that resolves workspace bins

After launch, AgentRoom controls the session through audited runtime commands:

```bash
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

## Environment

When AgentRoom launches Clanky, runtime providers set:

- `AGENTROOM=1`
- `AGENTROOM_AGENT_ID`
- `AGENTROOM_ROOM_ID`
- `AGENTROOM_ROLE`

Clanky may use these values for context, but it must remain runnable without
them. `AGENTROOM=1` only signals room participation.

Gateway startup is controlled separately:

- default: `CLANKY_CHAT_GATEWAY_OWNER=agent` behavior, so Clanky may start its
  own gateway when `CLANKY_DISCORD_TOKEN` is present.
- `CLANKY_CHAT_GATEWAY_OWNER=room`: suppress Clanky's gateway because the
  relevant Discord conversation is room-owned.
- `CLANKY_CHAT_GATEWAY_OWNER=off` or `CLANKY_DISABLE_CHAT_GATEWAY=1`: no
  in-process Clanky gateway.

Agent-owned Discord env:

- `CLANKY_DISCORD_TOKEN`
- `CLANKY_DISCORD_CREDENTIAL_KIND=bot-token|user-token` (default `bot-token`)
- `CLANKY_DISCORD_CONVERSATION_ID` or legacy alias
  `CLANKY_DISCORD_CHANNEL_ID`
- `CLANKY_DISCORD_PROVIDER_ID` (default `clanky-discord`)
