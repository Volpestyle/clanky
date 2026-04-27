---
name: log-dive
description: Deep-dive Clanky's structured runtime logs to reconstruct an incident end-to-end and produce a written post-mortem in docs/log-dives/. Use when the user asks to investigate a session, turn, error, regression, or unexpected bot behavior — phrases like "what happened in", "why did clanky", "trace this session", "log dive", "debug this incident", "post-mortem", or when given a sessionId / triggerMessageId / timestamp window to investigate.
metadata:
  short-description: Reconstruct one Clanky incident from structured logs and write a post-mortem
  domain: observability
  scope: workflow
---

# Clanky Log Dive

Reconstruct one incident from Clanky's structured event stream, then write it up. The product is a doc in `docs/log-dives/` that another operator can read end-to-end without re-querying.

This skill assumes the canonical logging contract in [`docs/operations/logging.md`](../../../docs/operations/logging.md). That file is the source of truth for event names, kinds, and metadata fields — read it whenever a new event family shows up that you don't recognize. Do not duplicate it here.

## When to use

- "What happened in session X?" / "Why did clanky Y?"
- A `triggerMessageId`, `sessionId`, `turnId`, timestamp window, or user-visible symptom is on the table
- Operator wants a written record of an incident, not just a one-line answer

## When *not* to use

- Asking which event to add, or how `Store.logAction` works → that's a code change, read `docs/operations/logging.md` and the runtime code directly
- Aggregate metrics, dashboards, charts → those are secondary; this skill is about reconstructing one turn at a time

## Workflow

### 1. Pin the scope before grepping

Get exactly one of these from the user (or infer from a symptom report):

- `sessionId` — voice session UUID, the strongest correlation key
- `triggerMessageId` — text turn anchor
- absolute timestamp window (UTC) + guild/channel
- a specific event name they saw fail (e.g. `voice_brain_generation_failed`) plus timestamp window / instance / guild

If none is available, ask. Don't dive blind — `runtime-actions.ndjson` may hold many sessions.

Also confirm: **which instance?** `CLANKER_INSTANCE_ID` (commonly `clanky` or `clanky-2`) — the same log file path differs per instance and Loki labels by `{instance="..."}`.

### 2. Pick the source

| Need | Source | Why |
|------|--------|-----|
| Last few minutes, just-stopped session | `data/logs/runtime-actions.ndjson` directly | Loki ingester delays 15–30s |
| Older sessions, multi-instance, time-range | Loki via Grafana Explore | Indexed, labelled, queryable |
| Single instance, last 24h, scriptable | ndjson + `rg` + `jq` | No services to start |

The ndjson is one JSON object per line with this top-level shape (see `docs/operations/logging.md` for the full list):

```
ts, instance, source, level, kind, event, agent,
guild_id, channel_id, message_id, user_id, usd_cost,
content, metadata
```

### 3. Collect — ndjson recipes

Locate the file (default path):

```bash
LOGS=data/logs/runtime-actions.ndjson
```

All events for one session, chronological:

```bash
rg --no-line-number "\"sessionId\":\"<sessionId>\"" "$LOGS" \
  | jq -c 'select(.metadata.sessionId == "<sessionId>")' \
  | jq -s 'sort_by(.ts)'
```

All events for one text turn:

```bash
rg --no-line-number "<triggerMessageId>" "$LOGS" | jq -s 'sort_by(.ts)'
```

Compact event-only timeline (good for skimming):

```bash
rg "<sessionId>" "$LOGS" \
  | jq -r '[.ts, .kind, .event, (.metadata.reason // ""), (.metadata.stage // "")] | @tsv' \
  | sort
```

Just the LLM calls for one session, with cost and shape:

```bash
rg "<sessionId>" "$LOGS" \
  | jq -c 'select(.kind=="llm_call") | {ts, model: .event, usd: .usd_cost, stop: .metadata.stopReason, chars: .metadata.responseChars, shape: .metadata.responseShape, sessionId: .metadata.sessionId}'
```

Pull the prompt bundle for one turn (system + user + tools + context):

```bash
rg "<turnId>" "$LOGS" \
  | jq -c 'select(.metadata.replyPrompts != null) | {ts, event, prompts: .metadata.replyPrompts}'
```

Everything that mentions an error or warning in a session:

```bash
rg "<sessionId>" "$LOGS" | jq -c 'select(.level=="error" or .level=="warn")'
```

### 4. Collect — LogQL recipes (Grafana Explore)

