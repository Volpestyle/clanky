# Memory System (Source of Truth)

This document describes how durable memory works in runtime, based on current code behavior.

## Scope

Durable memory has three layers:

1. **Daily journals** (`memory/YYYY-MM-DD.md`): append-only logs of every message and voice transcript. Raw material.
2. **Daily reflection**: an LLM pass that reviews each day's journal and distills it into durable facts. The bridge between raw logs and long-term memory.
3. **SQLite facts + vectors** (`memory_facts`, `memory_fact_vectors_native`): the durable knowledge base used by runtime retrieval and prompts.

Additionally, `memory/MEMORY.md` is a periodically regenerated snapshot for operator/dashboard inspection — not consumed by the model.

This is only the durable-fact memory system. Two adjacent persistence layers now sit beside it:

1. **Conversation history** (`messages` table): saved text chat, saved voice transcripts, and saved assistant spoken turns. Queried through `conversation_search` for “what did we say earlier?” continuity.
2. **Adaptive directives** (`adaptive_style_notes`, `adaptive_style_note_events`): persistent server-level instructions about how the bot should talk or act in future conversations. Queried separately from durable facts so style/behavior guidance does not pollute `memory_facts`.

## Flow Diagram

![Memory System Flow](diagrams/memory-system-flow.png)
<!-- source: docs/diagrams/memory-system-flow.mmd -->

## Key Files

- `src/memory.ts`: ingestion queue, daily journaling, daily reflection job, directive writes (`rememberDirectiveLine`), hybrid retrieval/ranking, markdown refresh.
- `src/memory/memoryHelpers.ts`: fact normalization, grounding checks, scoring helpers, directive scope config.
- `src/memory/dailyReflection.ts`: end-of-day reflection logic — reads daily journal, runs LLM distillation, writes durable facts.
- `src/store.ts`: `memory_facts` and `memory_fact_vectors_native` schema + query/update methods.
- `src/store/storeAdaptiveDirectives.ts`: adaptive directive storage, prompt-time retrieval, and audit-log helpers.
- `src/llm.ts`: embedding API calls, reflection LLM calls.
- `src/tools/replyTools.ts`: `memory_write` and `memory_search` tool definitions + execution handlers (used by text chat brain).
- `src/voice/voiceToolCalls.ts`: `memory_search`, `memory_write`, and adaptive-directive voice tool definitions + execution handlers (used by OpenAI Realtime brain).
- `src/bot.ts`: message ingest trigger, memory slice loading, reflection job scheduling.
- `src/bot/voiceReplies.ts` and `src/voice/voiceSessionManager.ts`: voice transcript ingestion + memory context loading.
- `src/dashboard.ts`: `/api/memory`, `/api/memory/refresh`, `/api/memory/search`.

## Data Model

### `memory_facts` (durable facts)

Created in `Store.init()` (`src/store.ts`) with key fields:

- `guild_id` (required): primary scope boundary.
- `channel_id` (optional): retrieval bias, not hard partitioning.
- `subject` (required): user ID for user facts, `__lore__` for lore facts, or `__self__` for durable bot self-memory.
- `fact`, `fact_type`, `evidence_text`, `source_message_id`, `confidence`.
- `is_active`: soft archive flag.
- `UNIQUE(guild_id, subject, fact)`: dedup/upsert key.

### `memory_fact_vectors_native` (semantic vectors)

- Primary key: `(fact_id, model)`.
- Stores `dims` and `embedding_blob` (Float32 blob).
- Queried with sqlite-vec cosine similarity (`1 - vec_distance_cosine(...)`).

## Runtime Lifecycle

### Startup and periodic maintenance

- `src/app.ts` initializes `MemoryManager` and calls `refreshMemoryMarkdown()` once at startup.
- `src/bot.ts` starts a 5-minute timer calling `refreshMemoryMarkdown()`.
- `src/bot.ts` starts the daily reflection scheduler (checks if reflection is due on each tick).
- On shutdown, bot drains pending ingest jobs (`drainIngestQueue`) before exit.

