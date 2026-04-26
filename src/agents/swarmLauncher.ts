import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildClaudeCodeAgentArgs,
  buildClaudeCodeInteractiveAgentArgs
} from "../llm/llmClaudeCode.ts";
import {
  buildCodexCliCodeAgentArgs,
  buildCodexCliInteractiveAgentArgs
} from "../llm/llmCodexCli.ts";
import {
  buildSwarmLabel,
  buildSwarmLauncherFirstTurnPreamble,
  applySwarmLauncherFirstTurnPreamble,
  type CodeAgentSwarmRuntimeConfig
} from "./codeAgentSwarm.ts";
import {
  resolveCodeAgentWorkspace,
  type CodeAgentWorkspace
} from "./codeAgentWorkspace.ts";
import { resolveSwarmDbPath } from "./swarmDbConnection.ts";
import { type SwarmReservationKeeper } from "./swarmReservationKeeper.ts";
import { isAdopted } from "./swarmDb.ts";
import { SwarmServerClient } from "./swarmServerClient.ts";

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

type SwarmServerClientLike = Pick<
  SwarmServerClient,
  "socketPath" | "supportsDirectHarnessSpawn" | "spawnPty" | "closePty" | "fetchState"
>;

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
  /** Optional client override used by tests for the swarm-server PTY route. */
  swarmServerClient?: SwarmServerClientLike;
};

export type SpawnedPeer = {
  instanceId: string;
  ptyId?: string;
  launchMode: "direct_child" | "swarm_server_pty";
  scope: string;
  fileRoot: string;
  workspace: CodeAgentWorkspace;
  child?: ChildProcess;
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

function normalizeOutputTailBytes(value: unknown): number {
  const bytes = Math.floor(Number(value) || OUTPUT_TAIL_BYTES);
  return Math.max(OUTPUT_TAIL_BYTES, Math.min(bytes, 10 * 1024 * 1024));
}

function normalizeWorkerTimeoutMs(value: unknown): number {
  const timeoutMs = Math.floor(Number(value) || 0);
  return Math.max(1000, timeoutMs);
}

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
    return {
      command: "claude",
      args: buildClaudeCodeAgentArgs({
        model: opts.model,
        prompt,
        maxTurns: opts.maxTurns,
        mcpConfig: mcpConfigJson
      })
    };
  }
  return {
    command: "codex",
    args: buildCodexCliCodeAgentArgs({
      model: opts.model,
      instruction: prompt,
      configOverrides: codexOverrides
    })
  };
}

function sanitizeInitialPtyPrompt(value: string): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .trim();
}

function buildBracketedPasteInput(value: string): string | null {
  const prompt = sanitizeInitialPtyPrompt(value);
  if (!prompt) return null;
  return `\u001b[200~${prompt}\u001b[201~\r`;
}

function buildInteractiveHarnessInvocation({
  opts,
  workspace,
  prompt,
  mcpConfigJson,
  codexOverrides
}: {
  opts: SpawnPeerOptions;
  workspace: CodeAgentWorkspace;
  prompt: string;
  mcpConfigJson: string;
  codexOverrides: string[];
}): { args: string[]; initialInput: string | null } {
  if (opts.harness === "claude-code") {
    return {
      args: buildClaudeCodeInteractiveAgentArgs({
        model: opts.model,
        mcpConfig: mcpConfigJson
      }),
      initialInput: buildBracketedPasteInput(prompt)
    };
  }
  return {
    args: buildCodexCliInteractiveAgentArgs({
      model: opts.model,
      cwd: workspace.cwd,
      configOverrides: codexOverrides
    }),
    initialInput: buildBracketedPasteInput(prompt)
  };
}

/**
 * Clanky's repo root, derived from this file's location. Used to resolve
 * relative paths in `swarm.args` (e.g. `./mcp-servers/swarm-mcp/src/index.ts`)
 * to absolute paths before the inline mcp-config is written, so the spawned
 * worker can find swarm-mcp regardless of its own cwd (which is the target
 * repo, not Clanky's).
 */
