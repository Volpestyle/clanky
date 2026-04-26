import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapSwarmTestSchema } from "./__fixtures__/swarmTestSchema.ts";
import { SwarmReservationKeeper } from "./swarmReservationKeeper.ts";

let tempDir: string;
let dbPath: string;
let workspaceDir: string;
let keeper: SwarmReservationKeeper | null;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "clanky-keeper-"));
  dbPath = path.join(tempDir, "swarm.db");
  workspaceDir = path.join(tempDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  bootstrapSwarmTestSchema(dbPath);
  keeper = null;
});

afterEach(() => {
  keeper?.shutdown();
  keeper = null;
  rmSync(tempDir, { recursive: true, force: true });
});

function instanceCount(): number {
  const verify = new Database(dbPath, { readonly: true });
  try {
    return (verify.query("SELECT COUNT(*) AS n FROM instances").get() as { n: number }).n;
  } finally {
    verify.close();
  }
}

function readHeartbeat(id: string): number | null {
  const verify = new Database(dbPath, { readonly: true });
  try {
    const row = verify
      .query("SELECT heartbeat FROM instances WHERE id = ?")
      .get(id) as { heartbeat: number } | null;
    return row ? row.heartbeat : null;
  } finally {
    verify.close();
  }
}

test("reserve writes a row and tracks it for heartbeating", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "origin:clanky" });

  expect(keeper.size()).toBe(1);
  expect(instanceCount()).toBe(1);
  expect(reserved.directory).toBe(path.resolve(workspaceDir));
});

test("release deletes the row when not yet adopted", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });
  expect(instanceCount()).toBe(1);

  keeper.release(reserved.id);
  expect(keeper.size()).toBe(0);
  expect(instanceCount()).toBe(0);
});

test("release leaves adopted rows alone (worker owns lifecycle once adopted)", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1, pid = 99 WHERE id = ?", [reserved.id]);
  } finally {
    adopt.close();
  }

  keeper.release(reserved.id);
  expect(keeper.size()).toBe(0);
  expect(instanceCount()).toBe(1);
});

test("tick refreshes heartbeats on unadopted rows we still own", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });

  const stomp = new Database(dbPath);
  try {
    stomp.run("UPDATE instances SET heartbeat = 1 WHERE id = ?", [reserved.id]);
  } finally {
    stomp.close();
  }

  keeper.tick();

  const heartbeat = readHeartbeat(reserved.id);
  expect(heartbeat).not.toBeNull();
  expect(heartbeat!).toBeGreaterThan(1);
  expect(keeper.size()).toBe(1);
});

test("tick stops tracking rows that have been adopted", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1, pid = 99 WHERE id = ?", [reserved.id]);
  } finally {
    adopt.close();
  }

  keeper.tick();
  expect(keeper.size()).toBe(0);
  // Adopted row remains — it's the worker's now.
  expect(instanceCount()).toBe(1);
});

test("tick stops tracking rows that have been deleted out from under us", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });

  const wipe = new Database(dbPath);
  try {
    wipe.run("DELETE FROM instances WHERE id = ?", [reserved.id]);
  } finally {
    wipe.close();
  }

  keeper.tick();
  expect(keeper.size()).toBe(0);
});

test("forceDeregister cascades cleanup even on adopted rows", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const reserved = keeper.reserve({ directory: workspaceDir, label: "x" });

  const seed = new Database(dbPath);
  try {
    seed.run("UPDATE instances SET adopted = 1, pid = 42 WHERE id = ?", [reserved.id]);
    seed.run(
      `INSERT INTO context (id, scope, instance_id, file, type, content)
       VALUES ('lock1', ?, ?, '/repo/a.txt', 'lock', 'held')`,
      [reserved.scope, reserved.id]
    );
  } finally {
    seed.close();
  }

  keeper.forceDeregister(reserved.id);
  expect(keeper.size()).toBe(0);
  expect(instanceCount()).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  try {
    const lockCount = (verify
      .query("SELECT COUNT(*) AS n FROM context WHERE instance_id = ?")
      .get(reserved.id) as { n: number }).n;
    expect(lockCount).toBe(0);
  } finally {
    verify.close();
  }
});

test("shutdown deletes any still-unadopted reservations and stops the timer", () => {
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  const a = keeper.reserve({ directory: workspaceDir, label: "a" });
  const b = keeper.reserve({ directory: workspaceDir, label: "b" });

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1, pid = 99 WHERE id = ?", [b.id]);
  } finally {
    adopt.close();
  }

  keeper.shutdown();
  // Adopted row stays; unadopted goes away.
  expect(instanceCount()).toBe(1);
  const verify = new Database(dbPath, { readonly: true });
  try {
    const remaining = verify.query("SELECT id FROM instances").all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual([b.id]);
  } finally {
    verify.close();
  }

  expect(() => keeper!.reserve({ directory: workspaceDir, label: "post" })).toThrow();
  expect(instanceCount()).toBe(1);
  // Reset to skip afterEach's shutdown re-run.
  keeper = null;
  expect(a.id).not.toBe(b.id);
});

test("tick is non-throwing when DB ops fail and routes errors to onError", () => {
  const errors: unknown[] = [];
  keeper = new SwarmReservationKeeper({
    dbPath,
    heartbeatIntervalMs: 60_000,
    onError: (error) => errors.push(error)
  });
  keeper.reserve({ directory: workspaceDir, label: "x" });

  // Drop the instances table to force every DB op for the tracked id to throw.
  // (Mimics a corrupted swarm.db without depending on filesystem timing.)
  const corrupt = new Database(dbPath);
  try {
    corrupt.exec("DROP TABLE instances");
  } finally {
    corrupt.close();
  }

  expect(() => keeper!.tick()).not.toThrow();
  expect(errors.length).toBeGreaterThan(0);
});
