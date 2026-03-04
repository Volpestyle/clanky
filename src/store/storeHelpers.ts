import { clamp, nowIso } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";
import { LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT } from "../store.ts";

export const LOOKUP_CONTEXT_QUERY_MAX_CHARS = 220;
export const LOOKUP_CONTEXT_SOURCE_MAX_CHARS = 120;
export const LOOKUP_CONTEXT_PROVIDER_MAX_CHARS = 64;
export const LOOKUP_CONTEXT_RESULT_MAX_CHARS = 420;
export const LOOKUP_CONTEXT_MATCH_TEXT_MAX_CHARS = 1800;
export const LOOKUP_CONTEXT_MAX_TTL_HOURS = 168;
export const LOOKUP_CONTEXT_MAX_AGE_HOURS = 168;
export const LOOKUP_CONTEXT_MAX_SEARCH_LIMIT = 16;

export function normalizeLookupResultText(value, maxChars = LOOKUP_CONTEXT_RESULT_MAX_CHARS) {
  return normalizeWhitespaceText(value, {
    maxLen: maxChars,
    minLen: 40
  });
}

export function normalizeLookupResultRows(rows, maxResults = LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT) {
  const source = Array.isArray(rows) ? rows : [];
  const boundedMaxResults = clamp(
    Math.floor(Number(maxResults) || LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT),
    1,
    10
  );
  const normalizedRows = [];
  for (const row of source) {
    if (normalizedRows.length >= boundedMaxResults) break;
    const url = normalizeLookupResultText(row?.url, 420);
    if (!url) continue;
    normalizedRows.push({
      title: normalizeLookupResultText(row?.title, 180),
      url,
      domain: normalizeLookupResultText(row?.domain, 120),
      snippet: normalizeLookupResultText(row?.snippet, 260),
      pageSummary: normalizeLookupResultText(row?.pageSummary, 320)
    });
  }
  return normalizedRows;
}

export function buildLookupContextMatchText({ query, results = [] }) {
  const normalizedQuery = normalizeLookupResultText(query, LOOKUP_CONTEXT_QUERY_MAX_CHARS);
  const resultRows = Array.isArray(results) ? results : [];
  const segments = [normalizedQuery];
  for (const row of resultRows) {
    const title = normalizeLookupResultText(row?.title, 180);
    const domain = normalizeLookupResultText(row?.domain, 120);
    const snippet = normalizeLookupResultText(row?.snippet, 220);
    const pageSummary = normalizeLookupResultText(row?.pageSummary, 220);
    if (title) segments.push(title);
    if (domain) segments.push(domain);
    if (snippet) segments.push(snippet);
    if (pageSummary) segments.push(pageSummary);
  }
  return segments
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LOOKUP_CONTEXT_MATCH_TEXT_MAX_CHARS);
}

export function scoreLookupContextRow(row, tokens = []) {
  const normalizedTokens = Array.isArray(tokens) ? tokens : [];
  if (!normalizedTokens.length) return 0;
  const query = String(row?.query || "")
    .toLowerCase()
    .trim();
  const matchText = String(row?.match_text || "")
    .toLowerCase()
    .trim();
  if (!query && !matchText) return 0;

  let score = 0;
  for (const token of normalizedTokens) {
    if (!token) continue;
    if (query.includes(token)) {
      score += 3;
      continue;
    }
    if (matchText.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function normalizeEmbeddingVector(rawEmbedding) {
  if (!Array.isArray(rawEmbedding) || !rawEmbedding.length) return [];
  const normalized = [];
  for (const value of rawEmbedding) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    normalized.push(numeric);
  }
  return normalized;
}

export function vectorToBlob(embedding) {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function parseEmbeddingBlob(rawBlob) {
  if (!rawBlob) return [];
  let buffer = rawBlob;
  if (!Buffer.isBuffer(buffer)) {
    try {
      buffer = Buffer.from(buffer);
    } catch {
      return [];
    }
  }
  if (!buffer.length || buffer.length % 4 !== 0) return [];
  const values = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  const out = [];
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return [];
    out.push(numeric);
  }
  return out;
}

export function normalizeAutomationStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "paused") return "paused";
  if (normalized === "deleted") return "deleted";
  return "";
}

export function normalizeAutomationRunStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "ok") return "ok";
  if (normalized === "error") return "error";
  if (normalized === "skipped") return "skipped";
  return "ok";
}

export function normalizeAutomationStatusFilter(statuses) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const raw = list
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);
  if (raw.includes("all")) {
    return ["active", "paused", "deleted"];
  }
  return [
    ...new Set(
      raw
        .map((status) => normalizeAutomationStatus(status))
        .filter(Boolean)
    )
  ];
}

export function mapAutomationRow(row) {
  if (!row) return null;
  const schedule = safeJsonParse(row.schedule_json, null);
  if (!schedule || typeof schedule !== "object") return null;

  return {
    id: Number(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name || null,
    title: row.title,
    instruction: row.instruction,
    schedule,
    next_run_at: row.next_run_at || null,
    status: row.status,
    is_running: Number(row.is_running || 0) === 1,
    running_started_at: row.running_started_at || null,
    last_run_at: row.last_run_at || null,
    last_error: row.last_error || null,
    last_result: row.last_result || null,
    match_text: row.match_text || ""
  };
}

export function normalizeMessageCreatedAt(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : nowIso();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }

  const text = String(value || "").trim();
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return nowIso();
}
