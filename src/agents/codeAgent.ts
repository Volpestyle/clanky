import type OpenAI from "openai";
import {
  buildCodeAgentSessionCliArgs,
  buildCodeAgentSessionTurnInput,
  parseClaudeCodeStreamOutput,
  normalizeClaudeCodeCliError,
  createClaudeCliStreamSession,
  type ClaudeCliStreamSessionLike
} from "../llm/llmClaudeCode.ts";
import { runCodexTask } from "../llm/llmCodex.ts";
import type { SubAgentRunTurnOptions, SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";
import { generateSessionId } from "./subAgentSession.ts";
import { CodexAgentSession, getActiveCodexAgentTaskCount } from "./codexAgent.ts";
import { CodexCliAgentSession, getActiveCodexCliAgentTaskCount } from "./codexCliAgent.ts";
import { provisionCodeAgentWorkspace, type CodeAgentWorkspaceLease } from "./codeAgentWorkspace.ts";
import { clamp } from "../utils.ts";
import { normalizeOpenAiOAuthModel } from "../llm/llmHelpers.ts";
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
  role?: CodeAgentRole | null;
}

type CodeAgentProvider = "codex" | "codex-cli" | "claude-code" | "auto";
export type CodeAgentRole = "design" | "implementation" | "review" | "research";

const CODE_AGENT_PROVIDER_VALUES = new Set<CodeAgentProvider>(["codex", "codex-cli", "claude-code", "auto"]);
const CODE_AGENT_ROLE_VALUES = new Set<CodeAgentRole>(["design", "implementation", "review", "research"]);

function normalizeCodeAgentProvider(value: unknown, fallback: CodeAgentProvider = "codex-cli"): CodeAgentProvider {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentProvider;
  if (CODE_AGENT_PROVIDER_VALUES.has(normalized)) return normalized;
  return fallback;
}

export function normalizeCodeAgentRole(value: unknown, fallback: CodeAgentRole = "implementation"): CodeAgentRole {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentRole;
  if (CODE_AGENT_ROLE_VALUES.has(normalized)) return normalized;
  return fallback;
}

function resolveEffectiveCodeAgentProvider(provider: CodeAgentProvider): Exclude<CodeAgentProvider, "auto"> {
  if (provider === "codex") return "codex";
  if (provider === "codex-cli") return "codex-cli";
  if (provider === "claude-code") return "claude-code";
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
  codexCostProvider?: "openai" | "openai-oauth";
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
  return activeTaskCount.current + getActiveCodexCliAgentTaskCount() + getActiveCodexAgentTaskCount();
}

export function isCodeAgentUserAllowed(userId: string, settings: Record<string, unknown>): boolean {
  const devPermissions = getDevTaskPermissions(settings);
  const devRuntime = getDevTeamRuntimeConfig(settings);
  if (!devRuntime.codex?.enabled && !devRuntime.codexCli?.enabled && !devRuntime.claudeCode?.enabled) return false;
  const allowedUserIds = devPermissions.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(String(userId || ""));
}

export function resolveCodeAgentCwd(settingsCwd: string, fallbackBaseDir: string): string {
  const raw = String(settingsCwd || "").trim();
  if (raw) return path.resolve(fallbackBaseDir, raw);
  return path.resolve(fallbackBaseDir);
}

interface CodeAgentConfig {
  role: CodeAgentRole;
  worker: "codex" | "codex_cli" | "claude_code";
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
  asyncDispatch: {
    enabled: boolean;
    thresholdMs: number;
    progressReports: {
      enabled: boolean;
      intervalMs: number;
      maxReportsPerTask: number;
    };
  };
}

