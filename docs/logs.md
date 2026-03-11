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

Prompt logs for turn-level debugging are attached under `metadata.replyPrompts`
and stay hidden by default in the dashboard Action Stream.

Pretty stdout rules:

- actual delivered speech/transcripts stay emphasized in pretty stdout when the log carries `metadata.transcript` or `metadata.incomingTranscript`
- output delivery stays labeled as `said` when `metadata.transcriptSource=output`
- request-time `metadata.replyText` stays visible in pretty stdout, but it is not rendered with the same bold speech emphasis as delivered transcripts
- `llm_call` runtime lines now summarize the returned model text the same way, plus `toolNames`, `toolCallCount`, `responseChars`, and `stopReason` when the provider reports one
- normal-operation reply admission / bridge handoff logs now carry transcript character counts instead of duplicating full text; use ASR segment logs and final assistant transcript logs when you need exact wording

Canonical prompt-log coverage:

- text reply turns: `sent_reply`, `sent_message`, `reply_skipped`
- voice classifier decisions: `voice_turn_addressing`
- full-brain voice generation turns: `realtime_reply_requested`, `realtime_reply_skipped`
- full-brain voice tool loop: `voice_brain_tool_call`, `voice_brain_generation_failed`
- provider-native realtime tool loop: `realtime_tool_call_started`, `realtime_tool_call_completed`, `realtime_tool_call_failed`
- realtime bridge/native prompt refresh and forwarded turns: `openai_realtime_instructions_updated`, `openai_realtime_text_turn_forwarded`

`metadata.replyPrompts` uses one shared shape:

- `systemPrompt`
- `initialUserPrompt`
- `followupUserPrompts`
- `followupSteps`

The Voice tab complements these per-event logs with a live SSE snapshot view:

- `promptState.instructions` shows the current realtime/system instructions the VC path is running with.
- `promptState.classifier`, `promptState.generation`, and `promptState.bridge` show the latest captured classifier, full-brain, and bridge-forward prompt bundles for the active session.
- Screen-share state in the Voice tab separates keyframe analyses (`streamWatch.visualFeed`) from the accumulated prompt context the VC brain sees (`streamWatch.brainContextPayload`).

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

## Voice memory attribution

When voice feels redundant or expensive, attribute memory work before changing
prompting behavior.

Start with these events:

- `voice_generation_memory_loaded`
- `voice_realtime_instruction_memory_loaded`
- `memory_embedding_call`

Suggested query:

```logql
{job="clanker_runtime",kind=~"voice_runtime|memory_embedding_call"}
```

Inspect these metadata fields together:

- `memorySource`
- `traceSource`
- `continuityLoadMs`
- `behavioralMemoryLoadMs`
- `totalLoadMs`
- `usedCachedBehavioralFacts`
- `userFactCount`
- `relevantFactCount`
- `behavioralFactCount`

Interpretation notes:

- `voice_generation_memory_loaded` is the orchestrator brain path that feeds Claude/OpenAI/etc. generation
- `voice_realtime_instruction_memory_loaded` is the separate OpenAI/Gemini/xAI realtime instruction refresh path
- `memory_embedding_call.traceSource` attributes the embedding API call to the caller:
  - `voice_realtime_behavioral_memory:generation` — behavioral fact retrieval from the brain/generation path (`voiceReplies.ts`)
  - `voice_realtime_behavioral_memory:instruction_refresh` — behavioral fact retrieval from the realtime instruction refresh path (`instructionManager.ts`)
  - `voice_realtime_instruction_context` — conversation continuity from instruction refresh
  - `voice_realtime_generation` — conversation continuity from generation
  - `memory_query` — explicit memory search tool call
- in transport_only sessions (brain mode), the instruction refresh path skips memory retrieval entirely — only the generation path should produce embedding calls
- if both `:generation` and `:instruction_refresh` traces appear on the same turn, the session is provider_native and both paths are expected

## Voice tool ownership attribution

When you need to distinguish provider-native realtime tools from the full-brain/orchestrator path, use event family plus ownership metadata together.

