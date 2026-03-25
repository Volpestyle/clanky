# Presence And Attention Alignment Plan

Status: complete

Reference:
- [`docs/architecture/presence-and-attention.md`](../../architecture/presence-and-attention.md)
- [`docs/architecture/activity.md`](../../architecture/activity.md)
- `AGENTS.md` core principle: shared context, soft guidance, no fake extra modes

## Review Summary

The text side was already broadly aligned with the shared `ACTIVE` / `AMBIENT` model.
The remaining drift was concentrated in the voice spoke, plus legacy settings compatibility and stale attention-era tests.

### Confirmed Gaps

1. Voice reply admission still had multiple competing notions of “addressed to me”.
   - The shared decider, music overlay, and cancel/standing path were not reading the same cue source.

2. Voice generation still treated room-level `ACTIVE` like speaker-level follow-up continuity.
   - `attentionMode === "ACTIVE"` was suppressing eager/ambient handling even when the current speaker was not part of the live thread.

3. The classifier prompt was still missing the canonical shared-attention summary.
   - It had recency fragments, but not an explicit room-level `ACTIVE` / `AMBIENT` state plus current-speaker continuity.

4. Music wake behavior was still framed like a pseudo-mode in the classifier prompt.
   - The canonical design says music playback and wake latch are overlays, not a separate command mind.

5. Voice reply generation still threaded unused soft-addressing prompt context.
   - The generation prompt path was carrying `voiceAddressingState` even though the live prompt should ignore soft guesses.

## Execution Plan

- [x] Introduce a canonical voice attention context that exposes room-level `ACTIVE` / `AMBIENT` and keeps speaker-specific continuity as a separate signal.
- [x] Refactor voice reply admission, prompting, snapshots, and dashboard types/UI to consume canonical attention terms.
- [x] Make the ambient voice thought loop depend on `AMBIENT` attention instead of only silence-plus-transport heuristics.
- [x] Remove unused voice addressing admission plumbing that no longer changes behavior.
- [x] Remove legacy settings aliases from normalization and test helpers, then rewrite affected tests around the canonical fields only.
- [x] Cut or rewrite legacy-label tests so the suite validates business behavior instead of obsolete internal wording.
- [x] Run `bun run test` and `bun run typecheck`, then update this document to reflect final status and any remaining follow-up.

## Completed Work

1. Canonical text attention and ambient thought behavior now use shared `ACTIVE` / `AMBIENT` semantics across admission, prompting, docs, settings normalization, and tests.

2. Voice attention now separates:
   - room-level `attentionMode`
   - speaker-level `currentSpeakerActive`
   - overlays such as music wake latch, pending command follow-up, and interruption recovery

3. Voice direct-address handling now uses one shared resolver.
   - deterministic direct address still uses exact wake-word / alias matching
   - softer name-cue detection now uses the canonical bot name only, which avoids alias-driven false positives in music gating and cancel standing

4. Voice generation no longer treats room-level `ACTIVE` as if the current speaker were automatically in-thread.
   - `isEagerTurn` now keys off `currentSpeakerActive`

5. The classifier prompt now explicitly reflects the canonical model.
   - shared attention state
   - whether the current speaker is in the active thread
   - pending command follow-up signal
   - interruption-recovery state
   - music wake as an overlay, not a separate mode

6. Vestigial prompt plumbing was removed from live voice generation.
   - `voiceAddressingState` is no longer threaded into generation-only conversation context

## Verification

- `bun run typecheck`
- `bun run test src/voice/voiceReplyDecision.test.ts src/voice/voiceMusicPlayback.test.ts src/voice/turnProcessor.test.ts src/voice/voiceSessionManager.addressing.test.ts --bail`
  - completed as part of the default unit/integration suite run
  - result: `1086 pass`, `0 fail`

## Completion Bar

This work is now complete:

- voice runtime surfaces `ACTIVE` / `AMBIENT` instead of legacy pseudo-modes
- overlays such as music wake latch and command follow-up are represented as overlays, not replacement attention modes
- voice thought generation only runs while ambient
- legacy normalization aliases used only for old saved settings are removed from the canonical runtime path
- affected docs and tests match the shipped model
