import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { DashboardAppConfig, DashboardPublicHttpsEntrypoint } from "../dashboard.ts";
import { isPublicTunnelRequestHost } from "../services/publicIngressAccess.ts";
import type { DashboardApp } from "./shared.ts";
import { getRequestHost, readDashboardBody } from "./shared.ts";

const DASHBOARD_SESSION_COOKIE_NAME = "dashboard_session";
const DASHBOARD_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
type DashboardCookieContext = Parameters<typeof getSignedCookie>[0];

export interface DashboardAuthState {
  authenticated: boolean;
  requiresToken: boolean;
  publicHttpsEnabled: boolean;
  authMethod: "none" | "open_local" | "header" | "session";
  configurationError: string | null;
}

export interface AuthRouteDeps {
  appConfig: DashboardAppConfig;
  publicHttpsEntrypoint: DashboardPublicHttpsEntrypoint | null;
}

export function isDashboardAuthSessionApiPath(apiPath: string) {
  return String(apiPath || "").trim() === "/auth/session";
}

export async function hasValidDashboardSessionCookie(
  c: DashboardCookieContext,
  dashboardToken: string
) {
  const normalizedToken = String(dashboardToken || "").trim();
  if (!normalizedToken) return false;
  const cookieValue = await getSignedCookie(c, normalizedToken, DASHBOARD_SESSION_COOKIE_NAME);
  return typeof cookieValue === "string" && cookieValue.length > 0;
}

export function attachAuthRoutes(app: DashboardApp, deps: AuthRouteDeps) {
  const { appConfig, publicHttpsEntrypoint } = deps;

  app.get("/api/auth/session", async (c) => {
    c.header("Cache-Control", "no-store");
    if (isRequestFromPublicTunnel(c, publicHttpsEntrypoint)) {
      return c.json({ error: "Not found." }, 404);
    }
    return c.json(await buildDashboardAuthState(c, deps));
  });

  app.post("/api/auth/session", async (c) => {
    c.header("Cache-Control", "no-store");
    if (isRequestFromPublicTunnel(c, publicHttpsEntrypoint)) {
      return c.json({ error: "Not found." }, 404);
    }

    const dashboardToken = String(appConfig.dashboardToken || "").trim();
    const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);
    if (!dashboardToken) {
      if (publicHttpsEnabled) {
        return c.json(
          {
            error: "dashboard_token_required_when_public_https_enabled"
          },
          503
        );
      }
      return c.json(await buildDashboardAuthState(c, deps));
    }

    const body = await readDashboardBody(c);
    const presentedToken = String(body.token || "").trim();
    if (!presentedToken || presentedToken !== dashboardToken) {
      return c.json({ error: "Unauthorized. Provide a valid dashboard token." }, 401);
    }

    await setSignedCookie(c, DASHBOARD_SESSION_COOKIE_NAME, crypto.randomUUID(), dashboardToken, {
      httpOnly: true,
      maxAge: DASHBOARD_SESSION_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Strict",
      secure: isSecureDashboardRequest(c)
    });

    return c.json({
      authenticated: true,
      requiresToken: true,
      publicHttpsEnabled,
      authMethod: "session",
      configurationError: null
    } satisfies DashboardAuthState);
  });

  app.delete("/api/auth/session", async (c) => {
    c.header("Cache-Control", "no-store");
    if (isRequestFromPublicTunnel(c, publicHttpsEntrypoint)) {
      return c.json({ error: "Not found." }, 404);
    }

    deleteCookie(c, DASHBOARD_SESSION_COOKIE_NAME, {
      path: "/"
    });

    const dashboardToken = String(appConfig.dashboardToken || "").trim();
    const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);
    if (!dashboardToken) {
      return c.json({
        authenticated: !publicHttpsEnabled,
        requiresToken: publicHttpsEnabled,
        publicHttpsEnabled,
        authMethod: publicHttpsEnabled ? "none" : "open_local",
        configurationError: publicHttpsEnabled ? "dashboard_token_required_when_public_https_enabled" : null
      } satisfies DashboardAuthState);
    }

    return c.json({
      authenticated: false,
      requiresToken: true,
      publicHttpsEnabled,
      authMethod: "none",
      configurationError: null
    } satisfies DashboardAuthState);
  });
}

async function buildDashboardAuthState(
  c: DashboardCookieContext,
  { appConfig, publicHttpsEntrypoint }: AuthRouteDeps
): Promise<DashboardAuthState> {
  const dashboardToken = String(appConfig.dashboardToken || "").trim();
  const publicHttpsEnabled = Boolean(publicHttpsEntrypoint?.getState?.()?.enabled);

  if (!dashboardToken) {
    if (publicHttpsEnabled) {
      return {
        authenticated: false,
        requiresToken: true,
        publicHttpsEnabled,
        authMethod: "none",
        configurationError: "dashboard_token_required_when_public_https_enabled"
      };
    }

    return {
      authenticated: true,
      requiresToken: false,
      publicHttpsEnabled,
      authMethod: "open_local",
      configurationError: null
    };
  }

  const presentedDashboardToken = String(c.req.header("x-dashboard-token") || "").trim();
  if (presentedDashboardToken && presentedDashboardToken === dashboardToken) {
    return {
      authenticated: true,
      requiresToken: true,
      publicHttpsEnabled,
      authMethod: "header",
      configurationError: null
    };
  }

  const hasSessionCookie = await hasValidDashboardSessionCookie(c, dashboardToken);
  return {
    authenticated: hasSessionCookie,
    requiresToken: true,
    publicHttpsEnabled,
    authMethod: hasSessionCookie ? "session" : "none",
    configurationError: null
  };
}

function isSecureDashboardRequest(
  c: DashboardCookieContext
) {
  const forwardedProto = String(c.req.header("x-forwarded-proto") || "").trim().toLowerCase();
  if (forwardedProto === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function isRequestFromPublicTunnel(
  c: DashboardCookieContext,
  publicHttpsEntrypoint: DashboardPublicHttpsEntrypoint | null | undefined
) {
  const requestHost = getRequestHost(c);
  if (!requestHost) return false;
  const publicState = publicHttpsEntrypoint?.getState?.() || null;
  return isPublicTunnelRequestHost(requestHost, publicState);
}