### Message ingest pipeline (text chat)

Triggered in `ClankerBot.handleMessage()` when `settings.memory.enabled` is true:

1. `memory.ingestMessage(...)` queues a job keyed by `messageId`.
2. Queue behavior:
   - Dedupes concurrent same-message jobs by returning one shared promise.
   - Max queue length is `400`; overflow drops the oldest job and resolves it as `false`.
3. Worker runs `processIngestMessage(...)` sequentially:
   - Cleans content (trim/collapse, max 320 chars; empty/too short dropped).
   - Appends one line to `memory/YYYY-MM-DD.md`.
   - Schedules markdown refresh (`queueMemoryRefresh`, debounced by `pendingWrite` + 1s delay).

Note: `processIngestMessage` does **not** perform automatic fact extraction. Durable facts are only created through explicit `memory_write` tool calls (see below).

### Message ingest pipeline (voice transcripts)

Voice paths also feed durable memory using synthetic message IDs:

- `src/bot/voiceReplies.ts`: STT transcript ingest for voice turn generation.
- `src/voice/voiceSessionManager.ts`: realtime transcript ingest for realtime instruction context.

Both call `memory.ingestMessage(...)` with `trace.source` indicating voice pipeline origin.

### Daily reflection

The reflection job is the bridge between raw journal logs and durable memory. It runs once per day (configurable) and reviews the day's journal to decide what's worth remembering long-term.

**How it works:**

1. Job triggers at the configured time (default: end of day, or on a configurable interval).
2. Reads the current day's journal file (`memory/YYYY-MM-DD.md`).
3. Sends the full journal to an LLM with a reflection prompt: "Review this day's conversations. Extract durable facts worth remembering — things about people, ongoing projects, important events, preferences, and recurring topics. Ignore throwaway chatter, greetings, and ephemeral requests."
4. LLM returns structured facts with scope (user/lore/self) and subject attribution.
5. Each fact is written through the same `rememberDirectiveLine` path as `memory_write` tool calls — same grounding checks, same dedup, same archiving.
6. Reflected journals are marked as processed. Journals older than `memory.dailyLogRetentionDays` are pruned.

**Why reflection exists alongside `memory_write`:**

Two complementary paths to durable memory:

- **`memory_write` (real-time)**: the brain notices something important mid-conversation and stores it immediately. Fast, but depends on the brain's in-the-moment judgment — things slip through, especially in fast-moving voice sessions.
- **Daily reflection (batch)**: reviews the full day with hindsight. Catches patterns, repeated topics, and facts the brain didn't think to store in real time. Sees the forest, not just the trees.

Both paths produce the same kind of durable facts in `memory_facts`. Reflection just has better context for deciding what matters.

**Settings:**

- `memory.enabled` (default `true`): master switch for durable memory journaling and fact retrieval/write behavior.
- `memory.reflection.enabled` (default `true`): master switch.
- `memory.reflection.hour` / `memory.reflection.minute`: daily reflection schedule time.
- `memory.reflection.maxFactsPerReflection`: cap on facts produced per run (default `20`).
- `memory.dailyLogRetentionDays` (default `30`): prune journals older than this after reflection.
- `adaptiveDirectives.enabled` (default `true`): independently enables/disables adaptive directive retrieval and conversational directive save/remove behavior.
- `automations.enabled` (default `true`): independently enables/disables recurring automation control plus scheduled execution.

### Fact creation via `memory_write` tool

Durable facts are created when the brain decides to call the `memory_write` tool during conversation. This replaces the previous `memoryLine`/`selfMemoryLine` JSON directive fields.

**Tool definition** (`src/tools/replyTools.ts`): accepts an `items` array, each with `text` and `scope`:

