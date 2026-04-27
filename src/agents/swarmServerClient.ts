import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveSwarmDbPath } from "./swarmDbConnection.ts";

const PROTOCOL_VERSION = 1;
const DIRECT_HARNESS_SPAWN_CAPABILITIES = [
  "pty.spawn.args",
  "pty.spawn.env",
  "pty.spawn.initial_input"
] as const;

export type SwarmServerHealth = {
  ok?: boolean;
  v?: number;
  capabilities?: unknown[];
};

export function healthSupportsDirectHarnessSpawn(health: SwarmServerHealth | null | undefined): boolean {
  const capabilities = new Set(
    (Array.isArray(health?.capabilities) ? health.capabilities : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  return health?.ok === true &&
    Number(health.v) === PROTOCOL_VERSION &&
    DIRECT_HARNESS_SPAWN_CAPABILITIES.every((capability) => capabilities.has(capability));
}

export type SwarmServerPtyInfo = {
  id: string;
  command: string;
  cwd: string;
  started_at: number;
  exit_code: number | null;
  bound_instance_id: string | null;
  cols: number;
  rows: number;
  lease?: unknown;
};

export type SwarmServerSpawnPtyRequest = {
  v: number;
  cwd: string;
  harness: "claude" | "codex";
  role?: string | null;
  scope?: string | null;
  label?: string | null;
  name?: string | null;
  instance_id?: string | null;
  cols?: number | null;
  rows?: number | null;
  args?: string[];
  env?: Record<string, string>;
  initial_input?: string | null;
};

export type SwarmServerSpawnPtyResponse = {
  v: number;
  pty: SwarmServerPtyInfo;
};

export type SwarmServerSnapshot = {
  ptys?: SwarmServerPtyInfo[];
};

export function resolveSwarmServerSocketPath(dbPath?: string | null): string {
  const resolvedDbPath = resolveSwarmDbPath(dbPath || "");
  return path.join(path.dirname(resolvedDbPath), "server", "swarm-server.sock");
}

function errorMessageFromPayload(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const message = String((parsed as Record<string, unknown>).message || "").trim();
      if (message) return message;
    }
  } catch {
    // ignore
  }
  return fallback;
}

export class SwarmServerClient {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor({ dbPath, timeoutMs = 1500 }: { dbPath?: string | null; timeoutMs?: number } = {}) {
    this.socketPath = resolveSwarmServerSocketPath(dbPath || "");
    this.timeoutMs = Math.max(100, Math.floor(Number(timeoutMs) || 1500));
  }

  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return false;
    try {
      const health = await this.getHealth();
      return health?.ok === true && Number(health.v) === PROTOCOL_VERSION;
    } catch {
      return false;
    }
  }

  getHealth(): Promise<SwarmServerHealth> {
    return this.requestJson("GET", "/health");
  }

  async supportsDirectHarnessSpawn(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return false;
    try {
      return healthSupportsDirectHarnessSpawn(await this.getHealth());
    } catch {
      return false;
    }
  }

  spawnPty(request: Omit<SwarmServerSpawnPtyRequest, "v">): Promise<SwarmServerSpawnPtyResponse> {
    return this.requestJson("POST", "/pty", {
      v: PROTOCOL_VERSION,
      ...request
    });
  }

  async closePty(ptyId: string, force = true): Promise<void> {
    const normalizedPtyId = String(ptyId || "").trim();
    if (!normalizedPtyId) return;
    await this.requestJson("DELETE", `/pty/${encodeURIComponent(normalizedPtyId)}`, {
      v: PROTOCOL_VERSION,
      pty_id: normalizedPtyId,
      force
    });
  }

  fetchState(): Promise<SwarmServerSnapshot> {
    return this.requestJson("GET", "/state");
  }

  fetchPtyReplay(ptyId: string): Promise<string> {
    const normalizedPtyId = String(ptyId || "").trim();
    if (!normalizedPtyId) return Promise.resolve("");
    return this.requestText("GET", `/pty/${encodeURIComponent(normalizedPtyId)}/replay`);
  }

  private requestText(method: string, requestPath: string, body?: unknown): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const headers: Record<string, string | number> = {
        Accept: "text/plain"
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: requestPath,
          headers,
          timeout: this.timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const statusCode = Number(res.statusCode || 0);
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  errorMessageFromPayload(
                    raw,
                    `swarm-server ${method} ${requestPath} failed with status ${statusCode}`
                  )
                )
              );
              return;
            }
            resolve(raw);
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error(`swarm-server ${method} ${requestPath} timed out`));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  private requestJson<T>(method: string, requestPath: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const headers: Record<string, string | number> = {
        Accept: "application/json"
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: requestPath,
          headers,
          timeout: this.timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const statusCode = Number(res.statusCode || 0);
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  errorMessageFromPayload(
                    raw,
                    `swarm-server ${method} ${requestPath} failed with status ${statusCode}`
                  )
                )
              );
              return;
            }
            if (!raw.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch (error) {
              reject(new Error(`failed to decode swarm-server response: ${error}`));
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error(`swarm-server ${method} ${requestPath} timed out`));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
}
