import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { bootstrapSwarmTestSchema } from "./__fixtures__/swarmTestSchema.ts";
import {
  deleteUnadopted,
  fullDeregister,
  heartbeatUnadopted,
  isAdopted,
  reserveInstance
} from "./swarmDb.ts";

let tempDir: string;
let dbPath: string;
let workspaceDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "clanky-swarm-db-"));
  dbPath = path.join(tempDir, "swarm.db");
  workspaceDir = path.join(tempDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  bootstrapSwarmTestSchema(dbPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function readInstance(id: string) {
  const verify = new Database(dbPath, { readonly: true });
  try {
    return verify
      .query(
        "SELECT id, scope, directory, root, file_root, pid, label, adopted FROM instances WHERE id = ?"
      )
      .get(id) as
      | {
          id: string;
          scope: string;
          directory: string;
          root: string;
          file_root: string;
          pid: number;
          label: string | null;
          adopted: number;
        }
      | null;
  } finally {
    verify.close();
  }
}

test("reserveInstance writes pid=0, adopted=0 and resolves git root for scope", () => {
  mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
  const innerDir = path.join(workspaceDir, "src", "agents");
  mkdirSync(innerDir, { recursive: true });

  const reserved = reserveInstance({
    dbPath,
    directory: innerDir,
    label: "origin:clanky role:implementer"
  });

  expect(reserved.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(reserved.directory).toBe(path.resolve(innerDir));
  expect(reserved.root).toBe(path.resolve(workspaceDir));
  expect(reserved.scope).toBe(path.resolve(workspaceDir));
  expect(reserved.fileRoot).toBe(path.resolve(innerDir));

  const row = readInstance(reserved.id);
  expect(row).not.toBeNull();
  expect(row?.pid).toBe(0);
  expect(row?.adopted).toBe(0);
  expect(row?.label).toBe("origin:clanky role:implementer");
  expect(row?.directory).toBe(path.resolve(innerDir));
  expect(row?.root).toBe(path.resolve(workspaceDir));
  expect(row?.scope).toBe(path.resolve(workspaceDir));
  expect(row?.file_root).toBe(path.resolve(innerDir));
});

test("reserveInstance falls back to directory itself when no .git ancestor exists", () => {
  const reserved = reserveInstance({
    dbPath,
    directory: workspaceDir,
    label: "origin:clanky"
  });
  expect(reserved.scope).toBe(path.resolve(workspaceDir));
  expect(reserved.root).toBe(path.resolve(workspaceDir));
});

test("reserveInstance honors explicit scope override and fileRoot", () => {
  mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
  const innerDir = path.join(workspaceDir, "src");
  mkdirSync(innerDir, { recursive: true });

  const reserved = reserveInstance({
    dbPath,
    directory: innerDir,
    scope: "/custom/scope",
    fileRoot: "/custom/file-root",
    label: "origin:clanky"
  });
  expect(reserved.scope).toBe(path.resolve("/custom/scope"));
  expect(reserved.fileRoot).toBe(path.resolve("/custom/file-root"));
  expect(reserved.root).toBe(path.resolve(workspaceDir));
});

test("heartbeatUnadopted refreshes pre-adopt rows and skips adopted ones", async () => {
  const reserved = reserveInstance({
    dbPath,
    directory: workspaceDir,
    label: "origin:clanky"
  });

  const stomp = new Database(dbPath);
  try {
    stomp.run("UPDATE instances SET heartbeat = 1 WHERE id = ?", [reserved.id]);
  } finally {
    stomp.close();
  }

  expect(heartbeatUnadopted(dbPath, reserved.id)).toBe(true);

  const verify = new Database(dbPath, { readonly: true });
  try {
    const row = verify
      .query("SELECT heartbeat FROM instances WHERE id = ?")
      .get(reserved.id) as { heartbeat: number };
    expect(row.heartbeat).toBeGreaterThan(1);
  } finally {
    verify.close();
  }

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1 WHERE id = ?", [reserved.id]);
  } finally {
    adopt.close();
  }
  expect(heartbeatUnadopted(dbPath, reserved.id)).toBe(false);
});

test("deleteUnadopted removes pre-adopt rows and leaves adopted ones intact", () => {
  const a = reserveInstance({ dbPath, directory: workspaceDir, label: "a" });
  const b = reserveInstance({ dbPath, directory: workspaceDir, label: "b" });

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1, pid = 99 WHERE id = ?", [b.id]);
  } finally {
    adopt.close();
  }

  expect(deleteUnadopted(dbPath, a.id)).toBe(true);
  expect(deleteUnadopted(dbPath, b.id)).toBe(false);
  expect(readInstance(a.id)).toBeNull();
  expect(readInstance(b.id)?.adopted).toBe(1);
});

test("isAdopted reports the row's adoption state and null when missing", () => {
  const reserved = reserveInstance({ dbPath, directory: workspaceDir, label: "x" });
  expect(isAdopted(dbPath, reserved.id)).toBe(false);

  const adopt = new Database(dbPath);
  try {
    adopt.run("UPDATE instances SET adopted = 1 WHERE id = ?", [reserved.id]);
  } finally {
    adopt.close();
  }
  expect(isAdopted(dbPath, reserved.id)).toBe(true);

  expect(isAdopted(dbPath, "missing-id")).toBeNull();
});

test("fullDeregister cascades cleanup and emits instance.deregistered", () => {
  const reserved = reserveInstance({ dbPath, directory: workspaceDir, label: "role:x" });

  const seed = new Database(dbPath);
  try {
    seed.run("UPDATE instances SET adopted = 1, pid = 42 WHERE id = ?", [reserved.id]);
    seed.run(
      `INSERT INTO context (id, scope, instance_id, file, type, content)
       VALUES ('lock1', ?, ?, '/repo/a.txt', 'lock', 'held')`,
      [reserved.scope, reserved.id]
    );
    seed.run(
      `INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
       VALUES ('t-claimed', ?, 'implement', 'claimed', 'planner', ?, 'claimed')`,
      [reserved.scope, reserved.id]
    );
    seed.run(
      `INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
       VALUES ('t-blocked', ?, 'implement', 'blocked', 'planner', ?, 'blocked')`,
      [reserved.scope, reserved.id]
    );
    seed.run(
      `INSERT INTO messages (scope, sender, recipient, content)
       VALUES (?, 'other', ?, 'queued')`,
      [reserved.scope, reserved.id]
    );
  } finally {
    seed.close();
  }

  fullDeregister(dbPath, reserved.id);

  const verify = new Database(dbPath, { readonly: true });
  try {
    expect(readInstance(reserved.id)).toBeNull();

    const lockCount = (verify
      .query("SELECT COUNT(*) AS n FROM context WHERE instance_id = ?")
      .get(reserved.id) as { n: number }).n;
    expect(lockCount).toBe(0);

    const msgCount = (verify
      .query("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?")
      .get(reserved.id) as { n: number }).n;
    expect(msgCount).toBe(0);

    const claimed = verify
      .query("SELECT status, assignee FROM tasks WHERE id = 't-claimed'")
      .get() as { status: string; assignee: string | null };
    expect(claimed.status).toBe("open");
    expect(claimed.assignee).toBeNull();

    const blocked = verify
      .query("SELECT status, assignee FROM tasks WHERE id = 't-blocked'")
      .get() as { status: string; assignee: string | null };
    expect(blocked.status).toBe("blocked");
    expect(blocked.assignee).toBeNull();

    const event = verify
      .query("SELECT type, subject FROM events WHERE type = 'instance.deregistered'")
      .get() as { type: string; subject: string } | null;
    expect(event?.subject).toBe(reserved.id);
  } finally {
    verify.close();
  }
});

test("fullDeregister is a no-op when the instance row is gone", () => {
  expect(() => fullDeregister(dbPath, "missing-id")).not.toThrow();
});

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
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

test("reserved row is adopted by a real swarm-mcp child via SWARM_MCP_INSTANCE_ID", async () => {
  const swarmIndex = path.resolve(process.cwd(), "../swarm-mcp/src/index.ts");
  if (!existsSync(swarmIndex)) {
    // No sibling checkout — skip the live integration leg.
    return;
  }

  const reserved = reserveInstance({
    dbPath,
    directory: workspaceDir,
    label: "origin:clanky role:implementer thread:dm user:anon"
  });

  const child = spawn(process.execPath, ["run", swarmIndex], {
    env: {
      ...process.env,
      SWARM_DB_PATH: dbPath,
      SWARM_MCP_INSTANCE_ID: reserved.id,
      SWARM_MCP_DIRECTORY: workspaceDir,
      SWARM_MCP_SCOPE: reserved.scope,
      SWARM_MCP_FILE_ROOT: reserved.fileRoot,
      SWARM_MCP_LABEL: "origin:clanky role:implementer thread:dm user:anon"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  try {
    await waitFor(
      () => isAdopted(dbPath, reserved.id) === true,
      { timeoutMs: 10000 }
    );
  } catch (error) {
    throw new Error(
      `swarm-mcp child failed to adopt reservation. stderr=\n${stderr}\n\n${(error as Error).message}`
    );
  } finally {
    await closeChild(child);
  }
});
