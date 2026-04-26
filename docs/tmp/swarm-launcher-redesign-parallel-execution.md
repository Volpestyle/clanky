# Swarm-Launcher Redesign — Parallel Execution Plan

Companion to [`swarm-launcher-redesign-plan.md`](./swarm-launcher-redesign-plan.md). Maps the six phases onto a dependency DAG and assigns parallel work waves so the redesign lands in ~3–4 days of wall time instead of ~7–10 done serially.

---

## Dependency DAG

```
                    Wave 1 — Preflight (parallel, ~3 hours)
        ┌──────────────────────────────────────────────────────┐
        │ Agent P1: 0.1 DB ergo + 0.2 SWARM_DB_PATH plumbing   │
        │ Agent P2: 0.3 label format + 0.4 worker contract doc │
        │           + shared fake-harness test fixture         │
        └────────────────────┬─────────────────────────────────┘
                             │ merge to main
        ┌────────────────────┴─────────────────────────────────┐
        │                                                       │
        │ Wave 2A — Worker spawn track (~1.5 days)              │
        │   Agent W: Phase 1 (swarmDb, reservationKeeper)       │
        │            → Phase 2 (swarmLauncher)                  │
        │   Files: src/agents/swarmDb.ts                        │
        │          src/agents/swarmReservationKeeper.ts         │
        │          src/agents/swarmLauncher.ts                  │
        │          (small) src/agents/codeAgentSwarm.ts edit    │
        │                                                       │
        │ Wave 2B — Peer track (~1 day, parallel with 2A)       │
        │   Agent P: Phase 3 (swarmPeer, peer manager)          │
        │   Files: src/agents/swarmPeer.ts                      │
        │          src/agents/swarmPeerManager.ts               │
        │          (read-only) swarm-mcp/src/{registry,tasks,   │
        │                       messages,context,kv}.ts          │
        └────────────────────┬─────────────────────────────────┘
                             │ both merged
                             ▼
        Wave 3 — Integration (~1 day, sequential)
        Agent I: Phase 4 (code_task rewires to swarm path)
        Files: src/tools/replyTools.ts (heavy edit)
               src/agents/swarmTaskWaiter.ts (new)
               src/voice/voiceSessionManager.ts (small)
               src/bot.ts (small, runtime construction)
               src/bot/agentTasks.ts (small)
               src/settings/settingsSchema.ts (execution.mode flag)
                             │
                             ▼
        Wave 4 — Soak (release cycle, operator-driven, no agent)
                             │
                             ▼
        Wave 5 — Deletion (~half day, one agent)
        Agent D: Phase 6 (delete old in-process session machinery)
```

---

## Why this DAG

The tracks parallelize cleanly because **the new code is mostly new files, not edits to shared files**:

- `swarmDb.ts`, `swarmReservationKeeper.ts`, `swarmLauncher.ts`, `swarmPeer.ts`, `swarmPeerManager.ts`, `swarmTaskWaiter.ts` — all new. Zero merge surface with each other.
- The few shared-edit files (`codeAgentSwarm.ts`, `settingsSchema.ts`, `replyTools.ts`) are touched by exactly one wave each, so no two agents fight over the same lines.
- Wave 2A and Wave 2B share **only** the low-level DB connection helper from Phase 1.1. Wave 2B can stub that helper for its first day of work and swap to the real one when 2A's branch lands.

The narrow point is **Wave 3 (integration)**: it must read all of 2A and 2B's output. That's why it's a single agent with full context, not a parallel job.

---

## Agent assignments

### Wave 1 — Preflight

**Agent P1** (~2 hours)

- Inputs: this plan + the redesign doc.
- Deliverables:
  - `src/agents/swarmDbConnection.ts` — small helper that opens `SWARM_DB_PATH` (or `~/.swarm-mcp/swarm.db`) with WAL + 3s busy timeout via `bun:sqlite`. Exported for reuse by Phase 1 and Phase 3.
  - `src/agents/swarmDbConnection.test.ts` — verifies WAL mode + busy timeout + concurrent open.
  - Schema-snapshot test: spawn `bun run /path/to/swarm-mcp/src/index.ts` once, then assert the `instances` table has `id, scope, directory, root, file_root, pid, label, adopted, heartbeat, registered_at`.
  - Settings resolver `getSwarmDbPath(settings)` if not already present.

