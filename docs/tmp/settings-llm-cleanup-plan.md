# Settings & LLM Cleanup Plan

**Date:** March 6, 2026
**Scope:** `settingsNormalization.ts` (224 `as any`, 1,304-line monolith), `llm.ts` (2,131-line god-file), duplicated constants, fire-and-forget patterns
**Goal:** Eliminate all `as any` casts in settings, decompose LLM service into domain modules, fix hygiene issues.

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Settings Normalization Overhaul](#2-settings-normalization-overhaul)
3. [LLM Service Decomposition](#3-llm-service-decomposition)
4. [Hygiene Fixes](#4-hygiene-fixes)
5. [Phased Execution Plan](#5-phased-execution-plan)
6. [Verification Strategy](#6-verification-strategy)

---

## 1. Current State

### What's already done

- `Settings` type exported from `settingsSchema.ts` (via `DeepWiden<typeof DEFAULT_SETTINGS>` + manual overrides)
- `SettingsInput = DeepPartial<Settings>` for incoming data
- `agentStack.ts` accessor functions fully typed (0 `as any`)
- Dead `src/llm/provider*.ts` files deleted
- `Promise.all` → `Promise.allSettled` already done in reply pipeline
- `migrateLegacySettings` already removed

### What remains

| Item | File | Severity |
|------|------|----------|
| 224 `as any` casts | `settingsNormalization.ts` | High |
| 1,304-line monolith `normalizeSettings()` | `settingsNormalization.ts` | High |
| Triple-layer redundant defaulting | normalization + storeSettings + agentStack | Medium |
| 2,131-line god-file (7 domains) | `llm.ts` | Medium |
| Duplicated `LORE_SUBJECT`/`SELF_SUBJECT` | `memory.ts` + `memoryHelpers.ts` | Low |
| 73 fire-and-forget `.catch(() => undefined)` | 22 files (24 in VSM, 8 in bot.ts) | Low |

---

## 2. Settings Normalization Overhaul

### Root Cause of the 224 `as any` Casts

`normalizeSettings(raw: unknown)` calls `deepMerge(DEFAULT_SETTINGS, canonicalInput)` which returns a loosely typed record. It then destructures each top-level section as `Record<string, unknown>`:

```typescript
const interaction = isRecord(merged.interaction) ? merged.interaction : {};
// Every sub-property access needs `as any`:
(interaction.activity as any)?.replyEagerness  // 224 of these
```

The `Settings` type already exists. The fix is to **type the `deepMerge` output** so the destructured sections carry their real types.

### The Fix: Typed Section Normalizers

Replace the 1,304-line monolith with **per-section normalizer functions** that receive typed inputs.

#### Step 1: Type the merge output

```typescript
export function normalizeSettings(raw: unknown): Settings {
  const canonicalInput: SettingsInput = isRecord(raw) ? raw : {};
  const merged = deepMerge(DEFAULT_SETTINGS, canonicalInput) as Settings;
  
  return {
    identity: normalizeIdentitySection(merged.identity),
    persona: normalizePersonaSection(merged.persona),
    prompting: normalizePromptingSection(merged.prompting),
    permissions: normalizePermissionsSection(merged.permissions),
    interaction: normalizeInteractionSection(merged.interaction),
    agentStack: normalizeAgentStackSection(merged.agentStack, canonicalInput.agentStack),
    memory: normalizeMemorySection(merged.memory),
    directives: normalizeDirectivesSection(merged.directives),
    initiative: normalizeInitiativeSection(merged.initiative),
    voice: normalizeVoiceSection(merged.voice),
    media: normalizeMediaSection(merged.media),
    music: normalizeMusicSection(merged.music),
    automations: normalizeAutomationsSection(merged.automations),
  };
}
```

One `as Settings` cast on the `deepMerge` output — this is justified because `deepMerge(DEFAULT_SETTINGS, partial)` structurally produces a `Settings` shape, and every field is immediately re-normalized below. This single cast replaces 224.

#### Step 2: Per-section normalizers

Each section normalizer receives its **typed** section and returns the normalized version:

```typescript
function normalizeIdentitySection(section: Settings["identity"]): Settings["identity"] {
  return {
    botName: normalizeString(section.botName, DEFAULT_SETTINGS.identity.botName, 64),
    aliases: normalizeBoundedStringList(section.aliases, DEFAULT_SETTINGS.identity.aliases, BOT_NAME_ALIAS_MAX_ITEMS, 64),
  };
}

function normalizePermissionsSection(section: Settings["permissions"]): Settings["permissions"] {
  return {
    allowedChannelIds: normalizeStringList(section.allowedChannelIds, DEFAULT_SETTINGS.permissions.allowedChannelIds, 100),
    blockedUserIds: normalizeStringList(section.blockedUserIds, DEFAULT_SETTINGS.permissions.blockedUserIds, 200),
    // ... each field explicitly typed, no `as any` needed
  };
}
```

Because the parameter is `Settings["permissions"]` (not `Record<string, unknown>`), TypeScript knows every sub-property type. No casts needed.

#### Step 3: Extract to domain files (optional, reduces file size)

The per-section normalizers can stay in `settingsNormalization.ts` or be split into domain files:

```
src/store/settingsNormalization.ts          (~100 lines — orchestrator + shared helpers)
src/store/normalize/identity.ts             (~20 lines)
src/store/normalize/persona.ts              (~30 lines)
src/store/normalize/prompting.ts            (~50 lines)
src/store/normalize/permissions.ts          (~40 lines)
src/store/normalize/interaction.ts          (~150 lines)
src/store/normalize/agentStack.ts           (~250 lines — largest section)
src/store/normalize/memory.ts               (~60 lines)
src/store/normalize/initiative.ts           (~200 lines)
src/store/normalize/voice.ts                (~200 lines)
src/store/normalize/media.ts                (~80 lines)
src/store/normalize/music.ts                (~30 lines)
src/store/normalize/automations.ts          (~40 lines)
```

Whether to split into files or keep as one file with section functions is a judgment call. The section functions alone solve the `as any` problem. Splitting reduces the file from 1,621 to ~100 lines but adds 12 small files.

### Triple-Layer Defaulting

The three layers:
1. **Normalization** (`normalizeSettings`) — `deepMerge(DEFAULT_SETTINGS, input)` + per-field clamping
2. **Persistence rewrite** (`storeSettings.ts: rewriteRuntimeSettingsRow`) — re-normalizes on every DB read, rewrites if changed
3. **Accessor merge** (`agentStack.ts`) — preset-aware resolution with own defaults

Layer 1 and 2 are redundant — if normalization produces correct output, the persistence rewrite should be a no-op. The fix is to:
- Keep Layer 1 (normalization) as the single source of truth
- Simplify Layer 2 to just call `normalizeSettings()` without the rewrite-on-read behavior (or add a dirty check to skip the rewrite when nothing changed — which it does, but the comparison itself is wasteful)
- Keep Layer 3 (agentStack accessors) — these do preset resolution, which is a distinct concern

This is a minor optimization, not critical. Address after the `as any` elimination.

---

## 3. LLM Service Decomposition

### Current: 7 domains in one class (2,131 lines)

| Domain | Methods | Lines | Dependencies |
|--------|---------|-------|-------------|
| Provider dispatch + model resolution | 6 methods | ~100 | SDK clients |
| Chat generation | 5 methods | ~340 | SDK clients |
| Tool loop chat | 1 method + helpers | ~200 | SDK clients |
| Claude Code CLI | 4 methods | ~250 | Claude CLI path |
| Memory extraction | 5 methods | ~220 | SDK clients |
| Media generation | 7 methods | ~350 | SDK clients, xAI HTTP |
| Audio (ASR + TTS + embeddings) | 5 methods | ~240 | SDK clients |

### Why it's a class

`LLMService` holds SDK client instances (`this.openai`, `this.xai`, `this.anthropic`) and a persistent Claude Code brain session. These are legitimate instance state — the class pattern is correct. The problem is that 7 unrelated domains share one class because they all need SDK clients.

### Target Architecture

```
LLMService (thin orchestrator — client construction, provider resolution)
│
├── src/llm/chatGeneration.ts       (generate, callOpenAI, callOpenAiResponses, callXai, callAnthropic)
├── src/llm/toolLoopChat.ts         (chatWithTools, message format converters)
├── src/llm/claudeCodeService.ts    (callClaudeCode, brain stream, memory extraction via CC)
├── src/llm/memoryExtraction.ts     (extractMemoryFacts, per-provider extraction methods)
├── src/llm/mediaGeneration.ts      (generateImage, generateVideo, capability checks, target resolution)
├── src/llm/audioService.ts         (transcribeAudio, synthesizeSpeech)
├── src/llm/embeddingService.ts     (embedText, resolveEmbeddingModel)
└── src/llm/llmHelpers.ts           (already exists — provider normalization)
```

### Extraction Pattern

Each extracted module receives the SDK clients it needs as parameters (not the full LLMService):

```typescript
// src/llm/mediaGeneration.ts
import type { OpenAI } from "openai";

export interface MediaGenerationDeps {
  readonly openai: OpenAI | null;
  readonly xaiApiKey: string | null;
}

export async function generateImage(
  deps: MediaGenerationDeps,
  prompt: string,
  target: ImageTarget,
  settings: ImageSettings
): Promise<ImageResult> { ... }

export async function generateVideo(
  deps: MediaGenerationDeps,
  prompt: string,
  target: VideoTarget
): Promise<VideoResult> { ... }

export function isImageGenerationReady(deps: MediaGenerationDeps): boolean { ... }
export function isVideoGenerationReady(deps: MediaGenerationDeps): boolean { ... }
```

`LLMService` becomes a thin facade that constructs the deps objects and delegates:

```typescript
class LLMService {
  // SDK clients (instance state — stays on the class)
  private openai: OpenAI | null;
  private xai: OpenAI | null;
  private anthropic: Anthropic | null;
  
  // Delegation
  async generateImage(...) { return generateImage(this.mediaDeps(), ...); }
  async generateVideo(...) { return generateVideo(this.mediaDeps(), ...); }
  
  private mediaDeps(): MediaGenerationDeps {
    return { openai: this.openai, xaiApiKey: this.xaiApiKey };
  }
}
```

Alternatively, the facade methods can be removed entirely if callers access the modules directly. But the facade preserves backward compatibility during the transition — callers continue importing `LLMService` and calling `llm.generateImage()`.

### What stays on the class (~400 lines)

- Constructor + SDK client initialization
- `resolveProviderAndModel()`, `isProviderConfigured()`, `resolveDefaultModel()`
- `generate()` — the main chat orchestrator (it calls provider-specific methods)
- `callChatModel()` — provider dispatch
- Delegation methods (thin, can be removed later)
- `close()` — cleanup

### Module sizing

| Module | Lines | Methods |
|--------|-------|---------|
| `LLMService` (orchestrator) | ~400 | Constructor, dispatch, delegation |
| `chatGeneration.ts` | ~340 | `callOpenAI`, `callOpenAiResponses`, `callXai`, `callAnthropic` |
| `toolLoopChat.ts` | ~350 | `chatWithTools`, message converters (already partially exists as helpers) |
| `claudeCodeService.ts` | ~250 | `callClaudeCode`, brain stream, CC memory extraction |
| `memoryExtraction.ts` | ~220 | `extractMemoryFacts`, per-provider extraction |
| `mediaGeneration.ts` | ~350 | Image + video generation, capability checks |
| `audioService.ts` | ~160 | `transcribeAudio`, `synthesizeSpeech` |
| `embeddingService.ts` | ~80 | `embedText`, model resolution |
| **Total** | ~2,150 | |

Total grows slightly from module boilerplate. No file exceeds 400 lines. Each module is independently testable.

---

## 4. Hygiene Fixes

### 4a. Duplicated Constants

**Current:** `LORE_SUBJECT` and `SELF_SUBJECT` defined identically in both `src/memory.ts` (lines 31-32) and `src/memory/memoryHelpers.ts` (lines 4-5). Plus redundant aliases `SUBJECT_LORE`/`SUBJECT_SELF` in `memory.ts` (lines 41-42).

**Fix:** Export from one location, import in the other.

```typescript
// src/memory/memoryHelpers.ts (or a shared constants file)
export const LORE_SUBJECT = "__lore__";
export const SELF_SUBJECT = "__self__";
```

Delete the duplicates + aliases in `memory.ts`. 5-minute fix.

### 4b. Fire-and-Forget Patterns (73 instances)

73 `.catch(() => undefined)` across 22 files. These silently swallow errors.

**Triage by category:**

| Category | Count | Action |
|----------|-------|--------|
| Cleanup/teardown (session end, timer clear, disconnect) | ~35 | **Keep** — errors during cleanup are expected and non-actionable |
| Discord API calls (send message, edit, react) | ~15 | **Log** — replace with `.catch(err => log.warn("discord op failed", { err }))` |
| Network/external service (search, video, music) | ~10 | **Log** — same treatment |
| Voice state mutations (drain, flush, sync) | ~13 | **Audit** — some of these mask real bugs in the voice state machine |

**Approach:** Don't try to fix all 73 at once. Group by file:
- Phase 1: Fix the 8 in `bot.ts` (since we're decomposing it anyway)
- Phase 2: Fix the non-voice ones (~20 across 15 files)
- Phase 3: Fix the 24 in `voiceSessionManager.ts` (as part of voice decomposition)

For each, the fix is:
```typescript
// Before
promise.catch(() => undefined);

// After (for non-cleanup cases)
promise.catch(err => log.warn("descriptive message", { err }));

// Keep as-is for genuine cleanup (e.g., disconnect on session end)
```

---

## 5. Phased Execution Plan

### Phase 0: Hygiene Quick Wins (30 minutes)

1. Deduplicate `LORE_SUBJECT`/`SELF_SUBJECT` — export from `memoryHelpers.ts`, import in `memory.ts`
2. Delete redundant `SUBJECT_LORE`/`SUBJECT_SELF` aliases

**Files changed:** `memory.ts`, `memoryHelpers.ts`
**Risk:** Minimal — rename + import.
**Verification:** `bun run test`

---

### Phase 1: Settings Normalization — Eliminate `as any` (1-2 sessions)

**Goal:** Replace 224 `as any` casts with typed section normalizers. Keep `normalizeSettings()` as the public API.

**Steps:**

1. Change `normalizeSettings` signature to `normalizeSettings(raw: unknown): Settings`
2. Cast `deepMerge` output as `Settings` (1 justified cast replacing 224)
3. Extract per-section normalizer functions:
   - `normalizeIdentitySection(section: Settings["identity"]): Settings["identity"]`
   - `normalizePersonaSection(section: Settings["persona"]): Settings["persona"]`
   - `normalizePromptingSection(section: Settings["prompting"]): Settings["prompting"]`
   - `normalizePermissionsSection(section: Settings["permissions"]): Settings["permissions"]`
   - `normalizeInteractionSection(section: Settings["interaction"]): Settings["interaction"]`
   - `normalizeAgentStackSection(section: Settings["agentStack"], raw?: SettingsInput["agentStack"]): Settings["agentStack"]`
   - `normalizeMemorySection(section: Settings["memory"]): Settings["memory"]`
   - `normalizeDirectivesSection(section: Settings["directives"]): Settings["directives"]`
   - `normalizeInitiativeSection(section: Settings["initiative"]): Settings["initiative"]`
   - `normalizeVoiceSection(section: Settings["voice"]): Settings["voice"]`
   - `normalizeMediaSection(section: Settings["media"]): Settings["media"]`
   - `normalizeMusicSection(section: Settings["music"]): Settings["music"]`
   - `normalizeAutomationsSection(section: Settings["automations"]): Settings["automations"]`
4. Move each section's field normalization into its typed function
5. Remove all `as any` casts — TypeScript now knows the types through the section parameter

**Files changed:** `settingsNormalization.ts` (major rewrite, same line count ±100)
**New files:** None required (section functions can be in the same file, or split into `src/store/normalize/` if preferred)
**Lines added:** ~50 (function signatures, return type annotations)
**Lines removed:** ~0 (field normalization logic stays, just moves into typed functions)
**`as any` casts:** 224 → 1 (the `deepMerge` cast)
**Risk:** Medium — every settings consumer exercises this code. But the logic doesn't change, only the types around it.
**Verification:** `bun run typecheck` (the real gate), `bun run test` (all tests), spot-check a few normalized settings outputs match before/after.

---

### Phase 2: Settings File Split (optional, 1 session)

If Phase 1 produces a single file that's still 1,600+ lines, split the section normalizers into `src/store/normalize/*.ts`. This is purely organizational — no logic change.

**Decision gate:** If the file with typed section functions is readable and navigable at ~1,600 lines, skip this phase. If it feels unwieldy, split.

---

### Phase 3: LLM Service Decomposition (2-3 sessions)

**Ordering:** Extract leaf domains first (no cross-domain calls), then work inward.

#### 3a. Extract `src/llm/embeddingService.ts`

Move `embedText()` and `resolveEmbeddingModel()` (~80 lines). Pure leaf — no other LLM methods call these.

#### 3b. Extract `src/llm/audioService.ts`

Move `transcribeAudio()` and `synthesizeSpeech()` (~160 lines). Pure leaf.

#### 3c. Extract `src/llm/mediaGeneration.ts`

Move `generateImage()`, `generateVideo()`, `fetchXaiJson()`, all capability checks and target resolution (~350 lines). Pure leaf — called by bot, never calls other LLM methods.

#### 3d. Extract `src/llm/memoryExtraction.ts`

Move `extractMemoryFacts()`, `callMemoryExtractionModel()`, `callOpenAiMemoryExtraction()`, `callXaiMemoryExtraction()`, `callAnthropicMemoryExtraction()` (~220 lines). Calls provider methods, so depends on chat generation — but can receive them as deps.

#### 3e. Extract `src/llm/claudeCodeService.ts`

Move `callClaudeCode()`, `callClaudeCodeMemoryExtraction()`, `runClaudeCodeBrainStream()` (~250 lines). Holds its own state (brain session). Most self-contained domain.

#### 3f. Extract `src/llm/chatGeneration.ts`

Move `callOpenAI()`, `callOpenAiResponses()`, `callXaiChatCompletions()`, `callAnthropic()` (~340 lines). These are the provider-specific chat implementations.

#### 3g. Extract `src/llm/toolLoopChat.ts`

Move `chatWithTools()` and the message format converters (`buildAnthropicToolLoopMessages`, `buildOpenAiToolLoopInput`, `buildToolLoopContentFromOpenAiOutput`, etc.) (~350 lines). Some converters are already outside the class (lines 222-365) — consolidate them with `chatWithTools`.

#### 3h. Slim down LLMService

After all extractions, the class retains:
- Constructor + SDK client initialization (~30 lines)
- `generate()` — main chat orchestrator (~100 lines)
- `callChatModel()` — provider dispatch (~15 lines)
- Provider/model resolution methods (~70 lines)
- Delegation methods to extracted modules (~50 lines)
- `close()` (~5 lines)
- **Total: ~400 lines**

**Risk:** Low-medium — each extraction is mechanical. The main risk is breaking import paths for the 7 files that import from `llm.ts`. The facade pattern (keeping delegation methods on `LLMService`) avoids this entirely.
**Verification:** `bun run typecheck` + `bun run test` after each extraction.

---

### Phase 4: Fire-and-Forget Audit (1 session)

Fix the non-voice, non-bot `.catch(() => undefined)` patterns (~20 instances across 15 files). Replace with `.catch(err => log.warn(...))` where the error is actionable.

Skip the 24 in `voiceSessionManager.ts` and 8 in `bot.ts` — those get addressed as part of their respective decomposition plans.

**Files changed:** ~15 files, 1-2 lines each
**Risk:** Minimal — adding logging, not changing behavior.
**Verification:** `bun run test`

---

## 6. Verification Strategy

### Per-Phase

1. `bun run typecheck` — zero errors (the primary gate for settings work)
2. `bun run test` — all tests pass
3. `bun run lint` — clean

### Critical Test Files

| Phase | Test Files |
|-------|-----------|
| 0 (Constants) | `memory.ingest.test.ts`, any memory tests |
| 1 (Settings) | `settingsNormalization.test.ts`, `settingsFormModel.test.ts`, `bot.replyDecisionPolicy.test.ts`, `promptCore.test.ts`, `discovery.test.ts` |
| 3 (LLM) | `llm.providerSelection.test.ts`, `llm.claudeCode.test.ts`, `browseAgent.test.ts` |
| 4 (Fire-and-forget) | All tests (no behavior change, just error logging) |

### Settings Normalization Regression Test

Before starting Phase 1, snapshot the output of `normalizeSettings(DEFAULT_SETTINGS)` and `normalizeSettings({})`. After the rewrite, assert identical output. This catches any field that was accidentally dropped or mis-defaulted.

---

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| 0 — Hygiene quick wins | 30 min | Constant dedup |
| 1 — Settings `as any` elimination | 1-2 sessions | Main value delivery |
| 2 — Settings file split (optional) | 1 session | Organizational only |
| 3 — LLM decomposition | 2-3 sessions | 7 module extractions |
| 4 — Fire-and-forget audit | 1 session | 20 instances in ~15 files |
| **Total** | **5-7 sessions** | |

At current pace, 2-3 days.

---

## Conflict Surface with Other Worktrees

This plan touches **different files** than both decomposition plans:

| This plan touches | Bot plan touches | Voice plan touches |
|---|---|---|
| `settingsNormalization.ts` | No | No |
| `llm.ts` → `src/llm/*.ts` | No (imports `LLMService` type only) | No (imports `LLMService` type only) |
| `memory.ts`, `memoryHelpers.ts` | Phase 1c (memorySlice) reads `memory` | No |
| Various files (fire-and-forget) | Overlaps on `bot.ts` — **skip bot.ts in Phase 4** | Overlaps on VSM — **skip VSM in Phase 4** |

**Safe to run concurrently** as a third worktree, with one rule: skip fire-and-forget fixes in `bot.ts` and `voiceSessionManager.ts` (those worktrees own those files).

The only potential merge conflict is if the bot worktree's Phase 0 changes how `LLMService` is imported (e.g., adding it to `BotContext`). This is a trivial merge — additive on both sides.
