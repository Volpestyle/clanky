import { isAbortError } from "../tools/browserTaskRuntime.ts";
import type { CodeAgentRole } from "./codeAgent.ts";
import type {
  SubAgentProgressEvent,
  SubAgentSession,
  SubAgentSessionManager,
  SubAgentTurnResult
} from "./subAgentSession.ts";

const DEFAULT_TASK_RETENTION_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 10_000;
const MAX_STORED_PROGRESS_EVENTS = 240;

export type BackgroundTaskStatus = "running" | "completed" | "error" | "cancelled";

export type BackgroundTaskProgress = {
  events: SubAgentProgressEvent[];
  lastEventAt: number;
  turnNumber: number;
  totalTurns: number | null;
  fileEdits: string[];
  lastMilestoneReportedAt: number;
  reportsSent: number;
  lastReportedEventCount: number;
};

export type BackgroundTask = {
  id: string;
  sessionId: string;
  scopeKey: string;
  guildId: string;
  channelId: string;
  userId: string | null;
  triggerMessageId: string | null;
  role: CodeAgentRole;
  source: string | null;
  input: string;
  startedAt: number;
  completedAt: number | null;
  status: BackgroundTaskStatus;
  progress: BackgroundTaskProgress;
  result: SubAgentTurnResult | null;
  errorMessage: string | null;
};

type BackgroundTaskProgressConfig = {
  enabled: boolean;
  intervalMs: number;
  maxReportsPerTask: number;
};

type BackgroundTaskDispatchArgs = {
  session: SubAgentSession;
  input: string;
  scopeKey: string;
  guildId: string;
  channelId: string;
  userId: string | null;
  triggerMessageId: string | null;
  role: CodeAgentRole;
  source?: string | null;
  progressReports?: BackgroundTaskProgressConfig;
  onProgress?: (task: BackgroundTask, recentEvents: SubAgentProgressEvent[]) => Promise<void> | void;
  onComplete?: (task: BackgroundTask) => Promise<void> | void;
};

type InternalTask = BackgroundTask & {
  session: SubAgentSession;
  abortController: AbortController;
  progressReports: BackgroundTaskProgressConfig;
  onProgress?: BackgroundTaskDispatchArgs["onProgress"];
  onComplete?: BackgroundTaskDispatchArgs["onComplete"];
  callbackInFlight: boolean;
};

type ActionStore = {
  logAction: (entry: Record<string, unknown>) => void;
};

type BackgroundTaskRunnerOptions = {
  store: ActionStore;
  sessionManager: Pick<SubAgentSessionManager, "remove">;
  retentionMs?: number;
  sweepIntervalMs?: number;
};

function truncateSummary(value: unknown, maxChars = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function extractFilePathFromSummary(summary: string): string {
  const normalized = String(summary || "").trim();
  if (!normalized) return "";
  const match = normalized.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]{1,12})/);
  return String(match?.[1] || "").trim();
}

function normalizeProgressReportsConfig(
  input: BackgroundTaskDispatchArgs["progressReports"]
): BackgroundTaskProgressConfig {
  return {
    enabled: input?.enabled !== false,
    intervalMs: Math.max(10_000, Math.floor(Number(input?.intervalMs) || 60_000)),
    maxReportsPerTask: Math.max(0, Math.floor(Number(input?.maxReportsPerTask) || 5))
  };
}

export function buildCodeTaskScopeKey({
  guildId,
  channelId
}: {
  guildId?: string | null;
  channelId?: string | null;
}) {
  const normalizedGuildId = String(guildId || "dm").trim() || "dm";
  const normalizedChannelId = String(channelId || "dm").trim() || "dm";
  return `code:${normalizedGuildId}:${normalizedChannelId}`;
}

