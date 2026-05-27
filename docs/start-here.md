# Start Here

![Clanky and companion overlooking a mountain forest](/branding/clanky-forest-overlook-1024.png)

Clanky is a personal agent built on [Pi](https://pi.dev). Learn it through
three questions:

1. What powerful things can I do as a user?
2. What should I let Clanky handle?
3. What mental model explains what is happening?

## 1. What You Can Do

Clanky gives you a local agent that can carry personal context across tools:

- use Pi's terminal TUI for repo work, session history, model switching, and
  slash commands
- keep profile-local auth, memory, sessions, skills, and connector settings
- ask Clanky to remember source-grounded facts, then inspect or forget them
- connect external communication gateways, with Discord as the current
  agent-owned text adapter for DMs, mentions, replies, and optional channel
  binding
- let gateway requests run through subagents while the foreground session keeps
  working
- join live voice through the current Discord/ClankVox media adapter, hear
  speakers, speak back, and delegate durable work to Pi
- use web, browser, media generation, Linear, Discord, and other connected tool
  skills when configured
- join an AgentRoom room as a normal Pi harness while keeping profile ownership
  explicit

<!-- Capture backlog:
- docs/assets/gifs/clanky-tui-discord.gif: foreground Clanky working in the local TUI while Discord routes a mention through a subagent and returns a useful handoff.
-->

## 2. What To Let Clanky Handle

Let Clanky handle work that benefits from personal state and live tool access:

- repository orientation and local command/file work
- memory-backed context that should follow your profile
- external chat triage: reply, skip, ask for clarification, or delegate
- voice-room questions that need fast response plus optional Pi follow-up
- media/web/browser tasks where the right skill can pick the right backend
- AgentRoom participation as a lead, worker, or reviewer

Use AgentRoom when the problem becomes a room: multiple agents, runtime launch,
audited terminal IO, task shadows, room-owned connectors, mobile checks, and
handoffs between workers. Jump to
[AgentRoom Ecosystem Tour](docs://agent-room-docs/ecosystem) for that layer.

## 3. Mental Model

```mermaid
flowchart TB
  pi["Pi foundation<br/>TUI, sessions, tools, slash commands, models"]
  thread["Canonical Clanky thread<br/>Pi session messaging"]
  clanky["Clanky layer<br/>persona, memory, profile, skills, gateway adapters"]
  profile["Profile stores<br/>auth, sessions, memory, voice, subagents"]
  chat["Communication gateways<br/>Discord today, others later"]
  voice["Voice/media gateways<br/>ClankVox Discord today"]
  vox["ClankVox<br/>RTP, Opus, DAVE, Go Live"]
  room["AgentRoom<br/>optional coordination room"]

  pi --> thread
  thread --> clanky
  clanky --> profile
  chat <--> thread
  clanky --> voice
  voice --> vox
  clanky <--> room
```

Pi is the generic agent harness. Clanky configures that harness with personal
state, memory, skills, and gateway adapters. The local Pi session thread is
Clanky's built-in messaging; Discord text, AgentRoom send/read, and future
Slack, Telegram, SMS, webhook, or huddle-style integrations are gateways into
or out of that thread. ClankVox sits under the current Discord voice adapter as
deterministic transport code.
AgentRoom sits around Clanky when you want multi-agent coordination.

## First Path To Try

Use the fresh-user script first. It creates a temporary Clanky home so you can
test onboarding without touching your real profile.

```bash
cd /path/to/clanky-pi
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
and basic tool use before you involve communication gateways or voice.

## Normal Personal Profile

After the fresh run works, start a persistent profile:

```bash
clanky --home ~/.clanky --profile personal --cwd .
```

Inside Clanky:

```text
/setup
/profile
/openai-whoami
```

Profiles are the boundary for sessions, memory, skills, auth, voice settings,
subagents, and work-tracker state. Running two live Clankies on the same profile
is unsupported.

## Docs Map

- [Pi Foundation](pi-foundation.md): what Clanky inherits from Pi and what
  Clanky adds.
- [First-Time Setup](first-time-setup.md): prerequisites, install, fresh-user
  test, and connector setup.
- [Using Clanky](using-clanky.md): day-to-day workflows once the profile works.
- [Communication Gateways](communication-gateways.md): chat and voice/media
  gateway abstraction, ownership, and subagent routing.
- [Command Reference](command-reference.md): CLI commands, Pi slash commands,
  Clanky slash commands, and model-facing tools.
- [Memory And Privacy](memory-and-privacy.md): profile state, auth storage,
  memory policy, and forget/export commands.
- [AgentRoom Integration](AGENTROOM.md): room participation, gateway ownership,
  and launch contract.
- [Discord Voice Architecture](discord-voice-architecture.md): TypeScript
  control plane, Realtime, Pi delegation, and ClankVox media plane.
- [Troubleshooting](troubleshooting.md): common setup failures and where to look
  first.

For LLM ingestion, the docs site publishes
[`llms.txt`](https://volpestyle.github.io/docs/clanky/llms.txt) and
[`llms-full.txt`](https://volpestyle.github.io/docs/clanky/llms-full.txt).
