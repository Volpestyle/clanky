# Implicit Any Audit

Generated 2026-03-07. `tsconfig.base.json` has `strict: false` — `noImplicitAny` is off.
Running `tsc --noImplicitAny` surfaces **2,361 errors** (2,014 backend, 347 frontend, 0 tests).

## Error Type Breakdown

| Code | Description | Backend | Frontend | Typical Fix |
|------|-------------|---------|----------|-------------|
| TS7006 | Parameter implicitly has `any` | 1,027 | 177 | Add type annotation to param |
| TS7031 | Destructured binding element has `any` | 693 | 150 | Type the destructured object param |
| TS7008 | Class member implicitly has `any` | 165 | 0 | Annotate field declaration |
| TS7018 | Object literal property has `any` | 90 | 5 | Resolves when source is typed |
| TS7053 | Element access with `any` index | 14 | 14 | Add index signature or type guard |
| TS7016 | No declaration file for module | 8 | 0 | Install `@types/*` |
| TS7005 | Variable implicitly has `any` | 8 | 0 | Annotate variable |
| TS7011 | Function return implicitly `any` | 7 | 1 | Add return type |
| TS7010 | Method return implicitly `any` | 2 | 0 | Add return type |

---

## Tier 1: Lowest Hanging Fruit

### 1A. Missing `@types` packages (8 errors)

```
bun add -d @types/express
```

Lodash was removed — all 3 imports were just `clamp`, replaced with `src/utils.ts`.

Files affected:
- `src/dashboard.ts` (2)
- `src/dashboard/routesMetrics.ts` (1)
- `src/dashboard/routesSettings.ts` (1)
- `src/dashboard/routesVoice.ts` (1)

### 1B. Files with 1 error (7 files)

Each is a single param annotation:
- `src/voice/voiceToolCallInfra.ts`
- `src/voice/musicPlayback.ts`
- `src/voice/instructionManager.ts`
- `src/normalization/jsonExtraction.ts`
- `src/memory/memoryToolRuntime.ts`
- `src/bot/imageAnalysis.ts`

### 1C. Files with 2 errors (9 files)

- `src/app.ts` — `signal` and `server` params
- `src/bot/automationEngine.ts` — 2 object literal properties
- `src/bot/discoveryEngine.ts` — 2 params
- `src/bot/memorySlice.ts` — 2 params
- `src/bot/screenShare.ts` — 2 params
- `src/bot/startupCatchup.ts` — 2 params
- `src/store/storeSettings.ts` — 2 params
- `src/store/storeStats.ts` — 2 params
- `src/voice/voiceAddressing.ts` — 2 params
- `src/voice/voiceGoldenHarness.ts` — 2 params
- `src/voice/voiceToolCallWeb.ts` — 2 params

### 1D. Files with 3-5 errors (9 files)

- `src/config.ts` (3)
- `src/bot/replyPipeline.ts` (3)
- `src/services/urlSafety.ts` (3)
- `src/store/responseTriggers.ts` (3)
- `src/store/storeAdaptiveDirectives.ts` (3)
- `src/voice/musicSearch.ts` (4)
- `src/testHelpers.ts` (5)
- `src/voice/deferredActionQueue.ts` (5)

### 1E. `bot.ts` timer fields (8 errors at lines 263-282)

All class members storing `setTimeout`/`setInterval` returns. Fix:
```ts
memoryTimer: Timer | null = null;
discoveryTimer: Timer | null = null;
// etc.
```

### 1F. Dashboard settings sections (frontend, ~80 errors)

All TS7031 — destructured props `({ settings, onChange })` without a type.
Pattern: define a shared `SettingsSectionProps` or per-component props interface.
Files:
- `VoiceModeSettingsSection.tsx` (33)
- `SettingsForm.tsx` (30)
- `LlmConfigurationSettingsSection.tsx` (18)
- `DiscoverySettingsSection.tsx` (11)
- `ActionStream.tsx` (10)
- `VisionSettingsSection.tsx` (8)
- `BrowserSettingsSection.tsx` (8)
- plus ~10 more sections with 2-4 each

---

## Tier 2: Medium Effort (pattern-based)

### 2A. `store.ts` — 153 errors (673 lines)

**Pattern:** The `Store` class declares ~15 fields without types (`dbPath`, `db`, `sqliteVecReady`, `onActionLogged`, etc.), and ~30 methods whose params are untyped (`logAction(action)`, `countActionsSince(kind, sinceIso)`, etc.). The methods are thin wrappers that delegate to imported functions.

**Fix approach:** Annotate the class fields with their actual types (`db: Database | null`, `onActionLogged: ((action: ActionLogEntry) => void) | null`, etc.), and add param types to each method. The delegated functions likely already have types or can inform what types to use. The `searchConversationWindows` opts object (lines 348-356) also needs its field types filled in — they're declared as shorthand without types.

**Difficulty:** Moderate. Requires checking the types of the delegated functions but is mechanical once you know them.

### 2B. `botHelpers.ts` — 86 errors

**Pattern:** Mostly TS7018 — object literals built from destructured untyped params. e.g. lines 76-95 build objects with properties like `operation`, `title`, `instruction` from variables that aren't typed.

**Fix approach:** Type the function params, and the object literal errors resolve automatically.

### 2C. Dashboard route files — 71 + 29 + 15 = 115 errors

- `routesVoice.ts` (71)
- `routesSettings.ts` (29)
- `routesMetrics.ts` (15)

