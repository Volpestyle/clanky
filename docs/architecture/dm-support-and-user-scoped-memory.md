# DM Support and User-Scoped Memory

This document describes the architectural shift that introduced portable user memory, DM-compatible memory retrieval, and the first owner-private memory lane.

It explains the current implemented foundation of Clanky's memory model, not the full end-state relationship-tier memory model described in `relationship-model.md`. Today the runtime composes `user`, `guild`, and owner-private `owner` scope. Over time, that foundation expands further into richer visibility domains such as collaborator-private memory and shared-resource memory.

## Problem

Today all memory is namespaced by `guild_id`. This creates two issues:

1. **No DM support.** DMs have no guild, so the bot silently drops them at the front door (`bot.ts:1537: if (!message.guild) return`). Even if that guard were removed, memory tools would reject empty guildId.

2. **No cross-guild user identity.** The bot forgets a user when they appear in a different server. Facts about "James likes spicy food" exist only in Guild A and are invisible in Guild B or DMs.

A real person remembers *you*, not "you in this server."

## Design: Multi-Scope Memory Foundation

Three memory scopes compose at query time in the current runtime:

### User scope

Facts about a person that follow them everywhere.

- Preferences, personality traits, relationship context, project history
- Keyed by `user_id` (the person the fact is about)
- No guild affinity -- visible in any guild and in DMs
- Examples:
  - "James prefers dark mode"
  - "Sarah is a game developer working on a puzzle game"
  - "Max and James are roommates"

### Guild scope

Server-specific knowledge that stays with the guild.

- Community lore, rules, culture, events, inside jokes
- Keyed by `guild_id`
- Only surfaced when interacting in that guild
- Examples:
  - "The #memes channel has a Friday meme competition"
  - "Server rule: no politics in general"
  - "The guild anniversary is March 15"

### Owner scope

Owner-private facts that belong to the operator-facing assistant relationship.

- Keyed as `scope = 'owner'`
- Retrieved only in owner-private contexts such as the configured owner's DM or the dedicated dashboard owner-private surface
- Examples:
  - "Renew passport in May"
  - "Default travel bag is the black duffel"
  - "Keep personal reminders out of shared guild contexts"

### Composition rules

| Context | What the bot sees |
|---------|-------------------|
| Guild message | User facts for all participants + guild facts for the server |
| DM | User facts for the DM partner + bot self-knowledge |
| Voice (guild) | User facts for all participants + guild facts |
| Owner-private DM/dashboard | Owner facts + owner guidance + bot self knowledge, plus owner user facts when relevant |

This scoped model is the current implementation baseline. It should not be read as the final product ontology for all future memory. Community memory remains a real visibility boundary, while future work adds more private and resource-bound memory domains above this base.

## Schema Migration

### Current schema

```sql
CREATE TABLE memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  guild_id TEXT NOT NULL,           -- mandatory partition key
  channel_id TEXT,
  subject TEXT NOT NULL,            -- userId, __self__, __lore__
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'other',
  evidence_text TEXT,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(guild_id, subject, fact)
);
```

### New schema

```sql
CREATE TABLE memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'guild',   -- 'user' | 'guild' | 'owner'
  guild_id TEXT,                         -- nullable: NULL for user-scoped facts
  channel_id TEXT,
  user_id TEXT,                          -- nullable: the fact owner for user/owner scopes
  subject TEXT NOT NULL,                 -- userId, __self__, __lore__, __owner__
  fact TEXT NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'other',
  evidence_text TEXT,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(scope, COALESCE(guild_id, ''), COALESCE(user_id, ''), subject, fact)
);
```

Key changes:
- `guild_id` becomes **nullable**
- New `scope` column: `"user"`, `"guild"`, or `"owner"`
- New `user_id` column: the user a fact belongs to (for user-scoped facts) or the configured owner identity (for owner-scoped facts)
- UNIQUE constraint spans both scopes without collision

This schema change stays intentionally minimal. It establishes portable person memory, guild/community memory, and the first owner-private lane without yet introducing separate columns or tables for collaborator-private or shared-resource memory.

### Index changes

