// Extracted Store Methods
import { clamp, nowIso } from "../utils.ts";
import { LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT, LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT } from "../store.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import {
  normalizeLookupResultText,
  normalizeLookupResultRows,
  buildLookupContextMatchText,
  scoreLookupContextRow,
  LOOKUP_CONTEXT_QUERY_MAX_CHARS,
  LOOKUP_CONTEXT_SOURCE_MAX_CHARS,
  LOOKUP_CONTEXT_PROVIDER_MAX_CHARS,
  LOOKUP_CONTEXT_MAX_TTL_HOURS,
  LOOKUP_CONTEXT_MAX_AGE_HOURS,
  LOOKUP_CONTEXT_MAX_SEARCH_LIMIT
} from "./storeHelpers.ts";

export function wasLinkSharedSince(store: any, url, sinceIso) {
const normalizedUrl = String(url || "").trim();
if (!normalizedUrl) return false;

const row = store.db
  .prepare(
    `SELECT 1
         FROM shared_links
         WHERE url = ? AND last_shared_at >= ?
         LIMIT 1`
  )
  .get(normalizedUrl, String(sinceIso));

return Boolean(row);
}

export function recordSharedLink(store: any, { url, source = null }) {
const normalizedUrl = String(url || "").trim();
if (!normalizedUrl) return;

const now = nowIso();
store.db
  .prepare(
    `INSERT INTO shared_links(url, first_shared_at, last_shared_at, share_count, source)
         VALUES(?, ?, ?, 1, ?)
         ON CONFLICT(url) DO UPDATE SET
           last_shared_at = excluded.last_shared_at,
           share_count = shared_links.share_count + 1,
           source = excluded.source`
  )
  .run(normalizedUrl, now, now, source ? String(source).slice(0, 120) : null);
}

export function pruneLookupContext(store: any, {
    now = nowIso(),
    guildId = null,
    channelId = null,
    maxRowsPerChannel = LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT
  } = {}) {
const normalizedNow = String(now || nowIso());
store.db
  .prepare(
    `DELETE FROM lookup_context
         WHERE expires_at <= ?`
  )
  .run(normalizedNow);

const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return;
const boundedMaxRowsPerChannel = clamp(
  Math.floor(Number(maxRowsPerChannel) || LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT),
  1,
  500
);
const normalizedChannelId = String(channelId || "").trim();
if (normalizedChannelId) {
  store.db
    .prepare(
      `DELETE FROM lookup_context
           WHERE id IN (
             SELECT id
             FROM lookup_context
             WHERE guild_id = ? AND channel_id = ?
             ORDER BY created_at DESC
             LIMIT -1 OFFSET ?
           )`
    )
    .run(normalizedGuildId, normalizedChannelId, boundedMaxRowsPerChannel);
  return;
}

store.db
  .prepare(
    `DELETE FROM lookup_context
         WHERE id IN (
           SELECT id
           FROM lookup_context
           WHERE guild_id = ? AND channel_id IS NULL
           ORDER BY created_at DESC
           LIMIT -1 OFFSET ?
         )`
  )
  .run(normalizedGuildId, boundedMaxRowsPerChannel);
}

export function recordLookupContext(store: any, {
    guildId,
    channelId = null,
    userId = null,
    source = null,
    query,
    provider = null,
    results = [],
    ttlHours = 48,
    maxResults = LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT,
    maxRowsPerChannel = LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT
  }) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedQuery = normalizeLookupResultText(query, LOOKUP_CONTEXT_QUERY_MAX_CHARS);
if (!normalizedGuildId || !normalizedQuery) return false;

const normalizedResults = normalizeLookupResultRows(results, maxResults);
if (!normalizedResults.length) return false;

