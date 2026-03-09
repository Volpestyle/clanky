# Memory Retrieval Rewrite: Implementation Plan

Archived completed plan. Most of this work has since landed, so file paths and deletion notes below should be read as historical implementation context rather than current instructions.

## Goal

Replace the per-turn embedding-based memory retrieval (`buildPromptMemorySlice`) with SQLite-only fact profiles cached at the voice session level. Move semantic ranking off the critical path — it stays alive for on-demand `memory_search` tool calls only.

## Design Reference

See `docs/memory-system.md` sections:
- "Fact profile retrieval (`loadUserFactProfile`)"
- "Tiered fact storage and eviction"
- "On-demand search via `memory_search` tool"

## Phase 1: New fact profile loader

### 1a. Add `loadUserFactProfile` to `MemoryManager`

**File:** `src/memory/memoryManager.ts`

Add a new method `loadUserFactProfile({ userId, guildId })` that:
- Queries `memory_facts` for active facts where `subject = userId AND guild_id = guildId AND is_active = 1`
- Orders by `confidence DESC, updated_at DESC`
- Returns `{ userFacts: MemoryFactRow[] }` (limit 20)
- Pure SQLite, no embedding call, no async API calls

This may need a new store method if `getFactsForSubjects` doesn't support the right ordering/filtering. Check existing store methods first.

### 1b. Add `loadGuildFactProfile` to `MemoryManager`

**File:** `src/memory/memoryManager.ts`

Add a new method `loadGuildFactProfile({ guildId })` that:
- Queries `memory_facts` for active facts where `subject IN ("__self__", "__lore__") AND guild_id = guildId AND is_active = 1`
- Orders by `confidence DESC, updated_at DESC`
- Returns `{ selfFacts: MemoryFactRow[], loreFacts: MemoryFactRow[] }` (limit 10 each)
- Pure SQLite

### 1c. Add `loadFactProfile` convenience wrapper

Combines user + guild profiles into the shape consumers expect:

```typescript
function loadFactProfile({ userId, guildId }): {
  userFacts: MemoryFactRow[];
  relevantFacts: MemoryFactRow[];  // self + lore combined
}
```

This returns the same `{ userFacts, relevantFacts }` shape that `buildPromptMemorySlice` returns, so downstream consumers don't change their access patterns.

