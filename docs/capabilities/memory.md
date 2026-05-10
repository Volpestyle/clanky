# Memory System

This document describes how Clanky's memory works today and where it is headed as the product deepens from community participant to trusted collaborator to owner assistant.

See also:

- [`../../AGENTS.md`](../../AGENTS.md) - Agent Autonomy
- [`../architecture/relationship-model.md`](../architecture/relationship-model.md)

Portable user memory, standard DM recall, owner-private retrieval, and explicit project/task/swarm/collaborator work memory are the shipped baseline now. This document is the canonical source for that foundation; there is no separate migration doc to maintain in parallel.

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

Clanky uses a tiered hybrid memory model:

1. File-backed identity in `memory/SOUL.md`
2. Curated always-on memory in `memory/CORE.md`, `memory/OWNER.md`, and `memory/COLLABORATION.md`
3. Durable facts in SQLite (`memory_facts`, `memory_fact_vectors_native`)
4. Retrieved conversation history in SQLite (`messages` and conversation-window vectors)
5. Explicit memory tools (`memory_search`, `conversation_search`, `memory_write`)

Supporting artifacts:

- Recent voice session summaries in SQLite (`session_summaries`)
- Operator snapshot in `memory/MEMORY.md`
- Dashboard runtime snapshot for inspecting the effective prompt slice

The SQLite store remains the source of truth for broad social and assistant recall. The curated markdown files are intentionally tiny operator-edited prompt-slice inputs for identity and high-priority standing context that should not depend on semantic retrieval.

The repository ignores `memory/*.md`, so these files are local operator state by default. Missing curated files are normal and fall back to settings-backed identity/persona plus SQLite memory retrieval.

### Tier 0: identity

`memory/SOUL.md` defines stable global identity: who Clanky is, how Clanky generally speaks, and the one-entity model that spans Discord participant, owner assistant, and task orchestrator.

Rules:

- `SOUL.md` loads first in text, voice, realtime voice, initiative, automation, and coding/task prompt surfaces when present.
- It should not contain guild lore, owner secrets, project paths, current tasks, or repo conventions.
- Obvious prompt-injection language blocks the file from prompt insertion for that prompt slice.
- If the file is missing, empty, or blocked, settings-backed bot name/persona remains the fallback identity source.

### Tier 1: curated always-on memory

Curated always-on memory is high-confidence, compact background context that should be present without retrieval.

Files:

- `memory/CORE.md` - global standing memory for all prompt modes
- `memory/OWNER.md` - owner-private standing memory, loaded only in owner-private contexts
- `memory/COLLABORATION.md` - coding/subagent collaboration defaults, loaded only in coding/task contexts

Rules:

- Entries should be declarative facts, not hidden imperative policy.
- Owner-private curated memory follows the same owner-private context gate as owner facts.
- Collaboration memory is task context, not public social memory.
- Curated content is loaded into an immutable prompt snapshot; edits on disk affect future prompt slices only.
- The loader blocks files that contain obvious prompt-injection patterns such as attempts to ignore or replace system/developer instructions.

### Tier 2: structured durable facts

Structured facts are the main scalable memory layer. They preserve scope, subject, type, confidence, evidence, activity state, FTS entries, and embeddings.

This layer powers people-in-room profiles, bot self facts, guild lore, owner-private facts, explicit project/task/swarm/collaborator work facts, guidance facts, and selective behavioral memory.

### Tier 3: retrieved history

Retrieved history brings back relevant text windows, voice transcript windows, compacted voice context, and recent voice session summaries.

This is separate from curated memory: a voice session summary can be fresh continuity without becoming an always-on fact.

### Tier 4: explicit tools

Memory tools remain fallback and management surfaces. They are not the primary access path for ordinary social continuity.

## Memory scopes

### Current scopes

Today the durable fact store has seven runtime scopes:

- `user` - user-portable facts that follow a person across guilds and DMs
- `guild` - guild-specific shared context such as lore, norms, and server-local context
- `owner` - owner-private facts that only load in owner-private contexts
- `project` - repo/workspace/resource facts used for approved coding and work tasks
- `task` - task-session decisions, verification, changed files, follow-ups, and outcomes
- `swarm` - durable knowledge about Clanky-spawned worker workflows and handoffs
- `collaborator` - approved collaborator relationship context, keyed by Discord user id

Runtime composition:

