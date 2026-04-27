# Code Agent Runtime

This document describes Clanky's code-orchestration capability. After the swarm-launcher redesign, code orchestration is not a single tool — it is a small Clanky-specific spawn tool plus the conditionally-mounted swarm-mcp tool surface. The orchestrator drives dispatches, followups, status, and cancellation by speaking swarm-mcp directly.

## Overview

The code-orchestration tool surface is available in:

- text reply tool loop (`src/tools/replyTools.ts`)
- voice text-mediated reply loop (`src/bot/voiceReplies.ts`)
- voice realtime followups via the swarm activity bridge
- `/clank code` slash subcommand (`src/bot.ts`, `handleClankCodeSlashCommand`)

It is mounted only for callers in `permissions.devTasks.allowedUserIds` on dev-allowed channels. For everyone else, neither `spawn_code_worker` nor the swarm-mcp tool surface appears in the tool list at all.

Core runtime files:

- `src/tools/spawnCodeWorker.ts` — handler for the `spawn_code_worker` tool: gate, cwd resolution, reserve → spawn → adopt → assign
- `src/agents/swarmLauncher.ts` — worker reserve/spawn/adopt mechanics
- `src/agents/swarmPeer.ts` and `src/agents/swarmPeerManager.ts` — Clanky's per-scope controller peer (load-bearing for orchestrator-to-worker `send_message` and for `requester` identity on tasks)
- `src/agents/swarmReservationKeeper.ts` — heartbeats unadopted instance rows until the worker adopts
- `src/agents/swarmDb.ts` — direct `swarm.db` writes (mirrors swarm-ui's `writes.rs`)
- `src/agents/swarmActivityBridge.ts` — runtime-side subscription that emits `code_task_progress` / `code_task_result` events into the reply pipeline and routes voice-realtime completions
- `src/agents/swarmTaskWaiter.ts` — small `wait_for_activity` helper used by the slash command and by the conditional `wait_for_activity` tool
- `src/agents/codeAgentSwarm.ts` — label builder and worker first-turn preamble
- `src/agents/codeAgentSettings.ts` — `resolveCodeAgentConfig` and `isCodeAgentUserAllowed`
- `src/agents/codeAgentRepoResolver.ts` — approved workspace-root enforcement and GitHub URL → local clone resolution
- `src/agents/codeAgentWorkspace.ts` — `resolveCodeAgentWorkspace({ cwd })` (repo-root resolver only; no worktree creation)
- `src/llm/llmClaudeCode.ts` and `src/llm/llmCodexCli.ts` — harness CLI arg builders

## Access Control

Access is settings-driven, not env-var-driven:

- at least one coding worker must be enabled under `agentStack.runtimeConfig.devTeam.*`
- caller Discord user ID must be present in `permissions.devTasks.allowedUserIds`
- at least one local workspace root must be present in `permissions.devTasks.allowedWorkspaceRoots`

Product-wise, code orchestration belongs to Clanky's trusted-collaborator tier, not the baseline community tier. Shared/community users can still talk to Clanky, search the web, or use other lower-trust capabilities, but code orchestration stays reserved for explicitly approved people and approved resources. The broader relationship model is documented in [`../architecture/relationship-model.md`](../architecture/relationship-model.md).

The gate is enforced inside `spawn_code_worker` (the only operation that creates a child process) and at tool-mount time (the swarm-mcp tool surface is not mounted at all for non-dev users). `request_task` without a worker is harmless — it just adds a row no one will claim — so the swarm tools themselves do not need separate per-call gates.

The dashboard exposes these controls in the Code Agent section, while the persisted source of truth is the preset-driven `agentStack` plus `permissions.devTasks`.

The canonical persistence, preset, and save semantics for these fields live in [`../reference/settings.md`](../reference/settings.md).

Guardrails enforced inside `spawn_code_worker`:

- resolved worker cwd must be inside one of `permissions.devTasks.allowedWorkspaceRoots`
- per-harness `maxTasksPerHour` (rolling-window counter)
- per-harness `maxParallelTasks` (counted by `swarmActivityBridge`-observed terminal events)
- per-task timeout and output buffer limits
- direct child fallback is disabled by default; without an interactive-capable `swarm-server`, worker launch fails instead of silently running headless

If blocked, runtime returns deterministic errors (`restricted to allowed users`, rate-limit blocks, parallel-limit blocks) before any swarm DB write.

## Providers

`agentStack.devTeam.roles.*` maps the optional `role` parameter on `spawn_code_worker` (`design`, `implementation`, `review`, `research`) to a harness. The worker runtime config then supplies that harness's own model, limits, and target repository path. The resolved harness becomes the swarm peer that runs the task. Callers can also pass `harness` directly to override the role-based mapping.

When `role` is omitted, the generic path resolves to the implementation role first, then falls back to the enabled worker order when no explicit implementation worker is set.

Preset defaults are intentionally asymmetric:

- `openai_*` presets keep `codex-cli` as the primary implementation worker and `claude-code` as the secondary local worker
- `claude_*` presets keep `claude-code` as the primary implementation worker and `codex-cli` as the secondary local worker
- review work can route to a different worker than implementation

The dashboard provider selector supports:

- `"claude-code"` — local Claude CLI runtime
- `"codex-cli"` — local Codex CLI runtime
- `"auto"` — defer to the resolved preset/default worker routing

Provider model fields:

- `codeAgent.model` (Claude Code model alias)
- `codeAgent.codexCliModel` (Codex CLI model)

In product terms:

- `claude-code` is the local Anthropic-side coding worker
- `codex-cli` is the local OpenAI-side coding worker

## Tool Surface

`spawn_code_worker` is the only Clanky-specific tool. Everything else the orchestrator might do during a code-orchestration turn is a swarm-mcp tool, mounted from `swarm-mcp`'s own schema with thin per-scope-peer adapters.

```ts
spawn_code_worker({
  task: string,                 // initial task description
  role?: "design" | "implementation" | "review" | "research",
  harness?: "claude-code" | "codex-cli",  // overrides role-based routing
  cwd?: string,                  // must be under an approved workspace root
  github_url?: string,           // issue/PR/repo URL resolved to a local clone when cwd is omitted
  review_after_completion?: boolean,
  review_harness?: "claude-code" | "codex-cli",
  wait_timeout_ms?: number,
}) → { workerId, taskId, scope, cwd, sessionKey, persistedSession }
```

Swarm-mcp tools mounted alongside it (only for `devTasks`-allowed users):

- `request_task`, `get_task`, `list_tasks`, `update_task`, `claim_task`
- `send_message`, `broadcast`, `wait_for_activity`
- `annotate`, `lock_file`, `unlock_file`, `check_file`
- `list_instances`, `whoami`
- `kv_get`, `kv_set`, `kv_delete`, `kv_list`

Each tool resolves through Clanky's per-scope controller peer (`peerManager.ensurePeer(...)`), so a single peer identity speaks for the orchestrator across the whole reply turn. The controller-peer label is `origin:clanky role:controller`.

Clanky writes `sessionKey` to swarm KV with the latest worker/task identity for the requesting guild/channel/user, and `send_message` can later target the same worker with either `recipient=<workerId>` or `session_key=<sessionKey>` while the worker is still in its brief post-task follow-up window.

Clanky also publishes its scoped controller peer id at `kv_get("clanky/controller")` whenever it spawns a code worker in that scope. Planner workers use this to ask Clanky for capacity when their delegated work is stranded.

The shared tool schema stays intentionally concise. Tool descriptions name each capability and its main options; access control, worker routing, and lifecycle behavior are documented here instead of being packed into schema prose.

## Lifecycle

A typical code dispatch is a chain of tool calls the orchestrator stitches together:

1. `spawn_code_worker(task, role, cwd)` — Clanky asks `swarm-server` to create an interactive PTY-backed worker (claude-code or codex-cli with `swarm-mcp` mounted), waits for auto-adopt, creates a swarm task, assigns the task to the worker, and returns `{ workerId, taskId, scope, cwd, sessionKey }`.
2. `wait_for_activity(taskId)` — orchestrator blocks until the task reaches a terminal status. The activity event stream also surfaces `progress` annotations along the way.
3. `get_task(taskId)` — orchestrator reads the final `result` text and the sibling `kind="usage"` annotation for cost/usage telemetry.
4. Orchestrator composes the user-facing reply. Async completions are re-fed through Clanky's normal reply pipeline so Clanky remains the final arbiter; direct result relay is only a fallback when the reply pipeline cannot enqueue the synthetic completion event.

Variations the orchestrator can express directly:

- **Status check**: `get_task(taskId)`, optionally `list_tasks(scope)` to see siblings.
- **Cancel**: `update_task(taskId, status="cancelled")`. Clanky marks the swarm task cancelled, then stops the backing worker — closing its swarm-server PTY when available or SIGTERMing the fallback child process.
- **Followup (existing worker)**: `send_message(workerId, content)` or `send_message(session_key, content)` while the worker is still in its post-task listen window. If the peer is no longer active, the orchestrator spawns a fresh worker.
- **Followup (fresh worker)**: `request_task({ parent_task_id: originalTaskId, ... })` followed by another `spawn_code_worker(...)`. Lets the orchestrator re-pick harness or `cwd`.
- **Multi-worker fan-out**: multiple `spawn_code_worker` calls in one turn — e.g. a researcher and an implementer in parallel — with the orchestrator coordinating them via `send_message` and `lock_file`.
- **Quality verification**: `spawn_code_worker(..., review_after_completion=true)` waits for the implementation task, then spawns a `role="review"` worker against the same workspace. The tool returns the implementation completion and the review completion. The reviewer is instructed to avoid edits, inspect the diff and relevant files, and start with `APPROVED:` or `ISSUES:`. Clanky treats reviewer output as findings to resolve or report, not as a decorative summary.
- **Planner loop**: `spawn_code_worker(role="design")` creates a planner peer that can stay alive briefly after its initial planning task. Clanky drives it with `send_message` during that listen window, and respawns if the peer exits.
- **Planner spawn escalation**: if a planner-created task remains open and unclaimed, the planner sends Clanky's controller peer `JSON.stringify({ v: 1, kind: "spawn_request", taskId, role, reason })`. The activity bridge validates the schema version, deduplicates repeated `(sender, kind, taskId)` requests for 60 seconds, rate-limits each sender, then asks Clanky's bot runtime to spawn or decline. The planner cannot choose `cwd` or `harness`; Clanky pins the spawn to the planner's own stored context and checks the original Discord requester's `devTasks` permission before creating a worker.

There is no procedural action enum. The swarm `taskId` is the canonical identity for any in-flight or terminal piece of work. Workers additionally get a KV-backed `sessionKey` so later reply turns can target the same live worker without relying on Discord-visible memory of the raw worker id.

The behavioral contract every Clanky-spawned worker follows lives in [`../architecture/swarm-worker-contract.md`](../architecture/swarm-worker-contract.md).

## Workspace

Workers run in the operator's local workspace. `spawn_code_worker` resolves `cwd`, verifies that path is under an approved coding workspace root, and pins the swarm `scope` to the git repo root when one exists. Non-git scratch directories are valid worker roots; their swarm `scope` is the resolved cwd itself.

`cwd` resolution order:

- explicit `cwd` argument if provided; relative values resolve from the selected worker's configured `defaultCwd`, then the first approved workspace root, then `process.cwd()`
- otherwise, a GitHub issue/PR/repo URL from `github_url` or the task text is matched to exactly one local clone under `permissions.devTasks.allowedWorkspaceRoots`
- otherwise the selected role worker's `defaultCwd`
- otherwise the first approved workspace root
- otherwise fallback: the bot process cwd (`process.cwd()`)

Important boundaries:

- Clanky does not create or manage `git worktree`s. Operators that want parallel-isolated workspaces should manage their own worktrees and aim `spawn_code_worker` at the appropriate cwd.
- This is workspace selection, not host isolation. Workers run as the same OS user and keep normal machine access.
- The resolved `cwd` must be an existing directory inside an approved workspace root. It does not need to be a git repository.
- Clanky never auto-clones repositories from chat or voice. If GitHub URL resolution cannot find exactly one approved local clone, it returns a deterministic error and the operator must add the clone/root in settings or provide an approved `cwd`.

## Coordination Substrate

`swarm-mcp` is the runtime substrate, not an opt-in feature. Every code worker runs as a swarm peer in the same SQLite-backed coordination DB.

Roles in the swarm:

- Clanky's brain registers as one controller peer per active repo scope with label `origin:clanky role:controller`. The conditional swarm tools mounted into Clanky's reply loop call swarm-mcp from this peer. It heartbeats every 10 seconds for the lifetime of the bot process, mirroring `swarm-mcp`'s own peer lifecycle, and is not a spawned code worker.
- Each spawned worker registers as a separate peer with label `origin:clanky provider:<harness> role:<role> thread:<channel> user:<user>`.
- `role:` tokens are advisory. Anyone can read them via `list_instances`; nothing is enforced.

Adoption happens through the env-var protocol. If `swarm-server` is running and advertises direct PTY spawn support, `spawn_code_worker` asks it to create an interactive PTY-backed worker so the worker is visible and attachable in `swarm-ui`. Claude receives Clanky's first-turn preamble/task as deferred PTY `initial_input`. Codex receives the preamble/task as a trailing CLI prompt argument and keeps `initial_input=null`; Clanky creates the worker identity row before the `/pty` call and passes that same ID both as PTY env and as explicit Codex `mcp_servers.<name>.env.*` overrides so Codex's stdio MCP child adopts the intended row. This is only an identity handoff; it does not limit how many Codex terminals Clanky can spawn. If `swarm-server` is unavailable or lacks `pty.spawn.args`, `pty.spawn.env`, and `pty.spawn.initial_input`, launch fails by default with a clear operator hint. Operators may explicitly enable `agentStack.runtimeConfig.devTeam.swarm.allowDirectChildFallback` to permit the older direct child-process path: Clanky creates an unadopted worker identity row in `swarm.db` (via `swarmDb.reserveInstance(...)`), heartbeats it through `swarmReservationKeeper` until the worker boots, and `swarm-mcp`'s `tryAutoAdopt` flips `adopted=1` when the worker connects. Workers do not call `register` themselves. Full details live in the [worker contract](../architecture/swarm-worker-contract.md).

When direct-child fallback is explicitly enabled, Codex direct-spawn workers run through `codex exec --ignore-user-config --skip-git-repo-check` with Clanky's swarm MCP server supplied as explicit `mcp_servers.<name>.*` config overrides. The override pins the vendored `swarm-mcp` command, args, package cwd, and the dynamic adoption env for the reserved instance row. This keeps Clanky-spawned Codex workers from inheriting unrelated user-scope MCP servers while still letting the worker operate in the resolved project cwd. The PTY-backed Codex path uses interactive Codex, not `codex exec`, but it still pins the same swarm MCP command/cwd/env overrides for adoption correctness.

`agentStack.runtimeConfig.devTeam.swarm.appendCoordinationPrompt` controls whether Clanky gives workers the generic `swarm-mcp` coordination playbook. When enabled, Clanky first checks whether the `swarm-mcp` skill is installed somewhere the worker harness can reach, such as `~/.agents/skills/swarm-mcp`, `~/.claude/skills/swarm-mcp`, or a workspace-level skill directory. If a reachable install exists, the worker prompt gets only a short discovery directive pointing at that path. If no reachable install exists, Clanky falls back to inlining the vendored skill body so workers still get the playbook on turn 1. Setting `appendCoordinationPrompt=false` disables both the discovery directive and the inline fallback, but it does not disable the Clanky-specific launcher overlays: auto-adoption, assigned task ID, plain-text result reporting, usage annotations, git authority, and the follow-up listen window always remain in the preamble.

DB location is `~/.swarm-mcp/swarm.db` by default. Override via `agentStack.runtimeConfig.devTeam.swarm.dbPath` (or the `SWARM_DB_PATH` env var). The same DB file is shared across `swarm-ui`, manually-launched workers, and Clanky-spawned workers running on the same host — single-host swarm scope is intentional.

Live observation of the swarm — peer graph, active tasks, terminal binding, intervention — is owned by `swarm-ui` (desktop) and `swarm-ios` (mobile/remote). Workers normally launch through `swarm-server`, so their PTYs are attachable there. Direct-spawn fallback workers, when explicitly enabled, still appear as peers/tasks in the shared DB, but they do not have a terminal binding. Clanky's own dashboard does not duplicate this surface.

## Activity Bridge and Progress Delivery

The orchestrator can call `wait_for_activity` directly to block on a task. For Discord-side delivery (text reply pipeline injection, voice realtime followups), there is also a runtime-side subscription that fires regardless of which tool the orchestrator is using.

`src/agents/swarmActivityBridge.ts` is registered once per active controller-peer scope and:

- Watches all tasks where `requester` matches the local Clanky controller peer.
- On `kind="progress"` annotations, writes progress to the action log at the worker-contract cadence.
- On terminal status (`done` / `failed` / `cancelled`), injects a synthetic completion event into the normal reply pipeline with `forceRespond: true`. The model sees the worker result and composes the user-facing follow-up. If the synthetic event cannot be queued, Clanky falls back to a direct truncated result post.
- Tracks per-harness active-worker counts for the `maxParallelTasks` bookkeeping read by `spawn_code_worker`; PTY-backed workers stop counting once their assigned task is terminal, even if the terminal session remains open for inspection.
- On `cancelled` transitions, stops the backing worker if it is still running: swarm-server PTY close for attachable workers, SIGTERM for fallback child-process workers.

The bridge subscription is set up alongside `peerManager` in `bot.ts` runtime construction. Orchestrators do not need to subscribe explicitly; the bridge is always running for the active controller peer.

The shared cancellation contract — keyword detection, speaker ownership, and the broader stop semantics — lives in [`../operations/cancellation.md`](../operations/cancellation.md).

## Logging

Primary action kinds:

- `code_agent_call` — `spawn_code_worker` returned successfully
- `code_agent_error` — spawn failure, adoption timeout, or activity-bridge delivery failure
- `swarm_worker_exit` — non-zero or unexpected worker exits, sourced from `swarm-server` PTY replay when available or from the direct-child stdout/stderr ring buffer otherwise

Common metadata fields:

- `provider` / `configuredProvider`
- `model`
- `taskId` / `instanceId` (swarm identifiers)
- `durationMs`
- `usage` and `costUsd` from the worker's `kind="usage"` annotation

Worker-internal events live in `swarm-mcp`'s own event log. PTY-backed workers keep their terminal output in `swarm-server` replay for diagnostics; direct-child fallback workers tee stdout/stderr to a small ring buffer. Neither stream is parsed for results, cost, or progress.

## Settings Surface

The cross-cutting settings contract lives in [`../reference/settings.md`](../reference/settings.md). The code-agent-specific knobs still live under `agentStack.runtimeConfig.devTeam` and `agentStack.overrides.devTeam`.

Canonical persisted defaults under `agentStack.runtimeConfig.devTeam` in `src/settings/settingsSchema.ts`:

```ts
devTeam: {
  swarm: {
    dbPath: "" // overrides SWARM_DB_PATH
  },
  codexCli: {
    enabled: false,
    model: "gpt-5.4",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2
  },
  claudeCode: {
    enabled: false,
    model: "sonnet",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2
  },
  roles: {
    // role → harness mapping for spawn_code_worker's optional role param.
    // Unchanged in shape from the pre-redesign schema.
  }
}
```

The selected worker order is controlled through `agentStack.overrides.devTeam.codingWorkers` when advanced overrides are enabled. The dashboard's `Auto` option leaves worker ordering on the preset/default path instead of pinning a specific worker override.
