let token = localStorage.getItem("dashboard_token") || "";

type ApiOptions = {
  method?: string;
  body?: unknown;
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

export function setToken(t: string) {
  token = t;
  localStorage.setItem("dashboard_token", t);
}

export function getToken(): string {
  return token;
}

export async function api<T = unknown>(url: string, options: ApiOptions = {}): Promise<T> {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { "x-dashboard-token": token } : {})
  };

  const res = await fetch(url, {
    method: options.method || "GET",
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

export async function resetSettings(): Promise<unknown> {
  return api("/api/settings/reset", { method: "POST" });
}
