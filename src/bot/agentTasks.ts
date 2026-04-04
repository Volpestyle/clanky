import {
  type CodeAgentRole,
  createCodeAgentSession as createCodeAgentSessionRuntime,
  getActiveCodeAgentTaskCount,
  isCodeAgentUserAllowed,
  normalizeCodeAgentRole,
  resolveCodeAgentConfig,
  runCodeAgent
} from "../agents/codeAgent.ts";
import { BrowserAgentSession } from "../agents/browseAgent.ts";
import { runOpenAiComputerUseTask } from "../tools/openAiComputerUseRuntime.ts";
import {
  buildBrowserTaskScopeKey,
  isAbortError,
  runBrowserBrowseTask
} from "../tools/browserTaskRuntime.ts";
import { clamp } from "../utils.ts";
import { MAX_BROWSER_BROWSE_QUERY_LEN, normalizeDirectiveText } from "./botHelpers.ts";
import { getResolvedBrowserTaskConfig, isDevTaskEnabled, isMinecraftEnabled, getMinecraftConfig } from "../settings/agentStack.ts";
import { createMinecraftSession as createMinecraftSessionRuntime } from "../agents/minecraft/minecraftSession.ts";
import type { BrowserBrowseContextState } from "./budgetTracking.ts";
import type { AgentContext } from "./botContext.ts";

type AgentTaskTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
  role?: CodeAgentRole | null;
};

type RunModelRequestedBrowserBrowseOptions = {
  settings: Record<string, unknown>;
  browserBrowse: BrowserBrowseContextState;
  query?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
  signal?: AbortSignal;
};

type BrowserBrowseState = BrowserBrowseContextState;

type RunModelRequestedCodeTaskOptions = {
  settings: Record<string, unknown>;
  task?: string;
  role?: CodeAgentRole;
  cwd?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
  signal?: AbortSignal;
};

