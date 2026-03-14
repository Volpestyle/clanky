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
DASHBOARD_SETTINGS_SAVE_DEBUG=false
```

`RUNTIME_STRUCTURED_LOGS_FILE_PATH` is the file Promtail tails into Loki.
`DASHBOARD_SETTINGS_SAVE_DEBUG=true` enables the otherwise-silent dashboard settings save success log.

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

## Incident analysis and replay

Loki/Grafana is the raw event substrate, not the final debugging experience.

For day-to-day operator work, the highest-leverage observability surface is a
turn debugger that reconstructs one incident from the underlying structured
events.

Prioritize this workflow over generic metrics dashboards:

- open any sent message, reply, error, or suspicious runtime event
- reconstruct the full turn timeline from correlated logs
- show the raw JSON beside a human-readable replay
- let operators pivot into broader log search only after the local turn makes sense

Minimum replay payload for a text or multimodal turn:

- trigger message and `triggerMessageIds`
- ingress admission decision (`reply_admission_decision`)
- queue-side drop reasons (`reply_queue_gate_rejected`) when a queued turn never reaches generation
- reply-pipeline boundary (`reply_pipeline_gate`) when a queued turn reaches the pipeline but stops before generation
- tool availability snapshot (`reply_tool_availability`) before the model decides whether to call tools
- coalesced recent-message window
- addressing / admission decision
- prompt bundle (`metadata.replyPrompts`)
- LLM calls in order, including `toolNames`, `toolCallCount`, `stopReason`, and transcript/output previews
- tool loop steps and tool results
- tool failures such as `browser_browse_failed`, including runtime, provider/model, URL, and error details
- attachment artifacts, image lookup results, fetched pages, or other retrieved context
- final delivered action: reaction, sent message, sent reply, skip, or failure
- memory side effects such as retrieval, embedding, and reply ingestion
- cost and latency breakdown (`performance.*`, `usd_cost`)

Correlation keys to preserve across the UI:

- `metadata.botId`
- `metadata.deployment`
- `metadata.triggerMessageId`
- `metadata.sessionId`
- `metadata.turnId`
- `metadata.source`
- `metadata.stage`
- `metadata.allow`
- `metadata.reason`
- `message_id`
- `metadata.triggerMessageId`
- `metadata.triggerMessageIds`
- `metadata.sessionId`
- `guild_id`
- `channel_id`
- `user_id`

## Text reply incident workflow

When a text message appears to be ignored before any prompt or LLM call happens, start with the ingress and queue boundaries:

- `reply_admission_decision`
- `reply_queue_gate_rejected`
- `reply_pipeline_gate`
- `reply_tool_availability`

Suggested query:

```logql
{job="clanker_runtime",kind="text_runtime"} |= "reply_"
```

Inspect these metadata fields together:

- `botId`
- `deployment`
- `triggerMessageId`
- `sessionId`
- `turnId`
- `allow`
- `reason`
- `addressSignal`
- `attentionMode`
- `attentionReason`
- `recentReplyWindowActive`
- `coldAmbientProbability`
- `coldAmbientGatePassed`
- `queueDepth`
- `forceRespond`
- `sendBudgetAllowed`
- `talkNowAllowed`
- `ctxBuilt`
- `includedTools`
- `excludedTools`

Interpretation notes:

- `reply_admission_decision` is the text ingress decision before the message is ever queued for generation.
- `reason=hard_address` means the text path admitted the turn immediately because it was a direct address or exact bot-name hit.
- `reason=recent_reply_window` means the turn stayed in the active follow-up window from a recent bot reply.
- `reason=cold_ambient_*` means the turn was ambient and passed or failed the deterministic cold-ambient probability gate.
- `reply_queue_gate_rejected` means the message was already queued, but the queue worker later dropped it because settings, identity, permissions, or duplicate-trigger state changed before send-time.
- `reply_pipeline_gate` means the queued turn reached `maybeReplyToMessagePipeline()`. `reason=ready` is the successful boundary crossing; other reasons explain why the pipeline exited before any LLM call.
- `reply_tool_availability` records the tool set that was actually exposed to the model for that text turn, including excluded tool names with collapsed reasons like `settings_disabled`, `budget_blocked`, `provider_unconfigured`, and `no_history_images`.
- These decision-boundary events should all carry the same debugger anchor bundle: `botId`, `deployment`, `triggerMessageId` or `sessionId`, `turnId`, `source`, `stage`, `allow`, and `reason`.

Design rule:

- analytics charts are secondary
- incident reconstruction, replay, and search are primary

If a weird behavior requires an operator to manually stitch together five log
lines across captioning, tool calls, memory, and final delivery, the logs are
present but the debugging product is still incomplete.

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
- Failed `voice_brain_tool_call` events also carry `metadata.error` with the tool-returned error summary when one is available, so you do not need to infer the failure from `metadata.isError` alone.
- `realtime_tool_call_*` events come from provider-native tool execution. These happen only when the session owns provider tools directly (`realtimeToolOwnership="provider_native"`).
- `session.mode` still tells you which realtime runtime carried audio. It does not, by itself, tell you who owned planning or tools.

## Native Screen Watch Fallback Attribution

When screen watch falls back to the share link and you need to know why native
Discord watch did not bind, inspect these events together:

- `voice_screen_watch_capability`
- `screen_watch_native_start_failed`
- `screen_watch_started_native`
- `stream_watch_reused_programmatic`
- `screen_watch_link_fallback_started`
- `screen_watch_link_reused`

Interpretation notes:

- `voice_screen_watch_capability` is the per-turn capability snapshot from the full-brain voice path. It records whether screen watch was supported, enabled, currently available, what the native-specific reason/status were, and whether `start_screen_watch` was actually exposed to the model on that turn.
- `voice_screen_watch_capability` can report native watch as ready from discovered Go Live state before the active-sharer roster has frame evidence or full stream credentials.
- `stream_discovery_go_live_bootstrap_seeded` marks the moment Bun turns `VOICE_STATE_UPDATE.self_stream=true` into provisional per-session Go Live state, before `STREAM_CREATE` or `STREAM_SERVER_UPDATE` arrive.
- `stream_discovery_go_live_bootstrap_cleared` marks provisional bootstrap state being cleared after `VOICE_STATE_UPDATE.self_stream=false` when Discord never promoted that share into full discovered credentials.
- `screen_watch_native_start_failed` is the authoritative native-start failure event before fallback.
- `screen_watch_started_native` means the Bun runtime actually bound a native Discord share target. Inspect `metadata.reused` and `metadata.frameReady` to tell whether it attached to an existing watch and whether usable pixels were already available.
- `stream_watch_reused_programmatic` is the manager-level reuse breadcrumb. It means a same-target native watch stayed active and Bun re-subscribed without resetting frame context.
- `screen_watch_link_fallback_started` and `screen_watch_link_reused` now carry `metadata.nativeFailureReason` so the fallback line still explains why native did not win.

Useful metadata fields:

- `toolExposed`
- `supported`
- `enabled`
- `available`
- `nativeSupported`
- `nativeEnabled`
- `nativeAvailable`
- `nativeStatus`
- `reason`
- `nativeReason`
- `fallback`
- `requestedTargetUserId`
- `selectionReason`
- `nativeActiveSharerCount`
- `nativeActiveSharerUserIds`
- `goLiveStreamUserId`
- `goLiveStreamCredentialsReady`
- `streamKey`
- `nativeDecoderSupported`
- `runtimeMode`
- `voiceChannelId`
- `reused`
- `frameReady`

When you need to locate the failure layer for native Discord screen watch,
follow the cross-process breadcrumb trail in order:

- Rust voice-conn observed Discord state: `clankvox_discord_video_state_observed`
- Rust saw an OP18 payload that looked video-adjacent but did not match the current video-state shape: `clankvox_voice_ws_unclassified_op18`
- Rust capture supervisor applied state: `clankvox_native_video_state_received`
- Rust emitted state over IPC: `clankvox_native_video_state_emitted`
- Bun session applied active-sharer state: `native_discord_screen_share_state_updated`
- Rust accepted the watch subscription: `clankvox_native_video_subscribe_requested`
- Rust refreshed Discord sink wants: `clankvox_video_sink_wants_updated`
- Rust forwarded the first subscribed frame: `clankvox_first_video_frame_forwarded`
- Bun ingested a frame for model context: `stream_watch_frame_ingested`
- Bun failed to decode a forwarded frame before ingest: `native_discord_video_decode_failed`

Interpretation notes:

- if `screen_watch_native_start_failed` says `requested_target_not_actively_sharing` and no `clankvox_discord_video_state_observed` appears, the Rust process never observed native share state from Discord
- if `clankvox_voice_ws_unclassified_op18` appears, Discord sent OP18 data that the current Rust parser did not recognize as video state
- if you see `ignoring video state payload without user_id`, Discord sent video-like state without the user identity field our Rust parser requires
- if `clankvox_discord_video_state_observed` appears without `native_discord_screen_share_state_updated`, the issue is between Rust IPC emission and Bun session-state application
- if state-update logs appear but `clankvox_first_video_frame_forwarded` never appears, native share discovery worked but no subscribed frame made it through
- if `native_discord_video_decode_failed` appears with `metadata.timedOut=true` or content `ffmpeg_decode_timeout`, Bun killed the per-frame `ffmpeg` decode watchdog before a JPEG reached stream-watch ingest
- if `clankvox_video_sink_wants_skipped_no_connection` appears, a subscription request arrived before the voice connection was ready; later `voice_ready` or another state update should trigger a retry path

## Voice output incident workflow

When a voice turn is transcribed correctly but the bot does not answer, use the
assistant output state machine doc first:

- [`../voice/voice-output-and-barge-in.md`](../voice/voice-output-and-barge-in.md)

Start with these events:

- `voice_turn_addressing`
- `voice_barge_in_gate`
- `voice_direct_address_interrupt`
- `bot_audio_started`
- `openai_realtime_response_done`
- `openai_realtime_active_response_cleared_stale`
- `realtime_assistant_utterance_queued`
- `realtime_assistant_utterance_drain_blocked`
- `realtime_assistant_utterance_queue_drained`

Important interpretation rule:

- top-level `reason="output_locked"` is a coarse public deny label
- `outputLockReason` is the authoritative blocker for reply/output lock incidents

Suggested query:

```logql
{job="clanker_runtime",kind=~"voice_runtime|voice_turn_out"} |= "voice_turn_addressing"
```

Inspect these metadata fields together:

- `allow`
- `reason`
- `outputLockReason`
- `blockers`
- `pendingResponseRequestId`
- `pendingResponseSource`
- `backpressureActive`
- `stage`
- `source`
- `msSinceAssistantReply`
- `retryAfterMs`

Common blockers:

- `outputLockReason=bot_audio_buffered`
- `outputLockReason=pending_response`
- `outputLockReason=openai_active_response`
- `outputLockReason=awaiting_tool_outputs`

Operator notes:

- `voice_barge_in_gate` is promotion-scoped, not chunk-scoped. It captures the first summarized interruption decision for a promoted user capture when some assistant output context is active.
- `realtime_assistant_utterance_queued` tells you why spoken playback was queued instead of sent immediately. Look at `blockers`, `outputLockReason`, `pendingResponse*`, and `ttsBufferedSamples`. Active user captures are no longer a blocker — the bot speaks when it has something to say, even while humans are talking.
- `realtime_assistant_utterance_drain_blocked` fires when queued spoken playback tried to drain but some blocker still held the floor. It is deduped by blocker signature, so a new line usually means the wedge changed state rather than simple polling noise.
- if `voice_barge_in_gate` shows `allow=false`, treat `reason` as the primary interruption blocker and `outputLockReason` as supporting context about what the assistant was doing.
- if `voice_barge_in_gate` shows `allow=false reason=music_only_playback`, that means music was the only remaining output lock. Buffered or live bot speech should not resolve to this reason.
- if `voice_barge_in_gate` shows `allow=false reason=transcript_overlap_interrupts_enabled`, the system intentionally waited for transcript-burst interruption logic instead of cutting audio from raw PCM.
- if `voice_barge_in_gate` shows `allow=false reason=local_only_promotion_pending_server_vad`, the capture promoted from strong local audio but had not yet been confirmed by server VAD for live interruption.
- `voice_interrupt_speech_started_pending initialReason=insufficient_capture_bytes` means the authorized same-speaker overlap is still live and the runtime will keep checking whether it matures into a valid interrupt; the first under-threshold chunk is no longer a permanent miss by itself. If `eventType=local_capture_overlap`, that pending sustain loop came from promoted local capture rather than provider `input_audio_buffer.speech_started`.
- `voice_interrupt_speech_started_retry_scheduled` means a pending same-speaker overlap stayed active but still had not crossed the raw cut gate on the last sustain check; inspect `captureBytesSent`, `minCaptureBytes`, and signal metrics before blaming policy or music. Note: `echo_guard_active` is a terminal denial — if the sustain recheck hits the echo guard, the pending interrupt is released rather than rescheduled, preventing the bot from cutting its own audio via echo.
- `voice_interrupt_on_speech_started_sustain speechStillActiveSource=local_capture` means the runtime committed the cut from an actively growing promoted capture even though provider `speech_started` never arrived in time; `provider_speech_started` means the sustain path was driven by provider VAD as usual.
- `realtime_reply_superseded_newer_input` now includes `replyUserId` and `pendingOtherSpeakerQueueDepth`. Only turns from the reply target speaker count as interrupting; chatter from other participants is tracked but does not trigger supersede.
- on `voice_barge_in_interrupt` or `voice_output_lock_interrupt`, read `interruptAcceptanceMode` and `interruptAccepted` separately from `responseCancelSucceeded` / `truncateSucceeded`; async-confirmation providers can accept a locally committed cut before the provider emits its later interruption/completion event.
- if `providerInterruptConfirmationPending=true`, the runtime already cut local playback and accepted the interrupt, but the provider did not give an immediate ack for that cut path.
- if `outputLockReason=bot_audio_buffered` persists for more than a couple seconds after `openai_realtime_response_done`, suspect stale `clankvox` playback telemetry rather than real remaining speech
- if `voice_turn_addressing` shows `reason=bot_turn_open` but a same-moment `voice_direct_address_interrupt` follows, the turn cut through output lock because it was an allowed wake-word / bot-name interruption
- if a deferred turn keeps rescheduling, inspect whether `voice_activity_started` is followed by `voice_turn_dropped_silence_gate`; silence-only captures should not be treated the same as real live speech

## Video transport and DAVE decrypt workflow

When the screen watch pipeline fails to produce frames, start with the transport
and DAVE layers before looking at Bun-side decode failures.

Start with these events:

- `clankvox_transport_decrypt_failed`
- `clankvox_h264_frame_nal_diagnostic`
- `clankvox_first_video_frame_forwarded`
- `native_discord_video_decode_failed`
- `stream_watch_frame_ingested`

Interpretation notes:

- `clankvox_transport_decrypt_failed` fires once per unique payload type when transport-level (AES-GCM / XChaCha20) decryption fails. If this fires for audio PT (111) or video PTs (103/105), the transport crypto AAD computation may be wrong. Inbound RTCP packets (PT 72-76) are filtered before decrypt and should never appear here.
- `clankvox_h264_frame_nal_diagnostic` logs NAL types, keyframe status, and frame byte count at frame 1-5 and every 100th frame. `video_keyframe_count=0` after hundreds of frames means no SPS/IDR has arrived. `nal_types=[7, 8, 1]` means SPS+PPS were prepended to a P-slice from the depacketizer cache (normal for Go Live).
- DAVE video passthrough warnings (`DAVE: video frame from user ... appears unencrypted`) are expected on Go Live streams. Video frames that fail DAVE decrypt with `UnencryptedWhenPassthroughDisabled` are dropped instead of forwarded, because the DAVE library's unencrypted detection can misfire on Go Live video that IS encrypted. Audio passthrough is still allowed on the stream watch transport since that audio channel is not used for ASR.
- `native_discord_video_decode_failed` with `ffmpeg_decode_timeout` means ffmpeg hung waiting for EOF. This is an ffmpeg H264 raw demuxer issue. The current workaround pipes H264 data through `cat | ffmpeg` to guarantee clean pipe close.
- `native_discord_video_decode_failed` with `deblocking_filter_idc out of range` or `reference count overflow` on frames that have `headerHex` starting with valid SPS bytes means DAVE-encrypted video was forwarded as cleartext. The DAVE video drop fix should prevent this.
- `native_discord_video_decode_failed` with `h264_missing_parameter_sets` means the depacketizer hasn't cached SPS/PPS yet. Wait for more frames.

Useful metadata fields:

- `codec`
- `keyframe`
- `rtpTimestamp`
- `frameBytes`
- `pendingH264AccessUnitCount`
- `timedOut`
- `headerHex`

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
- `openai_realtime_asr_bridge_empty_dropped` means the bridge never forwarded any transcript into turn processing, so no downstream LLM generation happened for that utterance; punctuation-only ASR fragments such as `"?"` collapse into this path
- `voice_interrupt_unclear_turn_handoff_requested` should appear only when that exact bridge utterance already committed a real interrupt; stale interruption context alone should not synthesize this recovery event
- `voice_interrupt_unclear_turn_handoff_skipped` means empty/unclear ASR tried to enter interruption recovery, but the bridge utterance did not have valid committed interrupt context; inspect `skipReason` before blaming ASR quality alone
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
