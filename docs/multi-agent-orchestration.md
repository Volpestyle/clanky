# Dual-Agent Orchestration Spec

Status: **Draft**

## Overview

Clanker is an autonomous software engineer. He has tools — browser, search, memory, code agents — and he composes them to accomplish tasks. This spec adds structured dual-agent collaboration: using two coding agents (Claude Code + Codex) together, with Clanker's brain as the mediator.

Two collaboration modes, one escalation path:

```
Solo ──── (non-trivial task) ───→ Review ──── (stuck/failing) ───→ Debate
 │                                  │                                │
 single agent                  implement + review              parallel implement
 Clanker guides               cross-reference commits          brain picks winner
```

---

## Testing Philosophy

**E2E tests in a controlled environment are strongly preferred.**

Clanker treats tests as his verification mechanism — without them, he's coding blind. The hierarchy:

1. **E2E tests first.** Write or identify a failing E2E test that reproduces the problem in a controlled environment before writing the fix. This is the source of truth.
2. **Unit tests as supplement.** Fine for pure logic, but E2E is what proves the system actually works.
3. **Tests are the judge.** In review mode, the reviewer runs the test suite. In debate mode, passing E2E tests is the primary tiebreaker between agents.

When to skip tests:
- Typo fixes, config changes, documentation
- When the user explicitly says to skip them

When tests are mandatory:
- Bug fixes (reproduce first, then fix)
- New features (define behavior with E2E tests)
- Debate mode (tests settle the argument)
- Any change touching voice subprocess, realtime clients, or agent orchestration

The brain prompt reinforces this:

> Before implementing a non-trivial fix, check if there's an existing E2E test that covers this behavior. If not, write one first. The test should fail before your fix and pass after. If you can't write a test, explain why.

---

## Collaboration Modes

### Solo Mode

**When:** Trivial tasks, quick fixes, exploratory work.

Single agent, Clanker prompts and guides. This is the existing `code_task` tool — no changes needed.

### Review Mode

**When:** Standard non-trivial work. This is the **default** for anything worth committing.

One agent implements, the other reviews. The brain doesn't have to manually orchestrate — `code_collab` handles the handoff.

```
Brain calls code_collab({ mode: "review", task: "..." })
    │
    ├── Phase 1: IMPLEMENT
    │   Implementer agent (Claude Code) works the task
    │   Commits changes to a branch
    │   Returns: diff, summary, test results
    │
    ├── Phase 2: REVIEW
    │   Reviewer agent (Codex) receives:
    │     - The original task description
    │     - The implementer's diff
    │     - The implementer's summary
    │     - Test results (pass/fail)
    │   Returns: review with specific feedback
    │     - Approve: "LGTM" + optional nits
    │     - Request changes: specific issues + suggested fixes
    │
    └── Brain receives both outputs
        If approved → done, report to user
        If changes requested → brain decides:
          - Send feedback to implementer for another pass
          - Override the reviewer ("nit, ship it")
          - Escalate to debate mode
```

The reviewer doesn't just rubber-stamp. Its prompt emphasizes:

> You are reviewing another agent's implementation. Be critical. Check for:
> - Does the change actually solve the stated problem?
> - Are there edge cases the implementer missed?
> - Does it break existing E2E tests?
> - Is it over-engineered or under-engineered?
> - Would you approve this PR from a junior engineer?

### Debate Mode

**When:** Stubborn bugs, stuck agents, user-requested second opinion.

Both agents implement in parallel. Clanker reads both outputs, cross-pollinates findings, and picks the winner. This is the escalation path when solo or review mode isn't cutting it.

```
Brain calls code_collab({ mode: "debate", task: "..." })
    │
    ├── Both agents receive the same task simultaneously
    │   ├── Agent A (Claude Code): works independently
    │   └── Agent B (Codex): works independently
    │
    ├── Brain reads both results
    │   Looks for divergence — different root causes, different files, different fixes
    │
    ├── Brain bridges context (optional, iterative)
    │   "Agent A found X. Investigate that angle."
    │   "Agent B's stack trace shows Y. Does that change your diagnosis?"
    │
    └── Brain resolves
        Picks winner based on:
        1. E2E tests pass? (primary tiebreaker)
        2. Correctness of diagnosis
        3. Simplicity of fix
        4. Evidence quality (stack traces, grep output vs vibes)
```

---

## The `code_collab` Tool

Single tool, mode-based interface. Replaces the previously specced `code_debate` with a broader scope.

