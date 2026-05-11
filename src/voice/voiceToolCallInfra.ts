import { shouldRegisterRealtimeTools } from "./voiceConfigResolver.ts";
import { normalizeInlineText, resolveVoiceSettingsSnapshot } from "./voiceSessionHelpers.ts";
import type { VoiceMcpServerStatus, VoicePendingToolCallState, VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";
import {
  buildRealtimeFunctionTools,
  ensureSessionToolRuntimeState,
  getVoiceMcpServerStatuses,
  parseRealtimeToolArguments,
  recordVoiceToolCallEvent,
  resolveRealtimeToolDescriptor,
  summarizeVoiceToolOutput
} from "./voiceToolCallToolRegistry.ts";
import { executeLocalVoiceToolCall, executeMcpVoiceToolCall } from "./voiceToolCallDispatch.ts";
import { buildVoiceReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { isAbortError } from "../tools/abortError.ts";
import { shouldRequestVoiceToolFollowup } from "../tools/sharedToolSchemas.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type RealtimeFunctionOutputClient = NonNullable<VoiceSession["realtimeClient"]> & {
  supportsFunctionCallOutputImages?: boolean;
  sendFunctionCallOutput?: (payload: {
    callId: string;
    output: string;
    inputImage?: RealtimeToolInputImage | null;
  }) => void;
};

type RealtimeToolInputImage = {
  mimeType: string;
  dataBase64: string;
  text: string;
};

type ToolExecutionSession = ToolRuntimeSession & {
  realtimePendingToolAbortControllers?: Map<string, AbortController>;
  realtimeClient?: RealtimeFunctionOutputClient | null;
};

function isToolOutputRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRealtimeToolOutputForModel(output: unknown, success: boolean) {
  const isSemanticError = isToolOutputRecord(output) && output.ok === false;
  if (!isSemanticError && success) return output;
  if (isToolOutputRecord(output)) {
    if (output.is_error === true) return output;
    return {
      ...output,
      is_error: true
    };
  }
  return {
    ok: false,
    is_error: true,
    result: output == null ? null : String(output)
  };
}

function extractRealtimeToolInputImage(toolName: string, output: unknown): RealtimeToolInputImage | null {
  if (String(toolName || "").trim().toLowerCase() !== "look_at_screen") return null;
  if (!isToolOutputRecord(output) || output.ok === false) return null;

  const dataBase64 = String(output.dataBase64 || "").trim();
  if (!dataBase64) return null;
  const mimeType = normalizeInlineText(output.mimeType, 80) || "image/jpeg";
  const streamerName = normalizeInlineText(output.streamerName, 80) || "the active screen watch";
  const frameAgeMs = Number.isFinite(Number(output.frameAgeMs))
    ? Math.max(0, Math.round(Number(output.frameAgeMs)))
    : null;
  const ageText = frameAgeMs == null ? "" : ` (${frameAgeMs}ms old)`;

  return {
    mimeType,
    dataBase64,
    text: `look_at_screen result: latest sampled frame from ${streamerName}${ageText}. Use this attached image as the current screen snapshot.`
  };
}

function stripRealtimeToolInlineImage(output: unknown, imageAttached: boolean) {
  if (!isToolOutputRecord(output)) return output;
  const { dataBase64: _dataBase64, ...rest } = output;
  return {
    ...rest,
    imageAttached,
    imageTransport: imageAttached ? "input_image" : "unsupported"
  };
}

export async function executeRealtimeFunctionCall(
  manager: VoiceToolCallManager,
  { session, settings, pendingCall }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null; pendingCall: VoicePendingToolCallState }
) {
  if (!session || session.ending) return;
  const runtimeSession = session as ToolExecutionSession;
  const callId = String(pendingCall?.callId || "").trim().slice(0, 180);
  const toolName = String(pendingCall?.name || "").trim().slice(0, 120);
  if (!callId) return;

  const startedAtMs = Date.now();
  const resolvedSettings = resolveVoiceSettingsSnapshot(manager.store, session, settings);
  const callArgs = parseRealtimeToolArguments(manager, pendingCall?.argumentsText || "");
  const toolDescriptor = resolveRealtimeToolDescriptor(manager, session, toolName);
  const resolvedToolName = toolName || toolDescriptor?.name || "unknown_tool";
  const toolType = toolDescriptor?.toolType === "mcp" ? "mcp" : "function";
  const activeReply = manager.activeReplies?.begin(
    buildVoiceReplyScopeKey(session.id),
    "voice-tool",
    [resolvedToolName]
  ) || null;

  const abortController = new AbortController();
  const toolSignal = activeReply
    ? AbortSignal.any([abortController.signal, activeReply.abortController.signal])
    : abortController.signal;
  if (!(runtimeSession.realtimePendingToolAbortControllers instanceof Map)) {
    runtimeSession.realtimePendingToolAbortControllers = new Map();
  }
  runtimeSession.realtimePendingToolAbortControllers.set(callId, abortController);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "realtime_tool_call_started",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: resolvedToolName || null,
      toolType,
      arguments: callArgs
    }
  });

  let success = false;
  let output: unknown = null;
  let errorMessage = "";
  try {
    if (!toolDescriptor) throw new Error(`unknown_tool:${toolName || "unnamed"}`);
    output = toolDescriptor.toolType === "mcp"
      ? await executeMcpVoiceToolCall(manager, {
          session,
          settings: resolvedSettings,
          toolDescriptor,
          args: callArgs,
          signal: toolSignal
        })
      : await executeLocalVoiceToolCall(manager, {
          session,
          settings: resolvedSettings,
          toolName: toolDescriptor.name,
          args: callArgs,
          signal: toolSignal
        });
    success = true;
  } catch (error) {
    if (isAbortError(error) || toolSignal.aborted) {
      errorMessage = "cancelled_by_user";
      output = {
        ok: false,
        cancelled: true,
        error: { message: "Tool call cancelled by user." }
      };
    } else {
      errorMessage = String(error?.message || error);
      output = { ok: false, error: { message: errorMessage } };
    }
  } finally {
    runtimeSession.realtimePendingToolAbortControllers?.delete(callId);
    manager.activeReplies?.clear(activeReply);
  }

  const runtimeMs = Math.max(0, Date.now() - startedAtMs);
  const normalizedOutput = normalizeRealtimeToolOutputForModel(output, success);
  const inputImage = extractRealtimeToolInputImage(resolvedToolName, normalizedOutput);
  const canAttachInputImage = Boolean(inputImage && runtimeSession.realtimeClient?.supportsFunctionCallOutputImages);
  const modelOutput = inputImage
    ? stripRealtimeToolInlineImage(normalizedOutput, canAttachInputImage)
    : normalizedOutput;
  const outputSummary = summarizeVoiceToolOutput(manager, resolvedToolName, modelOutput);
  const responseHadAssistantOutput =
    typeof manager.hasRealtimeAssistantOutputForResponse === "function" &&
    pendingCall.responseId
      ? manager.hasRealtimeAssistantOutputForResponse(session, pendingCall.responseId)
      : false;
  const requestFollowup = shouldRequestVoiceToolFollowup(resolvedToolName, {
    toolType,
    hasSpokenText: responseHadAssistantOutput
  });
  recordVoiceToolCallEvent(manager, {
    session,
    event: {
      callId,
      toolName: resolvedToolName,
      toolType,
      arguments: callArgs,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      runtimeMs,
      success,
      outputSummary,
      error: success ? null : errorMessage,
      sourceEventType: String(pendingCall?.sourceEventType || "")
    }
  });
  manager.instructionManager.scheduleRealtimeInstructionRefresh?.({
    session,
    settings: resolvedSettings,
    reason: "tool_result",
    speakerUserId: session.lastRealtimeToolCallerUserId || null,
    transcript: ""
  });

  try {
    if (typeof runtimeSession.realtimeClient?.sendFunctionCallOutput === "function") {
      let serializedOutput = "";
      if (typeof normalizedOutput === "string") {
        serializedOutput = normalizedOutput;
      } else {
        try {
          serializedOutput = JSON.stringify(modelOutput ?? null);
        } catch {
          serializedOutput = String(modelOutput ?? "");
        }
      }
      runtimeSession.realtimeClient.sendFunctionCallOutput({
        callId,
        output: serializedOutput,
        inputImage: canAttachInputImage ? inputImage : null
      });
    }
  } catch (sendError) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `realtime_tool_output_send_failed: ${String(sendError?.message || sendError)}`,
      metadata: { sessionId: session.id, callId, toolName: resolvedToolName || null }
    });
  }

  manager.store.logAction({
    kind: success ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: success ? "realtime_tool_call_completed" : "realtime_tool_call_failed",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: resolvedToolName || null,
      toolType,
      runtimeMs,
      outputSummary,
      error: success ? null : errorMessage
    }
  });

  if (session.realtimePendingToolCalls instanceof Map) session.realtimePendingToolCalls.delete(callId);
  if (session.realtimeCompletedToolCallIds instanceof Map) {
    session.realtimeCompletedToolCallIds.set(callId, Date.now());
    const completedRows = [...session.realtimeCompletedToolCallIds.entries()].sort((a, b) => a[1] - b[1]).slice(-256);
    session.realtimeCompletedToolCallIds = new Map(
      completedRows.filter(([, completedAtMs]) => Date.now() - completedAtMs <= 10 * 60 * 1000)
    );
  }
  if (session.realtimeToolCallExecutions instanceof Map) session.realtimeToolCallExecutions.delete(callId);
  if (!(session.realtimeToolCallExecutions instanceof Map) || session.realtimeToolCallExecutions.size <= 0) {
    manager.scheduleRealtimeToolFollowupResponse({
      session,
      userId: session.lastRealtimeToolCallerUserId || null,
      startedAtMs,
      requestFollowup,
      toolName: resolvedToolName || null
    });
  }
}

