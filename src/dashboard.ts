import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Response } from "express";
import type { Store } from "./store/store.ts";
import { normalizeDashboardHost } from "./config.ts";
import { classifyApiAccessPath, isAllowedPublicApiPath, isPublicTunnelRequestHost } from "./services/publicIngressAccess.ts";
import { attachSettingsRoutes } from "./dashboard/routesSettings.ts";
import { attachMetricsRoutes } from "./dashboard/routesMetrics.ts";
import { attachVoiceRoutes } from "./dashboard/routesVoice.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const STREAM_INGEST_API_PATH = "/voice/stream-ingest/frame";
const DASHBOARD_JSON_LIMIT = "7mb";
const PUBLIC_FRAME_REQUEST_WINDOW_MS = 60_000;
const PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW = 1200;
const PUBLIC_FRAME_DECLARED_BYTES_MAX = 6_000_000;
const PUBLIC_SHARE_FRAME_PATH_RE = /^\/api\/voice\/share-session\/[a-z0-9_-]{16,}\/frame\/?$/i;

export interface DashboardAppConfig {
  dashboardPort: number;
  dashboardHost: string;
  dashboardToken: string;
  publicApiToken: string;
  elevenLabsApiKey?: string | null;
}
export interface DashboardSseClient {
  res: Response;
  blocked: boolean;
}

export interface DashboardBot {
  applyRuntimeSettings(settings: unknown): Promise<unknown>;
  getRuntimeState(): Record<string, unknown> & {
    voice?: {
      activeCount?: unknown;
      sessions?: Array<Record<string, unknown>>;
    };
  };
  getGuilds(): Array<{ id: string; name: string }>;
  getGuildChannels(guildId: string): unknown;
  requestVoiceJoinFromDashboard?(payload: {
    guildId: string | null;
    requesterUserId: string | null;
    textChannelId: string | null;
    source: string;
  }): Promise<unknown>;
  ingestVoiceStreamFrame(payload: {
    guildId: string;
    streamerUserId: string | null;
    mimeType: string;
    dataBase64: string;
    source: string;
  }): Promise<unknown>;
}

export interface DashboardMemory {
  readMemoryMarkdown(): Promise<string>;
  refreshMemoryMarkdown(): Promise<unknown>;
  searchDurableFacts(payload: {
    guildId: string;
    queryText: string;
    settings: unknown;
    channelId?: string | null;
    trace?: Record<string, unknown>;
    limit?: number;
  }): Promise<unknown[]>;
  rerunDailyReflection?(payload: {
    dateKey: string;
    guildId: string;
    settings?: unknown;
  }): Promise<unknown>;
  buildPromptMemorySlice(payload: {
    guildId: string;
    queryText: string;
    settings: unknown;
    userId?: string | null;
    channelId?: string | null;
    trace?: Record<string, unknown>;
  }): Promise<{
    userFacts?: unknown[];
    relevantFacts?: unknown[];
    relevantMessages?: unknown[];
    [key: string]: unknown;
  }>;
}

export interface DashboardPublicHttpsState {
  enabled?: boolean;
  publicUrl?: string;
  [key: string]: unknown;
}

export interface DashboardPublicHttpsEntrypoint {
  getState?(): DashboardPublicHttpsState | null;
}

export interface DashboardScreenShareSessionManager {
  getRuntimeState?(): unknown;
  renderSharePage(token: string): {
    statusCode?: number | null;
    html?: string | null;
  };
  createSession(payload: {
    guildId: string;
    channelId: string;
    requesterUserId: string;
    requesterDisplayName?: string;
    targetUserId?: string | null;
    source?: string;
  }): Promise<Record<string, unknown>>;
  ingestFrameByToken(payload: {
    token: string;
    mimeType: string;
    dataBase64: string;
    source?: string;
  }): Promise<Record<string, unknown>>;
  stopSessionByToken(payload: {
    token: string;
    reason: string;
  }): Promise<unknown> | unknown;
}

export interface DashboardDeps {
  appConfig: DashboardAppConfig;
  store: Store;
  bot: DashboardBot;
  memory: DashboardMemory;
  publicHttpsEntrypoint?: DashboardPublicHttpsEntrypoint | null;
  screenShareSessionManager?: DashboardScreenShareSessionManager | null;
}

