import {
  isCodeAgentUserAllowed,
  normalizeCodeAgentRole,
  resolveCodeAgentConfig,
  resolveCodeAgentCwd,
  type CodeAgentRole
} from "../agents/codeAgentSettings.ts";
import {
  assertCodeAgentCwdAllowed,
  resolveGitHubRepoCwdForCodeTask
} from "../agents/codeAgentRepoResolver.ts";
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
  triggerMessageId?: string | null;
  githubUrl?: string | null;
  source?: string | null;
  existingTaskId?: string | null;
  signal?: AbortSignal;
};

export type SpawnCodeWorkerDeps = {
  store: SwarmLauncherStore & {
    countActionsSince?: (kind: string, sinceIso: string) => number;
  };
  peerManager: ClankySwarmPeerManager;
  reservationKeeper: SwarmReservationKeeper;
  spawnPeer?: typeof spawnPeer;
  /**
   * Optional activity bridge. When supplied, the spawned task is registered
   * so progress / terminal events route back to the originating Discord
   * surface across reply turns. The orchestrator sees swarm tools directly,
   * but the bridge is what fires async followups when a worker finishes
   * after the orchestrator's turn has ended.
   */
  activityBridge?: {
    watchControllerPeer?: (peer: ClankyPeer, context: { scope: string }) => void;
    trackTask: (peer: ClankyPeer, context: {
      taskId: string;
      workerId: string;
      scope: string;
      guildId: string | null;
      channelId: string | null;
      userId: string | null;
      triggerMessageId: string | null;
      source: string;
    }) => void;
  };
};

export type SpawnCodeWorkerResult = {
  workerId: string;
  taskId: string;
  scope: string;
  cwd: string;
  /**
   * KV key under which the live worker is recorded. Orchestrators use it on
   * later reply turns to drive `send_message` follow-ups against the same
   * worker if it's still in its post-task listen window. If the worker has
   * exited by then, the orchestrator should spawn fresh instead.
   */
  sessionKey: string | null;
  persistedSession: boolean;
};

type ActiveSpawnedWorker = {
  taskId: string;
  workerId: string;
  harness: SpawnCodeWorkerHarness;
  role: CodeAgentRole;
  scope: string;
  cwd: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  peer: ClankyPeer;
  spawned: SpawnedPeer;
  store: SwarmLauncherStore;
  // Flipped to `true` once the worker's currently-assigned task hits a
  // terminal status. Idle workers stay tracked (so a follow-up turn can
  // reuse them via `peer.sendMessage`) but do not count against the
  // `maxParallelTasks` cap.
  idle: boolean;
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

type CodeWorkerSessionRecord = {
  workerId: string;
  taskId: string;
  scope: string;
  role: CodeAgentRole;
  cwd: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  triggerMessageId: string | null;
  source: string;
  updatedAt: string;
};

const activeWorkersByTaskId = new Map<string, ActiveSpawnedWorker>();
const ACTIVE_WORKER_TASK_POLL_INTERVAL_MS = 1000;
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "cancelled"]);
const CODE_WORKER_SESSION_PREFIX = "clanky:code_worker_session";
export const CLANKY_CONTROLLER_KV_KEY = "clanky/controller";

function normalizeHarness(value: unknown): SpawnCodeWorkerHarness | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "claude-code") return "claude-code";
  if (normalized === "codex-cli") return "codex-cli";
  return null;
}

function sessionKeyToken(value: unknown, fallback: string): string {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+/g, "")
    .replace(/_+$/g, "");
  return sanitized || fallback;
}

export function buildCodeWorkerSessionKey(args: {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
}): string {
  const guild = sessionKeyToken(args.guildId, "dm");
  const channel = sessionKeyToken(args.channelId, "dm");
  const user = sessionKeyToken(args.userId, "anon");
  return `${CODE_WORKER_SESSION_PREFIX}:last:guild:${guild}:channel:${channel}:user:${user}`;
}

