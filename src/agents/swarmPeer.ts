import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { openSwarmDbConnection } from "./swarmDbConnection.ts";

const SWARM_DB_SCHEMA_VERSION = 1;
const STALE_INSTANCE_SECONDS = 30;
const MESSAGE_TTL_SECONDS = 3600;
const DEFAULT_ACTIVITY_POLL_INTERVAL_MS = 200;

const SWARM_BOOTSTRAP_SQL = `
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA user_version = ${SWARM_DB_SCHEMA_VERSION};

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

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL,
  recipient TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read INTEGER NOT NULL DEFAULT 0
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
  changed_at INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,
  idempotency_key TEXT,
  parent_task_id TEXT
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

CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS kv_scope_updates (
  scope TEXT PRIMARY KEY,
  changed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ui_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  created_by TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  claimed_by TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (status = 'pending' OR claimed_by IS NOT NULL),
  CHECK (status != 'pending' OR started_at IS NULL),
  CHECK (status NOT IN ('done', 'failed') OR completed_at IS NOT NULL)
);
`;

const SWARM_FINALIZE_SQL = `
UPDATE instances SET scope = directory WHERE scope = '';
UPDATE instances SET root = directory WHERE root = '';
UPDATE instances SET file_root = directory WHERE file_root = '';
UPDATE tasks SET changed_at = updated_at * 1000 WHERE changed_at = 0;

CREATE INDEX IF NOT EXISTS messages_scope_recipient_read_idx
  ON messages(scope, recipient, read, id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx
  ON messages(created_at);
CREATE INDEX IF NOT EXISTS instances_scope_idx
  ON instances(scope);
CREATE INDEX IF NOT EXISTS instances_heartbeat_idx
  ON instances(heartbeat);
CREATE INDEX IF NOT EXISTS tasks_scope_status_idx
  ON tasks(scope, status);
CREATE INDEX IF NOT EXISTS tasks_scope_assignee_idx
  ON tasks(scope, assignee);
CREATE INDEX IF NOT EXISTS tasks_scope_changed_at_idx
  ON tasks(scope, changed_at);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key_idx
  ON tasks(scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_scope_file_idx
  ON context(scope, file);
CREATE UNIQUE INDEX IF NOT EXISTS context_lock_idx
  ON context(scope, file) WHERE type = 'lock';
CREATE INDEX IF NOT EXISTS events_scope_id_idx
  ON events(scope, id);
CREATE INDEX IF NOT EXISTS events_created_at_idx
  ON events(created_at);
CREATE INDEX IF NOT EXISTS ui_commands_scope_status_id_idx
  ON ui_commands(scope, status, id);
`;

export type SwarmTaskStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "done"
  | "failed"
  | "cancelled"
  | "blocked"
  | "approval_required";

export type SwarmTaskType =
  | "review"
  | "implement"
  | "fix"
  | "test"
  | "research"
  | "other"
  | "code";

export type SwarmInstance = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  fileRoot: string;
  pid: number;
  label: string | null;
  registeredAt: number;
  heartbeat: number;
  adopted: boolean;
};

export type SwarmMessage = {
  id: number;
  scope: string;
  sender: string;
  recipient: string | null;
  content: string;
  createdAt: number;
  read: boolean;
};

export type SwarmContextEntry = {
  id: string;
  scope: string;
  instanceId: string;
  file: string;
  type: string;
  content: string;
  createdAt: number;
};

export type SwarmKvEntry = {
  scope: string;
  key: string;
  value: string;
  updatedAt: number;
};

export type SwarmTask = {
  id: string;
  scope: string;
  type: SwarmTaskType | string;
  title: string;
  description: string | null;
  requester: string;
  assignee: string | null;
  status: SwarmTaskStatus;
  files: string[];
  result: string | null;
  createdAt: number;
  updatedAt: number;
  changedAt: number;
  priority: number;
  dependsOn: string[];
  idempotencyKey: string | null;
  parentTaskId: string | null;
};

export type SwarmTaskSnapshot = Record<SwarmTaskStatus, SwarmTask[]>;

export type SwarmActivityChange =
  | "new_messages"
  | "task_updates"
  | "instance_changes"
  | "kv_updates";

export type SwarmActivity = {
  changes: SwarmActivityChange[];
  messages?: SwarmMessage[];
  tasks?: SwarmTaskSnapshot;
  instances?: SwarmInstance[];
  timeout?: boolean;
};

export type RequestTaskOpts = {
  type: SwarmTaskType | string;
  title: string;
  description?: string;
  files?: string[];
  assignee?: string;
  priority?: number;
  dependsOn?: string[];
  idempotencyKey?: string;
  parentTaskId?: string;
  approvalRequired?: boolean;
};

export type UpdateTaskOpts = {
  status: Extract<SwarmTaskStatus, "in_progress" | "done" | "failed" | "cancelled">;
  result?: string;
  metadata?: Record<string, unknown>;
};

export type AnnotateOpts = {
  file: string;
  kind: string;
  content: string;
};

export type ListTasksOpts = {
  status?: SwarmTaskStatus;
  assignee?: string;
  requester?: string;
};

type InstanceRow = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  file_root: string;
  pid: number;
  label: string | null;
  registered_at: number;
  heartbeat: number;
  adopted: number;
};

type MessageRow = {
  id: number;
  scope: string;
  sender: string;
  recipient: string | null;
  content: string;
  created_at: number;
  read: number;
};

