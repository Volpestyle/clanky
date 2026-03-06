# Round 3 Worktree Prompts

Four concurrent worktrees. No file overlap between plans.

---

## Worktree A: Voice Session Manager — Stub Pruning + Type Hardening

```
See docs/tmp/voice-final-cleanup-plan.md. Read and understand it thoroughly before starting.

You are one of four concurrent worktree agents executing Round 3 of a codebase improvement. Your scope is strictly src/voice/ files plus src/settings/settingsSchema.ts (voice field additions only).

NOTES FROM PLANNER:
- The plan has 5 phases. Execute them in order. Each phase has a clear deliverable.
- Phase 2 (settings schema drift) — add these missing fields to DEFAULT_SETTINGS.voice in settingsSchema.ts: runtimeMode, xai, elevenLabsRealtime, geminiRealtime, sttPipeline, generation. Look at how settingsNormalization.ts and agentStack.ts reference them to determine the correct default shapes/values. These fields exist at runtime (persisted in user settings) but are missing from the typed defaults.
- Phase 1 (voiceSessionTypes.ts) — the ~20 `: any` fields include things like: provider configs, source references, pending results, interruptionPolicy, brainContextEntries, toolCallState maps. Look at how each field is actually used in voiceSessionManager.ts and other voice modules to determine the correct type. When in doubt, use a narrow union or a named type alias rather than leaving `any`.
- Phase 3 (stub pruning) — the goal is to find methods on VoiceSessionManager that are pure delegation stubs (just forward to manager.someModule.method()) and either (a) delete them if callers can use the module directly, or (b) mark them as needed orchestration if they do real work. The extracted modules are: replyManager, bargeInController, captureManager, turnProcessor, thoughtEngine, deferredActionQueue, greetingManager, instructionManager, sessionLifecycle. Check if callers of each stub are internal or external — external callers may need the stub to stay as a public API facade.
- Phase 5 (fire-and-forget) — the ~25 .catch(() => undefined) patterns in voice files. For each: if the fire-and-forget is correct (truly optional side effect), add a descriptive error log. If the result matters, add proper error handling. If it's dead code, delete it.
- Pre-existing LSP errors in voiceSessionManager.ts around OutputChannelState and InstructionManagerHost — these are known. Fix them as part of Phase 1 or Phase 3 as appropriate.
- VoiceToolRuntimeSessionLike has openAiToolCallExecutions typed as Map<string, Promise<void>> but the actual runtime uses Map<string, { startedAtMs: number; toolName: string }>. Fix this in voiceSessionTypes.ts as part of Phase 1.
- dashboard/src/settingsFormModel.ts also has settings schema drift errors (generation, xai, elevenLabsRealtime, geminiRealtime, sttPipeline missing from voice settings type). These will be fixed automatically when you add the missing fields to DEFAULT_SETTINGS in settingsSchema.ts (Phase 2), since the type is inferred from DEFAULT_SETTINGS. If the dashboard file still shows errors after the schema fix, you may need to add it to your scope — but it should resolve automatically.

CONCURRENT WORK AWARENESS:
- Plan B is reorganizing src/ root files (moving botHelpers, pricing, store, memory, etc. to subdirectories). This will change import paths but does NOT touch any src/voice/ files. You may see import path changes at merge time — these are expected and trivially resolvable.
- Plan C is decomposing src/voice/voiceToolCalls.ts into smaller modules. You MUST NOT modify voiceToolCalls.ts. If you need to adjust its types, coordinate via voiceSessionTypes.ts (which you own).
- Plan D is slimming src/bot.ts and fixing VoiceReplyRuntime/ReplyPipelineRuntime interfaces. You MUST NOT modify src/bot.ts or src/bot/replyPipeline.ts.

VERIFICATION:
After each phase, run: bun run typecheck && bun run test
All 704+ tests must pass. No new `: any` should be introduced.

TARGET: voiceSessionManager.ts under 5,000 lines, 0 `: any` in voice types, settings schema drift resolved, fire-and-forget patterns addressed.
```

---

## Worktree B: Source Tree Reorganization + Remaining `:any` Cleanup

