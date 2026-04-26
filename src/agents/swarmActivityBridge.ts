import { cancelSpawnedWorkerForTask } from "../tools/spawnCodeWorker.ts";
import type { ClankyPeer, SwarmContextEntry, SwarmTaskStatus } from "./swarmPeer.ts";

/**
 * Per-dispatch routing context. The bridge keeps this so progress and
 * terminal events can be routed back to the surface that triggered the
 * dispatch (text channel, voice session, slash command, etc.).
 */
export type CodeTaskDispatchContext = {
  taskId: string;
  workerId: string;
  scope: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  triggerMessageId: string | null;
  source: string;
};

export type CodeTaskProgressEvent = {
  context: CodeTaskDispatchContext;
  annotationId: string;
  summary: string;
  createdAt: number;
};

export type CodeTaskTerminalEvent = {
  context: CodeTaskDispatchContext;
  status: Extract<SwarmTaskStatus, "done" | "failed" | "cancelled">;
  result: string;
};

export type SwarmActivityBridgeOptions = {
  onProgress?: (event: CodeTaskProgressEvent) => void | Promise<void>;
  onTerminal?: (event: CodeTaskTerminalEvent) => void | Promise<void>;
  /** Polling interval per scope. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /**
   * Override the cancel hook so tests don't reach into spawnCodeWorker's
   * shared map. Production callers leave this unset; the bridge defaults
   * to `cancelSpawnedWorkerForTask`.
   */
  cancelWorker?: (taskId: string, reason?: string) => Promise<unknown>;
  /** Action-log sink for telemetry. */
  logAction?: (entry: Record<string, unknown>) => void;
};

/**
 * Long-running subscription that watches swarm activity for tasks Clanky
 * dispatched and surfaces progress/terminal events back to the originating
 * Discord context. Lives across reply turns — progress that arrives after
 * the orchestrator's turn ends still gets delivered.
 *
 * The bridge polls per-scope rather than keeping a websocket open against
 * swarm-mcp's event stream. Polling keeps the implementation simple and
 * matches the existing pattern in `swarmTaskWaiter`. Cadence is per-scope,
 * not per-task, so a scope with N tasks polls once per interval and reads
 * all of them in a single pass.
 *
 * On `status="cancelled"`, the bridge also kills the backing worker via
 * `cancelSpawnedWorkerForTask` (closes its swarm-server PTY when path A,
 * SIGTERMs the direct child otherwise) — that's how the orchestrator's
 * `update_task(cancelled)` and the keyword cancel handler in `bot.ts`
 * actually stop the running process.
 */
export class SwarmActivityBridge {
  private readonly peers: Map<string, ClankyPeer> = new Map();
  private readonly contexts: Map<string, CodeTaskDispatchContext> = new Map();
  private readonly seenProgressIds: Map<string, Set<string>> = new Map();
  private readonly polling: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly pollIntervalMs: number;
  private readonly onProgress?: SwarmActivityBridgeOptions["onProgress"];
  private readonly onTerminal?: SwarmActivityBridgeOptions["onTerminal"];
  private readonly cancelWorker: NonNullable<SwarmActivityBridgeOptions["cancelWorker"]>;
  private readonly logAction?: SwarmActivityBridgeOptions["logAction"];
  private closed = false;

  constructor(opts: SwarmActivityBridgeOptions = {}) {
    this.pollIntervalMs = Math.max(250, Math.floor(Number(opts.pollIntervalMs) || 1500));
    this.onProgress = opts.onProgress;
    this.onTerminal = opts.onTerminal;
    this.cancelWorker = opts.cancelWorker ?? ((taskId, reason) =>
      cancelSpawnedWorkerForTask(taskId, reason));
    this.logAction = opts.logAction;
  }

  /** Register a freshly-dispatched task. The peer is the planner peer for the scope. */
  trackTask(peer: ClankyPeer, context: CodeTaskDispatchContext): void {
    if (this.closed) return;
    const taskId = String(context.taskId || "").trim();
    if (!taskId) return;
    this.peers.set(context.scope, peer);
    this.contexts.set(taskId, { ...context, taskId });
    this.seenProgressIds.set(taskId, new Set());
    if (!this.polling.has(context.scope)) {
      this.startPolling(context.scope);
    }
  }

