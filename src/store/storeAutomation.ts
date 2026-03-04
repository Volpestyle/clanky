// Extracted Store Methods
import { clamp, nowIso } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { normalizeAutomationTitle, normalizeAutomationInstruction, buildAutomationMatchText } from "../automation.ts";
import {
  mapAutomationRow,
  normalizeAutomationStatusFilter,
  normalizeAutomationStatus,
  normalizeAutomationRunStatus
} from "./storeHelpers.ts";

export function createAutomation(store: any, {
    guildId,
    channelId,
    createdByUserId,
    createdByName = "",
    title,
    instruction,
    schedule,
    nextRunAt = null
  }) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedChannelId = String(channelId || "").trim();
const normalizedCreatedBy = String(createdByUserId || "").trim();
const normalizedTitle = normalizeAutomationTitle(title, "scheduled task");
const normalizedInstruction = normalizeAutomationInstruction(instruction);

if (!normalizedGuildId || !normalizedChannelId || !normalizedCreatedBy || !normalizedInstruction) {
  return null;
}

const normalizedSchedule = safeJsonParse(JSON.stringify(schedule), null);
if (!normalizedSchedule || typeof normalizedSchedule !== "object") return null;

const now = nowIso();
const matchText = buildAutomationMatchText({
  title: normalizedTitle,
  instruction: normalizedInstruction
});
const result = store.db
  .prepare(
    `INSERT INTO automations(
          created_at,
          updated_at,
          guild_id,
          channel_id,
          created_by_user_id,
          created_by_name,
          title,
          instruction,
          schedule_json,
          next_run_at,
          status,
          is_running,
          running_started_at,
          last_run_at,
          last_error,
          last_result,
          match_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, NULL, NULL, ?)`
  )
  .run(
    now,
    now,
    normalizedGuildId,
    normalizedChannelId,
    normalizedCreatedBy,
    String(createdByName || "").trim().slice(0, 80) || null,
    normalizedTitle,
    normalizedInstruction,
    JSON.stringify(normalizedSchedule),
    nextRunAt ? String(nextRunAt) : null,
    matchText
  );

const id = Number(result?.lastInsertRowid || 0);
if (!id) return null;
return store.getAutomationById(id, normalizedGuildId);
}

export function getAutomationById(store: any, automationId, guildId = null) {
const id = Number(automationId);
if (!Number.isInteger(id) || id <= 0) return null;

if (guildId) {
  const row = store.db
    .prepare("SELECT * FROM automations WHERE id = ? AND guild_id = ? LIMIT 1")
    .get(id, String(guildId));
  return mapAutomationRow(row);
}

const row = store.db
  .prepare("SELECT * FROM automations WHERE id = ? LIMIT 1")
  .get(id);
return mapAutomationRow(row);
}

export function countAutomations(store: any, { guildId, statuses = ["active", "paused"] }) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return 0;

const normalizedStatuses = normalizeAutomationStatusFilter(statuses);
if (!normalizedStatuses.length) return 0;

const placeholders = normalizedStatuses.map(() => "?").join(", ");
const row = store.db
  .prepare(
    `SELECT COUNT(*) AS count
         FROM automations
         WHERE guild_id = ? AND status IN (${placeholders})`
  )
  .get(normalizedGuildId, ...normalizedStatuses);
return Number(row?.count || 0);
}

export function listAutomations(store: any, {
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    query = "",
    limit = 20
  }) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const normalizedStatuses = normalizeAutomationStatusFilter(statuses);
if (!normalizedStatuses.length) return [];

const where = ["guild_id = ?"];
const args = [normalizedGuildId];

if (channelId) {
  where.push("channel_id = ?");
  args.push(String(channelId));
}

where.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
args.push(...normalizedStatuses);

