import { clamp } from "../utils.ts";
import { executeVoiceBrowserBrowseTool, executeVoiceCodeTaskTool } from "./voiceToolCallAgents.ts";
import {
  executeVoiceConversationSearchTool,
  executeVoiceMemoryWriteTool
} from "./voiceToolCallMemory.ts";
import {
  executeVoiceMusicPlayTool,
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
import { maybeTriggerAssistantDirectedSoundboard } from "./voiceSoundboard.ts";
import type {
  VoiceRealtimeToolDescriptor,
  VoiceRealtimeToolSettings,
  VoiceSession,
  VoiceSessionSoundboardState,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";
import { throwIfAborted } from "../tools/browserTaskRuntime.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

function hasSoundboardSessionContext(
  session: ToolRuntimeSession | null | undefined
): session is ToolRuntimeSession & {
  ending: boolean;
  mode: string;
  guildId: string;
  textChannelId: string;
  id: string;
} {
  return Boolean(
    session &&
      typeof session.ending === "boolean" &&
      typeof session.mode === "string" &&
      typeof session.guildId === "string" &&
      typeof session.textChannelId === "string" &&
      typeof session.id === "string"
  );
}

function ensureSoundboardState(session: ToolRuntimeSession): VoiceSessionSoundboardState {
  const existing = session.soundboard;
  if (existing) return existing;
  const nextState: VoiceSessionSoundboardState = {
    playCount: 0,
    lastPlayedAt: 0,
    catalogCandidates: [],
    catalogFetchedAt: 0,
    lastDirectiveKey: "",
    lastDirectiveAt: 0
  };
  session.soundboard = nextState;
  return nextState;
}

function resolveSoundboardDirectiveSession(
  session: ToolRuntimeSession | null | undefined,
  settings: VoiceRealtimeToolSettings | null | undefined
): (ToolRuntimeSession & {
  ending: boolean;
  mode: string;
  guildId: string;
  textChannelId: string;
  id: string;
  settingsSnapshot: VoiceRealtimeToolSettings | null;
  soundboard: VoiceSessionSoundboardState;
}) | null {
  if (!hasSoundboardSessionContext(session)) {
    return null;
  }

  const settingsSnapshot = session.settingsSnapshot ?? settings ?? null;
  const soundboard = ensureSoundboardState(session);
  session.settingsSnapshot = settingsSnapshot;

  return Object.assign(session, {
    settingsSnapshot,
    soundboard
  });
}

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
  signal?: AbortSignal;
};

async function executeOfferScreenShareLinkTool(
  manager: VoiceToolCallManager,
  { session, settings }: { session?: ToolRuntimeSession | null; settings?: VoiceRealtimeToolSettings | null }
) {
  const requesterUserId = normalizeInlineText(session?.lastRealtimeToolCallerUserId, 80) || null;
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
    }).catch((error) => {
      manager.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: manager.client.user?.id || null,
        content: `assistant_leave_directive_end_session_failed: ${String(error instanceof Error ? error.message : error)}`,
        metadata: {
          sessionId: session.id,
          reason: "assistant_leave_directive"
        }
      });
    });
  }, 0);
}

async function executeVoicePlaySoundboardTool(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    args
  }: {
    session?: ToolRuntimeSession | null;
    settings?: VoiceRealtimeToolSettings | null;
    args?: VoiceToolCallArgs;
  }
) {
  const soundboardSession = resolveSoundboardDirectiveSession(session, settings);
  if (!soundboardSession || soundboardSession.ending) {
    return { ok: false, played: [], error: "soundboard_session_unavailable" };
  }

  const normalizedRefs = (Array.isArray(args?.refs) ? args.refs : [])
    .map((entry) => normalizeInlineText(entry, 180))
    .filter(Boolean)
    .slice(0, 10);
  if (normalizedRefs.length === 0) {
    return { ok: false, played: [], error: "soundboard_refs_required" };
  }

  const played: string[] = [];
  for (const requestedRef of normalizedRefs) {
    const previousPlayCount = Math.max(0, Number(soundboardSession.soundboard.playCount || 0));
    await maybeTriggerAssistantDirectedSoundboard(manager, {
      session: soundboardSession,
      settings,
      userId: manager.client.user?.id || null,
      transcript: "",
      requestedRef,
      source: "voice_realtime_tool_play_soundboard"
    });
    const nextPlayCount = Math.max(0, Number(soundboardSession.soundboard.playCount || 0));
    if (nextPlayCount > previousPlayCount) {
      played.push(requestedRef);
    }
  }

  return {
    ok: played.length > 0,
    played,
    error: played.length > 0 ? null : "soundboard_refs_unresolved"
  };
}

export async function executeLocalVoiceToolCall(manager: VoiceToolCallManager, opts: LocalVoiceToolCallOptions) {
  const normalizedToolName = normalizeInlineText(opts.toolName, 120);
  if (!normalizedToolName) {
    throw new Error("missing_tool_name");
  }

  switch (normalizedToolName) {
    case "memory_write":
      return executeVoiceMemoryWriteTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "conversation_search":
      return executeVoiceConversationSearchTool(manager, { session: opts.session, args: opts.args, signal: opts.signal });
    case "music_search":
      return executeVoiceMusicSearchTool(manager, { session: opts.session, args: opts.args, signal: opts.signal });
    case "music_play":
      return executeVoiceMusicPlayTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "music_queue_add":
      return executeVoiceMusicQueueAddTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "music_queue_next":
      return executeVoiceMusicQueueNextTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "music_stop":
      return executeVoiceMusicStopTool(manager, { session: opts.session, settings: opts.settings, signal: opts.signal });
    case "music_pause":
      return executeVoiceMusicPauseTool(manager, { session: opts.session, settings: opts.settings, signal: opts.signal });
    case "music_resume":
      return executeVoiceMusicResumeTool(manager, { session: opts.session, signal: opts.signal });
    case "music_skip":
      return executeVoiceMusicSkipTool(manager, { session: opts.session, settings: opts.settings, signal: opts.signal });
    case "music_now_playing":
      return executeVoiceMusicNowPlayingTool(manager, { session: opts.session, signal: opts.signal });
    case "play_soundboard":
      return executeVoicePlaySoundboardTool(manager, { session: opts.session, settings: opts.settings, args: opts.args });
    case "offer_screen_share_link":
      throwIfAborted(opts.signal, "Voice tool cancelled");
      return executeOfferScreenShareLinkTool(manager, { session: opts.session, settings: opts.settings });
    case "web_search":
      return executeVoiceWebSearchTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "web_scrape":
      return executeVoiceWebScrapeTool(manager, { session: opts.session, args: opts.args, signal: opts.signal });
    case "browser_browse":
      return executeVoiceBrowserBrowseTool(manager, {
        session: opts.session,
        settings: opts.settings,
        args: opts.args,
        signal: opts.signal
      });
    case "code_task":
      return executeVoiceCodeTaskTool(manager, { session: opts.session, settings: opts.settings, args: opts.args, signal: opts.signal });
    case "leave_voice_channel":
      throwIfAborted(opts.signal, "Voice tool cancelled");
      scheduleLeaveVoiceChannel(manager, { session: opts.session, settings: opts.settings });
      return { ok: true, status: "leaving" };
    default:
      throw new Error(`unsupported_tool:${normalizedToolName}`);
  }
}

export async function executeMcpVoiceToolCall(
  manager: VoiceToolCallManager,
  { session, settings: _settings, toolDescriptor, args, signal }: McpVoiceToolCallOptions
) {
  void _settings;
  throwIfAborted(signal, "Voice MCP tool cancelled");
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
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
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
