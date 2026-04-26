# Swarm Worker Contract

This document defines the behavioral contract every worker process Clanky spawns into the `swarm-mcp` coordination layer must follow. It is the runtime counterpart to the env-driven adoption protocol — the env vars give the worker its identity, this contract tells the worker what to do with it.

This contract applies only to **Clanky-spawned workers**. Sessions launched through `swarm-ui`'s Launcher, manual `claude --mcp-config` invocations, or peer agents that joined the swarm on their own terms can register and coordinate however they like.

Companion docs:

- [`overview.md`](./overview.md) — runtime architecture
- [`../capabilities/code.md`](../capabilities/code.md) — `spawn_code_worker` and swarm-tool capability surface
- [`../tmp/swarm-launcher-redesign-plan.md`](../tmp/swarm-launcher-redesign-plan.md) — the redesign that introduces this contract
- `swarm-mcp/docs/generic-AGENTS.md` — generic peer coordination rules

## 1. Identity and adoption

Workers do not call swarm-mcp's `register` tool by hand. Clanky either asks `swarm-server` to create a PTY-backed pending instance row, or falls back to pre-creating the unadopted row directly in `swarm.db`. In both modes, the launched worker receives these env vars:

| Variable | Purpose |
|---|---|
| `SWARM_DB_PATH` | Path to the shared SQLite file. Defaults to `~/.swarm-mcp/swarm.db`. |
| `SWARM_MCP_INSTANCE_ID` | The pre-reserved instance row's UUID. The MCP server flips `adopted=1` on boot via `tryAutoAdopt`. |
| `SWARM_MCP_DIRECTORY` | Live working directory (the worker's resolved cwd inside the operator's checkout). |
| `SWARM_MCP_SCOPE` | Canonical repo root used as the swarm membership boundary. Sessions in the same scope can see each other; different scopes are separate swarms. |
| `SWARM_MCP_FILE_ROOT` | Canonical base path for resolving relative file paths in `annotate`, `lock_file`, `check_file`, and task `files`. Equal to `SWARM_MCP_DIRECTORY` because Clanky never spawns workers into disposable worktrees; the field is preserved for symmetry with swarm-mcp's schema and with non-Clanky peers that may run worktree-isolated. |
| `SWARM_MCP_LABEL` | Machine-readable label tokens. Format: `origin:clanky provider:<harness> role:<role> thread:<channel> user:<user>`. |

By the time the worker's first reasoning turn runs, the worker's swarm-mcp server has already adopted the row (`adopted=1`, `pid=<worker pid>`, `heartbeat=now`). The worker may call `whoami` to confirm or skip straight to coordinated work.

If adoption fails (e.g. `SWARM_DB_PATH` unwritable, schema mismatch), the worker should surface the failure on stderr and exit non-zero. Clanky's launcher polls for `adopted=1` and treats a missed timeout as a launch error, closing the `swarm-server` PTY when present or cleaning up the directly reserved row otherwise.

## 2. Task lifecycle

Every Clanky-spawned worker is associated with one initial swarm task at spawn time. The task is created by Clanky's planner peer with `requester=<clanky-peer-id>` and `assignee=<worker-instance-id>`. The assigned task id is included in the first-turn preamble.

Worker responsibilities, in order:

1. **Claim** — call `claim_task(task_id)` once on first turn. Idempotent if `assignee` already matches.
2. **Execute** — perform the requested work. Files outside the assigned scope are off-limits unless explicitly granted.
3. **Report progress** (optional but recommended for long tasks) — emit `annotate` calls (see §4) so the orchestrator can stream updates back to the user.
4. **Complete on success** — call `update_task(task_id, status="done", result=<final output text>)`.
5. **Complete on failure** — call `update_task(task_id, status="failed", result=<short error message>)`. Do not silently exit non-zero on recoverable errors — the task ledger is the source of truth.
6. **Followup or exit** — see §2a below.

### 2a. Followups: brief listen window

After completing the assigned task, every Clanky-spawned worker stays available briefly for follow-up coordination. There is no one-shot vs inbox-loop mode switch in settings or prompts.

After `update_task(done)`, the worker continues running and polls its inbox via `wait_for_activity` / `list_messages` for roughly the configured follow-up window. When Clanky's orchestrator wants a followup, it calls `send_message(workerId, content)` or `send_message(session_key, content)`; the worker treats the message body as a follow-up instruction, claims or creates the appropriate follow-up task, executes, and reports again. The worker exits when it receives an explicit termination message or when the listen window elapses.

`spawn_code_worker` persists the latest `{ workerId, taskId, scope, role, cwd }` record into swarm KV under the returned `sessionKey`. This is a convenience pointer for Clanky's future reply turns; the worker still receives ordinary swarm messages and does not need to know the key exists.

Clanky also writes its scoped controller peer id to `kv_get("clanky/controller")`. Planner workers use that pointer, with a `list_instances(label_contains="origin:clanky role:planner")` fallback, when they need to escalate a stranded open task.

The MCP stale-heartbeat sweep (~30s) reclaims tasks abandoned by either shape.

Task statuses (from `swarm-protocol`): `open | claimed | in_progress | done | failed | cancelled | blocked | approval_required`.

Task types: `review | implement | fix | test | research | other`.

## 3. Result reporting

The `result` column in the `tasks` table is opaque text. By convention, Clanky-spawned workers post the **final user-facing output text** there as plain text, not structured JSON. Clanky's `swarmTaskWaiter` returns that text for synchronous tool waits. For async terminal events, Clanky feeds the text into its normal reply pipeline so the top-level agent remains the final arbiter before a Discord follow-up is posted.

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

Clanky subscribes to swarm activity events for the assigned task and logs these against the originating Discord context. Recommended cadence: at most one progress annotation every 30 seconds, or whenever a notable file edit / subtask transition occurs.

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

Workers may inspect git state, but they do not commit, push, create pull requests, or rewrite git history unless the user's task explicitly authorizes that action.

## 6. Exit semantics

| Situation | Worker action | Clanky's view |
|---|---|---|
| Task succeeded | `update_task(done)`, then exit or remain idle in the PTY | Waiter returns `SubAgentTurnResult` with the result text and any `kind="usage"` annotation. |
| Task failed (recoverable, with message) | `update_task(failed, result=<error>)`, then exit or remain idle in the PTY | Waiter returns `isError=true`, error text from `result`. |
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
- Inbox-loop resume pointer → swarm KV record returned as `sessionKey`
- Stranded task escalation → `send_message(controller, JSON.stringify({ v: 1, kind: "spawn_request", taskId, role, reason }))`
- Coordination findings (e.g. "this file is dangerous to edit concurrently") → `annotate(kind="hazard")`

Clanky tees worker stdout/stderr to a small ring buffer for crash diagnostics only. It is not parsed for results, cost, or progress. If you find yourself wanting to print structured data for Clanky to consume, post it through swarm primitives instead.

## 8. Versioning

This contract is keyed to swarm-mcp's `PRAGMA user_version` (currently `1`). Schema-breaking changes to swarm-mcp will bump the version; the worker contract may update in lockstep. Workers should be tolerant of unknown columns and indexes — read only the columns they need.
