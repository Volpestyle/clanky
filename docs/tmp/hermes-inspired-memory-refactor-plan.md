# Hermes-Inspired Memory Refactor Plan

Status: planning draft. Phases 1-5 are shipped; Phase 6 remains future promotion/curation work.

This plan evolves Clanky's current SQLite/vector-backed social memory into a hybrid memory architecture that also supports serious owner-assistant and coding/subagent work. It borrows prompt discipline and curated high-priority memory ideas from Hermes without replacing Clanky's scoped community memory.

See also:

- [`../capabilities/memory.md`](../capabilities/memory.md)
- [`memory-system-review.md`](memory-system-review.md)
- [`owner-private-memory-plan.md`](owner-private-memory-plan.md)
- [`owner-assistant-gap-plan.md`](owner-assistant-gap-plan.md)
- [`swarm-launcher-redesign-plan.md`](swarm-launcher-redesign-plan.md)

## Goal

Make Clanky better as one coherent entity that can be both:

- a socially real Discord community member with people/guild/voice continuity
- a general assistant that can privately help the owner and drive coding work through swarm MCP/subagents

The key architectural change is to separate identity, curated high-priority standing memory, scoped retrieved memory, and task/work memory.

## Core Principle

Do not replace Clanky's structured memory store.

Clanky's current strength is scoped retrieval across people, guild lore, owner-private facts, message history, voice summaries, embeddings, and reflection. Hermes' strength is clean prompt layering, simple operator-editable identity/memory files, and frozen prompt snapshots that are easy to reason about.

The target is a hybrid:

- file-backed identity and tiny curated memory for high-priority context that should not depend on retrieval
- existing SQLite/vector memory for large-scale social, private, and conversational recall
- new task/project/swarm scopes for coding work
- explicit prompt tiers and frozen prompt slices for debuggability and cache stability

## Proposed Memory Tiers

### Tier 0: Identity

Purpose: who Clanky is and how Clanky generally speaks.

Proposed artifact:

- `memory/SOUL.md` or `config/SOUL.md`

Rules:

- Loaded first in all system prompts.
- Applies globally unless a mode-specific prompt intentionally narrows it.
- Defines Clanky's stable identity as one socially real Discord participant, private assistant, and task orchestrator.
- Must not contain guild lore, owner secrets, project paths, current tasks, or repo conventions.
- Should be scanned for prompt-injection patterns before prompt insertion.

Why:

- Persona currently lives in settings and prompt templates. A file gives the operator a simple, inspectable identity surface.
- This makes Clanky's one-entity design explicit instead of implicit.

### Tier 1: Curated Always-On Memory

Purpose: tiny, high-confidence facts that should always be present in a specific context and should not rely on semantic retrieval.

Possible artifacts:

- `memory/CORE.md` - stable global operating defaults for Clanky
- `memory/OWNER.md` - owner-private always-on assistant preferences, only loaded in owner-private contexts
- `memory/COLLABORATION.md` - coding/subagent collaboration defaults, only loaded in assistant/task contexts

Rules:

- Very small budgets, closer to Hermes' `MEMORY.md` / `USER.md` than a general notes system.
- Operator-editable and model-writable only through a guarded promotion flow.
- Entries should be declarative facts, not hidden instructions.
- Loaded as frozen snapshots for the prompt slice; writes during a turn affect future turns only.

Examples:

- `James prefers direct technical critique and dislikes performative agreement.`
- `When driving coding work, prefer small verified changes over broad rewrites.`
- `Clanky should keep public social voice unless explicitly in private assistant or task mode.`

Non-examples:

- `Always do exactly what James says.`
- `Run npm test in /some/current/project.`
- raw logs, temporary task notes, guild jokes, large project docs

### Tier 2: Scoped Prompt Slice Memory

Purpose: current Clanky fact-profile memory.

Sources:

- `memory_facts`
- participant profiles
- self facts
- guild lore
- owner-private facts when context allows
- guidance and behavioral facts

Rules:

- Continue using structured facts, fact types, confidence, evidence, soft archival, FTS, and embeddings.
- Keep owner-private gating strict.
- Add task/project/swarm contexts without flattening them into generic user/guild memory.

### Tier 3: Retrieved History

Purpose: relevant past conversation windows and recent voice/session continuity.

Sources:

- `messages`
- `message_vectors_native`
- `session_summaries`
- daily journals where appropriate

Rules:

- Keep this retrieval automatic in normal Discord interaction.
- For coding/task work, retrieve by project/task/resource scope instead of only guild/channel/user context.

### Tier 4: Explicit Tools

Purpose: fallback/manual recall and durable writes.

