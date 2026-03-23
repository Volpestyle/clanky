# Prompt Boundary Refactor: Static Capability Docs → System Prompt

**Status: IMPLEMENTED** (both text and voice paths)

## Motivation

Static tool/capability documentation was previously assembled per-turn in the user prompt, meaning ~1200-1750 tokens of instructional content was re-processed on every LLM call. By moving static documentation into the system prompt (built once per settings change), we get:

- **Lower latency to first token** — fewer tokens to process per turn
- **Lower cost** — Anthropic cached input tokens are 90% cheaper
- **Simpler prompt assembly** — user prompt builders shrink significantly
- **Better agent autonomy alignment** — the model always knows its full capability set and decides what to use; infrastructure enforces gates via hard-fail at the tool execution layer

### Core Design Shift

**Before:** The prompt hides tools from the model when they're unavailable.
**After:** The model always knows about its tools (system prompt). Per-turn state lines tell it what's available *right now*. If it tries to use something gated, the tool execution layer returns a clear error and the model reasons from there.

---

## Phase 1: Identify and Extract Static Capability Blocks

These sections in `buildReplyPrompt` (`src/prompts/promptText.ts`) and `buildVoiceTurnPrompt` (`src/prompts/promptVoice.ts`) contain instructional documentation mixed with per-turn availability gates. Each needs to be split into static doc (system prompt) and dynamic state (user prompt).

### Text Prompt Sections (`promptText.ts`)

| Section (lines) | Static doc → system prompt | Dynamic state → user prompt |
|---|---|---|
| **Voice Control** (287-361) | Tool names, music command semantics, disambiguation flow, join/leave behavior | Music state (current track, queue, playback), VC roster, in-channel boolean |
| **Screen Watch** (363-397) | How screen watch works, `screenWatchIntent` field semantics | `screen watch: available` or `unavailable (reason)` |
| **Automation** (399-416) | Schedule kinds (`daily`, `interval`, `once`), operation types, field descriptions | `Automations available. Timezone: X` or unavailable line |
| **Web Search** (430-450) | Tool routing policy, `web_search` docs, `web_scrape` docs | `web search: available (budget: N)` or `unavailable (reason)` |
| **Browser** (452-467) | `browser_browse` docs, screenshot capability | `browser: available` or `unavailable (reason)` |
| **Memory Lookup** (469-495) | How `memory_search` works, `__ALL__` query, `image_lookup` docs | `memory lookup: available` / `image refs: N candidates` |
| **Video Context** (497-519) | How video context works, citing `[V1]` | Video findings data, or unavailable reason |
| **Media Generation** (521-573) | Prompt format (`{type, prompt}`), craft guidance, simple vs complex vs video distinctions | `image slots: N, video slots: N` or `unavailable` |
| **GIFs** (554-573) | How `{type: gif}` works | `gif slots: N` or `unavailable` |
| **Output Format** (575-591) | JSON schema, field semantics, tool call instructions | (none — fully static) |

### Voice Prompt Sections (`promptVoice.ts`)

| Section (lines) | Static doc → system prompt | Dynamic state → user prompt |
|---|---|---|
| **Tool instructions** (622-624) | Speak-first policy, tool acknowledgment guidance | (already thin) |
| **Memory write** (625-634) | `note_context` and `memory_write` field docs | `memory tools: available` |
| **Soundboard** (636-654) | Inline directive format, refs usage rules | Eagerness level, candidate list |
| **Web/browser policy** (704-714) | Tool routing, search policy, scrape/browse docs | `web search: available` |
| **Voice tools** (716-728) | Music/video/queue/floor-control semantics | (move entirely — static) |
| **Screen share tools** (730-734) | `start_screen_watch` docs | `screen watch: available` |
| **Admission policy** (755-770) | Eagerness tier descriptions, transcript quality reminder, tiny reply line | Eagerness values, room count, addressing signals |
| **Output format** (772-800) | `[[TO:...]]`, `[[LEASE:...]]` format rules | (move entirely — static) |

---

## Phase 2: Restructure System Prompt Builders

Expand `buildSystemPrompt(settings)` and `buildVoiceSystemPrompt(settings)` in `src/prompts/promptFormatters.ts` to include new sections. New structure:

```
=== PERSONA ===          (existing — identity, style, guidance)
=== CAPABILITIES ===     (existing — honesty, memory status, impossible action)
=== TOOLS ===            (NEW — all tool documentation, conditionally included)
=== OUTPUT FORMAT ===    (NEW — JSON schema or spoken format rules)
=== LIMITS ===           (existing — message length, hard limits)
```

The `=== TOOLS ===` section is conditionally assembled from settings at system-prompt build time:

- `settings.voice.enabled` → voice/music tool docs
- `settings.webSearch.enabled && settings.webSearch.configured` → web search/scrape docs
- `settings.browserBrowse.enabled && settings.browserBrowse.configured` → browser docs
- `settings.memory.enabled` → memory tool docs (search, write, image lookup)
- `settings.media.replyImages.enabled` → image generation docs
- `settings.media.replyVideos.enabled` → video generation docs
- `settings.media.replyGifs.enabled` → gif docs
- `settings.automation.enabled` → automation operation docs
- `settings.screenShare.enabled` → screen watch docs

Settings change → rebuild system prompt → Anthropic cache invalidation is automatic (new prefix).

Consider extracting the static doc builders into a new file `src/prompts/promptCapabilities.ts` to keep `promptFormatters.ts` focused.

---

## Phase 3: Slim Down User Prompts

Replace the large conditional documentation blocks with thin per-turn state lines.

### Example: Web Search

