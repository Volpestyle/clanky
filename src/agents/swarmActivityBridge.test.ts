import { afterEach, beforeEach, expect, test } from "bun:test";
import { SwarmActivityBridge, type CodeTaskDispatchContext } from "./swarmActivityBridge.ts";
import type { ClankyPeer, SwarmContextEntry, SwarmTask, SwarmTaskStatus } from "./swarmPeer.ts";

type FakePeer = Pick<ClankyPeer, "getTask" | "checkFile" | "scope">;

function fakePeer({
  scope,
  task,
  annotations
}: {
  scope: string;
  task: () => SwarmTask | null;
  annotations: () => SwarmContextEntry[];
}): FakePeer {
  return {
    scope,
    getTask: async () => task(),
    checkFile: async () => annotations()
  } as FakePeer;
}

function makeContext(overrides: Partial<CodeTaskDispatchContext> = {}): CodeTaskDispatchContext {
  return {
    taskId: "task-1",
    workerId: "worker-1",
    scope: "/repo",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    triggerMessageId: "msg-1",
    source: "test",
    ...overrides
  };
}

function makeTask({
  id,
  status,
  result = null
}: {
  id: string;
  status: SwarmTaskStatus;
  result?: string | null;
}): SwarmTask {
  return {
    id,
    scope: "/repo",
    type: "implement",
    title: "t",
    description: null,
    requester: "clanky",
    assignee: "worker-1",
    status,
    files: [],
    result,
    createdAt: 0,
    updatedAt: 0,
    changedAt: 0,
    priority: 0,
    dependsOn: [],
    idempotencyKey: null,
    parentTaskId: null
  };
}

let bridge: SwarmActivityBridge | null;

afterEach(() => {
  bridge?.shutdown();
  bridge = null;
});

test("trackTask + pollOnce surfaces progress annotations once each", async () => {
  let task: SwarmTask | null = makeTask({ id: "task-1", status: "in_progress" });
  let annotations: SwarmContextEntry[] = [];
  const progress: string[] = [];
  bridge = new SwarmActivityBridge({
    onProgress: (event) => {
      progress.push(event.summary);
    }
  });

  const peer = fakePeer({
    scope: "/repo",
    task: () => task,
    annotations: () => annotations
  });
  bridge.trackTask(peer as ClankyPeer, makeContext());

  annotations = [
    { id: "a1", scope: "/repo", instanceId: "worker-1", file: "task-1", type: "progress", content: "step 1", createdAt: 1 }
  ];
  await bridge.pollOnce("/repo");
  expect(progress).toEqual(["step 1"]);

  // Same annotation re-read shouldn't fire again.
  await bridge.pollOnce("/repo");
  expect(progress).toEqual(["step 1"]);

  annotations = [
    { id: "a1", scope: "/repo", instanceId: "worker-1", file: "task-1", type: "progress", content: "step 1", createdAt: 1 },
    { id: "a2", scope: "/repo", instanceId: "worker-1", file: "task-1", type: "progress", content: "step 2", createdAt: 2 }
  ];
  await bridge.pollOnce("/repo");
  expect(progress).toEqual(["step 1", "step 2"]);
});

test("terminal status fires onTerminal exactly once and clears tracking", async () => {
  let task: SwarmTask | null = makeTask({ id: "task-1", status: "in_progress" });
  const terminals: { status: string; result: string }[] = [];
  bridge = new SwarmActivityBridge({
    onTerminal: (event) => {
      terminals.push({ status: event.status, result: event.result });
    }
  });
  const peer = fakePeer({
    scope: "/repo",
    task: () => task,
    annotations: () => []
  });
  bridge.trackTask(peer as ClankyPeer, makeContext());

  await bridge.pollOnce("/repo");
  expect(terminals.length).toBe(0);
  expect(bridge.size()).toBe(1);

  task = makeTask({ id: "task-1", status: "done", result: "all good" });
  await bridge.pollOnce("/repo");
  expect(terminals).toEqual([{ status: "done", result: "all good" }]);
  expect(bridge.size()).toBe(0);

  // After clearing tracking, further polls don't refire.
  await bridge.pollOnce("/repo");
  expect(terminals.length).toBe(1);
});

test("cancelled status invokes the cancel hook with the taskId", async () => {
  let task: SwarmTask | null = makeTask({ id: "task-1", status: "in_progress" });
  const cancels: { taskId: string; reason?: string }[] = [];
  bridge = new SwarmActivityBridge({
    cancelWorker: async (taskId, reason) => {
      cancels.push({ taskId, reason });
      return true;
    }
  });
  const peer = fakePeer({
    scope: "/repo",
    task: () => task,
    annotations: () => []
  });
  bridge.trackTask(peer as ClankyPeer, makeContext());

  task = makeTask({ id: "task-1", status: "cancelled", result: "by user" });
  await bridge.pollOnce("/repo");
  expect(cancels).toEqual([{ taskId: "task-1", reason: "swarm task cancelled" }]);
});

test("contextsForScope filters by guildId and channelId", () => {
  bridge = new SwarmActivityBridge();
  const peerA = fakePeer({ scope: "/repoA", task: () => null, annotations: () => [] });
  const peerB = fakePeer({ scope: "/repoB", task: () => null, annotations: () => [] });

  bridge.trackTask(peerA as ClankyPeer, makeContext({ taskId: "t1", scope: "/repoA", channelId: "ch-A" }));
  bridge.trackTask(peerA as ClankyPeer, makeContext({ taskId: "t2", scope: "/repoA", channelId: "ch-B" }));
  bridge.trackTask(peerB as ClankyPeer, makeContext({ taskId: "t3", scope: "/repoB", channelId: "ch-A" }));

  const filteredByChannel = bridge.contextsForScope({ guildId: "guild-1", channelId: "ch-A" });
  expect(filteredByChannel.map((c) => c.taskId).sort()).toEqual(["t1", "t3"]);

  const filteredByGuildOnly = bridge.contextsForScope({ guildId: "guild-1" });
  expect(filteredByGuildOnly.length).toBe(3);
});

test("shutdown clears intervals and tracked state", () => {
  bridge = new SwarmActivityBridge({ pollIntervalMs: 10_000 });
  const peer = fakePeer({ scope: "/repo", task: () => null, annotations: () => [] });
  bridge.trackTask(peer as ClankyPeer, makeContext());
  expect(bridge.size()).toBe(1);
  bridge.shutdown();
  expect(bridge.size()).toBe(0);
  // Subsequent trackTask should be ignored.
  bridge.trackTask(peer as ClankyPeer, makeContext({ taskId: "t-ignored" }));
  expect(bridge.size()).toBe(0);
});
