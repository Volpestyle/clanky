import { deepMerge, sanitizeBotText, sleep } from "../utils.ts";
import {
  buildInitiativePrompt,
  buildSystemPrompt
} from "../prompts/index.ts";
import {
  getMediaPromptCraftGuidance,
  getPromptStyle
} from "../prompts/promptCore.ts";
import {
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  extractUrlsFromText,
  INITIATIVE_OUTPUT_JSON_SCHEMA,
  normalizeSkipSentinel,
  parseStructuredInitiativeOutput,
  splitDiscordMessage
} from "./botHelpers.ts";
import {
  getBotName,
  getDiscoverySettings,
  getMemorySettings,
  getReplyPermissions,
  getResolvedTextInitiativeBinding,
  isResearchEnabled,
  getTextInitiativeSettings
} from "../settings/agentStack.ts";
import { loadBehavioralMemoryFacts } from "./memorySlice.ts";
import {
  buildContextContentBlocks,
  type ContentBlock,
  type ContextMessage
} from "../llm/serviceShared.ts";
import { executeReplyTool } from "../tools/replyTools.ts";
import type { ReplyToolContext, ReplyToolRuntime } from "../tools/replyTools.ts";
import {
  BROWSER_BROWSE_SCHEMA,
  DISCOVERY_SOURCE_ADD_SCHEMA,
  DISCOVERY_SOURCE_LIST_SCHEMA,
  DISCOVERY_SOURCE_REMOVE_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  WEB_SCRAPE_SCHEMA,
  WEB_SEARCH_SCHEMA,
  toAnthropicTool
} from "../tools/sharedToolSchemas.ts";
import { normalizeDiscoveryUrl } from "../services/discovery.ts";
import type { BotContext } from "./botContext.ts";

const INITIATIVE_TICK_MAX_RUNTIME_MS = 30_000;
const INITIATIVE_SOURCE_STATS_WINDOW_DAYS = 14;
const INITIATIVE_LOOKBACK_MAX_CHANNEL_MESSAGES = 5;
const INITIATIVE_MIN_GAP_ACTION_KINDS = [
  "initiative_post",
  "initiative_skip"
] as const;
const SOURCE_TYPE_LABELS = {
  reddit: "Reddit",
  rss: "RSS",
  youtube: "YouTube",
  x: "X"
} as const;

const INTEREST_STOP_WORDS = new Set([
  "about",
  "again",
  "also",
  "been",
  "cant",
  "dont",
  "from",
  "have",
  "just",
  "like",
  "more",
  "only",
  "really",
  "some",
  "that",
  "their",
  "there",
  "they",
  "this",
  "want",
  "with",
  "would",
  "your"
]);

type InitiativeGuildLike = {
  id?: string;
};

type InitiativeChannelLike = {
  id: string;
  guildId?: string;
  name?: string;
  guild?: InitiativeGuildLike | null;
  isTextBased?: () => boolean;
  send?: (payload: unknown) => Promise<{
    id: string;
    createdTimestamp: number;
    guildId: string;
    channelId: string;
  }>;
  sendTyping?: () => Promise<unknown>;
  messages?: {
    fetch?: (messageId: string) => Promise<{
      reply: (payload: unknown) => Promise<{
        id: string;
        createdTimestamp: number;
        guildId: string;
        channelId: string;
      }>;
    }>;
  };
};

type InitiativeClientLike = BotContext["client"] & {
  user?: {
    id?: string;
    username?: string;
  } | null;
  channels: {
    cache: {
      get: (id: string) => InitiativeChannelLike | undefined;
    };
  };
};

type StoredMessageRow = {
  message_id?: string;
  created_at?: string;
  guild_id?: string | null;
  channel_id?: string;
  author_id?: string;
  author_name?: string;
  is_bot?: boolean | number;
  content?: string;
  referenced_message_id?: string | null;
};

type DiscoveryCandidate = {
  title?: string;
  url?: string;
  source?: string;
  sourceLabel?: string;
  excerpt?: string;
  publishedAt?: string | null;
};

type InitiativePendingThoughtStatus = "queued" | "reconsider";
type InitiativePendingThoughtAction = "post_now" | "hold" | "drop";

export type InitiativePendingThought = {
  id: string;
  guildId: string;
  channelId: string;
  channelName: string;
  trigger: string;
  draftText: string;
  currentText: string;
  createdAt: number;
  updatedAt: number;
  basisAt: number;
  notBeforeAt: number;
  expiresAt: number;
  revision: number;
  status: InitiativePendingThoughtStatus;
  lastDecisionReason: string | null;
  lastDecisionAction: InitiativePendingThoughtAction | null;
  mediaDirective: "none" | "image" | "video" | "gif";
  mediaPrompt: string | null;
};

