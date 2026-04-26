import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openSwarmDbConnection } from "./swarmDbConnection.ts";
import { ClankySwarmPeerManager } from "./swarmPeerManager.ts";
import { ensureClankySwarmPeerSchema } from "./swarmPeer.ts";

const tempDirs: string[] = [];
const managers: ClankySwarmPeerManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.shutdown();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "clanky-swarm-peer-"));
  tempDirs.push(dir);
  return dir;
}

function makeFixture() {
  const root = makeTempDir();
  const repoRoot = path.join(root, "repo");
  const fileRoot = path.join(repoRoot, "packages", "bot");
  mkdirSync(fileRoot, { recursive: true });
  return {
    dbPath: path.join(root, "swarm.db"),
    repoRoot,
    fileRoot
  };
}

function track(manager: ClankySwarmPeerManager) {
  managers.push(manager);
  return manager;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

function getInstanceRow(dbPath: string, id: string) {
  const db = openSwarmDbConnection(dbPath);
  try {
    return db
      .query("SELECT id, scope, pid, label, adopted, heartbeat FROM instances WHERE id = ?")
      .get(id) as {
      id: string;
      scope: string;
      pid: number;
      label: string | null;
      adopted: number;
      heartbeat: number;
    } | null;
  } finally {
    db.close();
  }
}

function getRegistrationParityRow(dbPath: string, id: string) {
  const db = openSwarmDbConnection(dbPath);
  try {
    return db
      .query("SELECT scope, directory, root, file_root, pid, label, adopted FROM instances WHERE id = ?")
      .get(id) as {
      scope: string;
      directory: string;
      root: string;
      file_root: string;
      pid: number;
      label: string | null;
      adopted: number;
    } | null;
  } finally {
    db.close();
  }
}

function registerWithSwarmMcpRegistry(fixture: ReturnType<typeof makeFixture>, label: string) {
  const registryUrl = pathToFileURL(path.resolve(import.meta.dir, "../../mcp-servers/swarm-mcp/src/registry.ts")).href;
  const script = `
    const { register } = await import(${JSON.stringify(registryUrl)});
    const instance = register(
      process.env.CLANKY_PARITY_REPO_ROOT,
      process.env.CLANKY_PARITY_LABEL,
      process.env.CLANKY_PARITY_SCOPE,
      process.env.CLANKY_PARITY_FILE_ROOT
    );
    console.log(JSON.stringify(instance));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      SWARM_DB_PATH: fixture.dbPath,
      CLANKY_PARITY_REPO_ROOT: fixture.repoRoot,
      CLANKY_PARITY_FILE_ROOT: fixture.fileRoot,
      CLANKY_PARITY_SCOPE: fixture.repoRoot,
      CLANKY_PARITY_LABEL: label
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split(/\n/).at(-1);
  assert.ok(line, "swarm-mcp registry helper did not print an instance.");
  return JSON.parse(line) as { id: string };
}

test("peer registers, heartbeats, and deregisters cleanly", async () => {
  const fixture = makeFixture();
  const manager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath, heartbeatIntervalMs: 50 }));
  const peer = manager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);

  const registered = getInstanceRow(fixture.dbPath, peer.instanceId);
  assert.equal(registered?.adopted, 1);
  assert.equal(registered?.pid, process.pid);
  assert.match(registered?.label || "", /origin:clanky/);
  assert.match(registered?.label || "", /role:planner/);

  const db = openSwarmDbConnection(fixture.dbPath);
  try {
    db.run("UPDATE instances SET heartbeat = 1 WHERE id = ?", [peer.instanceId]);
  } finally {
    db.close();
  }

  await waitFor(() => (getInstanceRow(fixture.dbPath, peer.instanceId)?.heartbeat ?? 0) > 1);

  manager.shutdown();
  assert.equal(getInstanceRow(fixture.dbPath, peer.instanceId), null);
});

test("peer registration row matches swarm-mcp register semantics", () => {
  const fixture = makeFixture();
  const label = "origin:clanky role:planner thread:dm user:anon";
  const swarmMcpPeer = registerWithSwarmMcpRegistry(fixture, label);

  const manager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const clankyPeer = manager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);

  const swarmMcpRow = getRegistrationParityRow(fixture.dbPath, swarmMcpPeer.id);
  const clankyRow = getRegistrationParityRow(fixture.dbPath, clankyPeer.instanceId);
  assert.ok(swarmMcpRow, "swarm-mcp registry row should exist.");
  assert.ok(clankyRow, "clanky peer registry row should exist.");

  assert.deepEqual(
    {
      scope: clankyRow.scope,
      directory: clankyRow.directory,
      root: clankyRow.root,
      file_root: clankyRow.file_root,
      label: clankyRow.label,
      adopted: clankyRow.adopted
    },
    {
      scope: swarmMcpRow.scope,
      directory: swarmMcpRow.directory,
      root: swarmMcpRow.root,
      file_root: swarmMcpRow.file_root,
      label: swarmMcpRow.label,
      adopted: swarmMcpRow.adopted
    }
  );
  assert.equal(clankyRow.pid, process.pid);
  assert.ok(swarmMcpRow.pid > 0);
});

test("messages, tasks, annotations, and activity stay isolated by scope", async () => {
  const fixture = makeFixture();
  const otherRoot = path.join(makeTempDir(), "other-repo");
  mkdirSync(otherRoot, { recursive: true });

  const managerA = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const managerB = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const managerC = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));

  const planner = managerA.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);
  const implementer = managerB.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);
  const otherScopePeer = managerC.ensurePeer(otherRoot, otherRoot, otherRoot);

  const broadcastCount = await planner.broadcast("scope-local hello");
  assert.equal(broadcastCount, 1);
  assert.equal((await implementer.pollMessages()).at(0)?.content, "scope-local hello");
  assert.deepEqual(await otherScopePeer.pollMessages(), []);

  const task = await planner.requestTask({
    type: "implement",
    title: "Wire peer tests",
    description: "Exercise the peer DB wrapper.",
    files: ["src/agents/swarmPeer.ts"],
    assignee: implementer.instanceId,
    priority: 4
  });
  assert.equal(task.status, "claimed");
  assert.equal(task.assignee, implementer.instanceId);
  assert.deepEqual(task.files, [path.join(fixture.fileRoot, "src/agents/swarmPeer.ts")]);

  const assignmentMessages = await implementer.pollMessages();
  assert.equal(assignmentMessages.length, 1);
  assert.match(assignmentMessages[0].content, /New implement task assigned/);

  await implementer.annotate({
    file: task.id,
    kind: "progress",
    content: "reading the relevant modules"
  });
  await implementer.updateTask(task.id, { status: "in_progress" });
  const completed = await implementer.updateTask(task.id, {
    status: "done",
    result: "peer wrapper complete"
  });
  assert.equal(completed.status, "done");
  assert.equal(completed.result, "peer wrapper complete");

  const activity = await planner.waitForActivity({ timeoutMs: 500, pollIntervalMs: 25 });
  assert.deepEqual(activity.changes, ["new_messages"]);
  assert.match(activity.messages?.at(0)?.content || "", /peer wrapper complete/);

  const verify = openSwarmDbConnection(fixture.dbPath);
  try {
    const annotation = verify
      .query("SELECT type, content FROM context WHERE scope = ? AND instance_id = ? AND file = ?")
      .get(planner.scope, implementer.instanceId, path.join(fixture.fileRoot, task.id)) as {
      type: string;
      content: string;
    } | null;
    assert.equal(annotation?.type, "progress");
    assert.equal(annotation?.content, "reading the relevant modules");

    const otherScopeMessages = verify
      .query("SELECT COUNT(*) as count FROM messages WHERE scope = ?")
      .get(otherScopePeer.scope) as { count: number };
    assert.equal(otherScopeMessages.count, 0);
  } finally {
    verify.close();
  }
});

test("assignTask claims an open task for a newly registered worker", async () => {
  const fixture = makeFixture();
  const plannerManager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const workerManager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));

  const planner = plannerManager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);
  const worker = workerManager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);

  const openTask = await planner.requestTask({
    type: "code",
    title: "Reserved task before worker assignment"
  });
  assert.equal(openTask.status, "open");
  assert.equal(openTask.assignee, null);

  const assigned = await planner.assignTask(openTask.id, worker.instanceId);
  assert.equal(assigned.status, "claimed");
  assert.equal(assigned.assignee, worker.instanceId);
  assert.match((await worker.pollMessages()).at(0)?.content || "", /assigned to you/);
});

test("requester can mark an unassigned launch task failed", async () => {
  const fixture = makeFixture();
  const manager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const planner = manager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);

  const openTask = await planner.requestTask({
    type: "code",
    title: "Launch-backed task"
  });
  assert.equal(openTask.status, "open");
  assert.equal(openTask.assignee, null);

  const failed = await planner.failRequestedTask(openTask.id, "worker launch failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, "worker launch failed");
});

test("stale clanky peer rows are pruned before restart registration", () => {
  const fixture = makeFixture();
  ensureClankySwarmPeerSchema(fixture.dbPath);

  const staleId = "stale-clanky-peer";
  const db = openSwarmDbConnection(fixture.dbPath);
  try {
    db.run(
      `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted, heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        staleId,
        fixture.repoRoot,
        fixture.repoRoot,
        fixture.repoRoot,
        fixture.fileRoot,
        process.pid,
        "origin:clanky role:planner thread:dm user:anon",
        Math.floor(Date.now() / 1000) - 60
      ]
    );
  } finally {
    db.close();
  }

  const manager = track(new ClankySwarmPeerManager({ dbPath: fixture.dbPath }));
  const peer = manager.ensurePeer(fixture.repoRoot, fixture.repoRoot, fixture.fileRoot);
  assert.notEqual(peer.instanceId, staleId);

  const verify = openSwarmDbConnection(fixture.dbPath);
  try {
    const stale = verify.query("SELECT id FROM instances WHERE id = ?").get(staleId);
    assert.equal(stale, null);

    const active = verify
      .query("SELECT COUNT(*) as count FROM instances WHERE scope = ?")
      .get(peer.scope) as { count: number };
    assert.equal(active.count, 1);

    const event = verify
      .query("SELECT type, subject FROM events WHERE type = 'instance.stale_reclaimed'")
      .get() as { type: string; subject: string } | null;
    assert.equal(event?.subject, staleId);
  } finally {
    verify.close();
  }
});
