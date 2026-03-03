# Replay Test Suite

The project includes two offline behavior-validation harnesses:

- Flooding replay harness: [`scripts/floodingReplayHarness.ts`](../scripts/floodingReplayHarness.ts)
- Voice golden harness: [`scripts/voiceGoldenHarness.ts`](../scripts/voiceGoldenHarness.ts) (covered in `docs/e2e-test-spec.md`)

Harness intent:

- Flooding replay evaluates behavior against real conversation history in `data/clanker.db` without running the full Discord runtime loop.
- Voice golden validates voice reply decisions and outputs using curated utterance cases across runtime modes.

## Replay Framework Layout

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

## Flooding Replay: How It Works

The flooding harness runs this pipeline:

1. Parse CLI args and load runtime settings from `settings.runtime_settings`.
2. Query `messages` for replay context and user turns (`since`/`until`/`channel-id` filters).
3. Query `actions` for recorded outcomes (`sent_reply`, `sent_message`, `reply_skipped`, `voice_intent_detected`).
4. Rebuild turn-by-turn context and detect whether each user turn is addressed to the bot.
5. Run the admission gate (`shouldAttemptReplyDecision`) to decide whether a turn is eligible for reply behavior.
6. Resolve the turn outcome:
   - `recorded` mode: reuse recorded action rows from DB.
   - `live` mode: call the actor LLM (`buildSystemPrompt` + `buildReplyPrompt`) for admitted turns.
7. Accumulate per-channel-mode stats (`initiative` vs `non_initiative`), timeline events, and turn snapshots.
8. Optionally run a judge LLM in `live` mode to score flooding for a specific `window-start`/`window-end`.
9. Evaluate assertions; any failure sets process exit code to `1`.

## Running the Flooding Replay

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

## Key Flags

- `--since`, `--until`, `--channel-id`: replay scope.
- `--history-lookback-hours`: extra context before `since`.
- `--max-turns`: cap number of replayed user turns.
- `--snapshots-limit`: how many turn snapshots to print.
- `--actor-provider`, `--actor-model`: override actor LLM in live mode.
- `--judge-provider`, `--judge-model`, `--judge`, `--no-judge`: control judge behavior.
- `--window-start`, `--window-end`: timeline window for judge + snapshot focus.
- `--assert-min-llm-calls`: assert minimum actor LLM volume in replay window.
- `--out-json`: write machine-readable report.

## Creating a New Replay Harness

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