Bring the stack up if needed:

```bash
bun run logs:loki:up   # Grafana on http://localhost:3000  (admin/admin)
```

Base label set is `{job="clanker_runtime"}`. Common slices:

```logql
{job="clanker_runtime",instance="clanky"} |~ "<sessionId>"
{job="clanker_runtime",kind="text_runtime"} |= "reply_"
{job="clanker_runtime",kind="llm_call"} |~ "<sessionId>"
{job="clanker_runtime",agent="voice",level="error"}
{job="clanker_runtime",kind=~"voice_runtime|memory_embedding_call"}
```

`docs/operations/logging.md` has more workflow-specific queries — re-read its section that matches the symptom (text reply, voice output, ASR/VAD, screen watch native fallback, video transport, prompt size, memory attribution, tool ownership). Do not invent your own taxonomy when one already exists there.

### 5. Reconstruct the turn

For each turn in scope, build the canonical replay payload listed in `docs/operations/logging.md` ("Minimum replay payload"). The shape:

1. **Trigger** — the user message / voice utterance that opened the turn
2. **Admission** — `reply_admission_decision`, `reply_queue_gate_rejected`, `reply_pipeline_gate`, or for voice `voice_turn_addressing` / `voice_barge_in_gate`
3. **Tool exposure** — `reply_tool_availability` for text, `voice_screen_watch_capability` etc. for voice
4. **Prompt bundle** — `metadata.replyPrompts` (`systemPrompt`, `initialUserPrompt`, `followupUserPrompts`, `followupSteps`)
5. **LLM calls in order** — provider, model, `usage.*`, `responseChars`, `stopReason`, `responseShape`, `rawContentSummary`, `responseDiagnostics`
6. **Tool loop steps** — for text, `llm_call` entries with `metadata.toolCallCount`, `metadata.toolNames`, `metadata.event=reply_tool_loop:<n>`, `reply_tool_concurrent_failure:*`, and tool-specific runtime events such as `browser_browse_failed`; for voice brain, `voice_brain_tool_call` with `toolResultSummary`; for provider-native realtime, `realtime_tool_call_*`
7. **Final delivery** — `sent_message`, `sent_reply`, `bot_utterance_completed` (with `deliveryRatio`, `audioSuppressedBytes`), `reply_skipped`, or a failure event
8. **Side effects** — memory loads, embeddings, attachment/image lookups
9. **Cost & latency** — sum `usd_cost`, capture `performance.*`, queue waits, generation time

Correlation keys to thread through every section: `botId`, `deployment`, `triggerMessageId`(s), `sessionId`, `turnId`, `source`, `stage`, `allow`, `reason`, `message_id`, `guild_id`, `channel_id`, `user_id`.

If you find an event you don't recognize, search `docs/operations/logging.md` first, then `rg "<event_name>"` in `src/` for the emit site — its surrounding code names the field semantics better than any inference.

### 6. Write the post-mortem

Output path: `docs/log-dives/<YYYY-MM-DD>-<short-slug>.md` (e.g. `2026-04-25-vc-session-eb826899.md`, `2026-04-25-text-reply-skip-leak.md`).

Match the structure used by existing dives in that directory. Skim one of them before writing — they are the canonical template:

- `2026-03-16-vc-session-eb826899.md`
- `2026-03-15-vc-session-155583c8.md`

Expected sections, in order (omit conditional sections when they do not apply):

1. **Header block** — session id / trigger id, UTC time range, mode (`elevenlabs_realtime`, `openai_realtime`, brain vs provider-native, etc.), participants, turn count, LLM call count, total cost
2. **Conversation Timeline** — fenced ASCII block, one line per user/bot turn, annotated `[SKIP]`, `(ignored)`, `TRUNCATED`, `***LEAK***` etc. Real wording matters; use the ASR final segments for user text and `replyText` / delivered transcript for bot text
3. **Issues Reported / Observed** — numbered list of distinct problems
4. **One section per issue** — root cause, evidence (event names + timestamps + metadata fields, not raw JSON dumps), interpretation. Quote the smallest sufficient slice
5. **Latency / prompt-size / cost tables** when relevant — copy column shape from prior dives
6. **Fixes Applied** — only if a fix already landed in a separate change; table of `Issue | Root Cause | Fix | File`, with the commit hash if available
7. **Open Items / Future Considerations** — bulleted, blunt, no filler

Optionally, drop full prompt captures into `docs/log-dives/prompt-snapshots/<date>-<slug>-<phase>.txt` if the dive turns on prompt content.

