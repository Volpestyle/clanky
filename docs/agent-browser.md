# Browser Agent Runtime

This document describes the shipped browser-agent system: how `browser_browse` works today, how it is configured, and how cancellation behaves across text and voice.

## Overview

The browser agent is a headless browsing capability built on `agent-browser`:

- `src/services/BrowserManager.ts`: wraps `agent-browser` CLI commands and logical session lifecycle.
- `src/tools/browserTools.ts`: low-level browser tool schemas and execution wrappers (`browser_open`, `browser_click`, `browser_extract`, etc.).
- `src/agents/browseAgent.ts`: inner LLM tool loop that drives those browser tools until it reaches a final answer.
- `src/tools/browserTaskRuntime.ts`: shared task runtime used by both text and voice for task registration, cancellation, and normalized browser-browse execution.

At the top level, the main brain does not directly drive `browser_open` / `browser_click`. It calls the higher-level `browser_browse` tool, and that tool launches the inner browse agent.

## Where It Is Available

`browser_browse` is available in:

- `/browse` slash command
- text reply tool loop
- voice tool loop

It is intentionally not enabled for automation runs right now, even though automations use the same general reply-tool loop.

## Runtime Flow

### 1. Top-level tool call

The top-level brain decides it needs interactive browsing and calls:

```text
browser_browse({ query: "go find ..." })
```

That top-level tool exists in:

- text replies via `src/tools/replyTools.ts`
- OpenAI realtime voice tool definitions via `src/voice/voiceToolCalls.ts`

### 2. Shared browser task runtime

Both text and voice pass through:

- `runBrowserBrowseTask(...)` in `src/tools/browserTaskRuntime.ts`

This shared runtime is responsible for:

- starting the browse-agent run
- normalizing abort/cancel errors
- logging `browser_browse_call`
- keeping task lifecycle behavior aligned across modalities

### 3. Inner browse-agent loop

The shared runtime then calls:

- `runBrowseAgent(...)` in `src/agents/browseAgent.ts`

That loop:

- calls `llm.chatWithTools(...)`
- exposes the low-level browser tool set from `src/tools/browserTools.ts`
- executes tool calls through `BrowserManager`
- appends tool results back into the loop
- stops when the model returns plain text

### 4. Low-level browser execution

`BrowserManager` converts each low-level browser action into an `agent-browser` CLI call such as:

- `open`
- `snapshot`
- `click`
- `type`
- `scroll`
- `extract`
- `screenshot`
- `close`

Each call uses `--session <sessionKey>` so the browser task operates in an isolated logical session.

## Cancellation Model

Recent work unified cancellation across text and voice.

### Shared principles

- Every active `browser_browse` task gets an `AbortController`.
- The abort signal is threaded through:
  - top-level text/voice tool entrypoint
  - shared browser task runtime
  - `runBrowseAgent(...)`
  - `executeBrowserTool(...)`
  - `BrowserManager`
  - `execFile(..., { signal })` for the underlying `agent-browser` process
- Abort errors are normalized so callers consistently see a cancellation instead of a generic subprocess failure.

### Text path

Text browser tasks are scoped by guild + channel through `BrowserTaskRegistry`:

- only one active browser task is tracked per channel scope
- a plain `stop`, `cancel`, `never mind`, or `nevermind` in that same channel aborts the active browser task
- one channel’s cancellation does not cancel another channel’s browser task

This is implemented in:

- `src/bot.ts`
- `src/tools/browserTaskRuntime.ts`

### Voice path

OpenAI realtime voice tool calls also create abort controllers per pending call:

- pending tool-call controllers are stored on the voice session
- when a pending response is cleared or torn down, those controllers are aborted
- `browser_browse` receives the same signal and stops the underlying browse task eagerly

This is implemented in:

- `src/voice/voiceToolCalls.ts`
- `src/voice/voiceSessionManager.ts`

## Settings

Browser-agent settings live under `settings.agentStack.runtimeConfig.browser`, with the selected runtime resolved from `settings.agentStack`.

Important fields:

- `agentStack.runtimeConfig.browser.enabled`
- `agentStack.overrides.browserRuntime`
- `agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask`
- `agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs`
- `agentStack.runtimeConfig.browser.localBrowserAgent.execution.model.provider`
- `agentStack.runtimeConfig.browser.localBrowserAgent.execution.model.model`
- `agentStack.runtimeConfig.browser.openaiComputerUse.model`

These are edited in the dashboard Browser Runtime section.

The browser agent uses its own configurable LLM provider/model instead of always inheriting the main chat brain model.

## Limits and Guardrails

Current guardrails include:

- per-task max step cap
- per-step timeout
- channel-scoped active-task tracking
- browser usage budget checks before `browser_browse` runs
- public-URL enforcement in `BrowserManager`
- concurrent browser session cap in `BrowserManager`

## Observability

Browser-agent activity is visible via action-log kinds:

- `browser_browse_call`
- `browser_tool_step`

The dashboard text history also surfaces richer tool-result detail for browser-adjacent tool usage alongside other tool calls.

## Testing

Current focused coverage includes:

- `src/agents/browseAgent.test.ts`
- `src/tools/browserTaskRuntime.test.ts`
- `src/voice/voiceToolCalls.test.ts`

Those tests cover:

- timeout forwarding
- abort during the LLM loop
- abort during an in-flight browser tool call
- channel-scoped task registry behavior
- voice-path signal propagation
