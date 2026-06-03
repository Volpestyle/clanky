# AgentRoom Integration

Clanky is standalone. AgentRoom should treat it as an external Pi harness
command, not as source code vendored into the AgentRoom repository.

## Gateway Boundary

Clanky's native messaging is its Pi session thread. Discord, AgentRoom
send/read, and future Slack, Telegram, SMS, webhook, or huddle-style
integrations are gateways that can feed that thread, receive replies from it,
or route work to profile-local subagents. A gateway can be absent entirely and
Clanky still works as a local Pi agent.

This is a communication abstraction layer, not a Discord-only design. Discord
text and Discord voice are today's concrete adapters; future Telegram, Slack,
SMS, webhook, huddle, or other messaging surfaces should plug in at the same
ownership boundary.

Voice and video are separate media gateways. Discord voice runs through
ClankVox; a future Slack huddle adapter should plug in at the same ownership
boundary rather than making Slack or Discord part of Clanky's core session
model.

## Two Independent Axes

There are two independent choices for Clanky + external gateways:

1. **Room participation:** Clanky may run outside AgentRoom, or AgentRoom may
   launch it as a runtime-backed Pi harness.
2. **Gateway ownership:** each external chat or media conversation is owned
   either by Clanky directly or by the AgentRoom daemon.

These are separate axes. `AGENTROOM=1` means "Clanky is in a room"; it does
not mean "Clanky must surrender an agent-owned gateway identity."

### Agent-owned Chat Gateway

For the Discord adapter, Clanky imports `@agentroom/chat-discord` as a
library and runs the gateway in-process under his own bot token. Traffic flows
directly Discord <-> Clanky. This works both outside a room and while Clanky is
participating in AgentRoom.

Use case: personal Clanky keeps his own Discord identity and DMs with the
human, while also using AgentRoom DMs, channels, reports, and tracker-linked
delegations to coordinate with other agents.

Clanky's chat subagents belong to this agent-owned path. They are only for
local multitasking while main Clanky is busy: if the main session is idle,
normal accepted gateway chat is routed to main Clanky, not to a subagent.
AgentRoom remains the path for real multi-agent development work, audited
worker coordination, tracker-aware handoffs, and room-owned connector channels.

The runtime starts this gateway when a Discord token is resolvable and
`CLANKY_CHAT_GATEWAY_OWNER=agent` (the default). The token is resolved from,
in order:

1. `CLANKY_DISCORD_TOKEN` env var (always wins; matches the existing Linear
   creds pattern).
2. Profile `AuthStorage` (`<profileDir>/auth.json`, perms `0600`) under
   provider id `clanky-discord`. Saved interactively via `/discord-login`
   from inside the Clanky TUI.

Without `CLANKY_DISCORD_CONVERSATION_ID`, Clanky handles Discord DMs, Discord
@mentions, direct replies to his recent messages, natural name mentions, and
same-user follow-ups during the engagement window. Natural name mentions and
follow-ups are still model-mediated: Clanky can output `[SKIP]` to stay silent.
Set `CLANKY_DISCORD_CONVERSATION_ID` to bind one specific DM, channel, or
thread. The conversation id may also be saved alongside the stored token at
login time.

### Room-owned Chat Gateway

AgentRoom daemon owns the gateway and token for a particular external
conversation. With Discord, the Discord identity is the room's connector bot,
not any individual Clanky. Inbound messages route to a configured target,
often `agent-stdin:clanky-lead`. Worker Clankies receive DMs and
tracker-linked work from the lead through AgentRoom's native messaging.

The gateway library is the same in both Discord cases (`@agentroom/chat-discord`,
which implements the chat gateway provider contract). Only the lifecycle owner
differs.

One external conversation should have exactly one owner. Do not point both an
agent-owned gateway and a room-owned gateway at the same channel or DM.

## Ownership

Clanky owns profile state and agent-owned gateway lifecycle. AgentRoom owns
rooms, runtime providers, room event audit, send/read coordination, and
room-owned gateway lifecycle.

