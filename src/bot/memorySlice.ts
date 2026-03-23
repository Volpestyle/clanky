import { collectMemoryFactHints } from "./botHelpers.ts";
import { isOwnerPrivateContext } from "../memory/memoryContext.ts";
import { clamp } from "../utils.ts";
import type { BotContext } from "./botContext.ts";

type MemoryTrace = Record<string, unknown> & {
  source?: string;
};

type MemorySettings = {
  memory?: {
    enabled?: boolean;
  };
} & Record<string, unknown>;

type FactProfileSlice = {
  participantProfiles: Array<Record<string, unknown>>;
  selfFacts: Array<Record<string, unknown>>;
  loreFacts: Array<Record<string, unknown>>;
  ownerFacts: Array<Record<string, unknown>>;
  userFacts: Array<Record<string, unknown>>;
  relevantFacts: Array<Record<string, unknown>>;
  guidanceFacts: Array<Record<string, unknown>>;
};

type LoadFactProfileOptions = {
  settings: MemorySettings;
  userId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  queryText?: string;
  recentMessages?: Array<Record<string, unknown>>;
  trace?: MemoryTrace;
  source?: string;
};

export function emptyFactProfileSlice(): FactProfileSlice {
  return {
    participantProfiles: [],
    selfFacts: [],
    loreFacts: [],
    ownerFacts: [],
    userFacts: [],
    relevantFacts: [],
    guidanceFacts: []
  };
}

export function normalizeFactProfileSlice(slice: unknown): FactProfileSlice {
  const value = slice && typeof slice === "object" && !Array.isArray(slice)
    ? slice as Record<string, unknown>
    : {};
  return {
    participantProfiles: Array.isArray(value.participantProfiles)
      ? value.participantProfiles as Array<Record<string, unknown>>
      : [],
    selfFacts: Array.isArray(value.selfFacts) ? value.selfFacts as Array<Record<string, unknown>> : [],
    loreFacts: Array.isArray(value.loreFacts) ? value.loreFacts as Array<Record<string, unknown>> : [],
    ownerFacts: Array.isArray(value.ownerFacts) ? value.ownerFacts as Array<Record<string, unknown>> : [],
    userFacts: Array.isArray(value.userFacts) ? value.userFacts as Array<Record<string, unknown>> : [],
    relevantFacts: Array.isArray(value.relevantFacts) ? value.relevantFacts as Array<Record<string, unknown>> : [],
    guidanceFacts: Array.isArray(value.guidanceFacts) ? value.guidanceFacts as Array<Record<string, unknown>> : []
  };
}

type BuildMediaMemoryFactsOptions = {
  userFacts?: Array<Record<string, unknown> | string>;
  relevantFacts?: Array<Record<string, unknown> | string>;
  maxItems?: number;
};

type ScopedFallbackFactsOptions = {
  guildId?: string | null;
  channelId?: string | null;
  limit?: number;
};

type LoadRelevantMemoryFactsOptions = {
  settings: MemorySettings;
  guildId: string;
  channelId?: string | null;
  queryText?: string;
  trace?: MemoryTrace;
  limit?: number;
  fallbackWhenNoMatch?: boolean;
};

function collectConversationParticipants(
  recentMessages: Array<Record<string, unknown>> = [],
  {
    focusUserId = null,
    botUserId = null
  }: {
    focusUserId?: string | null;
    botUserId?: string | null;
  } = {}
) {
  const normalizedFocusUserId = String(focusUserId || "").trim() || null;
  const normalizedBotUserId = String(botUserId || "").trim() || null;
  const byUserId = new Map<string, string>();

  for (const row of Array.isArray(recentMessages) ? recentMessages : []) {
    const userId = String(row?.author_id || row?.authorId || "").trim();
    if (!userId || userId === normalizedBotUserId) continue;
    const displayName = String(row?.author_name || row?.authorName || "").trim() || userId;
    if (!byUserId.has(userId)) {
      byUserId.set(userId, displayName);
    }
  }

  if (normalizedFocusUserId && !byUserId.has(normalizedFocusUserId)) {
    byUserId.set(normalizedFocusUserId, normalizedFocusUserId);
  }

  const ordered = [...byUserId.entries()]
    .map(([userId, displayName]) => ({
      userId,
      displayName,
      isPrimary: userId === normalizedFocusUserId
    }))
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

  return {
    participantIds: ordered.map((entry) => entry.userId),
    participantNames: Object.fromEntries(ordered.map((entry) => [entry.userId, entry.displayName]))
  };
}

