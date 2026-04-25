# Swarm-Launcher Redesign Plan

Reshape Clanky's code-orchestration runtime around `swarm-mcp` as the coordination substrate. Today Clanky owns child-process lifecycle, stream parsing, session reuse, async dispatch, and progress milestones. After this redesign, Clanky becomes a **swarm-aware launcher** plus a **swarm peer**: it provisions workspaces, reserves instance rows, spawns workers with the env-var adoption pattern `swarm-ui` already established, and then talks to those workers via standard swarm-mcp tools instead of through child-process plumbing.

This is a multi-phase deletion-heavy refactor. Net code change is roughly **−2,000 lines** in `src/agents/` and **+500 lines** of focused launcher/peer/db modules.

---

## End-state architecture

Four layers, one job each:

| Layer | Owner | Responsibilities |
|---|---|---|
| Launch policy | Clanky (`src/agents/swarmLauncher.ts`) | Identity reservation, cwd, workspace mode, role token, budgets, parallel caps, env injection, spawn |
| Coordination state | swarm-mcp (`~/.swarm-mcp/swarm.db`) | Membership, tasks, messages, locks, annotations, KV, events |
| Execution | Worker (claude-code / codex CLI with swarm-mcp mounted) | Auto-adopts on boot, claims tasks, locks files, posts results via `update_task` |
| Observation | swarm-ui (desktop) and swarm-ios (mobile/remote) | Live graph, terminal binding, intervention. Both read the shared `swarm.db`. No coupling — Clanky's dashboard does not duplicate this surface. |

Clanky's brain talks to workers entirely through swarm-mcp tools (`send_message`, `request_task`, `update_task`, `wait_for_activity`, `annotate`, `kv_*`). It does not parse claude/codex CLI streams. It does not own a `SubAgentSession` for code work.

Clanky itself is a swarm peer with `origin:clanky role:planner` (one peer per active repo scope) so that:
- It appears on the `swarm-ui` graph as a stable node.
- Other peers can `send_message` to it.
- It can `request_task` against itself to record orchestration intent.

---

## Migration strategy

Direct cutover. The legacy `code_task` tool is removed from the orchestrator surface when the new `spawn_code_worker` + swarm-tool surface is enabled:

- Phases 1–4 add the new path (peer, launcher, `spawn_code_worker`, conditional swarm-tool mounting).
- Phase 5 flips the orchestrator's tool surface for `devTasks`-allowed users to the new tools and removes `code_task` from registration.
- Phase 6 deletes the old `code_task` tool, the `executeCodeTask` block, and the in-process session machinery in `src/agents/`.

---

## Phase 0 — Preflight

Cheap setup work, no behavior change.

### 0.1 Verify swarm-mcp DB ergonomics from Bun

- Confirm `bun:sqlite` can open `~/.swarm-mcp/swarm.db` with `WAL` mode and a 3s busy timeout matching `swarm-mcp/src/db.ts`.
- Read the schema directly off `~/.swarm-mcp/swarm.db` after one `swarm-mcp` boot so we never hand-copy DDL — we depend on the runtime schema, not a snapshot.
- Add a unit test that opens an empty temp DB, runs `swarm-mcp init`, and asserts the `instances` table has the expected columns (`id, scope, directory, root, file_root, pid, label, adopted, heartbeat, registered_at`).

### 0.2 Add `SWARM_DB_PATH` plumbing

`agentStack.runtimeConfig.devTeam.swarm.dbPath` already exists in `src/settings/settingsSchema.ts:351`. Add a resolver that returns the effective path (`dbPath || ~/.swarm-mcp/swarm.db`) and use it everywhere instead of recomputing.

### 0.3 Roles and labels

Lock the label format Clanky writes. Extend `buildSwarmLabel` in `src/agents/codeAgentSwarm.ts:66` to include:

```
origin:clanky provider:<harness> role:<role> thread:<channelId> user:<userId>
```

