# Swarm Worker Contract

This document defines the behavioral contract every worker process Clanky spawns into the `swarm-mcp` coordination layer must follow. It is the runtime counterpart to the env-driven adoption protocol — the env vars give the worker its identity, this contract tells the worker what to do with it.

This contract applies only to **Clanky-spawned workers**. Sessions launched through `swarm-ui`'s Launcher, manual `claude --mcp-config` invocations, or peer agents that joined the swarm on their own terms can register and coordinate however they like.

Companion docs:

- [`overview.md`](./overview.md) — runtime architecture
- [`../capabilities/code.md`](../capabilities/code.md) — `spawn_code_worker` and swarm-tool capability surface
- [`../tmp/swarm-launcher-redesign-plan.md`](../tmp/swarm-launcher-redesign-plan.md) — the redesign that introduces this contract
- `swarm-mcp/docs/generic-AGENTS.md` — generic peer coordination rules

## 1. Identity and adoption

Workers do not call swarm-mcp's `register` tool by hand. Clanky pre-creates an unadopted instance row directly in `swarm.db` and injects these env vars at process spawn:

| Variable | Purpose |
|---|---|
| `SWARM_DB_PATH` | Path to the shared SQLite file. Defaults to `~/.swarm-mcp/swarm.db`. |
| `SWARM_MCP_INSTANCE_ID` | The pre-reserved instance row's UUID. The MCP server flips `adopted=1` on boot via `tryAutoAdopt`. |
| `SWARM_MCP_DIRECTORY` | Live working directory (the worker's resolved cwd inside the operator's checkout). |
| `SWARM_MCP_SCOPE` | Canonical repo root used as the swarm membership boundary. Sessions in the same scope can see each other; different scopes are separate swarms. |
| `SWARM_MCP_FILE_ROOT` | Canonical base path for resolving relative file paths in `annotate`, `lock_file`, `check_file`, and task `files`. Equal to `SWARM_MCP_DIRECTORY` because Clanky never spawns workers into disposable worktrees; the field is preserved for symmetry with swarm-mcp's schema and with non-Clanky peers that may run worktree-isolated. |
| `SWARM_MCP_LABEL` | Machine-readable label tokens. Format: `origin:clanky provider:<harness> role:<role> thread:<channel> user:<user>`. |

By the time the worker's first reasoning turn runs, the swarm-mcp server has already adopted the row (`adopted=1`, `pid=<worker pid>`, `heartbeat=now`). The worker may call `whoami` to confirm or skip straight to coordinated work.

If adoption fails (e.g. `SWARM_DB_PATH` unwritable, schema mismatch), the worker should surface the failure on stderr and exit non-zero. Clanky's launcher polls for `adopted=1` and treats a missed timeout as a launch error, cleaning up the reserved row.

## 2. Task lifecycle

Every Clanky-spawned worker is associated with one initial swarm task at spawn time. The task is created by Clanky's planner peer with `requester=<clanky-peer-id>` and `assignee=<worker-instance-id>`. The assigned task id is included in the first-turn preamble.

Worker responsibilities, in order:

1. **Claim** — call `claim_task(task_id)` once on first turn. Idempotent if `assignee` already matches.
2. **Execute** — perform the requested work. Files outside the assigned scope are off-limits unless explicitly granted.
3. **Report progress** (optional but recommended for long tasks) — emit `annotate` calls (see §4) so the orchestrator can stream updates back to the user.
4. **Complete on success** — call `update_task(task_id, status="done", result=<final output text>)`.
5. **Complete on failure** — call `update_task(task_id, status="failed", result=<short error message>)`. Do not silently exit non-zero on recoverable errors — the task ledger is the source of truth.
6. **Followup or exit** — see §2a below.

### 2a. Followups: one-shot vs inbox-loop

After completing the assigned task, a worker chooses one of two shapes per harness invocation. The first-turn preamble names which shape this run uses.

- **One-shot (default)**: Process exits 0 once the assigned task reaches a terminal status. Followups are handled by the orchestrator spawning a fresh worker via `spawn_code_worker` (typically with `request_task({ parent_task_id: original })` to preserve traceability).
- **Inbox-loop (opt-in via preamble)**: After `update_task(done)`, the worker continues running and polls its inbox via `wait_for_activity` / `list_messages`. When Clanky's orchestrator wants a followup, it calls `send_message(workerId, content)`; the worker treats the message body as a follow-up instruction, claims/creates a follow-up task as appropriate, executes, and reports again. The worker exits when it receives an explicit termination signal in its inbox or when its idle timeout (per harness config) elapses.

The MCP stale-heartbeat sweep (~30s) reclaims tasks abandoned by either shape.