type ContextRow = {
  id: string;
  scope: string;
  instance_id: string;
  file: string;
  type: string;
  content: string;
  created_at: number;
};

type KvRow = {
  scope: string;
  key: string;
  value: string;
  updated_at: number;
};

type TaskRow = {
  id: string;
  scope: string;
  type: string;
  title: string;
  description: string | null;
  requester: string;
  assignee: string | null;
  status: SwarmTaskStatus;
  files: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  changed_at: number;
  priority: number;
  depends_on: string | null;
  idempotency_key: string | null;
  parent_task_id: string | null;
};

type ReleasedTaskRow = {
  id: string;
  title: string;
  type: string;
  assignee: string;
  scope: string;
};

type ScopeVersionRow = {
  count: number;
  max_registered_at: number;
  max_heartbeat: number;
};

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function stamp() {
  return Date.now();
}

function marks(size: number) {
  return Array.from({ length: size }, () => "?").join(",");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizePath(value: string) {
  const resolved = path.resolve(String(value || "."));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeLabelToken(value: unknown, fallback: string) {
  const sanitized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return sanitized || fallback;
}

function readJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "")).filter(Boolean);
  } catch {
    return [];
  }
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = openSwarmDbConnection(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function userVersion(db: Database) {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

function tableColumns(db: Database, tableName: string) {
  return db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
}

function hasColumn(db: Database, tableName: string, column: string) {
  return tableColumns(db, tableName).some((item) => item.name === column);
}

function addColumnIfMissing(db: Database, tableName: string, spec: string) {
  const column = spec.trim().split(/\s+/)[0];
  if (!column || hasColumn(db, tableName, column)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${spec}`);
}

function ensureSwarmSchema(db: Database) {
  const liveVersion = userVersion(db);
  if (liveVersion > SWARM_DB_SCHEMA_VERSION) {
    throw new Error(
      `swarm.db schema version ${liveVersion} is newer than Clanky's peer runtime supports (${SWARM_DB_SCHEMA_VERSION}).`
    );
  }

  db.exec(SWARM_BOOTSTRAP_SQL);
  addColumnIfMissing(db, "instances", "scope TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "instances", "root TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "instances", "file_root TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "instances", "adopted INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "messages", "scope TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "tasks", "scope TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "tasks", "changed_at INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "tasks", "priority INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "tasks", "depends_on TEXT");
  addColumnIfMissing(db, "tasks", "idempotency_key TEXT");
  addColumnIfMissing(db, "tasks", "parent_task_id TEXT");
  addColumnIfMissing(db, "context", "scope TEXT NOT NULL DEFAULT ''");
  db.exec(SWARM_FINALIZE_SQL);
  db.exec(`PRAGMA user_version = ${SWARM_DB_SCHEMA_VERSION}`);
}

function ensureSwarmDb(dbPath: string) {
  withDb(dbPath, ensureSwarmSchema);
}

function emit(
  db: Database,
  scope: string,
  type: string,
  actor: string | null,
  subject: string | null,
  payload?: Record<string, string | number | boolean | null> | null
) {
  db.run(
    "INSERT INTO events (scope, type, actor, subject, payload) VALUES (?, ?, ?, ?, ?)",
    [scope, type, actor, subject, payload ? JSON.stringify(payload) : null]
  );
}

function toInstance(row: InstanceRow): SwarmInstance {
  return {
    id: row.id,
    scope: row.scope,
    directory: row.directory,
    root: row.root,
    fileRoot: row.file_root,
    pid: row.pid,
    label: row.label,
    registeredAt: row.registered_at,
    heartbeat: row.heartbeat,
    adopted: row.adopted !== 0
  };
}

function toMessage(row: MessageRow): SwarmMessage {
  return {
    id: row.id,
    scope: row.scope,
    sender: row.sender,
    recipient: row.recipient,
    content: row.content,
    createdAt: row.created_at,
    read: row.read !== 0
  };
}

function toContextEntry(row: ContextRow): SwarmContextEntry {
  return {
    id: row.id,
    scope: row.scope,
    instanceId: row.instance_id,
    file: row.file,
    type: row.type,
    content: row.content,
    createdAt: row.created_at
  };
}

function toKvEntry(row: KvRow): SwarmKvEntry {
  return {
    scope: row.scope,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at
  };
}

function toTask(row: TaskRow): SwarmTask {
  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    title: row.title,
    description: row.description,
    requester: row.requester,
    assignee: row.assignee,
    status: row.status,
    files: readJsonStringArray(row.files),
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    changedAt: row.changed_at,
    priority: row.priority,
    dependsOn: readJsonStringArray(row.depends_on),
    idempotencyKey: row.idempotency_key,
    parentTaskId: row.parent_task_id
  };
}

function listActiveInstances(db: Database, scope: string, labelContains?: string) {
  prune(db);

  const rows = labelContains
    ? (db
        .query(
          `SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, adopted
           FROM instances
           WHERE scope = ? AND label LIKE '%' || ? || '%'
           ORDER BY registered_at ASC`
        )
        .all(scope, labelContains) as InstanceRow[])
    : (db
        .query(
          `SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, adopted
           FROM instances
           WHERE scope = ?
           ORDER BY registered_at ASC`
        )
        .all(scope) as InstanceRow[]);

  return rows.map(toInstance);
}

