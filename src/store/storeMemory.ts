// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { clamp, nowIso } from "../utils.ts";
import { load as loadSqliteVec } from "sqlite-vec";
import { normalizeEmbeddingVector, vectorToBlob, parseEmbeddingBlob } from "./storeHelpers.ts";

interface MemoryStore {
  db: Database;
  sqliteVecReady: boolean | null;
  sqliteVecError: string;
  ensureSqliteVecReady(): boolean;
}

export interface MemoryFactRow {
  id: number;
  created_at: string;
  updated_at: string;
  guild_id: string;
  channel_id: string | null;
  subject: string;
  fact: string;
  fact_type: string;
  evidence_text: string | null;
  source_message_id: string | null;
  confidence: number;
}

interface MemoryFactIdRow {
  id: number;
  fact_type?: string;
}

const CORE_FACT_TYPES = ["profile", "relationship"] as const;
const CORE_FACT_TYPE_SET = new Set<string>(CORE_FACT_TYPES);
const CORE_FACT_KEEP = 35;

interface MemoryFactVectorBlobRow {
  embedding_blob: Uint8Array;
}

interface MemoryFactVectorScoreRow {
  fact_id: number;
  score: number;
}

interface MemoryFactLexicalSearchRow extends MemoryFactRow {
  lexical_score: number;
}

interface MemoryFactSemanticSearchRow extends MemoryFactRow {
  semantic_score: number;
}

interface MemorySubjectRow {
  guild_id: string;
  subject: string;
  last_seen_at: string;
  fact_count: number;
}

function escapeSqlLikePattern(value: string) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function buildScopedFactWhereClause({
  guildId,
  subjectIds = null,
  factTypes = null,
  tableAlias = ""
}: {
  guildId: string;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  tableAlias?: string;
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return null;

  const prefix = tableAlias ? `${tableAlias}.` : "";
  const where = [`${prefix}guild_id = ?`, `${prefix}is_active = 1`];
  const args: string[] = [normalizedGuildId];

  if (Array.isArray(subjectIds) && subjectIds.length) {
    const normalizedSubjects: string[] = [
      ...new Set(subjectIds.map((value) => String(value || "").trim()).filter(Boolean))
    ];
    if (normalizedSubjects.length) {
      where.push(`${prefix}subject IN (${normalizedSubjects.map(() => "?").join(", ")})`);
      args.push(...normalizedSubjects);
    }
  }

  if (Array.isArray(factTypes) && factTypes.length) {
    const normalizedFactTypes: string[] = [
      ...new Set(factTypes.map((value) => String(value || "").trim()).filter(Boolean))
    ];
    if (normalizedFactTypes.length) {
      where.push(`${prefix}fact_type IN (${normalizedFactTypes.map(() => "?").join(", ")})`);
      args.push(...normalizedFactTypes);
    }
  }

  return {
    where,
    args
  };
}

export function addMemoryFact(store: MemoryStore, fact) {
const guildId = String(fact.guildId || "").trim();
if (!guildId) return false;

const rawConfidence = Number(fact.confidence);
const confidence = clamp(Number.isFinite(rawConfidence) ? rawConfidence : 0.5, 0, 1);
const now = nowIso();
const result = store.db
  .prepare(
    `INSERT INTO memory_facts(
          created_at,
          updated_at,
          guild_id,
          channel_id,
          subject,
          fact,
          fact_type,
          evidence_text,
          source_message_id,
          confidence,
          is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(guild_id, subject, fact) DO UPDATE SET
          updated_at = excluded.updated_at,
          channel_id = excluded.channel_id,
          fact_type = excluded.fact_type,
          evidence_text = excluded.evidence_text,
          source_message_id = excluded.source_message_id,
          confidence = MAX(memory_facts.confidence, excluded.confidence),
          is_active = 1`
  )
  .run(
    now,
    now,
    guildId,
    fact.channelId ? String(fact.channelId).slice(0, 120) : null,
    String(fact.subject),
    String(fact.fact).slice(0, 400),
    String(fact.factType || "other").slice(0, 40),
    fact.evidenceText ? String(fact.evidenceText).slice(0, 240) : null,
    fact.sourceMessageId ? String(fact.sourceMessageId) : null,
    confidence
  );

return result.changes > 0;
}

export function getFactsForSubjectScoped(store: MemoryStore, subject, limit = 12, scope = null) {
const where = ["subject = ?", "is_active = 1"];
const args: string[] = [String(subject)];
if (scope?.guildId) {
  where.push("guild_id = ?");
  args.push(String(scope.guildId));
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 100));
}

