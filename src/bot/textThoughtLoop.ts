import { clamp } from "../utils.ts";
import { getReplyPermissions, getTextInitiativeSettings } from "../settings/agentStack.ts";
import type { BotContext } from "./botContext.ts";

const PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
const UNSOLICITED_REPLY_CONTEXT_WINDOW = 5;

type StoredMessageRow = {
  guild_id?: string;
  channel_id?: string;
  message_id?: string;
  author_id?: string;
  author_name?: string;
  content?: string;
  created_at?: string;
  is_bot?: boolean;
};

type ThoughtLoopChannelLike = {
  id: string;
  guildId?: string;
  guild?: unknown;
  send?: (payload: unknown) => Promise<unknown>;
};

type ThoughtLoopClientLike = BotContext["client"] & {
  user?: {
    id?: string;
  } | null;
  channels: {
    cache: {
      get: (id: string) => ThoughtLoopChannelLike | undefined;
    };
  };
};

type ThoughtLoopMessageRuntime = {
  id: string;
  createdTimestamp: number;
  guildId: string;
  channelId: string;
  guild?: unknown;
  channel: ThoughtLoopChannelLike;
  author: {
    id: string;
    username: string;
    bot: boolean;
  };
  member: {
    displayName: string;
  };
  content: string;
  mentions: {
    users: {
      has: () => boolean;
    };
    repliedUser: null;
  };
  reference: null;
  attachments: Map<string, never>;
  embeds: never[];
  reactions: {
    cache: Map<string, never>;
  };
  react: () => Promise<undefined>;
  reply: (payload: Record<string, unknown>) => Promise<unknown>;
};

type ThoughtLoopCandidate = {
  channel: ThoughtLoopChannelLike;
  recentMessages: StoredMessageRow[];
  message: ThoughtLoopMessageRuntime;
};

export type TextThoughtLoopRuntime = BotContext & {
  readonly client: ThoughtLoopClientLike;
  textThoughtLoopRunning: boolean;
  canSendMessage: (maxPerHour: number) => boolean;
  canTalkNow: (settings: Record<string, unknown>) => boolean;
  maybeReplyToMessage: (
    message: ThoughtLoopMessageRuntime,
    settings: Record<string, unknown>,
    options: {
      source: string;
      recentMessages: StoredMessageRow[];
      addressSignal: {
        direct: boolean;
        inferred: boolean;
        triggered: boolean;
        reason: string;
        confidence: number;
        threshold: number;
        confidenceSource: "fallback";
      };
      forceDecisionLoop: boolean;
    }
  ) => Promise<unknown>;
  isChannelAllowed: (settings: Record<string, unknown>, channelId: string) => boolean;
  isNonPrivateReplyEligibleChannel: (channel: ThoughtLoopChannelLike | null | undefined) => boolean;
  hydrateRecentMessages: (channel: ThoughtLoopChannelLike, limit: number) => Promise<unknown[]>;
  hasBotMessageInRecentWindow: (payload: {
    recentMessages: StoredMessageRow[];
    windowSize: number;
  }) => boolean;
};

export async function maybeRunTextThoughtLoopCycle(runtime: TextThoughtLoopRuntime) {
  if (runtime.textThoughtLoopRunning) return;
  runtime.textThoughtLoopRunning = true;

  try {
    const settings = runtime.store.getSettings();
    const textThoughtLoop = getTextInitiativeSettings(settings);
    const permissions = getReplyPermissions(settings);
    if (!textThoughtLoop.enabled) return;
    if (textThoughtLoop.maxThoughtsPerDay <= 0) return;
    if (!runtime.canSendMessage(permissions.maxMessagesPerHour)) return;
    if (!runtime.canTalkNow(settings)) return;

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const thoughts24h = runtime.store.countActionsSince("text_thought_loop_post", since24h);
    if (thoughts24h >= textThoughtLoop.maxThoughtsPerDay) return;

    const lastThoughtAt = runtime.store.getLastActionTime("text_thought_loop_post");
    const lastThoughtTs = lastThoughtAt ? new Date(lastThoughtAt).getTime() : 0;
    const minGapMs = Math.max(
      1,
      Number(textThoughtLoop.minMinutesBetweenThoughts || 0) * 60_000
    );
    if (lastThoughtTs && Date.now() - lastThoughtTs < minGapMs) return;

    const candidate = await pickTextThoughtLoopCandidate(runtime, settings);
    if (!candidate) return;

    const sent = await runtime.maybeReplyToMessage(candidate.message, settings, {
      source: "text_thought_loop",
      recentMessages: candidate.recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides",
        confidence: 0,
        threshold: 0.62,
        confidenceSource: "fallback"
      },
      forceDecisionLoop: true
    });
    if (!sent) return;

    runtime.store.logAction({
      kind: "text_thought_loop_post",
      guildId: candidate.message.guildId,
      channelId: candidate.message.channelId,
      messageId: candidate.message.id,
      userId: runtime.client.user?.id || null,
      content: candidate.message.content,
      metadata: {
        lookbackMessages: textThoughtLoop.lookbackMessages,
        source: "text_thought_loop"
      }
    });
  } finally {
    runtime.textThoughtLoopRunning = false;
  }
}

