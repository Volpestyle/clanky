# Memory System Review

Status: historical review from before owner-private dashboard parity and some later memory/runtime refinements. Use [`../capabilities/memory.md`](../capabilities/memory.md) for current shipped behavior.

Deep review of Clanky's memory system: current state, how it compares to OpenClaw, dashboard visibility, cross-modal behavior, and recommended path forward.

See also:

- [`../capabilities/memory.md`](../capabilities/memory.md)
- [`owner-private-memory-plan.md`](owner-private-memory-plan.md)
- [`owner-assistant-gap-plan.md`](owner-assistant-gap-plan.md)

## Current architecture

### Storage

SQLite-backed structured fact store with three tables:

- `memory_facts` — durable fact tuples with scope, subject, fact type, confidence, evidence, and soft-delete
- `memory_fact_vectors_native` — embedding vectors for semantic search (sqlite-vec cosine distance)
- `messages` / `message_vectors_native` — conversation history with embeddings

Supporting artifacts:

- `memory/YYYY-MM-DD.md` — append-only raw daily journals
- `memory/MEMORY.md` — generated operator-facing snapshot (not runtime source of truth)

### Memory scopes

Three scopes exist in the schema today:

| Scope | Purpose | guild_id | user_id | Typical subjects |
|-------|---------|----------|---------|-----------------|
| `user` | Person-portable facts that follow across guilds and DMs | NULL | person's Discord ID | User IDs, `__self__` |
| `guild` | Server-specific community context | guild ID | NULL | `__lore__`, `__self__`, user IDs |
| `owner` | Private assistant memory for the bot operator | NULL | owner user ID | `__owner__` |

The `owner` scope exists in the schema and write path but is not yet gated in retrieval or surfaced in the dashboard.

### Fact types

| Type | Use |
|------|-----|
| `profile` | Stable identity facts |
| `relationship` | Important links between people |
| `preference` | Tastes, habits, recurring likes/dislikes |
| `project` | Ongoing work and active efforts |
| `guidance` | Standing style/tone guidance (always loaded, exempt from temporal decay) |
| `behavioral` | Contextual behavior rules (loaded selectively when relevant, exempt from decay) |
| `other` | Lore, observations, and facts that do not fit the above |

### Retrieval pipeline

Hybrid three-channel retrieval:

1. **Recent candidates** — newest facts by `updated_at`
2. **Lexical candidates** — SQL LIKE scoring on fact text, evidence, subject, and fact_type tokens
3. **Semantic candidates** — cosine similarity via sqlite-vec

Merged, deduplicated, then ranked:

```
combined = 0.50 * semantic + 0.28 * lexical + 0.10 * confidence + 0.07 * recency + 0.05 * channel
```

Post-processing:

- Temporal decay (90-day half-life, min multiplier 0.2; guidance and behavioral exempt)
- Relevance gate filtering (minimum score thresholds)
- MMR diversity re-ranking (lambda 0.7)

## How memory is created

Three complementary paths:

### Real-time tool writes

The agent calls `memory_write` during conversation. Purely model-driven — no hardcoded triggers. The system prompt provides soft guidance: "Store long-lived useful facts or standing guidance, never secrets or chatter." The agent decides when something is worth persisting.

### Session-end micro-reflection

- **Text**: fires after 10 minutes of silence or when context pressure nears truncation
- **Voice**: fires at session end

Sends a bounded conversation excerpt to an LLM for structured fact extraction. Catches facts the agent did not explicitly save during conversation. Especially important in voice, where the model is focused on responding rather than filing memory in real time.

### Daily reflection

Scheduled batch process (default 4:00 AM). Reads daily journal files, reflects per guild, extracts up to 20 facts per guild per run. Handles supersession and dedup against existing facts.

### Safety filters on all write paths

- Normalized input and length bounds
- Rejection of prompt-injection and unsafe instruction text
- Behavioral directive detection (rejected unless fact type is explicitly guidance/behavioral)
- Semantic deduplication (threshold 0.9)
- Soft archival instead of destructive deletion when rotating old facts

## How memory is surfaced

### Automatic prompt injection (every reply turn)

Memory appears in three dedicated prompt sections on every text and voice reply:

1. **People in this conversation** — participant fact profiles (primary speaker: up to 12 facts, secondary: up to 6), self facts (up to 10), lore facts (up to 10)
2. **Behavior guidance** — standing guidance facts (up to 24)
3. **Relevant behavioral memory** — situationally-matched behavioral facts (up to 8), retrieved via semantic search against the current message

Conversation history windows are also loaded via semantic search and injected as "Recent conversation continuity."

This makes memory feel like natural recall. The agent sees relevant facts as context without needing to manually search.

### Fallback tools

- `memory_search` — explicit search of durable facts with namespace/scope targeting
- `conversation_search` — broader transcript/history lookup

