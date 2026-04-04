# Settings System

Canonical reference for how settings are authored, stored, resolved, served to the dashboard, and applied to the live runtime.

Companion docs:

- [`../architecture/presets.md`](../architecture/presets.md) for preset-specific defaults and product intent
- [`../architecture/overview.md`](../architecture/overview.md) for the broader runtime architecture
- [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md) for voice-specific stage behavior
- [`../capabilities/browser.md`](../capabilities/browser.md) for browser-runtime behavior
- [`../capabilities/code.md`](../capabilities/code.md) for code-agent behavior
- [`../capabilities/minecraft.md`](../capabilities/minecraft.md) for Minecraft runtime behavior and brain ownership

## 1. Mental Model

The settings system has four distinct layers:

1. `intent`
   - The operator-authored settings snapshot.
   - This is the only settings data that is persisted.

2. `effective`
   - The fully normalized runtime settings after preset defaults, canonical fallbacks, clamping, and coercion are applied.
   - This is the object the runtime actually reads.

3. `bindings`
   - Derived runtime helpers for the dashboard and debugging.
   - Examples: resolved orchestrator binding, voice generation binding, voice runtime family, provider auth availability.
   - Bindings are computed from `effective`. They are never persisted.

4. Control metadata
   - Save version, runtime-apply status, and similar control-plane state.
   - This is not part of the settings model itself.

The critical rule is: authored settings, resolved runtime state, and control metadata must stay separate.

## 2. Persistence Contract

The canonical settings row lives in SQLite:

- table: `settings`
- key: `runtime_settings`
- value: authored settings intent JSON
- version: `updated_at`

The database does not store materialized preset fallbacks or dashboard-only resolved helpers.

Before settings are written, the store minimizes the authored snapshot through `src/settings/settingsIntent.ts`. Any authored field that can be removed without changing normalized runtime behavior is stripped before persistence.

That means:

- unset inherited fields stay absent
- save operations do not freeze preset defaults into sticky overrides
- dashboard/runtime helper fields never leak into storage

## 3. Dashboard API Contract

`GET /api/settings` returns a settings envelope:

```ts
{
  intent,
  effective,
  bindings,
  _meta
}
```

Current meanings:

- `intent`: persisted operator-authored snapshot
- `effective`: normalized runtime settings
- `bindings`: resolved runtime helpers for display/debugging
- `_meta`: version and save/apply metadata

The dashboard edits `intent`. It uses `effective` and `bindings` as a runtime preview, but on save it materializes and submits the next full authored snapshot instead of sending a sparse intent patch.

`PUT /api/settings` accepts:

- the next full authored `intent` snapshot in the request body
- `_meta.expectedUpdatedAt` for optimistic concurrency

Save semantics:

- the request body replaces the full authored snapshot
- omitted branches revert to defaults or inherited runtime behavior after normalization
- this is not merge-patch behavior

Current save guarantees:

- saves are compare-and-swap on `settings.updated_at`
- stale tabs get `409`
- missing version metadata is rejected
- persistence and live-runtime apply are separate outcomes
- a save can succeed even if live voice sessions fail to reconcile immediately
- successful live apply rebinds active voice-session timers and refreshes realtime tools/instructions for sessions that support hot updates

`POST /api/settings/preset-defaults` returns a preview envelope for a selected preset. Save is still required before that preview becomes persisted intent.

`POST /api/settings/refresh` reapplies the last saved effective settings to the live runtime. For active voice sessions, it hot-refreshes session timers plus realtime tools/instructions where the provider supports in-place updates. It does not apply unsaved form draft state.

## 4. Resolution Pipeline

![Settings Flow](../diagrams/settings-flow.png)

<!-- source: docs/diagrams/settings-flow.mmd -->

Canonical pipeline:

```text
Persisted intent
  ↓
Intent minimization (`src/settings/settingsIntent.ts`)
  ↓
Normalization (`src/store/settingsNormalization.ts` + `src/store/normalize/*`)
  ↓
Resolved runtime bindings (`src/settings/agentStack.ts`)
  ↓
Dashboard envelope (`src/settings/dashboardSettingsState.ts`)
```

Responsibility split:

- `src/settings/settingsSchema.ts`
  - canonical settings shape and defaults

- `src/settings/settingsIntent.ts`
  - strips redundant authored fields before persistence

- `src/store/settingsNormalization.ts`
  - canonical normalization entrypoint

- `src/store/normalize/*`
  - section-specific coercion, bounds, and fallback logic

- `src/settings/agentStack.ts`
  - preset/runtime resolution and derived model/runtime bindings

- `src/settings/dashboardSettingsState.ts`
  - dashboard envelope and resolved dashboard-facing bindings

## 5. Top-Level Settings Map

Top-level persisted groups:

- `identity`
- `persona`
- `prompting`
- `permissions`
- `interaction`
- `agentStack`
- `memory`
- `memoryLlm`
- `initiative`
- `voice`
- `media`
- `music`
- `automations`

High-level ownership:

| Group | Primary responsibility |
|---|---|
| `identity`, `persona`, `prompting` | model context and presentation |
| `permissions` | deterministic safety and access control |
| `interaction` | text reply budgets, followup behavior, sessions, startup/catchup |
| `agentStack` | preset selection, runtime families, model/runtime bindings |
| `memory`, `memoryLlm` | durable memory behavior and retrieval/generation bindings |
| `initiative` | ambient text and voice initiative cadence |
| `voice` | conversation policy, admission, transcription, channel/session limits, soundboard |
| `media` | vision and video context |
| `music` | playback ducking/runtime-adjacent music behavior |
| `automations` | scheduled autonomous work |

At the product level, `permissions` is not just a raw allow/block layer. It is the deterministic enforcement surface for Clanky's relationship model: broad community-safe capabilities in shared Discord spaces, higher-trust collaborator capabilities for approved users on approved resources, and owner-scoped device capabilities for the operator's local instance. The conceptual model lives in [`../architecture/relationship-model.md`](../architecture/relationship-model.md).

## 6. Presets And Overrides

Presets are starting points, not an alternate storage system.

Rules:

- `agentStack.preset` selects the preset definition
- preset defaults seed missing values during normalization
- explicit overrides are authored in `intent`
- `effective` is the combination of preset defaults plus authored overrides
- removing an authored override should return the field to inherited preset behavior
- when multiple sources can supply the same runtime choice, explicit authored runtime config wins over preset defaults

Important consequence:

- the store should never persist a preset-derived value just because the dashboard displayed it

Preset-specific default choices and product intent live in [`../architecture/presets.md`](../architecture/presets.md).

## 7. Feature-Local Settings Docs

`docs/reference/settings.md` is the canonical cross-cutting contract. Feature docs still own the meaning of feature-local knobs:

- browser runtime knobs and behavior: [`../capabilities/browser.md`](../capabilities/browser.md)
- code-agent knobs and behavior: [`../capabilities/code.md`](../capabilities/code.md)
- Minecraft runtime knobs and brain binding: [`../capabilities/minecraft.md`](../capabilities/minecraft.md)
- `agentStack.runtimeConfig.devTeam.workspace` controls whether local coding workers use the shared checkout or isolated worktrees; its behavioral contract lives in [`../capabilities/code.md`](../capabilities/code.md)
- `agentStack.runtimeConfig.devTeam.swarm` is the optional MCP coordination wiring for local code workers; its behavioral contract also lives in [`../capabilities/code.md`](../capabilities/code.md)
- voice transport and pipeline knobs: [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md)
- activity/attention-facing behavior knobs: [`../architecture/activity.md`](../architecture/activity.md)

Those docs explain what a setting means behaviorally. This doc explains how settings exist as data.

## 8. Rules For Future Changes

When adding or changing settings:

- persist operator intent only
- do not save resolved fallbacks back into storage
- keep derived helpers in `bindings`, not in persisted settings
- keep control-plane data separate from the settings payload
- add new normalization logic in canonical section normalizers instead of dashboard-only mappers
- document the feature-local meaning in the relevant feature doc
- document any cross-cutting contract change here

The failure mode to avoid is a hybrid payload where authored settings, resolved runtime state, and dashboard control metadata are mixed together and then accidentally re-saved as if they were all operator intent.
