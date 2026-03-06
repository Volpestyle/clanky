import { createCodexCliStreamSession, type CodexCliStreamSessionLike, normalizeCodexCliError, parseCodexCliJsonlOutput } from "../llm/llmCodexCli.ts";
import type { SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
const activeCodexCliTaskCount = { current: 0 };

export function getActiveCodexCliAgentTaskCount(): number {
  return activeCodexCliTaskCount.current;
}

export interface CodexCliAgentSessionOptions {
  scopeKey: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxBufferBytes: number;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
}

export class CodexCliAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type = "code" as const;
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly streamSession: CodexCliStreamSessionLike;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private turnCount: number;

  constructor(options: CodexCliAgentSessionOptions) {
    const { scopeKey, cwd, model, timeoutMs, maxBufferBytes, trace, store } = options;
    this.id = generateSessionId("code", scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = trace.userId ?? null;
    this.status = "idle";
    this.model = String(model || "").trim();
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.turnCount = 0;
    this.streamSession = createCodexCliStreamSession({ model: this.model, maxBufferBytes, cwd });
  }

  async runTurn(input: string): Promise<SubAgentTurnResult> {
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

    try {
      activeCodexCliTaskCount.current += 1;
      const result = await this.streamSession.run({
        input,
        timeoutMs: this.timeoutMs
      });
      const parsed = parseCodexCliJsonlOutput(result.stdout);
      const turnResult: SubAgentTurnResult = parsed
        ? {
            text: parsed.text,
            costUsd: parsed.costUsd,
            isError: parsed.isError,
            errorMessage: parsed.isError ? parsed.errorMessage : "",
            usage: parsed.usage
          }
        : {
            text: result.stdout.slice(0, 2000) || "Code agent turn completed with no parseable output.",
            costUsd: 0,
            isError: false,
            errorMessage: "",
            usage: { ...EMPTY_USAGE }
          };

      this.status = "idle";
      this.lastUsedAt = Date.now();
      this.store.logAction({
        kind: "code_agent_call",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
          provider: "codex-cli",
          model: this.model,
          sessionId: this.id,
          turnNumber: this.turnCount,
          isError: turnResult.isError,
          usage: turnResult.usage,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
        },
        usdCost: turnResult.costUsd
      });
      return turnResult;
    } catch (error) {
      const normalized = normalizeCodexCliError(error, {
        timeoutPrefix: "Code agent session turn timed out",
        timeoutMs: this.timeoutMs
      });
      this.status = "error";
      this.lastUsedAt = Date.now();
      this.store.logAction({
        kind: "code_agent_error",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
          provider: "codex-cli",
          model: this.model,
          sessionId: this.id,
          turnNumber: this.turnCount,
          isTimeout: normalized.isTimeout,
          errorMessage: normalized.message,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
        }
      });
      return {
        text: normalized.message,
        costUsd: 0,
        isError: true,
        errorMessage: normalized.message,
        usage: { ...EMPTY_USAGE }
      };
    } finally {
      activeCodexCliTaskCount.current = Math.max(0, activeCodexCliTaskCount.current - 1);
    }
  }

  close(): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    this.streamSession.close();
  }
}
