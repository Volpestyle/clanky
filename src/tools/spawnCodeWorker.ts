import {
  isCodeAgentUserAllowed,
  normalizeCodeAgentRole,
  resolveCodeAgentConfig,
  resolveCodeAgentCwd,
  type CodeAgentRole
} from "../agents/codeAgentSettings.ts";
import { resolveCodeAgentWorkspace } from "../agents/codeAgentWorkspace.ts";
import {
  spawnPeer,
  type SpawnedPeer,
  type SwarmLauncherStore,
  type SwarmPeerRole
} from "../agents/swarmLauncher.ts";
import { ClankySwarmPeerManager } from "../agents/swarmPeerManager.ts";
import type { ClankyPeer, SwarmTask } from "../agents/swarmPeer.ts";
import { SwarmReservationKeeper } from "../agents/swarmReservationKeeper.ts";
import { getDevTeamRuntimeConfig, isDevTaskEnabled } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";

export type SpawnCodeWorkerHarness = "claude-code" | "codex-cli";

export type SpawnCodeWorkerArgs = {
  settings: Record<string, unknown>;
  task: string;
  role?: CodeAgentRole | string;
  harness?: SpawnCodeWorkerHarness | string;
  cwd?: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  source?: string | null;
  signal?: AbortSignal;
};

export type SpawnCodeWorkerDeps = {
  store: SwarmLauncherStore & {
    countActionsSince?: (kind: string, sinceIso: string) => number;
  };
  peerManager: ClankySwarmPeerManager;
  reservationKeeper: SwarmReservationKeeper;
};

export type SpawnCodeWorkerResult = {
  workerId: string;
  taskId: string;
  scope: string;
};

type ActiveSpawnedWorker = {
  taskId: string;
  workerId: string;
  harness: SpawnCodeWorkerHarness;
  peer: ClankyPeer;
  spawned: SpawnedPeer;
};

type PreparedWorkerLaunch = {
  role: CodeAgentRole;
  taskType: string;
  cwd: string;
  harness: SpawnCodeWorkerHarness;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  maxTasksPerHour: number;
  maxParallelTasks: number;
  swarm: NonNullable<ReturnType<typeof resolveCodeAgentConfig>["swarm"]>;
  scope: string;
  repoRoot: string;
  fileRoot: string;
};

const activeWorkersByTaskId = new Map<string, ActiveSpawnedWorker>();

function normalizeHarness(value: unknown): SpawnCodeWorkerHarness | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "claude-code") return "claude-code";
  if (normalized === "codex-cli") return "codex-cli";
  return null;
}

function roleToSwarmPeerRole(role: CodeAgentRole): SwarmPeerRole {
  if (role === "design") return "planner";
  if (role === "review") return "reviewer";
  if (role === "research") return "researcher";
  return "implementer";
}

function roleToTaskType(role: CodeAgentRole) {
  if (role === "review") return "review";
  if (role === "research") return "research";
  return "implement";
}