### 7. Sanity checks before handing back

- Every claim in the doc cites an event name or metadata field — no "probably" / "seems like" without log evidence
- Times are UTC and consistent (the ndjson is UTC; align Grafana timezone if pasting from there)
- `sessionId` / `triggerMessageId` appear verbatim in at least one place so future searches hit
- If the dive identifies a bug, you've grepped `src/` and named the file/function that emits the broken behavior — not just the symptom
- If a fix is in scope, it's a separate change — the dive document records the diagnosis, the fix is its own commit/PR

## Common dives, by symptom

| Symptom | Start with | Then expand to |
|---------|------------|----------------|
| Text reply never happened | `reply_admission_decision`, `reply_queue_gate_rejected`, `reply_pipeline_gate` | `reply_tool_availability`, prompt bundle, `llm_call` |
| Voice turn transcribed but no answer | `voice_turn_addressing`, `voice_barge_in_gate`, `outputLockReason` | `realtime_assistant_utterance_*`, `bot_utterance_completed` |
| Speech cut off mid-sentence | `bot_utterance_completed` (`deliveryRatio`, `audioSuppressedBytes`) | `voice_output_lock_interrupt`, `realtime_reply_superseded_newer_input` |
| Directive (`[SKIP]`, `[[NOTE:...]]`) read aloud | `realtime_reply_requested`, delivered transcript vs `replyText` | normalization call sites in `src/voice/` |
| Slow turn | `llm_call.usage.*`, `performance.*`, queue wait deltas | memory load events, prompt size fields on `realtime_reply_requested` |
| Empty ASR / repeated activity opens | `voice_activity_started.promotionReason`, `voice_realtime_transcription_empty`, `openai_realtime_asr_bridge_empty_dropped` | `voice_turn_dropped_provisional_capture` |
| Screen watch fell back to link | `voice_screen_watch_capability`, `screen_watch_native_start_failed`, `clankvox_*` video chain | `native_discord_video_decode_failed`, DAVE decrypt events |
| Text tool call broke | `llm_call.metadata.toolCallCount`, `toolNames`, `event=reply_tool_loop:<n>`, `reply_tool_concurrent_failure:*` | `reply_tool_availability`, tool-specific events such as `browser_browse_failed`, search/memory/browser sources |
| Voice tool call broke | `voice_brain_tool_call` / `realtime_tool_call_failed` with `metadata.error`, `toolResultSummary` | `voice_screen_watch_capability` / provider-native ownership metadata to confirm the tool was even exposed |
| LLM returned tokens but no parsed reply | `llm_call.responseShape`, `rawContentSummary`, `responseDiagnostics` | `invalid_structured_output` events |
| OpenAI streamed a tool but final output was empty | `responseDiagnostics.streamFunctionArgumentDeltaEventCount`, `streamFunctionCallDraftCount`, `streamRecoveredToolCallCount` | `rawContentSummary.functionCallCount`, tool-loop events, `invalid_structured_output` |
| Startup catchup oddity | `startup_catchup_begin`, `startup_catchup_channel_scanned`, `startup_catchup_complete` | per-channel admission events that follow |
| Code worker (swarm) stalled, never adopted, or spawned and exited | `swarm_worker_adoption_timeout`, `swarm_worker_exit`, `swarm_worker_log_attached`, `swarm_server_spawn_failed`, `swarm_server_spawn_fallback` | swarm-mcp instance row state via `swarm-deepdive`; pair with the worker's `cwd` / harness from the spawn payload |
| Bot misread or skipped an image / GIF / video attachment | `reply_tool_availability` (confirm `video_context` and/or `image_lookup` are in `includedTools`), `video_context_call`, `video_context_tool_result`, `video_context_error`, `video_context_dependency_status` | upstream media events on the trigger message, replyPipeline GIF/video branch, ffmpeg/yt-dlp dependency status |

## Cardinal rules

- **One incident per dive doc.** If the user asks about two unrelated issues, write two docs.
- **Cite, don't paraphrase.** Event names + metadata fields are the unit of evidence.
- **Read the canonical doc first.** `docs/operations/logging.md` already names the workflow for almost every common symptom — don't reinvent the query taxonomy.
- **Loki has 15–30s lag** after a session ends. For just-now incidents, hit the ndjson directly.
- **Don't fix in this skill.** Diagnose, write up, point at the broken file. Fix is a separate change so the dive document remains a standalone artifact.
