# AgentRoom Integration

Clanky is standalone. AgentRoom should treat it as an external Pi harness
command, not as source code vendored into the AgentRoom repository.

## Deployment Topologies

There are two supported shapes for Clanky + chat gateways (Discord today,
others later). Pick exactly one per profile.

### 1. Standalone Clanky

No AgentRoom daemon is running. Clanky imports `@agentroom/chat-discord` as
a library and runs the gateway in-process under his own bot token. Traffic
flows directly Discord <-> Clanky.

Use case: a personal Clanky talking to one human, joining a server the human
owns. Clanky owns the token here because there is no daemon to own it.

### 2. Enrolled multi-agent room

An AgentRoom daemon is running. AgentRoom owns the Discord gateway and the
token. The Discord identity is the **room's connector bot**, not any
individual Clanky. Inbound messages route to a designated lead agent (for
example `agent-stdin:clanky-lead`). Worker Clankies (`clanky-impl-a`,
`clanky-reviewer`, ...) do not see Discord directly; they receive tasks and
DMs from the lead through AgentRoom's native messaging.

The gateway library is the same in both cases (`@agentroom/chat-discord`,
which implements `ChatGatewayProvider`). Only the lifecycle owner differs.

## Ownership

- Clanky owns persona, memory, profile state, Linear stores, skills, and Pi
  `InteractiveMode` wiring.
- AgentRoom owns rooms, runtime providers, task/event audit, send/read
  coordination, and chat gateway lifecycle when the daemon is present.
- In standalone mode Clanky additionally owns the chat gateway lifecycle for
  its own profile. In enrolled mode it must not start its own gateway.

## Token Ownership

The rule: **whoever runs the gateway owns the token.**

- Standalone: Clanky's profile holds the Discord bot token. One token, one
  bot identity, one Clanky.
- Enrolled: AgentRoom holds the connector bot token. Worker Clankies never
  see it.

A Clanky launched into an enrolled room must not read a Discord token from
its profile, even if one is present.

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
them. In particular, the presence of `AGENTROOM=1` is the signal to skip
in-process gateway startup and defer chat delivery to AgentRoom.
