# Getting Started

![Clanky and companion overlooking a mountain forest](../branding/clanky-forest-overlook-1024.png)

Clanky is a personal agent built on [Pi](https://pi.dev). Pi is the generic
agent harness — TUI, sessions, tools, slash commands, models. Clanky configures
that harness with personal state: persona, memory, profile-local auth, skills,
and gateway adapters. The local Pi session thread is Clanky's built-in
messaging; Discord text and Discord voice are gateways into and out of that
thread. Multi-agent work fans out as [herdr](https://herdr.dev) panes.

This guide goes from a clean checkout to daily use. Optional connectors are
split out so you can stop after model auth and still have a useful agent.

## Prerequisites

- Node.js `>=22.19.0`.
- pnpm `11.4.0` through Corepack or a matching global pnpm install.
- This repository checked out locally.
- An OpenAI API key or another Pi-supported model auth path.
- Optional: a Discord bot token for the built-in agent-owned chat gateway.
- Optional: Rust/Cargo for the bundled Discord voice media helper.
- Optional: Playwright Chromium for browser automation routes.
- Optional: xAI, ElevenLabs, or Linear credentials for those specific features.

## Install

```bash
cd /path/to/clanky-pi
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
export PATH="$PWD/node_modules/.bin:$PATH" # source checkout only
clanky --help
```

The released CLI is intended to be used directly as `clanky`. The `PATH` line
is only for a source checkout before the CLI is installed globally.

## Fresh-User Test

Run the onboarding flow against a temporary home first:

```bash
pnpm dev:setup:fresh
```

That script creates a temporary Clanky home, uses profile `fresh`, launches the
TUI, and leaves your real `~/.clanky` untouched.

Inside the fresh TUI:

```text
/setup
/setup status
/openai-login
```

Then ask:

```text
Summarize this repository and tell me how to run the non-live checks.
```

Expected result: Clanky opens the Pi TUI, accepts a prompt, can use the local
repo tools, and can report missing optional connectors without crashing. That
proves the TUI, profile setup, model auth path, context loading, and basic tool
use before you involve gateways or voice.

## Persistent Profile

After the fresh path works, launch a normal personal profile:

```bash
clanky --home ~/.clanky --profile personal --cwd .
```

Inside Clanky:

```text
/setup
/profile
/openai-login
/openai-whoami
```

`/profile` shows the resolved home, profile dir, sessions dir, skill dirs, and
chat gateway ownership. Use it whenever you are not sure which profile you are
editing.

Profiles are the boundary for sessions, memory, skills, auth, voice settings,
subagents, and work-tracker state. Use separate profiles for separate
identities or experiments. Running two live Clankies on the same profile is
unsupported.

## Model Auth

Clanky can use Pi's normal `/login` flow or Clanky's profile-local OpenAI key
flow:

```text
/login
/openai-login
/openai-whoami
/auth
```

`/openai-login` stores the key in the active profile's `auth.json` under the
OpenAI provider id. Environment variables still work and override stored auth:

- `CLANKY_OPENAI_API_KEY`
- `OPENAI_API_KEY`

Remove stored provider credentials from the TUI with `/auth remove <provider>`
or `/auth remove all`. That does not unset launch environment variables.

Clanky's default chat model is `openai/gpt-5.5`. Main Clanky defaults to
`xhigh` thinking, while Clanky-owned subagents default to `medium`. Inspect or
change that at runtime with:

```text
/model
/effort
/effort main high
/effort subagents medium
/effort all low
```

## Chat Gateway

Clanky's built-in messaging is the local Pi session thread. Discord is an
optional gateway into that thread or into profile-local subagents. Clanky uses
its own profile credential and owns the gateway.

```text
/discord-login
/discord-whoami
```

Restart Clanky after login so the gateway starts with the new token. Then
inspect:

```text
/discord-status
```

By default, Clanky handles DMs, @mentions, replies to recent Clanky messages,
natural wake names such as `clanky` or `clank`, and same-user follow-ups during
the engagement window. Bind a specific Discord conversation with
`CLANKY_DISCORD_CONVERSATION_ID` when you need a tighter allowlist.

## Discord Voice

Discord voice is opt-in. Start with the wizard:

```text
/discord-voice setup
/discord-voice status
```

Useful shortcuts:

```text
/discord-voice enable
/discord-voice join <guild-id> <voice-channel-id>
/discord-voice allow-server <guild-id>
/discord-voice allow-channel <voice-channel-id>
/voice-logs
```

Pinned voice targets stay inactive on startup unless you explicitly enable
startup auto-join with `/discord-voice set auto-join on` or
`CLANKY_DISCORD_VOICE_AUTO_JOIN=1`.

Voice requires a Discord credential and an OpenAI credential for speaker
transcription. The realtime reasoning/tool agent defaults to OpenAI Realtime,
but can be switched to xAI Grok Voice when an xAI credential is available.
ElevenLabs is optional speech output:

```text
/xai-login
/discord-voice set realtime-provider xai
/discord-voice set xai-model grok-voice-latest
/elevenlabs-login
/discord-voice set tts-provider elevenlabs
/discord-voice set elevenlabs-voice <voice-id>
```

Validate the native helper before live voice work:

```bash
pnpm voice:native:test
pnpm voice:build
```

For live credentialed checks, use
[Discord Voice Live Runbook](qa/discord-voice-live-runbook.md). For the full
architecture, see [Discord Voice Architecture](discord-voice-architecture.md).

## Daily TUI Workflow

Start Clanky in the repo or workspace you want it to work on. The working
directory matters because Pi uses it for tool execution, context-file
discovery, session grouping, and project-relative file references.

Common daily loop:

1. Start Clanky in the target repo.
2. Run `/profile` if you need to confirm the active profile.
3. Ask for a small orientation task, such as "summarize this repo".
4. Let Clanky read files and run commands through Pi tools.
5. Use `/session`, `/tree`, `/resume`, `/fork`, and `/compact` as the work grows.

Useful Pi editor patterns:

- Type `@` to reference files.
- Prefix a shell command with `!` to run it and send output to the model.
- Prefix with `!!` to run a command without adding output to model context.
- Use `/model` or `/settings` to change model and thinking behavior.
- Use `/reload` after changing `AGENTS.md`, skills, prompt templates, or
  extensions.

Use `/setup status` for a compact view of profile paths, OpenAI, gateway
ownership, Discord adapter status, Discord voice, ElevenLabs, and xAI.

## Memory Workflow

Clanky loads a memory packet before each agent turn when memory is enabled. It
stores profile-local memories only when policy and user confirmation allow it.

Useful commands:

```text
/what_do_you_remember
/memory view
/memory remember <claim>
/memory reflect
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

Use `/memory reflect` near the end of a busy day or long session. It only runs
when there is enough recent transcript to review, and it should propose
memories before saving anything that lacks explicit confirmation.

## Subagents

Accepted gateway chat may route to a dedicated subagent. That gives the
external conversation its own Pi session and context window while the main TUI
session remains available. The Discord adapter can inspect Discord, ask main
Clanky for recent main-session context, and delegate durable work back to the
main worker.

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

For multi-agent work beyond gateway side requests, Clanky fans out into herdr
panes — see the [Roadmap](ROADMAP.md) for where that integration is headed.

## Web, Media, And Browser

For current public information, Clanky can use OpenAI hosted web search. For
browser interaction, screenshots, or UI checks, the bundled web skill can route
through Playwright, Chrome CDP, or local fetch.

```text
/web
/media
/xai-login
/xai-whoami
```

Model-facing tools include OpenAI image generation, xAI image generation, and
xAI video generation. Generated assets are saved to local files when the tool
runs.

Install Playwright Chromium once if browser automation is needed:

```bash
pnpm browser:install
```

## Skills

Pi discovers skills from normal Pi and agent skill locations. Clanky also
merges bundled Clanky skills and profile-local Clanky skills.

```text
/skills
/skill list
/skill add <name>
/skill:<skill-name>
```

Bundled operator skills cover Discord, web/browser work, media generation,
Linear bridging, log dives, and Pi TUI coding behavior.

## Connected Tools (MCP)

Most users should treat connected tools as something Clanky chooses when the
task needs them. You only need this when adding or debugging tool servers.

Inspect configured servers:

```text
/mcp
```

Configure custom MCP servers with `CLANKY_MCP_SERVERS`, a JSON object keyed by
server name. Anthropic server-side tool search can defer large tool schemas
when enabled. When tool search is enabled, Clanky registers configured MCP
server tools as direct `mcp__server__tool` wrappers and marks them deferred
according to each server's `deferLoading` and `toolOverrides` settings:

```bash
CLANKY_TOOL_SEARCH=1
CLANKY_TOOL_SEARCH_VARIANT=bm25
CLANKY_MCP_SERVERS='{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp","deferLoading":true,"toolOverrides":{"search_issues":{"deferLoading":false}}}}}'
```

## Non-Live Verification

Run these before using real service credentials:

```bash
pnpm smoke:clanky
pnpm smoke:voice
pnpm smoke:agent-tools
pnpm smoke:subagents
```

`pnpm check` is the broader repo gate.
