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
  scope: MemoryFactScope;
  guild_id: string | null;
  channel_id: string | null;
  user_id: string | null;
  subject: string;
  fact: string;
  fact_type: string;
  evidence_text: string | null;
  source_message_id: string | null;
  confidence: number;
  lexical_score?: number | null;
  semantic_score?: number | null;
}

export type MemoryFactScope = "user" | "guild" | "owner";

const LEGACY_FACT_TYPE_MAP: Record<string, string> = {
  lore: "other",
  self: "other",
  general: "other"
};

const LEGACY_FACT_PREFIX_RE = /^(?:memory line|self memory|identity memory|important tidbit|lore|general|server norm)\s*:\s*/i;

interface MemoryFactIdRow {
  id: number;
  fact_type?: string;
  confidence?: number;
  updated_at?: string;
}

interface DuplicateMemoryFactRow {
  id: number;
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

interface CountRow {
  count: number;
}

interface MemoryFactLexicalSearchRow extends MemoryFactRow {
  lexical_score: number;
}

interface MemoryFactSemanticSearchRow extends MemoryFactRow {
  semantic_score: number;
}

interface MemorySubjectRow {
  scope: MemoryFactScope;
  guild_id: string | null;
  user_id: string | null;
  subject: string;
  last_seen_at: string;
  fact_count: number;
}

function isPortableUserSubject(value: unknown) {
  const normalized = String(value || "").trim();
  return Boolean(normalized) && /^[0-9]+$/.test(normalized);
}

function escapeSqlLikePattern(value: string) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function escapeFtsToken(value: string) {
  return String(value || "")
    .replace(/["']/g, " ")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFtsMatchTerm(value: string) {
  const normalized = escapeFtsToken(value);
  if (!normalized) return "";
  if (/[-\s]/.test(normalized)) {
    const phrase = normalized
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return phrase ? `"${phrase.replace(/"/g, "\"\"")}"` : "";
  }
  return `${normalized}*`;
}

function buildMemoryFactsFtsQuery({
  queryText = "",
  queryTokens = []
}: {
  queryText?: string;
  queryTokens?: string[];
}) {
  const normalizedQueryText = escapeFtsToken(queryText);
  const normalizedTokens = [
    ...new Set((Array.isArray(queryTokens) ? queryTokens : []).map((value) => escapeFtsToken(value)).filter(Boolean))
  ].slice(0, 8);
  const parts: string[] = [];
  if (normalizedQueryText) {
    parts.push(`"${normalizedQueryText.replace(/"/g, "\"\"")}"`);
  }
  for (const token of normalizedTokens) {
    const term = buildFtsMatchTerm(token);
    if (term) parts.push(term);
  }
  if (!parts.length) return "";
  return parts.join(" OR ");
}

function normalizeMemoryFactSubject(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function canonicalizeMemoryFactText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEGACY_FACT_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMemoryFactText(value: unknown) {
  return canonicalizeMemoryFactText(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function canonicalizeMemoryFactType(value: unknown) {
  const normalized = String(value || "other")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 40) || "other";
  return LEGACY_FACT_TYPE_MAP[normalized] || normalized;
}

function normalizeMemoryFactType(value: unknown) {
  return canonicalizeMemoryFactType(value);
}

export function isLegacyMemoryFactRow(row: Pick<MemoryFactRow, "fact" | "fact_type"> | null | undefined) {
  const currentType = String(row?.fact_type || "").trim().toLowerCase();
  const currentFact = String(row?.fact || "").trim();
  return canonicalizeMemoryFactType(currentType) !== currentType || canonicalizeMemoryFactText(currentFact) !== currentFact;
}

function normalizeMemoryFactEvidence(value: unknown) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return normalized || null;
}

function deleteMemoryFactVectors(store: MemoryStore, factId: number) {
  if (!Number.isInteger(factId) || factId <= 0) return 0;
  const result = store.db
    .prepare("DELETE FROM memory_fact_vectors_native WHERE fact_id = ?")
    .run(factId);
  return Number(result?.changes || 0);
}

function countRows(store: MemoryStore, sql: string, args: Array<string | number | null> = []) {
  const row = store.db
    .prepare<CountRow, Array<string | number | null>>(sql)
    .get(...args);
  return Number(row?.count || 0);
}

const MEMORY_FACT_SELECT_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "scope",
  "guild_id",
  "channel_id",
  "user_id",
  "subject",
  "fact",
  "fact_type",
  "evidence_text",
  "source_message_id",
  "confidence"
].join(", ");

function normalizeMemoryFactScope(
  value: unknown,
  fallback: MemoryFactScope | null = null
): MemoryFactScope | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "user" || normalized === "guild") {
    return normalized;
  }
  if (normalized === "owner") {
    return normalized;
  }
  return fallback;
}

function buildScopedFactWhereClause({
  guildId = null,
  scope = null,
  subjectIds = null,
  factTypes = null,
  includePortableUserScope = false,
  includeOwnerScope = false,
  tableAlias = ""
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  includePortableUserScope?: boolean;
  includeOwnerScope?: boolean;
  tableAlias?: string;
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedScope = normalizeMemoryFactScope(scope);
  if (!normalizedGuildId && normalizedScope === "guild") return null;

  const prefix = tableAlias ? `${tableAlias}.` : "";
  const where = [`${prefix}is_active = 1`];
  const args: string[] = [];

  if (normalizedScope) {
    where.push(`${prefix}scope = ?`);
    args.push(normalizedScope);
  } else if (normalizedGuildId && (includePortableUserScope || includeOwnerScope)) {
    const scopeClauses = [`(${prefix}scope = 'guild' AND ${prefix}guild_id = ?)`];
    if (includePortableUserScope) scopeClauses.push(`${prefix}scope = 'user'`);
    if (includeOwnerScope) scopeClauses.push(`${prefix}scope = 'owner'`);
    where.push(`(${scopeClauses.join(" OR ")})`);
    args.push(normalizedGuildId);
  } else if (normalizedGuildId) {
    where.push(`${prefix}guild_id = ?`);
    args.push(normalizedGuildId);
  }

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
    args,
    scope: normalizedScope,
    guildId: normalizedGuildId || null
  };
}

export function addMemoryFact(store: MemoryStore, fact) {
const normalizedGuildId = String(fact.guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(fact.scope, normalizedGuildId ? "guild" : "user");
if (!normalizedScope) return false;
  if (normalizedScope === "guild" && !normalizedGuildId) return false;

const rawConfidence = Number(fact.confidence);
const confidence = clamp(Number.isFinite(rawConfidence) ? rawConfidence : 0.5, 0, 1);
const now = nowIso();
const normalizedSubject = normalizeMemoryFactSubject(fact.subject);
const normalizedFact = normalizeMemoryFactText(fact.fact);
if (!normalizedSubject || !normalizedFact) return false;
const normalizedUserId =
  normalizedScope === "user"
    ? (() => {
      if (normalizedSubject === "__self__") return null;
      const requestedUserId = String(fact.userId || "").trim();
      return requestedUserId || normalizedSubject;
    })()
    : normalizedScope === "owner"
      ? String(fact.userId || "").trim() || null
      : null;
const result = store.db
  .prepare(
    `INSERT INTO memory_facts(
          created_at,
          updated_at,
          scope,
          guild_id,
          channel_id,
          user_id,
          subject,
          fact,
          fact_type,
          evidence_text,
          source_message_id,
          confidence,
          is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT DO UPDATE SET
          updated_at = excluded.updated_at,
          scope = excluded.scope,
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          user_id = excluded.user_id,
          fact_type = excluded.fact_type,
          evidence_text = excluded.evidence_text,
          source_message_id = excluded.source_message_id,
          confidence = MAX(memory_facts.confidence, excluded.confidence),
          is_active = 1`
  )
  .run(
    now,
    now,
    normalizedScope,
    normalizedGuildId || null,
    fact.channelId ? String(fact.channelId).slice(0, 120) : null,
    normalizedUserId,
    normalizedSubject,
    normalizedFact,
    normalizeMemoryFactType(fact.factType),
    normalizeMemoryFactEvidence(fact.evidenceText),
    fact.sourceMessageId ? String(fact.sourceMessageId) : null,
    confidence
  );

return result.changes > 0;
}

export function getMemoryFactById(store: MemoryStore, factId, guildId = null, scope: MemoryFactScope | null = null) {
const factIdInt = Number(factId);
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope);
if (!Number.isInteger(factIdInt) || factIdInt <= 0) return null;

const where = ["id = ?", "is_active = 1"];
const args: Array<string | number> = [factIdInt];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return (
  store.db
    .prepare<MemoryFactRow, Array<string | number>>(
      `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
           FROM memory_facts
           WHERE ${where.join(" AND ")}
           LIMIT 1`
    )
    .get(...args) || null
);
}

export function getFactsForSubjectScoped(store: MemoryStore, subject, limit = 12, scope = null) {
const where = ["subject = ?", "is_active = 1"];
const args: string[] = [String(subject)];
const normalizedScope = normalizeMemoryFactScope(scope?.scope);
const normalizedGuildId = String(scope?.guildId || "").trim();
  if (normalizedScope === "guild" && !normalizedGuildId) return [];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
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
const normalizedScope = normalizeMemoryFactScope(scope?.scope);
const normalizedGuildId = String(scope?.guildId || "").trim();
  if (normalizedScope === "guild" && !normalizedGuildId) return [];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 500));
}

