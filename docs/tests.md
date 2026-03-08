# Tests

## Default Test Commands

- `bun run test` runs the default unit and integration suite and excludes `.live.test.ts` files.
- `bun run test:e2e` runs the Discord E2E suite.
- `bun run test:e2e:voice` runs the voice E2E suite.
- `bun run test:e2e:text` runs the text E2E suite.

## Live LLM Tests

These tests make real model calls or use real model CLIs, so they can cost money or consume quota.

### Shared Voice Coverage

The active voice live suites share a single source of truth:

- `tests/live/shared/voiceLiveScenarios.ts`

Current shared voice catalog size:

- `91` scenarios total
- `8` scenario groups
- Running both active voice suites exercises those same `91` scenarios twice: once in `voiceAdmission.live.test.ts` and once in the voice section of `replyGeneration.live.test.ts`
- Voice generation expectations are now exact for `82` of those `91` shared scenarios
- The remaining `9` generation `either` cases are raw room-event cues, where admission may allow but the brain is still intentionally free to speak or `[SKIP]`

Current group breakdown:

- `name detection fast-paths`: `4`
- `join events`: `9`
- `music commands`: `4`
- `clear engagement`: `18`
- `contextual engagement`: `13`
- `stays quiet`: `15`
- `music wake latch`: `7`
- `eagerness sweeps`: `21`

Coverage assessment:

- Good breadth for admission and generation behavior across name detection, unsolicited participation, joins, music control, silence cases, and eagerness thresholds
- Good alignment because admission and generation now consume the same voice inputs instead of drifting into separate hand-written suites
- The voice generation prompt now relies on transcript plus contextual guidance such as membership events, room context, and fuzzy bot-name cues instead of a dedicated join-state prompt flag
- Still not full-stack realtime coverage: these tests do not validate websocket/session transport, ASR streaming, TTS audio output, Discord timing, or end-to-end voice latency
- Still not a full provider matrix by default: the scenarios are broad, but we do not automatically run every scenario against every provider/model combination

### Structured Reply Live Test (Generation LLM only — no classifier)

This exercises the real structured reply contract for both text and voice generation.
It tests the **generation LLM brain only** — the classifier admission pipeline is NOT involved.
Each scenario builds a full generation prompt (`buildSystemPrompt` + `buildVoiceTurnPrompt`)
and sends it directly to the LLM via `llm.generate()`, then asserts whether the structured
output is a real spoken reply or `[SKIP]`.

This answers: "Given this context, does the generation LLM produce the right reply-vs-skip decision?"

The voice section uses the shared voice live scenario catalog that is also consumed by `tests/live/voiceAdmission.live.test.ts`, so both suites cover the same voice situations.

The text section also covers:

- tool selection for `web_search`, `web_scrape`, `conversation_search`, and `adaptive_directive_add`
- a vision turn with inline image input
- raw structured-output validity for representative reply and skip cases

Defaults:

- Text provider defaults to `claude-oauth`
- Voice provider defaults to `claude-oauth`
- The suite includes a small eagerness sweep for both text and voice so we validate low-vs-high participation behavior, not just one-off direct-address cases
- Tool-selection subtests are skipped automatically for providers without tool-call support
- Vision subtests are skipped automatically for providers without multimodal image support

```sh
bun test tests/live/replyGeneration.live.test.ts
```

You can target different providers/models per path:

```sh
TEXT_LLM_PROVIDER=claude-oauth TEXT_LLM_MODEL=claude-sonnet-4-6 \
VOICE_LLM_PROVIDER=claude-oauth VOICE_LLM_MODEL=claude-sonnet-4-6 \
bun test tests/live/replyGeneration.live.test.ts
```

```sh
TEXT_LLM_PROVIDER=openai TEXT_LLM_MODEL=gpt-5-mini \
VOICE_LLM_PROVIDER=anthropic VOICE_LLM_MODEL=claude-haiku-4-5 \
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
bun test tests/live/replyGeneration.live.test.ts
```

You can also filter to only one side:

```sh
LIVE_REPLY_FILTER=voice bun test tests/live/replyGeneration.live.test.ts
LIVE_REPLY_FILTER=text bun test tests/live/replyGeneration.live.test.ts
```

Debug visibility:

- `LIVE_REPLY_DEBUG=1` prints provider/model, system prompt, user prompt, raw model output, parsed structured text, and any returned tool calls

### Voice Admission Live Test (Classifier + fast-paths — no generation)

This is the active end-to-end admission suite for voice reply gating. It tests the
**classifier pipeline** — name detection fast-paths plus the YES/NO LLM classifier —
via `evaluateVoiceReplyDecision()`. The generation LLM is NOT involved.

The classifier LLM returns YES or NO. The admission pipeline wraps that into allow/deny
(along with deterministic fast-paths that can allow/deny before the classifier runs).
Each scenario asserts on the final `allow`/`deny` outcome.

This answers: "Given this context, does the admission pipeline (fast-paths + classifier) correctly gate the turn?"

It uses the same shared scenario corpus as the voice section of `replyGeneration.live.test.ts`.

Defaults:

- Classifier provider defaults to `claude-oauth`
- The suite covers the shared name-detection, join-event, music, contextual, and eagerness scenarios

```sh
bun test tests/live/voiceAdmission.live.test.ts
```

```sh
CLASSIFIER_PROVIDER=claude-oauth CLASSIFIER_MODEL=claude-haiku-4-5 VOICE_ADMISSION_DEBUG=0 bun test tests/live/voiceAdmission.live.test.ts
```

