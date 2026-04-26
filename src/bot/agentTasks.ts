import { BrowserAgentSession } from "../agents/browseAgent.ts";
import { runOpenAiComputerUseTask } from "../tools/openAiComputerUseRuntime.ts";
import { isAbortError } from "../tools/abortError.ts";
import {
  buildBrowserTaskScopeKey,
  runBrowserBrowseTask
} from "../tools/browserTaskRuntime.ts";
import { clamp } from "../utils.ts";
import { MAX_BROWSER_BROWSE_QUERY_LEN, normalizeDirectiveText } from "./botHelpers.ts";
import {
  getResolvedBrowserTaskConfig,
  isMinecraftEnabled,
  getMinecraftConfig,
  getMinecraftProjectActionBudget,
  getMinecraftServerCatalog
} from "../settings/agentStack.ts";
import { createMinecraftSession as createMinecraftSessionRuntime } from "../agents/minecraft/minecraftSession.ts";
import {
  buildMinecraftSessionScopeKey,
  findReusableMinecraftSession
} from "../agents/minecraft/minecraftSessionAccess.ts";
import {
  createMinecraftNarrationState,
  maybePostMinecraftNarration,
  type MinecraftNarrationRuntime
} from "./minecraftNarration.ts";
import { createMinecraftBrain } from "../agents/minecraft/minecraftBrain.ts";
import { createMinecraftBuilder } from "../agents/minecraft/minecraftBuilder.ts";
import { resolveMinecraftMcpServer, type MinecraftMcpProcess } from "../agents/minecraft/minecraftMcpProcess.ts";
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
  signal?: AbortSignal;
};

type BrowserBrowseState = BrowserBrowseContextState;

type CreateBrowserAgentSessionOptions = {
  settings: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
};

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

/**
 * How many recent Discord messages to expose to the Minecraft brain as
 * cross-surface context. Kept small so the brain's prompt stays compact —
 * the brain only needs enough history to connect follow-ups across surfaces.
 */
const MINECRAFT_DISCORD_CONTEXT_LIMIT = 10;

// ── Lazy Minecraft MCP lifecycle ─────────────────────────────────────────────
// The MCP server is spawned on first minecraft_task call, not at bot startup.
// A singleton resolver ensures only one spawn happens even under concurrent
// requests.

let minecraftMcpSingleton: { baseUrl: string; process: MinecraftMcpProcess | null } | null = null;
let minecraftMcpSpawnPromise: Promise<{ baseUrl: string; process: MinecraftMcpProcess | null } | null> | null = null;

async function ensureMinecraftMcpServer(
  settings: Record<string, unknown>,
  logAction: (entry: Record<string, unknown>) => void
): Promise<string | null> {
  if (!isMinecraftEnabled(settings)) return null;

  // Already resolved.
  if (minecraftMcpSingleton) return minecraftMcpSingleton.baseUrl;

  // Another caller is already spawning — wait for it.
  if (minecraftMcpSpawnPromise) {
    const result = await minecraftMcpSpawnPromise;
    return result?.baseUrl ?? null;
  }

  const config = getMinecraftConfig(settings);
  minecraftMcpSpawnPromise = (async () => {
    try {
      const result = await resolveMinecraftMcpServer({
        explicitUrl: config.mcpUrl,
        logAction,
        mcHost: config.serverTarget?.host ?? undefined,
        mcPort: config.serverTarget?.port ?? undefined
      });
      minecraftMcpSingleton = result;
      return result;
    } catch (error) {
      logAction({
        kind: "minecraft_mcp_init_error",
        content: String((error as Error)?.message || error)
      });
      return null;
    } finally {
      minecraftMcpSpawnPromise = null;
    }
  })();

  const result = await minecraftMcpSpawnPromise;
  return result?.baseUrl ?? null;
}

/**
 * Stop the auto-spawned MCP server (if any). Call on bot shutdown.
 */
