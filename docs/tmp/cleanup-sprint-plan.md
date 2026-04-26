# Cleanup Sprint Plan

Focused sprint to address over-engineering, code duplication, dead code, and maintainability issues identified in the full codebase review.

Organized into phases by dependency order and risk. Each phase is independently shippable.

## Status Update (2026-03-18)

- Completed in this pass:
  - **Phase 4.1** import alias cleanup in `src/bot.ts`, `src/bot/botRuntimeFactories.ts`, `src/bot/replyPipeline.ts`, and `src/voice/voiceSessionManager.ts`
  - **Phase 7.3** runtime-factory simplification in `src/bot/botRuntimeFactories.ts` (shared reply-address helper + reduced repeated runtime construction)
  - **Phase 7.4** removed the permissive index signatures from `VoiceSession` and `VoiceToolRuntimeSessionLike`
  - **Phase 7.5** extracted named constants for remaining bare numeric literals in the targeted memory/tooling/store/video modules
- **Phase 7.2** completed:
  - Decomposed `VoiceDebugger.tsx` by extracting `TurnReconstructor`, `AnomalyDetection`, `FlightLog`, and shared debugger types to `dashboard/src/components/voiceDebugger/`
  - Decomposed `VoiceMonitor.tsx` into focused modules under `dashboard/src/components/voiceMonitor/` (`SessionCard`, `ParticipantList`, `MusicDetail`, `StreamWatchDetail`, `LatencyPanel`, `McpPanel`, `ToolCallLog`, `ConversationContext`, `PromptStateViewer`, and shared helpers)

> **Superseded sequencing note (2026-04):** The original sequencing constraint here referenced the async code-task design (`BackgroundTaskRunner`, `onProgress` on `SubAgentSession`, etc.). That design has been replaced by the [swarm-launcher redesign](./swarm-launcher-redesign-plan.md), which deletes `codeAgent.ts`, `codexCliAgent.ts`, `backgroundTaskRunner.ts`, and most of the in-process session machinery for code work outright. Phases of this plan that targeted those files (notably 2.4 and 7.1) are partially or fully moot — see inline notes on each.

---

## Phase 1: Dead Code Removal

Zero-risk deletions. No behavior changes, no refactors. Just removing code that is never executed.

### 1.1 Delete orphaned dashboard components
- Delete `dashboard/src/components/settingsSections/BrowserSettingsSection.tsx` (159 lines) -- never imported, absorbed by ResearchBrowsingSettingsSection
- Delete `dashboard/src/components/settingsSections/WebSearchSettingsSection.tsx` (157 lines) -- never imported, absorbed by ResearchBrowsingSettingsSection

### 1.2 Delete dead voice infrastructure
- Delete `src/voice/musicPlayback.ts` (~100 lines) -- `NullMusicPlaybackProvider` always returns failure; all real music routes through `musicPlayer.ts`. Remove any imports of `createMusicPlaybackProvider`.
- Remove unused `discordSort` import from `src/voice/voiceSessionManager.constants.ts` line 1
- Remove two unexported/unreferenced constants from `voiceSessionManager.constants.ts`: `NON_DIRECT_REPLY_MIN_SILENCE_MS` (line 136) and `VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS` (line 128)

### 1.3 Delete dead functions and exports
- Remove `uniqueIdList` from `src/utils.ts` (lines 41-54) -- never exported, never called
- Remove `resetSettings()` from `dashboard/src/api.ts` (lines 85-87) -- not exported, never called
- Remove `isFinalHistoryTranscriptEventType()` from `dashboard/src/components/VoiceMonitor.tsx` (lines 181-221) -- defined but never called
- Remove 5 unused private functions from `src/settings/agentStack.ts`: `getInteractionSettings`, `getSessionOrchestrationSettings`, `getMediaSettings`, `getMusicSettings`, `getClaudeOAuthSessionRuntimeConfig`

### 1.4 Remove hardcoded dev artifact
- Remove `DEFAULT_JOIN_TEXT_CHANNEL_ID = "1475944808198574205"` from `VoiceMonitor.tsx` line 84 and replace any usage with a prop or settings value

### 1.5 Inline trivial micro-modules
- Inline `src/voice/realtimeInterruptAcceptance.ts` (16 lines) into its sole consumer
- Inline `src/voice/voiceTimeline.ts` (12 lines) into its sole consumer
- Evaluate whether `src/voice/voiceToolCalls.ts` (38-line pure re-export barrel) is imported anywhere; if all consumers import directly from sub-modules, delete it