**Agent P2** (~2 hours)

- Inputs: this plan + `src/agents/codeAgentSwarm.ts`.
- Deliverables:
  - Updated `buildSwarmLabel` in `src/agents/codeAgentSwarm.ts:66` to emit `origin:clanky provider:<harness> role:<role> thread:<channelId> user:<userId>`.
  - New `docs/architecture/swarm-worker-contract.md` describing what every Clanky-spawned worker must do (auto-adopt, claim/update task, post result+metadata, error/exit semantics, progress via `annotate`).
  - **Shared fake-harness fixture** at `src/agents/__fixtures__/fakeSwarmWorker.ts` — a small Bun script Wave 2A and 2B will both use in tests. It registers via swarm-mcp adoption, optionally claims a task, optionally posts a fake result, and exits. Parameterized via env vars (`FAKE_WORKER_BEHAVIOR=adopt_then_exit | claim_and_complete | hang | etc.`).

Both agents land independently. Merge order doesn't matter.

### Wave 2A — Worker spawn track

**Agent W** (~1.5 days, sequential within the track)

- Inputs: Wave 1 merged. Reads `src/agents/codeAgentWorkspace.ts`, `src/llm/llmClaudeCode.ts`, `src/llm/llmCodexCli.ts`, `swarm-mcp/apps/swarm-ui/src-tauri/src/writes.rs` (as reference).
- Deliverables (in order):
  1. **Phase 1**: `src/agents/swarmDb.ts` (`reserveInstance`, `heartbeatUnadopted`, `deleteUnadopted`, `fullDeregister`) + `swarmReservationKeeper.ts` + tests using the fake harness.
  2. **Phase 2**: `src/agents/swarmLauncher.ts` exporting `spawnPeer({...}) → SpawnedPeer`. Wires Phase 1 + workspace provisioning + env injection + adoption polling. Includes the new first-turn preamble builder.
  3. Updates `src/agents/codeAgentSwarm.ts` to drop `applyCodeAgentFirstTurnPreamble`'s register-instructions in favor of behavioral-only preamble.
  4. Tests: full reserve → spawn → adopt → exit using `fakeSwarmWorker.ts`. Adoption-timeout test. Cancellation test.

### Wave 2B — Peer track

**Agent P** (~1 day, parallel with Wave 2A)

