import { stream } from "hono/streaming";
import type { DashboardBot, DashboardMemory, DashboardScreenShareSessionManager } from "../dashboard.ts";
import type { DashboardApp, DashboardSseClient } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { parseBoundedInt, readDashboardBody, STREAM_INGEST_API_PATH, toRecord } from "./shared.ts";
import { canonicalizeMemoryFactText, canonicalizeMemoryFactType, isLegacyMemoryFactRow } from "../store/storeMemory.ts";

interface VoiceRouteDeps {
  store: Store;
  bot: DashboardBot;
  memory: DashboardMemory;
  screenShareSessionManager: DashboardScreenShareSessionManager | null;
  voiceSseClients: Set<DashboardSseClient>;
}

interface DashboardVoiceSessionRuntime {
  factProfiles: Map<string, unknown>;
  guildFactProfile: unknown;
  behavioralFactCache?: unknown;
  conversationHistoryCaches?: unknown;
  warmMemory?: {
    snapshot?: unknown;
  } | null;
}

interface DashboardVoiceManagerRuntime {
  getSession(guildId: string): DashboardVoiceSessionRuntime | null;
  primeSessionFactProfiles(session: DashboardVoiceSessionRuntime): void;
}

function mapDashboardFactRow(row: unknown) {
  const record = toRecord(row);
  const fact = canonicalizeMemoryFactText(record.fact || "").trim();
  if (!fact) return null;
  const confidence = Number(record.confidence);
  const factType = canonicalizeMemoryFactType(record.factType || record.fact_type || "").trim() || null;
  const scope = String(record.scope || "").trim() || null;
  const userId = String(record.userId || record.user_id || "").trim() || null;
  return {
    id: Number.isInteger(Number(record.id)) ? Number(record.id) : null,
    scope,
    userId,
    subject: String(record.subject || "").trim() || null,
    factType,
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
            : null,
      isLegacy: isLegacyMemoryFactRow({
        fact: String(record.fact || "").trim(),
        fact_type: String(record.factType || record.fact_type || "").trim()
      })
    }
  };
}

function normalizeDashboardFactRows(rows: unknown) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => mapDashboardFactRow(row))
    .filter((row) => row !== null);
}

function mapDashboardEditableFactRow(row: unknown) {
  const record = toRecord(row);
  const fact = canonicalizeMemoryFactText(record.fact || "").trim();
  if (!fact) return null;
  return {
    id: Number.isInteger(Number(record.id)) ? Number(record.id) : null,
    created_at: record.created_at ? String(record.created_at) : record.createdAt ? String(record.createdAt) : null,
    updated_at: record.updated_at ? String(record.updated_at) : record.updatedAt ? String(record.updatedAt) : null,
    scope: String(record.scope || "").trim() || null,
    guild_id: record.guild_id ? String(record.guild_id) : record.guildId ? String(record.guildId) : null,
    channel_id: record.channel_id ? String(record.channel_id) : record.channelId ? String(record.channelId) : null,
    user_id: record.user_id ? String(record.user_id) : record.userId ? String(record.userId) : null,
    subject: String(record.subject || "").trim() || null,
    fact,
    fact_type: canonicalizeMemoryFactType(record.fact_type || record.factType || "").trim() || "other",
    evidence_text:
      record.evidence_text ? String(record.evidence_text) : record.evidenceText ? String(record.evidenceText) : null,
    source_message_id:
      record.source_message_id
        ? String(record.source_message_id)
        : record.sourceMessageId
          ? String(record.sourceMessageId)
          : null,
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0,
    metadata: {
      isLegacy: isLegacyMemoryFactRow({
        fact: String(record.fact || "").trim(),
        fact_type: String(record.fact_type || record.factType || "").trim()
      })
    }
  };
}

function normalizeDashboardEditableFactRows(rows: unknown) {
  return (Array.isArray(rows) ? rows : []).map((row) => mapDashboardEditableFactRow(row)).filter((row) => row !== null);
}