- `scope = "lore"` → stored under subject `__lore__`, prefix `"Memory line"`, `fact_type = "lore"`, keep latest 120.
- `scope = "self"` → stored under subject `__self__`, prefix `"Self memory"`, `fact_type = "self"`, keep latest 120.
- `scope = "user"` → stored under the speaker's user ID as subject, prefix `"User memory"`, `fact_type = "preference"`, keep latest 80.

All scopes share: `confidence = 0.72`, grounding check against source text, instruction-like text rejection.

**Execution path**: tool call → `executeMemoryWrite()` in `replyTools.ts` → `memory.rememberDirectiveLine({ line, scope, subjectOverride, ... })` → `store.addMemoryFact(...)` → async embedding → archive old facts → markdown refresh.

**Scope config** is resolved by `resolveDirectiveScopeConfig()` in `memoryHelpers.ts`.

This path is used in both text chat (via `replyTools.ts`) and voice chat (via `voiceToolCalls.ts`), where equivalent `memory_write` and `memory_search` tools are registered as OpenAI Realtime function tools.

## Safety Guards

Facts written through `memory_write` are filtered in `memory.rememberDirectiveLine()` and `memoryHelpers.ts`:

- Input normalization and length bounds (`normalizeMemoryLineInput`).
- Fact type normalization (`preference|profile|relationship|project|other`; `general` collapses to `other`).
- Instruction/prompt-injection-like text rejection (`isInstructionLikeFactText` — rejects `system`, `developer`, `ignore previous`, secrets, etc.).
- Grounding requirement (`isTextGroundedInSource`):
  - Exact compact-substring pass, or
  - token-overlap threshold (about 45% minimum, with short-line special case).

If embedding fails, errors are logged and the fact is still stored (embedding backfill happens on next retrieval query).

## Embeddings

Embeddings are used only for semantic ranking of facts:

- Query embedding: `llm.embedText(...)` when query length >= 3 and OpenAI client exists.
- Fact embedding payload includes `type`, `fact`, and optional `evidence`.
- Model resolution order:
  1. `settings.memory.embeddingModel`
  2. `appConfig.defaultMemoryEmbeddingModel` (`DEFAULT_MEMORY_EMBEDDING_MODEL` env)
  3. fallback `"text-embedding-3-small"`

If vectors are missing for some candidates, retrieval backfills up to 8 missing fact vectors per query.

## Retrieval and Ranking

### Prompt slice retrieval (`buildPromptMemorySlice`)

For normal response generation:

- `userFacts`: hybrid select for subject `[userId]`, limit 8.
- `relevantFacts`: hybrid select for subjects `[userId, "__self__", "__lore__"]`, limit 10.
- `relevantMessages`: lexical search from `messages` table in current channel (limit 8).

Primary consumers of this slice:

- Text replies (`src/bot.ts`, `maybeReplyToMessage` path)
- Automation runs (`src/bot.ts`, automation generation path)
- Discovery generation (`src/bot.ts`, discovery post path)
- Voice turn generation/realtime voice context (`src/bot/voiceReplies.ts`, `src/voice/voiceSessionManager.ts`)

### Search API retrieval (`searchDurableFacts`)

For dashboard and model-triggered memory lookup:

- Pulls guild-scoped active facts (`getFactsForScope`).
- Hybrid ranking with strict relevance gate enabled.
- Returns top N (limit clamped to 1..24).

### Hybrid score formula

Per candidate:

- `lexicalScore`: token overlap / substring match on fact + evidence text.
- `semanticScore`: cosine similarity from sqlite-vec.
- `confidenceScore`: stored confidence.
- `recencyScore`: `1 / (1 + ageDays / 45)`.
- `channelScore`:
  - `1` same channel,
  - `0.25` fact has no channel_id,
  - `0` different channel.

Combined score:

- If semantic available:
  - `0.50 * semantic + 0.28 * lexical + 0.10 * confidence + 0.07 * recency + 0.05 * channel`
- If semantic unavailable:
  - `0.75 * lexical + 0.10 * confidence + 0.10 * recency + 0.05 * channel`

