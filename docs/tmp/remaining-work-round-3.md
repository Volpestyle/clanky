# Remaining Work — Round 3

**Date:** March 6, 2026
**Baseline:** 704 tests passing, 0 `as any` casts, 0 `manager: any`, 0 `bot: any`
**Overall Grade:** B+
**Target:** A-/A

---

## Current State Snapshot

| Metric | Value |
|--------|-------|
| Total TypeScript | 115,236 lines |
| Tests | 704 pass / 0 fail |
| `as any` casts (production) | 0 |
| `: any` parameter types (production) | ~30 |
| `.catch(() => undefined)` | 40 |
| Loose files in `src/` root | 26 |
| Largest file | voiceSessionManager.ts @ 7,655 |

---

## Remaining Issues (Prioritized)

### 1. Voice Session Manager Still 7,655 Lines

Down from 12,819, but still the largest file by far. The extracted modules are typed and the `manager: any` params are gone, but the orchestrator retains many delegation stubs. The stub pruning pass in the last round was modest (~60 lines reduced).

**What's left:** Audit remaining methods — identify pure delegation stubs, migrate callers to `manager.<module>` access, delete dead wrappers. Target: ~4,000–5,000 lines.

### 2. ~30 `: any` Parameter Types in Production Code

These aren't `as any` casts — they're untyped function signatures. Hotspots:

| File | Count | Pattern |
|------|-------|---------|
| `src/voice/voiceSessionTypes.ts` | ~20 | Session state fields typed as `any` (provider, source, pendingResults, interruptionPolicy, brainContextEntries, etc.) |
| `src/dashboard/routes*.ts` | ~3 files | `app: any, deps: any` function signatures |
| `src/store/storeAdaptiveDirectives.ts` | 7 | `store: any` parameter types |
| `src/voice/voiceSessionManager.ts` | 1 | `session: any` |
| `src/voice/voiceRuntimeState.ts` | 1 | `field: any` |

The `voiceSessionTypes.ts` ones are the most impactful — they define the session shape that every voice module reads.

### 3. 40 `.catch(() => undefined)` Fire-and-Forget Patterns

Down from 73. The bot.ts batch was addressed in earlier rounds. Remaining are mostly in voice files (~25) and scattered across services (~15).

### 4. 26 Loose Files in `src/` Root

Files that belong in existing subdirectories:

| File | Natural home |
|------|-------------|
| `llmClaudeCode.ts`, `llmCodex.ts` | `src/llm/` |
| `botHelpers.ts` | `src/bot/` |
| `promptCore.ts`, `prompts.ts` | `src/prompts/` |
| `screenShareSessionManager.ts` | `src/voice/` or `src/bot/` |
| `memory.ts` | `src/memory/` |
| `store.ts` | `src/store/` |
| `automation.ts`, `discovery.ts` | `src/bot/` |
| `pricing.ts` | `src/llm/` or `src/store/` |
| `directAddressConfidence.ts` | `src/bot/` |
| `gif.ts`, `video.ts`, `search.ts` | `src/services/` or similar |

Keep in root: `app.ts` (entrypoint), `config.ts`, `utils.ts`, `retry.ts`, `dashboard.ts`

### 5. voiceToolCalls.ts Still 2,015 Lines

Untouched by the decomposition. Large file with tool execution logic. Lower priority since it's focused on one domain.

### 6. Pre-Existing LSP/Type Errors (Settings Schema Drift)

`settingsNormalization.ts` and `settingsFormModel.ts` reference voice settings fields (`runtimeMode`, `xai`, `elevenLabsRealtime`, `geminiRealtime`, `sttPipeline`, `generation`) that don't exist in `DEFAULT_SETTINGS`. These are suppressed at runtime by the normalizer but cause LSP errors. Fix: add the missing fields to `DEFAULT_SETTINGS` in `settingsSchema.ts`.

`bot.ts` has LSP errors around `VoiceReplyRuntime` and `ReplyPipelineRuntime` interfaces missing methods (`runModelRequestedBrowserBrowse`, `buildBrowserBrowseContext`, `runModelRequestedCodeTask`, `resolveMediaAttachment`, `getAutoIncludeImageInputs`). Fix: add missing methods to the runtime interfaces or update the call sites.

---

## Proposed Plans

### Plan A: Voice Session Manager Stub Pruning + Session Type Hardening (1 worktree)

**Scope:** `src/voice/` exclusively

- Aggressive stub pruning in `voiceSessionManager.ts` — target ~4,000–5,000 lines
- Type the ~20 `: any` fields in `voiceSessionTypes.ts` with proper types
- Fix the 1 `session: any` in voiceSessionManager.ts and 1 `field: any` in voiceRuntimeState.ts
- Audit remaining ~25 `.catch(() => undefined)` in voice files
- Fix the settings schema drift — add missing voice fields to `DEFAULT_SETTINGS`

**Target outcome:** VSM under 5,000 lines, 0 `: any` in voice types, LSP errors resolved.

### Plan B: Source Tree Reorganization + Remaining `: any` Cleanup (1 worktree)

**Scope:** `src/` root files, `src/dashboard/`, `src/store/`

- Move ~15 loose files from `src/` root into their natural subdirectories
- Update all import paths across the codebase
- Type the `app: any, deps: any` in dashboard route files (~3 files)
- Type the `store: any` params in `storeAdaptiveDirectives.ts` (7 instances)
- Fix the `bot.ts` LSP errors (missing methods on runtime interfaces)
- Audit remaining ~15 non-voice `.catch(() => undefined)` patterns

**Target outcome:** `src/` root has ≤10 files, 0 `: any` outside voice, clean LSP.

---

## What Gets Us to A-

If both plans complete:

| Module | Current | Projected |
|--------|---------|-----------|
| Voice session manager | C+/B- | **B+** (under 5,000 lines, typed session, no `any`) |
| Bot core | B+ | **A-** (clean root, resolved LSP errors) |
| Settings/config | B+ | **A-** (LSP errors resolved, schema drift fixed) |
| Everything else | Stays at current grades | |
| **Overall** | **B+** | **A-** |

The gap from A- to A would require deeper structural work — explicit state machine in voice, test coverage expansion for new modules, refactoring `voiceToolCalls.ts` (2,015 lines). That's a future round.

---

## Estimated Effort

| Plan | Effort |
|------|--------|
| A — Voice stub pruning + session types | 3–4 sessions |
| B — Source tree reorg + remaining `: any` | 2–3 sessions |
| **Total** | **5–7 sessions** |

No file overlap between plans. Safe to run concurrently.
