import { clamp } from "../utils.ts";
import {
  getDirectiveSettings,
  getMemorySettings,
  getResolvedBrowserTaskConfig,
  isBrowserEnabled,
  isDevTaskEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";
import {
  ADAPTIVE_DIRECTIVE_ADD_SCHEMA,
  ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  CODE_TASK_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_PLAY_NOW_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_SEARCH_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_STOP_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  WEB_SEARCH_SCHEMA,
  toRealtimeTool
} from "../tools/sharedToolSchemas.ts";
import { OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS, OPENAI_TOOL_CALL_EVENT_MAX } from "./voiceSessionManager.constants.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import type {
  VoiceMcpServerStatus,
  VoiceRealtimeToolDescriptor,
  VoiceRealtimeToolSettings,
  VoiceToolCallEvent,
  VoiceSession,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";
import type { RealtimeFunctionTool, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

const BASE_REALTIME_TOOL_SCHEMAS = [
  MEMORY_SEARCH_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  ADAPTIVE_DIRECTIVE_ADD_SCHEMA,
  ADAPTIVE_DIRECTIVE_REMOVE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
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
  WEB_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  CODE_TASK_SCHEMA
];

function shouldIncludeLocalRealtimeTool(name: string, options: {
  includeAdaptiveDirectives: boolean;
  includeBrowser: boolean;
  includeCodeAgent: boolean;
  includeMemory: boolean;
  includeWebSearch: boolean;
}) {
  if ((name === "web_search" || name === "web_scrape") && !options.includeWebSearch) return false;
  if ((name === "memory_search" || name === "memory_write") && !options.includeMemory) return false;
  if ((name === "adaptive_directive_add" || name === "adaptive_directive_remove") && !options.includeAdaptiveDirectives) {
    return false;
  }
  if (name === "browser_browse" && !options.includeBrowser) return false;
  if (name === "code_task" && !options.includeCodeAgent) return false;
  return true;
}

export function ensureSessionToolRuntimeState(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined
) {
  if (!session || typeof session !== "object") return null;
  if (!Array.isArray(session.toolCallEvents)) session.toolCallEvents = [];
  if (!(session.openAiPendingToolCalls instanceof Map)) session.openAiPendingToolCalls = new Map();
  if (!(session.openAiCompletedToolCallIds instanceof Map)) session.openAiCompletedToolCallIds = new Map();
  if (!(session.openAiToolCallExecutions instanceof Map)) session.openAiToolCallExecutions = new Map();
  if (!(session.toolMusicTrackCatalog instanceof Map)) session.toolMusicTrackCatalog = new Map();
  if (!Array.isArray(session.memoryWriteWindow)) session.memoryWriteWindow = [];
  if (!session.mcpStatus || !Array.isArray(session.mcpStatus)) {
    session.mcpStatus = getVoiceMcpServerStatuses(manager).map((entry) => ({ ...entry }));
  }
  return session;
}

export function getVoiceMcpServerStatuses(manager: VoiceToolCallManager) {
  const servers = Array.isArray(manager.appConfig?.voiceMcpServers) ? manager.appConfig.voiceMcpServers : [];
  return servers
    .map((server) => {
      if (!server || typeof server !== "object") return null;
      const serverName = normalizeInlineText(server.serverName || server.name, 80);
      const baseUrl = normalizeInlineText(server.baseUrl, 280);
      if (!serverName || !baseUrl) return null;
      const tools = Array.isArray(server.tools)
        ? server.tools
            .map((tool) => {
              if (!tool || typeof tool !== "object") return null;
              const name = normalizeInlineText(tool.name, 120);
              if (!name) return null;
              return {
                name,
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
        tools,
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

export function resolveVoiceRealtimeToolDescriptors(
  manager: VoiceToolCallManager,
  { session, settings }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null } = {}
) {
  const localTools = BASE_REALTIME_TOOL_SCHEMAS.map((schema) => toRealtimeTool(schema));
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
      parameters: { type: "object", additionalProperties: false }
    });
  }

  const sessionState = ensureSessionToolRuntimeState(manager, session);
  const mcpTools = (Array.isArray(sessionState?.mcpStatus) ? sessionState.mcpStatus : []).flatMap((server) => {
    const serverName = normalizeInlineText(server?.serverName, 80);
    if (!serverName) return [];
    return (Array.isArray(server?.tools) ? server.tools : [])
      .map((tool): VoiceRealtimeToolDescriptor | null => {
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
              : { type: "object", additionalProperties: true },
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
  const includeCodeAgent = Boolean(
    isDevTaskEnabled(settings) && ((manager.createCodeAgentSession && manager.subAgentSessions) || manager.runModelRequestedCodeTask)
  );
  return [
    ...localTools.filter((entry) =>
      shouldIncludeLocalRealtimeTool(entry.name, {
        includeAdaptiveDirectives,
        includeBrowser,
        includeCodeAgent,
        includeMemory,
        includeWebSearch
      })
    ),
    ...mcpTools
  ];
}

export function buildRealtimeFunctionTools(
  manager: VoiceToolCallManager,
  { session, settings }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null } = {}
): RealtimeFunctionTool[] {
  return resolveVoiceRealtimeToolDescriptors(manager, { session, settings }).map((entry) => ({
    type: "function",
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    toolType: entry.toolType,
    serverName: entry.serverName || null
  }));
}

export function recordVoiceToolCallEvent(
  manager: VoiceToolCallManager,
  { session, event }: { session?: ToolRuntimeSession | null; event?: VoiceToolCallEvent | null } = {}
) {
  if (!session || !event) return;
  ensureSessionToolRuntimeState(manager, session);
  const events = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  events.push(event);
  session.toolCallEvents = events.length > OPENAI_TOOL_CALL_EVENT_MAX ? events.slice(-OPENAI_TOOL_CALL_EVENT_MAX) : events;
}

export function parseOpenAiRealtimeToolArguments(manager: VoiceToolCallManager, argumentsText = "") {
  void manager;
  const normalizedText = String(argumentsText || "").trim().slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
  if (!normalizedText) return {};
  try {
    const parsed = JSON.parse(normalizedText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveOpenAiRealtimeToolDescriptor(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined,
  toolName = ""
) {
  const normalizedToolName = normalizeInlineText(toolName, 120);
  if (!normalizedToolName) return null;
  const configuredTools = Array.isArray(session?.openAiToolDefinitions)
    ? session.openAiToolDefinitions
    : buildRealtimeFunctionTools(manager, {
        session,
        settings: session?.settingsSnapshot || manager.store.getSettings()
      });
  return configuredTools.find((tool) => String(tool?.name || "") === normalizedToolName) || null;
}

export function summarizeVoiceToolOutput(manager: VoiceToolCallManager, output: unknown = null) {
  void manager;
  if (output == null) return null;
  if (typeof output === "string") return normalizeInlineText(output, 280) || null;
  try {
    return normalizeInlineText(JSON.stringify(output), 280) || null;
  } catch {
    return normalizeInlineText(String(output), 280) || null;
  }
}
