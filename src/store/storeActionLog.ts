// Extracted Store Methods
import { clamp, nowIso } from "../utils.ts";
import { ACTION_LOG_RETENTION_DAYS_MIN, ACTION_LOG_RETENTION_DAYS_MAX, ACTION_LOG_MAX_ROWS_RUNTIME_MIN, ACTION_LOG_MAX_ROWS_MAX } from "../store.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { shouldTrackResponseTriggerKind, normalizeResponseTriggerMessageIds } from "./responseTriggers.ts";

export function maybePruneActionLog(store: any, { now = nowIso() } = {}) {
  store.actionWritesSincePrune += 1;
  if (store.actionWritesSincePrune < store.actionLogPruneEveryWrites) return;
  store.actionWritesSincePrune = 0;
  store.pruneActionLog({
    now
  });
}

export function pruneActionLog(store: any, {
  now = nowIso(),
  maxAgeDays = store.actionLogRetentionDays,
  maxRows = store.actionLogMaxRows
} = {}) {
  const nowText = String(now || nowIso());
  const nowMs = Date.parse(nowText);
  const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const boundedMaxAgeDays = clamp(
    Math.floor(Number(maxAgeDays) || store.actionLogRetentionDays),
    ACTION_LOG_RETENTION_DAYS_MIN,
    ACTION_LOG_RETENTION_DAYS_MAX
  );
  const boundedMaxRows = clamp(
    Math.floor(Number(maxRows) || store.actionLogMaxRows),
    ACTION_LOG_MAX_ROWS_RUNTIME_MIN,
    ACTION_LOG_MAX_ROWS_MAX
  );
  const cutoffIso = new Date(referenceMs - boundedMaxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  let deletedActions = Number(
    store.db
      .prepare(
        `DELETE FROM actions
           WHERE created_at < ?`
      )
      .run(cutoffIso)?.changes || 0
  );

  const oldestKeptRow = store.db
    .prepare(
      `SELECT id
         FROM actions
         ORDER BY id DESC
         LIMIT 1 OFFSET ?`
    )
    .get(Math.max(0, boundedMaxRows - 1));
  const oldestKeptId = Number(oldestKeptRow?.id || 0);
  if (Number.isInteger(oldestKeptId) && oldestKeptId > 0) {
    deletedActions += Number(
      store.db
        .prepare(
          `DELETE FROM actions
             WHERE id < ?`
        )
        .run(oldestKeptId)?.changes || 0
    );
  }

  const deletedResponseTriggers = Number(
    store.db
      .prepare(
        `DELETE FROM response_triggers
           WHERE created_at < ?
              OR NOT EXISTS (
                SELECT 1
                FROM actions
                WHERE actions.id = response_triggers.action_id
              )`
      )
      .run(cutoffIso)?.changes || 0
  );

  return {
    deletedActions,
    deletedResponseTriggers
  };
}

export function logAction(store: any, action) {
  const metadata = action.metadata ? JSON.stringify(action.metadata) : null;
  const createdAt = nowIso();
  const actionKind = String(action.kind);

  const result = store.db
    .prepare(
      `INSERT INTO actions(
          created_at,
          guild_id,
          channel_id,
          message_id,
          user_id,
          kind,
          content,
          metadata,
          usd_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      createdAt,
      action.guildId ? String(action.guildId) : null,
      action.channelId ? String(action.channelId) : null,
      action.messageId ? String(action.messageId) : null,
      action.userId ? String(action.userId) : null,
      actionKind,
      action.content ? String(action.content).slice(0, 2000) : null,
      metadata,
      Number(action.usdCost) || 0
    );

  store.indexResponseTriggersForAction({
    actionId: Number(result?.lastInsertRowid || 0),
    kind: actionKind,
    metadata: action.metadata,
    createdAt
  });
  try {
    store.maybePruneActionLog({ now: createdAt });
  } catch {
    // maintenance must never break action writes
  }

  if (store.onActionLogged) {
    const listener = store.onActionLogged;
    const loggedAction = { ...action, kind: actionKind, createdAt };
    queueMicrotask(() => {
      try {
        listener(loggedAction);
      } catch {
        // listener must never break store writes
      }
    });
  }
}

export function countActionsSince(store: any, kind, sinceIso) {
  const row = store.db
    .prepare("SELECT COUNT(*) AS count FROM actions WHERE kind = ? AND created_at >= ?")
    .get(String(kind), String(sinceIso));
  return Number(row?.count ?? 0);
}

export function getLastActionTime(store: any, kind) {
  const row = store.db
    .prepare(
      `SELECT created_at
         FROM actions
         WHERE kind = ?
         ORDER BY created_at DESC
         LIMIT 1`
    )
    .get(String(kind));

  return row?.created_at ?? null;
}

export function countInitiativePostsSince(store: any, sinceIso) {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM actions
         WHERE kind = 'initiative_post' AND created_at >= ?`
    )
    .get(String(sinceIso));
  return Number(row?.count ?? 0);
}

export function getRecentActions(store: any, limit = 200) {
  const parsedLimit = Number(limit);
  const boundedLimit = clamp(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 200, 1, 1000);
  const rows = store.db
    .prepare(
      `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         ORDER BY created_at DESC
         LIMIT ?`
    )
    .all(boundedLimit);

  return rows.map((row) => ({
    ...row,
    metadata: safeJsonParse(row.metadata, null)
  }));
}

export function indexResponseTriggersForAction(store: any, {
  actionId,
  kind,
  metadata,
  createdAt = nowIso()
}) {
  const normalizedActionId = Number(actionId);
  if (!Number.isInteger(normalizedActionId) || normalizedActionId <= 0) return;
  if (!shouldTrackResponseTriggerKind(kind)) return;

  const triggerMessageIds = normalizeResponseTriggerMessageIds(metadata);
  if (!triggerMessageIds.length) return;

  const insertTrigger = store.db.prepare(
    `INSERT OR IGNORE INTO response_triggers(trigger_message_id, action_id, created_at)
       VALUES (?, ?, ?)`
  );
  const insertTx = store.db.transaction((ids, responseActionId, responseCreatedAt) => {
    for (const triggerMessageId of ids) {
      insertTrigger.run(triggerMessageId, responseActionId, responseCreatedAt);
    }
  });
  insertTx(triggerMessageIds, normalizedActionId, String(createdAt || nowIso()));
}

export function hasTriggeredResponse(store: any, triggerMessageId) {
  const id = String(triggerMessageId).trim();
  if (!id) return false;

  const row = store.db
    .prepare(
      `SELECT 1
         FROM response_triggers
         WHERE trigger_message_id = ?
         LIMIT 1`
    )
    .get(id);

  return Boolean(row);
}
