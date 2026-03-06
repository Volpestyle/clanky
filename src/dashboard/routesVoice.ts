import { parseBoundedInt } from "../dashboard.ts";
import { STREAM_INGEST_API_PATH } from "../dashboard.ts";
import { getDirectiveSettings } from "../settings/agentStack.ts";

export function attachVoiceRoutes(app: any, deps: any) {
  const { store, bot, memory, screenShareSessionManager, voiceSseClients } = deps;
  
  app.post("/api/voice/share-session", async (req, res, next) => {
    try {
      if (!screenShareSessionManager) {
        return res.status(503).json({
          ok: false,
          reason: "screen_share_manager_unavailable"
        });
      }

      const result = await screenShareSessionManager.createSession({
        guildId: String(req.body?.guildId || "").trim(),
        channelId: String(req.body?.channelId || "").trim(),
        requesterUserId: String(req.body?.requesterUserId || "").trim(),
        requesterDisplayName: String(req.body?.requesterDisplayName || "").trim(),
        targetUserId: String(req.body?.targetUserId || "").trim() || null,
        source: String(req.body?.source || "dashboard_api").trim() || "dashboard_api"
      });
      return res.status(result?.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/voice/share-session/:token/frame", async (req, res, next) => {
    try {
      if (!screenShareSessionManager) {
        return res.status(503).json({
          accepted: false,
          reason: "screen_share_manager_unavailable"
        });
      }
      const token = String(req.params?.token || "").trim();
      const dataBase64 = String(req.body?.dataBase64 || "").trim();
      const mimeType = String(req.body?.mimeType || "image/jpeg").trim() || "image/jpeg";
      const source = String(req.body?.source || "share_session_page").trim() || "share_session_page";
      if (!token || !dataBase64) {
        return res.status(400).json({
          accepted: false,
          reason: !token ? "share_session_token_required" : "frame_data_required"
        });
      }

      const result = await screenShareSessionManager.ingestFrameByToken({
        token,
        mimeType,
        dataBase64,
        source
      });
      const status = result?.accepted ? 200 : 400;
      return res.status(status).json(result || { accepted: false, reason: "unknown" });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/voice/share-session/:token/stop", async (req, res) => {
    if (!screenShareSessionManager) {
      return res.status(503).json({
        ok: false,
        reason: "screen_share_manager_unavailable"
      });
    }
    const token = String(req.params?.token || "").trim();
    const reason = String(req.body?.reason || "stopped_by_user").trim() || "stopped_by_user";
    if (!token) {
      return res.status(400).json({
        ok: false,
        reason: "share_session_token_required"
      });
    }
    const stopped = await screenShareSessionManager.stopSessionByToken({ token, reason });
    return res.json({
      ok: Boolean(stopped),
      reason: stopped ? "ok" : "share_session_not_found"
    });
  });

  app.post("/api/voice/join", async (req, res, next) => {
    try {
      if (!bot || typeof bot.requestVoiceJoinFromDashboard !== "function") {
        return res.status(503).json({
          ok: false,
          reason: "voice_join_unavailable"
        });
      }

      const result = await bot.requestVoiceJoinFromDashboard({
        guildId: String(req.body?.guildId || "").trim() || null,
        requesterUserId: String(req.body?.requesterUserId || "").trim() || null,
        textChannelId: String(req.body?.textChannelId || "").trim() || null,
        source: String(req.body?.source || "dashboard_voice_tab").trim() || "dashboard_voice_tab"
      });

      return res.json(
        result && typeof result === "object"
          ? result
          : {
              ok: false,
              reason: "voice_join_unknown"
            }
      );
    } catch (error) {
      return next(error);
    }
  });

  app.post(`/api${STREAM_INGEST_API_PATH}`, async (req, res, next) => {
    try {
      const guildId = String(req.body?.guildId || "").trim();
      const dataBase64 = String(req.body?.dataBase64 || "").trim();
      const streamerUserId = String(req.body?.streamerUserId || "").trim() || null;
      const mimeType = String(req.body?.mimeType || "image/jpeg").trim() || "image/jpeg";
      const source = String(req.body?.source || "api_stream_ingest").trim() || "api_stream_ingest";

      if (!guildId) {
        return res.status(400).json({
          accepted: false,
          reason: "guild_id_required"
        });
      }
      if (!dataBase64) {
        return res.status(400).json({
          accepted: false,
          reason: "frame_data_required"
        });
      }

      const result = await bot.ingestVoiceStreamFrame({
        guildId,
        streamerUserId,
        mimeType,
        dataBase64,
        source
      });
      return res.json(result || { accepted: false, reason: "unknown" });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/voice/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const sendState = () => {
      try {
        const voiceState = bot.getRuntimeState()?.voice || { activeCount: 0, sessions: [] };
        res.write(`event: voice_state\ndata: ${JSON.stringify(voiceState)}\n\n`);
      } catch { /* swallow */ }
    };

    sendState();
    const stateInterval = setInterval(sendState, 3_000);
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { /* swallow */ }
    }, 15_000);

    const client = { res, blocked: false };
    voiceSseClients.add(client);

    req.on("close", () => {
      clearInterval(stateInterval);
      clearInterval(heartbeat);
      voiceSseClients.delete(client);
    });
  });

  app.get("/api/voice/state", (_req, res) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { activeCount: 0, sessions: [] };
      return res.json(voiceState);
    } catch (error) {
      return res.status(500).json({
        error: String(error?.message || error)
      });
    }
  });

  app.get("/api/voice/asr-sessions", (_req, res) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const asrSessions = sessions.flatMap((session) => {
        const sessionId = String(session?.sessionId || "").trim();
        const rows = Array.isArray(session?.asrSessions) ? session.asrSessions : [];
        return rows.map((row) => ({
          sessionId,
          userId: String(row?.userId || ""),
          displayName: row?.displayName ? String(row.displayName) : null,
          connected: Boolean(row?.connected),
          createdAt: row?.connectedAt ? String(row.connectedAt) : null,
          lastTranscriptAt: row?.lastTranscriptAt ? String(row.lastTranscriptAt) : null,
          idleTimerEndsAt:
            Number.isFinite(Number(row?.idleMs)) && Number.isFinite(Number(row?.idleTtlMs))
              ? new Date(Date.now() + Math.max(0, Number(row.idleTtlMs) - Number(row.idleMs))).toISOString()
              : null,
          closedReason: row?.connected ? null : row?.closing ? "error" : "idle_ttl"
        }));
      });
      return res.json({
        sessions: asrSessions
      });
    } catch (error) {
      return res.status(500).json({
        error: String(error?.message || error)
      });
    }
  });

  app.get("/api/voice/tool-events", (_req, res) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const events = sessions.flatMap((session) => {
        const sessionId = String(session?.sessionId || "").trim();
        const rows = Array.isArray(session?.toolCalls) ? session.toolCalls : [];
        return rows.map((row) => ({
          sessionId,
          callId: String(row?.callId || ""),
          toolName: String(row?.toolName || ""),
          toolType: String(row?.toolType || "function"),
          arguments: row?.arguments && typeof row.arguments === "object" ? row.arguments : {},
          startedAt: row?.startedAt ? String(row.startedAt) : null,
          completedAt: row?.completedAt ? String(row.completedAt) : null,
          runtimeMs: Number.isFinite(Number(row?.runtimeMs)) ? Math.round(Number(row.runtimeMs)) : null,
          success: Boolean(row?.success),
          outputSummary: row?.outputSummary ? String(row.outputSummary) : null,
          error: row?.error ? String(row.error) : null
        }));
      });
      return res.json({
        events
      });
    } catch (error) {
      return res.status(500).json({
        error: String(error?.message || error)
      });
    }
  });

  app.get("/api/mcp/status", (_req, res) => {
    try {
      const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
      const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
      const byName = new Map();
      for (const session of sessions) {
        const rows = Array.isArray(session?.mcpStatus) ? session.mcpStatus : [];
        for (const row of rows) {
          const serverName = String(row?.serverName || "").trim();
          if (!serverName) continue;
          const existing = byName.get(serverName) || null;
          const candidate = {
            serverName,
            connected: Boolean(row?.connected),
            tools: Array.isArray(row?.tools)
              ? row.tools.map((tool) => ({
                  name: String(tool?.name || ""),
                  description: String(tool?.description || "")
                }))
              : [],
            lastError: row?.lastError ? String(row.lastError) : null
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
      return res.json({
        servers: [...byName.values()]
      });
    } catch (error) {
      return res.status(500).json({
        error: String(error?.message || error)
      });
    }
  });

  app.get("/api/voice/history/sessions", (_req, res, next) => {
    try {
      const limit = parseBoundedInt(_req.query.limit, 100, 1, 200);
      const sinceHoursRaw = Number(_req.query.sinceHours);
      const sinceIso =
        Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
          ? new Date(Date.now() - sinceHoursRaw * 60 * 60 * 1000).toISOString()
          : null;
      res.json(store.getRecentVoiceSessions(limit, { sinceIso }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/voice/history/sessions/:sessionId/events", (_req, res, next) => {
    try {
      const sessionId = String(_req.params.sessionId || "");
      res.json(store.getVoiceSessionEvents(sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory", async (_req, res, next) => {
    try {
      const markdown = await memory.readMemoryMarkdown();
      res.json({ markdown });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/memory/refresh", async (_req, res, next) => {
    try {
      await memory.refreshMemoryMarkdown();
      const markdown = await memory.readMemoryMarkdown();
      res.json({ ok: true, markdown });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory/search", async (req, res, next) => {
    try {
      const queryText = String(req.query.q || "").trim();
      const guildId = String(req.query.guildId || "").trim();
      const channelId = String(req.query.channelId || "").trim() || null;
      const limit = Number(req.query.limit || 10);
      if (!queryText || !guildId) {
        return res.json({ results: [], queryText, guildId, channelId, limit: 0 });
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
      return res.json({
        queryText,
        guildId,
        channelId,
        limit,
        results
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/memory/adaptive-directives", (req, res, next) => {
    try {
      const guildId = String(req.query.guildId || "").trim();
      const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
      if (!guildId) {
        return res.json({
          guildId,
          notes: [],
          limit
        });
      }
      return res.json({
        guildId,
        limit,
        notes:
          typeof store.getActiveAdaptiveStyleNotes === "function"
            ? store.getActiveAdaptiveStyleNotes(guildId, limit)
            : []
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/memory/adaptive-directives/audit", (req, res, next) => {
    try {
      const guildId = String(req.query.guildId || "").trim();
      const limit = parseBoundedInt(req.query.limit, 100, 1, 500);
      if (!guildId) {
        return res.json({
          guildId,
          events: [],
          limit
        });
      }
      return res.json({
        guildId,
        limit,
        events:
          typeof store.getAdaptiveStyleNoteAuditLog === "function"
            ? store.getAdaptiveStyleNoteAuditLog(guildId, limit)
            : []
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/memory/adaptive-directives", (req, res, next) => {
    try {
      const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
      if (!adaptiveDirectivesEnabled) {
        return res.status(503).json({
          ok: false,
          reason: "adaptive_directives_disabled"
        });
      }
      const guildId = String(req.body?.guildId || "").trim();
      const noteText = String(req.body?.noteText || "").trim();
      const directiveKind = String(req.body?.directiveKind || "guidance").trim() || "guidance";
      const actorName = String(req.body?.actorName || "dashboard").trim() || "dashboard";
      if (!guildId || !noteText) {
        return res.status(400).json({
          ok: false,
          reason: !guildId ? "guild_id_required" : "note_text_required"
        });
      }
      const result = store.addAdaptiveStyleNote({
        guildId,
        directiveKind,
        noteText,
        actorName,
        source: "dashboard"
      });
      if (!result?.ok) {
        return res.status(400).json({
          ok: false,
          reason: String(result?.error || "adaptive_directive_add_failed")
        });
      }
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/memory/adaptive-directives/:noteId", (req, res, next) => {
    try {
      const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
      if (!adaptiveDirectivesEnabled) {
        return res.status(503).json({
          ok: false,
          reason: "adaptive_directives_disabled"
        });
      }
      const guildId = String(req.body?.guildId || "").trim();
      const noteId = Number(req.params.noteId);
      const noteText = String(req.body?.noteText || "").trim();
      const directiveKind = String(req.body?.directiveKind || "guidance").trim() || "guidance";
      const actorName = String(req.body?.actorName || "dashboard").trim() || "dashboard";
      if (!guildId || !Number.isInteger(noteId) || noteId <= 0 || !noteText) {
        return res.status(400).json({
          ok: false,
          reason: !guildId
            ? "guild_id_required"
            : !Number.isInteger(noteId) || noteId <= 0
              ? "note_id_required"
              : "note_text_required"
        });
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
        return res.status(result?.error === "note_not_found" ? 404 : 400).json({
          ok: false,
          reason: String(result?.error || "adaptive_directive_update_failed")
        });
      }
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/memory/adaptive-directives/:noteId/remove", (req, res, next) => {
    try {
      const adaptiveDirectivesEnabled = Boolean(getDirectiveSettings(store.getSettings?.()).enabled);
      if (!adaptiveDirectivesEnabled) {
        return res.status(503).json({
          ok: false,
          reason: "adaptive_directives_disabled"
        });
      }
      const guildId = String(req.body?.guildId || "").trim();
      const noteId = Number(req.params.noteId);
      const actorName = String(req.body?.actorName || "dashboard").trim() || "dashboard";
      const removalReason = String(req.body?.removalReason || "").trim();
      if (!guildId || !Number.isInteger(noteId) || noteId <= 0) {
        return res.status(400).json({
          ok: false,
          reason: !guildId ? "guild_id_required" : "note_id_required"
        });
      }
      const result = store.removeAdaptiveStyleNote({
        noteId,
        guildId,
        actorName,
        removalReason,
        source: "dashboard"
      });
      if (!result?.ok) {
        return res.status(result?.error === "note_not_found" ? 404 : 400).json({
          ok: false,
          reason: String(result?.error || "adaptive_directive_remove_failed")
        });
      }
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/memory/reflections", (req, res, next) => {
    try {
      const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
      return res.json({
        runs: store.getRecentMemoryReflections(limit)
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/memory/reflections/rerun", async (req, res, next) => {
    try {
      if (!memory || typeof memory.rerunDailyReflection !== "function") {
        return res.status(503).json({
          ok: false,
          reason: "memory_reflection_rerun_unavailable"
        });
      }

      const dateKey = String(req.body?.dateKey || "").trim();
      const guildId = String(req.body?.guildId || "").trim();
      if (!dateKey || !guildId) {
        return res.status(400).json({
          ok: false,
          reason: !dateKey ? "date_key_required" : "guild_id_required"
        });
      }

      await memory.rerunDailyReflection({
        dateKey,
        guildId,
        settings: store.getSettings()
      });

      return res.json({
        ok: true,
        dateKey,
        guildId
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/memory/simulate-slice", async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || "").trim() || null;
      const guildId = String(req.body?.guildId || "").trim();
      const channelId = String(req.body?.channelId || "").trim() || null;
      const queryText = String(req.body?.queryText || "").trim();

      if (!guildId || !queryText) {
        return res.status(400).json({ error: "guildId and queryText are required" });
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

      return res.json({
        userFacts: result.userFacts || [],
        relevantFacts: result.relevantFacts || [],
        relevantMessages: result.relevantMessages || []
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/memory/subjects", (req, res, next) => {
    try {
      const guildId = String(req.query.guildId || "").trim();
      const limit = parseBoundedInt(req.query.limit, 200, 1, 500);
      if (!guildId) {
        return res.json({ guildId, subjects: [], limit });
      }
      const subjects = store.getMemorySubjects(limit, { guildId });
      return res.json({ guildId, limit, subjects });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/memory/facts", (req, res, next) => {
    try {
      const guildId = String(req.query.guildId || "").trim();
      const limit = parseBoundedInt(req.query.limit, 120, 1, 500);
      const subjectFilter = String(req.query.subject || "").trim() || null;
      if (!guildId) {
        return res.json({ guildId, facts: [], limit });
      }
      const facts = store.getFactsForScope({
        guildId,
        limit,
        subjectIds: subjectFilter ? [subjectFilter] : null
      });
      return res.json({ guildId, limit, subject: subjectFilter, facts });
    } catch (error) {
      return next(error);
    }
  });
}
