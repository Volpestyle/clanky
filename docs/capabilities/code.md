# Code Agent Runtime

This document describes the `code_task` capability.

## Overview

`code_task` is available in:

- text reply tool loop (`src/tools/replyTools.ts`)
- voice text-mediated reply loop (`src/bot/voiceReplies.ts`)
- voice realtime tool loop (`src/voice/voiceToolCallAgents.ts`)
- `/clank code` slash subcommand (`src/bot.ts`, `handleClankCodeSlashCommand`)

Core runtime files:

- `src/agents/codeAgent.ts`
- `src/agents/codexCliAgent.ts`
- `src/agents/baseAgentSession.ts`
- `src/agents/subAgentSession.ts`
- `src/llm/llmClaudeCode.ts`
- `src/llm/llmCodexCli.ts`

## Access Control

Access is settings-driven, not env-var-driven:

- at least one coding worker must be enabled under `agentStack.runtimeConfig.devTeam.*`
- caller Discord user ID must be present in `permissions.devTasks.allowedUserIds`

Product-wise, `code_task` belongs to Clanky's trusted-collaborator tier, not the baseline community tier. Shared/community users can still talk to Clanky, search the web, or use other lower-trust capabilities, but code orchestration stays reserved for explicitly approved people and approved resources. The broader relationship model is documented in [`../architecture/relationship-model.md`](../architecture/relationship-model.md).

Dashboard compatibility fields still flatten those controls into the `codeAgent*` form section, but the persisted source of truth is the preset-driven `agentStack` plus `permissions.devTasks`.

The canonical persistence, preset, and save semantics for these fields live in [`../reference/settings.md`](../reference/settings.md).

Guardrails:

- per-worker `maxTasksPerHour`
- per-worker `maxParallelTasks`
- per-task timeout and output buffer limits

If blocked, runtime returns deterministic errors (`restricted to allowed users`, rate-limit blocks, parallel-limit blocks).

## Providers

`agentStack.devTeam.roles.*` selects which worker to spin up for design, implementation, review, and research tasks. The worker runtime config then supplies that worker's own model, limits, and target repository path.

The generic `code_task` path resolves through the implementation role first, then falls back to the enabled worker order when no explicit implementation worker is set.

Preset defaults are intentionally asymmetric:

- `openai_*` presets keep `codex-cli` as the primary implementation worker and `claude-code` as the secondary local worker
- `claude_*` presets keep `claude-code` as the primary implementation worker and `codex-cli` as the secondary local worker
- review work can route to a different worker than implementation

The dashboard-facing `codeAgent.provider` compatibility field supports:

- `"claude-code"` — local Claude CLI runtime
- `"codex-cli"` — local Codex CLI runtime
- `"auto"` — defer to the resolved preset/default worker routing

Provider model fields:

- `codeAgent.model` (Claude Code model alias)
- `codeAgent.codexCliModel` (Codex CLI model)

In product terms:

- `claude-code` is the local Anthropic-side coding worker
- `codex-cli` is the local OpenAI-side coding worker

## Tool Contract

`code_task` accepts:

- `task` (required)
- `role` (optional; `design`, `implementation`, `review`, or `research`)
- `cwd` (optional)
- `session_id` (optional; continue an existing code session)

The same shared schema is used across text and voice tool registration (`src/tools/sharedToolSchemas.ts`).

That shared schema stays intentionally concise. The tool description names the capability and its main options, while access control, worker routing, and session behavior are documented here instead of being packed into schema prose.

When `role` is omitted, the generic `code_task` path routes through the implementation role.

## Actions

`code_task` supports an `action` parameter that controls behavior:

| Action | Required Params | Description |
|--------|----------------|-------------|
| `run` (default) | `task` | Dispatch a new task or continue an existing session via `session_id` |
| `followup` | `task`, `session_id` | Queue a follow-up instruction for a running background task. Executes after the current turn completes. |
| `status` | `session_id` | Check a background task's progress, files touched, and recent activity |
| `cancel` | `session_id` | Cancel a running background task |

The `followup` action enables the orchestrator LLM to steer a running sub-agent based on progress updates — adjusting instructions, narrowing scope, or redirecting work without cancelling and restarting. Follow-ups are queued and executed sequentially after the current turn finishes.

## Session Model

`code_task` supports both session continuation and one-shot execution:

1. If `session_id` is provided and valid, runtime continues that session with `runTurn(...)`.
2. If no `session_id` is provided and session creation is available, runtime creates/registers a new code session and runs the first turn.
3. If session creation is unavailable, runtime falls back to one-shot `runCodeAgent(...)`.

Session manager:

- `SubAgentSessionManager` with idle sweep and max concurrent session controls
- owner checks prevent one user from continuing another user’s session
- provider-specific session implementations for Claude Code and Codex CLI
- all provider sessions extend `BaseAgentSession`, which owns shared `runTurn` lifecycle semantics (abort wiring, status transitions, cancel/close behavior, and lifecycle logging)
- `runTurn` options support both `signal` and `onProgress` (for async background task progress emission)

## Workspace Mode

`cwd` resolution:

- explicit `cwd` argument if provided
- otherwise the selected role worker's `defaultCwd`
- otherwise fallback: the bot repo root (`process.cwd()`)

For local workers (`claude-code`, `codex-cli`), that resolved path is treated as a target path inside a git repo, not just as a raw shell cwd. The runtime resolves a local workspace mode through `agentStack.runtimeConfig.devTeam.workspace.mode`:

