import { clamp01 } from "../normalization/numbers.ts";
import { normalizeWhitespaceText } from "../normalization/text.ts";
import { normalizeInlineText, parseMemoryExtractionJson } from "../llm/llmHelpers.ts";

export const LORE_SUBJECT = "__lore__";
export const SELF_SUBJECT = "__self__";
type DirectiveScope = "lore" | "self" | "user";

type DirectiveScopeConfig = {
  scope: DirectiveScope;
  subject: string | null;
  defaultFactType: string;
  keep: number;
  traceSource: string;
};

const FACT_TYPE_LABELS = {
  preference: "Preference",
  profile: "Profile",
  relationship: "Relationship",
  project: "Project",
  guidance: "Guidance",
  behavioral: "Behavioral"
};

const MEMORY_FACT_MAX_CHARS = 190;
const MEMORY_EVIDENCE_MAX_CHARS = 220;
const FACT_EMBEDDING_FACT_MAX_CHARS = 220;
const FACT_EMBEDDING_EVIDENCE_MAX_CHARS = 180;
const MEMORY_LINE_MAX_CHARS = 180;
const MEMORY_RECENCY_HALF_LIFE_DAYS = 45;
const HIGHLIGHT_ENTRY_MAX_CHARS = 220;

const ALLOWED_FACT_TYPES = new Set(["preference", "profile", "relationship", "project", "guidance", "behavioral", "other"]);
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
const EN_MEMORY_STYLE_GUIDANCE_RE =
  /\b(?:use|keep|be|stay|avoid|prefer)\b[\s\S]{0,80}\b(?:tone|style|voice|responses?|replies?|brief|concise|casual|formal|playful|direct)\b/i;

export type NormalizedReflectionFact = {
  subject: string;
  subjectName: string;
  fact: string;
  type: string;
  confidence: number;
  evidence: string;
  supersedes?: string;
};

export const REFLECTION_FACTS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", enum: ["author", "bot", "lore"] },
          subjectName: { type: "string", maxLength: 80 },
          fact: { type: "string", minLength: 1, maxLength: MEMORY_FACT_MAX_CHARS },
          type: { type: "string", enum: ["preference", "profile", "relationship", "project", "other"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: MEMORY_EVIDENCE_MAX_CHARS },
          supersedes: { type: "string", maxLength: 200 }
        },
        required: ["subject", "subjectName", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
});

export function normalizeReflectionFacts(rawText: string, maxFacts: number): NormalizedReflectionFact[] {
  const parsed = parseMemoryExtractionJson(rawText);
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts: NormalizedReflectionFact[] = [];
  const validSubjects = new Set(["author", "bot", "lore"]);

  for (const item of rawFacts) {
    if (!item || typeof item !== "object") continue;

    const subject = String(item.subject || "").trim().toLowerCase();
    const fact = normalizeInlineText(item.fact, MEMORY_FACT_MAX_CHARS);
    const evidence = normalizeInlineText(item.evidence, MEMORY_EVIDENCE_MAX_CHARS);
    if (!validSubjects.has(subject) || !fact || !evidence) continue;

    const supersedes = normalizeInlineText(item.supersedes, 200) || "";
    facts.push({
      subject,
      subjectName: normalizeInlineText(item.subjectName, 80) || "",
      fact,
      type: String(item.type || "other").trim().toLowerCase() || "other",
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      evidence,
      ...(supersedes ? { supersedes } : {})
    });
    if (facts.length >= maxFacts) break;
  }

  return facts;
}

export function normalizeStoredFactText(rawFact) {
  const compact = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length < 4) return "";
  if (!/[.!?]$/.test(compact)) return `${compact}.`.slice(0, MEMORY_FACT_MAX_CHARS);
  return compact.slice(0, MEMORY_FACT_MAX_CHARS);
}

export function normalizeFactType(rawType) {
  const normalized = String(rawType || "")
    .trim()
    .toLowerCase();
  return ALLOWED_FACT_TYPES.has(normalized) ? normalized : "other";
}

export function normalizeEvidenceText(rawEvidence, _sourceText) {
  const evidence = sanitizeInline(rawEvidence || "", MEMORY_EVIDENCE_MAX_CHARS);
  return evidence || null;
}

export function buildFactEmbeddingPayload(factRow) {
  const fact = sanitizeInline(factRow?.fact || "", FACT_EMBEDDING_FACT_MAX_CHARS);
  const evidence = sanitizeInline(factRow?.evidence_text || "", FACT_EMBEDDING_EVIDENCE_MAX_CHARS);
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
  return 1 / (1 + ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);
}

const DECAY_EXEMPT_FACT_TYPES = new Set(["guidance", "behavioral"]);

