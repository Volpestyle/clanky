---
name: clanky-herdr-operator
description: Run Clanky's parallel subagents as named terminal-stage panes through the current Herdr adapter. Spawn workers into a tagged run tab, monitor and unblock them, harvest per-worker results, synthesize, and clean up, using bundled scripts over the herdr CLI.
when_to_use: Use when running inside the current Herdr adapter (HERDR_ENV=1) and work should fan out to parallel visible workers, e.g. "spawn workers/subagents for these tasks", "run these refactors in parallel", "swarm this", "farm this out to agents", "check on the workers", "harvest the run", "clean up worker panes". Not for single quick tasks, Discord gateway side-requests, or when HERDR_ENV is unset.
allowed_tools:
  - Bash
deps:
  - herdr
---

# Clanky Stage Operator (Herdr Adapter)

This is Clanky's current multi-agent substrate: parallel workers run as visible
terminal-stage panes, visible and attributable, never as hidden processes. Herdr
is the current mux adapter; the product model is mux-agnostic so tmux, Zellij,
and other adapters can expose the same stage semantics later.

This skill is a Clanky-specific overlay on top of the vanilla `herdr` skill.
Use `herdr` for generic workspace, tab, pane, split, wait, read, send, and
presence mechanics. Use this skill only for Clanky's run grouping, worker
manifest, completion sentinels, harvest, synthesis, and cleanup protocol.
For tracker-backed fan-out, also use `clanky-work-tracker`; the tracker owns
planning and durable status, while this skill owns visible execution.
The current scripts are Herdr-specific; when another mux adapter lands, add an
equivalent adapter/tool surface rather than baking new behavior into raw Herdr
commands.

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
workers/<slug>/watch.log    # completion watcher output (see section 2)
```

The sentinel **files** are the source of truth for completion. Workers also
print `CLANKY_WORKER_DONE` / `CLANKY_WORKER_BLOCKED`, but do not wait on
those strings with `herdr wait output`: a worker that echoes its prompt file
reproduces them and you match a false positive. Poll the files (harvest.sh
does) and use herdr reads for inspection.

Pane and tab ids are not durable; they compact when panes close. Never store
them across steps. Address workers by agent name (`clanky:<slug>`) and
re-resolve the pane id with `herdr agent get` when a pane command needs one.

## Two run shapes: ephemeral fan-out vs persistent pool

**Ephemeral fan-out** (this skill's baseline): one worker per independent task,
spawned and discarded. **Persistent pool** (default for a long, many-issue,
tracker-backed effort): a small set of named, warm workers routed by scope
ownership, with the tracker as the orchestration ledger. Arm each pool task with
the harness's native `/goal` loop by hand after spawn
(`herdr pane run "$PANE" "/goal <task + definition-of-done>"`) — the spawn seam
does not arm it itself ([VUH-321](https://linear.app/vuhlp/issue/VUH-321)).
Full pool policy — routing, reserved workers, ledger rules, ADR-0002 status —
is in [references/pool-policy.md](references/pool-policy.md).

## 1. Spawn

One worker per independent task, lowercase-kebab slug, one-line task summary:

```bash
$OP/spawn.sh --slug fix-auth-tests --task "Fix the failing auth tests" \
	--cwd ~/dev/someproject --harness codex \
	--prompt "Run the auth test suite in this repo, fix the failures, re-run until green. List every file you changed."
```

It prints `RUN_ID=...`, `RUN_DIR=...`, `AGENT=...`, `PANE_ID=...`, `WATCH=...`.
Pass that `RUN_ID` to every later spawn so the workers share one run and one tab:

```bash
$OP/spawn.sh --run "$RUN_ID" --slug update-readme --task "Update README" \
	--cwd ~/dev/someproject --harness claude --prompt-file /tmp/readme-brief.md
