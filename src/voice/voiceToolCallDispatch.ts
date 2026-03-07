import { clamp } from "../utils.ts";
import { executeVoiceBrowserBrowseTool, executeVoiceCodeTaskTool } from "./voiceToolCallAgents.ts";
import { executeVoiceAdaptiveStyleAddTool, executeVoiceAdaptiveStyleRemoveTool } from "./voiceToolCallDirectives.ts";
import {
  executeVoiceConversationSearchTool,
  executeVoiceMemorySearchTool,
  executeVoiceMemoryWriteTool
} from "./voiceToolCallMemory.ts";
import {
  executeVoiceMusicPlayNowTool,
  executeVoiceMusicQueueAddTool,
  executeVoiceMusicQueueNextTool,
  executeVoiceMusicNowPlayingTool,
  executeVoiceMusicPauseTool,
  executeVoiceMusicSearchTool,
  executeVoiceMusicResumeTool,
  executeVoiceMusicSkipTool,
  executeVoiceMusicStopTool
} from "./voiceToolCallMusic.ts";
import { executeVoiceWebScrapeTool, executeVoiceWebSearchTool } from "./voiceToolCallWeb.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import type {
  VoiceRealtimeToolDescriptor,
  VoiceRealtimeToolSettings,
  VoiceSession,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type LocalVoiceToolCallOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  toolName: string;
  args?: VoiceToolCallArgs;
  signal?: AbortSignal;
};

type McpVoiceToolCallOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  toolDescriptor: VoiceRealtimeToolDescriptor | null | undefined;
  args?: VoiceToolCallArgs;
};

async function executeOfferScreenShareLinkTool(
  manager: VoiceToolCallManager,
  { session, settings }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null }
) {
  const requesterUserId = normalizeInlineText(session?.lastOpenAiToolCallerUserId, 80) || null;
  if (!requesterUserId || !session?.guildId || !session?.textChannelId) {
    return { ok: false, offered: false, error: "screen_share_context_unavailable" };
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

function scheduleLeaveVoiceChannel(
  manager: VoiceToolCallManager,
  { session, settings }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null }
) {
  setTimeout(async () => {
    if (!session || session.ending) return;
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
}

export async function executeLocalVoiceToolCall(manager: VoiceToolCallManager, opts: LocalVoiceToolCallOptions) {
  const normalizedToolName = normalizeInlineText(opts.toolName, 120);
  if (!normalizedToolName) {
    throw new Error("missing_tool_name");
  }

  switch (normalizedToolName) {
    case "memory_search":
      return executeVoiceMemorySearchTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "memory_write":
      return executeVoiceMemoryWriteTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "adaptive_directive_add":
      return executeVoiceAdaptiveStyleAddTool(manager, { session: opts.session, args: opts.args });
    case "adaptive_directive_remove":
      return executeVoiceAdaptiveStyleRemoveTool(manager, { session: opts.session, args: opts.args });
    case "conversation_search":
      return executeVoiceConversationSearchTool(manager, { session: opts.session, args: opts.args });
    case "music_search":
      return executeVoiceMusicSearchTool(manager, { session: opts.session, args: opts.args });
    case "music_queue_add":
      return executeVoiceMusicQueueAddTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "music_queue_next":
      return executeVoiceMusicQueueNextTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "music_play_now":
      return executeVoiceMusicPlayNowTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "music_stop":
      return executeVoiceMusicStopTool(manager, { session: opts.session, settings: opts.settings });
    case "music_pause":
      return executeVoiceMusicPauseTool(manager, { session: opts.session, settings: opts.settings });
    case "music_resume":
      return executeVoiceMusicResumeTool(manager, { session: opts.session });
    case "music_skip":
      return executeVoiceMusicSkipTool(manager, { session: opts.session, settings: opts.settings });
    case "music_now_playing":
      return executeVoiceMusicNowPlayingTool(manager, { session: opts.session });
    case "offer_screen_share_link":
      return executeOfferScreenShareLinkTool(manager, { session: opts.session, settings: opts.settings });
    case "web_search":
      return executeVoiceWebSearchTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "web_scrape":
      return executeVoiceWebScrapeTool(manager, { session: opts.session, args: opts.args });
    case "browser_browse":
      return executeVoiceBrowserBrowseTool(manager, {
        session: opts.session,
        settings: opts.settings,
        args: opts.args,
        signal: opts.signal
      });
    case "code_task":
      return executeVoiceCodeTaskTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "leave_voice_channel":
      scheduleLeaveVoiceChannel(manager, { session: opts.session, settings: opts.settings });
      return { ok: true, status: "leaving" };
    default:
      throw new Error(`unsupported_tool:${normalizedToolName}`);
  }
}

export async function executeMcpVoiceToolCall(
  manager: VoiceToolCallManager,
  { session, settings: _settings, toolDescriptor, args }: McpVoiceToolCallOptions
) {
  void _settings;
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
        payload = { output: bodyText };
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