export async function refreshRealtimeTools(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    reason = "voice_context_refresh"
  }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null; reason?: string } = {}
) {
  if (!session || session.ending) return;
  const realtimeClient = session.realtimeClient;
  const updateTools =
    realtimeClient && "updateTools" in realtimeClient && typeof realtimeClient.updateTools === "function"
      ? realtimeClient.updateTools.bind(realtimeClient)
      : null;
  if (!updateTools) return;

  const resolvedSettings = resolveVoiceSettingsSnapshot(manager.store, session, settings);
  if (!shouldRegisterRealtimeTools({ session, settings: resolvedSettings })) {
    const hadRealtimeTools =
      (Array.isArray(session.realtimeToolDefinitions) && session.realtimeToolDefinitions.length > 0) ||
      Boolean(String(session.lastRealtimeToolHash || ""));
    if (!hadRealtimeTools) return;

    try {
      updateTools({
        tools: [],
        toolChoice: "auto"
      });
      session.realtimeToolDefinitions = [];
      session.lastRealtimeToolHash = "";
      session.lastRealtimeToolRefreshAt = Date.now();
      manager.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: "realtime_tools_cleared",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    } catch (error) {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `realtime_tools_update_failed: ${String(error?.message || error)}`,
        metadata: { sessionId: session.id, reason: String(reason || "voice_context_refresh") }
      });
    }
    return;
  }

  ensureSessionToolRuntimeState(manager, session);
  const previousMcpStatuses = new Map<string, VoiceMcpServerStatus>();
  for (const entry of Array.isArray(session.mcpStatus) ? session.mcpStatus : []) {
    const serverName = String(entry?.serverName || "");
    if (serverName) previousMcpStatuses.set(serverName, entry);
  }
  session.mcpStatus = getVoiceMcpServerStatuses(manager).map((entry) => {
    const previous = previousMcpStatuses.get(String(entry.serverName || ""));
    return {
      ...entry,
      lastError: previous?.lastError || null,
      lastConnectedAt: previous?.lastConnectedAt || entry.lastConnectedAt || null,
      lastCallAt: previous?.lastCallAt || entry.lastCallAt || null
    };
  });

  const tools = buildRealtimeFunctionTools(manager, { session, settings: resolvedSettings });
  const nextToolHash = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      toolType: tool.toolType,
      serverName: tool.serverName || null,
      description: tool.description,
      parameters: tool.parameters
    }))
  );
  if (String(session.lastRealtimeToolHash || "") === nextToolHash) return;

  try {
    updateTools({
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      toolChoice: "auto"
    });
    session.realtimeToolDefinitions = tools;
    session.lastRealtimeToolHash = nextToolHash;
    session.lastRealtimeToolRefreshAt = Date.now();
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "realtime_tools_updated",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "voice_context_refresh"),
        localToolCount: tools.filter((tool) => tool.toolType === "function").length,
        mcpToolCount: tools.filter((tool) => tool.toolType === "mcp").length,
        toolNames: tools.map((tool) => tool.name)
      }
    });
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `realtime_tools_update_failed: ${String(error?.message || error)}`,
      metadata: { sessionId: session.id, reason: String(reason || "voice_context_refresh") }
    });
  }
}