Relevance gate:

- With semantic: pass if semantic/lexical minimums are met, or strong combined score with minimum signal.
- Without semantic: requires lexical >= 0.24 or combined >= 0.62.
- Strict mode (`searchDurableFacts`) returns no hits if all candidates fail gate.

## Adaptive Directives vs Durable Memory

Adaptive directives are intentionally not stored in `memory_facts`.

- `memory_facts`: durable facts about users, the bot, or guild lore
- `messages`: prior text/voice conversation history
- `adaptive_style_notes`: persistent instructions about how the bot should talk or act later

Examples:
- Durable memory: `James likes Nvidia.`
- Conversation history: `Two days ago we talked about NVDA being around $181.`
- Adaptive directive: `Use "type shit" occasionally in casual replies.` or `Send a GIF to Tiny Conk whenever they say "what the heli."`

Adaptive directives are split into:
- `guidance`: broad style/tone/persona/operating guidance, which can stay lightly active across turns
- `behavior`: recurring trigger/action behavior, which is retrieved into prompt context only when the current turn appears relevant

That retrieval split is what keeps behavior directives useful without bloating every prompt with every saved action rule.

## Markdown Files in `memory/`

### Daily logs: `memory/YYYY-MM-DD.md`

- Append-only journal lines: timestamp, author, and scoped message text.
- Header is initialized once per day/file.
- Consumed by the daily reflection job to produce durable facts.
- Pruned after `memory.dailyLogRetentionDays` (default 30 days) once reflection has processed them.

### Snapshot: `memory/MEMORY.md`

Generated by `refreshMemoryMarkdown()` with sections:

- People (durable facts by subject)
- Bot self memory (subject `__self__`)
- Ongoing lore (subject `__lore__`)
- Recent journal highlights
- Source daily logs

Used for dashboard/operator inspection, not direct model context.

## Settings and Controls

From defaults + normalization:

- `memory.enabled` (default `true`)
- `memory.maxRecentMessages` (default `35`, clamped `10..120`)
  Note: this controls short-term chat context windows, not durable fact count.
- `memory.embeddingModel` (default `"text-embedding-3-small"`)
- `memory.reflection.enabled` (default `true`): enable/disable daily reflection.
- `memory.reflection.hour` / `memory.reflection.minute`: daily reflection schedule time.
- `memory.reflection.maxFactsPerReflection` (default `20`): cap on facts per reflection run.
- `memory.dailyLogRetentionDays` (default `30`): prune reflected journals older than this.
- `adaptiveDirectives.enabled` (default `true`): toggle adaptive directive retrieval/write behavior separately from durable memory.
- `automations.enabled` (default `true`): toggle recurring automation control and scheduler execution separately from durable memory.
- `memoryLlm` provider/model config controls the model used for reflection and tool-triggered operations.

## APIs and Observability

Dashboard API:

- `GET /api/memory`: returns snapshot markdown content.
- `POST /api/memory/refresh`: regenerates and returns snapshot.
- `GET /api/memory/search?q=...&guildId=...&channelId=...&limit=...`: hybrid durable fact search.
- `POST /api/memory/simulate-slice`: preview `buildPromptMemorySlice(...)` output (`userFacts`, `relevantFacts`, `relevantMessages`) for a `guildId` + `queryText` request body.

Action log kinds used by memory pipeline:

- `memory_fact`
- `memory_reflection_call`, `memory_reflection_error`
- `memory_embedding_call`, `memory_embedding_error`
- `memory_log_prune`
- plus `bot_error`/`voice_error` entries for pipeline failures.

## Practical Notes

- Durable memory is always guild-scoped. Facts never cross guild boundaries.
- Channel scope is a ranking hint, not a hard filter.
- Archiving is soft (`is_active = 0`), not hard delete.
- The canonical source for runtime memory behavior is `src/memory.ts` + `src/store.ts`; docs should be updated if those files change.
