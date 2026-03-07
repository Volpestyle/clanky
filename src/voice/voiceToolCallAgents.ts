import { clamp } from "../utils.ts";
import { getResolvedBrowserTaskConfig } from "../settings/agentStack.ts";
import { isAbortError, runBrowserBrowseTask } from "../tools/browserTaskRuntime.ts";
import { runOpenAiComputerUseTask } from "../tools/openAiComputerUseRuntime.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import type { VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceAgentToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
};

type VoiceBrowserToolOptions = VoiceAgentToolOptions & {
  signal?: AbortSignal;
};

export async function executeVoiceBrowserBrowseTool(
  manager: VoiceToolCallManager,
  { session, settings, args, signal }: VoiceBrowserToolOptions
) {
  const instruction = normalizeInlineText(args?.query, 500);
  if (!instruction) {
    return { ok: false, text: "", error: "query_required" };
  }

  const sessionId = typeof args?.session_id === "string" ? String(args.session_id).trim() : "";
  if (sessionId && manager.subAgentSessions) {
    const existingSession = manager.subAgentSessions.get(sessionId);
    if (!existingSession) {
      return { ok: false, text: "", error: `Browser session '${sessionId}' not found or expired.` };
    }
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session?.lastOpenAiToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue browser session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(instruction);
      if (turnResult.isError) return { ok: false, text: "", error: turnResult.errorMessage };
      return { ok: true, text: turnResult.text.trim() || "Browser browse completed.", session_id: existingSession.id };
    } catch (error: unknown) {
      return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (manager.createBrowserAgentSession && manager.subAgentSessions) {
    const newSession = manager.createBrowserAgentSession({
      settings,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    });
    if (newSession) {
      manager.subAgentSessions.register(newSession);
      try {
        const turnResult = await newSession.runTurn(instruction);
        if (turnResult.isError) {
          return { ok: false, text: "", error: turnResult.errorMessage, session_id: newSession.id };
        }
        return { ok: true, text: turnResult.text.trim() || "Browser browse completed.", session_id: newSession.id };
      } catch (error: unknown) {
        return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  if (!manager.browserManager) return { ok: false, text: "", error: "browser_unavailable" };
  if (!manager.llm) return { ok: false, text: "", error: "llm_unavailable" };

  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  const maxSteps = clamp(Number(browserTaskConfig.maxStepsPerTask) || 15, 1, 30);
  const stepTimeoutMs = clamp(Number(browserTaskConfig.stepTimeoutMs) || 30_000, 5_000, 120_000);
  if (browserTaskConfig.runtime === "openai_computer_use" && !manager.llm?.openai) {
    return { ok: false, text: "", error: "openai_computer_use_unavailable" };
  }

  try {
    const sessionKey = `voice:${String(session?.id || session?.guildId || "unknown")}:${Date.now()}`;
    const trace = {
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    };
    const result = browserTaskConfig.runtime === "openai_computer_use"
      ? await runOpenAiComputerUseTask({
          openai: manager.llm?.openai,
          browserManager: manager.browserManager,
          store: manager.store,
          sessionKey,
          instruction,
          model: browserTaskConfig.openaiComputerUse.model,
          maxSteps,
          stepTimeoutMs,
          trace,
          logSource: "voice_realtime_tool_browser_browse",
          signal
        })
      : await runBrowserBrowseTask({
          llm: manager.llm,
          browserManager: manager.browserManager,
          store: manager.store,
          sessionKey,
          instruction,
          provider: browserTaskConfig.localAgent.provider,
          model: browserTaskConfig.localAgent.model,
          maxSteps,
          stepTimeoutMs,
          trace,
          logSource: "voice_realtime_tool_browser_browse",
          signal
        });

    return { ok: true, text: result.text, steps: result.steps, hit_step_limit: result.hitStepLimit };
  } catch (error: unknown) {
    const message = isAbortError(error)
      ? "Browser session cancelled."
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, text: "", error: message };
  }
}

export async function executeVoiceCodeTaskTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceAgentToolOptions
) {
  const task = normalizeInlineText(args?.task, 2000);
  if (!task) {
    return { ok: false, text: "", error: "task_required" };
  }

  const sessionId = typeof args?.session_id === "string" ? String(args.session_id).trim() : "";
  if (sessionId && manager.subAgentSessions) {
    const existingSession = manager.subAgentSessions.get(sessionId);
    if (!existingSession) {
      return { ok: false, text: "", error: `Code session '${sessionId}' not found or expired.` };
    }
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session?.lastOpenAiToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue code session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(task);
      if (turnResult.isError) return { ok: false, text: "", error: turnResult.errorMessage };
      return {
        ok: true,
        text: turnResult.text.trim() || "Code task completed.",
        cost_usd: turnResult.costUsd || 0,
        session_id: existingSession.id
      };
    } catch (error: unknown) {
      return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (manager.createCodeAgentSession && manager.subAgentSessions) {
    const newSession = manager.createCodeAgentSession({
      settings,
      cwd: typeof args?.cwd === "string" ? String(args.cwd).trim() : undefined,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_code_task"
    });
    if (newSession) {
      manager.subAgentSessions.register(newSession);
      try {
        const turnResult = await newSession.runTurn(task);
        if (turnResult.isError) {
          return { ok: false, text: "", error: turnResult.errorMessage, session_id: newSession.id };
        }
        return {
          ok: true,
          text: turnResult.text.trim() || "Code task completed.",
          cost_usd: turnResult.costUsd || 0,
          session_id: newSession.id
        };
      } catch (error: unknown) {
        return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  if (!manager.runModelRequestedCodeTask) {
    return { ok: false, text: "", error: "code_agent_unavailable" };
  }

  try {
    const result = await manager.runModelRequestedCodeTask({
      settings,
      task,
      cwd: typeof args?.cwd === "string" ? String(args.cwd).trim() : undefined,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_code_task"
    });
    if (result?.blockedByPermission) return { ok: false, text: "", error: "restricted_to_allowed_users" };
    if (result?.blockedByBudget) return { ok: false, text: "", error: "rate_limited" };
    if (result?.blockedByParallelLimit) return { ok: false, text: "", error: "too_many_parallel_tasks" };
    if (result?.error) return { ok: false, text: "", error: String(result.error) };
    return {
      ok: true,
      text: String(result?.text || "").trim() || "Code task completed.",
      cost_usd: result?.costUsd || 0
    };
  } catch (error: unknown) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}
