// Extracted Tool Call Methods
import {
  executeSharedAdaptiveDirectiveAdd,
  executeSharedAdaptiveDirectiveRemove
} from "../adaptiveDirectives/adaptiveDirectiveToolRuntime.ts";
import {
  executeSharedMemoryToolSearch,
  executeSharedMemoryToolWrite
} from "../memory/memoryToolRuntime.ts";
import { clamp, deepMerge } from "../utils.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import type {
  VoiceMcpServerStatus,
  VoiceToolRuntimeSessionLike,
  VoiceRealtimeToolSettings,
  VoiceRealtimeToolDescriptor,
  VoiceToolCallEvent,
} from "./voiceSessionTypes.ts";
import {
  OPENAI_TOOL_CALL_EVENT_MAX,
  OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS,
  VOICE_MEMORY_WRITE_MAX_PER_MINUTE,
  MEMORY_SENSITIVE_PATTERN_RE,
} from "./voiceSessionManager.constants.ts";
import { providerSupports } from "./voiceModes.ts";
import { isAbortError, runBrowserBrowseTask } from "../tools/browserTaskRuntime.ts";
import { runOpenAiComputerUseTask } from "../tools/openAiComputerUseRuntime.ts";
import {
  WEB_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  ADAPTIVE_DIRECTIVE_ADD_SCHEMA,
  ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CODE_TASK_SCHEMA,
  MUSIC_SEARCH_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_PLAY_NOW_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_STOP_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA,
  toRealtimeTool
} from "../tools/sharedToolSchemas.ts";
import {
  getDirectiveSettings,
  getMemorySettings,
  getResearchRuntimeConfig,
  getResolvedBrowserTaskConfig,
  isBrowserEnabled,
  isDevTaskEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";

export function ensureSessionToolRuntimeState(manager: any, session) {
  if (!session || typeof session !== "object") return null;
  if (!Array.isArray(session.toolCallEvents)) {
    session.toolCallEvents = [];
  }
  if (!(session.openAiPendingToolCalls instanceof Map)) {
    session.openAiPendingToolCalls = new Map();
  }
  if (!(session.openAiCompletedToolCallIds instanceof Map)) {
    session.openAiCompletedToolCallIds = new Map();
  }
  if (!(session.openAiToolCallExecutions instanceof Map)) {
    session.openAiToolCallExecutions = new Map();
  }
  if (!(session.toolMusicTrackCatalog instanceof Map)) {
    session.toolMusicTrackCatalog = new Map();
  }
  if (!Array.isArray(session.memoryWriteWindow)) {
    session.memoryWriteWindow = [];
  }
  if (!session.mcpStatus || !Array.isArray(session.mcpStatus)) {
    session.mcpStatus = manager.getVoiceMcpServerStatuses().map((entry) => ({
      ...entry
    }));
  }
  return session;
}

export function getVoiceMcpServerStatuses(manager: any) {
  const servers = Array.isArray(manager.appConfig?.voiceMcpServers) ? manager.appConfig.voiceMcpServers : [];
  return servers
    .map((server) => {
      if (!server || typeof server !== "object") return null;
      const serverName = normalizeInlineText(server.serverName || server.name, 80);
      const baseUrl = normalizeInlineText(server.baseUrl, 280);
      if (!serverName || !baseUrl) return null;
      const toolRows = Array.isArray(server.tools)
        ? server.tools
          .map((tool) => {
            if (!tool || typeof tool !== "object") return null;
            const toolName = normalizeInlineText(tool.name, 120);
            if (!toolName) return null;
            return {
              name: toolName,
              description: normalizeInlineText(tool.description, 800) || "",
              inputSchema:
                tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
                  ? tool.inputSchema
                  : undefined
            };
          })
          .filter(Boolean)
        : [];
      const headers =
        server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
          ? Object.fromEntries(
            Object.entries(server.headers)
              .map(([headerName, headerValue]) => [
                normalizeInlineText(headerName, 120),
                normalizeInlineText(headerValue, 320)
              ])
              .filter(([headerName, headerValue]) => Boolean(headerName) && Boolean(headerValue))
          )
          : {};
      return {
        serverName,
        connected: true,
        tools: toolRows,
        lastError: null,
        lastConnectedAt: null,
        lastCallAt: null,
        baseUrl,
        toolPath: normalizeInlineText(server.toolPath, 220) || "/tools/call",
        timeoutMs: clamp(Math.floor(Number(server.timeoutMs) || 10_000), 500, 60_000),
        headers
      };
    })
    .filter((entry): entry is VoiceMcpServerStatus => Boolean(entry));
}

export function resolveVoiceRealtimeToolDescriptors(manager: any, {
  session,
  settings
}: {
  session?: VoiceToolRuntimeSessionLike | null;
  settings?: VoiceRealtimeToolSettings | null;
} = {}) {
  const localTools: VoiceRealtimeToolDescriptor[] = [
    // Shared tools (canonical schemas from sharedToolSchemas.ts)
    toRealtimeTool(MEMORY_SEARCH_SCHEMA),
    toRealtimeTool(MEMORY_WRITE_SCHEMA),
    toRealtimeTool(ADAPTIVE_DIRECTIVE_ADD_SCHEMA),
    toRealtimeTool(ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA),
    toRealtimeTool(CONVERSATION_SEARCH_SCHEMA),
    // Voice-only tools (canonical schemas from sharedToolSchemas.ts)
    toRealtimeTool(MUSIC_SEARCH_SCHEMA),
    toRealtimeTool(MUSIC_QUEUE_ADD_SCHEMA),
    toRealtimeTool(MUSIC_PLAY_NOW_SCHEMA),
    toRealtimeTool(MUSIC_QUEUE_NEXT_SCHEMA),
    toRealtimeTool(MUSIC_STOP_SCHEMA),
    toRealtimeTool(MUSIC_PAUSE_SCHEMA),
    toRealtimeTool(MUSIC_RESUME_SCHEMA),
    toRealtimeTool(MUSIC_SKIP_SCHEMA),
    toRealtimeTool(MUSIC_NOW_PLAYING_SCHEMA),
    toRealtimeTool(LEAVE_VOICE_CHANNEL_SCHEMA),
    toRealtimeTool(WEB_SEARCH_SCHEMA),
    toRealtimeTool(WEB_SCRAPE_SCHEMA),
    toRealtimeTool(BROWSER_BROWSE_SCHEMA),
    toRealtimeTool(CODE_TASK_SCHEMA)
  ];

  const screenShareCapability =
    typeof manager.getVoiceScreenShareCapability === "function"
      ? manager.getVoiceScreenShareCapability({
        settings,
        guildId: session?.guildId || null,
        channelId: session?.textChannelId || null,
        requesterUserId: session?.lastOpenAiToolCallerUserId || null
      })
      : null;
  if (
    screenShareCapability?.available &&
    typeof manager.offerVoiceScreenShareLink === "function" &&
    session?.guildId &&
    session?.textChannelId
  ) {
    localTools.push({
      toolType: "function",
      name: "offer_screen_share_link",
      description: "Send the active speaker a temporary screen-share link in the text channel so they can start sharing their screen.",
      parameters: {
        type: "object",
        additionalProperties: false
      }
    });
  }

  const sessionState = manager.ensureSessionToolRuntimeState(session);
  const mcpTools = (Array.isArray(sessionState?.mcpStatus) ? sessionState.mcpStatus : [])
    .flatMap((server) => {
      const serverName = normalizeInlineText(server?.serverName, 80);
      if (!serverName) return [];
      return (Array.isArray(server?.tools) ? server.tools : [])
        .map((tool) => {
          if (!tool || typeof tool !== "object") return null;
          const name = normalizeInlineText(tool.name, 120);
          if (!name) return null;
          return {
            toolType: "mcp",
            name,
            description: normalizeInlineText(tool.description, 800) || `MCP tool ${name}`,
            parameters:
              tool.inputSchema && typeof tool.inputSchema === "object"
                ? tool.inputSchema
                : {
                  type: "object",
                  additionalProperties: true
                },
            serverName
          };
        })
        .filter((entry): entry is VoiceRealtimeToolDescriptor => Boolean(entry));
    });

  const includeWebSearch = isResearchEnabled(settings);
  const includeMemory = Boolean(getMemorySettings(settings).enabled);
  const includeAdaptiveDirectives = Boolean(getDirectiveSettings(settings).enabled);
  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  const includeBrowser = Boolean(
    isBrowserEnabled(settings) &&
    manager.browserManager &&
    (browserTaskConfig.runtime !== "openai_computer_use" || manager.llm?.openai)
  );
  const codeAgentRuntimeAvailable = Boolean(
    (manager.createCodeAgentSession && manager.subAgentSessions) ||
    manager.runModelRequestedCodeTask
  );
  const includeCodeAgent = Boolean(
    isDevTaskEnabled(settings) &&
    codeAgentRuntimeAvailable
  );
  const filteredLocalTools = localTools.filter((entry) => {
    if (entry.name === "web_search" && !includeWebSearch) return false;
    if (entry.name === "web_scrape" && !includeWebSearch) return false;
    if ((entry.name === "memory_search" || entry.name === "memory_write") && !includeMemory) return false;
    if ((entry.name === "adaptive_directive_add" || entry.name === "adaptive_directive_remove") && !includeAdaptiveDirectives) return false;
    if (entry.name === "browser_browse" && !includeBrowser) return false;
    if (entry.name === "code_task" && !includeCodeAgent) return false;
    return true;
  });
  return [
    ...filteredLocalTools,
    ...mcpTools
  ];
}

export function buildRealtimeFunctionTools(manager: any, {
  session,
  settings
}: {
  session?: VoiceToolRuntimeSessionLike | null;
  settings?: VoiceRealtimeToolSettings | null;
} = {}) {
  return manager.resolveVoiceRealtimeToolDescriptors({ session, settings }).map((entry) => ({
    type: "function",
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    toolType: entry.toolType,
    serverName: entry.serverName || null
  }));
}

export function recordVoiceToolCallEvent(manager: any, {
  session,
  event
}: {
  session?: VoiceToolRuntimeSessionLike | null;
  event?: VoiceToolCallEvent | null;
} = {}) {
  if (!session || !event) return;
  manager.ensureSessionToolRuntimeState(session);
  const events = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  events.push(event);
  if (events.length > OPENAI_TOOL_CALL_EVENT_MAX) {
    session.toolCallEvents = events.slice(-OPENAI_TOOL_CALL_EVENT_MAX);
  } else {
    session.toolCallEvents = events;
  }
}

export function parseOpenAiRealtimeToolArguments(manager: any, argumentsText = "") {
  const normalizedText = String(argumentsText || "")
    .trim()
    .slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
  if (!normalizedText) return {};
  try {
    const parsed = JSON.parse(normalizedText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function resolveOpenAiRealtimeToolDescriptor(manager: any, session, toolName = "") {
  const normalizedToolName = normalizeInlineText(toolName, 120);
  if (!normalizedToolName) return null;
  const configuredTools = Array.isArray(session?.openAiToolDefinitions)
    ? session.openAiToolDefinitions
    : manager.buildRealtimeFunctionTools({
      session,
      settings: session?.settingsSnapshot || manager.store.getSettings()
    });
  return configuredTools.find((tool) => String(tool?.name || "") === normalizedToolName) || null;
}

export function summarizeVoiceToolOutput(manager: any, output: unknown = null) {
  if (output == null) return null;
  if (typeof output === "string") {
    return normalizeInlineText(output, 280) || null;
  }
  try {
    return normalizeInlineText(JSON.stringify(output), 280) || null;
  } catch {
    return normalizeInlineText(String(output), 280) || null;
  }
}

export async function executeOpenAiRealtimeFunctionCall(manager: any, {
  session,
  settings,
  pendingCall
}) {
  if (!session || session.ending) return;
  const callId = normalizeInlineText(pendingCall?.callId, 180);
  const toolName = normalizeInlineText(pendingCall?.name, 120);
  if (!callId) return;
  const startedAtMs = Date.now();
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const callArgs = manager.parseOpenAiRealtimeToolArguments(pendingCall?.argumentsText || "");
  const toolDescriptor = manager.resolveOpenAiRealtimeToolDescriptor(session, toolName);
  const toolType = toolDescriptor?.toolType === "mcp" ? "mcp" : "function";

  const abortController = new AbortController();
  if (!session.openAiPendingToolAbortControllers) {
    session.openAiPendingToolAbortControllers = new Map();
  }
  session.openAiPendingToolAbortControllers.set(callId, abortController);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "openai_realtime_tool_call_started",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: toolName || null,
      toolType,
      arguments: callArgs
    }
  });

  let success = false;
  let output: unknown = null;
  let errorMessage = "";
  try {
    if (!toolDescriptor) {
      throw new Error(`unknown_tool:${toolName || "unnamed"}`);
    }

    if (toolDescriptor.toolType === "mcp") {
      output = await manager.executeMcpVoiceToolCall({
        session,
        settings: resolvedSettings,
        toolDescriptor,
        args: callArgs
      });
    } else {
      output = await manager.executeLocalVoiceToolCall({
        session,
        settings: resolvedSettings,
        toolName: toolDescriptor.name,
        args: callArgs,
        signal: abortController.signal
      });
    }
    success = true;
  } catch (error) {
    success = false;
    errorMessage = String(error?.message || error);
    output = {
      ok: false,
      error: {
        message: errorMessage
      }
    };
  } finally {
    session.openAiPendingToolAbortControllers?.delete(callId);
  }

  const runtimeMs = Math.max(0, Date.now() - startedAtMs);
  const outputSummary = manager.summarizeVoiceToolOutput(output);
  const eventPayload: VoiceToolCallEvent = {
    callId,
    toolName: toolName || toolDescriptor?.name || "unknown_tool",
    toolType,
    arguments: callArgs,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    runtimeMs,
    success,
    outputSummary,
    error: success ? null : errorMessage,
    sourceEventType: String(pendingCall?.sourceEventType || "")
  };
  manager.recordVoiceToolCallEvent({
    session,
    event: eventPayload
  });

  try {
    if (typeof session.realtimeClient?.sendFunctionCallOutput === "function") {
      let serializedOutput = "";
      if (typeof output === "string") {
        serializedOutput = output;
      } else {
        try {
          serializedOutput = JSON.stringify(output ?? null);
        } catch {
          serializedOutput = String(output ?? "");
        }
      }
      session.realtimeClient.sendFunctionCallOutput({
        callId,
        output: serializedOutput
      });
    }
  } catch (sendError) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `openai_realtime_tool_output_send_failed: ${String(sendError?.message || sendError)}`,
      metadata: {
        sessionId: session.id,
        callId,
        toolName: toolName || null
      }
    });
  }

  manager.store.logAction({
    kind: success ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: success ? "openai_realtime_tool_call_completed" : "openai_realtime_tool_call_failed",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: toolName || null,
      toolType,
      runtimeMs,
      outputSummary,
      error: success ? null : errorMessage
    }
  });

  if (session.openAiPendingToolCalls instanceof Map) {
    session.openAiPendingToolCalls.delete(callId);
  }
  if (session.openAiCompletedToolCallIds instanceof Map) {
    session.openAiCompletedToolCallIds.set(callId, Date.now());
    const completedRows = [...session.openAiCompletedToolCallIds.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(-256);
    session.openAiCompletedToolCallIds = new Map(
      completedRows.filter(([, completedAtMs]) => Date.now() - completedAtMs <= 10 * 60 * 1000)
    );
  }
  if (session.openAiToolCallExecutions instanceof Map) {
    session.openAiToolCallExecutions.delete(callId);
  }
  if (!(session.openAiToolCallExecutions instanceof Map) || session.openAiToolCallExecutions.size <= 0) {
    manager.scheduleOpenAiRealtimeToolFollowupResponse({
      session,
      userId: session.lastOpenAiToolCallerUserId || null
    });
  }
}