```sql
-- User-scoped fact lookups (DMs and cross-guild)
CREATE INDEX idx_memory_user_scope ON memory_facts(scope, user_id, subject, is_active, updated_at DESC);

-- Guild-scoped fact lookups (existing pattern, now filtered by scope)
CREATE INDEX idx_memory_guild_scope ON memory_facts(scope, guild_id, subject, is_active, updated_at DESC);

-- Owner-private fact lookups
CREATE INDEX idx_memory_owner_scope ON memory_facts(scope, user_id, subject, is_active, updated_at DESC);

-- Combined lookups (guild context: user facts + guild facts for participants)
CREATE INDEX idx_memory_subject_active ON memory_facts(subject, is_active, updated_at DESC);
```

### Migration strategy

One-time data migration when the new schema is detected:

1. Add `scope`, `user_id` columns (with defaults) to existing table
2. Classify existing rows:
   - `subject` is a Discord user ID (numeric string) and `fact_type` in (`preference`, `profile`, `relationship`, `project`, `other`) → `scope = 'user'`, `user_id = subject`
   - `subject = '__self__'` → `scope = 'user'`, `user_id = NULL` (bot self-knowledge is universal)
   - `subject = '__lore__'` → `scope = 'guild'`, `user_id = NULL`
   - `subject = '__owner__'` → `scope = 'owner'`, `user_id = configured owner`
   - `fact_type = 'guidance'` or `'behavioral'` → `scope = 'guild'` (server-specific operational config)
3. Rebuild UNIQUE constraint
4. Rebuild indexes

## Query Changes

### Loading facts for a guild context

```sql
-- User facts for participants
SELECT * FROM memory_facts
WHERE scope = 'user'
  AND subject IN (?, ?, ?)         -- participant user IDs
  AND is_active = 1
ORDER BY confidence DESC, updated_at DESC;

-- Guild facts
SELECT * FROM memory_facts
WHERE scope = 'guild'
  AND guild_id = ?
  AND is_active = 1
ORDER BY confidence DESC, updated_at DESC;
```

Results are merged and ranked together.

### Loading facts for a DM context

```sql
-- User facts for the DM partner
SELECT * FROM memory_facts
WHERE scope = 'user'
  AND subject IN (?, '__self__')   -- DM partner userId + bot self
  AND is_active = 1
ORDER BY confidence DESC, updated_at DESC;
```

No guild facts -- DMs have no guild context.

### Loading facts for an owner-private context

```sql
SELECT * FROM memory_facts
WHERE scope = 'owner'
  AND subject = '__owner__'
  AND is_active = 1
ORDER BY confidence DESC, updated_at DESC;
```

This owner scope is only added when `isOwnerPrivateContext(...)` resolves true.

### Hybrid search (semantic + lexical)

The existing hybrid search (`searchDurableFacts`) changes its WHERE clause:

- **Guild context:** `(scope = 'user' AND subject IN (?participants)) OR (scope = 'guild' AND guild_id = ?)`
- **DM context:** `scope = 'user' AND subject IN (?dmPartner, '__self__')`
- **Owner-private context:** `scope = 'owner'` plus the normal owner DM user/self slice when relevant

Lexical search uses an FTS5 virtual table with BM25 scoring, while embedding vectors in `memory_fact_vectors_native` remain keyed by `fact_id` and scope-agnostic.

## Memory Tool Changes

### Namespace resolution

The `memory_search` and `memory_write` tools currently require `guildId`. New behavior:

| Tool namespace | In guild | In DM |
|----------------|----------|-------|
| `"speaker"` / `"user"` / `"me"` | User-scoped fact about the speaker | Same (works without guild) |
| `"self"` / `"bot"` | User-scoped bot self-knowledge | Same |
| `"guild"` / `"lore"` / `"shared"` | Guild-scoped server lore | **Not available** (error: "guild context required for guild/lore namespace") |
| `"owner"` / `"private"` | **Not available** | Owner-scoped fact only in owner-private contexts |
| `"user:<id>"` | User-scoped fact about that user | Same |
| (empty/default) | Searches guild + user scopes | Searches user scope only, or user + owner scope in owner-private contexts |

