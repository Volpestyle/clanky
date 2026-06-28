---
description: Use when Clanky needs to inspect, read, or steer the live Herdr session from the Eve host.
---

# Herdr Host Control

You are running from the Eve host process, not from inside a Herdr pane. This is
the host-control counterpart to the vanilla pane-oriented `herdr` skill bundled
under the repo-level `skills/herdr/` directory. Prefer the host tools over
shelling out:

- Use `herdr_status` to list agents, panes, tabs, and workspaces.
- Use `herdr_read` with the default `source: "auto"` to inspect worker history;
  it prefers Clanky's durable transcript and falls back to Herdr
  recent-unwrapped output.
- Use `herdr_read` with `source: "visible"` when you need the exact current TUI
  screen state.
- Use `herdr_send` to answer prompts, send text, or press keys in a pane.
- Use `herdr_spawn` for watchable or parallel work that should become a visible
  `clanky:<slug>` pane.

If the task involves spawning, fan-out, or creating a performer, load
`clanky-herdr-operator` before calling `herdr_spawn`. This skill is enough for
status/read/send operations, but the operator skill owns Clanky's spawn protocol.

`herdr_status` includes `codingHarnesses`: the allowed harness set and configured
launcher profiles. When calling `herdr_spawn`, choose any allowed `harness` that
fits the task or that the user directed; do not omit it. `/harness` controls the
allowlist and native-vs-Ollama launch models for Claude, Codex, and OpenCode
workers. `performer` is a lower-level override. `command` is only a raw argv
override for custom commands; never pass `command: []`. Omit `cwd` to use
Clanky's host repo cwd, or pass a real host path. Do not use sandbox paths like
`/workspace`.

Spawned workers receive a compact bootstrap pointing them to
`skills/clanky-herdr-worker/SKILL.md` for coordination and completion only.
They can read durable worker history through `clanky transcript read
clanky:<slug> --lines N`; Herdr remains the live status, screen, and input
control plane.
Do not inject Clanky's coding skills into Claude Code, Codex, OpenCode, or
custom worker prompts. Those runtimes should use their own native coding,
planning, exploration, review, and subagent behavior. Use `performer:
"clanky"` only when the worker should be Clanky himself, via the installed
`clanky worker` CLI.

When calling `herdr_send`, address workers by `agent` when possible. To submit a
prompt in one call, pass both `text` and `keys: ["Enter"]`. Keys-only sends such
as `keys: ["Enter"]` are valid for named agents and panes.

Treat pane ids as temporary. Re-read status before sending to a pane if there is
any chance the layout changed. Agent names such as `clanky:fix-tests` are the
durable address when a named worker exists. The foreground Clanky face reports
as `clanky:main` when it is running inside Herdr.

Do not spawn work just to have activity. If no workers are running, report that
plainly.
