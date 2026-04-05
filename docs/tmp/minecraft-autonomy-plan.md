# Minecraft Autonomy Plan

This document captures the gaps between Clanky's current Minecraft runtime and the "real active player" standard in [`AGENTS.md`](../../AGENTS.md), grouped into phases by alignment severity and dependency order.

This is a planning doc, not canonical architecture truth. Canonical Minecraft capability truth lives in [`docs/capabilities/minecraft.md`](../capabilities/minecraft.md).

## Goal

Make Clanky's embodied Minecraft self feel like a real player who:

- makes his own in-world decisions from context (not command routing)
- collaborates and communicates across Discord text, Discord voice, and in-game chat as one continuous self
- talks about what's happening in-game unprompted, like any community member would
- recovers from mistakes mid-turn instead of dead-ending on a single failed action
- has rich enough sensory input to reason about the world — both structured telemetry for mechanical/survival reasoning AND real visual scenes for aesthetic/social moments like "look what I built"

## Non-goals and rejected alternatives

**Clanky stays one mind.** His Minecraft self is the same reasoning entity as his Discord self — same model family, same memory, same voice, same relationship with the operator. In-world embodiment is a surface of Clanky, not a delegated sub-agent.

**We don't replace the brain with a vision-language-action model.** We evaluated the "swap Mineflayer for a VLA (OpenHA, JARVIS-VLA, STEVE-1) that looks at pixels and presses keys" path and rejected it. Reasons:

- Splits Clanky into two minds (Discord reasoning + VLA in-world reasoning). Contradicts "one brain, many surfaces."
- Requires GPU sidecar infrastructure (dedicated hardware or dollars-per-hour cloud) per in-game session.
- Research stacks (MineRL / MineStudio) aren't turnkey on retail Java clients — needs a bespoke harness for screen capture, input injection, reconnect, GUI parsing, anti-cheat, etc.
- Breaks our structured-action logging (`follow { playerName }` vs mouse-move streams), breaking Grafana/Loki incident workflows.
- Optimizes for "plays Minecraft well" at the cost of "is still Clanky."

**Mineflayer is the permanent actuator.** Capability gaps (crafting, building, vision) are closed by expanding Mineflayer's MCP surface and adding brain action kinds — not by swapping the actuator layer.

**Vision-model perception is a tool the brain calls**, not a replacement controller. The plan includes two complementary vision tools (Phase 5.1) — structured block projection AND headless scene rendering via `prismarine-viewer` — both served by the same Node Mineflayer process, both invoked by the same Clanky brain. Still one brain, calling more eyes.

## Current state — what works

The architecture is sound and matches the design principle in `AGENTS.md`:

- **One brain per session, many input surfaces.** `MinecraftSession` owns one `MinecraftBrain` that decides in-world actions. Discord text, Discord voice, and Minecraft chat all feed into it.
- **Structured actions over regex commands.** The brain outputs a discriminated union of action kinds (`follow`, `guard`, `collect`, `go_to`, `chat`, `attack`, `look_at`, `return_home`, `connect`, `disconnect`, `stop`, `wait`). The session converts each to deterministic MCP tool calls.
- **Long-horizon planner state.** `activeGoal`, `subgoals`, `progress`, `lastInstruction`, `lastActionResult` persist across turns so the brain has continuity.
- **Bounded planner checkpoint loop.** The brain can checkpoint up to 3 times in one turn (e.g. `connect` → `follow`) without splitting authority across transports.
- **Reflexes are infrastructure, not personality.** Eat/flee/attack fire from survival thresholds via `evaluateReflexes`, separate from planner decisions.
- **`chatText: ""` is first-class silence.** The brain can stay quiet in MC chat the same way text replies can emit `[SKIP]`.
- **Session ownership and reuse.** `findReusableMinecraftSession` keeps Clanky as "one trusted buddy" per user/scope.

## Current state — remaining gaps against agent autonomy

Phases 1 through 7 and 5.1a/5.1b/5.2/5.3 have all shipped. Remaining gaps are narrow:

- **Vision budgeting is still basic.** Clanky now has both structured block/entity projection (`minecraft_visible_blocks`) and on-demand rendered first-person capture (`minecraft_look`), but explicit per-session/per-scope look budgets and cooldown hints are still future refinement.

