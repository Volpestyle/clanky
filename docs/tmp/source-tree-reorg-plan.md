# Plan B: Source Tree Reorganization + Remaining `:any` Cleanup

**Date:** March 6, 2026
**Round:** 3
**Worktree:** 1 (concurrent with Plans A, C, D — no file overlap)

---

## Objective

1. Move ~15 loose production files from `src/` root into existing subdirectories
2. Update all import paths across the codebase to match
3. Type the `app: any, deps: any` params in dashboard route files
4. Type the 7 `store: any` params in `storeAdaptiveDirectives.ts`
5. Audit ~15 non-voice `.catch(() => undefined)` fire-and-forget patterns
6. Type the untyped `createDashboardServer` parameter in `dashboard.ts`

**Target outcome:** `src/` root has ≤10 files, 0 `:any` outside voice, all tests pass.

---

## File Ownership (STRICT)

### This worktree OWNS (may modify freely):
- All files listed in the "File Moves" table below (source AND destination)
- `src/dashboard.ts`
- `src/dashboard/routesSettings.ts`
- `src/dashboard/routesMetrics.ts`
- `src/dashboard/routesVoice.ts`
- `src/store/storeAdaptiveDirectives.ts`
- Any file that needs import path updates due to file moves
- Associated test files that move with their production files

### This worktree MUST NOT modify:
- `src/voice/*` (Plan A owns this)
- `src/voice/voiceToolCalls.ts` (Plan C owns this)
- `src/bot.ts` (Plan D owns this)
- `src/bot/replyPipeline.ts` (Plan D owns this)
- `src/settings/settingsSchema.ts` (Plan A owns voice field additions)

### Shared files (import-path-only changes):
When updating imports in files owned by other worktrees, limit changes to `import` statements only. The other worktrees will be working from the pre-move paths, so conflicts will occur at merge time — these are trivially resolvable (just pick the new path).

---

## Phase 1: File Moves

### Move Table

| File | Lines | Destination | Rationale |
|------|------:|-------------|-----------|
| `src/llmClaudeCode.ts` | 804 | `src/llm/llmClaudeCode.ts` | Claude CLI integration belongs with LLM services |
| `src/llmCodex.ts` | 207 | `src/llm/llmCodex.ts` | Codex integration belongs with LLM services |
| `src/botHelpers.ts` | 1,136 | `src/bot/botHelpers.ts` | Reply parsing helpers belong with bot module |
| `src/promptCore.ts` | 278 | `src/prompts/promptCore.ts` | Core prompt building belongs with prompts module |
| `src/prompts.ts` | 7 | **DELETE** | Barrel file; inline re-exports at call sites or convert to `src/prompts/index.ts` |
| `src/memory.ts` | 1,063 | `src/memory/memoryManager.ts` | Memory orchestrator belongs in memory module (rename for clarity) |
| `src/store.ts` | 673 | `src/store/store.ts` | Store class belongs in store module |
| `src/discovery.ts` | 797 | `src/services/discovery.ts` | External service integration |
| `src/search.ts` | 756 | `src/services/search.ts` | External service integration |
| `src/gif.ts` | 172 | `src/services/gif.ts` | External service integration |
| `src/video.ts` | 1,191 | `src/video/videoContextService.ts` | Video service belongs in video module (rename for clarity) |
| `src/pricing.ts` | 370 | `src/llm/pricing.ts` | Model pricing tables belong with LLM module |
| `src/automation.ts` | 174 | `src/bot/automation.ts` | Automation validation helpers used by bot |
| `src/directAddressConfidence.ts` | 114 | `src/bot/directAddressConfidence.ts` | Voice-addressing heuristic used by bot |
| `src/screenShareSessionManager.ts` | 920 | `src/services/screenShareSessionManager.ts` | Standalone service |
| `src/runtimeActionLogger.ts` | 319 | `src/services/runtimeActionLogger.ts` | Standalone service |
| `src/publicHttpsEntrypoint.ts` | 278 | `src/services/publicHttpsEntrypoint.ts` | Standalone service |
| `src/publicIngressAccess.ts` | 52 | `src/services/publicIngressAccess.ts` | Access control helper for public tunnel |
| `src/urlSafety.ts` | 45 | `src/services/urlSafety.ts` | SSRF protection utility used by services |

