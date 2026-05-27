# AgentRoom Integration

Clanky is standalone. AgentRoom should treat it as an external Pi harness
command, not as source code vendored into the AgentRoom repository.

## Two Independent Axes

There are two independent choices for Clanky + chat gateways (Discord today,
others later):

1. **Room participation:** Clanky may run outside AgentRoom, or AgentRoom may
   launch it as a runtime-backed Pi harness.
2. **Gateway ownership:** each external chat conversation is owned either by
   Clanky directly or by the AgentRoom daemon.

These are separate axes. `AGENTROOM=1` means "Clanky is in a room"; it does
not mean "Clanky must surrender his Discord identity."

### Agent-owned Discord

Clanky imports `@agentroom/chat-discord` as a library and runs the gateway
in-process under his own bot token. Traffic flows directly Discord <->
Clanky. This works both outside a room and while Clanky is participating in
AgentRoom.

Use case: personal Clanky keeps his own Discord identity and DMs with the
human, while also using AgentRoom DMs/tasks/channels to coordinate with other
agents.

Clanky's Discord subagents belong to this agent-owned path. They are only for
local multitasking while main Clanky is busy: if the main session is idle,
normal accepted Discord chat is routed to main Clanky, not to a subagent.
AgentRoom remains the path for real multi-agent development work, room tasks,
audited worker coordination, and room-owned connector channels.

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

### Room-owned Discord

AgentRoom daemon owns the gateway and token for a particular Discord
conversation. The Discord identity is the room's connector bot, not any
individual Clanky. Inbound messages route to a configured target, often
`agent-stdin:clanky-lead`. Worker Clankies receive tasks and DMs from the
lead through AgentRoom's native messaging.

The gateway library is the same in both cases (`@agentroom/chat-discord`,
which implements `ChatGatewayProvider`). Only the lifecycle owner differs.

One Discord conversation should have exactly one owner. Do not point both an
agent-owned gateway and a room-owned gateway at the same channel or DM.

## Ownership

- Clanky owns persona, memory, profile state, Linear stores, skills, and Pi
  `InteractiveMode` wiring.
- AgentRoom owns rooms, runtime providers, task/event audit, send/read
  coordination, and room-owned chat gateway lifecycle.
- Clanky owns agent-owned chat gateway lifecycle for its own profile, whether
  or not it is also in a room.

## Token Ownership

The rule: **whoever runs the gateway owns the token.**

- Agent-owned: Clanky's profile holds Clanky's Discord bot token, persisted
  in `<profileDir>/auth.json` (the same file Pi uses for model API keys, with
  `0600` perms and the same file locking). `CLANKY_DISCORD_TOKEN` env still
  overrides the stored value.
- Room-owned: AgentRoom holds the connector bot token.

Clanky must never read the room connector token. AgentRoom must never read
Clanky's profile token.

## Multi-Agent Topology

When AgentRoom fans one connector bot out to multiple Clankies, the gateway
posts outbound messages in Discord **webhook mode** so the same bot token
can send with per-message `username` and `avatar_url`. `clanky-lead`,
`clanky-impl-a`, and `clanky-reviewer` therefore appear as visually distinct
authors in the Discord channel without needing N bot accounts.

The lead/worker split is an AgentRoom concern, not a Clanky concern. Clanky
is always just "a Pi agent." The role comes from how AgentRoom routes
inbound traffic and assigns tasks; Clanky's binary and persona do not
change.

### Profile isolation

Multiple Clanky instances in the same workspace **must** use separate
`--profile <name>` flags, and typically `--home ./.clanky-room` for
room-scoped state, so memory, sessions, and Linear links do not collide.
Profiles are the only isolation boundary; sharing a profile across two live
Clankies is unsupported.

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
  relevant Discord conversation is room-owned.
- `CLANKY_CHAT_GATEWAY_OWNER=off` or `CLANKY_DISABLE_CHAT_GATEWAY=1`: no
  in-process Clanky gateway.

Agent-owned Discord env:

- `CLANKY_DISCORD_TOKEN`
- `CLANKY_DISCORD_CREDENTIAL_KIND=bot-token|user-token` (default `bot-token`)
- `CLANKY_DISCORD_CONVERSATION_ID` or legacy alias
  `CLANKY_DISCORD_CHANNEL_ID`
- `CLANKY_DISCORD_PROVIDER_ID` (default `clanky-discord`)
- `CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES` (default `5`; `0` disables)
- `CLANKY_DISCORD_WAKE_NAMES` (comma-separated, default `clanky,clank`)

Agent-owned Discord voice env:

- `CLANKY_DISCORD_VOICE_ENABLED=1`
- `CLANKY_DISCORD_VOICE_GUILD_ID`
- `CLANKY_DISCORD_VOICE_CHANNEL_ID`
- `CLANKY_DISCORD_VOICE_AUTO_JOIN=1` to join the configured target at startup
  for dev/live-test runs. Without this, a configured target stays dormant until
  `/discord-voice join` or the `discord_voice_join` tool requests a join.