```

For the eve host `herdr_spawn` tool, omit `cwd` to use Clanky's current host
repo, or pass a real host path for another checkout. Never use sandbox paths
like `/workspace`. Check `herdr_status.codingHarnesses` before choosing worker
runtimes; it shows the allowed harnesses and launcher profiles. Use `harness:
"clanky"`, `"claude"`, `"codex"`, `"opencode"`, or `"custom"` for every spawn.
`performer` is a lower-level override.
`command` is only a full custom argv override, never `command: []`.

Workers spawned by either path receive a short bootstrap that tells them to
read `skills/clanky-herdr-worker/SKILL.md` for coordination and completion
only. Do not inject Clanky's coding skills into Claude Code, Codex, OpenCode,
or custom worker prompts. Those runtimes should use their own native coding,
planning, exploration, review, and subagent behavior. Use `performer:
"clanky"` only when the worker should be Clanky himself, via the installed
`clanky worker` CLI.

Clanky-spawned workers are transcript-wrapped by default while
`CLANKY_WORKER_TRANSCRIPTS` is on (managed by `/harness transcripts on|off`).
Pass `--transcript` or `--no-transcript` to override the default for one spawn.
Read durable history for wrapped workers with:

```bash
clanky transcript read clanky:<slug> --lines 120
```

Use Herdr reads for live current-screen state and input routing. Herdr pane
reads clamp at 1000 recent lines and have no full-history source, so a wrapped
transcript is the only complete record of a worker's run.

Independent means **write-disjoint**. Workers fanned out concurrently must not
write the same files, and a read-only worker must never audit files another
worker in the same run is creating. When unsure whether scopes overlap, assume
they do. Default to the parent/current worktree; a worker gets its own git
worktree only when the operator has deliberately decided its task should land as
its own branch/PR. For shared-parent runs, integration is **lead-owned**: never
`git add -A`/`git add .` or commit while any worker is mid-edit; wait for the
run to quiesce (all workers `idle`/done), per the `/c` skill — this interlock is
convention only, nothing enforces it yet
([VUH-337](https://linear.app/vuhlp/issue/VUH-337)). The full policy —
sequencing overlapping scopes, scope-partitioned shared worktrees, PR-lane
lifecycle and ledger fields — is in
[references/worktrees-and-pr-lanes.md](references/worktrees-and-pr-lanes.md).

Write real briefs: context, exact scope, whether the worker may edit or should
only explore/plan/review, the verification command, and what result.md must
contain. The script appends the completion protocol (result.md, DONE/BLOCKED,
autonomy) to every prompt — do not restate it.

For tracker-backed work, include the issue id, acceptance criteria, and expected
tracker transition in the brief. The operator owns tracker state: assign/start
work before dispatch when possible, verify the result after the worker finishes,
then move the issue and leave a concise comment. Do not let a worker's "done"
claim substitute for operator verification. The tracker — not pane scrollback —
is the durable context: post what the worker found/changed/verified to the
issue at harvest time, so the pane can close without losing anything.

Keep shared repo mutations lead-owned unless each writer is isolated in its own
worktree. Package installs, lockfiles, global config, workspace manifests, and
other cross-cutting files are coordination points, not worker-local edits. Tell
workers to report required dependency/config changes in a clear `DEP_NEEDED:
<change> -- <reason>` line instead of editing shared manifests themselves; batch
those changes centrally so concurrent workers do not race the lockfile.

**Generated artifacts are shared mutations too.** A worker whose *source* edit is
in scope can still rewrite a shared generated file as a side effect — e.g. a
worker editing `project.yml` that runs `xcodegen generate` rewrites the tracked
`project.pbxproj`, or a codegen/format step rewrites generated output. Two
workers regenerating the same artifact (or one editing the generator input while
another regenerates) race it just like a lockfile. Keep regeneration to a single
owner or the lead, and treat generated project files, codegen output, and
snapshots as coordination points, not worker-local edits.

For multi-wave runs, keep an operator-owned ledger in the run directory,
scratchpad, or tracker: worker -> task/issue, cwd/scope, mutable paths,
dependencies, verification command, and next DAG-unblocked tasks. Update it as
workers finish. This is separate from the manifest: the manifest records what
was spawned; the ledger records orchestration state and handoffs.

### Worker command

The allowed worker set uses `CLANKY_CODING_HARNESSES`, configured from the face
with `/harness allow`. Every spawn specifies its harness explicitly. Direct
`/harness <id>` commands configure launch settings for built-in harnesses.
Built-in harnesses are `clanky`, `claude`, `codex`, and `opencode`. `custom` uses
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
	--harness claude --prompt "..." -- claude --permission-mode acceptEdits

# Arbitrary worker with an explicit kickoff slot
$OP/spawn.sh --run "$RUN_ID" --slug triage --task "Triage open issues" \
	--harness codex --prompt "..." -- codex --dangerously-bypass-approvals-and-sandbox {KICKOFF}

# Clanky worker: uses Clanky's Eve runtime and configured skills
$OP/spawn.sh --run "$RUN_ID" --slug clanky-fix --task "Fix flaky tests" \
	--harness clanky --prompt "..."

# OpenCode worker: uses OpenCode native internals
$OP/spawn.sh --run "$RUN_ID" --slug opencode-fix --task "Fix flaky tests" \
	--harness opencode --prompt "..."
```