type CreateCodeAgentSessionOptions = {
  settings: Record<string, unknown>;
  role?: CodeAgentRole;
  cwd?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

type CreateBrowserAgentSessionOptions = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

function buildCodeAgentBudgetWindowStart() {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

function buildScopeKey({
  guildId,
  channelId
}: {
  guildId?: string | null;
  channelId?: string | null;
}) {
  return `${guildId || "dm"}:${channelId || "dm"}`;
}

function buildTrace({
  guildId,
  channelId = null,
  userId = null,
  source = null
}: AgentTaskTrace = {}) {
  return {
    guildId,
    channelId,
    userId,
    source
  };
}

export async function runModelRequestedBrowserBrowse(
  ctx: AgentContext,
  {
    settings,
    browserBrowse,
    query,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_message",
    signal
  }: RunModelRequestedBrowserBrowseOptions
) {
  const normalizedQuery = normalizeDirectiveText(query, MAX_BROWSER_BROWSE_QUERY_LEN);
  const state: BrowserBrowseState = {
    ...browserBrowse,
    requested: true,
    used: false,
    blockedByBudget: false,
    query: normalizedQuery,
    text: "",
    imageInputs: [],
    steps: 0,
    hitStepLimit: false,
    error: null
  };

  if (!state.enabled || !state.configured || !ctx.browserManager) {
    return state;
  }
  if (!state.budget?.canBrowse) {
    return {
      ...state,
      blockedByBudget: true
    };
  }
  if (!normalizedQuery) {
    return {
      ...state,
      error: "Missing browser browse query."
    };
  }
  if (!ctx.llm) {
    return {
      ...state,
      error: "llm_unavailable"
    };
  }

  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  const maxSteps = clamp(Number(browserTaskConfig.maxStepsPerTask) || 15, 1, 30);
  const stepTimeoutMs = clamp(Number(browserTaskConfig.stepTimeoutMs) || 30_000, 5_000, 120_000);
  const computerUseClient =
    browserTaskConfig.runtime === "openai_computer_use"
      ? ctx.llm.getComputerUseClient(browserTaskConfig.openaiComputerUse.client)
      : null;
  if (browserTaskConfig.runtime === "openai_computer_use" && !computerUseClient?.client) {
    return {
      ...state,
      error: "openai_computer_use_unavailable"
    };
  }

  const scopeKey = buildBrowserTaskScopeKey({
    guildId,
    channelId
  });
  const activeBrowserTask = ctx.activeBrowserTasks.beginTask(scopeKey);
  const taskSignal = signal
    ? AbortSignal.any([activeBrowserTask.abortController.signal, signal])
    : activeBrowserTask.abortController.signal;

  try {
    const sessionKey = `reply:${activeBrowserTask.taskId}`;
    const trace = buildTrace({
      guildId,
      channelId,
      userId,
      source: `${source}_browser_browse`
    });
    const result =
      browserTaskConfig.runtime === "openai_computer_use"
        ? await runOpenAiComputerUseTask({
            openai: computerUseClient.client,
            provider: computerUseClient.provider || "openai",
            browserManager: ctx.browserManager,
            store: ctx.store,
            sessionKey,
            instruction: normalizedQuery,
            model: browserTaskConfig.openaiComputerUse.model,
            headed: browserTaskConfig.headed,
            profile: browserTaskConfig.profile || undefined,
            maxSteps,
            stepTimeoutMs,
            sessionTimeoutMs: browserTaskConfig.sessionTimeoutMs,
            trace,
            logSource: source,
            signal: taskSignal
          })
        : await runBrowserBrowseTask({
            llm: ctx.llm,
            browserManager: ctx.browserManager,
            store: ctx.store,
            sessionKey,
            instruction: normalizedQuery,
            provider: browserTaskConfig.localAgent.provider,
            model: browserTaskConfig.localAgent.model,
            headed: browserTaskConfig.headed,
            profile: browserTaskConfig.profile || undefined,
            maxSteps,
            stepTimeoutMs,
            sessionTimeoutMs: browserTaskConfig.sessionTimeoutMs,
            trace,
            logSource: source,
            signal: taskSignal
          });

    return {
      ...state,
      used: true,
      text: result.text,
      imageInputs: Array.isArray(result.imageInputs) ? result.imageInputs : [],
      steps: result.steps,
      hitStepLimit: result.hitStepLimit
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ...state,
        cancelled: true,
        error: "Browser session cancelled by user."
      };
    }
    return {
      ...state,
      cancelled: false,
      error: String(error?.message || error)
    };
  } finally {
    ctx.activeBrowserTasks.clear(activeBrowserTask);
  }
}

export async function runModelRequestedCodeTask(
  ctx: AgentContext,
  {
    settings,
    task,
    role = "implementation",
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_message",
    signal
  }: RunModelRequestedCodeTaskOptions
) {
  if (!isDevTaskEnabled(settings)) {
    return { text: "", error: "code_agent_disabled" };
  }
  if (userId && !isCodeAgentUserAllowed(userId, settings)) {
    return { text: "", blockedByPermission: true };
  }

  const normalizedRole = normalizeCodeAgentRole(role);
  const codeAgentConfig = resolveCodeAgentConfig(settings, cwdOverride, normalizedRole);
  const maxParallel = codeAgentConfig.maxParallelTasks;
  if (getActiveCodeAgentTaskCount() >= maxParallel) {
    return { text: "", blockedByParallelLimit: true };
  }

  const maxPerHour = codeAgentConfig.maxTasksPerHour;
  const used = ctx.store.countActionsSince("code_agent_call", buildCodeAgentBudgetWindowStart());
  if (used >= maxPerHour) {
    return { text: "", blockedByBudget: true };
  }

  const {
    cwd,
    swarm,
    workspaceMode,
    provider,
    model,
    codexCliModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes
  } = codeAgentConfig;

  try {
    const result = await runCodeAgent({
      instruction: task,
      cwd,
      swarm,
      workspaceMode,
      provider,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      model,
      codexCliModel,
      trace: buildTrace({
        guildId,
        channelId,
        userId,
        source,
        role: normalizedRole
      }),
      store: ctx.store,
      signal
    });

    return {
      text: result.text,
      isError: result.isError,
      costUsd: result.costUsd,
      error: result.isError ? result.errorMessage : null
    };
  } catch (error) {
    return {
      text: "",
      error: String(error?.message || error)
    };
  }
}

export function createCodeAgentSession(
  ctx: AgentContext,
  {
    settings,
    role = "implementation",
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }: CreateCodeAgentSessionOptions
) {
  if (!isDevTaskEnabled(settings)) return null;
  if (userId && !isCodeAgentUserAllowed(userId, settings)) return null;

  const normalizedRole = normalizeCodeAgentRole(role);
  const codeAgentConfig = resolveCodeAgentConfig(settings, cwdOverride, normalizedRole);
  const maxParallel = codeAgentConfig.maxParallelTasks;
  if (getActiveCodeAgentTaskCount() >= maxParallel) return null;

  const maxPerHour = codeAgentConfig.maxTasksPerHour;
  const used = ctx.store.countActionsSince("code_agent_call", buildCodeAgentBudgetWindowStart());
  if (used >= maxPerHour) return null;

  const {
    cwd,
    swarm,
    workspaceMode,
    provider,
    model,
    codexCliModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes
  } = codeAgentConfig;

  const scopeKey = buildScopeKey({
    guildId,
    channelId
  });
  try {
    return createCodeAgentSessionRuntime({
      scopeKey,
      cwd,
      swarm,
      workspaceMode,
      provider,
      model,
      codexCliModel,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      trace: buildTrace({
        guildId,
        channelId,
        userId,
        source,
        role: normalizedRole
      }),
      store: ctx.store
    });
  } catch {
    return null;
  }
}

function createBrowserAgentSession(
  ctx: AgentContext,
  {
    settings,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }: CreateBrowserAgentSessionOptions
) {
  if (!ctx.browserManager) return null;
  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  if (browserTaskConfig.runtime === "openai_computer_use") return null;
  const maxSteps = clamp(Number(browserTaskConfig.maxStepsPerTask) || 15, 1, 30);
  const stepTimeoutMs = clamp(Number(browserTaskConfig.stepTimeoutMs) || 30_000, 5_000, 120_000);

  const scopeKey = buildScopeKey({
    guildId,
    channelId
  });
  const sessionKey = `session:${scopeKey}:${Date.now()}`;
  return new BrowserAgentSession({
    scopeKey,
    llm: ctx.llm,
    browserManager: ctx.browserManager,
    store: ctx.store,
    sessionKey,
    provider: browserTaskConfig.localAgent.provider,
    model: browserTaskConfig.localAgent.model,
    headed: browserTaskConfig.headed,
    profile: browserTaskConfig.profile || undefined,
    maxSteps,
    stepTimeoutMs,
    sessionTimeoutMs: browserTaskConfig.sessionTimeoutMs,
    trace: buildTrace({
      guildId,
      channelId,
      userId,
      source
    })
  });
}

export type CreateMinecraftSessionOptions = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

function createMinecraftSession(
  ctx: AgentContext,
  {
    settings,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }: CreateMinecraftSessionOptions
) {
  if (!isMinecraftEnabled(settings)) return null;

  const config = getMinecraftConfig(settings);
  const scopeKey = buildScopeKey({ guildId, channelId });
  return createMinecraftSessionRuntime({
    scopeKey,
    baseUrl: config.mcpUrl,
    ownerUserId: userId,
    operatorPlayerName: config.operatorPlayerName,
    logAction: (entry) =>
      ctx.store.logAction({
        ...entry,
        guildId,
        channelId,
        userId,
        source
      })
  });
}

export function buildSubAgentSessionsRuntime(ctx: AgentContext) {
  return {
    manager: ctx.subAgentSessions,
    createCodeSession: (opts: CreateCodeAgentSessionOptions) => createCodeAgentSession(ctx, opts),
    createBrowserSession: (opts: CreateBrowserAgentSessionOptions) =>
      createBrowserAgentSession(ctx, opts),
    createMinecraftSession: (opts: CreateMinecraftSessionOptions) =>
      createMinecraftSession(ctx, opts)
  };
}