**Estimated savings: ~750 lines removed, 3-5 files deleted**

---

## Phase 2: Type and Constant Deduplication

Mechanical find-and-replace. Change imports, delete local redeclarations. No logic changes.

### 2.1 Eliminate 11 redeclared types in voiceSessionManager.ts
Replace the local type declarations at lines 340-578 with imports from `voiceSessionTypes.ts`:
- `MusicSelectionResult`, `MusicDisambiguationPayload`, `MusicTextCommandMessage`
- `VoiceAddressingAnnotation`, `VoiceAddressingState`, `VoiceConversationContext`
- `VoiceReplyDecision`, `VoiceTimelineTurn`, `VoiceRealtimeToolDescriptor`
- `VoiceToolCallEvent`, `VoiceMcpServerStatus`, `VoiceRealtimeToolSettings`, `VoiceToolRuntimeSessionLike`

### 2.2 Consolidate `isRecordLike` / `isRecord`
Canonical source: `src/store/normalize/primitives.ts` exports `isRecord`. Update these files to import from there:
- `src/settings/settingsIntent.ts`
- `src/settings/dashboardSettingsState.ts`
- `src/store/settingsNormalization.ts`
- `src/store/storeSettings.ts`
- `src/settings/agentStack.ts` (`isSettingsInput`)

### 2.3 Consolidate `ModelBinding` and `DevTeamRoles`
- `src/settings/agentStack.ts` and `src/settings/agentStackCatalog.ts` should import `SettingsModelBinding` from `settingsSchema.ts` instead of redeclaring `ModelBinding`
- Define `DevTeamRoles` once (in `settingsSchema.ts` or `agentStack.ts`) and import in the other

### 2.4 Consolidate `EMPTY_USAGE`
Export from `src/agents/subAgentSession.ts`. Remove local declarations in:
- ~~`src/agents/codeAgent.ts`~~ — file deleted by swarm-launcher redesign
- ~~`src/agents/codexCliAgent.ts`~~ — file deleted by swarm-launcher redesign
- `src/agents/codexAgent.ts` (if still present)
- `src/agents/browseAgent.ts`

After the swarm-launcher redesign lands, this phase reduces to consolidating the remaining browse/codex-API declarations against the single `subAgentSession.ts` export.

### 2.5 Consolidate `ErrorWithAttempts`
- `src/video/videoContextService.ts` should import from `src/retry.ts` instead of redeclaring locally

### 2.6 Consolidate `sleep` / `sleepMs`
- Pick one name (`sleep`), export only that from `src/normalization/time.ts`
- Update all `sleepMs` call sites
- Remove re-export from `src/utils.ts` if redundant

### 2.7 Merge duplicate reflection schemas and normalizers
- Extract shared `REFLECTION_FACTS_JSON_SCHEMA` to `src/memory/memoryHelpers.ts`
- Extract shared `normalizeReflectionFacts()` to `src/memory/memoryHelpers.ts`
- Update `dailyReflection.ts` and `microReflection.ts` to import from there

**Estimated savings: ~300 lines removed, zero behavior change**

---

## Phase 3: Dashboard Deduplication and Hygiene

Low-risk frontend cleanup. Extracting shared helpers, removing unnecessary imports.

### 3.1 Extract shared dashboard utilities
Create `dashboard/src/utils/voiceHelpers.ts` with:
- `elapsed()` (from VoiceMonitor.tsx and VoiceDebugger.tsx)
- `deriveBotState()` (from VoiceMonitor.tsx and VoiceDebugger.tsx)
- `normalizePromptText()` and `normalizeFollowupPrompts()` (from ActionStream.tsx and VoiceMonitor.tsx)

Update both consumer files to import from the shared module.

### 3.2 Deduplicate MemoryTab localStorage helpers
Replace `loadStoredMemorySubTab()` and `saveStoredMemorySubTab()` in `MemoryTab.tsx` with the existing `loadStoredTab()` and `saveStoredTab()` from `tabState.ts`.

### 3.3 Remove unnecessary `import React` statements
Remove `import React from "react"` from the ~19 files that don't use `React` as a value (list in review). The project uses Vite with automatic JSX runtime.

### 3.4 Fix inconsistent CSS import
Move `voice-debugger.css` import from `VoiceDebugger.tsx` to `main.tsx` to match the global import pattern used by all other CSS files.

