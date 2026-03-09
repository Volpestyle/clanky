# Full-Brain Realtime Tool Ownership Plan

**Date:** March 9, 2026
**Scope:** Voice sessions running in realtime transport modes, with special attention to `replyPath=brain` and `replyPath=bridge`

## Problem

In full-brain voice sessions, Claude is already the acting brain for reply generation and tool loops, but the realtime transport provider still receives a tool registry through `session.update`.

That creates two bad behaviors:

1. **Duplicate tool authority**
   - Claude owns the real tool loop in `src/bot/voiceReplies.ts`.
   - OpenAI Realtime still gets function definitions via `src/voice/voiceToolCallInfra.ts`.
   - We end up with two independent places that can theoretically own tool execution.

2. **Provider-specific schema failures can kill brain sessions**
   - `music_play` currently has a top-level `anyOf` in `src/tools/sharedToolSchemas.ts`.
   - OpenAI Realtime rejects that schema during `session.update`.
   - The error is treated as fatal in `src/voice/sessionLifecycle.ts`, so the whole voice session exits even though OpenAI was only supposed to be transport.

This is an architectural bug, not just a bad schema bug.

## Desired End State

For voice sessions with `replyPath=brain` or `replyPath=bridge`:

- The realtime provider handles:
  - audio in/out
  - ASR / transcript transport
  - session instructions
  - response audio playback
- The brain provider handles:
  - structured intent decisions
  - tool calls
  - follow-up tool loops
  - action execution decisions
- No realtime provider tool registry is sent at all.
- No provider-native function call events are processed at all.
- The ownership mode is decided once at session creation and stored on the session, not recomputed ad hoc during later turn processing.

For voice sessions with `replyPath=native`:

- Provider-native function tools remain supported.
- Tool schemas must be exported in a provider-safe format.
- The ownership mode is also latched at session creation.

## Current State

### Brain-mode ownership already exists

`src/bot/voiceReplies.ts` already owns the real action loop:

- main generation (including music — no separate fast-path; tool calls handle search, disambiguation, and playback naturally)
- tool loop continuation

This is the correct authority for full-brain mode.

### Realtime tool registration is still unconditional

Realtime tool registration is currently triggered from:

- `src/voice/sessionLifecycle.ts` during session attach
- `src/voice/instructionManager.ts` during instruction refresh

Both flow into `refreshRealtimeTools(...)` in `src/voice/voiceToolCallInfra.ts`.

Today, that path checks provider capability, but **not** reply strategy.

### Provider event handling is still unconditional

`src/voice/sessionLifecycle.ts` binds the generic realtime `event` stream and always forwards it into `handleOpenAiRealtimeFunctionCallEvent(...)`.

That means even brain sessions still carry provider-native tool plumbing.

### Shared tool schemas are not provider-safe by construction

`toRealtimeTool(...)` in `src/tools/sharedToolSchemas.ts` passes shared schemas through unchanged.

That is fine for internal use, but not safe for provider-native exports. `music_play` is the direct example:

- shared schema is valid for our internal runtime rules
- shared schema is invalid for OpenAI Realtime function registration

## Root Cause

We currently have a **provider-agnostic tool registry** feeding **provider-specific function-calling runtimes**, without a transport-vs-brain ownership split.

The codebase already knows the difference between `replyPath=brain` and `replyPath=native` through `resolveRealtimeReplyStrategy(...)` in `src/voice/voiceConfigResolver.ts`, and `replyPath=bridge` is already treated specially in other parts of the voice stack. But that distinction is not latched onto the session and is not applied consistently to realtime tool registration or provider-side function-call handling.

## Plan

## Phase 1: Latch Tool Ownership At Session Creation

### Decision

At session creation, derive a single latched ownership mode and store it on the session.

Proposed session field:

- `session.realtimeToolOwnership`
  - `"transport_only"` for `replyPath=brain`
  - `"transport_only"` for `replyPath=bridge`
  - `"provider_native"` for `replyPath=native`

This replaces the current pattern where tool-related behavior is inferred repeatedly from current settings at later call sites.

### Changes

