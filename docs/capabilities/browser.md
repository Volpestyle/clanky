# Browser Agent Runtime

This document describes the shipped browser-agent system: how `browser_browse` works today, how it is configured, and how cancellation behaves across text and voice.

Canonical media hub: [`media.md`](media.md)

## Overview

`browser_browse` is one browsing capability with two shipped runtimes selected from `settings.agentStack`:

- `local_browser_agent`: our internal browse-agent loop. An LLM drives low-level browser tools through `BrowserManager`.
- `openai_computer_use`: OpenAI-hosted computer-use reasoning. The model emits computer actions, and Clanker executes them locally through `BrowserManager`.

Both runtimes run headless by default and can optionally show a visible browser window from the dashboard Browser Runtime section.

Headless browser sessions still render pixels offscreen. `src/services/browserSessionVideoSource.ts`
turns an active `BrowserManager` session into a deduped frame source by sampling
session screenshots plus the current URL at an adaptive cadence. That makes the
browser runtime usable as a visual source for outbound stream publish and other
live-visual features without requiring `headed` mode.

When voice is active, those same persistent browser sessions can also be shared
through the native Go Live sender path. `share_browser_session` attaches an
existing browser session to the outbound publish transport, and
`stop_video_share` tears that outbound browser/video share down cleanly.

Key modules:

- `src/services/BrowserManager.ts`: wraps `agent-browser` CLI commands and logical session lifecycle.
- `src/tools/browserTools.ts`: low-level browser tool schemas and execution wrappers (`browser_open`, `browser_click`, `browser_extract`, etc.) for the local runtime.
- `src/agents/browseAgent.ts`: inner LLM tool loop for `local_browser_agent`.
- `src/tools/browserTaskRuntime.ts`: local-runtime wrapper used by both text and voice for cancellation, logging, and normalized browser-browse execution.
- `src/tools/openAiComputerUseRuntime.ts`: hosted `openai_computer_use` loop that feeds screenshots into the OpenAI Responses API and replays returned computer actions.

At the top level, the main brain does not directly drive `browser_open` / `browser_click`. It calls the higher-level `browser_browse` tool, and that tool dispatches to the configured browser runtime.

The shared `browser_browse` schema description stays short on purpose. The schema names the capability and contrasts it with `web_scrape`; the cross-modal routing policy lives in `src/prompts/toolPolicy.ts`, and this runtime doc adds browser-specific behavior on top.

Tool selection is by fit, not a fixed ladder. `web_scrape` is best for quickly reading page text from a known URL. `browser_browse` is the right tool when the user explicitly asks for browser use, asks for a screenshot, asks what a page looks like, when page appearance/layout matters, or when navigation/interaction/JS rendering is needed.

When the resolved runtime is `local_browser_agent` and browser sessions are enabled, `session_id` is the continuation signal. If a `browser_browse` turn returns a `session_id`, the parent brain can continue that session on a later turn. If the inner browser agent explicitly ends the session with `browser_close`, the tool result omits `session_id`. `openai_computer_use` is currently one-shot; it does not expose persistent `browser_browse` session continuation.

## Where It Is Available

`browser_browse` is available in:

- `/clank browse` slash subcommand
- text reply tool loop
- full-brain voice reply tool loop
- provider-native realtime voice tool loop

`share_browser_session` / `stop_video_share` are voice-adjacent tools rather
than generic browser tools. They are only useful when there is an active voice
session plus a persistent local browser session to share.

In the full-brain voice path, `share_browser_session` only works when the voice
reply runtime forwards the active `voiceSession`, `voiceSessionManager`, and
`subAgentSessions` into the shared reply-tool runtime. That gives the tool both
the live Discord publish transport and the persistent browser session lookup it
needs to attach an existing browser session to Go Live.

It is intentionally not enabled for automation runs right now, even though automations use the same general reply-tool loop.

## Runtime Flow

### 1. Top-level tool call

The top-level brain decides it needs interactive browsing and calls:

```text
browser_browse({ query: "go find ..." })
```

That top-level tool exists in:

- text replies via `src/tools/replyTools.ts`
- full-brain voice replies via `src/bot/voiceReplies.ts`
- provider-native realtime voice tool definitions via `src/voice/voiceToolCallToolRegistry.ts`

### 2. Runtime selection

Text and voice both resolve the active browser runtime from `agentStack.runtimeConfig.browser` / `agentStack.overrides.browserRuntime`.

