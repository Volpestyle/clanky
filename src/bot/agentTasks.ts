import {
  createCodeAgentSession as createCodeAgentSessionRuntime,
  getActiveCodeAgentTaskCount,
  isCodeAgentUserAllowed,
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
import { MAX_BROWSER_BROWSE_QUERY_LEN, normalizeDirectiveText } from "../botHelpers.ts";
import { getResolvedBrowserTaskConfig, isDevTaskEnabled } from "../settings/agentStack.ts";
import type { BrowserBrowseContextState } from "./budgetTracking.ts";
import type { AgentContext } from "./botContext.ts";

type AgentTaskTrace = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string | null;
};

type RunModelRequestedBrowserBrowseOptions = {
  settings: Record<string, unknown>;
  browserBrowse: BrowserBrowseContextState;
  query?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

type BrowserBrowseState = BrowserBrowseContextState;

type RunModelRequestedCodeTaskOptions = {
  settings: Record<string, unknown>;
  task?: string;
  cwd?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

type CreateCodeAgentSessionOptions = {
  settings: Record<string, unknown>;
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
    source = "reply_message"
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
  if (browserTaskConfig.runtime === "openai_computer_use" && !ctx.llm?.openai) {
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
            openai: ctx.llm?.openai,
            browserManager: ctx.browserManager,
            store: ctx.store,
            sessionKey,
            instruction: normalizedQuery,
            model: browserTaskConfig.openaiComputerUse.model,
            maxSteps,
            stepTimeoutMs,
            trace,
            logSource: source,
            signal: activeBrowserTask.abortController.signal
          })
        : await runBrowserBrowseTask({
            llm: ctx.llm,
            browserManager: ctx.browserManager,
            store: ctx.store,
            sessionKey,
            instruction: normalizedQuery,
            provider: browserTaskConfig.localAgent.provider,
            model: browserTaskConfig.localAgent.model,
            maxSteps,
            stepTimeoutMs,
            trace,
            logSource: source,
            signal: activeBrowserTask.abortController.signal
          });

    return {
      ...state,
      used: true,
      text: result.text,
      steps: result.steps,
      hitStepLimit: result.hitStepLimit
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ...state,
        error: "Browser session cancelled by user."
      };
    }
    return {
      ...state,
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
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_message"
  }: RunModelRequestedCodeTaskOptions
) {
  if (!isDevTaskEnabled(settings)) {
    return { text: "", error: "code_agent_disabled" };
  }
  if (userId && !isCodeAgentUserAllowed(userId, settings)) {
    return { text: "", blockedByPermission: true };
  }

  const codeAgentConfig = resolveCodeAgentConfig(settings, cwdOverride);
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
    provider,
    model,
    codexModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes
  } = codeAgentConfig;

  try {
    const result = await runCodeAgent({
      instruction: task,
      cwd,
      provider,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      model,
      codexModel,
      openai: ctx.llm?.openai || null,
      trace: buildTrace({
        guildId,
        channelId,
        userId,
        source
      }),
      store: ctx.store
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
    cwd: cwdOverride,
    guildId,
    channelId = null,
    userId = null,
    source = "reply_session"
  }: CreateCodeAgentSessionOptions
) {
  if (!isDevTaskEnabled(settings)) return null;
  if (userId && !isCodeAgentUserAllowed(userId, settings)) return null;

  const codeAgentConfig = resolveCodeAgentConfig(settings, cwdOverride);
  const maxParallel = codeAgentConfig.maxParallelTasks;
  if (getActiveCodeAgentTaskCount() >= maxParallel) return null;

  const maxPerHour = codeAgentConfig.maxTasksPerHour;
  const used = ctx.store.countActionsSince("code_agent_call", buildCodeAgentBudgetWindowStart());
  if (used >= maxPerHour) return null;

  const {
    cwd,
    provider,
    model,
    codexModel,
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
      provider,
      model,
      codexModel,
      maxTurns,
      timeoutMs,
      maxBufferBytes,
      trace: buildTrace({
        guildId,
        channelId,
        userId,
        source
      }),
      store: ctx.store,
      openai: ctx.llm?.openai || null
    });
  } catch {
    return null;
  }
}

export function createBrowserAgentSession(
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
    maxSteps,
    stepTimeoutMs,
    trace: buildTrace({
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
      createBrowserAgentSession(ctx, opts)
  };
}