The complete file and token ownership map lives in
[AgentRoom Configuration](docs://agent-room-docs/configuration). The practical
rule is: whoever runs the gateway owns the token. Clanky must never read the
room connector token, and AgentRoom must never read Clanky's profile token.

## Multi-Agent Topology

When AgentRoom fans one connector bot out to multiple Clankies, the gateway
posts outbound messages in Discord **webhook mode** so the same bot token
can send with per-message `username` and `avatar_url`. `clanky-lead`,
`clanky-impl-a`, and `clanky-reviewer` therefore appear as visually distinct
authors in the Discord channel without needing N bot accounts.

The lead/worker split is an AgentRoom concern, not a Clanky concern. Clanky
is always just "a Pi agent." The role comes from how AgentRoom routes
inbound traffic and directs tracker-linked work; Clanky's binary and persona do
not change.

### Profile isolation

Multiple Clanky instances in the same workspace **must** use separate
`--profile <name>` flags, and typically `--home ./.clanky-room` for
room-scoped state, so memory, sessions, and work-tracker refs do not collide.
Profiles are the only isolation boundary; sharing a profile across two live
Clankies is unsupported.

AgentRoom can write the shared non-secret defaults directly into
`.agentroom/config.yaml`:

```bash
agent-room init --room my-project --runtime herdr --clanky --work-tracker linear --tracker-team team_123
```

Clanky treats that as a launch default only. Explicit `--home`, `--profile`,
`CLANKY_HOME`, and `CLANKY_PROFILE` still win, and API keys remain in env vars
or Clanky's profile auth store.

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

When Clanky is enrolled in AgentRoom through the MCP bridge, it should use the
matching MCP runtime tools instead of shelling out: `agentroom_runtime_providers`
and `agentroom_runtime_agents` for inspection, `agentroom_launch_agent` for
starting workers, and `agentroom_read_agent`, `agentroom_send_agent`, and
`agentroom_stop_agent` for audited runtime IO and lifecycle control.

## Environment

When AgentRoom launches Clanky, runtime providers set:

- `AGENTROOM=1`
- `AGENTROOM_AGENT_ID`
- `AGENTROOM_ROOM_ID`
- `AGENTROOM_ROLE`

Clanky may use these values for context, but it must remain runnable without
them. `AGENTROOM=1` only signals room participation.

Gateway startup is controlled separately:

- default: `CLANKY_CHAT_GATEWAY_OWNER=agent` behavior, so Clanky may start its
  own gateway when `CLANKY_DISCORD_TOKEN` is present.
- `CLANKY_CHAT_GATEWAY_OWNER=room`: suppress Clanky's gateway because the
  relevant external conversation is room-owned.
- `CLANKY_CHAT_GATEWAY_OWNER=off` or `CLANKY_DISABLE_CHAT_GATEWAY=1`: no
  in-process Clanky gateway.

Agent-owned Discord env:

- `CLANKY_DISCORD_TOKEN`
- `CLANKY_DISCORD_CREDENTIAL_KIND=bot-token|user-token` (default `bot-token`)
- `CLANKY_DISCORD_CONVERSATION_ID`
- `CLANKY_DISCORD_PROVIDER_ID` (default `clanky-discord`)
- `CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES` (default `5`; `0` disables)
- `CLANKY_DISCORD_WAKE_NAMES` (comma-separated, default `clanky,clank`)

Agent-owned Discord voice is configured through `/discord-voice`, profile
settings, and explicit voice env overrides for live checks. Keep the integration
contract here focused on ownership: AgentRoom room-owned text connectors do not
own Clanky's media gateway. For the full voice model and live-run flags, use
[Discord Voice Architecture](discord-voice-architecture.md) and
[Discord Voice Live Runbook](qa/discord-voice-live-runbook.md).

Voice reuses the agent-owned Discord client and token when text chat is
agent-owned. If room-owned text chat suppresses the text bridge, voice can still
log in with the same Discord credential using a voice-only client. Native
Discord Go Live screen watching depends on user-token/selfbot gateway behavior;
room-owned Discord connectors remain text/chat owner only. The realtime voice
bridge transcribes each active Discord speaker through a separate streaming
transcription session, then sends labeled transcript turns into the main
realtime voice agent session. The tool surface includes `ask_pi`,
`list_screen_shares`, `start_screen_watch`, `stop_screen_watch`, and
`see_screenshare_snapshot`.
The default `openai` speech output path means the selected realtime agent
returns audio directly. When ElevenLabs speech is selected, the selected
realtime agent returns text and Clanky streams that text through ElevenLabs
before playing the PCM audio through `clankvox`. The speech output provider is
separate from the realtime reasoning/tool agent provider; xAI Grok Voice is
selected with `realtime-provider xai`, not with `tts-provider`. The
`/discord-voice` advanced settings can store the realtime agent provider, xAI
model/voice, speech output provider, ElevenLabs voice id, model, output format,
and base URL in the active profile. `/xai-login` and `/elevenlabs-login` store
API keys in the profile auth store. Env vars still override profile settings.

The bundled native helper can be validated or prebuilt with `pnpm
voice:native:test` and `pnpm voice:build`. If no release binary exists, the
voice bridge falls back to `cargo run --release --locked` from the bundled
`clankvox` directory. If a native build was previously attempted against the
wrong system Opus library, run `pnpm voice:native:clean` before rebuilding.

Run `pnpm voice:live` for a headless live check. The detailed credentialed
checklist, result JSON flags, bot-token/user-token examples, and failure gates
live in [Discord Voice Live Runbook](qa/discord-voice-live-runbook.md).
