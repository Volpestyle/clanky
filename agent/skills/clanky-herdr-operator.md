---
description: Use when Clanky needs to fan out, monitor, unblock, or summarize visible Herdr workers named clanky:<slug>.
---

# Clanky Herdr Operator

Load this skill before calling `herdr_spawn` to create a visible performer pane.
Use the generic `herdr` skill for status/read/send-only work.

Use visible Herdr workers for work that benefits from parallelism, inspection,
or human steering. Do not use hidden Eve subagents for watchable coding work.

## Spawn

Create one worker per independent task with `herdr_spawn`.

- Use a lowercase kebab slug. The worker name will be `clanky:<slug>`.
- Omit `cwd` to use Clanky's current host repo, or put a real host path in
  `cwd` when the task belongs to a different checkout. Never use sandbox paths
  like `/workspace`.
- Give the worker a complete brief: context, exact scope, verification command,
  and what to report back.
- Use `claude` or `codex` unless the user explicitly wants a custom command.
- Do not pass `command` for normal `claude` or `codex` performers. `command` is
  only for a full custom argv override; never pass `command: []`.
- Spawned workers receive a short bootstrap that points them at
  `skills/clanky-herdr-worker/SKILL.md`. Keep worker-side coordination details
  in that skill rather than inlining them into every task.

## Monitor

Use `herdr_status` to list workers. For any worker that looks blocked, idle, or
done, use `herdr_read` with `source: "recent"` first and `source: "visible"` if
you need to see the current TUI state.

## Unblock

Use `herdr_send` to answer worker prompts or steer a worker. Prefer addressing a
named worker by `agent`; use `pane` only after re-reading status and confirming
the current pane id. To submit a prompt in one call, pass both `text` and
`keys: ["Enter"]`; keys-only sends such as `keys: ["Enter"]` are valid.

Workers can message each other from inside their pane with the Herdr CLI. For a
submitted prompt, they should resolve the target pane and use `herdr pane run`;
`herdr agent send` writes literal text only.

## Synthesize

The conductor owns the final answer. Read each worker's output, reconcile
conflicts, and attribute the useful work by slug. Clean summaries beat raw logs.
