import { clamp } from "../utils.ts";
import { normalizeInlineText, OPENAI_FUNCTION_CALL_ITEM_TYPES, type VoiceMcpServerStatus } from "./voiceSessionManager.ts";
import { OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS } from "./voiceSessionManager.constants.ts";

export function injectToolsMethods(target: any) {

      target.prototype.ensureSessionToolRuntimeState = function(session) {
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
      session.mcpStatus = this.getVoiceMcpServerStatuses().map((entry) => ({
        ...entry
      }));
    }
    return session;
      };

      target.prototype.ensureToolMusicQueueState = function(session) {
    if (!session || typeof session !== "object") return null;
    const current =
      session.musicQueueState && typeof session.musicQueueState === "object"
        ? session.musicQueueState
        : {};
    const tracks = Array.isArray(current.tracks) ? current.tracks : [];
    const normalizedTracks = tracks
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const id = normalizeInlineText(entry.id, 180);
        const title = normalizeInlineText(entry.title, 220);
        if (!id || !title) return null;
        return {
          id,
          title,
          artist: normalizeInlineText(entry.artist, 220) || null,
          durationMs: Number.isFinite(Number(entry.durationMs))
            ? Math.max(0, Math.round(Number(entry.durationMs)))
            : null,
          source:
            String(entry.source || "")
              .trim()
              .toLowerCase() === "sc"
              ? "sc"
              : "yt",
          streamUrl: normalizeInlineText(entry.streamUrl, 300) || null,
          platform: this.normalizeMusicPlatformToken(entry.platform, "youtube") || "youtube",
          externalUrl: normalizeInlineText(entry.externalUrl, 300) || null
        };
      })
      .filter(Boolean);
    const normalizedNowPlayingIndexRaw = Number(current.nowPlayingIndex);
    const normalizedNowPlayingIndex =
      Number.isInteger(normalizedNowPlayingIndexRaw) &&
        normalizedNowPlayingIndexRaw >= 0 &&
        normalizedNowPlayingIndexRaw < normalizedTracks.length
        ? normalizedNowPlayingIndexRaw
        : null;
    const next = {
      guildId: String(session.guildId || "").trim(),
      voiceChannelId: String(session.voiceChannelId || "").trim(),
      tracks: normalizedTracks,
      nowPlayingIndex: normalizedNowPlayingIndex,
      isPaused: Boolean(current.isPaused),
      volume: Number.isFinite(Number(current.volume))
        ? clamp(Number(current.volume), 0, 1)
        : 1
    };
    session.musicQueueState = next;
    return next;
      };

      target.prototype.getVoiceMcpServerStatuses = function() {
    const servers = Array.isArray(this.appConfig?.voiceMcpServers) ? this.appConfig.voiceMcpServers : [];
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
      };

      target.prototype.updateVoiceMcpStatus = function(session, serverName, updates = {}) {
    if (!session || !serverName) return;
    this.ensureSessionToolRuntimeState(session);
    const rows = Array.isArray(session.mcpStatus) ? session.mcpStatus : [];
    const index = rows.findIndex((row) => String(row?.serverName || "") === String(serverName));
    if (index < 0) return;
    rows[index] = {
      ...rows[index],
      ...(updates && typeof updates === "object" ? updates : {})
    };
    session.mcpStatus = rows;
      };

      target.prototype.extractOpenAiFunctionCallEnvelope = function(event) {
    if (!event || typeof event !== "object") return null;
    const eventType = String(event.type || "").trim();
    if (!OPENAI_FUNCTION_CALL_ITEM_TYPES.has(eventType)) return null;

    const item =
      event.item && typeof event.item === "object"
        ? event.item
        : event.output_item && typeof event.output_item === "object"
          ? event.output_item
          : null;
    const itemType = String(item?.type || "").trim().toLowerCase();
    if (item && itemType && itemType !== "function_call") return null;

    const callId = normalizeInlineText(event.call_id || item?.call_id, 180);
    const name = normalizeInlineText(event.name || item?.name, 120);
    if (!callId && !name) return null;

    if (eventType === "response.function_call_arguments.delta") {
      const delta = String(event.delta || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      return {
        phase: "delta",
        eventType,
        callId: callId || null,
        name: name || null,
        argumentsFragment: delta
      };
    }

    if (eventType === "response.function_call_arguments.done") {
      const argumentsText = String(event.arguments || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      return {
        phase: "done",
        eventType,
        callId: callId || null,
        name: name || null,
        argumentsFragment: argumentsText
      };
    }

    const itemArguments = String(item?.arguments || event.arguments || "").slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
    return {
      phase: eventType === "response.output_item.done" ? "done" : "added",
      eventType,
      callId: callId || null,
      name: name || null,
      argumentsFragment: itemArguments
    };
      };

      target.prototype.handleOpenAiRealtimeFunctionCallEvent = async function({ session, settings, event }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;
    const envelope = this.extractOpenAiFunctionCallEnvelope(event);
    if (!envelope) return;
    const runtimeSession = this.ensureSessionToolRuntimeState(session);
    if (!runtimeSession) return;

    const pendingCalls = runtimeSession.openAiPendingToolCalls;
    const executions = runtimeSession.openAiToolCallExecutions;
    const normalizedCallId = normalizeInlineText(envelope.callId, 180);
    const normalizedName = normalizeInlineText(envelope.name, 120);
    if (!normalizedCallId) return;

    const existing = pendingCalls.get(normalizedCallId) || null;
    const pendingCall = existing && typeof existing === "object"
      ? existing
      : {
        callId: normalizedCallId,
        name: normalizedName || "",
        argumentsText: "",
        done: false,
        startedAtMs: Date.now(),
        sourceEventType: envelope.eventType
      };
    if (normalizedName && !pendingCall.name) {
      pendingCall.name = normalizedName;
    }

    const fragment = String(envelope.argumentsFragment || "");
    if (fragment) {
      if (envelope.phase === "delta") {
        pendingCall.argumentsText = `${String(pendingCall.argumentsText || "")}${fragment}`.slice(
          0,
          OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS
        );
      } else {
        pendingCall.argumentsText = fragment.slice(0, OPENAI_TOOL_CALL_ARGUMENTS_MAX_CHARS);
      }
    }

    if (envelope.phase === "done") {
      pendingCall.done = true;
    }
    pendingCalls.set(normalizedCallId, pendingCall);
    if (!pendingCall.done) return;
    if (executions.has(normalizedCallId)) return;

    executions.set(normalizedCallId, {
      startedAtMs: Date.now(),
      toolName: pendingCall.name
    });
    session.awaitingToolOutputs = true;

    await this.executeOpenAiRealtimeFunctionCall({
      session,
      settings,
      pendingCall
    });
      };

      target.prototype.parseOpenAiRealtimeToolArguments = function(argumentsText = "") {
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
      };

      target.prototype.resolveOpenAiRealtimeToolDescriptor = function(session, toolName = "") {
    const normalizedToolName = normalizeInlineText(toolName, 120);
    if (!normalizedToolName) return null;
    const configuredTools = Array.isArray(session?.openAiToolDefinitions)
      ? session.openAiToolDefinitions
      : this.buildOpenAiRealtimeFunctionTools({
        session,
        settings: session?.settingsSnapshot || this.store.getSettings()
      });
    return configuredTools.find((tool) => String(tool?.name || "") === normalizedToolName) || null;
      };

      target.prototype.summarizeVoiceToolOutput = function(output: unknown = null) {
    if (output == null) return null;
    if (typeof output === "string") {
      return normalizeInlineText(output, 280) || null;
    }
    try {
      return normalizeInlineText(JSON.stringify(output), 280) || null;
    } catch {
      return normalizeInlineText(String(output), 280) || null;
    }
      };

      target.prototype.executeVoiceWebSearchTool = async function({ session, settings, args }) {
    const query = normalizeInlineText(args?.query, 240);
    if (!query) {
      return {
        ok: false,
        results: [],
        answer: "",
        error: "query_required"
      };
    }
    if (!this.search || typeof this.search.searchAndRead !== "function") {
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

    const searchResult = await this.search.searchAndRead({
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
      };
}