function getInstance(db: Database, id: string) {
  prune(db);
  const row = db
    .query(
      `SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, adopted
       FROM instances
       WHERE id = ?`
    )
    .get(id) as InstanceRow | null;
  return row ? toInstance(row) : null;
}

function releaseInstances(db: Database, ids: string[]) {
  if (!ids.length) return;
  const slots = marks(ids.length);
  const changedAt = stamp();

  db.run(
    `UPDATE tasks
     SET assignee = NULL, status = 'open', updated_at = unixepoch(), changed_at = ?
     WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`,
    [changedAt, ...ids]
  );
  db.run(
    `UPDATE tasks
     SET assignee = NULL, updated_at = unixepoch(), changed_at = ?
     WHERE assignee IN (${slots}) AND status IN ('blocked', 'approval_required')`,
    [changedAt, ...ids]
  );
  db.run(`DELETE FROM context WHERE type = 'lock' AND instance_id IN (${slots})`, ids);
  db.run(`DELETE FROM messages WHERE recipient IN (${slots})`, ids);
}

function prune(db: Database) {
  const cutoff = nowSeconds() - STALE_INSTANCE_SECONDS;
  const stale = db
    .query("SELECT id, scope, label FROM instances WHERE heartbeat < ?")
    .all(cutoff) as Array<{ id: string; scope: string; label: string | null }>;

  if (stale.length) {
    const ids = stale.map((item) => item.id);
    const slots = marks(ids.length);
    const releasedTasks = db
      .query(
        `SELECT id, title, type, assignee, scope
         FROM tasks
         WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`
      )
      .all(...ids) as ReleasedTaskRow[];

    db.transaction(() => {
      releaseInstances(db, ids);
      db.run(`DELETE FROM instances WHERE id IN (${slots})`, ids);

      for (const item of stale) {
        emit(db, item.scope, "instance.stale_reclaimed", "system", item.id, {
          label: item.label
        });
      }

      const tasksByScope = new Map<string, ReleasedTaskRow[]>();
      for (const task of releasedTasks) {
        const existing = tasksByScope.get(task.scope) ?? [];
        existing.push(task);
        tasksByScope.set(task.scope, existing);
      }

      for (const [scope, tasks] of tasksByScope) {
        const staleAgent = stale.find((item) => tasks.some((task) => task.assignee === item.id));
        const agentLabel = staleAgent?.label ?? staleAgent?.id ?? "unknown";
        const summary = tasks.map((task) => `"${task.title}" (${task.type}, task_id: ${task.id})`).join(", ");
        const content = `[auto] Agent ${agentLabel} went stale. ${tasks.length} task(s) released back to open: ${summary}. Claim them if they match your role.`;
        const recipients = db.query("SELECT id FROM instances WHERE scope = ?").all(scope) as Array<{ id: string }>;
        for (const recipient of recipients) {
          db.run(
            "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
            [scope, "system", recipient.id, content]
          );
        }
      }
    })();
  }

  db.run("DELETE FROM messages WHERE created_at < ?", [nowSeconds() - MESSAGE_TTL_SECONDS]);
}

function dependencyState(db: Database, scope: string, depIds: string[] = []) {
  if (!depIds.length) return { kind: "ready" as const };

  let allDone = true;
  for (const depId of depIds) {
    const dep = db
      .query("SELECT status FROM tasks WHERE id = ? AND scope = ?")
      .get(depId, scope) as { status: SwarmTaskStatus } | null;
    if (dep?.status === "failed" || dep?.status === "cancelled") {
      return { kind: "failed" as const, depId, depStatus: dep.status };
    }
    if (dep?.status !== "done") allDone = false;
  }

  return allDone ? { kind: "ready" as const } : { kind: "blocked" as const };
}

function autoCancelledResult(depId: string, depStatus: "failed" | "cancelled") {
  return `auto-cancelled: dependency ${depId} is already ${depStatus}`;
}

function validateTaskRelations(db: Database, scope: string, opts: RequestTaskOpts) {
  for (const depId of opts.dependsOn ?? []) {
    const dep = db.query("SELECT id FROM tasks WHERE id = ? AND scope = ?").get(depId, scope);
    if (!dep) return `Dependency task ${depId} not found in scope`;
  }

  if (!opts.parentTaskId) return null;
  const parent = db
    .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
    .get(opts.parentTaskId, scope);
  if (!parent) return `Parent task ${opts.parentTaskId} not found in scope`;
  return null;
}

function initialTaskState(db: Database, scope: string, opts: RequestTaskOpts) {
  const deps = dependencyState(db, scope, opts.dependsOn);
  if (deps.kind === "failed") {
    return {
      status: "cancelled" as const,
      result: autoCancelledResult(deps.depId, deps.depStatus)
    };
  }
  if (opts.approvalRequired) return { status: "approval_required" as const, result: null };
  if (deps.kind === "blocked") return { status: "blocked" as const, result: null };
  return { status: opts.assignee ? ("claimed" as const) : ("open" as const), result: null };
}

