import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapSwarmTestSchema } from "./__fixtures__/swarmTestSchema.ts";
import { type CodeAgentSwarmRuntimeConfig } from "./codeAgentSwarm.ts";
import {
  buildClaudeMcpConfigJson,
  buildCodexConfigOverrides,
  clankySwarmIsAvailable,
  loadProjectMcpServers,
  loadRoleCoordinationSkill,
  resolveSwarmArgs,
  spawnPeer,
  SwarmLauncherAdoptionTimeoutError
} from "./swarmLauncher.ts";
import { SwarmReservationKeeper } from "./swarmReservationKeeper.ts";

const FAKE_WORKER = path.resolve(__dirname, "__fixtures__/fakeSwarmWorker.ts");

let tempDir: string;
let dbPath: string;
let workspaceDir: string;
let keeper: SwarmReservationKeeper | null;
let logEntries: Record<string, unknown>[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "clanky-launcher-"));
  dbPath = path.join(tempDir, "swarm.db");
  workspaceDir = path.join(tempDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  bootstrapSwarmTestSchema(dbPath);
  keeper = new SwarmReservationKeeper({ dbPath, heartbeatIntervalMs: 60_000 });
  logEntries = [];
});

afterEach(() => {
  keeper?.shutdown();
  keeper = null;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSwarmConfig(): CodeAgentSwarmRuntimeConfig {
  return {
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "/path/to/swarm-mcp/src/index.ts"],
    dbPath,
    appendCoordinationPrompt: true,
    allowDirectChildFallback: true
  };
}

function makeStore() {
  return {
    logAction: (entry: Record<string, unknown>) => {
      logEntries.push(entry);
    }
  };
}

function makeFakeHarnessOverride(): { command: string; args: string[] } {
  return { command: "bun", args: ["run", FAKE_WORKER] };
}

function readInstance(id: string) {
  const verify = new Database(dbPath, { readonly: true });
  try {
    return verify
      .query("SELECT adopted, pid, label FROM instances WHERE id = ?")
      .get(id) as { adopted: number; pid: number; label: string | null } | null;
  } finally {
    verify.close();
  }
}

test("spawnPeer reserves, adopts, and exits cleanly with adopt_then_exit fixture", async () => {
  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "implement something",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm: makeSwarmConfig(),
    reservationKeeper: keeper!,
    harnessOverride: makeFakeHarnessOverride(),
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000
  });

  // The fake harness reads SWARM_MCP_INSTANCE_ID + writes adopted=1 directly.
  await spawned.adopted;
  const adoptedRow = readInstance(spawned.instanceId);
  expect(adoptedRow?.adopted).toBe(1);
  expect(adoptedRow?.label).toContain("provider:claude-code");
  expect(adoptedRow?.label).toContain("role:implementer");
  expect(adoptedRow?.label).toContain("thread:channel-1");
  expect(adoptedRow?.label).toContain("user:user-1");

  const exit = await spawned.exited;
  expect(exit.code).toBe(0);

  // Once adopted, the worker owns the row — release should be a no-op.
  expect(readInstance(spawned.instanceId)?.adopted).toBe(1);

  // Telemetry: we logged the worker exit.
  const exitLog = logEntries.find((entry) => entry.kind === "swarm_worker_exit");
  expect(exitLog).toBeDefined();
  expect((exitLog?.metadata as Record<string, unknown>)?.exitCode).toBe(0);
});

test("spawnPeer tees direct_child stdout to <dbDir>/worker-logs/<id>.log", async () => {
  const marker = "hello-from-worker-7c4e9";
  const previous = process.env.FAKE_WORKER_STDOUT_MARKER;
  process.env.FAKE_WORKER_STDOUT_MARKER = marker;
  try {
    const spawned = await spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "implement something",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-2", userId: "user-2", source: "test" },
      store: makeStore(),
      swarm: makeSwarmConfig(),
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      adoptionPollIntervalMs: 25,
      adoptionTimeoutMs: 5_000
    });

    await spawned.adopted;
    await spawned.exited;

    const expectedPath = path.join(path.dirname(dbPath), "worker-logs", `${spawned.instanceId}.log`);
    expect(spawned.logPath).toBe(expectedPath);

    const attachedLog = logEntries.find((entry) => entry.kind === "swarm_worker_log_attached");
    expect(attachedLog).toBeDefined();
    expect((attachedLog?.metadata as Record<string, unknown>)?.path).toBe(expectedPath);

    const contents = readFileSync(expectedPath, "utf8");
    expect(contents).toContain(marker);

    const exitLog = logEntries.find((entry) => entry.kind === "swarm_worker_exit");
    expect((exitLog?.metadata as Record<string, unknown>)?.logPath).toBe(expectedPath);
  } finally {
    if (previous === undefined) {
      delete process.env.FAKE_WORKER_STDOUT_MARKER;
    } else {
      process.env.FAKE_WORKER_STDOUT_MARKER = previous;
    }
  }
});

