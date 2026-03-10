import type { ImageInput } from "../llm/serviceShared.ts";
import { runBrowseAgent } from "../agents/browseAgent.ts";
import type { LLMService } from "../llm.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";

type BrowserTaskActionEntry = {
  kind: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  content?: string;
  metadata?: Record<string, unknown>;
  usdCost?: number;
};

export type BrowserTaskTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type BrowserTaskStore = {
  logAction: (entry: BrowserTaskActionEntry) => void;
};

export type BrowserBrowseTaskOptions = {
  llm: LLMService;
  browserManager: BrowserManager;
  store: BrowserTaskStore;
  sessionKey: string;
  instruction: string;
  provider: string;
  model: string;
  maxSteps: number;
  stepTimeoutMs: number;
  trace: BrowserTaskTrace;
  logSource?: string | null;
  signal?: AbortSignal;
};

export type BrowserBrowseTaskResult = {
  text: string;
  steps: number;
  totalCostUsd: number;
  hitStepLimit: boolean;
  imageInputs?: ImageInput[];
};

export type ActiveBrowserTask = {
  taskId: string;
  scopeKey: string;
  abortController: AbortController;
};

let browserTaskCounter = 0;

function normalizeAbortReason(reason: unknown, fallbackMessage: string) {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error) {
    const message = String(reason.message || "").trim();
    if (message) return message;
  }
  return fallbackMessage;
}

export function createAbortError(reason: unknown = "Browser task cancelled") {
  const error = new Error(`AbortError: ${normalizeAbortReason(reason, "Browser task cancelled")}`);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown) {
  if (!error) return false;
  const name = String((error as { name?: unknown }).name || "").trim();
  if (name === "AbortError") return true;

  const code = String((error as { code?: unknown }).code || "").trim().toUpperCase();
  if (code === "ABORT_ERR") return true;

  const message = String((error as { message?: unknown }).message || "").toLowerCase();
  return (
    message.includes("aborterror") ||
    message.includes("aborted") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

export function throwIfAborted(signal?: AbortSignal, fallbackReason = "Browser task cancelled"): void {
  if (!signal?.aborted) return;
  throw createAbortError(signal.reason || fallbackReason);
}

export function buildBrowserTaskScopeKey({
  guildId,
  channelId
}: {
  guildId?: string | null;
  channelId?: string | null;
}) {
  const normalizedGuildId = String(guildId || "dm").trim() || "dm";
  const normalizedChannelId = String(channelId || "dm").trim() || "dm";
  return `browser:${normalizedGuildId}:${normalizedChannelId}`;
}

export class BrowserTaskRegistry {
  private readonly tasksByScope = new Map<string, ActiveBrowserTask>();

  beginTask(scopeKey: string) {
    const normalizedScopeKey = String(scopeKey || "").trim();
    if (!normalizedScopeKey) {
      throw new Error("missing_browser_task_scope_key");
    }

    const existingTask = this.tasksByScope.get(normalizedScopeKey);
    if (existingTask) {
      existingTask.abortController.abort("Superseded by a newer browser task in the same channel");
    }

    browserTaskCounter += 1;
    const task: ActiveBrowserTask = {
      taskId: `${normalizedScopeKey}:${Date.now()}:${browserTaskCounter}`,
      scopeKey: normalizedScopeKey,
      abortController: new AbortController()
    };
    this.tasksByScope.set(normalizedScopeKey, task);
    return task;
  }

  get(scopeKey: string) {
    return this.tasksByScope.get(String(scopeKey || "").trim());
  }

  abort(scopeKey: string, reason = "Browser task cancelled by user") {
    const task = this.get(scopeKey);
    if (!task) return false;
    task.abortController.abort(reason);
    this.tasksByScope.delete(task.scopeKey);
    return true;
  }

  clear(task: ActiveBrowserTask | null | undefined) {
    if (!task) return;
    const currentTask = this.tasksByScope.get(task.scopeKey);
    if (!currentTask) return;
    if (currentTask.taskId !== task.taskId) return;
    this.tasksByScope.delete(task.scopeKey);
  }
}

export async function runBrowserBrowseTask({
  llm,
  browserManager,
  store,
  sessionKey,
  instruction,
  provider,
  model,
  maxSteps,
  stepTimeoutMs,
  trace,
  logSource,
  signal
}: BrowserBrowseTaskOptions): Promise<BrowserBrowseTaskResult> {
  throwIfAborted(signal);

  try {
    const result = await runBrowseAgent({
      llm,
      browserManager,
      store,
      sessionKey,
      instruction,
      provider,
      model,
      maxSteps,
      stepTimeoutMs,
      trace,
      signal
    });

    store.logAction({
      kind: "browser_browse_call",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: instruction.slice(0, 200),
      metadata: {
        steps: result.steps,
        hitStepLimit: result.hitStepLimit,
        imageInputCount: Array.isArray(result.imageInputs) ? result.imageInputs.length : 0,
        totalCostUsd: result.totalCostUsd,
        source: logSource ?? trace.source ?? null
      },
      usdCost: result.totalCostUsd
    });

    return result;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw createAbortError(signal?.reason || error);
    }
    throw error;
  }
}