- **Multi-operator session pivot.** `operatorPlayerName` is fixed at session start — trusted collaborators can't say "follow me" and pivot the session without an explicit handoff.

- **Prismarine-viewer fidelity.** Rendered first-person glances use vanilla textures with approximate lighting. Modded/packed/shadered servers are misrepresented until 5.1c (high-fidelity tier) ships.

## Design principle recap

From `AGENTS.md`:

> We do not hardcode behaviors for the agent. We give it rich context — conversation history, channel events, available tools, memory, participant state — and let the model reason about what to do.

Applied to Minecraft:

- The orchestrator routes **intent** to the Minecraft brain. It does not pre-translate commands.
- The Minecraft brain sees **full in-world context** and picks the action.
- Cost gates (rate limits, cooldowns, budget caps) apply at infrastructure boundaries — they do not hide context from the brain.
- The brain can always pick `wait` or `chatText: ""` — silence is a first-class decision.

## Prompt layering decision (from design discussion)

Three layers, three audiences. Orchestrator does NOT get the full action surface; it gets just enough to route intent.

**Layer 1 — Brain system prompt** (already implemented in `minecraftBrain.ts:428-479`)
Full structured action surface with their argument shapes. Static per-settings, cacheable. Only the brain needs this.

**Layer 2 — Orchestrator system prompt** (shipped)
~5-10 lines describing the Minecraft capability: that Clanky has an embodied Minecraft self with its own in-world brain, what kinds of intents route there, and the reminder to hand over intent/context rather than translated commands. Gated by `minecraftEnabled`, cacheable, settings-static. Same pattern as `code_task` — orchestrator knows the handoff, workers own the tool surface.

**Layer 3 — Per-turn session state hint in user prompt** (shipped)
One-line dynamic hint that injects ONLY when an active `MinecraftSession` exists for the current scope: active goal, mode, server target, connected y/n, last action. Breaks cache but fires only on turns where it matters. Richer detail is fetched via `action=status` tool call when needed.

## Phases

Phases are ordered by alignment severity and dependency. Phase 1 fixes active contradictions with `AGENTS.md`; phase 2 onward adds capabilities.

**Progress:** Phases 1-4 are shipped. Phases 5.1a, 5.1b, 5.2, and 5.3 are shipped. Phases 6, 7, and 8 are shipped. Only 5.1c (high-fidelity visual perception) remains as future work.

---

## Phase 1: Agent-autonomy alignment

**Status: Shipped.** All five sub-items implemented and audited clean. Touches `src/prompts/promptCapabilities.ts`, `src/bot/replyPipeline.ts`, `src/bot/voiceReplies.ts`, `src/agents/minecraft/minecraftSession.ts`, `src/agents/minecraft/minecraftSessionAccess.ts`, `src/tools/sharedToolSchemas.ts`.

Fix the seams that directly contradict the core design principle. Low risk, high coherence impact.

### 1.1 Plumb Minecraft into the orchestrator prompt (Layer 2)

- Add `minecraft_task` entry to `TEXT_TOOL_SUMMARIES` and `VOICE_TOOL_SUMMARIES` in `src/prompts/promptCapabilities.ts`.
- Add `minecraftEnabled: boolean` to `TextSystemCapabilityFlags` and `VoiceSystemCapabilityFlags`.
- Add `buildMinecraftDocs()` builder producing a short `=== MINECRAFT ===` block that describes the embodied-self routing model and explicitly says "hand over intent/context, not translated commands."
- Wire the flag through `src/bot/replyPipeline.ts` where `capabilities` is assembled (around `src/bot/replyPipeline.ts:500`).
- Wire the flag through the voice capability flags assembly path.

### 1.2 Add per-turn active-session hint (Layer 3)

- When the reply pipeline assembles user-prompt context, check for an active `MinecraftSession` via `findReusableMinecraftSession` (`src/agents/minecraft/minecraftSessionAccess.ts:79`).
- If present, inject a one-liner: `[Minecraft] Active session — goal: "<goal>" · mode: <mode> · server: <label> · connected: <y/n> · last action: <lastActionResult>`.
- Do the same for the voice user prompt assembly.
- Only fires when a session exists; zero cost otherwise.

### 1.3 Rewrite `MINECRAFT_TASK_SCHEMA.description`