Tokens are space-separated, lowercase, `[a-z0-9_-]` only. Unknown channels become `thread:dm`. Unknown users become `user:anon`. This is what swarm-ui's filters render.

### 0.4 Document the worker contract

New doc `docs/architecture/swarm-worker-contract.md` describing what every Clanky-spawned worker must do:

1. Auto-adopt via `SWARM_MCP_INSTANCE_ID` (free — done by swarm-mcp on boot).
2. Read its task assignment from `swarm://inbox` or by `claim_task` on its assigned id.
3. Post final output via `update_task(status="done", result=<text>, metadata={ usage, costUsd })`.
4. On error, `update_task(status="failed", error=<message>)`.
5. On exit, no explicit `deregister` needed — stale heartbeat sweep handles it.

This contract becomes the first-turn preamble in phase 2.

---

## Phase 1 — Direct swarm.db writer

New module `src/agents/swarmDb.ts`. Mirrors `swarm-mcp/apps/swarm-ui/src-tauri/src/writes.rs` (`create_pending_instance`, `heartbeat_unadopted_instance`, `delete_unadopted_instance`).

### 1.1 Reservation primitive

```ts
// src/agents/swarmDb.ts
export type ReservedInstance = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  fileRoot: string;
};

export function reserveInstance(opts: {
  dbPath: string;
  directory: string;
  scope?: string;
  fileRoot?: string;
  label: string;
}): ReservedInstance;

export function heartbeatUnadopted(dbPath: string, instanceId: string): boolean;
export function deleteUnadopted(dbPath: string, instanceId: string): boolean;
export function fullDeregister(dbPath: string, instanceId: string): void; // mirrors writes.rs::deregister_instance
```

Implementation rules:
- Use `bun:sqlite` directly.
- Open RW per call; do not hold a long-lived connection (matches `writes.rs`).
- Insert with `pid=0, adopted=0, heartbeat=unixepoch()` to match swarm-ui's pattern.
- `git_root` resolution can reuse `resolveRepoRoot` from `src/agents/codeAgentWorkspace.ts:78`.

### 1.2 Heartbeat keeper

A small in-process timer that walks "reservations Clanky owns but hasn't adopted yet" and refreshes their heartbeat every 10s so they survive `swarm-mcp/src/registry.ts`'s 30s stale sweep.

```ts
// src/agents/swarmReservationKeeper.ts
export class SwarmReservationKeeper {
  reserve(opts): ReservedInstance;
  release(id: string): void;          // delete-if-still-unadopted
  shutdown(): void;
}
```

Single instance, owned by `Bot` in `src/bot.ts:353`-style construction.

### 1.3 Tests

- `src/agents/swarmDb.test.ts` — temp-dir DB, reserve/heartbeat/delete round-trip.
- Reserve → start swarm-mcp child → confirm it auto-adopts → confirm `adopted=1`.
- Reserve → never adopt → confirm pruning sweep deletes after stale window.

---

## Phase 2 — Swarm-aware launcher

New module `src/agents/swarmLauncher.ts`. Replaces what `runLocalCodeAgentOnce` and `createCodeAgentSession` do today (`src/agents/codeAgent.ts:241` and `src/agents/codeAgent.ts:617`).

### 2.1 Single launcher entry point

```ts
// src/agents/swarmLauncher.ts
export type SpawnPeerOptions = {
  harness: "claude-code" | "codex-cli";
  cwd: string;
  role: "planner" | "implementer" | "reviewer" | "researcher";
  initialPrompt: string;
  labelExtras?: { thread?: string; user?: string };
  scope?: string;
  // Resource caps (from devTeam.{harness}.* settings)
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  // Telemetry
  trace: { guildId?: string; channelId?: string; userId?: string; source?: string };
  store: { logAction: (entry: Record<string, unknown>) => void };
};

export type SpawnedPeer = {
  instanceId: string;
  scope: string;
  fileRoot: string;
  workspace: CodeAgentWorkspaceLease;
  child: ChildProcess;        // for kill on cancel
  adopted: Promise<void>;     // resolves when MCP server flips adopted=1
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export async function spawnPeer(opts: SpawnPeerOptions): Promise<SpawnedPeer>;
```

