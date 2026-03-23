import { clamp, nowIso } from "../utils.ts";

interface SessionSummaryStore {
  db: {
    prepare: (sql: string) => {
      run: (...args: Array<string | number | null>) => { changes?: number };
      all: (...args: Array<string | number | null>) => unknown[];
    };
  };
}

export interface SessionSummaryRow {
  session_id: string;
  created_at: string;
  updated_at: string;
  guild_id: string;
  channel_id: string;
  modality: string;
  started_at: string | null;
  ended_at: string;
  summary_text: string;
}

const DEFAULT_SESSION_SUMMARY_RETENTION_HOURS = 24;

function normalizeSessionId(value: unknown) {
  return String(value || "").trim().slice(0, 120);
}

function normalizeScopeId(value: unknown) {
  return String(value || "").trim().slice(0, 120);
}

function normalizeSummaryText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_400);
}

function normalizeIso(value: unknown) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function resolveRetentionCutoffIso(retentionHours = DEFAULT_SESSION_SUMMARY_RETENTION_HOURS) {
  const boundedHours = clamp(Math.floor(Number(retentionHours) || DEFAULT_SESSION_SUMMARY_RETENTION_HOURS), 1, 24 * 30);
  return new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();
}

export function pruneExpiredSessionSummaries(
  store: SessionSummaryStore,
  {
    retentionHours = DEFAULT_SESSION_SUMMARY_RETENTION_HOURS
  }: {
    retentionHours?: number;
  } = {}
) {
  const result = store.db
    .prepare("DELETE FROM session_summaries WHERE ended_at < ?")
    .run(resolveRetentionCutoffIso(retentionHours));
  return Number(result?.changes || 0);
}

export function upsertSessionSummary(
  store: SessionSummaryStore,
  {
    sessionId,
    guildId,
    channelId,
    summaryText,
    startedAt = null,
    endedAt = null,
    modality = "voice"
  }: {
    sessionId: string;
    guildId: string;
    channelId: string;
    summaryText: string;
    startedAt?: string | null;
    endedAt?: string | null;
    modality?: string;
  }
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedGuildId = normalizeScopeId(guildId);
  const normalizedChannelId = normalizeScopeId(channelId);
  const normalizedSummaryText = normalizeSummaryText(summaryText);
  if (!normalizedSessionId || !normalizedGuildId || !normalizedChannelId || !normalizedSummaryText) {
    return false;
  }

  const now = nowIso();
  const normalizedStartedAt = normalizeIso(startedAt);
  const normalizedEndedAt = normalizeIso(endedAt) || now;
  const normalizedModality = String(modality || "").trim().toLowerCase().slice(0, 40) || "voice";

  pruneExpiredSessionSummaries(store);

  const result = store.db
    .prepare(
      `INSERT INTO session_summaries(
         session_id,
         created_at,
         updated_at,
         guild_id,
         channel_id,
         modality,
         started_at,
         ended_at,
         summary_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         guild_id = excluded.guild_id,
         channel_id = excluded.channel_id,
         modality = excluded.modality,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         summary_text = excluded.summary_text`
    )
    .run(
      normalizedSessionId,
      now,
      now,
      normalizedGuildId,
      normalizedChannelId,
      normalizedModality,
      normalizedStartedAt,
      normalizedEndedAt,
      normalizedSummaryText
    );

  return Number(result?.changes || 0) > 0;
}

export function getRecentSessionSummaries(
  store: SessionSummaryStore,
  {
    guildId,
    channelId = null,
    modality = "voice",
    sinceIso = null,
    beforeIso = null,
    limit = 3
  }: {
    guildId: string;
    channelId?: string | null;
    modality?: string;
    sinceIso?: string | null;
    beforeIso?: string | null;
    limit?: number;
  }
) {
  const normalizedGuildId = normalizeScopeId(guildId);
  const normalizedChannelId = normalizeScopeId(channelId);
  if (!normalizedGuildId) return [];

  pruneExpiredSessionSummaries(store);

  const normalizedModality = String(modality || "").trim().toLowerCase().slice(0, 40) || "voice";
  const where = ["guild_id = ?", "modality = ?"];
  const args: Array<string | number | null> = [normalizedGuildId, normalizedModality];
  if (normalizedChannelId) {
    where.push("channel_id = ?");
    args.push(normalizedChannelId);
  }
  const normalizedSinceIso = normalizeIso(sinceIso);
  if (normalizedSinceIso) {
    where.push("ended_at >= ?");
    args.push(normalizedSinceIso);
  }
  const normalizedBeforeIso = normalizeIso(beforeIso);
  if (normalizedBeforeIso) {
    where.push("ended_at <= ?");
    args.push(normalizedBeforeIso);
  }

  return store.db
    .prepare(
      `SELECT
         session_id,
         created_at,
         updated_at,
         guild_id,
         channel_id,
         modality,
         started_at,
         ended_at,
         summary_text
       FROM session_summaries
       WHERE ${where.join(" AND ")}
       ORDER BY ended_at DESC
       LIMIT ?`
    )
    .all(...args, clamp(Math.floor(Number(limit) || 3), 1, 20)) as SessionSummaryRow[];
}

export function deleteSessionSummariesForGuild(store: SessionSummaryStore, guildId: string) {
  const normalizedGuildId = normalizeScopeId(guildId);
  if (!normalizedGuildId) return { deleted: 0 };
  const result = store.db
    .prepare("DELETE FROM session_summaries WHERE guild_id = ?")
    .run(normalizedGuildId);
  return {
    deleted: Number(result?.changes || 0)
  };
}
