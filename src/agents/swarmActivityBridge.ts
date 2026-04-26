import { cancelSpawnedWorkerForTask } from "../tools/spawnCodeWorker.ts";
import type { ClankyPeer, SwarmContextEntry, SwarmMessage, SwarmTaskStatus } from "./swarmPeer.ts";

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

export type SwarmSpawnRequestRole = "implementation" | "review" | "research";

export type SwarmSpawnRequest = {
  v: 1;
  kind: "spawn_request";
  taskId: string;
  role: SwarmSpawnRequestRole;
  reason: string;
  priority: number | null;
};

export type SwarmSpawnRequestEvent = {
  scope: string;
  controllerPeer: ClankyPeer;
  message: SwarmMessage;
  request: SwarmSpawnRequest;
};

export type SwarmActivityBridgeOptions = {
  onProgress?: (event: CodeTaskProgressEvent) => void | Promise<void>;
  onTerminal?: (event: CodeTaskTerminalEvent) => void | Promise<void>;
  onSpawnRequest?: (event: SwarmSpawnRequestEvent) => void | Promise<void>;
  /** Polling interval per scope. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /** Duplicate spawn_request suppression window. Defaults to 60s. */
  spawnRequestDedupMs?: number;
  /** Maximum accepted spawn_requests per sender per minute. Defaults to 5. */
  spawnRequestRateLimitPerMinute?: number;
  /**
   * Override the cancel hook so tests don't reach into spawnCodeWorker's
   * shared map. Production callers leave this unset; the bridge defaults
   * to `cancelSpawnedWorkerForTask`.
   */
  cancelWorker?: (taskId: string, reason?: string) => Promise<unknown>;
  /** Action-log sink for telemetry. */
  logAction?: (entry: Record<string, unknown>) => void;
};

function normalizeSpawnRequestRole(value: unknown): SwarmSpawnRequestRole | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (normalized === "implementation" || normalized === "implement" || normalized === "implementer" || normalized === "fix") {
    return "implementation";
  }
  if (normalized === "review" || normalized === "reviewer") return "review";
  if (normalized === "research" || normalized === "researcher") return "research";
  return null;
}