Internal sequence:

1. `resolveCodeAgentWorkspace({ cwd })` — collapses today's `provisionCodeAgentWorkspace` down to its `shared_checkout` branch: resolve repo root, validate the requested cwd is inside it, return `{ repoRoot, cwd, canonicalCwd, relativeCwd }`. **Clanky does not create git worktrees.** Workers always run in the operator-supplied checkout. (See Phase 6.1 for the cleanup of the legacy worktree code path.)
2. Build label via `buildSwarmLabel({ provider, role, thread, user })`.
3. `swarmReservationKeeper.reserve({ directory: workspace.cwd, scope: workspace.repoRoot, fileRoot: workspace.canonicalCwd, label })` → `{ id }`.
4. Build env:
   ```
   SWARM_DB_PATH=<resolved>
   SWARM_MCP_INSTANCE_ID=<id>
   SWARM_MCP_DIRECTORY=<workspace.cwd>
   SWARM_MCP_SCOPE=<workspace.repoRoot>
   SWARM_MCP_FILE_ROOT=<workspace.canonicalCwd>
   SWARM_MCP_LABEL=<label>
   ```
5. Build harness command:
   - `claude-code`: `claude --mcp-config <inline-json> -p <prompt> --output-format stream-json` — this matches today's `buildCodeAgentSessionCliArgs`. The inline mcp-config is the same JSON `claudeMcpConfig` we build today in `codeAgentSwarm.ts:147`.
   - `codex-cli`: `codex exec -m <model> -c mcp_servers.swarm.command=<...> -c mcp_servers.swarm.args=<...> <prompt>` — matches today's `codexConfigOverrides`.
6. `spawn` the child with that env. Detach stdout for telemetry (see 2.3) but **do not parse it for results** — results come back via swarm tasks.
7. Poll the DB up to N seconds for `adopted=1` on the reserved id. Resolve `adopted` promise when seen.
8. If `adopted` never resolves before the launch deadline, kill the child, `swarmReservationKeeper.release(id)`, surface a `LaunchTimeoutError`.

### 2.2 First-turn preamble

The `initialPrompt` passed to `spawnPeer` is wrapped before the harness starts:

```
You are running as a swarm peer. Your identity has been reserved and your
swarm-mcp server has auto-adopted you on boot.

Coordination contract:
- The user's request is below. Execute it directly.
- When complete, call `update_task` on your assigned task with status="done"
  and a result containing the final output text plus a metadata field with
  { usage: { input_tokens, output_tokens, cache_*_tokens }, costUsd }.
- On unrecoverable error, call `update_task` with status="failed" and a clear
  error message.
- For collaborative work in this scope, peers are visible via list_instances.
  Use lock_file before editing, unlock when done, annotate hazards.

Task:
<initialPrompt>
```

This replaces `applyCodeAgentFirstTurnPreamble` (`codeAgentSwarm.ts:159`). The reservation already exists, so the preamble is purely behavioral — no `register` instructions.

### 2.3 Telemetry without stream parsing

We still want a record of when claude-code crashed vs exited cleanly. Tee child stdout to a ring buffer (last 2 KB) and surface that on `child.exited` rejection paths in `store.logAction` as `kind=swarm_worker_exit`. We don't compute cost/usage from it — workers self-report via task metadata.

### 2.4 Tests

- `src/agents/swarmLauncher.test.ts` — fake harness command (a bun script that prints, sleeps, exits) wired through the full reserve→spawn→adopt→exit path.
- Adoption timeout test (harness that never starts MCP).
- Cancellation test (kill mid-run; reservation cleaned up; workspace cleaned up).

---

## Phase 3 — Clanky as swarm peer

Clanky's own brain registers as a swarm peer per active repo scope. Implemented in `src/agents/swarmPeer.ts`.

### 3.1 Per-scope peer manager

