# ADR-0007 — Session-wide pane recorder over herdr `pane.attach`

- **Status:** Proposed (implementation landed alongside this ADR, pending owner review)
- **Date:** 2026-07-01
- **Deciders:** James Volpe
- **Issue:** Unfiled — file under the work tracker when convenient.
- **Affects:** `agent/lib/pane-recorder.ts` (new) · `agent/lib/history-search.ts`
  (new) · `agent/channels/pane-recorder.ts` (new boot seam) ·
  `agent/tools/herdr_read.ts` + `agent/tools/herdr_search.ts` ·
  `agent/lib/relay/ops.ts` (pane auto reads) · `agent/lib/transcripts.ts`
  (reserved `panes/` subtree) · `agent/lib/herdr-client-socket.ts` (protocol 15)
  · `bin/clanky.ts` (`recorder`/`transcript search` CLI) · `SPEC.md` §4.3

## Context

Agents (and the iOS window) need rich, durable history for **any** pane in the
connected herdr session — not just workers launched through the
`clanky transcript-run` seam. The gap shows up hardest for panes created from
the iOS app and for long agent sessions whose beginnings scroll away.

Herdr was evaluated as the history source of record (herdr source at
`~/dev/herdr`, installed 0.7.0, HEAD 0.7.1-dev):

- There is **no `full` read source** at any version. `parse_read_source`
  accepts `visible | recent | recent-unwrapped | detection` only; the
  `full`-with-fallback path in `herdr_read` was anticipating a capability that
  does not exist.
- `pane.read` clamps to **1000 lines server-side**
  (`params.lines.unwrap_or(80).min(1000)`, `src/app/api/panes.rs`) with no
  offset/pagination. A `--lines 3000` request silently returns 1000.
- Retention is the in-memory ghostty scrollback, capped by
  `scrollback_limit_bytes` (default **10 MB per pane**). Alternate-screen TUIs
  leave no scrollback at all. Everything dies with the pane.
- Across restarts: a graceful exit persists at most the in-memory buffer
  (`session-history.json`); a **live handoff replays only 8 KB per pane**
  (`MAX_REPLAY_BYTES_PER_PANE`). The running 0.7.0 session persists no
  scrollback file at all.
- Herdr HEAD (0.7.1-dev) **added the right primitive instead**: `pane.attach`
  streams raw PTY bytes per pane over the socket API (base64 chunks, monotonic
  `seq`, closes on lag so clients reattach and re-seed from `pane.read`), plus
  `pane.created`/`pane.closed`/`pane.exited` lifecycle events (already in
  0.7.0).

Verdict: **herdr is the live coordination plane, not a durable history store**
— by design, like tmux (bounded scrollback + `pipe-pane` for capture). Durable
history must be captured at the byte stream and owned by Clanky.

Clanky already has one capture plane: worker transcripts (SPEC §4.3), written
**in-path** by the `transcript-run` wrapper for panes spawned through the
seam. That plane is lossless-from-birth and survives brain downtime, but only
covers Clanky-spawned workers.

## Decision

Add a second, **observational** capture plane: a session-wide pane recorder
that runs inside the always-on brain, attaches to every pane in the connected
herdr session via `pane.attach`, and persists per-pane recordings next to the
worker transcripts.

The two planes have distinct guarantees and stay separate:

| Plane | Coverage | Guarantee | Mechanism |
|---|---|---|---|
| Worker transcripts | panes spawned through the transcript-run seam | lossless from birth; survives brain downtime | in-path pipe/`script(1)` capture |
| Pane recorder | every other pane in the session (iOS-created, manual, mirrors) | best-effort from attach; gaps seeded + marked | `pane.attach` byte stream + `pane.read` seeds |

- **Storage**: `~/.clanky/herdr-transcripts/<session>/panes/<recording-id>/`,
  flat files: `manifest.json` (kind `pane-recording`), `events.jsonl`
  (attach/seed/gap/rotate/finalize markers), `seed-NNNNNN.txt` snapshots,
  active `stream.ansi`/`stream.txt`, rotated `archive-NNNNNN.{ansi,txt}.gz`.
  `panes` is a reserved name under the session dir; `listTranscriptRuns`
  skips it.