Current runtime values:

- `local_browser_agent`
- `openai_computer_use`

The `openai_native_realtime` and `openai_oauth` presets default to `openai_computer_use`. Other presets currently default to the local browser agent unless explicitly overridden.
The dashboard Browser section can override that preset default directly, so a Claude preset can still route `browser_browse` through OpenAI computer use.

### 3. Local runtime: `local_browser_agent`

Text and voice route through:

- `runBrowserBrowseTask(...)` in `src/tools/browserTaskRuntime.ts`

That wrapper is responsible for:

- starting the local browse-agent run
- normalizing abort/cancel errors
- logging `browser_browse_call`
- keeping task lifecycle behavior aligned across modalities

It then calls:

- `runBrowseAgent(...)` in `src/agents/browseAgent.ts`

That inner loop:

- calls `llm.chatWithTools(...)`
- exposes the low-level browser tool set from `src/tools/browserTools.ts`
- executes tool calls through `BrowserManager`
- appends tool results back into the loop
- stops when the model returns plain text

When the inner browse agent captures a screenshot, that image is preserved as a structured image input instead of being stranded as raw base64 text. The parent brain receives the screenshot alongside the browser tool result text, so it can inspect the page visually. In text replies, the brain can either keep those screenshots private as reasoning context or explicitly attach the exact tool-returned images in the final Discord message. A request like "take a screenshot of eBay and tell me what's on the page" should route through `browser_browse`, not `web_scrape`.

`browser_close` is terminal for persistent local browser sessions. It is not just a low-level cleanup action. When the inner agent uses it, the browser session is treated as completed, future continuation on that `session_id` is rejected, and the wrapper omits `session_id` from the returned tool result.

### 4. Hosted runtime: `openai_computer_use`

When the resolved runtime is `openai_computer_use`, text and voice call:

- `runOpenAiComputerUseTask(...)` in `src/tools/openAiComputerUseRuntime.ts`

That runtime:

- opens a local browser session through `BrowserManager`
- sends the current URL plus a screenshot to the OpenAI Responses API computer tool
- executes returned computer actions locally (`click`, `type`, `keypress`, `drag`, `scroll`, `move`, `wait`)
- captures a fresh screenshot after each action batch and feeds it back into the hosted loop
- stops when OpenAI returns final text or the task hits the configured step cap

This branch still uses the local browser manager for actual page execution, but it does not run our inner `browseAgent.ts` loop and it does not expose multi-turn `session_id` continuation to the parent brain.

### 5. Low-level browser execution

For the local runtime, `BrowserManager` converts each low-level browser action into an `agent-browser` CLI call such as:

- `open`
- `snapshot`
- `click`
- `type`
- `scroll`
- `extract`
- `screenshot`
- `close`

Each call uses a short deterministic `--session` value derived from the logical session key so the browser task operates in an isolated logical session without tripping Unix socket path-length limits inside `agent-browser`.

The hosted `openai_computer_use` runtime also executes against the same `BrowserManager`, but the action plan comes from OpenAI computer-use output instead of our local browser tool loop.

When `agentStack.runtimeConfig.browser.headed` is enabled, the local browser manager launches those sessions with `agent-browser --headed`, so you can watch the task on the same machine that is running the bot. The default remains headless.

## Cancellation Model

Cancellation is unified across text and voice. See [`../operations/cancellation.md`](../operations/cancellation.md) for the full cancellation system (detection, speaker ownership, recovery).

### Shared principles

- Every active `browser_browse` task gets an `AbortController`.
- The abort signal is threaded through:
  - top-level text/voice tool entrypoint
  - either `runBrowserBrowseTask(...)` or `runOpenAiComputerUseTask(...)`
  - hosted runtime only: the OpenAI Responses API computer-use request loop
  - local runtime only: `runBrowseAgent(...)` and `executeBrowserTool(...)`
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

Full-brain voice replies use the same `ReplyToolRuntime` path as text replies:

- the voice-generation abort signal is forwarded into reply-tool execution
- when sub-agent sessions are available, `browser_browse` uses the persistent local browser-session path before falling back to one-shot channel-scoped browser tasks

Provider-native realtime voice tool calls also create abort controllers per pending call:

- pending tool-call controllers are stored on the voice session
- when a pending response is cleared or torn down, those controllers are aborted
- `browser_browse` receives the same signal and stops the underlying browse task eagerly