1. Add a resolver in `src/voice/voiceConfigResolver.ts` that maps reply path to a latched tool-ownership mode.
2. Populate that field when creating the session in `src/voice/voiceJoinFlow.ts`.
3. Prefer the latched session field over re-reading reply path at runtime for tool-registration and provider-function-call decisions.

### Expected Result

- Mode decisions are stable for the life of a session.
- Mid-session settings churn cannot create split-brain ownership behavior.
- Later code paths can branch on one explicit source of truth.

## Phase 2: Make Transport-Only Sessions Truly Transport-Only

### Decision

In any realtime voice session where `session.realtimeToolOwnership === "transport_only"`:

- do not call `updateTools`
- do not maintain provider-native tool registry state
- do not process provider-native function call events

### Changes

Add explicit gating helpers in `src/voice/voiceConfigResolver.ts`:

- `shouldRegisterRealtimeTools({ session, settings })`
- `shouldHandleRealtimeFunctionCalls({ session, settings })`

Rules:

- `transport_only` => `false`
- `provider_native` => `providerSupports(..., "updateTools")`

Replace raw `providerSupports(..., "updateTools")` checks at these call sites:

- `src/voice/sessionLifecycle.ts`
- `src/voice/instructionManager.ts`
- `src/voice/voiceSessionManager.ts`
- `src/voice/voiceToolCallInfra.ts`

### Expected Result

- Full-brain and bridge-only OpenAI Realtime sessions stop sending tool schemas entirely.
- OpenAI schema incompatibilities can no longer kill a brain-mode session.
- Claude remains the single tool-calling authority in brain mode.
- OpenAI Realtime becomes transport-only in non-native sessions: audio, VAD, transcription, and TTS, but no function calling.

## Phase 3: Keep Native Mode, But Make It Provider-Safe

Native realtime mode still needs provider-side function tools. That path should remain, but it must stop reusing raw shared schemas blindly.

### Changes

Split tool export into two layers:

1. **Shared internal schema**
   - Keep current shared schema definitions for Claude/internal tool execution.

2. **Provider-native export schema**
   - Add a provider-specific exporter in `src/voice/voiceToolCallToolRegistry.ts` or a new dedicated module.
   - Example API:
     - `buildRealtimeFunctionTools(manager, { session, settings, target: "openai_realtime" | "xai_realtime" })`

For OpenAI Realtime:

- flatten or rewrite incompatible schemas
- no top-level `anyOf` / `oneOf` / `allOf`
- ensure top-level `type: "object"`

For `music_play`, export a provider-safe shape such as:

- `type: "object"`
- properties: `query`, `selection_id`, `platform`, `max_results`
- no top-level combinators
- runtime validation still enforces "query xor selection_id-ish" semantics

### Expected Result

- Native mode keeps working.
- Provider-side tools become explicit and testable.
- Shared tool schema design stops being constrained by one provider's parser.

## Phase 4: Remove Transport-Only Native Tool Coupling

After Phase 2, some session state and prompt wiring becomes dead or misleading in transport-only sessions.

### Cleanup Targets

- `session.openAiToolDefinitions`
- `session.openAiPendingToolCalls`
- `session.openAiToolCallExecutions`
- `session.openAiCompletedToolCallIds`
- tool-related instruction sections that only exist to coach provider-native function calling

### Changes

1. Only initialize provider-native tool state in native sessions.
2. Stop including native tool policy instructions in brain-mode realtime prompts.
3. Audit reply/output-lock code that watches native tool executions and make sure it only does so in native mode.
4. Rename OpenAI-specific fields if they remain as generic native-tool runtime state, or delete them if they become unnecessary.

### Expected Result

- Brain and bridge sessions no longer carry dead native-tool machinery.
- Runtime snapshots and logs become easier to reason about.

## Phase 5: Harden Failure Handling

Even after ownership is split, provider-native registration failures should be handled more deliberately.

### Changes

1. Pre-validate exported provider-native schemas before sending `session.update`.
2. Log whether tool registration was:
   - skipped because session ownership is `transport_only`
   - applied because session ownership is `provider_native`
   - rejected by provider