Task statuses (from `swarm-protocol`): `open | claimed | in_progress | done | failed | cancelled | blocked | approval_required`.

Task types: `review | implement | fix | test | research | other`.

## 3. Result reporting

The `result` column in the `tasks` table is opaque text. By convention, Clanky-spawned workers post the **final user-facing output text** there — this is what surfaces in Discord (or voice TTS) when Clanky's `swarmTaskWaiter` resolves the turn.

Cost and usage telemetry travel as a separate `annotate` call:

```
annotate(
  file=task_id,
  kind="usage",
  content=JSON.stringify({
    inputTokens: <int>,
    outputTokens: <int>,
    cacheWriteTokens: <int>,
    cacheReadTokens: <int>,
    costUsd: <float>
  })
)
```

Why a sibling annotation rather than packing JSON into `result`: keeps `result` human-readable for the Discord turn and lets Clanky merge usage even if the worker died mid-update.

If the worker can't compute usage (older harness, parse failure), it omits the `kind="usage"` annotation. Clanky's waiter falls back to zero-usage and surfaces a `usage_unreported` flag in its action log.

## 4. Progress reporting

For long-running tasks, workers emit periodic progress annotations:

```
annotate(
  file=task_id,
  kind="progress",
  content=<short text summary of what's happening now>
)
```

Clanky subscribes to swarm activity events for the assigned task and forwards these to the originating Discord context (text reply pipeline or voice realtime session). Recommended cadence: at most one progress annotation every 30 seconds, or whenever a notable file edit / subtask transition occurs.

Workers should not abuse `annotate` for high-frequency updates. The events table is bounded; flooding it slows the whole swarm.

## 5. Coordination with peers

Workers in the same scope discover each other via `list_instances` and may exchange information via:

- `send_message(recipient, content)` — direct messages between instances
- `broadcast(content)` — one-to-many message
- `request_task(...)` — post sub-tasks for sibling implementers (with `parent_task_id` set to the worker's own assigned task for traceability)
- `lock_file(file)` / `unlock_file(file)` — exclusive edit lock before mutating shared paths
- `check_file(file)` — see who currently holds a lock and any outstanding annotations
- `annotate(file, kind, content)` — durable per-file findings, hazards, or status notes other peers will see

Workers must `lock_file` before mutating any path inside the shared scope, and `unlock_file` (or deregister) when finished. Clanky-spawned workers run directly in the operator's checkout, so `SWARM_MCP_FILE_ROOT` and `SWARM_MCP_DIRECTORY` resolve to the same path; locks point at the shared logical tree as a matter of course.

## 6. Exit semantics

| Situation | Worker action | Clanky's view |
|---|---|---|
| Task succeeded | `update_task(done)` → exit 0 | Waiter returns `SubAgentTurnResult` with the result text and any `kind="usage"` annotation. |
| Task failed (recoverable, with message) | `update_task(failed, result=<error>)` → exit 0 | Waiter returns `isError=true`, error text from `result`. |
| Task failed (uncaught exception, not yet reported) | best-effort `update_task(failed)`, then exit non-zero | Waiter returns `isError=true`. If `update_task` never landed, sees task stuck `claimed`/`in_progress` and translates timeout into a synthetic error. |
| Process killed externally (SIGTERM from launcher cancel) | no `update_task` required | Clanky already marked the task `cancelled` before signalling. Waiter has resolved with `cancelled`. |
| Process crashed without `update_task` | n/a | Task remains `claimed` or `in_progress` until stale-heartbeat sweep releases it (~30s). Waiter reports `worker_exit_without_result` after its own timeout. |

Workers do **not** need to call `deregister` on exit. The 10-second heartbeat plus 30-second stale sweep handles cleanup of the instance row, releases held locks, and returns claimed-but-incomplete tasks to `open`.

## 7. Telemetry

Worker telemetry goes through swarm primitives, not stdout:

- Final output → `tasks.result`
- Usage / cost → `annotate(kind="usage")`
- Progress → `annotate(kind="progress")`
- Subtask spawn → `request_task(parent_task_id=<self>)`
- Coordination findings (e.g. "this file is dangerous to edit concurrently") → `annotate(kind="hazard")`

Clanky tees worker stdout/stderr to a small ring buffer for crash diagnostics only. It is not parsed for results, cost, or progress. If you find yourself wanting to print structured data for Clanky to consume, post it through swarm primitives instead.

## 8. Versioning

This contract is keyed to swarm-mcp's `PRAGMA user_version` (currently `1`). Schema-breaking changes to swarm-mcp will bump the version; the worker contract may update in lockstep. Workers should be tolerant of unknown columns and indexes — read only the columns they need.
