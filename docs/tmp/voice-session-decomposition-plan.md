# Voice Session Manager Decomposition Plan

**Date:** March 6, 2026
**Target:** `src/voice/voiceSessionManager.ts` (12,819 lines)
**Goal:** Decompose the god-object into a thin orchestrator + domain modules with typed interfaces and an explicit state machine.

---

## Table of Contents

1. [Current State Summary](#1-current-state-summary)
2. [Target Architecture](#2-target-architecture)
3. [The Session State Contract](#3-the-session-state-contract)
4. [Cross-Cutting Dependency Graph](#4-cross-cutting-dependency-graph)
5. [Module Specifications](#5-module-specifications)
6. [The OutputChannel Abstraction](#6-the-outputchannel-abstraction)
7. [Phased Execution Plan](#7-phased-execution-plan)
8. [Risk Register](#8-risk-register)
9. [Verification Strategy](#9-verification-strategy)

---

## 1. Current State Summary

### What we're dealing with

| Metric | Value |
|--------|-------|
| File size | 12,819 lines |
| Mutable session properties | ~120 |
| Boolean state flags | 8 |
| Session-level timers | 16+ |
| Per-capture timers | 3 per user |
| Implicit high-level states | 10 |
| Compound gate conditions | 6 major gates (13–14 checks each) |
| External system dependencies | 6 (client, store, llm, memory, voxClient, realtimeClient) |

### Why it's hard

The session manager is a **flat state bag** — ~120 mutable properties on one object, with boolean flags encoding implicit states. Every subsystem reads state from every other subsystem:

- **Barge-in** reads: response/output, capture signals, music phase
- **Thought engine** reads: music, output lock, captures, turn processing, deferred actions, lookup busy, activity, participant count
- **Deferred actions** reads: captures, response, tool calls
- **Response/output** reads: music, captures, barge-in suppression, turn backlog, tool calls
- **Capture** reads: ASR config, barge-in eligibility, response state
- **Turn processing** reads: output lock, music, captures

The key coupling hub is `getReplyOutputLockState()` — consumed by 5 different subsystems. The second hub is `getDeferredOutputChannelBlockReason()` — consumed by 3 subsystems.

### What's already extracted (but not decoupled)

22 files already exist in `src/voice/` alongside the session manager. Most were mechanically extracted — the function bodies were moved but they still take `manager: any` and call back into the monolith. Key existing extractions:

| File | Lines | Decoupled? |
|------|-------|-----------|
| `voiceAsrBridge.ts` | 1,571 | Partially — owns ASR state, but calls `manager.queueRealtimeTurn` |
| `voiceMusicPlayback.ts` | 1,492 | Partially — owns music phase, but reads `session` directly |
| `voiceStreamWatch.ts` | 1,390 | Partially — owns stream watch state, but calls `manager.*` |
| `voiceToolCalls.ts` | 1,797 | Partially — handles tool execution, but mutates `session` |
| `voiceReplyDecision.ts` | 992 | Partially — LLM decision logic, reads `manager.getReplyOutputLockState` |
| `voiceJoinFlow.ts` | ~400 | Good — creates session, returns it |
| `assistantOutputState.ts` | ~200 | Good — pure phase reconciler, no session mutation |
| `voiceDecisionRuntime.ts` | ~200 | Good — pure decision runtime |
| `voiceSessionTypes.ts` | ~500 | Good — type definitions |
| `voiceRuntimeState.ts` | ~300 | Good — dashboard state snapshot |
| `voiceOperationalMessaging.ts` | ~300 | Good — text channel messaging |
| `systemSpeechOpportunity.ts` | ~200 | Good — join greeting evaluation |

---

## 2. Target Architecture

```
VoiceSessionOrchestrator
│
├── SessionLifecycle        (session creation, timers, ending, settings reconciliation)
├── CaptureManager          (per-user audio capture, promotion, finalization)
├── AsrBridge               (ASR routing, hallucination filtering, speaker handoff)
├── TurnProcessor           (realtime/STT turn queues, drain loops)
├── ReplyManager            (response tracking, output lock, bot turn lifecycle)
├── BargeInController       (barge-in eligibility, suppression, interrupt execution)
├── MusicManager            (playback phase machine, ducking, queue)
├── ThoughtEngine           (proactive thought loop, evaluation gate)
├── DeferredActionQueue     (deferred intent scheduling, recheck triggers)
├── GreetingManager         (join greeting lifecycle)
├── StreamWatchManager      (screen share monitoring, frame routing)
├── ToolCallManager         (realtime tool execution, debounce, followup)
└── InstructionManager      (realtime session instructions, refresh debounce)
```

### Design Principles

1. **Each module owns its state.** No module directly reads another module's internal properties. Cross-module queries go through typed accessor methods on the orchestrator or via a shared read-only state snapshot.

2. **The orchestrator routes events, not logic.** When a subprocess event arrives, the orchestrator calls the appropriate module method. When a module needs to trigger another module's behavior, it returns a **command** (or emits an event) rather than calling the other module directly.

3. **One typed session interface.** Replace the untyped property bag with a `VoiceSession` interface composed of per-module state slices.

4. **Boolean flags become phase enums.** Every implicit state machine becomes an explicit enum with a transition function.

5. **Guard conditions become query methods.** The compound gates (`shouldBargeIn`, `evaluateVoiceThoughtLoopGate`, etc.) become query methods on the orchestrator that compose per-module queries.

---

## 3. The Session State Contract

### Current: flat bag

```typescript
// Today — ~120 properties, all mutable, no structure
session.ending = true;
session.botTurnOpen = false;
session.bargeInSuppressionUntil = Date.now() + 500;
session.pendingResponse = null;
session.thoughtLoopBusy = false;
// ... 115 more
```

### Target: composed typed slices

```typescript
interface VoiceSession {
  // Identity (immutable after creation)
  readonly id: string;
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly requestedByUserId: string;
  readonly mode: VoiceMode;
  readonly startedAt: number;

  // Module-owned state slices
  lifecycle: SessionLifecycleState;
  capture: CaptureManagerState;
  asr: AsrBridgeState;
  turns: TurnProcessorState;
  reply: ReplyManagerState;
  bargeIn: BargeInState;
  music: MusicManagerState;
  thought: ThoughtEngineState;
  deferred: DeferredActionState;
  greeting: GreetingManagerState;
  streamWatch: StreamWatchState;
  tools: ToolCallManagerState;
  instructions: InstructionManagerState;
  context: ConversationContextState;

  // External handles (injected, not owned)
  readonly voxClient: ClankvoxClient;
  readonly realtimeClient: RealtimeClient;
}
```

Each state slice is a typed interface owned exclusively by its module. Only that module writes to it. Other modules read it through the orchestrator's query methods or through a read-only snapshot.

### Phase enums replacing booleans

```typescript
// SessionLifecycle
type SessionPhase = "initializing" | "active" | "ending";
// replaces: ending (boolean) + playbackArmed (boolean)

// ReplyManager
type BotTurnPhase = "idle" | "response_pending" | "speaking_live" | "speaking_buffered" | "awaiting_tool_outputs";
// replaces: botTurnOpen + assistantOutput.phase + awaitingToolOutputs
// NOTE: assistantOutputState.ts already models this — promote it to the canonical source

// TurnProcessor
type TurnDrainPhase = "idle" | "draining";
// replaces: realtimeTurnDrainActive (boolean), sttTurnDrainActive (boolean)

// ThoughtEngine
type ThoughtPhase = "idle" | "evaluating" | "generating" | "delivering";
// replaces: thoughtLoopBusy (boolean)

// CaptureManager (per-capture)
type CapturePhase = "pre_promotion" | "promoted" | "finalizing" | "resolved";
// replaces: promotedAt > 0, speakingEndFinalizeTimer !== null
```

---

## 4. Cross-Cutting Dependency Graph

This is the key constraint for decomposition. Each arrow means "reads state from":

```
                    ┌──────────────────┐
                    │  OutputChannel   │ ← the central query hub
                    │  (orchestrator)  │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                     │
        ▼                    ▼                     ▼
  ┌───────────┐      ┌─────────────┐      ┌──────────────┐
  │ BargeIn   │      │ ThoughtEng  │      │ DeferredQueue│
  │ Controller│      │             │      │              │
  └─────┬─────┘      └──────┬──────┘      └──────┬───────┘
        │                    │                     │
  reads from:          reads from:           reads from:
  - ReplyManager       - MusicManager        - CaptureManager
  - CaptureManager     - ReplyManager        - ReplyManager
  - MusicManager       - CaptureManager      - ToolCallManager
                       - TurnProcessor
                       - DeferredQueue
                       - Activity
```

### The OutputChannel Abstraction

The recurring pattern is: "can I produce output right now?" Almost every subsystem needs to answer this question. Today it's spread across `getReplyOutputLockState`, `getDeferredOutputChannelBlockReason`, and `syncAssistantOutputState`.

**Proposal:** Unify these into a single `OutputChannel` query on the orchestrator:

```typescript
interface OutputChannelState {
  phase: BotTurnPhase;        // from ReplyManager
  locked: boolean;            // derived
  lockReason: string | null;  // human-readable
  musicActive: boolean;       // from MusicManager
  captureBlocking: boolean;   // from CaptureManager
  bargeInSuppressed: boolean; // from BargeInController
  turnBacklog: number;        // from TurnProcessor
  toolCallsRunning: boolean;  // from ToolCallManager
}
```

Every module that needs "can I output?" queries `orchestrator.getOutputChannelState()` instead of reaching into other modules' internals.

---

## 5. Module Specifications

### 5.1 SessionLifecycle

**Owns:** `SessionLifecycleState { phase, maxTimer, maxEndsAt, inactivityTimer, inactivityEndsAt, botDisconnectTimer, settingsSnapshot, cleanupHandlers }`

**Responsibilities:**
- Session creation (delegates to `voiceJoinFlow.ts` — already extracted)
- Max duration timer
- Inactivity timer + `touchActivity()`
- Settings reconciliation
- `endSession()` orchestration (tells each module to clean up)
- Voice state update handling (user join/leave/move)

**Reads from others:** None for its core logic. `touchActivity` is called by other modules but that's an inbound write, not a cross-read.

**Events emitted:**
- `session:ending` — all modules clean up
- `session:activity_touched` — thought engine reschedules
- `session:settings_reconciled` — modules refresh config

**Lines moved from VSM:** ~300 (timers, touchActivity, reconcileSettings, endSession cleanup coordination)

---

### 5.2 CaptureManager

**Owns:** `CaptureManagerState { userCaptures: Map<string, CaptureState>, lastInboundAudioAt }`

Where `CaptureState` replaces the current untyped capture object:
```typescript
interface CaptureState {
  userId: string;
  phase: CapturePhase;
  startedAt: number;
  promotedAt: number;
  promotionReason: string | null;
  asrUtteranceId: string | null;
  signal: AudioSignalMetrics;
  pcmChunks: Buffer[];
  bytesSent: number;
  sharedAsrBytesSent: number;
  timers: { idle: Timer | null; max: Timer | null; speakingEndFinalize: Timer | null };
}
```

**Responsibilities:**
- `beginCapture(userId)` — create capture state, start timers, subscribe subprocess audio
- Audio signal analysis (RMS, peak, active sample counting)
- Capture promotion decision (`resolveCaptureTurnPromotionReason`)
- Capture finalization (aggregate PCM, determine reason, clean up)
- `hasBlockingActiveCapture()` — query for other modules

**Reads from others:**
- ASR config (from orchestrator — which ASR mode is active)

**Events emitted:**
- `capture:promoted { userId }` — triggers activity touch, cancels pending system speech
- `capture:finalized { userId, pcmBuffer, reason }` — triggers turn queuing or deferred action recheck
- `capture:audio { userId, pcmChunk }` — forwarded to ASR bridge and barge-in evaluation

**Lines moved from VSM:** ~600 (`startInboundCapture` closure body, signal analysis helpers, promotion logic)

---

### 5.3 AsrBridge

**Status:** Already partially extracted as `voiceAsrBridge.ts` (1,571 lines).

**Remaining work:**
- Type the `manager` parameter (currently `any`)
- Replace `manager.queueRealtimeTurn(...)` callbacks with returned commands or events
- Replace `manager.store.logAction(...)` with an injected logger interface

**Interface change:**
```typescript
// Before
asrBridge.onTranscript = (text) => manager.queueRealtimeTurn(session, { transcript: text });

// After
asrBridge.onTranscript = (text) => orchestrator.handleAsrTranscript(sessionId, { transcript: text });
```

**Lines moved from VSM:** ~200 (ASR session setup, config reads, empty transcript streak tracking)

---

### 5.4 TurnProcessor

**Owns:** `TurnProcessorState { realtimeQueue: QueuedTurn[], realtimeDrainPhase: TurnDrainPhase, sttQueue: QueuedTurn[], sttDrainPhase: TurnDrainPhase, pendingInputBytes: number, coalesceTimer }`

**Responsibilities:**
- `queueRealtimeTurn(turn)` — enqueue or merge into pending
- `drainRealtimeTurnQueue()` — process queued turns sequentially
- `queueSttPipelineTurn(turn)` — enqueue STT turn
- `drainSttPipelineTurnQueue()` — process STT turns
- Coalesce window management
- `getBacklogSize()` — query for other modules

**Reads from others:**
- OutputChannel state (to check if output is locked before processing a turn)
- MusicManager (to intercept music commands)

**Events emitted:**
- `turn:processed { decision, userId }` — result of turn processing
- `turn:deferred { userId, reason }` — turn was deferred (bot_turn_open, etc.)

**Lines moved from VSM:** ~800 (queueRealtimeTurn, drainRealtimeTurnQueue, runRealtimeTurn, queueSttPipelineTurn, drainSttPipelineTurnQueue, handleSttPipelineTurn, flushDeferredBotTurnOpenTurns, appendAudioToRealtimeInput, flushResponseFromBufferedAudio, createTrackedAudioResponse)

---

### 5.5 ReplyManager

**Owns:** `ReplyManagerState { botTurnPhase: BotTurnPhase, botTurnOpenAt: number, lastAssistantReplyAt: number, lastAudioDeltaAt: number, pendingResponse: TrackedResponse | null, nextResponseRequestId: number, lastResponseRequestAt: number, activeReplyInterruptionPolicy, responseTimers: { flush, watchdog, doneGrace, botTurnReset } }`

**Responsibilities:**
- `markBotTurnOut()` — transition to speaking
- `clearPendingResponse()` — transition back to idle
- `createTrackedAudioResponse()` — transition to response_pending
- `handleResponseDone()` — handle response completion (with/without audio, with/without tool calls)
- `handleSilentResponse()` — retry/recovery for stalled responses
- `syncOutputPhase()` — the canonical phase reconciler (promotes `assistantOutputState.ts` logic)
- `getOutputLockState()` — the primary query consumed by other modules
- `resetBotAudioPlayback()` — clear playback buffers

**Reads from others:**
- MusicManager (`musicPhaseShouldLockOutput`)
- ToolCallManager (`awaitingToolOutputs`, `executionsInFlight`)
- CaptureManager (`hasBlockingActiveCapture`) — in flush gating
- BargeInController (`isBargeInSuppressed`) — in flush gating
- TurnProcessor (`getBacklogSize`) — in flush gating

**Events emitted:**
- `reply:idle` — output channel is clear (triggers deferred action recheck, greeting recheck)
- `reply:audio_started` — first audio delta (triggers music duck)
- `reply:completed` — response fully delivered

**Lines moved from VSM:** ~600 (markBotTurnOut, clearPendingResponse, createTrackedAudioResponse, handleResponseDone, handleSilentResponse, syncAssistantOutputState delegation, getReplyOutputLockState, resetBotAudioPlayback)

---

### 5.6 BargeInController

**Owns:** `BargeInState { suppressionUntil: number, suppressedChunks: number, suppressedBytes: number }`

**Responsibilities:**
- `shouldBargeIn(userId, captureState)` — the 13-condition compound gate
- `interruptForBargeIn(userId)` — execute the interrupt
- `isBargeInSuppressed()` — query for other modules
- `setSuppression(durationMs)` — set suppression window

**Reads from others:**
- ReplyManager (`getOutputLockState`, `botTurnPhase`, `pendingResponse`, `lastAudioDeltaAt`)
- CaptureManager (capture signal metrics)
- MusicManager (via output lock)

**Cross-cutting writes (the hard part):**
Today `interruptBotSpeechForBargeIn` directly mutates:
- ReplyManager state: `botTurnOpen = false`, `botTurnOpenAt = 0`, `lastAudioDeltaAt`, `pendingResponse.audioReceivedAt`
- MusicManager: `releaseBotSpeechMusicDuck`
- DeferredActionQueue: `setDeferredVoiceAction("interrupted_reply")`

**Solution:** `interruptForBargeIn()` returns a `BargeInInterruptCommand`:
```typescript
interface BargeInInterruptCommand {
  cancelActiveResponse: boolean;
  truncateItemId: string | null;
  resetBotTurn: boolean;
  releaseMusicDuck: boolean;
  deferInterruptedReply: { userId: string; utteranceText: string } | null;
  suppressionMs: number;
}
```
The orchestrator executes the command by calling each module's appropriate method. This breaks the direct cross-module mutation.

**Lines moved from VSM:** ~300 (shouldBargeIn, isBargeInInterruptTargetActive, isBargeInOutputSuppressed, interruptBotSpeechForBargeIn, isCaptureSignalAssertive, isCaptureSignalAssertiveDuringBotSpeech, isUserAllowedToInterruptReply)

---

### 5.7 MusicManager

**Status:** Already partially extracted as `voiceMusicPlayback.ts` (1,492 lines) + `musicPlayback.ts` + `musicPlayer.ts` + `musicCommands.ts` + `musicSearch.ts`.

**Owns:** `MusicManagerState { phase: MusicPhase, queue: MusicQueueState, ducked: boolean, duckTimer: Timer | null, wakeLatch: { until: number, userId: string | null } }`

**Remaining work:**
- Consolidate `botSpeechMusicDucked` and `botSpeechMusicUnduckTimer` (currently ad-hoc properties on session) into the music state
- Type the `manager` parameter in `voiceMusicPlayback.ts`
- Move duck/unduck logic into this module
- `musicPhaseShouldLockOutput()` becomes a method on MusicManager

**Reads from others:**
- ReplyManager (`hasBufferedTtsPlayback`, `botTurnOpen`) — only for unduck delay decision

**Lines moved from VSM:** ~150 (engageBotSpeechMusicDuck, releaseBotSpeechMusicDuck, scheduleBotSpeechMusicUnduck, isCommandOnlyActive)

---

### 5.8 ThoughtEngine

**Owns:** `ThoughtEngineState { phase: ThoughtPhase, timer: Timer | null, nextAt: number, lastAttemptAt: number, lastSpokenAt: number }`

**Responsibilities:**
- `schedule()` — set timer for next evaluation
- `evaluateGate()` — the 14-condition compound gate
- `run()` — generate thought candidate, evaluate, deliver

**Reads from others:**
- OutputChannel state (locked?)
- MusicManager (active?)
- CaptureManager (blocking capture?)
- TurnProcessor (backlog?)
- DeferredActionQueue (pending turns?)
- SessionLifecycle (activity timestamps, participant count)

**Events emitted:**
- `thought:delivered { text }` — thought was spoken

**Lines moved from VSM:** ~400 (scheduleVoiceThoughtLoop, evaluateVoiceThoughtLoopGate, maybeRunVoiceThoughtLoop, runVoiceThoughtLoopAttempt, evaluateThoughtCandidate, deliverThoughtUtterance)

---

### 5.9 DeferredActionQueue

**Owns:** `DeferredActionState { actions: Record<string, DeferredAction>, timers: Record<string, Timer> }`

**Responsibilities:**
- `setAction(action)` — register a deferred action
- `clearAction(type)` / `clearAll()` — remove actions
- `recheck(reason)` — evaluate all pending actions against gates
- `canFire(action)` — check if an action's preconditions are met
- `getQueuedUserTurns()` — query for other modules

**Reads from others:**
- OutputChannel state (via `getDeferredOutputChannelBlockReason`)
- CaptureManager, ReplyManager, ToolCallManager (indirectly through OutputChannel)

**Events emitted:**
- `deferred:fire { action }` — action is ready to execute

**Lines moved from VSM:** ~250 (setDeferredVoiceAction, clearDeferredVoiceAction, clearAllDeferredVoiceActions, recheckDeferredVoiceActions, canFireDeferredAction, getDeferredOutputChannelBlockReason, getDeferredQueuedUserTurns, fireDeferredQueuedUserTurns, scheduleDeferredVoiceActionRecheck)

---

### 5.10 GreetingManager

**Owns:** `GreetingManagerState { opportunity: JoinGreetingOpportunity | null, timer: Timer | null }`

**Responsibilities:**
- `scheduleOpportunity(params)` — arm the greeting
- `canFire()` — check all preconditions
- `fire()` — deliver the greeting
- `clear()` — cancel

**Reads from others:**
- OutputChannel state
- SessionLifecycle (`playbackArmed`, `lastAssistantReplyAt`)
- InstructionManager (`lastInstructions` — must be non-empty)

**Lines moved from VSM:** ~100 (scheduleJoinGreetingOpportunity, canFireJoinGreetingOpportunity, maybeFireJoinGreetingOpportunity, clearJoinGreetingOpportunity)

---

### 5.11 ToolCallManager

**Owns:** `ToolCallManagerState { pendingCalls, executions: Map, completedIds: Set, definitions, lastHash, lastRefreshAt, lastCallerUserId, debounceTimer, awaitingOutputs: boolean }`

**Status:** Already partially extracted as `voiceToolCalls.ts` (1,797 lines).

**Remaining work:**
- Move `awaitingToolOutputs` flag and `openAiToolResponseDebounceTimer` from session into this module
- Type the `manager` parameter
- `handleFunctionCallEvent()` returns a command instead of directly setting `session.awaitingToolOutputs = true`

**Reads from others:** Minimal — mostly self-contained once `awaitingToolOutputs` is owned here.

**Lines moved from VSM:** ~100 (awaitingToolOutputs management, debounce timer, tool hash tracking)

---

### 5.12 InstructionManager

**Owns:** `InstructionManagerState { baseInstructions: string, lastSentInstructions: string, lastSentAt: number, refreshTimer: Timer | null }`

**Responsibilities:**
- Build realtime instructions from settings, context, memory, tools
- Debounced refresh
- `hasInstructions()` — query for greeting manager

**Lines moved from VSM:** ~200 (instruction building, refresh scheduling, the queueRealtimeTurnContextRefresh path)

---

### 5.13 StreamWatchManager

**Status:** Already extracted as `voiceStreamWatch.ts` (1,390 lines).

**Remaining work:**
- Type the `manager` parameter
- Own its state slice instead of reading `session.streamWatch` directly

---

## 6. The OutputChannel Abstraction

This is the architectural keystone. Today, 5 subsystems independently drill into each other's state to answer "can I produce output?" The OutputChannel unifies this:

```typescript
// On the orchestrator
getOutputChannelState(session: VoiceSession): OutputChannelState {
  const replyLock = this.replyManager.getOutputLockState(session.reply);
  return {
    phase: session.reply.botTurnPhase,
    locked: replyLock.locked || this.musicManager.shouldLockOutput(session.music),
    lockReason: replyLock.reason,
    musicActive: this.musicManager.isActive(session.music),
    captureBlocking: this.captureManager.hasBlockingCapture(session.capture),
    bargeInSuppressed: this.bargeInController.isSuppressed(session.bargeIn),
    turnBacklog: this.turnProcessor.getBacklogSize(session.turns),
    toolCallsRunning: this.toolCallManager.hasExecutionsInFlight(session.tools),
  };
}
```

Every consumer calls `orchestrator.getOutputChannelState()` instead of reaching into 5 different state bags. This is the **single most important abstraction** in the decomposition.

---

## 7. Phased Execution Plan

### Ordering Constraints

- **Phase 0 must come first** — typed session interface is prerequisite for everything else
- **ReplyManager before BargeInController** — barge-in reads reply state, so reply must stabilize first
- **CaptureManager before TurnProcessor** — captures produce turns
- **MusicManager can be done independently** — mostly self-contained
- **DeferredActionQueue and GreetingManager depend on OutputChannel** — do after ReplyManager
- **ThoughtEngine depends on almost everything** — do last

### Phase 0: Foundation (prerequisite for all phases)

**Goal:** Type the session interface, introduce the OutputChannel query, keep all 657 tests passing.

**Steps:**
1. Define `VoiceSession` interface in `voiceSessionTypes.ts` with all current properties, grouped into module-aligned sub-interfaces. This is a **type-only change** — the runtime code stays the same.
2. Add `OutputChannelState` type and implement `getOutputChannelState()` as a method on the session manager that calls the existing `getReplyOutputLockState()` + `getDeferredOutputChannelBlockReason()` internally.
3. Replace the 5 direct callers of `getReplyOutputLockState()` with `getOutputChannelState()`.
4. Type the `session` parameter in all existing extracted modules (replace `any` with the new interface).

**Files changed:** `voiceSessionTypes.ts`, `voiceSessionManager.ts` (method additions), all `src/voice/*.ts` files (parameter types).
**Lines added:** ~200 (types + OutputChannel method)
**Lines removed:** 0
**Risk:** Low — additive, no behavior change.
**Verification:** All 657 tests pass. `bun run typecheck` passes.

---

### Phase 1: ReplyManager extraction

**Goal:** Extract bot turn lifecycle, response tracking, and output lock into `src/voice/replyManager.ts`.

**Steps:**
1. Create `ReplyManagerState` interface and `ReplyManager` class.
2. Move these methods from VSM to ReplyManager:
   - `markBotTurnOut` (~60 lines)
   - `clearPendingResponse` (~25 lines)
   - `createTrackedAudioResponse` (~100 lines)
   - `handleResponseDone` logic (~60 lines)
   - `handleSilentResponse` (~100 lines)
   - `syncAssistantOutputState` delegation (~60 lines)
   - `getReplyOutputLockState` (~40 lines)
   - `resetBotAudioPlayback` (~20 lines)
   - Response timer management (~50 lines)
3. VSM keeps thin delegation methods that call `this.replyManager.*`.
4. Wire `reply:idle` event to trigger deferred action recheck and greeting recheck (replacing the direct calls from `clearPendingResponse`).

**Files created:** `src/voice/replyManager.ts` (~500 lines)
**Files changed:** `voiceSessionManager.ts` (-500 lines, replaced with delegations)
**Risk:** Medium — ReplyManager is the most-read module. Every test that checks output behavior exercises this path.
**Verification:** All lifecycle + addressing tests pass. Manual smoke: bot responds to voice turns, barge-in still works, music ducking works.

---

### Phase 2: BargeInController extraction

**Goal:** Extract barge-in eligibility and interrupt execution into `src/voice/bargeInController.ts`.

**Steps:**
1. Create `BargeInState` interface and `BargeInController` class.
2. Move these methods:
   - `shouldBargeIn` (~60 lines)
   - `isBargeInInterruptTargetActive` (~15 lines)
   - `isBargeInOutputSuppressed` (~10 lines)
   - `interruptBotSpeechForBargeIn` → refactor to return `BargeInInterruptCommand` (~100 lines)
   - Signal analysis helpers (~50 lines)
3. Orchestrator executes the command by calling ReplyManager, MusicManager, DeferredActionQueue.
4. Wire `capture:audio` event to call `bargeInController.evaluate()`.

**Files created:** `src/voice/bargeInController.ts` (~300 lines)
**Files changed:** `voiceSessionManager.ts` (-300 lines)
**Depends on:** Phase 1 (reads ReplyManager state)
**Risk:** Medium-high — barge-in timing is latency-sensitive. The command pattern adds one extra function call in the hot audio path.
**Verification:** Lifecycle tests (barge-in byte threshold tests, echo guard tests). E2E voice test if available.

---

### Phase 3: CaptureManager extraction

**Goal:** Extract per-user audio capture lifecycle into `src/voice/captureManager.ts`.

**Steps:**
1. Create `CaptureState` interface (typed, replacing the untyped capture bag) and `CaptureManager` class.
2. Move the `startInboundCapture` closure body (~680 lines) into CaptureManager methods:
   - `beginCapture(userId)` — setup, timer creation, subprocess subscription
   - `onAudio(userId, pcmChunk)` — signal analysis, ASR forwarding, barge-in delegation
   - `promoteCapture(userId)` — promotion decision
   - `finalizeCapture(userId)` — PCM aggregation, turn queuing delegation
3. CaptureManager emits `capture:finalized` which the orchestrator routes to TurnProcessor.
4. CaptureManager calls `orchestrator.evaluateBargeIn()` instead of `shouldBargeIn` directly.

**Files created:** `src/voice/captureManager.ts` (~700 lines)
**Files changed:** `voiceSessionManager.ts` (-700 lines)
**Depends on:** Phase 2 (barge-in delegation)
**Risk:** High — the `startInboundCapture` closure is deeply nested with 3 inner closures capturing shared mutable state. Untangling the closure scope is the hardest part of the entire decomposition.
**Verification:** Lifecycle tests (capture promotion, empty capture, shared ASR handoff). Addressing tests.

---

### Phase 4: MusicManager consolidation

**Goal:** Consolidate all music state (including duck/unduck) into the existing `voiceMusicPlayback.ts`.

**Steps:**
1. Move `botSpeechMusicDucked`, `botSpeechMusicUnduckTimer` from ad-hoc session properties into `MusicManagerState`.
2. Move `engageBotSpeechMusicDuck`, `releaseBotSpeechMusicDuck`, `scheduleBotSpeechMusicUnduck` into the music module.
3. Move `isCommandOnlyActive` into the music module.
4. Type the `manager` parameter in `voiceMusicPlayback.ts`.
5. Wire `reply:audio_started` event to trigger duck, `reply:completed`/`reply:idle` to trigger unduck scheduling.

**Files changed:** `voiceMusicPlayback.ts` (+150 lines), `voiceSessionManager.ts` (-150 lines)
**Depends on:** Phase 1 (ReplyManager events)
**Risk:** Low-medium — music is relatively self-contained.
**Verification:** Lifecycle tests (music ducking). Manual smoke: play music, bot speaks over it, music ducks and unducks correctly.

---

### Phase 5: TurnProcessor extraction

**Goal:** Extract turn queuing and drain loops into `src/voice/turnProcessor.ts`.

**Steps:**
1. Create `TurnProcessorState` interface and `TurnProcessor` class.
2. Move:
   - `queueRealtimeTurn` (~50 lines)
   - `drainRealtimeTurnQueue` (~30 lines)
   - `runRealtimeTurn` (large — ~400 lines, but much of this is voice reply decision logic already in `voiceReplyDecision.ts`)
   - `queueSttPipelineTurn` (~30 lines)
   - `drainSttPipelineTurnQueue` (~30 lines)
   - `handleSttPipelineTurn` (~200 lines)
   - Coalesce timer management
   - Audio buffer management (`appendAudioToRealtimeInput`, `flushResponseFromBufferedAudio`, `createTrackedAudioResponse`)
3. TurnProcessor calls `orchestrator.getOutputChannelState()` instead of reading session state directly.

**Files created:** `src/voice/turnProcessor.ts` (~800 lines)
**Files changed:** `voiceSessionManager.ts` (-800 lines)
**Depends on:** Phase 1 (OutputChannel), Phase 3 (CaptureManager emits finalized turns)
**Risk:** Medium — turn processing is the main happy path. Any regression here breaks voice responses entirely.
**Verification:** All lifecycle tests. E2E voice tests.

---

### Phase 6: DeferredActionQueue + GreetingManager + ThoughtEngine extraction

**Goal:** Extract the remaining smaller subsystems.

**Steps:**
1. Extract `DeferredActionQueue` (~250 lines) — straightforward, mostly self-contained.
2. Extract `GreetingManager` (~100 lines) — depends on OutputChannel + session lifecycle.
3. Extract `ThoughtEngine` (~400 lines) — depends on OutputChannel + every other module for its gate, but it's read-only against them.
4. Extract `InstructionManager` (~200 lines) — instruction building and refresh debounce.
5. Type the `manager` parameter in `voiceStreamWatch.ts` and `voiceToolCalls.ts`.

**Files created:** `src/voice/deferredActionQueue.ts`, `src/voice/greetingManager.ts`, `src/voice/thoughtEngine.ts`, `src/voice/instructionManager.ts`
**Files changed:** `voiceSessionManager.ts` (-950 lines), `voiceStreamWatch.ts`, `voiceToolCalls.ts` (type fixes)
**Depends on:** Phase 5 (all prior modules extracted)
**Risk:** Low — these are the least coupled subsystems.
**Verification:** All existing tests.

---

### Phase 7: Clean up the orchestrator

**Goal:** VSM becomes a thin orchestrator that creates modules, routes events, and composes queries.

**Steps:**
1. Remove all delegation stubs — methods that just forward to module methods.
2. Replace event-handler closures with orchestrator routing: `voxClient.on("speakingStart", (userId) => this.captureManager.beginCapture(session, userId))`.
3. Move remaining event binding (`bindRealtimeHandlers`, `bindVoxHandlers`, `bindSessionHandlers`) into the orchestrator's `setupSession()` method.
4. Final session cleanup: `endSession()` calls `module.cleanup()` on each module.
5. Verify the orchestrator is under 2,000 lines.

**Target line counts:**

| File | Lines |
|------|-------|
| `voiceSessionOrchestrator.ts` (was `voiceSessionManager.ts`) | ~1,500–2,000 |
| `replyManager.ts` | ~500 |
| `bargeInController.ts` | ~300 |
| `captureManager.ts` | ~700 |
| `turnProcessor.ts` | ~800 |
| `voiceMusicPlayback.ts` (consolidated) | ~1,700 |
| `thoughtEngine.ts` | ~400 |
| `deferredActionQueue.ts` | ~250 |
| `greetingManager.ts` | ~100 |
| `instructionManager.ts` | ~200 |
| `voiceToolCalls.ts` (typed) | ~1,800 |
| `voiceStreamWatch.ts` (typed) | ~1,400 |
| `voiceAsrBridge.ts` (typed) | ~1,600 |
| Other existing files | ~3,500 |
| **Total** | ~14,750 |

The total line count increases slightly (from 12,819 to ~14,750) because of interface definitions, module boilerplate, and the orchestrator routing layer. But no single file exceeds 2,000 lines, and every module is independently testable.

---

## 8. Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Barge-in latency regression** from command pattern indirection | High | Benchmark audio-to-interrupt latency before and after Phase 2. The command pattern adds one object allocation + one switch dispatch — should be sub-microsecond. |
| **Closure scope untangling in CaptureManager** (Phase 3) | High | This is the single hardest extraction. The `startInboundCapture` closure captures `session`, `settings`, `userId`, and 5 inner functions that share mutable `captureState`. Extract one inner function at a time, running tests between each. |
| **Race conditions from event-based coordination** replacing direct calls | Medium | All coordination is single-threaded (Node event loop). Events are synchronous `EventEmitter.emit()` calls, not async. The ordering guarantees are identical to direct function calls. |
| **Test breakage cascade** from changing internal method signatures | Medium | Each phase keeps VSM delegation stubs that call the new module. Old test code that mocks VSM methods continues to work. Remove stubs only in Phase 7. |
| **Module boundary leaks** — modules that need "just one more" cross-read | Medium | The OutputChannel abstraction exists specifically to prevent this. If a module needs state that isn't in OutputChannel, add it to OutputChannel rather than adding a direct dependency. |
| **Merge conflicts** with concurrent feature work | Medium | Do one phase per branch, merge to master between phases. Don't batch. |

---

## 9. Verification Strategy

### Per-Phase

Every phase must pass before merging:

1. `bun run test` — all 657+ tests pass
2. `bun run typecheck` — no type errors
3. `bun run lint` — no lint errors
4. Manual smoke test: join voice channel, have a conversation, play music, barge-in, leave

### Phase-Specific Tests to Watch

| Phase | Critical Test Files |
|-------|-------------------|
| 0 (Foundation) | `bun run typecheck` is the main gate |
| 1 (ReplyManager) | `voiceSessionManager.lifecycle.test.ts` (response tracking, bot turn reset) |
| 2 (BargeInController) | `voiceSessionManager.lifecycle.test.ts` (barge-in byte thresholds, echo guard, suppression) |
| 3 (CaptureManager) | `voiceSessionManager.lifecycle.test.ts` (capture promotion, empty capture, signal analysis), `voiceSessionManager.addressing.test.ts` |
| 4 (MusicManager) | `voiceSessionManager.lifecycle.test.ts` (music ducking, wake word latch) |
| 5 (TurnProcessor) | `voiceSessionManager.lifecycle.test.ts` (turn queue, coalesce), `voiceReplyDecision.test.ts` |
| 6 (Remaining) | `voiceSessionManager.lifecycle.test.ts` (deferred actions, thought loop), `systemSpeechOpportunity.test.ts` |
| 7 (Cleanup) | All of the above + `voiceSessionManager.silenceWatchdog.test.ts` |

### New Tests to Add

As each module is extracted, add **module-level unit tests** that test the module in isolation (without the full orchestrator). These should be simpler and faster than the current lifecycle tests because they don't need to set up the entire session:

- `replyManager.test.ts` — phase transitions, output lock computation
- `bargeInController.test.ts` — eligibility gate with mock OutputChannel
- `captureManager.test.ts` — promotion logic, signal thresholds
- `turnProcessor.test.ts` — queue/drain lifecycle, coalesce behavior
- `deferredActionQueue.test.ts` — action scheduling, gate evaluation
- `thoughtEngine.test.ts` — 14-condition gate with mock inputs

---

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| 0 — Foundation | 1 session | Type-only, low risk |
| 1 — ReplyManager | 1–2 sessions | Core abstraction, sets the pattern |
| 2 — BargeInController | 1 session | Command pattern design is the hard part |
| 3 — CaptureManager | 2–3 sessions | Closure untangling is genuinely hard |
| 4 — MusicManager | 1 session | Mostly consolidation of existing code |
| 5 — TurnProcessor | 2 sessions | Large, touches the happy path |
| 6 — Remaining modules | 1–2 sessions | Four small extractions |
| 7 — Orchestrator cleanup | 1 session | Delete delegation stubs, final wiring |
| **Total** | **10–14 focused sessions** | |

"Session" = a focused work block (2–4 hours). At your current pace that's 3–5 days if you go heads-down on it.