export function createDashboardServer({
  appConfig,
  store,
  bot,
  memory,
  publicHttpsEntrypoint = null,
  screenShareSessionManager = null
}: DashboardDeps) {
  const app = express();
  const publicFrameIngressRateLimit = new Map();
  const getStatsPayload = () => {
    const botRuntime = bot.getRuntimeState();
    return {
      stats: store.getStats(),
      runtime: {
        ...botRuntime,
        publicHttps: publicHttpsEntrypoint?.getState?.() || null,
        screenShare: screenShareSessionManager?.getRuntimeState?.() || null
      }
    };
  };

  app.use((req, res, next) => {
    if (!isPublicFrameIngressPath(req.path)) return next();

    const contentLengthHeader = String(req.get("content-length") || "").trim();
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > PUBLIC_FRAME_DECLARED_BYTES_MAX) {
        return res.status(413).json({
          accepted: false,
          reason: "payload_too_large"
        });
      }
    }

    const callerIp =
      String(req.get("cf-connecting-ip") || req.ip || req.socket?.remoteAddress || "").trim() || "unknown";
    const rateKey = `${callerIp}|${String(req.path || "")}`;
    const allowed = consumeFixedWindowRateLimit({
      buckets: publicFrameIngressRateLimit,
      key: rateKey,
      nowMs: Date.now(),
      windowMs: PUBLIC_FRAME_REQUEST_WINDOW_MS,
      maxRequests: PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW
    });
    if (!allowed) {
      return res.status(429).json({
        accepted: false,
        reason: "ingest_rate_limited"
      });
    }
    return next();
  });

  // Supports max stream-watch frame payloads (4MB binary -> ~5.4MB JSON/base64 body).
  app.use(express.json({ limit: DASHBOARD_JSON_LIMIT }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", (req, res, next) => {
    const apiAccessKind = classifyApiAccessPath(req.path);
    const isPublicApiRoute = isAllowedPublicApiPath(req.path);
    const dashboardToken = String(appConfig.dashboardToken || "").trim();
    const publicApiToken = String(appConfig.publicApiToken || "").trim();
    const presentedDashboardToken = req.get("x-dashboard-token") || req.query?.token || "";
    const presentedPublicToken = req.get("x-public-api-token") || "";
    const isDashboardAuthorized = Boolean(dashboardToken) && presentedDashboardToken === dashboardToken;
    const isPublicApiAuthorized = Boolean(publicApiToken) && presentedPublicToken === publicApiToken;
    const isPublicTunnelRequest = isRequestFromPublicTunnel(req, publicHttpsEntrypoint);
    const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);

    if (isDashboardAuthorized) return next();
    if (apiAccessKind === "public_session_token") return next();
    if (apiAccessKind === "public_header_token" && isPublicApiAuthorized) return next();

    if (isPublicTunnelRequest && !isPublicApiRoute) {
      return res.status(404).json({ error: "Not found." });
    }

    if (apiAccessKind === "public_header_token") {
      if (!dashboardToken && !publicApiToken) {
        return res.status(503).json({
          accepted: false,
          reason: "dashboard_or_public_api_token_required"
        });
      }
      if (publicApiToken && !isPublicApiAuthorized) {
        return res.status(401).json({
          accepted: false,
          reason: "unauthorized_public_api_token"
        });
      }
      return res.status(401).json({
        accepted: false,
        reason: "unauthorized_dashboard_token"
      });
    }

    if (!dashboardToken) {
      if (publicHttpsEnabled) {
        return res.status(503).json({
          error: "dashboard_token_required_when_public_https_enabled"
        });
      }
      return next();
    }
    return res.status(401).json({ error: "Unauthorized. Provide x-dashboard-token." });
  });
  // ---- ElevenLabs voice management ----
  // ---- Dashboard/Voice SSE live-stream ----
  const voiceSseClients = new Set<DashboardSseClient>();
  const activitySseClients = new Set<DashboardSseClient>();
  const writeSseEvent = (client: DashboardSseClient, eventName: string, payload: unknown) => {
    if (!client || client.blocked) return;
    try {
      const wirePayload = `event: ${String(eventName || "message")}\ndata: ${JSON.stringify(payload)}\n\n`;
      const wrote = client.res.write(wirePayload);
      if (wrote === false && typeof client.res.once === "function") {
        client.blocked = true;
        client.res.once("drain", () => {
          client.blocked = false;
        });
      }
    } catch {
      // caller handles client cleanup
      throw new Error("sse_write_failed");
    }
  };
  const broadcastSseEvent = (
    clients: Set<DashboardSseClient>,
    eventName: string,
    payload: unknown
  ) => {
    if (!clients || clients.size === 0) return;
    for (const client of clients) {
      try {
        writeSseEvent(client, eventName, payload);
      } catch {
        clients.delete(client);
      }
    }
  };
  attachSettingsRoutes(app, { store, bot, appConfig });
  attachMetricsRoutes(app, {
    store,
    publicHttpsEntrypoint,
    getStatsPayload,
    activitySseClients,
    writeSseEvent
  });
  attachVoiceRoutes(app, {
    store,
    bot,
    memory,
    screenShareSessionManager,
    voiceSseClients
  });

  const previousActionListener = typeof store.onActionLogged === "function" ? store.onActionLogged : null;
  store.onActionLogged = (action) => {
    if (previousActionListener) {
      try {
        previousActionListener(action);
      } catch {
        // keep dashboard listener resilient
      }
    }

    if (activitySseClients.size > 0) {
      broadcastSseEvent(activitySseClients, "action_event", action);
      broadcastSseEvent(activitySseClients, "stats_update", getStatsPayload());
    }
    if (action?.kind?.startsWith("voice_") && voiceSseClients.size > 0) {
      broadcastSseEvent(voiceSseClients, "voice_event", action);
    }
  };
  app.use((req, res, next) => {
    const isApiRoute = req.path === "/api" || req.path.startsWith("/api/");
    if (isApiRoute) return next();
    if (!isRequestFromPublicTunnel(req, publicHttpsEntrypoint)) return next();
    if (req.path.startsWith("/share/")) return next();
    return res.status(404).send("Not found.");
  });

  app.get("/share/:token", (req, res) => {
    if (!screenShareSessionManager) {
      return res.status(503).send("Screen share link unavailable.");
    }
    const rendered = screenShareSessionManager.renderSharePage(String(req.params?.token || "").trim());
    return res.status(rendered?.statusCode || 200).send(String(rendered?.html || ""));
  });

  const staticDir = path.resolve(__dirname, "../dashboard/dist");
  const indexPath = path.join(staticDir, "index.html");

  if (!fs.existsSync(indexPath)) {
    throw new Error("React dashboard build missing at dashboard/dist. Run `bun run build:ui`.");
  }

  app.use(express.static(staticDir));

  app.get("*", (_req, res) => {
    res.sendFile(indexPath);
  });

  const dashboardHost = normalizeDashboardHost(appConfig.dashboardHost);
  const server = app.listen(appConfig.dashboardPort, dashboardHost, () => {
    console.log(`Dashboard running on http://${dashboardHost}:${appConfig.dashboardPort}`);
  });

  return { app, server };
}