const now = nowIso();
const boundedTtlHours = clamp(Math.floor(Number(ttlHours) || 48), 1, LOOKUP_CONTEXT_MAX_TTL_HOURS);
const expiresAt = new Date(Date.now() + boundedTtlHours * 60 * 60 * 1000).toISOString();
const normalizedChannelId = String(channelId || "").trim() || null;
const normalizedUserId = String(userId || "").trim() || null;
const normalizedSource = normalizeLookupResultText(source, LOOKUP_CONTEXT_SOURCE_MAX_CHARS) || null;
const normalizedProvider = normalizeLookupResultText(provider, LOOKUP_CONTEXT_PROVIDER_MAX_CHARS) || null;
const matchText = buildLookupContextMatchText({
  query: normalizedQuery,
  results: normalizedResults
});
const result = store.db
  .prepare(
    `INSERT INTO lookup_context(
          created_at,
          expires_at,
          guild_id,
          channel_id,
          user_id,
          source,
          query,
          provider,
          results_json,
          match_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .run(
    now,
    expiresAt,
    normalizedGuildId,
    normalizedChannelId,
    normalizedUserId,
    normalizedSource,
    normalizedQuery,
    normalizedProvider,
    JSON.stringify(normalizedResults),
    matchText
  );
store.pruneLookupContext({
  now,
  guildId: normalizedGuildId,
  channelId: normalizedChannelId,
  maxRowsPerChannel
});
return Number(result?.changes || 0) > 0;
}

export function searchLookupContext(store: any, {
    guildId,
    channelId = null,
    queryText = "",
    limit = 4,
    maxAgeHours = 72
  }) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const now = nowIso();
const boundedMaxAgeHours = clamp(
  Math.floor(Number(maxAgeHours) || 72),
  1,
  LOOKUP_CONTEXT_MAX_AGE_HOURS
);
const sinceIso = new Date(Date.now() - boundedMaxAgeHours * 60 * 60 * 1000).toISOString();
const boundedLimit = clamp(Math.floor(Number(limit) || 4), 1, LOOKUP_CONTEXT_MAX_SEARCH_LIMIT);
const candidateLimit = clamp(boundedLimit * 6, boundedLimit, 120);
const normalizedChannelId = String(channelId || "").trim();

const rows = normalizedChannelId
  ? store.db
      .prepare(
        `SELECT id, created_at, guild_id, channel_id, user_id, source, query, provider, results_json, match_text
             FROM lookup_context
             WHERE guild_id = ?
               AND (channel_id = ? OR channel_id IS NULL)
               AND created_at >= ?
               AND expires_at > ?
             ORDER BY created_at DESC
             LIMIT ?`
      )
      .all(normalizedGuildId, normalizedChannelId, sinceIso, now, candidateLimit)
  : store.db
      .prepare(
        `SELECT id, created_at, guild_id, channel_id, user_id, source, query, provider, results_json, match_text
             FROM lookup_context
             WHERE guild_id = ?
               AND created_at >= ?
               AND expires_at > ?
             ORDER BY created_at DESC
             LIMIT ?`
      )
      .all(normalizedGuildId, sinceIso, now, candidateLimit);

const normalizedQuery = String(queryText || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();
const queryTokens = [...new Set(normalizedQuery.match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
const parsedRows = rows.map((row) => {
  const parsedResults = safeJsonParse(row?.results_json, []);
  const normalizedResults = normalizeLookupResultRows(parsedResults, LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT);
  const createdAt = String(row?.created_at || "").trim();
  const createdAtMs = Date.parse(createdAt);
  const ageMinutes = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.round((Date.now() - createdAtMs) / 60000))
    : null;
  return {
    id: Number(row?.id || 0),
    createdAt,
    guildId: String(row?.guild_id || "").trim(),
    channelId: String(row?.channel_id || "").trim() || null,
    userId: String(row?.user_id || "").trim() || null,
    source: String(row?.source || "").trim() || null,
    query: normalizeLookupResultText(row?.query, LOOKUP_CONTEXT_QUERY_MAX_CHARS),
    provider: normalizeLookupResultText(row?.provider, LOOKUP_CONTEXT_PROVIDER_MAX_CHARS) || null,
    results: normalizedResults,
    ageMinutes,
    matchText: String(row?.match_text || "")
      .replace(/\s+/g, " ")
      .trim()
  };
}).filter((row) => row.query && row.results.length);

if (!queryTokens.length) {
  return parsedRows.slice(0, boundedLimit);
}

const rankedRows = parsedRows
  .map((row, index) => ({
    ...row,
    _score: scoreLookupContextRow(
      {
        query: row.query,
        match_text: row.matchText
      },
      queryTokens
    ),
    _rank: index
  }))
  .filter((row) => row._score > 0)
  .sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return a._rank - b._rank;
  })
  .slice(0, boundedLimit)
  .map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    guildId: row.guildId,
    channelId: row.channelId,
    userId: row.userId,
    source: row.source,
    query: row.query,
    provider: row.provider,
    results: row.results,
    ageMinutes: row.ageMinutes
  }));
if (rankedRows.length) return rankedRows;

return parsedRows.slice(0, boundedLimit).map((row) => ({
  id: row.id,
  createdAt: row.createdAt,
  guildId: row.guildId,
  channelId: row.channelId,
  userId: row.userId,
  source: row.source,
  query: row.query,
  provider: row.provider,
  results: row.results,
  ageMinutes: row.ageMinutes
}));
}