export function loadFactProfile(
  ctx: BotContext,
  {
    settings,
    userId = null,
    guildId,
    channelId = null,
    queryText: _queryText = "",
    recentMessages = [],
    trace: _trace = {},
    source = "fact_profile"
  }: LoadFactProfileOptions
) {
  const empty = emptyFactProfileSlice();
  if (!settings?.memory?.enabled || typeof ctx.memory?.loadFactProfile !== "function") {
    return empty;
  }

  const normalizedGuildId = String(guildId || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedSource = String(source || "fact_profile").trim() || "fact_profile";
  const participants = collectConversationParticipants(recentMessages, {
    focusUserId: normalizedUserId,
    botUserId: ctx.botUserId || null
  });

  try {
    const factProfile = normalizeFactProfileSlice(ctx.memory.loadFactProfile({
      userId: normalizedUserId,
      guildId: normalizedGuildId,
      participantIds: participants.participantIds,
      participantNames: participants.participantNames,
      includeOwner: isOwnerPrivateContext({
        guildId: normalizedGuildId,
        actorUserId: normalizedUserId
      })
    }));
    return factProfile;
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId || null,
      channelId: normalizedChannelId,
      userId: normalizedUserId,
      content: `${normalizedSource}: ${String(error?.message || error)}`
    });
    return empty;
  }
}

export function buildMediaMemoryFacts({
  userFacts = [],
  relevantFacts = [],
  maxItems = 5
}: BuildMediaMemoryFactsOptions = {}) {
  const merged = [
    ...(Array.isArray(userFacts) ? userFacts : []),
    ...(Array.isArray(relevantFacts) ? relevantFacts : [])
  ];
  const max = clamp(Math.floor(Number(maxItems) || 5), 1, 8);
  return collectMemoryFactHints(merged, max);
}

export function getScopedFallbackFacts(
  ctx: BotContext,
  { guildId, channelId = null, limit = 8 }: ScopedFallbackFactsOptions
) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId || typeof ctx.store?.getFactsForScope !== "function") return [];

  const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
  const candidateLimit = clamp(boundedLimit * 4, boundedLimit, 120);
  const rows = ctx.store.getFactsForScope({
    guildId: normalizedGuildId,
    limit: candidateLimit
  });
  if (!rows.length) return [];

  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedChannelId) return rows.slice(0, boundedLimit);

  const sameChannel = [];
  const noChannel = [];
  const otherChannel = [];
  for (const row of rows) {
    const rowChannelId = String(row?.channel_id || "").trim();
    if (rowChannelId && rowChannelId === normalizedChannelId) {
      sameChannel.push(row);
      continue;
    }
    if (!rowChannelId) {
      noChannel.push(row);
      continue;
    }
    otherChannel.push(row);
  }

  return [...sameChannel, ...noChannel, ...otherChannel].slice(0, boundedLimit);
}

export async function loadRelevantMemoryFacts(
  ctx: BotContext,
  {
    settings,
    guildId,
    channelId = null,
    queryText = "",
    trace = {},
    limit = 8,
    fallbackWhenNoMatch = true
  }: LoadRelevantMemoryFactsOptions
) {
  if (!settings?.memory?.enabled || !ctx.memory?.searchDurableFacts) return [];

  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];

  const normalizedChannelId = String(channelId || "").trim() || null;
  const boundedLimit = clamp(Math.floor(Number(limit) || 8), 1, 24);
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  if (!normalizedQuery) {
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  }

  try {
    const results = await ctx.memory.searchDurableFacts({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      queryText: normalizedQuery,
      settings,
      trace: {
        ...trace,
        source: trace?.source || "memory_context"
      },
      limit: boundedLimit
    });
    if (results.length || !fallbackWhenNoMatch) return results;
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      content: `memory_context: ${String(error?.message || error)}`,
      metadata: {
        queryText: normalizedQuery.slice(0, 120),
        source: trace?.source || "memory_context"
      }
    });
    return getScopedFallbackFacts(ctx, {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      limit: boundedLimit
    });
  }
}

export async function loadBehavioralMemoryFacts(
  ctx: BotContext,
  {
    settings,
    guildId,
    channelId = null,
    queryText = "",
    participantIds = [],
    trace = {},
    limit = 8
  }: {
    settings: MemorySettings;
    guildId: string;
    channelId?: string | null;
    queryText?: string;
    participantIds?: string[];
    trace?: MemoryTrace;
    limit?: number;
  }
) {
  if (!settings?.memory?.enabled || typeof ctx.memory?.loadBehavioralFactsForPrompt !== "function") return [];

  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];

  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
  if (!normalizedQuery) return [];

  try {
    return await ctx.memory.loadBehavioralFactsForPrompt({
      guildId: normalizedGuildId,
      channelId: String(channelId || "").trim() || null,
      queryText: normalizedQuery,
      participantIds,
      settings,
      trace: {
        ...trace,
        source: trace?.source || "behavioral_memory_context"
      },
      limit
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: String(channelId || "").trim() || null,
      content: `behavioral_memory_context: ${String(error?.message || error)}`,
      metadata: {
        queryText: normalizedQuery.slice(0, 120),
        source: trace?.source || "behavioral_memory_context"
      }
    });
    return [];
  }
}
