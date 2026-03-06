# Round 4 Plans

**Date:** March 6, 2026
**Baseline:** 704 tests, 0 `as any`, typecheck clean
**Target:** VSM under 5,500 lines, bot.ts under 1,700 lines, 0 `:any` in store submodules

Four concurrent worktrees. File ownership boundaries enforced strictly.

---

## Plan A: VSM Module Extraction (voice-only)

**Goal:** Extract 6-8 self-contained modules from voiceSessionManager.ts. Target: -2,000 lines (7,618 → ~5,500).

### Extraction targets (in execution order):

#### 1. `src/voice/voiceRuntimeSnapshot.ts` (~461 lines)
Extract `getRuntimeState()` — the massive dashboard state builder.
- This is a pure read of session state. Zero mutations.
- Takes the session + dependencies, returns a serializable snapshot object.
- Define a `buildVoiceRuntimeSnapshot(session, deps)` free function.
- The VSM method becomes a 3-line delegation stub.

#### 2. `src/voice/voiceThoughtGeneration.ts` (~380 lines)
Extract the thought engine residuals that should have been in `ThoughtEngine`:
- `generateVoiceThoughtCandidate` (73 lines)
- `loadVoiceThoughtMemoryFacts` (59 lines)
- `evaluateVoiceThoughtDecision` (176 lines)
- `deliverVoiceThoughtCandidate` (62 lines)
- `resolveVoiceThoughtEngineConfig` (31 lines) — config resolver, pure function of settings

Define a `VoiceThoughtGenerationHost` interface for the dependencies these functions need (llm, memory, session state, realtime utterance, TTS). The existing `ThoughtEngine` class handles scheduling/timing — these new functions handle the actual generation/evaluation/delivery. Keep them separate or merge into ThoughtEngine at your discretion, but prefer standalone functions with DI over stuffing them into the class.

#### 3. `src/voice/voiceAddressing.ts` (~210 lines)
Extract the voice addressing functions:
- `normalizeVoiceAddressingAnnotation` (44 lines)
- `mergeVoiceAddressingAnnotation` (29 lines)
- `findLatestVoiceTurnIndex` (20 lines)
- `annotateLatestVoiceTurnAddressing` (46 lines)
- `buildVoiceAddressingState` (68 lines)

These are ALL pure functions of turn arrays and addressing objects. Zero session mutation, zero side effects. Trivial extraction — just move and update imports.

#### 4. `src/voice/voiceSoundboard.ts` (~210 lines)
Extract the soundboard coordination:
- `maybeTriggerAssistantDirectedSoundboard` (107 lines)
- `resolveSoundboardCandidates` (24 lines)
- `fetchGuildSoundboardCandidates` (67 lines)
- `normalizeSoundboardRefs` (9 lines)

Define a `VoiceSoundboardHost` interface for Discord client access and soundboard director. Cache the guild candidates in the session state.

#### 5. `src/voice/voiceConfigResolver.ts` (~170 lines)
Extract settings/config resolution:
- `shouldUsePerUserTranscription` (36 lines)
- `shouldUseSharedTranscription` (36 lines)
- `shouldUseRealtimeTranscriptBridge` (25 lines)
- `resolveRealtimeReplyStrategy` (7 lines)
- `shouldUseNativeRealtimeReply` (3 lines)
- `isAsrActive` (8 lines)
- `buildVoiceInstructions` (44 lines)

These are ALL pure functions of settings objects. Zero session state needed.

#### 6. `src/voice/voiceAudioAnalysis.ts` (~60 lines)
Extract audio analysis utilities:
- `analyzeMonoPcmSignal` (35 lines)
- `evaluatePcmSilenceGate` (14 lines)
- `estimatePcm16MonoDurationMs` (5 lines)
- `estimateDiscordPcmPlaybackDurationMs` (4 lines)

Pure functions. Zero dependencies.

#### 7. `src/voice/voiceLatencyTracker.ts` (~110 lines)
Extract latency measurement:
- `computeLatencyMs` (7 lines)
- `buildVoiceLatencyStageMetrics` (14 lines)
- `logVoiceLatencyStage` (85 lines)

Pure measurement/logging. Only dependency is `store.logAction`.