export function getFactProfileRows(store: MemoryStore, {
  guildId,
  scope = null,
  subjects = [],
  limit = 20
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  subjects?: string[];
  limit?: number;
}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope);
  if (normalizedScope === "guild" && !normalizedGuildId) return [];

const normalizedSubjects: string[] = [
  ...new Set((Array.isArray(subjects) ? subjects : []).map((value) => String(value || "").trim()).filter(Boolean))
];
if (!normalizedSubjects.length) return [];

const where = ["is_active = 1", `subject IN (${normalizedSubjects.map(() => "?").join(", ")})`];
const args: Array<string | number> = [...normalizedSubjects];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 200));
}

export function getFactsForScope(store: MemoryStore, {
  guildId,
  scope = null,
  limit = 120,
  subjectIds = null,
  factTypes = null,
  includePortableUserScope = false,
  includeOwnerScope = false,
  queryText = ""
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  limit?: number;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  includePortableUserScope?: boolean;
  includeOwnerScope?: boolean;
  queryText?: string;
}) {
  const scoped = buildScopedFactWhereClause({
    guildId,
    scope,
    subjectIds,
    factTypes,
    includePortableUserScope,
    includeOwnerScope
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
    `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 1000));
}

export function searchMemoryFactsLexical(store: MemoryStore, {
  guildId,
  scope = null,
  subjectIds = null,
  factTypes = null,
  queryText = "",
  queryTokens = [],
  limit = 60
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  queryText?: string;
  queryTokens?: string[];
  limit?: number;
}) {
  const scoped = buildScopedFactWhereClause({
    guildId,
    scope,
    subjectIds,
    factTypes,
    tableAlias: "m"
  });
  if (!scoped) return [];

  const ftsQuery = buildMemoryFactsFtsQuery({
    queryText,
    queryTokens
  });
  if (!ftsQuery) return [];

  const boundedLimit = clamp(Math.floor(Number(limit) || 60), 1, 240);
  const rows = store.db
    .prepare<MemoryFactLexicalSearchRow, Array<string | number>>(
      `SELECT
           id,
           created_at,
           updated_at,
           scope,
           guild_id,
           channel_id,
           user_id,
           subject,
           fact,
           fact_type,
           evidence_text,
           source_message_id,
           confidence,
           lexical_score
         FROM (
           SELECT
             m.id,
             m.created_at,
             m.updated_at,
             m.scope,
             m.guild_id,
             m.channel_id,
             m.user_id,
             m.subject,
             m.fact,
             m.fact_type,
             m.evidence_text,
             m.source_message_id,
             m.confidence,
             bm25(memory_facts_fts, 6.0, 3.0, 1.5, 1.0) AS lexical_score
           FROM memory_facts_fts
           JOIN memory_facts AS m
             ON m.id = memory_facts_fts.rowid
           WHERE memory_facts_fts MATCH ?
             AND ${scoped.where.join(" AND ")}
         ) AS ranked
         ORDER BY lexical_score ASC, updated_at DESC
         LIMIT ?`
    )
    .all(ftsQuery, ...scoped.args, boundedLimit);

  if (!rows.length) return [];

  const rawScores = rows
    .map((row) => Number(row.lexical_score))
    .filter((value) => Number.isFinite(value));
  const minScore = rawScores.length ? Math.min(...rawScores) : 0;
  const maxScore = rawScores.length ? Math.max(...rawScores) : minScore;
  const scoreRange = Math.max(1e-6, maxScore - minScore);

  return rows.map((row) => {
    const rawScore = Number(row.lexical_score);
    const normalizedLexicalScore = Number.isFinite(rawScore)
      ? (rawScores.length <= 1 ? 1 : 1 - ((rawScore - minScore) / scoreRange))
      : 0;
    return {
      id: Number(row.id),
      created_at: String(row.created_at || ""),
      updated_at: String(row.updated_at || ""),
      scope: normalizeMemoryFactScope(row.scope, "guild") || "guild",
      guild_id: String(row.guild_id || "").trim() || null,
      channel_id: String(row.channel_id || "").trim() || null,
      user_id: String(row.user_id || "").trim() || null,
      subject: String(row.subject || ""),
      fact: String(row.fact || ""),
      fact_type: String(row.fact_type || ""),
      evidence_text: String(row.evidence_text || "").trim() || null,
      source_message_id: String(row.source_message_id || "").trim() || null,
      confidence: Number(row.confidence || 0),
      lexical_score: Number(normalizedLexicalScore.toFixed(6))
    };
  });
}

export function searchMemoryFactsByEmbedding(store: MemoryStore, {
  guildId,
  scope = null,
  subjectIds = null,
  factTypes = null,
  model,
  queryEmbedding,
  limit = 60
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  model: string;
  queryEmbedding: number[];
  limit?: number;
}) {
  if (!store.ensureSqliteVecReady()) return [];

  const scoped = buildScopedFactWhereClause({
    guildId,
    scope,
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
             m.scope,
             m.guild_id,
             m.channel_id,
             m.user_id,
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
        scope: normalizeMemoryFactScope(row.scope, "guild") || "guild",
        guild_id: String(row.guild_id || "").trim() || null,
        channel_id: String(row.channel_id || "").trim() || null,
        user_id: String(row.user_id || "").trim() || null,
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
    scope = null,
    subjectIds = [],
    perSubjectLimit = 6,
    totalLimit = 600
  }: {
    guildId?: string | null;
    scope?: MemoryFactScope | null;
    subjectIds?: string[];
    perSubjectLimit?: number;
    totalLimit?: number;
  } = {}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope);
if (normalizedScope === "guild" && !normalizedGuildId) return [];

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
const where = [`subject IN (${subjectPlaceholders})`, "is_active = 1"];
const args: Array<string | number> = [...normalizedSubjects];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return store.db
  .prepare<MemoryFactRow, Array<string | number>>(
    `SELECT
           ${MEMORY_FACT_SELECT_COLUMNS}
         FROM (
           SELECT
             ${MEMORY_FACT_SELECT_COLUMNS},
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(guild_id, ''), COALESCE(user_id, ''), subject
               ORDER BY updated_at DESC
             ) AS row_num
           FROM memory_facts
           WHERE ${where.join(" AND ")}
         ) AS ranked
         WHERE row_num <= ?
         ORDER BY updated_at DESC
         LIMIT ?`
  )
  .all(
    ...args,
    boundedPerSubjectLimit,
    boundedTotalLimit
  );
}

export function getMemoryFactBySubjectAndFact(store: MemoryStore, {
  guildId = null,
  scope = null,
    userId = null,
  subject,
  fact
}: {
  guildId?: string | null;
  scope?: MemoryFactScope | null;
  userId?: string | null;
  subject: string;
  fact: string;
}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope, normalizedGuildId ? "guild" : "user");
const normalizedSubject = String(subject || "").trim();
const normalizedFact = String(fact || "").trim();
const normalizedUserId = String(userId || "").trim() || null;
if (!normalizedScope) return null;
if (!normalizedSubject || !normalizedFact) return null;
if (normalizedScope === "guild" && !normalizedGuildId) return null;

const where = ["subject = ?", "fact = ?", "is_active = 1"];
const args: Array<string | number> = [normalizedSubject, normalizedFact];
if (normalizedScope) {
  where.push("scope = ?");
  args.push(normalizedScope);
}
if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}
if (normalizedUserId) {
  where.push("user_id = ?");
  args.push(normalizedUserId);
}

return (
  store.db
    .prepare<MemoryFactRow, Array<string | number>>(
      `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
           FROM memory_facts
           WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC
           LIMIT 1`
    )
    .get(...args) || null
);
}

export function updateMemoryFact(store: MemoryStore, {
  guildId = null,
  scope = null,
  userId = null,
  factId,
  subject,
  fact,
  factType = "other",
  evidenceText = null,
  confidence = 0.5
}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope, normalizedGuildId ? "guild" : "user");
const factIdInt = Number(factId);
const normalizedSubject = normalizeMemoryFactSubject(subject);
const normalizedFact = normalizeMemoryFactText(fact);
if (!normalizedScope) return { ok: false, reason: "scope_required" } as const;
if (normalizedScope === "guild" && !normalizedGuildId) return { ok: false, reason: "guild_required" } as const;
if (!Number.isInteger(factIdInt) || factIdInt <= 0) return { ok: false, reason: "invalid_fact_id" } as const;
if (!normalizedSubject) return { ok: false, reason: "subject_required" } as const;
if (!normalizedFact) return { ok: false, reason: "fact_required" } as const;

const existing = getMemoryFactById(store, factIdInt, normalizedGuildId || null, normalizedScope);
if (!existing) return { ok: false, reason: "not_found" } as const;
  const normalizedUserId =
    normalizedScope === "user" || normalizedScope === "owner"
      ? String(userId || existing.user_id || "").trim() || null
      : null;

const duplicate = store.db
  .prepare<DuplicateMemoryFactRow, Array<string | number>>(
    `SELECT id
         FROM memory_facts
         WHERE scope = ?
           AND IFNULL(guild_id, '') = IFNULL(?, '')
           AND IFNULL(user_id, '') = IFNULL(?, '')
           AND subject = ?
           AND fact = ?
           AND is_active = 1
           AND id != ?
         LIMIT 1`
  )
  .get(
    normalizedScope,
    normalizedGuildId || null,
    normalizedUserId,
    normalizedSubject,
    normalizedFact,
    factIdInt
  );
if (Number.isInteger(Number(duplicate?.id)) && Number(duplicate.id) > 0) {
  return {
    ok: false,
    reason: "duplicate",
    duplicateId: Number(duplicate.id)
  } as const;
}

const normalizedFactType = normalizeMemoryFactType(factType);
const normalizedEvidenceText = normalizeMemoryFactEvidence(evidenceText);
const normalizedConfidence = clamp(Number.isFinite(Number(confidence)) ? Number(confidence) : 0.5, 0, 1);
const updatedAt = nowIso();
const result = store.db
  .prepare(
    `UPDATE memory_facts
         SET updated_at = ?,
             scope = ?,
             guild_id = ?,
             user_id = ?,
             subject = ?,
             fact = ?,
             fact_type = ?,
             evidence_text = ?,
             confidence = ?
         WHERE id = ?
           AND scope = ?
           AND IFNULL(guild_id, '') = IFNULL(?, '')
           AND is_active = 1`
  )
  .run(
    updatedAt,
    normalizedScope,
    normalizedGuildId || null,
    normalizedUserId,
    normalizedSubject,
    normalizedFact,
    normalizedFactType,
    normalizedEvidenceText,
    normalizedConfidence,
    factIdInt,
    normalizedScope,
    normalizedGuildId || null
  );
if (Number(result?.changes || 0) <= 0) return { ok: false, reason: "not_found" } as const;

deleteMemoryFactVectors(store, factIdInt);
const row = getMemoryFactById(store, factIdInt, normalizedGuildId || null, normalizedScope);
if (!row) return { ok: false, reason: "not_found" } as const;

return {
  ok: true,
  row
} as const;
}

export function deleteMemoryFact(store: MemoryStore, {
  guildId = null,
  scope = null,
  factId
}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope, normalizedGuildId ? "guild" : "user");
const factIdInt = Number(factId);
if (!normalizedScope) return { ok: false, reason: "scope_required", deleted: 0 } as const;
  if (normalizedScope === "guild" && !normalizedGuildId) {
  return { ok: false, reason: "guild_required", deleted: 0 } as const;
}
if (!Number.isInteger(factIdInt) || factIdInt <= 0) {
  return { ok: false, reason: "invalid_fact_id", deleted: 0 } as const;
}

const existing = getMemoryFactById(store, factIdInt, normalizedGuildId || null, normalizedScope);
if (!existing) {
  return { ok: false, reason: "not_found", deleted: 0 } as const;
}

store.db
  .prepare(
    `UPDATE memory_facts
         SET is_active = 0,
             updated_at = ?
         WHERE id = ?
           AND scope = ?
           AND IFNULL(guild_id, '') = IFNULL(?, '')
           AND is_active = 1`
  )
  .run(nowIso(), factIdInt, normalizedScope, normalizedGuildId || null);
deleteMemoryFactVectors(store, factIdInt);
return {
  ok: true,
  reason: "deleted",
  deleted: 1
} as const;
}

export function deleteMemoryFactsForGuild(store: MemoryStore, guildId: string) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) {
  return {
    ok: false,
    reason: "guild_required",
    factsDeleted: 0,
    vectorsDeleted: 0
  } as const;
}

const deleteTx = store.db.transaction((targetGuildId: string) => {
  const factsDeleted = countRows(
    store,
    `SELECT COUNT(*) AS count
       FROM memory_facts
      WHERE guild_id = ?`,
    [targetGuildId]
  );
  const vectorsDeleted = countRows(
    store,
    `SELECT COUNT(*) AS count
       FROM memory_fact_vectors_native
      WHERE fact_id IN (
        SELECT id
          FROM memory_facts
         WHERE guild_id = ?
      )`,
    [targetGuildId]
  );
  store.db
    .prepare(
      `DELETE FROM memory_fact_vectors_native
         WHERE fact_id IN (
           SELECT id
             FROM memory_facts
            WHERE guild_id = ?
         )`
    )
    .run(targetGuildId);
  store.db
    .prepare(
      `DELETE FROM memory_facts
         WHERE guild_id = ?`
    )
    .run(targetGuildId);
  return {
    factsDeleted,
    vectorsDeleted
  };
});

const result = deleteTx(normalizedGuildId);
return {
  ok: true,
  reason: "deleted",
  ...result
} as const;
}

export function cleanupLegacyMemoryFacts(store: MemoryStore) {
  const rows = store.db
    .prepare<MemoryFactRow, []>(
      `SELECT ${MEMORY_FACT_SELECT_COLUMNS}
         FROM memory_facts
        WHERE is_active = 1
        ORDER BY id ASC`
    )
    .all();

  const cleanupTx = store.db.transaction((activeRows: MemoryFactRow[]) => {
    let inspected = 0;
    let normalized = 0;
    let textRewritten = 0;
    let typeCanonicalized = 0;
    let mergedDuplicates = 0;
    let archivedDuplicates = 0;
    let vectorsDeleted = 0;
    let scopeMigrated = 0;

    for (const row of activeRows) {
      inspected += 1;
      const canonicalFact = normalizeMemoryFactText(row.fact);
      const canonicalFactType = normalizeMemoryFactType(row.fact_type);
      const factChanged = canonicalFact !== String(row.fact || "").trim();
      const typeChanged = canonicalFactType !== String(row.fact_type || "").trim().toLowerCase();
      const shouldPromotePortableUser = row.scope === "guild" && isPortableUserSubject(row.subject);
      if (!factChanged && !typeChanged && !shouldPromotePortableUser) continue;
      if (!canonicalFact) continue;

      const targetScope = shouldPromotePortableUser ? "user" : row.scope;
      const targetGuildId = shouldPromotePortableUser ? null : row.guild_id;
      const targetUserId = (targetScope === "user" || targetScope === "owner") && row.subject !== "__self__"
        ? String(row.user_id || row.subject || "").trim() || null
        : null;

      const duplicate = store.db
        .prepare<DuplicateMemoryFactRow, Array<string | number | null>>(
          `SELECT id
             FROM memory_facts
            WHERE scope = ?
              AND IFNULL(guild_id, '') = IFNULL(?, '')
              AND IFNULL(user_id, '') = IFNULL(?, '')
              AND subject = ?
              AND fact = ?
              AND is_active = 1
              AND id != ?
            LIMIT 1`
        )
        .get(targetScope, targetGuildId, targetUserId, row.subject, canonicalFact, row.id);

      if (Number.isInteger(Number(duplicate?.id)) && Number(duplicate.id) > 0) {
        const duplicateId = Number(duplicate.id);
        store.db
          .prepare(
            `UPDATE memory_facts
                SET updated_at = ?,
                    fact_type = ?,
                    confidence = MAX(confidence, ?),
                    evidence_text = CASE
                      WHEN (evidence_text IS NULL OR TRIM(evidence_text) = '') AND ? IS NOT NULL THEN ?
                      ELSE evidence_text
                    END
              WHERE id = ?`
          )
          .run(nowIso(), canonicalFactType, Number(row.confidence || 0), row.evidence_text, row.evidence_text, duplicateId);
        const archived = store.db
          .prepare(
            `UPDATE memory_facts
                SET is_active = 0,
                    updated_at = ?
              WHERE id = ?
                AND is_active = 1`
          )
          .run(nowIso(), row.id);
        if (Number(archived?.changes || 0) > 0) {
          archivedDuplicates += 1;
          mergedDuplicates += 1;
          vectorsDeleted += deleteMemoryFactVectors(store, row.id);
        }
        continue;
      }

      const result = store.db
        .prepare(
          `UPDATE memory_facts
              SET updated_at = ?,
                  scope = ?,
                  guild_id = ?,
                  user_id = ?,
                  fact = ?,
                  fact_type = ?
            WHERE id = ?
              AND is_active = 1`
        )
        .run(nowIso(), targetScope, targetGuildId, targetUserId, canonicalFact, canonicalFactType, row.id);
      if (Number(result?.changes || 0) > 0) {
        normalized += 1;
        if (factChanged) textRewritten += 1;
        if (typeChanged) typeCanonicalized += 1;
        if (shouldPromotePortableUser) scopeMigrated += 1;
        vectorsDeleted += deleteMemoryFactVectors(store, row.id);
      }
    }

    return {
      inspected,
      normalized,
      textRewritten,
      typeCanonicalized,
      scopeMigrated,
      mergedDuplicates,
      archivedDuplicates,
      vectorsDeleted
    };
  });

  return cleanupTx(rows);
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
const args: Array<string | number> = [];
  const normalizedScope = normalizeMemoryFactScope(scope?.scope);
  const normalizedGuildId = String(scope?.guildId || "").trim();
  const includePortableUserScope = scope?.includePortableUserScope === true;
  const includeOwnerScope = scope?.includeOwnerScope === true;
  if (normalizedScope) {
    where.push("scope = ?");
    args.push(normalizedScope);
  } else if (normalizedGuildId && (includePortableUserScope || includeOwnerScope)) {
    const clauses = ["(scope = 'guild' AND guild_id = ?)"];
    if (includePortableUserScope) clauses.push("scope = 'user'");
    if (includeOwnerScope) clauses.push("scope = 'owner'");
    where.push(`(${clauses.join(" OR ")})`);
    args.push(normalizedGuildId);
  } else if (normalizedGuildId) {
  where.push("guild_id = ?");
  args.push(normalizedGuildId);
}

return store.db
  .prepare<MemorySubjectRow, Array<string | number>>(
    `SELECT
         scope,
         guild_id,
         user_id,
         subject,
         MAX(updated_at) AS last_seen_at,
         COUNT(*) AS fact_count
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         GROUP BY scope, guild_id, user_id, subject
         ORDER BY last_seen_at DESC
         LIMIT ?`
  )
  .all(...args, clamp(limit, 1, 500));
}

export function archiveOldFactsForSubject(store: MemoryStore, {
  guildId = null,
  scope = null,
  userId = null,
  subject,
  factType = null,
  keep = 120
}) {
const normalizedGuildId = String(guildId || "").trim();
const normalizedScope = normalizeMemoryFactScope(scope, normalizedGuildId ? "guild" : "user");
  const normalizedUserId =
    normalizedScope === "user" || normalizedScope === "owner"
      ? String(userId || "").trim() || null
      : null;
const normalizedSubject = String(subject || "").trim();
if (!normalizedScope || !normalizedSubject) return 0;
if (normalizedScope === "guild" && !normalizedGuildId) return 0;

const boundedKeep = clamp(Math.floor(Number(keep) || 120), 1, 400);
const where = [
  "scope = ?",
  "IFNULL(guild_id, '') = IFNULL(?, '')",
  "IFNULL(user_id, '') = IFNULL(?, '')",
  "subject = ?",
  "is_active = 1"
];
const args: Array<string | number> = [
  normalizedScope,
  normalizedGuildId || null,
  normalizedUserId,
  normalizedSubject
];
if (factType) {
  where.push("fact_type = ?");
  args.push(String(factType));
}

const rows = store.db
  .prepare<MemoryFactIdRow, Array<string | number>>(
    `SELECT id, fact_type, confidence, updated_at
         FROM memory_facts
         WHERE ${where.join(" AND ")}
         ORDER BY confidence DESC, updated_at DESC
         LIMIT 1000`
  )
  .all(...args);
if (rows.length <= boundedKeep) return 0;

// Sort by time-weighted confidence so old unreinforced facts become evictable.
// Guidance and behavioral facts are exempt from decay (evergreen rules).
const EVICTION_DECAY_EXEMPT = new Set(["guidance", "behavioral"]);
const EVICTION_HALF_LIFE_DAYS = 120;
const sorted = [...rows].sort((left, right) => {
  const leftConf = Number(left.confidence ?? 0.5);
  const rightConf = Number(right.confidence ?? 0.5);
  const leftType = String(left.fact_type || "").trim().toLowerCase();
  const rightType = String(right.fact_type || "").trim().toLowerCase();
  const leftAge = Math.max(0, Date.now() - Date.parse(String(left.updated_at || ""))) / (24 * 60 * 60 * 1000);
  const rightAge = Math.max(0, Date.now() - Date.parse(String(right.updated_at || ""))) / (24 * 60 * 60 * 1000);
  const lambda = Math.LN2 / EVICTION_HALF_LIFE_DAYS;
  const leftDecayed = EVICTION_DECAY_EXEMPT.has(leftType) ? leftConf : leftConf * Math.exp(-lambda * leftAge);
  const rightDecayed = EVICTION_DECAY_EXEMPT.has(rightType) ? rightConf : rightConf * Math.exp(-lambda * rightAge);
  if (Math.abs(rightDecayed - leftDecayed) > 1e-9) return rightDecayed - leftDecayed;
  return Date.parse(String(right.updated_at || "")) - Date.parse(String(left.updated_at || ""));
});

let staleIds: number[] = [];
if (factType) {
  staleIds = sorted.slice(boundedKeep).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
} else {
  const contextualRows = sorted.filter((row) => !CORE_FACT_TYPE_SET.has(String(row.fact_type || "").trim()));
  const coreRows = sorted.filter((row) => CORE_FACT_TYPE_SET.has(String(row.fact_type || "").trim()));
  const overflowCount = Math.max(0, sorted.length - boundedKeep);
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
store.db
  .prepare(`UPDATE memory_facts SET is_active = 0, updated_at = ? WHERE id IN (${placeholders})`)
  .run(nowIso(), ...staleIds);
return staleIds.length;
}