function buildCodeWorkerRoleSessionKey(args: {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  role: CodeAgentRole;
}): string {
  const guild = sessionKeyToken(args.guildId, "dm");
  const channel = sessionKeyToken(args.channelId, "dm");
  const user = sessionKeyToken(args.userId, "anon");
  const role = sessionKeyToken(args.role, "implementation");
  return `${CODE_WORKER_SESSION_PREFIX}:role:${role}:guild:${guild}:channel:${channel}:user:${user}`;
}

export function buildCodeWorkerWorkerSessionKey(workerId: string): string {
  return `${CODE_WORKER_SESSION_PREFIX}:worker:${sessionKeyToken(workerId, "unknown")}`;
}

async function publishControllerPeer(args: {
  peer: ClankyPeer;
  store: SwarmLauncherStore;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  source: string;
  scope: string;
}): Promise<void> {
  try {
    await args.peer.kvSet(CLANKY_CONTROLLER_KV_KEY, args.peer.instanceId);
  } catch (error) {
    args.store.logAction({
      kind: "code_agent_error",
      guildId: args.guildId,
      channelId: args.channelId,
      userId: args.userId,
      content: "clanky_controller_publish_failed",
      metadata: {
        source: args.source,
        scope: args.scope,
        error: String((error as Error)?.message || error)
      }
    });
  }
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

function busyWorkerCount(harness: SpawnCodeWorkerHarness) {
  let count = 0;
  for (const worker of activeWorkersByTaskId.values()) {
    if (worker.harness === harness && !worker.idle) count++;
  }
  return count;
}

async function refreshTerminalWorkerStates(harness?: SpawnCodeWorkerHarness): Promise<void> {
  const checks: Promise<void>[] = [];
  for (const worker of activeWorkersByTaskId.values()) {
    if (harness && worker.harness !== harness) continue;
    if (worker.idle) continue;
    if (typeof worker.peer.getTask !== "function") continue;
    checks.push((async () => {
      try {
        const task = await worker.peer.getTask(worker.taskId);
        if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
          worker.idle = true;
        }
      } catch {
        // Keep the process-exit watcher as the fallback cleanup path.
      }
    })());
  }
  await Promise.all(checks);
}

function findReusableIdleWorker(args: {
  harness: SpawnCodeWorkerHarness;
  role: CodeAgentRole;
  scope: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
}): ActiveSpawnedWorker | null {
  for (const worker of activeWorkersByTaskId.values()) {
    if (!worker.idle) continue;
    if (worker.harness !== args.harness) continue;
    if (worker.role !== args.role) continue;
    if (worker.scope !== args.scope) continue;
    if (worker.guildId !== args.guildId) continue;
    if (worker.channelId !== args.channelId) continue;
    if (worker.userId !== args.userId) continue;
    return worker;
  }
  return null;
}

function rekeyActiveWorker(worker: ActiveSpawnedWorker, oldTaskId: string, newTaskId: string) {
  if (activeWorkersByTaskId.get(oldTaskId) === worker) {
    activeWorkersByTaskId.delete(oldTaskId);
  }
  worker.taskId = newTaskId;
  worker.idle = false;
  activeWorkersByTaskId.set(newTaskId, worker);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
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
  assertCodeAgentCwdAllowed(settings, workspace.canonicalCwd);
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
  void worker.spawned.exited.then(async (info) => {
    const taskId = worker.taskId;
    if (activeWorkersByTaskId.get(taskId) !== worker) return;
    try {
      const task = await worker.peer.getTask(taskId);
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return;
      await markRequestedTaskFailed(worker.peer, taskId, formatWorkerExitResult(info));
    } catch (error) {
      worker.store.logAction({
        kind: "code_agent_error",
        guildId: worker.guildId,
        channelId: worker.channelId,
        userId: worker.userId,
        content: "code_worker_exit_task_failure_update_failed",
        metadata: {
          taskId,
          instanceId: worker.workerId,
          scope: worker.scope,
          error: String((error as Error)?.message || error)
        }
      });
    }
  }).finally(() => {
    if (activeWorkersByTaskId.get(worker.taskId) === worker) {
      activeWorkersByTaskId.delete(worker.taskId);
    }
  });
  void untrackWhenTaskTerminal(worker);
}

