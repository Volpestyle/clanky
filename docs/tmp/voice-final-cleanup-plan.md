# Voice Session Manager Final Cleanup Plan (Revised)

**Date:** March 6, 2026 (revised after round 2 completion)
**Target:** `src/voice/` — voiceSessionManager.ts (7,655 lines), voiceSessionTypes.ts (~20 `: any` fields), settings schema drift, ~25 fire-and-forget patterns
**Goal:** Prune delegation stubs, type session state fields, fix settings schema drift, audit fire-and-forget patterns.

---

## Current State

The voice decomposition extracted 9 modules and a follow-up round typed all `manager: any` params (39 → 0). What remains:

| Metric | Value |
|--------|-------|
| `voiceSessionManager.ts` | 7,655 lines |
| `manager: any` params | **0** (done) |
| `: any` fields in voiceSessionTypes.ts | ~20 |
| `: any` in voiceSessionManager.ts | 1 (`session: any`) |
| `: any` in voiceRuntimeState.ts | 1 (`field: any`) |
| `.catch(() => undefined)` in voice files | ~25 |
| Settings schema drift (LSP errors) | ~20 errors across settingsNormalization + settingsFormModel + agentStack |
| Target VSM size | ~4,000–5,000 lines |

**Note:** `voiceToolCalls.ts` (2,015 lines) is handled by a separate worktree. Do not touch it.

---

## Phase 1: Type `: any` fields in voiceSessionTypes.ts (~20 fields)

The session state interface has ~20 fields typed as `any`. These define the shape that every voice module reads. Typing them properly propagates type safety through all extracted modules.

**Hotspot fields:** provider, source, pendingResults, interruptionPolicy, brainContextEntries, catalogCandidates, recentVoiceTurns, and others.

**Approach:** For each `: any` field, trace its usage across the codebase to determine the actual type. Replace with the concrete type or a narrow union.

**Files changed:** `voiceSessionTypes.ts`, possibly extracted modules that read these fields
**Risk:** Medium — changing a session field type may surface errors in modules that assumed `any`.

---

## Phase 2: Fix settings schema drift

`settingsNormalization.ts`, `settingsFormModel.ts`, and `agentStack.ts` reference voice settings fields that don't exist in `DEFAULT_SETTINGS`:

- `runtimeMode`
- `xai` (voice provider section)
- `elevenLabsRealtime`
- `geminiRealtime`
- `sttPipeline`
- `generation` (voice section)

**Fix:** Add the missing fields to `DEFAULT_SETTINGS` in `src/settings/settingsSchema.ts` with appropriate defaults. This resolves ~20 LSP errors that have been present since the `Settings` type was introduced.

**Files changed:** `src/settings/settingsSchema.ts`
**Risk:** Low — additive, no logic change. The normalizer already handles these fields; the schema just needs to declare them.

**Important:** The settings schema file is shared territory. Only add the missing voice fields — do not restructure the file or change existing fields.

---

## Phase 3: Prune delegation stubs from voiceSessionManager.ts

The session manager still has thin wrapper methods that just forward to extracted modules.

**Approach:**
- Audit every method — identify which are pure delegation (`this.<module>.method()` with no additional logic)
- For runtime callers: migrate to `manager.<module>` access
- For test callers: update test helpers to call modules directly where appropriate
- Delete the dead stubs
- Keep methods that are genuine orchestration (coordinate multiple modules, route events)

**Target:** Reduce voiceSessionManager.ts from 7,655 to ~4,000–5,000 lines.

**Files changed:** `voiceSessionManager.ts`, possibly test files that call removed stubs
**Risk:** Medium — must ensure all callers are migrated before deleting stubs.

---

## Phase 4: Fix remaining `: any` in voice files

- `voiceSessionManager.ts` — 1 `session: any` param
- `voiceRuntimeState.ts` — 1 `field: any` param

**Risk:** Low.

---

## Phase 5: Fire-and-forget audit (~25 patterns in voice files)

**Triage by category:**

| Category | Action |
|----------|--------|
| Cleanup/teardown (session end, disconnect, timer clear) | **Keep** — errors during cleanup are expected |
| Voice state mutations (drain, flush, sync) | **Audit** — some may mask real bugs |
| Discord/external API calls (send message, edit) | **Log** — `.catch(err => log.warn("...", { err }))` |

**Files to audit:**
- `voiceSessionManager.ts` (~18 patterns)
- `voiceAsrBridge.ts` (~4)
- `voiceMusicPlayback.ts` (~1)
- `voiceJoinFlow.ts` (~1)
- `voiceStreamWatch.ts` (~1)

**Skip:** `voiceToolCalls.ts` — owned by a separate worktree.

**Risk:** Minimal — adding logging, not changing behavior.

---

## Verification

Per-phase:
1. `bun run typecheck` — zero errors
2. `bun run test` — all 704+ tests pass
3. `bun run lint` — clean (at minimum `bunx eslint` on changed files)

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| 1 — Type session fields | 1–2 sessions |
| 2 — Fix settings schema drift | 30 min |
| 3 — Prune delegation stubs | 1–2 sessions |
| 4 — Fix remaining `: any` | 15 min |
| 5 — Fire-and-forget audit | 1 session |
| **Total** | **3–5 sessions** |

---

## File Ownership

This plan owns `src/voice/` exclusively, plus `src/settings/settingsSchema.ts` (voice field additions only).

Do not touch:
- `src/bot.ts` or `src/bot/` (separate worktree)
- `src/voice/voiceToolCalls.ts` (separate worktree)
- `src/llm.ts` or `src/llm/`
- `src/store/` (except reading settingsNormalization to understand drift)
- `dashboard/` (the settingsFormModel LSP errors resolve once schema is fixed)
