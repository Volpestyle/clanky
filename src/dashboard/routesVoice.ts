import { stream } from "hono/streaming";
import type { DashboardBot, DashboardMemory, DashboardScreenShareSessionManager } from "../dashboard.ts";
import type { DashboardApp, DashboardSseClient } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { parseBoundedInt, readDashboardBody, STREAM_INGEST_API_PATH, toRecord } from "./shared.ts";

export interface VoiceRouteDeps {
  store: Store;
  bot: DashboardBot;
  memory: DashboardMemory;
  screenShareSessionManager: DashboardScreenShareSessionManager | null;
  voiceSseClients: Set<DashboardSseClient>;
}

function mapDashboardFactRow(row: unknown) {
  const record = toRecord(row);
  const fact = String(record.fact || "").trim();
  if (!fact) return null;
  const confidence = Number(record.confidence);
  return {
    id: Number.isInteger(Number(record.id)) ? Number(record.id) : null,
    subject: String(record.subject || "").trim() || null,
    factType: String(record.factType || record.fact_type || "").trim() || null,
    fact,
    confidence: Number.isFinite(confidence) ? Number(confidence) : null,
    metadata: {
      createdAt: record.createdAt ? String(record.createdAt) : record.created_at ? String(record.created_at) : null,
      updatedAt: record.updatedAt ? String(record.updatedAt) : record.updated_at ? String(record.updated_at) : null,
      guildId: record.guildId ? String(record.guildId) : record.guild_id ? String(record.guild_id) : null,
      channelId: record.channelId ? String(record.channelId) : record.channel_id ? String(record.channel_id) : null,
      evidenceText:
        record.evidenceText ? String(record.evidenceText) : record.evidence_text ? String(record.evidence_text) : null,
      sourceMessageId:
        record.sourceMessageId
          ? String(record.sourceMessageId)
          : record.source_message_id
            ? String(record.source_message_id)
            : null
    }
  };
}

function normalizeDashboardFactRows(rows: unknown) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => mapDashboardFactRow(row))
    .filter((row) => row !== null);
}

function mapConversationMessageRow(row: unknown) {
  const record = toRecord(row);
  const content = String(record.content || "").trim();
  if (!content) return null;
  return {
    messageId: String(record.message_id || record.messageId || "").trim() || null,
    timestamp: record.created_at ? String(record.created_at) : record.createdAt ? String(record.createdAt) : null,
    author: record.author_name ? String(record.author_name) : record.authorName ? String(record.authorName) : null,
    content
  };
}

function mapConversationWindowRow(row: unknown) {
  const record = toRecord(row);
  const messages = (Array.isArray(record.messages) ? record.messages : [])
    .map((entry) => mapConversationMessageRow(entry))
    .filter((entry) => entry !== null);
  if (!messages.length) return null;
  const score = Number(record.score);
  const semanticScore = Number(record.semanticScore);
  const ageMinutes = Number(record.ageMinutes);
  return {
    anchorMessageId: String(record.anchorMessageId || record.anchor_message_id || "").trim() || null,
    createdAt: record.createdAt ? String(record.createdAt) : record.created_at ? String(record.created_at) : null,
    score: Number.isFinite(score) ? score : null,
    semanticScore: Number.isFinite(semanticScore) ? semanticScore : null,
    ageMinutes: Number.isFinite(ageMinutes) ? ageMinutes : null,
    messages
  };
}

