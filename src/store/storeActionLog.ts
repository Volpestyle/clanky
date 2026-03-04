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

export function countDiscoveryPostsSince(store: any, sinceIso) {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM actions
         WHERE kind = 'discovery_post' AND created_at >= ?`
    )
    .get(String(sinceIso));
  return Number(row?.count ?? 0);
}

export function getRecentActions(
  store: any,
  limit = 200,
  opts: { kinds?: string[]; sinceIso?: string | null } = {}
) {
  const parsedLimit = Number(limit);
  const boundedLimit = clamp(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 200, 1, 1000);
  const normalizedKinds = [...new Set(
    (Array.isArray(opts?.kinds) ? opts.kinds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  const normalizedSinceIso = String(opts?.sinceIso || "").trim();
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (normalizedKinds.length) {
    conditions.push(`kind IN (${normalizedKinds.map(() => "?").join(", ")})`);
    params.push(...normalizedKinds);
  }
  if (normalizedSinceIso) {
    conditions.push("created_at >= ?");
    params.push(normalizedSinceIso);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = store.db
    .prepare(
      `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`
    )
    .all(...params, boundedLimit);

  return rows.map((row) => ({
    ...row,
    metadata: safeJsonParse(row.metadata, null)
  }));
}

export function getRecentMemoryReflections(store: any, limit = 20) {
  const parsedLimit = Number(limit);
  const boundedLimit = clamp(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 20, 1, 100);
  const rows = store.db
    .prepare(
      `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         WHERE kind IN ('memory_reflection_start', 'memory_reflection_complete', 'memory_reflection_error')
         ORDER BY created_at DESC
         LIMIT ?`
    )
    .all(Math.max(60, boundedLimit * 6));

  const runs = new Map();
  for (const row of rows) {
    const metadata = safeJsonParse(row.metadata, null) || {};
    const dateKey = String(metadata?.dateKey || "").trim();
    const guildId = String(metadata?.guildId || row.guild_id || "").trim();
    const runId = String(metadata?.runId || "").trim() || `${dateKey}:${guildId}`;
    if (!dateKey || !guildId) continue;

    const existing = runs.get(runId) || {
      runId: runId.includes(":") ? null : runId,
      dateKey,
      guildId,
      channelId: row.channel_id ? String(row.channel_id) : null,
      status: "running",
      startedAt: null,
      completedAt: null,
      erroredAt: null,
      durationMs: null,
      strategy: null,
      provider: null,
      model: null,
      extractorProvider: null,
      extractorModel: null,
      adjudicatorProvider: null,
      adjudicatorModel: null,
      usdCost: 0,
      maxFacts: null,
      journalEntryCount: null,
      authorCount: null,
      factsExtracted: 0,
      factsSelected: 0,
      factsAdded: 0,
      factsSaved: 0,
      factsSkipped: 0,
      extractedFacts: [],
      selectedFacts: [],
      savedFacts: [],
      skippedFacts: [],
      rawResponseText: null,
      usage: null,
      reflectionPasses: [],
      startContent: null,
      completionContent: null,
      errorContent: null
    };

    existing.strategy = existing.strategy || (metadata?.strategy ? String(metadata.strategy) : null);
    existing.provider = existing.provider || (metadata?.provider ? String(metadata.provider) : null);
    existing.model = existing.model || (metadata?.model ? String(metadata.model) : null);
    existing.extractorProvider =
      existing.extractorProvider || (metadata?.extractorProvider ? String(metadata.extractorProvider) : null);
    existing.extractorModel =
      existing.extractorModel || (metadata?.extractorModel ? String(metadata.extractorModel) : null);
    existing.adjudicatorProvider =
      existing.adjudicatorProvider || (metadata?.adjudicatorProvider ? String(metadata.adjudicatorProvider) : null);
    existing.adjudicatorModel =
      existing.adjudicatorModel || (metadata?.adjudicatorModel ? String(metadata.adjudicatorModel) : null);
    existing.maxFacts =
      existing.maxFacts ?? (Number.isFinite(Number(metadata?.maxFacts)) ? Math.round(Number(metadata.maxFacts)) : null);
    existing.journalEntryCount =
      existing.journalEntryCount ??
      (Number.isFinite(Number(metadata?.journalEntryCount)) ? Math.round(Number(metadata.journalEntryCount)) : null);
    existing.authorCount =
      existing.authorCount ?? (Number.isFinite(Number(metadata?.authorCount)) ? Math.round(Number(metadata.authorCount)) : null);

    if (row.kind === "memory_reflection_start") {
      existing.startedAt = existing.startedAt || String(row.created_at || "");
      existing.startContent = existing.startContent || (row.content ? String(row.content) : null);
    } else if (row.kind === "memory_reflection_complete") {
      existing.status = "completed";
      existing.completedAt = existing.completedAt || String(row.created_at || "");
      existing.completionContent = existing.completionContent || (row.content ? String(row.content) : null);
      existing.usdCost = Number.isFinite(Number(row.usd_cost)) ? Number(row.usd_cost) : 0;
      existing.factsExtracted = Math.max(0, Number(metadata?.factsExtracted) || 0);
      existing.factsSelected = Math.max(0, Number(metadata?.factsSelected) || 0);
      existing.factsAdded = Math.max(0, Number(metadata?.factsAdded) || 0);
      existing.factsSaved = Math.max(0, Number(metadata?.factsSaved) || 0);
      existing.factsSkipped = Math.max(0, Number(metadata?.factsSkipped) || 0);
      existing.extractedFacts = Array.isArray(metadata?.extractedFacts) ? metadata.extractedFacts : [];
      existing.selectedFacts = Array.isArray(metadata?.selectedFacts) ? metadata.selectedFacts : [];
      existing.savedFacts = Array.isArray(metadata?.savedFacts) ? metadata.savedFacts : [];
      existing.skippedFacts = Array.isArray(metadata?.skippedFacts) ? metadata.skippedFacts : [];
      existing.rawResponseText =
        existing.rawResponseText || (metadata?.rawResponseText ? String(metadata.rawResponseText) : null);
      existing.usage = metadata?.usage && typeof metadata.usage === "object" ? metadata.usage : null;
      existing.reflectionPasses = Array.isArray(metadata?.reflectionPasses) ? metadata.reflectionPasses : [];
    } else if (row.kind === "memory_reflection_error") {
      if (existing.status !== "completed") {
        existing.status = "error";
      }
      existing.erroredAt = existing.erroredAt || String(row.created_at || "");
      existing.errorContent = existing.errorContent || (row.content ? String(row.content) : null);
    }

    runs.set(runId, existing);
  }

  const sorted = [...runs.values()]
    .map((run) => {
      const startedAtMs = Date.parse(String(run.startedAt || ""));
      const completedAtMs = Date.parse(String(run.completedAt || ""));
      const erroredAtMs = Date.parse(String(run.erroredAt || ""));
      const finishedAtMs = Number.isFinite(completedAtMs) ? completedAtMs : erroredAtMs;
      return {
        ...run,
        durationMs:
          Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
            ? Math.max(0, finishedAtMs - startedAtMs)
            : null
      };
    })
    .sort((a, b) => {
      const aTime = Date.parse(String(a.completedAt || a.erroredAt || a.startedAt || "")) || 0;
      const bTime = Date.parse(String(b.completedAt || b.erroredAt || b.startedAt || "")) || 0;
      return bTime - aTime;
    });

  return sorted.slice(0, boundedLimit);
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

export function hasReflectionBeenCompleted(store: any, dateKey: string, guildId: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1
         FROM actions
         WHERE kind = 'memory_reflection_complete'
           AND guild_id = ?
           AND json_extract(metadata, '$.dateKey') = ?
         LIMIT 1`
    )
    .get(String(guildId), String(dateKey));
  return Boolean(row);
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