function truncateSummary(value: unknown, maxChars = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function budgetWindowStart() {
  return new Date(Date.now() - 60 * 60_000).toISOString();
}

function activeWorkerCount(harness: SpawnCodeWorkerHarness) {
  let count = 0;
  for (const worker of activeWorkersByTaskId.values()) {
    if (worker.harness === harness) count++;
  }
  return count;
}

function selectedHarnessConfig(
  settings: Record<string, unknown>,
  cwdOverride: string | undefined,
  role: CodeAgentRole,
  harnessOverride: SpawnCodeWorkerHarness | null
): PreparedWorkerLaunch {
  const base = resolveCodeAgentConfig(settings, cwdOverride, role);
  const baseHarness = base.provider === "claude-code" ? "claude-code" : "codex-cli";
  const harness = harnessOverride ?? baseHarness;
  const runtime = getDevTeamRuntimeConfig(settings);
  const selectedConfig = harness === "claude-code" ? runtime.claudeCode : runtime.codexCli;

  if (!selectedConfig?.enabled) {
    throw new Error(`${harness} is not enabled for code workers.`);
  }
  if (!base.swarm?.enabled || !base.swarm.command) {
    throw new Error("spawn_code_worker requires an enabled swarm command.");
  }

  const cwd = harnessOverride
    ? resolveCodeAgentCwd(String(cwdOverride || selectedConfig.defaultCwd || ""), process.cwd())
    : base.cwd;
  const workspace = resolveCodeAgentWorkspace({ cwd });
  return {
    role,
    taskType: roleToTaskType(role),
    cwd,
    harness,
    model: harness === "claude-code"
      ? String(runtime.claudeCode?.model || "sonnet").trim() || "sonnet"
      : String(runtime.codexCli?.model || "gpt-5.4").trim() || "gpt-5.4",
    maxTurns: clamp(Number(selectedConfig.maxTurns) || 30, 1, 200),
    timeoutMs: clamp(Number(selectedConfig.timeoutMs) || 300_000, 10_000, 1_800_000),
    maxBufferBytes: clamp(Number(selectedConfig.maxBufferBytes) || 2 * 1024 * 1024, 4096, 10 * 1024 * 1024),
    maxTasksPerHour: clamp(Number(selectedConfig.maxTasksPerHour) || 10, 1, 500),
    maxParallelTasks: clamp(Number(selectedConfig.maxParallelTasks) || 2, 1, 32),
    swarm: base.swarm,
    scope: workspace.repoRoot,
    repoRoot: workspace.repoRoot,
    fileRoot: workspace.canonicalCwd
  };
}

function trackActiveWorker(worker: ActiveSpawnedWorker) {
  activeWorkersByTaskId.set(worker.taskId, worker);
  void worker.spawned.exited.finally(() => {
    activeWorkersByTaskId.delete(worker.taskId);
  });
}

export async function cancelSpawnedWorkerForTask(taskId: string, reason = "Task cancelled"): Promise<boolean> {
  const worker = activeWorkersByTaskId.get(String(taskId || "").trim());
  if (!worker) return false;
  await worker.spawned.cancel(reason);
  activeWorkersByTaskId.delete(worker.taskId);
  return true;
}

export function getActiveSpawnedWorkerCount(harness?: SpawnCodeWorkerHarness): number {
  if (!harness) return activeWorkersByTaskId.size;
  return activeWorkerCount(harness);
}

export async function spawnCodeWorker(
  args: SpawnCodeWorkerArgs,
  deps: SpawnCodeWorkerDeps
): Promise<SpawnCodeWorkerResult> {
  const task = String(args.task || "").trim();
  if (!task) throw new Error("spawn_code_worker requires a non-empty task.");
  if (!isDevTaskEnabled(args.settings)) {
    throw new Error("Code-worker spawning is disabled.");
  }
  if (args.userId && !isCodeAgentUserAllowed(args.userId, args.settings)) {
    throw new Error("This capability is restricted to allowed users.");
  }

  const role = normalizeCodeAgentRole(args.role, "implementation");
  const harnessOverride = args.harness ? normalizeHarness(args.harness) : null;
  if (args.harness && !harnessOverride) {
    throw new Error("Invalid harness. Expected claude-code or codex-cli.");
  }
  const launch = selectedHarnessConfig(args.settings, args.cwd, role, harnessOverride);

  if (activeWorkerCount(launch.harness) >= launch.maxParallelTasks) {
    throw new Error("Too many code workers are already running.");
  }
  const used = deps.store.countActionsSince?.("code_agent_call", budgetWindowStart()) ?? 0;
  if (used >= launch.maxTasksPerHour) {
    throw new Error("Code-worker spawning is currently blocked by rate limits.");
  }

  const peer = deps.peerManager.ensurePeer(launch.scope, launch.repoRoot, launch.fileRoot);
  const swarmTask: SwarmTask = await peer.requestTask({
    type: launch.taskType,
    title: truncateSummary(task, 80) || "Code task",
    description: task,
    files: [],
    priority: 0
  });

  let spawned: SpawnedPeer | null = null;
  try {
    spawned = await spawnPeer({
      harness: launch.harness,
      cwd: launch.cwd,
      role: roleToSwarmPeerRole(role),
      initialPrompt: task,
      taskId: swarmTask.id,
      labelExtras: {
        thread: args.channelId,
        user: args.userId
      },
      scope: launch.scope,
      maxTurns: launch.maxTurns,
      timeoutMs: launch.timeoutMs,
      maxBufferBytes: launch.maxBufferBytes,
      model: launch.model,
      trace: {
        guildId: args.guildId,
        channelId: args.channelId,
        userId: args.userId,
        source: args.source || "reply_tool_spawn_code_worker"
      },
      store: deps.store,
      swarm: launch.swarm,
      reservationKeeper: deps.reservationKeeper,
      signal: args.signal
    });
    await spawned.adopted;
    await peer.assignTask(swarmTask.id, spawned.instanceId);
    trackActiveWorker({
      taskId: swarmTask.id,
      workerId: spawned.instanceId,
      harness: launch.harness,
      peer,
      spawned
    });
    deps.store.logAction({
      kind: "code_agent_call",
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      content: truncateSummary(task, 200),
      metadata: {
        source: args.source || "reply_tool_spawn_code_worker",
        role,
        provider: launch.harness,
        model: launch.model,
        taskId: swarmTask.id,
        instanceId: spawned.instanceId,
        executionMode: "swarm_launcher"
      }
    });
    return {
      workerId: spawned.instanceId,
      taskId: swarmTask.id,
      scope: launch.scope
    };
  } catch (error) {
    if (spawned) {
      await spawned.cancel("spawn_code_worker failed").catch(() => null);
    }
    throw error;
  }
}
