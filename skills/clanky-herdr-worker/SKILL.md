---
name: clanky-herdr-worker
description: Follow inside a visible Herdr pane spawned by Clanky as clanky:<slug>.
allowed_tools:
  - Bash
deps:
  - herdr
---

# Clanky Herdr Worker

You are a visible worker spawned by Clanky. Your kickoff prompt gives your
durable name, usually `clanky:<slug>`, the host cwd, and the task. Follow the
task first; use Herdr only when coordination, status, or escalation helps.

## Stage Awareness

If `HERDR_ENV=1`, you are inside the Herdr stage.

- List workers and panes with `herdr agent list` and `herdr pane list`.
- Prefer durable names like `clanky:<slug>` over pane ids.
- Re-resolve pane ids before sending pane commands; pane ids are temporary.
- Clanky's foreground face reports as `clanky:main` when available.

If Herdr is unavailable, continue the task and say that live coordination was
unavailable.

## Messaging

Read another worker:

```bash
herdr agent read clanky:<slug> --source recent --lines 120
```

Send literal text without submitting:

```bash
herdr agent send clanky:<slug> "message"
```

Submit a prompt to another worker or to Clanky:

```bash
PANE="$(herdr agent get clanky:<slug-or-main> | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])')"
herdr pane run "$PANE" "message"
```

`herdr agent send` writes literal text only; use `herdr pane run` for submitted
prompts.

## Blocking

If blocked, state exactly what you need and wait. Do not ask the human directly
unless Clanky told you to. If `clanky:main` exists and the blocker needs the
conductor, send a short submitted prompt there.

If your task prompt includes a `result.md`, `DONE`, or `BLOCKED` completion
protocol, follow it exactly. Otherwise, leave a concise final report in your
pane.

## Shared files

If you notice a sibling worker is creating or editing files your task depends on,
do not silently analyze or edit a moving target. Say so explicitly: block for the
operator (state which files and which sibling), or send a short submitted prompt
to `clanky:main` to coordinate. Reporting against half-written files produces
stale conclusions — flag the race instead of caveating around it.

## Scope

Do not spawn more workers unless Clanky asked you to coordinate a sub-run. Do
not commit unless the user explicitly requested a commit.
