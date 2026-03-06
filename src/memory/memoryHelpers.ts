import { clamp01 } from "../normalization/numbers.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";

export const LORE_SUBJECT = "__lore__";
export const SELF_SUBJECT = "__self__";
type DirectiveScope = "lore" | "self" | "user";

type DirectiveScopeConfig = {
  scope: DirectiveScope;
  subject: string | null;
  prefix: string;
  factType: string;
  keep: number;
  traceSource: string;
};

const FACT_TYPE_LABELS = {
  preference: "Preference",
  profile: "Profile",
  relationship: "Relationship",
  project: "Project",
  lore: "Lore",
  self: "Self"
};

const ALLOWED_FACT_TYPES = new Set(["preference", "profile", "relationship", "project", "other", "general"]);
// English-only fallback heuristics for filtering obvious instruction-like memory writes.
// These are guardrails, not the primary memory decision-maker.
const EN_MEMORY_BEHAVIOR_VERB_RE =
  /\b(?:call|say|reply|respond|greet|address|refer to|talk to|treat|insult|mock|roast|flame|trash|dog|clown on)\b/i;
const EN_MEMORY_FUTURE_BEHAVIOR_RE =
  /\b(?:every time|each time|whenever|any time|from now on|going forward|next time)\b/i;
const EN_MEMORY_MODAL_DIRECTIVE_RE =
  /\b(?:you|i|we)\s+(?:should|must|need to|have to|gotta|will)\s+(?:always\s+)?(?:call|say|reply|respond|greet|address|refer to|talk to|treat|insult|mock|roast|flame|trash|dog|clown on)\b/i;
const EN_MEMORY_IMPERATIVE_DIRECTIVE_RE =
  /\b(?:make sure|be sure|start|keep)\s+(?:you\s+)?(?:call|saying|say|reply|respond|greet|address|referring to|refer to|talk to|treat|insult|mock|roast|flame|trash|dog|clown on)\b/i;
const EN_MEMORY_BEHAVIOR_RULE_RE =
  /\b(?:always|never)\s+(?:call|say|reply|respond|greet|address|refer to|talk to|treat|insult|mock|roast|flame|trash|dog|clown on)\b/i;
const EN_MEMORY_ABUSIVE_LABEL_RE = /\b(?:bitch|bih|idiot|moron|stupid|dumbass|loser|clown|bozo)\b/i;
const EN_MEMORY_PREFIX_NOISE_RE =
  /^(?:remember(?: this| that| this one)?|important|note this|log this|save this|dont forget|don't forget|keep in mind|worth remembering|fyi)\b[\s:,-]*/i;
const EN_MEMORY_LINE_LABEL_RE = /^(?:memory line|remember line)\s*:\s*/i;
const EN_MEMORY_LEADING_THAT_RE = /^that\s+/i;
const EN_MEMORY_OUTPUT_RULE_RE = /(?:always|never)\s+(?:reply|respond|say|output)/;
const EN_MEMORY_SECRET_RE = /(?:api key|token|password|credential|secret)/;

export function normalizeStoredFactText(rawFact) {
  const compact = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length < 4) return "";
  if (!/[.!?]$/.test(compact)) return `${compact}.`.slice(0, 190);
  return compact.slice(0, 190);
}

export function normalizeFactType(rawType) {
  const normalized = String(rawType || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_FACT_TYPES.has(normalized)) return "other";
  if (normalized === "general") return "other";
  return normalized;
}

export function normalizeEvidenceText(rawEvidence, sourceText) {
  const evidence = sanitizeInline(rawEvidence || "", 220);
  if (!evidence) return null;
  return isTextGroundedInSource(evidence, sourceText) ? evidence : null;
}

export function buildFactEmbeddingPayload(factRow) {
  const fact = sanitizeInline(factRow?.fact || "", 220);
  const evidence = sanitizeInline(factRow?.evidence_text || "", 180);
  const factType = sanitizeInline(factRow?.fact_type || "", 40);
  if (!fact) return "";

  const parts = [];
  if (factType) parts.push(`type: ${factType}`);
  parts.push(`fact: ${fact}`);
  if (evidence) parts.push(`evidence: ${evidence}`);
  return parts.join("\n");
}

export function computeLexicalFactScore(row, { queryTokens, queryCompact }) {
  const factCompact = normalizeHighlightText(row?.fact || "");
  const evidenceCompact = normalizeHighlightText(row?.evidence_text || "");
  const combinedCompact = `${factCompact} ${evidenceCompact}`.trim();
  if (!combinedCompact) return 0;

  if (queryCompact && combinedCompact.includes(queryCompact)) return 1;
  if (!queryTokens?.length) return 0;

  const factTokens = new Set(extractStableTokens(combinedCompact, 96));
  const overlap = queryTokens.filter((token) => factTokens.has(token));
  if (!overlap.length) return 0;

  return Math.min(1, overlap.length / Math.max(1, queryTokens.length));
}