```sh
CLASSIFIER_PROVIDER=claude-oauth CLASSIFIER_MODEL=claude-haiku-4-5 LABEL_FILTER="event: another person joins" VOICE_ADMISSION_DEBUG=1 bun test tests/live/voiceAdmission.live.test.ts
```

Debug visibility:

- `VOICE_ADMISSION_DEBUG=1` prints the exact classifier system prompt, classifier user prompt, raw classifier output, and parsed decision for each scenario
- `VOICE_CLASSIFIER_DEBUG=1` still works as a compatibility alias for the same live admission debug path

## Replay Test Harnesses

The project includes two offline behavior-validation harnesses:

- Flooding replay harness: [`scripts/floodingReplayHarness.ts`](../scripts/floodingReplayHarness.ts)
- Voice golden harness: [`scripts/voiceGoldenHarness.ts`](../scripts/voiceGoldenHarness.ts) (covered in `docs/e2e-test-spec.md`)

Harness intent:

- Flooding replay evaluates behavior against real conversation history in `data/clanker.db` without running the full Discord runtime loop.
- Voice golden validates voice reply decisions and outputs using curated utterance cases across runtime modes.

### Replay Framework Layout

Flooding replay uses a shared replay framework:

- Engine/runtime loop: `scripts/replay/core/engine.ts`
- Shared DB loading and history priming: `scripts/replay/core/db.ts`
- Shared LLM, judge, metrics, and output modules: `scripts/replay/core/llm.ts`, `scripts/replay/core/judge.ts`, `scripts/replay/core/metrics.ts`, `scripts/replay/core/output.ts`
- Shared helper types/utilities: `scripts/replay/core/types.ts`, `scripts/replay/core/utils.ts`
- Scenario implementations: `scripts/replay/scenarios/*.ts`
- Thin CLI entrypoints: `scripts/*ReplayHarness.ts`

Current flooding wiring:

- Entrypoint: `scripts/floodingReplayHarness.ts`
- Scenario implementation: `scripts/replay/scenarios/flooding.ts`

### Flooding Replay: How It Works

The flooding harness runs this pipeline:

1. Parse CLI args and load runtime settings from `settings.runtime_settings`.
2. Query `messages` for replay context and user turns (`since`/`until`/`channel-id` filters).
3. Query `actions` for recorded outcomes (`sent_reply`, `sent_message`, `reply_skipped`, `voice_intent_detected`).
4. Rebuild turn-by-turn context and detect whether each user turn is addressed to the bot.
5. Run the admission gate (`shouldAttemptReplyDecision`) to decide whether a turn is eligible for reply behavior.
6. Resolve the turn outcome:
   - `recorded` mode: reuse recorded action rows from DB.
   - `live` mode: call the actor LLM (`buildSystemPrompt` + `buildReplyPrompt`) for admitted turns.
7. Accumulate per-channel-mode stats (`reply_channel` vs `other_channel`), timeline events, and turn snapshots.
8. Optionally run a judge LLM in `live` mode to score flooding for a specific `window-start`/`window-end`.
9. Evaluate assertions; any failure sets process exit code to `1`.

### Running the Flooding Replay

Recorded replay (no actor LLM calls):

```bash
bun run replay:flooding
# or
bun scripts/floodingReplayHarness.ts --mode recorded
```

Live replay (actor LLM; optional judge):

```bash
bun run replay:flooding:live
# or
bun scripts/floodingReplayHarness.ts --mode live
```

Common scoped run:

```bash
bun scripts/floodingReplayHarness.ts --mode recorded \
  --since 2026-02-27T16:20:00.000Z \
  --until 2026-02-27T16:40:00.000Z \
  --channel-id 1052402898140667906 \
  --max-turns 80 \
  --snapshots-limit 20 \
  --out-json data/replays/flood-window.json
```

Common assertion gates:

```bash
bun scripts/floodingReplayHarness.ts --mode recorded \
  --assert-max-unaddressed-send-rate 15 \
  --assert-max-unaddressed-sends 3 \
  --assert-min-addressed-send-rate 70 \
  --assert-min-addressed-sends 2 \
  --assert-max-sent-turns 12 \
  --fail-on-llm-error
```

### Replay Key Flags

- `--since`, `--until`, `--channel-id`: replay scope.
- `--history-lookback-hours`: extra context before `since`.
- `--max-turns`: cap number of replayed user turns.
- `--snapshots-limit`: how many turn snapshots to print.
- `--actor-provider`, `--actor-model`: override actor LLM in live mode.
- `--judge-provider`, `--judge-model`, `--judge`, `--no-judge`: control judge behavior.
- `--window-start`, `--window-end`: timeline window for judge + snapshot focus.
- `--assert-min-llm-calls`: assert minimum actor LLM volume in replay window.
- `--out-json`: write machine-readable report.

### Creating a New Replay Harness

Use `scripts/replay/scenarios/flooding.ts` as the scenario template.

1. Create `scripts/replay/scenarios/<scenario>.ts`.
2. Export a `run<Scenario>ReplayHarness(argv)` function that:
   - parses scenario args,
   - calls `runReplayEngine(...)`,
   - evaluates scenario assertions,
   - prints/writes scenario report output.
3. Keep one decision path per mode (`recorded` vs `live`) and remove unused branches.
4. Add scenario assertions that encode the behavior the harness should protect.
5. Create `scripts/<scenario>ReplayHarness.ts` as a thin entrypoint that calls the scenario runner.
6. Optionally add `package.json` scripts:
   - `replay:<scenario>`
   - `replay:<scenario>:live`
7. Validate with a known window:
   - Run recorded first to establish baseline behavior.
   - Run live with same window to compare current model behavior.
   - Keep thresholds in CLI assertions so CI/local runs fail fast on regressions.