export async function refreshRealtimeTools(manager: any, {
  session,
  settings,
  reason = "voice_context_refresh"
}: {
  session?: VoiceToolRuntimeSessionLike | null;
  settings?: VoiceRealtimeToolSettings | null;
  reason?: string;
} = {}) {
  if (!session || session.ending) return;
  if (!providerSupports(session.mode || "", "updateTools")) return;
  const realtimeClient = session.realtimeClient;
  if (!realtimeClient || typeof realtimeClient.updateTools !== "function") return;

  manager.ensureSessionToolRuntimeState(session);
  const previousMcpStatuses = new Map<string, VoiceMcpServerStatus>();
  for (const entry of Array.isArray(session.mcpStatus) ? session.mcpStatus : []) {
    const serverName = String(entry?.serverName || "");
    if (!serverName) continue;
    previousMcpStatuses.set(serverName, entry);
  }
  session.mcpStatus = manager.getVoiceMcpServerStatuses().map((entry) => {
    const previous = previousMcpStatuses.get(String(entry.serverName || ""));
    return {
      ...entry,
      lastError: previous?.lastError || null,
      lastConnectedAt: previous?.lastConnectedAt || entry.lastConnectedAt || null,
      lastCallAt: previous?.lastCallAt || entry.lastCallAt || null
    };
  });

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const tools = manager.buildRealtimeFunctionTools({
    session,
    settings: resolvedSettings
  });
  const nextToolHash = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      toolType: tool.toolType,
      serverName: tool.serverName || null,
      description: tool.description,
      parameters: tool.parameters
    }))
  );
  if (String(session.lastOpenAiRealtimeToolHash || "") === nextToolHash) return;

  try {
    realtimeClient.updateTools({
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      toolChoice: "auto"
    });
    session.openAiToolDefinitions = tools;
    session.lastOpenAiRealtimeToolHash = nextToolHash;
    session.lastOpenAiRealtimeToolRefreshAt = Date.now();

    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "openai_realtime_tools_updated",
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
      content: `openai_realtime_tools_update_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        reason: String(reason || "voice_context_refresh")
      }
    });
  }
}

export async function executeVoiceMemorySearchTool(manager: any, {
  session,
  settings,
  args
}) {
  if (!manager.memory || typeof manager.memory.searchDurableFacts !== "function") {
    return {
      ok: false,
      matches: [],
      error: "memory_unavailable"
    };
  }
  return executeSharedMemoryToolSearch({
    runtime: {
      memory: manager.memory
    },
    settings,
    guildId: String(session?.guildId || "").trim(),
    channelId: session?.textChannelId || null,
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    namespace: args?.namespace,
    queryText: normalizeInlineText(args?.query, 240),
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_memory_search"
    },
    limit: clamp(Math.floor(Number(args?.top_k || 6)), 1, 20),
    tags: Array.isArray(args?.filters?.tags)
      ? args.filters.tags.map((entry) => normalizeInlineText(entry, 40)).filter(Boolean)
      : []
  });
}

export async function executeVoiceConversationSearchTool(manager: any, {
  session,
  args
}) {
  if (!manager.store || typeof manager.store.searchConversationWindows !== "function") {
    return {
      ok: false,
      matches: [],
      error: "conversation_history_unavailable"
    };
  }

  const query = normalizeInlineText(args?.query, 220);
  if (!query) {
    return {
      ok: false,
      matches: [],
      error: "query_required"
    };
  }

  const scope = String(args?.scope || "channel").trim().toLowerCase();
  const searchChannelId = scope === "guild" ? null : session?.textChannelId || null;
  const matches = manager.store.searchConversationWindows({
    guildId: String(session?.guildId || "").trim(),
    channelId: searchChannelId,
    queryText: query,
    limit: clamp(Math.floor(Number(args?.top_k || 3)), 1, 4),
    maxAgeHours: clamp(Math.floor(Number(args?.max_age_hours || 24 * 7)), 1, 24 * 30),
    before: 1,
    after: 1
  });

  return {
    ok: true,
    matches: Array.isArray(matches) ? matches : []
  };
}

export async function executeVoiceMemoryWriteTool(manager: any, {
  session,
  settings,
  args
}) {
  if (
    !manager.memory ||
    typeof manager.memory.searchDurableFacts !== "function" ||
    typeof manager.memory.rememberDirectiveLineDetailed !== "function"
  ) {
    return {
      ok: false,
      written: [],
      skipped: [],
      error: "memory_unavailable"
    };
  }
  const runtimeSession = manager.ensureSessionToolRuntimeState(session);
  if (!runtimeSession) {
    return {
      ok: false,
      written: [],
      skipped: [],
      error: "session_unavailable"
    };
  }

  const now = Date.now();
  const recentWindow = (Array.isArray(runtimeSession.memoryWriteWindow) ? runtimeSession.memoryWriteWindow : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && now - value <= 60_000);
  runtimeSession.memoryWriteWindow = recentWindow;
  const remainingWriteCapacity = Math.max(0, VOICE_MEMORY_WRITE_MAX_PER_MINUTE - recentWindow.length);
  if (remainingWriteCapacity <= 0) {
    return {
      ok: false,
      written: [],
      skipped: [],
      error: "write_rate_limited"
    };
  }

  const result = await executeSharedMemoryToolWrite({
    runtime: {
      memory: manager.memory
    },
    settings,
    guildId: String(session?.guildId || "").trim(),
    channelId: session?.textChannelId || null,
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    namespace: args?.namespace,
    items: Array.isArray(args?.items) ? args.items : [],
    trace: {
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_memory_write"
    },
    sourceMessageIdPrefix: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    limit: remainingWriteCapacity,
    dedupeThreshold: clamp(Number(args?.dedupe?.threshold), 0, 1) || 0.9,
    sensitivePattern: MEMORY_SENSITIVE_PATTERN_RE
  });
  if (result.ok && result.written.length > 0) {
    for (let i = 0; i < result.written.length; i += 1) {
      runtimeSession.memoryWriteWindow.push(now);
    }
    runtimeSession.memoryWriteWindow = runtimeSession.memoryWriteWindow
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && now - value <= 60_000);
  }

  return result;
}

export async function executeVoiceAdaptiveStyleAddTool(manager: any, {
  session,
  args
}) {
  if (
    !manager.store ||
    typeof manager.store.getActiveAdaptiveStyleNotes !== "function" ||
    typeof manager.store.addAdaptiveStyleNote !== "function" ||
    typeof manager.resolveVoiceSpeakerName !== "function"
  ) {
    return {
      ok: false,
      error: "adaptive_directive_unavailable"
    };
  }
  return await executeSharedAdaptiveDirectiveAdd({
    runtime: {
      store: manager.store
    },
    guildId: String(session?.guildId || "").trim(),
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    actorName: manager.resolveVoiceSpeakerName(session, session?.lastOpenAiToolCallerUserId || null),
    sourceMessageId: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    noteText: args?.note,
    directiveKind: args?.kind,
    source: "voice_tool"
  });
}

export async function executeVoiceAdaptiveStyleRemoveTool(manager: any, {
  session,
  args
}) {
  if (
    !manager.store ||
    typeof manager.store.getActiveAdaptiveStyleNotes !== "function" ||
    typeof manager.store.removeAdaptiveStyleNote !== "function" ||
    typeof manager.resolveVoiceSpeakerName !== "function"
  ) {
    return {
      ok: false,
      error: "adaptive_directive_unavailable"
    };
  }
  return await executeSharedAdaptiveDirectiveRemove({
    runtime: {
      store: manager.store
    },
    guildId: String(session?.guildId || "").trim(),
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    actorName: manager.resolveVoiceSpeakerName(session, session?.lastOpenAiToolCallerUserId || null),
    sourceMessageId: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    noteRef: args?.note_ref,
    target: args?.target,
    removalReason: args?.reason,
    source: "voice_tool"
  });
}

export async function executeVoiceMusicSearchTool(manager: any, { session, args }) {
  const query = normalizeInlineText(args?.query, 180);
  if (!query) {
    return {
      ok: false,
      tracks: [],
      error: "query_required"
    };
  }
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 10);
  const searchResponse = await manager.musicSearch.search(query, {
    platform: "auto",
    limit: maxResults
  });
  const runtimeSession = manager.ensureSessionToolRuntimeState(session);
  const catalog = runtimeSession?.toolMusicTrackCatalog instanceof Map
    ? runtimeSession.toolMusicTrackCatalog
    : new Map();
  if (runtimeSession && !(runtimeSession.toolMusicTrackCatalog instanceof Map)) {
    runtimeSession.toolMusicTrackCatalog = catalog;
  }
  const tracks = (Array.isArray(searchResponse?.results) ? searchResponse.results : [])
    .slice(0, maxResults)
    .map((row) => {
      const normalized = manager.normalizeMusicSelectionResult({
        id: row.id,
        title: row.title,
        artist: row.artist,
        platform: row.platform,
        externalUrl: row.externalUrl,
        durationSeconds: row.durationSeconds
      });
      if (!normalized) return null;
      catalog.set(normalized.id, normalized);
      return {
        id: normalized.id,
        title: normalized.title,
        artist: normalized.artist,
        durationMs: Number.isFinite(Number(normalized.durationSeconds))
          ? Math.max(0, Math.round(Number(normalized.durationSeconds) * 1000))
          : null,
        source: normalized.platform === "soundcloud" ? "sc" : "yt",
        streamUrl: normalized.externalUrl || null
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    query,
    tracks
  };
}

export async function executeVoiceMusicQueueAddTool(manager: any, { session, settings, args }) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = manager.ensureSessionToolRuntimeState(session);
  if (!queueState || !runtimeSession) {
    return {
      ok: false,
      queue_length: 0,
      added: [],
      error: "queue_unavailable"
    };
  }
  const requestedTrackIds = Array.isArray(args?.tracks)
    ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
    : [];
  if (!requestedTrackIds.length) {
    return {
      ok: false,
      queue_length: queueState.tracks.length,
      added: [],
      error: "tracks_required"
    };
  }
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map ? runtimeSession.toolMusicTrackCatalog : new Map();
  const resolvedTracks = requestedTrackIds
    .map((trackId) => {
      const fromCatalog = catalog.get(trackId);
      if (!fromCatalog) return null;
      return {
        id: fromCatalog.id,
        title: fromCatalog.title,
        artist: fromCatalog.artist,
        durationMs: Number.isFinite(Number(fromCatalog.durationSeconds))
          ? Math.max(0, Math.round(Number(fromCatalog.durationSeconds) * 1000))
          : null,
        source: fromCatalog.platform === "soundcloud" ? "sc" : "yt",
        streamUrl: fromCatalog.externalUrl || null,
        platform: fromCatalog.platform,
        externalUrl: fromCatalog.externalUrl
      };
    })
    .filter(Boolean);
  if (!resolvedTracks.length) {
    return {
      ok: false,
      queue_length: queueState.tracks.length,
      added: [],
      error: "unknown_track_ids"
    };
  }

  const wasEmpty = queueState.tracks.length === 0;
  const positionRaw = args?.position;
  const insertAt = typeof positionRaw === "number"
    ? clamp(Math.floor(Number(positionRaw)), 0, queueState.tracks.length)
    : queueState.tracks.length;
  queueState.tracks.splice(insertAt, 0, ...resolvedTracks);
  if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
    queueState.nowPlayingIndex = 0;
  }

  // Auto-play: if queue was empty and nothing is currently playing, start playback
  const shouldAutoPlay = wasEmpty && !manager.isMusicPlaybackActive(session) && !queueState.isPaused;
  if (shouldAutoPlay && settings) {
    const playIndex = queueState.nowPlayingIndex ?? 0;
    manager.playVoiceQueueTrackByIndex({ session, settings, index: playIndex }).catch(() => undefined);
  }

  return {
    ok: true,
    queue_length: queueState.tracks.length,
    added: resolvedTracks.map((entry) => entry.id),
    auto_playing: shouldAutoPlay,
    queue_state: {
      tracks: queueState.tracks.map((entry) => ({
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
        source: entry.source
      })),
      nowPlayingIndex: queueState.nowPlayingIndex,
      isPaused: queueState.isPaused
    }
  };
}

export async function executeVoiceMusicQueueNextTool(manager: any, { session, settings, args }) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = manager.ensureSessionToolRuntimeState(session);
  if (!queueState || !runtimeSession) {
    return {
      ok: false,
      queue_length: 0,
      added: [],
      error: "queue_unavailable"
    };
  }
  const requestedTrackIds = Array.isArray(args?.tracks)
    ? args.tracks.map((entry) => normalizeInlineText(entry, 180)).filter(Boolean).slice(0, 12)
    : [];
  if (!requestedTrackIds.length) {
    return {
      ok: false,
      queue_length: queueState.tracks.length,
      added: [],
      error: "tracks_required"
    };
  }
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map ? runtimeSession.toolMusicTrackCatalog : new Map();
  const resolvedTracks = requestedTrackIds
    .map((trackId) => {
      const fromCatalog = catalog.get(trackId);
      if (!fromCatalog) return null;
      return {
        id: fromCatalog.id,
        title: fromCatalog.title,
        artist: fromCatalog.artist,
        durationMs: Number.isFinite(Number(fromCatalog.durationSeconds))
          ? Math.max(0, Math.round(Number(fromCatalog.durationSeconds) * 1000))
          : null,
        source: fromCatalog.platform === "soundcloud" ? "sc" : "yt",
        streamUrl: fromCatalog.externalUrl || null,
        platform: fromCatalog.platform,
        externalUrl: fromCatalog.externalUrl
      };
    })
    .filter(Boolean);
  if (!resolvedTracks.length) {
    return {
      ok: false,
      queue_length: queueState.tracks.length,
      added: [],
      error: "unknown_track_ids"
    };
  }

  const insertAt = queueState.nowPlayingIndex == null
    ? queueState.tracks.length
    : clamp(queueState.nowPlayingIndex + 1, 0, queueState.tracks.length);
  queueState.tracks.splice(insertAt, 0, ...resolvedTracks);
  if (queueState.nowPlayingIndex == null && queueState.tracks.length > 0) {
    queueState.nowPlayingIndex = 0;
  }

  const shouldAutoPlay = !manager.isMusicPlaybackActive(session) && !queueState.isPaused;
  if (shouldAutoPlay && settings) {
    const playIndex = queueState.nowPlayingIndex ?? 0;
    await manager.playVoiceQueueTrackByIndex({ session, settings, index: playIndex });
  }

  return {
    ok: true,
    queue_length: queueState.tracks.length,
    added: resolvedTracks.map((entry) => entry.id),
    inserted_after_index: queueState.nowPlayingIndex,
    auto_playing: shouldAutoPlay,
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceMusicPlayNowTool(manager: any, { session, settings, args }) {
  const queueState = manager.ensureToolMusicQueueState(session);
  const runtimeSession = manager.ensureSessionToolRuntimeState(session);
  const trackId = normalizeInlineText(args?.track_id, 180);
  if (!queueState || !runtimeSession) {
    return {
      ok: false,
      error: "queue_unavailable"
    };
  }
  if (!trackId) {
    return {
      ok: false,
      error: "track_id_required"
    };
  }
  const catalog = runtimeSession.toolMusicTrackCatalog instanceof Map ? runtimeSession.toolMusicTrackCatalog : new Map();
  const selectedTrack = catalog.get(trackId);
  if (!selectedTrack) {
    return {
      ok: false,
      error: "unknown_track_id"
    };
  }

  const replacementTrack = {
    id: selectedTrack.id,
    title: selectedTrack.title,
    artist: selectedTrack.artist,
    durationMs: Number.isFinite(Number(selectedTrack.durationSeconds))
      ? Math.max(0, Math.round(Number(selectedTrack.durationSeconds) * 1000))
      : null,
    source: selectedTrack.platform === "soundcloud" ? "sc" : "yt",
    streamUrl: selectedTrack.externalUrl || null,
    platform: selectedTrack.platform,
    externalUrl: selectedTrack.externalUrl
  };
  const trailingTracks = queueState.nowPlayingIndex == null
    ? []
    : queueState.tracks.slice(Math.max(0, queueState.nowPlayingIndex + 1));
  queueState.tracks = [replacementTrack, ...trailingTracks];
  queueState.nowPlayingIndex = 0;
  queueState.isPaused = false;

  const trackInfo = { title: selectedTrack.title, artist: selectedTrack.artist };

  manager.requestPlayMusic({
    guildId: session.guildId,
    channelId: session.textChannelId,
    requestedByUserId: session.lastOpenAiToolCallerUserId || null,
    settings,
    query: normalizeInlineText(`${selectedTrack.title} ${selectedTrack.artist || ""}`, 120),
    trackId: selectedTrack.id,
    searchResults: [selectedTrack],
    reason: "voice_tool_music_play_now",
    source: "voice_tool_call",
    mustNotify: false
  })
    .then(() => {
      manager.requestRealtimePromptUtterance({
        session,
        prompt: `(system: "${trackInfo.title}" by ${trackInfo.artist} is now playing)`,
        source: "music_now_playing",
        interruptionPolicy: { assertive: true, scope: "speaker", allowedUserId: session.lastOpenAiToolCallerUserId || null, reason: "announcement", source: "music_now_playing" }
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "unknown error";
      manager.requestRealtimePromptUtterance({
        session,
        prompt: `(system: failed to load "${trackInfo.title}" — ${message})`,
        source: "music_play_failed",
        interruptionPolicy: { assertive: true, scope: "none", reason: "announcement", source: "music_play_failed" }
      });
    });

  return {
    ok: true,
    status: "loading",
    track: {
      id: replacementTrack.id,
      title: replacementTrack.title,
      artist: replacementTrack.artist,
      source: replacementTrack.source
    },
    queue_state: manager.buildVoiceQueueStatePayload(session)
  };
}

export async function executeVoiceWebSearchTool(manager: any, { session, settings, args }) {
  const query = normalizeInlineText(args?.query, 240);
  if (!query) {
    return {
      ok: false,
      results: [],
      answer: "",
      error: "query_required"
    };
  }
  if (!manager.search || typeof manager.search.searchAndRead !== "function") {
    return {
      ok: false,
      results: [],
      answer: "",
      error: "web_search_unavailable"
    };
  }

  const researchConfig = getResearchRuntimeConfig(settings);
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 8);
  const recencyDays = clamp(
    Math.floor(Number(args?.recency_days || researchConfig.localExternalSearch.recencyDaysDefault || 30)),
    1,
    3650
  );
  const toolSettings = deepMerge(deepMerge({}, settings || {}), {
    agentStack: {
      runtimeConfig: {
        research: {
          ...researchConfig,
          enabled: true,
          localExternalSearch: {
            ...researchConfig.localExternalSearch,
            maxResults,
            recencyDaysDefault: recencyDays
          }
        }
      }
    }
  });

  const searchResult = await manager.search.searchAndRead({
    settings: toolSettings,
    query,
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_web_search"
    }
  });
  const rows = (Array.isArray(searchResult?.results) ? searchResult.results : [])
    .slice(0, maxResults)
    .map((row) => ({
      title: normalizeInlineText(row?.title || row?.pageTitle, 220) || "",
      snippet: normalizeInlineText(row?.snippet || row?.pageSummary, 420) || "",
      url: normalizeInlineText(row?.url, 300) || "",
      source: normalizeInlineText(row?.provider, 60) || searchResult?.providerUsed || "web"
    }));
  const answer = [
    normalizeInlineText(searchResult?.summaryText, 1200),
    rows
      .slice(0, 3)
      .map((row) => row.snippet)
      .filter(Boolean)
      .join(" ")
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1200);
  return {
    ok: true,
    query,
    recency_days: recencyDays,
    results: rows,
    answer
  };
}

export async function executeVoiceWebScrapeTool(manager: any, { session, args }: { session: any, args: any }) {
  const url = String(args?.url || "").trim().slice(0, 2000);
  if (!url) {
    return { ok: false, text: "", error: "url_required" };
  }
  if (!manager.search || typeof manager.search.readPageSummary !== "function") {
    return { ok: false, text: "", error: "web_scrape_unavailable" };
  }

  const maxChars = clamp(Math.floor(Number(args?.max_chars) || 8000), 350, 24000);

  try {
    const result = await manager.search.readPageSummary(url, maxChars);
    const title = result?.title ? String(result.title).trim() : null;
    const body = String(result?.summary || "").trim();
    if (!body) {
      return {
        ok: true,
        text: `Page at ${url} returned no readable content. Try browser_browse for JS-rendered pages.`,
        title: null,
        url
      };
    }
    return {
      ok: true,
      title,
      url,
      text: body
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: "",
      url,
      error: `${message}. If the page requires JavaScript or interaction, try browser_browse.`
    };
  }
}

export async function executeVoiceBrowserBrowseTool(manager: any, { session, settings, args, signal }: { session: any, settings: any, args: any, signal?: AbortSignal }) {
  const instruction = normalizeInlineText(args?.query, 500);
  if (!instruction) {
    return { ok: false, text: "", error: "query_required" };
  }

  const sessionId = typeof args?.session_id === "string" ? String(args.session_id).trim() : "";

  // --- Multi-turn session continuation ---
  if (sessionId && manager.subAgentSessions) {
    const existingSession = manager.subAgentSessions.get(sessionId);
    if (!existingSession) {
      return { ok: false, text: "", error: `Browser session '${sessionId}' not found or expired.` };
    }
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session.lastOpenAiToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue browser session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(instruction);
      if (turnResult.isError) {
        return { ok: false, text: "", error: turnResult.errorMessage };
      }
      return {
        ok: true,
        text: turnResult.text.trim() || "Browser browse completed.",
        session_id: existingSession.id
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: "", error: message };
    }
  }

  // --- New interactive session (if session manager is available) ---
  if (manager.createBrowserAgentSession && manager.subAgentSessions) {
    const newSession = manager.createBrowserAgentSession({
      settings,
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    });

    if (newSession) {
      manager.subAgentSessions.register(newSession);
      try {
        const turnResult = await newSession.runTurn(instruction);
        if (turnResult.isError) {
          return { ok: false, text: "", error: turnResult.errorMessage, session_id: newSession.id };
        }
        return {
          ok: true,
          text: turnResult.text.trim() || "Browser browse completed.",
          session_id: newSession.id
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, text: "", error: message };
      }
    }
  }

  // --- Legacy one-shot fallback ---
  if (!manager.browserManager) {
    return { ok: false, text: "", error: "browser_unavailable" };
  }
  if (!manager.llm) {
    return { ok: false, text: "", error: "llm_unavailable" };
  }

  const browserTaskConfig = getResolvedBrowserTaskConfig(settings);
  const maxSteps = clamp(Number(browserTaskConfig.maxStepsPerTask) || 15, 1, 30);
  const stepTimeoutMs = clamp(Number(browserTaskConfig.stepTimeoutMs) || 30_000, 5_000, 120_000);
  if (browserTaskConfig.runtime === "openai_computer_use" && !manager.llm?.openai) {
    return { ok: false, text: "", error: "openai_computer_use_unavailable" };
  }

  try {
    const sessionKey = `voice:${String(session.id || session.guildId || "unknown")}:${Date.now()}`;
    const trace = {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_browser_browse"
    };
    const result =
      browserTaskConfig.runtime === "openai_computer_use"
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

    return {
      ok: true,
      text: result.text,
      steps: result.steps,
      hit_step_limit: result.hitStepLimit
    };
  } catch (error: unknown) {
    const message = isAbortError(error)
      ? "Browser session cancelled."
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, text: "", error: message };
  }
}

export async function executeVoiceCodeTaskTool(manager: any, { session, settings, args }: { session: any, settings: any, args: any }) {
  const task = normalizeInlineText(args?.task, 2000);
  if (!task) {
    return { ok: false, text: "", error: "task_required" };
  }

  const sessionId = typeof args?.session_id === "string" ? String(args.session_id).trim() : "";

  // --- Multi-turn session continuation ---
  if (sessionId && manager.subAgentSessions) {
    const existingSession = manager.subAgentSessions.get(sessionId);
    if (!existingSession) {
      return { ok: false, text: "", error: `Code session '${sessionId}' not found or expired.` };
    }
    if (existingSession.ownerUserId && existingSession.ownerUserId !== session.lastOpenAiToolCallerUserId) {
      return { ok: false, text: "", error: `Not authorized to continue code session '${sessionId}'.` };
    }
    try {
      const turnResult = await existingSession.runTurn(task);
      if (turnResult.isError) {
        return { ok: false, text: "", error: turnResult.errorMessage };
      }
      return {
        ok: true,
        text: turnResult.text.trim() || "Code task completed.",
        cost_usd: turnResult.costUsd || 0,
        session_id: existingSession.id
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: "", error: message };
    }
  }

  // --- New interactive session (if session manager is available) ---
  if (manager.createCodeAgentSession && manager.subAgentSessions) {
    const newSession = manager.createCodeAgentSession({
      settings,
      cwd: typeof args?.cwd === "string" ? String(args.cwd).trim() : undefined,
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
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
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, text: "", error: message };
      }
    }
  }

  // --- Legacy one-shot fallback ---
  if (!manager.runModelRequestedCodeTask) {
    return { ok: false, text: "", error: "code_agent_unavailable" };
  }

  try {
    const result = await manager.runModelRequestedCodeTask({
      settings,
      task,
      cwd: typeof args?.cwd === "string" ? String(args.cwd).trim() : undefined,
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_code_task"
    });

    if (result?.blockedByPermission) {
      return { ok: false, text: "", error: "restricted_to_allowed_users" };
    }
    if (result?.blockedByBudget) {
      return { ok: false, text: "", error: "rate_limited" };
    }
    if (result?.blockedByParallelLimit) {
      return { ok: false, text: "", error: "too_many_parallel_tasks" };
    }
    if (result?.error) {
      return { ok: false, text: "", error: String(result.error) };
    }

    return {
      ok: true,
      text: String(result?.text || "").trim() || "Code task completed.",
      cost_usd: result?.costUsd || 0
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: "", error: message };
  }
}

export async function executeLocalVoiceToolCall(manager: any, {
  session,
  settings,
  toolName,
  args,
  signal
}: { session: any, settings: any, toolName: any, args: any, signal?: AbortSignal }) {
  const normalizedToolName = normalizeInlineText(toolName, 120);
  if (!normalizedToolName) {
    throw new Error("missing_tool_name");
  }
  if (normalizedToolName === "memory_search") {
    return await manager.executeVoiceMemorySearchTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "memory_write") {
    return await manager.executeVoiceMemoryWriteTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "adaptive_directive_add") {
    return await manager.executeVoiceAdaptiveStyleAddTool({
      session,
      args
    });
  }
  if (normalizedToolName === "adaptive_directive_remove") {
    return await manager.executeVoiceAdaptiveStyleRemoveTool({
      session,
      args
    });
  }
  if (normalizedToolName === "conversation_search") {
    return await manager.executeVoiceConversationSearchTool({
      session,
      args
    });
  }
  if (normalizedToolName === "music_search") {
    return await manager.executeVoiceMusicSearchTool({
      session,
      args
    });
  }
  if (normalizedToolName === "music_queue_add") {
    return await manager.executeVoiceMusicQueueAddTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "music_queue_next") {
    return await manager.executeVoiceMusicQueueNextTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "music_play_now") {
    return await manager.executeVoiceMusicPlayNowTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "music_stop") {
    await manager.requestStopMusic({
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: session.lastOpenAiToolCallerUserId || null,
      settings,
      reason: "voice_tool_music_stop",
      source: "voice_tool_call",
      clearQueue: true,
      mustNotify: false
    });
    return {
      ok: true,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (normalizedToolName === "music_pause") {
    await manager.requestPauseMusic({
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: session.lastOpenAiToolCallerUserId || null,
      settings,
      reason: "voice_tool_music_pause",
      source: "voice_tool_call",
      mustNotify: false
    });
    const queueState = manager.ensureToolMusicQueueState(session);
    if (queueState) queueState.isPaused = true;
    return {
      ok: true,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (normalizedToolName === "music_resume") {
    manager.musicPlayer?.resume?.();
    // Transition to playing and re-lock the session
    manager.setMusicPhase(session, "playing");
    manager.haltSessionOutputForMusicPlayback(session, "music_resumed");
    const queueState = manager.ensureToolMusicQueueState(session);
    if (queueState) queueState.isPaused = false;
    return {
      ok: true,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (normalizedToolName === "music_skip") {
    const queueState = manager.ensureToolMusicQueueState(session);
    if (!queueState || queueState.nowPlayingIndex == null) {
      await manager.requestStopMusic({
        guildId: session.guildId,
        channelId: session.textChannelId,
        requestedByUserId: session.lastOpenAiToolCallerUserId || null,
        settings,
        reason: "voice_tool_music_skip_without_queue",
        source: "voice_tool_call",
        mustNotify: false
      });
      return {
        ok: true,
        queue_state: manager.buildVoiceQueueStatePayload(session)
      };
    }
    const nextIndex = queueState.nowPlayingIndex + 1;
    await manager.requestStopMusic({
      guildId: session.guildId,
      channelId: session.textChannelId,
      requestedByUserId: session.lastOpenAiToolCallerUserId || null,
      settings,
      reason: "voice_tool_music_skip",
      source: "voice_tool_call",
      mustNotify: false
    });
    if (nextIndex < queueState.tracks.length) {
      return await manager.playVoiceQueueTrackByIndex({
        session,
        settings,
        index: nextIndex
      });
    }
    queueState.nowPlayingIndex = null;
    queueState.isPaused = false;
    return {
      ok: true,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (normalizedToolName === "offer_screen_share_link") {
    const requesterUserId = normalizeInlineText(session.lastOpenAiToolCallerUserId, 80) || null;
    if (!requesterUserId || !session.guildId || !session.textChannelId) {
      return {
        ok: false,
        offered: false,
        error: "screen_share_context_unavailable"
      };
    }
    let transcript = "";
    const recentVoiceTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    for (let i = recentVoiceTurns.length - 1; i >= 0; i -= 1) {
      const turn = recentVoiceTurns[i];
      if (String(turn?.role || "") !== "user") continue;
      if (String(turn?.userId || "") !== requesterUserId) continue;
      transcript = normalizeInlineText(turn?.text, 220) || "";
      break;
    }
    const result = await manager.offerVoiceScreenShareLink({
      settings,
      guildId: session.guildId,
      channelId: session.textChannelId,
      requesterUserId,
      transcript,
      source: "voice_realtime_tool_call"
    });
    return {
      ok: Boolean(result?.offered || result?.reused),
      offered: Boolean(result?.offered),
      reused: Boolean(result?.reused),
      reason: normalizeInlineText(result?.reason, 120) || null,
      linkUrl: normalizeInlineText(result?.linkUrl, 320) || null,
      expiresInMinutes: Number.isFinite(Number(result?.expiresInMinutes))
        ? Math.max(0, Math.round(Number(result.expiresInMinutes)))
        : null
    };
  }
  if (normalizedToolName === "music_now_playing") {
    const queueState = manager.ensureToolMusicQueueState(session);
    const nowTrack =
      queueState && queueState.nowPlayingIndex != null ? queueState.tracks[queueState.nowPlayingIndex] || null : null;
    const musicState = manager.ensureSessionMusicState(session);
    return {
      ok: true,
      now_playing: nowTrack
        ? {
          ...nowTrack
        }
        : musicState?.lastTrackTitle
          ? {
            id: musicState.lastTrackId || null,
            title: musicState.lastTrackTitle,
            artist: Array.isArray(musicState.lastTrackArtists) ? musicState.lastTrackArtists.join(", ") : null,
            source: String(musicState.provider || "").trim().toLowerCase() === "discord" ? "yt" : "yt",
            streamUrl: musicState.lastTrackUrl || null
          }
          : null,
      queue_state: manager.buildVoiceQueueStatePayload(session)
    };
  }
  if (normalizedToolName === "web_search") {
    return await manager.executeVoiceWebSearchTool({
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "web_scrape") {
    return await executeVoiceWebScrapeTool(manager, {
      session,
      args
    });
  }
  if (normalizedToolName === "browser_browse") {
    return await executeVoiceBrowserBrowseTool(manager, {
      session,
      settings,
      args,
      signal
    });
  }
  if (normalizedToolName === "code_task") {
    return await executeVoiceCodeTaskTool(manager, {
      session,
      settings,
      args
    });
  }
  if (normalizedToolName === "leave_voice_channel") {
    // Schedule the leave after the tool output is sent and the model's
    // follow-up audio (goodbye) finishes playing.
    setTimeout(async () => {
      if (session.ending) return;
      await manager.waitForLeaveDirectivePlayback({
        session,
        expectRealtimeAudio: true,
        source: "realtime_tool_leave_directive"
      });
      await manager.endSession({
        guildId: session.guildId,
        reason: "assistant_leave_directive",
        requestedByUserId: manager.client.user?.id || null,
        settings,
        announcement: "wrapping up vc."
      }).catch(() => {});
    }, 0);
    return { ok: true, status: "leaving" };
  }
  throw new Error(`unsupported_tool:${normalizedToolName}`);
}

export async function executeMcpVoiceToolCall(manager: any, {
  session,
  settings: _settings,
  toolDescriptor,
  args
}) {
  const serverName = normalizeInlineText(toolDescriptor?.serverName, 80);
  const toolName = normalizeInlineText(toolDescriptor?.name, 120);
  if (!serverName || !toolName) {
    throw new Error("invalid_mcp_tool_descriptor");
  }
  const serverStatus = (Array.isArray(session?.mcpStatus) ? session.mcpStatus : [])
    .find((entry) => String(entry?.serverName || "") === serverName) || null;
  if (!serverStatus) {
    throw new Error(`mcp_server_not_found:${serverName}`);
  }

  const baseUrl = String(serverStatus.baseUrl || "").trim().replace(/\/+$/, "");
  const toolPath = String(serverStatus.toolPath || "/tools/call").trim() || "/tools/call";
  const targetUrl = `${baseUrl}${toolPath.startsWith("/") ? "" : "/"}${toolPath}`;
  const timeoutMs = clamp(Math.floor(Number(serverStatus.timeoutMs || 10_000)), 500, 60_000);
  const headers = {
    "content-type": "application/json",
    ...(serverStatus.headers && typeof serverStatus.headers === "object" ? serverStatus.headers : {})
  };

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        toolName,
        arguments: args && typeof args === "object" ? args : {}
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const bodyText = await response.text().catch(() => "");
    let payload: Record<string, unknown> | null = null;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = {
          output: bodyText
        };
      }
    }
    if (!response.ok) {
      const errorMessage = normalizeInlineText(payload?.error || payload?.message || bodyText, 400) || `HTTP_${response.status}`;
      manager.updateVoiceMcpStatus(session, serverName, {
        connected: false,
        lastError: errorMessage,
        lastCallAt: new Date().toISOString()
      });
      throw new Error(errorMessage);
    }
    manager.updateVoiceMcpStatus(session, serverName, {
      connected: true,
      lastError: null,
      lastCallAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString()
    });
    return {
      ok: payload?.ok === false ? false : true,
      output: Object.hasOwn(payload || {}, "output") ? payload?.output : payload,
      error: payload?.error || null
    };
  } catch (error) {
    const message = String(error?.message || error);
    manager.updateVoiceMcpStatus(session, serverName, {
      connected: false,
      lastError: message,
      lastCallAt: new Date().toISOString()
    });
    throw error;
  }
}
