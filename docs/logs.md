# Runtime Logs and Local Loki

This project emits structured runtime action logs as JSON lines and can stream them into a local Loki stack for debugging.

## Structured log output

Runtime action logs are produced from `Store.onActionLogged` and include:
- `ts`
- `source`
- `level`
- `kind`
- `event`
- `agent`
- `guild_id`
- `channel_id`
- `message_id`
- `user_id`
- `usd_cost`
- `content`
- `metadata`

Sensitive metadata keys are redacted (`apiKey`, `token`, `authorization`, `secret`, etc.).

## Environment settings

Add to `.env`:

```bash
RUNTIME_STRUCTURED_LOGS_ENABLED=true
RUNTIME_STRUCTURED_LOGS_STDOUT=true
RUNTIME_STRUCTURED_LOGS_FILE_PATH=data/logs/runtime-actions.ndjson
```

`RUNTIME_STRUCTURED_LOGS_FILE_PATH` is the file Promtail tails into Loki.

## Local Loki stack

The repository includes:
- `docker-compose.loki.yml`
- `ops/loki/loki-config.yml`
- `ops/loki/promtail-config.yml`
- `ops/loki/grafana/provisioning/datasources/loki.yml`

Start:

```bash
bun run logs:loki:up
```

Stop:

```bash
bun run logs:loki:down
```

## Usage flow

1. Start Loki stack (`bun run logs:loki:up`).
2. Start bot (`bun run start`).
3. Open Grafana at `http://localhost:3000` (`admin` / `admin`).
4. In Explore, use Loki datasource and query:

```logql
{job="clanker_runtime"}
```

Filter examples:

```logql
{job="clanker_runtime",kind="voice_runtime"}
{job="clanker_runtime",agent="voice",level="error"}
```

## Voice output incident workflow

When a voice turn is transcribed correctly but the bot does not answer, use the
assistant output state machine doc first:

- [`voice-output-state-machine.md`](voice-output-state-machine.md)

Start with these events:

- `voice_turn_addressing`
- `bot_audio_started`
- `openai_realtime_response_done`
- `openai_realtime_active_response_cleared_stale`

Important interpretation rule:

- top-level `reason="bot_turn_open"` is a coarse public deny label
- `outputLockReason` is the authoritative blocker for reply/output lock incidents

Suggested query:

```logql
{job="clanker_runtime",kind=~"voice_runtime|voice_turn_out"} |= "voice_turn_addressing"
```

Inspect these metadata fields together:

- `outputLockReason`
- `reason`
- `msSinceAssistantReply`
- `retryAfterMs`

Common blockers:

- `outputLockReason=bot_audio_buffered`
- `outputLockReason=pending_response`
- `outputLockReason=openai_active_response`
- `outputLockReason=awaiting_tool_outputs`

Operator notes:

- if `outputLockReason=bot_audio_buffered` persists for more than a couple seconds after `openai_realtime_response_done`, suspect stale `clankvox` playback telemetry rather than real remaining speech
- if a deferred turn keeps rescheduling, inspect whether `voice_activity_started` is followed by `voice_turn_dropped_silence_gate`; silence-only captures should not be treated the same as real live speech

## Voice input / VAD workflow

When the bot appears to ignore speech or ambient audio keeps opening turns, inspect the provisional-capture path before looking at reply admission.

Start with these events:

- `voice_activity_started`
- `voice_turn_dropped_provisional_capture`
- `openai_realtime_asr_speech_started`
- `openai_realtime_asr_speech_stopped`
- `voice_realtime_transcription_empty`
- `openai_realtime_asr_bridge_empty_dropped`

Important interpretation rules:

- `voice_activity_started` now means a provisional capture promoted to a real turn
- `promotionReason=server_vad_confirmed` means OpenAI Realtime transcription VAD confirmed speech for that utterance
- `promotionReason=strong_local_audio` means the local fallback promoted without waiting for VAD
- `voice_turn_dropped_provisional_capture` means the capture never became a real turn and was discarded before normal reply admission

Suggested query:

```logql
{job="clanker_runtime",kind="voice_runtime"} |= "voice_activity_started"
```

Inspect these metadata fields together:

- `promotionReason`
- `promotionServerVadConfirmed`
- `promotionBytes`
- `promotionPeak`
- `promotionRms`
- `promotionActiveSampleRatio`

Ambient-noise triage:

- repeated `voice_activity_started` followed by `voice_realtime_transcription_empty` or `openai_realtime_asr_bridge_empty_dropped` usually means local promotion is still too permissive for the room
- repeated `voice_turn_dropped_provisional_capture` means the new provisional gate is working and the noise is being rejected before it becomes a turn
- if `openai_realtime_asr_speech_started` never appears for a promoted turn and `promotionReason=strong_local_audio`, the fallback path promoted without server VAD confirmation
- if a join greeting fires but no greeting is heard, check `realtime_reply_skipped` for `source=voice_join_greeting`; a fired join greeting now retries once, but a persistent `empty_reply_text` still means the brain path produced no spoken output
