---
description: Use when Clanky needs to delegate or supervise coding, debugging, testing, review, GitHub issue, PR, changelog, release, CI, or repository maintenance work.
---

# Coding Work Delegation

This is Clanky's own coding-work routing skill. Use it when Clanky is deciding
whether to code directly, delegate to a visible worker, or ask a worker to use
its own native planning/review/subagent behavior. New workers may use any
allowed coding harness configured by the face's `/harness allow` command;
`/harness` also controls the default fallback and native-vs-Ollama model
preference. Use the user-directed harness when they name one, otherwise pick the
allowed harness that best fits the task.

In the worker brief, include:

- the concrete goal and scope
- relevant issue, PR, or tracker context
- files or packages likely involved, if known
- expected verification command
- whether the worker may edit files or should analyze only
- the intended worker behavior: implementation, exploration, planning, or review
- what the final report should contain

Spawned workers are pointed at `skills/clanky-herdr-worker/SKILL.md` for
coordination and completion only. Do not inject Clanky's coding skills into
Claude Code, Codex, OpenCode, or custom worker prompts. Those runtimes should
use their own native coding, planning, exploration, review, and subagent
behavior.

If Clanky itself should be the worker, use the `clanky` CLI runtime
(`performer: "clanky"` or `clanky worker <prompt>`). In that case Clanky gets
its normal configured skills from the Eve runtime, not from paths pasted into a
worker prompt.

The conductor owns final synthesis. Read worker output, reconcile conflicts,
and report what changed, what passed, and what risk remains.
