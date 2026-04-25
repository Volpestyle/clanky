import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  buildSwarmLabel,
  buildSwarmLauncherFirstTurnPreamble,
  applyCodeAgentFirstTurnPreamble,
  type CodeAgentSwarmRuntimeConfig
} from "./codeAgentSwarm.ts";
import {
  provisionCodeAgentWorkspace,
  type CodeAgentWorkspaceLease
} from "./codeAgentWorkspace.ts";
import { resolveSwarmDbPath } from "./swarmDbConnection.ts";
import { type SwarmReservationKeeper } from "./swarmReservationKeeper.ts";
import { isAdopted } from "./swarmDb.ts";

/** Roles emitted in the swarm label and used by the worker preamble. */
export type SwarmPeerRole = "planner" | "implementer" | "reviewer" | "researcher";

export type SwarmLauncherTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

export type SwarmLauncherStore = {
  logAction: (entry: Record<string, unknown>) => void;
};

export type SpawnPeerOptions = {
  harness: "claude-code" | "codex-cli";
  cwd: string;
  role: SwarmPeerRole;
  initialPrompt: string;
  /** Optional task id reserved upstream — embedded in the preamble. */
  taskId?: string | null;
  labelExtras?: { thread?: string | null; user?: string | null };
  /** Override the swarm-mcp scope (defaults to repoRoot). */
  scope?: string;
  /** Resource caps from devTeam.{harness}.* settings. */
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  /** Model hint passed to the harness (claude/codex). */
  model: string;
  /** Telemetry context propagated into store.logAction. */
  trace: SwarmLauncherTrace;
  store: SwarmLauncherStore;
  /** swarm-mcp connect config — drives MCP server invocation by the worker. */
  swarm: CodeAgentSwarmRuntimeConfig;
  /** Owns reservation lifecycle. */
  reservationKeeper: SwarmReservationKeeper;
  /** Adoption polling cadence (ms). Defaults to 100ms. */
  adoptionPollIntervalMs?: number;
  /** Adoption deadline (ms). Defaults to 15s. */
  adoptionTimeoutMs?: number;
  /**
   * Override the actual command/args spawned. Used by tests (fake worker
   * fixture) and by operators who run claude/codex from a non-PATH location.
   * When set, replaces the harness-derived invocation entirely; the launcher
   * still injects the swarm env vars and sets cwd from the workspace.
   */
  harnessOverride?: { command: string; args?: string[] };
  /** Optional AbortSignal used to cancel the launch (kills the child + cleans reservation). */
  signal?: AbortSignal;
};

export type SpawnedPeer = {
  instanceId: string;
  scope: string;
  fileRoot: string;
  workspace: CodeAgentWorkspaceLease;
  child: ChildProcess;
  /** Resolves once swarm-mcp flips `adopted=1` on the reserved row. */
  adopted: Promise<void>;
  /** Resolves once the harness child exits, with its exit signature. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Last 2KB of merged stdout/stderr — telemetry only, not parsed for results. */
  outputTail: () => string;
  /** Convenience: kill the child and release the reservation if still unadopted. */
  cancel: (reason?: string) => Promise<void>;
};

export class SwarmLauncherAdoptionTimeoutError extends Error {
  readonly instanceId: string;
  readonly timeoutMs: number;
  readonly tail: string;
  constructor(message: string, instanceId: string, timeoutMs: number, tail: string) {
    super(message);
    this.name = "SwarmLauncherAdoptionTimeoutError";
    this.instanceId = instanceId;
    this.timeoutMs = timeoutMs;
    this.tail = tail;
  }
}

const DEFAULT_ADOPTION_POLL_INTERVAL_MS = 100;
const DEFAULT_ADOPTION_TIMEOUT_MS = 15_000;
const OUTPUT_TAIL_BYTES = 2048;

