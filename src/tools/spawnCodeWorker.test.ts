import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SwarmTask, UpdateTaskOpts } from "../agents/swarmPeer.ts";
import type { SpawnedPeer, SpawnPeerOptions } from "../agents/swarmLauncher.ts";
import { createTestSettings } from "../testSettings.ts";
import {
  cancelSpawnedWorkerForTask,
  getActiveSpawnedWorkerCount,
  spawnCodeWorker
} from "./spawnCodeWorker.ts";

function makeTask(id: string, scope: string): SwarmTask {
  return {
    id,
    scope,
    type: "implement",
    title: "Implement thing",
    description: "Implement thing",
    requester: "planner-1",
    assignee: null,
    status: "open",
    files: [],
    result: null,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
    priority: 0,
    dependsOn: [],
    idempotencyKey: null,
    parentTaskId: null
  };
}

function makeSettings(workspaceDir: string, dbPath: string) {
  return createTestSettings({
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"]
      }
    },
    agentStack: {
      overrides: {
        devTeam: {
          codingWorkers: ["codex_cli"],
          roles: {
            implementation: "codex_cli"
          }
        }
      },
      runtimeConfig: {
        devTeam: {
          swarm: {
            enabled: true,
            command: "bun",
            args: ["run", "./mcp-servers/swarm-mcp/src/index.ts"],
            dbPath
          },
          codexCli: {
            enabled: true,
            defaultCwd: workspaceDir,
            maxTasksPerHour: 100,
            maxParallelTasks: 4
          }
        }
      }
    }
  });
}

function makeSpawnedPeer(instanceId: string, workspaceDir: string, order: string[]): SpawnedPeer {
  let resolveExited!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExited = resolve;
  });
  return {
    instanceId,
    launchMode: "direct_child",
    scope: workspaceDir,
    fileRoot: workspaceDir,
    workspace: {
      repoRoot: workspaceDir,
      cwd: workspaceDir,
      canonicalCwd: workspaceDir,
      relativeCwd: ""
    },
    adopted: Promise.resolve(),
    exited,
    outputTail: () => "",
    cancel: async (reason?: string) => {
      order.push(`cancel:${reason}`);
      resolveExited({ code: null, signal: "SIGTERM" });
    }
  };
}

async function withTempWorkspace(run: (workspaceDir: string, dbPath: string) => Promise<void>) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clanky-spawn-code-worker-"));
  const workspaceDir = path.join(tempDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: workspaceDir });
  try {
    await run(workspaceDir, path.join(tempDir, "swarm.db"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("cancelSpawnedWorkerForTask marks the task cancelled before stopping the worker", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    const task = makeTask("task-1", workspaceDir);
    const spawned = makeSpawnedPeer("worker-1", workspaceDir, order);
    const peer = {
      requestTask: async () => task,
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        order.push(`update:${opts.result}`);
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    const result = await spawnCodeWorker({
      settings: makeSettings(workspaceDir, dbPath),
      task: "Implement thing",
      guildId: null,
      channelId: "channel-1",
      userId: "user-1"
    }, {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: {
        ensurePeer: () => peer
      } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (_opts: SpawnPeerOptions) => spawned
    });

    expect(result.taskId).toBe("task-1");
    expect(result.workerId).toBe("worker-1");
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(1);

    await expect(cancelSpawnedWorkerForTask("task-1", "operator stop")).resolves.toBe(true);

    expect(order).toEqual(["update:operator stop", "cancel:operator stop"]);
    expect(task.status).toBe("cancelled");
    expect(task.result).toBe("operator stop");
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(0);
  });
});

test("spawnCodeWorker can launch inbox-loop workers and persist their session", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    const task = makeTask("task-inbox", workspaceDir);
    const spawned = makeSpawnedPeer("worker-inbox", workspaceDir, order);
    const kvWrites: Array<{ key: string; value: string }> = [];
    let capturedOptions: SpawnPeerOptions | null = null;
    const peer = {
      instanceId: "clanky-planner",
      requestTask: async () => task,
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      getTask: async () => task,
      kvSet: async (key: string, value: string) => {
        kvWrites.push({ key, value });
        return {
          scope: workspaceDir,
          key,
          value,
          updatedAt: Date.now()
        };
      },
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        order.push(`update:${opts.result}`);
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    const result = await spawnCodeWorker({
      settings: makeSettings(workspaceDir, dbPath),
      task: "Plan an implementation",
      role: "design",
      workerMode: "inbox_loop",
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      triggerMessageId: "message-1"
    }, {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: {
        ensurePeer: () => peer
      } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (opts: SpawnPeerOptions) => {
        capturedOptions = opts;
        return spawned;
      }
    });

    expect(capturedOptions?.workerMode).toBe("inbox_loop");
    expect(capturedOptions?.role).toBe("planner");
    expect(result.workerMode).toBe("inbox_loop");
    expect(result.sessionKey).toContain("clanky:code_worker_session:last:guild:guild-1:channel:channel-1:user:user-1");
    expect(result.persistedSession).toBe(true);
    expect(kvWrites.length).toBe(4);
    expect(kvWrites.some((entry) => entry.key === "clanky/controller" && entry.value)).toBe(true);
    const lastSession = kvWrites.find((entry) => entry.key === result.sessionKey);
    expect(lastSession).toBeDefined();
    const sessionRecord = JSON.parse(String(lastSession?.value || "{}")) as Record<string, unknown>;
    expect(sessionRecord.workerId).toBe("worker-inbox");
    expect(sessionRecord.taskId).toBe("task-inbox");
    expect(sessionRecord.workerMode).toBe("inbox_loop");
    const workerSession = kvWrites.find((entry) => entry.key === "clanky:code_worker_session:worker:worker-inbox");
    expect(workerSession).toBeDefined();

    await expect(cancelSpawnedWorkerForTask("task-inbox", "test cleanup")).resolves.toBe(true);
  });
});

