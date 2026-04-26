import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openSwarmDbConnection, type SwarmDbConnection } from "./swarmDbConnection.ts";

export type ReservedInstance = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  fileRoot: string;
};

export type ReserveInstanceOptions = {
  dbPath: string;
  directory: string;
  scope?: string | null;
  fileRoot?: string | null;
  label: string;
};

function normalizePath(input: string): string {
  const next = normalize(resolve(String(input || "").trim()));
  return process.platform === "win32" ? next.toLowerCase() : next;
}

function gitRoot(directory: string): string {
  const start = normalizePath(directory);
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function withConnection<T>(dbPath: string, fn: (db: SwarmDbConnection) => T): T {
  const db = openSwarmDbConnection(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function reserveInstance(opts: ReserveInstanceOptions): ReservedInstance {
  const directory = normalizePath(opts.directory);
  const root = gitRoot(directory);
  const explicitScope = String(opts.scope || "").trim();
  const scope = explicitScope ? normalizePath(explicitScope) : root;
  const fileRoot = opts.fileRoot ? normalizePath(opts.fileRoot) : directory;
  const id = randomUUID();
  const label = String(opts.label || "").trim() || null;

  withConnection(opts.dbPath, (db) => {
    db.run(
      `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
      [id, scope, directory, root, fileRoot, label]
    );
  });

  return { id, scope, directory, root, fileRoot };
}

export function heartbeatUnadopted(dbPath: string, instanceId: string): boolean {
  return withConnection(dbPath, (db) => {
    const result = db.run(
      "UPDATE instances SET heartbeat = unixepoch() WHERE id = ? AND adopted = 0",
      [instanceId]
    );
    return result.changes > 0;
  });
}

export function deleteUnadopted(dbPath: string, instanceId: string): boolean {
  return withConnection(dbPath, (db) => {
    const result = db.run(
      "DELETE FROM instances WHERE id = ? AND adopted = 0",
      [instanceId]
    );
    return result.changes > 0;
  });
}

export function isAdopted(dbPath: string, instanceId: string): boolean | null {
  return withConnection(dbPath, (db) => {
    const row = db
      .query("SELECT adopted FROM instances WHERE id = ?")
      .get(instanceId) as { adopted: number } | null;
    if (!row) return null;
    return row.adopted !== 0;
  });
}

/**
 * Mirrors writes.rs::deregister_instance: cascade-clean an instance row's
 * tasks/locks/messages so the DB ends in the same shape as a clean MCP-side
 * `swarm.deregister`. Used when Clanky tears down a peer it owns regardless of
 * adoption state.
 */
export function fullDeregister(dbPath: string, instanceId: string): void {
  withConnection(dbPath, (db) => {
    const existing = db
      .query("SELECT id, scope, label FROM instances WHERE id = ?")
      .get(instanceId) as { id: string; scope: string; label: string | null } | null;
    if (!existing) return;

    const tx = db.transaction(() => {
      db.run(
        `UPDATE tasks
         SET assignee = NULL, status = 'open',
             updated_at = unixepoch(), changed_at = unixepoch() * 1000
         WHERE assignee = ? AND status IN ('claimed', 'in_progress')`,
        [instanceId]
      );
      db.run(
        `UPDATE tasks
         SET assignee = NULL, updated_at = unixepoch(), changed_at = unixepoch() * 1000
         WHERE assignee = ? AND status IN ('blocked', 'approval_required')`,
        [instanceId]
      );
      db.run(
        "DELETE FROM context WHERE type = 'lock' AND instance_id = ?",
        [instanceId]
      );
      db.run("DELETE FROM messages WHERE recipient = ?", [instanceId]);
      db.run("DELETE FROM instances WHERE id = ?", [instanceId]);
      db.run(
        `INSERT INTO events (scope, type, actor, subject, payload)
         VALUES (?, 'instance.deregistered', ?, ?, ?)`,
        [
          existing.scope,
          instanceId,
          instanceId,
          JSON.stringify({ label: existing.label })
        ]
      );
    });
    tx();
  });
}