This setup intentionally gives workers autonomy inside their panes. Pick an
explicit command after `--` when a task needs a different permission mode. For
Claude Code, `--permission-mode auto` (the "auto mode" convention) auto-accepts
edits and safe commands, so a self-driving worker won't stall on a bash-permission
prompt the way `acceptEdits` can; reserve full bypass for when it is truly needed.

### Stage layout (keep workers human-readable)

Every `herdr agent start --tab` **appends another column to one row**, and
finished workers keep their columns until cleanup — a run that spawns waves
into one tab decays into unreadable slivers. Levers that exist today:

- **Ratio-sized agent panes (preferred).** An agent is just a process in a
  pane: herdr detects `agent`/`agent_status` from the running process, not
  from `agent start` (verified live). So compose exact sizing yourself:
  `herdr pane split --pane <ref> --direction right|down --ratio 0.X --cwd
  <dir>` → `herdr pane rename <new-pane> clanky:<slug>` → `herdr pane run
  <new-pane> "<worker argv>"`. `agent start` is the one-call convenience but
  supports only `--split right|down` — direction, no ratio.
- Background/service panes (servers, log tails): same split, small ratio
  (`--ratio 0.2`), no rename ceremony needed.
- `herdr pane rename <pane> <label>` names panes (also fixes wake routing).
- `herdr pane resize --direction <d> --amount <cells>` is **grow-only**
  (negative amounts are silent no-ops), clamps at pane minimums, and can
  return `"changed": false` — check that field; do not build equalizers on it
  without verifying each call took effect.
- `herdr pane zoom` is a human affordance, not an agent tool: steering via
  `pane run` works at any pane width. The one agent-side use is rescuing a
  read of a slivered TUI (a TUI renders to its width, so no read source can
  recover what it never drew) — but zoom hijacks the user's visible screen;
  prefer right-sizing at spawn so it never comes to that.

Policy: rename your lead pane before the first spawn; prefer ratio-split
spawns so panes start human-readable instead of repairing them after; keep a
run's live panes few (waves help); if a tab has decayed into slivers, say so
and let the user rearrange rather than fighting resize blind.

## 2. Monitor and wait

**Wake-driven is the default.** Every spawn — `spawn.sh` and the eve
`herdr_spawn` tool — arms a detached one-shot watcher (`clanky watch`) for its
worker. So the loop is: spawn, optionally arm the harness's `/goal` loop, end
your turn. When the worker settles, the watcher classifies it against the run's
sentinel files and delivers one provenance-stamped wake into the spawning
lead's pane:

```
[from watch:<slug>] [worker done|blocked|idle|dead] clanky:<slug> run=<run-id> result=<result.md path>
```

Act on the wake (verify, then unblock/harvest per §3/§4); the watcher is
one-shot, so re-arming is the next spawn's (or your) job —
`clanky watch clanky:<slug> --notify <your durable name> --run-dir "$RUN_DIR"`
re-arms one by hand. Opt a spawn out with `--no-watch` (spawn.sh) or
`watch: false` (`herdr_spawn`). The armed watcher is recorded in
`manifest.json` (notify target, pid, log) and its output lands in
`workers/<slug>/watch.log`.

Classification trusts sentinel files over herdr's heuristic `agent_status`:
`done`/`blocked` mean the sentinel exists; `idle` means the status settled with
no sentinel (finished-but-forgot-the-protocol, or stuck at a startup prompt —
inspect the pane); `dead` means the pane is gone with no sentinel. Because
statuses flicker (a pane can read `idle` mid-turn), a status-only settle fires
only after the screen stays quiet across consecutive probes, and a slow
recheck under the event stream catches sentinels whose settle event never
arrived. A dropped event subscription is not a death verdict: the watcher
re-resolves the pane by durable name and resubscribes.

`harvest.sh` is the timeout safety net and state snapshot, not the completion
mechanism:

```bash
$OP/harvest.sh "$RUN_ID"                      # snapshot: <slug> done|blocked|running|dead
$OP/harvest.sh "$RUN_ID" --wait --timeout 900 # fallback poll when a wake never came
```

Exit 0 means every worker is done. Watching a pane live is a deliberate
steering mode, not how you learn about completion:

```bash
herdr agent read clanky:fix-auth-tests --source recent --lines 60
```

`herdr agent list` shows all workers; `agent_status` is heuristic. Trust the
harvest states, not `agent_status`, for completion.

When monitoring from Clanky's Eve tools, use `herdr_read` with the default
`source: "auto"` for worker history, and `source: "visible"` only when the
current TUI screen matters.

