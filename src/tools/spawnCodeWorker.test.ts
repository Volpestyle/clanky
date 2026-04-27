import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
        allowedUserIds: ["user-1"],
        allowedWorkspaceRoots: [workspaceDir]
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

test("spawnCodeWorker persists a session record on every spawn so followups can find the live worker", async () => {
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

    expect(capturedOptions?.role).toBe("planner");
    expect(result.sessionKey).toContain("clanky:code_worker_session:last:guild:guild-1:channel:channel-1:user:user-1");
    expect(result.persistedSession).toBe(true);
    expect(kvWrites.length).toBe(4);
    expect(kvWrites.some((entry) => entry.key === "clanky/controller" && entry.value)).toBe(true);
    const lastSession = kvWrites.find((entry) => entry.key === result.sessionKey);
    expect(lastSession).toBeDefined();
    const sessionRecord = JSON.parse(String(lastSession?.value || "{}")) as Record<string, unknown>;
    expect(sessionRecord.workerId).toBe("worker-inbox");
    expect(sessionRecord.taskId).toBe("task-inbox");
    expect(sessionRecord.role).toBe("design");
    const workerSession = kvWrites.find((entry) => entry.key === "clanky:code_worker_session:worker:worker-inbox");
    expect(workerSession).toBeDefined();

    await expect(cancelSpawnedWorkerForTask("task-inbox", "test cleanup")).resolves.toBe(true);
  });
});

test("spawnCodeWorker resolves GitHub issue URLs to approved local clones", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const repoDir = path.join(workspaceDir, "nested", "clanky");
    mkdirSync(repoDir, { recursive: true });
    spawnSync("git", ["init", "--quiet"], { cwd: repoDir });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/Volpestyle/clanky.git"], { cwd: repoDir });

    const realRepoDir = realpathSync(repoDir);
    const order: string[] = [];
    const task = makeTask("task-github", realRepoDir);
    const spawned = makeSpawnedPeer("worker-github", realRepoDir, order);
    let capturedOptions: SpawnPeerOptions | null = null;
    const peer = {
      instanceId: "clanky-planner",
      requestTask: async () => task,
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      getTask: async () => task,
      kvSet: async (key: string, value: string) => ({
        scope: realRepoDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    const result = await spawnCodeWorker({
      settings: makeSettings(workspaceDir, dbPath),
      task: "Fix https://github.com/Volpestyle/clanky/issues/25",
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
      spawnPeer: async (opts: SpawnPeerOptions) => {
        capturedOptions = opts;
        return spawned;
      }
    });

    expect(capturedOptions?.cwd).toBe(realRepoDir);
    expect(result.cwd).toBe(realRepoDir);

    await expect(cancelSpawnedWorkerForTask("task-github", "test cleanup")).resolves.toBe(true);
  });
});