- Current: command-routing examples ("'follow me', 'guard me from mobs', 'collect 16 oak logs'"). See `src/tools/sharedToolSchemas.ts:241-305`.
- Replacement: intent-routing framing. Something like: "Send intent or context to Clanky's embodied Minecraft self. Describe what the user wants or what's happening in the channel — his Minecraft brain decides the in-world action. Use action=status to read current in-world state."
- Update the `task` field description to match.

### 1.4 Remove the dead regex command-parser fallback

- Delete the `if (!command && task && !this.brain)` branch in `MinecraftSession.executeTurn` (`src/agents/minecraft/minecraftSession.ts:999-1001`).
- Delete `parseCommand()` and `extractPlayerName()` (`minecraftSession.ts:236-322`) if no other caller needs them. Verify nothing imports them.
- Delete the `COORD_RE` regex constant.
- Keep the explicit `parsed.command` path for orchestrator-side structured command handoff (already exercised by tests), but stop silently falling back to regex on raw text. If brain is absent, return an error turn result.

### 1.5 Log loudly when brain rewrites server target

- `executeBrainAction` (`minecraftSession.ts:874-897`) lets the brain mutate `this.serverTarget` via `action.kind === "connect"` with a `target` arg. Keep that authority, but make sure the `minecraft_server_target_updated` log line always fires with the previous-vs-new delta and the source (`brain_action`).
- Already emits one log line — just verify there's no path that silently mutates without logging.

---

## Phase 2: Cross-surface context continuity

**Status: Shipped.** All three sub-items implemented with test coverage. Discord context flows into both `brain.replyToChat` and `brain.planTurn`; DM/owner-private scopes are gated off by construction (no callback passed). Chat history is label-and-keep-separate with speaker attribution. Touches `src/agents/minecraft/minecraftSession.ts`, `src/agents/minecraft/minecraftBrain.ts`, `src/bot/agentTasks.ts`, plus tests at `src/agents/minecraft/minecraftSession.test.ts:390-509`.

Make "one brain, many surfaces" actually work by unifying context across Discord and in-game.

### 2.1 Pipe Discord context into Minecraft chat decisions

- When `handleIncomingChat` calls `brain.replyToChat` (`minecraftSession.ts:672`), also pass recent Discord turn context.
- This requires threading a `getRecentDiscordContext()` callback through `MinecraftSessionOptions` (similar to how `onGameEvent` is passed).
- The brain's chat-reply system prompt should mention that it may see recent Discord activity in context.
- Example impact: Volpe says "help Alice get wood" in voice, Alice types "hey clanky help me" in MC chat — brain can connect them.

### 2.2 Pipe Discord voice context into Minecraft turn planning

- Same shape as 2.1 but for `brain.planTurn` (`minecraftSession.ts:918`).
- When the turn input came from a Discord surface, include enough recent Discord context that the brain understands follow-ups correctly.
- Tricky piece: avoid leaking DM or owner-private context through MC chat. Filter by relationship tier at the plumbing boundary.

### 2.3 Unified chat-history window

- Today `chatHistory` in `MinecraftBrainSharedContext` is MC-chat-only.
- Consider merging a bounded window of cross-surface history (MC chat + recent Discord channel mentions) with speaker-attribution so the brain sees one conversation instead of two.
- **Resolved: label-and-keep-separate.** The brain sees two parallel prompt sections (`[Recent in-game chat]` and `[Recent Discord channel context]`) so it can reason about surface-of-origin instead of conflating the streams. Discord context is capped at 10 messages and pulled lazily per brain invocation.

---

## Phase 3: Proactive in-game narration

Make Clanky feel like a player who naturally talks about what's happening in-game, not just a command responder.

**Status: Shipped.** Significant game events now flow through a dedicated Minecraft narration pipeline that rate-limits per owning Discord channel, filters to meaningful events before the LLM call, and lets the model decide whether to post or `[SKIP]`.

### 3.1 Wire `onGameEvent` to a Discord narration pipeline

- Today `onGameEvent` only logs events to the action log (`src/bot/agentTasks.ts:546`).
- Add an initiative-style path that surfaces significant game events as candidate Discord posts.
- The model generates the text AND decides whether to post — `[SKIP]` remains first-class.
- Use the existing `initiativeEngine` patterns if possible, or a dedicated `minecraftNarration` module that feeds into the same initiative gates.