export async function pickTextThoughtLoopCandidate(
  runtime: TextThoughtLoopRuntime,
  settings: Record<string, unknown>
): Promise<ThoughtLoopCandidate | null> {
  const permissions = getReplyPermissions(settings);
  const textThoughtLoop = getTextInitiativeSettings(settings);
  const candidateIds = [...new Set(
    permissions.replyChannelIds
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!candidateIds.length) return null;

  const shuffled = candidateIds
    .map((id) => ({ id, sortKey: Math.random() }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.id);

  const lookback = clamp(Number(textThoughtLoop.lookbackMessages) || 0, 4, 80);
  for (const channelId of shuffled) {
    if (!runtime.isChannelAllowed(settings, channelId)) continue;
    const channel = runtime.client.channels.cache.get(channelId);
    if (!runtime.isNonPrivateReplyEligibleChannel(channel)) continue;

    await runtime.hydrateRecentMessages(channel, lookback);
    const recentMessages = runtime.store.getRecentMessages(channel.id, lookback) as StoredMessageRow[];
    if (!recentMessages.length) continue;
    if (runtime.hasBotMessageInRecentWindow({ recentMessages, windowSize: UNSOLICITED_REPLY_CONTEXT_WINDOW })) {
      continue;
    }

    const latestHuman = getLatestRecentHumanMessage(recentMessages);
    if (!latestHuman) continue;
    if (!isRecentHumanActivity(latestHuman)) {
      continue;
    }

    return {
      channel,
      recentMessages,
      message: buildStoredMessageRuntime(channel, latestHuman)
    };
  }

  return null;
}

export function buildStoredMessageRuntime(
  channel: ThoughtLoopChannelLike,
  row: StoredMessageRow
): ThoughtLoopMessageRuntime {
  const guild = channel.guild;
  const guildId = String(row?.guild_id || channel.guildId || "").trim();
  const channelId = String(row?.channel_id || channel.id || "").trim();
  const messageId = String(row?.message_id || "").trim() || `stored-${Date.now()}`;
  const authorId = String(row?.author_id || "unknown").trim();
  const authorName = String(row?.author_name || "unknown").trim() || "unknown";
  const content = String(row?.content || "").trim();
  const createdAtMs = Date.parse(String(row?.created_at || ""));

  return {
    id: messageId,
    createdTimestamp: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    guildId,
    channelId,
    guild,
    channel,
    author: {
      id: authorId,
      username: authorName,
      bot: Boolean(row?.is_bot)
    },
    member: {
      displayName: authorName
    },
    content,
    mentions: {
      users: {
        has() {
          return false;
        }
      },
      repliedUser: null
    },
    reference: null,
    attachments: new Map<string, never>(),
    embeds: [],
    reactions: {
      cache: new Map<string, never>()
    },
    async react() {
      return undefined;
    },
    async reply(payload) {
      return await channel.send?.({
        ...payload,
        allowedMentions: { repliedUser: false }
      });
    }
  };
}

export function getLatestRecentHumanMessage(rows: StoredMessageRow[] = []) {
  return (Array.isArray(rows) ? rows : []).find((row) => !row?.is_bot) || null;
}

export function isRecentHumanActivity(
  row: StoredMessageRow | null | undefined,
  { maxAgeMs = PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS }: { maxAgeMs?: number } = {}
) {
  if (!row || row.is_bot) return false;
  const createdAtMs = Date.parse(String(row.created_at || ""));
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - createdAtMs <= Math.max(60_000, Number(maxAgeMs) || PROACTIVE_TEXT_CHANNEL_ACTIVE_WINDOW_MS);
}
