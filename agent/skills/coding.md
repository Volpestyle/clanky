---
description: Use when Clanky needs to delegate or supervise coding, debugging, testing, review, GitHub issue, PR, changelog, release, CI, or repository maintenance work.
---

# Coding Work Delegation

This is Clanky's own coding-work routing skill. Use it when Clanky is deciding
whether to code directly, delegate to a visible worker, or ask a worker to use
its own native planning/review/subagent behavior. New workers may use any
allowed coding harness configured by the face's `/harness allow` command;
direct `/harness <id>` commands configure native-vs-Ollama model preference for
launchable harnesses. Use the user-directed harness when they name one,
otherwise pick the allowed harness that best fits the task and pass it
explicitly when spawning.

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

## Getting context before you delegate

You cannot read host code, PRs, or designs with your own `read_file`/`grep` —
those see only your sandbox. Gather context as data first, then decide whether a
worker is even needed:

- **Issues and work status** — your work-tracker connection (Linear) via
  `connection_search`. Read the ticket, acceptance criteria, and comments
  directly; no pane.
- **Designs and specs** — your design connection (Figma) via `connection_search`.
- **Branches, PRs, diffs, review comments (GitHub)** — no curated connection is
  bound yet, so read version-control state by spawning a short worker that runs
  `gh`/`git` in the host checkout (e.g. `gh pr view <n>`, `gh pr diff <n>`) and
  reports back. A read-only GitHub connection for this context lane is planned
  (ADR-0003); prefer it once it lands.

If a connection returns `needsAuthorization: true`, stop and say it needs
authorization — do not fall back to guessed dynamic MCP.

## Reviewing PRs and pulling branches / worktrees

Reviewing or working a PR is the work lane: it needs a host shell in a real
checkout. `herdr_spawn` does not clone — its `cwd` must be an existing host repo
(Clanky's own cwd, or another checkout under the host repos root, e.g.
`~/dev/<repo>`). Recipe:

- Spawn a worker with `cwd` set to the target checkout and a brief that names the
  PR/branch. Have it `git fetch` and, when the PR should land as its own branch,
  `git worktree add ../<repo>-pr-<n> origin/<branch>` so the review is isolated
  from other workers (see `clanky-herdr-operator` for write-disjoint / worktree
  rules).
- For review-only, tell the worker to analyze and not edit; have it report the
  diff summary, risks, and a verdict. For fixes, let it edit in the worktree.
- You own the branch/PR lifecycle: capture branch, worktree path, PR URL, and
  review status; verify the worker's result yourself before accepting; reconcile
  with trunk after it lands.