function getPreferredWorkerForRole(
  resolvedStack: ReturnType<typeof resolveAgentStack>,
  role: CodeAgentRole
): "codex" | "codex_cli" | "claude_code" {
  if (role === "design") {
    return resolvedStack.devTeam.roles.design || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  if (role === "review") {
    return resolvedStack.devTeam.roles.review || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  if (role === "research") {
    return resolvedStack.devTeam.roles.research || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  return resolvedStack.devTeam.roles.implementation || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
}

export function resolveCodeAgentConfig(
  settings: Record<string, unknown>,
  cwdOverride?: string,
  requestedRole: CodeAgentRole = "implementation"
): CodeAgentConfig {
  const resolvedStack = resolveAgentStack(settings);
  const devRuntime = getDevTeamRuntimeConfig(settings);
  const role = normalizeCodeAgentRole(requestedRole);
  const preferredWorker = getPreferredWorkerForRole(resolvedStack, role);
  const primaryWorkerConfig =
    preferredWorker === "codex"
      ? devRuntime.codex
      : preferredWorker === "codex_cli"
        ? devRuntime.codexCli
      : devRuntime.claudeCode;
  const cwd = resolveCodeAgentCwd(
    String(cwdOverride || primaryWorkerConfig?.defaultCwd || ""),
    process.cwd()
  );
  const provider = normalizeCodeAgentProvider(
    preferredWorker === "codex"
      ? "codex"
      : preferredWorker === "codex_cli"
        ? "codex-cli"
        : "claude-code",
    "codex-cli"
  );
  const model = String(devRuntime.claudeCode?.model || "sonnet").trim();
  const codexModel = String(devRuntime.codex?.model || "gpt-5.4").trim() || "gpt-5.4";
  const codexCliModel = String(devRuntime.codexCli?.model || "gpt-5.4").trim() || "gpt-5.4";
  const maxTurns = clamp(Number(primaryWorkerConfig?.maxTurns) || 30, 1, 200);
  const timeoutMs = clamp(Number(primaryWorkerConfig?.timeoutMs) || 300_000, 10_000, 1_800_000);
  const maxBufferBytes = clamp(Number(primaryWorkerConfig?.maxBufferBytes) || 2 * 1024 * 1024, 4096, 10 * 1024 * 1024);
  const maxTasksPerHour = clamp(Number(primaryWorkerConfig?.maxTasksPerHour) || 10, 1, 500);
  const maxParallelTasks = clamp(Number(primaryWorkerConfig?.maxParallelTasks) || 2, 1, 32);
  const asyncDispatchEnabled = primaryWorkerConfig?.asyncDispatch?.enabled !== false;
  const asyncDispatchThresholdMs = clamp(
    Number(primaryWorkerConfig?.asyncDispatch?.thresholdMs) || 0,
    0,
    1_800_000
  );
  const asyncDispatchProgressEnabled = primaryWorkerConfig?.asyncDispatch?.progressReports?.enabled !== false;
  const asyncDispatchProgressIntervalMs = clamp(
    Number(primaryWorkerConfig?.asyncDispatch?.progressReports?.intervalMs) || 60_000,
    10_000,
    1_800_000
  );
  const asyncDispatchMaxReportsPerTask = clamp(
    Number(primaryWorkerConfig?.asyncDispatch?.progressReports?.maxReportsPerTask) || 5,
    0,
    20
  );
  return {
    role,
    worker: preferredWorker,
    cwd,
    provider,
    model,
    codexModel,
    codexCliModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    maxTasksPerHour,
    maxParallelTasks,
    asyncDispatch: {
      enabled: asyncDispatchEnabled,
      thresholdMs: asyncDispatchThresholdMs,
      progressReports: {
        enabled: asyncDispatchProgressEnabled,
        intervalMs: asyncDispatchProgressIntervalMs,
        maxReportsPerTask: asyncDispatchMaxReportsPerTask
      }
    }
  };
}

function resolveCodexAgentModel(model: string, costProvider: "openai" | "openai-oauth"): string {
  if (costProvider === "openai-oauth") {
    return normalizeOpenAiOAuthModel(model, "gpt-5.4");
  }
  return String(model || "").trim() || "gpt-5.4";
}

async function runLocalCodeAgentOnce({
  instruction,
  cwd,
  provider,
  maxTurns,
  timeoutMs,
  maxBufferBytes,
  model,
  codexCliModel,
  trace,
  store,
  signal
}: {
  instruction: string;
  cwd: string;
  provider: "claude-code" | "codex-cli";
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  model: string;
  codexCliModel: string;
  trace: CodeAgentTrace;
  store: {
    logAction: (entry: Record<string, unknown>) => void;
  };
  signal?: AbortSignal;
}): Promise<CodeAgentResult> {
  const workspace = provisionCodeAgentWorkspace({
    cwd,
    provider,
    scopeKey: `oneshot:${provider}:${trace.guildId || "dm"}:${trace.channelId || "dm"}`
  });
  const scopeKey = `oneshot:${provider}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  let session: SubAgentSession;
  try {
    session =
      provider === "codex-cli"
        ? new CodexCliAgentSession({
            scopeKey,
            cwd: workspace.cwd,
            model: codexCliModel,
            timeoutMs,
            maxBufferBytes,
            trace,
            store,
            workspace
          })
        : new CodeAgentSession({
            scopeKey,
            cwd: workspace.cwd,
            model,
            maxTurns,
            timeoutMs,
            maxBufferBytes,
            trace,
            store,
            workspace
          });
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
  try {
    const result = await session.runTurn(instruction, { signal });
    return {
      text: result.text,
      costUsd: result.costUsd,
      isError: result.isError,
      errorMessage: result.errorMessage,
      usage: result.usage
    };
  } finally {
    session.close();
  }
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
    codexCostProvider = "openai",
    trace,
    store,
    signal
  } = options;
  const resolvedProvider = resolveEffectiveCodeAgentProvider(provider);
  if (resolvedProvider === "claude-code" || resolvedProvider === "codex-cli") {
    return await runLocalCodeAgentOnce({
      instruction,
      cwd,
      provider: resolvedProvider,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      model,
      codexCliModel,
      trace,
      store,
      signal
    });
  }

  activeTaskCount.current++;
  const startMs = Date.now();
  try {
    throwIfAborted(signal, "Code agent cancelled");
    if (resolvedProvider === "codex") {
      if (!openai) {
        throw new Error("Codex code agent requires OPENAI_API_KEY or OPENAI_OAUTH_REFRESH_TOKEN.");
      }
      const resolvedCodexModel = resolveCodexAgentModel(codexModel, codexCostProvider);

      const response = await runCodexTask({
        openai,
        instruction,
        model: resolvedCodexModel,
        costProvider: codexCostProvider,
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
          model: resolvedCodexModel,
          authProvider: codexCostProvider,
          role: trace.role || "implementation",
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

    throw new Error(`Unsupported code agent provider: ${resolvedProvider}`);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw createAbortError(signal?.reason || error);
    }
    const normalized = {
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
        model:
          resolvedProvider === "codex"
            ? resolveCodexAgentModel(codexModel, codexCostProvider)
            : model,
        role: trace.role || "implementation",
        maxTurns,
        cwd,
        authProvider: resolvedProvider === "codex" ? codexCostProvider : undefined,
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

interface CodeAgentSessionOptions {
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
  workspace?: CodeAgentWorkspaceLease | null;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

class CodeAgentSession implements SubAgentSession {
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
  private readonly workspace: CodeAgentWorkspaceLease | null;
  private turnCount: number;
  private totalCostUsd: number;
  private activeAbortController: AbortController | null;
  private workspaceReleased: boolean;

  constructor(options: CodeAgentSessionOptions) {
    const { scopeKey, cwd, model, maxTurns, timeoutMs, maxBufferBytes, trace, store, workspace = null } = options;

    this.id = generateSessionId("code", scopeKey);
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.ownerUserId = trace.userId ?? null;
    this.status = "idle";
    this.timeoutMs = timeoutMs;
    this.trace = trace;
    this.store = store;
    this.workspace = workspace;
    this.turnCount = 0;
    this.totalCostUsd = 0;
    this.activeAbortController = null;
    this.workspaceReleased = false;

    const args = buildCodeAgentSessionCliArgs({ model, maxTurns });
    this.streamSession = createClaudeCliStreamSession({
      args,
      maxBufferBytes,
      cwd
    });
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

    const stdinPayload = buildCodeAgentSessionTurnInput(input);

    try {
      throwIfAborted(turnSignal, "Code agent session cancelled");
      activeTaskCount.current++;
      const result = await this.streamSession.run({
        input: stdinPayload,
        timeoutMs: this.timeoutMs,
        signal: turnSignal,
        onEvent: options.onProgress
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
          role: this.trace.role || "implementation",
          workspaceMode: this.workspace?.mode || null,
          workspaceBranch: this.workspace?.branch || null,
          workspaceBaseRef: this.workspace?.baseRef || null,
          workspaceRepoRoot: this.workspace?.repoRoot || null,
          workspaceCwd: this.workspace?.cwd || null,
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
        this.releaseWorkspace();
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
          role: this.trace.role || "implementation",
          workspaceMode: this.workspace?.mode || null,
          workspaceBranch: this.workspace?.branch || null,
          workspaceBaseRef: this.workspace?.baseRef || null,
          workspaceRepoRoot: this.workspace?.repoRoot || null,
          workspaceCwd: this.workspace?.cwd || null,
          isTimeout: normalized.isTimeout,
          errorMessage: normalized.message,
          source: this.trace.source,
          durationMs: Date.now() - turnStartMs
        }
      });
      this.releaseWorkspace();

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
    this.releaseWorkspace();
  }

  close(): void {
    this.cancel("Code agent session closed");
  }

  private releaseWorkspace() {
    if (this.workspaceReleased) return;
    this.workspaceReleased = true;
    this.workspace?.cleanup();
  }
}

interface CreateCodeAgentSessionOptions {
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
  codexCostProvider?: "openai" | "openai-oauth";
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
    openai = null,
    codexCostProvider = "openai"
  } = options;
  const resolvedProvider = resolveEffectiveCodeAgentProvider(provider);

  if (resolvedProvider === "codex") {
    if (!openai) {
      throw new Error("Codex code agent requires OPENAI_API_KEY or OPENAI_OAUTH_REFRESH_TOKEN.");
    }
    return new CodexAgentSession({
      scopeKey,
      model: resolveCodexAgentModel(codexModel, codexCostProvider),
      costProvider: codexCostProvider,
      timeoutMs,
      trace,
      store,
      openai
    });
  }

  if (resolvedProvider === "codex-cli") {
    const workspace = provisionCodeAgentWorkspace({
      cwd,
      provider: "codex-cli",
      scopeKey
    });
    try {
      return new CodexCliAgentSession({
        scopeKey,
        cwd: workspace.cwd,
        model: codexCliModel,
        timeoutMs,
        maxBufferBytes,
        trace,
        store,
        workspace
      });
    } catch (error) {
      workspace.cleanup();
      throw error;
    }
  }

  // claude-code: persistent multi-turn session via Claude CLI
  const workspace = provisionCodeAgentWorkspace({
    cwd,
    provider: "claude-code",
    scopeKey
  });
  try {
    return new CodeAgentSession({
      scopeKey,
      cwd: workspace.cwd,
      model,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      trace,
      store,
      workspace
    });
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}