test("spawnPeer routes through swarm-server PTY when direct spawn is supported", async () => {
  const requests: Record<string, unknown>[] = [];
  const instanceId = "server-instance-1";
  const ptyId = "pty-server-1";
  let ptyClosed = false;
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => true,
    spawnPty: async (body: Record<string, unknown>) => {
      requests.push(body);
      const db = new Database(dbPath);
      try {
        db.run(
          `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
          [instanceId, body.scope, body.cwd, workspaceDir, body.cwd, body.label]
        );
      } finally {
        db.close();
      }
      return {
        v: 1,
        pty: {
          id: ptyId,
          command: body.harness as string,
          cwd: body.cwd as string,
          started_at: Date.now(),
          exit_code: null,
          bound_instance_id: instanceId,
          cols: 120,
          rows: 40,
          lease: null
        }
      };
    },
    closePty: async () => {
      ptyClosed = true;
    },
    fetchState: async () => ({
      ptys: ptyClosed
        ? []
        : [{
          id: ptyId,
          command: "claude",
          cwd: workspaceDir,
          started_at: Date.now(),
          exit_code: null,
          bound_instance_id: instanceId,
          cols: 120,
          rows: 40,
          lease: null
        }]
    })
  };

  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "implement something",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm: makeSwarmConfig(),
    reservationKeeper: keeper!,
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000,
    swarmServerClient
  });

  await spawned.adopted;
  expect(spawned.launchMode).toBe("swarm_server_pty");
  expect(spawned.instanceId).toBe(instanceId);
  expect(spawned.ptyId).toBe(ptyId);
  expect(spawned.child).toBeUndefined();
  expect(readInstance(instanceId)?.adopted).toBe(1);

  const request = requests[0];
  expect(request?.harness).toBe("claude");
  expect(request?.args).toContain("--model");
  expect(request?.args).not.toContain("-p");
  expect(request?.args).not.toContain("--output-format");
  expect(String(request?.initial_input || "")).toContain("implement something");
  expect(String(request?.initial_input || "")).toContain("## Swarm coordination skill");
  expect(String(request?.initial_input || "")).toContain("\u001b[200~");
  expect((request?.env as Record<string, string>)?.SWARM_DB_PATH).toBe(dbPath);

  await spawned.cancel("test cancel");
  await spawned.exited;
  expect(ptyClosed).toBe(true);
});

test("spawnPeer honors appendCoordinationPrompt=false while keeping Clanky overlays", async () => {
  const requests: Record<string, unknown>[] = [];
  const instanceId = "server-instance-no-skill";
  const ptyId = "pty-no-skill";
  let ptyClosed = false;
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => true,
    spawnPty: async (body: Record<string, unknown>) => {
      requests.push(body);
      const db = new Database(dbPath);
      try {
        db.run(
          `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
          [instanceId, body.scope, body.cwd, workspaceDir, body.cwd, body.label]
        );
      } finally {
        db.close();
      }
      return {
        v: 1,
        pty: {
          id: ptyId,
          command: body.harness as string,
          cwd: body.cwd as string,
          started_at: Date.now(),
          exit_code: null,
          bound_instance_id: instanceId,
          cols: 120,
          rows: 40,
          lease: null
        }
      };
    },
    closePty: async () => {
      ptyClosed = true;
    },
    fetchState: async () => ({
      ptys: ptyClosed
        ? []
        : [{
          id: ptyId,
          command: "claude",
          cwd: workspaceDir,
          started_at: Date.now(),
          exit_code: null,
          bound_instance_id: instanceId,
          cols: 120,
          rows: 40,
          lease: null
        }]
    })
  };

  const swarm = { ...makeSwarmConfig(), appendCoordinationPrompt: false };
  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "implement without generic skill",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm,
    reservationKeeper: keeper!,
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000,
    swarmServerClient
  });

  await spawned.adopted;
  const initialInput = String(requests[0]?.initial_input || "");
  expect(initialInput).toContain("Do not call `register`");
  expect(initialInput).toContain("implement without generic skill");
  expect(initialInput).not.toContain("## Swarm coordination skill");

  await spawned.cancel("test cancel");
  await spawned.exited;
});

