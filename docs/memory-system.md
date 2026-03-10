# Memory System

This document describes how the bot's memory works — how it learns, what it remembers, and how memories surface during conversation.

See also: `AGENTS.md` — Agent Autonomy section.

## Design Philosophy

Memory should feel like memory, not like a database the bot has to query. A human in a Discord server knows things about the people they talk to, remembers past conversations, and recalls relevant context without performing a lookup. The bot should work the same way.

**Three principles:**

- **The bot knows everyone in the room.** In voice, fact profiles for all participants are in context — not just the current speaker. In text, profiles are loaded for everyone in the recent conversation window. The bot can cross-reference: "James, you should ask Sarah about that — she's been learning Rust too."
- **Past conversations surface automatically.** Relevant prior conversations are retrieved by topic similarity at context assembly time, running in parallel with other I/O. The bot doesn't need to call a tool to access its own memory of what was said before.
- **The bot builds memory three ways.** Real-time writes for things it notices mid-conversation, session-end micro-reflection for things it missed in the moment, and daily reflection for big-picture patterns. Each layer catches what the others miss.

## Scope

The memory system has two persistence layers:

1. **Durable facts** (`memory_facts`, `memory_fact_vectors_native`): the bot's long-term knowledge base — things it knows about people, the server, itself, and how it should behave. This includes behavioral guidance stored as `guidance` and `behavioral` facts with contextual retrieval.
2. **Conversation history** (`messages` table): saved text chat, voice transcripts, and bot replies. Auto-retrieved by topic relevance at context assembly time. `conversation_search` tool remains available for deeper or broader lookups.

Supporting infrastructure:
- **Daily journals** (`memory/YYYY-MM-DD.md`): append-only logs of all ingested text and transcripts. Raw material consumed by reflection.
- **Snapshot** (`memory/MEMORY.md`): periodically regenerated markdown for operator/dashboard inspection — not consumed by the model.

## Flow Diagram

![Memory System Flow](diagrams/memory-system-flow.png)
<!-- source: docs/diagrams/memory-system-flow.mmd -->

## How Memory Is Created

Three complementary paths, each catching what the others miss:

### Real-time writes (`memory_write` tool)

The brain notices something important mid-conversation and stores it immediately. The agent decides what matters — no hardcoded extraction rules.

- Accepts `namespace` (speaker/guild/self) and `items` array with `text` and optional `type`.
- `namespace = "speaker"` / `user:<id>` → stored under that user's Discord ID.
- `namespace = "guild"` → stored under `__lore__`.
- `namespace = "self"` → stored under `__self__`.
- `items[].type`: `preference`, `profile`, `relationship`, `project`, `guidance`, `behavioral`, or `other`.
- All scopes: `confidence = 0.72`, grounding check, instruction-injection rejection.
- Execution path: tool call → memory fact write path → `store.addMemoryFact()` → async embedding → archive aged facts → markdown refresh.
- In voice: the affected user's cached profile is refreshed immediately so the next turn sees the new fact.
- In voice: prefer session-scoped `note_context` for facts that only need to stay available for the rest of the conversation. Reserve `memory_write` for explicit "remember this" requests or obviously durable facts.

**Strengths:** Immediate. Agent-driven. **Gap:** Spotty in fast-moving voice sessions — the model is focused on responding, not archiving.

### Session-end micro-reflection

When a voice session ends or a text conversation goes quiet, a lightweight reflection pass reviews just that conversation: "anything worth remembering from the last 30 minutes?"

This closes the gap between real-time writes (spotty) and daily reflection (too late). Someone mentions their birthday at 10am — micro-reflection catches it at the end of the voice session, not 14 hours later at the daily reflection run.

- Triggers on voice session end event, or after sustained text silence in a channel.
- Scoped to just that conversation's journal entries, not the full day.
- Text-channel silence reflection is scheduled from human-authored messages and reflects on human-authored turns only, so the bot does not canonize its own prose into durable memory.
- Same fact write path as `memory_write` — same grounding checks, dedup, archiving.
- Lightweight: short context, fast model, capped output.

**Strengths:** Catches what the real-time path missed, while context is still fresh. **Gap:** Doesn't see full-day patterns.

### Daily reflection

An LLM reviews the full day's journal and distills it into durable facts. The bridge between raw logs and long-term memory.

1. Job triggers at the configured time (default: end of day).
2. Reads `memory/YYYY-MM-DD.md`.
3. Reflection prompt: "Review this day's conversations. Extract durable facts — things about people, ongoing projects, important events, preferences, recurring topics. Ignore throwaway chatter."
4. LLM returns structured facts with scope and subject attribution. Reflection output uses strict JSON schema validation; every declared field is required, and non-author facts use `subjectName: ""` rather than omitting the field.
5. Written through the same memory fact write path — same grounding checks, dedup, archiving.
6. Journals marked as processed. Retained indefinitely.

