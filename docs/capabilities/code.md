# Code Agent Runtime

This document describes the `code_task` capability.

## Overview

`code_task` is available in:

- text reply tool loop (`src/tools/replyTools.ts`)
- voice text-mediated reply loop (`src/bot/voiceReplies.ts`)
- voice realtime tool loop (`src/voice/voiceToolCallAgents.ts`)
- `/clank code` slash subcommand (`src/commands/codeCommand.ts`)

Core runtime files:

- `src/agents/codeAgent.ts`
- `src/agents/codexAgent.ts`
- `src/agents/codexCliAgent.ts`
- `src/agents/subAgentSession.ts`
- `src/llm/llmClaudeCode.ts`
- `src/llm/llmCodex.ts`
- `src/llm/llmCodexCli.ts`

## Access Control

Access is settings-driven, not env-var-driven:

- at least one coding worker must be enabled under `agentStack.runtimeConfig.devTeam.*`
- caller Discord user ID must be present in `permissions.devTasks.allowedUserIds`

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
- remote `codex` remains available, but it is not part of the preset-default local worker order

The dashboard-facing `codeAgent.provider` compatibility field supports:

- `"claude-code"` — local Claude CLI runtime
- `"codex-cli"` — local Codex CLI runtime
- `"codex"` — remote OpenAI Responses/Codex runtime
- `"auto"` — defer to the resolved preset/default worker routing

Provider model fields:

- `codeAgent.model` (Claude Code model alias)
- `codeAgent.codexCliModel` (Codex CLI model)
- `codeAgent.codexModel` (OpenAI Codex Responses model)

In product terms:

- `claude-code` is the local Anthropic-side coding worker
- `codex-cli` is the local OpenAI-side coding worker
- `codex` is the optional remote OpenAI Responses worker

## Tool Contract

`code_task` accepts:

- `task` (required)
- `role` (optional; `design`, `implementation`, `review`, or `research`)
- `cwd` (optional)
- `session_id` (optional; continue an existing code session)

The same shared schema is used across text and voice tool registration (`src/tools/sharedToolSchemas.ts`).

That shared schema stays intentionally concise. The tool description names the capability and its main options, while access control, worker routing, and session behavior are documented here instead of being packed into schema prose.

When `role` is omitted, the generic `code_task` path routes through the implementation role.

## Session Model

`code_task` supports both session continuation and one-shot execution:

1. If `session_id` is provided and valid, runtime continues that session with `runTurn(...)`.
2. If no `session_id` is provided and session creation is available, runtime creates/registers a new code session and runs the first turn.
3. If session creation is unavailable, runtime falls back to one-shot `runCodeAgent(...)`.

Session manager:

- `SubAgentSessionManager` with idle sweep and max concurrent session controls
- owner checks prevent one user from continuing another user’s session
- provider-specific session implementations for Claude Code, Codex CLI, and Codex

## Workspace Isolation

`cwd` resolution:

- explicit `cwd` argument if provided
- otherwise the selected role worker's `defaultCwd`
- otherwise fallback: the bot repo root (`process.cwd()`)

For local workers (`claude-code`, `codex-cli`), that resolved path is treated as a target path inside a git repo, not as the live execution directory. Runtime behavior:

- resolve the containing git repo root for the requested path
- create a disposable `git worktree` on a fresh `clanker/...` branch
- run the local coding worker inside the matching path within that worktree
- reuse the same worktree across follow-up turns in the same code session
- remove the worktree and throw away the branch when the session closes, times out, errors, or is cancelled

This protects the live checkout from routine agent edits while still preserving full local shell power inside the disposable branch workspace.

Important boundary:

- this is workspace isolation, not host isolation
- local workers still run as the same OS user and keep normal machine access
- the resolved `cwd` must point inside a git repository for local workers

`codex` still runs through OpenAI's API-driven Responses execution path and does not provision a local worktree.

## Async Dispatch (Design)

The current `code_task` path is synchronous — the orchestrator LLM blocks until the sub-agent finishes. For multi-minute tasks, this results in silence in the channel with no progress feedback.

The async dispatch design (`async-code-task-design.md`) introduces:

1. **Async dispatch:** `code_task` returns immediately for long-running tasks. The orchestrator composes an acknowledgment.
2. **Progress streaming:** Sub-agent stream events are parsed in real-time and accumulated as progress milestones.
3. **Result delivery:** On completion, a synthetic event triggers a new reply pipeline run. The LLM composes the follow-up with full result context.

See [async-code-task-design.md](async-code-task-design.md) for the full specification.

## Logging

Primary action kinds:

- `code_agent_call`
- `code_agent_error`

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
  codex: {
    enabled: false,
    model: "gpt-5.4",
    maxTurns: 30,
    timeoutMs: 300_000,
    maxBufferBytes: 2 * 1024 * 1024,
    defaultCwd: "",
    maxTasksPerHour: 10,
    maxParallelTasks: 2
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
  }
}
```

The selected worker order is controlled through `agentStack.overrides.devTeam.codingWorkers` when advanced overrides are enabled. The dashboard's `Auto` option leaves worker ordering on the preset/default path instead of pinning a specific worker override.
