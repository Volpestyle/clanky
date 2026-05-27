# Using Clanky

Once setup is done, treat Clanky as your personal Pi agent. Start it in the repo
or workspace you want it to work on:

```bash
pnpm clanky --home ~/.clanky --profile personal --cwd .
```

The current working directory matters because Pi uses it for tool execution,
context-file discovery, session grouping, and project-relative file references.

## Local TUI Workflow

Common daily loop:

1. Start Clanky in the target repo.
2. Run `/profile` if you need to confirm the active profile.
3. Ask for a small orientation task, such as "summarize this repo".
4. Let Clanky read files and run commands through Pi tools.
5. Use `/session`, `/tree`, `/resume`, `/fork`, and `/compact` as the work grows.

Useful Pi editor patterns still apply:

- Type `@` to reference files.
- Prefix a shell command with `!` to run it and send output to the model.
- Prefix with `!!` to run a command without adding output to model context.
- Use `/model` or `/settings` to change model and thinking behavior.
- Use `/reload` after changing `AGENTS.md`, skills, prompt templates, or
  extensions.

## Setup And Status

`/setup` is the new-user and connector hub:

```text
/setup
/setup status
/setup fresh
```

Use `/setup status` when you want a compact view of profile paths, OpenAI,
Discord text, Discord owner, Discord voice, ElevenLabs, xAI, and AgentRoom
participation.

## Memory Workflow

Clanky loads a memory packet before each agent turn when memory is enabled. It
stores profile-local memories only when policy and user confirmation allow it.

Useful commands:

```text
/what_do_you_remember
/memory view
/memory remember <claim>
/memory forget <id>
/memory export
/privacy
/why_did_you_say_that
/forget_me
/memory_off
```

Memory is not the same as persona. The static persona is
`agents/clanky/persona/SELF.md`. Profile-local self memory and remembered facts
live under the active profile directory.

## Discord Text Workflow

Agent-owned Discord is for Clanky's personal identity:

```text
/discord-whoami
/discord-status
```

Accepted Discord chat may route to a dedicated Discord subagent. That gives
Discord its own Pi session and context window while the main TUI session remains
available. The Discord subagent can inspect Discord, ask main Clanky for recent
main-session context, and delegate durable work back to the main worker.

Use the live subagent panel in the TUI:

```text
/subagents
/subagents status
/subagents focus
/subagents chat
/subagents modal
/subagents hide
```

In Discord, `/clanky direct <message>` bypasses the Discord subagent and sends
the turn straight to main Clanky. Use that only when you explicitly want the
foreground worker.

## Discord Voice Workflow

Voice is a separate live path. It is not just a normal Pi text turn.

The voice bridge uses:

- TypeScript for control, settings, Realtime, tools, and Pi delegation.
- Rust `clankvox` for Discord voice transport, RTP, Opus, screen watch, and
  PCM IPC.
- OpenAI Realtime by default, or xAI Grok Voice when selected, as the realtime
  reasoning/tool agent.
- The selected realtime agent audio by default, or ElevenLabs, as the speech
  output provider.
- Pi delegation through `ask_pi` when the realtime voice agent needs durable
  work.

Basic commands:

```text
/discord-voice
/discord-voice setup
/discord-voice join <guild-id> <voice-channel-id>
/discord-voice status
/discord-voice disable
/voice-logs
```

For architecture and live validation, see
[Discord Voice Architecture](discord-voice-architecture.md) and
[Discord Voice Live Runbook](qa/discord-voice-live-runbook.md).

## Web And Media Workflow

For current public information, Clanky can use OpenAI hosted web search. For
browser interaction, screenshots, or UI checks, the bundled web skill can route
through Playwright, Chrome CDP, or local fetch.

```text
/web
```

For generated media:

```text
/media
/xai-whoami
```

Model-facing tools include OpenAI image generation, xAI image generation, and
xAI video generation. Generated assets are saved to local files when the tool
runs.

## AgentRoom Workflow

Clanky remains a standalone Pi agent even inside an AgentRoom room. AgentRoom
owns room launch, audit, send/read flow, task shadows, and room-owned connector
lifecycle. Clanky owns its profile state and agent-owned connectors.

Use separate profiles for multiple live Clankies:

```bash
pnpm clanky --home ./.clanky-room --profile clanky-lead --cwd .
pnpm clanky --home ./.clanky-room --profile clanky-reviewer --cwd .
```

Use `CLANKY_CHAT_GATEWAY_OWNER=room` when the room connector owns Discord.
Leave it unset or set it to `agent` when this Clanky profile owns the Discord
bridge.

## Skills Workflow

Pi discovers skills from normal Pi and agent skill locations. Clanky also merges
bundled Clanky skills and profile-local Clanky skills.

Commands:

```text
/skills
/skill list
/skill add <name>
/skill:<skill-name>
```

Bundled operator skills cover Discord, web/browser work, media generation,
AgentRoom operation, Linear bridging, log dives, and Pi TUI coding behavior.

## External MCP Workflow

Clanky auto-adds AgentRoom MCP when enrolled in an AgentRoom room or when
`.agentroom/config.yaml` exists. It also auto-adds Discord MCP by default and
can inject stored profile Discord credentials when no Discord MCP token env var
is set.

Inspect configured servers:

```text
/mcp
```

Configure custom MCP servers with `CLANKY_MCP_SERVERS`, a JSON object keyed by
server name. Disable auto-adds with:

```bash
CLANKY_AGENTROOM_MCP=0
CLANKY_DISCORD_MCP=0
```