3. In brain mode, provider tool registration errors should be impossible.
4. In native mode, schema export failures should fail fast with a precise internal error before runtime connect if possible.

### Expected Result

- Clearer logs
- No more misleading "tools updated" followed by async rejection surprises

## Tests

## Unit / Integration

### `src/voice/voiceConfigResolver.test.ts`

Add coverage for:

- session ownership resolves to `transport_only` for `replyPath=brain`
- session ownership resolves to `transport_only` for `replyPath=bridge`
- session ownership resolves to `provider_native` for `replyPath=native`
- `shouldRegisterRealtimeTools` returns `false` for transport-only sessions
- `shouldRegisterRealtimeTools` returns `true` for provider-native sessions when provider supports it
- `shouldHandleRealtimeFunctionCalls` follows the same rule

### `src/voice/voiceToolCallInfra.test.ts`

Add coverage for:

- `refreshRealtimeTools` no-ops in brain mode
- `refreshRealtimeTools` no-ops in bridge mode
- `refreshRealtimeTools` still registers tools in native mode
- provider-native tool export rewrites `music_play` into a Realtime-safe schema

### `src/voice/voiceSessionManager.lifecycle.test.ts`

Add coverage for:

- session attach latches transport-only ownership for brain sessions
- session attach latches transport-only ownership for bridge sessions
- session attach does not call `updateTools` when session ownership is transport-only
- instruction refresh does not call `updateTools` when session ownership is transport-only
- realtime `error_event` for invalid tool schema is no longer reachable in brain mode startup

### `src/voice/voiceSessionManager.addressing.test.ts` or a dedicated lifecycle test

Add coverage for:

- provider function-call events are ignored in brain mode
- provider function-call events are ignored in bridge mode
- provider function-call events still execute in native mode

### `src/bot/voiceReplies.test.ts`

Keep or extend coverage proving:

- brain mode music actions still run through structured voice intent / Claude tool loop
- no OpenAI-native tool registration is needed for music playback in brain mode

## Optional E2E After Unit Coverage

Do not run live smoke during this change by default.

After unit/integration coverage is in place, the best E2E confirmation is:

1. OpenAI Realtime transport + `replyPath=brain` + `brainProvider=anthropic`
2. Join voice channel
3. Confirm no provider tool registration occurs
4. Ask for music
5. Confirm Claude path handles tool/action flow and music starts

## Implementation Order

1. Add reply-strategy gating helpers.
2. Latch session ownership at session creation.
3. Gate session-start tool registration.
4. Gate instruction-refresh tool registration.
5. Gate provider-native function-call event handling.
6. Add tests proving transport-only sessions no longer register tools.
7. Add provider-specific native export layer.
8. Update native-mode tests for provider-safe schema export.
9. Delete dead transport-only native tool state / prompt coupling.

## Acceptance Criteria

This work is complete when all of the following are true:

- Joining an OpenAI Realtime voice session in `replyPath=brain` does not send tool schemas.
- Joining an OpenAI Realtime voice session in `replyPath=bridge` does not send tool schemas.
- Full-brain voice sessions no longer fail because of provider-native schema validation.
- Bridge-only voice sessions no longer fail because of provider-native schema validation.
- Claude remains the only tool-calling authority in brain mode.
- OpenAI Realtime is transport-only in non-native sessions.
- Native mode still supports provider-side function calling with provider-safe schemas.
- Brain-mode music requests still work end-to-end.
- Dead native-tool compatibility paths are removed from brain mode rather than left dormant.

## Non-Goals

- Reworking the entire voice admission pipeline
- Replacing Claude tool loops with fully deterministic non-LLM routing for all voice actions
- Adding new provider-native capabilities beyond what native mode already intends to support

## Short Version

The complete fix is:

- **brain mode:** transport only, no realtime tools
- **bridge mode:** transport only, no realtime tools
- **native mode:** provider tools allowed, but exported through a provider-safe schema layer
- **mode latch:** decide ownership once at session creation, not per turn
- **cleanup:** remove transport-only native tool plumbing instead of keeping both paths alive
