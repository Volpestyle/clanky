# Clanky

![Clanky](/branding/clanky-logo-512.png)

Clanky is a personal Pi agent with profile state, memory, a canonical Pi
session thread, communication gateway adapters, subagents, media tools,
work-tracker refs, bundled skills, and AgentRoom participation.

It is not a separate daemon or scheduler. Pi supplies the terminal agent
runtime. Clanky adds the personal layer. AgentRoom supplies the multi-agent room
when Clanky needs to coordinate with other agents.

Use Clanky when you want one agent that is yours. Use AgentRoom when you need a
shared room around multiple agents, runtime audit, task shadows, handoffs, and
mobile checks.

## 1. What You Can Do

Use Clanky as the agent that is always yours:

- work in a repo through the Pi TUI with Clanky's persona, skills, memory, and
  profile-local credentials
- keep separate profiles for personal work, room leads, reviewers, voice tests,
  or temporary experiments
- store and inspect source-grounded memories with explicit privacy controls
- connect external communication gateways, with Discord as the current
  agent-owned text adapter for DMs, mentions, replies, and channel bindings
- let gateway side requests route to subagents while the main TUI session keeps
  working
- join live voice through the current Discord/ClankVox media adapter,
  transcribe speakers, speak through Realtime or ElevenLabs, and delegate
  durable work back to Pi
- generate or inspect web/media artifacts through the bundled operator skills
- participate in AgentRoom as a lead, worker, reviewer, or standalone personal
  agent

<!-- Capture backlog:
- docs/assets/gifs/clanky-tui-discord.gif: local TUI work continuing while a Discord mention routes through a subagent.
- docs/assets/gifs/clankvox-voice-live.gif: Discord voice live run with speaker transcript, spoken response, ask_pi delegation, and screen-watch or media counters.
-->

## 2. What To Let Clanky Handle

Clanky is strongest when the work needs personal context plus tools:

- orienting in a local repository
- remembering durable preferences, project facts, and recurring context
- deciding whether an external gateway message needs a response or should be skipped
- splitting gateway side work into subagents so the foreground session stays
  useful
- using browser, web search, media, Linear, Discord, or MCP skills when the task
  calls for them
- answering live voice questions quickly and handing longer work to Pi
- joining an AgentRoom room and coordinating through room messages, tasks, and
  audited runtime flow

Let AgentRoom handle multi-agent room topology, runtime launch, audited
send/read, task shadows, room-owned chat connectors, and mobile control. Let
Clanky handle the personal profile, memory, agent-owned gateway credentials,
voice settings, skills, and foreground Pi work.

## 3. Mental Model

```mermaid
flowchart TB
  user["Human"]
  tui["Pi TUI"]
  thread["Clanky Pi session thread<br/>canonical messaging"]
  clanky["Clanky runtime"]
  profile["Profile<br/>auth, memory, sessions, skills"]
  chat["Communication gateway adapters<br/>Discord today, others later"]
  voice["Voice/media gateway adapters<br/>ClankVox Discord today"]
  vox["ClankVox<br/>native media plane"]
  room["AgentRoom<br/>optional room participation"]

  user --> tui
  tui --> thread
  thread --> clanky
  clanky --> profile
  chat <--> thread
  clanky --> voice
  voice --> vox
  clanky <--> room
```

Read it as:

- Pi owns the TUI, sessions, model runtime, slash commands, and local repo tools.
- Clanky configures Pi with persona, profile state, memory, skills, connectors,
  and voice/media capabilities.
- Clanky's built-in messaging is the Pi session thread. Discord, AgentRoom, and
  future Slack, Telegram, SMS, webhook, or huddle-style integrations are
  gateways into or out of that thread.
- ClankVox is a subprocess below Clanky for the current Discord media transport.
- AgentRoom is optional room infrastructure around Clanky; it does not own
  Clanky's profile.

## First Path

Run the fresh-user flow first so you can test onboarding without touching your
real profile:

```bash
cd /path/to/clanky-pi
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install
export PATH="$PWD/node_modules/.bin:$PATH" # source checkout only
pnpm dev:setup:fresh
```

Inside the TUI:

```text
/setup
/setup status
/openai-login
```

Then ask:

```text
Summarize this repository and tell me how to run the non-live checks.
```

For a persistent profile:

```bash
clanky --home ~/.clanky --profile personal --cwd .
```

The released CLI is intended to be used directly as `clanky`. The `PATH` line
is only for a source checkout before the CLI is installed globally.

## Communication Gateways And Voice

Agent-owned communication gateways are configured from inside the TUI. Discord
is the current built-in chat adapter:

```text
/discord-login
/discord-whoami
/discord-status
```

Voice/media gateways are separate from Clanky's native Pi thread. The current
Discord voice adapter uses the same profile credential, Clanky's TypeScript
control plane, OpenAI/xAI Realtime, optional ElevenLabs speech, Pi delegation
through `ask_pi`, and the bundled ClankVox Rust media process:

```text
/discord-voice
/discord-voice setup
/discord-voice join <guild-id> <voice-channel-id>
/voice-logs
```

For the full voice map, use
[Discord Voice Architecture](docs/discord-voice-architecture.md). For the native
media subprocess, jump to [ClankVox Docs](docs://clankvox-docs/overview).
For the cross-channel abstraction, use
[Communication Gateways](docs/communication-gateways.md).

## AgentRoom

Clanky can run inside AgentRoom as a normal Pi harness:

```bash
agent-room launch clanky --harness pi --command clanky --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

Room participation and gateway ownership are separate:

- agent-owned chat: Clanky uses its own profile credential and owns the
  conversation, currently through the Discord adapter
- room-owned chat: AgentRoom owns the connector bot and routes the
  conversation through the room

One external conversation should have one owner. Use
`CLANKY_CHAT_GATEWAY_OWNER=room` when an AgentRoom connector owns that gateway
conversation.

For the room side, jump to [AgentRoom Ecosystem Tour](docs://agent-room-docs/ecosystem).

## Docs Map

- [Start Here](docs/start-here.md): new-user product path.
- [Pi Foundation](docs/pi-foundation.md): what Pi owns and what Clanky adds.
- [First-Time Setup](docs/first-time-setup.md): install, auth, connectors.
- [Using Clanky](docs/using-clanky.md): daily TUI, memory, communication
  gateways, voice/media, AgentRoom, skills, and connected tool workflows.
- [Communication Gateways](docs/communication-gateways.md): chat and
  voice/media gateway abstraction and ownership.
- [Command Reference](docs/command-reference.md): CLI and slash commands.
- [Memory And Privacy](docs/memory-and-privacy.md): profile-local state and
  privacy controls.
- [AgentRoom Integration](docs/AGENTROOM.md): launch, gateway ownership, and
  room/profile boundaries.

## Local Development

```bash
pnpm check
pnpm smoke
clanky --help
pnpm docs:dev
```

Focused non-live checks:

```bash
pnpm smoke:clanky
pnpm smoke:voice
pnpm smoke:agent-tools
pnpm voice:native:test
```
