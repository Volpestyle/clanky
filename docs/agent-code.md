# Code Agent Runtime

This document describes the `code_task` capability.

## Overview

`code_task` is available in:

- text reply tool loop (`src/tools/replyTools.ts`)
- voice realtime tool loop (`src/voice/voiceToolCalls.ts`)
- `/code` slash command (`src/commands/codeCommand.ts`)

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

Guardrails:

- per-worker `maxTasksPerHour`
- per-worker `maxParallelTasks`
- per-task timeout and output buffer limits

If blocked, runtime returns deterministic errors (`restricted to allowed users`, rate-limit blocks, parallel-limit blocks).

## Providers

The dashboard-facing `codeAgent.provider` compatibility field supports:

- `"claude-code"` — local Claude CLI runtime
- `"codex-cli"` — local Codex CLI runtime
- `"codex"` — remote OpenAI Responses/Codex runtime
- `"auto"` — defer to the resolved dev-team worker order; the current fallback path resolves to `codex-cli`

Provider model fields:

- `codeAgent.model` (Claude Code model alias)
- `codeAgent.codexCliModel` (Codex CLI model)
- `codeAgent.codexModel` (OpenAI Codex Responses model)

## Tool Contract

`code_task` accepts:

- `task` (required)
- `cwd` (optional)
- `session_id` (optional; continue an existing code session)

The same shared schema is used across text and voice tool registration (`src/tools/sharedToolSchemas.ts`).

## Session Model

`code_task` supports both session continuation and one-shot execution:

1. If `session_id` is provided and valid, runtime continues that session with `runTurn(...)`.
2. If no `session_id` is provided and session creation is available, runtime creates/registers a new code session and runs the first turn.
3. If session creation is unavailable, runtime falls back to one-shot `runCodeAgent(...)`.

Session manager:

- `SubAgentSessionManager` with idle sweep and max concurrent session controls
- owner checks prevent one user from continuing another user’s session
- provider-specific session implementations for Claude Code, Codex CLI, and Codex

## Working Directory

`cwd` resolution:

- explicit `cwd` argument if provided
- otherwise the enabled worker's `defaultCwd`
- otherwise fallback: `../web` relative to app root

`claude-code` and `codex-cli` execute locally in that directory. `codex` runs through OpenAI's API-driven Responses execution path.

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

## Settings Reference

Canonical persisted defaults live under `agentStack.runtimeConfig.devTeam` in `src/settings/settingsSchema.ts`:

```ts
devTeam: {
  codex: {
    enabled: false,
    model: "codex-mini-latest",
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

The selected worker order is controlled through `agentStack.overrides.devTeam.codingWorkers` when advanced overrides are enabled. The dashboard's `Auto` option serializes to the full worker set instead of pinning one provider.