export type InitiativeRuntime = BotContext & {
  readonly client: InitiativeClientLike;
  readonly discovery: {
    collect: (payload: {
      settings: Record<string, unknown>;
      guildId: string;
      channelId: string;
      channelName: string;
      recentMessages: StoredMessageRow[];
    }) => Promise<{
      enabled: boolean;
      topics: string[];
      candidates: DiscoveryCandidate[];
      selected: DiscoveryCandidate[];
      reports: Array<{
        source?: string;
        fetched?: number;
        accepted?: number;
        error?: string | null;
      }>;
      errors: string[];
    }>;
  } | null;
  readonly search: ReplyToolRuntime["search"];
  initiativeCycleRunning: boolean;
  getPendingInitiativeThoughts: () => Map<string, InitiativePendingThought>;
  getPendingInitiativeThought: (guildId: string) => InitiativePendingThought | null;
  setPendingInitiativeThought: (guildId: string, thought: InitiativePendingThought | null) => void;
  canSendMessage: (maxPerHour: number) => boolean;
  canTalkNow: (settings: Record<string, unknown>) => boolean;
  hydrateRecentMessages: (channel: InitiativeChannelLike, limit: number) => Promise<unknown[]>;
  isChannelAllowed: (settings: Record<string, unknown>, channelId: string) => boolean;
  isNonPrivateReplyEligibleChannel: (channel: InitiativeChannelLike | null | undefined) => boolean;
  getSimulatedTypingDelayMs: (minMs: number, jitterMs: number) => number;
  markSpoke: () => void;
  composeMessageContentForHistory: (message: unknown, baseText?: string) => string;
  loadRelevantMemoryFacts: (payload: {
    settings: Record<string, unknown>;
    guildId?: string | null;
    channelId?: string | null;
    queryText?: string;
    trace?: Record<string, unknown>;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  buildMediaMemoryFacts: (payload: {
    userFacts: Array<Record<string, unknown>>;
    relevantFacts: Array<Record<string, unknown>>;
  }) => string[];
  getImageBudgetState: (settings: Record<string, unknown>) => {
    canGenerate: boolean;
    remaining: number;
  };
  getVideoGenerationBudgetState: (settings: Record<string, unknown>) => {
    canGenerate: boolean;
    remaining: number;
  };
  getGifBudgetState: (settings: Record<string, unknown>) => {
    canFetch: boolean;
    remaining: number;
  };
  getMediaGenerationCapabilities: (settings: Record<string, unknown>) => {
    simpleImageReady: boolean;
    complexImageReady: boolean;
    videoReady: boolean;
  };
  resolveMediaAttachment: (payload: {
    settings: Record<string, unknown>;
    text: string;
    directive: {
      type: string | null;
      gifQuery?: string | null;
      imagePrompt?: string | null;
      complexImagePrompt?: string | null;
      videoPrompt?: string | null;
    };
    trace: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      source?: string;
    };
  }) => Promise<{
    payload: {
      content: string;
      files?: unknown[];
    };
    media: unknown;
  }>;
  buildBrowserBrowseContext: (settings: Record<string, unknown>) => {
    enabled?: boolean;
    configured?: boolean;
    budget?: {
      canBrowse?: boolean;
    };
  };
  runModelRequestedBrowserBrowse: (payload: {
    settings: Record<string, unknown>;
    browserBrowse: {
      enabled?: boolean;
      configured?: boolean;
      budget?: {
        canBrowse?: boolean;
      };
    };
    query?: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    source?: string;
    signal?: AbortSignal;
  }) => Promise<{
    used?: boolean;
    text?: string;
    steps?: number;
    hitStepLimit?: boolean;
    error?: string | null;
    blockedByBudget?: boolean;
  }>;
};

type InitiativeChannelSummary = {
  guildId: string;
  channelId: string;
  channelName: string;
  channel: InitiativeChannelLike;
  recentMessages: StoredMessageRow[];
  recentHumanMessageCount: number;
  lastHumanAt: string | null;
  lastHumanMessageId: string | null;
  lastHumanAuthorName: string | null;
  lastHumanSnippet: string | null;
  lastBotAt: string | null;
};

type InitiativeSourceStat = {
  label: string;
  sharedCount: number;
  fetchedCount: number;
  engagementCount: number;
  lastUsedAt: string | null;
};

const INITIATIVE_PENDING_THOUGHT_REVISIT_MS = 30_000;
const INITIATIVE_PENDING_THOUGHT_MIN_EXPIRY_MS = 30 * 60_000;
const INITIATIVE_PENDING_THOUGHT_HARD_MAX_AGE_MS = 2 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePendingInitiativeThought(
  thought: InitiativePendingThought | null | undefined
): InitiativePendingThought | null {
  if (!thought || typeof thought !== "object") return null;
  const currentText = sanitizeBotText(String(thought.currentText || "").trim(), 1800);
  if (!currentText) return null;
  const guildId = String(thought.guildId || "").trim();
  const channelId = String(thought.channelId || "").trim();
  if (!guildId || !channelId) return null;
  const rawMediaDirective = String(thought.mediaDirective || "none").trim().toLowerCase();
  const mediaDirective =
    rawMediaDirective === "image" || rawMediaDirective === "video" || rawMediaDirective === "gif"
      ? rawMediaDirective
      : "none";
  const mediaPrompt = mediaDirective === "none"
    ? null
    : sanitizeBotText(String(thought.mediaPrompt || "").trim(), 900) || null;
  return {
    ...thought,
    guildId,
    channelId,
    channelName: String(thought.channelName || channelId).trim() || channelId,
    trigger: String(thought.trigger || "timer").trim() || "timer",
    draftText: sanitizeBotText(String(thought.draftText || currentText).trim(), 1800) || currentText,
    currentText,
    revision: Math.max(1, Number(thought.revision || 1)),
    status: thought.status === "reconsider" ? "reconsider" : "queued",
    lastDecisionReason: String(thought.lastDecisionReason || "").trim() || null,
    lastDecisionAction:
      thought.lastDecisionAction === "post_now" || thought.lastDecisionAction === "hold" || thought.lastDecisionAction === "drop"
        ? thought.lastDecisionAction
        : null,
    mediaDirective,
    mediaPrompt
  };
}

function clearPendingInitiativeThought(
  runtime: InitiativeRuntime,
  guildId: string,
  {
    reason = "cleared",
    trigger = "timer",
    now = Date.now()
  }: {
    reason?: string;
    trigger?: string;
    now?: number;
  } = {}
) {
  const pendingThought = normalizePendingInitiativeThought(runtime.getPendingInitiativeThought(guildId));
  runtime.setPendingInitiativeThought(guildId, null);
  if (!pendingThought) return null;
  runtime.store.logAction({
    kind: "initiative_skip",
    guildId,
    channelId: pendingThought.channelId,
    userId: runtime.client.user?.id || null,
    content: `pending_thought_${reason}`,
    metadata: {
      thoughtId: pendingThought.id,
      thoughtText: pendingThought.currentText,
      thoughtRevision: pendingThought.revision,
      trigger,
      ageMs: Math.max(0, Math.round(now - Number(pendingThought.createdAt || now)))
    }
  });
  return pendingThought;
}

function resolvePendingInitiativeThoughtExpiryAt(
  existingThought: InitiativePendingThought | null,
  minGapMs: number,
  now = Date.now()
) {
  const createdAt = Number(existingThought?.createdAt || now);
  const rollingExpiryAt = now + Math.max(INITIATIVE_PENDING_THOUGHT_MIN_EXPIRY_MS, minGapMs * 2);
  const boundedExpiryAt = Math.min(createdAt + INITIATIVE_PENDING_THOUGHT_HARD_MAX_AGE_MS, rollingExpiryAt);
  const previousExpiryAt = Number(existingThought?.expiresAt || 0);
  return previousExpiryAt > 0 ? Math.min(previousExpiryAt, boundedExpiryAt) : boundedExpiryAt;
}

function pendingInitiativeThoughtIsExpired(
  thought: InitiativePendingThought | null | undefined,
  now = Date.now()
) {
  if (!thought) return false;
  const expiresAt = Number(thought.expiresAt || 0);
  const createdAt = Number(thought.createdAt || 0);
  const hardExpiresAt = createdAt > 0 ? createdAt + INITIATIVE_PENDING_THOUGHT_HARD_MAX_AGE_MS : 0;
  return (
    (expiresAt > 0 && now >= expiresAt) ||
    (hardExpiresAt > 0 && now >= hardExpiresAt)
  );
}

function savePendingInitiativeThought(
  runtime: InitiativeRuntime,
  {
    guildId,
    channelId,
    channelName,
    trigger,
    draftText,
    thoughtText,
    mediaDirective,
    mediaPrompt,
    reason,
    minGapMs,
    existingThought = null,
    now = Date.now()
  }: {
    guildId: string;
    channelId: string;
    channelName: string;
    trigger: string;
    draftText: string;
    thoughtText: string;
    mediaDirective: "none" | "image" | "video" | "gif";
    mediaPrompt: string | null;
    reason: string;
    minGapMs: number;
    existingThought?: InitiativePendingThought | null;
    now?: number;
  }
) {
  const currentText = sanitizeBotText(String(thoughtText || "").trim(), 1800);
  if (!currentText) {
    return clearPendingInitiativeThought(runtime, guildId, {
      reason: "empty_hold_thought",
      trigger,
      now
    });
  }
  const expiresAt = resolvePendingInitiativeThoughtExpiryAt(existingThought, minGapMs, now);
  if (expiresAt <= now) {
    return clearPendingInitiativeThought(runtime, guildId, {
      reason: "expired",
      trigger,
      now
    });
  }
  const nextThought: InitiativePendingThought = {
    id: existingThought?.id || `${guildId}:initiative:${now.toString(36)}`,
    guildId,
    channelId,
    channelName,
    trigger: String(trigger || existingThought?.trigger || "timer").trim() || "timer",
    draftText: sanitizeBotText(String(draftText || currentText).trim(), 1800) || currentText,
    currentText,
    createdAt: existingThought?.createdAt || now,
    updatedAt: now,
    basisAt: now,
    notBeforeAt: now + INITIATIVE_PENDING_THOUGHT_REVISIT_MS,
    expiresAt,
    revision: existingThought ? Math.max(1, Number(existingThought.revision || 1)) + 1 : 1,
    status: "queued",
    lastDecisionReason: String(reason || "").trim() || null,
    lastDecisionAction: "hold",
    mediaDirective,
    mediaPrompt
  };
  runtime.setPendingInitiativeThought(guildId, nextThought);
  runtime.store.logAction({
    kind: "initiative_skip",
    guildId,
    channelId,
    userId: runtime.client.user?.id || null,
    content: existingThought ? "pending_thought_updated" : "pending_thought_created",
    metadata: {
      thoughtId: nextThought.id,
      thoughtText: nextThought.currentText,
      thoughtRevision: nextThought.revision,
      trigger,
      notBeforeAt: new Date(nextThought.notBeforeAt).toISOString(),
      expiresAt: new Date(nextThought.expiresAt).toISOString(),
      mediaDirective: nextThought.mediaDirective,
      reason: nextThought.lastDecisionReason
    }
  });
  return nextThought;
}

function buildInitiativeGenerationSettings(settings: Record<string, unknown>) {
  const binding = getResolvedTextInitiativeBinding(settings);
  return deepMerge(deepMerge({}, settings), {
    agentStack: {
      overrides: {
        orchestrator: {
          provider: binding.provider,
          model: binding.model
        }
      }
    },
    interaction: {
      replyGeneration: {
        temperature: binding.temperature,
        maxOutputTokens: binding.maxOutputTokens,
        reasoningEffort: binding.reasoningEffort
      }
    }
  });
}

function countRecentActions(store: InitiativeRuntime["store"], kind: string, sinceIso: string) {
  return Number(store.countActionsSince(kind, sinceIso) || 0);
}

export function getEligibleInitiativeChannelIds(settings: Record<string, unknown>) {
  const permissions = getReplyPermissions(settings);
  // The reply-channel list is the canonical unified initiative pool.
  return [...new Set(
    (Array.isArray(permissions.replyChannelIds) ? permissions.replyChannelIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

function getLastActionTimes(store: InitiativeRuntime["store"], kinds: string[]) {
  return kinds
    .map((kind) => store.getLastActionTime(kind))
    .filter(Boolean)
    .map((value) => Date.parse(String(value)))
    .filter((value) => Number.isFinite(value));
}

function buildEligibleChannels(runtime: InitiativeRuntime, settings: Record<string, unknown>) {
  const lookbackMessages = Math.max(
    4,
    Math.min(80, Number(getTextInitiativeSettings(settings).lookbackMessages) || 20)
  );
  const candidateIds = getEligibleInitiativeChannelIds(settings);

  return Promise.all(candidateIds.map(async (channelId) => {
    if (!runtime.isChannelAllowed(settings, channelId)) return null;
    const channel = runtime.client.channels.cache.get(channelId);
    if (!runtime.isNonPrivateReplyEligibleChannel(channel)) return null;

    await runtime.hydrateRecentMessages(channel, lookbackMessages);
    const rowsNewestFirst = runtime.store.getRecentMessages(channel.id, lookbackMessages) as StoredMessageRow[];
    const recentMessages = rowsNewestFirst
      .slice(0, INITIATIVE_LOOKBACK_MAX_CHANNEL_MESSAGES)
      .reverse();
    const lastHourCutoff = Date.now() - 60 * 60_000;
    let lastHumanAt: string | null = null;
    let lastHumanMessageId: string | null = null;
    let lastHumanAuthorName: string | null = null;
    let lastHumanSnippet: string | null = null;
    let lastBotAt: string | null = null;
    let recentHumanMessageCount = 0;

    for (const row of rowsNewestFirst) {
      const createdAtText = String(row?.created_at || "").trim();
      const createdAtMs = Date.parse(createdAtText);
      const isBot = row?.is_bot === true || row?.is_bot === 1;
      const content = String(row?.content || "").replace(/\s+/g, " ").trim();
      if (!isBot && Number.isFinite(createdAtMs) && createdAtMs >= lastHourCutoff) {
        recentHumanMessageCount += 1;
      }
      if (!isBot && !lastHumanAt && createdAtText) {
        lastHumanAt = createdAtText;
        lastHumanMessageId = String(row?.message_id || "").trim() || null;
        lastHumanAuthorName = String(row?.author_name || "").trim() || null;
        lastHumanSnippet = content.slice(0, 180) || null;
      }
      if (isBot && !lastBotAt && createdAtText) {
        lastBotAt = createdAtText;
      }
    }

    return {
      guildId: String(channel.guildId || channel.guild?.id || "").trim(),
      channelId: channel.id,
      channelName: String(channel.name || channel.id).trim() || channel.id,
      channel,
      recentMessages,
      recentHumanMessageCount,
      lastHumanAt,
      lastHumanMessageId,
      lastHumanAuthorName,
      lastHumanSnippet,
      lastBotAt
    } satisfies InitiativeChannelSummary;
  })).then((rows) =>
    rows
      .filter((row): row is InitiativeChannelSummary => Boolean(row?.guildId && row.channelId))
  );
}

function pickGuildChannelSet(channels: InitiativeChannelSummary[]) {
  const byGuild = new Map<string, InitiativeChannelSummary[]>();
  for (const channel of channels) {
    const group = byGuild.get(channel.guildId) || [];
    group.push(channel);
    byGuild.set(channel.guildId, group);
  }

  let bestGuildId = "";
  let bestScore = -1;
  for (const [guildId, group] of byGuild.entries()) {
    const latestHumanMs = Math.max(
      ...group.map((entry) => Date.parse(String(entry.lastHumanAt || ""))).filter(Number.isFinite),
      0
    );
    const totalRecentHuman = group.reduce((sum, entry) => sum + entry.recentHumanMessageCount, 0);
    const score = totalRecentHuman * 10_000_000 + latestHumanMs;
    if (score > bestScore) {
      bestScore = score;
      bestGuildId = guildId;
    }
  }

  return bestGuildId ? byGuild.get(bestGuildId) || [] : [];
}

function collectPendingInitiativeThoughtCandidates(
  runtime: InitiativeRuntime,
  eligibleChannels: InitiativeChannelSummary[],
  now = Date.now()
) {
  const blockedGuildIds = new Set<string>();
  const pendingThoughts = [...runtime.getPendingInitiativeThoughts().values()]
    .map((thought) => normalizePendingInitiativeThought(thought))
    .filter((thought): thought is InitiativePendingThought => Boolean(thought))
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  const dueCandidates: Array<{
    pendingThought: InitiativePendingThought;
    guildChannels: InitiativeChannelSummary[];
  }> = [];

  for (const pendingThought of pendingThoughts) {
    if (pendingInitiativeThoughtIsExpired(pendingThought, now)) {
      clearPendingInitiativeThought(runtime, pendingThought.guildId, {
        reason: "expired",
        trigger: pendingThought.trigger,
        now
      });
      continue;
    }

    const guildChannels = eligibleChannels.filter((channel) => channel.guildId === pendingThought.guildId);
    if (!guildChannels.length) {
      clearPendingInitiativeThought(runtime, pendingThought.guildId, {
        reason: "guild_no_longer_eligible",
        trigger: pendingThought.trigger,
        now
      });
      continue;
    }
    blockedGuildIds.add(pendingThought.guildId);

    const hasNewGuildActivity = guildChannels.some((channel) =>
      channel.recentMessages.some((message) => {
        const createdAtMs = Date.parse(String(message?.created_at || ""));
        return Number.isFinite(createdAtMs) && createdAtMs > Number(pendingThought.basisAt || 0);
      })
    );

    if (hasNewGuildActivity && pendingThought.status !== "reconsider") {
      const refreshedThought = {
        ...pendingThought,
        status: "reconsider" as const,
        updatedAt: now
      };
      runtime.setPendingInitiativeThought(pendingThought.guildId, refreshedThought);
      if (Number(refreshedThought.notBeforeAt || 0) <= now) {
        dueCandidates.push({
          pendingThought: refreshedThought,
          guildChannels
        });
      }
      continue;
    }

    if (Number(pendingThought.notBeforeAt || 0) <= now) {
      dueCandidates.push({
        pendingThought,
        guildChannels
      });
    }
  }

  return {
    dueCandidates,
    blockedGuildIds
  };
}

function buildInterestFacts({
  recentGuildMessages,
  eligibleChannels,
  sourceStats
}: {
  recentGuildMessages: StoredMessageRow[];
  eligibleChannels: InitiativeChannelSummary[];
  sourceStats: InitiativeSourceStat[];
}) {
  const facts: string[] = [];
  const tokenCounts = new Map<string, number>();

  for (const row of recentGuildMessages) {
    if (row?.is_bot === true || row?.is_bot === 1) continue;
    const matches = String(row?.content || "")
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{3,24}/g) || [];
    for (const token of matches) {
      if (INTEREST_STOP_WORDS.has(token)) continue;
      tokenCounts.set(token, Number(tokenCounts.get(token) || 0) + 1);
    }
  }

  const topTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([token]) => token);
  if (topTokens.length) {
    facts.push(`Recent chatter keeps circling around ${topTokens.join(", ")}.`);
  }

  const activeChannel = eligibleChannels
    .slice()
    .sort((a, b) => b.recentHumanMessageCount - a.recentHumanMessageCount)[0];
  if (activeChannel?.recentHumanMessageCount) {
    facts.push(`#${activeChannel.channelName} is the liveliest eligible channel right now.`);
  }

  const topSource = sourceStats
    .filter((entry) => entry.engagementCount > 0)
    .slice()
    .sort((a, b) => b.engagementCount - a.engagementCount)[0];
  if (topSource) {
    facts.push(`${topSource.label} has been getting the strongest response from recent proactive posts.`);
  }

  return facts.slice(0, 8);
}

function configuredSourceLabels(discoverySettings: ReturnType<typeof getDiscoverySettings>) {
  const labels = new Set<string>();
  if (discoverySettings.sources.reddit) {
    for (const sub of discoverySettings.redditSubreddits) {
      labels.add(`r/${String(sub).replace(/^r\//i, "").trim()}`);
    }
  }
  if (discoverySettings.sources.hackerNews) {
    labels.add("Hacker News");
  }
  if (discoverySettings.sources.youtube) {
    for (const channelId of discoverySettings.youtubeChannelIds) {
      labels.add(`YouTube ${String(channelId).trim()}`);
    }
  }
  if (discoverySettings.sources.rss) {
    for (const feedUrl of discoverySettings.rssFeeds) {
      try {
        labels.add(new URL(feedUrl).hostname);
      } catch {
        labels.add(String(feedUrl).trim());
      }
    }
  }
  if (discoverySettings.sources.x) {
    for (const handle of discoverySettings.xHandles) {
      labels.add(`@${String(handle).replace(/^@/, "").trim()}`);
    }
  }
  return [...labels];
}

function buildSourcePerformanceSummary(
  runtime: InitiativeRuntime,
  {
    guildId,
    discoverySettings,
    discoveryCandidates
  }: {
    guildId: string;
    discoverySettings: ReturnType<typeof getDiscoverySettings>;
    discoveryCandidates: DiscoveryCandidate[];
  }
) {
  const sinceIso = new Date(Date.now() - INITIATIVE_SOURCE_STATS_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const sourceLabels = configuredSourceLabels(discoverySettings);
  const rows = new Map<string, InitiativeSourceStat>();

  const ensureRow = (label: string) => {
    const normalizedLabel = String(label || "").trim();
    if (!normalizedLabel) return null;
    const existing = rows.get(normalizedLabel);
    if (existing) return existing;
    const next: InitiativeSourceStat = {
      label: normalizedLabel,
      sharedCount: 0,
      fetchedCount: 0,
      engagementCount: 0,
      lastUsedAt: null
    };
    rows.set(normalizedLabel, next);
    return next;
  };

  for (const label of sourceLabels) {
    ensureRow(label);
  }
  for (const candidate of discoveryCandidates) {
    const label = String(candidate?.sourceLabel || candidate?.source || "").trim();
    const row = ensureRow(label);
    if (!row) continue;
    row.fetchedCount += 1;
  }

  const recentActions = runtime.store.getRecentActions(300, {
    guildId,
    sinceIso,
    kinds: ["initiative_post", "discovery_feed_snapshot"]
  });

  const initiativePosts = recentActions.filter((row) => row.kind === "initiative_post");
  const messageIds = initiativePosts
    .map((row) => String(row?.message_id || "").trim())
    .filter(Boolean);
  const engagementByMessageId = new Map(
    runtime.store.getReferencedMessageStats({
      guildId,
      sinceIso,
      messageIds
    }).map((row) => [
      String(row?.referenced_message_id || "").trim(),
      Number(row?.reaction_count || 0) + Number(row?.reply_count || 0)
    ])
  );

  for (const action of recentActions) {
    const metadata = isRecord(action?.metadata) ? action.metadata : {};
    if (action.kind === "discovery_feed_snapshot") {
      const counts = Array.isArray(metadata.sourceCounts) ? metadata.sourceCounts : [];
      for (const entry of counts) {
        if (!isRecord(entry)) continue;
        const label = String(entry.sourceLabel || "").trim();
        const row = ensureRow(label);
        if (!row) continue;
        row.fetchedCount += Math.max(0, Number(entry.count || 0));
      }
      continue;
    }

    const sourceLabelsForPost = Array.isArray(metadata.sourceLabels) ? metadata.sourceLabels : [];
    const actionCreatedAt = String(action?.created_at || "").trim() || null;
    const engagementCount = engagementByMessageId.get(String(action?.message_id || "").trim()) || 0;
    for (const labelValue of sourceLabelsForPost) {
      const row = ensureRow(String(labelValue || ""));
      if (!row) continue;
      row.sharedCount += 1;
      row.engagementCount += engagementCount;
      if (actionCreatedAt && (!row.lastUsedAt || Date.parse(actionCreatedAt) > Date.parse(row.lastUsedAt))) {
        row.lastUsedAt = actionCreatedAt;
      }
    }
  }

  return [...rows.values()]
    .sort((a, b) =>
      b.engagementCount - a.engagementCount ||
      b.sharedCount - a.sharedCount ||
      a.label.localeCompare(b.label)
    )
    .slice(0, 10);
}

function summarizeDiscoveryCandidates(discoveryCandidates: DiscoveryCandidate[]) {
  const counts = new Map<string, number>();
  for (const candidate of discoveryCandidates) {
    const label = String(candidate?.sourceLabel || candidate?.source || "").trim();
    if (!label) continue;
    counts.set(label, Number(counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([sourceLabel, count]) => ({ sourceLabel, count }));
}

function sanitizeSourceValue(sourceType: string, rawValue: unknown) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  if (sourceType === "reddit") return text.replace(/^r\//i, "").trim();
  if (sourceType === "x") return text.replace(/^@/, "").trim();
  if (sourceType === "rss") return normalizeDiscoveryUrl(text) || "";
  return text;
}

function buildSourceListSummary(discoverySettings: ReturnType<typeof getDiscoverySettings>) {
  const lines = [
    `reddit (${discoverySettings.redditSubreddits.length}/${discoverySettings.maxSourcesPerType}): ${discoverySettings.redditSubreddits.join(", ") || "(none)"}`,
    `rss (${discoverySettings.rssFeeds.length}/${discoverySettings.maxSourcesPerType}): ${discoverySettings.rssFeeds.join(", ") || "(none)"}`,
    `youtube (${discoverySettings.youtubeChannelIds.length}/${discoverySettings.maxSourcesPerType}): ${discoverySettings.youtubeChannelIds.join(", ") || "(none)"}`,
    `x (${discoverySettings.xHandles.length}/${discoverySettings.maxSourcesPerType}): ${discoverySettings.xHandles.join(", ") || "(none)"}`
  ];
  return lines.join("\n");
}

function updateDiscoverySources({
  runtime,
  settings,
  sourceType,
  value,
  operation,
  guildId,
  channelId
}: {
  runtime: InitiativeRuntime;
  settings: Record<string, unknown>;
  sourceType: string;
  value: string;
  operation: "add" | "remove";
  guildId: string;
  channelId: string | null;
}) {
  const discoverySettings = getDiscoverySettings(settings);
  if (!discoverySettings.allowSelfCuration) {
    return { content: "Discovery self-curation is disabled.", isError: true };
  }
  if (!(sourceType in SOURCE_TYPE_LABELS)) {
    return { content: `Unsupported source type: ${sourceType}`, isError: true };
  }
  if (discoverySettings.sources[sourceType as keyof typeof discoverySettings.sources] !== true) {
    return { content: `${SOURCE_TYPE_LABELS[sourceType as keyof typeof SOURCE_TYPE_LABELS]} sources are disabled in settings.`, isError: true };
  }

  const normalizedValue = sanitizeSourceValue(sourceType, value);
  if (!normalizedValue) {
    return { content: "Missing or invalid source value.", isError: true };
  }

  const key =
    sourceType === "reddit"
      ? "redditSubreddits"
      : sourceType === "rss"
        ? "rssFeeds"
        : sourceType === "youtube"
          ? "youtubeChannelIds"
          : "xHandles";
  const currentList = Array.isArray(discoverySettings[key]) ? discoverySettings[key] : [];
  const nextList = operation === "add"
    ? [...new Set([...currentList, normalizedValue])]
    : currentList.filter((entry) => String(entry || "").trim() !== normalizedValue);

  if (operation === "add" && currentList.includes(normalizedValue)) {
    return {
      content: `Already subscribed to ${normalizedValue}.\n${buildSourceListSummary(discoverySettings)}`
    };
  }
  if (operation === "remove" && currentList.length === nextList.length) {
    return {
      content: `${normalizedValue} is not currently subscribed.\n${buildSourceListSummary(discoverySettings)}`
    };
  }
  if (operation === "add" && nextList.length > discoverySettings.maxSourcesPerType) {
    return {
      content: `Cannot add ${normalizedValue}. ${SOURCE_TYPE_LABELS[sourceType as keyof typeof SOURCE_TYPE_LABELS]} is capped at ${discoverySettings.maxSourcesPerType} sources.`,
      isError: true
    };
  }

  const nextSettings = runtime.store.patchSettings({
    initiative: {
      discovery: {
        [key]: nextList
      }
    }
  });
  const nextDiscoverySettings = getDiscoverySettings(nextSettings);
  runtime.store.logAction({
    kind: operation === "add" ? "initiative_source_add" : "initiative_source_remove",
    guildId,
    channelId,
    userId: runtime.client.user?.id || null,
    content: `${sourceType}:${normalizedValue}`,
    metadata: {
      sourceType,
      value: normalizedValue,
      currentSources: buildSourceListSummary(nextDiscoverySettings)
    }
  });

  return {
    content: `${operation === "add" ? "Added" : "Removed"} ${normalizedValue}.\n${buildSourceListSummary(nextDiscoverySettings)}`
  };
}

async function executeInitiativeTool(
  runtime: InitiativeRuntime,
  {
    toolName,
    input,
    settings,
    guildId,
    channelId,
    signal
  }: {
    toolName: string;
    input: Record<string, unknown>;
    settings: Record<string, unknown>;
    guildId: string;
    channelId: string | null;
    signal?: AbortSignal;
  }
) {
  if (toolName === "discovery_source_list") {
    return {
      content: buildSourceListSummary(getDiscoverySettings(settings))
    };
  }
  if (toolName === "discovery_source_add" || toolName === "discovery_source_remove") {
    return updateDiscoverySources({
      runtime,
      settings,
      sourceType: String(input?.sourceType || "").trim().toLowerCase(),
      value: String(input?.value || "").trim(),
      operation: toolName === "discovery_source_add" ? "add" : "remove",
      guildId,
      channelId
    });
  }

  const toolRuntime: ReplyToolRuntime = {
    search: runtime.search,
    browser: {
      browse: async ({ settings: toolSettings, query, guildId: toolGuildId, channelId: toolChannelId, userId, source, signal: toolSignal }) => {
        const browserBrowse = runtime.buildBrowserBrowseContext(toolSettings);
        return await runtime.runModelRequestedBrowserBrowse({
          settings: toolSettings,
          browserBrowse,
          query,
          guildId: toolGuildId,
          channelId: toolChannelId,
          userId,
          source,
          signal: toolSignal
        });
      }
    },
    memory: runtime.memory,
    store: runtime.store
  };
  const toolContext: ReplyToolContext = {
    settings,
    guildId,
    channelId,
    userId: runtime.client.user?.id || "",
    sourceMessageId: `initiative:${Date.now()}`,
    sourceText: "",
    botUserId: runtime.client.user?.id || undefined,
    trace: {
      guildId,
      channelId,
      userId: runtime.client.user?.id || null,
      source: "initiative_tool"
    },
    signal
  };
  return await executeReplyTool(toolName, input, toolRuntime, toolContext);
}

function initiativeToolSet({
  settings,
  allowWebSearch,
  allowWebScrape,
  allowBrowserBrowse,
  allowSelfCuration
}: {
  settings: Record<string, unknown>;
  allowWebSearch: boolean;
  allowWebScrape: boolean;
  allowBrowserBrowse: boolean;
  allowSelfCuration: boolean;
}) {
  const tools = [];
  const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
  if (allowWebSearch) {
    tools.push(toAnthropicTool(WEB_SEARCH_SCHEMA));
  }
  if (allowWebScrape) {
    tools.push(toAnthropicTool(WEB_SCRAPE_SCHEMA));
  }
  if (allowBrowserBrowse) {
    tools.push(toAnthropicTool(BROWSER_BROWSE_SCHEMA));
  }
  if (memoryEnabled) {
    tools.push(toAnthropicTool(MEMORY_SEARCH_SCHEMA));
  }
  if (allowSelfCuration) {
    tools.push(toAnthropicTool(DISCOVERY_SOURCE_LIST_SCHEMA));
    tools.push(toAnthropicTool(DISCOVERY_SOURCE_ADD_SCHEMA));
    tools.push(toAnthropicTool(DISCOVERY_SOURCE_REMOVE_SCHEMA));
  }
  return tools;
}

export async function maybeRunInitiativeCycle(runtime: InitiativeRuntime) {
  if (runtime.initiativeCycleRunning) return;
  runtime.initiativeCycleRunning = true;

  try {
    const settings = runtime.store.getSettings();
    const initiative = getTextInitiativeSettings(settings);
    const permissions = getReplyPermissions(settings);
    const discoverySettings = getDiscoverySettings(settings);
    const memorySettings = getMemorySettings(settings);
    if (!initiative.enabled) return;
    if (initiative.maxPostsPerDay <= 0) return;
    if (!runtime.canSendMessage(permissions.maxMessagesPerHour)) return;
    if (!runtime.canTalkNow(settings)) return;

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const posts24h = countRecentActions(runtime.store, "initiative_post", since24h);
    if (posts24h >= initiative.maxPostsPerDay) return;

    const now = Date.now();
    const minGapMs = Math.max(1, Number(initiative.minMinutesBetweenPosts || 0) * 60_000);
    const eligibleChannels = await buildEligibleChannels(runtime, settings);
    const {
      dueCandidates: duePendingCandidates,
      blockedGuildIds: pendingThoughtGuildIds
    } = collectPendingInitiativeThoughtCandidates(runtime, eligibleChannels, now);
    const freshEligibleChannels = eligibleChannels.filter((channel) => !pendingThoughtGuildIds.has(channel.guildId));
    const freshGuildChannels = pickGuildChannelSet(freshEligibleChannels);
    let freshPassAllowed = false;

    if (freshGuildChannels.length) {
      const lastPostTimes = getLastActionTimes(runtime.store, [...INITIATIVE_MIN_GAP_ACTION_KINDS]);
      const lastPostTs = lastPostTimes.length ? Math.max(...lastPostTimes) : 0;
      if (!lastPostTs || now - lastPostTs >= minGapMs) {
        const eagerness = Math.max(0, Math.min(100, Number(initiative.eagerness) || 0));
        const roll = Math.random() * 100;
        freshPassAllowed = roll < eagerness;
      }
    }

    const selectedPendingCandidate = !freshPassAllowed && duePendingCandidates.length > 0
      ? duePendingCandidates[0]
      : null;
    const pendingThought = selectedPendingCandidate?.pendingThought || null;
    const guildChannels = selectedPendingCandidate?.guildChannels || freshGuildChannels;
    if (!guildChannels.length) return;
    const isPendingThoughtPass = Boolean(pendingThought);
    if (!isPendingThoughtPass && !freshPassAllowed) return;

    const guildId = guildChannels[0].guildId;
    const recentGuildMessages = runtime.store.getRecentMessagesAcrossGuild(guildId, 180) as StoredMessageRow[];
    const recentGuildQuery = recentGuildMessages
      .slice(0, 24)
      .map((row) => String(row?.content || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    const recentGuildParticipantIds = [...new Set(
      recentGuildMessages
        .map((row) => String(row?.author_id || "").trim())
        .filter(Boolean)
    )];

    const discoveryResult = runtime.discovery
      ? await runtime.discovery.collect({
          settings,
          guildId,
          channelId: guildChannels[0].channelId,
          channelName: guildChannels[0].channelName,
          recentMessages: recentGuildMessages.slice(0, 20)
        })
      : {
          enabled: false,
          topics: [],
          candidates: [],
          selected: [],
          reports: [],
          errors: []
        };

    const memoryFacts = memorySettings.enabled
      ? await runtime.loadRelevantMemoryFacts({
          settings,
          guildId,
          channelId: guildChannels[0].channelId,
          queryText: [
            recentGuildQuery,
            ...discoveryResult.candidates.slice(0, 4).map((item) => String(item?.title || "").trim())
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 500),
          trace: {
            guildId,
            channelId: guildChannels[0].channelId,
            userId: runtime.client.user?.id || null,
            source: "initiative_prompt"
          },
          limit: 10
        })
      : [];
    const guildProfile =
      memorySettings.enabled && typeof runtime.memory?.loadGuildFactProfile === "function"
        ? runtime.memory.loadGuildFactProfile({
            guildId
          })
        : { guidanceFacts: [] };
    const behavioralFacts = await loadBehavioralMemoryFacts(runtime, {
      settings,
      guildId,
      channelId: guildChannels[0].channelId,
      queryText: [
        recentGuildQuery,
        ...discoveryResult.candidates.slice(0, 4).map((item) => String(item?.title || "").trim())
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500),
      participantIds: recentGuildParticipantIds,
      trace: {
        guildId,
        channelId: guildChannels[0].channelId,
        userId: runtime.client.user?.id || null,
        source: "initiative_behavioral_memory"
      },
      limit: 8
    });

    const sourcePerformance = buildSourcePerformanceSummary(runtime, {
      guildId,
      discoverySettings,
      discoveryCandidates: discoveryResult.candidates
    });
    runtime.store.logAction({
      kind: "discovery_feed_snapshot",
      guildId,
      channelId: guildChannels[0].channelId,
      userId: runtime.client.user?.id || null,
      content: `candidates=${discoveryResult.candidates.length}`,
      metadata: {
        sourceCounts: summarizeDiscoveryCandidates(discoveryResult.candidates)
      }
    });
    const communityInterestFacts = buildInterestFacts({
      recentGuildMessages,
      eligibleChannels: guildChannels,
      sourceStats: sourcePerformance
    });
    const imageBudget = runtime.getImageBudgetState(settings);
    const videoBudget = runtime.getVideoGenerationBudgetState(settings);
    const gifBudget = runtime.getGifBudgetState(settings);
    const mediaCapabilities = runtime.getMediaGenerationCapabilities(settings);
    const allowActiveCuriosity = Boolean(initiative.allowActiveCuriosity);
    const webSearchToolAvailable = allowActiveCuriosity && isResearchEnabled(settings);
    const browserBrowseContext = runtime.buildBrowserBrowseContext(settings);
    const browserBrowseToolAvailable = allowActiveCuriosity &&
      Boolean(browserBrowseContext.enabled) &&
      Boolean(browserBrowseContext.configured) &&
      browserBrowseContext.budget?.canBrowse !== false;
    const allowSelfCuration = Boolean(discoverySettings.allowSelfCuration);
    const botName = getBotName(settings);
    const persona = getPromptStyle(settings);
    const systemPrompt = buildSystemPrompt(settings);
    const userPrompt = buildInitiativePrompt({
      botName,
      persona,
      initiativeEagerness: Math.max(0, Math.min(100, Number(initiative.eagerness) || 0)),
      channelSummaries: guildChannels,
      pendingThought: pendingThought
        ? {
          currentText: pendingThought.currentText,
          status: pendingThought.status,
          revision: pendingThought.revision,
          ageMs: Math.max(0, Date.now() - Number(pendingThought.createdAt || Date.now())),
          channelName: pendingThought.channelName,
          lastDecisionReason: pendingThought.lastDecisionReason,
          mediaDirective: pendingThought.mediaDirective,
          mediaPrompt: pendingThought.mediaPrompt
        }
        : null,
      discoveryCandidates: discoveryResult.candidates,
      sourcePerformance,
      communityInterestFacts,
      relevantFacts: memoryFacts,
      guidanceFacts: Array.isArray(guildProfile?.guidanceFacts) ? guildProfile.guidanceFacts : [],
      behavioralFacts,
      allowActiveCuriosity,
      allowWebSearch: webSearchToolAvailable,
      allowWebScrape: webSearchToolAvailable,
      allowBrowserBrowse: browserBrowseToolAvailable,
      allowMemorySearch: memorySettings.enabled,
      allowSelfCuration,
      allowImagePosts:
        discoverySettings.allowImagePosts &&
        imageBudget.canGenerate &&
        (mediaCapabilities.simpleImageReady || mediaCapabilities.complexImageReady),
      allowVideoPosts:
        discoverySettings.allowVideoPosts &&
        videoBudget.canGenerate &&
        mediaCapabilities.videoReady,
      allowGifPosts:
        discoverySettings.allowReplyGifs &&
        gifBudget.canFetch,
      remainingImages: imageBudget.remaining,
      remainingVideos: videoBudget.remaining,
      remainingGifs: gifBudget.remaining,
      maxMediaPromptChars: discoverySettings.maxMediaPromptChars,
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    });

    const initiativeSettings = buildInitiativeGenerationSettings(settings);
    const tools = initiativeToolSet({
      settings,
      allowWebSearch: webSearchToolAvailable,
      allowWebScrape: webSearchToolAvailable,
      allowBrowserBrowse: browserBrowseToolAvailable,
      allowSelfCuration
    });
    const trace = {
      guildId,
      channelId: guildChannels[0].channelId,
      userId: runtime.client.user?.id || null,
      source: "initiative_cycle",
      event: isPendingThoughtPass ? "initiative_pending_thought" : "initiative_post",
      reason: null,
      messageId: null
    };
    let contextMessages: ContextMessage[] = [];
    let generation = await runtime.llm.generate({
      settings: initiativeSettings,
      systemPrompt,
      userPrompt,
      contextMessages,
      jsonSchema: tools.length ? "" : INITIATIVE_OUTPUT_JSON_SCHEMA,
      tools,
      trace
    });

    const startedAt = Date.now();
    let toolLoopSteps = 0;
    let totalToolCalls = 0;

    while (
      generation.toolCalls?.length &&
      toolLoopSteps < Math.max(0, Number(initiative.maxToolSteps) || 0) &&
      totalToolCalls < Math.max(0, Number(initiative.maxToolCalls) || 0) &&
      Date.now() - startedAt < INITIATIVE_TICK_MAX_RUNTIME_MS
    ) {
      const assistantContent = buildContextContentBlocks(generation.rawContent, generation.text);
      if (contextMessages.length === 0) {
        contextMessages = [
          { role: "user", content: userPrompt },
          { role: "assistant", content: assistantContent }
        ];
      } else {
        contextMessages = [
          ...contextMessages,
          { role: "assistant", content: assistantContent }
        ];
      }

      const toolResultMessages: ContentBlock[] = [];
      for (const toolCall of generation.toolCalls) {
        if (totalToolCalls >= Math.max(0, Number(initiative.maxToolCalls) || 0)) break;
        totalToolCalls += 1;
        const result = await executeInitiativeTool(runtime, {
          toolName: toolCall.name,
          input: isRecord(toolCall.input) ? toolCall.input : {},
          settings,
          guildId,
          channelId: guildChannels[0].channelId
        });
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }

      contextMessages = [
        ...contextMessages,
        { role: "user", content: toolResultMessages }
      ];

      generation = await runtime.llm.generate({
        settings: initiativeSettings,
        systemPrompt,
        userPrompt: "",
        contextMessages,
        jsonSchema: "",
        tools,
        trace: {
          ...trace,
          event: `initiative_post:tool_loop:${toolLoopSteps + 1}`
        }
      });
      toolLoopSteps += 1;
    }

    const decision = parseStructuredInitiativeOutput(
      generation.text,
      discoverySettings.maxMediaPromptChars
    );
    if (decision.parseState === "unstructured" || decision.contractViolation) {
      runtime.store.logAction({
        kind: "initiative_skip",
        guildId,
        channelId: pendingThought?.channelId || guildChannels[0]?.channelId || null,
        userId: runtime.client.user?.id || null,
        content: decision.contractViolationReason || decision.reason || "skip",
        metadata: {
          parseState: decision.parseState,
          reason: decision.reason || null,
          contractViolation: decision.contractViolation,
          contractViolationReason: decision.contractViolationReason,
          pendingThoughtId: pendingThought?.id || null
        }
      });
      return;
    }

    if (decision.action === "drop" || decision.skip) {
      if (pendingThought) {
        clearPendingInitiativeThought(runtime, guildId, {
          reason: decision.reason || "model_drop",
          trigger: pendingThought.trigger,
          now: Date.now()
        });
      } else {
        runtime.store.logAction({
          kind: "initiative_skip",
          guildId,
          channelId: null,
          userId: runtime.client.user?.id || null,
          content: decision.reason || "skip",
          metadata: {
            parseState: decision.parseState,
            reason: decision.reason || null
          }
        });
      }
      return;
    }

    const selectedChannel = guildChannels.find((channel) => channel.channelId === decision.channelId);
    if (!selectedChannel || !selectedChannel.channel.send || !selectedChannel.channel.sendTyping) {
      runtime.store.logAction({
        kind: "bot_error",
        guildId,
        channelId: decision.channelId,
        userId: runtime.client.user?.id || null,
        content: `initiative_invalid_channel:${String(decision.channelId || "")}`
      });
      return;
    }

    const normalizedText = sanitizeBotText(normalizeSkipSentinel(decision.text || ""), 1800);
    if (!normalizedText || normalizedText === "[SKIP]") return;

    if (decision.action === "hold") {
      const heldMediaDirective: "none" | "image" | "video" | "gif" =
        decision.mediaDirective === "image" || decision.mediaDirective === "video" || decision.mediaDirective === "gif"
          ? decision.mediaDirective
          : "none";
      savePendingInitiativeThought(runtime, {
        guildId,
        channelId: selectedChannel.channelId,
        channelName: selectedChannel.channelName,
        trigger: pendingThought?.trigger || "timer",
        draftText: pendingThought?.draftText || pendingThought?.currentText || normalizedText,
        thoughtText: normalizedText,
        mediaDirective: heldMediaDirective,
        mediaPrompt: decision.mediaPrompt,
        reason: decision.reason || "hold",
        minGapMs,
        existingThought: pendingThought,
        now: Date.now()
      });
      return;
    }

    const mediaMemoryFacts = runtime.buildMediaMemoryFacts({
      userFacts: [],
      relevantFacts: memoryFacts
    });
    const mediaAttachment = await runtime.resolveMediaAttachment({
      settings,
      text: normalizedText,
      directive: {
        type:
          decision.mediaDirective === "image"
            ? "image_simple"
            : decision.mediaDirective === "video"
              ? "video"
              : decision.mediaDirective === "gif"
                ? "gif"
                : null,
        gifQuery: decision.mediaDirective === "gif" ? decision.mediaPrompt : null,
        imagePrompt:
          decision.mediaDirective === "image" && decision.mediaPrompt
            ? composeDiscoveryImagePrompt(
                decision.mediaPrompt,
                normalizedText,
                discoverySettings.maxMediaPromptChars,
                mediaMemoryFacts
              )
            : null,
        complexImagePrompt: null,
        videoPrompt:
          decision.mediaDirective === "video" && decision.mediaPrompt
            ? composeDiscoveryVideoPrompt(
                decision.mediaPrompt,
                normalizedText,
                discoverySettings.maxMediaPromptChars,
                mediaMemoryFacts
              )
            : null
      },
      trace: {
        guildId,
        channelId: selectedChannel.channelId,
        userId: runtime.client.user?.id || null,
        source: "initiative_post"
      }
    });

    await selectedChannel.channel.sendTyping();
    await sleep(runtime.getSimulatedTypingDelayMs(350, 900));
    const chunks = splitDiscordMessage(mediaAttachment.payload.content);
    const firstPayload = { ...mediaAttachment.payload, content: chunks[0] };
    const replyToMessageId = String(decision.replyToMessageId || "").trim() || null;
    let replyTarget = null;
    if (replyToMessageId) {
      try {
        replyTarget = await selectedChannel.channel.messages.fetch(replyToMessageId);
      } catch {
        // Message not found or inaccessible — fall back to standalone post
      }
    }
    const sent = replyTarget
      ? await replyTarget.reply(firstPayload)
      : await selectedChannel.channel.send(firstPayload);
    for (let index = 1; index < chunks.length; index += 1) {
      await selectedChannel.channel.send({ content: chunks[index] });
    }

    runtime.markSpoke();
    runtime.setPendingInitiativeThought(guildId, null);
    runtime.store.recordMessage({
      messageId: sent.id,
      createdAt: sent.createdTimestamp,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: runtime.client.user?.id || "unknown",
      authorName: botName,
      isBot: true,
      content: runtime.composeMessageContentForHistory(sent, normalizedText),
      referencedMessageId: replyToMessageId
    });

    const includedUrls = extractUrlsFromText(normalizedText)
      .map((url) => normalizeDiscoveryUrl(url))
      .filter(Boolean) as string[];
    const matchedDiscoveryItems = discoveryResult.candidates.filter((candidate) =>
      includedUrls.includes(normalizeDiscoveryUrl(candidate?.url || "") || "")
    );
    for (const url of includedUrls) {
      runtime.store.recordSharedLink({
        url,
        source: matchedDiscoveryItems.find((item) => normalizeDiscoveryUrl(item?.url || "") === url)?.sourceLabel || "initiative_post"
      });
    }

    runtime.store.logAction({
      kind: "initiative_post",
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: runtime.client.user?.id || null,
      content: normalizedText,
      metadata: {
        reason: decision.reason || null,
        pendingThoughtId: pendingThought?.id || null,
        pendingThoughtRevision: pendingThought?.revision || null,
        mediaDirective: decision.mediaDirective,
        sourceLabels: [...new Set(
          matchedDiscoveryItems
            .map((item) => String(item?.sourceLabel || item?.source || "").trim())
            .filter(Boolean)
        )],
        urls: includedUrls,
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd,
          toolLoopSteps,
          totalToolCalls
        },
        channelSummary: {
          channelId: selectedChannel.channelId,
          channelName: selectedChannel.channelName
        },
        discoveryCandidateCount: discoveryResult.candidates.length
      }
    });
  } finally {
    runtime.initiativeCycleRunning = false;
  }
}
