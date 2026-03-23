# Memory System

This document describes how Clanky's memory works today and where it is headed as the product deepens from community participant to trusted collaborator to owner assistant.

See also:

- `AGENTS.md` - Agent Autonomy
- `docs/architecture/relationship-model.md`
- `docs/architecture/dm-support-and-user-scoped-memory.md`

## Product shape

Clanky is one socially real Discord-native entity.

Memory should reinforce that identity rather than split Clanky into separate personas or separate bots. The same agent should:

- remember people and shared history like a real community participant
- carry forward durable context for approved higher-trust collaboration
- become a deeper private assistant for the owner without leaking that private context into public interactions

This means memory is not one flat bucket. It is one unified memory system with multiple scopes, visibility rules, and ownership boundaries.

## Design principles

- Memory should feel like recall, not like the bot manually searching a database every turn.
- Social continuity is the default public behavior.
- Deeper memory access expands with trust, policy, and resource ownership.
- Private memory never silently bleeds into shared community contexts.
- The model decides what matters, but the system constrains where that memory can live and who can see it.

## Memory layers

Clanky has two persistence layers in the current runtime:

1. Durable facts in SQLite (`memory_facts`, `memory_fact_vectors_native`)
2. Conversation history in SQLite (`messages` and conversation-window vectors)

Supporting artifacts:

- Recent voice session summaries in SQLite (`session_summaries`)
- Daily journals in `memory/YYYY-MM-DD.md`
- Operator snapshot in `memory/MEMORY.md`
- Dashboard runtime snapshot for inspecting the effective prompt slice

The markdown files are useful operator-facing artifacts, but the runtime source of truth is the indexed SQLite memory store.

## Memory scopes

### Current scopes

Today the durable fact store has three runtime scopes:

- `user` - user-portable facts that follow a person across guilds and DMs
- `guild` - guild-specific shared context such as lore, norms, and server-local context
- `owner` - owner-private facts that only load in owner-private contexts

Runtime composition:

| Context | Memory in scope |
|---------|-----------------|
| Guild text/voice | participant user facts + guild facts |
| Standard DM | DM partner user facts + bot self facts |
| Owner-private DM/dashboard | owner facts + owner guidance + bot self facts, with owner user facts when relevant |

This is the current implemented foundation. Owner-private retrieval is intentionally gated. The owner scope does not bleed into guild contexts or ordinary DMs with other people.

### Target scopes

The relationship model implies a richer memory model over time.

Clanky should eventually distinguish at least these buckets:

- `community memory` - guild-scoped shared social context and lore
- `collaborator-private memory` - user-specific context for an approved collaborator relationship
- `shared-resource memory` - memory attached to a shared repo, project, workspace, channel, or team workflow
- `owner-private memory` - private assistant memory for the owner-facing relationship

These are not separate bots. They are separate visibility and ownership domains inside one memory fabric.

The important architectural point is that community context remains real context, not just provenance metadata. Memory should not be flattened into one global personal store. Clanky should remember people across contexts while still preserving community, resource, and private visibility boundaries.

## What memory is for

Different scopes serve different product needs.

### Community memory

Used for Clanky as a socially embedded public participant.

Examples:

- who regulars are
- their preferences and recurring interests
- server culture, running jokes, guild lore, recurring events
- socially useful facts that help Clanky feel continuous in public conversation

### Collaborator memory

Used when an approved person asks more of Clanky on shared or specifically approved resources.

Examples:

- collaborator-private context that belongs to that approved relationship
- ongoing work context for an approved repo or project
- follow-through on a longer-running shared task
- shared-resource notes that should help future collaboration without exposing owner-private context

In the target model this is not one flat bucket. It eventually breaks down into at least:

- collaborator-private memory
- shared-resource memory

### Owner-private assistant memory

Used for the deepest assistant relationship with the person running the instance.

Examples:

- private reminders
- personal preferences and routines
- device-linked context
- ongoing personal workflows and assistant continuity

This layer is the closest analogue to OpenClaw-style personal assistant memory.

## How memory is created today

Clanky builds durable memory through three complementary paths:

### Real-time writes

The model can write durable facts immediately when it notices something worth remembering.

- Tool path: `memory_write`
- Namespaces resolve to user, guild, self, or owner scopes
- Fact types are normalized and filtered before storage
- Writes dedupe, refresh embeddings, archive lower-priority old facts, and refresh prompt snapshots
- Owner writes are accepted only inside owner-private contexts

This path is best for explicit "remember this" requests or obviously durable facts.

### Session-end micro-reflection

After a voice session ends or a text thread goes quiet, a lightweight reflection reviews that recent conversation and extracts missed durable facts.

- catches facts not saved in the moment
- stays narrow to the recent session or quiet text window
- uses the same durable write path as direct writes

This is especially important in voice, where the model is often focused on responding rather than filing memory in real time.

### Pre-compaction voice reflection

Long voice sessions flush a lighter reflection pass before old transcript turns are compacted into the rolling summary.

- runs on the exact batch about to be compacted
- extracts a small number of durable facts without blocking compaction
- reduces the chance that early-session details disappear before the session-end reflection sees them

### Daily reflection

A broader reflection pass reviews the day journal and distills durable facts.

- sees larger patterns across multiple sessions
- merges near-duplicates against existing memory
- writes through the same validation, dedupe, and archival path

