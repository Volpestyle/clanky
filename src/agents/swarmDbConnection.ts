import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getDevTeamRuntimeConfig } from "../settings/agentStack.ts";

export const SWARM_DB_BUSY_TIMEOUT_MS = 3000;

export type SwarmDbConnection = Database;

export function getDefaultSwarmDbPath(): string {
  return path.join(homedir(), ".swarm-mcp", "swarm.db");
}

function expandHome(rawPath: string): string {
  const normalized = String(rawPath || "").trim();
  if (!normalized) return "";
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(homedir(), normalized.slice(2));
  }
  return normalized;
}

export function resolveSwarmDbPath(rawPath?: string | null): string {
  const explicit = String(rawPath || "").trim();
  const envPath = String(process.env.SWARM_DB_PATH || "").trim();
  return path.resolve(expandHome(explicit || envPath || getDefaultSwarmDbPath()));
}

export function getSwarmDbPath(settings: unknown): string {
  const swarmRuntime = getDevTeamRuntimeConfig(settings).swarm;
  return resolveSwarmDbPath(swarmRuntime?.dbPath || "");
}

export function openSwarmDbConnection(dbPath?: string | null): SwarmDbConnection {
  const resolvedPath = resolveSwarmDbPath(dbPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.exec(`PRAGMA busy_timeout = ${SWARM_DB_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