Start with these events:

- `voice_brain_tool_call`
- `voice_brain_generation_failed`
- `realtime_tool_call_started`
- `realtime_tool_call_completed`
- `realtime_tool_call_failed`

Interpretation notes:

- `voice_brain_*` events come from the full-brain reply path. They should carry `metadata.replyPath="brain"` and `metadata.realtimeToolOwnership="transport_only"`.
- `realtime_tool_call_*` events come from provider-native tool execution. These happen only when the session owns provider tools directly (`realtimeToolOwnership="provider_native"`).
- `session.mode` still tells you which realtime runtime carried audio. It does not, by itself, tell you who owned planning or tools.

## Voice output incident workflow

When a voice turn is transcribed correctly but the bot does not answer, use the
assistant output state machine doc first:

- [`voice-output-and-barge-in.md`](voice/voice-output-and-barge-in.md)

Start with these events:

- `voice_turn_addressing`
- `voice_direct_address_interrupt`
- `bot_audio_started`
- `openai_realtime_response_done`
- `openai_realtime_active_response_cleared_stale`

Important interpretation rule:

- top-level `reason="output_locked"` is a coarse public deny label
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
- if `voice_turn_addressing` shows `reason=bot_turn_open` but a same-moment `voice_direct_address_interrupt` follows, the turn cut through output lock because it was an allowed wake-word / bot-name interruption
- if a deferred turn keeps rescheduling, inspect whether `voice_activity_started` is followed by `voice_turn_dropped_silence_gate`; silence-only captures should not be treated the same as real live speech

## Voice input / VAD workflow

When the bot appears to ignore speech or ambient audio keeps opening turns, inspect the provisional-capture path before looking at reply admission.

Start with these events:

- `voice_activity_started`
- `voice_turn_dropped_provisional_capture`
- `openai_realtime_asr_speech_started`
- `openai_realtime_asr_speech_stopped`
- `voice_realtime_transcription_empty`
- `file_asr_transcription_empty`
- `openai_realtime_asr_bridge_empty_dropped`

Important interpretation rules:

- `voice_activity_started` now means a provisional capture promoted to a real turn
- `promotionReason=server_vad_confirmed` means OpenAI Realtime transcription VAD confirmed speech for that utterance
- `promotionReason=strong_local_audio` means the local fallback promoted without waiting for VAD
- `voice_turn_dropped_provisional_capture` means the capture never became a real turn and was discarded before normal reply admission
- `voice_realtime_transcription_empty` includes `trackedUtteranceId`, `activeUtteranceId`, `finalSegmentCount`, and `partialChars` so you can tell whether the commit went empty while a newer live utterance was already active
- `file_asr_transcription_empty` means the local file-turn transcription path returned no transcript before admission/generation
- `openai_realtime_asr_bridge_empty_dropped` means the bridge never forwarded any transcript into turn processing, so no downstream LLM generation happened for that utterance
- `voice_turn_addressing` and `openai_realtime_text_turn_forwarded` now report transcript length metadata rather than the full utterance text; inspect `openai_realtime_asr_final_segment` for the exact user wording in realtime bridge sessions

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

- repeated `voice_activity_started` followed by `voice_realtime_transcription_empty`, `file_asr_transcription_empty`, or `openai_realtime_asr_bridge_empty_dropped` usually means local promotion is still too permissive for the room
- repeated `voice_turn_dropped_provisional_capture` means the new provisional gate is working and the noise is being rejected before it becomes a turn
- a promoted turn followed immediately by `voice_turn_dropped_provisional_capture` often means the drop belongs to a second weak follow-on capture, not the already-promoted utterance
- if `openai_realtime_asr_speech_started` never appears for a promoted turn and `promotionReason=strong_local_audio`, the fallback path promoted without server VAD confirmation
- if promoted turns keep interrupting ambient bot speech, check `voice_system_speech_cancelled_for_user_speech` together with `realtime_reply_skipped` to confirm the thought path was preempted before audio
