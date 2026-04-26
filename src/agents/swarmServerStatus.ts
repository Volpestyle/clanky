import { existsSync } from "node:fs";
import { SwarmServerClient, resolveSwarmServerSocketPath } from "./swarmServerClient.ts";

/**
 * Operator-facing observability for `swarm-server`, the Rust control-plane
 * daemon shipped with `swarm-mcp`. swarm-server is what gives Clanky-spawned
 * coding workers terminal visibility / takeover / replay in `swarm-ui` and
 * `swarm-ios`. When it isn't running, workers still function — they just
 * spawn as plain child processes that no UI can attach to.
 *
 * This module is the cheap "is it up?" surface for the bot startup log and
 * the dashboard widget. The richer client capabilities (spawn / close /
 * state) live in `swarmServerClient.ts`.
 */

export type SwarmServerStatus = {
  available: boolean;
  socketPath: string;
  /** Operator-facing hint when the daemon is unreachable. */
  hint?: string;
};

/**
 * Synchronous existence check. Cheap; useful when the caller only needs to
 * know "is the socket file there at all?" — e.g. boot-time logging that
 * shouldn't block on a network round-trip.
 */
export function swarmServerSocketExists(dbPath?: string | null): boolean {
  return existsSync(resolveSwarmServerSocketPath(dbPath || ""));
}

/**
 * Asynchronous probe via the daemon's `/health` endpoint. Returns
 * `available: true` only when swarm-server actually responds with `ok: true`,
 * not just when the socket file exists. Resolves quickly (<= 1.5s default
 * client timeout) — safe for boot-time use.
 */
export async function getSwarmServerStatus(dbPath?: string | null): Promise<SwarmServerStatus> {
  const client = new SwarmServerClient({ dbPath });
  const socketPath = client.socketPath;

  if (!swarmServerSocketExists(dbPath)) {
    return {
      available: false,
      socketPath,
      hint:
        "swarm-server is not running. Code workers will spawn headless — operators won't see them in swarm-ui or swarm-ios. " +
        "Open swarm-ui (auto-starts the daemon) or run `swarm-server` directly to enable terminal visibility."
    };
  }

  try {
    const ok = await client.isAvailable();
    if (ok) {
      return { available: true, socketPath };
    }
    return {
      available: false,
      socketPath,
      hint:
        `Socket ${socketPath} exists but the daemon did not respond with a healthy /health. ` +
        "Stale socket from a crashed swarm-server? Try restarting it."
    };
  } catch {
    return {
      available: false,
      socketPath,
      hint: `Socket ${socketPath} exists but probing it failed.`
    };
  }
}

/**
 * Format a single human-readable status line. Used at bot startup.
 */
export function formatSwarmServerStatusLine(status: SwarmServerStatus): string {
  if (status.available) {
    return "swarm-server: running ✓ — code workers will be visible/interactive in swarm-ui/swarm-ios";
  }
  return `swarm-server: not running ✗ — ${status.hint || "code workers will spawn headless"}`;
}