export async function stopMinecraftMcpServer(): Promise<void> {
  if (minecraftMcpSingleton?.process) {
    await minecraftMcpSingleton.process.stop();
  }
  minecraftMcpSingleton = null;
  minecraftMcpSpawnPromise = null;
}

async function createMinecraftSession(
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

  const scopeKey = buildMinecraftSessionScopeKey({ guildId, channelId });
  const existingSession = findReusableMinecraftSession(ctx.subAgentSessions, {
    ownerUserId: userId,
    scopeKey
  });
  if (existingSession) return existingSession;

  const logAction = (entry: Record<string, unknown>) =>
    ctx.store.logAction({ ...entry, guildId, channelId, userId, source });

  // Lazy-spawn the MCP server on first use.
  const baseUrl = await ensureMinecraftMcpServer(settings, logAction);
  if (!baseUrl) return null;

  const config = getMinecraftConfig(settings);
  const narrationState = createMinecraftNarrationState();
  const narrationRuntime: MinecraftNarrationRuntime = {
    ...ctx,
    client: ctx.client as MinecraftNarrationRuntime["client"]
  };

  // Cross-surface Discord context: only for guild-scoped sessions. DM/owner-private
  // scopes deliberately get no Discord context because MC chat may be visible to
  // other players the brain shouldn't leak private conversation to.
  const getRecentDiscordContext =
    guildId && channelId
      ? () => {
          const rows = ctx.store.getRecentMessages(channelId, MINECRAFT_DISCORD_CONTEXT_LIMIT);
          // getRecentMessages returns DESC (newest first); flip to chronological
          // so the brain reads the prompt section like a conversation.
          return rows.reverse().map((row) => ({
            speaker: row.author_name,
            text: row.content,
            timestamp: row.created_at,
            isBot: row.is_bot
          }));
        }
      : undefined;

  return createMinecraftSessionRuntime({
    scopeKey,
    baseUrl,
    ownerUserId: userId,
    knownIdentities: config.knownIdentities.map((entry) => ({
      mcUsername: entry.mcUsername,
      ...(entry.discordUsername ? { discordUsername: entry.discordUsername } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.relationship ? { relationship: entry.relationship } : {}),
      ...(entry.notes ? { notes: entry.notes } : {})
    })),
    serverTarget: config.serverTarget,
    serverCatalog: getMinecraftServerCatalog(settings),
    logAction,
    onGameEvent: (events, context) =>
      {
        logAction({
          kind: "minecraft_game_events",
          content: events.map((event) => `[${event.type}] ${event.summary}`).join("; "),
          metadata: { events, eventCount: events.length }
        });
        void maybePostMinecraftNarration(narrationRuntime, {
          guildId,
          channelId,
          ownerUserId: userId,
          scopeKey,
          source,
          serverLabel: config.serverTarget?.label || config.serverTarget?.host || null,
          events,
          chatHistory: context?.chatHistory,
          state: narrationState
        }).catch((error) => {
          logAction({
            kind: "bot_error",
            content: `minecraft_narration: ${String(error instanceof Error ? error.message : error)}`,
            metadata: { scopeKey, events }
          });
        });
      },
    getRecentDiscordContext,
    brain: createMinecraftBrain(
      ctx.llm,
      () => ctx.store.getSettings()
    ),
    builder: createMinecraftBuilder(
      ctx.llm,
      () => ctx.store.getSettings()
    ),
    projectActionBudget: getMinecraftProjectActionBudget(settings)
  });
}

export function buildSubAgentSessionsRuntime(ctx: AgentContext) {
  return {
    manager: ctx.subAgentSessions,
    createBrowserSession: (opts: CreateBrowserAgentSessionOptions) =>
      createBrowserAgentSession(ctx, opts),
    createMinecraftSession: (opts: CreateMinecraftSessionOptions) =>
      createMinecraftSession(ctx, opts)
  };
}