| Context | Memory in scope |
|---------|-----------------|
| Guild text/voice | participant user facts + guild facts |
| Standard DM | DM partner user facts + bot self facts |
| Owner-private DM/dashboard | owner facts + owner guidance + bot self facts, with owner user facts when relevant |
| Coding/task worker launch | curated task memory + explicit project/task/swarm/collaborator facts |

Owner-private retrieval is intentionally gated. Work scopes are explicit and are not part of ordinary public guild prompt slices. They are retrieved for approved coding/task contexts or when explicitly targeted through a permitted memory namespace.

### Product language for scopes

The runtime stores concrete scope names in the database, but product-facing language should describe the social/private scopes as:

- `People` - portable person memory
- `Community` - guild-scoped shared memory
- `Owner Private` - private assistant memory for the owner-facing relationship

### Assistant/work scopes

Assistant/work scopes are durable database scopes, not separate bots:

- `project` memory is attached to a repo/workspace/resource key.
- `task` memory is attached to a swarm task id.
- `swarm` memory uses the `__swarm__` subject for worker/orchestration facts.
- `collaborator` memory is attached to an approved collaborator Discord user id.

These are separate visibility and ownership domains inside one memory fabric.

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

### Collaborator / shared-work memory

Used when an approved person asks more of Clanky on shared or specifically approved resources.

Examples:

- collaborator-private context that belongs to that approved relationship
- ongoing work context for an approved repo or project
- follow-through on a longer-running shared task
- shared-resource notes that should help future collaboration without exposing owner-private context

The runtime has both file-backed collaboration memory for coding/subagent prompts and durable database scopes for shared work. Clanky-spawned swarm workers provide parent-readable `handoff` annotations before marking tasks done. On successful completion, the parent process promotes stable handoff material into `task`, `project`, `swarm`, and when applicable `collaborator` facts after durable-memory safety validation. Failed, cancelled, interrupted, or timed-out work does not become durable work memory by default.

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

### Turn lifecycle boundaries

Durable sync uses the clean conversational input, not prompt-expanded context. Retrieved memory, provider-added background, tool results, and prompt scaffolding are not treated as if the user said them.

Before a text or voice turn is written to `messages`, conversation vectors, or reflection input, the runtime checks that the turn is complete enough to be durable conversational truth.

- completed Discord text messages and successfully sent bot replies are eligible
- completed voice transcripts and fully delivered assistant voice replies are eligible
- interrupted, cancelled, stale, superseded, partial, or not-delivered turns are skipped for durable sync
- interrupted assistant voice output can remain in the live session transcript for immediate conversational continuity, but it is marked non-durable and excluded from voice reflection
- idle-timeout and near-silence voice captures are treated as partial capture boundaries unless a higher-level flow records a completed turn separately

Skipped lifecycle writes are logged under `memory_runtime` so operators can distinguish an intentional non-durable boundary from missing memory.

### Real-time writes

The model can write durable facts immediately when it notices something worth remembering.

- Tool path: `memory_write`
- Namespaces resolve to user, guild, self, owner, project, task, swarm, or collaborator scopes
- Fact types are normalized and filtered before storage
- Writes dedupe, refresh embeddings, archive lower-priority old facts, and refresh prompt snapshots
- Owner writes are accepted only inside owner-private contexts

Owner-private writes are currently narrow by design:

- `owner` and `private` namespaces are accepted only for configured owner user ids
- owner-private memory is intended for owner DMs and other explicitly owner-only flows
- ordinary guild/community contexts should not silently write owner memory

This path is best for explicit "remember this" requests or obviously durable facts.

### Session-end micro-reflection

After a voice session ends or a text thread goes quiet, a lightweight reflection reviews that recent conversation and extracts missed durable facts.

- catches facts not saved in the moment
- stays narrow to the recent session or quiet text window
- can supersede an existing fact by returning the exact older fact text alongside the replacement
- uses the same durable write path as direct writes

This is especially important in voice, where the model is often focused on responding rather than filing memory in real time.


### Pre-compaction voice reflection

Long voice sessions flush a lighter reflection pass before old transcript turns are compacted into the rolling summary.

- runs on the exact batch about to be compacted
- extracts a small number of durable facts without blocking compaction
- reduces the chance that early-session details disappear before the session-end reflection sees them

## How memory is surfaced today

### Frozen prompt slices

Every reply/task prompt receives a frozen memory slice assembled before generation. Writes that happen during a turn persist immediately but affect future slices only.

Prompt tiers use a consistent vocabulary across text, text-mediated voice, realtime voice, initiative, automation, and code-worker launches:

1. Identity (`SOUL.md` or settings fallback)
2. Base mode guidance
3. Curated always-on memory for the current visibility/mode
4. Scoped structured facts
5. Retrieved conversation or task history
6. Capability/tool state
7. Current user/event input

Prompt logs capture the effective system/user prompt text with the same tier labels for Discord text replies, text-mediated voice replies, realtime voice instruction refreshes, initiative cycles, automation runs, and code-worker launches. Memory-runtime logs include loaded, missing, and blocked curated file keys for incident analysis.

### Curated prompt files

Curated files load only when their gate fits the current prompt surface:

| File | Loads in |
|------|----------|
| `SOUL.md` | All prompt modes when present and safe |
| `CORE.md` | All prompt modes when present and safe |
| `OWNER.md` | Owner-private prompt contexts only |
| `COLLABORATION.md` | Coding/task worker prompts only |

These files are background context, not new user-authored input. If a file is edited while a generation is in flight, the active generation continues using the already-built slice. Code-worker launch logs include the task prompt bundle that was sent to the worker so the operator can inspect which curated and scoped work memory was present at dispatch time.

### Fact profiles for people in the room

Clanky loads memory for all relevant participants, not just the current speaker.

- In voice, participant fact profiles are cached in-session.
- In text, user facts are loaded for people in the recent message window.
- Guild lore and bot-self facts are included where relevant.
- Owner DMs can additionally load owner-private facts.

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

Configured owners can explicitly target owner-private memory through the `owner` / `private` namespace in tool contexts. Approved coding collaborators can explicitly target permitted work memory with `project:<key>`, `task:<id>`, `swarm`, and their own `collaborator:<discord_user_id>` namespace.

These are fallback tools, not the primary way Clanky accesses memory in ordinary interaction.

## Durable fact model today

Durable facts live in `memory_facts`.

Important fields:

- `scope` - `user`, `guild`, `owner`, `project`, `task`, `swarm`, or `collaborator`
- `guild_id` - used for guild-scoped facts
- `user_id` - owner for user-scoped, owner-scoped, or collaborator-scoped facts
- `subject` - user ID, `__lore__`, `__self__`, `__owner__`, `__swarm__`, project key, or task id
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
- project/task/swarm/collaborator facts load only through explicit work namespaces or approved coding/task worker prompt bundles
- `guidance` is meant to act like always-relevant standing context
- `behavioral` is retrieved more selectively to avoid bloating every prompt
- provenance such as guild, channel, and source message should inform ranking and inspection, but it is not the only organizing principle of the system
- lexical fact recall uses SQLite FTS5/BM25 instead of tokenized `LIKE` scoring
- embeddings support hybrid semantic + lexical ranking for both fact search and conversation recall

## Snapshots

`memory/MEMORY.md` is a generated operator-facing summary.

- useful for inspection and debugging
- not the runtime source of truth
- dashboard can also render a scoped runtime snapshot without changing the file on disk
- the `People` section is limited to `user` and `guild` facts; project, task, swarm, and collaborator work facts stay in work-memory surfaces
- the global snapshot now includes an `Owner Private` section so operators can inspect the private assistant layer separately from person/community memory
- raw durable turn history, vectors, facts, and reflection runs live in SQLite rather than parallel markdown journals

## Safety and quality guards

Writes are filtered before becoming durable memory.

- normalized input and length bounds
- fact type normalization
- rejection of prompt-injection and unsafe instruction text
- evidence grounding requirements
- dedupe and supersession handling
- soft archival instead of destructive deletion when rotating old facts

If embeddings fail, the fact can still be stored and embedded later.

Curated markdown files have a separate prompt-insertion guard:

- missing files are treated as empty optional context
- files with obvious prompt-injection language are blocked from prompt insertion for that slice
- blocked/missing/loaded keys are logged under `memory_runtime` for debugging
- owner-private and collaboration files are only read when their visibility gate applies

## Current reality vs target direction

The runtime is strongest at social memory:

- knowing people
- recalling conversations
- carrying guild lore and recurring context
- feeling continuous in Discord voice and text

That is correct and important.

The relationship model also needs stronger assistant-oriented memory for higher-trust use cases.

The system has assistant-oriented layers now: owner-private facts, file-backed curated prompt memory, and explicit durable work scopes. Clanky should keep growing this unified memory fabric so it supports:

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

The new owner-private layer starts closing that gap by giving the owner a real private assistant memory lane without changing Clanky's public social identity.

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