These are fallback tools, not the primary access path.

## How memory works in voice

### Voice-specific optimizations

**Warm memory system** (`voiceSessionWarmMemory.ts`):

- Exponential moving average of turn embeddings creates a topic fingerprint
- Cosine similarity detects topic drift: >= 0.85 reuse warm snapshot, < 0.65 full retrieval
- Warm snapshots expire after 5 minutes
- Avoids redundant retrieval on same-topic back-and-forth

**Session-level caching** (`voiceSessionMemoryCache.ts`):

- Behavioral fact pool (up to 64 facts) cached per guild + participant set, re-ranked lexically on each query
- Conversation history cache (45-second TTL) with token-level Jaccard similarity for reuse
- Low-signal turns ("yeah", "ok", "mhm") reuse cached results without re-querying

**Context compaction** (`voiceContextCompaction.ts`):

- Keeps the 50 most recent turns verbatim
- Older turns batched (10 at a time) and summarized by LLM into a rolling summary (max 1,200 chars)
- Summary replaces raw turns in subsequent prompts
- Priority order for compaction: speaker attribution > current activity > open threads > decisions/commitments > screen-watch context
- Compacted summary is ephemeral — lost when the session ends

**Per-turn memory ingest**:

- Every transcribed user turn is ingested via `memory.ingestMessage()` (same pipeline as text)
- Bot voice replies are also recorded to the message store and ingested
- Both become searchable in conversation history

**Post-session extraction**:

- Micro-reflection runs at session end on speech-only turns
- Voice sessions can use `memory_write` tool during conversation (rate-limited to 5/min)

## Cross-modal context

### What persists across voice and text

- Individual messages — voice turns are recorded to the same message store that text uses
- Durable facts — extracted during or after voice sessions, stored in the same fact store
- Fact profiles — shared between both modalities
- Conversation search — finds both voice and text messages

### What does not persist

- Voice compaction summary — ephemeral, lost on session end
- Warm memory state — in-memory only, per session
- Session transcript timeline — the raw `transcriptTurns` array is not persisted in full

## Dashboard memory visibility

### Sub-tabs

| Tab | Purpose |
|-----|---------|
| **Runtime Snapshot** | Simulate what memory slice the bot would assemble for a given turn (text or voice mode, specific user, channel, query) |
| **Summary** | Generated markdown snapshot of all durable memory |
| **Inspector** | Full CRUD on individual facts — edit subject, type, confidence, text, evidence; delete; filter by subject and text |
| **Profiles** | Structured fact profile view by user + guild |
| **Reflections** | Audit trail of daily reflection runs with extracted facts |
| **Search** | Semantic/hybrid search across durable facts |

### CRUD support

- **Read**: all views support scoped reading with filtering
- **Update**: Inspector allows inline editing of all fact fields
- **Delete**: Individual fact deletion and full guild memory purge (with name confirmation)
- **Create**: No manual "add fact" UI — facts are created by the bot at runtime only

### What is not in the dashboard today

- Owner-private memory surface
- Voice session summary persistence/viewer
- Memory creation provenance chain (which reflection run or tool call created a fact)
- Cross-modal context bridging visibility

## Comparison to OpenClaw

### Storage philosophy

| | Clanky | OpenClaw |
|---|--------|----------|
| Format | Structured fact tuples in SQLite | Free-form Markdown files |
| Source of truth | Indexed SQLite store | Markdown on disk |
| Search index | sqlite-vec embeddings + LIKE scoring | SQLite FTS5 (BM25) + vector embeddings |
| Organization | scope / subject / fact_type | file path / date |

Clanky's structured approach enables richer retrieval (typed facts, confidence scores, evidence grounding, per-person profiles) but is less flexible for complex free-form context. OpenClaw's file-based approach is simpler and more natural for the agent to write, but lacks the retrieval sophistication.

### Memory creation

| | Clanky | OpenClaw |
|---|--------|----------|
| Agent writes | `memory_write` tool | Standard file `write`/`edit` tools |
| Auto-extraction | Micro-reflection + daily reflection | None (agent-only) |
| Pre-compaction flush | Not implemented | Silent agentic turn before compaction |
| Dedup | Semantic dedup (0.9 threshold) | Content hash dedup on pre-compaction flush |

OpenClaw's pre-compaction flush is a notable pattern: before context is compressed, the agent gets a silent turn to save anything important. Clanky has no equivalent for either text or voice compaction.

### Retrieval quality

| | Clanky | OpenClaw |
|---|--------|----------|
| Keyword search | SQL LIKE scoring | BM25 via FTS5 |
| Semantic search | sqlite-vec cosine | sqlite-vec cosine (or LanceDB, or QMD sidecar) |
| Temporal decay | 90-day half-life | 30-day half-life |
| Diversity | MMR (lambda 0.7) | MMR (lambda 0.7) |
| Citations | No | Source path#line citations |
| Multimodal | No | Gemini image/audio embedding search |
| Query expansion | No | Multilingual BM25 query expansion |

