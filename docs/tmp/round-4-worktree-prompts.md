# Round 4 Worktree Prompts

**Wave 1 (3 concurrent):** Plans A + C + D
**Wave 2 (after A merges):** Plan B

---

## Worktree A: VSM Module Extraction

```
See docs/tmp/round-4-plans.md, Plan A. Read and understand it thoroughly before starting.

You are one of three concurrent worktree agents executing Round 4 Wave 1 of a codebase improvement. Your scope is strictly src/voice/voiceSessionManager.ts and new files you create in src/voice/.

YOUR TASK: Extract 8 self-contained modules from voiceSessionManager.ts. Each extraction follows this pattern:
1. Identify the methods listed in the plan
2. Determine the minimal dependency interface (what session state / services the function needs)
3. Create the new file with free functions that take the dependency interface as a parameter
4. Replace the methods in voiceSessionManager.ts with thin delegation stubs (3-5 lines each)
5. Run bun run typecheck && bun run test after each extraction

EXTRACTION TARGETS (in recommended order):

1. src/voice/voiceAudioAnalysis.ts (~60 lines)
   - analyzeMonoPcmSignal, evaluatePcmSilenceGate, estimatePcm16MonoDurationMs, estimateDiscordPcmPlaybackDurationMs
   - These are pure functions with ZERO dependencies. Just move them.

2. src/voice/voiceLatencyTracker.ts (~110 lines)
   - computeLatencyMs, buildVoiceLatencyStageMetrics, logVoiceLatencyStage
   - Only dependency is store.logAction for recording metrics.

3. src/voice/voiceAddressing.ts (~210 lines)
   - normalizeVoiceAddressingAnnotation, mergeVoiceAddressingAnnotation, findLatestVoiceTurnIndex, annotateLatestVoiceTurnAddressing, buildVoiceAddressingState
   - Pure functions of turn arrays and addressing objects. Zero side effects.

4. src/voice/voiceConfigResolver.ts (~170 lines)
   - shouldUsePerUserTranscription, shouldUseSharedTranscription, shouldUseRealtimeTranscriptBridge, resolveRealtimeReplyStrategy, shouldUseNativeRealtimeReply, isAsrActive, buildVoiceInstructions
   - Pure functions of settings. No session state.

5. src/voice/voiceSoundboard.ts (~210 lines)
   - maybeTriggerAssistantDirectedSoundboard, resolveSoundboardCandidates, fetchGuildSoundboardCandidates, normalizeSoundboardRefs
   - Define a VoiceSoundboardHost interface for Discord client and soundboard director access.

6. src/voice/voiceRuntimeSnapshot.ts (~461 lines)
   - getRuntimeState — the massive dashboard state builder
   - This is a pure read of session state. Define a function buildVoiceRuntimeSnapshot(sessions, deps) that takes the sessions map and read-only dependencies.
   - This is the biggest single win. 461 lines → 3-line stub.

7. src/voice/voiceMusicDisambiguation.ts (~275 lines)
   - isMusicDisambiguationResolutionTurn, resolvePendingMusicDisambiguationSelection, completePendingMusicDisambiguationSelection, maybeHandlePendingMusicDisambiguationTurn, hasPendingMusicDisambiguationForUser, getMusicPromptContext, describeMusicPromptAction
   - Define a VoiceMusicDisambiguationHost interface for music state, command sessions, operational messaging.

8. src/voice/voiceThoughtGeneration.ts (~380 lines)
   - generateVoiceThoughtCandidate, loadVoiceThoughtMemoryFacts, evaluateVoiceThoughtDecision, deliverVoiceThoughtCandidate, resolveVoiceThoughtEngineConfig
   - The existing ThoughtEngine class handles scheduling/timing. These functions handle actual generation/evaluation/delivery. Keep them as standalone functions with a VoiceThoughtGenerationHost interface. Do NOT merge them into the ThoughtEngine class — keep concerns separate.

NOTES FROM PLANNER:
- The established pattern in this codebase for extracted modules is: define a narrow Host interface (like MusicPlaybackHost, ReplyDecisionHost), write free functions that take (host, ...args), leave thin delegation stubs on VSM that call the free function with `this` as host. Follow this pattern exactly.
- For getRuntimeState: the function reads from many session fields and calls several other methods. You may need to make some of the methods it calls available on the host interface, or extract those sub-functions first. Consider extracting voiceAddressing and voiceConfigResolver BEFORE voiceRuntimeSnapshot, since getRuntimeState calls buildVoiceAddressingState and various config resolvers.
- There are pre-existing LSP errors in voiceSessionManager.ts around InstructionManagerHost type compatibility and sttPipeline settings field. These are known and should NOT block your work. Do not try to fix them — Plan A from Round 3 was supposed to address settings schema drift but it wasn't completed. Work around them.
- The free function resolveVoiceThoughtTopicalityBias already exists outside the class (line ~3025). The VSM method is a 3-line delegation to it. This is the existing pattern — follow it.

CONCURRENT WORK AWARENESS:
- Plan C is extracting bot.ts runtime factories. No overlap with your scope.
- Plan D is typing store submodule :any params. No overlap with your scope.
- Plan B (VSM stub deletion) will run AFTER you, in Wave 2. It will delete some of the delegation stubs you leave behind. Don't worry about the stub count — just make clean extractions.

VERIFICATION:
After EACH extraction (not just at the end), run: bun run typecheck && bun run test
All 704+ tests must pass. No new : any should be introduced.

TARGET: voiceSessionManager.ts reduced by ~1,800 lines (from 7,618 to ~5,800). 8 new well-typed modules.
```