Note: `relevantMessages` was part of the old slice but is a separate lexical search against the `messages` table. Check whether any consumer actually uses `relevantMessages` from the memory slice on the voice path. If so, keep it as a separate synchronous store call (it's already SQLite-only). If not, drop it.

## Phase 2: Session-level fact profile caching

### 2a. Add `factProfiles` to voice session state

**File:** `src/voice/voiceSessionTypes.ts`

Add to `VoiceSession`:
```typescript
factProfiles: Map<string, { userFacts: MemoryFactRow[]; loadedAt: number }>;
guildFactProfile: { selfFacts: MemoryFactRow[]; loreFacts: MemoryFactRow[]; loadedAt: number } | null;
```

### 2b. Load profiles on voice session creation

**File:** `src/voice/voiceJoinFlow.ts` or `src/voice/sessionLifecycle.ts`

When a session is created:
1. Load guild fact profile (self + lore) → store on `session.guildFactProfile`
2. Load fact profiles for any users already in the voice channel → store on `session.factProfiles`

### 2c. Update profiles on join/leave

**File:** `src/voice/voiceSessionManager.ts` in `handleVoiceStateUpdate`

- On `movedIntoSession`: load the joining user's fact profile, add to `session.factProfiles`
- On `movedOutOfSession`: remove the leaving user from `session.factProfiles`

### 2d. Invalidate cache on `memory_write`

**Files:** `src/voice/voiceToolCallMemory.ts`, `src/memory/memoryToolRuntime.ts`

After a successful `memory_write`:
- If there's an active voice session for the guild, refresh the affected user's profile in `session.factProfiles`
- If the write was to `__self__` or `__lore__`, refresh `session.guildFactProfile`

## Phase 3: Replace `loadPromptMemorySlice` consumers

### 3a. Update `loadConversationContinuityContext`

**File:** `src/bot/conversationContinuity.ts`

Replace the `loadPromptMemorySlice` callback parameter with `loadFactProfile`:
- Change the parameter from `loadPromptMemorySlice?: (payload) => Promise<unknown>` to `loadFactProfile?: (payload: { userId: string; guildId: string }) => { userFacts; relevantFacts }`
- Note: `loadFactProfile` is **synchronous** (returns cached data or fast SQLite). No need for `Promise.race` timeout.
- Remove `resolvePromptMemorySlice` private function entirely
- Remove `memoryTimeoutMs` parameter (no longer needed — no async API call to timeout)
- Remove imports of `emptyPromptMemorySlice` and `normalizePromptMemorySlice`

The return shape stays the same: `{ memorySlice, recentWebLookups, recentConversationHistory, adaptiveDirectives }`.

### 3b. Update legacy voice file-ASR caller

**File:** `src/bot/voiceReplies.ts`

In `generateVoiceTurnReply`:
- Remove `VOICE_MEMORY_PREFETCH_WAIT_MS` constant
- Replace the `loadPromptMemorySlice` callback passed to `loadConversationContinuityContext` with a function that reads from `session.factProfiles[speakerUserId]` + `session.guildFactProfile`
- Remove `memoryTimeoutMs` parameter
- Remove the `normalizeVoiceMemorySlice` / `VoiceMemorySlice` type and related helpers if they only exist for this path

### 3c. Update voice realtime instruction refresh caller

**File:** `src/voice/instructionManager.ts`

In the instruction refresh path:
- Replace the `loadPromptMemorySlice` callback with one that reads from session fact profile cache
- Remove the `loadPromptMemorySliceFromMemory` import

### 3d. Update text chat reply pipeline caller

**File:** `src/bot/replyPipeline.ts`

- Replace `loadPromptMemorySlice` callback with `loadFactProfile` that calls `memoryManager.loadFactProfile()` directly (no caching needed for text — per-turn SQLite is fast enough)

### 3e. Update automation engine caller

**File:** `src/bot/automationEngine.ts`

- Same change as text chat: replace callback with direct `loadFactProfile` call

### 3f. Update `botRuntimeFactories.ts` wiring

**File:** `src/bot/botRuntimeFactories.ts`

- Remove `loadPromptMemorySlice` wiring from all three runtime factory functions (automation, reply pipeline, voice reply)
- Wire up `loadFactProfile` instead (or let each consumer call `memoryManager.loadFactProfile` directly)

### 3g. Update `botContext.ts` types

**File:** `src/bot/botContext.ts`

- Remove `LoadPromptMemorySliceFn` type alias
- Add `LoadFactProfileFn` type if needed

## Phase 4: Tiered eviction

### 4a. Update `archiveOldFactsForSubject`

**File:** `src/store/storeMemory.ts`

Change eviction logic:
1. Separate active facts into core (`fact_type IN ('profile', 'relationship')`) and contextual (everything else)
2. Archive contextual facts first when total exceeds cap
3. Only archive core facts if contextual are within budget and total still exceeds cap
4. Core facts are never evicted to make room for contextual facts

Define constants:
- `CORE_FACT_TYPES = ['profile', 'relationship']`
- Per-subject core cap: 20 (configurable)

### 4b. Update tests

**File:** `src/store/store.memory.test.ts`

Update existing `archiveOldFactsForSubject` test to cover tiered eviction behavior:
- Core facts survive when contextual facts are archived
- Core facts archive only when core cap is exceeded
- Mixed scenarios

## Phase 5: Delete legacy code

**IMPORTANT:** Only delete after all consumers are migrated and tests pass.

### Files to delete entirely:
- `src/memory/promptMemorySlice.ts` — all exports (`emptyPromptMemorySlice`, `normalizePromptMemorySlice`, `loadPromptMemorySliceFromMemory`) are dead

### Functions to delete from existing files:
- `src/memory/memoryManager.ts`: `buildPromptMemorySlice`, `selectHybridFacts`
- `src/bot/memorySlice.ts`: `loadPromptMemorySlice` function (keep other exports like `buildMediaMemoryFacts`, `loadRelevantMemoryFacts` if they're still used — check first)
- `src/bot/conversationContinuity.ts`: `resolvePromptMemorySlice` (already removed in Phase 3a)

### Dashboard endpoint to delete:
- `src/dashboard/routesVoice.ts`: `POST /api/memory/simulate-slice` endpoint (lines ~681-707)
- `src/dashboard.ts`: remove `buildPromptMemorySlice` from `DashboardMemory` interface

### Wiring to delete:
- `src/bot/botRuntimeFactories.ts`: remove old `loadPromptMemorySlice` wiring (3 sites)
- `src/bot/botContext.ts`: remove `LoadPromptMemorySliceFn` type

### Test mocks to update:
- `src/bot/memorySlice.test.ts`: rewrite tests to cover `loadFactProfile` instead
- `src/bot/bot.loop.test.ts`: remove `buildPromptMemorySlice` mock stubs
- `src/voice/voiceSessionManager.addressing.test.ts`: remove `buildPromptMemorySlice` mock stubs
- `src/testHelpers.ts`: remove `buildPromptMemorySlice` mock stub

## Phase 6: Verify

1. Run `bun run test` — all unit/integration tests must pass
2. Run `bun run typecheck` — no type errors
3. Verify no remaining references to deleted symbols:
   - `grep -r "buildPromptMemorySlice" src/`
   - `grep -r "selectHybridFacts" src/`
   - `grep -r "loadPromptMemorySliceFromMemory" src/`
   - `grep -r "emptyPromptMemorySlice" src/`
   - `grep -r "normalizePromptMemorySlice" src/`
   - `grep -r "resolvePromptMemorySlice" src/`
   - `grep -r "VOICE_MEMORY_PREFETCH_WAIT_MS" src/`
   - `grep -r "simulate-slice" src/`

## What stays untouched

- `searchDurableFacts` — used by `memory_search` tool, dashboard, followup, thought engine
- `rankHybridCandidates` → `getSemanticScoreMap` → `getQueryEmbeddingForRetrieval` — shared by `searchDurableFacts`
- `memory_search` / `memory_write` tool schemas and dispatchers
- All embedding infrastructure (still used for `memory_search` and fact write-time embedding)
- Daily reflection pipeline
- Message ingest pipeline
- `MEMORY.md` markdown refresh

## Expected latency impact

Before (per voice turn):
```
embedding API call:     ~500-1500ms (when it doesn't timeout at 120ms)
semantic ranking:       ~50ms
total memory overhead:  ~550-1600ms on critical path
```

After (per voice turn):
```
SQLite fact lookup:     <1ms (cached: 0ms)
total memory overhead:  <1ms
```

The entire `asrToGenerationStartMs` gap (~1.2s in the analyzed logs) should collapse to near-zero.
