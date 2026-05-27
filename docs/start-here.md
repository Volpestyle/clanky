# Start Here

![Clanky and companion overlooking a mountain forest](/branding/clanky-forest-overlook-1024.png)

Clanky is a personal agent built on [Pi](https://pi.dev). The most useful
mental model is:

- Pi is the terminal agent foundation: model runtime, TUI, sessions, built-in
  tools, context files, extensions, skills, and slash command mechanics.
- Clanky is the personal layer on top: persona, profile-local state, memory,
  Discord text and voice, media generation, web lookup, Linear links, MCP
  servers, and AgentRoom-aware coordination.

That means a new user should learn Clanky as a Pi-powered agent, not as a
separate daemon. When `pnpm clanky` starts, it builds a Pi runtime, injects the
Clanky persona and extensions, starts any configured Discord bridges, and opens
Pi's interactive TUI.

## What Clanky Can Do

| Area | What it means |
| --- | --- |
| Local TUI | Work in the current repo through Pi's terminal UI, sessions, models, tools, and slash commands. |
| Memory | Store profile-local, source-grounded memories when policy and user confirmation allow it. |
| Discord text | Use Clanky's own Discord credential for DMs, mentions, replies, and optional channel binding. |
| Discord subagents | Give agent-owned Discord chat its own Pi session while the main Clanky session keeps working. |
| Discord voice | Join a configured voice channel, transcribe speakers, speak through Realtime or ElevenLabs, and delegate durable work to Pi. |
| Web and media | Use OpenAI hosted web search, Playwright or Chrome CDP routes, OpenAI image generation, and xAI image/video generation. |
| AgentRoom | Participate in an AgentRoom room as a normal Pi harness while keeping profile state and connector ownership explicit. |
| Linear and MCP | Create/link Linear issues when credentials exist and call configured external MCP tools. |

## First Path To Try

Use the fresh-user script first. It creates a temporary Clanky home so you can
test onboarding without touching your real profile.

```bash
cd /Users/jamesvolpe/dev/agents/clanky-pi
pnpm install
pnpm dev:setup:fresh
```

Inside the TUI:

```text
/setup
/setup status
/openai-login
```

Then send a simple prompt:

```text
Summarize this repository and tell me how to run the non-live checks.
```

That proves the Pi TUI, Clanky profile setup, model auth path, context loading,
and basic tool use before you involve Discord or voice.

## Normal Personal Profile

After the fresh run works, start a persistent profile:

```bash
pnpm clanky --home ~/.clanky --profile personal --cwd .
```

Inside Clanky:

```text
/setup
/profile
/openai-whoami
```

Use `--home` and `--profile` whenever you want isolation. Profiles are the
boundary for sessions, memory, skills, auth, voice settings, subagents, and
Linear state. Running two live Clankies on the same profile is unsupported.

## Docs Map

- [Pi Foundation](pi-foundation.md): the core concept that explains what Clanky
  inherits from Pi and what Clanky adds.
- [First-Time Setup](first-time-setup.md): prerequisites, install, fresh-user
  test, and connector setup.
- [Using Clanky](using-clanky.md): day-to-day workflows once the profile works.
- [Command Reference](command-reference.md): CLI commands, Pi slash commands,
  Clanky slash commands, and model-facing tools.
- [Memory And Privacy](memory-and-privacy.md): profile state, auth storage,
  memory policy, and forget/export commands.
- [Troubleshooting](troubleshooting.md): common setup failures and where to look
  first.

If you want to feed Clanky's docs into an LLM, the docs site publishes
[`llms.txt`](https://volpestyle.github.io/clanky/llms.txt) (index) and
[`llms-full.txt`](https://volpestyle.github.io/clanky/llms-full.txt)
(all docs concatenated, paste-ready). The same links also appear under
"For LLMs" in the docs site sidebar.

## The Two Big Boundaries

### Pi Versus Clanky

Pi is the reusable agent harness. Clanky does not reimplement the terminal UI,
session tree, context-file discovery, extension lifecycle, skill discovery, or
core file/shell tools. Clanky configures those Pi systems for a personal agent.

The practical result: Pi commands like `/model`, `/settings`, `/resume`,
`/tree`, `/compact`, `/reload`, and `/hotkeys` still matter in Clanky.
For the canonical Pi user docs, use [pi.dev/docs/latest](https://pi.dev/docs/latest).

### Clanky Versus AgentRoom

AgentRoom is the room/runtime daemon. Clanky is a standalone Pi agent that may
participate in a room. Room participation and Discord gateway ownership are
separate decisions:

- Agent-owned Discord means Clanky uses its own profile credential and owns the
  Discord bridge.
- Room-owned Discord means AgentRoom owns the connector token and routes chat
  through the room.

One Discord conversation should have one owner. Do not point Clanky's agent-owned
gateway and an AgentRoom room-owned gateway at the same channel.
