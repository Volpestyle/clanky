import { clamp } from "../utils.ts";
import { getResolvedBrowserTaskConfig } from "../settings/agentStack.ts";
import { normalizeCodeAgentRole, resolveCodeAgentConfig } from "../agents/codeAgent.ts";
import { isAbortError, runBrowserBrowseTask } from "../tools/browserTaskRuntime.ts";
import { runOpenAiComputerUseTask } from "../tools/openAiComputerUseRuntime.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { stopBrowserSessionStreamPublish, startBrowserSessionStreamPublish } from "./voiceBrowserStreamPublish.ts";
import { ensureStreamPublishState } from "./voiceStreamPublish.ts";
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

function maybeRemoveCompletedVoiceSession(
  manager: VoiceToolCallManager["subAgentSessions"],
  sessionId: string,
  sessionCompleted?: boolean
) {
  if (!sessionCompleted) return;
  manager?.remove?.(sessionId);
}

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
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session?.lastRealtimeToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue browser session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(instruction, { signal });
      maybeRemoveCompletedVoiceSession(manager.subAgentSessions, existingSession.id, turnResult.sessionCompleted);
      if (turnResult.isError) return { ok: false, text: "", error: turnResult.errorMessage };
      return turnResult.sessionCompleted
        ? { ok: true, text: turnResult.text.trim() || "Browser browse completed." }
        : { ok: true, text: turnResult.text.trim() || "Browser browse completed.", session_id: existingSession.id };
    } catch (error: unknown) {
      return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (manager.createBrowserAgentSession && manager.subAgentSessions) {
    const newSession = manager.createBrowserAgentSession({
      settings,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastRealtimeToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    });
    if (newSession) {
      manager.subAgentSessions.register(newSession);
      try {
        const turnResult = await newSession.runTurn(instruction, { signal });
        maybeRemoveCompletedVoiceSession(manager.subAgentSessions, newSession.id, turnResult.sessionCompleted);
        if (turnResult.isError) {
          return turnResult.sessionCompleted
            ? { ok: false, text: "", error: turnResult.errorMessage }
            : { ok: false, text: "", error: turnResult.errorMessage, session_id: newSession.id };
        }
        return turnResult.sessionCompleted
          ? { ok: true, text: turnResult.text.trim() || "Browser browse completed." }
          : { ok: true, text: turnResult.text.trim() || "Browser browse completed.", session_id: newSession.id };
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
  const computerUseClient =
    browserTaskConfig.runtime === "openai_computer_use"
      ? manager.llm.getComputerUseClient(browserTaskConfig.openaiComputerUse.client)
      : null;
  if (browserTaskConfig.runtime === "openai_computer_use" && !computerUseClient?.client) {
    return { ok: false, text: "", error: "openai_computer_use_unavailable" };
  }

  try {
    const sessionKey = `voice:${String(session?.id || session?.guildId || "unknown")}:${Date.now()}`;
    const trace = {
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      userId: session?.lastRealtimeToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    };
    const result = browserTaskConfig.runtime === "openai_computer_use"
      ? await runOpenAiComputerUseTask({
          openai: computerUseClient.client,
          provider: computerUseClient.provider || "openai",
          browserManager: manager.browserManager,
          store: manager.store,
          sessionKey,
          instruction,
          model: browserTaskConfig.openaiComputerUse.model,
          headed: browserTaskConfig.headed,
          maxSteps,
          stepTimeoutMs,
          sessionTimeoutMs: browserTaskConfig.sessionTimeoutMs,
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
          headed: browserTaskConfig.headed,
          maxSteps,
          stepTimeoutMs,
          sessionTimeoutMs: browserTaskConfig.sessionTimeoutMs,
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
  { session, settings, args, signal }: VoiceBrowserToolOptions
) {
  const task = normalizeInlineText(args?.task, 2000);
  const role = normalizeCodeAgentRole(args?.role, "implementation");
  const resolvedCwd = typeof args?.cwd === "string" ? String(args.cwd).trim() : undefined;
  if (!task) {
    return { ok: false, text: "", error: "task_required" };
  }

  const sessionId = typeof args?.session_id === "string" ? String(args.session_id).trim() : "";
  if (sessionId && manager.subAgentSessions) {
    const existingSession = manager.subAgentSessions.get(sessionId);
    if (!existingSession) {
      return { ok: false, text: "", error: `Code session '${sessionId}' not found or expired.` };
    }
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session?.lastRealtimeToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue code session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(task, { signal });
      maybeRemoveCompletedVoiceSession(manager.subAgentSessions, existingSession.id, turnResult.sessionCompleted);
      if (turnResult.isError) return { ok: false, text: "", error: turnResult.errorMessage };
      return turnResult.sessionCompleted
        ? {
            ok: true,
            text: turnResult.text.trim() || "Code task completed.",
            cost_usd: turnResult.costUsd || 0
          }
        : {
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
      role,
      cwd: resolvedCwd,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastRealtimeToolCallerUserId || null,
      source: "voice_realtime_tool_code_task"
    });
    if (newSession) {
      manager.subAgentSessions.register(newSession);
      const normalizedGuildId = String(session?.guildId || "").trim();
      const normalizedChannelId = String(session?.textChannelId || "").trim();
      const canDispatchAsync = Boolean(
        manager.dispatchBackgroundCodeTask &&
        normalizedGuildId &&
        normalizedChannelId
      );
      if (canDispatchAsync) {
        try {
          const codeConfig = resolveCodeAgentConfig(settings || {}, resolvedCwd, role);
          if (codeConfig.asyncDispatch.enabled && codeConfig.asyncDispatch.thresholdMs <= codeConfig.timeoutMs) {
            const dispatchedTask = manager.dispatchBackgroundCodeTask?.({
              session: newSession,
              task,
              role,
              guildId: normalizedGuildId,
              channelId: normalizedChannelId,
              userId: session?.lastRealtimeToolCallerUserId || null,
              triggerMessageId: null,
              source: "voice_realtime_tool_code_task",
              progressReports: {
                enabled: codeConfig.asyncDispatch.progressReports.enabled,
                intervalMs: codeConfig.asyncDispatch.progressReports.intervalMs,
                maxReportsPerTask: codeConfig.asyncDispatch.progressReports.maxReportsPerTask
              }
            });
            if (dispatchedTask?.sessionId) {
              return {
                ok: true,
                text: `Code task dispatched in background (session ${dispatchedTask.sessionId}). I will follow up when it's done.`,
                session_id: dispatchedTask.sessionId,
                dispatched: true
              };
            }
          }
        } catch (error: unknown) {
          manager.subAgentSessions.remove?.(newSession.id);
          return {
            ok: false,
            text: "",
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
      try {
        const turnResult = await newSession.runTurn(task, { signal });
        maybeRemoveCompletedVoiceSession(manager.subAgentSessions, newSession.id, turnResult.sessionCompleted);
        if (turnResult.isError) {
          return turnResult.sessionCompleted
            ? { ok: false, text: "", error: turnResult.errorMessage }
            : { ok: false, text: "", error: turnResult.errorMessage, session_id: newSession.id };
        }
        return turnResult.sessionCompleted
          ? {
              ok: true,
              text: turnResult.text.trim() || "Code task completed.",
              cost_usd: turnResult.costUsd || 0
            }
          : {
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
      role,
      cwd: resolvedCwd,
      guildId: session?.guildId || "",
      channelId: session?.textChannelId || "",
      userId: session?.lastRealtimeToolCallerUserId || null,
      source: "voice_realtime_tool_code_task",
      signal
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

export async function executeVoiceShareBrowserSessionTool(
  manager: VoiceToolCallManager,
  { session, args, signal }: VoiceBrowserToolOptions
) {
  const browserSessionId = normalizeInlineText(args?.session_id, 220);
  if (!browserSessionId) {
    return { ok: false, text: "", error: "session_id_required" };
  }
  if (!session?.guildId) {
    return { ok: false, text: "", error: "voice_session_missing" };
  }

  try {
    const result = await startBrowserSessionStreamPublish(manager, {
      guildId: session.guildId,
      browserSessionId,
      requesterUserId: session.lastRealtimeToolCallerUserId || null,
      source: "voice_realtime_tool_share_browser_session",
      signal
    });
    if (!result?.ok) {
      return { ok: false, text: "", error: String(result?.error || "browser_stream_publish_failed") };
    }
    return {
      ok: true,
      text: "",
      started: Boolean(result.started),
      reused: Boolean(result.reused),
      session_id: browserSessionId
    };
  } catch (error: unknown) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeVoiceStopVideoShareTool(
  manager: VoiceToolCallManager,
  { session }: VoiceBrowserToolOptions
) {
  if (!session?.guildId) {
    return { ok: false, text: "", error: "voice_session_missing" };
  }

  const state = ensureStreamPublishState(manager.sessions.get(String(session.guildId || "").trim()) || null);
  if (!state?.active || !state.sourceKind) {
    return { ok: false, text: "", error: "video_share_inactive" };
  }

  if (state.sourceKind === "browser_session") {
    const result = await stopBrowserSessionStreamPublish(manager, {
      guildId: session.guildId,
      reason: "voice_realtime_tool_stop_video_share"
    });
    return {
      ok: Boolean(result?.ok),
      text: "",
      stopped: Boolean(result?.ok),
      source_kind: state.sourceKind
    };
  }

  const stopMusicStreamPublish = "stopMusicStreamPublish" in manager &&
    typeof manager.stopMusicStreamPublish === "function"
    ? manager.stopMusicStreamPublish.bind(manager)
    : null;
  if (!stopMusicStreamPublish) {
    return { ok: false, text: "", error: "stream_publish_stop_unavailable" };
  }

  const result = stopMusicStreamPublish({
    guildId: session.guildId,
    reason: "voice_realtime_tool_stop_video_share"
  });
  return {
    ok: Boolean(result?.ok),
    text: "",
    stopped: Boolean(result?.ok),
    source_kind: state.sourceKind
  };
}