export function getFactsForSubjects(store: MemoryStore, subjects, limit = 80, scope = null) {
const normalizedSubjects: string[] = [
  ...new Set((Array.isArray(subjects) ? subjects : []).map((value) => String(value || "").trim()).filter(Boolean))
];
if (!normalizedSubjects.length) return [];

const placeholders = normalizedSubjects.map(() => "?").join(", ");
const where = [`subject IN (${placeholders})`, "is_active = 1"];
const args: string[] = [...normalizedSubjects];
if (scope?.guildId) {
  where.push("guild_id = ?");
  args.push(String(scope.guildId));
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 500));
}

export function getFactProfileRows(store: MemoryStore, {
  guildId,
  subjects = [],
  limit = 20
}: {
  guildId?: string | null;
  subjects?: string[];
  limit?: number;
}) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const normalizedSubjects: string[] = [
  ...new Set((Array.isArray(subjects) ? subjects : []).map((value) => String(value || "").trim()).filter(Boolean))
];
if (!normalizedSubjects.length) return [];

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE guild_id = ?
           AND is_active = 1
           AND subject IN (${normalizedSubjects.map(() => "?").join(", ")})
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`
  )
  .all(normalizedGuildId, ...normalizedSubjects, clamp(limit, 1, 200));
}

export function getFactsForScope(store: MemoryStore, {
  guildId,
  limit = 120,
  subjectIds = null,
  factTypes = null,
  queryText = ""
}) {
const scoped = buildScopedFactWhereClause({
  guildId,
  subjectIds,
  factTypes
});
if (!scoped) return [];

const { where, args } = scoped;

const normalizedQueryText = String(queryText || "").trim();
if (normalizedQueryText) {
  const likePattern = `%${escapeSqlLikePattern(normalizedQueryText)}%`;
  where.push(
    `(
      subject LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR fact LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR fact_type LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR COALESCE(evidence_text, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR COALESCE(source_message_id, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR COALESCE(channel_id, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
    )`
  );
  args.push(likePattern, likePattern, likePattern, likePattern, likePattern, likePattern);
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 1000));
}

export function searchMemoryFactsLexical(store: MemoryStore, {
  guildId,
  subjectIds = null,
  factTypes = null,
  queryText = "",
  queryTokens = [],
  limit = 60
}: {
  guildId: string;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  queryText?: string;
  queryTokens?: string[];
  limit?: number;
}) {
  const scoped = buildScopedFactWhereClause({
    guildId,
    subjectIds,
    factTypes
  });
  if (!scoped) return [];

  const normalizedQueryText = String(queryText || "").trim();
  const normalizedTokens = [
    ...new Set((Array.isArray(queryTokens) ? queryTokens : []).map((value) => String(value || "").trim()).filter(Boolean))
  ].slice(0, 8);
  if (!normalizedQueryText && !normalizedTokens.length) return [];

  const scoreParts: string[] = [];
  const scoreArgs: string[] = [];
  if (normalizedQueryText) {
    const likePattern = `%${escapeSqlLikePattern(normalizedQueryText)}%`;
    scoreParts.push("CASE WHEN fact LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 6 ELSE 0 END");
    scoreParts.push("CASE WHEN COALESCE(evidence_text, '') LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 4 ELSE 0 END");
    scoreArgs.push(likePattern, likePattern);
  }

  for (const token of normalizedTokens) {
    const likePattern = `%${escapeSqlLikePattern(token)}%`;
    scoreParts.push("CASE WHEN fact LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 3 ELSE 0 END");
    scoreParts.push("CASE WHEN COALESCE(evidence_text, '') LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 2 ELSE 0 END");
    scoreParts.push("CASE WHEN subject LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1 ELSE 0 END");
    scoreParts.push("CASE WHEN fact_type LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1 ELSE 0 END");
    scoreArgs.push(likePattern, likePattern, likePattern, likePattern);
  }

  const boundedLimit = clamp(Math.floor(Number(limit) || 60), 1, 240);
  const rows = store.db
    .prepare<MemoryFactLexicalSearchRow, Array<string | number>>(
      `SELECT
           id,
           created_at,
           updated_at,
           guild_id,
           channel_id,
           subject,
           fact,
           fact_type,
           evidence_text,
           source_message_id,
           confidence,
           lexical_score
         FROM (
           SELECT
             id,
             created_at,
             updated_at,
             guild_id,
             channel_id,
             subject,
             fact,
             fact_type,
             evidence_text,
             source_message_id,
             confidence,
             (${scoreParts.join(" + ")}) AS lexical_score
           FROM memory_facts
           WHERE ${scoped.where.join(" AND ")}
         ) AS ranked
         WHERE lexical_score > 0
         ORDER BY lexical_score DESC, updated_at DESC
         LIMIT ?`
    )
    .all(...scoreArgs, ...scoped.args, boundedLimit);

  return rows.map((row) => ({
    id: Number(row.id),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    guild_id: String(row.guild_id || ""),
    channel_id: String(row.channel_id || "").trim() || null,
    subject: String(row.subject || ""),
    fact: String(row.fact || ""),
    fact_type: String(row.fact_type || ""),
    evidence_text: String(row.evidence_text || "").trim() || null,
    source_message_id: String(row.source_message_id || "").trim() || null,
    confidence: Number(row.confidence || 0)
  }));
}

export function searchMemoryFactsByEmbedding(store: MemoryStore, {
  guildId,
  subjectIds = null,
  factTypes = null,
  model,
  queryEmbedding,
  limit = 60
}: {
  guildId: string;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  model: string;
  queryEmbedding: number[];
  limit?: number;
}) {
  if (!store.ensureSqliteVecReady()) return [];

  const scoped = buildScopedFactWhereClause({
    guildId,
    subjectIds,
    factTypes,
    tableAlias: "m"
  });
  if (!scoped) return [];

  const normalizedModel = String(model || "").trim();
  const normalizedQueryEmbedding = normalizeEmbeddingVector(queryEmbedding);
  if (!normalizedModel || !normalizedQueryEmbedding.length) return [];

  try {
    return store.db
      .prepare<MemoryFactSemanticSearchRow, Array<string | number | Buffer>>(
        `SELECT
             m.id,
             m.created_at,
             m.updated_at,
             m.guild_id,
             m.channel_id,
             m.subject,
             m.fact,
             m.fact_type,
             m.evidence_text,
             m.source_message_id,
             m.confidence,
             (1 - vec_distance_cosine(v.embedding_blob, ?)) AS semantic_score
           FROM memory_facts AS m
           JOIN memory_fact_vectors_native AS v
             ON v.fact_id = m.id
          WHERE ${scoped.where.join(" AND ")}
            AND v.model = ?
            AND v.dims = ?
          ORDER BY semantic_score DESC, m.updated_at DESC
          LIMIT ?`
      )
      .all(
        vectorToBlob(normalizedQueryEmbedding),
        ...scoped.args,
        normalizedModel,
        normalizedQueryEmbedding.length,
        clamp(Math.floor(Number(limit) || 60), 1, 240)
      )
      .filter((row) => Number.isFinite(Number(row?.semantic_score)) && Number(row.semantic_score) > 0)
      .map((row) => ({
        id: Number(row.id),
        created_at: String(row.created_at || ""),
        updated_at: String(row.updated_at || ""),
        guild_id: String(row.guild_id || ""),
        channel_id: String(row.channel_id || "").trim() || null,
        subject: String(row.subject || ""),
        fact: String(row.fact || ""),
        fact_type: String(row.fact_type || ""),
        evidence_text: String(row.evidence_text || "").trim() || null,
        source_message_id: String(row.source_message_id || "").trim() || null,
        confidence: Number(row.confidence || 0)
      }));
  } catch (error) {
    store.sqliteVecReady = false;
    store.sqliteVecError = String(error?.message || error);
    return [];
  }
}

export function getFactsForSubjectsScoped(store: MemoryStore, {
    guildId = null,
    subjectIds = [],
    perSubjectLimit = 6,
    totalLimit = 600
  } = {}) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const normalizedSubjects: string[] = [
  ...new Set((subjectIds || []).map((value) => String(value || "").trim()).filter(Boolean))
];
if (!normalizedSubjects.length) return [];

const boundedPerSubjectLimit = clamp(Math.floor(Number(perSubjectLimit) || 6), 1, 24);
const boundedTotalLimit = clamp(
  Math.floor(Number(totalLimit) || normalizedSubjects.length * boundedPerSubjectLimit * 2),
  boundedPerSubjectLimit,
  1200
);
const subjectPlaceholders = normalizedSubjects.map(() => "?").join(", ");

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT
           id,
           created_at,
           updated_at,
           guild_id,
           channel_id,
           subject,
           fact,
           fact_type,
           evidence_text,
           source_message_id,
           confidence
         FROM (
           SELECT
             id,
             created_at,
             updated_at,
             guild_id,
             channel_id,
             subject,
             fact,
             fact_type,
             evidence_text,
             source_message_id,
             confidence,
             ROW_NUMBER() OVER (PARTITION BY subject ORDER BY updated_at DESC) AS row_num
           FROM memory_facts
           WHERE guild_id = ?
             AND is_active = 1
             AND subject IN (${subjectPlaceholders})
         ) AS ranked
         WHERE row_num <= ?
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(
    normalizedGuildId,
    ...normalizedSubjects,
    boundedPerSubjectLimit,
    boundedTotalLimit
  );
}

export function getMemoryFactBySubjectAndFact(store: MemoryStore, guildId, subject, fact) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return null;

return (
  store.db
    .prepare<MemoryFactRow, [string, string, string]>(
      `SELECT id, created_at, updated_at, guild_id, channel_id, subject, fact, fact_type, evidence_text, source_message_id, confidence
           FROM memory_facts
           WHERE guild_id = ? AND subject = ? AND fact = ? AND is_active = 1
           LIMIT 1`
    )
    .get(normalizedGuildId, String(subject), String(fact)) || null
);
}

export function ensureSqliteVecReady(store: MemoryStore) {
if (store.sqliteVecReady !== null) {
  return store.sqliteVecReady;
}

try {
  loadSqliteVec(store.db);
  store.sqliteVecReady = true;
  store.sqliteVecError = "";
} catch (error) {
  store.sqliteVecReady = false;
  store.sqliteVecError = String(error?.message || error);
}

return store.sqliteVecReady;
}

export function upsertMemoryFactVectorNative(store: MemoryStore, { factId, model, embedding, updatedAt = nowIso() }) {
const factIdInt = Number(factId);
const normalizedModel = String(model || "").slice(0, 120);
const vector = normalizeEmbeddingVector(embedding);
if (!Number.isInteger(factIdInt) || factIdInt <= 0) return false;
if (!normalizedModel || !vector.length) return false;

const result = store.db
  .prepare(
    `INSERT INTO memory_fact_vectors_native(fact_id, model, dims, embedding_blob, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id, model) DO UPDATE SET
           dims = excluded.dims,
           embedding_blob = excluded.embedding_blob,
           updated_at = excluded.updated_at`
  )
  .run(
    factIdInt,
    normalizedModel,
    vector.length,
    vectorToBlob(vector),
    String(updatedAt || nowIso())
  );

return Number(result?.changes || 0) > 0;
}

export function getMemoryFactVectorNative(store: MemoryStore, factId, model) {
const factIdInt = Number(factId);
const normalizedModel = String(model || "").trim();
if (!Number.isInteger(factIdInt) || factIdInt <= 0) return null;
if (!normalizedModel) return null;

const row = store.db
  .prepare<MemoryFactVectorBlobRow, [number, string]>(
    `SELECT embedding_blob
         FROM memory_fact_vectors_native
         WHERE fact_id = ? AND model = ?
         LIMIT 1`
  )
  .get(factIdInt, normalizedModel);
const vector = parseEmbeddingBlob(row?.embedding_blob);
return vector.length ? vector : null;
}

export function getMemoryFactVectorNativeScores(store: MemoryStore, { factIds, model, queryEmbedding }) {
if (!store.ensureSqliteVecReady()) return [];

const ids: number[] = [
  ...new Set((Array.isArray(factIds) ? factIds : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
];
const normalizedModel = String(model || "").trim();
const normalizedQueryEmbedding = normalizeEmbeddingVector(queryEmbedding);
if (!ids.length || !normalizedModel || !normalizedQueryEmbedding.length) return [];

const placeholders = ids.map(() => "?").join(", ");
try {
  return store.db
    .prepare<MemoryFactVectorScoreRow, Array<string | number | Buffer>>(
      `SELECT fact_id, (1 - vec_distance_cosine(embedding_blob, ?)) AS score
           FROM memory_fact_vectors_native
           WHERE model = ? AND dims = ? AND fact_id IN (${placeholders})`
    )
    .all(
      vectorToBlob(normalizedQueryEmbedding),
      normalizedModel,
      normalizedQueryEmbedding.length,
      ...ids
    )
    .map((row) => ({
      fact_id: Number(row.fact_id),
      score: Number(row.score)
    }))
    .filter((row) => Number.isInteger(row.fact_id) && row.fact_id > 0 && Number.isFinite(row.score));
} catch (error) {
  store.sqliteVecReady = false;
  store.sqliteVecError = String(error?.message || error);
  return [];
}
}

export function getMemorySubjects(store: MemoryStore, limit = 80, scope = null) {
const where = ["is_active = 1"];
const args: string[] = [];
if (scope?.guildId) {
  where.push("guild_id = ?");
  args.push(String(scope.guildId));
}

return store.db
  .prepare<MemorySubjectRow, Array<string | number>>(
    `SELECT guild_id, subject, MAX(updated_at) AS last_seen_at, COUNT(*) AS fact_count
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         GROUP BY guild_id, subject
         ORDER BY last_seen_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 500));
}

