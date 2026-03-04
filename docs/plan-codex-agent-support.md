# Plan: Add Codex as Alternative Code Agent Provider

## Context

The code agent currently only supports Claude Code CLI (`spawn("claude", ...)`).
We want to add OpenAI Codex as a second provider, selectable per-server via dashboard settings.

## Architecture (current)

```
codeAgent.ts → llmClaudeCode.ts → spawn("claude") CLI
     ↓
SubAgentSession interface  ← brain calls runTurn(), doesn't care about provider
```

`SubAgentSession` (`src/agents/subAgentSession.ts`) is provider-agnostic.
Only `CodeAgentSession` and the `llmClaudeCode` layer are Claude-specific.

## Changes

### 1. Settings: add `provider` field

In `settingsSchema.ts` → `codeAgent`:

```ts
codeAgent: {
  enabled: false,
  provider: "claude-code",        // NEW — "claude-code" | "codex" | "auto"
  model: "sonnet",                // claude-code model (existing)
  codexModel: "codex-mini-latest", // NEW — codex model when provider is codex/auto
  // ... rest unchanged
}
```

Add normalization in `settingsNormalization.ts` for the new fields.

### 2. Codex integration: `src/llmCodex.ts`

Thin wrapper around OpenAI Responses API with Codex models:
- `runCodexTask({ instruction, model, timeoutMs })` — single-shot
- `runCodexSessionTurn({ previousResponseId, input, model, timeoutMs })` — multi-turn via `previous_response_id`
- Parse response text + usage from the Responses API output
- Uses existing `providerOpenAI.ts` OpenAI client (already initialized with key)

### 3. Codex session: `src/agents/codexAgent.ts`

Implements `SubAgentSession` (same interface as `CodeAgentSession`):
- `type: "code"` — interchangeable with Claude Code sessions
- `runTurn(input)` → calls `runCodexSessionTurn`, returns `SubAgentTurnResult`
- Tracks `previousResponseId` for multi-turn chaining
- Same logging shape (`code_agent_session_turn`, `code_agent_error`)

### 4. Factory: provider routing

Add a factory function (in `codeAgent.ts` or new file):

```ts
function createCodeAgentSession(settings, deps): SubAgentSession {
  const provider = settings.codeAgent.provider; // "claude-code" | "codex" | "auto"
  if (provider === "codex") return new CodexAgentSession(...);
  if (provider === "claude-code") return new CodeAgentSession(...);
  // "auto" — use heuristic or default
  return new CodeAgentSession(...);
}
```

Wire this into wherever `CodeAgentSession` is currently constructed.

### 5. Dashboard UI

Add a provider dropdown to the code agent settings panel:
- Options: Claude Code (default), Codex, Auto
- Show `codexModel` field when provider is codex/auto

### 6. "Auto" mode (future iteration)

Start with a simple default (Claude Code) for `auto`. Later, add a lightweight
classifier or heuristic (e.g., greenfield generation → Codex, multi-file refactor → Claude Code).
This can be a follow-up PR.

## Files touched

| File | Change |
|---|---|
| `src/settings/settingsSchema.ts` | Add `provider`, `codexModel` to `codeAgent` |
| `src/store/settingsNormalization.ts` | Normalize new fields |
| `src/llmCodex.ts` | **New** — Codex API wrapper |
| `src/agents/codexAgent.ts` | **New** — `CodexAgentSession` impl |
| `src/agents/codeAgent.ts` | Extract factory, keep Claude Code session |
| `src/agents/subAgentSession.ts` | No changes needed |
| Dashboard UI component | Provider dropdown + conditional model field |

## Key decisions for implementer

1. **Codex sandbox**: Codex runs code in a cloud sandbox. Our current Claude Code agent runs in a local `cwd`. Codex tasks may need file context uploaded or repo cloned into the sandbox — check Codex API docs for how to pass project context.
2. **Cost tracking**: Codex pricing differs from Claude. Ensure `costUsd` calculation uses the right rates.
3. **Timeout behavior**: Codex tasks can be long-running (async polling). The wrapper needs to handle polling with the existing `timeoutMs` budget.
4. **`auto` heuristic**: Punt to follow-up PR. Default to Claude Code for now.
