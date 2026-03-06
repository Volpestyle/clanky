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

interface MemoryFactRow {
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
}

interface MemoryFactVectorBlobRow {
  embedding_blob: Uint8Array;
}

interface MemoryFactVectorScoreRow {
  fact_id: number;
  score: number;
}

interface MemorySubjectRow {
  guild_id: string;
  subject: string;
  last_seen_at: string;
  fact_count: number;
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
    String(fact.factType || "general").slice(0, 40),
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

export function getFactsForScope(store: MemoryStore, { guildId, limit = 120, subjectIds = null }) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const where = ["guild_id = ?", "is_active = 1"];
const args: string[] = [normalizedGuildId];

if (Array.isArray(subjectIds) && subjectIds.length) {
  const normalizedSubjects: string[] = [...new Set(subjectIds.map((value) => String(value || "").trim()).filter(Boolean))];
  if (normalizedSubjects.length) {
    where.push(`subject IN (${normalizedSubjects.map(() => "?").join(", ")})`);
    args.push(...normalizedSubjects);
  }
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

export function archiveOldFactsForSubject(store: MemoryStore, { guildId, subject, factType = null, keep = 60 }) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedSubject = String(subject || "").trim();
if (!normalizedGuildId || !normalizedSubject) return 0;

const boundedKeep = clamp(Math.floor(Number(keep) || 60), 1, 400);
const where = ["guild_id = ?", "subject = ?", "is_active = 1"];
const args: string[] = [normalizedGuildId, normalizedSubject];
if (factType) {
  where.push("fact_type = ?");
  args.push(String(factType));
}

const rows = store.db
  .prepare<MemoryFactIdRow, string[]>(
    `SELECT id
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT 1000`
  )
  .all(...args);
if (rows.length <= boundedKeep) return 0;

const staleIds = rows.slice(boundedKeep).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
if (!staleIds.length) return 0;

const placeholders = staleIds.map(() => "?").join(", ");
const result = store.db
  .prepare(`UPDATE memory_facts SET is_active = 0, updated_at = ? WHERE id IN (${placeholders})`)
  .run(nowIso(), ...staleIds);
return Number(result?.changes || 0);
}