This is implemented in:

- `src/voice/voiceToolCallInfra.ts`
- `src/voice/voiceToolCallAgents.ts`
- `src/voice/voiceSessionManager.ts`

## Persistent Browser Profile (Authenticated Browsing)

By default, every browser session starts fresh with no cookies or login state. To let the bot browse as an authenticated user, configure a persistent Chromium profile directory.

### How it works

`agent-browser` supports `--profile <path>`, which points to a persistent Chromium user data directory. When set, cookies, localStorage, IndexedDB, saved passwords, and all other browser state persist across sessions. The bot reuses existing login state every time it opens a browser.

### Setup

1. The default profile path is `~/.clanky/browser-profile`. This is used automatically — no dashboard configuration required. To use a different path, change it in the dashboard (Research & Browsing > Browser profile path) or directly in settings.

2. Run a headed login session to establish auth state:
   ```sh
   agent-browser --profile ~/.clanky/browser-profile --headed open https://youtube.com
   ```
   Log into each site you want the bot to access. The profile directory persists all cookies and session data.

3. Close the headed session. Future bot-initiated browser sessions automatically inherit the saved auth state.

### Important notes

- The profile directory is shared across all browser sessions. Concurrent sessions using the same profile may conflict — `agent-browser` handles this via its session daemon, but be aware of potential cookie mutation races.
- Sessions that the site expires (e.g. 30-day login tokens) require re-authentication through another headed session.
- The profile path supports `~` expansion by the shell when used via CLI. In the dashboard, use an absolute path.

## Settings

The canonical persistence, preset, and save semantics for these fields live in [`../reference/settings.md`](../reference/settings.md).

This document only covers the browser-local knobs that matter for browser runtime behavior.

Important fields:

- `agentStack.runtimeConfig.browser.enabled`
- `agentStack.runtimeConfig.browser.headed`
- `agentStack.runtimeConfig.browser.profile`
- `agentStack.overrides.browserRuntime` (`local_browser_agent` or `openai_computer_use`)
- `agentStack.runtimeConfig.browser.openaiComputerUse.client` (`auto`, `openai`, or `openai-oauth`)
- `agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask`
- `agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs`
- `agentStack.runtimeConfig.browser.localBrowserAgent.execution.model.provider`
- `agentStack.runtimeConfig.browser.localBrowserAgent.execution.model.model`
- `agentStack.runtimeConfig.browser.openaiComputerUse.model`

These are edited in the dashboard Browser Runtime section. The browser runtime override is independent from the main orchestrator preset, so you can keep `claude_oauth` as the conversational brain while routing `browser_browse` through `openai_computer_use`.

The browser agent uses its own configurable LLM provider/model instead of always inheriting the main chat brain model.
When the hosted runtime is selected, the browser layer resolves its own OpenAI-compatible client separately from the main orchestrator. `openaiComputerUse.client = auto` prefers a direct OpenAI API key and falls back to OpenAI OAuth when available.

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
- `browser_browse_failed`
- `browser_tool_step` (local runtime low-level steps)

The dashboard text history also surfaces richer tool-result detail for browser-adjacent tool usage alongside other tool calls.
The dashboard Agents tab follows the global header guild selector, so browser-session history stays isolated to the currently selected guild instead of mixing sessions from every server.

`browser_browse_call` is emitted by both runtimes. The local runtime records `sessionKey`, runtime/provider/model, step count, cost, screenshot count, and duration. The hosted runtime records `runtime: "openai_computer_use"`, `sessionKey`, step count, current URL, and duration. `browser_browse_failed` is emitted by both runtimes with the same correlation metadata plus the concrete error name/message so Grafana and the Agents tab can reconstruct failed runs. `browser_agent_session_turn` is specific to the local browse-agent loop.

## Testing

Current focused coverage includes:

- `src/agents/browseAgent.test.ts`
- `src/tools/browserTaskRuntime.test.ts`
- `src/tools/openAiComputerUseRuntime.test.ts`
- `src/voice/voiceToolCalls.test.ts`

Those tests cover:

- runtime selection and settings gating
- timeout forwarding
- abort during the LLM loop
- abort during an in-flight browser tool call
- OpenAI computer-use action execution and cancellation
- channel-scoped task registry behavior
- voice-path signal propagation