```
See docs/tmp/source-tree-reorg-plan.md. Read and understand it thoroughly before starting.

You are one of four concurrent worktree agents executing Round 3 of a codebase improvement. Your scope is src/ root files (moving them to subdirectories), src/dashboard/ route typing, src/store/storeAdaptiveDirectives.ts typing, and non-voice fire-and-forget cleanup.

NOTES FROM PLANNER:
- This is the highest-risk plan because file moves affect import paths across the entire codebase. Execute Phase 1+2 (moves + imports) first and get it green before touching types.
- Move files in batches by destination directory: (1) src/llm/ batch, (2) src/bot/ batch, (3) src/services/ batch, (4) src/prompts/ batch, (5) src/memory/ batch, (6) src/store/ batch, (7) src/video/ batch. After each batch, fix imports and run typecheck.
- The prompts.ts barrel file (7 lines re-exporting from src/prompts/*) should be converted to src/prompts/index.ts. This lets `import from './prompts'` or `import from '../prompts'` still resolve without changing import paths at call sites.
- When moving test files, they go to the same destination directory as their production file. Update any relative imports within the test file.
- For dashboard route typing (Phase 3): define per-route-file dep interfaces. Use `import type { Express } from "express"` for the app param. The deps interface for each file should exactly match what that file destructures from deps. Check dashboard.ts's createDashboardServer to see the full dep shape and define a DashboardDeps interface there too.
- For storeAdaptiveDirectives.ts (Phase 4): DO NOT import Store directly (circular dependency). Define a narrow AdaptiveDirectiveStore interface locally in the file with just the db and logAction members that these functions actually use. This follows the pattern already established by MusicPlaybackHost and ReplyDecisionHost in voice modules.
- For fire-and-forget audit (Phase 5): scan for .catch(() => undefined) and .catch(() => {}) outside src/voice/. There should be ~15. For each: add descriptive error logging if the fire-and-forget is intentional, add proper error handling if the result matters, or delete if dead code.

CONCURRENT WORK AWARENESS:
- Plan A is modifying src/voice/ files and src/settings/settingsSchema.ts. DO NOT touch any src/voice/ files.
- Plan C is decomposing src/voice/voiceToolCalls.ts. DO NOT touch it.
- Plan D is modifying src/bot.ts and src/bot/replyPipeline.ts. DO NOT touch these files. When moving botHelpers.ts to src/bot/botHelpers.ts, you'll update imports in bot.ts — but only the import path, not the code. Plan D's changes to bot.ts will conflict at merge time but only on different lines.
- When you update imports in files owned by other worktrees (like import paths in voice files pointing to moved files), limit changes to import statements only. These will be trivially mergeable.

VERIFICATION:
After each phase (especially after each move batch), run: bun run typecheck && bun run test
All 704+ tests must pass. No new `: any` should be introduced.

TARGET: src/ root has ≤10 files (7 production + test helpers), 0 `:any` in dashboard routes, 0 `store: any` in storeAdaptiveDirectives, no .catch(() => undefined) outside voice.
```

---

## Worktree C: voiceToolCalls.ts Decomposition

