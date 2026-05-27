# Clanky

![Clanky](/branding/clanky-logo-512.png)

Clanky is a standalone personal Pi agent. It owns its persona, profile-local
state, memory, native work-tracker refs, and bundled skills. It does not run
its own daemon, scheduler, HTTP server, WebSocket server, or multi-agent room
system. Linear is the built-in tracker provider today, but the core work
tracking model is provider-neutral.

New to Clanky? Start with [docs/start-here.md](docs/start-here.md), then read
[docs/pi-foundation.md](docs/pi-foundation.md). The upstream Pi harness docs
live at [pi.dev/docs/latest](https://pi.dev/docs/latest).

AgentRoom is the room/runtime daemon. Clanky works naturally inside any
AgentRoom because AgentRoom can launch it as a normal Pi harness command and
audit the room send/read flow around it.

## Room And Chat Ownership

Two axes are independent. Full contract in `docs/AGENTROOM.md`.

- **Room participation.** Clanky can run outside AgentRoom or be launched into
  a room as a normal Pi harness.
- **Gateway ownership.** Each Discord conversation is owned either by Clanky
  directly or by the AgentRoom daemon. Agent-owned Discord keeps Clanky's own
  bot identity and token, even while Clanky participates in a room. Room-owned
  Discord uses the room connector bot and routes through AgentRoom.

For a personal Clanky, the intuitive setup is agent-owned Discord plus optional
AgentRoom participation for coordinating with other agents. For a shared
multi-agent public channel, use a room-owned connector with webhook attribution.

## Configuration Model

Clanky is configured through the active profile, not through AgentRoom's room
YAML. The TUI setup commands edit profile-local stores such as `auth.json`,
`discord-voice.json`, and `models.json`; launch env vars remain explicit
overrides for CI, AgentRoom launches, and one-off sessions.

AgentRoom's `.agentroom/config.yaml` owns room topology and room-owned
connectors. Clanky's profile owns personal credentials, memory, sessions,
skills, and agent-owned chat settings. See `docs/configuration.md` for the
source-of-truth and override rules.

## Discord Setup (Agent-Owned)

The primary path is the interactive login from inside the Clanky TUI:

```bash
pnpm clanky
# inside Clanky:
/discord-login     # walks credential kind -> instructions -> masked token entry
/discord-whoami    # shows which credential the next launch will use
/discord-status    # shows active Discord text/voice bridge counters
/discord-logout    # removes the stored credential
```

`/discord-login` validates the token against Discord's REST API (`GET /users/@me`),
confirms the identity, and persists the credential into the active profile's
`auth.json` (`0600` perms) under provider id `clanky-discord`. Restart Clanky
to start the gateway with the new token.

`CLANKY_DISCORD_TOKEN` still works as an override: when present it always wins
over the stored credential. Useful for CI, AgentRoom launchers, and one-off
runs.

Agent-owned Discord starts when a token is resolvable (env or stored) and
`CLANKY_CHAT_GATEWAY_OWNER` is `agent` (the default).

### Discord Subagents

Clanky-owned Discord subagents are a local multitasking aid, not an AgentRoom
worker system. Accepted Discord chat goes to a dedicated Discord subagent when
the subagent coordinator is available, giving Discord its own Pi session and
context window instead of reinjecting Discord history into the main session on
each turn. That subagent can inspect Discord through the bundled
`clanky-discord-operator` skill, ask main Clanky for main-session context, and
delegate longer work back to the main worker.

Subagent sessions are profile-local and resumed from the stored subagent session
file when Clanky restarts. Pi compaction applies normally to those sessions.
Use `/clanky direct <message>` from Discord only when you explicitly want to
bypass the Discord subagent and send a turn straight to main Clanky.

Use AgentRoom for multi-agent development work, room tasks, audited worker
coordination, and shared room-owned chat connectors. Use Clanky subagents only
for Clanky's own agent-owned Discord multitasking.

## OpenAI Setup

Clanky can use the normal Pi `/login` OAuth path, or store an OpenAI API key
interactively:

```bash
pnpm clanky
# inside Clanky:
/openai-login     # masked API-key entry + validation
/openai-whoami    # shows the active OpenAI credential source
/openai-logout    # removes the stored OpenAI credential
```

`/openai-login` validates the key against OpenAI's models endpoint and stores it
in the active profile's `auth.json` (`0600` perms) under provider id `openai`,
the same slot Pi uses for OpenAI model auth. `CLANKY_OPENAI_API_KEY` and
`OPENAI_API_KEY` still work as launch-environment overrides; the Clanky-scoped
env var wins for Clanky tools when both are set.

Clanky's default Pi chat model is `openai/gpt-5.5` with `xhigh` reasoning.
Clanky-owned Discord subagents use the same default model with `medium`
reasoning so quick Discord replies do not inherit the main worker's reasoning
budget. Pi auto-compaction stays enabled by default. In the TUI, use
`/effort`, `/effort main <level>`, `/effort subagents <level>`, or
`/effort all <level>` to inspect or change these levels at runtime.

Without a conversation binding, Clanky accepts DMs, Discord @mentions, direct
replies to his recent messages, natural name mentions (`clanky` / `clank` by
default), and same-user follow-ups during the engagement window. Name mentions
and follow-ups are still model-mediated: Clanky can output `[SKIP]` to stay
silent.

### Discord Voice

Discord voice is opt-in and uses the same Discord credential as the text
gateway. When text chat is agent-owned, Clanky shares one Discord client for
chat and voice. When text chat is suppressed by `CLANKY_CHAT_GATEWAY_OWNER`,
Clanky can still create a voice-only Discord client with voice-state intents,
join one configured voice channel through `clankvox`, transcribe each active
Discord speaker through an individual OpenAI Realtime transcription session, and
send labeled transcript turns into the main realtime voice agent session.
See `docs/discord-voice-architecture.md` for the end-to-end control-plane,
media-plane, Realtime, and Pi delegation map.

Required runtime env:

- `CLANKY_DISCORD_VOICE_ENABLED=1`
- `CLANKY_DISCORD_VOICE_GUILD_ID`
- `CLANKY_DISCORD_VOICE_CHANNEL_ID`

OpenAI credentials for voice may come from `OPENAI_API_KEY`,
`CLANKY_OPENAI_API_KEY`, or a stored `/openai-login` API key.
ElevenLabs credentials for optional external speech may come from
`CLANKY_ELEVENLABS_API_KEY`, `ELEVENLABS_API_KEY`, or a stored
`/elevenlabs-login` API key.

Optional env:

- `CLANKY_DISCORD_VOICE_TTS_PROVIDER` or `CLANKY_VOICE_TTS_PROVIDER`
  selects only the speech output provider (default `openai`; supported values:
  `openai`, `realtime`, `elevenlabs`, `eleven_labs`, `11labs`)
- `CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER` or
  `CLANKY_VOICE_REALTIME_AGENT_PROVIDER` selects the realtime reasoning/tool
  agent provider (`openai` or `xai`; default `openai`)
- `CLANKY_OPENAI_REALTIME_MODEL` controls the OpenAI Realtime reasoning/tool
  agent model (default `gpt-realtime-2`)
- `CLANKY_OPENAI_REALTIME_VOICE` (default `marin`; used only by OpenAI
  Realtime audio output)
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
- `CLANKY_ELEVENLABS_API_KEY` or `ELEVENLABS_API_KEY` when using
  `CLANKY_DISCORD_VOICE_TTS_PROVIDER=elevenlabs` without `/elevenlabs-login`
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
- `CLANKY_OPENAI_BASE_URL`
- `CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS` (default `2000`) throttles
  automatic Realtime attachment of decoded screen-share frames; the snapshot
  tool always attaches the latest decoded frame on demand.
- `CLANKY_CLANKVOX_DIR` or `CLANKY_CLANKVOX_BIN` to override the bundled
  `clankvox` Rust source/binary lookup

The speech output provider is deliberately separate from the realtime
reasoning/tool agent. With the default `openai` speech output provider, the
selected realtime agent returns audio directly: OpenAI Realtime uses
`CLANKY_OPENAI_REALTIME_VOICE`, and xAI Grok Voice uses
`CLANKY_XAI_REALTIME_VOICE`. With `elevenlabs`, the selected realtime agent is
still used for live reasoning, tools, and text responses; Clanky streams that
text through ElevenLabs TTS and sends the returned PCM audio to Discord. The
`/discord-voice` advanced settings can store the realtime agent provider, xAI
model/voice, speech output provider, ElevenLabs voice id, model, PCM output
format, and API base URL in the active profile. `/xai-login` and
`/elevenlabs-login` store API keys in the profile auth store. Env vars still
override profile settings.

The bundled native helper can be checked or prebuilt before launching voice:

```bash
pnpm voice:native:test
pnpm voice:build
```

If no release binary exists, the voice bridge falls back to
`cargo run --release --locked` from the bundled `clankvox` directory.
If a native build was previously attempted against the wrong system Opus
library, run `pnpm voice:native:clean` before rebuilding.

The realtime bridge exposes voice-native tools for delegating durable work back
to the Pi runtime (`ask_pi`) and for native Discord Go Live screen watching
(`list_screen_shares`, `start_screen_watch`, `stop_screen_watch`,
`see_screenshare_snapshot`). Native Go Live watching depends on Discord
user-token/selfbot behavior; bot-token voice can join normal voice channels but
should not be expected to provide the full screen-share path.

For a headless live check with real credentials, run `pnpm voice:live`. It
starts the same runtime/gateway stack, joins the configured voice channel, prints
bridge status, and holds the session open for `CLANKY_DISCORD_VOICE_LIVE_MS`
(default `60000`, `0` means until signal). It also prints periodic status with
audio/tool/screen counters; set `CLANKY_DISCORD_VOICE_STATUS_MS=0` to disable
that interval. Set `CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT` to send an initial
text prompt into the realtime voice agent session after join; this is useful for
validating output audio or asking the model to call `ask_pi` without manual
spoken setup. Set `CLANKY_DISCORD_VOICE_STOP_WHEN_VALID=1` to stop the live run
as soon as all enabled positive validation counters pass; error-only validation
still runs for the full configured duration. To make the live run fail unless
specific activity happened, set
`CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO`, `CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO`,
`CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION`,
`CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO`,
`CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL`, `CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI`,
`CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH`, or
`CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME` to `1`;
`CLANKY_DISCORD_VOICE_REQUIRE_ALL=1` enables all of them. Set
`CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1` to also fail if the Realtime API
returns errors or the Realtime socket errors or closes during the run. The
harness prints a checklist for the enabled requirements after joining voice.
Stream-watch and screen-frame validation require a `user-token` Discord
credential.

For the exact user-run checklist and copyable bot-token/user-token validation
commands, including `CLANKY_DISCORD_VOICE_RESULT_PATH` for saving the final
or startup-failure validation JSON, see
[docs/qa/discord-voice-live-runbook.md](docs/qa/discord-voice-live-runbook.md).

## Operator Skills

Bundled operator skills use Clanky tools and local project CLIs, not global installs:

- `clanky-web-operator`: broad routing policy for live web lookup and browser
  work. It can choose OpenAI hosted `web_search`, direct HTTP, Playwright,
  Chrome CDP, or `agent-browser` depending on the task.
- `clanky-media-operator`: image/video generation routing across OpenAI Images
  API, xAI Grok Imagine images, and xAI Grok Imagine videos.
- `clanky-playwright-browser`: general browsing, extraction, and screenshots through
  `pnpm browser:playwright ...` or short `pnpm exec tsx` Playwright scripts.
- `clanky-chrome-cdp`: attach to Chrome DevTools Protocol sessions through
  `pnpm browser:cdp ...`; launch a temporary-profile debug Chrome with
  `pnpm browser:chrome-debug ...`.

`web_search` requires an OpenAI credential from `/openai-login`,
`OPENAI_API_KEY`, or `CLANKY_OPENAI_API_KEY`, and defaults to
`CLANKY_WEB_SEARCH_MODEL` or `gpt-5.5`. Set
`CLANKY_WEB_OPERATOR_AUTO_SKILL=0` to disable automatic `clanky-web-operator`
skill injection for lookup/browser-like prompts.

Media generation tools:

- `openai_image_generate` uses `/openai-login`, `CLANKY_OPENAI_API_KEY`, or
  `OPENAI_API_KEY`; default model `CLANKY_OPENAI_IMAGE_MODEL` or `gpt-image-2`.
- `xai_image_generate` uses `XAI_API_KEY`; default model `CLANKY_XAI_IMAGE_MODEL`
  or `grok-imagine-image-quality`.
- `xai_video_generate` uses `XAI_API_KEY`; default model `CLANKY_XAI_VIDEO_MODEL`
  or `grok-imagine-video`.
- `media_backend_status` shows configured media backends. Set
  `CLANKY_MEDIA_OPERATOR_AUTO_SKILL=0` to disable automatic
  `clanky-media-operator` skill injection for media-generation prompts.

Install Playwright's Chromium binary once with `pnpm browser:install` if the
host does not already have it.

## Layout

- `agents/clanky` is the runnable `@clanky/agent` package and `clanky` bin.
- `packages/clanky-core` contains Clanky memory, work-tracker stores, profile
  paths, state storage, skills loading, and model-facing tools.
- `skills/` contains bundled Clanky skills.
- `agents/clanky/persona/SELF.md` is the static persona injected into Pi's
  system prompt.

## Local Development

```bash
pnpm install
pnpm check
pnpm smoke
pnpm clanky --help
```

Run the local interactive Pi surface:

```bash
pnpm clanky
pnpm clanky --profile personal --home ~/.clanky --cwd .
```

Smoke tests are non-live and isolate profile state in temporary directories:

```bash
pnpm smoke:clanky
pnpm smoke:voice
pnpm smoke:agent-tools
pnpm voice:native:test
```

## AgentRoom

From any initialized AgentRoom room, launch Clanky as an external Pi harness:

```bash
agent-room launch clanky --harness pi --command clanky --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

The `clanky` command must be available in the runtime environment. For local
development, run AgentRoom from a shell where this checkout's bin is on `PATH`,
or use a wrapper command that enters this checkout before starting Clanky.

AgentRoom supplies room/runtime environment variables such as `AGENTROOM`,
`AGENTROOM_AGENT_ID`, `AGENTROOM_ROOM_ID`, and `AGENTROOM_ROLE`. These mark
room participation; they do not decide who owns Clanky's Discord identity.
Use `CLANKY_CHAT_GATEWAY_OWNER=room` or `CLANKY_CHAT_GATEWAY_OWNER=off` when a
launcher should suppress Clanky's agent-owned gateway.

Agent-owned Discord runtime env:

- `CLANKY_DISCORD_TOKEN`: Clanky's own Discord bot/user token.
- `CLANKY_DISCORD_CREDENTIAL_KIND`: `bot-token` (default) or `user-token`.
- `CLANKY_DISCORD_CONVERSATION_ID`: optional DM/channel/thread allowlist. When
  omitted, Clanky accepts DMs and messages that mention it.
- `CLANKY_DISCORD_ENGAGEMENT_WINDOW_MINUTES`: same-user follow-up window in
  unbound channels. Default `5`; `0` disables.
- `CLANKY_DISCORD_WAKE_NAMES`: comma-separated natural names that count as
  mentioning Clanky. Default `clanky,clank`.

See `docs/AGENTROOM.md` for the integration contract.

## State

By default, Clanky stores profile state under `~/.clanky`. Use `--home` and
`--profile` to isolate runs:

```bash
pnpm clanky --home ./.clanky --profile work
```

The self-memory tool writes profile-local notes under the resolved profile
directory. The static persona markdown in `agents/clanky/persona/SELF.md`
remains the source for startup identity.