export function computeTemporalDecayMultiplier({
  createdAtIso,
  factType,
  halfLifeDays = 90,
  minMultiplier = 0.2
}) {
  const normalizedFactType = String(factType || "").trim().toLowerCase();
  if (DECAY_EXEMPT_FACT_TYPES.has(normalizedFactType)) return 1;

  const timestamp = Date.parse(String(createdAtIso || ""));
  if (!Number.isFinite(timestamp)) return 1;

  const boundedHalfLifeDays = Math.max(1, Number(halfLifeDays) || 90);
  const boundedMinMultiplier = clamp01(minMultiplier, 0);
  const ageMs = Math.max(0, Date.now() - timestamp);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const lambda = Math.LN2 / boundedHalfLifeDays;
  const rawMultiplier = Math.exp(-lambda * ageDays);
  return Math.max(boundedMinMultiplier, rawMultiplier);
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

function computeFactTokenSimilarity(left, right) {
  const mmrStopwords = new Set([
    "and",
    "for",
    "from",
    "have",
    "that",
    "the",
    "this",
    "user",
    "with",
    "you",
    "your"
  ]);
  const leftRawTokens = extractStableTokens(normalizeHighlightText(left), 80);
  const rightRawTokens = extractStableTokens(normalizeHighlightText(right), 80);
  const leftTokens = new Set(leftRawTokens.filter((token) => !mmrStopwords.has(token)));
  const rightTokens = new Set(rightRawTokens.filter((token) => !mmrStopwords.has(token)));
  const fallbackLeftTokens = leftTokens.size ? leftTokens : new Set(leftRawTokens);
  const fallbackRightTokens = rightTokens.size ? rightTokens : new Set(rightRawTokens);
  if (!fallbackLeftTokens.size || !fallbackRightTokens.size) return 0;

  let overlap = 0;
  for (const token of fallbackLeftTokens) {
    if (fallbackRightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(fallbackLeftTokens.size, fallbackRightTokens.size));
}

export function rerankWithMmr(rows = [], { lambda = 0.7 } = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  if (candidates.length <= 1) return candidates;

  const boundedLambda = clamp01(lambda, 0.7);
  const working = candidates.map((row) => ({
    row,
    relevance: clamp01(row?._score, 0),
    text: `${String(row?.fact || "")} ${String(row?.evidence_text || "")}`.trim()
  }));

  const selected: typeof working = [];
  const remaining = [...working];

  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let redundancy = 0;
      for (const picked of selected) {
        redundancy = Math.max(redundancy, computeFactTokenSimilarity(candidate.text, picked.text));
      }

      const mmrScore = boundedLambda * candidate.relevance - (1 - boundedLambda) * redundancy;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
        continue;
      }
      if (Math.abs(mmrScore - bestScore) <= 1e-9) {
        const current = remaining[bestIndex];
        if (candidate.relevance > current.relevance) {
          bestIndex = index;
        }
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    if (!next) break;
    selected.push(next);
  }

  return selected.map((entry) => entry.row);
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

  return text.slice(0, MEMORY_FACT_MAX_CHARS);
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
      .slice(0, HIGHLIGHT_ENTRY_MAX_CHARS);
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

function parseDailyEntryLine(line) {
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

const SCOPE_FRAGMENT_RE = /\[guild:(\S+)\s+channel:(\S+)\s+message:(\S+)(?:\s+(voice))?\]/;
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
  const isVoice = scopeMatch ? scopeMatch[4] === "voice" : false;
  const content = scopeMatch ? rawText.slice(scopeMatch.index + scopeMatch[0].length).trim() : rawText;

  return {
    timestampIso,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    author,
    authorId,
    guildId,
    channelId,
    messageId,
    isVoice,
    content
  };
}

export function normalizeLoreFactForDisplay(rawFact) {
  return cleanFactForMemory(rawFact);
}

export function normalizeSelfFactForDisplay(rawFact) {
  return cleanFactForMemory(rawFact);
}

export function resolveDirectiveScopeConfig(scope: string | null | undefined): DirectiveScopeConfig {
  const normalizedScope = String(scope || "lore")
    .trim()
    .toLowerCase() as DirectiveScope;

  if (normalizedScope === "self") {
    return {
      scope: "self",
      subject: SELF_SUBJECT,
      defaultFactType: "other",
      keep: 120,
      traceSource: "memory_self_ingest"
    };
  }

  if (normalizedScope === "user") {
    return {
      scope: "user",
      subject: null,
      defaultFactType: "other",
      keep: 120,
      traceSource: "memory_user_ingest"
    };
  }

  return {
    scope: "lore",
    subject: LORE_SUBJECT,
    defaultFactType: "other",
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
  return text.slice(0, MEMORY_LINE_MAX_CHARS);
}

export function isInstructionLikeFactText(line) {
  return isUnsafeMemoryFactText(line) || isBehavioralDirectiveLikeFactText(line);
}

export function isUnsafeMemoryFactText(line) {
  const text = String(line || "").toLowerCase();
  if (!text) return true;
  if (/\[\[[\s\S]*\]\]/.test(text)) return true;
  if (/(?:system|developer|prompt|instruction|policy|jailbreak|override)/.test(text)) return true;
  if (/(?:ignore|disregard|bypass)\s+(?:previous|prior|earlier)/.test(text)) return true;
  if (EN_MEMORY_OUTPUT_RULE_RE.test(text)) return true;
  if (EN_MEMORY_SECRET_RE.test(text)) return true;
  return false;
}

export function isBehavioralDirectiveLikeFactText(line) {
  const text = String(line || "").toLowerCase();
  if (!text) return true;
  if (EN_MEMORY_MODAL_DIRECTIVE_RE.test(text)) return true;
  if (EN_MEMORY_IMPERATIVE_DIRECTIVE_RE.test(text)) return true;
  if (EN_MEMORY_BEHAVIOR_RULE_RE.test(text)) return true;
  if (EN_MEMORY_STYLE_GUIDANCE_RE.test(text)) return true;
  if (EN_MEMORY_BEHAVIOR_VERB_RE.test(text) && EN_MEMORY_FUTURE_BEHAVIOR_RE.test(text)) return true;
  if (EN_MEMORY_ABUSIVE_LABEL_RE.test(text) && EN_MEMORY_BEHAVIOR_VERB_RE.test(text)) return true;
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
  return text.slice(0, 640);
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
