import { clamp01 } from "../normalization/numbers.ts";
import {
  LORE_SUBJECT,
  SELF_SUBJECT,
  computeChannelScopeScore,
  computeLexicalFactScore,
  computeRecencyScore,
  computeTemporalDecayMultiplier,
  extractStableTokens,
  normalizeHighlightText,
  normalizeQueryEmbeddingText,
  passesHybridRelevanceGate
} from "../memory/memoryHelpers.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";
import type {
  VoiceConversationHistoryCacheEntry,
  VoiceConversationHistoryCacheStrategy,
  VoiceSession,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";

const SESSION_BEHAVIORAL_FACT_POOL_LIMIT = 64;
const SESSION_CONVERSATION_HISTORY_CACHE_TTL_MS = 45_000;
const SESSION_CONVERSATION_HISTORY_SIMILARITY_THRESHOLD = 0.58;
const SESSION_BEHAVIORAL_TEMPORAL_HALF_LIFE_DAYS = 90;
const SESSION_BEHAVIORAL_TEMPORAL_MIN_MULTIPLIER = 0.2;
const LOW_SIGNAL_CONVERSATION_QUERIES = new Set([
  "ah",
  "alright",
  "bet",
  "damn",
  "exactly",
  "fair enough",
  "for sure",
  "gotcha",
  "good point",
  "hm",
  "hmm",
  "i know",
  "makes sense",
  "mhm",
  "mm",
  "nah",
  "nope",
  "okay",
  "ok",
  "right",
  "same",
  "totally",
  "true",
  "uh huh",
  "uh-huh",
  "word",
  "wow",
  "yeah",
  "yep",
  "yup"
]);

type SessionCacheCarrier = VoiceSession | VoiceToolRuntimeSessionLike;

type SearchDurableFactsFn = (payload: {
  guildId: string;
  channelId?: string | null;
  queryText: string;
  subjectIds?: string[] | null;
  factTypes?: string[] | null;
  settings: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
  limit?: number;
}) => Promise<MemoryFactRow[]> | MemoryFactRow[];

type SearchConversationHistoryFn = (payload: {
  guildId: string;
  channelId: string | null;
  queryText: string;
  limit: number;
  maxAgeHours: number;
}) => Promise<unknown[]> | unknown[];

type RankBehavioralFactsFn = (payload: {
  candidates: MemoryFactRow[];
  queryText: string;
  channelId?: string | null;
  settings?: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
  limit?: number;
}) => Promise<MemoryFactRow[] | null> | MemoryFactRow[] | null;

function normalizeParticipantIds(participantIds: string[] = []) {
  return [...new Set(
    participantIds
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )].sort();
}

function toBehavioralPromptRows(rows: MemoryFactRow[] = []) {
  return rows.map((row) => {
    const subject = String(row?.subject || "").trim();
    if (subject === SELF_SUBJECT) {
      return { ...row, subjectLabel: "Bot" };
    }
    if (subject === LORE_SUBJECT) {
      return { ...row, subjectLabel: "Shared lore" };
    }
    return row;
  });
}

function rankCachedBehavioralFactsLexically(
  rows: MemoryFactRow[] = [],
  {
    queryText,
    channelId = null,
    limit = 8
  }: {
    queryText: string;
    channelId?: string | null;
    limit?: number;
  }
) {
  const normalizedQuery = normalizeQueryEmbeddingText(queryText);
  if (!normalizedQuery) return [];

  const queryTokens = extractStableTokens(normalizedQuery, 32);
  const queryCompact = normalizeHighlightText(normalizedQuery);
  const normalizedChannelId = String(channelId || "").trim() || null;
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(Number(limit) || 8)));

  const scored = toBehavioralPromptRows(rows).map((row) => {
    const lexicalScore = computeLexicalFactScore(row, { queryTokens, queryCompact });
    const recencyScore = computeRecencyScore(row.created_at);
    const confidenceScore = clamp01(row.confidence, 0.5);
    const channelScore = computeChannelScopeScore(row.channel_id, normalizedChannelId);
    const combined =
      0.75 * lexicalScore +
      0.1 * confidenceScore +
      0.1 * recencyScore +
      0.05 * channelScore;
    const temporalMultiplier = computeTemporalDecayMultiplier({
      createdAtIso: row.created_at,
      factType: row.fact_type,
      halfLifeDays: SESSION_BEHAVIORAL_TEMPORAL_HALF_LIFE_DAYS,
      minMultiplier: SESSION_BEHAVIORAL_TEMPORAL_MIN_MULTIPLIER
    });

    return {
      ...row,
      _score: Number((combined * temporalMultiplier).toFixed(6)),
      _semanticScore: 0,
      _lexicalScore: Number(lexicalScore.toFixed(6))
    };
  }).sort((left, right) => {
    if (right._score !== left._score) return right._score - left._score;
    return Date.parse(String(right.created_at || "")) - Date.parse(String(left.created_at || ""));
  });

  return scored
    .filter((row) => passesHybridRelevanceGate({ row, semanticAvailable: false }))
    .slice(0, boundedLimit)
    .map(({ _score: _ignoredScore, _semanticScore: _ignoredSemantic, _lexicalScore: _ignoredLexical, ...row }) => row);
}