- Inputs: Wave 1 merged. Reads `swarm-mcp/src/{registry,tasks,messages,context,kv,events,paths}.ts` to understand surface area, then ports / imports needed pieces.
- Deliverables:
  1. **Phase 3**: `src/agents/swarmPeer.ts` exporting `ClankyPeer` with `sendMessage`, `broadcast`, `pollMessages`, `requestTask`, `assignTask`, `getTask`, `updateTask`, `waitForActivity`, `annotate`.
  2. `src/agents/swarmPeerManager.ts` exporting `ClankySwarmPeerManager.ensurePeer(scope, repoRoot, fileRoot)`.
  3. Heartbeat loop (10s, mirroring swarm-mcp's own).
  4. Tests: peer registers/heartbeats/deregisters; multi-scope isolation; restart-recovery (stale peer rows cleanly re-registered).

Implementation choice: pick option **A** from the redesign plan (embed swarm-mcp DB modules in-process by re-implementing the small subset of operations Clanky calls, against the shared `swarmDbConnection.ts`). Do **not** spawn a swarm-mcp child for Clanky's own peer — that's option B and adds latency.

### Wave 3 — Integration

**Agent I** (~1 day, sequential after 2A and 2B both merged)

- Inputs: everything in 2A + 2B + the redesign plan's Phase 4 spec.
- Deliverables:
  1. `src/tools/spawnCodeWorker.ts` — the new tool handler. Owns permissions gate, resource caps, cwd resolution, and the `peerManager.ensurePeer → peer.requestTask → spawnPeer → peer.assignTask` sequence. Returns `{ workerId, taskId, scope }`. ~50 lines.
  2. `src/tools/sharedToolSchemas.ts` — add the `spawn_code_worker` tool schema. Add the conditional swarm-mcp tool schemas (`request_task`, `wait_for_activity`, `get_task`, `update_task`, `send_message`, `broadcast`, `annotate`, `lock_file`, `unlock_file`, `check_file`, `list_instances`, `whoami`, `kv_*`). Do **not** delete `code_task` yet — Wave 5 does that.
  3. `src/tools/toolRegistry.ts` — extend the conditional-tool pattern to gate the swarm-mcp tool surface behind `permissions.devTasks.allowedUserIds` + dev-channel allowlist. Both `spawn_code_worker` and the swarm tools mount/unmount together for a given turn.
  4. Each conditional swarm-mcp tool is a thin wrapper around the corresponding `peer.*` method — they all resolve through the per-scope planner peer, so a single peer identity speaks for the orchestrator across the turn.
  5. `src/agents/swarmActivityBridge.ts` — runtime-side subscription registered once per active planner-peer scope. Watches swarm task events; emits `code_task_progress` / `code_task_result` synthetic messages into the reply pipeline; routes voice-realtime completions through `VoiceSessionManager.requestRealtimeCodeTaskFollowup(...)`. ~120 lines.
  6. `src/agents/swarmTaskWaiter.ts` — small helper for `wait_for_activity`-style blocking used internally by both the conditional swarm tool and the `/clank code` slash command. Returns the `SubAgentTurnResult`-shaped object.
  7. Wire `peerManager`, `swarmReservationKeeper`, and `swarmActivityBridge` into `src/bot.ts:353-426` runtime construction. All three lifecycle-managed alongside `subAgentSessions`.
  8. Tests: spawn happy path, cancel via `update_task`, timeout, permission gating (non-dev user sees neither `spawn_code_worker` nor the swarm tools), resource cap rejection before any DB writes — all using the Wave 1 fake harness.

### Wave 4 — Soak

No agent. Operator enables the new tool surface (`spawn_code_worker` + conditional swarm tools) for owner-only Discord users via `agentStack.overrides.devTasks.allowedUserIds`, runs for one release cycle, watches:
- Adoption-failure rate
- Median `spawn_code_worker` return → terminal task event time
- Error classification for `spawn_code_worker` + swarm-tool runs, compared against pre-cutover baselines where available
- Cost/usage drift (worker self-report vs receipts)
- Orchestrator behavior signals: how often does the model use `send_message` followups vs spawning fresh workers? `request_task` with `parent_task_id`? Multi-worker fan-out?

### Wave 5 — Deletion

**Agent D** (~half day, after soak passes)

- Deliverables: Phase 6. Delete the `code_task` schema from `sharedToolSchemas.ts` and the entire `executeCodeTask` block in `replyTools.ts`. Delete `src/agents/codeAgent.ts` (most of), `codexCliAgent.ts`, `backgroundTaskRunner.ts`. Shrink `codeAgentSwarm.ts`. Move `resolveCodeAgentConfig` + `isCodeAgentUserAllowed` to `codeAgentSettings.ts`. Trim `subAgentSession.ts` to drop the `"code"` type variant. Trim `llmClaudeCode.ts` and `llmCodexCli.ts` to keep only arg-builders. Rewire `/clank code` and the dashboard form to call `spawn_code_worker` + `wait_for_activity` server-side. Update all remaining call sites.

This is mechanical. One agent, single PR, no parallelism needed.

---

## Coordination mechanics

### Worktrees, not the same checkout

Each Wave 2 agent works in its own `git worktree` off `main`:

```
clanky/                          # operator
clanky-worktrees/wave2a-spawn/   # Agent W
clanky-worktrees/wave2b-peer/    # Agent P
```

These worktrees are **operator-managed at development time**, not Clanky-spawned at runtime. The redesign drops the runtime `isolated_worktree` workspace mode (Clanky no longer creates worktrees per worker); manually creating worktrees here is just a normal multi-agent dev workflow.

Reasons:
- The redesign deletes a chunk of `src/agents/` later. Agents shouldn't see each other's WIP.
- Both agents get a clean branch off `main` so neither inherits the other's unmerged commits.

### Shared fixtures live on `main`

`fakeSwarmWorker.ts` (Wave 1 P2) lands on `main` before Wave 2 starts. Both Wave 2 agents pull from `main`, so both have the fixture. No cross-branch dependency.

### Merge order between 2A and 2B

Either order works — they don't touch each other's files. Whichever PR is reviewed first lands first. The second rebases onto `main` (no conflicts expected).

### Merge sequence for Wave 3

Wave 3 (integration) requires both 2A and 2B merged. If 2B is delayed, Wave 3 can start against 2A only and stub `peer.requestTask`/`peer.waitForTaskCompletion` — but this is wasteful, so prefer to wait.

### Optional: dogfood by running the agents through swarm-mcp itself

Each Wave 2 agent registers in a swarm scope at the clanky repo root with `role:implementer name:wave2a` / `name:wave2b`. They use `lock_file` before editing the few shared files (`codeAgentSwarm.ts`, `settingsSchema.ts`). They post `annotate` calls as they finish each phase. The operator (or a `role:planner` peer) watches via swarm-ui.

This is meta — using swarm-mcp to build clanky's swarm-mcp integration — and surfaces real ergonomic issues. Recommended but optional.

---

## Headcount and wall-clock estimate

| Wave | Agents | Wall time | Reason for shape |
|---|---|---|---|
| 1 | 2 parallel | ~3 hours | Both tracks small and independent |
| 2 | 2 parallel (W + P) | ~1.5 days | Bottlenecked by Wave 2A which has two phases sequentially |
| 3 | 1 | ~1 day | Integration must see everything |
| 4 | 0 (operator) | release cycle | Soak, not coding |
| 5 | 1 | ~0.5 day | Mechanical deletion |

**Total wall time** (excluding soak): ~3.5 days with 2-3 concurrent agents at peak.
**Serial baseline** (one agent, no parallelism): ~7–10 days.
**Parallelism gain**: roughly 2x.

You don't get more than 2x because Phase 4 is a hard serialization point. Spending agents on 4 different sub-tasks within Phase 4 costs more in coordination than it saves in time.

---

## Risks specific to parallel execution

| Risk | Mitigation |
|---|---|
| Wave 2A and 2B both touch `swarmDbConnection.ts` differently | Wave 1 P1 ships this first as a stable, tested helper. No edits in Wave 2. |
| Wave 2B stubs the DB helper differently from Wave 2A's real one | Wave 2B uses the real helper from Wave 1. No stubs. |
| Fake harness ships too late | Wave 1 P2 includes it. Wave 2 cannot start without it. |
| Wave 2B drifts from swarm-mcp's actual DB semantics | Re-port from `swarm-mcp/src/registry.ts` etc. directly. Add a "schema parity" test that calls swarm-mcp's `register` tool and Clanky's `peer.register` against the same DB and asserts identical row state. |
| Two agents both write to the same DB during tests | Each test uses an isolated temp `SWARM_DB_PATH`. Enforce in test fixtures. |
| Wave 3 integration agent runs out of context loading 2A + 2B | Land 2A and 2B before kicking off Wave 3 so the integration agent reads finalized files, not WIP diffs. |
| Operator becomes the merge bottleneck | Two PRs in Wave 1, two in Wave 2, one in Wave 3, one in Wave 5. Six merges over ~4 days is fine. If reviews block, route through one trusted reviewer agent (`role:reviewer` in the dogfood swarm). |

---

## Bootstrapping the parallel run

If you start now:

1. Operator: create `git worktree`s for `wave1-p1`, `wave1-p2`. Spawn two agents (`/clank code` or external claude/codex). Hand each their wave-1 deliverable list from this doc.
2. Merge both Wave 1 PRs (~3h later).
3. Operator: create `wave2a-spawn`, `wave2b-peer` worktrees. Spawn two agents.
4. As each PR lands, rebase the other onto main (no expected conflicts).
5. After both merge, spawn Wave 3 agent in a fresh worktree.
6. Soak over the release cycle.
7. Spawn Wave 5 deletion agent at the end.

Total operator-active touchpoints: ~6 (one per agent kickoff + one per merge). Most of the wall time is agents working in parallel.
