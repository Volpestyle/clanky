# Async Code Task Dispatch

## Problem

When the orchestrator LLM calls `code_task`, the entire reply pipeline blocks until the sub-agent finishes. For short tasks (< 30s), this is fine. For multi-minute tasks, the user experience degrades:

- **Text channel:** typing indicator dies after ~10s. Channel goes silent for minutes.
- **Voice channel:** output state is `tool_call_in_progress`. Silence until done.
- **No progress feedback.** The user has no idea whether the bot is working, stuck, or crashed.

Meanwhile, rich progress data is already flowing through the sub-agent processes (Claude Code stream-json events, Codex CLI JSONL events) -- we just throw it away by buffering everything and only parsing at the end.

## Design Principles

- **The LLM authors every user-facing message.** No canned "Working on it..." text. The orchestrator composes the acknowledgment, the runtime triggers follow-ups, and the LLM composes those too.
- **`[SKIP]` is always an option.** The LLM can decide not to send a progress update if it judges it unnecessary.
- **Deterministic gates for infrastructure, agent autonomy for content.** The runtime decides *when* to trigger an update cycle. The LLM decides *what* to say (or not).
- **Graceful degradation.** If async dispatch isn't available (e.g., no channel context), fall back to the existing blocking behavior. Short tasks stay synchronous.

## Architecture

```
User: "refactor the auth module"
                │
     ┌──────────▼──────────┐
     │   Orchestrator LLM   │
     │  calls code_task()   │
     └──────────┬──────────┘
                │
     ┌──────────▼──────────┐
     │  executeCodeTask()   │  duration heuristic → async
     │  dispatches to       │  returns immediately:
     │  BackgroundTaskRunner │  "Task dispatched. Session X running."
     └──────────┬──────────┘
                │
    ┌───────────┼───────────────────┐
    │           │                   │
    ▼           ▼                   ▼
 tool result  background task    orchestrator LLM
 "dispatched" runs sub-agent     composes ack:
              in parallel        "On it, I'll follow
              with progress      up when it's done."
              streaming               │
                │                     ▼
                │               Discord message
                │
          [minutes pass]
          progress events
          accumulate
                │
     ┌──────────▼──────────┐
     │  Milestone check     │  every ~60s or on
     │  (runtime timer)     │  significant progress
     └──────────┬──────────┘
                │ (optional)
     ┌──────────▼──────────┐
     │  Trigger mini reply  │  LLM sees progress context,
     │  pipeline with       │  composes update or [SKIP]
     │  progress context    │
     └──────────┬──────────┘
                │
     ┌──────────▼──────────┐
     │  Task completes      │
     │  → completion        │
     │    callback fires    │
     └──────────┬──────────┘
                │
     ┌──────────▼──────────┐
     │  Trigger reply       │  LLM sees full result,
     │  pipeline with       │  composes follow-up message
     │  result context      │
     └──────────┬──────────┘
                │
                ▼
          Discord follow-up
```

## Layer 1: Async Dispatch

### Tool Contract Change

`executeCodeTask` gains a duration heuristic. When the task is expected to be long (based on settings thresholds), it dispatches asynchronously and returns an immediate result to the orchestrator LLM.

```ts
// Short task (default / fallback): blocking, same as today
// Long task (async dispatch): returns immediately

// Tool result for async dispatch:
{
  content: "Code task dispatched. Background session code:impl:abc123 is running.\n" +
           "The task will run for up to 5 minutes. A follow-up will be posted in this channel when it completes.\n" +
           "You can acknowledge this to the user now.",
  isError: false
}
```

The orchestrator LLM sees this and composes a natural acknowledgment. It does NOT get a `session_id` back -- there's no multi-turn follow-up on async tasks. The runtime handles delivery.

### Duration Heuristic

Configurable per-worker threshold. Suggested defaults:

| Worker | Async Threshold | Rationale |
|--------|----------------|-----------|
| `claude-code` | always async | Claude Code tasks typically run 1-10 minutes |
| `codex-cli` | always async | Codex CLI tasks typically run 30s-5 minutes |
| `codex` (API) | always async | Remote API, unpredictable latency |

Override: a new `asyncDispatch` setting under `agentStack.runtimeConfig.devTeam.<worker>`:

```ts
asyncDispatch: {
  enabled: true,          // false = always block (legacy behavior)
  thresholdMs: 0          // 0 = always async when enabled
}
```

For the initial implementation: default to `enabled: true, thresholdMs: 0` for all workers. The blocking path remains as a fallback when `enabled: false` or when the dispatch infrastructure isn't available (missing channel context, voice-only without text channel).

### BackgroundTaskRunner

A new component that manages in-flight async code tasks.