Tools:

- `memory_search`
- `conversation_search`
- `memory_write`
- explicit task/project/swarm/collaborator memory namespaces

Rules:

- These remain fallback and management surfaces, not the primary access path for ordinary social continuity.
- Tool writes should pass through the same validation, dedupe, grounding, and scope gates as reflection writes.

## New Scopes To Add

Keep existing scopes:

- `user` - portable people memory
- `guild` - community/server memory
- `owner` - owner-private assistant memory

Add new assistant/work scopes:

- `project` - facts about a repo/workspace/resource
- `task` - active task-session facts and decisions
- `swarm` - durable knowledge about subagent capabilities, handoffs, and swarm workflows
- `collaborator` - future approved collaborator-private memory

The important distinction: project/task/swarm context is not social memory. It should not bleed into public Discord banter unless explicitly relevant and safe.

## Prompt Assembly Contract

Every reply/voice/task prompt should be built from explicit layers:

1. Identity (`SOUL.md` or settings fallback)
2. Base mode guidance (text, voice, owner assistant, coding task, swarm orchestration)
3. Curated always-on memory for the current context
4. Scoped structured facts for the current context
5. Retrieved conversation/task history
6. Capability/tool state
7. Current user/event input

The exact effective prompt slice should be logged or inspectable in the dashboard.

Current Clanky surfaces that need this treatment:

- Text reply prompt construction in `replyPipeline.ts` / `promptText.ts`.
- Voice reply prompt construction in `voiceReplies.ts` / `promptVoice.ts`.
- Realtime voice instruction refreshes in `voice/instructionManager.ts`.
- Coding and swarm orchestration prompts, especially worker launch preambles and follow-up synthesis.

The important invariant is that all these surfaces should share the same memory tier vocabulary even when their budgets and refresh cadence differ.

## Voice And Realtime Memory Contract

Voice needs explicit handling because it has lower latency budgets, warm context reuse, and realtime instruction updates.

Rules:

- Treat voice session warm memory as a frozen prompt-slice cache, not as a second source of truth.
- Reuse warm snapshots only while drift detection says the topic is stable and the snapshot is fresh.
- Invalidate warm snapshots on memory writes, participant changes, explicit context shifts, and owner/private visibility changes.
- Realtime instruction refreshes may rebuild a new instruction slice at defined boundaries, but should not mutate the slice currently being used to answer an in-flight turn.
- Voice session summaries remain short-lived continuity artifacts unless reflection promotes a durable fact through the normal memory write path.
- Text replies after voice sessions may receive recent voice summaries, but those summaries should stay separate from curated always-on memory and durable facts.

Why:

- Clanky already has `voiceSessionWarmMemory.ts` and realtime instruction memory loading. The refactor should preserve this performance work while making its lifecycle inspectable and safe.
- Without explicit boundaries, a realtime instruction refresh can look like memory changed mid-turn even if the underlying durable store did not.

## Frozen Prompt Slice Rule

Adopt Hermes' frozen snapshot discipline:

- Build the effective prompt slice once for a reply turn, voice cycle, or task session.
- Do not let memory writes during that turn mutate the same prompt slice.
- Persist writes immediately, but surface them in future turns/sessions only.
- For long-running task/subagent sessions, define explicit refresh boundaries instead of ad hoc mid-loop memory changes.

Why:

- Easier debugging.
- Better prompt-cache behavior.
- Avoids self-referential loops where the model writes a memory and immediately treats it as prior truth.

## Turn And Lifecycle Memory Boundaries

Borrow these concrete lifecycle rules from Hermes:

- Preserve the original clean user input separately from any injected prompt context. Use clean input for memory sync, retrieval queries, and background review triggers.
- Inject retrieved or provider-added context as contextual background, not as if the user said it.
- Skip durable turn sync when the turn is interrupted, cancelled, or only partially delivered. Partial assistant output and aborted tool chains are not durable conversational truth.
- Persist explicit memory writes immediately, but only expose them in the next prompt slice or at an intentional refresh boundary.
- Run post-turn/background memory review only after the user-visible response is complete, and keep it best-effort so it never competes with the active reply.
- Run session-end extraction at actual boundaries: voice session end, text quiet-window reflection, dashboard/assistant session end, and task/swarm session completion.
- Run pre-compaction extraction on exactly the messages about to be compacted so facts are not lost before the final session reflection sees them.
- If a session ID or task ID rotates because of compaction, reset provider/cache/session-local state without treating the logical conversation as brand new.

Clanky already has similar ingredients: text micro-reflection, voice pre-compaction reflection, daily reflection, and voice warm memory. The refactor should make the boundaries uniform across text, voice, owner assistant, and swarm work.

