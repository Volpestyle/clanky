---
description: Use when Clanky needs to fan out, monitor, unblock, or summarize visible Herdr workers named clanky:<slug>.
---

# Clanky Herdr Operator

Use visible Herdr workers for work that benefits from parallelism, inspection,
or human steering. Do not use hidden Eve subagents for watchable coding work.

## Spawn

Create one worker per independent task with `herdr_spawn`.

- Use a lowercase kebab slug. The worker name will be `clanky:<slug>`.
- Put the repo path in `cwd` when the task belongs to a specific checkout.
- Give the worker a complete brief: context, exact scope, verification command,
  and what to report back.
- Use `claude` or `codex` unless the user explicitly wants a custom command.

## Monitor

Use `herdr_status` to list workers. For any worker that looks blocked, idle, or
done, use `herdr_read` with `source: "recent"` first and `source: "visible"` if
you need to see the current TUI state.

## Unblock

Use `herdr_send` to answer worker prompts or steer a worker. Prefer addressing a
named worker by `agent`; use `pane` only after re-reading status and confirming
the current pane id.

## Synthesize

The conductor owns the final answer. Read each worker's output, reconcile
conflicts, and attribute the useful work by slug. Clean summaries beat raw logs.
