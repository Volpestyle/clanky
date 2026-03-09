# Provider-Swappable Realtime Tool Ownership Plan

**Date:** March 9, 2026
**Scope:** Voice sessions running in realtime transport modes, with special attention to `replyPath=native`, `replyPath=bridge`, and `replyPath=brain`

## Goal

Support the same product behavior through multiple providers without creating duplicate sources of truth for tools, prompts, or execution semantics.

The architecture target is:

- `native`: provider owns ASR, reply planning, and provider-native tool calling
- `bridge`: local ASR provides labeled text, but the provider still owns reply planning and provider-native tool calling
- `brain`: the upstream orchestrator owns reply planning and tool loops; the realtime provider is speech transport only

## Single Sources Of Truth

The system should keep exactly one canonical implementation of each concern:

### Tool definitions

- shared schemas: `src/tools/sharedToolSchemas.ts`
- provider-safe realtime export: `src/voice/voiceToolCallToolRegistry.ts`

Providers may need different schema sanitization rules, but that adaptation must remain an export layer, not a second tool-definition layer.

### Tool execution

- local and MCP dispatch: `src/voice/voiceToolCallDispatch.ts`

Whether a tool call was planned by the full brain or by a provider-native realtime model, the execution path should converge here.

### Context / prompting

- provider-native session context: `src/voice/instructionManager.ts`
- full-brain generation context: `src/voice/voiceReplyPipeline.ts`

These are two presentation layers over the same product context: persona, memory, continuity, speaker state, channel state, and tool policy.

### Provider protocol adapters

- OpenAI: `src/voice/openaiRealtimeClient.ts`
- xAI: `src/voice/xaiRealtimeClient.ts`

These clients should only translate protocol details such as `session.update`, `response.create`, `conversation.item.create`, playback semantics, and function-call result transport.

## Ownership Matrix

| Reply path | Tool ownership | Why |
|---|---|---|
| `native` | `provider_native` | Provider is the end-to-end realtime brain |
| `bridge` | `provider_native` | Provider is still the planner; only ASR moved outboard |
| `brain` | `transport_only` | Upstream orchestrator already owns planning and tools |

The session latches this as `session.realtimeToolOwnership` during join so later refreshes and event handling do not have to recompute ownership ad hoc.

## Runtime Consequences

### Provider-native sessions (`native`, `bridge`)

- refresh provider-safe tool definitions through `refreshRealtimeTools()`
- accept provider function-call events through `handleRealtimeFunctionCallEvent()`
- execute tools through the shared dispatch layer
- return results with `sendFunctionCallOutput()`
- request follow-up model output with `scheduleRealtimeToolFollowupResponse()` when needed

### Transport-only sessions (`brain`)

- do not register provider-native tools
- do not process provider-native function-call events
- use `requestPlaybackUtterance()` only to speak already-generated text

## Maintainability Rules

- Do not create one tool registry for OpenAI and another for xAI.
- Do not duplicate tool execution logic between provider-native and full-brain paths.
- Do not let provider adapters own product behavior.
- Prefer renaming OpenAI-shaped runtime state to provider-neutral names when the state now serves multiple providers.

## Current Direction

The intended end state is:

- OpenAI and xAI are first-class variants of the same realtime tool-capable client surface
- bridge and native share the same provider-native tool/runtime infrastructure
- brain mode stays cleanly transport-only
- docs and logs describe the provider-native path generically instead of as OpenAI-specific behavior

Product language: “Bridge and native are both provider-native planning modes, brain is transport-only, and all three share one canonical context layer and one canonical tool execution layer.”