test("spawnPeer falls back to direct child when enabled and swarm-server's supportsDirectHarnessSpawn returns false", async () => {
  const requests: Record<string, unknown>[] = [];
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => false,
    spawnPty: async (body: Record<string, unknown>) => {
      requests.push(body);
      throw new Error("should not be called when capability check fails");
    },
    closePty: async () => {},
    fetchState: async () => ({ ptys: [] })
  };

  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "fallback test",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm: makeSwarmConfig(),
    reservationKeeper: keeper!,
    harnessOverride: makeFakeHarnessOverride(),
    swarmServerClient,
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000
  });

  expect(spawned.launchMode).toBe("direct_child");
  expect(spawned.child).toBeDefined();
  expect(spawned.ptyId).toBeUndefined();
  expect(requests.length).toBe(0);
  await spawned.adopted;
  await spawned.exited;
});

test("spawnPeer rejects when swarm-server PTY is unsupported and direct child fallback is disabled", async () => {
  const requests: Record<string, unknown>[] = [];
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => false,
    spawnPty: async (body: Record<string, unknown>) => {
      requests.push(body);
      throw new Error("should not be called when capability check fails");
    },
    closePty: async () => {},
    fetchState: async () => ({ ptys: [] })
  };

  await expect(
    spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "fallback disabled test",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-1", userId: "user-1", source: "test" },
      store: makeStore(),
      swarm: { ...makeSwarmConfig(), allowDirectChildFallback: false },
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      swarmServerClient,
      adoptionPollIntervalMs: 25,
      adoptionTimeoutMs: 5_000
    })
  ).rejects.toThrow(/PTY launch is required/i);

  expect(requests.length).toBe(0);
});

test("spawnPeer falls back to direct child when enabled and swarm-server's spawnPty rejects", async () => {
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => true,
    spawnPty: async () => {
      throw new Error("simulated 500 from swarm-server /pty");
    },
    closePty: async () => {},
    fetchState: async () => ({ ptys: [] })
  };

  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "fallback test",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm: makeSwarmConfig(),
    reservationKeeper: keeper!,
    harnessOverride: makeFakeHarnessOverride(),
    swarmServerClient,
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000
  });

  expect(spawned.launchMode).toBe("direct_child");
  await spawned.adopted;
  await spawned.exited;

  const fallbackLog = logEntries.find((entry) => entry.kind === "swarm_server_spawn_fallback");
  expect(fallbackLog).toBeDefined();
  expect(String((fallbackLog?.metadata as Record<string, unknown>)?.reason || "")).toMatch(/simulated 500/);
});

test("spawnPeer rejects when swarm-server spawnPty rejects and direct child fallback is disabled", async () => {
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    supportsDirectHarnessSpawn: async () => true,
    spawnPty: async () => {
      throw new Error("simulated 500 from swarm-server /pty");
    },
    closePty: async () => {},
    fetchState: async () => ({ ptys: [] })
  };

  await expect(
    spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "fallback disabled test",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-1", userId: "user-1", source: "test" },
      store: makeStore(),
      swarm: { ...makeSwarmConfig(), allowDirectChildFallback: false },
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      swarmServerClient,
      adoptionPollIntervalMs: 25,
      adoptionTimeoutMs: 5_000
    })
  ).rejects.toThrow(/swarm-server PTY spawn failed: simulated 500/i);

  const failureLog = logEntries.find((entry) => entry.kind === "swarm_server_spawn_failed");
  expect(failureLog).toBeDefined();
});