**Before (~20 lines across 4 conditional branches):**
```typescript
if (webSearch?.optedOutByUser) {
  parts.push("The user explicitly asked not to use web search.");
  parts.push("Do not call web_search or web_scrape and do not claim live lookup.");
} else if (!webSearch?.enabled) {
  parts.push("Live web search capability exists but is currently unavailable (disabled in settings).");
  parts.push("Do not call web_search or web_scrape...");
} else if (!webSearch?.configured) {
  // ...more lines
} else if (webSearch?.blockedByBudget) {
  // ...more lines
} else {
  parts.push("Live web search and direct page reading are available via...");
  parts.push(buildWebToolRoutingPolicyLine(...));
  parts.push(buildWebSearchPolicyLine());
  parts.push(WEB_SCRAPE_POLICY_LINE);
  parts.push("Use the web tools only when they materially help.");
}
```

**After (~1-2 lines):**
```typescript
if (webSearchToolAvailable) {
  parts.push("Web search: available (budget: 8/10 remaining).");
} else {
  parts.push(`Web search: unavailable (${webSearchUnavailableReason}).`);
}
```

The model already knows what `web_search` does from the system prompt. It just needs the per-turn gate status. If it calls `web_search` despite seeing "unavailable," the tool execution layer returns an error and the model adjusts.

### Thin State Line Pattern

All capability sections follow this pattern in the slimmed user prompt:

```
<capability>: available [optional budget/state details]
```
or
```
<capability>: unavailable (<reason>)
```

Per-turn context data (music state, video findings, image candidates, VC roster, etc.) stays in the user prompt as before — it's genuinely per-turn.

---

## Phase 4: Hard-Fail Tool Execution Guards

Add/verify guard logic at the tool execution layer (`src/tools/`) so that if the model calls a tool that's currently gated:

1. The tool handler checks availability before executing
2. Returns a clear error message: `"web_search is currently unavailable: hourly budget exhausted"`
3. The model sees this in the tool result and reasons about alternatives
4. No prompt-level hiding needed

**Audit needed:** Check existing tool execution paths to see what guards already exist and where gaps are. Key tools to verify:

- `web_search` / `web_scrape` — budget gate
- `browser_browse` — budget gate
- `memory_search` / `memory_write` — enabled gate
- `image_lookup` — enabled gate
- Media generation tools — budget gate
- Voice tools — voice-enabled gate, in-channel gate
- Automation tools — enabled gate
- Screen watch — enabled/available gate

---

## Phase 5: Execution Order

1. **Start with text path** — lower latency sensitivity, easier to test with `bun run test`
2. **Extract static blocks** into new helper functions (new `src/prompts/promptCapabilities.ts` or extend `promptCore.ts`)
3. **Expand `buildSystemPrompt`** to conditionally include the extracted blocks
4. **Slim `buildReplyPrompt`** to thin state lines
5. **Run tests**, compare prompt output diffs, validate behavior
6. **Repeat for voice path** — same pattern applied to `buildVoiceSystemPrompt` and `buildVoiceTurnPrompt`
7. **Verify/add tool execution guards** to cover all gated tools
8. **Update docs** to reflect new prompt architecture

Within the text path, tackle sections in this order (biggest token savings first):

1. Output Format (fully static, easy win)
2. Automation instructions
3. Media Generation + GIFs
4. Web Search + Browser
5. Memory Lookup + Image Lookup
6. Voice Control (most complex due to music state interleaving)
7. Screen Watch
8. Video Context

---

## Estimated Token Savings Per Turn

| Content | Current (user prompt, reprocessed) | After (system prompt, cached) | Per-turn savings |
|---|---|---|---|
| Tool documentation blocks | ~800-1200 tokens | 0 (cached) | ~800-1200 |
| Output format instructions | ~200-300 tokens | 0 (cached) | ~200-300 |
| Policy lines | ~150-250 tokens | 0 (cached) | ~150-250 |
| **Total per-turn savings** | | | **~1150-1750 tokens** |

At Anthropic's cached vs uncached input pricing (90% discount), this reduces both latency and cost on every turn after the first.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Prompt quality regression** — model may behave differently with capability docs in system vs user | Incremental rollout, one section at a time. Compare outputs before/after. Use golden harness tests. |
| **Stale system prompt** — settings change mid-session without rebuilding | Verify that settings changes trigger system prompt rebuild. Already partially solved since `buildSystemPrompt` takes `settings` as input. |
| **Tool hard-fail UX** — model calls gated tool, extra round-trip | Should be rare if state lines are clear. Adds ~2-3s on failure path for voice. Monitor tool-call-on-unavailable rate. |
| **Cache invalidation on settings change** — rebuilt system prompt breaks prefix cache | Expected and acceptable. Settings changes are infrequent vs per-turn calls. |

---

## Key Files

- `src/prompts/promptFormatters.ts` — `buildSystemPrompt`, `buildVoiceSystemPrompt`
- `src/prompts/promptText.ts` — `buildReplyPrompt` (main text user prompt)
- `src/prompts/promptVoice.ts` — `buildVoiceTurnPrompt` (main voice user prompt)
- `src/prompts/promptCore.ts` — shared primitives, defaults, guardrails
- `src/prompts/toolPolicy.ts` — tool routing policy lines
- `src/prompts/voiceAdmissionPolicy.ts` — voice admission/eagerness
- `src/prompts/voiceLivePolicy.ts` — music and tiny reply policy
- `src/llm/serviceShared.ts` — Anthropic cache construction (`buildAnthropicCachedSystemPrompt`)
- `src/bot/replyPipeline.ts` — text reply callsite
- `src/bot/voiceReplies.ts` — voice reply callsite
- `src/tools/` — tool execution handlers (need guard audit)
