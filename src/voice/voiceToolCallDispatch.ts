import { clamp } from "../utils.ts";
import {
  executeVoiceBrowserBrowseTool,
  executeVoiceCodeTaskTool,
  executeVoiceMinecraftTaskTool,
  executeVoiceShareBrowserSessionTool,
  executeVoiceStopVideoShareTool
} from "./voiceToolCallAgents.ts";
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
  executeVoiceMusicReplyHandoffTool,
  executeVoiceMusicResumeTool,
  executeVoiceMusicSkipTool,
  executeVoiceMusicStopTool,
  executeVoiceStreamVisualizerTool,
  executeVoiceVideoPlayTool,
  executeVoiceVideoSearchTool
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

const LOCAL_VOICE_TOOL_HANDLERS: Record<
  string,
  (manager: VoiceToolCallManager, opts: LocalVoiceToolCallOptions) => Promise<Record<string, unknown>>
> = {
  memory_write: async (manager, opts) =>
    await executeVoiceMemoryWriteTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  conversation_search: async (manager, opts) =>
    await executeVoiceConversationSearchTool(manager, {
      session: opts.session,
      args: opts.args,
      signal: opts.signal
    }),
  music_search: async (manager, opts) =>
    await executeVoiceMusicSearchTool(manager, {
      session: opts.session,
      args: opts.args,
      signal: opts.signal
    }),
  music_play: async (manager, opts) =>
    await executeVoiceMusicPlayTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  video_search: async (manager, opts) =>
    await executeVoiceVideoSearchTool(manager, {
      session: opts.session,
      args: opts.args,
      signal: opts.signal
    }),
  video_play: async (manager, opts) =>
    await executeVoiceVideoPlayTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  music_queue_add: async (manager, opts) =>
    await executeVoiceMusicQueueAddTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  music_queue_next: async (manager, opts) =>
    await executeVoiceMusicQueueNextTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  media_stop: async (manager, opts) =>
    await executeVoiceMusicStopTool(manager, {
      session: opts.session,
      settings: opts.settings,
      signal: opts.signal
    }),
  media_pause: async (manager, opts) =>
    await executeVoiceMusicPauseTool(manager, {
      session: opts.session,
      settings: opts.settings,
      signal: opts.signal
    }),
  media_reply_handoff: async (manager, opts) =>
    await executeVoiceMusicReplyHandoffTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  media_resume: async (manager, opts) =>
    await executeVoiceMusicResumeTool(manager, {
      session: opts.session,
      signal: opts.signal
    }),
  media_skip: async (manager, opts) =>
    await executeVoiceMusicSkipTool(manager, {
      session: opts.session,
      settings: opts.settings,
      signal: opts.signal
    }),
  media_now_playing: async (manager, opts) =>
    await executeVoiceMusicNowPlayingTool(manager, {
      session: opts.session,
      signal: opts.signal
    }),
  play_soundboard: async (manager, opts) =>
    await executeVoicePlaySoundboardTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args
    }),
  start_screen_watch: async (manager, opts) => {
    throwIfAborted(opts.signal, "Voice tool cancelled");
    return await executeStartScreenWatchTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args
    });
  },
  see_screenshare_snapshot: async (_manager, opts) => {
    throwIfAborted(opts.signal, "Voice tool cancelled");
    const sw = (opts.session as { streamWatch?: {
      active?: boolean;
      latestFrameDataBase64?: string;
      latestFrameMimeType?: string;
      latestFrameAt?: number;
      targetUserId?: string;
    } } | null)?.streamWatch;
    if (!sw?.active) {
      return { ok: false, error: "No active screen watch." };
    }
    const dataBase64 = String(sw.latestFrameDataBase64 || "").trim();
    if (!dataBase64) {
      return { ok: false, error: "No recent frame available." };
    }
    return {
      ok: true,
      streamerName: sw.targetUserId || null,
      frameAgeMs: Math.max(0, Date.now() - Number(sw.latestFrameAt || 0)),
      mimeType: String(sw.latestFrameMimeType || "image/jpeg"),
      dataBase64
    };
  },
  web_search: async (manager, opts) =>
    await executeVoiceWebSearchTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  web_scrape: async (manager, opts) =>
    await executeVoiceWebScrapeTool(manager, {
      session: opts.session,
      args: opts.args,
      signal: opts.signal
    }),
  browser_browse: async (manager, opts) =>
    await executeVoiceBrowserBrowseTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  stream_visualizer: async (manager, opts) =>
    await executeVoiceStreamVisualizerTool(manager, {
      session: opts.session,
      args: opts.args,
      signal: opts.signal
    }),
  share_browser_session: async (manager, opts) =>
    await executeVoiceShareBrowserSessionTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  stop_video_share: async (manager, opts) =>
    await executeVoiceStopVideoShareTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  code_task: async (manager, opts) =>
    await executeVoiceCodeTaskTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  minecraft_task: async (manager, opts) =>
    await executeVoiceMinecraftTaskTool(manager, {
      session: opts.session,
      settings: opts.settings,
      args: opts.args,
      signal: opts.signal
    }),
  leave_voice_channel: async (manager, opts) => {
    throwIfAborted(opts.signal, "Voice tool cancelled");
    scheduleLeaveVoiceChannel(manager, {
      session: opts.session,
      settings: opts.settings
    });
    return { ok: true, status: "leaving" };
  }
};

async function executeStartScreenWatchTool(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    args
  }: {
    session?: ToolRuntimeSession | null;
    settings?: VoiceRealtimeToolSettings | null;
    args?: VoiceToolCallArgs | null;
  }
) {
  const requesterUserId = normalizeInlineText(session?.lastRealtimeToolCallerUserId, 80) || null;
  if (!requesterUserId || !session?.guildId) {
    return { ok: false, started: false, error: "screen_watch_context_unavailable" };
  }
  const target = normalizeInlineText(args?.target, 120) || null;

  let transcript = "";
  const recentVoiceTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
  for (let i = recentVoiceTurns.length - 1; i >= 0; i -= 1) {
    const turn = recentVoiceTurns[i];
    if (String(turn?.role || "") !== "user") continue;
    if (String(turn?.userId || "") !== requesterUserId) continue;
    transcript = normalizeInlineText(turn?.text, 220) || "";
    break;
  }

  const result = await manager.startVoiceScreenWatch({
    settings,
    guildId: session.guildId,
    channelId: session.textChannelId || null,
    requesterUserId,
    target,
    transcript,
    source: "voice_realtime_tool_call"
  });
  return {
    ok: Boolean(result?.started || result?.reused),
    started: Boolean(result?.started || result?.reused),
    reused: Boolean(result?.reused),
    transport:
      result?.transport === "native" || result?.transport === "link"
        ? result.transport
        : null,
    reason: normalizeInlineText(result?.reason, 120) || null,
    targetUserId: normalizeInlineText(result?.targetUserId, 80) || null,
    frameReady: Boolean(result?.frameReady),
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

export async function executeLocalVoiceToolCall(
  manager: VoiceToolCallManager,
  opts: LocalVoiceToolCallOptions
): Promise<Record<string, unknown>> {
  const normalizedToolName = normalizeInlineText(opts.toolName, 120);
  if (!normalizedToolName) {
    throw new Error("missing_tool_name");
  }
  const handler = LOCAL_VOICE_TOOL_HANDLERS[normalizedToolName];
  if (!handler) {
    throw new Error(`unsupported_tool:${normalizedToolName}`);
  }
  return await handler(manager, opts);
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