## Declarative Fact Policy

Elevate this rule across prompts, tools, and reflection:

- Memory facts should describe durable truth.
- Memory facts should not become hidden imperative policy unless intentionally stored as `guidance` or `behavioral` with scope and evidence.

Good:

- `James prefers concise implementation summaries.`
- `The rc-studio repo uses pnpm and React Query.`

Bad:

- `Always summarize concisely for James.`
- `You must use pnpm in every repo.`

This should be part of real-time write guidance, reflection prompts, and memory write validation.

## Swarm MCP Memory Contract

Coding/subagent work needs a stronger memory boundary than general Discord interaction.

Parent Clanky should:

- build a scoped task memory bundle before launching workers
- include only relevant owner/project/task/swarm context
- exclude public guild lore unless explicitly relevant
- exclude owner-private facts from non-owner-visible work unless explicitly authorized

Worker/subagent should:

- receive a bounded task memory bundle
- produce a structured handoff with summary, changed files, tests, decisions, blockers, and follow-up recommendations
- avoid writing directly to broad social memory
- treat owner/project/task facts in the bundle as task context, not as general social memory
- report progress and final output through swarm primitives, not stdout scraping

Parent Clanky should then:

- store distilled task outcomes in `task` or `project` scope
- promote stable reusable process lessons into `swarm` or curated collaboration memory only when high confidence
- keep raw worker transcripts searchable but not always injected
- observe child work from the parent side and decide what, if anything, becomes durable memory
- skip broad memory writes for failed, cancelled, or interrupted worker runs unless there is a clear user-visible outcome or durable blocker worth recording

Hermes' useful pattern is that child agents are isolated from shared memory and the parent receives only task/result observations. Clanky should map that to swarm workers by treating `tasks.result`, `annotate(kind="progress")`, `annotate(kind="usage")`, and worker logs as raw inputs. A parent-owned extraction step should distill those into task/project/swarm memory.

Current Clanky worker contract note:

- Workers put final user-facing text into `update_task(status="done", result=<text>)`, with usage/progress in `annotate` records.
- Workers also emit `annotate(kind="handoff")` as a separate worker artifact. The parent reads that annotation and persists successful outcomes into scoped work memory without breaking the plain-text result contract.

## Promotion Flow

Add a path for high-value DB facts to become curated always-on memory.

Promotion candidates:

- repeated owner corrections
- durable assistant preferences
- stable project conventions used often
- critical privacy/behavior constraints
- stable swarm workflow lessons

Promotion should be rare, visible, and reversible.

Candidate generation should be asynchronous and reviewable, like Hermes' background memory/skill review, not inline hidden prompt mutation.

Possible flow:

1. reflection or runtime identifies a candidate
2. candidate is stored as a normal structured fact first
3. promotion job/operator UI suggests adding it to `CORE.md`, `OWNER.md`, or `COLLABORATION.md`
4. accepted promotion writes a compact declarative line to the curated file
5. future prompt slices include it independent of retrieval

Guardrails:

- Never promote from a failed/interrupted partial turn without explicit operator review.
- Never promote owner-private or project-private context into globally loaded curated memory.
- Promotion candidates should preserve provenance: source scope, evidence message/task/session IDs, and whether the candidate came from reflection, direct write, background review, or swarm handoff extraction.
- Promotion should favor stable preferences and constraints over one-off task state.

## Dashboard Requirements

The dashboard should expose:

- effective prompt slice inspector with tier breakdown
- identity file editor (`SOUL.md` equivalent)
- curated memory editor for `CORE.md`, `OWNER.md`, and `COLLABORATION.md`
- promotion candidate review queue
- project/task/swarm memory filters
- clear owner-private isolation indicators

The operator should be able to answer: "Why did Clanky remember this right now?" without reading raw SQLite rows.

## Implementation Phases

### Phase 1: Identity Surface

- Add `SOUL.md` equivalent with settings fallback.
- Load it as the first prompt layer for text, voice, initiative, owner-assistant, and task modes.
- Add prompt-injection scanning.
- Add dashboard/editor support or at least file documentation.
- Tests: missing file fallback, empty file behavior, injection blocking, prompt order.

### Phase 2: Curated Always-On Memory

- Add tiny scoped curated files.
- Define context gates for `CORE.md`, `OWNER.md`, and `COLLABORATION.md`.
- Freeze their content per prompt slice.
- Tests: owner file does not load publicly, collaboration file loads only in task contexts, writes do not affect current turn.

### Phase 3: Prompt Tier Refactor

