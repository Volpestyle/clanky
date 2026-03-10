try {
  globalThis.localStorage?.removeItem("dashboard_token");
} catch {
  // ignore localStorage cleanup failures
}

type ApiOptions = {
  method?: string;
  body?: unknown;
};

export type DashboardAuthState = {
  authenticated: boolean;
  requiresToken: boolean;
  publicHttpsEnabled: boolean;
  authMethod: "none" | "open_local" | "header" | "session";
  configurationError: string | null;
};

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, fallbackText = "") {
    const responseText =
      typeof body === "string"
        ? body
        : fallbackText || JSON.stringify(body);
    super(`API ${status}: ${responseText}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(url: string, options: ApiOptions = {}): Promise<T> {
  const headers = options.body ? { "Content-Type": "application/json" } : undefined;
  const res = await fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    const contentType =
      typeof res.headers?.get === "function"
        ? String(res.headers.get("content-type") || "").toLowerCase()
        : "";
    let body: unknown = text;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    throw new ApiError(res.status, body, text);
  }

  return res.json() as Promise<T>;
}

export async function getDashboardAuthState(): Promise<DashboardAuthState> {
  return api("/api/auth/session");
}

export async function createDashboardSession(token: string): Promise<DashboardAuthState> {
  return api("/api/auth/session", {
    method: "POST",
    body: {
      token
    }
  });
}

export async function destroyDashboardSession(): Promise<DashboardAuthState> {
  return api("/api/auth/session", {
    method: "DELETE"
  });
}

export async function resetSettings(): Promise<unknown> {
  return api("/api/settings/reset", { method: "POST" });
}