### 3.2 Event significance filter

- Not every MC event is Discord-worthy. Filter to: deaths, first sightings of rare items/structures, combat outcomes, friend join/leave, server join/leave, major progression moments (first diamond, first nether portal, etc.).
- Significance filter is a cost gate (avoid LLM calls on every chat tick), not a relevance gate — once an event passes the filter, the LLM decides whether to post.

### 3.3 Rate limiting + eagerness setting

- Respect `minSecondsBetweenPosts` and eagerness the same way text initiative does.
- New setting: `agentStack.runtimeConfig.minecraft.narration.eagerness` (0-100).
- High eagerness → wide significance filter. Low eagerness → only deaths/major events.

### 3.4 Route posts to the right channel

- Question: narration posts to the Discord channel that owns the current MC session (scope-keyed), or to a dedicated discovery/logbook channel?
- Leaning: scope-keyed channel by default, configurable per-guild.

---

## Phase 4: Intra-turn self-correction

**Status: Shipped.** Failed in-world actions now trigger an immediate replanning checkpoint within the same turn, planner state carries typed `lastActionFailure` context plus did-you-mean player suggestions, and tests cover the follow-name recovery path.

Let the brain recover from failed actions inside a single turn instead of dead-ending.

### 4.1 Widen `canContinueAfterBrainAction`

- Today only `wait/connect/status/chat/look_at` allow continuation (`minecraftSession.ts:205-211`).
- Widen to: any action whose execution `ok` is false. Rationale: if `follow Volpe` failed because no player named Volpe is visible, the brain should see `lastActionResult` and decide what to do next in the same turn.
- Cap on failed-action continuations already implicit via `MAX_PLANNER_CHECKPOINTS_PER_TURN = 3`.

### 4.2 Surface structured failure reasons to the brain

- `recordPlannerActionResult` (`minecraftSession.ts:799`) stores execution text as a free-form string.
- Extend to capture a typed failure reason: `player_not_visible`, `path_blocked`, `inventory_full`, `out_of_range`, `rejected_by_server`, etc.
- Brain sees typed reason in `sessionState.lastActionFailure` and can reason about retries vs alternatives.

### 4.3 Player name resolution fallback

- Today `resolveFollowDistance` and friends require an exact `playerName`.
- When the brain requests `follow: "Volpe"` but the world snapshot has `Volpestyle`, surface a "did you mean" option as part of `lastActionFailure`.
- Brain can self-correct: retry with `Volpestyle` or fall back to `status`.

---

## Phase 5: Richer sensory input

Give the brain more than structured telemetry to reason about the world.

### 5.1 Two complementary vision tools

Clanky needs two ways to see, each for a different kind of reasoning. Both are tools the brain invokes — neither replaces the actuator, neither is a fallback for the other. The brain picks the right eye for the moment.

- **Block projection** for mechanical/survival/navigation — what blocks are in front, what entities are near, is there a cliff, am I in a cave.
- **Scene rendering** for aesthetic/social — "look what I built", "check out this sunset", "what do you think of my base".

Block projection answers "what is there"; scene rendering answers "what does it look like." Both matter for "real active player" behavior, and the social angle is essential to the "keep Clanky while he plays with us" goal that symbols alone can't carry.

Both tools run inside the existing `mcp-servers/minecraft` Node/Mineflayer process. One sidecar, one deployment unit, one log stream.

#### 5.1a Block projection (structured telemetry)

**Status: Shipped.** `minecraft_visible_blocks` now exposes a bounded projection of non-air blocks and nearby entities ahead of the bot, and `WorldSnapshot` carries that data into the brain as `visualScene` with sky/enclosure and notable-feature hints.

- Mineflayer doesn't render, but it has `bot.blockAt` and raycast. Expose a `minecraft_visible_blocks` MCP tool that returns a bounded 3D projection of what's in front of the bot (blocks in a cone, nearby entities with types, sky/cave visibility, notable features).
- Brain's `WorldSnapshot` gains a `visibleBlocks` / `visualScene` field.
- Vision as structured telemetry the reasoning model can ingest, not pixels the model has to decode.
- Cheap in compute (no GPU), debuggable in logs (tokenized blocks, not mouse streams), and keeps Clanky one mind.
- Primary use: "am I safe", "can I mine this", "what's around me", "is the path clear", "what biome am I in".