#### 8. `src/voice/voiceMusicDisambiguation.ts` (~275 lines)
Extract music disambiguation flow:
- `isMusicDisambiguationResolutionTurn` (16 lines)
- `resolvePendingMusicDisambiguationSelection` (46 lines)
- `completePendingMusicDisambiguationSelection` (93 lines)
- `maybeHandlePendingMusicDisambiguationTurn` (72 lines)
- `hasPendingMusicDisambiguationForUser` (8 lines)
- `getMusicPromptContext` (63 lines)
- `describeMusicPromptAction` (12 lines)

Define a `VoiceMusicDisambiguationHost` interface. These interact with music state, command sessions, and operational messaging.

### Total expected extraction: ~1,876 lines of logic + the delegation stubs that replace them (~50 lines) = net reduction of ~1,800 lines.

### File ownership (STRICT):
- **OWNS:** `src/voice/voiceSessionManager.ts` + all new files created above
- **MAY MODIFY:** `src/voice/thoughtEngine.ts` (if merging thought generation into it)
- **MUST NOT MODIFY:** `src/bot.ts`, `src/bot/*`, `src/store/*`, `src/dashboard/*`, any file outside `src/voice/`

---

## Plan B: VSM Stub Deletion (voice-internal stubs only)

**Goal:** Delete delegation stubs that only have internal (`src/voice/`) callers. Update callers to use the extracted modules directly. Target: -300-400 lines.

### Safe-to-delete stub groups (internal callers only):

#### 1. Tool call stubs (22 stubs, ~50 internal call sites)
Callers: `voiceToolCallToolRegistry.ts`, `voiceToolCallMusic.ts`, `voiceToolCallMemory.ts`, `voiceToolCallInfra.ts`, `voiceToolCallDispatch.ts`, `voiceJoinFlow.ts`, `sessionLifecycle.ts`, `instructionManager.ts`

Currently: `manager.executeVoiceMemorySearchTool(...)` → stub → `executeVoiceMemorySearchTool(manager, ...)`
After: Callers import and call `executeVoiceMemorySearchTool(manager, ...)` directly.

#### 2. ASR bridge stubs (19 stubs, ~36 internal call sites)
Callers: `captureManager.ts`, `sessionLifecycle.ts`

Currently: `manager.beginOpenAiAsrUtterance(...)` → stub → `beginAsrUtterance(manager, ...)`
After: Callers import and call the ASR bridge functions directly.

#### 3. Operational messaging stubs (3 stubs, ~37 internal call sites)
Callers: `voiceJoinFlow.ts`, `voiceStreamWatch.ts`, `voiceMusicPlayback.ts`

Currently: `manager.sendOperationalMessage(...)` → stub → `sendOperationalMessage(manager, ...)`
After: Callers import `sendOperationalMessage` from `voiceOperationalMessaging.ts` directly.

### NOT safe to delete (have external callers):
- Stream watch stubs (15 stubs) — called by `bot.ts` and `screenShareSessionManager.ts`
- Music stubs (28 stubs) — called by `bot.ts` and `replyPipeline.ts`

Leave these as the public facade. They're the VSM's external API.

### File ownership (STRICT):
- **OWNS:** `src/voice/voiceSessionManager.ts` + all `src/voice/` files that need caller updates
- **MUST NOT MODIFY:** `src/bot.ts`, `src/bot/*`, `src/store/*`, `src/dashboard/*`, `src/services/*`

### Dependency on Plan A:
Plan B should run AFTER Plan A, not concurrent. Plan A creates new modules that Plan B's callers need to import from. If run concurrently, there will be heavy conflicts in the same lines of voiceSessionManager.ts.

**IMPORTANT:** Since Plans A and B both modify voiceSessionManager.ts heavily, they CANNOT run concurrently. Run A first, merge, then run B. Plans C and D are independent and can run concurrent with A.

---

## Plan C: bot.ts Runtime Factory Extraction

**Goal:** Extract the `to*Runtime()` factory methods from bot.ts into `src/bot/botRuntimeFactories.ts`. Target: -400 lines (2,075 → ~1,675).

### Methods to extract:

| Factory | Lines | Complexity |
|---------|-------|------------|
| `toBotContext()` | 10 | Trivial — 6 field assignments |
| `toAgentContext()` | 8 | Trivial |
| `toBudgetContext()` | 9 | Trivial |
| `toMediaAttachmentContext()` | 6 | Trivial |
| `toScreenShareRuntime()` | 8 | Low |
| `toVoiceCoordinationRuntime()` | 8 | Low |
| `toDiscoveryEngineRuntime()` | 42 | Medium |
| `toAutomationEngineRuntime()` | 42 | Medium |
| `toTextThoughtLoopRuntime()` | 29 | Medium |
| `toQueueGatewayRuntime()` | 95 | High — 7 Object.defineProperties for mutable state |
| `toReplyPipelineRuntime()` | 105 | High — 35 adapter lambdas |
| `toVoiceReplyRuntime()` | 29 | Medium |

### Approach:
These factories access `this` (ClankerBot instance) fields. Two options:

**Option A (recommended):** Create standalone functions that take a `ClankerBot` instance:
```typescript
export function buildBotContext(bot: ClankerBot): BotContext { ... }
export function buildReplyPipelineRuntime(bot: ClankerBot): ReplyPipelineRuntime { ... }
```
Then bot.ts methods become:
```typescript
toBotContext() { return buildBotContext(this); }
```
This requires that the fields accessed are public (or the function is a friend/same-module). Check which fields are private — if many are, use Option B.

**Option B (fallback):** Define a `BotRuntimeFactoryDeps` interface that exposes the needed fields, and have `ClankerBot` implement it. The factory functions take the interface instead of the concrete class.

### File ownership (STRICT):
- **OWNS:** `src/bot.ts`, `src/bot/botRuntimeFactories.ts` (new), `src/bot/botContext.ts` (interface adjustments if needed)
- **MUST NOT MODIFY:** `src/voice/*`, `src/store/*`, `src/dashboard/*`

---

## Plan D: Store Submodule `:any` Typing

**Goal:** Type the 56 `:any` parameters across 8 store submodule files. Target: 0 `:any` in production code.

### Files and counts:

| File | Count | Pattern |
|------|-------|---------|
| `src/store/storeActionLog.ts` | 12 | SQLite row results + query params |
| `src/store/storeMemory.ts` | 12 | SQLite row results + query params |
| `src/store/storeAutomation.ts` | 11 | SQLite row results + query params |
| `src/store/storeMessages.ts` | 7 | SQLite row results |
| `src/store/storeLookups.ts` | 5 | SQLite row results |
| `src/store/storeSettings.ts` | 5 | SQLite row results |
| `src/store/storeStats.ts` | 2 | SQLite row results |
| `src/store/storeVoice.ts` | 2 | SQLite row results |

### Approach:
For each file:
1. Read each `db.query<any>(...)` or `.get<any>(...)` call
2. Define a row interface matching the SQL column names and types
3. Replace `: any` with the row interface

Example:
```typescript
// Before
const row = db.query<any>("SELECT id, guild_id, text FROM messages WHERE id = ?").get(id);

// After
interface MessageRow { id: number; guild_id: string; text: string; }
const row = db.query<MessageRow, [number]>("SELECT id, guild_id, text FROM messages WHERE id = ?").get(id);
```

Also check for `(row: any)` in `.map()` callbacks and type those.

### File ownership (STRICT):
- **OWNS:** All `src/store/store*.ts` files (excluding `src/store/store.ts` itself and `src/store/settingsNormalization.ts`)
- **MUST NOT MODIFY:** `src/voice/*`, `src/bot/*`, `src/dashboard/*`, `src/store/store.ts`, `src/store/normalize/*`

---

## Concurrency Matrix

| | Plan A (VSM extract) | Plan B (VSM stubs) | Plan C (bot.ts) | Plan D (store) |
|---|---|---|---|---|
| **Plan A** | — | SEQUENTIAL (A before B) | Safe concurrent | Safe concurrent |
| **Plan B** | Must wait for A | — | Safe concurrent | Safe concurrent |
| **Plan C** | Safe concurrent | Safe concurrent | — | Safe concurrent |
| **Plan D** | Safe concurrent | Safe concurrent | Safe concurrent | — |

### Execution plan:
**Wave 1 (3 concurrent):** Plans A + C + D
**Wave 2 (1 worktree):** Plan B (after A merges)

### Merge order:
1. **D first** (store typing — isolated, no import path changes)
2. **C second** (bot.ts — isolated to bot files)
3. **A third** (VSM extraction — creates new voice modules)
4. **B last** (VSM stub deletion — modifies voice callers that Plan A touched)