Status: shipped for text replies, text-mediated voice replies, realtime voice instruction refreshes, initiative cycles, automation runs, and code-worker launches.

- Refactor prompt assembly to expose tiered sections explicitly.
- Add effective prompt slice capture for dashboard/debug logs.
- Preserve existing memory retrieval behavior while changing structure.
- Tests: prompt sections appear in deterministic order and scoped sections are omitted correctly.

### Phase 3a: Lifecycle Boundaries

Status: shipped for text/voice durable turn boundaries, voice pre-compaction reflection, frozen prompt slices, and successful swarm task-completion extraction.

- Preserve clean user input separately from injected prompt context for memory query/sync paths.
- Gate durable sync and background review on completed, non-interrupted turns.
- Define session-end, quiet-window, voice-end, pre-compaction, and task-completion extraction boundaries.
- Ensure memory writes affect future slices only unless a realtime refresh boundary explicitly rebuilds the slice.
- Tests: interrupted turn does not sync as durable conversation truth, injected context is not treated as user-authored memory input, pre-compaction extraction only sees the compacted batch.

### Phase 3b: Voice/Realtime Integration

Status: shipped for curated voice/realtime memory loading, warm-memory invalidation, realtime instruction prompt logs, and recent voice-session carryover.

- Thread the new identity and curated-memory layers through voice prompts and realtime instruction refreshes.
- Treat warm memory snapshots as frozen slices with explicit invalidation.
- Keep voice session summaries separate from durable facts and curated memory.
- Add dashboard/debug visibility into realtime instruction memory counts and refresh reasons.
- Tests: warm memory invalidates on memory write/topic drift/participant change, owner-private memory does not appear in guild voice instructions, realtime refresh does not mutate an in-flight turn slice.

### Phase 4: Project/Task/Swarm Scopes

Status: shipped for durable `project`, `task`, `swarm`, and `collaborator` fact scopes plus explicit memory-tool namespaces.

- Durable facts use explicit `project`, `task`, `swarm`, and `collaborator` scopes in the existing SQLite fact table.
- Namespace resolution handles project/task/swarm/collaborator writes and searches.
- Coding/task contexts retrieve scoped work memory before worker dispatch.
- Tests cover scope isolation and namespace forwarding.

### Phase 5: Swarm Memory Contract

Status: shipped for parent-built work-memory launch bundles, structured handoff annotations, and parent-side successful handoff persistence into scoped work memory.

- Parent-built task memory bundles load scoped project/task/swarm/collaborator facts for swarm launches.
- Workers emit structured handoff annotations before successful completion.
- Parent-side successful handoff persistence stores outcomes into task/project/swarm memory and collaborator memory when a requesting user is present.
- Existing plain-text worker result behavior remains intact.
- Tests cover scope isolation, work-memory launch retrieval, handoff parsing, and handoff storage.

### Phase 6: Promotion And Curation

- Add promotion candidate generation.
- Add dashboard review queue.
- Add write path to curated files.
- Add audit trail and rollback.

## Risks

- Over-injecting curated memory could make Clanky feel less socially natural.
- Bad scope gates could leak owner/project memory into public contexts.
- Adding too many tiers could make prompt assembly hard to reason about.
- Promotion could turn stale preferences into hidden policy if not constrained.
- Swarm memory could become noisy if raw handoffs are promoted instead of distilled.
- Realtime voice refreshes could appear to mutate context mid-turn unless refresh boundaries are explicit.
- Background review could save facts that came from injected context rather than the user's clean input unless provenance is tracked.
- Failed or interrupted worker runs could pollute project memory if task completion is not part of the write gate.

## Non-Goals

- Do not replace `memory_facts` with markdown files.
- Do not make `SOUL.md` a dumping ground for project or owner-private facts.
- Do not load owner-private curated memory in guild/public contexts.
- Do not make subagents write directly into broad social memory.
- Do not require semantic retrieval for the highest-priority assistant preferences.
- Do not treat warm voice memory, session summaries, or worker logs as curated always-on memory.
- Do not change the swarm worker result contract without versioning the worker contract and launcher prompt together.

## Success Criteria

- Clanky's public Discord behavior remains socially continuous and natural.
- Owner-private assistant behavior becomes more reliable across sessions.
- Coding/subagent work gets durable project/task continuity without polluting social memory.
- Operators can inspect identity, curated memory, retrieved memory, and prompt slices separately.
- Memory writes affect future turns predictably, not the current prompt mid-stream.
- Interrupted turns and failed workers do not become durable memory by default.
- Voice/realtime memory stays low-latency while preserving the same scope and privacy guarantees as text prompts.
