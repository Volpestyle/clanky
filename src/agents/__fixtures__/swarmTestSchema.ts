import { Database } from "bun:sqlite";

/**
 * Minimum subset of swarm-mcp's bootstrap SQL needed by Wave 2 tests
 * (swarmDb, swarmReservationKeeper, swarmLauncher). Mirrors
 * `swarm-mcp/sql/swarm_db_bootstrap.sql` so write paths see the same
 * columns/defaults at runtime. The Wave 1 P1 schema-snapshot test in
 * `swarmDbConnection.test.ts` is what guards us against drift here —
 * if swarm-mcp's bootstrap diverges, that test fails.
 */
export const SWARM_TEST_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  directory TEXT NOT NULL,
  root TEXT NOT NULL,
  file_root TEXT NOT NULL DEFAULT '',
  pid INTEGER NOT NULL,
  label TEXT,
  registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
  heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
  adopted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  requester TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  files TEXT,
  result TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  changed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL,
  recipient TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  file TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  subject TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export function bootstrapSwarmTestSchema(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.exec(SWARM_TEST_SCHEMA);
  } finally {
    db.close();
  }
}