export function computeRecencyScore(createdAtIso) {
  const timestamp = Date.parse(String(createdAtIso || ""));
  if (!Number.isFinite(timestamp)) return 0;
  const ageMs = Math.max(0, Date.now() - timestamp);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + ageDays / 45);
}

export function computeChannelScopeScore(rowChannelId, queryChannelId) {
  const normalizedQueryChannelId = String(queryChannelId || "").trim();
  if (!normalizedQueryChannelId) return 0;

  const normalizedRowChannelId = String(rowChannelId || "").trim();
  if (!normalizedRowChannelId) return 0.25;
  return normalizedRowChannelId === normalizedQueryChannelId ? 1 : 0;
}

export function passesHybridRelevanceGate({ row, semanticAvailable }) {
  const lexicalScore = clamp01(row?._lexicalScore, 0);
  const semanticScore = clamp01(row?._semanticScore, 0);
  const combinedScore = clamp01(row?._score, 0);

  if (semanticAvailable) {
    if (semanticScore >= 0.2 || lexicalScore >= 0.22) return true;
    return combinedScore >= 0.52 && (semanticScore >= 0.08 || lexicalScore >= 0.1);
  }

  return lexicalScore >= 0.24 || combinedScore >= 0.62;
}

function cleanFactForMemory(rawFact) {
  let text = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text
    .replace(/\s+\b(?:bro|lol|lmao|lmfao|fr|ngl)\b[\s\S]*$/i, ".")
    .replace(/\s+\b(?:and|but|because)\b[\s\S]*$/i, ".");

  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(text)) text += ".";

  return text.slice(0, 190);
}

export function formatTypedFactForMemory(rawFact, rawType) {
  const fact = cleanFactForMemory(rawFact);
  if (!fact) return "";

  const type = String(rawType || "")
    .trim()
    .toLowerCase();
  const label = FACT_TYPE_LABELS[type];
  return label ? `${label}: ${fact}` : fact;
}