The reflection prompt includes existing durable facts for all subjects mentioned in the journal. This lets the model skip facts that already exist and merge near-duplicates with different wording into the best version. Combined with the database-level `UNIQUE` constraint and the agent seeing its own memory during conversation, this forms a three-layer dedup system.

With micro-reflection handling heavy voice sessions at session-end, daily reflection mostly processes text chat and cross-session patterns — the load is distributed rather than one massive batch.

**Strengths:** Sees patterns across the full day. Catches recurring themes the moment-by-moment paths miss. Consolidates semantic duplicates. **Gap:** 24-hour delay (mitigated by micro-reflection).

## How Memory Is Surfaced

### Everyone in the room (fact profiles)

Fact profiles are loaded for **all participants**, not just the current speaker. The bot knows things about everyone it's talking to simultaneously.

**Voice:**
- When a user joins, their fact profile is loaded and cached on `session.factProfiles[userId]`.
- When a user leaves, their profile is removed.
- On every generation turn, all participants' facts are included in the prompt.
- The current speaker gets full facts. Other participants get a compact summary of key facts.
- Lore (`__lore__`) and self-facts (`__self__`) are loaded at session start and refreshed on `memory_write`.
- Behavioral facts are cached as a session-scoped fact pool keyed by the active participant set. Spoken generation reranks that pool with the normal hybrid semantic+lexical scoring path, reusing cached fact vectors instead of refetching the pool every turn, and `memory_write` invalidates the pool.
- Conversation-history retrieval keeps short per-session caches per retrieval mode. Same-topic follow-ups reuse recent results, and low-signal backchannels reuse the freshest cached history or skip retrieval entirely instead of re-querying memory.
- Voice also has a session-scoped scratchpad via `note_context`. This keeps short-term plans/preferences/relationships live without promoting them to durable memory mid-conversation. The runtime may keep more notes than the prompt shows; prompts include a recent prompt-safe subset rather than dumping the full scratchpad every turn.

**Text:**
- Fact profiles are loaded for everyone who appears in the recent message window, not just the message author.
- Loading is SQLite-only, sub-millisecond per user. 3-5 profiles in parallel adds nothing to latency.

**Prompt structure:**
```
People in this conversation:

James (current speaker):
  - Loves Rust, works at Acme Corp, plays Elden Ring
  - Prefers concise replies

Sarah:
  - Into indie games, learning Rust, birthday March 15

Mike:
  - Streams on Twitch, competitive FPS player
```

The model sees people, not "current speaker" vs "others." It can cross-reference naturally.

### Relevant past conversations (auto-retrieved)

Past conversations are retrieved by topic similarity at context assembly time, without the model calling a tool. This runs in parallel with fact profile loading and other I/O.

- Conversation windows are embedded at storage time (async, background).
- At context assembly, meaningful current messages/transcripts are embedded (~50-100ms) and matched against stored windows via vector similarity.
- Top 2-3 relevant past conversations are included in the prompt.
- Low-signal follow-ups like backchannels do not force a fresh semantic lookup every turn; the bot reuses recent same-topic recall when it already has it.

The model references past conversations naturally, like genuine recall: "Oh yeah, we talked about that last week" — not "let me search my history."

### Fallback tools

Text and automation runs keep `memory_search` and `conversation_search` as fallback tools for cases the auto-retrieval doesn't cover:
- Cross-subject queries ("what do I know about Rust?" across all users)
- Deeper lookups beyond the auto-retrieval's top-k
- Broader time ranges or guild-wide conversation search

Voice keeps `conversation_search` for "what did we say earlier?" style recall, but does not expose `memory_search` as a live tool. Same-session continuity should come from the auto-retrieved context plus `note_context`, not a manual durable-memory search on every spoken turn.

These are fallbacks, not primary access paths. The model shouldn't need to search its own memory for the common case.

## Data Model

### `memory_facts` (durable facts)

- `guild_id` (required): primary scope boundary. Facts never cross guild boundaries.
- `channel_id` (optional): retrieval bias, not hard partitioning.
- `subject` (required): user ID, `__lore__`, or `__self__`.
- `fact`, `fact_type`, `evidence_text`, `source_message_id`, `confidence`.
- `is_active`: soft archive flag (archiving is soft delete, not hard).
- `UNIQUE(guild_id, subject, fact)`: dedup/upsert key.

