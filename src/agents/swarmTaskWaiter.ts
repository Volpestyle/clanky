import { openSwarmDbConnection } from "./swarmDbConnection.ts";
import type { ClankyPeer, SwarmTask } from "./swarmPeer.ts";
import {
  EMPTY_USAGE,
  type SubAgentProgressEvent,
  type SubAgentTurnResult,
  type SubAgentUsage
} from "./subAgentSession.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_ACTIVITY_POLL_MS = 1000;

type SwarmTaskWaiterPeer = Pick<ClankyPeer, "getTask" | "waitForActivity" | "scope">;

export type SwarmTaskWaiterOptions = {
  dbPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: SubAgentProgressEvent) => void;
};

type ContextRow = {
  id: string;
  type: string;
  content: string;
  created_at: number;
};

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || "cancelled")));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || "cancelled")));
      },
      { once: true }
    );
  });
}

function normalizeUsage(raw: unknown): SubAgentUsage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_USAGE };
  const record = raw as Record<string, unknown>;
  return {
    inputTokens: Math.max(0, Number(record.inputTokens ?? record.input_tokens ?? 0) || 0),
    outputTokens: Math.max(0, Number(record.outputTokens ?? record.output_tokens ?? 0) || 0),
    cacheWriteTokens: Math.max(0, Number(record.cacheWriteTokens ?? record.cache_write_tokens ?? 0) || 0),
    cacheReadTokens: Math.max(0, Number(record.cacheReadTokens ?? record.cache_read_tokens ?? 0) || 0)
  };
}

function parseUsageAnnotation(content: string): { usage: SubAgentUsage; costUsd: number } {
  try {
    const parsed: unknown = JSON.parse(String(content || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { usage: { ...EMPTY_USAGE }, costUsd: 0 };
    }
    const record = parsed as Record<string, unknown>;
    const nestedUsage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? record.usage
      : record;
    return {
      usage: normalizeUsage(nestedUsage),
      costUsd: Math.max(0, Number(record.costUsd ?? record.cost_usd ?? 0) || 0)
    };
  } catch {
    return { usage: { ...EMPTY_USAGE }, costUsd: 0 };
  }
}

function readTaskContextRows({
  dbPath,
  scope,
  taskId,
  minCreatedAt = 0
}: {
  dbPath: string;
  scope: string;
  taskId: string;
  minCreatedAt?: number;
}) {
  const db = openSwarmDbConnection(dbPath);
  try {
    return db
      .query(
        `SELECT id, type, content, created_at
         FROM context
         WHERE scope = ?
           AND created_at >= ?
           AND (file = ? OR file LIKE ?)
         ORDER BY created_at ASC, id ASC`
      )
      .all(scope, minCreatedAt, taskId, `%/${taskId}`) as ContextRow[];
  } finally {
    db.close();
  }
}

function buildResultFromTask(task: SwarmTask, usage: SubAgentUsage, costUsd: number): SubAgentTurnResult {
  const text = String(task.result || "").trim();
  const isError = task.status === "failed" || task.status === "cancelled";
  const fallbackText =
    task.status === "cancelled"
      ? "Code task was cancelled."
      : task.status === "failed"
        ? "Code task failed."
        : "";
  return {
    text: text || fallbackText,
    costUsd,
    isError,
    errorMessage: isError ? (text || fallbackText) : "",
    sessionCompleted: true,
    usage
  };
}

export async function waitForTaskCompletion(
  peer: SwarmTaskWaiterPeer,
  taskId: string,
  opts: SwarmTaskWaiterOptions
): Promise<SubAgentTurnResult> {
  const timeoutMs = Math.max(1_000, Math.floor(Number(opts.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS)));
  const pollIntervalMs = Math.max(100, Math.floor(Number(opts.pollIntervalMs || DEFAULT_ACTIVITY_POLL_MS)));
  const deadline = Date.now() + timeoutMs;
  const seenProgressIds = new Set<string>();
  let lastContextCreatedAt = 0;
  let usage = { ...EMPTY_USAGE };
  let costUsd = 0;

  const consumeContextRows = () => {
    const rows = readTaskContextRows({
      dbPath: opts.dbPath,
      scope: peer.scope,
      taskId,
      minCreatedAt: lastContextCreatedAt
    });
    for (const row of rows) {
      lastContextCreatedAt = Math.max(lastContextCreatedAt, Number(row.created_at || 0));
      if (row.type === "usage") {
        const parsed = parseUsageAnnotation(row.content);
        usage = parsed.usage;
        costUsd = parsed.costUsd;
        continue;
      }
      if (row.type === "progress" && !seenProgressIds.has(row.id)) {
        seenProgressIds.add(row.id);
        opts.onProgress?.({
          kind: "swarm_progress",
          summary: String(row.content || "").trim(),
          timestamp: Date.now(),
          metadata: { taskId, annotationId: row.id }
        });
      }
    }
  };

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error(String(opts.signal.reason || "cancelled"));
    }

    consumeContextRows();
    const task = await peer.getTask(taskId);
    if (!task) {
      throw new Error(`Swarm task ${taskId} was not found.`);
    }
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      consumeContextRows();
      return buildResultFromTask(task, usage, costUsd);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const activity = await peer.waitForActivity({
      timeoutMs: Math.min(pollIntervalMs, remainingMs),
      pollIntervalMs: Math.min(200, pollIntervalMs)
    });
    if (!activity.changes.length) {
      await sleep(Math.min(50, remainingMs), opts.signal);
    }
  }

  const latestTask = await peer.getTask(taskId);
  return {
    text: `Code task timed out after ${Math.ceil(timeoutMs / 1000)}s.`,
    costUsd,
    isError: true,
    errorMessage: latestTask
      ? `Swarm task ${taskId} timed out while ${latestTask.status}.`
      : `Swarm task ${taskId} timed out and could not be read.`,
    sessionCompleted: true,
    usage
  };
}
