# Discord Voice Live Runbook

Use this after the non-live checks pass. The harness joins a real Discord voice
channel, connects OpenAI Realtime, and validates the counters that prove the
voice bridge is working.

## Preflight

Run these locally before joining Discord:

```bash
pnpm check
pnpm smoke
pnpm voice:native:check
pnpm voice:build
```

Credentials can come from `CLANKY_DISCORD_TOKEN` or from a stored
`/discord-login` credential in the active Clanky profile. Bot tokens are enough
for normal voice audio. Native Discord Go Live watching requires a user-token
credential.

## Bot-Token Audio And Tool Check

This checks voice join, Discord input audio, Realtime output audio, Realtime
tool calling, Pi delegation, and Realtime socket health. Join the configured
voice channel yourself and speak briefly during the run.

```bash
CLANKY_DISCORD_VOICE_ENABLED=1 \
CLANKY_DISCORD_VOICE_GUILD_ID=... \
CLANKY_DISCORD_VOICE_CHANNEL_ID=... \
OPENAI_API_KEY=... \
CLANKY_DISCORD_VOICE_LIVE_MS=90000 \
CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL=1 \
CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI=1 \
CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1 \
CLANKY_DISCORD_VOICE_RESULT_PATH=tmp/discord-voice-bot-result.json \
CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT="Use ask_pi to ask Pi for a one-sentence status check, then reply out loud." \
pnpm voice:live
```

For group voice validation, add:

```bash
CLANKY_DISCORD_VOICE_REQUIRE_GROUP_AUDIO=1
```

Then have two voice participants overlap briefly. The status output should show
`discordInputMaxConcurrentSpeakers` greater than `1`.

## User-Token Go Live Check

Use this only with a burner Discord user account. The native screen-share path
uses undocumented user-token/selfbot Discord gateway behavior.

Start a Discord Go Live stream in the configured voice channel, then run:

```bash
CLANKY_DISCORD_CREDENTIAL_KIND=user-token \
CLANKY_DISCORD_VOICE_ENABLED=1 \
CLANKY_DISCORD_VOICE_GUILD_ID=... \
CLANKY_DISCORD_VOICE_CHANNEL_ID=... \
OPENAI_API_KEY=... \
CLANKY_DISCORD_VOICE_LIVE_MS=120000 \
CLANKY_DISCORD_VOICE_REQUIRE_ALL=1 \
CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1 \
CLANKY_DISCORD_VOICE_RESULT_PATH=tmp/discord-voice-golive-result.json \
CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT="List active screen shares, start watching the visible Go Live stream, take a snapshot, and describe what is on screen." \
pnpm voice:live
```

If you use stored `/discord-login` credentials instead of
`CLANKY_DISCORD_TOKEN`, make sure `/discord-whoami` reports `user-token`.

## Result Artifact

Set `CLANKY_DISCORD_VOICE_RESULT_PATH` to write a JSON result file. The harness
writes it for preflight/startup failures and before final validation failures
are thrown, so it is useful for both passing and failing runs. Share that file
when reporting live results.

The result includes:

- `phase` (`preflight`, `error`, or `final`)
- `validation.passed`
- `validation.failures`
- `validation.requirements`
- bridge `status` when available
- startup/runtime `error` when available
- start/end timestamps and duration

## Pass Criteria

The harness prints `voice-live: validation PASS` when all enabled requirements
are satisfied. For the full Go Live run, the important counters are:

- `discordInputAudioEventCount > 0`
- `discordInputMaxConcurrentSpeakers > 1` when group audio is required
- `realtimeAudioDeltaCount > 0`
- `realtimeFunctionCallCount > 0`
- `askPiCallCount > 0`
- `streamWatchConnectCount > 0`
- `decodedVideoFrameCount > 0`
- Realtime API/socket error counters stay at `0`

## Common Failures

- `Discord Go Live validation requires ... user-token`: the run requested
  stream-watch or screen-frame validation with a bot token.
- `expected Discord input audio events`: nobody spoke in the configured voice
  channel, or the bot/user did not join the expected channel.
- `expected overlapping Discord input from at least two speakers`: group audio
  validation was enabled but the speakers did not overlap.
- `expected decoded Discord screen-share frames`: `STREAM_WATCH` connected, but
  no decodable frame reached `clankvox`; keep the Go Live stream visible for
  longer and retry.
- Realtime socket closes/errors: rerun with `CLANKY_DISCORD_VOICE_STATUS_MS=1000`
  to capture the last status counters before failure.
