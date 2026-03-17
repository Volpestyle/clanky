import { clamp } from "../utils.ts";
import {
  getMemorySettings,
  getResolvedBrowserTaskConfig,
  getVoiceSoundboardSettings,
  isBrowserEnabled,
  isDevTaskEnabled,
  isResearchEnabled
} from "../settings/agentStack.ts";
import { toRealtimeTool } from "../tools/sharedToolSchemas.ts";
import { buildVoiceRealtimeLocalToolSchemas } from "../tools/toolRegistry.ts";
import { OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS, OPENAI_TOOL_CALL_EVENT_MAX } from "./voiceSessionManager.constants.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import { summarizeVoiceToolResult } from "./voiceToolResultSummary.ts";
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
  const screenShareCapability =
    typeof manager.getVoiceScreenWatchCapability === "function"
      ? manager.getVoiceScreenWatchCapability({
          settings,
          guildId: session?.guildId || null,
          channelId: session?.textChannelId || null,
          requesterUserId: session?.lastRealtimeToolCallerUserId || null
        })
      : null;

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
  const computerUseClient =
    browserTaskConfig.runtime === "openai_computer_use"
      ? manager.llm?.getComputerUseClient?.(browserTaskConfig.openaiComputerUse.client)
      : null;
  const includeBrowser = Boolean(
    isBrowserEnabled(settings) &&
      manager.browserManager &&
      (browserTaskConfig.runtime !== "openai_computer_use" || computerUseClient?.client)
  );
  const includeCodeAgent = Boolean(
    isDevTaskEnabled(settings) && ((manager.createCodeAgentSession && manager.subAgentSessions) || manager.runModelRequestedCodeTask)
  );
  const includeScreenShare = Boolean(
    screenShareCapability?.available &&
      typeof manager.startVoiceScreenWatch === "function" &&
      session?.guildId &&
      (screenShareCapability?.nativeAvailable || session?.textChannelId)
  );
  const sessionStreamWatch = (session as { streamWatch?: { active?: boolean; latestFrameDataBase64?: string } } | null)?.streamWatch;
  const includeScreenShareSnapshot = Boolean(
    sessionStreamWatch?.active &&
    String(sessionStreamWatch?.latestFrameDataBase64 || "").trim()
  );
  const localTools = buildVoiceRealtimeLocalToolSchemas({
    browserAvailable: includeBrowser,
    codeAgentAvailable: includeCodeAgent,
    memoryAvailable: includeMemory,
    screenShareAvailable: includeScreenShare,
    screenShareSnapshotAvailable: includeScreenShareSnapshot,
    soundboardAvailable: includeSoundboard,
    webSearchAvailable: includeWebSearch
  }).map((schema) => adaptRealtimeToolDescriptorForTarget(toRealtimeTool(schema), exportTarget));
  return [
    ...localTools,
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

export function summarizeVoiceToolOutput(
  manager: VoiceToolCallManager,
  toolName = "",
  output: unknown = null
) {
  void manager;
  return summarizeVoiceToolResult(toolName, output);
}
