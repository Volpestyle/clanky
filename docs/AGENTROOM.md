# AgentRoom Integration

Clanky is standalone. AgentRoom should treat it as an external Pi harness
command, not as source code vendored into the AgentRoom repository.

## Ownership

- Clanky owns persona, memory, profile state, Linear stores, skills, and Pi
  `InteractiveMode` wiring.
- AgentRoom owns rooms, runtime providers, task/event audit, send/read
  coordination, and communication gateways such as Discord.
- Communication bridges should route inbound messages to an AgentRoom room or
  runtime-backed agent input. Clanky should receive ordinary terminal input
  through AgentRoom rather than embedding a separate Discord or room daemon.

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
them.