This turns raw journal history into longer-lived memory.

## How memory is surfaced today

### Fact profiles for people in the room

Clanky loads memory for all relevant participants, not just the current speaker.

- In voice, participant fact profiles are cached in-session.
- In text, user facts are loaded for people in the recent message window.
- Guild lore and bot-self facts are included where relevant.

This makes memory feel like natural social recall rather than a special tool call.

### Relevant past conversations

Conversation windows are retrieved automatically by topic relevance during context assembly.

- current turn is embedded
- relevant prior windows are recalled in parallel
- low-signal backchannels can reuse fresh recent recall instead of re-querying every turn

This gives Clanky recall of what was said before without forcing the model to manually search history in the common case.

### Recent voice session carryover

When a voice session ends, the compacted session summary is persisted as a short-lived artifact and can be injected into the text reply prompt for the same channel.

- text replies can inherit the most recent voice context for a short window after the session ends
- summaries expire automatically instead of becoming permanent durable memory
- dashboard prompt inspection shows the injected voice-session context

### Fallback memory tools

Text and automation contexts can still use explicit search tools when needed.

- `memory_search` for deeper durable-fact lookup
- `conversation_search` for broader transcript/history lookup

These are fallback tools, not the primary way Clanky accesses memory in ordinary interaction.

## Durable fact model today

Durable facts live in `memory_facts`.

Important fields:

- `scope` - `user`, `guild`, or `owner`
- `guild_id` - used for guild-scoped facts
- `user_id` - owner for user-scoped or owner-scoped facts
- `subject` - user ID, `__lore__`, `__self__`, or `__owner__`
- `fact`
- `fact_type`
- `evidence_text`
- `source_message_id`
- `confidence`
- `is_active`

### Current fact types

Canonical fact types today:

- `profile`
- `relationship`
- `preference`
- `project`
- `guidance`
- `behavioral`
- `other`

Notes:

- `__lore__` is a subject, not a fact type.
- `__self__` is a subject, not a fact type.
- `__owner__` is the canonical owner-private subject.
- Legacy stored rows may still contain old types like `lore`, `self`, or `general`, but those are not part of the intended canonical model.

### Fact type intent

| Type | Use |
|------|-----|
| `profile` | stable identity facts |
| `relationship` | important links between people |
| `preference` | tastes, habits, recurring likes/dislikes |
| `project` | ongoing work and active efforts |
| `guidance` | standing style/tone guidance |
| `behavioral` | contextual behavior rules |
| `other` | lore, observations, and facts that do not fit the above |

### Retrieval behavior

- core people/context facts are loaded directly into participant fact profiles
- community-scoped lore remains a real retrieval surface in guild contexts
- owner-private facts load only in owner-private contexts and in the dedicated dashboard owner-private surface
- `guidance` is meant to act like always-relevant standing context
- `behavioral` is retrieved more selectively to avoid bloating every prompt
- provenance such as guild, channel, and source message should inform ranking and inspection, but it is not the only organizing principle of the system
- lexical fact recall uses SQLite FTS5/BM25 instead of tokenized `LIKE` scoring
- embeddings support hybrid semantic + lexical ranking for both fact search and conversation recall

## Journals and snapshots

### Daily journals

`memory/YYYY-MM-DD.md` is the append-only raw journal.

- stores ingested text messages and voice transcripts
- provides source material for reflection
- keeps message/guild/channel provenance visible for operators

### Operator snapshot

`memory/MEMORY.md` is a generated operator-facing summary.

- useful for inspection and debugging
- not the runtime source of truth
- dashboard can also render a scoped runtime snapshot without changing the file on disk

## Safety and quality guards

Writes are filtered before becoming durable memory.

- normalized input and length bounds
- fact type normalization
- rejection of prompt-injection and unsafe instruction text
- evidence grounding requirements
- dedupe and supersession handling
- soft archival instead of destructive deletion when rotating old facts

If embeddings fail, the fact can still be stored and embedded later.

## Current reality vs target direction

The current runtime is strongest at social memory:

- knowing people
- recalling conversations
- carrying guild lore and recurring context
- feeling continuous in Discord voice and text

That is correct and important.

But the relationship model now makes it clear that Clanky also needs stronger assistant-oriented memory for higher-trust use cases.

Today the system has the technical foundations for scoped durable memory, but the product direction extends beyond pure social recall. Clanky should grow toward a unified memory fabric that supports:

- social continuity in community spaces
- approved collaborator continuity in collaborator-private and shared-resource contexts
- deeper owner-private assistant continuity

## Comparison to OpenClaw-style memory

OpenClaw-style memory is strongest at explicit assistant continuity:

- notes
- decisions
- project context
- reminders
- durable private working context written to inspectable artifacts

Clanky's current memory is strongest at socially embedded continuity:

- people in the room
- shared history
- guild lore
- conversation recall

Clanky should not replace its social memory with OpenClaw-style memory.
It should add assistant-oriented scopes and retrieval on top of the social foundation while preserving one identity and one consistent public personality.

## Intended end state

Clanky remembers you like a real social participant and supports you like a serious assistant.

That means:

- one agent identity
- one memory system
- multiple scopes
- explicit ownership boundaries
- deeper memory visibility and continuity as trust increases

The public Clanky people know in Discord and the deeper assistant the owner relies on are the same being, with different memory surfaces available depending on relationship depth, policy, and resource ownership.
