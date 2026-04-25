import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createTestSettings } from "../testSettings.ts";
import {
  getSwarmDbPath,
  openSwarmDbConnection,
  resolveSwarmDbPath,
  SWARM_DB_BUSY_TIMEOUT_MS
} from "./swarmDbConnection.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "clanky-swarm-db-"));
  tempDirs.push(dir);
  return dir;
}

function makeTempDbPath() {
  return path.join(makeTempDir(), "swarm.db");
}

function withSwarmDbPath<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.SWARM_DB_PATH;
  if (value === undefined) {
    delete process.env.SWARM_DB_PATH;
  } else {
    process.env.SWARM_DB_PATH = value;
  }
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.SWARM_DB_PATH;
    } else {
      process.env.SWARM_DB_PATH = prior;
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

async function closeChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.killed) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, 1000))
  ]);
}

test("openSwarmDbConnection enables WAL mode, busy timeout, and concurrent opens", () => {
  const dbPath = makeTempDbPath();
  const first = openSwarmDbConnection(dbPath);
  const second = openSwarmDbConnection(dbPath);

  try {
    const journalMode = first.query("PRAGMA journal_mode").get() as { journal_mode?: string };
    const busyTimeout = first.query("PRAGMA busy_timeout").get() as { timeout?: number };
    assert.equal(String(journalMode.journal_mode || "").toLowerCase(), "wal");
    assert.equal(busyTimeout.timeout, SWARM_DB_BUSY_TIMEOUT_MS);

    first.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    first.query("INSERT INTO probe (value) VALUES (?)").run("from-first");
    second.query("INSERT INTO probe (value) VALUES (?)").run("from-second");

    const rows = first.query("SELECT value FROM probe ORDER BY id ASC").all() as Array<{ value: string }>;
    assert.deepEqual(rows.map((row) => row.value), ["from-first", "from-second"]);
  } finally {
    first.close();
    second.close();
  }
});

test("resolveSwarmDbPath and getSwarmDbPath centralize the effective path", () => {
  const explicitPath = path.join(makeTempDir(), "explicit.db");
  const envPath = path.join(makeTempDir(), "env.db");

  withSwarmDbPath(envPath, () => {
    assert.equal(resolveSwarmDbPath(), path.resolve(envPath));
    assert.equal(resolveSwarmDbPath(explicitPath), path.resolve(explicitPath));

    const defaultSettings = createTestSettings();
    assert.equal(getSwarmDbPath(defaultSettings), path.resolve(envPath));

    const configuredSettings = createTestSettings({
      agentStack: {
        runtimeConfig: {
          devTeam: {
            swarm: {
              dbPath: explicitPath
            }
          }
        }
      }
    });
    assert.equal(getSwarmDbPath(configuredSettings), path.resolve(explicitPath));
  });
});

test("swarm-mcp bootstraps the runtime instances schema Clanky depends on", async () => {
  const swarmIndex = path.resolve(process.cwd(), "../swarm-mcp/src/index.ts");
  assert.equal(existsSync(swarmIndex), true, `Expected sibling swarm-mcp checkout at ${swarmIndex}`);

  const dbPath = makeTempDbPath();
  const child = spawn(process.execPath, ["run", swarmIndex], {
    env: {
      ...process.env,
      SWARM_DB_PATH: dbPath
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  try {
    const expectedColumns = [
      "id",
      "scope",
      "directory",
      "root",
      "file_root",
      "pid",
      "label",
      "adopted",
      "heartbeat",
      "registered_at"
    ];

    await waitFor(() => {
      if (!existsSync(dbPath)) return false;
      const db = openSwarmDbConnection(dbPath);
      try {
        const rows = db.query("PRAGMA table_info(instances)").all() as Array<{ name: string }>;
        const columns = new Set(rows.map((row) => row.name));
        return expectedColumns.every((column) => columns.has(column));
      } finally {
        db.close();
      }
    }, { timeoutMs: 8000 });
  } finally {
    await closeChild(child);
  }

  assert.equal(child.exitCode === 1 && stderr.length > 0, false, stderr);
});