Long-running waiters should have timeouts. A timeout is not a verdict: inspect
the worker's recent output, decide whether it is progressing, blocked, or dead,
then either steer it, harvest it, or re-arm the waiter with a fresh timeout.
Avoid tight polling loops: completion is the spawn-armed wake's job; use
explicit `herdr wait` event waits for intermediate milestones (server ready,
tests started) and explicit reads for progress checks.

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
Workers message each other with `clanky msg <name> "message"` — it resolves the
target against the live roster (a `clanky:<slug>`, label, or pane id), refuses an
ambiguous or self target, and stamps the sender's verified `[from <self>]` so no
one trusts a pane id a message claims for itself. Raw `herdr pane run` (resolve
the pane fresh with `herdr agent get`) is the fallback for non-message input;
`herdr agent send` writes literal text only. When a brief tells one worker to
coordinate with another, give the sibling's durable name, not a pane id — pane
ids compact and get misattributed.

If a worker hits an external live-gate (a dev server, production service, paid
API, or user-owned live agent) do not start or mutate that system just to unblock
the run unless the user has already authorized it. Steer the worker toward a
synthetic/offline verification path when it still answers the core question;
otherwise mark the result pending-live-gate and ask for permission.

## 4. Harvest and synthesize

```bash
$OP/harvest.sh "$RUN_ID" --results
```

prints every worker's state and `result.md`. Read them yourself from
`$RUN_DIR/workers/*/result.md` when synthesizing — combine, reconcile
conflicts, and report per-worker attribution (slug + what it did). The
synthesis is your job, not a script's.

Verify before marking work complete. Run the focused command that matches the
brief, inspect diffs for scope creep, then update the tracker or final status.
For a wave, summarize landed work, in-flight work, blockers, and next
DAG-unblocked tasks rather than dumping raw worker logs.

When several workers analyzed overlapping scope (the same files, the same
change), fold their results into **one** implementation task here and spawn that
as a single edit-capable worker. Do not tell each analyzer to go implement its
own plan: their edits collide in the shared tree. Synthesis is the point where N
overlapping plans become one ordered change set.

## 5. Clean up

Close each worker's pane as soon as its result is harvested, verified, and
tracked — context lives in the tracker, the run dir, and the transcript, not
in scrollback. A finished TUI pane closes from the outside by quitting the
agent: `herdr pane run <pane> "/quit"` (codex) or `"/exit"` (claude) ends the
TUI, the transcript wrapper exits with it, and the pane closes; if a bare
shell remains, `herdr pane run <pane> "exit"`. Pane ids compact on close —
re-resolve survivors by durable name afterward.

After the whole run is harvested:

```bash
$OP/cleanup.sh "$RUN_ID" --rm
```

closes the run tab (all worker panes with it) and deletes the run directory.
Omit `--rm` to keep results on disk. It refuses while workers are still
`running` unless you pass `--force`.

## Failure modes

**Worker blocked.** See "Unblock or steer". If the question needs the user,
relay it, get the answer, send it on.

**Wake never arrived (undelivered watch).** spawn.sh resolves the wake target
from the spawning pane's label, else its `clanky:*` agent name; a lead it
cannot name — e.g. a bare `claude`/`codex` operator pane — falls back to
`clanky:main`, and when the brain isn't running the wake dies as
`undelivered` in `workers/<slug>/watch.log`. Read the `WATCH=armed
notify=...` line every spawn prints: if it says `clanky:main` and you are not
the brain, fix your own name first — `herdr pane rename <your-pane-id>
clanky:<lead-name>` gives your pane a durable label the resolver picks up
automatically for every later spawn — or pass `--notify <name>` per spawn /
re-arm by hand (`clanky watch clanky:<slug> --notify <name> --run-dir
"$RUN_DIR"`). A missed wake is recoverable — the sentinel files are still
truth; harvest.

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

**Worker cwd went stale (removed/recreated worktree).** If a worktree a worker is
rooted in is deleted — or deleted and recreated at the same path (a `git worktree`
cleanup pass, a branch reset) — the worker's shell keeps the old, now-dangling
directory inode: its `git`/file commands operate on a ghost, not the new tree.
Restart the pane in the live path (`/exit`, then `cd <path> && <agent>`); a running
TUI can't `cd` itself. The work itself survives even when the worktree directory is
gone — the branch ref and objects outlive the working directory, so verify (and
push) from the repo rather than assuming committed work was lost.

## Attribution contract (for remote clients)

Anything this skill creates is identifiable without this conversation:

- tab label `clanky:<run-id>` — one per run
- pane label / agent name `clanky:<task-slug>` — one per worker
- pane title = the `--task` one-liner (set via `herdr pane report-metadata
  --source clanky-orchestrator`)
- `manifest.json` — the durable mapping of names to tasks, cwd, and argv

Keep this contract if you spawn anything by hand: name it `clanky:<slug>`
and record it in the run's manifest.
