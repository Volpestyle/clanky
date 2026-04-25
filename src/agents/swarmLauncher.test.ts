import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapSwarmTestSchema } from "./__fixtures__/swarmTestSchema.ts";
import { type CodeAgentSwarmRuntimeConfig } from "./codeAgentSwarm.ts";
import { spawnPeer, SwarmLauncherAdoptionTimeoutError } from "./swarmLauncher.ts";
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
  // resolveCodeAgentWorkspace calls `git rev-parse --show-toplevel`.
  // Make the workspace a real git repo so checkout resolution succeeds.
  spawnSync("git", ["init", "--quiet"], { cwd: workspaceDir });
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
    appendCoordinationPrompt: true
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
