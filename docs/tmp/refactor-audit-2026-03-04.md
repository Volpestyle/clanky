# Refactor Audit And Remediation

Date: March 4, 2026

## Scope

This document tracks the cleanup pass requested across the repository, starting from the findings produced after reading `docs/` and auditing the implementation.

## Findings To Address

- [x] Unify text and voice `memory_search` / `memory_write` behavior behind one shared implementation.
- [x] Remove reply-pipeline duplicate helpers and the `bot.ts` <-> `bot/replyPipeline.ts` circular dependency.
- [x] Collapse duplicated voice music helper logic to a single implementation.
- [x] Remove legacy `voice.realtimeReplyStrategy` compatibility behavior and use `voice.replyPath` as the single runtime source of truth.
- [x] Deduplicate realtime provider/model normalization helpers and constants.
- [x] Clean generated-artifact / build-output issues affecting lint and repository hygiene.
- [x] Reduce `any`-driven extracted-module boundaries where the duplication cleanup touches them.

## Working Notes

### Architecture intent from docs

- The docs describe extracted bot domains, extracted voice domains, and provider-agnostic voice/runtime helpers as the intended architecture.
- The repository instructions explicitly prefer a single source of truth and removing legacy compatibility paths as part of refactors.

### Concrete mismatches found

- Text and voice memory tools currently share names but not schema or execution behavior.
- `replyPipeline.ts` was extracted, but copied helper logic still exists in `bot.ts`, and `replyPipeline.ts` imports back from `bot.ts`.
- Voice music runtime helpers exist in both `voiceSessionManager.ts` and `voiceMusicPlayback.ts`.
- Runtime reply-path logic still carries `realtimeReplyStrategy` fallback logic.
- Realtime provider normalization/model constants are duplicated in multiple modules.
- Lint currently traverses generated Rust build output and a tracked Rust build log exists in the repo.

## Execution Log

### 2026-03-04

- Created tracking document.
- Confirmed `bun run typecheck` passes before changes.
- Confirmed `bun run lint` fails on both real issues and generated artifact traversal.
- Started refactor work in dependency order:
  1. reply pipeline extraction cleanup
  2. shared memory tool core
  3. voice music helper dedupe
  4. reply-path cleanup
  5. realtime normalization dedupe
  6. lint / generated-artifact cleanup
- Added `src/bot/replyPipelineShared.ts` and moved reply pipeline shared helpers/constants there so `src/bot/replyPipeline.ts` no longer imports back from `src/bot.ts`.
- Added `src/memory/memoryToolRuntime.ts` and switched both text reply tools and voice realtime tools to the same namespace resolution, dedupe search, and `rememberDirectiveLineDetailed(...)` write path.
- Simplified the voice memory tool schema so text and voice use the same namespace model and durable-write semantics.
- Removed the legacy `voice.realtimeReplyStrategy` normalization/runtime fallback and kept `voice.replyPath` as the single source of truth.
- Added `src/voice/realtimeProviderNormalization.ts` and switched settings normalization, ASR, and realtime clients to the shared base-url/model normalizers.
- Removed the tracked Rust build log, ignored Rust build artifacts in ESLint and `.gitignore`, and fixed the lint-blocking E2E test `any` casts.
- Finished the voice music extraction:
  - `src/voice/voiceSessionManager.ts` now delegates helper and command-flow methods to `src/voice/voiceMusicPlayback.ts`.
  - `src/voice/voiceMusicPlayback.ts` was brought to parity with the manager path for disambiguation action tracking, queue clearing, slash commands, and voice follow-up handling.
- Removed the last local copy of the OpenAI realtime transcription-model allowlist from `src/voice/voiceSessionManager.ts` so normalization now has one owner.
- Tightened touched extraction boundaries by moving memory tool behavior behind typed shared runtime contracts and aligning tests with the new API surface.

## Completed Refactors

### Shared memory runtime

- `memory_search` and `memory_write` now resolve namespace scope the same way in text and voice.
- Both paths now use `searchDurableFacts(...)` for dedupe/search and `rememberDirectiveLineDetailed(...)` for writes.
- Voice no longer bypasses directive memory writes with a separate store insertion path.

### Reply pipeline extraction cleanup

- Reply performance helpers, prompt capture helpers, and shared constants moved into `src/bot/replyPipelineShared.ts`.
- The `replyPipeline.ts` <-> `bot.ts` circular import was removed.
- Duplicated helper implementations in `src/bot.ts` were deleted.

### Voice music consolidation

- `voiceSessionManager.ts` now delegates the music playback helper layer and the higher-level command-flow layer to `voiceMusicPlayback.ts`.
- The extracted runtime now owns the disambiguation state machine, queue-clearing behavior, slash-command handling, and playback turn interception logic.
- `pendingAction` is now initialized/reset consistently in the extracted music state.

### Reply-path cleanup

- `settingsNormalization.ts` no longer derives or writes `voice.realtimeReplyStrategy`.
- `voiceSessionManager.ts` now resolves realtime reply strategy from `voice.replyPath` only.
- Tests and harnesses were updated to use `replyPath`.

### Realtime normalization dedupe

- OpenAI/Gemini/ElevenLabs base URL normalization and OpenAI realtime transcription model normalization now live in `src/voice/realtimeProviderNormalization.ts`.
- The shared normalization module is now used by settings normalization, ASR, realtime clients, helper modules, and the voice session manager.

### Lint / repository hygiene

- ESLint now ignores `src/voice/clankvox/target/**` and the Rust build log.
- `.gitignore` now ignores the same generated artifacts.
- `src/voice/clankvox/build_log.txt` was removed from the repository.

## Verification Checklist

- [x] `bun run typecheck`
- [x] `bun run lint`
- [x] Targeted tests updated and passing

## Verification Results

- `bun run typecheck`
  - Passed.
- `bun run lint`
  - Passed with `0` errors and `395` warnings.
  - Remaining warnings are broad repository warning debt outside the specific cleanup findings addressed here.
- Targeted tests
  - Command run:
    - `bun test ./src/store/settingsNormalization.test.ts ./src/voice/voiceSessionHelpers.test.ts ./src/voice/openaiRealtimeClient.test.ts ./src/voice/openaiRealtimeTranscriptionClient.test.ts ./src/voice/geminiRealtimeClient.test.ts ./src/voice/elevenLabsRealtimeClient.test.ts ./src/voice/voiceSessionManager.addressing.test.ts`
  - Result:
    - `173` passing, `0` failing.