#### 5.1b Headless scene rendering via `prismarine-viewer`

**Status: Shipped.** `minecraft_look` now captures a rendered first-person scene image through the Mineflayer MCP runtime, and the planner can choose a structured `look` action that feeds that image into the next checkpoint of the same Minecraft brain.

- Add a `minecraft_look` MCP tool that returns a rendered image of the bot's current perspective using [`prismarine-viewer`](https://github.com/PrismarineJS/prismarine-viewer), the first-party PrismarineJS companion library to Mineflayer. Renders Mineflayer's world state into a three.js scene with vanilla Minecraft textures, captures to a PNG/JPEG buffer.
- Brain's existing vision-capable model reasons about the image directly — same pattern as the browser screenshot tool.
- **Headless and always-on.** No GPU required, no Minecraft client window required, no extra process. Runs wherever Mineflayer runs.
- Primary use: "friend says 'look at this' → call `minecraft_look`", "friend built something → glance and react", "unusual scene worth narrating → capture and post to Discord", "panoramic moments Clanky would naturally comment on".
- The brain decides when to look. Silence / no-call is the default; perception fires only when something social-or-aesthetic justifies it.
- Rate limited by the brain's own judgment plus infrastructure budget caps (per-session + per-scope call ceilings).
- **Known fidelity limits:** approximate lighting (no shaders), weak text rendering on signs/books, no custom resource packs, misrepresents modded servers. For structural and aesthetic reasoning on vanilla content this is fine. Text content should route through Mineflayer's structured readers (`bot.world.getBlock().signText`, book NBT) rather than visual OCR.

#### 5.1c Future: high-fidelity visual perception

If prismarine-viewer's fidelity proves insufficient — specifically for heavily-modded servers, custom resource packs, or shader-based aesthetic moments that friends actively show off — add a separate high-fidelity perception tier backed by screen capture of a running Minecraft client. That capability is parked as future work and does not ship in the initial plan. Scope it only if real usage surfaces the gap.

### 5.2 MC chat backlog instead of drop-on-cooldown

**Status: Shipped.** Incoming in-game chat now lands in a bounded `pendingInGameMessages` backlog carried in planner state. Cooldown/in-flight gates defer the next brain invocation instead of hiding messages from the brain, and tests cover burst-chat preservation.

- Previously, `CHAT_REPLY_COOLDOWN_MS = 2_000` and `chatReplyInFlight` silently dropped incoming chats before the brain saw them.
- Replace with a bounded backlog: incoming chats during cooldown queue up as `pendingInGameMessages` in the planner state.
- When the next decision cycle fires, the brain sees the backlog and decides whether to respond to each, batch them, or ignore.
- Infrastructure gate moves from "hide messages from brain" to "defer brain invocation" — closer to the AGENTS.md principle.

### 5.3 Server event enrichment

**Status: Shipped.** The MCP server now emits typed event objects instead of flat strings for chat, death, player join/leave, combat, block-break, item-pickup, and server/system events. Session routing, planner prompts, and narration filtering all consume the structured shape.

- Previously, `recentEvents` was a flat `string[]` timeline.
- Structure events with typed payloads (chat, death, player_join, player_leave, combat, block_break, item_pickup).
- Let the brain filter and reason without regex-parsing event strings.

---

## Phase 6: Reflex completion

**Status: Shipped.** Flee, shield-equip, unstick, and eat reflexes now fire concrete recovery actions backed by new MCP tools. Stuck detection tracks position delta across consecutive reflex ticks. Reflexes remain safety/latency infrastructure, not personality.

### 6.1 Flee vector computation

**Shipped.** `evaluateReflexes` computes an opposite-direction vector when health is low and a hazard is within flee distance. `executeReflex` dispatches to `minecraft_flee_toward` with the computed endpoint. When the hazard is on top of the bot, a default east vector is chosen.

### 6.2 Equip shield

**Shipped.** New MCP tools `minecraft_equip_offhand` and `minecraft_unequip_offhand`. The reflex fires when health is below a threshold, hazards are nearby, a shield is in inventory, and off-hand is empty. The brain can also call `equip_offhand { itemName }` pre-emptively.