```typescript
{
  name: "code_collab",
  description: "Dual-agent collaboration. Two modes: 'review' (one implements, other reviews the commit) and 'debate' (both implement in parallel, you pick the winner). Use 'review' for standard non-trivial work. Use 'debate' when an agent is stuck or you need competing approaches.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["review", "debate"],
        description: "review: one agent implements, the other reviews. debate: both implement in parallel."
      },
      action: {
        type: "string",
        enum: ["start", "turn", "resolve"],
        description: "start: launch the collaboration. turn: send follow-up to one/both agents. resolve: finalize (pick winner in debate, accept/reject in review)."
      },
      task: {
        type: "string",
        description: "(start) The coding task. Be specific — include file paths, expected behavior, error messages."
      },
      target: {
        type: "string",
        enum: ["implementer", "reviewer", "claude", "codex", "both"],
        description: "(turn) Which agent to message. In review mode: 'implementer' or 'reviewer'. In debate mode: 'claude', 'codex', or 'both'."
      },
      message: {
        type: "string",
        description: "(turn) Follow-up instruction, review feedback, or cross-referenced context from the other agent."
      },
      verdict: {
        type: "string",
        enum: ["approve", "request_changes", "claude", "codex"],
        description: "(resolve) In review mode: 'approve' or 'request_changes'. In debate mode: 'claude' or 'codex'."
      },
      reason: {
        type: "string",
        description: "(resolve) Why this verdict."
      }
    },
    required: ["mode", "action"]
  }
}
```

---

## Architecture

### CollabSession

A composite session wrapping two inner `SubAgentSession` instances. Supports both review and debate workflows.

```
┌──────────────────────────────────────────────────────────────┐
│  CollabSession                                               │
│                                                              │
│  mode: "review" | "debate"                                   │
│  status: "active" | "resolved" | "cancelled"                 │
│                                                              │
│  ┌────────────────────┐    ┌────────────────────────┐        │
│  │  Agent A            │    │  Agent B               │        │
│  │  (Claude Code)      │    │  (Codex)               │        │
│  │                     │    │                        │        │
│  │  Role (review mode):│    │  Role (review mode):   │        │
│  │  IMPLEMENTER        │    │  REVIEWER              │        │
│  │                     │    │                        │        │
│  │  Role (debate mode):│    │  Role (debate mode):   │        │
│  │  CONTENDER          │    │  CONTENDER             │        │
│  └────────────────────┘    └────────────────────────┘        │
│                                                              │
│  turnHistory: CollabTurnEntry[]                              │
│  totalCostUsd: number                                        │
│  verdict: string | null                                      │
│  verdictReason: string                                       │
└──────────────────────────────────────────────────────────────┘
```

```typescript
interface CollabTurnEntry {
  turnNumber: number;
  phase: "implement" | "review" | "debate" | "followup";
  target: string;
  input: string;
  agentAResult: SubAgentTurnResult | null;
  agentBResult: SubAgentTurnResult | null;
  timestamp: number;
}

// Extends SubAgentSession type union
type: "code" | "browser" | "collab"
```

Registers with the existing `SubAgentSessionManager`. Inner sessions are managed internally.

---

## Review Mode — Detailed Flow

### `action: "start"`

1. Create inner `CodeAgentSession` (implementer — Claude Code)
2. Send `task` to implementer
3. Wait for implementation result
4. Create inner `CodexAgentSession` (reviewer — Codex)
5. Send structured review prompt to reviewer:

```
## Task
{original task}

## Implementation Summary
{implementer's text output}

## Changes Made
{diff output, if available}

## Test Results
{pass/fail output, if available}

## Your Job
Review this implementation critically. Does it solve the problem correctly?
Are there edge cases? Would the E2E tests pass? Approve or request changes.
```

6. Return both outputs to brain:

```
## REVIEW COMPLETE

### Implementation (Claude Code)
[implementer output]

### Review (Codex)
[reviewer verdict + feedback]
```

### `action: "turn"` (review mode)

Brain can send follow-ups to either agent:

- `target: "implementer"` — "The reviewer flagged X. Fix it."
- `target: "reviewer"` — "The implementer addressed your feedback. Here's the updated diff. Re-review."

This enables iterative implement → review → revise → re-review cycles without starting over.

### `action: "resolve"` (review mode)

- `verdict: "approve"` — Accept the implementation. Log and close.
- `verdict: "request_changes"` — Brain overrides the reviewer and sends specific feedback to the implementer for another pass. (Or: brain agrees with the reviewer and just wants to formally mark it.)

---

## Debate Mode — Detailed Flow

### `action: "start"`

1. Create both `CodeAgentSession` and `CodexAgentSession`
2. Send `task` to **both** concurrently (`Promise.allSettled`)
3. Collect results
4. Return structured comparison:

```
## DEBATE STARTED — 2 agents working

### Agent: Claude Code (sonnet)
[Claude's response]

### Agent: Codex (codex-mini)
[Codex's response]

### Divergence
[Points where they disagree — files, root causes, approaches]
```

### `action: "turn"` (debate mode)

Brain cross-pollinates:

```
code_collab({
  mode: "debate",
  action: "turn",
  target: "codex",
  message: "The Claude Code agent found that the issue is in voiceSubprocess.ts line 340.
            It suggests renaming the duplicate variable. Investigate that angle."
})
```

### `action: "resolve"` (debate mode)

- `verdict: "claude"` or `"codex"` — pick the winner
- Close the loser's session
- Log full debate (turns, cost breakdown, winner, reason)

---

## Auto-Escalation

The brain knows when to escalate. The system prompt teaches the progression:

```
## Agent Collaboration

You have `code_task` for solo work and `code_collab` for dual-agent collaboration.

### When to use what:

SOLO (code_task):
- Trivial fixes, typos, config changes
- Clear, well-defined tasks with obvious solutions
- Exploratory work, research

REVIEW (code_collab mode: "review"):
- Any non-trivial implementation you plan to commit
- Bug fixes (write E2E test first, then implement, then reviewer verifies)
- New features
- Refactors touching multiple files

DEBATE (code_collab mode: "debate"):
- Previous code_task or review failed
- Agent is going in circles
- User says "this is stuck", "try harder", "get a second opinion"
- Bug has burned through 2+ failed attempts
- You want competing approaches to compare

### Testing discipline:
- Before implementing a non-trivial fix, write or identify a failing E2E test
- E2E tests in controlled environments are strongly preferred over unit tests
- In review mode, the reviewer should verify tests pass
- In debate mode, passing E2E tests is the primary tiebreaker
```

---

## Implementer/Reviewer Agent Assignment

By default:
- **Implementer:** Claude Code (better at writing code, has filesystem access)
- **Reviewer:** Codex (fresh perspective, no shared context with implementer)

This can be flipped via settings. The point is that they're different agents with different blind spots — that's the value.

In debate mode, both are contenders. No role distinction.

### Fallback (no Codex available)

If `OPENAI_API_KEY` is not set or Codex is unavailable:
- Use two Claude Code sessions with different models
- e.g., implementer = `sonnet`, reviewer = `opus`
- Or in debate: contender A = `sonnet`, contender B = `opus`

---

## Limits & Safety

| Concern | Mitigation |
|---------|------------|
| Double cost | Combined cost tracked per collab session. Each agent turn counts toward `maxTasksPerHour` |
| Runaway collaboration | Max 10 turns per collab session (configurable). Auto-resolve after limit |
| Parallel resource usage | Collab counts as 2 active tasks against `maxParallelTasks` |
| Idle sessions | Normal `SubAgentSessionManager` sweep closes after 5 min idle |
| No Codex available | Fall back to two Claude Code sessions with different models |
| Infinite review loop | Max 3 implement→review cycles. After that, brain must resolve or escalate |

### Settings

```typescript
codeAgent: {
  // ...existing fields...
  collab: {
    enabled: true,                    // master switch
    maxCollabTurns: 10,               // auto-resolve after N turns
    maxReviewCycles: 3,               // max implement→review→revise cycles
    fallbackToModelSplit: true,       // two Claude models if no Codex
    fallbackModelA: "sonnet",
    fallbackModelB: "opus",
    defaultImplementer: "claude",     // which agent implements by default
    defaultReviewer: "codex",         // which agent reviews by default
  }
}
```

---

## Logging

Every collab session is logged with full metadata:

```typescript
store.logAction({
  kind: "code_collab_resolved",
  guildId, channelId, userId,
  content: originalTask.slice(0, 200),
  metadata: {
    collabSessionId: session.id,
    mode: session.mode,                   // "review" | "debate"
    totalTurns: session.turnHistory.length,
    verdict: session.verdict,
    verdictReason: session.verdictReason,
    agentACostUsd: agentA.totalCostUsd,
    agentBCostUsd: agentB.totalCostUsd,
    source: trace.source,
    durationMs: Date.now() - session.createdAt
  },
  usdCost: session.totalCostUsd
});
```

---

## File Plan

| File | Change |
|------|--------|
| `src/agents/collabSession.ts` | **New** — `CollabSession` class, review/debate flows |
| `src/agents/subAgentSession.ts` | Extend type union with `"collab"` |
| `src/tools/replyTools.ts` | Register `code_collab` tool for text brain |
| `src/voice/voiceToolCalls.ts` | Register `code_collab` tool for voice brain |
| `src/settings/settingsSchema.ts` | Add `collab` sub-block to `codeAgent` settings |
| `src/bot/replyPipeline.ts` | Wire up `code_collab` tool execution |
| `docs/agent-debate-mode.md` | This spec |

