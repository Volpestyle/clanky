# Clanky

Clanky is a standalone personal Pi agent. It owns its persona, profile-local
state, memory, Linear stores, and bundled skills. It does not run its own
daemon, scheduler, HTTP server, WebSocket server, or multi-agent room
system.

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
join one configured voice channel through `clankvox`, and bridge Discord PCM to
OpenAI Realtime.

Required runtime env:

- `CLANKY_DISCORD_VOICE_ENABLED=1`
- `CLANKY_DISCORD_VOICE_GUILD_ID`
- `CLANKY_DISCORD_VOICE_CHANNEL_ID`
- `OPENAI_API_KEY` or `CLANKY_OPENAI_API_KEY`

Optional env:

- `CLANKY_OPENAI_REALTIME_MODEL` (default `gpt-realtime-2`)
- `CLANKY_OPENAI_REALTIME_VOICE` (default `marin`)
- `CLANKY_OPENAI_BASE_URL`
- `CLANKY_DISCORD_VOICE_VIDEO_FRAME_INTERVAL_MS` (default `2000`) throttles
  automatic Realtime attachment of decoded screen-share frames; the snapshot
  tool always attaches the latest decoded frame on demand.
- `CLANKY_CLANKVOX_DIR` or `CLANKY_CLANKVOX_BIN` to override the bundled
  `clankvox` Rust source/binary lookup

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
text prompt into the Realtime voice session after join; this is useful for
validating output audio or asking the model to call `ask_pi` without manual
spoken setup. Set `CLANKY_DISCORD_VOICE_STOP_WHEN_VALID=1` to stop the live run
as soon as all enabled positive validation counters pass; error-only validation
still runs for the full configured duration. To make the live run fail unless
specific activity happened, set
`CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO`, `CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO`,
`CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO`, `CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL`,
`CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI`, `CLANKY_DISCORD_VOICE_REQUIRE_STREAM_WATCH`, or
`CLANKY_DISCORD_VOICE_REQUIRE_SCREEN_FRAME` to `1`; `CLANKY_DISCORD_VOICE_REQUIRE_ALL=1`
enables all of them. Set `CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1` to
also fail if the Realtime API returns errors or the Realtime socket errors or
closes during the run. The harness prints a checklist for the enabled
requirements after joining voice. Stream-watch and screen-frame validation
require a `user-token` Discord credential.

For the exact user-run checklist and copyable bot-token/user-token validation
commands, including `CLANKY_DISCORD_VOICE_RESULT_PATH` for saving the final
or startup-failure validation JSON, see
[docs/discord-voice-live-runbook.md](docs/discord-voice-live-runbook.md).

## Browser CLI Skills

Bundled browser skills use local project CLIs, not global installs:

- `clanky-web-operator`: broad routing policy for live web lookup and browser
  work. It can choose OpenAI hosted `web_search`, direct HTTP, Playwright,
  Chrome CDP, or `agent-browser` depending on the task.
- `clanky-playwright-browser`: general browsing, extraction, and screenshots through
  `pnpm browser:playwright ...` or short `pnpm exec tsx` Playwright scripts.
- `clanky-chrome-cdp`: attach to Chrome DevTools Protocol sessions through
  `pnpm browser:cdp ...`; launch a temporary-profile debug Chrome with
  `pnpm browser:chrome-debug ...`.

`web_search` requires `OPENAI_API_KEY` or `CLANKY_OPENAI_API_KEY` and defaults
to `CLANKY_WEB_SEARCH_MODEL` or `gpt-5.5`. Set
`CLANKY_WEB_OPERATOR_AUTO_SKILL=0` to disable automatic `clanky-web-operator`
skill injection for lookup/browser-like prompts.

Install Playwright's Chromium binary once with `pnpm browser:install` if the
host does not already have it.

## Layout

- `agents/clanky` is the runnable `@clanky/agent` package and `clanky` bin.
- `packages/clanky-core` contains Clanky memory, Linear stores, profile paths,
  state storage, skills loading, and model-facing tools.
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
