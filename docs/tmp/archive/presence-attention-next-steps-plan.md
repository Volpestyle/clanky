# Presence And Attention Next Steps Plan

Status: proposed

Reference:
- [`docs/architecture/presence-and-attention.md`](../../architecture/presence-and-attention.md)
- [`docs/architecture/activity.md`](../../architecture/activity.md)
- [`docs/voice/voice-provider-abstraction.md`](../../voice/voice-provider-abstraction.md)
- [`docs/architecture/initiative.md`](../../architecture/initiative.md)
- [`docs/tmp/presence-attention-alignment-plan.md`](presence-attention-alignment-plan.md)
- [`docs/tmp/thought-queue-alignment-plan.md`](thought-queue-alignment-plan.md)

## Goal

Finish the last important convergence work after the recent shared-attention alignment:

- keep one social mind across text and voice
- preserve modality-specific floor ownership
- treat `bridge` as an explicit transport exception, not a conceptual failure
- keep cross-modal continuity strong without making Clanker jump into unrelated surfaces just because he is already active somewhere else

## Current State

The runtime is now much closer to the canonical model:

- text and voice both speak in terms of shared `ACTIVE` / `AMBIENT`
- ambient text and ambient voice both support pending-thought continuity
- docs now describe shared attention with transport-specific spokes instead of separate minds

The remaining work is mostly about sharpening boundaries and making the shipped exceptions explicit.

## Remaining Gaps

### 1. Bridge exception is real, but not yet treated as a first-class design boundary

`bridge` reply mode cannot rely on native `[SKIP]`, so classifier-first admission is still required there.

That is acceptable, but the code and docs should make the rule unambiguous:

- `bridge` is classifier-first because of transport constraints
- `brain` should stay generation-owned by default
- `native` follows provider-native floor behavior

We should avoid language that makes the `bridge` exception look like a general statement about the whole voice spoke.

### 2. Brain-path voice admission still needs a cleaner ownership story

For `brain` reply mode, the desired rule is:

- deterministic safety/cost/floor gates may still run first
- after that, real active turns should reach the main brain
- the model decides reply vs `[SKIP]`

The remaining cleanup is to make sure `generation_decides` really means that in practice, and to keep optional classifier-first behavior clearly optional instead of semantically central.

### 3. Cross-modal continuity needs stronger asymmetry guarantees

The important product behavior is continuity, not a literal shared state-machine module.

Desired behavior:

- a text ping can make Clanker more awake in VC
- a VC wakeup can make nearby text context feel continuous
- being active in VC should not by itself make him jump into random text threads
- being active in text should not by itself force voice output

The code is close to this already, but the contract should become more explicit in prompt framing, docs, and tests.

### 4. Lightweight continuity observability is still weaker than the behavior deserves

We now have shared continuity semantics, but runtime visibility is still fragmented.

We should be able to inspect:

- current continuity mode
- why it is `ACTIVE`
- which speaker or author currently owns the live thread
- whether continuity came from text, voice, interruption recovery, or command follow-up

This matters for debugging future regressions without re-litigating the model each time.

## Execution Plan

### 1. Make reply-path ownership explicit

- Audit `voiceReplyDecision`, settings mapping, and dashboard wording so `bridge`, `brain`, and `native` describe ownership clearly.
- Keep `bridge` classifier-first by design.
- Keep `brain` on `generation_decides` by default.
- Treat optional classifier-first on `brain` as an override, not as the default mental model.

Primary files:

- `src/voice/voiceReplyDecision.ts`
- `src/settings/voiceDashboardMappings.ts`
- `src/settings/agentStack.ts`
- `dashboard/src/components/settingsSections/VoiceModeSettingsSection.tsx`
- [`docs/architecture/activity.md`](../../architecture/activity.md)
- [`docs/voice/voice-provider-abstraction.md`](../../voice/voice-provider-abstraction.md)

### 2. Lock in cross-modal asymmetry

- Keep text `ACTIVE` promotion text-local: direct address, reply-to-bot, same-author follow-up, or other explicitly local thread signals.
- Do not let “active voice session exists” silently widen unrelated text reply admission.
- Keep voice floor-taking voice-local even when text recently promoted shared attention.
- Add prompt language that frames other-surface activity as continuity context, not as automatic permission to speak.

Primary files:

- `src/bot/replyAdmission.ts`
- `src/bot/replyPipeline.ts`
- `src/prompts/promptText.ts`
- `src/prompts/promptVoice.ts`
- [`docs/architecture/presence-and-attention.md`](../../architecture/presence-and-attention.md)
- [`docs/architecture/activity.md`](../../architecture/activity.md)

### 3. Add a lightweight continuity debug surface

- Expose current attention mode and reason in runtime snapshots/logs for both text and voice paths.
- Make cross-modal continuity sources visible, not just inferred from scattered timestamps.
- Prefer one canonical summary shape reused by logs, snapshots, and prompts.

This does not require a giant new hub module. A small shared summary contract is enough.

Primary files:

- `src/bot/replyAdmission.ts`
- `src/voice/voiceReplyDecision.ts`
- `src/voice/voiceRuntimeSnapshot.ts`
- `src/voice/voiceSessionTypes.ts`
- any text-side runtime snapshot/debug surface that already exists

### 4. Tighten focused tests around the intended product contract

Add or update only the tests that protect the important behavior:

- `bridge` stays classifier-first
- `brain` active turns are generation-owned by default
- active VC does not auto-promote unrelated text turns into `ACTIVE`
- recent cross-modal continuity can still show up as prompt context without forcing output
- runtime snapshots/logs expose the same attention reason the prompts see

Primary files:

- `src/voice/voiceReplyDecision.test.ts`
- `src/bot/replyAdmission.test.ts`
- `src/bot/voiceReplies.test.ts`
- other focused prompt/runtime tests only where the contract is otherwise unprotected

## Non-Goals

- Do not build a giant monolithic shared attention state machine just to satisfy the docs.
- Do not erase modality-specific floor rules in the name of “unification.”
- Do not make VC activeness a blanket text-participation permission.
- Do not remove the `bridge` classifier path unless the transport can natively express `[SKIP]`.

## Done Criteria

- `bridge`, `brain`, and `native` each have a crisp documented ownership model.
- `brain` mode is clearly generation-owned by default after deterministic safety/cost/floor gates.
- Cross-modal continuity is preserved, but unrelated text/voice surfaces do not auto-activate each other.
- Shared attention reasons are visible in runtime/debug output, not only buried in prompt assembly.
- Canonical docs describe the shipped behavior without apologizing for the distributed implementation.

Product language: Clanker should feel like one person whose attention carries across text and voice, while each medium still keeps its own natural right to the floor.