```ts
// src/agents/swarmPeer.ts
export class ClankySwarmPeerManager {
  ensurePeer(scope: string, repoRoot: string, fileRoot: string): ClankyPeer;
  shutdown(): void;
}

export type ClankyPeer = {
  instanceId: string;
  scope: string;
  // Wrappers around swarm-mcp tools, scoped to this peer.
  sendMessage(recipient: string, content: string): Promise<void>;
  broadcast(content: string): Promise<void>;
  pollMessages(): Promise<SwarmMessage[]>;
  requestTask(opts: RequestTaskOpts): Promise<SwarmTask>;
  getTask(id: string): Promise<SwarmTask | null>;
  waitForActivity(opts?: { timeoutMs?: number }): Promise<SwarmActivity>;
  annotate(opts: AnnotateOpts): Promise<void>;
  // …
};
```

### 3.2 Implementation choice: launch a long-lived swarm-mcp process

Clanky's peer needs to *call* swarm-mcp tools, which means an MCP client. Two options:

- **A. Embed swarm-mcp in-process.** Import its `db.ts`, `registry.ts`, `tasks.ts`, `messages.ts` directly and call them from Clanky. Fastest, no IPC, but couples Clanky to swarm-mcp internals.
- **B. Spawn a long-lived swarm-mcp stdio process per scope and speak MCP to it.** Clean boundary, slower, more processes.

Pick **A**. swarm-mcp is in the same monorepo (well, sibling repo we control); its DB modules are pure SQLite operations. Re-implementing them cleanly is small. Wrap them in `swarmPeer.ts` so the rest of Clanky depends only on the wrapper. If we later want isolation, we can flip to B without touching call sites.

To keep B as a viable fallback, expose every operation as an async function so the wrapper can be swapped for a transport-layer implementation later.

### 3.3 Peer label

```
origin:clanky role:planner thread:<channelId> user:<userId>
```

`role:planner` is the long-term identity — Clanky's brain plans/dispatches/reviews. The actual coding work goes to spawned peers with `role:implementer`.

### 3.4 Heartbeat

Same 10s heartbeat the swarm-mcp server uses for its own peers, applied to Clanky's peer rows.

### 3.5 Tests

- Peer registers, heartbeats, deregisters cleanly.
- Multi-scope: two repo scopes → two peers, no cross-talk.
- Crash recovery: restart Clanky → existing peer rows are stale → cleanly re-register without duplicates.

---

## Phase 4 — Dissolve `code_task` into `spawn_code_worker` + swarm-mcp tools

The original framing of this phase ("rewire `executeCodeTask` to swarm internally") is replaced. After the redesign, the orchestrator drives dispatches by speaking swarm-mcp directly. `code_task` is not refactored — it is removed.

### 4.1 New tool surface

One Clanky-specific tool replaces `code_task`:

```ts
// src/tools/sharedToolSchemas.ts (new entry; old code_task entry deleted)
spawn_code_worker({
  task: string,                 // initial task description
  role?: "design" | "implementation" | "review" | "research",
  harness?: "claude-code" | "codex-cli",  // overrides role-based routing
  cwd?: string,
}) → { workerId: string, taskId: string, scope: string }
```

This tool owns everything Clanky-specific:

- Permissions gate (`permissions.devTasks.allowedUserIds`).
- Resource caps (`maxTasksPerHour`, `maxParallelTasks` per harness — see §4.5 below for where the bookkeeping lives now).
- `cwd` resolution + repo-root → swarm scope mapping.
- The reserve → spawn → adopt → assign sequence (Phase 1 + Phase 2 primitives).
- Returns the `taskId` and `workerId`; the orchestrator drives the rest.

The implementation is a thin wrapper:

```ts
// pseudo
const peer = peerManager.ensurePeer(scope, repoRoot, fileRoot);
const reservedTaskId = await peer.requestTask({
  type: typeForRole(role),
  title: shortTitle(task),
  description: task,
});
const spawned = await spawnPeer({
  harness: harness ?? workerForRole(role),
  cwd: resolvedCwd,
  role: role ?? "implementation",
  initialPrompt: buildInitialPrompt({ task, taskId: reservedTaskId, peerId: peer.instanceId }),
  labelExtras: { thread: channelId, user: userId },
  scope,
  ...resourceCaps,
  trace,
  store,
});
await spawned.adopted;
await peer.assignTask(reservedTaskId, spawned.instanceId);
return { workerId: spawned.instanceId, taskId: reservedTaskId, scope };
```

### 4.2 Conditional swarm-tool mounting

For `devTasks`-allowed users on dev-allowed channels, mount the swarm-mcp tool surface directly into the orchestrator's reply loop alongside `spawn_code_worker`:

- `request_task`, `get_task`, `list_tasks`, `update_task`, `claim_task`
- `send_message`, `broadcast`, `wait_for_activity`
- `annotate`, `lock_file`, `unlock_file`, `check_file`
- `list_instances`, `whoami`
- `kv_get`, `kv_set`, `kv_delete`, `kv_list`

Implementation: extend the conditional-tool pattern in `src/tools/toolRegistry.ts`. The tools resolve through Clanky's per-scope planner peer (the same `peerManager.ensurePeer(...)` instance used by `spawn_code_worker`), so a single peer identity speaks for the orchestrator across the whole reply turn.

For non-`devTasks` users, none of these tools are mounted — the entire substrate is invisible to community-tier conversations.

### 4.3 Action collapse

The dissolution erases the old `code_task` action enum. The orchestrator expresses each former action through the appropriate swarm-mcp tool:

| Old `code_task` action | New flow |
|---|---|
| `run` | `spawn_code_worker(...)` → `{ workerId, taskId }` → `wait_for_activity(taskId)` → `get_task(taskId)` |
| `status` | `get_task(taskId)` (and optionally `list_tasks` for sibling tasks) |
| `cancel` | `update_task(taskId, status="cancelled")` + the peer manager SIGTERMs the still-running worker on `cancelled` transitions |
| `followup` | Either `send_message(workerId, content)` if a long-lived inbox-loop worker is running, **or** `request_task({ parent_task_id: originalTaskId, ... })` followed by another `spawn_code_worker` for a fresh worker. Orchestrator chooses. |

The orchestrator's reasoning loop stitches these calls together. There is no procedural wrapper enforcing one action shape per dispatch — multi-worker fan-out and inter-worker messaging fall out of the substrate naturally.

### 4.4 Result delivery and progress

Both paths (synchronous awaits and voice-realtime progress) read from swarm activity events, not from a `code_task`-specific code path:

- **Synchronous text turn**: the orchestrator's `wait_for_activity(taskId)` call blocks the turn until the task reaches a terminal status. The result text comes back via `get_task`.
- **Voice realtime + voice text-mediated**: a runtime-side subscription in `swarmActivityBridge.ts` (new, ~80 lines) watches all tasks where `requester` matches the local Clanky planner peer. On terminal status or `kind="progress"` annotation, it emits the synthetic `code_task_progress` / `code_task_result` events into the reply pipeline / `VoiceSessionManager.requestRealtimeCodeTaskFollowup(...)`. Same delivery shape as today's `BackgroundTaskRunner`, just sourced from swarm events instead of in-process callbacks.

This subscription is registered once per active peer scope, not per dispatch. It does not require the orchestrator to remember to subscribe.

### 4.5 Resource cap bookkeeping

Today `maxParallelTasks` and `maxTasksPerHour` are enforced in-process by the session manager. In the dissolved model, `spawn_code_worker` is the only choke point that creates workers, so it owns the counters:

- Per-harness in-memory counter of active spawned workers (decremented when their swarm task reaches terminal status, observed via the same `swarmActivityBridge` subscription).
- Per-harness rolling-window counter of tasks dispatched in the last hour.
- Both checks happen *before* `requestTask` / `spawnPeer` are called.