---

## Worktree C: bot.ts Runtime Factory Extraction

```
See docs/tmp/round-4-plans.md, Plan C. Read and understand it thoroughly before starting.

You are one of three concurrent worktree agents executing Round 4 Wave 1. Your scope is strictly src/bot.ts, src/bot/botRuntimeFactories.ts (new file), and src/bot/botContext.ts.

YOUR TASK: Extract the 12 to*Runtime() factory methods from bot.ts into a new src/bot/botRuntimeFactories.ts file.

THE 12 FACTORIES:
1. toBotContext() — 10 lines, trivial
2. toAgentContext() — 8 lines, trivial
3. toBudgetContext() — 9 lines, trivial
4. toMediaAttachmentContext() — 6 lines, trivial
5. toScreenShareRuntime() — 8 lines, low
6. toVoiceCoordinationRuntime() — 8 lines, low
7. toDiscoveryEngineRuntime() — 42 lines, medium
8. toAutomationEngineRuntime() — 42 lines, medium
9. toTextThoughtLoopRuntime() — 29 lines, medium
10. toQueueGatewayRuntime() — 95 lines, high (uses Object.defineProperties for mutable state access)
11. toReplyPipelineRuntime() — 105 lines, high (35 adapter lambdas)
12. toVoiceReplyRuntime() — 29 lines, medium

APPROACH:
1. First, read bot.ts thoroughly. Identify all fields/properties that the factory methods access via `this`.
2. Determine which fields are public vs private. If most are public, use direct ClankerBot parameter. If many are private, define a narrow BotFactoryDeps interface.
3. Create src/bot/botRuntimeFactories.ts with standalone functions:
   ```typescript
   export function buildBotContext(bot: ClankerBot): BotContext { ... }
   export function buildReplyPipelineRuntime(bot: ClankerBot): ReplyPipelineRuntime { ... }
   ```
4. Replace each factory method in bot.ts with a one-liner:
   ```typescript
   private toBotContext() { return buildBotContext(this); }
   ```
5. For toQueueGatewayRuntime: this uses Object.defineProperties with get/set for mutable state (replyQueue, gatewayState). The extracted function needs to access these via the bot instance. If the fields are private, you may need to make them protected/public or use a deps interface.

NOTES FROM PLANNER:
- There are pre-existing LSP errors in bot.ts around VoiceReplyRuntime and ReplyPipelineRuntime (Round 3 Plan D fixed some but not all). The replyPipeline.ts also has import errors for buildContextContentBlocks/ContentBlock. These are in-flight edits — work around them, don't fix them.
- The bot.ts file also has some delegation wrappers that were not removed in Round 3. Leave them — they're out of scope for this plan. Focus exclusively on the factory extraction.
- Import types from src/bot/botContext.ts — that's where BotContext, ReplyPipelineRuntime, VoiceReplyRuntime etc. are defined.
- Some factories import functions from other bot/ modules (e.g., replyPipeline, discoveryEngine, automationEngine). The extracted factory functions will need the same imports.

CONCURRENT WORK AWARENESS:
- Plan A is extracting modules from voiceSessionManager.ts. No overlap with your scope.
- Plan D is typing store submodule :any params. No overlap with your scope.
- DO NOT modify any files outside src/bot.ts, src/bot/botRuntimeFactories.ts, src/bot/botContext.ts.

VERIFICATION:
Run: bun run typecheck && bun run test
All 704+ tests must pass.

TARGET: bot.ts reduced by ~400 lines (from 2,075 to ~1,675). Clean, thin factory delegation.
```