test("spawnCodeWorker resolves bare cwd under the configured root and allows non-git workspaces", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clanky-spawn-code-worker-non-git-"));
  const workspaceRoot = path.join(tempDir, "volpestyle");
  const packageDir = path.join(workspaceRoot, "swarm-test");
  mkdirSync(packageDir, { recursive: true });
  try {
    const realPackageDir = realpathSync(packageDir);
    const order: string[] = [];
    const task = makeTask("task-non-git", realPackageDir);
    const spawned = makeSpawnedPeer("worker-non-git", realPackageDir, order);
    let capturedOptions: SpawnPeerOptions | null = null;
    let capturedPeerScope = "";
    let capturedPeerRepoRoot = "";
    let capturedPeerFileRoot = "";
    const peer = {
      instanceId: "clanky-planner",
      requestTask: async () => task,
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      kvSet: async (key: string, value: string) => ({
        scope: realPackageDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    const result = await spawnCodeWorker({
      settings: makeSettings(workspaceRoot, path.join(tempDir, "swarm.db")),
      task: "Create a short todo app in this package",
      cwd: "swarm-test",
      guildId: null,
      channelId: "channel-1",
      userId: "user-1"
    }, {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: {
        ensurePeer: (scope: string, repoRoot: string, fileRoot: string) => {
          capturedPeerScope = scope;
          capturedPeerRepoRoot = repoRoot;
          capturedPeerFileRoot = fileRoot;
          return peer;
        }
      } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (opts: SpawnPeerOptions) => {
        capturedOptions = opts;
        return spawned;
      }
    });

    expect(capturedOptions?.cwd).toBe(realPackageDir);
    expect(capturedPeerScope).toBe(realPackageDir);
    expect(capturedPeerRepoRoot).toBe(realPackageDir);
    expect(capturedPeerFileRoot).toBe(realPackageDir);
    expect(result.cwd).toBe(realPackageDir);
    expect(result.scope).toBe(realPackageDir);

    await expect(cancelSpawnedWorkerForTask("task-non-git", "test cleanup")).resolves.toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test("spawnCodeWorker marks newly created tasks failed when worker launch fails", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const task = makeTask("task-launch-failed", workspaceDir);
    const updates: UpdateTaskOpts[] = [];
    const peer = {
      instanceId: "clanky-planner",
      requestTask: async () => task,
      kvSet: async (key: string, value: string) => ({
        scope: workspaceDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      assignTask: async (_taskId: string, assignee: string) => {
        task.assignee = assignee;
        return task;
      },
      updateTask: async (_taskId: string, opts: UpdateTaskOpts) => {
        updates.push(opts);
        task.status = opts.status;
        task.result = opts.result ?? null;
        return task;
      }
    };

    await expect(spawnCodeWorker({
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
      spawnPeer: async () => {
        throw new Error("spawn exploded");
      }
    })).rejects.toThrow("spawn exploded");

    expect(updates).toEqual([{
      status: "failed",
      result: "spawn_code_worker failed before worker assignment: spawn exploded"
    }]);
    expect(task.status).toBe("failed");
    expect(task.result).toBe("spawn_code_worker failed before worker assignment: spawn exploded");
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

test("spawnCodeWorker reuses an idle worker via send_message instead of spawning fresh", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    let nextTaskId = 1;
    const tasks = new Map<string, SwarmTask>();
    const makeFreshTask = () => {
      const id = `task-${nextTaskId++}`;
      const t = makeTask(id, workspaceDir);
      tasks.set(id, t);
      return t;
    };

    const spawned = makeSpawnedPeer("worker-reuse", workspaceDir, order);
    let spawnPeerCalls = 0;
    const sentMessages: Array<{ recipient: string; content: string }> = [];
    const assignedTaskIds: string[] = [];

    const peer = {
      instanceId: "clanky-orchestrator",
      requestTask: async () => makeFreshTask(),
      getTask: async (taskId: string) => tasks.get(taskId) ?? null,
      assignTask: async (taskId: string, assignee: string) => {
        const t = tasks.get(taskId);
        if (!t) throw new Error(`unknown task ${taskId}`);
        t.assignee = assignee;
        t.status = "claimed";
        assignedTaskIds.push(taskId);
        return t;
      },
      sendMessage: async (recipient: string, content: string) => {
        sentMessages.push({ recipient, content });
      },
      kvSet: async (key: string, value: string) => ({
        scope: workspaceDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      updateTask: async (taskId: string, opts: UpdateTaskOpts) => {
        const t = tasks.get(taskId);
        if (!t) throw new Error(`unknown task ${taskId}`);
        order.push(`update:${taskId}:${opts.status}`);
        t.status = opts.status;
        t.result = opts.result ?? null;
        return t;
      }
    };

    const settings = makeSettings(workspaceDir, dbPath);
    const baseArgs = {
      settings,
      role: "implementation" as const,
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1"
    };
    const deps = {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: { ensurePeer: () => peer } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (_opts: SpawnPeerOptions) => {
        spawnPeerCalls += 1;
        return spawned;
      }
    };

    const first = await spawnCodeWorker({ ...baseArgs, task: "First task" }, deps);
    expect(spawnPeerCalls).toBe(1);
    expect(first.taskId).toBe("task-1");
    expect(first.workerId).toBe("worker-reuse");
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(1);

    // Mark the first task done so the worker enters its idle listen window.
    // The next spawn call's refresh pass will flip the worker's idle flag.
    tasks.get("task-1")!.status = "done";

    const second = await spawnCodeWorker({ ...baseArgs, task: "Follow-up task" }, deps);

    expect(spawnPeerCalls).toBe(1);
    expect(second.workerId).toBe("worker-reuse");
    expect(second.taskId).toBe("task-2");
    expect(assignedTaskIds).toEqual(["task-1", "task-2"]);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.recipient).toBe("worker-reuse");
    expect(sentMessages[0]?.content).toContain("task-2");
    expect(sentMessages[0]?.content).toContain("Follow-up task");
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(1);

    await expect(cancelSpawnedWorkerForTask("task-2", "test cleanup")).resolves.toBe(true);
    expect(getActiveSpawnedWorkerCount("codex-cli")).toBe(0);
  });
});

test("spawnCodeWorker falls through to fresh spawn when reuse fails", async () => {
  await withTempWorkspace(async (workspaceDir, dbPath) => {
    const order: string[] = [];
    let nextTaskId = 1;
    const tasks = new Map<string, SwarmTask>();
    const makeFreshTask = () => {
      const id = `task-${nextTaskId++}`;
      const t = makeTask(id, workspaceDir);
      tasks.set(id, t);
      return t;
    };

    const spawnedFirst = makeSpawnedPeer("worker-stale", workspaceDir, order);
    const spawnedSecond = makeSpawnedPeer("worker-fresh", workspaceDir, order);
    const spawnedQueue: SpawnedPeer[] = [spawnedFirst, spawnedSecond];
    let spawnPeerCalls = 0;

    const peer = {
      instanceId: "clanky-orchestrator",
      requestTask: async () => makeFreshTask(),
      getTask: async (taskId: string) => tasks.get(taskId) ?? null,
      assignTask: async (taskId: string, assignee: string) => {
        const t = tasks.get(taskId);
        if (!t) throw new Error(`unknown task ${taskId}`);
        t.assignee = assignee;
        t.status = "claimed";
        return t;
      },
      sendMessage: async () => {
        throw new Error("Instance worker-stale is not active in this scope.");
      },
      kvSet: async (key: string, value: string) => ({
        scope: workspaceDir,
        key,
        value,
        updatedAt: Date.now()
      }),
      updateTask: async (taskId: string, opts: UpdateTaskOpts) => {
        const t = tasks.get(taskId);
        if (!t) throw new Error(`unknown task ${taskId}`);
        t.status = opts.status;
        t.result = opts.result ?? null;
        return t;
      }
    };

    const settings = makeSettings(workspaceDir, dbPath);
    const baseArgs = {
      settings,
      role: "implementation" as const,
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1"
    };
    const deps = {
      store: {
        countActionsSince: () => 0,
        logAction: () => {}
      },
      peerManager: { ensurePeer: () => peer } as never,
      reservationKeeper: {} as never,
      spawnPeer: async (_opts: SpawnPeerOptions) => {
        spawnPeerCalls += 1;
        const next = spawnedQueue.shift();
        if (!next) throw new Error("no more spawned peers queued");
        return next;
      }
    };

    await spawnCodeWorker({ ...baseArgs, task: "First task" }, deps);
    tasks.get("task-1")!.status = "done";

    const second = await spawnCodeWorker({ ...baseArgs, task: "Follow-up after stale" }, deps);

    expect(spawnPeerCalls).toBe(2);
    expect(second.workerId).toBe("worker-fresh");
    expect(second.taskId).toBe("task-3");

    await expect(cancelSpawnedWorkerForTask(second.taskId, "test cleanup")).resolves.toBe(true);
  });
});
