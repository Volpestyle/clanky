# Product Spec: Self-Improving Bot Agent

**Status:** Draft / Exploration
**Date:** March 6, 2026

---

## One-liner

Clanker Conk can observe its own runtime behavior, identify problems, write fixes, and propose changes to its own codebase — as a natural extension of its conversational capabilities.

---

## Why this is different

Every coding agent (OpenClaw, Devin, Codex, Claude Code) is a tool you point at a repo. You provide the intent, the context, and the judgment. The agent writes code.

Clanker Conk is already running. It already has:
- Structured runtime logs with per-action cost, latency, and error tracking
- User interaction context (who said what, when, in what channel)
- Settings and configuration state
- Multi-turn agent sessions (code + browser) accessible from voice and text

The differentiator isn't "a bot that can code." It's **a bot whose coding capability is pointed at itself, informed by its own lived experience, and accessible through the same conversational interface users already use.**

You don't open a separate tool. You say "that music skip thing is broken again" and the bot already knows what you mean because it was there when it happened.

---

## Core capability

A new agent type — **self-improvement agent** — that can:

1. **Observe:** Monitor runtime action logs for anomalies (error rates, latency spikes, repeated failures)
2. **Investigate:** Read its own source code, trace error paths, identify root causes
3. **Plan:** Decompose fixes into scoped changes with file ownership boundaries
4. **Execute:** Spin up code agent sessions to write the fix
5. **Verify:** Run typecheck + tests to validate the change
6. **Propose:** Open a PR or present a diff for human approval
7. **Report:** Explain what it did, conversationally, in the channel where the issue was raised

---

## What already exists

| Capability | Current state | Gap |
|------------|--------------|-----|
| Runtime logging | `RuntimeActionLogger` — structured NDJSON with agent tagging, cost, error tracking | Need anomaly detection / pattern recognition layer |
| Code execution | `CodeAgentSession` (Claude Code CLI) + `CodexAgentSession` (OpenAI Responses API) | Need git operations as tool capability |
| Multi-turn sessions | `SubAgentSession` interface with `runTurn()`, managed by `SubAgentSessionManager` | Need a "planner" session type that orchestrates other sessions |
| Voice integration | `executeVoiceCodeTaskTool` bridges voice commands to code agents | Need "investigate this error" and "fix this" voice intents |
| Automation engine | Store-driven scheduled tasks with LLM generation + tool loops | Could drive periodic self-audits |
| Test runner | `bun run typecheck && bun run test` | Need as a tool callable by agents |
| Git | Not currently a tool | Need: branch, commit, diff, PR creation |

---

## Architecture

### New components

**1. `SelfImprovementAgent`** (new SubAgentSession type)

Orchestrator that coordinates the observe-investigate-plan-execute-verify loop. Uses existing `CodeAgentSession` as its execution backend. Holds a planner LLM context for reasoning about the codebase.

```
┌─────────────────────────────────────────────┐
│              SelfImprovementAgent            │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Observer  │→ │ Planner  │→ │ Executor  │ │
│  │ (logs)   │  │ (LLM)    │  │ (code     │ │
│  │          │  │          │  │  agent)    │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       ↑                           │         │
│       └───── verify (test) ───────┘         │
└─────────────────────────────────────────────┘
```

**2. Runtime anomaly detection** (lightweight, rules-based)

Not an LLM call — a simple monitor that watches the action log stream:
- Error rate exceeding threshold for a given `kind` (e.g., `voice_tool_call` failing >30% in a 10-min window)
- Repeated identical errors (same stack trace / error message N times)
- Latency regression (p95 for a `kind` jumps >2x vs rolling baseline)

When triggered, emits an event that the SelfImprovementAgent can pick up. This is the "notice" step — deterministic, cheap, no LLM needed.

**3. Git tool capability**

New tool functions callable by code agents:
- `git_branch_create` — create and checkout a branch
- `git_commit` — stage + commit with message
- `git_diff` — show current changes
- `git_pr_create` — open a PR via `gh` CLI

These are thin wrappers around shell commands, gated by the same permission system as code agents (`devPermissions.allowedUserIds`).

**4. Test runner tool**

- `run_typecheck` — `bun run typecheck`, returns pass/fail + error output
- `run_tests` — `bun run test`, returns pass/fail + failure details

---

## Interaction patterns

### Pattern 1: User-initiated fix request (voice or text)

```
User (voice): "Hey, the web search tool keeps timing out"
Bot: "I've seen 4 timeouts in the last hour from web_search, all
      from the Brave provider. Let me look into it."
      [spins up SelfImprovementAgent]
Bot: "Found it — the retry logic in search.ts isn't handling
      Brave's new 429 rate limit header. I wrote a fix and tests
      pass. PR is up: github.com/Volpestyle/clanker_conk/pull/47"
User: "Nice, ship it"
Bot: [merges PR]
```

### Pattern 2: Self-initiated investigation (automation-driven)

