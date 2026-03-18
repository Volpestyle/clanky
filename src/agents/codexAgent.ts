import type OpenAI from "openai";
import { runCodexSessionTurn } from "../llm/llmCodex.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";
import { BaseAgentSession } from "./baseAgentSession.ts";
import type { SubAgentTurnOptions, SubAgentTurnResult } from "./subAgentSession.ts";
import { EMPTY_USAGE, generateSessionId } from "./subAgentSession.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

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

export class CodexAgentSession extends BaseAgentSession {
  private readonly model: string;
  private readonly costProvider: string;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private readonly openai: OpenAI;
  private turnCount: number;
  private previousResponseId: string;
  private lastTurnInput: string;
  private lastTurnStartedAtMs: number;

  constructor(options: CodexAgentSessionOptions) {
    const { scopeKey, model, costProvider = "openai", timeoutMs, trace, store, openai } = options;
    super({
      id: generateSessionId("code", scopeKey),
      type: "code",
      ownerUserId: trace.userId ?? null,
      logAction: store.logAction
    });
    this.model = String(model || "").trim();
    this.costProvider = String(costProvider || "openai").trim() || "openai";
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.openai = openai;
    this.turnCount = 0;
    this.previousResponseId = "";
    this.lastTurnInput = "";
    this.lastTurnStartedAtMs = 0;
  }

  protected async executeTurn(input: string, options: SubAgentTurnOptions): Promise<SubAgentTurnResult> {
    this.turnCount += 1;
    this.lastTurnInput = String(input || "");
    this.lastTurnStartedAtMs = Date.now();
    const turnSignal = options.signal;

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
        signal: turnSignal
      });
      this.previousResponseId = response.responseId || this.previousResponseId;

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
          durationMs: Date.now() - this.lastTurnStartedAtMs
        },
        usdCost: turnResult.costUsd
      });

      return turnResult;
    } finally {
      activeCodexTaskCount.current = Math.max(0, activeCodexTaskCount.current - 1);
    }
  }

  protected handleTurnError(error: unknown, _input: string): SubAgentTurnResult {
    const message = String(error instanceof Error ? error.message : error || "Codex session turn failed.");
    this.store.logAction({
      kind: "code_agent_error",
      guildId: this.trace.guildId || null,
      channelId: this.trace.channelId || null,
      userId: this.trace.userId || null,
      content: this.lastTurnInput.slice(0, 200),
      metadata: {
        provider: "codex",
        model: this.model,
        sessionId: this.id,
        turnNumber: this.turnCount,
        errorMessage: message,
        source: this.trace.source,
        durationMs: Date.now() - this.lastTurnStartedAtMs
      }
    });
    return {
      text: message,
      costUsd: 0,
      isError: true,
      errorMessage: message,
      usage: { ...EMPTY_USAGE }
    };
  }
}
