# Unified Tool Call Cancellation System

## Problem

Clanker has no general mechanism to cancel in-flight tool calls when a user says "stop", "cancel", "nevermind", etc. The only working cancellation path today is text-channel -> `browser_browse` via `BrowserTaskRegistry`. Everything else (voice tools, text reply pipeline, sub-agents, MCP calls) runs to completion even if the user explicitly asks to stop.

### Current State

| Layer | Mechanism | Scope | Signal Threading |
|-------|-----------|-------|------------------|
| `BrowserTaskRegistry` | `Map<scopeKey, ActiveBrowserTask>` | guild:channel | Full (signal -> browseAgent) |
| `openAiPendingToolAbortControllers` | `Map<callId, AbortController>` on session | per voice tool call | Partial (only `browser_browse` receives it) |
| `clearPendingResponse` | Iterates + aborts all controllers | entire voice session | Triggers abort but no listeners on most tools |
| Text `stop`/`cancel` keyword | `activeBrowserTasks.abort()` | guild:channel | Only browser tasks |
| `SubAgentSessionManager` | `Map<id, SubAgentSession>` with `close()` | per session ID | None (no signal, no cancel) |

### Gaps

| Gap | Location | Impact |
|-----|----------|--------|
| Text reply pipeline has no abort mechanism | `src/bot/replyPipeline.ts` | "stop" during a web_search or code_task in text does nothing |
| Voice tool signal not threaded to most tools | `src/voice/voiceToolCallDispatch.ts:119-175` | web_search, memory_search, music_*, etc. can't be aborted |
| No voice keyword detection for "stop"/"cancel" | `src/voice/voiceSessionManager.ts` | Saying "stop" in voice doesn't trigger tool abort |
| Sub-agent sessions have no user-initiated cancel | `src/agents/subAgentSession.ts` | No way to cancel a running code_task or browser agent via user input |

---

## Design Principles

1. **Single registry, scoped by channel** -- One `ActiveReplyRegistry` tracks all cancellable work per `guildId:channelId` (text) or per voice session (voice). Replaces the need for tool-specific registries.
2. **Cooperative cancellation via `AbortSignal`** -- Thread a signal through every async operation. Check it at stage boundaries. No forceful kills.
3. **Consistent detection** -- Same keyword set for text and voice, extracted to a shared utility.
4. **Orphan cleanup** -- When a tool call is cancelled mid-flight, synthesize a clean tool result so the LLM provider doesn't get mismatched `tool_use`/`tool_result` pairs (inspired by openclaw's `session-tool-result-guard`).
5. **Abort cutoff** -- Prevent queued/deferred work from executing after a cancel.

---

## Architecture

```
+-----------------------------------------------------------+
|                  Cancellation Detection                    |
|                                                           |
|  Text channel:  bot.ts handleMessage()                    |
|    +-- isCancelIntent(messageText)                        |
|                                                           |
|  Voice channel: turnProcessor.ts runRealtimeTurn()        |
|    +-- isCancelIntent(transcript) [post-ASR]              |
|                                                           |
|  Shared: src/tools/cancelDetection.ts                     |
|    +-- isCancelIntent(text): boolean                      |
+----------------------------+------------------------------+
                             |
                             v
+-----------------------------------------------------------+
|              ActiveReplyRegistry                           |
|              src/tools/activeReplyRegistry.ts              |
|                                                           |
|  Map<scopeKey, Set<ActiveReply>>                           |
|                                                           |
|  ActiveReply {                                            |
|    id: string                                             |
|    scopeKey: string          // guild:channel or session   |
|    kind: "text-reply" | "voice-tool" | "sub-agent"        |
|    abortController: AbortController                       |
|    startedAt: number                                      |
|    toolNames: string[]       // for logging/feedback      |
|  }                                                        |
|                                                           |
|  Methods:                                                 |
|    begin(scopeKey, kind) -> { signal, handle }            |
|    abortAll(scopeKey, reason) -> number                   |
|    clear(handle)                                          |
|    has(scopeKey) -> boolean                               |
|    isStale(scopeKey, startedAt) -> boolean                |
+----------------------------+------------------------------+
                             |
          +------------------+------------------+
          v                  v                  v
   +--------------+ +--------------+ +------------------+
   | Text Reply   | |  Voice       | |  Sub-Agent       |
   |  Pipeline    | |  Tools       | |  Sessions        |
   |              | |              | |                  |
   | signal       | | signal       | | signal           |
   | threaded     | | threaded     | | threaded         |
   | through:     | | to ALL       | | to runTurn()     |
   | - generate   | | tools,       | |                  |
   | - tool loop  | | not just     | |                  |
   | - each tool  | | browser      | |                  |
   +--------------+ +--------------+ +------------------+
```