- `auto`: default mode. Uses `shared_checkout` when swarm is enabled and `isolated_worktree` when swarm is disabled.
- `shared_checkout`: run the worker directly in the live checkout at the requested repo path.
- `shared_checkout`: follow-up turns in the same code session stay in that same live checkout.
- `isolated_worktree`: create a disposable `git worktree` on a fresh `clanker/...` branch.
- `isolated_worktree`: run the local worker inside the matching path within that worktree.
- `isolated_worktree`: reuse the same worktree across follow-up turns in the same code session.
- `isolated_worktree`: remove the worktree and throw away the branch when the session closes, times out, errors, or is cancelled.

Product-wise, `shared_checkout` is the more natural swarm-collaboration mode because every local worker sees the same live repo state. `isolated_worktree` remains the safer containment mode for non-swarm or higher-risk tasks.

Important boundary:

- this is workspace selection, not host isolation
- local workers still run as the same OS user and keep normal machine access
- the resolved `cwd` must point inside a git repository for local workers

## Swarm Coordination

Clanky can optionally mount `swarm-mcp` into local code workers as an internal coordination layer.

When `agentStack.runtimeConfig.devTeam.swarm.enabled` is true:

- local `codex-cli` and `claude-code` workers get a per-session swarm MCP config at launch time
- the worker receives first-turn guidance to register itself into the shared swarm
- the worker registers with a machine-readable label like `origin:clanky provider:codex-cli role:implementer`
- `workspace.mode: auto` defaults those local workers to the shared checkout so the swarm naturally sees one live repo
- when a session still uses `isolated_worktree`, registration uses the disposable worktree as the live `directory`, but uses the original requested repo path as `file_root`
- swarm `scope` is pinned to the canonical repo root

This matters because local workers can now run either in the shared checkout or in disposable git worktrees. Without the canonical `file_root` and repo-root `scope`, an isolated worker's file lock or annotation would point at its transient worktree path instead of the shared repo path that another worker should see.

Role-bearing labels are advisory, not enforced schema. A session can omit the `role:` token entirely and be treated as a generalist by the shared swarm protocol.

Operationally:

- `agentStack.runtimeConfig.devTeam.swarm` configures how Clanky launches the swarm MCP server for local coding workers
- the swarm command and args should normally use absolute paths so both Codex CLI and Claude Code can start the same server reliably
- `dbPath` is optional and overrides the shared SQLite location via `SWARM_DB_PATH`

## Async Dispatch

`code_task` supports async background dispatch for new code sessions.

- worker-level routing is controlled by `agentStack.runtimeConfig.devTeam.<worker>.asyncDispatch`
- when enabled and the worker threshold is met, `executeCodeTask` dispatches through `BackgroundTaskRunner` and returns immediately
- the orchestrator LLM receives a normal tool result indicating dispatch and composes the user-facing acknowledgment
- session continuation calls (`session_id` present) remain synchronous by design

`BackgroundTaskRunner` (`src/agents/backgroundTaskRunner.ts`) handles:

- in-flight async task lifecycle and retention cleanup
- real-time progress accumulation from `SubAgentSession.runTurn(..., { onProgress })`
- milestone callbacks for optional progress updates
- completion/cancellation callbacks
- scope cancellation via `buildCodeTaskScopeKey(...)` + `cancelByScope(...)`

Delivery surfaces:

- text and text-mediated voice use synthetic message events (`code_task_progress` / `code_task_result`) fed into `enqueueReplyJob(..., forceRespond: true)`
- voice realtime tasks (`voice_realtime_tool_code_task`) deliver completion/cancellation back into the live realtime conversation via `VoiceSessionManager.requestRealtimeCodeTaskFollowup(...)`, then trigger spoken follow-up output

Async background dispatch now lives in this runtime doc; there is no separate canonical design spec to keep in sync.

## Logging

Primary action kinds:

- `code_agent_call`
- `code_agent_error`
- `sub_agent_session_lifecycle`

Common metadata fields:

- `provider` / `configuredProvider`
- `model`
- `sessionId` / `turnNumber` (session path)
- `durationMs`
- usage and cost where available

## Settings Surface

The cross-cutting settings contract lives in [`../reference/settings.md`](../reference/settings.md). The code-agent-specific knobs still live under `agentStack.runtimeConfig.devTeam` and `agentStack.overrides.devTeam`.

Canonical persisted defaults live under `agentStack.runtimeConfig.devTeam` in `src/settings/settingsSchema.ts`:

```ts
devTeam: {
  workspace: {
    mode: "auto"
  },
  swarm: {
    enabled: false,
    serverName: "swarm",
    command: "",
    args: [],
    dbPath: "",
    appendCoordinationPrompt: true
  },
  codexCli: {
    enabled: false,
    model: "gpt-5.4",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2,
    asyncDispatch: {
      enabled: true,
      thresholdMs: 0,
      progressReports: {
        enabled: true,
        intervalMs: 60_000,
        maxReportsPerTask: 5
      }
    }
  },
  claudeCode: {
    enabled: false,
    model: "sonnet",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2,
    asyncDispatch: {
      enabled: true,
      thresholdMs: 0,
      progressReports: {
        enabled: true,
        intervalMs: 60_000,
        maxReportsPerTask: 5
      }
    }
  }
}
```

The selected worker order is controlled through `agentStack.overrides.devTeam.codingWorkers` when advanced overrides are enabled. The dashboard's `Auto` option leaves worker ordering on the preset/default path instead of pinning a specific worker override.