This is ~40 lines in `spawn_code_worker.ts` and is the only place rate-limiting lives.

### 4.6 Tests

- `src/tools/spawnCodeWorker.test.ts` — happy path: spawn → activity event → terminal status, with the fake harness from Wave 1.
- Cancel test: spawn → `update_task(cancelled)` → assert worker child got SIGTERM.
- Followup test: spawn → `send_message(workerId, ...)` → worker (running an inbox loop in fixture form) picks it up. (If we ship inbox-loop workers in Phase 4; otherwise covered by a separate spawn-followup test.)
- Permission test: non-`devTasks` user → `spawn_code_worker` and the swarm tool surface are absent from the tool list.
- Resource cap test: spawn N+1 workers when `maxParallelTasks=N` → second one fails with a deterministic cap error before any `requestTask` is issued.

---

## Phase 5 — Cutover

Flip the default tool surface and start running the new path on real Discord traffic.

### 5.1 Tool surface flip

For `devTasks`-allowed users on dev-allowed channels, mount `spawn_code_worker` + the conditional swarm-mcp tool surface (per §4.2). For everyone else, mount neither. The legacy `code_task` tool is removed from `sharedToolSchemas.ts` in this phase — there is no `execution.mode` enum to flip.

### 5.2 Soak

Run for one release cycle. Collect:
- Adoption-failure rate (workers that never flip to `adopted=1`).
- Median time from `spawn_code_worker` return → `update_task(done)` event observed by `swarmActivityBridge`.
- Error classification for failed `spawn_code_worker` + swarm-tool runs, compared against pre-cutover baselines where available.
- Orchestrator behavior: how often does the model use `send_message` followups vs spawning fresh workers? Useful signal for whether long-lived inbox-loop workers earn their keep.

### 5.3 Observation surface

Swarm observation is owned by `swarm-ui` (desktop) and `swarm-ios` (mobile/remote), not by Clanky's dashboard. Both read the same `~/.swarm-mcp/swarm.db` and provide the live peer graph, task list, terminal binding, and intervention. No new dashboard view is added in this phase — adding one would duplicate functionality that already lives outside the bot.

The `/clank code` slash command becomes a thin wrapper that calls `spawn_code_worker` + `wait_for_activity` server-side; the user-facing surface is unchanged.

---

## Phase 6 — Delete the old path

Once soak is clean, remove the in-process session machinery.

### 6.1 Files deleted

- `src/agents/codeAgent.ts` (695 lines) — the `runLocalCodeAgentOnce` + `CodeAgentSession` class. Keep only `resolveCodeAgentConfig` (settings reader) and `isCodeAgentUserAllowed` (permissions); move them to `src/agents/codeAgentSettings.ts` (~80 lines).
- `src/agents/codexCliAgent.ts` (195 lines) — gone.
- `src/agents/baseAgentSession.ts` (172 lines) — kept *only* if browse/minecraft sessions still need it. Audit: if `BrowseAgentSession` and `MinecraftAgentSession` are the only consumers, leave it; otherwise inline.
- `src/agents/backgroundTaskRunner.ts` (534 lines) — gone. The progress/cancel/followup hooks live in the new `peer.waitForTaskCompletion` and a small `src/agents/swarmTaskWaiter.ts` (~150 lines).
- `src/agents/codeAgentSwarm.ts` (current ~165 lines) — shrinks to just `buildSwarmLabel` and the worker-contract preamble builder (~60 lines).
- `src/agents/codeAgentWorkspace.ts` — collapses to a single `resolveCodeAgentWorkspace({ cwd })` helper. Delete the `isolated_worktree` branch, the `WORKTREE_PARENT_DIR` temp dir, the `runGitOrThrow`/`resolveBaseRef`/branch + worktree creation code, and the lease's `cleanup()` plumbing. Clanky does not create or remove git worktrees at runtime; the operator's checkout is the only workspace.
- `src/settings/codeAgentWorkspaceMode.ts` — delete. With only one workspace shape, the `ResolvedCodeAgentWorkspaceMode` union and its resolver are dead.