These are Express route handlers. Once `@types/express` is installed (Tier 1A), many of these resolve. The remaining ones are untyped destructured request body/query params.

### 2D. `promptFormatters.ts` (38) + `promptText.ts` (32) + `promptCore.ts` (19) = 89 errors

Prompt formatting functions with untyped string/settings params. Should be straightforward — these functions take settings objects and message data.

### 2E. `llmHelpers.ts` (27) + `llmClaudeCode.ts` (22) + `pricing.ts` (24) = 73 errors

LLM layer. `pricing.ts` is likely lookup tables with untyped params. `llmHelpers.ts` and `llmClaudeCode.ts` wrap API calls.

---

## Tier 3: Requires More Thought

### 3A. `voiceSessionManager.ts` — 266 errors (4,942 lines)

**The biggest file in the codebase.** The `VoiceSessionManager` class has ~28 fields declared without types (lines 521-548). The constructor takes a large destructured options bag (lines 550-562) with no type annotation. There are dozens of methods that take `session` as an untyped param (lines 799, 803, 858, 863, 873, 882, 886, 903, 908, 912, 916...).

**Key decision:** The `session` param appears everywhere and has type `VoiceSession` (defined at line ~430 as a `type` with `[key: string]: unknown` catch-all). The question is whether to:
- Just annotate every `session` param with `VoiceSession` (mechanical but noisy)
- Tighten the `VoiceSession` type itself to remove the `[key: string]: unknown` index signature, which would surface real type errors but is a bigger change

The constructor options bag also needs an interface — something like `VoiceSessionManagerDeps` with `client: Client`, `store: Store`, etc.

**Risk:** This is the core voice runtime. Typing it properly may reveal actual bugs (good) but also requires careful testing.

### 3B. Realtime client classes — 148 errors across 5 files

All five realtime clients (`openai`, `gemini`, `elevenLabs`, `xai`, + `realtimeClientCore`) share the same anti-pattern: class fields declared without types.

```ts
// Every client looks like this:
export class XxxRealtimeClient extends EventEmitter {
  apiKey;        // string
  ws;            // WebSocket | null
  logger;        // Logger
  lastError;     // Error | null
  sessionId;     // string | null
  sessionConfig; // Record<string, unknown> | null
  // ... 8-12 more fields
```

**Key decision:** These classes share a lot of structure. Options:
- **Quick:** Just annotate each field in each class individually
- **Better:** Extract a shared base class or interface (`RealtimeClientState`) for the common fields (`ws`, `lastError`, `sessionId`, `lastCloseCode`, etc.), then each client only adds its unique fields. This would reduce duplication and make it easier to add new providers.
- `realtimeClientCore.ts` also has several utility functions (`compactObject`, `extractAudioBase64`, `safeJsonPreview`) that take/return untyped params. These are shared across all clients and need proper generic or union types.

**Risk:** Low for just annotating fields. Medium if refactoring to shared base.

### 3C. `discovery.ts` + `search.ts` — 123 errors (1,557 lines combined)

**Pattern in `discovery.ts`:** The `DiscoveryService.collect()` method takes a big untyped options bag (`{ settings, guildId, channelId, channelName, recentMessages }`). Below that, there are several config-normalization functions that take `config` and `rawConfig` without types. The `TS7053` at line 180 (`obj[string]`) suggests a dynamic property access pattern that needs an index signature or `Record` type.

**Pattern in `search.ts`:** Already has some types defined (`ProviderSearchInput`, `ProviderSearchRow`, `ProviderSearchResult`) but the class methods and callback params aren't annotated. The `AttemptError` class (line 45) has an untyped `attempts` field and constructor params.

**Key decision:** These services deal with external API responses (Brave Search, SerpAPI, HackerNews, YouTube, RSS). The return shapes from these APIs need to be typed accurately. Options:
- Type what we control (our function params and return types) and use `unknown` for raw API responses, casting after validation
- Define comprehensive response types for each external API

**Risk:** Low for typing our own interfaces. Medium for external API response types (they can change, but having types catches breakage faster).

### 3D. `voiceStreamWatch.ts` — 66 errors

Haven't inspected deeply but likely similar to voiceSessionManager — lots of untyped `session` and `settings` params.

### 3E. `memoryManager.ts` — 88 errors

Memory system. Likely has untyped database row results and settings params.

### 3F. `videoContextService.ts` — 60 errors

Video/screen-share context. Similar pattern of untyped service method params.

---

## Recommended Attack Order

1. **Install `@types/express`** — 5 errors, 30 seconds (lodash already removed)
2. **Sweep all 1-2 error files** — ~35 errors, ~30 min
3. **Bot.ts timer fields** — 8 errors, 5 min
4. **Dashboard settings sections** — ~80 errors, define shared props type
5. **Store.ts** — 153 errors, annotate fields + method params
6. **Dashboard routes** — recheck after @types/express, fix remaining
7. **Prompt/LLM layer** — 162 errors, mechanical param typing
8. **botHelpers.ts** — 86 errors, type function params
9. **Realtime clients** — 148 errors, annotate class fields (consider shared base)
10. **discovery.ts + search.ts** — 123 errors, type service interfaces
11. **voiceSessionManager.ts** — 266 errors, define `VoiceSessionManagerDeps` + annotate `session` params
12. **Remaining files** — memoryManager, voiceStreamWatch, videoContextService, etc.

Steps 1-3 eliminate ~50 errors in under an hour.
Steps 4-8 are mechanical and cover ~570 errors.
Steps 9-12 require the most thought and cover ~700+ errors.