async function untrackWhenTaskTerminal(worker: ActiveSpawnedWorker): Promise<void> {
  if (typeof worker.peer.getTask !== "function") return;
  while (activeWorkersByTaskId.get(worker.taskId) === worker) {
    if (worker.idle) return;
    try {
      const task = await worker.peer.getTask(worker.taskId);
      if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
        worker.idle = true;
        return;
      }
    } catch {
      // Keep the process-exit watcher as the fallback cleanup path.
    }
    await sleep(ACTIVE_WORKER_TASK_POLL_INTERVAL_MS);
  }
}

function isAlreadyTerminalTaskError(error: unknown): boolean {
  const message = String((error as Error)?.message || error);
  return /\bis already (done|failed|cancelled)\b/i.test(message);
}

async function markWorkerTaskCancelled(worker: ActiveSpawnedWorker, reason: string): Promise<void> {
  try {
    await worker.peer.updateTask(worker.taskId, {
      status: "cancelled",
      result: reason
    });
  } catch (error) {
    if (!isAlreadyTerminalTaskError(error)) throw error;
  }
}

async function markNewWorkerTaskLaunchFailed(args: {
  peer: ClankyPeer;
  taskId: string;
  error: unknown;
}): Promise<void> {
  const message = String((args.error as Error)?.message || args.error || "unknown error").trim();
  await markRequestedTaskFailed(
    args.peer,
    args.taskId,
    `spawn_code_worker failed before worker assignment: ${message || "unknown error"}`
  );
}

async function markRequestedTaskFailed(peer: ClankyPeer, taskId: string, result: string): Promise<void> {
  if (typeof peer.failRequestedTask === "function") {
    await peer.failRequestedTask(taskId, result);
    return;
  }
  await peer.updateTask(taskId, {
    status: "failed",
    result
  });
}

function formatWorkerExitResult(info: { code: number | null; signal: NodeJS.Signals | null }): string {
  const code = info.code === null || info.code === undefined ? "null" : String(info.code);
  const signal = info.signal ? String(info.signal) : "null";
  return `Code worker exited before completing the task (code=${code}, signal=${signal}).`;
}

async function resolveExistingOpenTask(peer: ClankyPeer, taskId: string): Promise<SwarmTask> {
  const task = await peer.getTask(taskId);
  if (!task) throw new Error(`Swarm task ${taskId} was not found.`);
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new Error(`Swarm task ${taskId} is already ${task.status}.`);
  }
  if (task.assignee) {
    throw new Error(`Swarm task ${taskId} is already assigned to ${task.assignee}.`);
  }
  if (task.status !== "open") {
    throw new Error(`Swarm task ${taskId} is ${task.status}; only open unassigned tasks can be auto-spawned.`);
  }
  return task;
}

export async function cancelSpawnedWorkerForTask(taskId: string, reason = "Task cancelled"): Promise<boolean> {
  const worker = activeWorkersByTaskId.get(String(taskId || "").trim());
  if (!worker) return false;

  const normalizedReason = String(reason || "").trim() || "Task cancelled";
  let taskUpdateError: unknown = null;
  try {
    await markWorkerTaskCancelled(worker, normalizedReason);
  } catch (error) {
    taskUpdateError = error;
  }

  try {
    await worker.spawned.cancel(normalizedReason);
  } finally {
    if (activeWorkersByTaskId.get(worker.taskId) === worker) {
      activeWorkersByTaskId.delete(worker.taskId);
    }
  }
  if (taskUpdateError) throw taskUpdateError;
  return true;
}