### 6.2 Files modified

- `src/agents/subAgentSession.ts` — `SubAgentSessionManager` keeps existing browse/minecraft session types but loses `"code"` from `SubAgentSession.type` union. The code-related code paths in `replyTools.ts` and `bot.ts` no longer touch it.
- `src/llm/llmClaudeCode.ts` — keep `buildCodeAgentSessionCliArgs` (the launcher uses it). Delete `createClaudeCliStreamSession` and `parseClaudeCodeStreamOutput` (both exist for the persistent stream path that's gone).
- `src/llm/llmCodexCli.ts` — same shape. Keep arg-builder; delete stream session + parser.
- `src/voice/voiceSessionManager.ts` — references to `subAgentSessions.createCodeSession` and `BackgroundTaskRunner` hooks become calls to the swarm-tool surface and the swarm activity bridge.
- `src/bot.ts:353-426` — `subAgentSessions = new SubAgentSessionManager` stays for browse/minecraft. Code-agent runtime construction moves to `peerManager`, `swarmReservationKeeper`, and `swarmActivityBridge`.
- `src/bot/agentTasks.ts:637-638` — drop `createCodeSession`; the slash command path calls `spawn_code_worker` + `wait_for_activity` server-side.
- `src/tools/replyTools.ts:444, 1280-1479` — **the entire `executeCodeTask` block deletes outright.** Replaced by the much smaller `spawn_code_worker` tool handler (~50 lines) plus the conditional mounting glue. No procedural action enum, no session_id plumbing, no in-process status/cancel/followup.
- `src/tools/sharedToolSchemas.ts:200` — `code_task` schema **deleted**. `spawn_code_worker` schema added (~15 lines). Conditional swarm-tool schemas added behind a `dev-tasks` capability gate.
- `src/tools/toolRegistry.ts` — extend the conditional-tool pattern to mount the swarm-mcp tool surface for `devTasks`-allowed users.

### 6.2a New file

- `src/agents/swarmActivityBridge.ts` (~120 lines) — registered once per active planner-peer scope. Subscribes to swarm task events, emits synthetic `code_task_progress` / `code_task_result` events into the reply pipeline / voice realtime delivery (replaces the in-process `BackgroundTaskRunner` callback model).

### 6.3 Settings cleanup

In `src/settings/settingsSchema.ts`, the `devTeam` shape simplifies:

```ts
devTeam: {
  // No more `workspace.mode` — Clanky never creates worktrees. Workers run
  // in the operator's checkout. The `workspace` group, the
  // `ResolvedCodeAgentWorkspaceMode` union, and the auto/shared/isolated
  // resolver all go away.
  // No more `execution.mode` enum — there is only one path.
  swarm: {
    dbPath: "",              // override SWARM_DB_PATH
  },
  claudeCode: {
    enabled: false, model: "sonnet", timeoutMs: 300_000, maxBufferBytes: ...,
    defaultCwd: "", maxTasksPerHour: 10, maxParallelTasks: 2,
    // No more asyncDispatch — async is the only mode.
  },
  codexCli: { /* same shape */ },
  roles: {
    // role → harness mapping for spawn_code_worker's optional role param.
    // Unchanged in shape from pre-redesign.
  },
}
```

### 6.4 Estimated impact

- Lines removed: ~1,800 (agents/) + ~700 (`replyTools.ts`'s `executeCodeTask` block, action handlers, session-id plumbing) + ~200 (settings/voice/bot) ≈ **~2,700**
- Lines added across phases 1–4: ~600 (`swarmDb`, `swarmLauncher`, `swarmPeer`, `swarmActivityBridge`, `spawn_code_worker` tool handler, conditional swarm-tool schemas, tests excluded from count)
- Net change: **~−2,100 production lines**, plus removal of three whole runtime concepts (in-process code session, BackgroundTaskRunner, the procedural `code_task` action enum / session-id plumbing)

---

## Worker-side changes (swarm-mcp side)

Mostly already supported. Confirm and polish:

### W.1 `request_task` accepts an explicit assignee

Already supported (`swarm-mcp/src/index.ts:114-157` shows the schema). Confirm `claim_task` semantics when `assignee` is preassigned: it should be a no-op claim if the assignee already matches.

### W.2 `update_task` `metadata` is preserved verbatim

Confirm in `swarm-mcp/src/tasks.ts` that arbitrary JSON in `metadata` round-trips through `get_task`. We rely on this for cost/usage reporting.

### W.3 Worker behavior under `claude -p` and `codex exec`

Both harnesses run one-shot in this mode. Verify swarm-mcp's `register` tool is exposed in time for the worker's first reasoning turn — i.e. that auto-adopt happens before the model starts streaming. If there's a race (model decides to call swarm tools before the MCP server fully connects), add a 200ms warmup in the launcher between spawn and prompt delivery. (This may already be handled by the MCP client's tool-discovery handshake; verify.)

### W.4 Progress annotations

Define the convention: workers emit progress updates by calling `annotate` with `kind="progress"` on the running task. Clanky's `swarmTaskWaiter` listens for `task.annotated` events and forwards to Discord. Document this in the worker contract.

---

## Risks and rollbacks

| Risk | Mitigation |
|---|---|
| Worker fails to auto-adopt within timeout | Launcher kills child + cleans reservation + returns clean error. Retry once with longer warmup. |
| Worker exits without `update_task` | `swarmTaskWaiter` has its own timeout. On expiry: mark task `failed`, return error to Discord turn. Telemetry tags with `worker_exit_without_result`. |
| `bun:sqlite` and Bun-side `swarm-mcp` race on the same DB | Both already use WAL + busy timeout; we mirror those settings in `swarmDb.ts`. Add a stress test that hammers reservations from Clanky while a swarm-mcp child is running. |
| Cost/usage drift from worker self-report | Cross-check against per-process `claude` API receipts when available. Acceptable drift: ±5%. If higher, parse a small portion of stream stdout in the launcher's ring buffer for spot checks. |
| Voice realtime needs faster progress updates than swarm polling | Swarm `wait_for_activity` is event-driven, not polling. Confirm latency is <500 ms end-to-end on local DB. If higher, switch the in-process embed (option 3.2.A) to direct event emitters. |
| Behavior regression vs old path | Roll forward on the swarm path: gate the new tool surface to `devTasks`-allowed users, monitor soak metrics, and fix failures before expanding access. |

Rollback: disable the `devTasks` allowlist while fixes land. There is no phase-5 legacy tool fallback.

---

## Open questions

1. **One-shot vs long-lived workers.** Phase 4 starts with one-shot per task (spawn → run → exit). Voice realtime use cases (followup, multi-turn) may want long-lived workers that loop on inbox. Decide before phase 5 whether long-lived is a phase-7 follow-up or part of phase 4.

2. **Permissions enforcement layer.** Today `isCodeAgentUserAllowed` gates `code_task` at the tool-call boundary. After this redesign, the same gate applies to `spawnPeer`. But Clanky-as-peer's own `request_task` calls don't go through the gate — they're already gated by the upstream tool call. Confirm no path lets an unauthenticated swarm peer post tasks that Clanky-spawned workers will claim.

3. **Multi-host scope.** swarm.db is a single SQLite file. If Clanky runs on host A and the user opens swarm-ui on host B, they don't share state. Out of scope for this plan — note in the architecture doc that the swarm scope is single-host today.

4. **Owner-only operator UI.** Should Clanky's dashboard include a `Spawn worker manually` button (for the owner) that calls `spawnPeer` directly? Useful for debugging but not load-bearing. Defer to post-phase-6.

5. **What happens to `BrowseAgentSession` and `MinecraftAgentSession`?** They're orthogonal — they don't need swarm coordination today. Leave them on the `SubAgentSession` framework. The framework stays; only the code agents move out.