export function buildHighlightsSection(entries, maxItems = 24) {
  const byAuthorCount = new Map();
  const seen = new Set();
  const items = [];

  for (const entry of entries) {
    if (items.length >= maxItems) break;

    const author = String(entry.author || "").trim();
    const text = String(entry.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    if (!author || !text) continue;
    if (text.length < 8) continue;
    if (/^https?:\/\/\S+$/i.test(text)) continue;

    const normalized = normalizeHighlightText(text);
    if (!normalized || seen.has(normalized)) continue;

    const authorCount = byAuthorCount.get(author) || 0;
    if (authorCount >= 8) continue;

    byAuthorCount.set(author, authorCount + 1);
    seen.add(normalized);
    items.push(`- ${author}: ${text}`);
  }

  return items;
}

export function normalizeHighlightText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:[^:>]+:\d+>/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDailyEntryLine(line) {
  if (!String(line).startsWith("- ")) return null;
  const payload = line.slice(2).trim();
  const parts = payload.split(" | ");
  if (parts.length < 3) return null;

  const [timestampIso, authorPart, ...textParts] = parts;
  const text = textParts.join(" | ").trim();
  const author = authorPart.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (!timestampIso || !author || !text) return null;

  const timestampMs = Date.parse(timestampIso);
  return {
    timestampIso,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    author,
    text
  };
}

const SCOPE_FRAGMENT_RE = /\[guild:(\S+)\s+channel:(\S+)\s+message:(\S+)\]/;
const AUTHOR_ID_RE = /\((\d+)\)$/;

export function parseDailyEntryLineWithScope(line) {
  if (!String(line).startsWith("- ")) return null;
  const payload = line.slice(2).trim();
  const parts = payload.split(" | ");
  if (parts.length < 3) return null;

  const [timestampIso, authorPart, ...textParts] = parts;
  const rawText = textParts.join(" | ").trim();
  const author = authorPart.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (!timestampIso || !author || !rawText) return null;

  const timestampMs = Date.parse(timestampIso);
  const authorIdMatch = authorPart.trim().match(AUTHOR_ID_RE);
  const authorId = authorIdMatch ? authorIdMatch[1] : null;

  const scopeMatch = rawText.match(SCOPE_FRAGMENT_RE);
  const guildId = scopeMatch ? scopeMatch[1] : null;
  const channelId = scopeMatch ? scopeMatch[2] : null;
  const messageId = scopeMatch ? scopeMatch[3] : null;
  const content = scopeMatch ? rawText.slice(scopeMatch.index + scopeMatch[0].length).trim() : rawText;

  return {
    timestampIso,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    author,
    authorId,
    guildId,
    channelId,
    messageId,
    content
  };
}

export function normalizeLoreFactForDisplay(rawFact) {
  let text = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text
    .replace(/^alias mapping:\s*/i, "memory line: ")
    .replace(/^important tidbit:\s*/i, "memory line: ");

  if (!/^memory line:\s*/i.test(text)) {
    text = `Memory line: ${text}`;
  }

  return cleanFactForMemory(text);
}

export function normalizeSelfFactForDisplay(rawFact) {
  let text = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text
    .replace(/^bot memory:\s*/i, "self memory: ")
    .replace(/^identity memory:\s*/i, "self memory: ");

  if (!/^self memory:\s*/i.test(text)) {
    text = `Self memory: ${text}`;
  }

  return cleanFactForMemory(text);
}

export function resolveDirectiveScopeConfig(scope: string | null | undefined): DirectiveScopeConfig {
  const normalizedScope = String(scope || "lore")
    .trim()
    .toLowerCase() as DirectiveScope;

  if (normalizedScope === "self") {
    return {
      scope: "self",
      subject: SELF_SUBJECT,
      prefix: "Self memory",
      factType: "self",
      keep: 120,
      traceSource: "memory_self_ingest"
    };
  }

  if (normalizedScope === "user") {
    return {
      scope: "user",
      subject: null,
      prefix: "User memory",
      factType: "preference",
      keep: 80,
      traceSource: "memory_user_ingest"
    };
  }

  return {
    scope: "lore",
    subject: LORE_SUBJECT,
    prefix: "Memory line",
    factType: "lore",
    keep: 120,
    traceSource: "memory_lore_ingest"
  };
}

export function normalizeMemoryLineInput(input) {
  let text = String(input || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  if (!text) return "";

  text = text
    .replace(EN_MEMORY_PREFIX_NOISE_RE, "")
    .replace(EN_MEMORY_LINE_LABEL_RE, "")
    .replace(EN_MEMORY_LEADING_THAT_RE, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  if (text.length < 4) return "";
  return text.slice(0, 180);
}

export function isInstructionLikeFactText(line) {
  const text = String(line || "").toLowerCase();
  if (!text) return true;
  if (/\[\[[\s\S]*\]\]/.test(text)) return true;
  if (/(?:system|developer|prompt|instruction|policy|jailbreak|override)/.test(text)) return true;
  if (/(?:ignore|disregard|bypass)\s+(?:previous|prior|earlier)/.test(text)) return true;
  if (EN_MEMORY_OUTPUT_RULE_RE.test(text)) return true;
  if (EN_MEMORY_SECRET_RE.test(text)) return true;
  if (EN_MEMORY_MODAL_DIRECTIVE_RE.test(text)) return true;
  if (EN_MEMORY_IMPERATIVE_DIRECTIVE_RE.test(text)) return true;
  if (EN_MEMORY_BEHAVIOR_RULE_RE.test(text)) return true;
  if (EN_MEMORY_BEHAVIOR_VERB_RE.test(text) && EN_MEMORY_FUTURE_BEHAVIOR_RE.test(text)) return true;
  if (EN_MEMORY_ABUSIVE_LABEL_RE.test(text) && EN_MEMORY_BEHAVIOR_VERB_RE.test(text)) return true;
  return false;
}

export function isTextGroundedInSource(memoryLine, sourceText) {
  const sourceCompact = normalizeHighlightText(sourceText);
  const memoryCompact = normalizeHighlightText(memoryLine);
  if (!sourceCompact || !memoryCompact) return false;
  if (sourceCompact.includes(memoryCompact)) return true;

  const sourceTokens = extractStableTokens(sourceText, 64);
  if (!sourceTokens.length) return false;

  const memoryTokens = extractStableTokens(memoryLine, 32);
  if (!memoryTokens.length) return false;

  const sourceSet = new Set(sourceTokens);
  const overlapCount = memoryTokens.filter((token) => sourceSet.has(token)).length;
  const minOverlap = Math.max(2, Math.ceil(memoryTokens.length * 0.45));
  if (overlapCount >= minOverlap) return true;
  if (memoryTokens.length <= 3 && overlapCount === memoryTokens.length && overlapCount >= 2) return true;

  return false;
}

export function extractStableTokens(text, maxTokens = 64) {
  return [...new Set(String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(
    0,
    Math.max(1, maxTokens)
  );
}

export function normalizeQueryEmbeddingText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

export function cleanDailyEntryContent(content) {
  const text = String(content || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  if (!text) return "";
  if (text.length < 2) return "";
  return text.slice(0, 320);
}

export function sanitizeInline(value, maxLen = 120) {
  return normalizeWhitespaceText(value, {
    maxLen,
    replacements: [{ pattern: /[\r\n|]/g, replacement: " " }]
  });
}

export function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