### Files that STAY in `src/` root:
| File | Lines | Reason |
|------|------:|--------|
| `src/app.ts` | 174 | Application entrypoint / composition root |
| `src/bot.ts` | 2,110 | Bot orchestrator (Plan D owns) |
| `src/config.ts` | ~200 | App configuration — true root concern |
| `src/dashboard.ts` | ~300 | Dashboard server factory — true root concern |
| `src/llm.ts` | 559 | LLM facade (thin, re-exports from `src/llm/`) |
| `src/utils.ts` | 77 | General utilities — true root concern |
| `src/retry.ts` | 63 | Shared retry utilities — true root concern |

**Result:** 7 production files in `src/` root (down from 26). Plus `config.test.ts` and `testHelpers.ts`/`testSettings.ts`.

### Test files that move with their production files:
| Test File | Destination |
|-----------|-------------|
| `src/automation.test.ts` | `src/bot/automation.test.ts` |
| `src/botHelpers.test.ts` | `src/bot/botHelpers.test.ts` |
| `src/bot.helpers.test.ts` | `src/bot/bot.helpers.test.ts` |
| `src/discovery.test.ts` | `src/services/discovery.test.ts` |
| `src/gif.test.ts` | `src/services/gif.test.ts` |
| `src/llm.claudeCode.test.ts` | `src/llm/llm.claudeCode.test.ts` |
| `src/llm.providerSelection.test.ts` | `src/llm/llm.providerSelection.test.ts` |
| `src/memory.ingest.test.ts` | `src/memory/memory.ingest.test.ts` |
| `src/memory.logic.test.ts` | `src/memory/memory.logic.test.ts` |
| `src/pricing.test.ts` | `src/llm/pricing.test.ts` |
| `src/promptCore.test.ts` | `src/prompts/promptCore.test.ts` |
| `src/publicHttpsEntrypoint.test.ts` | `src/services/publicHttpsEntrypoint.test.ts` |
| `src/publicIngressAccess.test.ts` | `src/services/publicIngressAccess.test.ts` |
| `src/runtimeActionLogger.test.ts` | `src/services/runtimeActionLogger.test.ts` |
| `src/screenShareSessionManager.test.ts` | `src/services/screenShareSessionManager.test.ts` |
| `src/search.test.ts` | `src/services/search.test.ts` |
| `src/video.test.ts` | `src/video/video.test.ts` |
| `src/dashboard.routes.test.ts` | `src/dashboard/dashboard.routes.test.ts` |
| `src/prompts.voiceJoinWindowBias.test.ts` | `src/prompts/prompts.voiceJoinWindowBias.test.ts` |
| `src/bot.loop.test.ts` | `src/bot/bot.loop.test.ts` |
| `src/bot.replyDecisionPolicy.test.ts` | `src/bot/bot.replyDecisionPolicy.test.ts` |

---

## Phase 2: Import Path Updates

After moving files, every import referencing the old path must be updated. This is the bulk of the work.

### Strategy:
1. Move files one batch at a time (by destination directory)
2. After each batch, use `grep` / LSP to find all broken imports
3. Update import paths in all consuming files
4. Run `bun run typecheck` after each batch to verify

### High-import-count files (will have many consumers to update):
| File | Expected importers |
|------|-------------------|
| `src/botHelpers.ts` → `src/bot/botHelpers.ts` | bot.ts, llm/, prompts/, voice/ |
| `src/store.ts` → `src/store/store.ts` | app.ts, dashboard.ts, many services |
| `src/memory.ts` → `src/memory/memoryManager.ts` | app.ts, bot.ts, llm/, dashboard/ |
| `src/pricing.ts` → `src/llm/pricing.ts` | llm/, llmCodex.ts, runtimeActionLogger.ts |
| `src/utils.ts` | **STAYS** — no import changes needed |
| `src/retry.ts` | **STAYS** — no import changes needed |
| `src/prompts.ts` | bot.ts, voice/ (barrel file — see note below) |

### `src/prompts.ts` barrel file:
This 7-line barrel re-exports from `src/prompts/`. Options:
- **Option A (recommended):** Convert to `src/prompts/index.ts` so `import from './prompts'` still resolves. Then delete `src/prompts.ts`.
- **Option B:** Delete the barrel and update all 4 import sites to import directly from `src/prompts/promptFormatters.ts`, `src/prompts/promptText.ts`, `src/prompts/promptVoice.ts`.

