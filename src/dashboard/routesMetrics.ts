import { parseBoundedInt } from "../dashboard.ts";
import { getLlmModelCatalog } from "../pricing.ts";
import { STREAM_INGEST_API_PATH } from "../dashboard.ts";

export function attachMetricsRoutes(app: any, deps: any) {
  const { store, bot, memory, appConfig, publicHttpsEntrypoint, screenShareSessionManager, getStatsPayload, voiceSseClients, activitySseClients, writeSseEvent, broadcastSseEvent } = deps;
  
  app.get("/api/actions", (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 200, 1, 1000);
    res.json(store.getRecentActions(limit));
  });

  app.get("/api/stats", (_req, res) => {
    res.json(getStatsPayload());
  });

  app.get("/api/public-https", (_req, res) => {
    res.json(publicHttpsEntrypoint?.getState?.() || null);
  });

  app.get("/api/activity/events", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const client = { res, blocked: false };
    activitySseClients.add(client);

    const sendSnapshot = () => {
      writeSseEvent(client, "activity_snapshot", {
        actions: store.getRecentActions(220),
        stats: getStatsPayload()
      });
    };
    const sendStats = () => {
      writeSseEvent(client, "stats_update", getStatsPayload());
    };

    try {
      sendSnapshot();
    } catch {
      activitySseClients.delete(client);
      return res.end();
    }

    const statsInterval = setInterval(() => {
      try {
        sendStats();
      } catch {
        activitySseClients.delete(client);
      }
    }, 3_000);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // swallowed; close handler will clean up
      }
    }, 15_000);

    _req.on("close", () => {
      clearInterval(statsInterval);
      clearInterval(heartbeat);
      activitySseClients.delete(client);
    });
  });

  app.get("/api/automations", (req, res) => {
    const guildId = String(req.query.guildId || "").trim();
    const channelId = String(req.query.channelId || "").trim() || null;
    const statusParam = String(req.query.status || "active,paused").trim();
    const query = String(req.query.q || "").trim();
    const limit = parseBoundedInt(req.query.limit, 30, 1, 120);

    if (!guildId) {
      return res.status(400).json({ error: "guildId is required" });
    }

    const statuses = statusParam
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const rows = store.listAutomations({
      guildId,
      channelId,
      statuses,
      query,
      limit
    });
    return res.json({
      guildId,
      channelId,
      statuses,
      query,
      limit,
      rows
    });
  });

  app.get("/api/automations/runs", (req, res) => {
    const guildId = String(req.query.guildId || "").trim();
    const automationId = Number(req.query.automationId);
    const limit = parseBoundedInt(req.query.limit, 30, 1, 120);

    if (!guildId || !Number.isInteger(automationId) || automationId <= 0) {
      return res.status(400).json({ error: "guildId and automationId are required" });
    }

    const rows = store.getAutomationRuns({
      guildId,
      automationId,
      limit
    });
    return res.json({
      guildId,
      automationId,
      limit,
      rows
    });
  });
}