---

## Component Details

### 1. Cancel Detection -- `src/tools/cancelDetection.ts` (new)

Shared cancel-intent detection, used by both text and voice paths.

```typescript
const CANCEL_KEYWORDS = /^(?:stop|cancel|never\s?mind|nevermind|nvm|forget\s?it|abort|quit)$/i;

export function isCancelIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return CANCEL_KEYWORDS.test(text.trim());
}
```

Simple regex, same approach as the existing music disambiguation pattern in `voiceMusicDisambiguation.ts`. No LLM needed -- these are unambiguous imperative commands.

### 2. Active Reply Registry -- `src/tools/activeReplyRegistry.ts` (new)

Replaces the role of `BrowserTaskRegistry` for general-purpose reply tracking. `BrowserTaskRegistry` continues to exist for browser-specific scope management (auto-supersede semantics) but the cancel keyword path goes through this registry.

```typescript
type ReplyKind = "text-reply" | "voice-tool" | "sub-agent";

interface ActiveReply {
  id: string;
  scopeKey: string;
  kind: ReplyKind;
  abortController: AbortController;
  startedAt: number;
  toolNames: string[];
}

class ActiveReplyRegistry {
  private readonly repliesByScope = new Map<string, Set<ActiveReply>>();
  private readonly abortCutoffs = new Map<string, number>();

  /** Register a new cancellable operation. Returns the signal to thread. */
  begin(scopeKey: string, kind: ReplyKind): ActiveReply { ... }

  /** Abort all active replies for a scope. Returns count aborted. */
  abortAll(scopeKey: string, reason: string): number {
    // ... abort all active replies ...
    this.abortCutoffs.set(scopeKey, Date.now());
    return count;
  }

  /** Remove a completed reply from tracking. */
  clear(reply: ActiveReply): void { ... }

  /** Check if any active work exists for a scope. */
  has(scopeKey: string): boolean { ... }

  /** Returns true if work should be skipped (was started before an abort). */
  isStale(scopeKey: string, startedAt: number): boolean {
    const cutoff = this.abortCutoffs.get(scopeKey);
    return cutoff != null && startedAt < cutoff;
  }
}
```

Key difference from `BrowserTaskRegistry`: uses a `Set` per scope (multiple concurrent tool calls can be active), not a single entry. The `abortAll` method iterates the set and fires all controllers.

### 3. Text Channel Changes -- `src/bot.ts`

Expand the existing stop/cancel handler (currently at lines 1022-1036):

```typescript
// Before (only browser tasks):
if (isCancelKeyword(lowerText)) {
  this.activeBrowserTasks.abort(scopeKey, "...");
}

// After (all active work):
if (isCancelIntent(text)) {
  const scopeKey = `${message.guildId}:${message.channelId}`;
  const cancelledCount = this.activeReplies.abortAll(
    scopeKey, "User requested cancellation"
  );
  // BrowserTaskRegistry abort stays as a fallback for standalone browser tasks
  const browserCancelled = this.activeBrowserTasks.abort(
    buildBrowserTaskScopeKey({ guildId, channelId }),
    "User requested cancellation"
  );
  if (cancelledCount > 0 || browserCancelled) {
    await message.reply("Cancelled.");
    return;
  }
  // If nothing was active, fall through to normal message handling
  // (the LLM can respond naturally to "never mind" etc.)
}
```

### 4. Text Reply Pipeline Changes -- `src/bot/replyPipeline.ts`

Thread a signal through the entire pipeline:

```typescript
// In maybeReplyToMessagePipeline or attemptReply:
const activeReply = bot.activeReplies.begin(scopeKey, "text-reply");
const { signal } = activeReply.abortController;

try {
  // Pass signal to LLM generate
  const llmResult = await bot.llm.generate({ ...opts, signal });

  // Tool loop: check signal between iterations
  while (generation.toolCalls?.length > 0 && ...) {
    throwIfAborted(signal);  // guard at top of each loop iteration

    // Pass signal to each tool execution
    for (const toolCall of sequentialToolCalls) {
      throwIfAborted(signal);
      const result = await executeReplyTool(toolCall, { ...opts, signal });
    }

    // Pass signal to concurrent tool calls
    const concurrentResults = await Promise.allSettled(
      concurrentToolCalls.map(tc =>
        executeReplyTool(tc, { ...opts, signal })
      )
    );

    throwIfAborted(signal);  // guard before follow-up LLM call
    generation = await bot.llm.generate({ ...opts, signal });
  }
} catch (error) {
  if (isAbortError(error)) {
    // Clean exit -- don't send a reply, don't log as error
    return true;
  }
  throw error;
} finally {
  bot.activeReplies.clear(activeReply);
}
```

### 5. Voice Tool Dispatch Changes -- `src/voice/voiceToolCallDispatch.ts`

Thread `opts.signal` to **all** local tools, not just `browser_browse`:

```typescript
// Every case in the switch statement gets signal:
case "web_search":
  return executeWebSearch({ ...opts.args, signal: opts.signal });
case "memory_search":
  return executeMemorySearch({ ...opts.args, signal: opts.signal });
case "code_task":
  return executeVoiceCodeTaskTool(manager, { ...opts, signal: opts.signal });
// ... etc for all tools
```

Individual tool implementations need to accept and respect the signal -- at minimum calling `throwIfAborted(signal)` at entry, and passing it to any `fetch()` or long-running sub-operation.

### 6. Voice Cancel Detection -- `src/voice/turnProcessor.ts`

Add a cancel keyword check early in `runRealtimeTurn()` and `runFileAsrTurn()`, after transcript is available but before the music check:

```typescript
// In runRealtimeTurn(), after transcript is available (~line 613):
if (isCancelIntent(transcript)) {
  // Abort all pending tool calls for this voice session
  const session = turn.session;
  if (session.openAiPendingToolAbortControllers?.size) {
    for (const controller of session.openAiPendingToolAbortControllers.values()) {
      try { controller.abort("User said cancel"); } catch {}
    }
    session.openAiPendingToolAbortControllers.clear();
  }
  // Cancel any active realtime response
  session.realtimeClient?.cancelActiveResponse?.();
  // Send acknowledgment (let the LLM generate the exact wording)
  // OR: send a brief operational message and return early
  return;
}
```

This runs before `maybeHandleMusicPlaybackTurn()` and `evaluateVoiceReplyDecision()`, so it short-circuits the entire turn when cancel intent is detected.

### 7. Sub-Agent Session Changes -- `src/agents/subAgentSession.ts`

Add signal support to `SubAgentSession`:

```typescript
interface SubAgentSession {
  // existing...
  runTurn(
    input: string,
    options?: { signal?: AbortSignal }
  ): Promise<SubAgentTurnResult>;
  cancel(reason?: string): void;  // new: triggers abort + sets status
}
```

The `cancel()` method sets `status = "cancelled"` and fires the internal abort controller. `runTurn` checks the signal at each stage boundary.

### 8. Abort Cutoff (Race Condition Prevention)

After aborting, set a cutoff timestamp on the scope to prevent deferred/queued work from executing. This is built into `ActiveReplyRegistry.abortAll()` (see section 2 above).

Check `isStale()` before processing:
- Deferred voice actions (`deferredActionQueue`)
- Queued tool results
- Follow-up LLM calls

---

## What NOT to Do

- **Don't use the LLM to detect cancel intent.** This is a deterministic, unambiguous keyword match -- adding latency and cost for an obvious decision is the wrong tradeoff.
- **Don't force-kill running processes.** Cooperative cancellation via `AbortSignal` is sufficient and avoids resource leaks.
- **Don't merge `BrowserTaskRegistry` into `ActiveReplyRegistry`.** Browser tasks have auto-supersede semantics (new task aborts previous) that are specific to browsing. Keep it as a domain-specific layer that also registers with the general registry.
- **Don't try to detect cancel from partial ASR transcripts.** The latency savings vs. false-positive risk isn't worth the complexity. Wait for finalized transcripts.