---

## Worktree D: Store Submodule `:any` Typing

```
See docs/tmp/round-4-plans.md, Plan D. Read and understand it thoroughly before starting.

You are one of three concurrent worktree agents executing Round 4 Wave 1. Your scope is strictly the src/store/store*.ts submodule files (NOT src/store/store.ts itself, NOT src/store/settingsNormalization.ts, NOT src/store/normalize/*).

YOUR TASK: Type 56 : any parameters across 8 store submodule files with proper SQLite row interfaces.

FILES AND COUNTS:
- src/store/storeActionLog.ts — 12 : any
- src/store/storeMemory.ts — 12 : any
- src/store/storeAutomation.ts — 11 : any
- src/store/storeMessages.ts — 7 : any
- src/store/storeLookups.ts — 5 : any
- src/store/storeSettings.ts — 5 : any
- src/store/storeStats.ts — 2 : any
- src/store/storeVoice.ts — 2 : any

APPROACH:
For each file:
1. Read the file completely
2. Find every : any occurrence (in db.query<any>, .get<any>, .all<any>, .map((row: any) => ...), function params typed as any)
3. For db.query results: look at the SQL query to determine column names and types. Define a row interface:
   ```typescript
   interface ActionLogRow {
     id: number;
     guild_id: string;
     action: string;
     detail: string;
     created_at: string;
     // ... match the SELECT columns
   }
   ```
4. Replace db.query<any>(...) with db.query<ActionLogRow, [paramTypes]>(...)
5. Replace (row: any) => with (row: ActionLogRow) =>
6. For function parameters typed as : any (like store: any), determine the correct type. If it's the Store class, use a narrow interface to avoid circular imports (this pattern is already established in storeAdaptiveDirectives.ts from Round 3).

NAMING CONVENTION: Use descriptive row interface names like `ActionLogRow`, `MessageRow`, `AutomationRow`, `MemoryFactRow`, `LookupContextRow`, etc. Define them at the top of each file, not exported (they're internal to the module).

NOTES FROM PLANNER:
- bun:sqlite's Database.query() accepts a type parameter for the row shape: db.query<RowType, ParamTupleType>(sql). Use this for both the row result and the parameter tuple.
- SQLite columns are nullable unless constrained. When in doubt about nullability, check the CREATE TABLE schema in src/store/store.ts (the main store file has all migrations).
- Some queries use computed columns (COUNT(*), SUM(), etc.) — type these with appropriate names like `{ count: number }`.
- The storeAdaptiveDirectives.ts file was already typed in Round 3 with a narrow AdaptiveDirectiveStore interface. Follow that exact pattern for any function that takes store: any in these files.
- There is 1 remaining : any in src/voice/voiceToolCallInfra.ts — that is NOT your scope. Leave it.

CONCURRENT WORK AWARENESS:
- Plan A is extracting modules from voiceSessionManager.ts. No overlap.
- Plan C is extracting bot.ts runtime factories. No overlap.
- DO NOT modify src/store/store.ts, src/store/settingsNormalization.ts, src/store/normalize/*, or any file outside src/store/.

VERIFICATION:
After each file, run: bun run typecheck && bun run test
All 704+ tests must pass. When complete, verify: rg ': any\b' src/store/ -t ts --glob '!*.test.*' should return 0 results.

TARGET: 0 : any in all store submodule files. 56 → 0.
```

---

## Worktree B: VSM Stub Deletion (Wave 2 — after Plan A merges)