The most impactful difference is BM25 vs LIKE. BM25 is materially better for exact tokens, code symbols, error strings, proper nouns, and technical terms that LIKE scoring handles poorly.

### Context management

| | Clanky | OpenClaw |
|---|--------|----------|
| Voice compaction | Rolling summary of older turns | N/A (no voice) |
| Text compaction | None (truncation + micro-reflection) | Full auto-compaction with chunked summarization |
| Identifier preservation | No special handling | Strict preservation of UUIDs, hashes, URLs |
| Pluggable engines | No | Context engine plugin architecture |

### Social vs assistant memory

| | Clanky | OpenClaw |
|---|--------|----------|
| Multi-person profiles | Strong — per-participant fact budgets, relationship facts | None |
| Guild/community lore | Explicit lore subject and scope | N/A |
| Voice integration | Deep — warm memory, compaction, per-turn ingest | None |
| Private assistant depth | Weak — owner scope not fully wired | Strong — MEMORY.md, daily logs, DM-only loading |
| Dashboard inspection | Rich — runtime snapshot, inspector, profiles | CLI + file browsing |

### Where Clanky is stronger

- Social/multi-person memory (participant profiles, per-person fact budgets, guild lore)
- Voice integration (warm memory, topic drift, session caching, compaction)
- Dashboard inspection (runtime snapshot preview is excellent)
- Structured retrieval (fact types, confidence, evidence, explicit scopes)
- Automatic fact extraction (micro-reflection and daily reflection catch what the agent misses)

### Where OpenClaw is stronger

- Keyword search quality (BM25 vs LIKE)
- Pre-compaction memory flush
- Text compaction for long conversations
- Free-form memory representation
- Memory citations
- Pluggable context engine architecture
- Multimodal memory search
- Multilingual query expansion

## Review of planning docs

### owner-private-memory-plan.md

The plan is solid and well-scoped. Implementation status:

| Step | Status |
|------|--------|
| 1. Extend scope acceptance to include `owner` | Done |
| 2. Add canonical owner subject (`__owner__`) | Done |
| 3. Add store/query support for owner facts | Done |
| 4. Add owner-context gating primitive | Not done |
| 5. Add owner/private memory-write namespace resolution | Partially done (aliases wired, no context gating) |
| 6. Add owner retrieval path for owner-private contexts only | Not done |
| 7. Add dashboard Owner Private surface | Not done |
| 8. Add tests | Not done |
| 9. Update canonical docs | Not done |

Roughly 40% complete. The backend write path and schema are ready. The remaining work is retrieval gating, dashboard surface, and tests.

### owner-assistant-gap-plan.md

This is a roadmap document, not an implementation plan. The product thesis ("socially embedded on the outside, deeply integrated owner assistant on the inside") is strong and aligned with AGENTS.md.

The five gaps it identifies are all real:

- **Gap A**: Owner companion integration (biggest, most architectural)
- **Gap B**: Task/follow-through depth
- **Gap C**: Memory ownership lanes (owner-private-memory-plan is step one)
- **Gap D**: Permissions as first-class runtime model
- **Gap E**: Internal capability plumbing

For the memory system specifically, Gap C is the actionable item and the owner-private-memory-plan is the right first step.

## Gaps and recommendations

### 1. Cross-modal context bridging

**Priority**: High

**Gap**: When a voice session ends, the compacted summary is discarded. If someone was talking to Clanky in voice for 30 minutes about a project and then sends a text message 5 minutes later, the text pipeline only sees fragmented persisted messages and any durable facts from micro-reflection. The rolling summary — which was the richest representation of that conversation — is gone.

**Recommendation**: Persist the voice compaction summary as a "session summary" artifact when the session ends. Make it retrievable by the text pipeline as a context injection for the same channel within a configurable time window (suggest 30 minutes). This closes the most obvious cross-modal gap without requiring architectural changes.

**Implementation sketch**:

1. On session end, write `session.compactedContextSummary` to a new `session_summaries` table (or similar) with guild_id, channel_id, ended_at, summary text
2. In `buildReplyContext` for text, check for recent session summaries in the same channel
3. If found and within the time window, inject as a "Recent voice session context" prompt section
4. Let summaries expire naturally (auto-delete after 24 hours or similar)

### 2. BM25 full-text search

**Priority**: Medium-high

**Gap**: Clanky's lexical search uses SQL LIKE scoring against tokens. This is significantly weaker than BM25 for exact matches on code symbols, error strings, IDs, proper nouns, and technical terms.

