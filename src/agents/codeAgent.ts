import type OpenAI from "openai";
import {
  buildCodeAgentSessionCliArgs,
  buildCodeAgentSessionTurnInput,
  parseClaudeCodeStreamOutput,
  normalizeClaudeCodeCliError,
  createClaudeCliStreamSession,
  type ClaudeCliStreamSessionLike
} from "../llm/llmClaudeCode.ts";
import {
  buildCodexCliCodeAgentArgs,
  normalizeCodexCliError,
  parseCodexCliJsonlOutput,
  runCodexCli
} from "../llm/llmCodexCli.ts";
import { runCodexTask } from "../llm/llmCodex.ts";
import type { SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";
import { CodexAgentSession, getActiveCodexAgentTaskCount } from "./codexAgent.ts";
import { CodexCliAgentSession, getActiveCodexCliAgentTaskCount } from "./codexCliAgent.ts";
import { clamp } from "../utils.ts";
import path from "node:path";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import {
  getDevTaskPermissions,
  getDevTeamRuntimeConfig,
  resolveAgentStack
} from "../settings/agentStack.ts";

interface CodeAgentTrace {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
}

export type CodeAgentProvider = "codex" | "codex-cli" | "auto";

const CODE_AGENT_PROVIDER_VALUES = new Set<CodeAgentProvider>(["codex", "codex-cli", "auto"]);

function normalizeCodeAgentProvider(value: unknown, fallback: CodeAgentProvider = "codex-cli"): CodeAgentProvider {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentProvider;
  if (CODE_AGENT_PROVIDER_VALUES.has(normalized)) return normalized;
  return fallback;
}

function resolveEffectiveCodeAgentProvider(provider: CodeAgentProvider): Exclude<CodeAgentProvider, "auto"> {
  if (provider === "codex") return "codex";
  return "codex-cli";
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
  codexCliModel: string;
  openai?: OpenAI | null;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
  signal?: AbortSignal;
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
  return activeTaskCount.current + getActiveCodexAgentTaskCount() + getActiveCodexCliAgentTaskCount();
}

export function isCodeAgentUserAllowed(userId: string, settings: Record<string, unknown>): boolean {
  const devPermissions = getDevTaskPermissions(settings);
  const devRuntime = getDevTeamRuntimeConfig(settings);
  if (!devRuntime.codex?.enabled && !devRuntime.codexCli?.enabled) return false;
  const allowedUserIds = devPermissions.allowedUserIds;
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
  codexCliModel: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  maxTasksPerHour: number;
  maxParallelTasks: number;
}

export function resolveCodeAgentConfig(settings: Record<string, unknown>, cwdOverride?: string): CodeAgentConfig {
  const resolvedStack = resolveAgentStack(settings);
  const devRuntime = getDevTeamRuntimeConfig(settings);
  const implementationProvider = String(resolvedStack.devTeam.roles.implementation.model?.provider || "").trim().toLowerCase();
  const preferredWorker =
    implementationProvider === "codex"
      ? "codex"
      : resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  const primaryWorkerConfig =
    preferredWorker === "codex"
      ? devRuntime.codex
      : devRuntime.codexCli;
  const cwd = cwdOverride || resolveCodeAgentCwd(
    String(primaryWorkerConfig?.defaultCwd || ""),
    process.cwd()
  );
  const provider = normalizeCodeAgentProvider(
    preferredWorker === "codex" ? "codex" : "codex-cli",
    "codex-cli"
  );
  const model = String(devRuntime.codexCli?.model || "gpt-5.4").trim();
  const codexModel = String(devRuntime.codex?.model || "codex-mini-latest").trim() || "codex-mini-latest";
  const codexCliModel = String(devRuntime.codexCli?.model || "gpt-5.4").trim() || "gpt-5.4";
  const maxTurns = clamp(Number(primaryWorkerConfig?.maxTurns) || 30, 1, 200);
  const timeoutMs = clamp(Number(primaryWorkerConfig?.timeoutMs) || 300_000, 10_000, 1_800_000);
  const maxBufferBytes = clamp(Number(primaryWorkerConfig?.maxBufferBytes) || 2 * 1024 * 1024, 4096, 10 * 1024 * 1024);
  const maxTasksPerHour = clamp(Number(primaryWorkerConfig?.maxTasksPerHour) || 10, 1, 500);
  const maxParallelTasks = clamp(Number(primaryWorkerConfig?.maxParallelTasks) || 2, 1, 32);
  return { cwd, provider, model, codexModel, codexCliModel, maxTurns, timeoutMs, maxBufferBytes, maxTasksPerHour, maxParallelTasks };
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
    codexCliModel,
    openai = null,
    trace,
    store,
    signal
  } = options;
  const resolvedProvider = resolveEffectiveCodeAgentProvider(provider);

  activeTaskCount.current++;
  const startMs = Date.now();

  try {
    throwIfAborted(signal, "Code agent cancelled");
    if (resolvedProvider === "codex") {
      if (!openai) {
        throw new Error("Codex code agent requires OPENAI_API_KEY.");
      }

      const response = await runCodexTask({
        openai,
        instruction,
        model: codexModel,
        timeoutMs,
        signal
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

    if (resolvedProvider === "codex-cli") {
      const args = buildCodexCliCodeAgentArgs({
        model: codexCliModel,
        cwd,
        instruction
      });
      const result = await runCodexCli({
        args,
        input: "",
        timeoutMs,
        maxBufferBytes,
        signal
      });
      const parsed = parseCodexCliJsonlOutput(result.stdout);
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
          provider: "codex-cli",
          configuredProvider: provider,
          model: codexCliModel,
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
    }

    throw new Error(`Unsupported code agent provider: ${resolvedProvider}`);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw createAbortError(signal?.reason || error);
    }
    const normalized = resolvedProvider === "codex-cli"
      ? normalizeCodexCliError(error, {
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
        model: resolvedProvider === "codex" ? codexModel : resolvedProvider === "codex-cli" ? codexCliModel : model,
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
  private activeAbortController: AbortController | null;

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
    this.activeAbortController = null;

    const args = buildCodeAgentSessionCliArgs({ model, maxTurns });
    this.streamSession = createClaudeCliStreamSession({
      args,
      maxBufferBytes,
      cwd
    });
  }

  async runTurn(input: string, options: { signal?: AbortSignal } = {}): Promise<SubAgentTurnResult> {
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

    const stdinPayload = buildCodeAgentSessionTurnInput(input);

    try {
      throwIfAborted(turnSignal, "Code agent session cancelled");
      activeTaskCount.current++;
      const result = await this.streamSession.run({
        input: stdinPayload,
        timeoutMs: this.timeoutMs,
        signal: turnSignal
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
      if (isAbortError(error) || turnSignal.aborted) {
        this.status = "cancelled";
        this.lastUsedAt = Date.now();
        throw createAbortError(turnSignal.reason || error);
      }
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
      this.activeAbortController = null;
      activeTaskCount.current = Math.max(0, activeTaskCount.current - 1);
    }
  }

  cancel(reason = "Code agent session cancelled"): void {
    if (this.status === "cancelled") return;
    this.status = "cancelled";
    try {
      this.activeAbortController?.abort(reason);
    } catch {
      // ignore
    }
    this.streamSession.close();
  }

  close(): void {
    this.cancel("Code agent session closed");
  }
}

export interface CreateCodeAgentSessionOptions {
  scopeKey: string;
  cwd: string;
  provider: CodeAgentProvider;
  model: string;
  codexModel: string;
  codexCliModel: string;
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
    codexCliModel,
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

  if (resolvedProvider === "codex-cli") {
    return new CodexCliAgentSession({
      scopeKey,
      cwd,
      model: codexCliModel,
      timeoutMs,
      maxBufferBytes,
      trace,
      store
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