### `memory_fact_vectors_native` (semantic vectors)

- Primary key: `(fact_id, model)`.
- Float32 blob, queried with sqlite-vec cosine similarity.

### Fact types

| Type | Tier | Description | Examples |
|------|------|-------------|----------|
| `profile` | Core | Identity-level, rarely changes | Name, birthday, occupation, timezone |
| `relationship` | Core | Connections between people | Family members, close friends, work relationships |
| `preference` | Contextual | Likes, dislikes, habits | "Prefers short replies", "Likes Rust" |
| `project` | Contextual | Ongoing work, activities | "Building a Discord bot", "Playing Elden Ring" |
| `guidance` | Behavioral | Standing style/tone instructions | "Keep responses brief", "Use casual tone in #general" |
| `behavioral` | Behavioral | Trigger/action rules from the community | "Send a GIF when Tiny Conk says 'what the heli'", "Always greet James in Spanish" |
| `other` | Contextual | Everything else | Lore, observations, miscellaneous |

### Tiered storage and retrieval

Facts are classified into three tiers that control eviction and retrieval:

**Core facts** — identity-level, rarely change:
- Types: `profile`, `relationship`.
- Evicted last. Consolidation pass merges/compresses when tier fills.
- Cap: 35 per user subject.
- Retrieval: always loaded for all participants in the conversation.

**Contextual facts** — situational, expected to rotate:
- Types: `preference`, `project`, `other`.
- FIFO eviction by `updated_at`.
- Cap: remaining budget after core facts (e.g., 85 contextual if 35 core out of 120 total).
- Retrieval: always loaded for all participants in the conversation.

Lore is stored under the special subject `__lore__`, not as a separate fact type.

**Behavioral facts** — standing instructions about how to act:
- Types: `guidance`, `behavioral`.
- `guidance` facts are always included in the prompt (light, few of them — style/tone context the bot reasons about on every turn).
- `behavioral` facts are contextually retrieved — only included when the current turn's content is relevant (prevents bloating every prompt with trigger/action rules).
- In voice sessions, the bot loads the scoped behavioral fact pool once, reranks it locally against each transcript, and refreshes that pool on `memory_write` or participant-set changes.
- Subject scoping: `__lore__` for server-wide behavioral rules, user ID for per-person rules.
- FIFO eviction, same as contextual.

Behavioral guidance is stored, retrieved, and reasoned about the same way as any other fact. The bot doesn't distinguish between "facts about people" and "rules for how to act." It just knows things and acts accordingly.

**Per-subject total cap:** 120 facts. Enough to hold a real relationship's worth of knowledge about someone you talk to regularly.

**Eviction order** (`archiveOldFactsForSubject`):
1. Archive contextual and behavioral facts beyond cap (oldest first).
2. Only if contextual/behavioral within budget AND total exceeds subject cap, archive core facts.
3. Core facts are never archived to make room for other tiers.

## Safety Guards

Facts are filtered at write time:

- Input normalization and length bounds.
- Fact type normalization (`preference|profile|relationship|project|guidance|behavioral|other`).
- Instruction/prompt-injection rejection (rejects `system`, `developer`, `ignore previous`, secrets, etc.).
- Grounding requirement: exact substring match or ~45% token-overlap threshold.
- If embedding fails, fact is still stored; embedding backfill happens on next retrieval.

## Embeddings

Used for semantic ranking in `memory_search`, conversation retrieval, and dashboard search.

- Query embedding: `llm.embedText(...)` when query length >= 3.
- Fact embedding payload: `type` + `fact` + optional `evidence`.
- Model resolution: `settings.memory.embeddingModel` → `DEFAULT_MEMORY_EMBEDDING_MODEL` env → `"text-embedding-3-small"`.
- Missing vectors are backfilled (up to 8 per query).
- Fact embeddings generated at write time. Conversation window embeddings generated at storage time.

### Hybrid score formula (for `searchDurableFacts`)

Candidate generation happens in three lanes before ranking:
- Semantic lane: vector search over stored fact embeddings within the scoped subject/type filter.
- Lexical lane: token/phrase match search over fact text and evidence.
- Recent fallback lane: a small recent scoped slice so continuity still works when embeddings are unavailable or the query is too weak.

The merged candidate set is then reranked with the hybrid score below.

Per candidate:
- `lexicalScore`: token overlap / substring match.
- `semanticScore`: cosine similarity from sqlite-vec.
- `confidenceScore`: stored confidence.
- `recencyScore`: `1 / (1 + ageDays / 45)`.
- `channelScore`: 1 (same channel), 0.25 (no channel), 0 (different channel).

