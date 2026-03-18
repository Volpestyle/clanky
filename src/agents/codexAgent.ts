import type OpenAI from "openai";
import { runCodexSessionTurn } from "../llm/llmCodex.ts";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import type { SubAgentRunTurnOptions, SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
const activeCodexTaskCount = { current: 0 };

export function getActiveCodexAgentTaskCount(): number {
  return activeCodexTaskCount.current;
}

interface CodexAgentSessionOptions {
  scopeKey: string;
  model: string;
  costProvider?: string;
  timeoutMs: number;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
  openai: OpenAI;
}

export class CodexAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type = "code" as const;
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly model: string;
  private readonly costProvider: string;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private readonly openai: OpenAI;
  private turnCount: number;
  private previousResponseId: string;
  private activeAbortController: AbortController | null;

  constructor(options: CodexAgentSessionOptions) {
    const { scopeKey, model, costProvider = "openai", timeoutMs, trace, store, openai } = options;

    this.id = generateSessionId("code", scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = trace.userId ?? null;
    this.status = "idle";
    this.model = String(model || "").trim();
    this.costProvider = String(costProvider || "openai").trim() || "openai";
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.openai = openai;
    this.turnCount = 0;
    this.previousResponseId = "";
    this.activeAbortController = null;
  }

  async runTurn(input: string, options: SubAgentRunTurnOptions = {}): Promise<SubAgentTurnResult> {
    if (this.status === "cancelled" || this.status === "error") {
      return {
        text: `Session is ${this.status} and cannot accept new turns.`,
        costUsd: 0,
        isError: true,
        errorMessage: `Session ${this.status}`,
        usage: { ...EMPTY_USAGE }
      };
    }

    this.status = "running";
    this.lastUsedAt = Date.now();
    this.turnCount += 1;
    const turnStartMs = Date.now();
    this.activeAbortController = new AbortController();
    const turnSignal = options.signal
      ? AbortSignal.any([this.activeAbortController.signal, options.signal])
      : this.activeAbortController.signal;

    try {
      throwIfAborted(turnSignal, "Codex session cancelled");
      activeCodexTaskCount.current += 1;
      const response = await runCodexSessionTurn({
        openai: this.openai,
        previousResponseId: this.previousResponseId || null,
        input,
        model: this.model,
        costProvider: this.costProvider,
        timeoutMs: this.timeoutMs,
        signal: turnSignal,
        onProgress: options.onProgress
      });
      this.previousResponseId = response.responseId || this.previousResponseId;
      this.status = "idle";
      this.lastUsedAt = Date.now();

      const turnResult: SubAgentTurnResult = {
        text: response.text || (response.isError ? response.errorMessage : "Code agent turn completed with no output."),
        costUsd: response.costUsd,
        isError: response.isError,
        errorMessage: response.isError ? response.errorMessage : "",
        usage: response.usage || { ...EMPTY_USAGE }
      };

      this.store.logAction({
        kind: "code_agent_call",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
          provider: "codex",
          model: this.model,
          sessionId: this.id,
          turnNumber: this.turnCount,
          status: response.status,
          responseId: response.responseId || null,
          isError: turnResult.isError,
          usage: turnResult.usage,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
        },
        usdCost: turnResult.costUsd
      });

      return turnResult;
    } catch (error) {
      if (isAbortError(error) || turnSignal.aborted) {
        this.status = "cancelled";
        this.lastUsedAt = Date.now();
        throw createAbortError(turnSignal.reason || error);
      }
      const message = String(error instanceof Error ? error.message : error || "Codex session turn failed.");
      this.status = "error";
      this.lastUsedAt = Date.now();

      this.store.logAction({
        kind: "code_agent_error",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
          provider: "codex",
          model: this.model,
          sessionId: this.id,
          turnNumber: this.turnCount,
          errorMessage: message,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
        }
      });

      return {
        text: message,
        costUsd: 0,
        isError: true,
        errorMessage: message,
        usage: { ...EMPTY_USAGE }
      };
    } finally {
      this.activeAbortController = null;
      activeCodexTaskCount.current = Math.max(0, activeCodexTaskCount.current - 1);
    }
  }

  cancel(reason = "Codex session cancelled"): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    try {
      this.activeAbortController?.abort(reason);
    } catch {
      // ignore
    }
  }

  close(): void {
    this.cancel("Codex session closed");
  }
}
