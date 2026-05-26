# Discord Voice Live Runbook

Use this after the non-live checks pass. The harness joins a real Discord voice
channel, connects OpenAI Realtime, and validates the counters that prove the
voice bridge is working. OpenAI Realtime is always used for live reasoning,
tool calls, and speaker transcription. Speech output can come from OpenAI
Realtime audio directly or from ElevenLabs TTS.

## Preflight

Run these locally before joining Discord:

```bash
pnpm check
pnpm smoke
pnpm voice:native:check
pnpm voice:build
```

Enable voice from the Clanky TUI with:

```text
/discord-voice
```

On a fresh profile that opens setup. Once voice settings exist, it shows status.
Setup can enable voice access, add allowed server IDs, optionally restrict voice
channel IDs, pin a current voice channel target, and adjust Realtime settings.
Use `/discord-voice enable` to turn dynamic voice access on without pinning a
channel, `/discord-voice allow-server <guild-id> [...]` to add allowed servers,
`/discord-voice allow-channel <voice-channel-id> [...]` to add optional channel
restrictions, `/discord-voice join <guild-id> <voice-channel-id>` to pin one
active channel, or `/discord-voice status` for a quick text snapshot. These
settings are stored in the active Clanky profile and hot-restart the Discord
bridge when changed.
When voice access is enabled without a pinned target, Clanky can use the
`discord_voice_status`, `discord_voice_join`, and `discord_voice_leave` tools to
choose or leave a voice channel at runtime. If an allowlist is configured,
`discord_voice_join` rejects channels outside it.

By default OpenAI Realtime provides both the spoken response and the
tool-calling brain. To use ElevenLabs voices for speech while keeping Realtime
for reasoning, use the `/discord-voice` advanced settings or the shortcut
commands:

```text
/elevenlabs-login
/discord-voice set tts-provider elevenlabs
/discord-voice set elevenlabs-voice <voice-id>
/discord-voice set elevenlabs-model eleven_flash_v2_5
/discord-voice set elevenlabs-output-format pcm_24000
```

Env config still works and overrides the TUI profile setting when present:

```bash
CLANKY_DISCORD_VOICE_ENABLED=1
# Optional fixed target:
CLANKY_DISCORD_VOICE_GUILD_ID=...
CLANKY_DISCORD_VOICE_CHANNEL_ID=...
# Optional comma/space-separated server allowlist:
CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS=...
# Optional comma/space-separated channel allowlist:
CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS=...
# Optional ElevenLabs speech synthesis:
CLANKY_DISCORD_VOICE_TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
# or CLANKY_ELEVENLABS_API_KEY=...
CLANKY_ELEVENLABS_VOICE_ID=...
CLANKY_ELEVENLABS_MODEL=eleven_flash_v2_5
CLANKY_ELEVENLABS_OUTPUT_FORMAT=pcm_24000
```

Supported ElevenLabs PCM output formats are `pcm_16000`, `pcm_22050`,
`pcm_24000`, and `pcm_44100`. `CLANKY_ELEVENLABS_BASE_URL` or
`ELEVENLABS_BASE_URL` can override the API base URL. The `/discord-voice`
advanced settings can store the ElevenLabs voice id, model, output format, and
base URL in the active profile; `/elevenlabs-login` stores the API key.

Credentials can come from `CLANKY_DISCORD_TOKEN` or from a stored
`/discord-login` credential in the active Clanky profile. Bot tokens are enough
for normal voice audio. Native Discord Go Live watching requires a user-token
credential.

OpenAI credentials are still required for the Realtime model and can come from
`OPENAI_API_KEY`, `CLANKY_OPENAI_API_KEY`, or a stored `/openai-login` API key.
The examples below show `OPENAI_API_KEY`; omit that line if the active profile
already has a stored OpenAI key. ElevenLabs speech additionally requires
`ELEVENLABS_API_KEY`, `CLANKY_ELEVENLABS_API_KEY`, or a stored
`/elevenlabs-login` API key.

This bridge uses the OpenAI Realtime WebSocket/event transport intentionally.
OpenAI recommends WebRTC for browser or mobile clients where the client owns a
microphone track. Here, `clankvox` already terminates Discord RTP and exposes
PCM frames to Node, so WebSocket audio-buffer events map directly onto Discord
input/output without adding another media peer connection.

In group voice, barge-in is intentionally gated. While Clanky has spoken audio
buffered or active external TTS, ordinary speaker transcripts are recorded but
not forwarded to the response session. A speaker must explicitly say `Clanky`
or a configured/known STT alias such as `clank`, `clanker`, `clonky`,
`clunky`, or `planky` to interrupt; that path stops TTS playback, cancels the
active Realtime response, and forwards the addressed transcript. Add
`CLANKY_DISCORD_VOICE_WAKE_NAMES` or `CLANKY_DISCORD_WAKE_NAMES` for local
nicknames that should also count.

## Music And Video Media

Realtime is the live voice front-end, but Pi remains the reasoning/tool/skill
layer. The Realtime voice bridge exposes small URL-first media controls:

- `play_music_url`: play a resolved http(s) URL into Discord voice audio.
- `play_video_url`: start Discord Go Live for a resolved http(s) video URL and,
  by default, play the audio into voice too.
- `start_music_visualizer`: publish a Go Live visualizer for current music or a
  resolved music URL.