### 6.3 Unstick logic

**Shipped.** New MCP tools `minecraft_jump` and `minecraft_repath`. Session samples position on every reflex tick; when it has moved less than 0.25 blocks across two consecutive ticks with an active navigation task, the unstick reflex fires (`jump` then `repath`).

### 6.4 Eat slot management

**Shipped.** New MCP tool `minecraft_eat_best_food` picks the highest-scoring food in inventory (foodPoints + 2×saturation), equips it, and consumes it. The `eat` reflex now calls this directly instead of relying on Mineflayer auto-eat.

---

## Phase 7: Capability expansion

**Status: Shipped.** All five sub-items implemented. Brain action surface now includes crafting, chest workflows, block placement, structured builds with a sub-planner, multi-world catalog, and the long-horizon project loop.

### 7.1 Crafting pipeline

**Shipped.** New MCP tools: `minecraft_craft`, `minecraft_recipe_check`, `minecraft_find_crafting_table`. New brain action `craft { recipeName, count?, useCraftingTable? }`. `CraftItemSkill` validates preconditions, discovers nearby tables when requested, and reports missing ingredients via typed failure reasons.

### 7.2 Chest / inventory workflows

**Shipped.** New MCP tools: `minecraft_find_chests`, `minecraft_deposit_items`, `minecraft_withdraw_items`. New brain actions: `deposit { chest, items }` and `withdraw { chest, items }` with `{name, count}` item requests. `constraints.allowedChests` is enforced at the session layer before any MCP call — type is now `{ x, y, z, label? }[]` rather than a freeform string list.

### 7.3 Building planner

**Shipped.** New MCP tools: `minecraft_place_block`, `minecraft_dig_block`. New brain action `build { plan? | description, origin?, dimensions? }`. `BuildStructureSkill` executes a placement list block-by-block, navigating closer when out of reach and clearing obstructions when `clearFirst` is set. The `MinecraftBuilder` sub-planner expands shorthand descriptions two ways: geometric primitives (`wall WxH`, `floor WxD`, `pillar N`, `box WxHxD`, `hollow_box WxHxD`) are expanded deterministically with no LLM cost; freeform descriptions call the Minecraft brain binding once to materialize concrete placements. Plans are hard-capped at 256 blocks.

### 7.4 Multi-world registry

**Shipped.** New setting `agentStack.runtimeConfig.minecraft.serverCatalog: ServerCatalogEntry[]`. The brain sees the catalog as a labeled prompt section; when the brain emits `connect { target: { label: "Creative" } }`, the session resolves the label against the catalog and backfills host/port. The single `server` field remains the default/primary target.

### 7.5 Long-horizon autonomous project loop

**Shipped.** New brain actions: `project_start`, `project_step`, `project_pause`, `project_resume`, `project_abort`. Project state persists across turns inside the session's `MinecraftPlannerState.activeProject` and surfaces to the brain via the planner-state prompt section. Infrastructure budget caps trip `budget_exceeded` failures that auto-pause the project, with concrete in-world actions (not reads, session plumbing, or chat) auto-accruing against the budget. Settings: `agentStack.runtimeConfig.minecraft.project.defaultActionBudget`. The brain decides when to start, step, pause, or abandon — the budget is a cost gate, not a creative one. Late cleanup also fixed catalog-target persistence for reconnects and stopped double-counting `look` / `connect` as project work.

---

## Phase 8: Testing

**Status: Shipped.** Test coverage added for the new reflex and capability paths alongside the earlier chat-initiated and cross-surface tests that shipped with phases 2-5.

### 8.1 Add chat-initiated behavior coverage

**Shipped with phase 2/5.2.** `minecraftSession.test.ts` already drives chat events through the tick loop, verifies the brain is called with chat context, and verifies `chatText` is sent back via `runtime.chat`.

### 8.2 Cross-surface context tests

**Shipped with phase 2.** Tests verify Discord context flows into the brain for guild-scoped sessions and confirm no DM/owner-private leakage.

### 8.3 Proactive narration tests

**Shipped with phase 3.** `minecraftNarration.test.ts` covers event significance filtering, eagerness gating, and `[SKIP]` behavior.

### 8.4 New Phase 6/7 tests