**Estimated savings: ~100 lines, improved consistency**

---

## Phase 4: Import Alias Cleanup

High readability impact. Mechanical but requires care to avoid breaking call sites.

### 4.1 Remove `ForModuleName` import suffixes
Files to clean up:
- `src/bot.ts` (~44 aliased imports, lines 49-92)
- `src/bot/botRuntimeFactories.ts` (~68 aliased imports, lines 2-69)
- `src/voice/voiceSessionManager.ts` (~60 aliased imports)
- `src/bot/replyPipeline.ts` (aliased imports in header)

Process for each file:
1. Remove the `as xxxForModule` alias from the import
2. Find-replace all usages of the aliased name with the original function name
3. If genuine collisions exist (unlikely), use the shortest disambiguating alias

**Estimated savings: ~200 lines of import noise, major readability improvement**

---

## Phase 5: Logic Deduplication

Requires understanding call sites. Slightly higher risk.

### 5.1 Extract shared settings resolution helper
Replace the 20+ instances of `settings || session?.settingsSnapshot || manager.store.getSettings()` with a shared utility:
```ts
function resolveSettings(session: VoiceSession | null, settings: Settings | null, store: Store): Settings
```
Place in `src/voice/voiceSessionHelpers.ts` or a new `src/voice/voiceSettingsResolver.ts`.

### 5.2 Deduplicate media prompt composers in botHelpers.ts
`composeDiscoveryImagePrompt` / `composeReplyImagePrompt` and their video counterparts share ~90% of their logic. Extract a shared `composeMediaPrompt(mode: "reply" | "discovery", type: "image" | "video", ...)` template function.

### 5.3 Merge duplicate `formatRelativePromptAge`
`promptFormatters.ts` has `formatRelativePromptAge` (line 187) and `formatPromptRelativeAge` (line 338) doing the same thing. Keep one, alias or redirect the other, update callers.

### 5.4 Extract conversation window assembly
In `src/store/storeMessages.ts`, extract the shared window assembly logic from `searchConversationWindows` and `searchConversationWindowsByEmbedding` into a shared `assembleConversationWindows()` helper.

### 5.5 Consolidate magic numbers in memory system
Replace hardcoded `.slice(0, N)` limits in `memoryManager.ts` with named constants:
```ts
const MAX_USER_FACTS = 20;
const MAX_GUIDANCE_FACTS = 8;
const MAX_SELF_FACTS = 10;
const MAX_LORE_FACTS = 10;
// etc.
```
Same for `memoryHelpers.ts` limits (190, 220, 180, 45).

### 5.6 Consolidate query length constants
In `src/tools/replyTools.ts`, replace four identical `MAX_*_QUERY_LEN = 220` with a single `MAX_TOOL_QUERY_LEN`.

**Estimated savings: ~250 lines, reduced bug surface**

---

## Phase 6: Test Cleanup

Remove bloat, fix brittle patterns.

### 6.1 Delete trivial/tautological tests
- Delete `dashboard/src/components/SettingsForm.test.ts` -- tests a 4-line typeof check
- Evaluate `dashboard/src/tabState.test.ts` for removal -- tests a trivial localStorage wrapper

### 6.2 Fix brittle test patterns
- `VoiceModeSettingsSection.test.tsx`: Replace `renderToStaticMarkup` + `.includes()` string matching with React Testing Library queries
- `LlmProviderOptions.test.ts`: Replace hardcoded provider array assertion with structural property tests (e.g., "vision providers are a subset of general providers")

---

## Phase 7: Structural Refactors (Larger Effort)

These are the bigger wins but require more careful execution. Each is independently valuable.

### 7.1 Extract BaseAgentSession (**scope reduced by swarm-launcher redesign**)
Original framing: a shared base class for all four agent sessions, sized to support an `onProgress` callback for async code-task work.

After the swarm-launcher redesign, `CodeAgentSession` and `CodexCliAgentSession` are deleted along with the in-process session machinery for code work. `onProgress` is no longer needed (progress comes through swarm `annotate(kind="progress")` events). The remaining `BaseAgentSession` need is:

- `BrowserAgentSession` (and possibly `CodexAgentSession` if the OpenAI Codex API agent still uses session shape)
- `MinecraftAgentSession` (if it lives on the same framework)