- `media_pause`, `media_resume`, `media_stop`, `media_status`: live playback
  controls.

For search-like requests such as "play Minecraft music" or "put on this video",
Realtime should call `ask_pi` first and let Pi use skills/tools to resolve the
playable URL. The media tools intentionally do not carry the old search,
queueing, and disambiguation stack.

`play_music_url` works with bot-token voice because it is normal Discord voice
audio. `play_video_url` and `start_music_visualizer` need a user-token
credential because they use Discord Go Live publish.

## Bot-Token Audio And Tool Check

This checks voice join, Discord input audio, Realtime session acceptance,
Realtime output audio, Realtime tool calling, Pi delegation, and Realtime socket
health. Join the configured voice channel yourself and speak briefly during the
run.

```bash
CLANKY_DISCORD_VOICE_ENABLED=1 \
CLANKY_DISCORD_VOICE_GUILD_ID=... \
CLANKY_DISCORD_VOICE_CHANNEL_ID=... \
OPENAI_API_KEY=... \
CLANKY_DISCORD_VOICE_LIVE_MS=90000 \
CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION=1 \
CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL=1 \
CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI=1 \
CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1 \
CLANKY_DISCORD_VOICE_RESULT_PATH=tmp/discord-voice-bot-result.json \
CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT="Use ask_pi to ask Pi for a one-sentence status check, then reply out loud." \
pnpm voice:live
```

`gpt-realtime-2` is the default Realtime model. The bridge sends
`reasoning.effort=low` by default for that model; override it with
`CLANKY_OPENAI_REALTIME_REASONING_EFFORT=minimal|low|medium|high|xhigh` when
you want to trade latency for deeper reasoning.

`CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO=1` follows the active speech
provider. For the default OpenAI speech path it requires OpenAI Realtime audio
deltas plus Discord output sends. For ElevenLabs speech it requires ElevenLabs
TTS output plus Discord output sends.

## ElevenLabs Speech Check

This checks voice join, Discord input audio, Realtime session acceptance,
Realtime tool calling, Pi delegation, ElevenLabs TTS streaming, Discord output
sends, and Realtime socket health. Join the configured voice channel yourself
and speak briefly during the run.

```bash
CLANKY_DISCORD_VOICE_ENABLED=1 \
CLANKY_DISCORD_VOICE_GUILD_ID=... \
CLANKY_DISCORD_VOICE_CHANNEL_ID=... \
OPENAI_API_KEY=... \
CLANKY_DISCORD_VOICE_TTS_PROVIDER=elevenlabs \
ELEVENLABS_API_KEY=... \
CLANKY_ELEVENLABS_VOICE_ID=... \
CLANKY_DISCORD_VOICE_LIVE_MS=90000 \
CLANKY_DISCORD_VOICE_REQUIRE_INPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_REALTIME_SESSION=1 \
CLANKY_DISCORD_VOICE_REQUIRE_OUTPUT_AUDIO=1 \
CLANKY_DISCORD_VOICE_REQUIRE_TOOL_CALL=1 \
CLANKY_DISCORD_VOICE_REQUIRE_ASK_PI=1 \
CLANKY_DISCORD_VOICE_FAIL_ON_REALTIME_ERROR=1 \
CLANKY_DISCORD_VOICE_RESULT_PATH=tmp/discord-voice-elevenlabs-result.json \
CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT="Use ask_pi to ask Pi for a one-sentence status check, then reply out loud." \
pnpm voice:live
```

Pass criteria for this path are the enabled checklist plus
`externalTtsRequestCount > 0`, `externalTtsAudioBytes > 0`,
`externalTtsErrorCount = 0`, and `discordOutputAudioSendCount > 0` in the final
status/result JSON.

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
- `validation.checks` with per-requirement `id`, `observed`, `expected`, and
  `passed` values when bridge status is available
- `validation.requirements`
- bridge `status` when available
- startup/runtime `error` when available
- start/end timestamps and duration

## Pass Criteria

The harness prints `voice-live: validation PASS` when all enabled requirements
are satisfied. For the full Go Live run, the important counters are:

- `discordInputAudioEventCount > 0`
- `discordInputMaxConcurrentSpeakers > 1` when group audio is required
- `realtimeSessionUpdatedCount > 0`
- `realtimeAudioDeltaCount > 0` when OpenAI speech is active
- `externalTtsRequestCount > 0` and `externalTtsAudioBytes > 0` when
  `CLANKY_DISCORD_VOICE_TTS_PROVIDER=elevenlabs`
- `discordOutputAudioSendCount > 0`
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
- `expected OpenAI Realtime session.updated after session.update`: the Realtime
  socket opened but OpenAI did not acknowledge the requested session
  configuration.
- `expected voice output audio to be sent to Discord`: the active speech
  provider produced output, but the bridge did not hand any audio to `clankvox`.
- `expected ElevenLabs TTS output audio`: ElevenLabs speech is active, but the
  bridge did not complete a TTS request; check the API key, voice id, model, and
  `externalTtsErrorCount`.
- `expected decoded Discord screen-share frames`: `STREAM_WATCH` connected, but
  no decodable frame reached `clankvox`; keep the Go Live stream visible for
  longer and retry.
- Realtime socket closes/errors: rerun with `CLANKY_DISCORD_VOICE_STATUS_MS=1000`
  to capture the last status counters before failure.