**Recommendation**: Add an FTS5 virtual table for `memory_facts` and switch the lexical channel of the hybrid pipeline to BM25 scoring. SQLite already supports FTS5 natively. The hybrid ranking weights can stay the same — replace the LIKE scorer with BM25 scores.

**Implementation sketch**:

1. Create `memory_facts_fts` FTS5 virtual table on `(fact, evidence_text, subject)`
2. Add triggers or sync logic to keep it updated on insert/update/delete
3. Replace `searchMemoryFactsLexical` with a BM25-based query
4. Normalize BM25 scores to 0-1 range for compatibility with the hybrid ranking formula
5. Run comparative tests on retrieval quality

### 3. Pre-compaction memory flush for voice

**Priority**: Medium

**Gap**: Voice compaction summarizes old turns into a rolling summary but does not trigger a memory extraction pass before compacting. Turns compacted early in a long session may never get a dedicated reflection pass. The micro-reflection at session end only sees the final bounded conversation excerpt (max 80 entries, 9,000 chars), so early conversation content in a long session may be lost entirely.

**Recommendation**: Before compacting a batch of turns, run a lightweight fact extraction pass on those specific turns. This is OpenClaw's pre-compaction flush pattern adapted for voice.

**Implementation sketch**:

1. In `voiceContextCompaction.ts`, before summarizing a batch, call a focused mini-reflection on just those turns
2. Use a simpler/cheaper extraction prompt than full micro-reflection (fewer max facts, shorter context)
3. Run as fire-and-forget alongside the compaction (should not block the compaction itself)
4. Deduplicate against existing facts via the same semantic dedup path

### 4. Owner-private memory

**Priority**: High (for owner-assistant product direction)

**Gap**: The owner scope exists in schema and write path but lacks runtime context gating, retrieval enforcement, and dashboard surface.

**Recommendation**: Execute the remaining steps of `owner-private-memory-plan.md`:

1. Implement `isOwnerPrivateContext` primitive (DM with configured owner, explicit dashboard flows)
2. Wire retrieval rules: owner facts loaded only in owner-private contexts
3. Build dashboard Owner Private surface (visually separate from person/community memory)
4. Add tests for scope isolation
5. Update canonical docs

### 5. Text conversation compaction

**Priority**: Lower (revisit after owner-private memory)

**Gap**: Text conversations have no compaction. Clanky relies on truncation (limited recent message window) and micro-reflection to handle long text threads. In a fast-moving channel or long DM conversation, important context from 100+ messages ago is simply gone from the prompt.

**Recommendation**: For long-running DM conversations (especially with the owner), adopt a text-side compaction strategy. This is lower priority because Discord text conversations are naturally more episodic, and `conversation_search` provides explicit fallback recall.

**Implementation sketch**:

1. Track per-channel message count since last compaction
2. When count exceeds a threshold, compact older messages into a rolling summary
3. Inject summary as context in subsequent replies
4. Consider making this DM-only or owner-DM-only initially

### 6. Memory citations

**Priority**: Low (nice-to-have)

**Gap**: When Clanky recalls a fact, the user has no way to know where it came from without the dashboard Inspector.

**Recommendation**: Consider optional source citations on memory search results in DM/owner contexts. Format could be a Discord message link or channel/timestamp reference. Probably not appropriate for public channels where it would feel awkward and break immersion.

## AGENTS.md alignment assessment

The memory system is well-aligned with the agent autonomy principle:

- Memory creation is model-driven, not rule-triggered
- Memory retrieval is automatic but transparent (injected as context, not hidden)
- Micro-reflection and daily reflection are safety nets, not prescriptive rules
- The agent can always choose to use or ignore memory tools
- Soft guidance ("store long-lived useful facts") not hard rules
- `[SKIP]` remains a valid response even with rich memory context

**One area to watch**: The voice warm memory system's topic drift detection is a deterministic gate on whether to refresh memory retrieval. Per AGENTS.md, deterministic gates should exist "only for infrastructure safety — permissions, rate limits, acoustic thresholds, budget caps." The warm memory system is a latency/cost optimization that could theoretically suppress relevant memory refresh if cosine similarity misclassifies a topic shift. The thresholds seem reasonable (ambiguous cases conservatively reuse), but it is worth monitoring whether this causes missed retrievals in practice.

## Recommended execution order

1. **Cross-modal context bridging** — persist voice session summaries, inject into text pipeline
2. **Owner-private memory** — complete the remaining implementation steps
3. **BM25 full-text search** — replace LIKE scoring with FTS5 BM25
4. **Pre-compaction memory flush** — extract facts before voice compaction batches
5. **Text compaction** — rolling summary for long DM conversations
6. **Memory citations** — optional source references in DM contexts

Items 1-2 are the highest product impact. Items 3-4 are retrieval quality improvements. Items 5-6 are future refinements.