export function getActiveSpawnedWorkerCount(harness?: SpawnCodeWorkerHarness): number {
  if (!harness) return activeWorkersByTaskId.size;
  return activeWorkerCount(harness);
}

async function reuseIdleWorkerForTask(input: {
  worker: ActiveSpawnedWorker;
  task: string;
  launch: PreparedWorkerLaunch;
  existingTaskId: string;
  source: string;
  args: SpawnCodeWorkerArgs;
  deps: SpawnCodeWorkerDeps;
}): Promise<SpawnCodeWorkerResult> {
  const { worker, task, launch, existingTaskId, source, args, deps } = input;
  const oldTaskId = worker.taskId;
  const peer = worker.peer;

  const swarmTask: SwarmTask = existingTaskId
    ? await resolveExistingOpenTask(peer, existingTaskId)
    : await peer.requestTask({
      type: launch.taskType,
      title: truncateSummary(task, 80) || "Code task",
      description: task,
      files: [],
      priority: 0
    });

  try {
    await peer.assignTask(swarmTask.id, worker.workerId);
    const followupMessage =
      `Follow-up task assigned: \`${swarmTask.id}\`. Treat this message as a new task instruction per your preamble — claim the task, execute it, then \`update_task(done)\` + \`annotate(kind="usage")\` and return to listening.\n\nTask:\n${task}`;
    await peer.sendMessage(worker.workerId, followupMessage);
  } catch (error) {
    if (!existingTaskId) {
      await markNewWorkerTaskLaunchFailed({
        peer,
        taskId: swarmTask.id,
        error
      }).catch((cleanupError) => {
        deps.store.logAction({
          kind: "code_agent_error",
          guildId: args.guildId || null,
          channelId: args.channelId || null,
          userId: args.userId || null,
          content: "code_worker_task_cleanup_failed",
          metadata: {
            source,
            taskId: swarmTask.id,
            error: String((cleanupError as Error)?.message || cleanupError)
          }
        });
      });
    }
    throw error;
  }

  rekeyActiveWorker(worker, oldTaskId, swarmTask.id);
  void untrackWhenTaskTerminal(worker);

  const sessionKey = buildCodeWorkerSessionKey({
    guildId: args.guildId,
    channelId: args.channelId,
    userId: args.userId
  });
  let persistedSession = false;
  const record: CodeWorkerSessionRecord = {
    workerId: worker.workerId,
    taskId: swarmTask.id,
    scope: launch.scope,
    role: launch.role,
    cwd: launch.cwd,
    guildId: args.guildId || null,
    channelId: args.channelId || null,
    userId: args.userId || null,
    triggerMessageId: args.triggerMessageId || null,
    source,
    updatedAt: new Date().toISOString()
  };
  try {
    await peer.kvSet(sessionKey, JSON.stringify(record));
    await peer.kvSet(buildCodeWorkerWorkerSessionKey(worker.workerId), JSON.stringify(record));
    await peer.kvSet(buildCodeWorkerRoleSessionKey({
      guildId: args.guildId,
      channelId: args.channelId,
      userId: args.userId,
      role: launch.role
    }), JSON.stringify(record));
    persistedSession = true;
  } catch (error) {
    deps.store.logAction({
      kind: "code_agent_error",
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      content: "code_worker_session_persist_failed",
      metadata: {
        source,
        taskId: swarmTask.id,
        instanceId: worker.workerId,
        sessionKey,
        workerSessionKey: buildCodeWorkerWorkerSessionKey(worker.workerId),
        error: String((error as Error)?.message || error)
      }
    });
  }

  if (deps.activityBridge) {
    deps.activityBridge.watchControllerPeer?.(peer, { scope: launch.scope });
    deps.activityBridge.trackTask(peer, {
      taskId: swarmTask.id,
      workerId: worker.workerId,
      scope: launch.scope,
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      triggerMessageId: args.triggerMessageId || null,
      source
    });
  }

  deps.store.logAction({
    kind: "code_agent_call",
    guildId: args.guildId || null,
    channelId: args.channelId || null,
    userId: args.userId || null,
    content: truncateSummary(task, 200),
    metadata: {
      source,
      role: launch.role,
      provider: launch.harness,
      model: launch.model,
      taskId: swarmTask.id,
      existingTaskId: existingTaskId || null,
      instanceId: worker.workerId,
      sessionKey,
      persistedSession,
      executionMode: "swarm_launcher_reuse"
    }
  });

  return {
    workerId: worker.workerId,
    taskId: swarmTask.id,
    scope: launch.scope,
    cwd: launch.cwd,
    sessionKey,
    persistedSession
  };
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
  const repoResolution = args.cwd
    ? null
    : resolveGitHubRepoCwdForCodeTask({
      settings: args.settings,
      task,
      githubUrl: args.githubUrl
    });
  const launch = selectedHarnessConfig(args.settings, args.cwd || repoResolution?.cwd, role, harnessOverride);

  await refreshTerminalWorkerStates(launch.harness);
  const reusableWorker = findReusableIdleWorker({
    harness: launch.harness,
    role,
    scope: launch.scope,
    guildId: args.guildId || null,
    channelId: args.channelId || null,
    userId: args.userId || null
  });
  if (!reusableWorker && busyWorkerCount(launch.harness) >= launch.maxParallelTasks) {
    throw new Error("Too many code workers are already running.");
  }
  const used = deps.store.countActionsSince?.("code_agent_call", budgetWindowStart()) ?? 0;
  if (used >= launch.maxTasksPerHour) {
    throw new Error("Code-worker spawning is currently blocked by rate limits.");
  }

  const peer = deps.peerManager.ensurePeer(launch.scope, launch.repoRoot, launch.fileRoot);
  const source = args.source || "reply_tool_spawn_code_worker";
  await publishControllerPeer({
    peer,
    store: deps.store,
    guildId: args.guildId || null,
    channelId: args.channelId || null,
    userId: args.userId || null,
    source,
    scope: launch.scope
  });
  const existingTaskId = String(args.existingTaskId || "").trim();

  if (reusableWorker) {
    try {
      return await reuseIdleWorkerForTask({
        worker: reusableWorker,
        task,
        launch,
        existingTaskId,
        source,
        args,
        deps
      });
    } catch (error) {
      deps.store.logAction({
        kind: "code_agent_error",
        guildId: args.guildId || null,
        channelId: args.channelId || null,
        userId: args.userId || null,
        content: "code_worker_reuse_failed",
        metadata: {
          source,
          workerId: reusableWorker.workerId,
          taskId: reusableWorker.taskId,
          error: String((error as Error)?.message || error)
        }
      });
      // The idle peer is no longer reachable (process gone, instance dropped
      // from the swarm registry, etc.). Drop it from tracking and fall
      // through to a fresh spawn.
      if (activeWorkersByTaskId.get(reusableWorker.taskId) === reusableWorker) {
        activeWorkersByTaskId.delete(reusableWorker.taskId);
      }
      if (busyWorkerCount(launch.harness) >= launch.maxParallelTasks) {
        throw new Error("Too many code workers are already running.");
      }
    }
  }
  const swarmTask: SwarmTask = existingTaskId
    ? await resolveExistingOpenTask(peer, existingTaskId)
    : await peer.requestTask({
      type: launch.taskType,
      title: truncateSummary(task, 80) || "Code task",
      description: task,
      files: [],
      priority: 0
    });

  let spawned: SpawnedPeer | null = null;
  try {
    spawned = await (deps.spawnPeer ?? spawnPeer)({
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
        source
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
      role,
      scope: launch.scope,
      cwd: launch.cwd,
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      peer,
      spawned,
      store: deps.store,
      idle: false
    });
    // Persist session keys unconditionally so the orchestrator can drive
    // follow-ups via send_message during the worker's post-task listen
    // window. If the worker has already exited by then, send_message will
    // surface an inactive-peer error and the orchestrator falls back to
    // spawning fresh.
    const sessionKey = buildCodeWorkerSessionKey({
      guildId: args.guildId,
      channelId: args.channelId,
      userId: args.userId
    });
    let persistedSession = false;
    const record: CodeWorkerSessionRecord = {
      workerId: spawned.instanceId,
      taskId: swarmTask.id,
      scope: launch.scope,
      role,
      cwd: launch.cwd,
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      triggerMessageId: args.triggerMessageId || null,
      source,
      updatedAt: new Date().toISOString()
    };
    try {
      await peer.kvSet(sessionKey, JSON.stringify(record));
      await peer.kvSet(buildCodeWorkerWorkerSessionKey(spawned.instanceId), JSON.stringify(record));
      await peer.kvSet(buildCodeWorkerRoleSessionKey({
        guildId: args.guildId,
        channelId: args.channelId,
        userId: args.userId,
        role
      }), JSON.stringify(record));
      persistedSession = true;
    } catch (error) {
      deps.store.logAction({
        kind: "code_agent_error",
        guildId: args.guildId || null,
        channelId: args.channelId || null,
        userId: args.userId || null,
        content: "code_worker_session_persist_failed",
        metadata: {
          source: args.source || "reply_tool_spawn_code_worker",
          taskId: swarmTask.id,
          instanceId: spawned.instanceId,
          sessionKey,
          workerSessionKey: buildCodeWorkerWorkerSessionKey(spawned.instanceId),
          error: String((error as Error)?.message || error)
        }
      });
    }
    if (deps.activityBridge) {
      deps.activityBridge.watchControllerPeer?.(peer, {
        scope: launch.scope
      });
      deps.activityBridge.trackTask(peer, {
        taskId: swarmTask.id,
        workerId: spawned.instanceId,
        scope: launch.scope,
        guildId: args.guildId || null,
        channelId: args.channelId || null,
        userId: args.userId || null,
        triggerMessageId: args.triggerMessageId || null,
        source
      });
    }
    deps.store.logAction({
      kind: "code_agent_call",
      guildId: args.guildId || null,
      channelId: args.channelId || null,
      userId: args.userId || null,
      content: truncateSummary(task, 200),
      metadata: {
        source,
        role,
        provider: launch.harness,
        model: launch.model,
        taskId: swarmTask.id,
        existingTaskId: existingTaskId || null,
        githubRepo: repoResolution?.githubRepo || null,
        instanceId: spawned.instanceId,
        sessionKey,
        persistedSession,
        launchMode: spawned.launchMode,
        ptyId: spawned.ptyId ?? null,
        executionMode: "swarm_launcher"
      }
    });
    return {
      workerId: spawned.instanceId,
      taskId: swarmTask.id,
      scope: launch.scope,
      cwd: launch.cwd,
      sessionKey,
      persistedSession
    };
  } catch (error) {
    if (spawned) {
      await spawned.cancel("spawn_code_worker failed").catch(() => null);
    }
    if (!existingTaskId) {
      await markNewWorkerTaskLaunchFailed({
        peer,
        taskId: swarmTask.id,
        error
      }).catch((cleanupError) => {
        deps.store.logAction({
          kind: "code_agent_error",
          guildId: args.guildId || null,
          channelId: args.channelId || null,
          userId: args.userId || null,
          content: "code_worker_task_cleanup_failed",
          metadata: {
            source,
            taskId: swarmTask.id,
            error: String((cleanupError as Error)?.message || cleanupError)
          }
        });
      });
    }
    activeWorkersByTaskId.delete(swarmTask.id);
    throw error;
  }
}