---

## Implementation Order

| Phase | Work | Files | Priority |
|-------|------|-------|----------|
| 1 | `cancelDetection.ts` + `activeReplyRegistry.ts` | New files | Critical |
| 2 | Wire text channel cancel -> `activeReplyRegistry.abortAll()` | `bot.ts` | Critical |
| 3 | Thread signal through text reply pipeline | `replyPipeline.ts` | Critical |
| 4 | Thread signal to all voice tool dispatches | `voiceToolCallDispatch.ts` | Critical |
| 5 | Add voice cancel detection in turn processor | `turnProcessor.ts` | Critical |
| 6 | Add `cancel()` + signal to `SubAgentSession` | `subAgentSession.ts` | Hardening |
| 7 | Abort cutoff for deferred/queued work | `activeReplyRegistry.ts`, `turnProcessor.ts`, `replyManager.ts` | Hardening |
| 8 | Orphan tool result synthesis (if needed by provider) | New utility or `voiceToolCallInfra.ts` | Hardening |

Phases 1-5 cover the critical path. Phases 6-8 are hardening.

---

## Key Files Reference

| File | Lines | Role |
|------|-------|------|
| `src/bot.ts` | 1022-1036 | Text "stop"/"cancel" keyword handler (expand) |
| `src/bot/replyPipeline.ts` | 697-867 | Text reply tool loop (add signal) |
| `src/voice/voiceToolCallInfra.ts` | 37-93 | Voice tool AbortController creation |
| `src/voice/voiceToolCallDispatch.ts` | 119-175 | Voice tool dispatch switch (thread signal to all) |
| `src/voice/turnProcessor.ts` | 613-616, 1362-1365 | Insertion points for voice cancel detection |
| `src/voice/replyManager.ts` | 588-601 | `clearPendingResponse` mass abort |
| `src/voice/voiceSessionManager.ts` | 1977-2025 | Barge-in response cancellation |
| `src/tools/browserTaskRuntime.ts` | 105-148 | `BrowserTaskRegistry` (reference pattern) |
| `src/agents/subAgentSession.ts` | 27-41 | `SubAgentSession` interface (add cancel) |
| `src/voice/voiceMusicDisambiguation.ts` | 233, 377 | Existing cancel keyword regex (reference pattern) |

---

## Phase 2: Hardening Gaps (Post-Initial Implementation)

The initial implementation (commit `6c0087c` on `codex/unified-tool-call-cancellation`) covers the infrastructure — `ActiveReplyRegistry`, `cancelDetection`, signal threading through all tools, voice cancel detection, and abort cutoffs. The following gaps remain and should be closed on the same branch before merge.

### Gap 1: Text pipeline cancel test (HIGH priority)

**Problem:** The highest-impact cancel flow — user types "stop" in text while a reply with tool calls is in-flight — has no test coverage.

**What to do:**

Create a test in `src/bot/replyPipeline.test.ts` (or `src/tools/activeReplyRegistry.test.ts` if a pipeline-level test is too heavy) that verifies:

1. `maybeReplyToMessagePipeline` registers an `ActiveReply` with `bot.activeReplies`
2. When `activeReplies.abortAll()` is called for that scope during execution, the pipeline catches the `AbortError` and returns `true` (reply handled, no message sent)
3. The `ActiveReply` is cleaned up in `finally` (no leak in the registry)

Approach: create a minimal mock of `ReplyPipelineRuntime` where `bot.llm.generate()` is a slow async function (e.g., waits on a promise). Start the pipeline, fire `abortAll` on the scope, and assert the pipeline resolves with `true` without calling `sendReplyMessage`.

**Files:** `src/bot/replyPipeline.test.ts` (new or existing)

### Gap 2: Voice cancel user feedback (HIGH priority)

**Problem:** When a user says "stop" in voice and tool calls are cancelled, there's no acknowledgment. In text they get "Cancelled." — in voice they get silence. The user has no idea the cancellation worked.