test("spawnCodeWorker can assign an existing open swarm task instead of creating a duplicate", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    const task = makeTask("existing-task", workspaceDir);
    task.title = "Existing planner task";
    const spawned = makeSpawnedPeer("worker-existing", workspaceDir, order);
    let requestTaskCalls = 0;
    let capturedTaskId: string | null = null;
    const peer = {
      instanceId: "clanky-planner",
      requestTask: async () => {
        requestTaskCalls += 1;
        return task;
      },
      getTask: async (taskId: string) => taskId === task.id ? task : null,
      kvSet: async (key: string, value: string) => ({
        scope: workspaceDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      assignTask: async (taskId: string, assignee: string) => {
        capturedTaskId = taskId;
        task.assignee = assignee;
        task.status = "claimed";
        return task;
      },
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    const result = await spawnCodeWorker({
      settings: makeSettings(workspaceDir, dbPath),
      task: "Handle existing task",
      existingTaskId: "existing-task",
      guildId: null,
      channelId: "channel-1",
      userId: "user-1"
    }, {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: {
        ensurePeer: () => peer
      } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (_opts: SpawnPeerOptions) => spawned
    });

    expect(requestTaskCalls).toBe(0);
    expect(capturedTaskId).toBe("existing-task");
    expect(result.taskId).toBe("existing-task");
    expect(result.workerId).toBe("worker-existing");

    await expect(cancelSpawnedWorkerForTask("existing-task", "test cleanup")).resolves.toBe(true);
  });
});

test("cancelSpawnedWorkerForTask still stops the worker when the task is already terminal", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    const task = makeTask("task-2", workspaceDir);
    const spawned = makeSpawnedPeer("worker-2", workspaceDir, order);
    const peer = {
      requestTask: async () => task,
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      updateTask: async () => {
        order.push("update");
        throw new Error("Task task-2 is already cancelled.");
      }
    };

    await spawnCodeWorker({
      settings: makeSettings(workspaceDir, dbPath),
      task: "Implement other thing",
      guildId: null,
      channelId: "channel-1",
      userId: "user-1"
    }, {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: {
        ensurePeer: () => peer
      } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (_opts: SpawnPeerOptions) => spawned
    });

    await expect(cancelSpawnedWorkerForTask("task-2", "already cancelled")).resolves.toBe(true);

    expect(order).toEqual(["update", "cancel:already cancelled"]);
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(0);
  });
});
