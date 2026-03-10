import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Store } from "./store/store.ts";
import { normalizeDashboardHost } from "./config.ts";
import { classifyApiAccessPath, isAllowedPublicApiPath, isPublicTunnelRequestHost } from "./services/publicIngressAccess.ts";
import { attachSettingsRoutes } from "./dashboard/routesSettings.ts";
import { attachMetricsRoutes } from "./dashboard/routesMetrics.ts";
import { attachVoiceRoutes } from "./dashboard/routesVoice.ts";
import {
  createDashboardServerHandle,
  DashboardHttpError,
  getRequestIp,
  isApiPath,
  type DashboardApp,
  type DashboardEnv,
  type DashboardServerHandle,
  type DashboardSseClient,
  stripApiPrefix,
  STREAM_INGEST_API_PATH
} from "./dashboard/shared.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_FRAME_REQUEST_WINDOW_MS = 60_000;
const PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW = 1200;
const PUBLIC_FRAME_DECLARED_BYTES_MAX = 6_000_000;
const PUBLIC_SHARE_FRAME_PATH_RE = /^\/api\/voice\/share-session\/[a-z0-9_-]{16,}\/frame\/?$/i;

function isLocalDashboardHost(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export { STREAM_INGEST_API_PATH } from "./dashboard/shared.ts";
export type { DashboardApp, DashboardServerHandle, DashboardSseClient } from "./dashboard/shared.ts";

export interface DashboardAppConfig {
  dashboardPort: number;
  dashboardHost: string;
  dashboardToken: string;
  publicApiToken: string;
  elevenLabsApiKey?: string | null;
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  claudeOAuthRefreshToken?: string | null;
  openaiOAuthRefreshToken?: string | null;
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
  loadFactProfile?(payload: {
    userId?: string | null;
    guildId?: string | null;
    participantIds?: string[];
    participantNames?: Record<string, string>;
  }): {
    participantProfiles?: unknown[];
    selfFacts?: unknown[];
    loreFacts?: unknown[];
    userFacts?: unknown[];
    relevantFacts?: unknown[];
    guidanceFacts?: unknown[];
  };
  loadUserFactProfile?(payload: {
    userId?: string | null;
    guildId?: string | null;
  }): {
    userFacts?: unknown[];
  };
  loadGuildFactProfile?(payload: {
    guildId?: string | null;
  }): {
    selfFacts?: unknown[];
    loreFacts?: unknown[];
  };
  loadBehavioralFactsForPrompt?(payload: {
    guildId: string;
    channelId?: string | null;
    queryText: string;
    participantIds?: string[];
    settings?: unknown;
    trace?: Record<string, unknown>;
    limit?: number;
  }): Promise<unknown[]>;
  searchDurableFacts(payload: {
    guildId: string;
    queryText: string;
    settings: unknown;
    channelId?: string | null;
    subjectIds?: string[] | null;
    factTypes?: string[] | null;
    trace?: Record<string, unknown>;
    limit?: number;
  }): Promise<unknown[]>;
  searchConversationHistory?(payload: {
    guildId: string;
    channelId?: string | null;
    queryText: string;
    settings?: unknown;
    trace?: Record<string, unknown>;
    limit?: number;
    maxAgeHours?: number;
    before?: number;
    after?: number;
  }): Promise<unknown[]>;
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
}: DashboardDeps): {
  app: DashboardApp;
  server: DashboardServerHandle;
} {
  const dashboardHost = normalizeDashboardHost(appConfig.dashboardHost);
  const dashboardToken = String(appConfig.dashboardToken || "").trim();
  if (!dashboardToken && !isLocalDashboardHost(dashboardHost)) {
    throw new Error("DASHBOARD_TOKEN is required when DASHBOARD_HOST is not loopback-only.");
  }

  const app = new Hono<DashboardEnv>();
  const publicFrameIngressRateLimit = new Map<string, FixedWindowBucket>();
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

  app.onError((error, c) => {
    if (error instanceof DashboardHttpError) {
      if (error.responseKind === "text") {
        return new Response(String(error.responseBody), {
          status: error.status,
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        });
      }
      return Response.json(error.responseBody, { status: error.status });
    }

    console.error("Dashboard request failed:", error);
    if (isApiPath(c.req.path)) {
      return c.json(
        {
          error: String(error instanceof Error ? error.message : error)
        },
        500
      );
    }
    return c.text("Internal Server Error", 500);
  });

  app.notFound((c) => {
    if (isApiPath(c.req.path)) {
      return c.json({ error: "Not found." }, 404);
    }
    return c.text("Not found.", 404);
  });

  app.use("*", async (c, next) => {
    if (!isPublicFrameIngressPath(c.req.path)) {
      await next();
      return;
    }

    const contentLengthHeader = String(c.req.header("content-length") || "").trim();
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > PUBLIC_FRAME_DECLARED_BYTES_MAX) {
        return c.json(
          {
            accepted: false,
            reason: "payload_too_large"
          },
          413
        );
      }
    }

    const callerIp = getRequestIp(c);
    const rateKey = `${callerIp}|${c.req.path}`;
    const allowed = consumeFixedWindowRateLimit({
      buckets: publicFrameIngressRateLimit,
      key: rateKey,
      nowMs: Date.now(),
      windowMs: PUBLIC_FRAME_REQUEST_WINDOW_MS,
      maxRequests: PUBLIC_FRAME_REQUEST_MAX_PER_WINDOW
    });
    if (!allowed) {
      return c.json(
        {
          accepted: false,
          reason: "ingest_rate_limited"
        },
        429
      );
    }

    await next();
  });

  app.use("*", async (c, next) => {
    if (!isApiPath(c.req.path)) {
      await next();
      return;
    }

    const apiPath = stripApiPrefix(c.req.path);
    const apiAccessKind = classifyApiAccessPath(apiPath);
    const isPublicApiRoute = isAllowedPublicApiPath(apiPath);
    const dashboardToken = String(appConfig.dashboardToken || "").trim();
    const publicApiToken = String(appConfig.publicApiToken || "").trim();
    const presentedDashboardToken = c.req.header("x-dashboard-token") || "";
    const presentedPublicToken = c.req.header("x-public-api-token") || "";
    const isDashboardAuthorized = Boolean(dashboardToken) && presentedDashboardToken === dashboardToken;
    const isPublicApiAuthorized = Boolean(publicApiToken) && presentedPublicToken === publicApiToken;
    const isPublicTunnelRequest = isRequestFromPublicTunnel(c, publicHttpsEntrypoint);
    const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);

    if (isDashboardAuthorized) {
      await next();
      return;
    }
    if (apiAccessKind === "public_session_token") {
      await next();
      return;
    }
    if (apiAccessKind === "public_header_token" && isPublicApiAuthorized) {
      await next();
      return;
    }

    if (isPublicTunnelRequest && !isPublicApiRoute) {
      return c.json({ error: "Not found." }, 404);
    }

    if (apiAccessKind === "public_header_token") {
      if (!dashboardToken && !publicApiToken) {
        return c.json(
          {
            accepted: false,
            reason: "dashboard_or_public_api_token_required"
          },
          503
        );
      }
      if (publicApiToken && !isPublicApiAuthorized) {
        return c.json(
          {
            accepted: false,
            reason: "unauthorized_public_api_token"
          },
          401
        );
      }
      return c.json(
        {
          accepted: false,
          reason: "unauthorized_dashboard_token"
        },
        401
      );
    }

    if (!dashboardToken) {
      if (publicHttpsEnabled) {
        return c.json(
          {
            error: "dashboard_token_required_when_public_https_enabled"
          },
          503
        );
      }
      await next();
      return;
    }

    return c.json({ error: "Unauthorized. Provide x-dashboard-token." }, 401);
  });

  const voiceSseClients = new Set<DashboardSseClient>();
  const activitySseClients = new Set<DashboardSseClient>();
  const writeSseEvent = async (client: DashboardSseClient, eventName: string, payload: unknown) => {
    const wirePayload = `event: ${String(eventName || "message")}\ndata: ${JSON.stringify(payload)}\n\n`;
    await client.write(wirePayload);
  };
  const broadcastSseEvent = (
    clients: Set<DashboardSseClient>,
    eventName: string,
    payload: unknown
  ) => {
    if (clients.size === 0) return;
    for (const client of clients) {
      void writeSseEvent(client, eventName, payload).catch(() => {
        clients.delete(client);
      });
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

  const staticDir = path.resolve(__dirname, "../dashboard/dist");
  const staticRoot = path.relative(process.cwd(), staticDir) || ".";
  const indexPath = path.join(staticDir, "index.html");

  if (!fs.existsSync(indexPath)) {
    throw new Error("React dashboard build missing at dashboard/dist. Run `bun run build:ui`.");
  }

  const indexHtml = fs.readFileSync(indexPath, "utf8");
  const serveDashboardStatic = serveStatic({ root: staticRoot });

  app.use("*", async (c, next) => {
    if (isRequestFromPublicTunnel(c, publicHttpsEntrypoint) && !c.req.path.startsWith("/share/")) {
      return c.text("Not found.", 404);
    }

    await next();
  });

  app.get("/share/:token", (c) => {
    if (!screenShareSessionManager) {
      return c.text("Screen share link unavailable.", 503);
    }
    const rendered = screenShareSessionManager.renderSharePage(String(c.req.param("token") || "").trim());
    return new Response(String(rendered.html || ""), {
      status: rendered.statusCode || 200,
      headers: {
        "content-type": "text/html; charset=UTF-8"
      }
    });
  });

  app.use("/assets/*", serveDashboardStatic);

  app.get("*", (c) => {
    if (isApiPath(c.req.path) || c.req.path.startsWith("/share/")) {
      return c.text("Not found.", 404);
    }
    return c.html(indexHtml);
  });

  app.on("HEAD", "*", (c) => {
    if (isApiPath(c.req.path) || c.req.path.startsWith("/share/")) {
      return c.body(null, 404);
    }
    return c.body(null, 200, {
      "content-type": "text/html; charset=UTF-8"
    });
  });

  const bunServer = Bun.serve({
    hostname: dashboardHost,
    port: appConfig.dashboardPort,
    fetch(request, server) {
      return app.fetch(request, { server });
    }
  });
  const server = createDashboardServerHandle(bunServer, dashboardHost);

  console.log(`Dashboard running on http://${dashboardHost}:${bunServer.port}`);

  return { app, server };
}

function isRequestFromPublicTunnel(
  c: { req: { header(name: string): string | undefined } },
  publicHttpsEntrypoint: DashboardPublicHttpsEntrypoint | null | undefined
) {
  const requestHost = String(c.req.header("x-forwarded-host") || c.req.header("host") || "").trim();
  if (!requestHost) return false;
  const publicState = publicHttpsEntrypoint?.getState?.() || null;
  return isPublicTunnelRequestHost(requestHost, publicState);
}

function isPublicFrameIngressPath(rawPath: string) {
  const normalizedPath = String(rawPath || "").trim();
  if (!normalizedPath) return false;
  if (normalizedPath === `/api${STREAM_INGEST_API_PATH}` || normalizedPath === `/api${STREAM_INGEST_API_PATH}/`) {
    return true;
  }
  return PUBLIC_SHARE_FRAME_PATH_RE.test(normalizedPath);
}

interface FixedWindowBucket {
  windowStartedAt: number;
  count: number;
  lastSeenAt: number;
}

function consumeFixedWindowRateLimit({
  buckets,
  key,
  nowMs,
  windowMs,
  maxRequests
}: {
  buckets: Map<string, FixedWindowBucket>;
  key: string;
  nowMs: number;
  windowMs: number;
  maxRequests: number;
}) {
  if (!key) return false;
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

function pruneRateLimitBuckets(buckets: Map<string, FixedWindowBucket>, nowMs: number, windowMs: number) {
  if (buckets.size <= 2500) return;
  const staleBefore = nowMs - windowMs * 3;
  for (const [key, bucket] of buckets.entries()) {
    if (Number(bucket.lastSeenAt || 0) < staleBefore) {
      buckets.delete(key);
    }
    if (buckets.size <= 1500) break;
  }
}