Combined: `0.50 * semantic + 0.28 * lexical + 0.10 * confidence + 0.07 * recency + 0.05 * channel` (with fallback weights when semantic is unavailable).

Relevance gate filters low-quality matches.

## Unified Memory Model

Everything the bot knows lives in `memory_facts`. There is no separate store for behavioral instructions — they're facts with a behavioral type and contextual retrieval.

| What the bot knows | Stored as | Example |
|----|----|-----|
| Facts about people | `profile`, `relationship`, `preference` facts | "James likes Nvidia" |
| What happened before | `messages` table (conversation history) | "Two days ago we talked about NVDA at $181" |
| How to behave | `guidance` and `behavioral` facts | "Use 'type shit' occasionally", "Greet James in Spanish" |
| Server context | `other` facts under the `__lore__` subject | "This server is focused on game dev" |
| Self-knowledge | `__self__` subject facts | "I prefer concise replies" |

A human doesn't have separate mental stores for "what I know" and "how I should act." The bot shouldn't either. When someone says "hey, from now on always greet me in Spanish," the bot stores that as a behavioral fact about that person. It sees the fact in context and acts on it — same as any other fact.

### Behavioral retrieval

- `guidance` facts are always included in prompt context
- `behavioral` facts are retrieved by relevance when the current turn matches

This is a retrieval strategy on fact types within the same memory store.

## Message Ingest Pipeline

### Text chat

Both incoming user messages and outgoing bot replies are journaled when `memory.enabled` is true:

1. `ClankerBot.handleMessage()` → `memory.ingestMessage(...)` for user messages.
2. Reply pipeline, automation engine, initiative engine → `memory.ingestMessage(...)` for bot output.
3. Jobs queued by `messageId`, deduped, max queue 400.
4. Worker appends one line to `memory/YYYY-MM-DD.md`.

`processIngestMessage` does NOT perform automatic fact extraction. Durable facts come from `memory_write`, micro-reflection, or daily reflection.

Journal entries are capped at 640 characters — long enough to preserve a full thought or explanation without truncating nuance.

### Voice transcripts

Both sides captured via synthetic message IDs:
- User speech: `queueVoiceMemoryIngest()` for transcripts from realtime bridge and file-ASR.
- Bot replies: `persistAssistantVoiceTimelineTurn()`.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `memory.enabled` | `true` | Master switch for journaling, fact retrieval, and writes |
| `memory.embeddingModel` | `"text-embedding-3-small"` | Model for fact and conversation embeddings |
| `memory.promptSlice.maxRecentMessages` | `35` | Short-term chat context window size |
| `memory.reflection.enabled` | `true` | Daily reflection toggle |
| `memory.reflection.hour` / `minute` | end of day | Daily reflection schedule |
| `memory.reflection.maxFactsPerReflection` | `20` | Cap on facts per reflection run |
| `memoryLlm` | inherit | Optional override for reflection and memory-adjacent background work. The dashboard defaults this to inherit/on, and an empty object clears any explicit override back to the main text/orchestrator model. |

## APIs and Observability

Dashboard API:

- `GET /api/memory` — snapshot markdown.
- `POST /api/memory/refresh` — regenerate snapshot.
- `GET /api/memory/search?q=&guildId=&channelId=&limit=` — hybrid durable fact search.
- `GET /api/memory/fact-profile` — structured fact profile for guild/user.
- `GET /api/memory/facts` — list/filter raw facts.
- `GET /api/memory/subjects` — list subjects with fact counts.
- `GET /api/memory/reflections` — reflection run history.

Action log kinds: `memory_fact`, `memory_reflection_start`, `memory_reflection_complete`, `memory_reflection_error`, `memory_embedding_call`, `memory_embedding_error`, `memory_log_prune`.

## Key Files

| File | Purpose |
|------|---------|
| `src/memory/memoryManager.ts` | Ingestion, journaling, reflection, fact profiles, retrieval |
| `src/memory/memoryHelpers.ts` | Fact normalization, grounding checks, scoring |
| `src/memory/dailyReflection.ts` | End-of-day reflection logic |
| `src/store/store.ts` | `memory_facts` schema, query/update methods |
| `src/tools/replyTools.ts` | `memory_write`, `memory_search`, `conversation_search` text tools |
| `src/voice/voiceToolCallMemory.ts` | Voice `memory_write` and `conversation_search` handlers |
| `src/bot.ts` | Ingest triggers, reflection scheduling |
| `src/voice/voiceSessionManager.ts` | Voice transcript ingestion, session fact profile caching |