function normalizeConversationQueryForSignalCheck(queryText: string) {
  return String(queryText || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowSignalConversationQuery(queryText: string) {
  const compactQuery = normalizeConversationQueryForSignalCheck(queryText);
  if (!compactQuery) return true;
  if (LOW_SIGNAL_CONVERSATION_QUERIES.has(compactQuery)) return true;
  if (/^(?:ha|he|hi|ho){2,}$/.test(compactQuery.replace(/\s+/g, ""))) return true;
  if (/^(?:l+o+l+|lmao|lmfao|rofl)$/.test(compactQuery.replace(/\s+/g, ""))) return true;
  return false;
}

function getConversationQuerySimilarity({
  currentQuery,
  cachedQuery,
  currentTokens,
  cachedTokens
}: {
  currentQuery: string;
  cachedQuery: string;
  currentTokens: string[];
  cachedTokens: string[];
}) {
  if (!currentQuery || !cachedQuery) return 0;
  if (currentQuery === cachedQuery) return 1;
  if (currentQuery.includes(cachedQuery) || cachedQuery.includes(currentQuery)) {
    return 0.92;
  }
  if (!currentTokens.length || !cachedTokens.length) return 0;

  const currentSet = new Set(currentTokens);
  const cachedSet = new Set(cachedTokens);
  let overlap = 0;
  for (const token of currentSet) {
    if (cachedSet.has(token)) overlap += 1;
  }
  const unionSize = new Set([...currentSet, ...cachedSet]).size;
  if (!unionSize) return 0;
  return overlap / unionSize;
}

function matchesConversationHistoryCacheScope(
  entry: VoiceConversationHistoryCacheEntry | null,
  {
    strategy,
    guildId,
    channelId,
    limit,
    maxAgeHours
  }: {
    strategy: VoiceConversationHistoryCacheStrategy;
    guildId: string;
    channelId?: string | null;
    limit: number;
    maxAgeHours: number;
  }
) {
  if (!entry) return false;
  if (entry.strategy !== strategy) return false;
  if (entry.guildId !== guildId) return false;
  if ((entry.channelId || null) !== (String(channelId || "").trim() || null)) return false;
  if (entry.limit !== limit || entry.maxAgeHours !== maxAgeHours) return false;
  return true;
}

function isConversationHistoryCacheFresh(entry: VoiceConversationHistoryCacheEntry | null) {
  if (!entry) return false;
  return Date.now() - Number(entry.loadedAt || 0) <= SESSION_CONVERSATION_HISTORY_CACHE_TTL_MS;
}

function shouldReuseConversationHistoryCache(
  entry: VoiceConversationHistoryCacheEntry | null,
  {
    strategy,
    guildId,
    channelId,
    queryText,
    limit,
    maxAgeHours
  }: {
    strategy: VoiceConversationHistoryCacheStrategy;
    guildId: string;
    channelId?: string | null;
    queryText: string;
    limit: number;
    maxAgeHours: number;
  }
) {
  if (!matchesConversationHistoryCacheScope(entry, {
    strategy,
    guildId,
    channelId,
    limit,
    maxAgeHours
  })) {
    return false;
  }
  if (!isConversationHistoryCacheFresh(entry)) return false;
  const normalizedQuery = normalizeQueryEmbeddingText(queryText);
  const queryTokens = extractStableTokens(normalizedQuery, 24);

  const similarity = getConversationQuerySimilarity({
    currentQuery: normalizedQuery,
    cachedQuery: entry.queryText,
    currentTokens: queryTokens,
    cachedTokens: Array.isArray(entry.queryTokens) ? entry.queryTokens : []
  });
  return similarity >= SESSION_CONVERSATION_HISTORY_SIMILARITY_THRESHOLD;
}

function getConversationHistoryCacheEntry(
  session: SessionCacheCarrier | null,
  strategy: VoiceConversationHistoryCacheStrategy
) {
  const caches =
    session?.conversationHistoryCaches && typeof session.conversationHistoryCaches === "object"
      ? session.conversationHistoryCaches
      : null;
  const entry = caches?.[strategy];
  return entry && typeof entry === "object" ? entry : null;
}

function setConversationHistoryCacheEntry(
  session: SessionCacheCarrier | null,
  strategy: VoiceConversationHistoryCacheStrategy,
  entry: VoiceConversationHistoryCacheEntry
) {
  if (!session) return;
  const existing =
    session.conversationHistoryCaches && typeof session.conversationHistoryCaches === "object"
      ? session.conversationHistoryCaches
      : {};
  session.conversationHistoryCaches = {
    ...existing,
    [strategy]: entry
  };
}

export function invalidateSessionBehavioralMemoryCache(session: SessionCacheCarrier | null) {
  if (!session) return;
  session.behavioralFactCache = null;
}

export async function loadSessionBehavioralMemoryFacts({
  session,
  searchDurableFacts,
  rankBehavioralFacts = null,
  guildId,
  channelId = null,
  queryText = "",
  participantIds = [],
  settings = null,
  trace = {},
  limit = 8
}: {
  session: SessionCacheCarrier | null;
  searchDurableFacts?: SearchDurableFactsFn | null;
  rankBehavioralFacts?: RankBehavioralFactsFn | null;
  guildId: string;
  channelId?: string | null;
  queryText?: string;
  participantIds?: string[];
  settings?: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
  limit?: number;
}): Promise<MemoryFactRow[] | null> {
  if (!session || typeof searchDurableFacts !== "function") return null;

  const normalizedGuildId = String(guildId || "").trim();
  const normalizedQuery = normalizeQueryEmbeddingText(queryText);
  if (!normalizedGuildId || !normalizedQuery) return [];

  const normalizedParticipantIds = normalizeParticipantIds(participantIds);
  const participantKey = normalizedParticipantIds.join("|");
  const cachedEntry =
    session.behavioralFactCache && typeof session.behavioralFactCache === "object"
      ? session.behavioralFactCache
      : null;

  let factCacheEntry = cachedEntry;
  if (
    !factCacheEntry ||
    factCacheEntry.guildId !== normalizedGuildId ||
    factCacheEntry.participantKey !== participantKey ||
    !Array.isArray(factCacheEntry.facts)
  ) {
    try {
      const rows = await searchDurableFacts({
        guildId: normalizedGuildId,
        channelId: String(channelId || "").trim() || null,
        queryText: "__ALL__",
        subjectIds: [SELF_SUBJECT, LORE_SUBJECT, ...normalizedParticipantIds],
        factTypes: ["behavioral"],
        settings: settings || null,
        trace: {
          ...trace,
          source: String(trace?.source || "voice_session_behavioral_memory_cache")
        },
        limit: SESSION_BEHAVIORAL_FACT_POOL_LIMIT
      });
      factCacheEntry = {
        guildId: normalizedGuildId,
        participantKey,
        loadedAt: Date.now(),
        facts: Array.isArray(rows) ? rows : []
      };
      session.behavioralFactCache = factCacheEntry;
    } catch {
      return null;
    }
  }

  if (typeof rankBehavioralFacts === "function") {
    try {
      const ranked = await rankBehavioralFacts({
        candidates: factCacheEntry.facts,
        queryText: normalizedQuery,
        channelId,
        settings,
        trace,
        limit
      });
      if (Array.isArray(ranked)) {
        return toBehavioralPromptRows(ranked).slice(0, Math.max(1, Math.min(12, Math.floor(Number(limit) || 8))));
      }
    } catch {
      return null;
    }
  }

  return rankCachedBehavioralFactsLexically(factCacheEntry.facts, {
    queryText: normalizedQuery,
    channelId,
    limit
  });
}

export async function loadSessionConversationHistory({
  session,
  loadRecentConversationHistory,
  strategy = "semantic",
  guildId,
  channelId = null,
  queryText = "",
  limit,
  maxAgeHours
}: {
  session: SessionCacheCarrier | null;
  loadRecentConversationHistory?: SearchConversationHistoryFn | null;
  strategy?: VoiceConversationHistoryCacheStrategy;
  guildId: string;
  channelId?: string | null;
  queryText?: string;
  limit: number;
  maxAgeHours: number;
}) {
  if (!session || typeof loadRecentConversationHistory !== "function") return [];

  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedQuery = normalizeQueryEmbeddingText(queryText);
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const boundedMaxAgeHours = Math.max(1, Math.floor(Number(maxAgeHours) || 1));
  if (!normalizedGuildId || !normalizedQuery) return [];

  const cachedEntry = getConversationHistoryCacheEntry(session, strategy);
  if (isLowSignalConversationQuery(normalizedQuery)) {
    if (matchesConversationHistoryCacheScope(cachedEntry, {
      strategy,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit,
      maxAgeHours: boundedMaxAgeHours
    }) && isConversationHistoryCacheFresh(cachedEntry)) {
      return Array.isArray(cachedEntry?.windows) ? cachedEntry.windows : [];
    }
    return [];
  }

  if (shouldReuseConversationHistoryCache(cachedEntry, {
    strategy,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    queryText: normalizedQuery,
    limit: boundedLimit,
    maxAgeHours: boundedMaxAgeHours
  })) {
    return Array.isArray(cachedEntry?.windows) ? cachedEntry.windows : [];
  }

  const windows = await loadRecentConversationHistory({
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    queryText: normalizedQuery,
    limit: boundedLimit,
    maxAgeHours: boundedMaxAgeHours
  });
  const normalizedWindows = Array.isArray(windows) ? windows : [];
  setConversationHistoryCacheEntry(session, strategy, {
    strategy,
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    queryText: normalizedQuery,
    queryTokens: extractStableTokens(normalizedQuery, 24),
    limit: boundedLimit,
    maxAgeHours: boundedMaxAgeHours,
    loadedAt: Date.now(),
    windows: normalizedWindows
  });
  return normalizedWindows;
}