test("spawnPeer falls back to direct child when enabled and swarm-server health probe times out", async () => {
  const swarmServerClient = {
    socketPath: "/tmp/fake-swarm-server.sock",
    // Mimics the real client's behavior when /health hangs: returns false
    // after its own internal timeout. From the launcher's perspective this
    // is indistinguishable from "capabilities don't include args/env."
    supportsDirectHarnessSpawn: async () => false,
    spawnPty: async () => {
      throw new Error("should not be called when health probe times out");
    },
    closePty: async () => {},
    fetchState: async () => ({ ptys: [] })
  };

  const spawned = await spawnPeer({
    harness: "claude-code",
    cwd: workspaceDir,
    role: "implementer",
    initialPrompt: "fallback test",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    model: "sonnet",
    trace: { channelId: "channel-1", userId: "user-1", source: "test" },
    store: makeStore(),
    swarm: makeSwarmConfig(),
    reservationKeeper: keeper!,
    harnessOverride: makeFakeHarnessOverride(),
    swarmServerClient,
    adoptionPollIntervalMs: 25,
    adoptionTimeoutMs: 5_000
  });

  expect(spawned.launchMode).toBe("direct_child");
  await spawned.adopted;
  await spawned.exited;
});

test("spawnPeer surfaces adoption timeout when worker explicitly never adopts", async () => {
  const previousBehavior = process.env.FAKE_WORKER_BEHAVIOR;
  const previousHang = process.env.FAKE_WORKER_HANG_MS;
  process.env.FAKE_WORKER_BEHAVIOR = "never_adopt";
  process.env.FAKE_WORKER_HANG_MS = "1500";
  try {
    let caught: unknown = null;
    let spawned;
    try {
      spawned = await spawnPeer({
        harness: "claude-code",
        cwd: workspaceDir,
        role: "implementer",
        initialPrompt: "p",
        maxTurns: 5,
        timeoutMs: 30_000,
        maxBufferBytes: 1024 * 1024,
        model: "sonnet",
        trace: { channelId: "channel-1", userId: "user-1", source: "test" },
        store: makeStore(),
        swarm: makeSwarmConfig(),
        reservationKeeper: keeper!,
        harnessOverride: makeFakeHarnessOverride(),
        adoptionPollIntervalMs: 25,
        adoptionTimeoutMs: 500
      });
      try {
        await spawned.adopted;
      } catch (err) {
        caught = err;
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SwarmLauncherAdoptionTimeoutError);
    expect((caught as SwarmLauncherAdoptionTimeoutError).timeoutMs).toBe(500);

    // Reservation is cleaned up after a timeout cancel.
    if (spawned) {
      await spawned.exited;
      const remaining = readInstance(spawned.instanceId);
      expect(remaining).toBeNull();
    }

    const adoptionLog = logEntries.find(
      (entry) => entry.kind === "swarm_worker_adoption_timeout"
    );
    expect(adoptionLog).toBeDefined();
  } finally {
    if (previousBehavior === undefined) delete process.env.FAKE_WORKER_BEHAVIOR;
    else process.env.FAKE_WORKER_BEHAVIOR = previousBehavior;
    if (previousHang === undefined) delete process.env.FAKE_WORKER_HANG_MS;
    else process.env.FAKE_WORKER_HANG_MS = previousHang;
  }
}, 10_000);

test("spawnPeer.cancel kills a running worker and releases its workspace", async () => {
  const previousBehavior = process.env.FAKE_WORKER_BEHAVIOR;
  const previousHang = process.env.FAKE_WORKER_HANG_MS;
  process.env.FAKE_WORKER_BEHAVIOR = "hang";
  process.env.FAKE_WORKER_HANG_MS = "10000";
  try {
    const spawned = await spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "p",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-1", userId: "user-1", source: "test" },
      store: makeStore(),
      swarm: makeSwarmConfig(),
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      adoptionPollIntervalMs: 25,
      adoptionTimeoutMs: 5_000
    });

    await spawned.adopted;

    await spawned.cancel("test cancel");
    const exit = await spawned.exited;
    expect(exit.code === null || exit.code !== 0 || exit.signal !== null).toBe(true);

    // Adopted rows are not removed by release(); the worker's lifecycle owns them.
    expect(readInstance(spawned.instanceId)?.adopted).toBe(1);
  } finally {
    if (previousBehavior === undefined) delete process.env.FAKE_WORKER_BEHAVIOR;
    else process.env.FAKE_WORKER_BEHAVIOR = previousBehavior;
    if (previousHang === undefined) delete process.env.FAKE_WORKER_HANG_MS;
    else process.env.FAKE_WORKER_HANG_MS = previousHang;
  }
}, 15_000);