```
You are one of four concurrent worktree agents executing Round 3 of a codebase improvement. Your scope is strictly src/voice/voiceToolCalls.ts — decomposing it from 2,015 lines into smaller, focused modules.

CONTEXT:
voiceToolCalls.ts contains 25 exported functions across 6 logical domains:

1. INFRASTRUCTURE (~730 lines): ensureSessionToolRuntimeState, getVoiceMcpServerStatuses, resolveVoiceRealtimeToolDescriptors, buildRealtimeFunctionTools, recordVoiceToolCallEvent, parseOpenAiRealtimeToolArguments, resolveOpenAiRealtimeToolDescriptor, summarizeVoiceToolOutput, executeOpenAiRealtimeFunctionCall, refreshRealtimeTools
2. MUSIC TOOLS (~520 lines): executeVoiceMusicSearchTool, executeVoiceMusicQueueAddTool, executeVoiceMusicQueueNextTool, executeVoiceMusicPlayNowTool (plus inline music_pause/resume/stop/now_playing handlers inside executeLocalVoiceToolCall)
3. MEMORY TOOLS (~150 lines): executeVoiceMemorySearchTool, executeVoiceConversationSearchTool, executeVoiceMemoryWriteTool
4. ADAPTIVE DIRECTIVE TOOLS (~60 lines): executeVoiceAdaptiveStyleAddTool, executeVoiceAdaptiveStyleRemoveTool
5. WEB/RESEARCH TOOLS (~140 lines): executeVoiceWebSearchTool, executeVoiceWebScrapeTool
6. AGENT TOOLS (~260 lines): executeVoiceBrowserBrowseTool, executeVoiceCodeTaskTool
7. DISPATCH (~350 lines): executeLocalVoiceToolCall (big switch), executeMcpVoiceToolCall

The file also defines internal types: VoiceToolCallManager (massive Pick<VoiceSessionManager, ...> with 50+ members), VoiceToolCallArgs, RealtimeFunctionTool, SubAgentTurnResult, SubAgentInteractiveSession, SubAgentSessionRegistry.

DECOMPOSITION PLAN:
Extract into these new files in src/voice/:

1. src/voice/voiceToolCallTypes.ts — Export VoiceToolCallManager, VoiceToolCallArgs, RealtimeFunctionTool, SubAgentTurnResult, SubAgentInteractiveSession, SubAgentSessionRegistry types
2. src/voice/voiceToolCallInfra.ts — Infrastructure functions: session state init, tool resolution, descriptor building, recording, parsing, summarizing, execute orchestrator, refresh
3. src/voice/voiceToolCallMusic.ts — Music tool handlers
4. src/voice/voiceToolCallMemory.ts — Memory + conversation search + memory write
5. src/voice/voiceToolCallDirectives.ts — Adaptive directive add/remove
6. src/voice/voiceToolCallWeb.ts — Web search + scrape
7. src/voice/voiceToolCallAgents.ts — Browser browse + code task
8. src/voice/voiceToolCallDispatch.ts — executeLocalVoiceToolCall + executeMcpVoiceToolCall

Keep src/voice/voiceToolCalls.ts as a thin barrel that re-exports the public API from all submodules, so existing callers don't need import path changes.

EXECUTION STEPS:
1. Read voiceToolCalls.ts thoroughly to understand all internal dependencies between functions
2. Create the type file first (voiceToolCallTypes.ts)
3. Extract domain-specific tool handlers (music, memory, directives, web, agents) — these are the most independent
4. Extract infrastructure functions — these depend on types and may be imported by domain handlers
5. Extract the dispatch functions last — they import from all domain handlers
6. Convert voiceToolCalls.ts to a barrel re-exporting everything
7. Verify all existing tests pass and typecheck is clean

NOTES FROM PLANNER:
- The big dispatch function executeLocalVoiceToolCall has inline handlers for music_pause, music_resume, music_stop, music_now_playing that are NOT separate exported functions. When extracting, either move these inline cases to voiceToolCallMusic.ts as named functions, or keep them inline in the dispatch if they're trivially small (1-3 lines each).
- VoiceToolCallManager is a Pick<VoiceSessionManager, ...> with 50+ members. This is the dependency injection interface — it stays as-is but moves to the types file. Don't try to refactor it further in this pass.
- The SubAgent types and session management (SubAgentInteractiveSession, SubAgentSessionRegistry) support multi-turn browser/code sessions. These are used by voiceToolCallAgents.ts.
- executeOpenAiRealtimeFunctionCall (the orchestrator) calls executeLocalVoiceToolCall and executeMcpVoiceToolCall. Keep this in voiceToolCallInfra.ts — it's infrastructure, not dispatch.

CONCURRENT WORK AWARENESS:
- Plan A may modify voiceSessionTypes.ts (the types your file imports). Your decomposition should import from voiceSessionTypes.ts as the source of truth. If Plan A changes type shapes, the conflict will be in the import types — trivially resolvable at merge.
- Plan B may change import paths for files like pricing.ts, memory.ts, store.ts. You should NOT be importing those directly from voiceToolCalls.ts (it uses VoiceToolCallManager as DI), so no conflict expected.
- Plan D is modifying bot.ts. No overlap with your scope.
- DO NOT modify any files outside src/voice/voiceToolCalls.ts and the new files you create in src/voice/.

VERIFICATION:
Run: bun run typecheck && bun run test
All 704+ tests must pass. The barrel re-export means no import path changes needed in consumers.

TARGET: voiceToolCalls.ts becomes a thin barrel (<50 lines). Each new module is <400 lines. All existing functionality preserved.
```

---

## Worktree D: bot.ts Final Slim-Down

