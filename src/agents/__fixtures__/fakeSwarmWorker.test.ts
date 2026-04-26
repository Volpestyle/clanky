/**
 * Self-tests for the fake-swarm-worker fixture. These verify that each
 * configurable behavior writes the swarm.db rows the launcher / waiter
 * tests in Wave 2 will assert against.
 *
 * The schema here is the minimum subset of swarm-mcp's bootstrap SQL the
 * fake worker touches. Phase 1's swarmDbConnection.ts loads the full
 * schema from swarm-mcp at runtime; this fixture stays hermetic.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBehavior } from "./fakeSwarmWorker.ts";

const MINIMAL_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  directory TEXT NOT NULL,
  root TEXT NOT NULL,
  file_root TEXT NOT NULL DEFAULT '',
  pid INTEGER NOT NULL,
  label TEXT,
  registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
  heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
  adopted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  requester TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  files TEXT,
  result TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  changed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE context (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  file TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  subject TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

const SCOPE = "/repo";
const INSTANCE_ID = "instance-test-1";
const TASK_ID = "task-test-1";

let tempDir: string;
let dbPath: string;
const previousEnv: Record<string, string | undefined> = {};

function snapshotEnv(keys: string[]) {
  for (const key of keys) previousEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const key of Object.keys(previousEnv)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function reserveInstance(db: Database, opts: { id: string; scope: string; label?: string | null }) {
  db.run(
    `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
    [opts.id, opts.scope, opts.scope, opts.scope, opts.scope, opts.label ?? null]
  );
}

function insertTask(
  db: Database,
  opts: { id: string; scope: string; requester: string; assignee?: string | null }
) {
  db.run(
    `INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
     VALUES (?, ?, 'implement', 'fixture task', ?, ?, 'open')`,
    [opts.id, opts.scope, opts.requester, opts.assignee ?? null]
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "fake-swarm-worker-"));
  dbPath = path.join(tempDir, "swarm.db");
  const db = new Database(dbPath);
  db.exec(MINIMAL_SCHEMA);
  db.close();
  snapshotEnv([
    "SWARM_DB_PATH",
    "SWARM_MCP_INSTANCE_ID",
    "SWARM_MCP_LABEL",
    "FAKE_WORKER_BEHAVIOR",
    "FAKE_WORKER_TASK_ID",
    "FAKE_WORKER_RESULT_TEXT",
    "FAKE_WORKER_ERROR_MESSAGE",
    "FAKE_WORKER_USAGE_JSON",
    "FAKE_WORKER_PROGRESS_COUNT",
    "FAKE_WORKER_PROGRESS_INTERVAL_MS",
    "FAKE_WORKER_DELAY_MS",
    "FAKE_WORKER_HANG_MS"
  ]);
});

afterEach(() => {
  restoreEnv();
  rmSync(tempDir, { recursive: true, force: true });
});

test("adopt_then_exit flips adopted=1, sets pid, and emits instance.registered event", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE, label: "origin:clanky" });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID,
    SWARM_MCP_LABEL: "origin:clanky provider:claude-code role:implementer thread:dm user:anon"
  });

  const code = await runBehavior("adopt_then_exit");
  expect(code).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  const row = verify
    .query("SELECT adopted, pid, label FROM instances WHERE id = ?")
    .get(INSTANCE_ID) as { adopted: number; pid: number; label: string } | null;
  expect(row).not.toBeNull();
  expect(row?.adopted).toBe(1);
  expect(row?.pid).toBe(process.pid);
  expect(row?.label).toContain("provider:claude-code");

  const event = verify
    .query("SELECT type, subject FROM events WHERE type = 'instance.registered'")
    .get() as { type: string; subject: string } | null;
  expect(event?.subject).toBe(INSTANCE_ID);
  verify.close();
});

test("claim_and_complete adopts, claims task, and writes 'done' with result text", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE });
  insertTask(db, { id: TASK_ID, scope: SCOPE, requester: "clanky-peer", assignee: INSTANCE_ID });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID,
    FAKE_WORKER_TASK_ID: TASK_ID,
    FAKE_WORKER_RESULT_TEXT: "patch landed clean",
    FAKE_WORKER_USAGE_JSON: JSON.stringify({
      inputTokens: 1234,
      outputTokens: 567,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.0123
    })
  });

  const code = await runBehavior("claim_and_complete");
  expect(code).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  const task = verify
    .query("SELECT status, result, assignee FROM tasks WHERE id = ?")
    .get(TASK_ID) as { status: string; result: string; assignee: string } | null;
  expect(task?.status).toBe("done");
  expect(task?.result).toBe("patch landed clean");
  expect(task?.assignee).toBe(INSTANCE_ID);

  const usage = verify
    .query("SELECT content FROM context WHERE type = 'usage' AND file = ?")
    .get(TASK_ID) as { content: string } | null;
  expect(usage).not.toBeNull();
  const parsed = JSON.parse(usage!.content);
  expect(parsed.inputTokens).toBe(1234);
  expect(parsed.costUsd).toBeCloseTo(0.0123, 4);
  verify.close();
});

test("claim_and_fail writes 'failed' status with error text", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE });
  insertTask(db, { id: TASK_ID, scope: SCOPE, requester: "clanky-peer", assignee: INSTANCE_ID });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID,
    FAKE_WORKER_TASK_ID: TASK_ID,
    FAKE_WORKER_ERROR_MESSAGE: "compile failed: missing semicolon"
  });

  const code = await runBehavior("claim_and_fail");
  expect(code).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  const task = verify
    .query("SELECT status, result FROM tasks WHERE id = ?")
    .get(TASK_ID) as { status: string; result: string } | null;
  expect(task?.status).toBe("failed");
  expect(task?.result).toBe("compile failed: missing semicolon");
  verify.close();
});

test("progress_then_complete emits N progress annotations before terminal update", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE });
  insertTask(db, { id: TASK_ID, scope: SCOPE, requester: "clanky-peer", assignee: INSTANCE_ID });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID,
    FAKE_WORKER_TASK_ID: TASK_ID,
    FAKE_WORKER_PROGRESS_COUNT: "4",
    FAKE_WORKER_PROGRESS_INTERVAL_MS: "0",
    FAKE_WORKER_RESULT_TEXT: "all steps complete"
  });

  const code = await runBehavior("progress_then_complete");
  expect(code).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  const annotations = verify
    .query("SELECT content FROM context WHERE type = 'progress' AND file = ? ORDER BY rowid ASC")
    .all(TASK_ID) as Array<{ content: string }>;
  expect(annotations.length).toBe(4);
  expect(annotations[0].content).toBe("step 1 of 4");
  expect(annotations[3].content).toBe("step 4 of 4");

  const task = verify
    .query("SELECT status, result FROM tasks WHERE id = ?")
    .get(TASK_ID) as { status: string; result: string } | null;
  expect(task?.status).toBe("done");
  expect(task?.result).toBe("all steps complete");
  verify.close();
});

test("crash_after_adopt adopts the row but leaves the assigned task untouched", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE });
  insertTask(db, { id: TASK_ID, scope: SCOPE, requester: "clanky-peer", assignee: INSTANCE_ID });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID
  });

  const code = await runBehavior("crash_after_adopt");
  expect(code).toBe(1);

  const verify = new Database(dbPath, { readonly: true });
  const instance = verify
    .query("SELECT adopted FROM instances WHERE id = ?")
    .get(INSTANCE_ID) as { adopted: number } | null;
  expect(instance?.adopted).toBe(1);

  const task = verify
    .query("SELECT status, assignee FROM tasks WHERE id = ?")
    .get(TASK_ID) as { status: string; assignee: string } | null;
  // Task remains 'open' with original assignee — waiter timeout / stale sweep is what handles this in production.
  expect(task?.status).toBe("open");
  expect(task?.assignee).toBe(INSTANCE_ID);
  verify.close();
});

test("never_adopt does not write to the DB and returns when its hang window elapses", async () => {
  const db = new Database(dbPath);
  reserveInstance(db, { id: INSTANCE_ID, scope: SCOPE });
  db.close();

  setEnv({
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: INSTANCE_ID,
    FAKE_WORKER_HANG_MS: "20"
  });

  const code = await runBehavior("never_adopt");
  expect(code).toBe(0);

  const verify = new Database(dbPath, { readonly: true });
  const instance = verify
    .query("SELECT adopted FROM instances WHERE id = ?")
    .get(INSTANCE_ID) as { adopted: number } | null;
  expect(instance?.adopted).toBe(0);
  verify.close();
});

test("missing required env throws a clear error", async () => {
  setEnv({ SWARM_DB_PATH: undefined, SWARM_MCP_INSTANCE_ID: undefined });
  await expect(runBehavior("adopt_then_exit")).rejects.toThrow(/SWARM_DB_PATH/);
});
