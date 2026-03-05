import type OpenAI from "openai";
import {
  runClaudeCli,
  buildCodeAgentCliArgs,
  buildCodeAgentSessionCliArgs,
  buildCodeAgentSessionTurnInput,
  parseClaudeCodeStreamOutput,
  normalizeClaudeCodeCliError,
  createClaudeCliStreamSession
} from "../llmClaudeCode.ts";
import { runCodexTask } from "../llmCodex.ts";
import type { ClaudeCliStreamSessionLike } from "../llmClaudeCode.ts";
import type { SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";
import { CodexAgentSession, getActiveCodexAgentTaskCount } from "./codexAgent.ts";
import { clamp } from "../utils.ts";
import path from "node:path";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

export type CodeAgentProvider = "claude-code" | "codex" | "auto";

const CODE_AGENT_PROVIDER_VALUES = new Set<CodeAgentProvider>(["claude-code", "codex", "auto"]);

function normalizeCodeAgentProvider(value: unknown, fallback: CodeAgentProvider = "claude-code"): CodeAgentProvider {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentProvider;
  if (CODE_AGENT_PROVIDER_VALUES.has(normalized)) return normalized;
  return fallback;
}

function resolveEffectiveCodeAgentProvider(provider: CodeAgentProvider): Exclude<CodeAgentProvider, "auto"> {
  return provider === "codex" ? "codex" : "claude-code";
}

interface CodeAgentOptions {
  instruction: string;
  cwd: string;
  provider: CodeAgentProvider;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  model: string;
  codexModel: string;
  openai?: OpenAI | null;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
}

interface CodeAgentResult {
  text: string;
  costUsd: number;
  isError: boolean;
  errorMessage: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}

const activeTaskCount = { current: 0 };

export function getActiveCodeAgentTaskCount(): number {
  return activeTaskCount.current + getActiveCodexAgentTaskCount();
}

export function isCodeAgentUserAllowed(userId: string, settings: Record<string, unknown>): boolean {
  const codeAgent = settings?.codeAgent as Record<string, unknown> | undefined;
  if (!codeAgent?.enabled) return false;
  const allowedUserIds = codeAgent?.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(String(userId || ""));
}

export function resolveCodeAgentCwd(settingsCwd: string, fallbackBaseDir: string): string {
  const raw = String(settingsCwd || "").trim();
  if (raw) return raw;
  // Default: "web" directory one level above the app root
  return path.resolve(fallbackBaseDir, "..", "web");
}

export interface CodeAgentConfig {
  cwd: string;
  provider: CodeAgentProvider;
  model: string;
  codexModel: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
}

export function resolveCodeAgentConfig(settings: Record<string, unknown>, cwdOverride?: string): CodeAgentConfig {
  const codeAgent = settings?.codeAgent as Record<string, unknown> | undefined;
  const cwd = cwdOverride || resolveCodeAgentCwd(
    String(codeAgent?.defaultCwd || ""),
    process.cwd()
  );
  const provider = normalizeCodeAgentProvider(codeAgent?.provider, "claude-code");
  const model = String(codeAgent?.model || "sonnet").trim();
  const codexModel = String(codeAgent?.codexModel || "codex-mini-latest").trim() || "codex-mini-latest";
  const maxTurns = clamp(Number(codeAgent?.maxTurns) || 30, 1, 200);
  const timeoutMs = clamp(Number(codeAgent?.timeoutMs) || 300_000, 10_000, 1_800_000);
  const maxBufferBytes = clamp(Number(codeAgent?.maxBufferBytes) || 2 * 1024 * 1024, 4096, 10 * 1024 * 1024);
  return { cwd, provider, model, codexModel, maxTurns, timeoutMs, maxBufferBytes };
}

export async function runCodeAgent(options: CodeAgentOptions): Promise<CodeAgentResult> {
  const {
    instruction,
    cwd,
    provider,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    model,
    codexModel,
    openai = null,
    trace,
    store
  } = options;
  const resolvedProvider = resolveEffectiveCodeAgentProvider(provider);

  activeTaskCount.current++;
  const startMs = Date.now();

  try {
    if (resolvedProvider === "codex") {
      if (!openai) {
        throw new Error("Codex code agent requires OPENAI_API_KEY.");
      }

      const response = await runCodexTask({
        openai,
        instruction,
        model: codexModel,
        timeoutMs
      });
      const text = response.text || (response.isError ? response.errorMessage : "Code agent completed with no output.");
      const agentResult: CodeAgentResult = {
        text,
        costUsd: response.costUsd,
        isError: response.isError,
        errorMessage: response.isError ? response.errorMessage : "",
        usage: response.usage
      };

      store.logAction({
        kind: "code_agent_call",
        guildId: trace.guildId || null,
        channelId: trace.channelId || null,
        userId: trace.userId || null,
        content: instruction.slice(0, 200),
        metadata: {
          provider: "codex",
          configuredProvider: provider,
          model: codexModel,
          maxTurns,
          cwd,
          status: response.status,
          responseId: response.responseId || null,
          isError: agentResult.isError,
          usage: agentResult.usage,
          source: trace.source,
          durationMs: Date.now() - startMs
        },
        usdCost: agentResult.costUsd
      });

      return agentResult;
    }

    const args = buildCodeAgentCliArgs({
      model,
      maxTurns,
      instruction
    });
    const result = await runClaudeCli({
      args,
      input: "",
      timeoutMs,
      maxBufferBytes,
      cwd
    });
    const parsed = parseClaudeCodeStreamOutput(result.stdout);
    const agentResult: CodeAgentResult = parsed
      ? {
          text: parsed.text,
          costUsd: parsed.costUsd,
          isError: parsed.isError,
          errorMessage: parsed.isError ? parsed.errorMessage : "",
          usage: parsed.usage
        }
      : {
          text: result.stdout.slice(0, 2000) || "Code agent completed with no parseable output.",
          costUsd: 0,
          isError: false,
          errorMessage: "",
          usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
        };

    store.logAction({
      kind: "code_agent_call",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: instruction.slice(0, 200),
      metadata: {
        provider: "claude-code",
        configuredProvider: provider,
        model,
        maxTurns,
        cwd,
        isError: agentResult.isError,
        usage: agentResult.usage,
        source: trace.source,
        durationMs: Date.now() - startMs
      },
      usdCost: agentResult.costUsd
    });

    return agentResult;
  } catch (error) {
    const normalized = resolvedProvider === "claude-code"
      ? normalizeClaudeCodeCliError(error, {
          timeoutPrefix: "Code agent timed out",
          timeoutMs
        })
      : {
          isTimeout: /\btimed out\b/i.test(String((error as Error)?.message || "")),
          message: String((error as Error)?.message || "Code agent failed.")
        };

    store.logAction({
      kind: "code_agent_error",
      guildId: trace.guildId || null,
      channelId: trace.channelId || null,
      userId: trace.userId || null,
      content: instruction.slice(0, 200),
      metadata: {
        provider: resolvedProvider,
        configuredProvider: provider,
        model: resolvedProvider === "codex" ? codexModel : model,
        maxTurns,
        cwd,
        isTimeout: normalized.isTimeout,
        errorMessage: normalized.message,
        source: trace.source,
        durationMs: Date.now() - startMs
      }
    });

    return {
      text: normalized.message,
      costUsd: 0,
      isError: true,
      errorMessage: normalized.message,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
    };
  } finally {
    activeTaskCount.current = Math.max(0, activeTaskCount.current - 1);
  }
}

// ---------------------------------------------------------------------------
// CodeAgentSession — persistent multi-turn wrapper around ClaudeCliStreamSession
// ---------------------------------------------------------------------------

export interface CodeAgentSessionOptions {
  scopeKey: string;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

export class CodeAgentSession implements SubAgentSession {
  readonly id: string;
  readonly type = "code" as const;
  readonly createdAt: number;
  readonly ownerUserId: string | null;
  lastUsedAt: number;
  status: SubAgentSession["status"];

  private readonly streamSession: ClaudeCliStreamSessionLike;
  private readonly timeoutMs: number;
  private readonly trace: CodeAgentTrace;
  private readonly store: { logAction: (entry: Record<string, unknown>) => void };
  private turnCount: number;
  private totalCostUsd: number;

  constructor(options: CodeAgentSessionOptions) {
    const { scopeKey, cwd, model, maxTurns, timeoutMs, maxBufferBytes, trace, store } = options;

    this.id = generateSessionId("code", scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = trace.userId ?? null;
    this.status = "idle";
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.turnCount = 0;
    this.totalCostUsd = 0;

    const args = buildCodeAgentSessionCliArgs({ model, maxTurns });
    this.streamSession = createClaudeCliStreamSession({
      args,
      maxBufferBytes,
      cwd
    });
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

    const stdinPayload = buildCodeAgentSessionTurnInput(input);

    try {
      activeTaskCount.current++;
      const result = await this.streamSession.run({
        input: stdinPayload,
        timeoutMs: this.timeoutMs
      });

      const parsed = parseClaudeCodeStreamOutput(result.stdout);
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

      this.totalCostUsd += turnResult.costUsd;
      this.status = "idle";
      this.lastUsedAt = Date.now();

      this.store.logAction({
        kind: "code_agent_call",
        guildId: this.trace.guildId || null,
        channelId: this.trace.channelId || null,
        userId: this.trace.userId || null,
        content: input.slice(0, 200),
        metadata: {
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
      const normalized = normalizeClaudeCodeCliError(error, {
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
      activeTaskCount.current = Math.max(0, activeTaskCount.current - 1);
    }
  }

  close(): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    this.streamSession.close();
  }
}

export interface CreateCodeAgentSessionOptions {
  scopeKey: string;
  cwd: string;
  provider: CodeAgentProvider;
  model: string;
  codexModel: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
  openai?: OpenAI | null;
}

export function createCodeAgentSession(options: CreateCodeAgentSessionOptions): SubAgentSession {
  const {
    scopeKey,
    cwd,
    provider,
    model,
    codexModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    trace,
    store,
    openai = null
  } = options;
  const resolvedProvider = resolveEffectiveCodeAgentProvider(provider);

  if (resolvedProvider === "codex") {
    if (!openai) {
      throw new Error("Codex code agent requires OPENAI_API_KEY.");
    }
    return new CodexAgentSession({
      scopeKey,
      model: codexModel,
      timeoutMs,
      trace,
      store,
      openai
    });
  }

  return new CodeAgentSession({
    scopeKey,
    cwd,
    model,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    trace,
    store
  });
}
