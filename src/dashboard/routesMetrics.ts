import { stream } from "hono/streaming";
import type { DashboardPublicHttpsEntrypoint } from "../dashboard.ts";
import type { DashboardApp, DashboardSseClient } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { parseBoundedInt } from "./shared.ts";
import { getSwarmDbPath } from "../agents/swarmDbConnection.ts";
import { getSwarmServerStatus } from "../agents/swarmServerStatus.ts";
import { getSwarmMcpSkillStatus } from "../agents/swarmMcpSkillStatus.ts";
import { installSwarmMcpSkill, type SkillInstallScope } from "../agents/swarmMcpSkillInstall.ts";
import { readDashboardBody } from "./shared.ts";

interface MetricsRouteDeps {
  store: Store;
  publicHttpsEntrypoint: DashboardPublicHttpsEntrypoint | null;
  getStatsPayload: (guildId?: string | null) => unknown;
  activitySseClients: Set<DashboardSseClient>;
  writeSseEvent: (client: DashboardSseClient, eventName: string, payload: unknown) => Promise<void>;
}

export function attachMetricsRoutes(app: DashboardApp, deps: MetricsRouteDeps) {
  const { store, publicHttpsEntrypoint, getStatsPayload, activitySseClients, writeSseEvent } = deps;

  app.get("/api/swarm-server-status", async (c) => {
    const dbPath = getSwarmDbPath(store.getSettings());
    const status = await getSwarmServerStatus(dbPath);
    return c.json(status);
  });

  app.get("/api/swarm-mcp-skill-status", (c) => {
    const settings = store.getSettings();
    const workspaceRoots = settings.permissions?.devTasks?.allowedWorkspaceRoots || [];
    const status = getSwarmMcpSkillStatus(workspaceRoots);
    return c.json(status);
  });

  app.post("/api/swarm-mcp-skill-install", async (c) => {
    const body = await readDashboardBody(c);
    const scope = String(body.scope || "").trim() as SkillInstallScope;
    if (scope !== "user" && scope !== "workspace") {
      return c.json({ ok: false, reason: "scope must be 'user' or 'workspace'" }, 400);
    }
    const workspaceRoot = scope === "workspace" ? String(body.workspaceRoot || "").trim() : undefined;
    const settings = store.getSettings();
    const allowedWorkspaceRoots = settings.permissions?.devTasks?.allowedWorkspaceRoots || [];
    try {
      const result = installSwarmMcpSkill({ scope, workspaceRoot }, allowedWorkspaceRoots);
      store.logAction({
        kind: "dashboard",
        level: result.ok ? "info" : "warn",
        content: result.ok ? "swarm_mcp_skill_install_ok" : "swarm_mcp_skill_install_failed",
        metadata: { scope, workspaceRoot, created: result.created, skipped: result.skipped, reason: result.reason }
      });
      if (!result.ok) return c.json(result, 400);
      return c.json(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      store.logAction({
        kind: "dashboard",
        level: "error",
        content: "swarm_mcp_skill_install_error",
        metadata: { scope, workspaceRoot, error: reason }
      });
      return c.json({ ok: false, reason }, 500);
    }
  });

  app.get("/api/actions", (c) => {
    const limit = parseBoundedInt(c.req.query("limit"), 200, 1, 1000);
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    const kinds = String(c.req.query("kinds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const sinceHoursRaw = Number(c.req.query("sinceHours"));
    const sinceIso =
      Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
        ? new Date(Date.now() - sinceHoursRaw * 60 * 60 * 1000).toISOString()
        : null;

    return c.json(store.getRecentActions(limit, { kinds, sinceIso, guildId }));
  });

  app.get("/api/agents/browser-sessions", (c) => {
    const sinceHoursRaw = Number(c.req.query("sinceHours"));
    const sinceHours = Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0 ? sinceHoursRaw : 24;
    const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, 200);
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    const sessions = store.getRecentBrowserSessions(limit, { sinceIso, guildId });
    return c.json({ guildId, sessions });
  });

  app.get("/api/stats", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim() || null;
    return c.json(getStatsPayload(guildId));
  });

  app.get("/api/public-https", (c) => {
    return c.json(publicHttpsEntrypoint?.getState?.() || null);
  });

  app.get("/api/activity/events", (c) => {
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
      activitySseClients.add(client);
      let statsInterval: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (statsInterval) clearInterval(statsInterval);
        if (heartbeat) clearInterval(heartbeat);
        activitySseClients.delete(client);
      };

      client.onAbort(cleanup);

      try {
        await writeSseEvent(client, "activity_snapshot", {
          actions: store.getRecentActions(220),
          stats: getStatsPayload(null)
        });
      } catch {
        cleanup();
        await streaming.close();
        return;
      }

      statsInterval = setInterval(() => {
        void writeSseEvent(client, "stats_update", getStatsPayload(null)).catch(() => {
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

  app.get("/api/automations", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const channelId = String(c.req.query("channelId") || "").trim() || null;
    const statusParam = String(c.req.query("status") || "active,paused").trim();
    const query = String(c.req.query("q") || "").trim();
    const limit = parseBoundedInt(c.req.query("limit"), 30, 1, 120);

    if (!guildId) {
      return c.json({ error: "guildId is required" }, 400);
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

    return c.json({
      guildId,
      channelId,
      statuses,
      query,
      limit,
      rows
    });
  });

  app.get("/api/automations/runs", (c) => {
    const guildId = String(c.req.query("guildId") || "").trim();
    const automationId = Number(c.req.query("automationId"));
    const limit = parseBoundedInt(c.req.query("limit"), 30, 1, 120);

    if (!guildId || !Number.isInteger(automationId) || automationId <= 0) {
      return c.json({ error: "guildId and automationId are required" }, 400);
    }

    const rows = store.getAutomationRuns({
      guildId,
      automationId,
      limit
    });

    return c.json({
      guildId,
      automationId,
      limit,
      rows
    });
  });
}
