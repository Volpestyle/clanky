// Extracted Tool Call Methods
import { runBrowseAgent } from "../agents/browseAgent.ts";
import { clamp } from "../utils.ts";
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

export function ensureSessionToolRuntimeState(manager: any, session) {
  if (!session || typeof session !== "object") return null;
  if (!Array.isArray(session.toolCallEvents)) {
    session.toolCallEvents = [];
  }
  if (!(session.openAiPendingToolCalls instanceof Map)) {
    session.openAiPendingToolCalls = new Map();
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
    {
      toolType: "function",
      name: "memory_search",
      description: "Search durable memory facts by semantic relevance.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "integer", minimum: 1, maximum: 20 },
          namespace: { type: "string" },
          filters: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: { type: "string" }
              }
            },
            additionalProperties: false
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "memory_write",
      description: "Store durable memory facts with dedupe and safety limits.",
      parameters: {
        type: "object",
        properties: {
          namespace: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                metadata: {
                  type: "object",
                  properties: {
                    authorSpeakerId: { type: "string" }
                  },
                  additionalProperties: true
                }
              },
              required: ["text"],
              additionalProperties: true
            },
            minItems: 1,
            maxItems: 8
          },
          dedupe: {
            type: "object",
            properties: {
              strategy: { type: "string" },
              threshold: { type: "number", minimum: 0, maximum: 1 }
            },
            additionalProperties: false
          }
        },
        required: ["items"],
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_search",
      description: "Search for music tracks to queue or play.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: 10 }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_queue_add",
      description: "Add one or more track IDs to the voice music queue.",
      parameters: {
        type: "object",
        properties: {
          tracks: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 12
          },
          position: {
            oneOf: [
              { type: "string", enum: ["end"] },
              { type: "integer", minimum: 0 }
            ]
          }
        },
        required: ["tracks"],
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_play",
      description: "Start playing queue track by index, or resume current playback.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 }
        },
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_pause",
      description: "Pause music playback.",
      parameters: {
        type: "object",
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_resume",
      description: "Resume paused music playback.",
      parameters: {
        type: "object",
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_skip",
      description: "Skip current track and advance to next queued track.",
      parameters: {
        type: "object",
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "music_now_playing",
      description: "Read now-playing and queue status.",
      parameters: {
        type: "object",
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "web_search",
      description: "Run live web search and return condensed results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          recency_days: { type: "integer", minimum: 1, maximum: 3650 },
          max_results: { type: "integer", minimum: 1, maximum: 8 }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      toolType: "function",
      name: "browser_browse",
      description: "Browse a webpage interactively and report back with the result.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ];

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

  const includeWebSearch = Boolean(settings?.webSearch?.enabled);
  const includeMemory = Boolean(settings?.memory?.enabled);
  const includeBrowser = Boolean(settings?.browser?.enabled);
  const filteredLocalTools = localTools.filter((entry) => {
    if (entry.name === "web_search" && !includeWebSearch) return false;
    if ((entry.name === "memory_search" || entry.name === "memory_write") && !includeMemory) return false;
    if (entry.name === "browser_browse" && !includeBrowser) return false;
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
        args: callArgs
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

  const query = normalizeInlineText(args?.query, 240);
  if (!query) {
    return {
      ok: false,
      matches: [],
      error: "query_required"
    };
  }
  const topK = clamp(Math.floor(Number(args?.top_k || 6)), 1, 20);
  const scope = manager.resolveVoiceMemoryNamespaceScope({
    session,
    namespace: args?.namespace
  });
  if (!scope?.ok) {
    return {
      ok: false,
      matches: [],
      error: String(scope?.reason || "invalid_namespace")
    };
  }
  const tags = Array.isArray(args?.filters?.tags)
    ? args.filters.tags.map((entry) => normalizeInlineText(entry, 40)).filter(Boolean)
    : [];

  const rows = await manager.memory.searchDurableFacts({
    guildId: scope.guildId,
    channelId: session.textChannelId,
    queryText: query,
    settings,
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_memory_search"
    },
    limit: clamp(topK * 2, 1, 40)
  });

  const filtered = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (scope.subject && String(row?.subject || "").trim() !== scope.subject) return false;
      if (tags.length > 0 && !tags.includes(String(row?.fact_type || "").trim())) return false;
      return true;
    })
    .slice(0, topK)
    .map((row) => ({
      id: String(row?.id || ""),
      text: normalizeInlineText(row?.fact, 420) || "",
      score: Number.isFinite(Number(row?.score))
        ? Number(Number(row.score).toFixed(3))
        : Number.isFinite(Number(row?.semanticScore))
          ? Number(Number(row.semanticScore).toFixed(3))
          : 0,
      metadata: {
        createdAt: String(row?.created_at || ""),
        tags: [String(row?.fact_type || "").trim()].filter(Boolean)
      }
    }));

  return {
    ok: true,
    namespace: scope.namespace,
    matches: filtered
  };
}

export async function executeVoiceMemoryWriteTool(manager: any, {
  session,
  settings,
  args
}) {
  if (!manager.memory || typeof manager.memory.ensureFactVector !== "function") {
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

  const dedupeThreshold = clamp(Number(args?.dedupe?.threshold), 0, 1) || 0.9;
  const sourceItems = Array.isArray(args?.items) ? args.items : [];
  const items = sourceItems
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeInlineText(entry.text, 360);
      if (!text) return null;
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((tag) => normalizeInlineText(tag, 40)).filter(Boolean).slice(0, 6)
        : [];
      const authorSpeakerId = normalizeInlineText(entry?.metadata?.authorSpeakerId, 80) || null;
      return {
        text,
        tags,
        authorSpeakerId
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  if (!items.length) {
    return {
      ok: false,
      written: [],
      skipped: [],
      error: "items_required"
    };
  }

  const written = [];
  const skipped = [];
  let writesCommitted = 0;

  for (const item of items) {
    const scope = manager.resolveVoiceMemoryNamespaceScope({
      session,
      namespace: args?.namespace,
      authorSpeakerId: item.authorSpeakerId
    });
    if (!scope?.ok) {
      skipped.push({
        text: item.text,
        reason: String(scope?.reason || "invalid_namespace")
      });
      continue;
    }
    if (MEMORY_SENSITIVE_PATTERN_RE.test(item.text)) {
      skipped.push({
        text: item.text,
        reason: "sensitive_content"
      });
      continue;
    }

    const potentialDuplicates = typeof manager.memory.searchDurableFacts === "function"
      ? await manager.memory.searchDurableFacts({
        guildId: scope.guildId,
        channelId: session.textChannelId,
        queryText: item.text,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: session.lastOpenAiToolCallerUserId || null,
          source: "voice_realtime_tool_memory_dedupe"
        },
        limit: 8
      })
      : [];
    const hasDuplicate = (Array.isArray(potentialDuplicates) ? potentialDuplicates : []).some((row) => {
      if (scope.subject && String(row?.subject || "").trim() !== scope.subject) return false;
      const score = Math.max(
        Number.isFinite(Number(row?.score)) ? Number(row.score) : 0,
        Number.isFinite(Number(row?.semanticScore)) ? Number(row.semanticScore) : 0
      );
      return score >= dedupeThreshold;
    });
    if (hasDuplicate) {
      skipped.push({
        text: item.text,
        reason: "duplicate"
      });
      continue;
    }

    const sourceMessageId = `voice-tool-${session.id}-${Date.now()}-${written.length + skipped.length + 1}`;
    const factType = item.tags[0] || scope.factTypeDefault || "general";
    const inserted = manager.store.addMemoryFact({
      guildId: scope.guildId,
      channelId: session.textChannelId,
      subject: scope.subject,
      fact: item.text,
      factType,
      evidenceText: item.text,
      sourceMessageId,
      confidence: 0.8
    });
    if (!inserted) {
      skipped.push({
        text: item.text,
        reason: "write_failed"
      });
      continue;
    }

    const factRow = manager.store.getMemoryFactBySubjectAndFact(scope.guildId, scope.subject, item.text);
    if (factRow) {
      await manager.memory.ensureFactVector({
        factRow,
        settings,
        trace: {
          guildId: scope.guildId,
          channelId: session.textChannelId,
          userId: session.lastOpenAiToolCallerUserId || null,
          source: "voice_realtime_tool_memory_write"
        }
      });
    }
    written.push({
      id: String(factRow?.id || sourceMessageId),
      status: "inserted"
    });
    writesCommitted += 1;
    if (writesCommitted >= remainingWriteCapacity) break;
  }

  if (written.length > 0 && typeof manager.memory.queueMemoryRefresh === "function") {
    await manager.memory.queueMemoryRefresh();
  }
  if (written.length > 0) {
    for (let i = 0; i < writesCommitted; i += 1) {
      runtimeSession.memoryWriteWindow.push(now);
    }
    runtimeSession.memoryWriteWindow = runtimeSession.memoryWriteWindow
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && now - value <= 60_000);
  }

  return {
    ok: true,
    namespace: manager.resolveVoiceMemoryNamespaceScope({
      session,
      namespace: args?.namespace
    })?.namespace || `guild:${String(session.guildId || "").trim()}`,
    dedupeThreshold,
    written,
    skipped
  };
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

  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 8);
  const recencyDays = clamp(Math.floor(Number(args?.recency_days || settings?.webSearch?.recencyDaysDefault || 30)), 1, 3650);
  const toolSettings = {
    ...(settings || {}),
    webSearch: {
      ...((settings && typeof settings === "object" ? settings.webSearch : {}) || {}),
      enabled: true,
      maxResults,
      recencyDaysDefault: recencyDays
    }
  };

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
  const answer = rows
    .slice(0, 3)
    .map((row) => row.snippet)
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

export async function executeVoiceBrowserBrowseTool(manager: any, { session, settings, args }) {
  const instruction = normalizeInlineText(args?.query, 500);
  if (!instruction) {
    return { ok: false, text: "", error: "query_required" };
  }
  if (!manager.browserManager) {
    return { ok: false, text: "", error: "browser_unavailable" };
  }
  if (!manager.llm) {
    return { ok: false, text: "", error: "llm_unavailable" };
  }

  const maxSteps = clamp(Number(settings?.browser?.maxStepsPerTask) || 15, 1, 30);
  const stepTimeoutMs = clamp(Number(settings?.browser?.stepTimeoutMs) || 30_000, 5_000, 120_000);

  try {
    const result = await runBrowseAgent({
      llm: manager.llm,
      browserManager: manager.browserManager,
      store: manager.store,
      sessionKey: session.guildId,
      instruction,
      maxSteps,
      stepTimeoutMs,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: session.lastOpenAiToolCallerUserId || null,
        source: "voice_realtime_tool_browser_browse"
      }
    });

    manager.store.logAction({
      kind: "browser_browse_call",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: session.lastOpenAiToolCallerUserId || null,
      content: instruction.slice(0, 200),
      metadata: {
        steps: result.steps,
        hitStepLimit: result.hitStepLimit,
        totalCostUsd: result.totalCostUsd,
        source: "voice_realtime_tool_browser_browse"
      },
      usdCost: result.totalCostUsd
    });

    return {
      ok: true,
      text: result.text,
      steps: result.steps,
      hit_step_limit: result.hitStepLimit
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
  args
}) {
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
  if (normalizedToolName === "music_play") {
    return await manager.playVoiceQueueTrackByIndex({
      session,
      settings,
      index: Number(args?.index)
    });
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
    if (manager.musicPlayer?.isPaused?.()) {
      manager.musicPlayer.resume();
    } else if (manager.ensureSessionMusicState(session)?.lastTrackId) {
      manager.musicPlayer?.resume?.();
    }
    // Re-lock the session so bot goes quiet while music plays
    const musicState = manager.ensureSessionMusicState(session);
    if (musicState) musicState.active = true;
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
  if (normalizedToolName === "browser_browse") {
    return await executeVoiceBrowserBrowseTool(manager, {
      session,
      settings,
      args
    });
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