```
See docs/tmp/round-4-plans.md, Plan B. Read and understand it thoroughly before starting.

IMPORTANT: This worktree runs AFTER Plan A (VSM module extraction) has been merged to master. Plan A creates new extracted modules and leaves delegation stubs on the VoiceSessionManager. Your job is to delete the stubs that only have internal (src/voice/) callers, and update those callers to import the extracted functions directly.

Your scope is strictly src/voice/ files.

YOUR TASK: Delete ~44 delegation stubs from voiceSessionManager.ts and update internal callers to use the extracted modules directly.

THREE GROUPS OF SAFE-TO-DELETE STUBS:

1. TOOL CALL STUBS (22 stubs, ~50 internal call sites)
   Stubs: ensureSessionToolRuntimeState, getVoiceMcpServerStatuses, resolveVoiceRealtimeToolDescriptors, buildRealtimeFunctionTools, recordVoiceToolCallEvent, parseOpenAiRealtimeToolArguments, resolveOpenAiRealtimeToolDescriptor, summarizeVoiceToolOutput, executeOpenAiRealtimeFunctionCall, refreshRealtimeTools, executeVoiceMemorySearchTool, executeVoiceMemoryWriteTool, executeVoiceAdaptiveStyleAddTool, executeVoiceAdaptiveStyleRemoveTool, executeVoiceConversationSearchTool, executeVoiceMusicSearchTool, executeVoiceMusicQueueAddTool, executeVoiceMusicQueueNextTool, executeVoiceMusicPlayNowTool, executeVoiceWebSearchTool, executeLocalVoiceToolCall, executeMcpVoiceToolCall

   Internal callers: voiceToolCallToolRegistry.ts, voiceToolCallMusic.ts, voiceToolCallMemory.ts, voiceToolCallInfra.ts, voiceToolCallDispatch.ts, voiceJoinFlow.ts, sessionLifecycle.ts, instructionManager.ts

   Current pattern: manager.executeVoiceMemorySearchTool(...) → stub → executeVoiceMemorySearchTool(manager, ...)
   Target pattern: caller imports executeVoiceMemorySearchTool from voiceToolCallMemory.ts and calls it with manager directly.

2. ASR BRIDGE STUBS (19 stubs, ~36 internal call sites)
   Stubs: getOpenAiSharedAsrState, getOpenAiAsrSessionMap, getOrCreateOpenAiAsrSessionState, ensureOpenAiAsrSessionConnected, beginOpenAiAsrUtterance, appendAudioToOpenAiAsr, commitOpenAiAsrUtterance, discardOpenAiAsrUtterance, scheduleOpenAiAsrSessionIdleClose, closeOpenAiAsrSession, closeAllOpenAiAsrSessions, beginOpenAiSharedAsrUtterance, appendAudioToOpenAiSharedAsr, commitOpenAiSharedAsrUtterance, discardOpenAiSharedAsrUtterance, scheduleOpenAiSharedAsrSessionIdleClose, releaseOpenAiSharedAsrActiveUser, tryHandoffSharedAsrToWaitingCapture, closeOpenAiSharedAsrSession

   Internal callers: captureManager.ts (27 sites), sessionLifecycle.ts (1 site)

   Current pattern: manager.beginOpenAiAsrUtterance(...) → stub → beginAsrUtterance(manager, ...)
   Target pattern: caller imports beginAsrUtterance from voiceAsrBridge.ts and calls it directly.

3. OPERATIONAL MESSAGING STUBS (3 stubs, ~37 internal call sites)
   Stubs: sendOperationalMessage, resolveOperationalChannel, sendToChannel

   Internal callers: voiceJoinFlow.ts (18 sites), voiceStreamWatch.ts (9 sites), voiceMusicPlayback.ts (10 sites)

   Current pattern: manager.sendOperationalMessage(...) → stub → sendOperationalMessage(manager, ...)
   Target pattern: caller imports sendOperationalMessage from voiceOperationalMessaging.ts.

DO NOT DELETE these stub groups (they have external callers in bot.ts, screenShareSessionManager.ts):
- Stream watch stubs (15 stubs) — called by bot.ts and screenShareSessionManager.ts
- Music stubs (28 stubs) — called by bot.ts and replyPipeline.ts
These remain as the VSM's public API facade.

ALSO: After Plan A runs, there will be NEW delegation stubs for the modules Plan A extracted (voiceRuntimeSnapshot, voiceAddressing, voiceConfigResolver, etc.). Check if any of those new stubs are ONLY called internally. If so, delete them too.

EXECUTION APPROACH:
1. Start with tool call stubs — they have the most call sites but are all in voiceToolCall*.ts files (self-contained)
2. Then ASR bridge stubs — mostly in captureManager.ts (27 of 36 sites)
3. Then operational messaging stubs
4. After each group, run typecheck + tests

NOTES FROM PLANNER:
- When updating callers, you need to know what function name the stub delegates to and which module it's in. Read the stub body to find the actual function call, then import that function in the caller.
- Some stubs add minor logic before delegating (guard checks, default values). In those cases, move the guard logic to the caller or into the module function itself. Don't silently drop guards.
- The test files (voiceMemory.test.ts, voiceSessionManager.addressing.test.ts, voiceSessionManager.lifecycle.test.ts) assign mock stubs on the manager. When you delete a stub, update the test to either (a) mock the module function directly, or (b) remove the mock assignment if it's no longer needed.

VERIFICATION:
After each group, run: bun run typecheck && bun run test
All 704+ tests must pass.

TARGET: ~44 stubs deleted, ~300-400 lines removed from voiceSessionManager.ts. All callers updated to import from extracted modules directly.
```