---

## Example Flows

### Standard Feature — Review Mode

```
User: "add rate limiting to the browse agent"

Brain: calls code_collab({
  mode: "review",
  action: "start",
  task: "Add per-user rate limiting to the browse agent. Max 5 browse tasks
         per user per hour. Add an E2E test that verifies the rate limit
         triggers after 5 calls."
})

  Phase 1 — IMPLEMENT (Claude Code):
    "Added rate limiting to browseAgent.ts using a sliding window counter.
     New E2E test in tests/e2e/browseRateLimit.test.ts — passes.
     Changes: browseAgent.ts, browseRateLimit.test.ts"

  Phase 2 — REVIEW (Codex):
    "APPROVE with nits:
     - The sliding window should use the guild+user composite key, not just userId
     - The E2E test only checks the happy path — add a test for rate limit reset
     - Otherwise solid implementation"

Brain: "Implementation approved with minor feedback. Let me have the
        implementer address the nits."

Brain: calls code_collab({
  mode: "review",
  action: "turn",
  target: "implementer",
  message: "Reviewer feedback: use guild+user composite key for rate limit,
            and add an E2E test for rate limit reset."
})

  Implementer: "Fixed both — composite key and added reset test. All passing."

Brain: calls code_collab({
  mode: "review",
  action: "resolve",
  verdict: "approve",
  reason: "Implementation complete, reviewer feedback addressed, E2E tests passing."
})

Brain: "Done. Added rate limiting to the browse agent — max 5 per user per hour.
        Two E2E tests cover the limit trigger and reset. Ready to push."
```

### Stubborn Bug — Escalation to Debate

```
User: "the voice subprocess keeps crashing on join"

Brain: calls code_collab({
  mode: "review",
  action: "start",
  task: "Fix crash in voice subprocess on channel join. Write E2E test first."
})

  IMPLEMENT: "I think the issue is in the connection timeout. Added a 5s buffer."
  REVIEW: "REQUEST CHANGES — this doesn't fix the root cause. The crash stack
           shows a null dereference in music_player, not a timeout."

Brain: sends feedback to implementer, implementer tries again, still wrong.
Brain: "This isn't working. Escalating to debate."

Brain: calls code_collab({
  mode: "debate",
  action: "start",
  task: "Voice subprocess crashes on channel join. Stack trace shows null deref
         in music_player. Previous attempt to fix connection timeout didn't help.
         Write a failing E2E test that reproduces this, then fix it."
})

  Agent A: "The crash happens because music_player is None after MusicEvent::Idle
            but music_active is still true. Fixed by checking music_active || music_finishing."
  Agent B: "Root cause: the join handler accesses music_player without checking
            if audio extraction has finished. Added a guard clause."

Brain: "Both found the same root cause — music_player becomes None while music_active
        stays true. A's fix is more complete (checks music_finishing too). But let me
        make sure A's E2E test actually reproduces it."

Brain: calls code_collab({
  mode: "debate",
  action: "turn",
  target: "claude",
  message: "Run your E2E test and confirm it fails without the fix and passes with it."
})

  Agent A: "Confirmed — test fails on main, passes with fix. Here's the output: [...]"

Brain: calls code_collab({
  mode: "debate",
  action: "resolve",
  verdict: "claude",
  reason: "Both found root cause, but Claude's fix covers the music_finishing edge case
           and has a verified failing→passing E2E test."
})
```

### Quick Convergence — Early Exit

```
Brain: calls code_collab({ mode: "debate", action: "start", task: "..." })

  Agent A: "Add null check on line 42."
  Agent B: "Add null check on line 42."

Brain: "Both agree. No debate needed."
Brain: calls code_collab({
  mode: "debate",
  action: "resolve",
  verdict: "claude",
  reason: "Both converged on identical fix."
})
```

---

## Non-Goals

- **Agent-to-agent direct communication.** The brain is always the mediator. Agents never see each other's raw output — only what the brain relays.
- **Automatic winner selection.** The brain (LLM) always makes the judgment call. No algorithmic scoring.
- **More than 2 agents.** Two is the right number. Three adds noise.
- **Collab for non-code tasks.** Scoped to coding agents. Browser and memory don't need this.
- **Persistent review relationships.** Each collab session is independent. No "always have Codex review Claude's work" — the brain decides per-task.
