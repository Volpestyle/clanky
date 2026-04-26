#!/usr/bin/env bun
/**
 * Fake swarm worker fixture used by Wave 2 tests for the swarm-launcher
 * redesign. Simulates the behaviors a real claude-code / codex-cli worker
 * exhibits after Clanky pre-creates an instance row and spawns it with
 * the SWARM_MCP_* env vars.
 *
 * This fixture writes directly to the swarm-mcp SQLite DB. It does NOT
 * mount a real MCP server. That is intentional: launcher tests verify the
 * reserve → adopt → exit sequence, which only depends on row state. If a
 * future test needs full MCP-protocol fidelity, spawn an actual swarm-mcp
 * subprocess instead.
 *
 * Inputs (all read from process.env):
 *
 *   Required (matches what swarm-mcp's tryAutoAdopt reads):
 *     SWARM_DB_PATH               path to swarm.db
 *     SWARM_MCP_INSTANCE_ID       reserved instance UUID
 *
 *   Optional identity (passed through to the row on adopt):
 *     SWARM_MCP_LABEL             label tokens
 *
 *   Behavior selection:
 *     FAKE_WORKER_BEHAVIOR        one of:
 *                                   adopt_then_exit       (default)
 *                                   claim_and_complete
 *                                   claim_and_fail
 *                                   progress_then_complete
 *                                   crash_after_adopt
 *                                   never_adopt
 *                                   hang
 *
 *   Task-related (required for claim_*, progress_*):
 *     FAKE_WORKER_TASK_ID         task id to claim/update
 *     FAKE_WORKER_RESULT_TEXT     final result text (default "fake worker result")
 *     FAKE_WORKER_ERROR_MESSAGE   failure result text (default "fake worker error")
 *     FAKE_WORKER_USAGE_JSON      JSON to post as kind="usage" annotation
 *     FAKE_WORKER_PROGRESS_COUNT  progress notes to emit (default 3)
 *     FAKE_WORKER_PROGRESS_INTERVAL_MS  ms between progress notes (default 50)
 *
 *   Timing:
 *     FAKE_WORKER_DELAY_MS        sleep before adopting (default 0)
 *     FAKE_WORKER_HANG_MS         max sleep for "hang" behavior (default 60000)
 *
 * Exit code:
 *   0 — happy-path completion (including expected failure modes that posted to the task ledger)
 *   1 — explicit crash behaviors and missing-required-env errors
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

type Behavior =
  | "adopt_then_exit"
  | "claim_and_complete"
  | "claim_and_fail"
  | "progress_then_complete"
  | "crash_after_adopt"
  | "never_adopt"
  | "hang";

const BEHAVIORS: ReadonlySet<Behavior> = new Set<Behavior>([
  "adopt_then_exit",
  "claim_and_complete",
  "claim_and_fail",
  "progress_then_complete",
  "crash_after_adopt",
  "never_adopt",
  "hang"
]);

function readBehavior(): Behavior {
  const raw = String(process.env.FAKE_WORKER_BEHAVIOR || "adopt_then_exit").trim();
  if (BEHAVIORS.has(raw as Behavior)) return raw as Behavior;
  throw new Error(`fakeSwarmWorker: unknown FAKE_WORKER_BEHAVIOR=${raw}`);
}

function requireEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`fakeSwarmWorker: missing required env ${name}`);
  return value;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`fakeSwarmWorker: ${name} must be numeric, got ${raw}`);
  }
  return parsed;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function openDb(dbPath: string) {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

function adoptInstance(db: Database, instanceId: string, label: string | null) {
  // Mirrors swarm-mcp/src/registry.ts::register adoption path:
  //   UPDATE instances SET pid=?, label=?, adopted=1, heartbeat=unixepoch() WHERE id=?
  // We respect any non-null label that's already on the row (matches
  // `nextLabel = trimmedLabel ?? existing.label`).
  const existing = db
    .query("SELECT label, scope FROM instances WHERE id = ?")
    .get(instanceId) as { label: string | null; scope: string } | null;
  if (!existing) {
    throw new Error(`fakeSwarmWorker: no reserved instance row for id=${instanceId}`);
  }
  const nextLabel = label ?? existing.label;
  db.run(
    `UPDATE instances
     SET pid = ?, label = ?, adopted = 1, heartbeat = unixepoch()
     WHERE id = ?`,
    [process.pid, nextLabel, instanceId]
  );
  emitEvent(db, existing.scope, "instance.registered", instanceId, instanceId, {
    label: nextLabel,
    adopted: true,
    pid: process.pid,
    fake_worker: true
  });
  return existing.scope;
}

function claimTask(db: Database, taskId: string, instanceId: string, scope: string) {
  // Status transitions to 'claimed' immediately. The real implementation
  // walks dependencies and may end up at 'in_progress' instead, but for
  // launcher tests we only care that an assignee + status flip lands.
  const ts = Date.now();
  const updated = db.run(
    `UPDATE tasks
     SET assignee = ?, status = 'claimed',
         updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ?`,
    [instanceId, ts, taskId, scope]
  );
  if (updated.changes === 0) {
    throw new Error(`fakeSwarmWorker: task ${taskId} not found in scope ${scope}`);
  }
  emitEvent(db, scope, "task.claimed", instanceId, taskId, { fake_worker: true });
}

function updateTaskTerminal(
  db: Database,
  taskId: string,
  scope: string,
  status: "done" | "failed",
  result: string
) {
  const ts = Date.now();
  db.run(
    `UPDATE tasks
     SET status = ?, result = ?,
         updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ?`,
    [status, result, ts, taskId, scope]
  );
  emitEvent(db, scope, `task.${status}`, null, taskId, {
    fake_worker: true,
    ts
  });
}

function annotate(
  db: Database,
  scope: string,
  instanceId: string,
  file: string,
  kind: string,
  content: string
) {
  db.run(
    `INSERT INTO context (id, scope, instance_id, file, type, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), scope, instanceId, file, kind, content]
  );
  emitEvent(db, scope, "context.annotated", instanceId, file, {
    kind,
    fake_worker: true
  });
}

function emitEvent(
  db: Database,
  scope: string,
  type: string,
  actor: string | null,
  subject: string,
  payload: Record<string, unknown>
) {
  db.run(
    `INSERT INTO events (scope, type, actor, subject, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [scope, type, actor, subject, JSON.stringify(payload)]
  );
}

async function runBehavior(behavior: Behavior) {
  if (behavior === "never_adopt") {
    // Simulate a worker that boots but its MCP layer never adopts the row.
    // Sleeps for the hang window so the launcher's adoption-timeout trips.
    const hangMs = readNumber("FAKE_WORKER_HANG_MS", 60_000);
    await sleep(hangMs);
    return 0;
  }

  const dbPath = requireEnv("SWARM_DB_PATH");
  const instanceId = requireEnv("SWARM_MCP_INSTANCE_ID");
  const label = process.env.SWARM_MCP_LABEL?.trim() || null;
  const delayMs = readNumber("FAKE_WORKER_DELAY_MS", 0);

  if (delayMs > 0) await sleep(delayMs);

  const stdoutMarker = process.env.FAKE_WORKER_STDOUT_MARKER?.trim();
  if (stdoutMarker) {
    process.stdout.write(`${stdoutMarker}\n`);
  }

  const db = openDb(dbPath);
  let scope: string;
  try {
    scope = adoptInstance(db, instanceId, label);
  } catch (error) {
    db.close();
    throw error;
  }

  try {
    switch (behavior) {
      case "adopt_then_exit":
        return 0;

      case "crash_after_adopt":
        // Adopted but never reports task status. Simulates `claude` crashing
        // after MCP boot but before the model finishes.
        return 1;

      case "hang": {
        const hangMs = readNumber("FAKE_WORKER_HANG_MS", 60_000);
        await sleep(hangMs);
        return 0;
      }

      case "claim_and_complete": {
        const taskId = requireEnv("FAKE_WORKER_TASK_ID");
        const resultText = process.env.FAKE_WORKER_RESULT_TEXT ?? "fake worker result";
        claimTask(db, taskId, instanceId, scope);
        const usageJson = process.env.FAKE_WORKER_USAGE_JSON?.trim();
        if (usageJson) {
          annotate(db, scope, instanceId, taskId, "usage", usageJson);
        }
        updateTaskTerminal(db, taskId, scope, "done", resultText);
        return 0;
      }

      case "claim_and_fail": {
        const taskId = requireEnv("FAKE_WORKER_TASK_ID");
        const errorText = process.env.FAKE_WORKER_ERROR_MESSAGE ?? "fake worker error";
        claimTask(db, taskId, instanceId, scope);
        updateTaskTerminal(db, taskId, scope, "failed", errorText);
        return 0;
      }

      case "progress_then_complete": {
        const taskId = requireEnv("FAKE_WORKER_TASK_ID");
        const resultText = process.env.FAKE_WORKER_RESULT_TEXT ?? "fake worker result";
        const progressCount = Math.max(0, Math.floor(readNumber("FAKE_WORKER_PROGRESS_COUNT", 3)));
        const intervalMs = Math.max(0, Math.floor(readNumber("FAKE_WORKER_PROGRESS_INTERVAL_MS", 50)));

        claimTask(db, taskId, instanceId, scope);
        for (let i = 0; i < progressCount; i++) {
          annotate(db, scope, instanceId, taskId, "progress", `step ${i + 1} of ${progressCount}`);
          if (intervalMs > 0 && i < progressCount - 1) await sleep(intervalMs);
        }
        const usageJson = process.env.FAKE_WORKER_USAGE_JSON?.trim();
        if (usageJson) {
          annotate(db, scope, instanceId, taskId, "usage", usageJson);
        }
        updateTaskTerminal(db, taskId, scope, "done", resultText);
        return 0;
      }
    }
  } finally {
    db.close();
  }
}

const isMain = import.meta.path === Bun.main;

if (isMain) {
  const behavior = readBehavior();
  runBehavior(behavior)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[fakeSwarmWorker] ${(error as Error)?.message || error}`);
      process.exit(1);
    });
}

// Exported for tests that want to invoke the fixture in-process instead of
// spawning a subprocess.
export { runBehavior, type Behavior };