const normalizedQuery = String(query || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();
if (normalizedQuery) {
  where.push("match_text LIKE ?");
  args.push(`%${normalizedQuery}%`);
}

const rows = store.db
  .prepare(
    `SELECT *
         FROM automations
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
  )
  .all(...args, clamp(Math.floor(Number(limit) || 20), 1, 120));

return rows.map((row) => mapAutomationRow(row)).filter(Boolean);
}

export function getMostRecentAutomations(store: any, {
    guildId,
    channelId = null,
    statuses = ["active", "paused"],
    limit = 8
  }) {
return store.listAutomations({
  guildId,
  channelId,
  statuses,
  query: "",
  limit
});
}

export function findAutomationsByQuery(store: any, {
    guildId,
    channelId = null,
    query = "",
    statuses = ["active", "paused"],
    limit = 8
  }) {
return store.listAutomations({
  guildId,
  channelId,
  statuses,
  query,
  limit
});
}

export function setAutomationStatus(store: any, {
    automationId,
    guildId,
    status,
    nextRunAt = null,
    lastError = null,
    lastResult = null
  }) {
const id = Number(automationId);
const normalizedGuildId = String(guildId || "").trim();
const normalizedStatus = normalizeAutomationStatus(status);
if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId || !normalizedStatus) return null;

store.db
  .prepare(
    `UPDATE automations
         SET
           updated_at = ?,
           status = ?,
           next_run_at = ?,
           is_running = 0,
           running_started_at = NULL,
           last_error = ?,
           last_result = ?
         WHERE id = ? AND guild_id = ?`
  )
  .run(
    nowIso(),
    normalizedStatus,
    nextRunAt ? String(nextRunAt) : null,
    lastError ? String(lastError).slice(0, 500) : null,
    lastResult ? String(lastResult).slice(0, 500) : null,
    id,
    normalizedGuildId
  );

return store.getAutomationById(id, normalizedGuildId);
}

export function claimDueAutomations(store: any, { now = nowIso(), limit = 4 }: { now?: string; limit?: number } = {}) {
const normalizedNow = String(now || nowIso());
const boundedLimit = clamp(Math.floor(Number(limit) || 4), 1, 40);
const selectDueIds = store.db.prepare(
  `SELECT id
       FROM automations
       WHERE status = 'active'
         AND is_running = 0
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC
       LIMIT ?`
);
const claimOne = store.db.prepare(
  `UPDATE automations
       SET
         is_running = 1,
         running_started_at = ?,
         updated_at = ?
       WHERE id = ?
         AND status = 'active'
         AND is_running = 0
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?`
);
const fetchOne = store.db.prepare("SELECT * FROM automations WHERE id = ? LIMIT 1");
const claimTx = store.db.transaction((referenceNow, requestLimit) => {
  const dueIds = selectDueIds
    .all(referenceNow, requestLimit)
    .map((row) => Number(row?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!dueIds.length) return [];

  const claimedRows = [];
  for (const id of dueIds) {
    const claim = claimOne.run(referenceNow, referenceNow, id, referenceNow);
    if (Number(claim?.changes || 0) !== 1) continue;
    const row = fetchOne.get(id);
    if (row) claimedRows.push(row);
  }
  return claimedRows;
});

const rows = claimTx(normalizedNow, boundedLimit);
return rows.map((row) => mapAutomationRow(row)).filter(Boolean);
}

export function finalizeAutomationRun(store: any, {
    automationId,
    guildId,
    status = "active",
    nextRunAt = null,
    lastRunAt = null,
    lastError = null,
    lastResult = null
  }: {
    automationId?: number | string;
    guildId?: string;
    status?: string;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastError?: string | null;
    lastResult?: string | null;
  } = {}) {
const id = Number(automationId);
const normalizedGuildId = String(guildId || "").trim();
const normalizedStatus = normalizeAutomationStatus(status);
if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId || !normalizedStatus) return null;

store.db
  .prepare(
    `UPDATE automations
         SET
           updated_at = ?,
           status = ?,
           next_run_at = ?,
           is_running = 0,
           running_started_at = NULL,
           last_run_at = ?,
           last_error = ?,
           last_result = ?
         WHERE id = ? AND guild_id = ?`
  )
  .run(
    nowIso(),
    normalizedStatus,
    nextRunAt ? String(nextRunAt) : null,
    lastRunAt ? String(lastRunAt) : null,
    lastError ? String(lastError).slice(0, 500) : null,
    lastResult ? String(lastResult).slice(0, 500) : null,
    id,
    normalizedGuildId
  );

return store.getAutomationById(id, normalizedGuildId);
}

export function recordAutomationRun(store: any, {
    automationId,
    startedAt = null,
    finishedAt = null,
    status = "ok",
    summary = "",
    error = "",
    messageId = null,
    metadata = null
  }) {
const id = Number(automationId);
if (!Number.isInteger(id) || id <= 0) return null;

const createdAt = nowIso();
store.db
  .prepare(
    `INSERT INTO automation_runs(
          automation_id,
          created_at,
          started_at,
          finished_at,
          status,
          summary,
          error,
          message_id,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .run(
    id,
    createdAt,
    startedAt ? String(startedAt) : createdAt,
    finishedAt ? String(finishedAt) : null,
    normalizeAutomationRunStatus(status),
    summary ? String(summary).slice(0, 700) : null,
    error ? String(error).slice(0, 1000) : null,
    messageId ? String(messageId) : null,
    metadata ? JSON.stringify(metadata) : null
  );
}

export function getAutomationRuns(store: any, {
    automationId,
    guildId,
    limit = 20
  }: {
    automationId?: number | string;
    guildId?: string;
    limit?: number;
  } = {}) {
const id = Number(automationId);
const normalizedGuildId = String(guildId || "").trim();
if (!Number.isInteger(id) || id <= 0 || !normalizedGuildId) return [];

const rows = store.db
  .prepare(
    `SELECT runs.*
         FROM automation_runs AS runs
         JOIN automations AS jobs
           ON jobs.id = runs.automation_id
         WHERE runs.automation_id = ?
           AND jobs.guild_id = ?
         ORDER BY runs.created_at DESC
         LIMIT ?`
  )
  .all(id, normalizedGuildId, clamp(Math.floor(Number(limit) || 20), 1, 120));

return rows.map((row) => ({
  ...row,
  metadata: safeJsonParse(row.metadata, null)
}));
}