The `guild_required` guard in `memoryToolRuntime.ts:127` changes to only reject when the tool explicitly targets guild scope and no guild is present.

## DM Pipeline Changes

### Hard blockers to remove

| File | Line | Change |
|------|------|--------|
| `bot.ts` | 1537 | Allow DMs: `if (!message.channel \|\| !message.author) return;` |
| `queueGateway.ts` | 306 | Allow DMs: `if (!headMessage.channel) { ... }` |
| `bot.ts` | 2340-2350 | Null-guard `getEmojiHints` / `getReactionEmojiOptions` for null guild |

### Type changes

Widen `guildId` to `string | null` in:
- `ReplyTrace` (replyPipeline.ts)
- `ReplyToolContext` (replyTools.ts)
- `ReplyPipelineSentMessage` (replyPipeline.ts)
- `SentMessageLike` (bot.ts)
- `ConversationContinuityPayload` (conversationContinuity.ts)

### Graceful degradation in DMs

Features that silently degrade (no crash, reduced functionality):
- @mention resolution: no guild member cache, falls back to raw text
- Custom emoji hints: empty list (no guild emoji cache)
- Channel permissions: DM channels bypass allowlist/blocklist (always allowed)
- Initiative engine: does not proactively DM (future enhancement)
- Conversation history: scoped by channel ID (DM channel), works naturally

## Fact Profile Changes

`loadFactProfile()` currently loads facts with a mandatory guildId. New behavior:

```
loadFactProfile({ userId, guildId?, participantIds })
  if (guildId) {
    // Guild context: load user-scoped facts for participants + guild-scoped facts
    userFacts = query(scope='user', subject IN participantIds)
    guildFacts = query(scope='guild', guild_id=guildId, subject IN ['__lore__', '__self__', ...participantIds])
    return merge(userFacts, guildFacts)
  } else {
    // DM context: load user-scoped facts only
    userFacts = query(scope='user', subject IN participantIds)
    selfFacts = query(scope='user', subject='__self__')
    return merge(userFacts, selfFacts)
  }
```

When the context is owner-private, the composed slice can also include owner facts and owner guidance. The owner scope never appears in non-owner guild or DM contexts.

## Reflection Pipeline Changes

The memory reflection system (post-conversation fact extraction) currently writes all facts with a guildId. New behavior:

- The model's `memory_write` calls specify `namespace`:
  - `"speaker"` / `"user"` → writes as `scope = 'user'` (no guildId needed)
  - `"lore"` / `"guild"` → writes as `scope = 'guild'` (requires guildId, rejected in DMs)
- Automated reflection (periodic fact extraction) classifies facts:
  - Personal facts about users → `scope = 'user'`
  - Server/community facts → `scope = 'guild'`
- The prompt for reflection should guide the model to distinguish between user-portable and server-specific facts

This is still a current-runtime description. Longer term, reflection should become capable of emitting richer memory visibility classes rather than only choosing between user-portable and guild/community facts.

## Cross-modal carryover

Voice compaction summaries persist into `session_summaries` and can be injected into the text prompt for the same channel shortly after a voice session ends.

- voice context survives the voice/text boundary without forcing everything into durable facts
- summaries expire automatically instead of becoming permanent memory
- long voice sessions also run a pre-compaction mini-reflection so early turns can emit durable facts before they are summarized away

## Historical implementation order

1. **Schema migration** -- Add columns, migrate existing data, rebuild indexes
2. **Store layer** -- Update `storeMemory.ts` query functions to support dual-scope
3. **Memory manager** -- Update `searchDurableFacts`, `loadFactProfile`, `rememberDirectiveLineDetailed`
4. **Memory tools** -- Update namespace resolution in `memoryToolRuntime.ts`
5. **DM pipeline unblock** -- Remove guards, widen types, null-guard crashes
6. **Reflection prompts** -- Guide the model to classify user vs guild facts
7. **Testing** -- E2E: DM conversation with memory, cross-guild memory recall

Future memory work should build on this foundation rather than replacing it with a single global scope. The intended next step is a richer relationship-aware memory model, not a collapse of community memory into generic self-memory.
