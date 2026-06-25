---
name: clanky-herdr-operator
description: Run Clanky's parallel subagents as named herdr panes. Spawn workers into a tagged run tab, monitor and unblock them, harvest per-worker results, synthesize, and clean up, using bundled scripts over the herdr CLI.
when_to_use: Use when running inside herdr (HERDR_ENV=1) and work should fan out to parallel visible workers, e.g. "spawn workers/subagents for these tasks", "run these refactors in parallel", "swarm this", "farm this out to agents", "check on the workers", "harvest the run", "clean up worker panes". Not for single quick tasks, Discord gateway side-requests, or when HERDR_ENV is unset.
allowed_tools:
  - Bash
deps:
  - herdr
---

# Clanky herdr Operator

This is Clanky's one multi-agent substrate: parallel workers run as herdr
panes, visible and attributable, never as hidden processes.

This skill is a Clanky-specific overlay on top of the vanilla `herdr` skill.
Use `herdr` for generic workspace, tab, pane, split, wait, read, send, and
presence mechanics. Use this skill only for Clanky's run grouping, worker
manifest, completion sentinels, harvest, synthesis, and cleanup protocol.

Before anything else, check that `HERDR_ENV=1`. If it is not set to `1`, say
you are not running inside herdr and stop; never control herdr from outside
it. The bundled scripts enforce the same gate.

The scripts live in `scripts/` next to this SKILL.md. Set
`OP="<this skill's directory>/scripts"` once and use `$OP/...` below.

## When not to use this

- Simple Discord side-requests that do not need watching: answer them in the
  foreground agent. Do not spawn herdr workers for them.
- A single quick task you could do inline: just do it.
- One shell command, server, or test in a sibling pane: use the vanilla `herdr`
  skill directly, no Clanky run machinery needed.

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

For the eve host `herdr_spawn` tool, omit `cwd` to use Clanky's current host
repo, or pass a real host path for another checkout. Never use sandbox paths
like `/workspace`. Check `herdr_status.codingHarnesses` before choosing worker
runtimes; it shows the allowed harnesses and automatic fallback. Use `harness:
"clanky"`, `"claude"`, `"codex"`, `"opencode"`, or `"custom"` when a specific
allowed runner fits the task; omit `harness`, `performer`, and `command` only
when Clanky may pick from the allowed set. `performer` is a lower-level override.
`command` is only a full custom argv override, never `command: []`.

Workers spawned by either path receive a short bootstrap that tells them to
read `skills/clanky-herdr-worker/SKILL.md` for coordination and completion
only. Do not inject Clanky's coding skills into Claude Code, Codex, OpenCode,
or custom worker prompts. Those runtimes should use their own native coding,
planning, exploration, review, and subagent behavior. Use `performer:
"clanky"` only when the worker should be Clanky himself, via the installed
`clanky worker` CLI.

Clanky-spawned workers are transcript-wrapped by default. Read durable history
with:

```bash
clanky transcript read clanky:<slug> --lines 120
```

Use Herdr reads for live current-screen state and input routing.

Independent means **write-disjoint**. Workers fanned out concurrently must not
write the same files, and a read-only worker must never audit files another
worker in the same run is creating — its analysis reads a moving target and
reports stale or half-written state. If two tasks share mutable paths (one reads
what another writes, or both edit the same files), do not fan them out together:
sequence them (separate runs, or a `blocked` handoff), or isolate each writer in
its own git worktree. When unsure whether scopes overlap, assume they do.

Write real briefs: context, exact scope, whether the worker may edit or should
only explore/plan/review, the verification command, and what result.md must
contain. The script appends the completion protocol (result.md, DONE/BLOCKED,
autonomy) to every prompt — do not restate it.

### Worker command