```ts
interface BackgroundTask {
  id: string;                              // session ID from SubAgentSession
  sessionId: string;                       // SubAgentSession ID
  guildId: string;
  channelId: string;
  userId: string | null;
  triggerMessageId: string | null;         // the message that triggered the task
  role: CodeAgentRole;
  startedAt: number;
  status: "running" | "completed" | "error" | "cancelled";
  progress: BackgroundTaskProgress;
  result: SubAgentTurnResult | null;       // populated on completion
  promise: Promise<void>;                  // the running task
}

interface BackgroundTaskProgress {
  events: SubAgentProgressEvent[];         // accumulated progress events
  lastEventAt: number;
  turnNumber: number;
  totalTurns: number | null;
  fileEdits: string[];                     // file paths touched
  lastMilestoneReportedAt: number;         // when we last triggered a progress report
}
```

**Lifecycle:**

1. `dispatch(session, channelContext)` — registers the task, starts `session.runTurn()` in the background, returns immediately.
2. The background promise runs the sub-agent, accumulates progress events, and on completion calls the configured `onComplete` callback.
3. `cancel(taskId, reason)` — cancels the sub-agent session and marks the task as cancelled.
4. Cleanup: tasks are removed after result delivery or after a max retention period (e.g., 30 minutes).

**Where it lives:** `src/agents/backgroundTaskRunner.ts`, instantiated on `ClankerBot` alongside `SubAgentSessionManager`.

## Layer 2: Progress Streaming

### SubAgentSession Progress Callback

Add an optional `onProgress` callback to `runTurn`:

```ts
interface SubAgentProgressEvent {
  kind: "tool_use" | "file_edit" | "assistant_message" | "turn_complete" | "error";
  summary: string;           // human-readable, e.g. "Editing src/auth/tokenValidator.ts"
  turnNumber?: number;
  elapsedMs: number;
  timestamp: number;
}

// Updated runTurn signature:
runTurn(input: string, options?: {
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
}): Promise<SubAgentTurnResult>;
```

### Stream Parsing Changes

**Claude Code (`ClaudeCliStreamSession`):**

The stream-json protocol already emits events as they arrive. Currently `run()` collects all stdout and returns it as one blob. Change: parse events as they arrive and emit progress callbacks.

Relevant events to surface:
- `type: "assistant"` with `subtype: "tool_use"` → `kind: "tool_use"`, summary from tool name/input
- `type: "assistant"` with text content → `kind: "assistant_message"`, summary from text prefix
- `type: "result"` → `kind: "turn_complete"`

**Codex CLI (`CodexCliStreamSession`):**

The JSONL protocol emits events line-by-line. Currently we buffer and parse at the end. Change: parse each line as it arrives and emit progress callbacks.

Relevant events:
- `type: "item.completed"` with `item.type: "tool_call"` → `kind: "tool_use"`
- `type: "item.completed"` with `item.type: "agent_message"` → `kind: "assistant_message"`
- `type: "turn.completed"` → `kind: "turn_complete"`

**Codex API (`CodexAgentSession`):**

The polling loop already checks status periodically. Surface the polling status as progress events.

### File Edit Detection

Extract file paths from tool use events. Claude Code's `tool_use` events include `Write`, `Edit`, and similar tool names with `file_path` parameters. Codex CLI's tool calls similarly reference file paths. Accumulate these on `BackgroundTaskProgress.fileEdits` for use in progress reports.

## Layer 3: Result & Progress Delivery

### Completion Callback

When a background task finishes, the `BackgroundTaskRunner` calls `deliverAsyncTaskResult()` on the bot. This follows the existing `handleMemberJoin` synthetic event pattern:

1. Build a synthetic context payload:

```
[CODE TASK COMPLETED]
Session: code:impl:abc123
Role: implementation
Duration: 3 minutes 12 seconds
Status: success
Cost: $0.18

Result:
<full sub-agent output, truncated to reasonable length>

Files touched: src/auth/tokenValidator.ts, src/auth/types.ts, src/auth/index.ts

This is an async task completion event, not a chat message.
Compose a follow-up for the user who requested it.
```

2. Record in message history with synthetic ID `code-task-result-${taskId}-${timestamp}`.
3. Build a synthetic message-like object targeting the original channel.
4. Call `enqueueReplyJob({ source: "code_task_result", message: syntheticMessage, forceRespond: true })`.

`forceRespond: true` bypasses admission gates since the user explicitly requested this work. The LLM sees full channel context + the result and composes a natural follow-up.

### Progress Milestone Reporting (Optional)

A periodic check (every 60s) on active background tasks. For each task with meaningful new progress since the last report, trigger a mini reply pipeline:

```
[CODE TASK PROGRESS]
Session: code:impl:abc123
Status: running (turn 4 of 30, elapsed 90s)
Recent activity:
- Edited src/auth/tokenValidator.ts
- Created src/auth/types.ts
- Running tests

This is a progress update for an active code task.
Compose a brief update for the user, or respond with [SKIP] if unnecessary.
```