- `OPENAI_API_KEY`, `CLANKY_OPENAI_API_KEY`, or stored `/openai-login`
- `CLANKY_DISCORD_VOICE_TTS_PROVIDER` or `CLANKY_VOICE_TTS_PROVIDER`
  selects only the speech output provider (default `openai`; set to
  `elevenlabs` to use external ElevenLabs speech)
- `CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER` or
  `CLANKY_VOICE_REALTIME_AGENT_PROVIDER` selects the realtime reasoning/tool
  agent provider (`openai` or `xai`; default `openai`)
- `CLANKY_OPENAI_REALTIME_MODEL` controls the OpenAI Realtime reasoning/tool
  agent model (default `gpt-realtime-2`)
- `CLANKY_OPENAI_REALTIME_VOICE` (default `marin`; used by the default OpenAI
  speech output path)
- `CLANKY_OPENAI_REALTIME_REASONING_EFFORT` (default `low` with
  `gpt-realtime-2`; supported values: `minimal`, `low`, `medium`, `high`,
  `xhigh`)
- `XAI_API_KEY`, `CLANKY_XAI_REALTIME_MODEL` (default `grok-voice-latest`),
  and `CLANKY_XAI_REALTIME_VOICE` (default `eve`) when using
  `CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER=xai`
- `CLANKY_OPENAI_REALTIME_TRANSCRIPTION_MODEL` (default
  `gpt-realtime-whisper`)
- `CLANKY_OPENAI_REALTIME_TRANSCRIPTION_DELAY` (default `low`; supported
  values: `minimal`, `low`, `medium`, `high`, `xhigh`)
- `CLANKY_OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE` to provide a language hint
  such as `en`
- `CLANKY_ELEVENLABS_API_KEY`, `ELEVENLABS_API_KEY`, or stored
  `/elevenlabs-login` when using `CLANKY_DISCORD_VOICE_TTS_PROVIDER=elevenlabs`
- `CLANKY_ELEVENLABS_VOICE_ID` when using ElevenLabs speech without the TUI
  voice setting
- `CLANKY_ELEVENLABS_MODEL` (default `eleven_flash_v2_5`)
- `CLANKY_ELEVENLABS_OUTPUT_FORMAT` (default `pcm_24000`; supported values:
  `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_44100`)
- `CLANKY_ELEVENLABS_BASE_URL` or `ELEVENLABS_BASE_URL`
- `CLANKY_DISCORD_VOICE_SPEAKER_TRANSCRIPTION_IDLE_CLOSE_MS` (default `120000`)
  closes inactive per-speaker transcription sessions
- `CLANKY_DISCORD_VOICE_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS` (default `350`)
  batches near-simultaneous speaker transcripts before asking the realtime voice
  agent to respond
- `CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS` (default `2000`) throttles
  automatic Realtime attachment of decoded screen-share frames; snapshot
  requests still attach the latest decoded frame immediately.
- `CLANKY_CLANKVOX_DIR` or `CLANKY_CLANKVOX_BIN` to override the bundled
  `clankvox` Rust source/binary lookup

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

Run `pnpm voice:live` for a headless live check. It starts the same Clanky
runtime/gateway stack, joins the configured voice channel, prints bridge status,
and holds the session open for `CLANKY_DISCORD_VOICE_LIVE_MS` (default `60000`,
`0` means until signal). It also prints periodic status with audio/tool/screen
counters; set `CLANKY_DISCORD_VOICE_STATUS_MS=0` to disable that interval. Set
`CLANKY_DISCORD_VOICE_REQUIRE_ALL=1` to fail the live run unless input audio,
group audio overlap, output audio, tool calls, Pi delegation, stream watch, and
screen frames all occurred. The individual `CLANKY_DISCORD_VOICE_REQUIRE_*`
flags can be used for narrower checks. The harness prints a checklist for the
enabled requirements after joining voice. Set `CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT` to inject an
initial text prompt into the realtime voice agent session after join; this can trigger
spoken output or an `ask_pi` tool call without manual voice setup. Set
`CLANKY_DISCORD_VOICE_STOP_WHEN_VALID=1` to stop the live run as soon as all
enabled positive validation counters pass; error-only validation still runs for
the full configured duration. Set `CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1`
to also fail on Realtime API errors or Realtime socket errors/closes.
Stream-watch and screen-frame validation require a `user-token` Discord
credential.

For the exact user-run checklist and copyable bot-token/user-token validation
commands, including `CLANKY_DISCORD_VOICE_RESULT_PATH` for saving the final
or startup-failure validation JSON, see
[discord-voice-live-runbook.md](discord-voice-live-runbook.md).
