import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClankySwarmPeerManager } from "./swarmPeerManager.ts";
import { waitForTaskCompletion } from "./swarmTaskWaiter.ts";

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

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clanky-swarm-task-waiter-"));
  tempDirs.push(root);
  const repoRoot = path.join(root, "repo");
  const fileRoot = path.join(repoRoot, "src");
  mkdirSync(fileRoot, { recursive: true });
  const manager = new ClankySwarmPeerManager({
    dbPath: path.join(root, "swarm.db"),
    heartbeatIntervalMs: 60_000
  });
  managers.push(manager);
  return {
    dbPath: path.join(root, "swarm.db"),
    peer: manager.ensurePeer(repoRoot, repoRoot, fileRoot)
  };
}

test("waitForTaskCompletion returns task result, usage, and progress annotations", async () => {
  const { dbPath, peer } = makeFixture();
  const task = await peer.requestTask({
    type: "implement",
    title: "Wire the waiter",
    description: "Exercise result extraction.",
    files: []
  });
  await peer.assignTask(task.id, peer.instanceId);
  const progress: string[] = [];

  await peer.annotate({
    file: task.id,
    kind: "progress",
    content: "editing src/agents/swarmTaskWaiter.ts"
  });
  await peer.annotate({
    file: task.id,
    kind: "usage",
    content: JSON.stringify({
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheWriteTokens: 2,
        cacheReadTokens: 1
      },
      costUsd: 0.123
    })
  });
  await peer.updateTask(task.id, {
    status: "done",
    result: "waiter complete"
  });

  const result = await waitForTaskCompletion(peer, task.id, {
    dbPath,
    timeoutMs: 500,
    pollIntervalMs: 25,
    onProgress: (event) => {
      progress.push(event.summary);
    }
  });

  assert.equal(result.isError, false);
  assert.equal(result.text, "waiter complete");
  assert.equal(result.costUsd, 0.123);
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheWriteTokens: 2,
    cacheReadTokens: 1
  });
  assert.deepEqual(progress, ["editing src/agents/swarmTaskWaiter.ts"]);
});

test("waitForTaskCompletion returns a timeout result for non-terminal tasks", async () => {
  const { dbPath, peer } = makeFixture();
  const task = await peer.requestTask({
    type: "implement",
    title: "Hang",
    description: "Remain pending.",
    files: []
  });

  const result = await waitForTaskCompletion(peer, task.id, {
    dbPath,
    timeoutMs: 50,
    pollIntervalMs: 10
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /timed out/);
  assert.match(result.errorMessage, new RegExp(task.id));
});
