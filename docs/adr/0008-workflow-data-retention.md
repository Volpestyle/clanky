# ADR-0008 — Retention pruning for the eve dev local workflow store

- **Status:** Proposed (implementation landed alongside this ADR, pending owner review)
- **Date:** 2026-07-01
- **Deciders:** James Volpe
- **Issue:** Unfiled — file under the work tracker when convenient.
- **Affects:** `agent/lib/workflow-data-retention.ts` (new) · `bin/clanky.ts`
  (`startDevBrain`) · `scripts/clanky.ts` (`startServer`) ·
  `test/workflow-data-retention-smoke.ts` (new)

## Context

eve's dev-mode workflow queue (the Vercel Workflow SDK "local world") persists
every workflow run on disk under `.workflow-data` as individual JSON files —
one per run, event, step, and hook, plus binary stream chunks. Two properties
of that store combine badly for an always-on agent:

1. **Unbounded growth.** Nothing ever deletes files. After roughly a week of
   Clanky uptime the store held ~10,900 files (315 MB), including 247 runs
   stranded in `running` status by killed dev servers.
2. **O(N) directory scans per queue operation.** The local queue lists whole
   directories and suffix-filters on each operation (`readdir` + libuv
   `scandir` sort + per-filename V8 string internalization). Scan cost grows
   with total accumulated files, not live work.

Under active workflow traffic (several agents testing against Clanky at once)
the dev server sustained ~2.9 CPU cores in a `getdirentries64`/`qsort`/GC
loop, ramping fans and starving the machine. A fresh server over the same
store idles at 0% only until traffic resumes.

## Options weighed

- **Fix the queue upstream (`vercel/eve` / Workflow SDK):** index instead of
  rescan, shard directories, or expire terminal runs. The right long-term fix,
  but not in Clanky's layer and not same-day; worth an upstream issue/PR from
  the `~/dev/eve` checkout.
- **Relocate the store (`WORKFLOW_LOCAL_DATA_DIR`):** keeps the repo clean but
  does not change scan cost, which depends on file count, not location.
- **Retention pruning at the brain spawn seam (chosen):** delete stale runs
  and their linked files immediately before spawning an eve dev server, when
  nothing can be scanning the store.

## Decision

Prune at both brain spawn sites — `startDevBrain` in `bin/clanky.ts` and the
face's `startServer` in `scripts/clanky.ts` — via
`agent/lib/workflow-data-retention.ts`:

- A run is **stale** when its record's `updatedAt` (fallback `createdAt`,
  then file mtime) is older than the retention window. Status is deliberately
  ignored: dev-server kills strand runs in `running` forever, so age is the
  only trustworthy signal. Clanky workflows complete in minutes; a
  multi-day-quiet "running" run is a zombie.
- Pruning a run removes its record plus linked events, steps, hooks (linked
  by `runId` in the JSON body), stream run records, and stream chunks.
- **Orphans** (linked files whose run record is already gone) are pruned only
  when older than the window; fresh orphans survive because a run mid-creation
  writes linked files before its record.
- Window: `CLANKY_WORKFLOW_RETENTION_HOURS`, default 48; `<= 0` disables.
- Pruning never runs against a live store: both call sites execute before the
  eve process is spawned, and attach paths (`ensureDevBrain` finding a healthy
  server) skip it.

## Consequences

- Workflow run history older than the window is gone — acceptable for dev,
  where the store is replay/debug detail, not Clanky's memory (sessions and
  memory live in the eve agent store, untouched).
- Queue scan cost is bounded by the retention window's traffic instead of
  lifetime traffic.
- The upstream O(N) scan remains; if Clanky's per-window traffic grows enough
  to hurt inside 48 h, shrink the window or pursue the upstream fix.
