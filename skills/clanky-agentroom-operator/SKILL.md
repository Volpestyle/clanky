---
name: clanky-agentroom-operator
description: Use AgentRoom from inside Clanky through the MCP bridge (plus bounded read-only agent-room CLI fallback) for room coordination, messages, DMs, waits, and runtime-backed agents.
when_to_use: Use when the user asks about AgentRoom, room messages, room workers, runtime-backed agents, AgentRoom DMs, or coordinating through the agent-room CLI.
allowed_tools:
  - mcp_list_tools
  - mcp_call
deps:
  - agent-room
  - agentroom-mcp
---

# Clanky AgentRoom Operator

Clanky is a **consumer** of AgentRoom, not a second room. Reach the room through
the MCP bridge; prefer MCP tools and fall back to the bounded read-only
`agent-room` CLI only when a capability is missing.

## Discover the live tools — do not trust a hardcoded list

The room's tool set is the source of truth, and it changes. Call
`mcp_list_tools` to get the authoritative `agentroom_*` surface before relying on
any specific tool. The canonical verb reference is agent-room's `docs/PROTOCOL.md`
plus whatever `mcp_list_tools` reports live — if a tool you expected is not in
that list, it does not exist; do not invent it.

Tools you will commonly use (confirm names against `mcp_list_tools`):

- `agentroom_whoami` — confirm identity and room.
- `agentroom_enroll` — join or refresh enrollment.
- `agentroom_agents` — list agents and presence.
- `agentroom_feed` / `agentroom_post` — read / post to the room feed.
- `agentroom_messages` / `agentroom_events` — read room messages / recent events.
- `agentroom_directed_messages` / `agentroom_dm` — read DMs to you / send a DM.
- `agentroom_wait` — wait for the next relevant room event.
- `agentroom_context` — audit/context details for the room.
- `agentroom_report` — narrative status to the user.

## AgentRoom has no task store

AgentRoom deliberately tracks **no** tasks — there is no task tool, task model, or
task API. The configured work tracker (reached via its own MCP/CLI/skill) is the
single source of truth for issues, status, ownership, and comments. Do not look
for or call a room "task" tool, and never create work that exists only in the
room. Coordinate active work through messages/DMs and the agent state machine
(`done` / `block` / `wait-agent`); use `agentroom_report` for narrative status to
the user.

For durable task state from Clanky, use the work-tracker skill / tracker MCP, not
the room.

## Raw CLI fallback (only when MCP is unavailable)

Read-only first:

```bash
agent-room help
```

Then bounded actions against bound agents:

- `agent-room send <id> "msg"` — audited input to a bound agent.
- `agent-room read <id>` — recent output from a bound agent.
- `agent-room stop <id>` — halt a bound agent.

Always prefer the MCP tools above. Keep raw CLI usage bounded and read-only
unless you have explicit instruction to send or stop.