export class BackgroundTaskRunner {
  private readonly store: ActionStore;
  private readonly sessionManager: Pick<SubAgentSessionManager, "remove">;
  private readonly retentionMs: number;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly scopeIndex = new Map<string, Set<string>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor({
    store,
    sessionManager,
    retentionMs = DEFAULT_TASK_RETENTION_MS,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS
  }: BackgroundTaskRunnerOptions) {
    this.store = store;
    this.sessionManager = sessionManager;
    this.retentionMs = Math.max(60_000, Math.floor(Number(retentionMs) || DEFAULT_TASK_RETENTION_MS));
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(5_000, Math.floor(Number(sweepIntervalMs) || DEFAULT_SWEEP_INTERVAL_MS)));
    if (typeof this.sweepTimer.unref === "function") {
      this.sweepTimer.unref();
    }
  }

  dispatch(args: BackgroundTaskDispatchArgs): BackgroundTask {
    const now = Date.now();
    const progressReports = normalizeProgressReportsConfig(args.progressReports);
    const task: InternalTask = {
      id: String(args.session.id || "").trim() || `code-task-${now}`,
      sessionId: String(args.session.id || "").trim() || `code-task-${now}`,
      scopeKey: String(args.scopeKey || "").trim() || buildCodeTaskScopeKey({
        guildId: args.guildId,
        channelId: args.channelId
      }),
      guildId: String(args.guildId || "").trim() || "",
      channelId: String(args.channelId || "").trim() || "",
      userId: args.userId ? String(args.userId) : null,
      triggerMessageId: args.triggerMessageId ? String(args.triggerMessageId) : null,
      role: args.role,
      source: args.source ? String(args.source) : null,
      input: String(args.input || ""),
      startedAt: now,
      completedAt: null,
      status: "running",
      progress: {
        events: [],
        lastEventAt: now,
        turnNumber: 1,
        totalTurns: null,
        fileEdits: [],
        lastMilestoneReportedAt: now,
        reportsSent: 0,
        lastReportedEventCount: 0
      },
      result: null,
      errorMessage: null,
      session: args.session,
      abortController: new AbortController(),
      progressReports,
      onProgress: args.onProgress,
      onComplete: args.onComplete,
      callbackInFlight: false
    };

    const existing = this.tasks.get(task.id);
    if (existing) {
      this.cancel(task.id, "Superseded by a newer background task");
      this.removeTask(task.id);
    }

    this.tasks.set(task.id, task);
    this.indexTask(task);

    this.store.logAction({
      kind: "code_agent_call",
      guildId: task.guildId || null,
      channelId: task.channelId || null,
      userId: task.userId || null,
      content: truncateSummary(task.input, 200),
      metadata: {
        source: task.source || "background_task_dispatch",
        role: task.role,
        sessionId: task.sessionId,
        taskId: task.id,
        asyncDispatched: true,
        progressReports: task.progressReports
      }
    });

    void this.runTask(task);
    return this.snapshotTask(task);
  }

  cancel(taskId: string, reason = "Background code task cancelled"): boolean {
    const task = this.tasks.get(String(taskId || "").trim());
    if (!task) return false;
    if (task.status !== "running") return false;
    task.status = "cancelled";
    task.errorMessage = String(reason || "").trim() || "cancelled";
    try {
      task.abortController.abort(reason);
    } catch {
      // ignore
    }
    try {
      task.session.cancel(reason);
    } catch {
      // ignore
    }
    this.store.logAction({
      kind: "code_agent_error",
      guildId: task.guildId || null,
      channelId: task.channelId || null,
      userId: task.userId || null,
      content: "background_code_task_cancelled",
      metadata: {
        taskId: task.id,
        sessionId: task.sessionId,
        reason: task.errorMessage,
        source: task.source || null
      }
    });
    return true;
  }

  cancelByScope(scopeKey: string, reason = "Background code tasks cancelled"): number {
    const normalizedScopeKey = String(scopeKey || "").trim();
    if (!normalizedScopeKey) return 0;
    const scopedTaskIds = this.scopeIndex.get(normalizedScopeKey);
    if (!scopedTaskIds || scopedTaskIds.size === 0) return 0;
    let cancelled = 0;
    for (const taskId of [...scopedTaskIds]) {
      if (this.cancel(taskId, reason)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.cancel(task.id, "Background task runner shutting down");
      }
    }
  }

  private async runTask(task: InternalTask) {
    try {
      const signal = AbortSignal.any([task.abortController.signal]);
      const result = await task.session.runTurn(task.input, {
        signal,
        onProgress: (event) => this.handleProgressEvent(task, event)
      });
      task.result = result;
      task.completedAt = Date.now();
      task.status = result.isError ? "error" : task.status === "cancelled" ? "cancelled" : "completed";
      if (result.isError) {
        task.errorMessage = String(result.errorMessage || "Code task failed").trim();
      }
    } catch (error) {
      task.completedAt = Date.now();
      const message = String(error instanceof Error ? error.message : error || "Code task failed").trim();
      task.errorMessage = message;
      task.status = isAbortError(error) || task.abortController.signal.aborted ? "cancelled" : "error";
    } finally {
      this.finalizeTask(task);
      await this.invokeCompletion(task);
    }
  }

  private handleProgressEvent(task: InternalTask, rawEvent: SubAgentProgressEvent) {
    if (task.status !== "running") return;
    const timestamp = Math.max(0, Number(rawEvent.timestamp) || Date.now());
    const elapsedMs = Math.max(0, Number(rawEvent.elapsedMs) || (Date.now() - task.startedAt));
    const event: SubAgentProgressEvent = {
      kind: rawEvent.kind,
      summary: truncateSummary(rawEvent.summary || ""),
      turnNumber: Number.isFinite(Number(rawEvent.turnNumber))
        ? Math.max(1, Math.floor(Number(rawEvent.turnNumber)))
        : undefined,
      elapsedMs,
      timestamp,
      filePath: String(rawEvent.filePath || "").trim() || undefined
    };
    task.progress.events.push(event);
    if (task.progress.events.length > MAX_STORED_PROGRESS_EVENTS) {
      task.progress.events.splice(0, task.progress.events.length - MAX_STORED_PROGRESS_EVENTS);
    }
    task.progress.lastEventAt = timestamp;
    if (event.turnNumber) {
      task.progress.turnNumber = event.turnNumber;
    }
    const filePath = event.filePath || extractFilePathFromSummary(event.summary);
    if (filePath && !task.progress.fileEdits.includes(filePath)) {
      task.progress.fileEdits.push(filePath);
    }
    this.maybeEmitProgressMilestone(task);
  }

  private maybeEmitProgressMilestone(task: InternalTask) {
    if (!task.progressReports.enabled) return;
    if (task.progressReports.maxReportsPerTask <= 0) return;
    if (task.progress.reportsSent >= task.progressReports.maxReportsPerTask) return;
    if (task.callbackInFlight) return;

    const now = Date.now();
    const newEventCount = Math.max(0, task.progress.events.length - task.progress.lastReportedEventCount);
    if (newEventCount <= 0) return;
    if (now - task.progress.lastMilestoneReportedAt < task.progressReports.intervalMs) return;

    const recentEvents = task.progress.events.slice(task.progress.lastReportedEventCount);
    task.progress.lastMilestoneReportedAt = now;
    task.progress.lastReportedEventCount = task.progress.events.length;
    task.progress.reportsSent += 1;
    task.callbackInFlight = true;
    Promise.resolve(task.onProgress?.(this.snapshotTask(task), recentEvents))
      .catch((error) => {
        this.store.logAction({
          kind: "bot_error",
          guildId: task.guildId || null,
          channelId: task.channelId || null,
          userId: task.userId || null,
          content: `background_code_task_progress_delivery_failed: ${String(error instanceof Error ? error.message : error)}`,
          metadata: {
            taskId: task.id,
            sessionId: task.sessionId,
            reportsSent: task.progress.reportsSent
          }
        });
      })
      .finally(() => {
        task.callbackInFlight = false;
      });
  }

  private finalizeTask(task: InternalTask) {
    try {
      this.sessionManager.remove(task.sessionId);
    } catch {
      // ignore
    }
    if (!task.completedAt) {
      task.completedAt = Date.now();
    }
    this.store.logAction({
      kind: task.status === "completed" ? "code_agent_call" : "code_agent_error",
      guildId: task.guildId || null,
      channelId: task.channelId || null,
      userId: task.userId || null,
      content: task.status === "completed" ? "background_code_task_completed" : "background_code_task_finished_with_error",
      metadata: {
        taskId: task.id,
        sessionId: task.sessionId,
        role: task.role,
        status: task.status,
        durationMs: Math.max(0, Number(task.completedAt || Date.now()) - task.startedAt),
        errorMessage: task.errorMessage || null,
        fileEditCount: task.progress.fileEdits.length,
        progressEvents: task.progress.events.length,
        source: task.source || null
      },
      usdCost: Number(task.result?.costUsd || 0)
    });
  }

  private async invokeCompletion(task: InternalTask) {
    try {
      await task.onComplete?.(this.snapshotTask(task));
    } catch (error) {
      this.store.logAction({
        kind: "bot_error",
        guildId: task.guildId || null,
        channelId: task.channelId || null,
        userId: task.userId || null,
        content: `background_code_task_completion_delivery_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          status: task.status
        }
      });
    }
  }

  private snapshotTask(task: InternalTask): BackgroundTask {
    return {
      id: task.id,
      sessionId: task.sessionId,
      scopeKey: task.scopeKey,
      guildId: task.guildId,
      channelId: task.channelId,
      userId: task.userId,
      triggerMessageId: task.triggerMessageId,
      role: task.role,
      source: task.source,
      input: task.input,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      status: task.status,
      progress: {
        events: [...task.progress.events],
        lastEventAt: task.progress.lastEventAt,
        turnNumber: task.progress.turnNumber,
        totalTurns: task.progress.totalTurns,
        fileEdits: [...task.progress.fileEdits],
        lastMilestoneReportedAt: task.progress.lastMilestoneReportedAt,
        reportsSent: task.progress.reportsSent,
        lastReportedEventCount: task.progress.lastReportedEventCount
      },
      result: task.result
        ? {
            ...task.result,
            usage: { ...task.result.usage },
            imageInputs: Array.isArray(task.result.imageInputs) ? [...task.result.imageInputs] : undefined
          }
        : null,
      errorMessage: task.errorMessage
    };
  }

  private indexTask(task: InternalTask) {
    const bucket = this.scopeIndex.get(task.scopeKey) || new Set<string>();
    bucket.add(task.id);
    this.scopeIndex.set(task.scopeKey, bucket);
  }

  private unindexTask(task: InternalTask) {
    const bucket = this.scopeIndex.get(task.scopeKey);
    if (!bucket) return;
    bucket.delete(task.id);
    if (bucket.size <= 0) {
      this.scopeIndex.delete(task.scopeKey);
    }
  }

  private removeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.unindexTask(task);
    this.tasks.delete(taskId);
  }

  private sweep() {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.maybeEmitProgressMilestone(task);
        continue;
      }
      const completedAtMs = Number(task.completedAt || task.startedAt);
      if (now - completedAtMs > this.retentionMs) {
        this.removeTask(task.id);
      }
    }
  }
}
