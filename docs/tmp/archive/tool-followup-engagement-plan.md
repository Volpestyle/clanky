# Tool Followup Engagement Plan

**Date:** March 9, 2026
**Scope:** Minimal deterministic floor control for voice tool followups that belong to one engaged user

## Problem

The immediate failure mode is not that the model lacks enough prompting. It is that unrelated turns can still reach the model during a tool-owned followup window.

The cheap model-facing mitigations are still worth doing and keeping:

- classifier context that names the active command owner
- correct `is_error` signaling on failed tool results
- tighter tool descriptions so the model understands when a tool is asking for user repair

But those are soft controls. The hard fix is to stop unrelated turns before they reach the model.

## Current Working Assumptions

We are already most of the way there:

- music disambiguation already creates temporary ownership with `voiceCommandState`
- the classifier already sees active command ownership context
- the main missing piece is a small deterministic gate that says "this followup currently belongs to user X"

We do **not** need a large generalized framework yet.

## Minimal Plan

### 1. Keep The Cheap Model-Facing Layer

Treat these as first-class, not optional hints:

- active command owner in classifier context
- `is_error` on failed tool outputs
- clearer music/tool descriptions

These are low-cost and already improve the common cases.

### 2. Use A Minimal Followup Lease

Do not introduce a large typed framework yet. Start with the smallest useful ownership record:

```ts
type VoiceFollowupLease = {
  ownerUserId: string | null;
  domain: string | null;
  expiresAt: number;
};
```

Implementation-wise, this can ride on the existing `voiceCommandState` path first rather than creating a second ownership system.

### 3. Add One Deterministic Admission Gate

Before classifier or generation dispatch:

- if the lease owner is speaking, allow the turn
- if someone else is speaking, block the turn
- if the user says stop/cancel, let the existing cancel path clear the work and lease

That is the main value. It prevents cross-talk from ever entering the model during the owned followup window.

### 4. Defer The Rest

Do **not** build these yet unless logs show they are still needed:

- tool-returned followup metadata
- explicit interruption-policy overrides
- deferred-turn pruning logic
- broad prompt-context expansions
- per-domain followup abstractions beyond what music already needs

## Tests

Add focused coverage for:

- owner admitted during active followup lease
- other speaker blocked during active followup lease
- failed realtime tool output includes `is_error`
- music ambiguity still behaves correctly with the minimal lease

## Follow-On Criteria

Only move to the larger system if logs still show:

- stale deferred turns replaying after the owned followup resolves
- interruption behavior still letting other speakers cut in at the wrong time
- a second tool domain truly needing structured followup metadata