class RingBuffer {
  private chunks: Buffer[];
  private bytes: number;
  private readonly limit: number;
  constructor(limit: number) {
    this.chunks = [];
    this.bytes = 0;
    this.limit = limit;
  }
  push(chunk: Buffer | string) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.chunks.push(buf);
    this.bytes += buf.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const head = this.chunks.shift()!;
      this.bytes -= head.length;
    }
    if (this.chunks.length === 1 && this.bytes > this.limit) {
      const head = this.chunks[0];
      this.chunks[0] = head.subarray(head.length - this.limit);
      this.bytes = this.chunks[0].length;
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function buildHarnessInvocation({
  opts,
  prompt,
  mcpConfigJson,
  codexOverrides
}: {
  opts: SpawnPeerOptions;
  prompt: string;
  mcpConfigJson: string;
  codexOverrides: string[];
}): { command: string; args: string[] } {
  if (opts.harnessOverride?.command) {
    return {
      command: opts.harnessOverride.command,
      args: [...(opts.harnessOverride.args || [])]
    };
  }
  if (opts.harness === "claude-code") {
    const args = [
      "-p", prompt,
      "--model", String(opts.model || "sonnet"),
      "--max-turns", String(Math.max(1, Math.min(10000, Math.floor(opts.maxTurns)))),
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence"
    ];
    if (mcpConfigJson) {
      args.push("--strict-mcp-config", "--mcp-config", mcpConfigJson);
    }
    return { command: "claude", args };
  }
  const args = ["exec", "-m", String(opts.model || "gpt-5.4")];
  for (const override of codexOverrides) {
    args.push("-c", override);
  }
  args.push(prompt);
  return { command: "codex", args };
}

function buildClaudeMcpConfigJson(swarm: CodeAgentSwarmRuntimeConfig): string {
  if (!swarm?.command) return "";
  return JSON.stringify({
    [swarm.serverName]: {
      type: "stdio",
      command: swarm.command,
      args: swarm.args,
      env: swarm.dbPath ? { SWARM_DB_PATH: swarm.dbPath } : {}
    }
  });
}

function buildCodexConfigOverrides(swarm: CodeAgentSwarmRuntimeConfig): string[] {
  if (!swarm?.command) return [];
  const literalString = (value: string) => `'${String(value || "").replace(/'/g, "''")}'`;
  const literalArray = (values: string[]) =>
    `[${values.map((value) => literalString(value)).join(", ")}]`;
  return [
    `mcp_servers.${swarm.serverName}.command=${literalString(swarm.command)}`,
    `mcp_servers.${swarm.serverName}.args=${literalArray(swarm.args)}`
  ];
}

export async function spawnPeer(opts: SpawnPeerOptions): Promise<SpawnedPeer> {
  if (!opts.swarm?.enabled) {
    throw new Error("spawnPeer requires an enabled swarm runtime config.");
  }
  if (!opts.swarm.command && !opts.harnessOverride) {
    throw new Error(
      "spawnPeer requires agentStack.runtimeConfig.devTeam.swarm.command (or a harnessOverride for tests)."
    );
  }
  if (opts.signal?.aborted) {
    throw new Error(`spawnPeer aborted before launch: ${opts.signal.reason || "cancelled"}`);
  }

  const workspace = provisionCodeAgentWorkspace({
    cwd: opts.cwd,
    provider: opts.harness,
    scopeKey: `swarm:${opts.harness}:${opts.trace.channelId || "dm"}:${randomUUID().slice(0, 8)}`,
    mode: "shared_checkout"
  });

  const label = buildSwarmLabel({
    provider: opts.harness,
    role: opts.role,
    thread: opts.labelExtras?.thread ?? opts.trace.channelId ?? null,
    user: opts.labelExtras?.user ?? opts.trace.userId ?? null
  });

  let reserved;
  try {
    reserved = opts.reservationKeeper.reserve({
      directory: workspace.cwd,
      scope: opts.scope || workspace.repoRoot,
      fileRoot: workspace.canonicalCwd,
      label
    });
  } catch (error) {
    workspace.cleanup();
    throw error;
  }

  const dbPath = resolveSwarmDbPath(opts.swarm.dbPath || "");
  const childEnv: Record<string, string> = {
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: reserved.id,
    SWARM_MCP_DIRECTORY: workspace.cwd,
    SWARM_MCP_SCOPE: reserved.scope,
    SWARM_MCP_FILE_ROOT: workspace.canonicalCwd,
    SWARM_MCP_LABEL: label
  };

  const preamble = buildSwarmLauncherFirstTurnPreamble({
    serverName: opts.swarm.serverName,
    taskId: opts.taskId
  });
  const wrappedPrompt = applyCodeAgentFirstTurnPreamble(opts.initialPrompt, preamble);
  const mcpConfigJson = buildClaudeMcpConfigJson(opts.swarm);
  const codexOverrides = buildCodexConfigOverrides(opts.swarm);

  const { command, args } = buildHarnessInvocation({
    opts,
    prompt: wrappedPrompt,
    mcpConfigJson,
    codexOverrides
  });

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: workspace.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...childEnv }
    });
  } catch (error) {
    opts.reservationKeeper.release(reserved.id);
    workspace.cleanup();
    throw error;
  }

  const tail = new RingBuffer(OUTPUT_TAIL_BYTES);
  child.stdout?.on("data", (chunk) => tail.push(chunk));
  child.stderr?.on("data", (chunk) => tail.push(chunk));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let cancelled = false;
  let cancelReason: string = "";
  const cancel = async (reason?: string) => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = String(reason || "cancelled");
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1500))
      ]);
    } finally {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      // If the worker never adopted, drop the row; if it did adopt, the
      // reservation tracking is already off, so this is a cheap no-op.
      opts.reservationKeeper.release(reserved.id);
      workspace.cleanup();
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      await cancel(opts.signal.reason || "aborted");
      throw new Error(`spawnPeer aborted: ${cancelReason}`);
    }
    opts.signal.addEventListener(
      "abort",
      () => {
        void cancel(opts.signal?.reason || "aborted");
      },
      { once: true }
    );
  }

  const adopted = waitForAdoption({
    dbPath,
    instanceId: reserved.id,
    pollIntervalMs: opts.adoptionPollIntervalMs ?? DEFAULT_ADOPTION_POLL_INTERVAL_MS,
    timeoutMs: opts.adoptionTimeoutMs ?? DEFAULT_ADOPTION_TIMEOUT_MS,
    exited
  }).catch(async (error) => {
    if (error instanceof SwarmLauncherAdoptionTimeoutError) {
      try {
        opts.store.logAction({
          kind: "swarm_worker_adoption_timeout",
          guildId: opts.trace.guildId || null,
          channelId: opts.trace.channelId || null,
          userId: opts.trace.userId || null,
          metadata: {
            instanceId: reserved.id,
            harness: opts.harness,
            timeoutMs: error.timeoutMs,
            tail: tail.toString().slice(-512),
            source: opts.trace.source ?? null
          }
        });
      } catch {
        // ignore telemetry errors
      }
    }
    await cancel("adoption timeout");
    throw error;
  });

  // Telemetry on child exit so we can spot crashes-without-result distinct
  // from clean exits. Result/cost still come from worker self-report via
  // update_task; this is just process-level signal.
  exited.then((info) => {
    try {
      opts.store.logAction({
        kind: "swarm_worker_exit",
        guildId: opts.trace.guildId || null,
        channelId: opts.trace.channelId || null,
        userId: opts.trace.userId || null,
        metadata: {
          instanceId: reserved.id,
          harness: opts.harness,
          exitCode: info.code,
          exitSignal: info.signal,
          cancelled,
          cancelReason: cancelled ? cancelReason : null,
          tail: tail.toString().slice(-512),
          source: opts.trace.source ?? null
        }
      });
    } catch {
      // ignore telemetry errors
    }
  });

  return {
    instanceId: reserved.id,
    scope: reserved.scope,
    fileRoot: workspace.canonicalCwd,
    workspace,
    child,
    adopted,
    exited,
    outputTail: () => tail.toString(),
    cancel
  };
}

async function waitForAdoption({
  dbPath,
  instanceId,
  pollIntervalMs,
  timeoutMs,
  exited
}: {
  dbPath: string;
  instanceId: string;
  pollIntervalMs: number;
  timeoutMs: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}): Promise<void> {
  const deadline = Date.now() + Math.max(500, Math.floor(timeoutMs));
  let earlyExit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | null = null;
  let earlyExitFlag = false;
  void exited.then((info) => {
    earlyExit = info;
    earlyExitFlag = true;
  });

  while (true) {
    const adopted = isAdopted(dbPath, instanceId);
    if (adopted === true) return;
    if (earlyExitFlag) {
      throw new SwarmLauncherAdoptionTimeoutError(
        `Swarm worker exited before adoption (code=${earlyExit?.code ?? "null"}, signal=${earlyExit?.signal ?? "null"})`,
        instanceId,
        timeoutMs,
        ""
      );
    }
    if (Date.now() >= deadline) {
      throw new SwarmLauncherAdoptionTimeoutError(
        `Swarm worker did not adopt within ${timeoutMs}ms`,
        instanceId,
        timeoutMs,
        ""
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(10, Math.min(pollIntervalMs, deadline - Date.now())))
    );
  }
}