**What to do:**

In `turnProcessor.ts` > `cancelRealtimeSessionWork()`, after aborting pending tool calls and cancelling the active response, trigger a short model-generated acknowledgment. **Do not use hardcoded text** (per AGENTS.md: "User-visible bot speech/messages must be model-generated").

Two options (pick the simpler one that fits the existing voice reply patterns):

**Option A — Operational message:** Call `sendOperationalMessage` with a `voice_turn_cancel_acknowledged` kind. This puts a system message in chat but doesn't generate speech. Lightweight, but the user in voice won't hear anything.

**Option B — Inject a brief LLM turn (Recommended):** After cancelling, create a realtime response with a system instruction like `"The user just asked you to stop/cancel what you were doing. Acknowledge briefly."` This lets the bot say something natural like "okay" or "sure, cancelled." Use the existing `forwardRealtimeTextTurnToBrain` or `createTrackedAudioResponse` path. Keep it short — cap at a sentence.

**Files:** `src/voice/turnProcessor.ts` (modify `cancelRealtimeSessionWork`)

### Gap 3: AbortError distinction in voice tool output (MEDIUM priority)

**Problem:** In `voiceToolCallInfra.ts`, when a voice tool call is cancelled, the catch block stringifies the error as `{ ok: false, error: { message: "..." } }`. The realtime LLM sees a generic error and may attempt to retry the tool call.

**What to do:**

In the catch block of `executeOpenAiRealtimeFunctionCall` (~line 106), detect `isAbortError(error)` and return a cancellation-specific output:

```typescript
} catch (error) {
  if (isAbortError(error) || abortController.signal.aborted) {
    errorMessage = "cancelled_by_user";
    output = { ok: false, cancelled: true, error: { message: "Tool call cancelled by user." } };
  } else {
    errorMessage = String(error?.message || error);
    output = { ok: false, error: { message: errorMessage } };
  }
}
```

The `cancelled: true` field gives the LLM a clear signal not to retry. Also consider skipping the `sendFunctionCallOutput` entirely for cancelled calls if the realtime API supports it — but sending a clean cancellation result is safer than an orphaned tool_use.

**Files:** `src/voice/voiceToolCallInfra.ts`

### Gap 4: Comment on abort return value in reply pipeline (LOW priority)

**Problem:** `replyPipeline.ts` returns `true` on `AbortError` catch with no explanation. Future readers won't understand why a cancelled reply is treated as "handled."

**What to do:**

Add a comment in the catch block:

```typescript
} catch (error) {
  if (isAbortError(error) || signal.aborted) {
    // Return true ("reply handled") to prevent the caller from retrying
    // or attempting a fallback reply. The user explicitly cancelled.
    return true;
  }
  throw error;
}
```

**Files:** `src/bot/replyPipeline.ts`

### Gap 5: Remove `activeReplies` type cast in VSM constructor (LOW priority)

**Problem:** `voiceSessionManager.ts` line 578 has `this.activeReplies = activeReplies as ActiveReplyRegistry | null` — an unnecessary type assertion.

**What to do:**

Type the constructor parameter properly so the cast isn't needed. The constructor options object should declare `activeReplies?: ActiveReplyRegistry | null`.

**Files:** `src/voice/voiceSessionManager.ts`

---

### Hardening task summary

| # | Gap | Priority | Files | Estimated size |
|---|-----|----------|-------|----------------|
| 1 | Text pipeline cancel test | HIGH | `src/bot/replyPipeline.test.ts` | ~40-60 lines |
| 2 | Voice cancel user feedback | HIGH | `src/voice/turnProcessor.ts` | ~15-25 lines |
| 3 | AbortError distinction in voice tool output | MEDIUM | `src/voice/voiceToolCallInfra.ts` | ~10 lines |
| 4 | Comment on abort return value | LOW | `src/bot/replyPipeline.ts` | 3 lines |
| 5 | Remove type cast in VSM constructor | LOW | `src/voice/voiceSessionManager.ts` | ~5 lines |

Do all 5 in a single commit on the same branch. Run `bun run test` after to verify nothing breaks. Gaps 1-3 are the ones that matter — 4 and 5 are trivial cleanup.
