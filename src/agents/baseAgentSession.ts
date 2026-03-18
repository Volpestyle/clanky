import { createAbortError, isAbortError } from "../tools/browserTaskRuntime.ts";
import {
  EMPTY_USAGE,
  type SubAgentSession,
  type SubAgentTurnOptions,
  type SubAgentTurnResult
} from "./subAgentSession.ts";

type BaseAgentSessionOptions = {
  id: string;
  type: SubAgentSession["type"];
  ownerUserId: string | null;
  baseSignal?: AbortSignal;
  logAction?: (entry: {
    kind: string;
    userId?: string | null;
    content?: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export abstract class BaseAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type: SubAgentSession["type"];
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly baseSignal?: AbortSignal;
  private readonly logAction?: BaseAgentSessionOptions["logAction"];
  protected activeAbortController: AbortController | null;

  protected constructor(options: BaseAgentSessionOptions) {
    this.id = options.id;
    this.type = options.type;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = options.ownerUserId;
    this.status = "idle";
    this.baseSignal = options.baseSignal;
    this.logAction = options.logAction;
    this.activeAbortController = null;
  }

  async runTurn(input: string, options: SubAgentTurnOptions = {}): Promise<SubAgentTurnResult> {
    if (this.status === "cancelled" || this.status === "error" || this.status === "completed") {
      this.logLifecycle("turn_rejected", {
        reason: `session_${this.status}`,
        inputLength: String(input || "").length
      });
      return {
        text: `Session is ${this.status} and cannot accept new turns.`,
        costUsd: 0,
        isError: true,
        errorMessage: `Session ${this.status}`,
        sessionCompleted: this.status === "completed",
        usage: { ...EMPTY_USAGE }
      };
    }

    this.status = "running";
    this.lastUsedAt = Date.now();
    this.activeAbortController = new AbortController();
    const turnSignal = this.buildTurnSignal(options.signal);
    this.logLifecycle("turn_started", {
      inputLength: String(input || "").length
    });

    try {
      const result = await this.executeTurn(input, {
        ...options,
        signal: turnSignal
      });
      if (this.status === "running") {
        this.status = result.sessionCompleted ? "completed" : "idle";
      }
      this.lastUsedAt = Date.now();
      this.logLifecycle("turn_completed", {
        sessionCompleted: Boolean(result.sessionCompleted),
        isError: Boolean(result.isError),
        costUsd: result.costUsd
      });
      return result;
    } catch (error) {
      if (isAbortError(error) || turnSignal?.aborted) {
        this.status = "cancelled";
        this.lastUsedAt = Date.now();
        this.onCancelled(String(turnSignal?.reason || error || `${this.type} session cancelled`));
        this.logLifecycle("turn_cancelled", {
          reason: String(turnSignal?.reason || error || `${this.type} session cancelled`)
        });
        throw createAbortError(turnSignal?.reason || error);
      }

      this.status = "error";
      this.lastUsedAt = Date.now();
      this.logLifecycle("turn_failed", {
        error: String(error instanceof Error ? error.message : error || "Session turn failed.")
      });
      return this.handleTurnError(error, input);
    } finally {
      this.activeAbortController = null;
    }
  }

  cancel(reason = `${this.type} session cancelled`): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    try {
      this.activeAbortController?.abort(reason);
    } catch {
      // ignore
    }
    this.onCancelled(reason);
    this.logLifecycle("session_cancelled", { reason });
  }

  close(): void {
    const reason = `${this.type} session closed`;
    if (this.status === "idle" || this.status === "running") {
      this.cancel(reason);
    } else if (this.status !== "cancelled") {
      this.onCancelled(reason);
    }
    this.onClosed();
    this.logLifecycle("session_closed", { reason });
  }

  protected buildTurnSignal(signal?: AbortSignal): AbortSignal | undefined {
    const signals = [this.baseSignal, this.activeAbortController?.signal, signal]
      .filter((entry): entry is AbortSignal => Boolean(entry));
    if (signals.length <= 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  protected handleTurnError(error: unknown, _input: string): SubAgentTurnResult {
    const message = String(error instanceof Error ? error.message : error || "Session turn failed.");
    return {
      text: message,
      costUsd: 0,
      isError: true,
      errorMessage: message,
      usage: { ...EMPTY_USAGE }
    };
  }

  protected onCancelled(_reason: string): void {
    // subclasses can override
  }

  protected onClosed(): void {
    // subclasses can override
  }

  protected logLifecycle(content: string, metadata?: Record<string, unknown>): void {
    this.logAction?.({
      kind: "sub_agent_session_lifecycle",
      userId: this.ownerUserId || null,
      content,
      metadata: {
        sessionId: this.id,
        sessionType: this.type,
        status: this.status,
        ...(metadata || {})
      }
    });
  }

  protected abstract executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult>;
}