```
You are one of four concurrent worktree agents executing Round 3 of a codebase improvement. Your scope is strictly src/bot.ts and src/bot/replyPipeline.ts (plus src/bot/botContext.ts for interface fixes).

CONTEXT:
bot.ts is currently 2,110 lines. It has:
- 27 thin delegation wrappers (methods that just forward to imported functions)
- 10 runtime factory methods (to*Runtime) totaling ~401 lines (19% of file)
- Pre-existing LSP errors from interface mismatches

TARGET: ~1,400-1,600 lines, clean LSP, no type errors.

PHASE 1: Fix LSP Errors

The VoiceReplyRuntime interface (src/bot/botContext.ts lines 233-247) requires these members that ClankerBot's toVoiceReplyRuntime() doesn't provide:
- runModelRequestedBrowserBrowse
- buildBrowserBrowseContext  
- runModelRequestedCodeTask
- appConfig (from BotContext base)

Fix: Add the missing adapter lambdas to toVoiceReplyRuntime() in bot.ts (lines 772-800). These should follow the same pattern as other adapter methods — import the function from the appropriate bot/ module and wrap it with the context.

The ReplyPipelineRuntime interface requires `resolveMediaAttachment` which ClankerBot doesn't implement. Fix: Add the missing method or adapter.

In replyPipeline.ts, `getAutoIncludeImageInputs` was referenced but appears to have been cleaned up already. Verify this — if the error still exists, check what the correct replacement is (likely `getImageInputs` from the media context).

There are also pre-existing import errors in replyPipeline.ts: `buildContextContentBlocks` and `ContentBlock` are imported from `../llm/serviceShared.ts` but may not be exported there. Check if these were renamed/moved during prior rounds and fix the import paths. These may be in-flight edits from the user — if so, work around them.

PHASE 2: Prune Thin Delegation Wrappers

27 wrappers identified. Categorize each:

DELETE candidates (pure passthrough, no context injection needed):
- getReplyCoalesceWindowMs, getReplyCoalesceMaxMessages, getReplyCoalesceWaitMs — these just forward to imported functions with no `this` context
- getDiscoveryPostingIntervalMs, getDiscoveryAverageIntervalMs, getDiscoveryPacingMode, getDiscoveryMinGapMs — pure passthrough to imported functions
- markGatewayEvent — trivial `this.lastGatewayEventAt = Date.now()`
- markSpoke — trivial `this.lastBotMessageAt = Date.now()`

KEEP candidates (inject `this.to*Runtime()` context — callers need the class method):
- All the queue/gateway methods that pass `this.toQueueGatewayRuntime()`
- maybeReplyToMessage (passes `this.toReplyPipelineRuntime()`)
- requestVoiceJoinFromDashboard (passes `this.toVoiceCoordinationRuntime()`)
- The message history methods (syncMessageSnapshot etc.)

For DELETE candidates: find all call sites, update them to call the imported function directly, then delete the wrapper method. If the method is part of a public interface (check the Pick<ClankerBot, ...> types in botContext.ts), you'll need to remove it from the Pick too.

For KEEP candidates: leave them but ensure they're clean (no unnecessary nesting, no duplicated logic).

PHASE 3: Extract Runtime Factories (if time allows)

The 10 to*Runtime() methods total ~401 lines. Consider extracting them to a new file src/bot/botRuntimeFactories.ts as standalone functions that take `bot: ClankerBot` (or a subset). This would reduce bot.ts by ~400 lines.

However, this may be complex since several factories access private fields (like this.replyQueue, this.gatewayState). Evaluate feasibility — if it requires making too many fields public, skip this and note it as future work.

NOTES FROM PLANNER:
- ReplyPipelineRuntimeMember (botContext.ts lines 183-197) picks 15 members from ClankerBot. If you delete wrapper methods that are in this Pick list, you must update the Pick.
- The discovery schedule wrappers (lines 2041-2077) are candidates for extraction to a separate bot/discoveryScheduleHelpers.ts or inlining at call sites.
- Check if evaluateDiscoverySchedule and evaluateSpontaneousDiscoverySchedule are substantial enough to keep as class methods or if they should move to src/bot/discoveryEngine.ts (which already exists).

CONCURRENT WORK AWARENESS:
- Plan A is modifying src/voice/ files. No overlap with your scope.
- Plan B is moving src/ root files to subdirectories, which will change import paths in bot.ts. At merge time, your changes to bot.ts will conflict with Plan B's import path updates — but these are on different lines (imports vs method bodies) and trivially resolvable.
- Plan B is also moving botHelpers.ts to src/bot/botHelpers.ts. If you add new imports from botHelpers in bot.ts, use the current path (./botHelpers.ts) — it'll be updated at merge.
- Plan C is decomposing voiceToolCalls.ts. No overlap.
- DO NOT modify files outside your scope: src/bot.ts, src/bot/replyPipeline.ts, src/bot/botContext.ts.

VERIFICATION:
Run: bun run typecheck && bun run test
All 704+ tests must pass. LSP errors in bot.ts and replyPipeline.ts should be resolved.

TARGET: bot.ts ~1,400-1,600 lines, 0 LSP errors, all delegation wrappers either justified or removed.
```