export function archiveOldFactsForSubject(store: MemoryStore, { guildId, subject, factType = null, keep = 120 }) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedSubject = String(subject || "").trim();
if (!normalizedGuildId || !normalizedSubject) return 0;

const boundedKeep = clamp(Math.floor(Number(keep) || 120), 1, 400);
const where = ["guild_id = ?", "subject = ?", "is_active = 1"];
const args: string[] = [normalizedGuildId, normalizedSubject];
if (factType) {
  where.push("fact_type = ?");
  args.push(String(factType));
}

const rows = store.db
  .prepare<MemoryFactIdRow, string[]>(
    `SELECT id, fact_type
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT 1000`
  )
  .all(...args);
if (rows.length <= boundedKeep) return 0;

let staleIds: number[] = [];
if (factType) {
  staleIds = rows.slice(boundedKeep).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
} else {
  const contextualRows = rows.filter((row) => !CORE_FACT_TYPE_SET.has(String(row.fact_type || "").trim()));
  const coreRows = rows.filter((row) => CORE_FACT_TYPE_SET.has(String(row.fact_type || "").trim()));
  const overflowCount = Math.max(0, rows.length - boundedKeep);
  const contextualKeep = Math.max(0, contextualRows.length - overflowCount);
  const contextualStaleIds = contextualRows
    .slice(contextualKeep)
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const remainingOverflow = Math.max(0, overflowCount - contextualStaleIds.length);
  const coreKeep = Math.min(CORE_FACT_KEEP, coreRows.length);
  const coreOverflow = Math.max(0, coreRows.length - coreKeep);
  const coreToArchive = Math.min(coreOverflow, remainingOverflow);
  const coreStaleIds = coreRows
    .slice(coreRows.length - coreToArchive)
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  staleIds = [...contextualStaleIds, ...coreStaleIds];
}
if (!staleIds.length) return 0;

const placeholders = staleIds.map(() => "?").join(", ");
const result = store.db
  .prepare(`UPDATE memory_facts SET is_active = 0, updated_at = ? WHERE id IN (${placeholders})`)
  .run(nowIso(), ...staleIds);
return Number(result?.changes || 0);
}
