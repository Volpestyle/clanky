import type { Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";

export const STREAM_INGEST_API_PATH = "/voice/stream-ingest/frame";
export const DASHBOARD_BODY_LIMIT_BYTES = 7 * 1024 * 1024;

export type DashboardEnv = {
  Bindings: {
    server: Bun.Server<undefined>;
  };
};

export type DashboardApp = Hono<DashboardEnv>;

export interface DashboardSseClient {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
  onAbort(listener: () => void | Promise<void>): void;
}

export interface DashboardServerAddress {
  address: string;
  family: string;
  port: number;
}

export interface DashboardServerHandle {
  readonly listening: boolean;
  address(): DashboardServerAddress;
  close(callback?: (error?: Error) => void): void;
  closeAllConnections(): void;
  closeIdleConnections(): void;
}

export class DashboardHttpError extends Error {
  readonly status: number;
  readonly responseKind: "json" | "text";
  readonly responseBody: Record<string, unknown> | string;

  constructor(
    status: number,
    responseBody: Record<string, unknown> | string,
    responseKind: "json" | "text" = "json"
  ) {
    super(typeof responseBody === "string" ? responseBody : String(responseBody.error || `HTTP ${status}`));
    this.name = "DashboardHttpError";
    this.status = status;
    this.responseKind = responseKind;
    this.responseBody = responseBody;
  }
}

export function parseBoundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function createDashboardServerHandle(server: Bun.Server<undefined>, fallbackHost: string): DashboardServerHandle {
  return new BunDashboardServerHandle(server, fallbackHost);
}

export function isApiPath(rawPath: string) {
  return rawPath === "/api" || rawPath.startsWith("/api/");
}

export function stripApiPrefix(rawPath: string) {
  if (rawPath === "/api") return "/";
  if (rawPath.startsWith("/api/")) {
    return rawPath.slice("/api".length);
  }
  return rawPath;
}

export function getRequestHost(c: Context<DashboardEnv>) {
  return String(c.req.header("x-forwarded-host") || c.req.header("host") || "").trim();
}

export function getRequestIp(c: Context<DashboardEnv>) {
  const forwardedIp = String(c.req.header("cf-connecting-ip") || "").trim();
  if (forwardedIp) return forwardedIp;

  try {
    const connInfo = getConnInfo(c);
    const address = String(connInfo.remote.address || "").trim();
    return address || "unknown";
  } catch {
    return "unknown";
  }
}

export async function readDashboardBody(
  c: Context,
  limitBytes = DASHBOARD_BODY_LIMIT_BYTES
): Promise<Record<string, unknown>> {
  const declaredLength = parseDeclaredContentLength(c.req.header("content-length"));
  if (declaredLength !== null && declaredLength > limitBytes) {
    throw new DashboardHttpError(413, { error: "payload_too_large" });
  }

  if (!c.req.raw.body) {
    return {};
  }

  const bodyBuffer = await c.req.raw.clone().arrayBuffer();
  if (bodyBuffer.byteLength === 0) {
    return {};
  }
  if (bodyBuffer.byteLength > limitBytes) {
    throw new DashboardHttpError(413, { error: "payload_too_large" });
  }

  const contentType = String(c.req.header("content-type") || "").toLowerCase();
  const bodyText = new TextDecoder().decode(bodyBuffer);

  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      return toBodyRecord(parsed);
    } catch {
      throw new DashboardHttpError(400, { error: "invalid_json_body" });
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseUrlEncodedBody(bodyText);
  }

  return {};
}

class BunDashboardServerHandle implements DashboardServerHandle {
  private listeningState = true;

  constructor(
    private readonly server: Bun.Server<undefined>,
    private readonly fallbackHost: string
  ) {}

  get listening() {
    return this.listeningState;
  }

  address(): DashboardServerAddress {
    const address = String(this.server.hostname || this.fallbackHost || "127.0.0.1");
    return {
      address,
      family: address.includes(":") ? "IPv6" : "IPv4",
      port: Number(this.server.port || 0)
    };
  }

  close(callback?: (error?: Error) => void) {
    if (!this.listeningState) {
      callback?.();
      return;
    }

    this.listeningState = false;
    void this.server
      .stop(false)
      .then(() => {
        callback?.();
      })
      .catch((error: unknown) => {
        callback?.(normalizeError(error));
      });
  }

  closeAllConnections() {
    if (!this.listeningState) return;
    this.listeningState = false;
    void this.server.stop(true).catch(() => {
      // ignore shutdown races
    });
  }

  closeIdleConnections() {
    this.closeAllConnections();
  }
}

function parseDeclaredContentLength(contentLengthHeader: string | undefined) {
  const normalized = String(contentLengthHeader || "").trim();
  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toBodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const body: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    body[key] = entry;
  }
  return body;
}

function parseUrlEncodedBody(bodyText: string) {
  const params = new URLSearchParams(bodyText);
  const body: Record<string, unknown> = {};

  for (const [key, value] of params.entries()) {
    const existing = body[key];
    if (existing === undefined) {
      body[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      body[key] = [...existing, value];
      continue;
    }
    body[key] = [existing, value];
  }

  return body;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