function clankyRepoRoot(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

/**
 * Load the swarm-mcp coordination skill bundled with the vendored submodule.
 *
 * Layout (post-`Simplify swarm MCP skill installation` upstream commit): one
 * Claude Code skill at `skills/swarm-mcp/` with `SKILL.md` as the entry plus
 * role-specific guidance under `references/<role>.md`. We inline both:
 *
 *   - `SKILL.md` — coordination contract, role-routing summary, when to use
 *     swarm tools at all
 *   - `references/<role>.md` — deep guidance for the worker's role
 *     (planner / implementer / reviewer / researcher)
 *
 * Returns the concatenated body, or "" when the submodule is not initialized.
 */
export function loadRoleCoordinationSkill(role: SwarmPeerRole): string {
  const skillRoot = path.resolve(clankyRepoRoot(), "mcp-servers/swarm-mcp/skills/swarm-mcp");
  const skillEntry = path.join(skillRoot, "SKILL.md");
  if (!existsSync(skillEntry)) return "";

  const sections: string[] = [];
  try {
    sections.push(readFileSync(skillEntry, "utf8"));
  } catch {
    return "";
  }

  const roleReference = path.join(skillRoot, "references", `${role}.md`);
  if (existsSync(roleReference)) {
    try {
      sections.push(`# Role reference: ${role}\n\n${readFileSync(roleReference, "utf8")}`);
    } catch {
      // ignore — we still have the SKILL.md entry
    }
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Resolve any relative entries in `swarm.args` against Clanky's repo root.
 * Absolute paths and non-path tokens (e.g. `run`) pass through unchanged.
 *
 * Exported for tests; production callers go through `buildClaudeMcpConfigJson`
 * or `buildCodexConfigOverrides`.
 */
export function resolveSwarmArgs(args: string[]): string[] {
  const repoRoot = clankyRepoRoot();
  return args.map((arg) => {
    const trimmed = String(arg || "");
    if (!trimmed) return trimmed;
    if (path.isAbsolute(trimmed)) return trimmed;
    if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
      return path.resolve(repoRoot, trimmed);
    }
    return trimmed;
  });
}

/**
 * Read the worker-target repo's `.mcp.json` (Claude Code's project-scope MCP
 * config). Returns the `mcpServers` map, or `{}` if the file is missing or
 * malformed. Project-scope MCPs and skills are inherited by the worker by
 * design — Clanky's injected config plays the role the operator's user-scope
 * config would otherwise play, so user-scope is intentionally excluded.
 */
export function loadProjectMcpServers(workspaceCwd: string): Record<string, unknown> {
  const file = path.join(workspaceCwd, ".mcp.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    return servers as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Probe whether Clanky's vendored swarm-mcp can actually be spawned with the
 * configured command/args. Looks for a path-like arg (typically the entry
 * file) and checks for its existence. If `swarm.args` has no path-like entry
 * (e.g. operator put the runtime on PATH), we trust the command is resolvable
 * and return true.
 */
export function clankySwarmIsAvailable(swarm: CodeAgentSwarmRuntimeConfig): boolean {
  if (!swarm?.command) return false;
  const resolvedArgs = resolveSwarmArgs(swarm.args);
  const pathLikeArg = resolvedArgs.find((arg) => path.isAbsolute(arg) && /\.(?:ts|js|mjs|cjs)$/.test(arg));
  if (!pathLikeArg) return true;
  return existsSync(pathLikeArg);
}

function clankySwarmServerEntry(swarm: CodeAgentSwarmRuntimeConfig): Record<string, unknown> | null {
  if (!swarm?.command) return null;
  return {
    type: "stdio",
    command: swarm.command,
    args: resolveSwarmArgs(swarm.args),
    env: swarm.dbPath ? { SWARM_DB_PATH: swarm.dbPath } : {}
  };
}

/**
 * Build the inline `--mcp-config` JSON for claude-code workers.
 *
 * Composition rules:
 *   1. Start with project-scope MCP servers from `<cwd>/.mcp.json`.
 *   2. Overlay Clanky's vendored swarm-mcp entry, but only if the vendored
 *      path actually exists on disk. When it doesn't, the project's entry
 *      (if any) keeps the swarm slot — that's the project-fallback behavior.
 *   3. Pair with `--strict-mcp-config` at call time so user-scope MCPs are
 *      ignored entirely. (Skills still load from project + user — Claude Code
 *      doesn't expose a strict-skills flag — but project-scope skills are the
 *      target experience and they always load based on cwd.)
 */
export function buildClaudeMcpConfigJson(swarm: CodeAgentSwarmRuntimeConfig, workspaceCwd: string): string {
  const merged: Record<string, unknown> = { ...loadProjectMcpServers(workspaceCwd) };
  const clankyEntry = clankySwarmServerEntry(swarm);
  if (clankyEntry && clankySwarmIsAvailable(swarm)) {
    merged[swarm.serverName] = clankyEntry;
  }
  if (Object.keys(merged).length === 0) return "";
  return JSON.stringify(merged);
}

function buildCodexConfigOverrides(swarm: CodeAgentSwarmRuntimeConfig): string[] {
  if (!swarm?.command) return [];
  // If clanky's vendored swarm-mcp is unavailable, omit the override and let
  // codex resolve the swarm server from its own (project/user) config — the
  // project-fallback path. The project's codex config can register a swarm
  // entry under the same `serverName` and the worker will pick it up.
  if (!clankySwarmIsAvailable(swarm)) return [];
  const literalString = (value: string) => `'${String(value || "").replace(/'/g, "''")}'`;
  const literalArray = (values: string[]) =>
    `[${values.map((value) => literalString(value)).join(", ")}]`;
  return [
    `mcp_servers.${swarm.serverName}.command=${literalString(swarm.command)}`,
    `mcp_servers.${swarm.serverName}.args=${literalArray(resolveSwarmArgs(swarm.args))}`
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

  const workspace = resolveCodeAgentWorkspace({ cwd: opts.cwd });
  const scope = opts.scope || workspace.repoRoot;

  const label = buildSwarmLabel({
    provider: opts.harness,
    role: opts.role,
    thread: opts.labelExtras?.thread ?? opts.trace.channelId ?? null,
    user: opts.labelExtras?.user ?? opts.trace.userId ?? null
  });

  const dbPath = resolveSwarmDbPath(opts.swarm.dbPath || "");
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    serverName: opts.swarm.serverName,
    taskId: opts.taskId,
    coordinationSkill: opts.swarm.appendCoordinationPrompt === false
      ? ""
      : loadRoleCoordinationSkill(opts.role)
  });
  const wrappedPrompt = applySwarmLauncherFirstTurnPreamble(opts.initialPrompt, preamble);
  const mcpConfigJson = buildClaudeMcpConfigJson(opts.swarm, workspace.cwd);
  const codexOverrides = buildCodexConfigOverrides(opts.swarm);

  const directInvocation = buildHarnessInvocation({
    opts,
    prompt: wrappedPrompt,
    mcpConfigJson,
    codexOverrides
  });

  // Try path A whenever a swarm-server client is reachable. `harnessOverride`
  // alone (e.g. test fixtures) shouldn't skip path A — tests can exercise the
  // fallback transition by passing a `swarmServerClient` that returns null
  // from `supportsDirectHarnessSpawn` or throws on `spawnPty`. When neither
  // a swarmServerClient nor a real socket is available, path A is naturally
  // skipped (the default `new SwarmServerClient(...).supportsDirectHarnessSpawn()`
  // returns false when the socket file is missing).
  if (!opts.harnessOverride || opts.swarmServerClient) {
    const interactiveInvocation = buildInteractiveHarnessInvocation({
      opts,
      workspace,
      prompt: wrappedPrompt,
      mcpConfigJson,
      codexOverrides
    });
    const serverSpawned = await spawnPeerViaSwarmServer({
      opts,
      workspace,
      scope,
      label,
      dbPath,
      args: interactiveInvocation.args,
      initialInput: interactiveInvocation.initialInput
    });
    if (serverSpawned) return serverSpawned;
  }

  const { command, args } = directInvocation;

  if (opts.signal?.aborted) {
    throw new Error(`spawnPeer aborted before launch: ${opts.signal.reason || "cancelled"}`);
  }

  const reserved = opts.reservationKeeper.reserve({
    directory: workspace.cwd,
    scope,
    fileRoot: workspace.canonicalCwd,
    label
  });

  const childEnv: Record<string, string> = {
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: reserved.id,
    SWARM_MCP_DIRECTORY: workspace.cwd,
    SWARM_MCP_SCOPE: reserved.scope,
    SWARM_MCP_FILE_ROOT: workspace.canonicalCwd,
    SWARM_MCP_LABEL: label
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: workspace.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...childEnv }
    });
  } catch (error) {
    opts.reservationKeeper.release(reserved.id);
    throw error;
  }

  const tail = new RingBuffer(normalizeOutputTailBytes(opts.maxBufferBytes));
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

  const workerTimeout = setTimeout(() => {
    void cancel("timeout");
  }, normalizeWorkerTimeoutMs(opts.timeoutMs));
  workerTimeout.unref?.();
  void exited.finally(() => clearTimeout(workerTimeout));

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
    launchMode: "direct_child",
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

function swarmServerHarness(harness: SpawnPeerOptions["harness"]): "claude" | "codex" {
  return harness === "claude-code" ? "claude" : "codex";
}

async function spawnPeerViaSwarmServer({
  opts,
  workspace,
  scope,
  label,
  dbPath,
  args,
  initialInput
}: {
  opts: SpawnPeerOptions;
  workspace: CodeAgentWorkspace;
  scope: string;
  label: string;
  dbPath: string;
  args: string[];
  initialInput: string | null;
}): Promise<SpawnedPeer | null> {
  const client = opts.swarmServerClient ?? new SwarmServerClient({ dbPath });
  if (!(await client.supportsDirectHarnessSpawn())) {
    return null;
  }

  let response;
  try {
    response = await client.spawnPty({
      cwd: workspace.cwd,
      harness: swarmServerHarness(opts.harness),
      role: opts.role,
      scope,
      label,
      name: null,
      instance_id: null,
      cols: null,
      rows: null,
      args,
      env: {
        SWARM_DB_PATH: dbPath
      },
      initial_input: initialInput
    });
  } catch (error) {
    try {
      opts.store.logAction({
        kind: "swarm_server_spawn_fallback",
        guildId: opts.trace.guildId || null,
        channelId: opts.trace.channelId || null,
        userId: opts.trace.userId || null,
        metadata: {
          harness: opts.harness,
          socketPath: client.socketPath,
          reason: String(error instanceof Error ? error.message : error),
          source: opts.trace.source ?? null
        }
      });
    } catch {
      // ignore telemetry errors
    }
    return null;
  }

  const instanceId = String(response.pty.bound_instance_id || "").trim();
  const ptyId = String(response.pty.id || "").trim();
  if (!instanceId || !ptyId) {
    throw new Error("swarm-server /pty response did not include a bound instance id.");
  }

  let cancelled = false;
  let cancelReason = "";
  const exited = waitForSwarmServerPtyExit({ client, ptyId });
  const cancel = async (reason?: string) => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = String(reason || "cancelled");
    try {
      await client.closePty(ptyId, true);
    } catch {
      // The server may already have reaped the PTY.
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1500))
    ]);
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      await cancel(opts.signal.reason || "aborted");
      throw new Error(`spawnPeer aborted: ${String(opts.signal.reason || "cancelled")}`);
    }
    opts.signal.addEventListener(
      "abort",
      () => {
        void cancel(opts.signal?.reason || "aborted");
      },
      { once: true }
    );
  }

  const workerTimeout = setTimeout(() => {
    void cancel("timeout");
  }, normalizeWorkerTimeoutMs(opts.timeoutMs));
  workerTimeout.unref?.();
  void exited.finally(() => clearTimeout(workerTimeout));

  const adopted = waitForAdoption({
    dbPath,
    instanceId,
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
            instanceId,
            ptyId,
            harness: opts.harness,
            launchMode: "swarm_server_pty",
            timeoutMs: error.timeoutMs,
            tail: "",
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

  exited.then((info) => {
    try {
      opts.store.logAction({
        kind: "swarm_worker_exit",
        guildId: opts.trace.guildId || null,
        channelId: opts.trace.channelId || null,
        userId: opts.trace.userId || null,
        metadata: {
          instanceId,
          ptyId,
          harness: opts.harness,
          launchMode: "swarm_server_pty",
          exitCode: info.code,
          exitSignal: info.signal,
          cancelled,
          cancelReason: cancelled ? cancelReason : null,
          tail: "",
          source: opts.trace.source ?? null
        }
      });
    } catch {
      // ignore telemetry errors
    }
  });

  return {
    instanceId,
    ptyId,
    launchMode: "swarm_server_pty",
    scope,
    fileRoot: workspace.canonicalCwd,
    workspace,
    adopted,
    exited,
    outputTail: () => "",
    cancel
  };
}

async function waitForSwarmServerPtyExit({
  client,
  ptyId,
  pollIntervalMs = 1000
}: {
  client: SwarmServerClientLike;
  ptyId: string;
  pollIntervalMs?: number;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  while (true) {
    try {
      const snapshot = await client.fetchState();
      const pty = (Array.isArray(snapshot.ptys) ? snapshot.ptys : [])
        .find((candidate) => candidate.id === ptyId);
      if (!pty) return { code: null, signal: null };
      if (pty.exit_code !== null && pty.exit_code !== undefined) {
        return { code: Number(pty.exit_code), signal: null };
      }
    } catch {
      return { code: null, signal: null };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollIntervalMs)));
  }
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