The allowed worker set uses `CLANKY_CODING_HARNESSES`, configured from the face
with `/harness allow`. When no harness is specified, Clanky picks automatically
from the allowed set, preferring `clanky` when it is allowed. Direct
`/harness <id>` commands can still set `CLANKY_CODING_HARNESS` as an optional
preferred fallback. Built-in harnesses are
`clanky`, `claude`, `codex`, and `opencode`. `custom` uses
`CLANKY_CODING_HARNESS_COMMAND`. The `claude`, `codex`, and `opencode` harnesses
can use the default CLI launcher or `ollama launch <harness>` with a configured
model. Codex Ollama mode uses `ollama launch codex`, not the Codex app, and runs
in an isolated `CODEX_HOME` (`CLANKY_CODEX_OLLAMA_HOME`, default
`~/.clanky/codex-ollama-home`) so it never clobbers a subscription codex worker's
`~/.codex`. This lets a local Ollama codex worker and a subscription codex worker
run side by side.

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
  --prompt "..." -- codex --dangerously-bypass-approvals-and-sandbox {KICKOFF}

# Clanky worker: uses Clanky's Eve runtime and configured skills
$OP/spawn.sh --run "$RUN_ID" --slug clanky-fix --task "Fix flaky tests" \
	--harness clanky --prompt "..."

# OpenCode worker: uses OpenCode native internals
$OP/spawn.sh --run "$RUN_ID" --slug opencode-fix --task "Fix flaky tests" \
	--harness opencode --prompt "..."
```

This setup intentionally gives workers autonomy inside their panes. Pick an
explicit command after `--` when a task needs a different permission mode.

## 2. Monitor and wait

```bash
$OP/harvest.sh "$RUN_ID"                      # snapshot: <slug> done|blocked|running|dead
$OP/harvest.sh "$RUN_ID" --wait --timeout 900 # poll until nothing is running
```

Exit 0 means every worker is done. Peek at a live worker anytime:

```bash
herdr agent read clanky:fix-auth-tests --source recent --lines 60
```

`herdr agent list` shows all workers; `agent_status` is heuristic. Trust the
harvest states, not `agent_status`, for completion.

When monitoring from Clanky's Eve tools, use `herdr_read` with the default
`source: "auto"` for worker history, and `source: "visible"` only when the
current TUI screen matters.

## 3. Unblock or steer

A `blocked` worker wrote what it needs to its `result.md` and is waiting.
Read it, then answer into the worker's pane. From the eve host tools, prefer
`herdr_send` with the worker `agent`; submit in one call by passing both `text`
and `keys: ["Enter"]`. With the pane CLI, send text first, then Enter:

```bash
cat "$RUN_DIR/workers/fix-auth-tests/result.md"
PANE=$(herdr agent get clanky:fix-auth-tests | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])')
herdr pane run "$PANE" "Use the staging database, credentials are in .env.staging. Delete the BLOCKED file and continue."
```

Mid-flight course corrections work the same way on a `running` worker. Before
sending any steer, confirm the worker is still `running` (re-run `harvest.sh` or
check its `DONE` file): a worker that already wrote `DONE` is finished, and
re-prompting it to "write result.md / print CLANKY_WORKER_DONE" only wastes a
turn on work it has done. Pane reads and `agent_status` lag the sentinel — let
the sentinel decide whether a steer is needed at all.
Workers can also message each other with the Herdr CLI. For a submitted prompt,
they should resolve the target pane and use `herdr pane run`; `herdr agent send`
writes literal text only.

## 4. Harvest and synthesize

```bash
$OP/harvest.sh "$RUN_ID" --results
```

prints every worker's state and `result.md`. Read them yourself from
`$RUN_DIR/workers/*/result.md` when synthesizing — combine, reconcile
conflicts, and report per-worker attribution (slug + what it did). The
synthesis is your job, not a script's.

When several workers analyzed overlapping scope (the same files, the same
change), fold their results into **one** implementation task here and spawn that
as a single edit-capable worker. Do not tell each analyzer to go implement its
own plan: their edits collide in the shared tree. Synthesis is the point where N
overlapping plans become one ordered change set.

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
