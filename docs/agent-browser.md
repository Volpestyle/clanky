# Browser Agent Runtime

This document describes the shipped browser-agent system: how `browser_browse` works today, how it is configured, and how cancellation behaves across text and voice.

## Overview

The browser agent is a local browsing capability built on `agent-browser`. It runs headless by default and can optionally show a visible browser window from the dashboard Browser Runtime section:

- `src/services/BrowserManager.ts`: wraps `agent-browser` CLI commands and logical session lifecycle.
- `src/tools/browserTools.ts`: low-level browser tool schemas and execution wrappers (`browser_open`, `browser_click`, `browser_extract`, etc.).
- `src/agents/browseAgent.ts`: inner LLM tool loop that drives those browser tools until it reaches a final answer.
- `src/tools/browserTaskRuntime.ts`: shared task runtime used by both text and voice for task registration, cancellation, and normalized browser-browse execution.

At the top level, the main brain does not directly drive `browser_open` / `browser_click`. It calls the higher-level `browser_browse` tool, and that tool launches the inner browse agent.

The shared `browser_browse` schema description stays short on purpose. The schema names the capability and contrasts it with `web_scrape`; the fuller routing guidance lives in prompts and this runtime doc.

Tool selection is by fit, not a fixed ladder. `web_scrape` is best for quickly reading page text from a known URL. `browser_browse` is the right tool when the user explicitly asks for browser use, asks for a screenshot, asks what a page looks like, when page appearance/layout matters, or when navigation/interaction/JS rendering is needed.

When interactive browser sessions are enabled, `session_id` is the continuation signal. If a `browser_browse` turn returns a `session_id`, the parent brain can continue that session on a later turn. If the inner browser agent explicitly ends the session with `browser_close`, the tool result omits `session_id`. The parent brain does not need a second lifecycle flag to know whether continuation is possible.

## Where It Is Available

`browser_browse` is available in:

- `/clank browse` slash subcommand
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
- provider-native realtime voice tool definitions via `src/voice/voiceToolCallToolRegistry.ts`

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

When the inner browse agent captures a screenshot, that image is preserved as a structured image input instead of being stranded as raw base64 text. The parent brain receives the screenshot on the next continuation turn alongside the browser tool result text, so it can inspect the page visually. A request like "take a screenshot of eBay and tell me what's on the page" should route through `browser_browse`, not `web_scrape`.

`browser_close` is terminal for persistent browser sessions. It is not just a low-level cleanup action. When the inner agent uses it, the browser session is treated as completed, future continuation on that `session_id` is rejected, and the wrapper omits `session_id` from the returned tool result.

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

Each call uses a short deterministic `--session` value derived from the logical session key so the browser task operates in an isolated logical session without tripping Unix socket path-length limits inside `agent-browser`.

When `agentStack.runtimeConfig.browser.headed` is enabled, the local browser manager launches those sessions with `agent-browser --headed`, so you can watch the task on the same machine that is running the bot. The default remains headless.

## Cancellation Model

Cancellation is unified across text and voice. See [`cancel.md`](cancel.md) for the full cancellation system (detection, speaker ownership, recovery).

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

Provider-native realtime voice tool calls also create abort controllers per pending call:

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
- `agentStack.runtimeConfig.browser.headed`
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
- deterministic shortening of CLI-facing browser session names to stay below `agent-browser` socket limits on macOS/Linux

## Observability

Browser-agent activity is visible via action-log kinds:

- `browser_browse_call`
- `browser_tool_step`

The dashboard text history also surfaces richer tool-result detail for browser-adjacent tool usage alongside other tool calls.

`browser_browse_call` and `browser_agent_session_turn` metadata include `imageInputCount` when screenshots were captured and handed back to the parent brain.

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