function getActiveVoiceSessionFactProfileSnapshot(
  bot: DashboardBot,
  {
    guildId,
    userId = null
  }: {
    guildId: string;
    userId?: string | null;
  }
) {
  const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
  const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
  const session = sessions.find((entry) => String(toRecord(entry).guildId || "").trim() === guildId) || null;
  if (!session) return null;

  const normalizedUserId = String(userId || "").trim();
  const sessionRecord = toRecord(session);
  const memoryRecord = toRecord(sessionRecord.memory);
  const factProfiles = (Array.isArray(memoryRecord.factProfiles) ? memoryRecord.factProfiles : [])
    .map((entry) => {
      const profileRecord = toRecord(entry);
      const cachedUserId = String(profileRecord.userId || "").trim();
      if (!cachedUserId) return null;
      const userFacts = normalizeDashboardFactRows(profileRecord.userFacts);
      const guidanceFacts = normalizeDashboardFactRows(profileRecord.guidanceFacts);
      return {
        userId: cachedUserId,
        displayName: profileRecord.displayName ? String(profileRecord.displayName) : null,
        loadedAt: profileRecord.loadedAt ? String(profileRecord.loadedAt) : null,
        factCount: userFacts.length + guidanceFacts.length,
        userFacts,
        guidanceFacts
      };
    })
    .filter((entry) => entry !== null);
  const selectedFactProfile =
    normalizedUserId
      ? factProfiles.find((entry) => String(entry?.userId || "") === normalizedUserId) || null
      : null;
  const guildFactProfileRecord = toRecord(memoryRecord.guildFactProfile);

  return {
    sessionId: String(sessionRecord.sessionId || "").trim() || null,
    voiceChannelId: sessionRecord.voiceChannelId ? String(sessionRecord.voiceChannelId) : null,
    textChannelId: sessionRecord.textChannelId ? String(sessionRecord.textChannelId) : null,
    participantCount: Number.isFinite(Number(sessionRecord.participantCount))
      ? Math.max(0, Math.round(Number(sessionRecord.participantCount)))
      : 0,
    participants: (Array.isArray(sessionRecord.participants) ? sessionRecord.participants : []).map((participant) => {
      const participantRecord = toRecord(participant);
      return {
        userId: String(participantRecord.userId || "").trim() || null,
        displayName: participantRecord.displayName ? String(participantRecord.displayName) : null
      };
    }),
    cachedUsers: factProfiles.map((entry) => ({
      userId: entry?.userId || null,
      displayName: entry?.displayName || null,
      loadedAt: entry?.loadedAt || null,
      factCount: Number(entry?.factCount || 0)
    })),
    userFactProfile: selectedFactProfile,
    guildFactProfile: memoryRecord.guildFactProfile
      ? {
          loadedAt: guildFactProfileRecord.loadedAt ? String(guildFactProfileRecord.loadedAt) : null,
          selfFacts: normalizeDashboardFactRows(guildFactProfileRecord.selfFacts),
          loreFacts: normalizeDashboardFactRows(guildFactProfileRecord.loreFacts),
          guidanceFacts: normalizeDashboardFactRows(guildFactProfileRecord.guidanceFacts)
        }
      : null
  };
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

  app.get("/api/memory/fact-profile", async (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const userId = String(c.req.query("userId") || "").trim() || null;
    const channelId = String(c.req.query("channelId") || "").trim() || null;
    const queryText = String(c.req.query("queryText") || "").trim();

    if (!guildId) {
      return c.json({
        guildId,
        userId,
        channelId,
        queryText,
        durableProfile: {
          userFacts: [],
          selfFacts: [],
          loreFacts: [],
          guidanceFacts: []
        },
        promptContext: {
          recentConversationHistory: []
        },
        activeVoiceSession: null
      });
    }

    const userProfile =
      typeof memory.loadUserFactProfile === "function"
        ? memory.loadUserFactProfile({
            userId,
            guildId
          })
        : { userFacts: [], guidanceFacts: [] };
    const guildProfile =
      typeof memory.loadGuildFactProfile === "function"
        ? memory.loadGuildFactProfile({
            guildId
          })
        : { selfFacts: [], loreFacts: [], guidanceFacts: [] };
    const userProfileRecord = toRecord(userProfile);
    const guildProfileRecord = toRecord(guildProfile);
    let recentConversationHistory: Array<NonNullable<ReturnType<typeof mapConversationWindowRow>>> = [];
    if (channelId && queryText) {
      const historyRows =
        typeof memory.searchConversationHistory === "function"
          ? await memory.searchConversationHistory({
              guildId,
              channelId,
              queryText,
              settings: store.getSettings(),
              trace: {
                guildId,
                channelId,
                source: "dashboard_fact_profile_conversation_history"
              },
              limit: 3,
              maxAgeHours: 24 * 14,
              before: 1,
              after: 1
            })
          : store.searchConversationWindows?.({
              guildId,
              channelId,
              queryText,
              limit: 3,
              maxAgeHours: 24 * 14,
              before: 1,
              after: 1
            }) || [];
      recentConversationHistory = historyRows
        .map((row) => mapConversationWindowRow(row))
        .filter((row): row is NonNullable<ReturnType<typeof mapConversationWindowRow>> => row !== null);
    }

    return c.json({
      guildId,
      userId,
      channelId,
      queryText,
      durableProfile: {
        userFacts: normalizeDashboardFactRows(userProfileRecord.userFacts),
        selfFacts: normalizeDashboardFactRows(guildProfileRecord.selfFacts),
        loreFacts: normalizeDashboardFactRows(guildProfileRecord.loreFacts),
        guidanceFacts: normalizeDashboardFactRows([
          ...(Array.isArray(guildProfileRecord.guidanceFacts) ? guildProfileRecord.guidanceFacts : []),
          ...(Array.isArray(userProfileRecord.guidanceFacts) ? userProfileRecord.guidanceFacts : [])
        ])
      },
      promptContext: {
        recentConversationHistory
      },
      activeVoiceSession: getActiveVoiceSessionFactProfileSnapshot(bot, {
        guildId,
        userId
      })
    });
  });

  app.get("/api/memory/reflections", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
    return c.json({
      runs: store.getRecentMemoryReflections(limit)
    });
  });

  app.delete("/api/memory/reflections/:runId", (c) => {
    const runId = String(c.req.param("runId") || "").trim();
    if (!runId) {
      return c.json({ ok: false, error: "runId required" }, 400);
    }
    const result = store.deleteReflectionRun(runId);
    return c.json({ ok: true, deleted: result.deleted });
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
    const queryText = String(c.req.query("q") || "").trim();
    if (!guildId) {
      return c.json({ guildId, facts: [], limit, queryText });
    }
    const facts = store.getFactsForScope({
      guildId,
      limit,
      subjectIds: subjectFilter ? [subjectFilter] : null,
      queryText
    });
    return c.json({ guildId, limit, subject: subjectFilter, queryText, facts });
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