function normalizeDashboardFactEditorText(value: unknown, maxChars: number) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeDashboardFactConfidence(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

async function refreshDashboardMemoryMarkdown(memory: DashboardMemory) {
  try {
    await memory.refreshMemoryMarkdown();
  } catch {
    // Durable fact edits should still succeed even if the operator snapshot
    // fails to refresh immediately.
  }
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

function mapRecentVoiceSessionSummaryRow(row: unknown) {
  const record = toRecord(row);
  const summaryText = String(record.summaryText || record.summary_text || "").trim();
  if (!summaryText) return null;
  const ageMinutes = Number(record.ageMinutes || record.age_minutes);
  return {
    sessionId: String(record.sessionId || record.session_id || "").trim() || null,
    guildId: String(record.guildId || record.guild_id || "").trim() || null,
    channelId: String(record.channelId || record.channel_id || "").trim() || null,
    endedAt: record.endedAt ? String(record.endedAt) : record.ended_at ? String(record.ended_at) : null,
    ageMinutes: Number.isFinite(ageMinutes) ? ageMinutes : null,
    summaryText
  };
}

function getActiveVoiceSessionRecord(bot: DashboardBot, guildId: string) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return null;
  const voiceState = bot.getRuntimeState()?.voice || { sessions: [] };
  const sessions = Array.isArray(voiceState?.sessions) ? voiceState.sessions : [];
  return sessions.find((entry) => String(toRecord(entry).guildId || "").trim() === normalizedGuildId) || null;
}

function getDashboardVoiceManager(bot: DashboardBot) {
  const manager = (bot as DashboardBot & { voiceSessionManager?: DashboardVoiceManagerRuntime }).voiceSessionManager;
  if (!manager) return null;
  if (typeof manager.getSession !== "function") return null;
  if (typeof manager.primeSessionFactProfiles !== "function") return null;
  return manager;
}

function invalidateGuildMemoryRuntime(bot: DashboardBot, guildId: string) {
  if (typeof bot.purgeGuildMemoryRuntime === "function") {
    return Boolean(bot.purgeGuildMemoryRuntime(guildId));
  }

  const manager = getDashboardVoiceManager(bot);
  if (!manager) return false;

  const session = manager.getSession(String(guildId || "").trim());
  if (!session) return false;

  session.factProfiles = new Map();
  session.guildFactProfile = null;
  session.behavioralFactCache = null;
  session.conversationHistoryCaches = null;
  if (session.warmMemory?.snapshot) {
    session.warmMemory.snapshot = null;
  }
  manager.primeSessionFactProfiles(session);
  return true;
}

function normalizeParticipantIds(value: unknown) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return [...new Set(
      value
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .filter(Boolean)
    )];
  }
  return [];
}