  /** Stop tracking a task without firing terminal — used when a caller takes over. */
  forgetTask(taskId: string): void {
    const id = String(taskId || "").trim();
    if (!id) return;
    this.contexts.delete(id);
    this.seenProgressIds.delete(id);
  }

  /** Active dispatch contexts for a (guildId, channelId) scope. Used by cancel handlers. */
  contextsForScope(filter: { guildId?: string | null; channelId?: string | null }): CodeTaskDispatchContext[] {
    const guildId = filter.guildId ? String(filter.guildId) : null;
    const channelId = filter.channelId ? String(filter.channelId) : null;
    const matches: CodeTaskDispatchContext[] = [];
    for (const ctx of this.contexts.values()) {
      if (guildId && ctx.guildId !== guildId) continue;
      if (channelId && ctx.channelId !== channelId) continue;
      matches.push(ctx);
    }
    return matches;
  }

  /** Number of tasks currently tracked. */
  size(): number {
    return this.contexts.size;
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.polling.values()) clearInterval(handle);
    this.polling.clear();
    this.peers.clear();
    this.contexts.clear();
    this.seenProgressIds.clear();
  }

  /** Force a poll cycle now. Exposed for tests. */
  async pollOnce(scope?: string): Promise<void> {
    if (this.closed) return;
    const scopes = scope ? [scope] : [...this.peers.keys()];
    for (const s of scopes) {
      await this.pollScope(s).catch(() => {});
    }
  }

  private startPolling(scope: string) {
    const handle = setInterval(() => {
      void this.pollScope(scope).catch(() => {});
    }, this.pollIntervalMs);
    this.polling.set(scope, handle);
  }

  private stopPollingIfEmpty(scope: string) {
    const stillTracked = [...this.contexts.values()].some((ctx) => ctx.scope === scope);
    if (stillTracked) return;
    const handle = this.polling.get(scope);
    if (handle) clearInterval(handle);
    this.polling.delete(scope);
    this.peers.delete(scope);
  }

  private async pollScope(scope: string): Promise<void> {
    if (this.closed) return;
    const peer = this.peers.get(scope);
    if (!peer) return;
    const tasks = [...this.contexts.values()].filter((ctx) => ctx.scope === scope);
    if (tasks.length === 0) {
      this.stopPollingIfEmpty(scope);
      return;
    }
    for (const ctx of tasks) {
      await this.processTask(peer, ctx).catch((error) => {
        this.logAction?.({
          kind: "swarm_activity_bridge_error",
          content: "poll_failure",
          metadata: {
            taskId: ctx.taskId,
            scope: ctx.scope,
            error: String((error as Error)?.message || error)
          }
        });
      });
    }
  }

  private async processTask(peer: ClankyPeer, ctx: CodeTaskDispatchContext): Promise<void> {
    const task = await peer.getTask(ctx.taskId);
    if (!task) return;

    // Progress: emit one event per new `kind="progress"` annotation.
    const annotations = await peer.checkFile(ctx.taskId).catch(() => [] as SwarmContextEntry[]);
    const seen = this.seenProgressIds.get(ctx.taskId);
    if (seen) {
      for (const ann of annotations) {
        if (ann.type !== "progress") continue;
        if (seen.has(ann.id)) continue;
        seen.add(ann.id);
        if (this.onProgress) {
          await this.onProgress({
            context: ctx,
            annotationId: ann.id,
            summary: String(ann.content || "").trim(),
            createdAt: Number(ann.createdAt) || Date.now()
          });
        }
      }
    }

    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      const status = task.status;
      const result = String(task.result || "").trim();
      try {
        if (this.onTerminal) {
          await this.onTerminal({ context: ctx, status, result });
        }
      } finally {
        this.contexts.delete(ctx.taskId);
        this.seenProgressIds.delete(ctx.taskId);
      }
      if (status === "cancelled") {
        // SIGTERM the worker if it's still running. Idempotent — returns false
        // if the worker has already exited or was never tracked.
        await this.cancelWorker(ctx.taskId, "swarm task cancelled").catch(() => false);
      }
      this.stopPollingIfEmpty(ctx.scope);
    }
  }
}