test("spawnPeer enforces the configured worker timeout", async () => {
  const previousBehavior = process.env.FAKE_WORKER_BEHAVIOR;
  const previousHang = process.env.FAKE_WORKER_HANG_MS;
  process.env.FAKE_WORKER_BEHAVIOR = "hang";
  process.env.FAKE_WORKER_HANG_MS = "10000";
  try {
    const spawned = await spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "p",
      maxTurns: 5,
      timeoutMs: 100,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-1", userId: "user-1", source: "test" },
      store: makeStore(),
      swarm: makeSwarmConfig(),
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      adoptionPollIntervalMs: 25,
      adoptionTimeoutMs: 5_000
    });

    await spawned.adopted;
    const exit = await spawned.exited;
    expect(exit.code === null || exit.code !== 0 || exit.signal !== null).toBe(true);
  } finally {
    if (previousBehavior === undefined) delete process.env.FAKE_WORKER_BEHAVIOR;
    else process.env.FAKE_WORKER_BEHAVIOR = previousBehavior;
    if (previousHang === undefined) delete process.env.FAKE_WORKER_HANG_MS;
    else process.env.FAKE_WORKER_HANG_MS = previousHang;
  }
}, 5_000);

test("spawnPeer signal-aborted before launch tears down without leaking rows", async () => {
  const controller = new AbortController();
  controller.abort("test abort");

  await expect(
    spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "p",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: { channelId: "channel-1", userId: "user-1", source: "test" },
      store: makeStore(),
      swarm: makeSwarmConfig(),
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride(),
      signal: controller.signal
    })
  ).rejects.toThrow();

  // No rows were inserted because we bail before reservation.
  const verify = new Database(dbPath, { readonly: true });
  try {
    const count = (verify.query("SELECT COUNT(*) AS n FROM instances").get() as { n: number }).n;
    expect(count).toBe(0);
  } finally {
    verify.close();
  }
});

test("spawnPeer rejects when swarm runtime is disabled", async () => {
  await expect(
    spawnPeer({
      harness: "claude-code",
      cwd: workspaceDir,
      role: "implementer",
      initialPrompt: "p",
      maxTurns: 5,
      timeoutMs: 30_000,
      maxBufferBytes: 1024 * 1024,
      model: "sonnet",
      trace: {},
      store: makeStore(),
      swarm: { ...makeSwarmConfig(), enabled: false },
      reservationKeeper: keeper!,
      harnessOverride: makeFakeHarnessOverride()
    })
  ).rejects.toThrow(/swarm runtime/i);
});

test("resolveSwarmArgs anchors relative paths at clanky's repo root", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const resolved = resolveSwarmArgs(["run", "./mcp-servers/swarm-mcp/src/index.ts"]);
  expect(resolved[0]).toBe("run");
  expect(resolved[1]).toBe(path.resolve(repoRoot, "./mcp-servers/swarm-mcp/src/index.ts"));
  expect(path.isAbsolute(resolved[1])).toBe(true);
});

test("resolveSwarmArgs leaves absolute paths and bare tokens unchanged", () => {
  const absolute = path.join(path.sep, "tmp", "swarm-mcp", "index.ts");
  const resolved = resolveSwarmArgs(["run", absolute, "--flag"]);
  expect(resolved).toEqual(["run", absolute, "--flag"]);
});

test("buildCodexConfigOverrides pins swarm cwd and adoption env", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const swarm: CodeAgentSwarmRuntimeConfig = {
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "./mcp-servers/swarm-mcp/src/index.ts"],
    dbPath: "",
    appendCoordinationPrompt: true,
    allowDirectChildFallback: false
  };

  const overrides = buildCodexConfigOverrides(swarm, {
    SWARM_MCP_INSTANCE_ID: "worker-1",
    SWARM_MCP_SCOPE: "/tmp/scope",
    BAD_KEY: "",
    "bad-key": "ignored"
  });

  expect(overrides).toContain(
    `mcp_servers.swarm.cwd='${path.resolve(repoRoot, "mcp-servers/swarm-mcp")}'`
  );
  expect(overrides).toContain("mcp_servers.swarm.env.SWARM_MCP_INSTANCE_ID='worker-1'");
  expect(overrides).toContain("mcp_servers.swarm.env.SWARM_MCP_SCOPE='/tmp/scope'");
  expect(overrides.some((value) => value.includes("bad-key"))).toBe(false);
  expect(overrides.some((value) => value.includes("BAD_KEY"))).toBe(false);
});

