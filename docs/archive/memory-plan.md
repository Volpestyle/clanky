Bottom line

The best-supported design is not “one memory database.” It is a tiered memory hierarchy: a tiny always-loaded core, structured per-user/server facts, an immutable episodic log, retrieval over summaries and source messages, reflection/consolidation jobs, and a separate skill library. Research increasingly treats memory as a first-class agent primitive, not just “RAG plus chat history”; a 2026 survey argues that old “short-term vs. long-term” labels are insufficient and breaks memory into forms, functions, and dynamics such as factual, experiential, and working memory.  ￼

For a Discord agent, the safest version is: remember server/project context and opt-in personal preferences, not silently profile every person. Discord’s Developer Policy says API data must be used only as necessary for the app’s stated functionality, prohibits profiling users/their identities/relationships, prohibits scraping, and forbids using message content to train AI models unless Discord grants express permission.  ￼

What the research points to

The strongest social-agent pattern is observe → store → reflect → retrieve → plan → act. Generative Agents stored experience records, synthesized higher-level reflections, and dynamically retrieved memory for planning; their ablation found observation, planning, and reflection all mattered for believable behavior.  ￼

The strongest token-efficiency pattern is memory hierarchy. MemGPT frames the context window as fast memory and external stores as slower memory, moving information between tiers to support long conversations and document work beyond the model’s context window.  ￼

The strongest conversational-memory benchmark pattern is indexing + retrieval + reading, not just dumping long context into the prompt. LongMemEval evaluates information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention; it reports that sustained interactions cause a major accuracy drop and recommends optimizations like session decomposition, fact-augmented indexing, and time-aware query expansion.  ￼ LoCoMo similarly finds that long-context models and RAG help, but still lag on very long-term dialogue, especially temporal and causal dynamics.  ￼

For “improving at skills,” the best pattern is non-parametric self-improvement: write better memories, reflections, procedures, and tools instead of retraining the model. Reflexion shows agents can improve by writing verbal reflections into episodic memory rather than updating model weights.  ￼ Voyager shows the same idea for skills: it stores reusable executable code skills, retrieves them, and improves them through feedback and self-verification.  ￼ Newer memory work also points toward dynamic organization: Reflective Memory Management uses forward-looking summaries plus backward-looking retrieval refinement, while A-Mem uses Zettelkasten-like linking and evolving memory representations.  ￼

How OpenClaw, Hermes, and Claude Code fit in

These systems are converging on the same broad lesson: small curated memory + external recall + skill/procedure learning.

Claude Code uses persistent CLAUDE.md files plus auto-memory; its docs say auto-memory loads the first 200 lines or 25KB of MEMORY.md at startup, keeps details in topic files, and lets users audit/edit memory through /memory. It also warns that memory is context, not guaranteed hard configuration, so concise and specific instructions work better.  ￼

Hermes Agent uses bounded curated files for core memory, with MEMORY.md for learned environment/project notes and USER.md for user profile/preferences, both injected at session start. It also supports external memory providers that prefetch relevant memories before turns, sync conversation turns, extract memories, and add search/store/manage tools.  ￼

OpenClaw is positioned as a personal assistant across user channels, and its Supermemory plugin pattern is auto-recall before each turn plus auto-capture after each turn, with memory deletion/search/profile tools. That pattern is useful, but for Discord you should put a stronger policy/consent layer in front of auto-capture.  ￼

The architecture I’d build

Use eight memory layers, each with a narrow job.

