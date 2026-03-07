import { stream } from "hono/streaming";
import type { DashboardBot, DashboardMemory, DashboardScreenShareSessionManager } from "../dashboard.ts";
import type { DashboardApp, DashboardSseClient } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { getDirectiveSettings } from "../settings/agentStack.ts";
import { parseBoundedInt, readDashboardBody, STREAM_INGEST_API_PATH } from "./shared.ts";

export interface VoiceRouteDeps {
  store: Store;
  bot: DashboardBot;
  memory: DashboardMemory;
  screenShareSessionManager: DashboardScreenShareSessionManager | null;
  voiceSseClients: Set<DashboardSseClient>;
}

export function attachVoiceRoutes(app: DashboardApp, deps: VoiceRouteDeps) {
  const { store, bot, memory, screenShareSessionManager, voiceSseClients } = deps;

  app.post("/api/voice/share-session", async (c) => {
    if (!screenShareSessionManager) {
      return c.json(
        {
          ok: false,
          reason: "screen_share_manager_unavailable"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const result = await screenShareSessionManager.createSession({
      guildId: String(body.guildId || "").trim(),
      channelId: String(body.channelId || "").trim(),
      requesterUserId: String(body.requesterUserId || "").trim(),
      requesterDisplayName: String(body.requesterDisplayName || "").trim(),
      targetUserId: String(body.targetUserId || "").trim() || null,
      source: String(body.source || "dashboard_api").trim() || "dashboard_api"
    });

    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/api/voice/share-session/:token/frame", async (c) => {
    if (!screenShareSessionManager) {
      return c.json(
        {
          accepted: false,
          reason: "screen_share_manager_unavailable"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const token = String(c.req.param("token") || "").trim();
    const dataBase64 = String(body.dataBase64 || "").trim();
    const mimeType = String(body.mimeType || "image/jpeg").trim() || "image/jpeg";
    const source = String(body.source || "share_session_page").trim() || "share_session_page";

    if (!token || !dataBase64) {
      return c.json(
        {
          accepted: false,
          reason: !token ? "share_session_token_required" : "frame_data_required"
        },
        400
      );
    }

    const result = await screenShareSessionManager.ingestFrameByToken({
      token,
      mimeType,
      dataBase64,
      source
    });
    return c.json(result || { accepted: false, reason: "unknown" }, result.accepted ? 200 : 400);
  });

  app.post("/api/voice/share-session/:token/stop", async (c) => {
    if (!screenShareSessionManager) {
      return c.json(
        {
          ok: false,
          reason: "screen_share_manager_unavailable"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const token = String(c.req.param("token") || "").trim();
    const reason = String(body.reason || "stopped_by_user").trim() || "stopped_by_user";
    if (!token) {
      return c.json(
        {
          ok: false,
          reason: "share_session_token_required"
        },
        400
      );
    }

    const stopped = await screenShareSessionManager.stopSessionByToken({ token, reason });
    return c.json({
      ok: Boolean(stopped),
      reason: stopped ? "ok" : "share_session_not_found"
    });
  });

  app.post("/api/voice/join", async (c) => {
    if (!bot || typeof bot.requestVoiceJoinFromDashboard !== "function") {
      return c.json(
        {
          ok: false,
          reason: "voice_join_unavailable"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const result = await bot.requestVoiceJoinFromDashboard({
      guildId: String(body.guildId || "").trim() || null,
      requesterUserId: String(body.requesterUserId || "").trim() || null,
      textChannelId: String(body.textChannelId || "").trim() || null,
      source: String(body.source || "dashboard_voice_tab").trim() || "dashboard_voice_tab"
    });

    return c.json(
      result && typeof result === "object"
        ? result
        : {
            ok: false,
            reason: "voice_join_unknown"
          }
    );
  });

  app.post(`/api${STREAM_INGEST_API_PATH}`, async (c) => {
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const dataBase64 = String(body.dataBase64 || "").trim();
    const streamerUserId = String(body.streamerUserId || "").trim() || null;
    const mimeType = String(body.mimeType || "image/jpeg").trim() || "image/jpeg";
    const source = String(body.source || "api_stream_ingest").trim() || "api_stream_ingest";

    if (!guildId) {
      return c.json(
        {
          accepted: false,
          reason: "guild_id_required"
        },
        400
      );
    }
    if (!dataBase64) {
      return c.json(
        {
          accepted: false,
          reason: "frame_data_required"
        },
        400
      );
    }

    const result = await bot.ingestVoiceStreamFrame({
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source
    });
    return c.json(result || { accepted: false, reason: "unknown" });
  });

  app.get("/api/voice/events", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return stream(c, async (streaming) => {
      const client: DashboardSseClient = {
        write: async (chunk) => {
          await streaming.write(chunk);
        },
        close: async () => {
          await streaming.close();
        },
        onAbort(listener) {
          streaming.onAbort(listener);
        }
      };
      voiceSseClients.add(client);

      let stateInterval: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (stateInterval) clearInterval(stateInterval);
        if (heartbeat) clearInterval(heartbeat);
        voiceSseClients.delete(client);
      };

      client.onAbort(cleanup);

      const sendState = async () => {
        const voiceState = bot.getRuntimeState()?.voice || { activeCount: 0, sessions: [] };
        await client.write(`event: voice_state\ndata: ${JSON.stringify(voiceState)}\n\n`);
      };

      try {
        await sendState();
      } catch {
        cleanup();
        await streaming.close();
        return;
      }

      stateInterval = setInterval(() => {
        void sendState().catch(() => {
          cleanup();
        });
      }, 3_000);
      heartbeat = setInterval(() => {
        void client.write(": heartbeat\n\n").catch(() => {
          cleanup();
        });
      }, 15_000);

      await new Promise<void>((resolve) => {
        client.onAbort(() => {
          cleanup();
          resolve();
        });
      });
    });
  });

  app.get("/api/voice/state", (c) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { activeCount: 0, sessions: [] };
      return c.json(voiceState);
    } catch (error) {
      return c.json(
        {
          error: String(error instanceof Error ? error.message : error)
        },
        500
      );
    }
  });

  app.get("/api/voice/asr-sessions", (c) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const asrSessions = sessions.flatMap((session) => {
        const sessionRecord = toRecord(session);
        const sessionId = String(sessionRecord.sessionId || "").trim();
        const rows = Array.isArray(sessionRecord.asrSessions) ? sessionRecord.asrSessions : [];
        return rows.map((row) => {
          const rowRecord = toRecord(row);
          return {
            sessionId,
            userId: String(rowRecord.userId || ""),
            displayName: rowRecord.displayName ? String(rowRecord.displayName) : null,
            connected: Boolean(rowRecord.connected),
            createdAt: rowRecord.connectedAt ? String(rowRecord.connectedAt) : null,
            lastTranscriptAt: rowRecord.lastTranscriptAt ? String(rowRecord.lastTranscriptAt) : null,
            idleTimerEndsAt:
              Number.isFinite(Number(rowRecord.idleMs)) && Number.isFinite(Number(rowRecord.idleTtlMs))
                ? new Date(Date.now() + Math.max(0, Number(rowRecord.idleTtlMs) - Number(rowRecord.idleMs))).toISOString()
                : null,
            closedReason: rowRecord.connected ? null : rowRecord.closing ? "error" : "idle_ttl"
          };
        });
      });
      return c.json({
        sessions: asrSessions
      });
    } catch (error) {
      return c.json(
        {
          error: String(error instanceof Error ? error.message : error)
        },
        500
      );
    }
  });

  app.get("/api/voice/tool-events", (c) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const events = sessions.flatMap((session) => {
        const sessionRecord = toRecord(session);
        const sessionId = String(sessionRecord.sessionId || "").trim();
        const rows = Array.isArray(sessionRecord.toolCalls) ? sessionRecord.toolCalls : [];
        return rows.map((row) => {
          const rowRecord = toRecord(row);
          return {
            sessionId,
            callId: String(rowRecord.callId || ""),
            toolName: String(rowRecord.toolName || ""),
            toolType: String(rowRecord.toolType || "function"),
            arguments:
              rowRecord.arguments && typeof rowRecord.arguments === "object" && !Array.isArray(rowRecord.arguments)
                ? toRecord(rowRecord.arguments)
                : {},
            startedAt: rowRecord.startedAt ? String(rowRecord.startedAt) : null,
            completedAt: rowRecord.completedAt ? String(rowRecord.completedAt) : null,
            runtimeMs: Number.isFinite(Number(rowRecord.runtimeMs)) ? Math.round(Number(rowRecord.runtimeMs)) : null,
            success: Boolean(rowRecord.success),
            outputSummary: rowRecord.outputSummary ? String(rowRecord.outputSummary) : null,
            error: rowRecord.error ? String(rowRecord.error) : null
          };
        });
      });
      return c.json({
        events
      });
    } catch (error) {
      return c.json(
        {
          error: String(error instanceof Error ? error.message : error)
        },
        500
      );
    }
  });

  app.get("/api/mcp/status", (c) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const byName = new Map<string, MpcStatusRow>();

      for (const session of sessions) {
        const sessionRecord = toRecord(session);
        const rows = Array.isArray(sessionRecord.mcpStatus) ? sessionRecord.mcpStatus : [];
        for (const row of rows) {
          const rowRecord = toRecord(row);
          const serverName = String(rowRecord.serverName || "").trim();
          if (!serverName) continue;

          const existing = byName.get(serverName) || null;
          const candidate: MpcStatusRow = {
            serverName,
            connected: Boolean(rowRecord.connected),
            tools: Array.isArray(rowRecord.tools)
              ? rowRecord.tools.map((tool) => {
                  const toolRecord = toRecord(tool);
                  return {
                    name: String(toolRecord.name || ""),
                    description: String(toolRecord.description || "")
                  };
                })
              : [],
            lastError: rowRecord.lastError ? String(rowRecord.lastError) : null
          };

          if (!existing) {
            byName.set(serverName, candidate);
            continue;
          }

          byName.set(serverName, {
            ...existing,
            connected: Boolean(existing.connected || candidate.connected),
            tools: existing.tools.length > 0 ? existing.tools : candidate.tools,
            lastError: existing.lastError || candidate.lastError
          });
        }
      }

      return c.json({
        servers: [...byName.values()]
      });
    } catch (error) {
      return c.json(
        {
          error: String(error instanceof Error ? error.message : error)
        },
        500
      );
    }
  });

  app.get("/api/voice/history/sessions", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 100, 1, 200);
    const sinceHoursRaw = Number(c.req.query("sinceHours"));
    const sinceIso =
      Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
        ? new Date(Date.now() - sinceHoursRaw * 60 * 60 * 1000).toISOString()
        : null;
    return c.json(store.getRecentVoiceSessions(limit, { sinceIso }));
  });

  app.get("/api/voice/history/sessions/:sessionId/events", (c) => {
    const sessionId = String(c.req.param("sessionId") || "");
    return c.json(store.getVoiceSessionEvents(sessionId));
  });

  app.get("/api/memory", async (c) => {
    return c.json({ markdown: await memory.readMemoryMarkdown() });
  });

  app.post("/api/memory/refresh", async (c) => {
    await memory.refreshMemoryMarkdown();
    const markdown = await memory.readMemoryMarkdown();
    return c.json({ ok: true, markdown });
  });

  app.get("/api/memory/search", async (c) => {
    const queryText = String(c.req.query("q") || "").trim();
    const guildId = String(c.req.query("guildId") || "").trim();
    const channelId = String(c.req.query("channelId") || "").trim() || null;
    const limit = Number(c.req.query("limit") || 10);

    if (!queryText || !guildId) {
      return c.json({ results: [], queryText, guildId, channelId, limit: 0 });
    }

    const settings = store.getSettings();
    const results = await memory.searchDurableFacts({
      guildId,
      channelId,
      queryText,
      settings,
      trace: {
        guildId,
        channelId,
        source: "dashboard_memory_search"
      },
      limit
    });

    return c.json({
      queryText,
      guildId,
      channelId,
      limit,
      results
    });
  });

  app.get("/api/memory/adaptive-directives", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, 200);
    if (!guildId) {
      return c.json({
        guildId,
        notes: [],
        limit
      });
    }

    return c.json({
      guildId,
      limit,
      notes:
        typeof store.getActiveAdaptiveStyleNotes === "function"
          ? store.getActiveAdaptiveStyleNotes(guildId, limit)
          : []
    });
  });

  app.get("/api/memory/adaptive-directives/audit", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const limit = parseBoundedInt(c.req.query("limit"), 100, 1, 500);
    if (!guildId) {
      return c.json({
        guildId,
        events: [],
        limit
      });
    }

    return c.json({
      guildId,
      limit,
      events:
        typeof store.getAdaptiveStyleNoteAuditLog === "function"
          ? store.getAdaptiveStyleNoteAuditLog(guildId, limit)
          : []
    });
  });

  app.post("/api/memory/adaptive-directives", async (c) => {
    const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
    if (!adaptiveDirectivesEnabled) {
      return c.json(
        {
          ok: false,
          reason: "adaptive_directives_disabled"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const noteText = String(body.noteText || "").trim();
    const directiveKind = String(body.directiveKind || "guidance").trim() || "guidance";
    const actorName = String(body.actorName || "dashboard").trim() || "dashboard";
    if (!guildId || !noteText) {
      return c.json(
        {
          ok: false,
          reason: !guildId ? "guild_id_required" : "note_text_required"
        },
        400
      );
    }

    const result = store.addAdaptiveStyleNote({
      guildId,
      directiveKind,
      noteText,
      actorName,
      source: "dashboard"
    });
    if (!result?.ok) {
      return c.json(
        {
          ok: false,
          reason: String(result?.error || "adaptive_directive_add_failed")
        },
        400
      );
    }
    return c.json(result);
  });

  app.patch("/api/memory/adaptive-directives/:noteId", async (c) => {
    const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
    if (!adaptiveDirectivesEnabled) {
      return c.json(
        {
          ok: false,
          reason: "adaptive_directives_disabled"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const noteId = Number(c.req.param("noteId"));
    const noteText = String(body.noteText || "").trim();
    const directiveKind = String(body.directiveKind || "guidance").trim() || "guidance";
    const actorName = String(body.actorName || "dashboard").trim() || "dashboard";
    if (!guildId || !Number.isInteger(noteId) || noteId <= 0 || !noteText) {
      return c.json(
        {
          ok: false,
          reason: !guildId
            ? "guild_id_required"
            : !Number.isInteger(noteId) || noteId <= 0
              ? "note_id_required"
              : "note_text_required"
        },
        400
      );
    }

    const result = store.updateAdaptiveStyleNote({
      noteId,
      guildId,
      directiveKind,
      noteText,
      actorName,
      source: "dashboard"
    });
    if (!result?.ok) {
      return c.json(
        {
          ok: false,
          reason: String(result?.error || "adaptive_directive_update_failed")
        },
        result?.error === "note_not_found" ? 404 : 400
      );
    }
    return c.json(result);
  });

  app.post("/api/memory/adaptive-directives/:noteId/remove", async (c) => {
    const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
    if (!adaptiveDirectivesEnabled) {
      return c.json(
        {
          ok: false,
          reason: "adaptive_directives_disabled"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const noteId = Number(c.req.param("noteId"));
    const actorName = String(body.actorName || "dashboard").trim() || "dashboard";
    const removalReason = String(body.removalReason || "").trim();
    if (!guildId || !Number.isInteger(noteId) || noteId <= 0) {
      return c.json(
        {
          ok: false,
          reason: !guildId ? "guild_id_required" : "note_id_required"
        },
        400
      );
    }

    const result = store.removeAdaptiveStyleNote({
      noteId,
      guildId,
      actorName,
      removalReason,
      source: "dashboard"
    });
    if (!result?.ok) {
      return c.json(
        {
          ok: false,
          reason: String(result?.error || "adaptive_directive_remove_failed")
        },
        result?.error === "note_not_found" ? 404 : 400
      );
    }
    return c.json(result);
  });

  app.get("/api/memory/reflections", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
    return c.json({
      runs: store.getRecentMemoryReflections(limit)
    });
  });

  app.post("/api/memory/reflections/rerun", async (c) => {
    if (!memory || typeof memory.rerunDailyReflection !== "function") {
      return c.json(
        {
          ok: false,
          reason: "memory_reflection_rerun_unavailable"
        },
        503
      );
    }

    const body = await readDashboardBody(c);
    const dateKey = String(body.dateKey || "").trim();
    const guildId = String(body.guildId || "").trim();
    if (!dateKey || !guildId) {
      return c.json(
        {
          ok: false,
          reason: !dateKey ? "date_key_required" : "guild_id_required"
        },
        400
      );
    }

    await memory.rerunDailyReflection({
      dateKey,
      guildId,
      settings: store.getSettings()
    });

    return c.json({
      ok: true,
      dateKey,
      guildId
    });
  });

  app.post("/api/memory/simulate-slice", async (c) => {
    const body = await readDashboardBody(c);
    const userId = String(body.userId || "").trim() || null;
    const guildId = String(body.guildId || "").trim();
    const channelId = String(body.channelId || "").trim() || null;
    const queryText = String(body.queryText || "").trim();

    if (!guildId || !queryText) {
      return c.json({ error: "guildId and queryText are required" }, 400);
    }

    const settings = store.getSettings();
    const result = await memory.buildPromptMemorySlice({
      userId,
      guildId,
      channelId,
      queryText,
      settings,
      trace: { guildId, channelId, source: "dashboard_simulate_slice" }
    });

    return c.json({
      userFacts: result.userFacts || [],
      relevantFacts: result.relevantFacts || [],
      relevantMessages: result.relevantMessages || []
    });
  });

  app.get("/api/memory/subjects", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const limit = parseBoundedInt(c.req.query("limit"), 200, 1, 500);
    if (!guildId) {
      return c.json({ guildId, subjects: [], limit });
    }
    const subjects = store.getMemorySubjects(limit, { guildId });
    return c.json({ guildId, limit, subjects });
  });

  app.get("/api/memory/facts", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const limit = parseBoundedInt(c.req.query("limit"), 120, 1, 500);
    const subjectFilter = String(c.req.query("subject") || "").trim() || null;
    if (!guildId) {
      return c.json({ guildId, facts: [], limit });
    }
    const facts = store.getFactsForScope({
      guildId,
      limit,
      subjectIds: subjectFilter ? [subjectFilter] : null
    });
    return c.json({ guildId, limit, subject: subjectFilter, facts });
  });
}

interface MpcStatusRow {
  serverName: string;
  connected: boolean;
  tools: Array<{
    name: string;
    description: string;
  }>;
  lastError: string | null;
}

function toRecord(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}
