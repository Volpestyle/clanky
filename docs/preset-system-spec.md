# Preset System Spec

Canonical reference for how agent stack presets work. Preset names and runtime resolution live in `src/settings/settingsSchema.ts` and `src/settings/agentStack.ts`.

## Presets

Six named presets. Each is a coherent combination of orchestrator, voice pipeline, tool ownership, and cost profile.

| Preset | Auth | Orchestrator | Voice Reply | Voice Runtime | Tool Ownership | Cost Profile |
|---|---|---|---|---|---|---|
| `claude_oauth` | OAuth token | claude-oauth/claude-opus-4-6 | brain | openai_realtime | transport_only | zero (subscription) |
| `claude_api` | API key | anthropic/claude-sonnet-4-6 | brain | openai_realtime | transport_only | pay-per-token |
| `openai_native_realtime` | API key | openai/gpt-5 | bridge | openai_realtime | provider_native | pay-per-token |
| `openai_api` | API key | openai/gpt-5 | brain | openai_realtime | transport_only | pay-per-token |
| `openai_oauth` | OAuth token | OpenAI OAuth (`openai-oauth`)/gpt-5.4 | brain | openai_realtime | transport_only | subscription-limited |
| `grok_native_agent` | API key | xai/grok-4-latest | native | voice_agent | provider_native | pay-per-token |

### Voice Reply Paths

- **native** — Audio in → realtime model → audio out. Model handles everything including tool calls. Used by `grok_native_agent`.
- **bridge** — Audio in → ASR transcript → realtime model (text) → audio out. Realtime model handles tool calls. Used by `openai_native_realtime`.
- **brain** — Audio in → ASR transcript → text LLM → TTS → audio out. Text LLM handles tool calls via internal orchestrator. Used by `claude_oauth`, `claude_api`, `openai_api`, `openai_oauth`.

### Tool Ownership

- **provider_native** — Tools registered with the realtime/voice-agent API. The provider model calls them directly. Used when voice reply path is `native` or `bridge`.
- **transport_only** — Realtime connection is audio transport only. Tool calls go through the internal text orchestrator (brain path). Used when voice reply path is `brain`.

Tools are defined once in `src/tools/sharedToolSchemas.ts` and adapted per target via format converters (`toAnthropicTool`, `toRealtimeTool`). The tool registry in `voiceToolCallToolRegistry.ts` conditionally includes tools based on feature flags (memory, research, browser, code agent) regardless of which preset is active.

### Preset Defaults Detail

Each preset sets defaults for:

1. **Harness** — `internal` (our orchestrator) or `responses_native` (OpenAI Responses SDK)
2. **Orchestrator** — provider + model for text replies and follow-up loops
3. **Research runtime** — `openai_native_web_search` (hosted) or `local_external_search` (our search pipeline)
4. **Browser runtime** — `openai_computer_use` (hosted) or `local_browser_agent` (Playwright)
5. **Voice runtime** — `openai_realtime`, `voice_agent`, etc.
6. **Voice reply path** — `native`, `bridge`, or `brain`
7. **Voice TTS mode** — `realtime` or `api` (only relevant for brain path)
8. **Voice admission policy** — `generation_decides`, `classifier_gate`, or `adaptive`
9. **Voice admission classifier** — provider + model for the reply classifier
10. **Voice generation** — provider + model for brain-path text generation (when different from orchestrator)
11. **Dev team** — orchestrator, role bindings, coding workers

`devTeam.roles.*` are worker-routing defaults, not direct model bindings. The orchestrator plans the work, then the selected role determines which worker instance to spin up, and that worker's runtime config supplies its own model.

Current preset intent:

- `openai_oauth`, `openai_api`, and `openai_native_realtime` use `codex-cli` as the default implementation worker, with `claude-code` also available as a local worker
- `claude_oauth` and `claude_api` use `claude-code` as the default implementation worker, with `codex-cli` also available as a local worker
- `claude_oauth` keeps the voice reply classifier on `claude-haiku-4-5`, but the brain-path voice generation model defaults to `claude-sonnet-4-6`
- remote `codex` is a manual opt-in worker, not part of the preset-default local worker ordering

## Modularity

Even with a preset selected, the user can:

- Change voice reply path (native/bridge/brain)
- Swap voice runtime provider (openai/xai/gemini/elevenlabs)
- Enable advanced overrides to customize orchestrator, research runtime, browser runtime, etc.
- Override any individual model binding

The preset defines the starting point. User changes layer on top.

## Dashboard UX

### Preset Selector

The Stack Preset section shows a dropdown with all 6 presets. Selecting a new preset fetches preview defaults from `/api/settings/preset-defaults` and applies them to the form, updating orchestrator, voice runtime, voice reply path, admission mode, and generation models.

The preview is local-only. The dirty indicator stays on until the user clicks Save, and runtime settings do not change just from selecting a preset in the dashboard.

### Reset to Preset Defaults

A "Reset to preset defaults" button next to the preset dropdown loads a full normalized default form for the selected preset. It resolves the selected preset through canonical normalization and preserves only server-specific channel permissions and voice channel policy. Save is still required before those defaults affect the live bot.

### Advanced Overrides

When `advancedOverridesEnabled` is true, additional sections appear: Advanced Stack (LLM), Research Runtime, Browser Runtime, Dev Team, Sessions. These allow per-field overrides that persist independently of preset selection.

## Settings Resolution Flow

```
User settings (data/settings.json)
  ↓
Normalization (settingsNormalization.ts)
  ├── Preset name normalization
  ├── Preset config seeds defaults for admission mode, reply path, TTS mode
  └── Per-section normalization (bounds, validation)
  ↓
Resolved Agent Stack (agentStack.ts → resolveAgentStack())
  ├── Merges preset defaults + overrides
  └── Produces runtime-only ResolvedAgentStack
  ↓
Runtime uses resolved bindings
```

## Accepted Preset Identifiers

Normalization accepts these preset identifiers and resolves them to canonical preset names:

| Input Name | Canonical Name |
|---|---|
| `claude_oauth_local_tools` | `claude_oauth` |
| `claude_oauth_openai_tools` | `claude_oauth` |
| `claude_oauth_max` | `claude_oauth` |
| `anthropic_brain_openai_tools` | `claude_api` |
| `anthropic_api_openai_tools` | `claude_api` |
| `openai_native` | `openai_native_realtime` |
| `custom` | `openai_api` |
