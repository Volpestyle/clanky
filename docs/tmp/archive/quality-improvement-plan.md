# Quality Improvement Plan

**Date:** March 6, 2026
**Baseline:** 769 tests, 0 `:any`, typecheck clean, 5 subsystem state machine docs written
**Focus:** Bug prevention through interaction tests, E2E coverage, and error handling fixes

This plan targets the gaps that actually cause production bugs — timing-sensitive cross-domain interactions, missing E2E scenarios, and silent error swallowing — rather than further code extraction.

---

## Priority 1: Fix Known Bugs (Quick Wins)

### 1A. Delete dead code — `voiceRuntimeState.ts`

`src/voice/voiceRuntimeState.ts` is dead code, superseded by `src/voice/voiceRuntimeSnapshot.ts`. It has no importers. Delete it.

Also the source of the `getDeferredQueuedUserTurns` / `getJoinGreetingOpportunity` LSP phantom errors — those errors go away with the file.

**Effort:** 5 minutes
**Files:** Delete `src/voice/voiceRuntimeState.ts`

### 1B. Fix fire-and-forget error swallowing (HIGH risk)

**`src/voice/voiceToolCallDispatch.ts:103`** — `.catch(() => {})` on `endSession()`. If this fails silently, the bot gets stuck in a voice channel permanently with no logs.

