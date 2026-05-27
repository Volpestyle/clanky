# Troubleshooting

Start with `/setup status` and `/profile`. Most Clanky setup issues are profile,
credential, or ownership issues.

## Clanky Starts But The Model Cannot Answer

Check auth:

```text
/openai-whoami
/model
```

Fix:

```text
/openai-login
```

Also check whether `CLANKY_OPENAI_API_KEY` or `OPENAI_API_KEY` is set in the
launch environment. Env vars override stored profile auth.

## I Am In The Wrong Profile

Check:

```text
/profile
```

Fix launch flags:

```bash
pnpm clanky --home ~/.clanky --profile personal --cwd .
```

For disposable testing, prefer:

```bash
pnpm dev:setup:fresh
```

## Discord Text Does Not Respond

Check:

```text
/discord-whoami
/discord-status
/setup status
```

Common causes:

- No Discord credential is stored and `CLANKY_DISCORD_TOKEN` is not set.
- Clanky needs a restart after `/discord-login`.
- `CLANKY_CHAT_GATEWAY_OWNER=room` or `off` is suppressing the agent-owned
  gateway.
- The message does not match DMs, mentions, replies, wake names, conversation
  binding, or engagement-window rules.
- Another owner is already handling the same Discord conversation.

## Discord Subagents Look Stuck

Check:

```text
/subagents status
/subagents modal
pnpm clanky logs --profile personal --home ~/.clanky
```

Use AgentRoom for real multi-agent room work. Clanky subagents are only the
agent-owned Discord multitasking path.

## Discord Voice Does Not Join

Check:

```text
/discord-voice status
/voice-logs tail
/discord-status
```

Common causes:

- Voice is not enabled.
- Guild or channel ids are missing or outside the allowlist.
- Discord credential is missing or was added after launch.
- OpenAI credential is missing for Realtime.
- Native helper failed to build or start.

Validate native pieces:

```bash
pnpm voice:native:test
pnpm voice:build
```

If a previous build used the wrong system Opus library:

```bash
pnpm voice:native:clean
pnpm voice:native:test
```

For live checks, use [Discord Voice Live Runbook](qa/discord-voice-live-runbook.md).

## Voice Speaks With The Wrong TTS Provider

Check:

```text
/discord-voice status
/elevenlabs-whoami
```

Env vars override profile settings. Look for:

- `CLANKY_DISCORD_VOICE_TTS_PROVIDER`
- `CLANKY_VOICE_TTS_PROVIDER`
- `CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER`
- `CLANKY_VOICE_REALTIME_AGENT_PROVIDER`
- `XAI_API_KEY`
- `CLANKY_ELEVENLABS_API_KEY`
- `ELEVENLABS_API_KEY`
- `CLANKY_ELEVENLABS_VOICE_ID`

Profile settings can be changed with:

```text
/discord-voice set realtime-provider xai
/discord-voice set xai-model grok-voice-latest
/discord-voice set tts-provider elevenlabs
/discord-voice set elevenlabs-voice <voice-id>
```

## Go Live Or Screen Watch Does Not Work

Normal bot-token voice can join channels and play audio. Native Discord Go Live
screen watching depends on user-token/selfbot behavior and should be considered
live-gated. Use the voice runbook and confirm the credential kind before
debugging media code.

## Web Or Browser Work Fails

Check:

```text
/web
```

For OpenAI hosted web search, configure OpenAI auth. For Playwright routes,
install Chromium once:

```bash
pnpm browser:install
```

For Chrome CDP routes, start or attach to a Chrome debug session through the
browser helper scripts documented in the web operator skill.

## Media Generation Fails

Check:

```text
/media
/openai-whoami
/xai-whoami
```

OpenAI images use OpenAI auth. xAI image/video generation uses xAI auth. Env
vars can override stored profile auth.

## MCP Tools Are Missing

Check:

```text
/mcp
```

Custom MCP servers come from `CLANKY_MCP_SERVERS`, a JSON object keyed by server
name. AgentRoom MCP is auto-added when enrolled in a room or when
`.agentroom/config.yaml` exists. Discord MCP is auto-added unless disabled.

Disable auto-adds:

```bash
CLANKY_AGENTROOM_MCP=0
CLANKY_DISCORD_MCP=0
```

## AgentRoom Launch Works But Discord Ownership Is Confusing

Remember the two axes:

- `AGENTROOM=1` means Clanky is participating in a room.
- `CLANKY_CHAT_GATEWAY_OWNER` decides whether Clanky starts its own Discord
  gateway.

Use `CLANKY_CHAT_GATEWAY_OWNER=room` when AgentRoom owns the Discord connector.
Use agent-owned Discord only when this Clanky profile owns the Discord
conversation.

## Docs Site Does Not Build

Run:

```bash
pnpm docs:build
```

The GitHub Pages workflow builds only on docs-relevant path changes:

- `.github/workflows/docs-pages.yml`
- `apps/docs/**`
- `docs/**`
- `README.md`
- workspace dependency/config files

The broader `pnpm check` command can fail on unrelated active code changes. Use
`pnpm docs:build` to validate docs-only changes.