**Shipped.** `minecraftReflexes.test.ts` covers threshold logic (eat, flee vector computation, shield equip, attack, stuck detection). `minecraftBuilder.test.ts` covers geometric primitive expansion and freeform LLM-backed expansion. `minecraftSessionPhase7.test.ts` covers session dispatch for eat/equip_offhand/craft/deposit (with allowedChests enforcement)/place_block/build/project lifecycle including budget accrual and auto-pause.

### 8.5 E2E live test (manual / operator-triggered only)

- One end-to-end path: bot joins Discord → joins voice → user says "go follow Volpe in Minecraft" → bot connects to MC, follows, reports status.
- Does not run in CI. Operator-driven only per `AGENTS.md` cost-gate rules.

---

## Sequencing and dependencies

- **Phase 1** is standalone and should land first — it fixes the autonomy-alignment seams and unblocks everything else.
- **Phase 2** depends on Phase 1 (needs the orchestrator capability doc to make sense of cross-surface context).
- **Phase 3** depends on Phase 2 (narration is more coherent when brain sees Discord context).
- **Phase 4** is standalone and can land in parallel with Phase 2/3.
- **Phase 5.1a** (block projection) and **5.1b** (prismarine-viewer) both depend on `minecraft` MCP server changes and can land in either order — they don't conflict. **Phase 5.2** (backlog) and **5.3** (event enrichment) are standalone.
- **Phase 6** is standalone and can land in parallel with anything.
- **Phase 7** depends on Phase 5.1a (block projection) for meaningful crafting/building — need structural reasoning about targetable blocks and placement sites. 5.1b (prismarine-viewer) is orthogonal.
- **Phase 8** follows each phase it tests.

## Open questions

- **Multi-operator MC sessions.** Today `operatorPlayerName` is fixed at session start. Should trusted collaborators be able to say "follow me" and have the session temporarily pivot to them? Or do we require explicit session handoff?
- ~~**Owner-private vs guild-public game context.** DMs and owner-private memory don't leak into MC chat today by accident (the session is scoped). Phase 2 adds Discord context merging — we need an explicit filter there.~~ **Resolved in Phase 2:** filter lives at the plumbing boundary — `getRecentDiscordContext` is simply not wired for DM-scoped sessions in `createMinecraftSession`, so private channel history can never enter the brain's Discord-context window in the first place.
- **Narration channel routing.** Proactive narration targets the scope-keyed channel by default. Should we support a per-guild "minecraft-logbook" channel override?
- ~~**Brain model binding for high-frequency chat decisions.** If chat narration fires frequently, the `dedicated_model` binding may want a cheaper model than planning turns. Consider separate bindings for `planTurn` vs `replyToChat` vs narration.~~ **Resolved in Phase 3:** narration shares the Minecraft brain binding via `getResolvedMinecraftBrainBinding` (`src/bot/minecraftNarration.ts`). Clanky is one mind across surfaces — the same model that plans his in-world actions speaks about them to Discord, because voice consistency matters more than per-call token savings. Revisit only if cost telemetry shows narration dominating spend, latency complaints surface, or we want a deliberate stylistic difference between surfaces.
- **Vision tool budgeting.** If the brain calls `minecraft_look` frequently, vision-model token cost can balloon (image tokens are expensive). Need per-session and per-scope call budgets, plus a cooldown/budget hint the brain can see in its state snapshot ("5 of 20 looks used this session"). Block projection has no equivalent cost pressure since it rides on the existing status call.
- **prismarine-viewer fidelity for modded/packed servers.** The headless renderer uses vanilla textures; friend groups running mods, resource packs, or shaders will get misrepresented scenes. Is this an acceptable failure mode for v1 (Clanky reacts to the vanilla approximation), or does that compromise "real player" believability enough to prioritize the high-fidelity tier (5.1c) sooner?
- **Render-to-buffer performance.** Calling prismarine-viewer per `minecraft_look` invocation may have non-trivial startup cost (three.js scene construction). Benchmark whether to keep a persistent renderer alive for the session vs. spin up per call.

## Product language

Clanky's Minecraft self should feel like a real player sitting at his desk — he sees the server through game state, sees with his own eyes when a friend points at something, sees chat, sees his Discord friends, decides what to do himself, and talks about it unprompted when something interesting happens.
