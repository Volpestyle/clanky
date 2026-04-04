# Minecraft

Canonical capability doc for Clanky's embodied Minecraft runtime.

Minecraft is not a separate persona. It is Clanky operating inside a Minecraft Java world through a Mineflayer-backed MCP runtime.

![Minecraft Brain Flow](../diagrams/minecraft-brain-flow.png)

<!-- source: docs/diagrams/minecraft-brain-flow.mmd -->

## Core Model

- Discord text, Discord voice, and Minecraft chat are all input surfaces into the same Minecraft session.
- The active `MinecraftSession` owns one Minecraft brain.
- The Minecraft brain decides structured in-world actions and updates longer-horizon goal state.
- The runtime executes that decision deterministically through Mineflayer tools.

That split is intentional:

- brain: decides what to do, what the active goal is, and whether another planner checkpoint is needed immediately
- runtime/tools: make the action happen reliably

This keeps Minecraft aligned with `AGENTS.md`: Clanky sees context and decides for himself, instead of acting like a regex command router.

## Current Capability Set

Today the runtime supports these high-level actions:

- connect / disconnect
- status
- follow a player
- guard a player
- go to coordinates
- collect nearby blocks by canonical ID
- attack the nearest hostile mob
- look at a player
- stop current autonomous behavior
- return home
- chat in Minecraft

The Minecraft brain can choose between those actions, react to in-game chat, and keep using the same active session across Discord text and voice followups.

It also carries lightweight long-horizon state inside the session:

- active goal
- current subgoals
- progress notes/checkpoints
- preferred world/server target for joining

## Input Surfaces

### Discord text

- The text/orchestrator brain decides whether to use `minecraft_task`.
- Once a Minecraft session exists, the instruction is handed to the Minecraft brain for in-world interpretation.

### Discord voice

- The voice runtime decides whether to use `minecraft_task`.
- Once a Minecraft session exists, the instruction is handed to the same Minecraft brain.

### Minecraft chat

- New in-game chat events are observed from the MCP status/event stream.
- The Minecraft brain decides whether to reply in chat, act in the world, both, or neither.

The transport that delivered the instruction does not change who is making the Minecraft decision.

## Runtime Shape

The live path is:

1. A Discord text turn, Discord voice turn, or Minecraft chat event reaches the active `MinecraftSession`.
2. The session assembles world state, recent game events, chat history, current mode, constraints, preferred server target, and longer-horizon planner state.
3. The Minecraft brain chooses a structured checkpoint action plus any goal/subgoal/progress updates.
4. The session may run a bounded internal planner loop for that turn when the brain marks the step as a setup/checkpoint, such as `connect` before `follow`.
5. The session converts each chosen action into concrete MCP tool calls.
6. The MCP server drives Mineflayer, which performs the actual movement, pathfinding, combat, and block interaction.

The session also runs a deterministic reflex loop for fast infrastructure-grade reactions such as hazard response. Reflexes are not the personality layer; they are the safety/latency layer.

## Settings

The canonical config lives under `agentStack.runtimeConfig.minecraft`:

- `enabled`
- `mcpUrl`
- `operatorPlayerName`
- `server`
- `execution`

`execution` follows the same model-binding pattern used by other capability-local brains:

- `mode: inherit_orchestrator`
- `mode: dedicated_model`

When `inherit_orchestrator` is selected, Minecraft uses the main text/orchestrator model.

When `dedicated_model` is selected, Minecraft uses its own provider/model binding for both:

- operator-turn interpretation inside the Minecraft session
- Minecraft in-game chat behavior

This is the preferred architecture for an embodied capability: one Minecraft brain, many input surfaces.

## Server Selection And Identity

The canonical product-level join target lives in `agentStack.runtimeConfig.minecraft.server`.

That target is session context, not a second decision-maker. It gives the Minecraft brain and runtime a shared answer to questions like:

- what world/server does `join the server` mean here?
- what world is Clanky expected to rejoin after disconnects or restarts?
- what server label should appear in planner context and status summaries?

`server` currently supports:

- `label`
- `host`
- `port`
- `description`

When configured, the session uses that target for both explicit `connect` actions and automatic reconnect/autoconnect behavior.

If no explicit target is configured yet, the bundled MCP runtime still resolves the server host in this order:

1. explicit `host` argument when the low-level connect tool receives one
2. `server-info.json` from the configured server-info URL
3. `MC_HOST`
4. `127.0.0.1`

The bundled MCP runtime resolves the bot username in this order:

1. explicit `username` argument when the low-level connect tool receives one
2. `MC_USERNAME`
3. `ClankyBuddy`

`operatorPlayerName` is separate. It is the human operator's Minecraft username and is used for things like `follow me` and `guard me`.

## Current Limits

Minecraft is currently an embodied teammate runtime, but not yet a full sandbox player. Known gaps include:

- no crafting pipeline
- no chest deposit or home-base workflow
- no building planner
- no first-person vision
- no long-horizon autonomous project loop such as "gear up, gather, craft, and return"
- no multi-world registry or named destination catalog beyond one preferred server target
- no proactive Discord narration of game events without an explicit outer trigger

The important boundary is that these are capability limits, not architecture limits. The runtime now has the right authority boundary for future expansion: the Minecraft brain owns in-world decisions, and the tool/runtime layer owns reliable execution.

## Product Language

Current product language: `embodied Minecraft teammate`

Avoid describing it as only a `command companion` when discussing the architecture. The runtime still has capability gaps, but the authority model is one in-world brain rather than transport-specific command handlers.
