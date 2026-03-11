import { clamp } from "../utils.ts";
import {
  getMemorySettings,
  getResolvedBrowserTaskConfig,
  getVoiceSoundboardSettings,
  isBrowserEnabled,
  isDevTaskEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";
import {
  BROWSER_BROWSE_SCHEMA,
  CODE_TASK_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA,
  OFFER_SCREEN_SHARE_LINK_SCHEMA,
  MEMORY_WRITE_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_PLAY_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_REPLY_HANDOFF_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_SEARCH_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_STOP_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
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
type RealtimeToolExportTarget = string;

const BASE_REALTIME_TOOL_SCHEMAS = [
  MEMORY_WRITE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  MUSIC_SEARCH_SCHEMA,
  MUSIC_PLAY_SCHEMA,
  MUSIC_QUEUE_ADD_SCHEMA,
  MUSIC_QUEUE_NEXT_SCHEMA,
  MUSIC_STOP_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_REPLY_HANDOFF_SCHEMA,
  MUSIC_RESUME_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_NOW_PLAYING_SCHEMA,
  PLAY_SOUNDBOARD_SCHEMA,
  LEAVE_VOICE_CHANNEL_SCHEMA,
  WEB_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  BROWSER_BROWSE_SCHEMA,
  CODE_TASK_SCHEMA
];

function shouldIncludeLocalRealtimeTool(name: string, options: {
  includeBrowser: boolean;
  includeCodeAgent: boolean;
  includeMemory: boolean;
  includeSoundboard: boolean;
  includeWebSearch: boolean;
}) {
  if ((name === "web_search" || name === "web_scrape") && !options.includeWebSearch) return false;
  if (name === "memory_write" && !options.includeMemory) return false;
  if (name === "browser_browse" && !options.includeBrowser) return false;
  if (name === "code_task" && !options.includeCodeAgent) return false;
  if (name === "play_soundboard" && !options.includeSoundboard) return false;
  return true;
}

function resolveRealtimeToolExportTarget({
  session,
  target = null
}: {
  session?: ToolRuntimeSession | null;
  target?: string | null;
} = {}): RealtimeToolExportTarget {
  return String(target || session?.mode || "generic")
    .trim()
    .toLowerCase() || "generic";
}

function sanitizeProviderNativeRealtimeParameters(parameters: unknown): Record<string, unknown> {
  const source =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? { ...(parameters as Record<string, unknown>) }
      : {};

  delete source.anyOf;
  delete source.oneOf;
  delete source.allOf;
  delete source.not;
  delete source.enum;

  const properties =
    source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? source.properties
      : {};

  return {
    ...source,
    type: "object",
    properties,
    additionalProperties:
      typeof source.additionalProperties === "boolean" ? source.additionalProperties : true
  };
}

function adaptRealtimeToolParametersForTarget(
  parameters: Record<string, unknown>,
  target: RealtimeToolExportTarget
) {
  if (target === "openai_realtime" || target === "xai_realtime" || target === "voice_agent") {
    return sanitizeProviderNativeRealtimeParameters(parameters);
  }
  return parameters;
}

function adaptRealtimeToolDescriptorForTarget(
  descriptor: VoiceRealtimeToolDescriptor,
  target: RealtimeToolExportTarget
): VoiceRealtimeToolDescriptor {
  return {
    ...descriptor,
    parameters: adaptRealtimeToolParametersForTarget(descriptor.parameters, target)
  };
}

export function ensureSessionToolRuntimeState(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined
) {
  if (!session || typeof session !== "object") return null;
  if (!Array.isArray(session.toolCallEvents)) session.toolCallEvents = [];
  if (!(session.toolMusicTrackCatalog instanceof Map)) session.toolMusicTrackCatalog = new Map();
  if (!Array.isArray(session.memoryWriteWindow)) session.memoryWriteWindow = [];
  if (!session.mcpStatus || !Array.isArray(session.mcpStatus)) {
    session.mcpStatus = getVoiceMcpServerStatuses(manager).map((entry) => ({ ...entry }));
  }
  if (session.realtimeToolOwnership === "provider_native") {
    if (!(session.realtimePendingToolCalls instanceof Map)) session.realtimePendingToolCalls = new Map();
    if (!(session.realtimeCompletedToolCallIds instanceof Map)) session.realtimeCompletedToolCallIds = new Map();
    if (!(session.realtimeToolCallExecutions instanceof Map)) session.realtimeToolCallExecutions = new Map();
    if (!(session.realtimeResponsesWithAssistantOutput instanceof Map)) {
      session.realtimeResponsesWithAssistantOutput = new Map();
    }
    if (typeof session.realtimeToolFollowupNeeded !== "boolean") session.realtimeToolFollowupNeeded = false;
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
  {
    session,
    settings,
    target = null
  }: {
    session?: ToolRuntimeSession | null;
    settings?: VoiceRealtimeToolSettings | null;
    target?: string | null;
  } = {}
) {
  const exportTarget = resolveRealtimeToolExportTarget({ session, target });
  const localTools = BASE_REALTIME_TOOL_SCHEMAS
    .map((schema) => adaptRealtimeToolDescriptorForTarget(toRealtimeTool(schema), exportTarget));
  const screenShareCapability =
    typeof manager.getVoiceScreenShareCapability === "function"
      ? manager.getVoiceScreenShareCapability({
          settings,
          guildId: session?.guildId || null,
          channelId: session?.textChannelId || null,
          requesterUserId: session?.lastRealtimeToolCallerUserId || null
        })
      : null;
  if (
    screenShareCapability?.available &&
    typeof manager.offerVoiceScreenShareLink === "function" &&
    session?.guildId &&
    session?.textChannelId
  ) {
    localTools.push(
      adaptRealtimeToolDescriptorForTarget(toRealtimeTool(OFFER_SCREEN_SHARE_LINK_SCHEMA), exportTarget)
    );
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
          parameters: adaptRealtimeToolParametersForTarget(
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", additionalProperties: true },
            exportTarget
          ),
          serverName,
          continuationPolicy: "always"
        };
      })
      .filter((entry): entry is VoiceRealtimeToolDescriptor => Boolean(entry));
  });

  const includeWebSearch = isResearchEnabled(settings);
  const includeMemory = Boolean(getMemorySettings(settings).enabled);
  const includeSoundboard = Boolean(getVoiceSoundboardSettings(settings).enabled);
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
        includeBrowser,
        includeCodeAgent,
        includeMemory,
        includeSoundboard,
        includeWebSearch
      })
    ),
    ...mcpTools
  ];
}

export function buildRealtimeFunctionTools(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    target = null
  }: {
    session?: ToolRuntimeSession | null;
    settings?: VoiceRealtimeToolSettings | null;
    target?: string | null;
  } = {}
): RealtimeFunctionTool[] {
  return resolveVoiceRealtimeToolDescriptors(manager, { session, settings, target }).map((entry) => ({
    type: "function",
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    toolType: entry.toolType,
    serverName: entry.serverName || null,
    continuationPolicy: entry.continuationPolicy
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

export function parseRealtimeToolArguments(manager: VoiceToolCallManager, argumentsText = "") {
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

export function resolveRealtimeToolDescriptor(
  manager: VoiceToolCallManager,
  session: ToolRuntimeSession | null | undefined,
  toolName = ""
) {
  const normalizedToolName = normalizeInlineText(toolName, 120);
  if (!normalizedToolName) return null;
  const configuredTools = Array.isArray(session?.realtimeToolDefinitions)
    ? session.realtimeToolDefinitions
    : buildRealtimeFunctionTools(manager, {
        session,
        settings: session?.settingsSnapshot || manager.store.getSettings(),
        target: session?.mode || null
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