This runs through the same `enqueueReplyJob` path but with softer delivery. The LLM can `[SKIP]` if it judges the update unnecessary. Settings control whether progress reports are enabled and the milestone interval.

### Voice Surface

For voice text-mediated replies (`voiceReplies.ts`): same pattern as text -- the async result triggers a follow-up voice reply with the result context injected.

For voice realtime (`voiceToolCallAgents.ts`): the tool returns the "dispatched" result immediately. The realtime model speaks an acknowledgment. On completion, the runtime injects a `conversation.item.create` with the result text, then triggers a response. This follows the pattern used by `scheduleRealtimeToolFollowupResponse`.

## Settings Surface

New settings under `agentStack.runtimeConfig.devTeam.<worker>.asyncDispatch`:

```ts
asyncDispatch: {
  enabled: boolean;              // default: true
  thresholdMs: number;           // default: 0 (always async when enabled)
  progressReports: {
    enabled: boolean;            // default: true
    intervalMs: number;          // default: 60_000
    maxReportsPerTask: number;   // default: 5
  }
}
```

Dashboard: add an "Async Dispatch" toggle and progress report interval under the code agent advanced settings section.

## Cancellation Integration

The existing `ActiveReplyRegistry` and cancel detection (from the tool-call-cancellation design) integrate directly:

- When the user says "stop" or "cancel", the `ActiveReplyRegistry` fires abort signals.
- For async tasks, the `BackgroundTaskRunner` listens for cancel and calls `session.cancel()`.
- The background task is marked `cancelled` and a cancellation delivery is triggered (same pattern as completion, but with a cancellation context).

A dedicated cancel mechanism for background tasks:

- The LLM could call `code_task` with a cancel intent (new `action: "cancel"` parameter, or a separate `code_task_cancel` tool).
- Or: the text/voice cancel detection path (`isCancelIntent`) cancels all active background tasks for the channel scope.

## Implementation Order

| Phase | Work | Scope |
|-------|------|-------|
| **1a** | `BackgroundTaskRunner` class | New file: `src/agents/backgroundTaskRunner.ts` |
| **1b** | Async dispatch path in `executeCodeTask` | Modify: `src/tools/replyTools.ts` |
| **1c** | Completion delivery via synthetic event | Modify: `src/bot.ts`, new method `deliverAsyncTaskResult` |
| **1d** | Wire up in bot constructor | Modify: `src/bot.ts` |
| **2a** | `onProgress` callback on `SubAgentSession` | Modify: `src/agents/subAgentSession.ts` |
| **2b** | Real-time event parsing in `ClaudeCliStreamSession` | Modify: `src/llm/llmClaudeCode.ts` |
| **2c** | Real-time event parsing in `CodexCliStreamSession` | Modify: `src/llm/llmCodexCli.ts` |
| **3a** | Progress milestone delivery | Modify: `src/agents/backgroundTaskRunner.ts` |
| **3b** | Voice realtime async dispatch | Modify: `src/voice/voiceToolCallAgents.ts` |
| **3c** | Dashboard settings for async dispatch | Modify: dashboard components |
| **3d** | Cancel integration | Modify: cancel detection paths |

Phase 1 is the core UX fix. Phase 2 adds progress visibility. Phase 3 is polish.

## Prompt Construction

### New Prompt Builder: `buildCodeTaskResultPrompt`

Located in `src/prompts/promptText.ts`, alongside `buildInitiativePrompt` and `buildAutomationPrompt`. This builds the user-facing prompt for async code task results and progress updates.

Input context:
- Task metadata (session ID, role, duration, status, cost)
- Full or partial sub-agent output
- Files touched
- Original trigger message (if available)
- Recent channel history (same window as initiative)
- Memory facts for the requesting user

The prompt instructs the LLM to compose a natural follow-up, not to echo the raw output, and to summarize appropriately for the channel context. For progress updates, it permits `[SKIP]`.

## Open Questions

1. **Should async be the default for all code tasks, or opt-in?** The design defaults to always-async for all workers. An alternative: only dispatch async when estimated duration exceeds a threshold. But estimating duration is unreliable. Simpler to always dispatch async and let short tasks complete quickly with a fast follow-up.

2. **Should progress reports use message edits or new messages?** Edits are cleaner (one message updated in place) but harder to implement (need to track the message ID). New messages are simpler but can be spammy. Recommendation: new messages for now, with `maxReportsPerTask` as a cap. Consider edits as a future refinement.

3. **What about the `/clank code` slash command?** The slash command path already has `deferReply()` which provides a persistent loading indicator. It could keep the blocking behavior (best UX with deferred reply) or switch to async with `editReply()` updates. Recommendation: keep slash command blocking for now since `deferReply()` already solves the UX problem.

4. **Thread delivery?** For channels where the code task result would be a large message, should the bot create a thread? This is a UX question, not an architecture one. The LLM could be given the option to suggest thread creation. Defer to later.