function normalizeRuntimeSnapshotRecentMessages(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((row) => {
      const record = toRecord(row);
      const content = String(record.content || "").trim();
      const authorId = String(record.authorId || record.author_id || "").trim();
      if (!content || !authorId) return null;
      return {
        messageId: String(record.messageId || record.message_id || "").trim() || null,
        authorId,
        authorName: String(record.authorName || record.author_name || "").trim() || authorId,
        content
      };
    })
    .filter((row) => row !== null);
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
  const session = getActiveVoiceSessionRecord(bot, guildId);
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
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    const sinceHoursRaw = Number(c.req.query("sinceHours"));
    const sinceIso =
      Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
        ? new Date(Date.now() - sinceHoursRaw * 60 * 60 * 1000).toISOString()
        : null;
    return c.json(store.getRecentVoiceSessions(limit, { sinceIso, guildId }));
  });

  app.get("/api/voice/history/sessions/:sessionId/events", (c) => {
    const sessionId = String(c.req.param("sessionId") || "");
    return c.json(store.getVoiceSessionEvents(sessionId));
  });

  app.get("/api/memory", async (c) => {
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    return c.json({ guildId, markdown: await memory.readMemoryMarkdown({ guildId }) });
  });

  app.post("/api/memory/refresh", async (c) => {
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim() || null;
    await memory.refreshMemoryMarkdown();
    const markdown = await memory.readMemoryMarkdown({ guildId });
    return c.json({ ok: true, guildId, markdown });
  });

  app.delete("/api/memory/guild", async (c) => {
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const confirmGuildName = String(body.confirmGuildName || "").trim();

    if (!guildId) {
      return c.json({ ok: false, error: "guildId required" }, 400);
    }

    const guild = bot.getGuilds().find((entry) => String(entry?.id || "").trim() === guildId) || null;
    if (!guild) {
      return c.json({ ok: false, error: "guild_not_found" }, 404);
    }

    if (!confirmGuildName) {
      return c.json({ ok: false, error: "confirmGuildName required" }, 400);
    }

    const expectedGuildName = String(guild.name || "").trim();
    if (confirmGuildName !== expectedGuildName) {
      return c.json(
        {
          ok: false,
          error: "guild_name_confirmation_mismatch",
          expectedGuildName
        },
        400
      );
    }

    const result =
      typeof memory.purgeGuildMemory === "function"
        ? await memory.purgeGuildMemory({ guildId })
        : { ok: false, reason: "purge_unavailable" };
    if (!result?.ok) {
      return c.json({ ok: false, error: result?.reason || "purge_failed" }, 400);
    }

    try {
      invalidateGuildMemoryRuntime(bot, guildId);
    } catch {
      // The durable purge succeeded. Runtime caches can recover on their next refresh.
    }

    return c.json({
      ok: true,
      guildId,
      guildName: expectedGuildName,
      deleted: {
        durableFacts: Number(result?.durableFactsDeleted || 0),
        durableFactVectors: Number(result?.durableFactVectorsDeleted || 0),
        conversationMessages: Number(result?.conversationMessagesDeleted || 0),
        conversationVectors: Number(result?.conversationVectorsDeleted || 0),
        reflectionEvents: Number(result?.reflectionEventsDeleted || 0),
        journalEntries: Number(result?.journalEntriesDeleted || 0),
        journalFilesTouched: Number(result?.journalFilesTouched || 0)
      },
      summaryRefreshed: Boolean(result?.summaryRefreshed)
    });
  });

  app.post("/api/memory/runtime-snapshot", async (c) => {
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const channelId = String(body.channelId || "").trim() || null;
    const userId = String(body.userId || "").trim() || null;
    const queryText = String(body.queryText || "").replace(/\s+/g, " ").trim().slice(0, 420);
    const mode = String(body.mode || "text").trim().toLowerCase() === "voice" ? "voice" : "text";
    const recentMessages = normalizeRuntimeSnapshotRecentMessages(body.recentMessages);
    const participantIds = normalizeParticipantIds(body.participantIds);

    if (!guildId) {
      return c.json(
        {
          ok: false,
          error: "guildId required"
        },
        400
      );
    }

    const activeVoiceSessionRecord = getActiveVoiceSessionRecord(bot, guildId);
    const activeVoiceSession = getActiveVoiceSessionFactProfileSnapshot(bot, {
      guildId,
      userId
    });
    const participantNameMap: Record<string, string> = {};
    const derivedParticipantIds: string[] = [];
    const pushParticipant = (participantId: string, displayName: string | null, source: string) => {
      const normalizedParticipantId = String(participantId || "").trim();
      if (!normalizedParticipantId) return;
      if (!derivedParticipantIds.includes(normalizedParticipantId)) {
        derivedParticipantIds.push(normalizedParticipantId);
      }
      const normalizedDisplayName = String(displayName || "").trim() || normalizedParticipantId;
      if (!participantNameMap[normalizedParticipantId]) {
        participantNameMap[normalizedParticipantId] = normalizedDisplayName;
      }
      return {
        userId: normalizedParticipantId,
        displayName: normalizedDisplayName,
        source
      };
    };

    const participants: Array<{ userId: string; displayName: string; source: string }> = [];
    for (const participantId of participantIds) {
      const participant = pushParticipant(participantId, participantId, "request");
      if (participant) participants.push(participant);
    }
    for (const message of recentMessages) {
      const participant = pushParticipant(message.authorId, message.authorName, "recent_message");
      if (participant && !participants.some((entry) => entry.userId === participant.userId)) {
        participants.push(participant);
      }
    }
    if (mode === "voice" && activeVoiceSessionRecord) {
      const sessionRecord = toRecord(activeVoiceSessionRecord);
      for (const participant of Array.isArray(sessionRecord.participants) ? sessionRecord.participants : []) {
        const participantRecord = toRecord(participant);
        const participantId = String(participantRecord.userId || "").trim();
        if (!participantId) continue;
        const pushed = pushParticipant(
          participantId,
          String(participantRecord.displayName || "").trim() || participantId,
          "active_voice_session"
        );
        if (pushed && !participants.some((entry) => entry.userId === pushed.userId)) {
          participants.push(pushed);
        }
      }
    }
    if (userId) {
      const participant = pushParticipant(userId, participantNameMap[userId] || userId, "primary_user");
      if (participant) {
        const existingIndex = participants.findIndex((entry) => entry.userId === participant.userId);
        if (existingIndex >= 0) {
          participants[existingIndex] = participant;
        } else {
          participants.unshift(participant);
        }
      }
    }

    const settings = store.getSettings();
    const factProfile =
      typeof memory.loadFactProfile === "function"
        ? toRecord(memory.loadFactProfile({
            userId,
            guildId,
            participantIds: derivedParticipantIds,
            participantNames: participantNameMap
          }))
        : {};

    const behavioralFacts =
      typeof memory.loadBehavioralFactsForPrompt === "function" && queryText
        ? await memory.loadBehavioralFactsForPrompt({
            guildId,
            channelId,
            queryText,
            participantIds: derivedParticipantIds,
            settings,
            trace: {
              guildId,
              channelId,
              userId,
              source: "dashboard_runtime_snapshot_behavioral"
            },
            limit: 8
          })
        : [];

    const recentConversationHistory =
      typeof memory.searchConversationHistory === "function" && channelId && queryText
        ? await memory.searchConversationHistory({
            guildId,
            channelId,
            queryText,
            settings,
            trace: {
              guildId,
              channelId,
              userId,
              source: "dashboard_runtime_snapshot_conversation_history"
            },
            limit: 3,
            maxAgeHours: 24 * 14,
            before: 1,
            after: 1
          })
        : [];
    const recentVoiceSessionContext =
      typeof memory.getRecentVoiceSessionSummariesForPrompt === "function" && channelId
        ? memory.getRecentVoiceSessionSummariesForPrompt({
            guildId,
            channelId,
            referenceAtMs: Date.now()
          })
        : [];

    return c.json({
      guildId,
      channelId,
      userId,
      queryText,
      mode,
      participants,
      counts: {
        participantCount: participants.length,
        participantProfileCount: Array.isArray(factProfile.participantProfiles) ? factProfile.participantProfiles.length : 0,
        userFactCount: Array.isArray(factProfile.userFacts) ? factProfile.userFacts.length : 0,
        relevantFactCount: Array.isArray(factProfile.relevantFacts) ? factProfile.relevantFacts.length : 0,
        selfFactCount: Array.isArray(factProfile.selfFacts) ? factProfile.selfFacts.length : 0,
        loreFactCount: Array.isArray(factProfile.loreFacts) ? factProfile.loreFacts.length : 0,
        guidanceFactCount: Array.isArray(factProfile.guidanceFacts) ? factProfile.guidanceFacts.length : 0,
        behavioralFactCount: Array.isArray(behavioralFacts) ? behavioralFacts.length : 0,
        conversationWindowCount: Array.isArray(recentConversationHistory) ? recentConversationHistory.length : 0,
        recentVoiceSessionCount: Array.isArray(recentVoiceSessionContext) ? recentVoiceSessionContext.length : 0
      },
      slice: {
        participantProfiles: (Array.isArray(factProfile.participantProfiles) ? factProfile.participantProfiles : [])
          .map((entry) => {
            const profileRecord = toRecord(entry);
            return {
              userId: String(profileRecord.userId || "").trim() || null,
              displayName: String(profileRecord.displayName || "").trim() || null,
              isPrimary: Boolean(profileRecord.isPrimary),
              facts: normalizeDashboardFactRows(profileRecord.facts)
            };
          }),
        userFacts: normalizeDashboardFactRows(factProfile.userFacts),
        relevantFacts: normalizeDashboardFactRows(factProfile.relevantFacts),
        selfFacts: normalizeDashboardFactRows(factProfile.selfFacts),
        loreFacts: normalizeDashboardFactRows(factProfile.loreFacts),
        guidanceFacts: normalizeDashboardFactRows(factProfile.guidanceFacts),
        behavioralFacts: normalizeDashboardFactRows(behavioralFacts)
      },
      promptContext: {
        recentConversationHistory: (Array.isArray(recentConversationHistory) ? recentConversationHistory : [])
          .map((row) => mapConversationWindowRow(row))
          .filter((row): row is NonNullable<ReturnType<typeof mapConversationWindowRow>> => row !== null),
        recentVoiceSessionContext: (Array.isArray(recentVoiceSessionContext) ? recentVoiceSessionContext : [])
          .map((row) => mapRecentVoiceSessionSummaryRow(row))
          .filter((row): row is NonNullable<ReturnType<typeof mapRecentVoiceSessionSummaryRow>> => row !== null)
      },
      activeVoiceSession
    });
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
    const recentVoiceSessionContext =
      typeof memory.getRecentVoiceSessionSummariesForPrompt === "function" && channelId
        ? memory.getRecentVoiceSessionSummariesForPrompt({
            guildId,
            channelId,
            referenceAtMs: Date.now()
          })
            .map((row) => mapRecentVoiceSessionSummaryRow(row))
            .filter((row): row is NonNullable<ReturnType<typeof mapRecentVoiceSessionSummaryRow>> => row !== null)
        : [];

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
        recentConversationHistory,
        recentVoiceSessionContext
      },
      activeVoiceSession: getActiveVoiceSessionFactProfileSnapshot(bot, {
        guildId,
        userId
      })
    });
  });

  app.get("/api/memory/owner-private", (c) => {
    const ownerProfile =
      typeof memory.loadOwnerFactProfile === "function"
        ? toRecord(memory.loadOwnerFactProfile())
        : (() => {
            const rows = store.getFactsForScope({
              scope: "owner",
              subjectIds: ["__owner__"],
              limit: 120
            });
            return {
              ownerFacts: rows.filter((row) => {
                const factType = String(row?.fact_type || "").trim();
                return factType !== "guidance" && factType !== "behavioral";
              }),
              guidanceFacts: rows.filter((row) => String(row?.fact_type || "").trim() === "guidance")
            };
          })();
    return c.json({
      ownerProfile: {
        ownerFacts: normalizeDashboardFactRows(ownerProfile.ownerFacts),
        guidanceFacts: normalizeDashboardFactRows(ownerProfile.guidanceFacts)
      }
    });
  });

  app.get("/api/memory/owner-private/facts", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 120, 1, 500);
    const queryText = String(c.req.query("q") || "").trim();
    const facts = store.getFactsForScope({
      scope: "owner",
      limit,
      subjectIds: ["__owner__"],
      queryText
    });
    return c.json({
      limit,
      queryText,
      facts: normalizeDashboardEditableFactRows(facts)
    });
  });

  app.put("/api/memory/owner-private/facts/:factId", async (c) => {
    const factId = Number(c.req.param("factId"));
    const body = await readDashboardBody(c);
    const subject = normalizeDashboardFactEditorText(body.subject, 120);
    const fact = normalizeDashboardFactEditorText(body.fact, 400);
    const factType = normalizeDashboardFactEditorText(body.factType, 40).toLowerCase() || "other";
    const evidenceText = normalizeDashboardFactEditorText(body.evidenceText, 240) || null;
    const confidence = normalizeDashboardFactConfidence(body.confidence);

    if (!Number.isInteger(factId) || factId <= 0) {
      return c.json({ ok: false, error: "valid factId required" }, 400);
    }
    if (!subject) {
      return c.json({ ok: false, error: "subject required" }, 400);
    }
    if (!fact) {
      return c.json({ ok: false, error: "fact required" }, 400);
    }
    if (confidence === null) {
      return c.json({ ok: false, error: "confidence must be a number between 0 and 1" }, 400);
    }

    const existing = store.getMemoryFactById(factId, null, "owner");
    if (!existing || existing.scope !== "owner") {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const result = store.updateMemoryFact({
      guildId: null,
      scope: "owner",
      userId: existing.user_id,
      factId,
      subject,
      fact,
      factType,
      evidenceText,
      confidence
    });
    if (!result.ok) {
      const status = result.reason === "duplicate" ? 409 : result.reason === "not_found" ? 404 : 400;
      return c.json({ ok: false, error: result.reason }, status);
    }

    await refreshDashboardMemoryMarkdown(memory);

    return c.json({
      ok: true,
      fact: mapDashboardEditableFactRow(result.row)
    });
  });

  app.delete("/api/memory/owner-private/facts/:factId", async (c) => {
    const factId = Number(c.req.param("factId"));
    if (!Number.isInteger(factId) || factId <= 0) {
      return c.json({ ok: false, error: "valid factId required" }, 400);
    }

    const existing = store.getMemoryFactById(factId, null, "owner");
    if (!existing || existing.scope !== "owner") {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const result = store.deleteMemoryFact({
      guildId: null,
      scope: "owner",
      userId: existing.user_id,
      factId
    });
    if (!result.ok) {
      return c.json({ ok: false, error: result.reason }, result.reason === "not_found" ? 404 : 400);
    }

    await refreshDashboardMemoryMarkdown(memory);

    return c.json({
      ok: true,
      deleted: result.deleted
    });
  });

  app.get("/api/memory/reflections", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    return c.json({
      guildId,
      runs: store.getRecentMemoryReflections(limit, { guildId })
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
    const subjects = store.getMemorySubjects(limit, { guildId, includePortableUserScope: true, includeOwnerScope: true });
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
      includePortableUserScope: true,
      includeOwnerScope: true,
      queryText
    });
    return c.json({ guildId, limit, subject: subjectFilter, queryText, facts: normalizeDashboardEditableFactRows(facts) });
  });

  app.put("/api/memory/facts/:factId", async (c) => {
    const factId = Number(c.req.param("factId"));
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();
    const subject = normalizeDashboardFactEditorText(body.subject, 120);
    const fact = normalizeDashboardFactEditorText(body.fact, 400);
    const factType = normalizeDashboardFactEditorText(body.factType, 40).toLowerCase() || "other";
    const evidenceText = normalizeDashboardFactEditorText(body.evidenceText, 240) || null;
    const confidence = normalizeDashboardFactConfidence(body.confidence);

    if (!guildId) {
      return c.json({ ok: false, error: "guildId required" }, 400);
    }
    if (!Number.isInteger(factId) || factId <= 0) {
      return c.json({ ok: false, error: "valid factId required" }, 400);
    }
    if (!subject) {
      return c.json({ ok: false, error: "subject required" }, 400);
    }
    if (!fact) {
      return c.json({ ok: false, error: "fact required" }, 400);
    }
    if (confidence === null) {
      return c.json({ ok: false, error: "confidence must be a number between 0 and 1" }, 400);
    }

    const existing = store.getMemoryFactById(factId);
    if (!existing) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    if (existing.scope === "guild" && existing.guild_id !== guildId) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const result = store.updateMemoryFact({
      guildId: existing.guild_id,
      scope: existing.scope,
      userId: existing.user_id,
      factId,
      subject,
      fact,
      factType,
      evidenceText,
      confidence
    });

    if (!result.ok) {
      const status = result.reason === "duplicate" ? 409 : result.reason === "not_found" ? 404 : 400;
      return c.json({ ok: false, error: result.reason }, status);
    }

    await refreshDashboardMemoryMarkdown(memory);

    return c.json({
      ok: true,
      fact: mapDashboardEditableFactRow(result.row)
    });
  });

  app.delete("/api/memory/facts/:factId", async (c) => {
    const factId = Number(c.req.param("factId"));
    const body = await readDashboardBody(c);
    const guildId = String(body.guildId || "").trim();

    if (!guildId) {
      return c.json({ ok: false, error: "guildId required" }, 400);
    }
    if (!Number.isInteger(factId) || factId <= 0) {
      return c.json({ ok: false, error: "valid factId required" }, 400);
    }

    const existing = store.getMemoryFactById(factId);
    if (!existing) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    if (existing.scope === "guild" && existing.guild_id !== guildId) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const result = store.deleteMemoryFact({
      guildId: existing.guild_id,
      scope: existing.scope,
      factId
    });
    if (!result.ok) {
      return c.json({ ok: false, error: result.reason }, result.reason === "not_found" ? 404 : 400);
    }

    await refreshDashboardMemoryMarkdown(memory);

    return c.json({
      ok: true,
      deleted: result.deleted
    });
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