- **Dedup**: panes whose foreground process is a `transcript-run` wrapper are
  detected via `pane.process_info` and recorded as lifecycle-only
  (`coveredBy: "worker-transcript"`), so bytes are stored once.
  `CLANKY_PANE_RECORDER_RECORD_ALL=1` forces full capture anyway.
- **Retention**: recordings ride the existing transcript sweep (same 30-day /
  500-run / 2 GiB budgets — flat recording dirs keep `measureRunDir`
  accounting exact), plus a per-recording cap (256 MiB) enforced by pruning
  oldest archives at rotation so an immortal pane cannot eat the budget.
  Rotation gzips segments (~10× for terminal output); `rg -z` keeps archives
  searchable without decompression on disk.
- **Search**: `agent/lib/history-search.ts` searches both planes (ripgrep
  `--json -z` when available, bounded pure-node scan otherwise), exposed as
  the `herdr_search` tool and `clanky transcript search`. No index/database:
  under the 2 GiB budget rg chews the whole store in seconds; revisit
  incremental indexing only if budgets grow.
- **Reads**: `herdr_read`/relay `read` `source:auto` for panes now prefer the
  recording store and fall back to live herdr reads. `anchor: head|tail` +
  `skip` page through history beyond herdr's 1000-line cap (the tool still
  returns ≤1000 lines per call for context safety).
- **Boot**: guarded module side effect in `agent/channels/pane-recorder.ts`
  (the discord-gateway pattern), gated by `CLANKY_PANE_RECORDER=1` which the
  face injects into the owned brain env when it runs inside herdr. A
  heartbeat lockfile serializes one recorder per session across concurrent
  brains (`clanky dev` + always-on).
- **Degraded mode**: against a herdr without `pane.attach` the recorder still
  subscribes to lifecycle events and writes seeds (last ≤1000 lines per pane),
  marking `attach-unsupported`. `clanky recorder seed` runs one seed pass
  manually — used immediately before the herdr live-handoff upgrade so
  pre-upgrade tails survive the 8 KB replay truncation.
- **Herdr upgrade**: the recorder's stream mode needs herdr ≥0.7.1
  (`pane.attach`, protocol 15). The binary client pin
  (`HERDR_CLIENT_PROTOCOL_VERSION`) moves 14 → 15 in the same change because
  herdr rejects version-mismatched clients strictly. Upgrade path is
  `herdr server live-handoff --import-exe <new>` (PTY fds transfer; processes
  survive; rehearsed on a scratch session before touching the live one).

## Options weighed

1. **Rely on herdr for full history** (upstream a `full` read source +
   scrollback persistence). Rejected: turns a multiplexer into a database;
   still loses closed panes, alt-screen apps, and pre-restart history; the
   read API would need pagination; upstream (ogulcancelik/herdr) keeps
   transport truth, Clanky keeps product policy. `pane.attach` is the correct
   upstream contribution shape and already exists.
2. **Generalize the transcript-run wrapper** (wrap every pane). Rejected:
   cannot wrap panes Clanky didn't spawn (iOS relay raw passthrough, manual
   splits), and re-parenting existing panes is impossible.
3. **Poll `pane.read` on an interval**. Rejected: lossy between polls,
   O(panes × frequency) socket load, and James's standing preference for
   event-driven watchers over polling.
4. **One capture plane (recorder subsumes wrapper)**. Rejected for now: the
   wrapper is in-path (cannot miss bytes, works while the brain is down) and
   carries exit codes; the recorder is observational. Collapsing them would
   trade away the stronger guarantee where Clanky controls the spawn.

## Consequences

- Any pane in the session has durable, searchable history from the moment the
  recorder first sees it; herdr's caps stop being the ceiling for agents and
  the iOS window.
- Recorder coverage has marked gaps (brain downtime, stream lag) — readers
  see explicit `gap`/`seed` events rather than silently missing bytes.
- Disk cost is bounded by the shared 2 GiB budget; wrapper-covered panes are
  not double-stored by default.
- The relay/iOS terminal path and the recorder both require the herdr 0.7.1
  protocol-15 binary once the client pin moves; older herdr keeps working
  only in degraded seed mode.