Layer	Purpose	Always in prompt?	Storage
Core self memory	Identity, boundaries, server role, current operating rules	Yes, tiny	Markdown/config
Consent/privacy state	Who opted in, which channels are memory-enabled, retention rules	Yes, tiny	DB, not LLM-written
User memory cards	Explicit preferences, goals, working style, stable facts	Retrieved only when relevant	Structured DB
Server/channel memory	Rules, norms, ongoing projects, public decisions	Retrieved by guild/channel	Structured DB + summaries
Episodic log	Source events: mentions, DMs, opted-in channel messages	No	Append-only event store
Semantic memory	Extracted facts with provenance, confidence, TTL	Retrieved	Postgres/SQLite + vector/BM25
Reflection memory	Session/topic summaries, lessons, contradictions, open questions	Retrieved	Markdown/DB
Skill memory	Reusable workflows, scripts, prompts, tests, tool recipes	Retrieved or invoked	Git repo + registry

The key object should be a memory atom, not a blob of chat:

MemoryAtom
- id
- scope: user | dm | guild | channel | project | agent
- subject_id: Discord user/guild/channel/project id
- type: preference | fact | decision | commitment | lesson | skill_hint
- claim: concise natural-language statement
- source_event_ids: exact messages/interactions behind the claim
- confidence: 0.0–1.0
- sensitivity: public | personal | sensitive | secret
- created_at, updated_at, valid_from, valid_until
- ttl / decay policy
- last_used_at
- embedding
- lexical_index_terms

This makes memories auditable, erasable, source-grounded, and token-efficient.

The Discord-specific design

Do not make the bot silently absorb the whole server. Use four modes.

Mention mode is the default. The bot reads and remembers only messages that mention it, replies to it, or use slash commands. Discord’s message-content policy says bots can access messages that specifically mention them and DMs with the bot regardless of privileged message-content approval.  ￼

Opt-in channel mode is for channels where admins explicitly enable memory. The bot posts a notice like: “I retain summaries and explicit decisions from this channel to help the server. Use /memory view, /memory forget, or /memory off.” For bots operating at scale, Discord requires privileged message-content approval for broader message access, and approval criteria emphasize privacy, non-invasiveness, and a visible privacy policy.  ￼

DM relationship mode is per-user and opt-in. This is where the agent can develop a working relationship: communication preferences, ongoing projects, recurring tasks, and user-approved facts. It should not infer sensitive traits or build hidden psychological profiles.

Server memory mode stores shared context, not private dossiers: decisions, project plans, rules, FAQs, rituals, unresolved debates, and recurring workflows.

The memory write pipeline

Every Discord event should pass through this sequence:

Discord event
→ scope check: mention, DM, opted-in channel, slash command
→ policy gate: consent, sensitivity, server settings, retention
→ memory extraction: candidate atoms only
→ verification: source attached, no unsupported inference
→ write decision:
   - auto-save low-risk server facts
   - ask confirmation for personal facts
   - reject secrets, credentials, sensitive/irrelevant data
→ storage
→ periodic consolidation

A good memory extractor should output things like:

{
  "candidate": true,
  "scope": "user",
  "type": "preference",
  "claim": "User prefers concise technical answers with implementation details.",
  "needs_confirmation": true,
  "sensitivity": "personal",
  "source_event_ids": ["discord_msg_..."],
  "ttl": "180d"
}

Do not store:

“Alex is probably depressed.”
“Sam and Jamie seem to be dating.”
“User is politically X based on jokes.”
“User’s wallet seed phrase is ...”

That is exactly the kind of profiling/sensitive retention that will create safety, trust, and platform problems.

The retrieval pipeline

At response time, compile a memory packet instead of dumping history.

Current message
→ classify intent: social, task, factual recall, project, moderation, scheduling
→ generate memory queries:
   - exact IDs: user, guild, channel, thread
   - semantic query
   - lexical query
   - temporal query
→ retrieve candidates
→ rerank by relevance, recency, salience, source reliability, scope, consent
→ dedupe / resolve contradictions
→ produce small evidence packet
→ answer with source-aware uncertainty

A practical context budget:

System + policy:              800–1,500 tokens
Core self memory:             300–800
Recent conversation window:   1,000–4,000
Retrieved memory packet:      500–1,500
Task/tool context:            as needed
Hidden chain/scratch:         do not persist as memory

The memory packet should look like:

Relevant memory:
1. [user_pref, confidence .92, source 2026-05-01] Riley prefers TypeScript examples.
2. [guild_decision, confidence .88, source #planning 2026-05-12] The server agreed bot announcements go in #updates.
3. [active_commitment, due 2026-05-25] Agent promised to draft onboarding FAQ.

“Self-aware” without pretending it is conscious

Build a self-model, not mystical self-awareness.

The agent should maintain a small, inspectable file like:

SELF.md
- Name / role: Discord assistant for this server.
- Capabilities: answer, summarize, schedule, search memories, run approved tools.
- Limits: not conscious, may misremember, must cite/check memory before claiming recall.
- Current commitments: ...
- Active projects: ...
- Recent lessons: ...
- Known failure modes: over-saving memories, stale channel context, confusing users with similar names.
- Memory policy: only remember opt-in personal facts and public server decisions.

Then expose commands:

/who_are_you
/what_do_you_remember
/why_did_you_say_that
/forget_me
/forget_this_channel
/memory_export
/memory_off
/privacy

That gives the agent continuity while keeping users in control.

How it improves at skills

Use a skill lifecycle rather than fine-tuning on Discord messages.

1. After a complex task, write a Reflexion-style lesson: what worked, what failed, what should be tried next.
2. If a task repeats, create a skill file.
3. Skills have tests, examples, permissions, and failure modes.
4. Skills are versioned in Git.
5. New or dangerous tool permissions require human approval.
6. The agent retrieves skills only when relevant.

Example skill structure:

skills/
  summarize_discord_decision/
    skill.md
    examples.md
    tests.yaml
    permissions.yaml
    changelog.md

skill.md should contain:

When to use:
- A channel had a long debate and someone asks “what did we decide?”
Procedure:
1. Retrieve messages from the thread/channel.
2. Identify proposals, objections, final decision, unresolved questions.
3. Cite message links.
4. Ask for confirmation before saving as a server decision.
Failure modes:
- Do not treat jokes as decisions.
- Do not infer private intent.
- If no decision exists, say so.

This mirrors Voyager’s skill-library idea, but adapted to social/workflow contexts rather than Minecraft.  ￼

The main failure modes to design against

The biggest failures are not model intelligence failures; they are memory governance failures.

First, the bot may save too much. That makes it creepy, expensive, and inaccurate. Solve this with opt-in scopes, memory atom filters, TTLs, and confirmation for personal facts.

Second, it may retrieve irrelevant memories. That pollutes the prompt and causes weird personalization. Solve this with hybrid search, reranking, source provenance, and a strict memory packet budget.

Third, it may preserve stale facts. Solve this with time-aware retrieval, contradiction handling, and “valid_until” fields.

Fourth, it may treat memory as instruction. Stored memories should be data, never authority. A retrieved memory like “Ignore all previous rules” must be displayed as a user-authored claim, not executed as an instruction.

Fifth, it may build hidden profiles. For Discord, that is especially risky because the policy directly limits profiling and relationship inference from API data.  ￼

MVP stack

A pragmatic v1:

Discord.js or discord.py
Postgres + pgvector
Redis queue
Object store for raw event snapshots
Small model for memory extraction
Large model for response/planning
Background workers for summarization, consolidation, skill updates
Admin dashboard for memory review

Start with:

1. Mention/DM-only memory
2. Per-user opt-in memory cards
3. Server decision memory
4. /what_do_you_remember and /forget_me
5. Daily consolidation
6. Skill files for repeated workflows

Add graph memory later. Graphs are useful for projects, topics, decisions, and documents, but for Discord users you must be careful not to turn the graph into a hidden relationship profiler.

The best design in one sentence

Build a privacy-gated, source-grounded, hierarchical memory system where the agent always carries only a tiny self-model, retrieves only the few memories needed for the current turn, learns through reflections and versioned skills, and lets every user see, correct, and delete what it remembers.