test("loadProjectMcpServers returns mcpServers block from project .mcp.json", () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "clanky-project-"));
  try {
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "github-mcp", args: [] },
          sentry: { type: "stdio", command: "sentry-mcp", args: ["--workspace", "x"] }
        }
      })
    );
    const servers = loadProjectMcpServers(projectDir);
    expect(Object.keys(servers).sort()).toEqual(["github", "sentry"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("loadProjectMcpServers returns empty when .mcp.json is absent or malformed", () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "clanky-project-"));
  try {
    expect(loadProjectMcpServers(projectDir)).toEqual({});
    writeFileSync(path.join(projectDir, ".mcp.json"), "not json");
    expect(loadProjectMcpServers(projectDir)).toEqual({});
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("clankySwarmIsAvailable detects missing vendored swarm-mcp", () => {
  const missing: CodeAgentSwarmRuntimeConfig = {
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "./mcp-servers/swarm-mcp-does-not-exist/src/index.ts"],
    dbPath: "",
    appendCoordinationPrompt: true,
    allowDirectChildFallback: false
  };
  expect(clankySwarmIsAvailable(missing)).toBe(false);

  const onPath: CodeAgentSwarmRuntimeConfig = {
    enabled: true,
    serverName: "swarm",
    command: "swarm-mcp",
    args: [],
    dbPath: "",
    appendCoordinationPrompt: true,
    allowDirectChildFallback: false
  };
  // No path-like arg → trust the command resolves on PATH.
  expect(clankySwarmIsAvailable(onPath)).toBe(true);
});

test("buildClaudeMcpConfigJson merges project MCPs and lets clanky's swarm win when vendored", () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "clanky-project-"));
  try {
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "github-mcp", args: [] },
          swarm: { type: "stdio", command: "old-swarm", args: ["--legacy"] }
        }
      })
    );
    const swarm: CodeAgentSwarmRuntimeConfig = {
      enabled: true,
      serverName: "swarm",
      command: "swarm-mcp",
      args: [],
      dbPath: "",
      appendCoordinationPrompt: true,
      allowDirectChildFallback: false
    };
    const json = JSON.parse(buildClaudeMcpConfigJson(swarm, projectDir));
    expect(json.github.command).toBe("github-mcp");
    // Clanky's vendored swarm overrides the project's stale entry.
    expect(json.swarm.command).toBe("swarm-mcp");
    expect(json.swarm.args).toEqual([]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("buildClaudeMcpConfigJson falls back to project's swarm entry when clanky's vendor is missing", () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "clanky-project-"));
  try {
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          swarm: {
            type: "stdio",
            command: "node",
            args: ["/opt/project-swarm-mcp/dist/index.js"]
          }
        }
      })
    );
    const swarm: CodeAgentSwarmRuntimeConfig = {
      enabled: true,
      serverName: "swarm",
      command: "bun",
      args: ["run", "./mcp-servers/swarm-mcp-does-not-exist/src/index.ts"],
      dbPath: "",
      appendCoordinationPrompt: true,
      allowDirectChildFallback: false
    };
    const json = JSON.parse(buildClaudeMcpConfigJson(swarm, projectDir));
    // Project's swarm entry wins because clanky's vendored path is absent.
    expect(json.swarm.command).toBe("node");
    expect(json.swarm.args).toEqual(["/opt/project-swarm-mcp/dist/index.js"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("loadRoleCoordinationSkill concatenates SKILL.md entry and role reference", () => {
  for (const role of ["planner", "implementer", "reviewer", "researcher"] as const) {
    const skill = loadRoleCoordinationSkill(role);
    // SKILL.md frontmatter is always present.
    expect(skill).toMatch(/name:\s*swarm-mcp/);
    // The role-specific reference is appended under a header.
    expect(skill).toMatch(new RegExp(`# Role reference: ${role}`));
  }
});