function processCompletion(db: Database, scope: string, completedId: string) {
  const blocked = db
    .query(
      `SELECT id, depends_on, assignee
       FROM tasks
       WHERE scope = ? AND status = 'blocked' AND depends_on IS NOT NULL`
    )
    .all(scope) as Array<{ id: string; depends_on: string; assignee: string | null }>;

  for (const task of blocked) {
    const deps = readJsonStringArray(task.depends_on);
    if (!deps.includes(completedId)) continue;

    const state = dependencyState(db, scope, deps);
    if (state.kind === "failed") {
      db.run(
        "UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
        [autoCancelledResult(state.depId, state.depStatus), stamp(), task.id, scope]
      );
      emit(db, scope, "task.cascade.cancelled", "system", task.id, {
        trigger: completedId,
        reason: "dependency_failed"
      });
      processFailure(db, scope, task.id);
      continue;
    }

    if (state.kind === "ready") {
      const nextStatus = task.assignee ? "claimed" : "open";
      db.run(
        "UPDATE tasks SET status = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
        [nextStatus, stamp(), task.id, scope]
      );
      emit(db, scope, "task.cascade.unblocked", "system", task.id, {
        trigger: completedId,
        status: nextStatus
      });
    }
  }
}

function processFailure(db: Database, scope: string, failedId: string) {
  const dependents = db
    .query(
      `SELECT id, depends_on
       FROM tasks
       WHERE scope = ? AND status IN ('blocked', 'approval_required') AND depends_on IS NOT NULL`
    )
    .all(scope) as Array<{ id: string; depends_on: string }>;

  for (const task of dependents) {
    const deps = readJsonStringArray(task.depends_on);
    if (!deps.includes(failedId)) continue;

    db.run(
      "UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
      [`auto-cancelled: dependency ${failedId} failed`, stamp(), task.id, scope]
    );
    emit(db, scope, "task.cascade.cancelled", "system", task.id, {
      trigger: failedId,
      reason: "dependency_failed"
    });
    processFailure(db, scope, task.id);
  }
}

function getTaskById(db: Database, scope: string, id: string) {
  prune(db);
  const row = db.query("SELECT * FROM tasks WHERE id = ? AND scope = ?").get(id, scope) as TaskRow | null;
  return row ? toTask(row) : null;
}

function listTasks(db: Database, scope: string, filters: ListTasksOpts = {}) {
  prune(db);
  const clauses = ["scope = ?"];
  const params: Array<string | number | null> = [scope];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.assignee) {
    clauses.push("assignee = ?");
    params.push(filters.assignee);
  }
  if (filters.requester) {
    clauses.push("requester = ?");
    params.push(filters.requester);
  }
  const rows = db
    .query(`SELECT * FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, created_at ASC, id ASC`)
    .all(...params) as TaskRow[];
  return rows.map(toTask);
}

function bumpKvScope(db: Database, scope: string) {
  const changedAt = stamp();
  db.run(
    `INSERT INTO kv_scope_updates (scope, changed_at) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET changed_at =
       CASE
         WHEN excluded.changed_at > kv_scope_updates.changed_at THEN excluded.changed_at
         ELSE kv_scope_updates.changed_at + 1
       END`,
    [scope, changedAt]
  );
}

function taskSnapshot(db: Database, scope: string): SwarmTaskSnapshot {
  const snapshot: SwarmTaskSnapshot = {
    open: [],
    claimed: [],
    in_progress: [],
    done: [],
    failed: [],
    cancelled: [],
    blocked: [],
    approval_required: []
  };
  for (const task of listTasks(db, scope)) {
    snapshot[task.status].push(task);
  }
  return snapshot;
}

function maxUnreadMessageId(db: Database, instanceId: string, scope: string) {
  const row = db
    .query("SELECT MAX(id) as max_id FROM messages WHERE scope = ? AND recipient = ? AND read = 0")
    .get(scope, instanceId) as { max_id: number | null } | null;
  return row?.max_id ?? 0;
}

function maxTaskUpdate(db: Database, scope: string) {
  const row = db
    .query("SELECT MAX(changed_at) as max_changed_at FROM tasks WHERE scope = ?")
    .get(scope) as { max_changed_at: number | null } | null;
  return row?.max_changed_at ?? 0;
}

function instancesVersion(db: Database, scope: string) {
  const row = db
    .query(
      `SELECT COUNT(*) as count,
              COALESCE(MAX(registered_at), 0) as max_registered_at,
              COALESCE(MAX(heartbeat), 0) as max_heartbeat
       FROM instances
       WHERE scope = ?`
    )
    .get(scope) as ScopeVersionRow | null;
  return `${row?.count ?? 0}:${row?.max_registered_at ?? 0}:${row?.max_heartbeat ?? 0}`;
}

function kvVersion(db: Database, scope: string) {
  const row = db
    .query("SELECT changed_at FROM kv_scope_updates WHERE scope = ?")
    .get(scope) as { changed_at: number } | null;
  return row?.changed_at ?? 0;
}