Recommendation: defer until the swarm-launcher redesign lands, then re-evaluate whether the remaining 1–2 sessions justify a base class at all, or whether inlining the lifecycle into each is simpler. Estimated savings drop from ~400 lines to ~100–150 lines.

### 7.2 Decompose VoiceMonitor.tsx and VoiceDebugger.tsx
Split each into focused sub-components:

`dashboard/src/components/voiceMonitor/`:
- `VoiceMonitor.tsx` (main container, ~200 lines)
- `SessionCard.tsx`
- `ParticipantList.tsx`
- `MusicDetail.tsx`
- `StreamWatchDetail.tsx`
- `LatencyPanel.tsx`
- `McpPanel.tsx`
- `ToolCallLog.tsx`
- `ConversationContext.tsx`
- `PromptStateViewer.tsx`

`dashboard/src/components/voiceDebugger/`:
- `VoiceDebugger.tsx` (main container)
- `TurnReconstructor.ts` (the 360-line business logic function, with its own tests)
- `FlightLog.tsx`
- `TurnCard.tsx`
- `AnomalyDetection.ts`

### 7.3 Slim down botRuntimeFactories.ts (**affects async code task wiring**)
Replace the manual partial-application pattern with a simpler approach. Instead of:
```ts
buildReplyPipelineRuntime(bot) {
  return { runSearch: (args) => runSearch(ctx, args), runBrowse: (args) => runBrowse(ctx, args), ... }
}
```
Consider passing the context objects directly to consumers, letting them call functions with the context as the first arg. This eliminates the entire runtime factory layer (~560 lines).

The async code task design adds `BackgroundTaskRunner` as a new component on `ClankerBot` with a `deliverAsyncTaskResult` method. If this refactor lands first, the new component integrates cleanly without following the over-engineered pattern. If async lands first, it creates yet another runtime that would need to be un-wrapped later.

### 7.4 Close the VoiceSession index signature
Remove `[key: string]: unknown` from the `VoiceSession` interface in `voiceSessionTypes.ts`. Audit all dynamic property accesses and migrate them to explicit typed fields. This restores TypeScript's type safety for the most-passed-around object in the voice system.

### 7.5 Extract named constants for all magic numbers
Sweep through `memoryManager.ts`, `memoryHelpers.ts`, `replyTools.ts`, `videoContextService.ts`, `storeMessages.ts`, and `storeActionLog.ts` replacing all bare numeric literals with named constants at the top of each file.

---

## Execution Order

```
Phase 1 (Dead Code)          ~2 hours    No dependencies
Phase 2 (Type Dedup)         ~2 hours    No dependencies
Phase 3 (Dashboard Hygiene)  ~1 hour     No dependencies
Phase 4 (Import Aliases)     ~2 hours    No dependencies
  -- run tests, verify --
Phase 5 (Logic Dedup)        ~3 hours    After phases 1-2
Phase 6 (Test Cleanup)       ~1 hour     After phase 3
  -- run tests, verify --
Phase 7 (Structural)         ~6 hours    After phases 1-5
  7.1 BaseAgentSession       ~2 hours
  7.2 Dashboard decomp       ~2 hours
  7.3 Runtime factories      ~1 hour
  7.4 VoiceSession index sig ~0.5 hours
  7.5 Magic numbers          ~0.5 hours
```

Phases 1-4 are independent and can be done in parallel or any order. Total estimated effort: ~17 hours across all phases.

---

## Sequencing with Async Code Task Work (superseded)

This section originally laid out how cleanup phases should interleave with the async code-task design. That design no longer exists — the [swarm-launcher redesign](./swarm-launcher-redesign-plan.md) replaces it by deleting the in-process code-session path entirely (`codeAgent.ts`, `codexCliAgent.ts`, `backgroundTaskRunner.ts`, and the `asyncDispatch` settings tree all go away).

Practical implications for this cleanup plan:

- Phase 2.4 (`EMPTY_USAGE` consolidation) shrinks: two of its target files are deleted by the redesign.
- Phase 7.1 (`BaseAgentSession` extraction) loses most of its rationale: only browse / minecraft sessions remain on the framework. Defer until the redesign lands and re-scope from there.
- Other cleanup phases (1, 3, 4, 5, 6, 7.2, 7.4, 7.5) are independent of the redesign and can land on either side of it.

If you need a sequencing diagram, work it against the [swarm-launcher parallel-execution plan](./swarm-launcher-redesign-parallel-execution.md) instead of this section.