export function parseBoundedInt(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function isRequestFromPublicTunnel(req, publicHttpsEntrypoint) {
  const requestHost = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
  if (!requestHost) return false;
  const publicState = publicHttpsEntrypoint?.getState?.() || null;
  return isPublicTunnelRequestHost(requestHost, publicState);
}

function isPublicFrameIngressPath(rawPath) {
  const normalizedPath = String(rawPath || "").trim();
  if (!normalizedPath) return false;
  if (normalizedPath === `/api${STREAM_INGEST_API_PATH}` || normalizedPath === `/api${STREAM_INGEST_API_PATH}/`) {
    return true;
  }
  return PUBLIC_SHARE_FRAME_PATH_RE.test(normalizedPath);
}

function consumeFixedWindowRateLimit({ buckets, key, nowMs, windowMs, maxRequests }) {
  if (!buckets || !key) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const windowSpan = Math.max(1, Number(windowMs) || 1);
  const maxInWindow = Math.max(1, Number(maxRequests) || 1);

  let bucket = buckets.get(key) || null;
  if (!bucket || now - Number(bucket.windowStartedAt || 0) >= windowSpan) {
    bucket = {
      windowStartedAt: now,
      count: 0,
      lastSeenAt: now
    };
    buckets.set(key, bucket);
  }

  if (Number(bucket.count || 0) >= maxInWindow) {
    bucket.lastSeenAt = now;
    pruneRateLimitBuckets(buckets, now, windowSpan);
    return false;
  }

  bucket.count = Number(bucket.count || 0) + 1;
  bucket.lastSeenAt = now;
  pruneRateLimitBuckets(buckets, now, windowSpan);
  return true;
}

function pruneRateLimitBuckets(buckets, nowMs, windowMs) {
  if (!buckets || buckets.size <= 2500) return;
  const staleBefore = nowMs - windowMs * 3;
  for (const [key, bucket] of buckets.entries()) {
    if (Number(bucket?.lastSeenAt || 0) < staleBefore) {
      buckets.delete(key);
    }
    if (buckets.size <= 1500) break;
  }
}