Go with **Option A** — minimal import churn, preserves the public API.

---

## Phase 3: Type the Dashboard Route Signatures

### Current pattern (all 3 files):
```typescript
export function attachVoiceRoutes(app: any, deps: any) {
  const { store, bot, memory, screenShareSessionManager, voiceSseClients } = deps;
```

### Target pattern:
```typescript
import type { Express } from "express";

export interface VoiceRouteDeps {
  store: Store;
  bot: ClankerBot;
  memory: MemoryManager;
  screenShareSessionManager: ScreenShareSessionManager | null;
  voiceSseClients: Map<string, Response>;
}

export function attachVoiceRoutes(app: Express, deps: VoiceRouteDeps) {
  const { store, bot, memory, screenShareSessionManager, voiceSseClients } = deps;
```

### Files to update:
| File | `deps` shape |
|------|-------------|
| `src/dashboard/routesSettings.ts` | `{ store: Store, bot: ClankerBot, appConfig: AppConfig }` |
| `src/dashboard/routesMetrics.ts` | `{ store: Store, publicHttpsEntrypoint: PublicHttpsEntrypoint \| null, getStatsPayload: () => object, activitySseClients: Map<string, Response>, writeSseEvent: (...) => void }` |
| `src/dashboard/routesVoice.ts` | `{ store: Store, bot: ClankerBot, memory: MemoryManager, screenShareSessionManager: ScreenShareSessionManager \| null, voiceSseClients: Map<string, Response> }` |

### Also type `dashboard.ts`:
The `createDashboardServer` function parameter is an untyped destructured object. Define a `DashboardDeps` interface:
```typescript
export interface DashboardDeps {
  appConfig: AppConfig;
  store: Store;
  bot: ClankerBot;
  memory: MemoryManager;
  publicHttpsEntrypoint: PublicHttpsEntrypoint | null;
  screenShareSessionManager: ScreenShareSessionManager | null;
}
```

---

## Phase 4: Type `store: any` in `storeAdaptiveDirectives.ts`

7 functions with `store: any` first parameter. The `store` is the `Store` class from `src/store.ts` (which will now be at `src/store/store.ts`).

**But:** Importing `Store` from `src/store/store.ts` into a file inside `src/store/` creates a circular dependency (since `store.ts` imports `storeAdaptiveDirectives.ts`).

### Solution:
Define a narrow interface for what these functions actually need from `store`:

```typescript
/** Narrow interface for the SQLite database methods used by adaptive directive functions */
interface AdaptiveDirectiveStore {
  db: import("bun:sqlite").Database;
  logAction(guildId: string, action: string, detail: string): void;
}
```

Then type all 7 functions as `store: AdaptiveDirectiveStore`. This avoids circular imports and follows the interface-segregation principle already established by `MusicPlaybackHost` and `ReplyDecisionHost` in voice modules.

---

## Phase 5: Fire-and-Forget Audit (~15 non-voice patterns)

Scan for `.catch(() => undefined)` and `.catch(() => {})` outside `src/voice/`.

For each occurrence:
1. If the fire-and-forget is correct (truly optional side-effect like logging), replace with `.catch((err) => log.warn("context", err))` or a named helper
2. If the result matters, add proper error handling
3. If it's dead code, delete it

---

## Execution Order

1. **Phase 1+2 first** — file moves + import updates (this is the riskiest; get it green before touching types)
2. **Phase 3** — dashboard typing (independent of moves, but do after so import paths are final)
3. **Phase 4** — storeAdaptiveDirectives typing (small, independent)
4. **Phase 5** — fire-and-forget audit (independent)

After each phase: `bun run typecheck && bun run test`

---

## Verification Checklist

- [ ] `src/` root has ≤10 files (7 production + config.test.ts + testHelpers.ts + testSettings.ts)
- [ ] All 704+ tests pass
- [ ] `bun run typecheck` clean
- [ ] 0 `:any` in `src/dashboard/` files
- [ ] 0 `store: any` in `storeAdaptiveDirectives.ts`
- [ ] No `.catch(() => undefined)` outside `src/voice/`
- [ ] No circular dependency introduced by store typing
- [ ] `src/prompts.ts` barrel converted to `src/prompts/index.ts`
