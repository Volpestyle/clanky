---
description: Use when Clanky needs to fan out, monitor, unblock, or summarize visible Herdr workers named clanky:<slug>.
---

# Clanky Herdr Operator

Load this skill before calling `herdr_spawn` to create a visible performer pane.
Use the generic `herdr` skill for status/read/send-only work.

Use visible Herdr workers for work that benefits from parallelism, inspection,
or human steering. Do not use hidden Eve subagents for watchable coding work.

## Spawn

Create one worker per independent task with `herdr_spawn`. Independent means
**write-disjoint**: workers fanned out together must not write the same files,
and a read-only worker must never audit files another worker in the run is
creating. If tasks share mutable paths, sequence them (separate runs or a
`blocked` handoff) or isolate each writer in its own git worktree.

- Use a lowercase kebab slug. The worker name will be `clanky:<slug>`.
- Omit `cwd` to use Clanky's current host repo, or put a real host path in
  `cwd` when the task belongs to a different checkout. Never use sandbox paths
  like `/workspace`.
- Give the worker a complete brief: context, exact scope, verification command,
  and what to report back.
- Check `herdr_status.codingHarnesses` when choosing worker runtimes; it shows
  the allowed harnesses and launcher profiles.
- Use `harness: "clanky"`, `"claude"`, `"codex"`, `"opencode"`, or `"custom"`
  for every spawn. Use `performer` only as a lower-level override.
- `/harness allow` controls the allowed set. `/harness` also controls
  native-vs-Ollama launch models for Claude, Codex, and OpenCode workers; Codex
  Ollama mode is the CLI integration, not the app.
- Do not pass `command` for normal harnesses. `command` is only for a full
  custom argv override; never pass `command: []`.
- Spawned workers receive a short bootstrap that points them at
  `skills/clanky-herdr-worker/SKILL.md` for coordination and completion only.
- Do not inject Clanky's coding skills into Claude Code, Codex, OpenCode, or
  custom worker prompts. Those runtimes should use their own native coding,
  planning, exploration, review, and subagent behavior.
- Use `performer: "clanky"` only when the worker should be Clanky himself, via
  the installed `clanky worker` CLI.

## Monitor

Use `herdr_status` to list workers. For any worker that looks blocked, idle, or
done, use `herdr_read` with the default `source: "auto"` first so durable
transcripts are preferred. Use `source: "visible"` when you need the exact
current TUI state.

## Unblock

Use `herdr_send` to answer worker prompts or steer a worker. Prefer addressing a
named worker by `agent`; use `pane` only after re-reading status and confirming
the current pane id. Before steering, confirm the worker is still running: a
worker with `agent_status: done` is finished, and a bundled operator-run worker
that already wrote a `DONE` sentinel is finished too. Re-prompting either wastes
a turn.
Pane reads and status lag the sentinel. To submit a prompt in one call, pass both `text` and
`keys: ["Enter"]`; keys-only sends such as `keys: ["Enter"]` are valid.

Workers can message each other from inside their pane with the Herdr CLI. For a
submitted prompt, they should resolve the target pane and use `herdr pane run`;
`herdr agent send` writes literal text only.

## Synthesize

The conductor owns the final answer. Read each worker's output, reconcile
conflicts, and attribute the useful work by slug. Clean summaries beat raw logs.
When workers analyzed overlapping scope, fold their results into one
implementation task and spawn that as a single edit-capable worker — do not send
each analyzer off to implement its own plan, since their edits collide.
