# Roadmap: Clanky + herdr, AgentRoom Retired

This document is the working plan for retiring AgentRoom and consolidating on
two systems: Clanky (the personal agent) and herdr (the terminal agent
multiplexer). It is the source of truth for in-flight migration state; other
docs describe the target model and may briefly lead the code.

## Decisions

- **AgentRoom is retired.** Clanky and herdr together cover its job. herdr is
  the multi-agent substrate: panes, agent status, waits, swarms. Clanky is the
  personal layer: persona, memory, profile, gateways, voice.
- **One orchestration substrate.** Clanky's real multi-agent work runs as herdr
  panes, driven by the herdr/herdr-swarm skills. Discord gateway subagents
  remain only for side-request multitasking while the main session is busy, and
  should run as herdr panes when herdr is available.
- **Gateway code moves in-repo.** `@agentroom/chat-discord` is vendored into
  this repo. `discord-mcp` merges in as a workspace package with the CLI and
  skill as the canonical interface; the MCP server entrypoint is dropped
  (recoverable from git history).
- **Remote access is a herdr feature, not a separate daemon.** herdr grows an
  HTTP/WS bridge over its socket API, tailnet-bound, with pairing and push
  hooks. The agent-room-ios app is rebranded as the Clanky iOS app and pointed
  at that bridge.
- **Push notifications:** ntfy (or tailnet polling) while single-user; a small
  hosted APNs relay when the app is distributed, because APNs provider keys are
  developer-scoped and cannot ship inside user-run daemons.

## Phase 1: Vendor the gateway dependencies

Goal: clanky builds standalone with no `link:` deps on sibling repos.

- Copy `agent-room/packages/integrations/chat-discord` into
  `packages/clanky-chat-discord`; update imports in `agentDiscordGateway.ts`,
  `agentDiscordClient.ts`, `agentDiscordVoice.ts`, and `test/runtime-smoke.ts`.
- Move `discord_mcp` into `packages/discord-mcp` (`workspace:*`). Keep
  `operator.ts` (library) and `cli.ts`; delete `mcp.ts`; point the
  `clanky-discord-operator` skill at the CLI; remove the auto-registered MCP
  server from `clanky-core/src/mcp/client.ts`.
- `pnpm install && pnpm check && pnpm smoke` green.
- Archive `Volpestyle/agent-room` and `Volpestyle/discord_mcp` on GitHub.

## Phase 2: Delete the room concept from code

- Remove `packages/clanky-core/src/agentroom-config.ts` and the `AGENTROOM`
  branches in `chat-mode.ts`, `agent-tools.ts`, `mcp/client.ts`,
  `setupWizard.ts`, and smoke tests.
- Remove `CLANKY_AGENTROOM_MCP` and `.agentroom/config.yaml` adoption.
  `CLANKY_CHAT_GATEWAY_OWNER` simplifies to `agent` (default) or `off`; the
  `room` value disappears.
- Remove `/setup agentroom` from the setup wizard.

## Phase 3: herdr as the orchestration substrate

- herdr: add pane metadata/tags (e.g. `agent=clanky`, `parent=<pane>`,
  `task=<one-liner>`) settable over the socket API, so a remote client can
  render Clanky's subagent tree instead of a flat pane list.
- Clanky: when `HERDR_ENV=1`, spawn subagents as tagged herdr panes
  (herdr-swarm pattern); keep the in-process path only as a fallback outside
  herdr. Unify `discordSubagentCoordinator.ts` and
  `discordVoiceSubagentCoordinator.ts` on that mechanism.
- Ship herdr orchestration skills with Clanky (`skills/`), not only in
  `~/.claude/skills`.

## Phase 4: Remote access (herdr bridge + Clanky iOS)

- herdr daemon mode: HTTP/WS bridge over the existing socket API, tailnet-bound,
  serving roughly the contract the iOS app already expects: list
  workspaces/panes with status and tags, read output, send input/keys,
  spawn/stop, health, pairing grant, device registration.
- Notification hook on `blocked`/`done` transitions: ntfy first, APNs relay
  behind the same interface later.
- iOS app: rename from AgentRoom to Clanky (assets in `branding/`), repoint
  `AgentRoomAPIClient` at the herdr bridge, delete room-only models
  (room agents, messages/events, channels). Home screen becomes Clanky: his
  thread (terminal view + composer) and his subagent tree; the raw
  workspace/pane browser becomes a secondary view.

## Status

- Docs rewritten to the target model. Done.
- Phase 1 done: `packages/clanky-chat-discord` and `packages/discord-mcp` are
  workspace packages; no `link:` deps remain. Archive the
  `Volpestyle/agent-room` and `Volpestyle/discord_mcp` GitHub repos.
- Phase 2 done: no room concept remains in the runtime;
  `CLANKY_CHAT_GATEWAY_OWNER` is `agent` or `off`.
- Phases 3-4 not started (herdr pane metadata, herdr bridge, iOS rebrand).