Fix: `.catch((err) => logger.error("endSession failed in scheduleLeaveVoiceChannel", { error: err }))` (or whatever the project's logging pattern is).

**Effort:** 10 minutes
**Files:** `src/voice/voiceToolCallDispatch.ts`

### 1C. Fix fire-and-forget error swallowing (MEDIUM risk)

3 instances:

| File | Line | Fix |
|---|---|---|
| `src/services/screenShareSessionManager.ts` | 399 | Log the error before coercing to `null` |
| `src/bot/conversationContinuity.ts` | 100 | Log memory retrieval failure before returning empty |
| `src/video/videoContextService.ts` | 773 | Log the error and don't permanently cache the failure result |

**Effort:** 20 minutes
**Files:** 3 files above

---

## Priority 2: Cross-Domain Interaction Tests

These test the timing-sensitive state reads identified in the subsystem docs. They are unit/integration tests (no Discord connection needed) but they validate the contracts between subsystems.

### 2A. Barge-in timing edge cases

Test the `shouldBargeIn` gate sequence under the exact conditions that cause production false-positives:

| Test Case | What It Validates |
|---|---|
| Pre-audio guard: user speaking while response pending but no audio delta yet | Barge-in should NOT fire — user can't interrupt what they haven't heard |
| Active flow guard: bot finished generating, subprocess draining buffered frames | Barge-in should NOT fire — response is effectively complete |
| Echo guard: bot audio started <1500ms ago | Barge-in should NOT fire — likely echo |
| Post-cancel race: `response_done` arrives between audio chunk and barge-in check | If cancel fails (response already done), should NOT queue retry or set full suppression |
| Assertiveness during bot speech: peak < 0.05 or active ratio < 0.06 | Barge-in should NOT fire — signal too weak to confirm intentional interruption |
| Interruption policy: `scope="speaker"` with non-matching userId | Barge-in should be blocked for non-speaker |

**Test file:** `src/voice/bargeInController.test.ts`
**Dependencies:** Mock `VoiceSession` with `assistantOutput`, `pendingResponse`, `botTurnOpen`, `botTurnOpenAt`, `bargeInSuppressionUntil`. Mock capture signal metrics.
**Effort:** 1-2 hours

### 2B. Deferred turn flush timing

Test the interaction between output lock release and deferred turn flushing:

| Test Case | What It Validates |
|---|---|
| Phase transitions to `idle` → deferred turns flush | The `syncAssistantOutputState` → `recheckDeferredVoiceActions` path works |
| Active promoted capture blocks deferred turn flush | `hasDeferredTurnBlockingActiveCapture` prevents reply during active speech |
| Silence-only capture does NOT block deferred flush | Weak captures that never promoted shouldn't hold up deferred turns |
| Deferred turn re-runs admission gate on flush | Coalesced turn is re-evaluated, not blindly dispatched |
| Deferred action expires before output frees | Stale actions are cleaned up, not fired |
| Queued turns flush once output is genuinely clear | Deferred actions only exist for queued user turns now |

**Test file:** `src/voice/deferredActionQueue.test.ts`
**Dependencies:** Mock `VoiceSession` with output state, capture state, deferred actions.
**Effort:** 1-2 hours

### 2C. ASR bridge commit race conditions

Test the shared ASR user lock and handoff logic:

| Test Case | What It Validates |
|---|---|
| Shared ASR user lock prevents concurrent access | Second user's `beginAsrUtterance` returns false while first user holds lock |
| Lock released after commit | `releaseSharedAsrActiveUser` unlocks, next user can proceed |
| Handoff replays buffered PCM | `tryHandoffSharedAsr` finds waiting promoted capture and flushes its audio |
| Circuit breaker after 3 empty commits | Forces close + reconnect |
| Audio buffer overflow drops oldest, not newest | 10s cap preserves recent audio |
| Commit during connecting phase buffers correctly | Audio queued as pending, flushed when ready |

**Test file:** `src/voice/voiceAsrBridge.test.ts`
**Dependencies:** Mock `OpenAiRealtimeTranscriptionClient`, mock `VoiceSession` with ASR state.
**Effort:** 1-2 hours

### 2D. Output state machine transition contracts

Test the `assistantOutput` phase transitions that drive the output lock:

| Test Case | What It Validates |
|---|---|
| `response_done` before subprocess drain keeps lock | Phase should be `speaking_buffered`, not `idle` |
| Stale positive clankvox telemetry expires | Buffer depth updates that stop arriving eventually release the lock |
| Stale OpenAI active response cleared | `isResponseInProgress()` returns true but pendingResponse is gone → phase returns to `idle` |
| Barge-in forces immediate `idle` | Both `speaking_live` and `speaking_buffered` → `idle` |
| Tool call lifecycle: `response_pending` → `awaiting_tool_outputs` → `response_pending` | Tool call doesn't lose the pending response |

**Test file:** `src/voice/assistantOutputState.test.ts` (extend existing)
**Dependencies:** Already has test infrastructure. Extend with new scenarios.
**Effort:** 1 hour

### 2E. Capture promotion contract tests

Test the two-phase capture lifecycle:

| Test Case | What It Validates |
|---|---|
| `server_vad_confirmed` requires matching utterance ID AND local thresholds | Server VAD alone doesn't promote — local signal must also pass |
| `strong_local_audio` promotes without server VAD | High-confidence local signal bypasses server VAD |
| Near-silence early abort at 1s | Captures with very weak signal abort early |
| Max duration timer forces finalize at 8s | Long captures don't run forever |
| `speakingEnd` → `speakingStart` within debounce continues same capture | Debounce prevents premature finalization |
| Promotion cancels pending system speech | Join greetings / thoughts cancelled when user starts speaking |

**Test file:** `src/voice/captureManager.test.ts`
**Dependencies:** Mock `VoiceSession`, mock clankvox events, mock ASR state.
**Effort:** 1-2 hours

---

## Priority 3: E2E Test Gaps

These require the bot-to-bot test infrastructure (DriverBot, test guild, separate bot tokens).

### 3A. Barge-in E2E test

The biggest E2E gap. No test currently validates the bot's behavior when a user interrupts mid-speech.

**Scenario:**
1. Driver summons bot, asks a question that produces a long response
2. While bot is speaking (wait for first audio bytes, then ~2s), driver plays a new audio fixture (interruption)
3. Assert: bot stops speaking within a reasonable window
4. Assert: bot processes the new input and responds to it

**Prerequisite:** Need a `DriverBot` helper that can play audio while capturing the bot's output simultaneously. Current `playAudio` is sequential. May need `playAudioNonBlocking()` or similar.

**Test file:** `tests/e2e/voiceBargeIn.test.ts`
**Effort:** 3-4 hours (including DriverBot helper extension)

### 3B. Supersede / rapid input E2E test

Test that newer input supersedes stale replies:

1. Driver plays two utterances in rapid succession (second starts before bot finishes responding to first)
2. Assert: bot's final response addresses the second utterance, not the first

This partially exists in `voicePhysicalHarness.test.ts` ("rapid sequential utterances") but doesn't validate response content, only that audio is received.

**Enhancement to:** `tests/e2e/voicePhysicalHarness.test.ts`
**Effort:** 1-2 hours

### 3C. Voice history API integration for test assertions

Current E2E tests only assert on audio byte counts (bot spoke / didn't speak). The dashboard exposes `/api/voice/history/sessions` and `/api/voice/history/sessions/:id/events` which could provide:

- Exact event sequence (turn received, reply sent, barge-in, tool call)
- Timing data
- Transcript content
- Distinction between TTS speech and music audio

**Task:** Build a `VoiceHistoryAssertionHelper` in `tests/e2e/driver/` that polls the voice history API and provides assertion methods like `assertEventSequence(["turn_received", "reply_started", "reply_completed"])`.

**Test file:** `tests/e2e/driver/voiceHistory.ts`
**Effort:** 2-3 hours

---

## Concurrency Plan

Priority 1 (quick fixes) should be done sequentially on master — they're small and touch different files.

Priority 2 (interaction tests) can run as **3 parallel worktrees**:

| Worktree | Tests | Files Owned |
|---|---|---|
| **W1** | 2A (barge-in) + 2D (output state) | `bargeInController.test.ts`, extend `assistantOutputState.test.ts` |
| **W2** | 2B (deferred flush) + 2E (capture promotion) | `deferredActionQueue.test.ts`, `captureManager.test.ts` |
| **W3** | 2C (ASR bridge) | `voiceAsrBridge.test.ts` |

All three create test files only — zero production code changes, zero conflicts.

Priority 3 (E2E tests) should be done after Priority 2 merges, since they require a running bot and test guild.

---

## Expected Outcome

| Metric | Current | After Plan |
|---|---|---|
| Tests | 769 | ~830-850 |
| Fire-and-forget (HIGH risk) | 1 | 0 |
| Fire-and-forget (MEDIUM risk) | 3 | 0 |
| Dead code files | 1 | 0 |
| Barge-in interaction tests | 0 | ~6 |
| Deferred action interaction tests | 0 | ~6 |
| ASR bridge interaction tests | 0 | ~6 |
| Capture promotion tests | 0 | ~6 |
| E2E barge-in coverage | none | 1 scenario |
| Cross-domain timing contracts tested | 0 | ~24 |
