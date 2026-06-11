---
name: clanky-herdr-operator
description: Run Clanky's parallel subagents as named herdr panes. Spawn workers into a tagged run tab, monitor and unblock them, harvest per-worker results, synthesize, and clean up, using bundled scripts over the herdr CLI.
when_to_use: Use when running inside herdr (HERDR_ENV=1) and work should fan out to parallel visible workers, e.g. "spawn workers/subagents for these tasks", "run these refactors in parallel", "swarm this", "farm this out to agents", "check on the workers", "harvest the run", "clean up worker panes". Not for single quick tasks, Discord gateway side-requests, or when HERDR_ENV is unset.
allowed_tools:
  - Bash
deps: []
---

# Clanky herdr Operator

This is Clanky's one multi-agent substrate: parallel workers run as herdr
panes, visible and attributable, never as hidden processes.

Before anything else, check that `HERDR_ENV=1`. If it is not set to `1`, say
you are not running inside herdr and stop; never control herdr from outside
it. The bundled scripts enforce the same gate.

The scripts live in `scripts/` next to this SKILL.md. Set
`OP="<this skill's directory>/scripts"` once and use `$OP/...` below.

## When not to use this

- Discord gateway side-requests: the in-process subagent coordinators own
  those. Do not spawn herdr workers for them.
- A single quick task you could do inline: just do it.
- One shell command, server, or test in a sibling pane: use the plain herdr
  CLI (`herdr pane split` + `herdr pane run`), no run machinery needed.

## Model

A **run** is one fan-out: a run directory plus one herdr tab labeled
`clanky:<run-id>`. A **worker** is one agent pane in that tab, named
`clanky:<task-slug>`. Everything Clanky spawns carries the `clanky:` prefix
so a remote client can reconstruct the subagent tree from pane state alone;
`manifest.json` in the run directory is the durable record (names, tasks,
argv, timestamps).

Run directories live under `${CLANKY_HERDR_RUN_ROOT:-$HOME/.clanky/herdr-runs}/<run-id>/`:

```
manifest.json
workers/<slug>/prompt.md    # task brief + completion protocol (spawn.sh writes it)
workers/<slug>/result.md    # worker's output
workers/<slug>/DONE         # sentinel file: finished
workers/<slug>/BLOCKED      # sentinel file: needs input
```

The sentinel **files** are the source of truth for completion. Workers also
print `CLANKY_WORKER_DONE` / `CLANKY_WORKER_BLOCKED`, but do not wait on
those strings with `herdr wait output`: a worker that echoes its prompt file
reproduces them and you match a false positive. Poll the files (harvest.sh
does) and use herdr reads for inspection.

Pane and tab ids are not durable; they compact when panes close. Never store
them across steps. Address workers by agent name (`clanky:<slug>`) and
re-resolve the pane id with `herdr agent get` when a pane command needs one.

## 1. Spawn

One worker per independent task, lowercase-kebab slug, one-line task summary:

```bash
$OP/spawn.sh --slug fix-auth-tests --task "Fix the failing auth tests" \
  --cwd ~/dev/someproject \
  --prompt "Run the auth test suite in this repo, fix the failures, re-run until green. List every file you changed."
```

It prints `RUN_ID=...`, `RUN_DIR=...`, `AGENT=...`, `PANE_ID=...`. Pass that
`RUN_ID` to every later spawn so the workers share one run and one tab:

```bash
$OP/spawn.sh --run "$RUN_ID" --slug update-readme --task "Update README" \
  --cwd ~/dev/someproject --prompt-file /tmp/readme-brief.md
```

Write real briefs: context, exact scope, what result.md must contain. The
script appends the completion protocol (result.md, DONE/BLOCKED, autonomy)
to every prompt — do not restate it.

### Worker command

The default worker is `clanky` (PATH first, falling back to this repo's bin
via pnpm), so workers inherit Clanky's profile and persona. Spawn always sets
`CLANKY_CHAT_GATEWAY_OWNER=off` for default workers — exactly one Clanky may
own the Discord gateway, and it is not a worker.

Override with `--` for a different agent. The `{KICKOFF}` token is replaced
with the kickoff message; without it, the kickoff is appended as the last
argument. Spawned agents get no human at the keyboard, so pick a permission
mode that will not stop to ask:

```bash
# Claude Code worker (kickoff lands as the positional prompt)
$OP/spawn.sh --run "$RUN_ID" --slug audit-deps --task "Audit dependencies" \
  --prompt "..." -- claude --permission-mode acceptEdits

# Arbitrary worker with an explicit kickoff slot
$OP/spawn.sh --run "$RUN_ID" --slug triage --task "Triage open issues" \
  --prompt "..." -- pi {KICKOFF}
```

`claude --dangerously-skip-permissions` only for throwaway work in disposable
checkouts. Pi and clanky workers have no approval gates; nothing extra needed.

## 2. Monitor and wait

```bash
$OP/harvest.sh "$RUN_ID"                      # snapshot: <slug> done|blocked|running|dead
$OP/harvest.sh "$RUN_ID" --wait --timeout 900 # poll until nothing is running
```

Exit 0 means every worker is done. Peek at a live worker anytime:

```bash
herdr agent read clanky:fix-auth-tests --source recent --lines 60
```

`herdr agent list` shows all workers; `agent_status` there is heuristic (the
`clanky` binary is not a recognized process, so expect `unknown`) — trust the
harvest states, not `agent_status`, for completion.

## 3. Unblock or steer

A `blocked` worker wrote what it needs to its `result.md` and is waiting.
Read it, then answer into the worker's pane (text first, then Enter):

```bash
cat "$RUN_DIR/workers/fix-auth-tests/result.md"
PANE=$(herdr agent get clanky:fix-auth-tests | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])')
herdr pane run "$PANE" "Use the staging database, credentials are in .env.staging. Delete the BLOCKED file and continue."
```

Mid-flight course corrections work the same way on a `running` worker.

## 4. Harvest and synthesize

```bash
$OP/harvest.sh "$RUN_ID" --results
```

prints every worker's state and `result.md`. Read them yourself from
`$RUN_DIR/workers/*/result.md` when synthesizing — combine, reconcile
conflicts, and report per-worker attribution (slug + what it did). The
synthesis is your job, not a script's.

## 5. Clean up

After harvesting:

```bash
$OP/cleanup.sh "$RUN_ID" --rm
```

closes the run tab (all worker panes with it) and deletes the run directory.
Omit `--rm` to keep results on disk. It refuses while workers are still
`running` unless you pass `--force`.

## Failure modes

**Worker blocked.** See "Unblock or steer". If the question needs the user,
relay it, get the answer, send it on.

**Worker stuck on a startup prompt.** A worker showing `running` long after
spawn with no activity may be sitting on an interactive prompt before the
kickoff even lands (seen live: Claude Code's "trust this folder" dialog in a
new cwd). Read the pane, then answer it:

```bash
herdr agent read clanky:<slug> --source visible --lines 30
herdr pane send-keys "$PANE" Enter   # resolve $PANE via herdr agent get
```

The kickoff is queued as input, so it submits once the dialog clears.

**Worker died silently.** harvest reports `dead`: no sentinel and the agent
pane is gone (process crashed, or the pane was closed by hand). The tab may
still hold a dead shell pane. Check for a partial `result.md`, then respawn
under a fresh slug (`fix-auth-tests-2`) — agent names must be unique and the
old name may still be cached.

**Worker ran out without the protocol.** A pane can show a finished agent
with no DONE file (it forgot the protocol). Read the pane
(`herdr agent read clanky:<slug> --lines 100`), and if the work is done,
salvage: tell it via `herdr pane run` to write result.md and the DONE file.

**Pane ids compacted.** Any stored pane id (including `pane_id_at_spawn` in
the manifest) is stale after panes close. Resolve fresh ids by name via
`herdr agent get`.

**Orphaned run directories.** Crashed orchestrations leave run dirs behind.
`$OP/cleanup.sh --list` shows every run with worker states; clean finished
ones with `cleanup.sh <run-id> --rm`.

**Tab closed by hand.** If the user closed the run tab, the workers are gone
but the run dir remains. Harvest whatever sentinel files exist, then
`cleanup.sh <run-id> --rm`.

## Attribution contract (for remote clients)

Anything this skill creates is identifiable without this conversation:

- tab label `clanky:<run-id>` — one per run
- pane label / agent name `clanky:<task-slug>` — one per worker
- pane title = the `--task` one-liner (set via `herdr pane report-metadata
  --source clanky-orchestrator`)
- `manifest.json` — the durable mapping of names to tasks, cwd, and argv

Keep this contract if you spawn anything by hand: name it `clanky:<slug>`
and record it in the run's manifest.
