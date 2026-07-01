# Pool policy: ephemeral fan-out vs persistent pool

- **Ephemeral fan-out** (the skill's baseline): one worker per independent task,
  spawned and discarded. Correct for a one-shot swarm of unrelated or
  write-overlapping tasks — maximal isolation, nothing to keep warm.
- **Persistent pool** (default for a long, many-issue, tracker-backed effort):
  keep a small set of **named, warm workers** across the whole run and route each
  new task to the worker that already owns the touched scope. Warm context plus
  domain locality beat cold spawns at scale — a worker that built a module carries
  the context to extend it. Give pool workers stable identities (`clanky:worker1`
  …) and keep an ownership map (worker -> paths/domain) in the ledger; when the
  next task lands, dispatch it to the owner rather than spawning fresh. Hold a
  worker deliberately **reserved** for a blocked capstone instead of force-fitting
  busywork. Respawn only when a worker dies.

For a pool, prefer the **tracker as the orchestration ledger** (queue + DAG +
completion record): pull the next issue whose blockers are Done, dispatch it,
verify, mark it Done, and file follow-up issues as work reveals itself. The run
directory stays useful for sentinels and results, but do not maintain a second
durable task ledger that drifts from the tracker.

Drive each pool task under the worker harness's native **`/goal`** loop when the
harness supports it (Claude, Codex): after the pane is ready, arm it with
`herdr pane run "$PANE" "/goal <task + definition-of-done>"`. `/goal` gives an
unambiguous terminal state and per-task turn/token cost, and enforces
"prove done" inside the worker. The spawn seam does not arm `/goal` itself
([VUH-321](https://linear.app/vuhlp/issue/VUH-321)); arm it by hand after spawn.

The harness-owned form of this whole model — pool registry, tracker scheduler,
parsed result contract, commit interlock — is [ADR-0002](../../../docs/adr/0002-pool-orchestration-operating-model.md)
([VUH-333](https://linear.app/vuhlp/issue/VUH-333)). None of it has landed;
run the model by hand as above.