function pollMessagesFromDb(db: Database, instanceId: string, scope: string, limit: number) {
  prune(db);
  const rows = db
    .query(
      `SELECT id, scope, sender, recipient, content, created_at, read
       FROM messages
       WHERE scope = ? AND recipient = ? AND read = 0
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(scope, instanceId, limit) as MessageRow[];

  if (rows.length) {
    db.run(`UPDATE messages SET read = 1 WHERE id IN (${marks(rows.length)})`, rows.map((row) => row.id));
  }

  return rows.map(toMessage);
}

function buildPlannerLabel(thread?: string | null, user?: string | null) {
  return [
    "origin:clanky",
    "role:planner",
    `thread:${normalizeLabelToken(thread, "dm")}`,
    `user:${normalizeLabelToken(user, "anon")}`
  ].join(" ");
}

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function ensureActivePeer(db: Database, instanceId: string, scope: string) {
  const current = getInstance(db, instanceId);
  if (!current || current.scope !== scope) {
    throw new Error(`Swarm peer ${instanceId} is not active in scope ${scope}.`);
  }
}

function assertAssignableTarget(db: Database, assignee: string, scope: string) {
  const target = getInstance(db, assignee);
  if (!target || target.scope !== scope) {
    throw new Error(`Instance ${assignee} is not active in scope ${scope}.`);
  }
}

export type ClankyPeerOptions = {
  dbPath: string;
  scope: string;
  repoRoot: string;
  fileRoot: string;
  thread?: string | null;
  user?: string | null;
  heartbeatIntervalMs?: number;
};

export class ClankyPeer {
  readonly instanceId: string;
  readonly scope: string;

  private readonly dbPath: string;
  private readonly directory: string;
  private readonly root: string;
  private readonly fileRoot: string;
  private readonly label: string;
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: ClankyPeerOptions) {
    this.dbPath = assertNonEmpty(options.dbPath, "dbPath");
    this.scope = normalizePath(assertNonEmpty(options.scope, "scope"));
    this.directory = normalizePath(assertNonEmpty(options.repoRoot, "repoRoot"));
    this.root = this.directory;
    this.fileRoot = normalizePath(assertNonEmpty(options.fileRoot, "fileRoot"));
    this.label = buildPlannerLabel(options.thread, options.user);
    this.heartbeatIntervalMs = Math.max(100, options.heartbeatIntervalMs ?? 10_000);
    this.instanceId = randomUUID();

    ensureSwarmDb(this.dbPath);
    this.register();
    this.startHeartbeat();
  }

  async sendMessage(recipient: string, content: string): Promise<void> {
    const normalizedRecipient = assertNonEmpty(String(recipient || ""), "recipient");
    const normalizedContent = assertNonEmpty(String(content || ""), "content");
    withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const target = getInstance(db, normalizedRecipient);
      if (!target || target.scope !== this.scope) {
        throw new Error(`Instance ${normalizedRecipient} is not active in this scope.`);
      }
      if (target.id === this.instanceId) {
        throw new Error("Cannot send a swarm message to self.");
      }
      db.run(
        "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
        [this.scope, this.instanceId, target.id, normalizedContent]
      );
      emit(db, this.scope, "message.sent", this.instanceId, target.id, { length: normalizedContent.length });
    });
  }

  async broadcast(content: string): Promise<number> {
    const normalizedContent = assertNonEmpty(String(content || ""), "content");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const peers = listActiveInstances(db, this.scope).filter((item) => item.id !== this.instanceId);
      for (const peer of peers) {
        db.run(
          "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
          [this.scope, this.instanceId, peer.id, normalizedContent]
        );
      }
      if (peers.length) {
        emit(db, this.scope, "message.broadcast", this.instanceId, null, {
          recipients: peers.length,
          length: normalizedContent.length
        });
      }
      return peers.length;
    });
  }

  async pollMessages(limit = 50): Promise<SwarmMessage[]> {
    const cappedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      return pollMessagesFromDb(db, this.instanceId, this.scope, cappedLimit);
    });
  }

  async requestTask(opts: RequestTaskOpts): Promise<SwarmTask> {
    const title = assertNonEmpty(String(opts.title || ""), "title");
    const type = assertNonEmpty(String(opts.type || ""), "type");
    const taskId = withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);

      if (opts.assignee) assertAssignableTarget(db, opts.assignee, this.scope);

      if (opts.idempotencyKey) {
        const existing = db
          .query("SELECT id FROM tasks WHERE scope = ? AND idempotency_key = ?")
          .get(this.scope, opts.idempotencyKey) as { id: string } | null;
        if (existing) return existing.id;
      }

      const relationError = validateTaskRelations(db, this.scope, opts);
      if (relationError) throw new Error(relationError);

      const id = randomUUID();
      const state = initialTaskState(db, this.scope, opts);
      const files = opts.files?.length ? JSON.stringify(opts.files.map((item) => this.resolvePeerFile(item))) : null;
      const dependsOn = opts.dependsOn?.length ? JSON.stringify(opts.dependsOn) : null;
      db.run(
        `INSERT INTO tasks
           (id, scope, type, title, description, requester, assignee, files, status, priority, depends_on, idempotency_key, parent_task_id, result, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          this.scope,
          type,
          title,
          opts.description ?? null,
          this.instanceId,
          opts.assignee ?? null,
          files,
          state.status,
          opts.priority ?? 0,
          dependsOn,
          opts.idempotencyKey ?? null,
          opts.parentTaskId ?? null,
          state.result,
          stamp()
        ]
      );
      emit(db, this.scope, "task.created", this.instanceId, id, {
        task_type: type,
        status: state.status,
        assignee: opts.assignee ?? null,
        parent_task_id: opts.parentTaskId ?? null
      });

      if (opts.assignee && opts.assignee !== this.instanceId) {
        const statusNote =
          state.status !== "claimed" ? ` (currently ${state.status} - will be claimable when ready)` : "";
        db.run(
          "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
          [
            this.scope,
            this.instanceId,
            opts.assignee,
            `[auto] New ${type} task assigned to you: "${title}" (task_id: ${id})${statusNote}. Claim it with claim_task if not auto-claimed.`
          ]
        );
      }

      return id;
    });

    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} was created but could not be read back.`);
    return task;
  }

  async listTasks(filters: ListTasksOpts = {}): Promise<SwarmTask[]> {
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      return listTasks(db, this.scope, filters);
    });
  }

  async claimTask(taskId: string): Promise<SwarmTask> {
    const normalizedTaskId = assertNonEmpty(String(taskId || ""), "taskId");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);

      const task = getTaskById(db, this.scope, normalizedTaskId);
      if (!task) throw new Error(`Task ${normalizedTaskId} not found.`);
      if (task.assignee === this.instanceId && (task.status === "claimed" || task.status === "in_progress")) {
        return task;
      }
      if (["done", "failed", "cancelled"].includes(task.status)) {
        throw new Error(`Task ${normalizedTaskId} is already ${task.status}.`);
      }
      if (task.assignee && task.assignee !== this.instanceId) {
        throw new Error(`Task ${normalizedTaskId} is assigned to ${task.assignee}.`);
      }
      if (task.status === "blocked" || task.status === "approval_required") {
        throw new Error(`Task ${normalizedTaskId} is ${task.status} and cannot be claimed yet.`);
      }

      db.run(
        "UPDATE tasks SET assignee = ?, status = 'claimed', updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
        [this.instanceId, stamp(), normalizedTaskId, this.scope]
      );
      emit(db, this.scope, "task.claimed", this.instanceId, normalizedTaskId, {});

      const updated = getTaskById(db, this.scope, normalizedTaskId);
      if (!updated) throw new Error(`Task ${normalizedTaskId} disappeared after claim.`);
      return updated;
    });
  }

  async assignTask(taskId: string, assignee: string): Promise<SwarmTask> {
    const normalizedTaskId = assertNonEmpty(String(taskId || ""), "taskId");
    const normalizedAssignee = assertNonEmpty(String(assignee || ""), "assignee");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      assertAssignableTarget(db, normalizedAssignee, this.scope);

      const task = getTaskById(db, this.scope, normalizedTaskId);
      if (!task) throw new Error(`Task ${normalizedTaskId} not found.`);
      if (["done", "failed", "cancelled"].includes(task.status)) {
        throw new Error(`Task ${normalizedTaskId} is already ${task.status}.`);
      }

      const nextStatus =
        task.status === "open" || task.status === "claimed"
          ? "claimed"
          : task.status;
      db.run(
        "UPDATE tasks SET assignee = ?, status = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
        [normalizedAssignee, nextStatus, stamp(), normalizedTaskId, this.scope]
      );
      emit(db, this.scope, "task.claimed", normalizedAssignee, normalizedTaskId, {
        assigned_by: this.instanceId
      });

      if (normalizedAssignee !== this.instanceId) {
        db.run(
          "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
          [
            this.scope,
            this.instanceId,
            normalizedAssignee,
            `[auto] Task "${task.title}" (${normalizedTaskId}) is assigned to you. Claim it with claim_task if not auto-claimed.`
          ]
        );
      }

      const updated = getTaskById(db, this.scope, normalizedTaskId);
      if (!updated) throw new Error(`Task ${normalizedTaskId} disappeared after assignment.`);
      return updated;
    });
  }

  async getTask(id: string): Promise<SwarmTask | null> {
    const normalizedId = assertNonEmpty(String(id || ""), "id");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      return getTaskById(db, this.scope, normalizedId);
    });
  }

  async updateTask(id: string, opts: UpdateTaskOpts): Promise<SwarmTask> {
    const normalizedId = assertNonEmpty(String(id || ""), "id");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);

      const task = getTaskById(db, this.scope, normalizedId);
      if (!task) throw new Error(`Task ${normalizedId} not found.`);
      if (["done", "failed", "cancelled"].includes(task.status)) {
        throw new Error(`Task ${normalizedId} is already ${task.status}.`);
      }

      if (opts.status === "cancelled") {
        if (task.requester !== this.instanceId && task.assignee !== this.instanceId) {
          throw new Error("Only the requester or assignee can cancel this task.");
        }
      } else {
        if (!task.assignee) throw new Error("Task must be assigned before it can be updated.");
        if (task.assignee !== this.instanceId) throw new Error("Only the assignee can update this task.");
      }

      if (opts.status === "in_progress" && task.status !== "claimed") {
        throw new Error("Task must be claimed before it can move to in_progress.");
      }

      db.run(
        "UPDATE tasks SET status = ?, result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
        [opts.status, opts.result ?? null, stamp(), normalizedId, this.scope]
      );
      if (opts.metadata && Object.keys(opts.metadata).length > 0) {
        db.run(
          "INSERT INTO context (id, scope, instance_id, file, type, content) VALUES (?, ?, ?, ?, ?, ?)",
          [randomUUID(), this.scope, this.instanceId, normalizedId, "usage", JSON.stringify(opts.metadata)]
        );
      }
      emit(db, this.scope, "task.updated", this.instanceId, normalizedId, {
        status: opts.status,
        prior_status: task.status
      });

      if (opts.status === "done") {
        processCompletion(db, this.scope, normalizedId);
      } else if (opts.status === "failed" || opts.status === "cancelled") {
        processFailure(db, this.scope, normalizedId);
      }

      if ((opts.status === "done" || opts.status === "failed") && task.requester !== this.instanceId) {
        db.run(
          "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
          [
            this.scope,
            this.instanceId,
            task.requester,
            `[auto] Task "${task.title}" (${normalizedId}) is now ${opts.status}.${opts.result ? ` Result: ${opts.result}` : ""}`
          ]
        );
      }

      const updated = getTaskById(db, this.scope, normalizedId);
      if (!updated) throw new Error(`Task ${normalizedId} disappeared after update.`);
      return updated;
    });
  }

  async waitForActivity(opts: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<SwarmActivity> {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const pollIntervalMs = Math.max(25, opts.pollIntervalMs ?? DEFAULT_ACTIVITY_POLL_INTERVAL_MS);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

    const baseline = withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const existingMessages = pollMessagesFromDb(db, this.instanceId, this.scope, 50);
      if (existingMessages.length) {
        return {
          immediate: {
            changes: ["new_messages"] as SwarmActivityChange[],
            messages: existingMessages,
            tasks: taskSnapshot(db, this.scope)
          }
        };
      }
      return {
        messageId: maxUnreadMessageId(db, this.instanceId, this.scope),
        taskUpdate: maxTaskUpdate(db, this.scope),
        instances: instancesVersion(db, this.scope),
        kv: kvVersion(db, this.scope)
      };
    });

    if ("immediate" in baseline) return baseline.immediate;

    while (deadline === 0 || Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const activity = withDb(this.dbPath, (db) => {
        ensureSwarmSchema(db);
        ensureActivePeer(db, this.instanceId, this.scope);
        const changes: SwarmActivityChange[] = [];
        const currentMessageId = maxUnreadMessageId(db, this.instanceId, this.scope);
        const currentTaskUpdate = maxTaskUpdate(db, this.scope);
        const currentInstances = instancesVersion(db, this.scope);
        const currentKv = kvVersion(db, this.scope);

        if (currentMessageId > baseline.messageId) changes.push("new_messages");
        if (currentTaskUpdate > baseline.taskUpdate) changes.push("task_updates");
        if (currentInstances !== baseline.instances) changes.push("instance_changes");
        if (currentKv > baseline.kv) changes.push("kv_updates");

        if (!changes.length) return null;

        const result: SwarmActivity = { changes };
        if (changes.includes("new_messages")) {
          result.messages = pollMessagesFromDb(db, this.instanceId, this.scope, 50);
        }
        if (changes.includes("task_updates")) {
          result.tasks = taskSnapshot(db, this.scope);
        }
        if (changes.includes("instance_changes")) {
          result.instances = listActiveInstances(db, this.scope);
        }
        return result;
      });

      if (activity) return activity;
    }

    return { changes: [], timeout: true };
  }

  async annotate(opts: AnnotateOpts): Promise<void> {
    const file = assertNonEmpty(String(opts.file || ""), "file");
    const kind = assertNonEmpty(String(opts.kind || ""), "kind");
    const content = assertNonEmpty(String(opts.content || ""), "content");
    withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const id = randomUUID();
      const resolvedFile = this.resolvePeerFile(file);
      db.run(
        "INSERT INTO context (id, scope, instance_id, file, type, content) VALUES (?, ?, ?, ?, ?, ?)",
        [id, this.scope, this.instanceId, resolvedFile, kind, content]
      );
      emit(db, this.scope, kind === "lock" ? "context.lock_acquired" : "context.annotated", this.instanceId, resolvedFile, {
        annotation_type: kind,
        id
      });
    });
  }

  async listInstances(labelContains?: string | null): Promise<SwarmInstance[]> {
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      return listActiveInstances(db, this.scope, String(labelContains || "").trim() || undefined);
    });
  }

  async whoami(): Promise<SwarmInstance> {
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const current = getInstance(db, this.instanceId);
      if (!current) throw new Error(`Swarm peer ${this.instanceId} is not active.`);
      return current;
    });
  }

  async lockFile(file: string, content = "locked by Clanky planner"): Promise<SwarmContextEntry> {
    const resolvedFile = this.resolvePeerFile(assertNonEmpty(String(file || ""), "file"));
    const normalizedContent = String(content || "").trim() || "locked by Clanky planner";
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const existing = db
        .query("SELECT id, scope, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? AND type = 'lock'")
        .get(this.scope, resolvedFile) as ContextRow | null;
      if (existing) {
        if (existing.instance_id === this.instanceId) return toContextEntry(existing);
        throw new Error(`File is already locked by ${existing.instance_id}: ${resolvedFile}`);
      }
      const id = randomUUID();
      db.run(
        "INSERT INTO context (id, scope, instance_id, file, type, content) VALUES (?, ?, ?, ?, 'lock', ?)",
        [id, this.scope, this.instanceId, resolvedFile, normalizedContent]
      );
      emit(db, this.scope, "context.lock_acquired", this.instanceId, resolvedFile, { id });
      const row = db
        .query("SELECT id, scope, instance_id, file, type, content, created_at FROM context WHERE id = ?")
        .get(id) as ContextRow | null;
      if (!row) throw new Error(`Lock ${id} was created but could not be read back.`);
      return toContextEntry(row);
    });
  }

  async unlockFile(file: string): Promise<boolean> {
    const resolvedFile = this.resolvePeerFile(assertNonEmpty(String(file || ""), "file"));
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const result = db.run(
        "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
        [this.scope, resolvedFile, this.instanceId]
      );
      if (Number(result.changes || 0) > 0) {
        emit(db, this.scope, "context.lock_released", this.instanceId, resolvedFile, {});
        return true;
      }
      return false;
    });
  }

  async checkFile(file: string): Promise<SwarmContextEntry[]> {
    const resolvedFile = this.resolvePeerFile(assertNonEmpty(String(file || ""), "file"));
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const rows = db
        .query(
          `SELECT id, scope, instance_id, file, type, content, created_at
           FROM context
           WHERE scope = ? AND file = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(this.scope, resolvedFile) as ContextRow[];
      return rows.map(toContextEntry);
    });
  }

  async searchContext(query: string): Promise<SwarmContextEntry[]> {
    const normalizedQuery = assertNonEmpty(String(query || ""), "query");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const rows = db
        .query(
          `SELECT id, scope, instance_id, file, type, content, created_at
           FROM context
           WHERE scope = ? AND (file LIKE ? OR content LIKE ?)
           ORDER BY created_at DESC, id DESC`
        )
        .all(this.scope, `%${normalizedQuery}%`, `%${normalizedQuery}%`) as ContextRow[];
      return rows.map(toContextEntry);
    });
  }

  async kvGet(key: string): Promise<SwarmKvEntry | null> {
    const normalizedKey = assertNonEmpty(String(key || ""), "key");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const row = db
        .query("SELECT scope, key, value, updated_at FROM kv WHERE scope = ? AND key = ?")
        .get(this.scope, normalizedKey) as KvRow | null;
      return row ? toKvEntry(row) : null;
    });
  }

  async kvSet(key: string, value: string): Promise<SwarmKvEntry> {
    const normalizedKey = assertNonEmpty(String(key || ""), "key");
    const normalizedValue = String(value ?? "");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      db.run(
        `INSERT INTO kv (scope, key, value, updated_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
        [this.scope, normalizedKey, normalizedValue]
      );
      bumpKvScope(db, this.scope);
      emit(db, this.scope, "kv.set", this.instanceId, normalizedKey, {});
      const row = db
        .query("SELECT scope, key, value, updated_at FROM kv WHERE scope = ? AND key = ?")
        .get(this.scope, normalizedKey) as KvRow | null;
      if (!row) throw new Error(`KV key ${normalizedKey} was written but could not be read back.`);
      return toKvEntry(row);
    });
  }

  async kvAppend(key: string, value: string): Promise<number> {
    const normalizedKey = assertNonEmpty(String(key || ""), "key");
    const normalizedValue = String(value ?? "");
    const parsedValue = JSON.parse(normalizedValue) as unknown;
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const existing = db
        .query("SELECT value FROM kv WHERE scope = ? AND key = ?")
        .get(this.scope, normalizedKey) as { value: string } | null;
      let next: unknown[] = [];
      if (existing) {
        try {
          const parsedExisting = JSON.parse(existing.value);
          next = Array.isArray(parsedExisting) ? parsedExisting : [parsedExisting];
        } catch {
          next = [existing.value];
        }
      }
      next.push(parsedValue);
      const merged = JSON.stringify(next);
      db.run(
        `INSERT INTO kv (scope, key, value, updated_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
        [this.scope, normalizedKey, merged]
      );
      bumpKvScope(db, this.scope);
      emit(db, this.scope, "kv.appended", this.instanceId, normalizedKey, { length: next.length });
      return next.length;
    });
  }

  async kvDelete(key: string): Promise<boolean> {
    const normalizedKey = assertNonEmpty(String(key || ""), "key");
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const result = db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [this.scope, normalizedKey]);
      if (Number(result.changes || 0) > 0) {
        bumpKvScope(db, this.scope);
        emit(db, this.scope, "kv.deleted", this.instanceId, normalizedKey, {});
        return true;
      }
      return false;
    });
  }

  async kvList(prefix?: string | null): Promise<SwarmKvEntry[]> {
    const normalizedPrefix = String(prefix || "").trim();
    return withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      ensureActivePeer(db, this.instanceId, this.scope);
      const rows = normalizedPrefix
        ? (db
            .query("SELECT scope, key, value, updated_at FROM kv WHERE scope = ? AND key LIKE ? ORDER BY key ASC")
            .all(this.scope, `${normalizedPrefix}%`) as KvRow[])
        : (db
            .query("SELECT scope, key, value, updated_at FROM kv WHERE scope = ? ORDER BY key ASC")
            .all(this.scope) as KvRow[]);
      return rows.map(toKvEntry);
    });
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      releaseInstances(db, [this.instanceId]);
      db.run("DELETE FROM instances WHERE id = ?", [this.instanceId]);
      emit(db, this.scope, "instance.deregistered", this.instanceId, this.instanceId, {
        label: this.label
      });
    });
  }

  private register() {
    withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      prune(db);
      db.run(
        `INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted, heartbeat)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, unixepoch())`,
        [this.instanceId, this.scope, this.directory, this.root, this.fileRoot, process.pid, this.label]
      );
      emit(db, this.scope, "instance.registered", this.instanceId, this.instanceId, {
        label: this.label,
        adopted: true,
        pid: process.pid
      });
    });
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        // The next explicit peer operation will surface DB failures with full context.
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private heartbeat() {
    if (this.closed) return;
    withDb(this.dbPath, (db) => {
      ensureSwarmSchema(db);
      db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [nowSeconds(), this.instanceId]);
      prune(db);
    });
  }

  private resolvePeerFile(file: string) {
    const input = String(file || "").trim();
    if (!input) return this.fileRoot;
    return normalizePath(path.isAbsolute(input) ? input : path.resolve(this.fileRoot, input));
  }
}

export function ensureClankySwarmPeerSchema(dbPath: string): void {
  ensureSwarmDb(dbPath);
}
