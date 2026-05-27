# First-Time Setup

This guide starts from a clean checkout and gets to a working local Clanky TUI.
Optional connectors are split out so a new user can stop after model auth and
still have a useful agent.

You do not need to install Pi globally to run this checkout; Clanky uses the
workspace Pi package dependency. If you want to learn the base harness outside
Clanky, start with the [Pi quickstart](https://pi.dev/docs/latest/quickstart).

## Prerequisites

- Node.js `>=22.19.0`.
- pnpm `10.33.4` through Corepack or a matching global pnpm install.
- This repository checked out at `/Users/jamesvolpe/web/clanky-pi`.
- An OpenAI API key or another Pi-supported model auth path.
- Optional: a Discord bot token for agent-owned Discord text.
- Optional: Rust/Cargo for the bundled Discord voice helper.
- Optional: Playwright Chromium for browser automation routes.
- Optional: xAI, ElevenLabs, Linear, or AgentRoom credentials for those specific
  features.

## Install

```bash
cd /Users/jamesvolpe/web/clanky-pi
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install
pnpm clanky --help
```

The docs site and CI use the same workspace scripts. For hosted docs only:

```bash
pnpm docs:build
```

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
repo tools, and can report missing optional connectors without crashing.

## Persistent Profile

After the fresh path works, launch a normal personal profile:

```bash
pnpm clanky --home ~/.clanky --profile personal --cwd .
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

Clanky uses profile-local durable stores rather than a single room YAML file.
The TUI setup commands write the active profile, while env vars remain
launch-time overrides. See [Configuration Model](configuration.md) for the
source-of-truth rules and the AgentRoom boundary.

## Model Auth

Clanky can use Pi's normal `/login` flow or Clanky's profile-local OpenAI key
flow:

```text
/login
/openai-login
/openai-whoami
```

`/openai-login` stores the key in the active profile's `auth.json` under the
OpenAI provider id. Environment variables still work and override stored auth:

- `CLANKY_OPENAI_API_KEY`
- `OPENAI_API_KEY`

Clanky's default chat model is `openai/gpt-5.5`. Main Clanky defaults to
`xhigh` thinking, while Clanky-owned subagents default to `medium`. Inspect or
change that at runtime with:

```text
/effort
/effort main high
/effort subagents medium
/effort all low
```

## Discord Text

Agent-owned Discord means Clanky uses its own profile credential and owns the
gateway.

```text
/discord-login
/discord-whoami
```

Restart Clanky after login so the gateway starts with the new token:

```bash
pnpm clanky --home ~/.clanky --profile personal --cwd .
```

Then inspect:

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
[Discord Voice Live Runbook](qa/discord-voice-live-runbook.md).

## Web, Browser, And Media

OpenAI web search and OpenAI image generation use the OpenAI credential. xAI
image/video generation uses xAI credentials.

```text
/web
/media
/xai-login
/xai-whoami
```

Install Playwright Chromium once if browser automation is needed:

```bash
pnpm browser:install
```

## AgentRoom

Clanky can participate in AgentRoom as a normal Pi harness:

```bash
agent-room launch clanky --harness pi --command clanky --cwd .
```

Inside Clanky, `/setup` shows whether the process is enrolled in AgentRoom.
AgentRoom participation does not decide Discord ownership. Use
`CLANKY_CHAT_GATEWAY_OWNER=room` when an AgentRoom room-owned connector owns the
Discord conversation.

See [AgentRoom Integration](AGENTROOM.md) for the full contract.

## Non-Live Verification

Run these before using real service credentials:

```bash
pnpm smoke:clanky
pnpm smoke:voice
pnpm smoke:agent-tools
pnpm smoke:subagents
pnpm docs:build
```

`pnpm check` is the broader repo gate. It may surface unrelated worktree issues
while active development is in progress.