function parseSpawnRequestMessage(content: string): SwarmSpawnRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(content || ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || record.kind !== "spawn_request") return null;
  const taskId = String(record.taskId || record.task_id || "").trim();
  const role = normalizeSpawnRequestRole(record.role);
  if (!taskId || !role) return null;
  const reason = String(record.reason || "").trim().slice(0, 500);
  const rawPriority = Number(record.priority);
  return {
    v: 1,
    kind: "spawn_request",
    taskId,
    role,
    reason,
    priority: Number.isFinite(rawPriority) ? Math.max(-100, Math.min(100, Math.floor(rawPriority))) : null
  };
}

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
  private readonly controllerScopes: Set<string> = new Set();
  private readonly seenSpawnRequestKeys: Map<string, number> = new Map();
  private readonly spawnRequestSenderHits: Map<string, number[]> = new Map();
  private readonly polling: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly pollIntervalMs: number;
  private readonly spawnRequestDedupMs: number;
  private readonly spawnRequestRateLimitPerMinute: number;
  private readonly onProgress?: SwarmActivityBridgeOptions["onProgress"];
  private readonly onTerminal?: SwarmActivityBridgeOptions["onTerminal"];
  private readonly onSpawnRequest?: SwarmActivityBridgeOptions["onSpawnRequest"];
  private readonly cancelWorker: NonNullable<SwarmActivityBridgeOptions["cancelWorker"]>;
  private readonly logAction?: SwarmActivityBridgeOptions["logAction"];
  private closed = false;

  constructor(opts: SwarmActivityBridgeOptions = {}) {
    this.pollIntervalMs = Math.max(250, Math.floor(Number(opts.pollIntervalMs) || 1500));
    this.spawnRequestDedupMs = Math.max(1_000, Math.floor(Number(opts.spawnRequestDedupMs) || 60_000));
    this.spawnRequestRateLimitPerMinute = Math.max(1, Math.floor(Number(opts.spawnRequestRateLimitPerMinute) || 5));
    this.onProgress = opts.onProgress;
    this.onTerminal = opts.onTerminal;
    this.onSpawnRequest = opts.onSpawnRequest;
    this.cancelWorker = opts.cancelWorker ?? ((taskId, reason) =>
      cancelSpawnedWorkerForTask(taskId, reason));
    this.logAction = opts.logAction;
  }

  /** Watch this Clanky planner peer's inbox for controller messages such as planner spawn_request escalations. */
  watchControllerPeer(peer: ClankyPeer, context: { scope: string }): void {
    if (this.closed) return;
    const scope = String(context.scope || peer.scope || "").trim();
    if (!scope) return;
    this.peers.set(scope, peer);
    this.controllerScopes.add(scope);
    if (!this.polling.has(scope)) {
      this.startPolling(scope);
    }
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
    this.controllerScopes.clear();
    this.seenSpawnRequestKeys.clear();
    this.spawnRequestSenderHits.clear();
  }

  /** Force a poll cycle now. Exposed for tests. */
  async pollOnce(scope?: string): Promise<void> {
    if (this.closed) return;
    const scopes = scope ? [scope] : [...this.peers.keys()];
    for (const s of scopes) {
      await this.pollScope(s);
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
    if (stillTracked || this.controllerScopes.has(scope)) return;
    const handle = this.polling.get(scope);
    if (handle) clearInterval(handle);
    this.polling.delete(scope);
    this.peers.delete(scope);
  }

  private async pollScope(scope: string): Promise<void> {
    if (this.closed) return;
    const peer = this.peers.get(scope);
    if (!peer) return;
    if (this.controllerScopes.has(scope)) {
      await this.processControllerInbox(peer, scope).catch((error) => {
        this.logAction?.({
          kind: "swarm_activity_bridge_error",
          content: "controller_inbox_poll_failure",
          metadata: {
            scope,
            error: String((error as Error)?.message || error)
          }
        });
      });
    }
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

  private async processControllerInbox(peer: ClankyPeer, scope: string): Promise<void> {
    if (!this.onSpawnRequest) return;
    const messages = await peer.pollMessages(50);
    for (const message of messages) {
      const request = parseSpawnRequestMessage(message.content);
      if (!request) continue;
      if (this.isDuplicateSpawnRequest(message, request)) continue;
      if (!this.acceptSpawnRequestRate(message, request, scope)) continue;
      await this.onSpawnRequest({
        scope,
        controllerPeer: peer,
        message,
        request
      });
    }
  }

  private isDuplicateSpawnRequest(message: SwarmMessage, request: SwarmSpawnRequest): boolean {
    const now = Date.now();
    const cutoff = now - this.spawnRequestDedupMs;
    for (const [key, seenAt] of this.seenSpawnRequestKeys.entries()) {
      if (seenAt < cutoff) this.seenSpawnRequestKeys.delete(key);
    }
    const key = `${message.sender}:${request.kind}:${request.taskId}`;
    const seenAt = this.seenSpawnRequestKeys.get(key);
    if (seenAt && seenAt >= cutoff) return true;
    this.seenSpawnRequestKeys.set(key, now);
    return false;
  }

  private acceptSpawnRequestRate(message: SwarmMessage, request: SwarmSpawnRequest, scope: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const sender = String(message.sender || "").trim() || "unknown";
    const hits = (this.spawnRequestSenderHits.get(sender) || []).filter((stamp) => stamp >= cutoff);
    if (hits.length >= this.spawnRequestRateLimitPerMinute) {
      this.spawnRequestSenderHits.set(sender, hits);
      this.logAction?.({
        kind: "swarm_spawn_request_rate_limited",
        content: "spawn_request_rate_limited",
        metadata: {
          scope,
          sender,
          taskId: request.taskId,
          limitPerMinute: this.spawnRequestRateLimitPerMinute
        }
      });
      return false;
    }
    hits.push(now);
    this.spawnRequestSenderHits.set(sender, hits);
    return true;
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
      let terminalError: unknown = null;
      try {
        if (this.onTerminal) {
          await this.onTerminal({ context: ctx, status, result });
        }
      } catch (error) {
        terminalError = error;
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
      if (terminalError) throw terminalError;
    }
  }
}
