# Clanky Live Gates

These checks touch real services or credentials. Run the non-live checks first:

```bash
cd /Users/jamesvolpe/dev/agents/clanky-pi
pnpm check
pnpm smoke
```

Do not paste tokens into chat or docs. Prefer the interactive login commands
where available because they store credentials in the active profile's
`auth.json` with `0600` permissions.

## OpenAI Model Auth

Required for normal Clanky model use, OpenAI web search/media tools, and Discord
voice Realtime.

```bash
pnpm clanky --home ~/.clanky --profile personal
```

Inside Clanky:

```text
/openai-login
/openai-whoami
```

Expected result: `/openai-login` validates the key, `/openai-whoami` reports the
stored credential source, and a normal prompt can complete with the configured
Pi model.

## Agent-Owned Discord Text

Required for Clanky's own Discord identity and Discord subagent path.

```bash
pnpm clanky --home ~/.clanky --profile personal
```

Inside Clanky:

```text
/discord-login
/discord-whoami
```

Restart Clanky after login. Then run:

```text
/discord-status
```

Expected result: the text bridge is active when `CLANKY_CHAT_GATEWAY_OWNER` is
unset or `agent`, and Clanky responds only to DMs, mentions, replies, configured
conversation IDs, or accepted wake-name follow-ups.

## Discord Voice

Required for live voice join, speaker transcription, spoken output, Pi
delegation from voice, and optional Discord Go Live watching.

Use `discord-voice-live-runbook.md` (same directory). It covers bot-token audio, user-token
Go Live, OpenAI Realtime speech, and ElevenLabs speech.

Minimum credential set:

- Discord bot token or stored `/discord-login` credential.
- OpenAI API key or stored `/openai-login` credential.
- For ElevenLabs speech only: `ELEVENLABS_API_KEY`,
  `CLANKY_ELEVENLABS_API_KEY`, or stored `/elevenlabs-login`, plus
  `CLANKY_ELEVENLABS_VOICE_ID` or the TUI voice setting.

## Linear

Required only for live Linear issue creation or link updates from Clanky tools.

```bash
LINEAR_API_KEY=... pnpm clanky --home ~/.clanky --profile personal
```

Expected result: `work_tracker_create_issue` can create Linear issues when
Linear is the selected provider, and `work_tracker_link` can persist tracker
refs. If tracker credentials are unavailable, Clanky should report the skipped
tracker update explicitly rather than pretending it happened.

## xAI Media

Required only for xAI image/video tools.

```bash
XAI_API_KEY=... pnpm clanky --home ~/.clanky --profile personal
```

Expected result: `media_backend_status` shows xAI image/video backends as
configured and media-generation prompts can call the relevant tool.

## AgentRoom Launch

Required only when testing Clanky as a runtime-backed agent inside an AgentRoom
room.

From an initialized AgentRoom room:

```bash
agent-room launch clanky \
  --harness pi \
  --command "pnpm --dir /Users/jamesvolpe/dev/agents/clanky-pi clanky --home ./.clanky-room --profile clanky" \
  --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

Expected result: AgentRoom owns the room/runtime audit flow, while Clanky remains
standalone and keeps its profile-local state under the configured `--home`.
