# Code Agent Runtime

Status as of March 5, 2026: **Implemented**.

This document describes the shipped `code_task` capability as it exists in runtime today.

## Overview

`code_task` is available in:

- text reply tool loop (`src/tools/replyTools.ts`)
- voice realtime tool loop (`src/voice/voiceToolCalls.ts`)
- `/code` slash command (`src/commands/codeCommand.ts`)

Core runtime files:

- `src/agents/codeAgent.ts`
- `src/agents/codexAgent.ts`
- `src/agents/subAgentSession.ts`
- `src/llmClaudeCode.ts`
- `src/llmCodex.ts`

## Access Control

Access is settings-driven, not env-var-driven:

- `codeAgent.enabled` must be `true`
- caller Discord user ID must be in `codeAgent.allowedUserIds`

Guardrails:

- `codeAgent.maxTasksPerHour`
- `codeAgent.maxParallelTasks`
- per-task timeout and output buffer limits

If blocked, runtime returns deterministic errors (`restricted to allowed users`, rate-limit/parallel-limit blocks).

## Providers

`codeAgent.provider` supports:

- `"claude-code"`
- `"codex"`
- `"auto"` (currently resolves to Claude Code)

Provider model fields:

- `codeAgent.model` (Claude Code model alias)
- `codeAgent.codexModel` (Codex Responses model)

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

## Working Directory

`cwd` resolution:

- explicit `cwd` argument if provided
- otherwise `codeAgent.defaultCwd`
- otherwise fallback: `../web` relative to app root

Claude Code runs locally in that directory. Codex runs through OpenAI Responses and does not use local CLI execution.

## Logging

Primary action kinds:

- `code_agent_call`
- `code_agent_error`

Common metadata fields:

- provider / configuredProvider
- model
- sessionId / turnNumber (session path)
- durationMs
- usage and cost where available

## Settings Reference

`codeAgent` defaults (`src/settings/settingsSchema.ts`):

```ts
codeAgent: {
  enabled: false,
  provider: "claude-code",
  model: "sonnet",
  codexModel: "codex-mini-latest",
  maxTurns: 30,
  timeoutMs: 300_000,
  maxBufferBytes: 2 * 1024 * 1024,
  defaultCwd: "",
  maxTasksPerHour: 10,
  maxParallelTasks: 2,
  allowedUserIds: []
}
```

## Notes

- The `/code` command and tool descriptions still mention “Claude Code” text in a few places, but provider routing is runtime-configurable and supports Codex.