```
[Anomaly detector fires: voice_tool_call error rate 40% over 15 min]
Bot (in designated dev channel): "Heads up — voice tool calls have
      been failing at 40% for the last 15 minutes. Mostly
      music_queue_add with 'queue state undefined'. Investigating."
      [spins up SelfImprovementAgent]
Bot: "Root cause: race condition in queue-next when skip is called
      during track loading. Fix ready, PR #48. Tests pass.
      Want me to merge?"
```

### Pattern 3: Periodic self-audit (scheduled automation)

A scheduled automation that runs weekly/daily:
- Scans runtime logs for the past period
- Identifies recurring issues, performance regressions, unused code paths
- Produces a summary report in a dev channel
- Optionally proposes fixes for the highest-impact items

---

## Autonomy boundary

The critical design decision: what can the bot do without human approval?

| Action | Autonomy level |
|--------|---------------|
| Observe + investigate | Full autonomy (no side effects) |
| Write a fix + run tests | Full autonomy (sandboxed, no deployment) |
| Open a PR | Full autonomy (low risk, visible, reviewable) |
| Merge a PR | **Requires human approval** (explicit "ship it" or equivalent) |
| Deploy | **Out of scope** (handled by existing CI/CD) |
| Self-modify without tests passing | **Never** (hard guardrail) |
| Modify security-sensitive code | **Requires human approval** + explicit flag |

The bot can go all the way to "PR ready, tests passing" autonomously. The human decides whether to merge. This matches the existing `devPermissions` pattern — the allowed user list gates who can trigger code agents, and the same list gates who can approve merges.

---

## What makes this not just "a coding agent"

1. **The bot is the observer.** It doesn't need logs shipped to it — it produces them. The anomaly detector runs in-process.

2. **The bot is the reporter.** It tells you about issues in the same channel you're already in. No context switch to a dashboard, a terminal, or a separate tool.

3. **The bot remembers.** Its memory system (`MemoryManager`) can track "I fixed this class of bug before" and apply learned patterns. A pure coding agent starts fresh every time.

4. **The bot has taste.** Its settings, persona, and behavioral directives shape how it communicates about code changes. It's not a generic PR description — it's the same entity you've been talking to.

5. **The feedback loop is continuous.** Fix goes in → bot observes runtime behavior post-fix → confirms the fix worked or flags a regression. No human needs to check metrics.

---

## Implementation phases

### Phase 0: Git + test runner tools
- Add git tool functions (branch, commit, diff, PR) to the code agent's tool set
- Add test runner tools (typecheck, test)
- Gate behind `devPermissions`
- **Effort:** Small. Shell command wrappers + tool definitions.

### Phase 1: User-initiated self-fix
- New voice/text intent: "fix this" / "investigate this error"
- Spins up SelfImprovementAgent with the user's description + recent relevant logs
- Agent reads code, writes fix, runs tests, opens PR
- Reports back conversationally
- **Effort:** Medium. New agent type, new voice tool, planner prompt engineering.

### Phase 2: Anomaly detection + self-initiated investigation
- Runtime anomaly detector (error rate, latency regression, repeated failures)
- Auto-triggers SelfImprovementAgent when thresholds are exceeded
- Reports to designated dev channel
- **Effort:** Medium. Anomaly detection is straightforward; the LLM investigation/fix pipeline reuses Phase 1.

### Phase 3: Periodic self-audit
- Scheduled automation: weekly codebase health scan
- Uses planner-grade LLM (Opus) to review runtime patterns, code quality, test coverage gaps
- Produces actionable report with optional auto-fix proposals
- **Effort:** Medium. Builds on Phase 2 + existing automation engine.

### Phase 4: Multi-agent orchestration
- The planner can spin up parallel code agent sessions (like Codex worktrees)
- File ownership boundaries enforced programmatically
- Sequential merge with automated conflict resolution for trivial conflicts (import paths)
- **Effort:** Large. This is the full loop — what we're doing manually right now, automated.

---

## Open questions

1. **Model selection for planner vs executor.** The planner needs deep reasoning (Opus-class). The executor needs fast code generation (Sonnet/Codex-class). Should these be configurable per-guild, or hardcoded?

2. **Scope boundaries.** Should the bot only be able to modify its own repo? Or could it work on other repos the user grants access to? (The latter makes it a general coding agent again — maybe that's fine as a secondary capability.)

3. **Cost management.** Self-improvement runs burn tokens. Should there be a daily/weekly budget cap? Should the bot report its own improvement costs in the dev channel?

4. **Conflict with manual development.** If a human is actively developing (like we are now), the bot's self-improvement could conflict. Need a "dev mode" flag that pauses autonomous improvement.

5. **Testing the self-improver.** How do you test a system that modifies its own code? Probably: snapshot the repo, run the agent in a sandbox, verify the diff is clean and tests pass. But the anomaly detection + investigation path is harder to test without synthetic failure injection.
