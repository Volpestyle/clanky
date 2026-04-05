import type { MinecraftChatMessage } from "../agents/minecraft/minecraftBrain.ts";
import type { MinecraftGameEvent } from "../agents/minecraft/types.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import { buildMinecraftNarrationPrompt, buildSystemPrompt } from "../prompts/index.ts";
import {
  applyOrchestratorOverrideSettings,
  getBotName,
  getMinecraftNarrationSettings,
  getReplyPermissions,
  getResolvedMinecraftBrainBinding
} from "../settings/agentStack.ts";
import { sanitizeBotText, sleep } from "../utils.ts";
import { normalizeSkipSentinel, splitDiscordMessage } from "./botHelpers.ts";
import type { BotContext } from "./botContext.ts";

const MINECRAFT_NARRATION_JSON_SCHEMA = `{
  "skip": false,
  "text": "message text or [SKIP]",
  "reason": "short reason or null"
}`;

const MINECRAFT_NARRATION_SIGNAL_LIMIT = 6;
const MINECRAFT_NARRATION_CONTEXT_MESSAGE_LIMIT = 10;
const MINECRAFT_NARRATION_MIN_GAP_ACTION_KINDS = [
  "minecraft_narration_post",
  "minecraft_narration_skip"
] as const;
const CORE_PROGRESS_BLOCKS = new Set([
  "diamond_ore",
  "deepslate_diamond_ore",
  "ancient_debris",
  "obsidian"
]);
const WIDE_PROGRESS_BLOCKS = new Set([
  ...CORE_PROGRESS_BLOCKS,
  "emerald_ore",
  "deepslate_emerald_ore"
]);

type StoredMessageLike = {
  author_name?: string;
  content?: string;
  is_bot?: boolean | number;
};

type MinecraftNarrationChannelLike = {
  id: string;
  guildId?: string;
  name?: string;
  send?: (payload: unknown) => Promise<{
    id: string;
    createdTimestamp: number;
    guildId: string;
    channelId: string;
  }>;
  sendTyping?: () => Promise<unknown>;
};

type MinecraftNarrationClientLike = BotContext["client"] & {
  user?: {
    id?: string;
  } | null;
  channels: {
    cache: {
      get: (id: string) => MinecraftNarrationChannelLike | undefined;
    };
  };
};

export type MinecraftNarrationRuntime = BotContext & {
  readonly client: MinecraftNarrationClientLike;
  canSendMessage: (maxPerHour: number) => boolean;
  canTalkNow: (settings: Record<string, unknown>) => boolean;
  getSimulatedTypingDelayMs: (minMs: number, jitterMs: number) => number;
  markSpoke: () => void;
  composeMessageContentForHistory: (message: unknown, baseText?: string) => string;
};

export type MinecraftNarrationState = {
  seenMilestones: Set<string>;
};

export type MinecraftNarrationSignal = {
  category: "death" | "server" | "combat" | "player" | "progress";
  key: string;
  event: MinecraftGameEvent;
  summary: string;
  minEagerness: number;
};

type MaybePostMinecraftNarrationOptions = {
  guildId: string | null;
  channelId: string | null;
  ownerUserId?: string | null;
  scopeKey?: string | null;
  source?: string | null;
  serverLabel?: string | null;
  events: MinecraftGameEvent[];
  /**
   * Recent in-game chat snapshot from the session when these events fired.
   * Passed through to the narration prompt as a labeled, separate section
   * alongside Discord context. Mirrors Phase 2.3's label-and-keep-separate
   * cross-surface design so the model can tell which surface each message
   * came from.
   */
  chatHistory?: MinecraftChatMessage[];
  state: MinecraftNarrationState;
};

function isSendableChannel(
  channel: MinecraftNarrationChannelLike | null | undefined
): channel is MinecraftNarrationChannelLike {
  return Boolean(channel) &&
    typeof channel.send === "function" &&
    typeof channel.sendTyping === "function";
}

function buildNarrationSettings(settings: Record<string, unknown>) {
  const binding = getResolvedMinecraftBrainBinding(settings);
  return applyOrchestratorOverrideSettings(settings, {
    provider: binding.provider,
    model: binding.model,
    temperature: binding.temperature,
    maxOutputTokens: Math.min(600, Math.max(120, Number(binding.maxOutputTokens) || 300)),
    reasoningEffort: binding.reasoningEffort
  });
}

function recordProgressMilestone(
  state: MinecraftNarrationState,
  blockName: string,
  eagerness: number
): MinecraftNarrationSignal | null {
  const normalizedBlockName = String(blockName || "").trim().toLowerCase();
  if (!normalizedBlockName) return null;

  const isCore = CORE_PROGRESS_BLOCKS.has(normalizedBlockName);
  const isWide = WIDE_PROGRESS_BLOCKS.has(normalizedBlockName);
  if (!isCore && !isWide) return null;

  const minEagerness = isCore ? 30 : 75;
  if (eagerness < minEagerness) return null;

  const key = `progress:${normalizedBlockName}`;
  if (state.seenMilestones.has(key)) return null;
  state.seenMilestones.add(key);

    return {
      category: "progress",
      key,
      event: {
        type: "item_pickup",
        timestamp: new Date().toISOString(),
        summary: `collected block milestone: ${normalizedBlockName}`,
        itemName: normalizedBlockName,
        count: 1
      },
      summary: `first notable progression item this session: ${normalizedBlockName}`,
      minEagerness
    };
}

export function createMinecraftNarrationState(): MinecraftNarrationState {
  return {
    seenMilestones: new Set()
  };
}

export function selectSignificantMinecraftEvents({
  events,
  eagerness,
  state
}: {
  events: MinecraftGameEvent[];
  eagerness: number;
  state: MinecraftNarrationState;
}): MinecraftNarrationSignal[] {
  const normalizedEagerness = Math.max(0, Math.min(100, Number(eagerness) || 0));
  if (normalizedEagerness <= 0) return [];

  const selected: MinecraftNarrationSignal[] = [];
  const selectedKeys = new Set<string>();
  let connectSignal: MinecraftNarrationSignal | null = null;

  const pushSignal = (signal: MinecraftNarrationSignal | null) => {
    if (!signal) return;
    if (normalizedEagerness < signal.minEagerness) return;
    if (selectedKeys.has(signal.key)) return;
    selectedKeys.add(signal.key);
    selected.push(signal);
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;

    switch (event.type) {
      case "chat":
        continue;
      case "server":
        if (event.serverEvent === "spawned_as") {
          connectSignal = {
            category: "server",
            key: `server_join:${event.summary.toLowerCase()}`,
            event,
            summary: event.summary,
            minEagerness: 25
          };
          continue;
        }
        if (event.serverEvent === "logged_in" || event.serverEvent === "spawn") {
          if (!connectSignal) {
            connectSignal = {
              category: "server",
              key: `server_join:${event.serverEvent}`,
              event,
              summary: event.summary,
              minEagerness: 25
            };
          }
          continue;
        }
        pushSignal({
          category: "server",
          key: `server_state:${event.serverEvent}:${event.summary.toLowerCase()}`,
          event,
          summary: event.summary,
          minEagerness: 1
        });
        continue;
      case "death":
        pushSignal({
          category: "death",
          key: `death:${event.timestamp}`,
          event,
          summary: "you died in Minecraft",
          minEagerness: 1
        });
        continue;
      case "combat":
        pushSignal({
          category: "combat",
          key: `combat:${event.combatKind}:${event.target.toLowerCase()}`,
          event,
          summary: event.summary,
          minEagerness: 15
        });
        continue;
      case "player_join":
      case "player_leave":
        pushSignal({
          category: "player",
          key: `player:${event.type}:${event.playerName.toLowerCase()}`,
          event,
          summary: event.summary,
          minEagerness: 15
        });
        continue;
      case "item_pickup":
        pushSignal(recordProgressMilestone(state, event.itemName, normalizedEagerness));
        continue;
      case "block_break":
        pushSignal(recordProgressMilestone(state, event.blockName, normalizedEagerness));
        continue;
      default:
        continue;
    }
  }

  if (connectSignal) {
    pushSignal(connectSignal);
  }

  return selected.slice(0, MINECRAFT_NARRATION_SIGNAL_LIMIT);
}

function getLastNarrationActionAt(
  runtime: MinecraftNarrationRuntime,
  guildId: string,
  channelId: string
): number {
  const rows = runtime.store.getRecentActions(20, {
    guildId,
    kinds: [...MINECRAFT_NARRATION_MIN_GAP_ACTION_KINDS]
  });
  return rows
    .filter((row) => String(row?.channel_id || "").trim() === channelId)
    .map((row) => Date.parse(String(row?.created_at || "")))
    .filter((value) => Number.isFinite(value))
    .reduce((latest, value) => Math.max(latest, value), 0);
}

export async function maybePostMinecraftNarration(
  runtime: MinecraftNarrationRuntime,
  {
    guildId,
    channelId,
    ownerUserId = null,
    scopeKey = null,
    source = null,
    serverLabel = null,
    events,
    chatHistory = [],
    state
  }: MaybePostMinecraftNarrationOptions
): Promise<boolean> {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedGuildId || !normalizedChannelId || !Array.isArray(events) || events.length === 0) {
    return false;
  }

  const settings = runtime.store.getSettings();
  const permissions = getReplyPermissions(settings);
  const narration = getMinecraftNarrationSettings(settings);
  const normalizedEagerness = Math.max(0, Math.min(100, Number(narration.eagerness) || 0));
  if (normalizedEagerness <= 0) return false;

  const significantEvents = selectSignificantMinecraftEvents({
    events,
    eagerness: normalizedEagerness,
    state
  });
  if (significantEvents.length <= 0) {
    runtime.store.logAction({
      kind: "minecraft_narration_filtered",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      content: "no_significant_events",
      metadata: {
        scopeKey,
        source,
        eventCount: events.length,
        events
      }
    });
    return false;
  }

  runtime.store.logAction({
    kind: "minecraft_narration_candidate",
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    userId: ownerUserId,
    content: significantEvents.map((event) => event.summary).join("; "),
    metadata: {
      scopeKey,
      source,
      serverLabel,
      eventCount: significantEvents.length,
      categories: significantEvents.map((event) => event.category),
      events: significantEvents.map((event) => event.event)
    }
  });

  if (!runtime.canSendMessage(permissions.maxMessagesPerHour)) {
    runtime.store.logAction({
      kind: "minecraft_narration_blocked",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      content: "hourly_message_cap",
      metadata: { scopeKey, source }
    });
    return false;
  }

  if (!runtime.canTalkNow(settings)) {
    runtime.store.logAction({
      kind: "minecraft_narration_blocked",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      content: "message_cooldown_active",
      metadata: { scopeKey, source }
    });
    return false;
  }

  const minGapMs = Math.max(0, Number(narration.minSecondsBetweenPosts) || 0) * 1000;
  if (minGapMs > 0) {
    const lastActionAt = getLastNarrationActionAt(runtime, normalizedGuildId, normalizedChannelId);
    if (lastActionAt && Date.now() - lastActionAt < minGapMs) {
      runtime.store.logAction({
        kind: "minecraft_narration_blocked",
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        userId: ownerUserId,
        content: "min_gap_active",
        metadata: {
          scopeKey,
          source,
          minSecondsBetweenPosts: Number(narration.minSecondsBetweenPosts) || 0,
          lastActionAt: new Date(lastActionAt).toISOString()
        }
      });
      return false;
    }
  }

  const channel = runtime.client.channels.cache.get(normalizedChannelId);
  if (!isSendableChannel(channel)) {
    runtime.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      content: "minecraft_narration_channel_unavailable",
      metadata: { scopeKey, source }
    });
    return false;
  }

  const recentMessages = runtime.store.getRecentMessages(
    normalizedChannelId,
    MINECRAFT_NARRATION_CONTEXT_MESSAGE_LIMIT
  ) as StoredMessageLike[];
  const botName = getBotName(settings);
  const userPrompt = buildMinecraftNarrationPrompt({
    botName,
    channelName: String(channel?.name || "channel").trim() || "channel",
    serverLabel,
    narrationEagerness: normalizedEagerness,
    recentMessages,
    recentMcChat: Array.isArray(chatHistory) ? chatHistory : [],
    botUsername: botName,
    significantEvents
  });
  const generation = await runtime.llm.generate({
    settings: buildNarrationSettings(settings),
    systemPrompt: buildSystemPrompt(settings),
    userPrompt,
    jsonSchema: MINECRAFT_NARRATION_JSON_SCHEMA,
    trace: {
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      source: "minecraft_narration"
    }
  });
  const parsed = safeJsonParseFromString(generation.text, null) as {
    skip?: unknown;
    text?: unknown;
    reason?: unknown;
  } | null;
  const reason = parsed?.reason == null ? null : String(parsed.reason).trim() || null;
  const text = sanitizeBotText(normalizeSkipSentinel(String(parsed?.text || "")), 1800);
  const skip = parsed?.skip === true || !text || text === "[SKIP]";

  if (skip) {
    runtime.store.logAction({
      kind: "minecraft_narration_skip",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: ownerUserId,
      content: reason || "skip",
      metadata: {
        scopeKey,
        source,
        parseOk: Boolean(parsed),
        reason,
        events: significantEvents.map((event) => ({
          category: event.category,
          summary: event.summary,
          event: event.event
        })),
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      }
    });
    return false;
  }

  await channel.sendTyping();
  await sleep(runtime.getSimulatedTypingDelayMs(350, 900));
  const chunks = splitDiscordMessage(text);
  const sent = await channel.send({ content: chunks[0] });
  for (let index = 1; index < chunks.length; index += 1) {
    await channel.send({ content: chunks[index] });
  }

  runtime.markSpoke();
  runtime.store.recordMessage({
    messageId: sent.id,
    createdAt: sent.createdTimestamp,
    guildId: sent.guildId,
    channelId: sent.channelId,
    authorId: runtime.client.user?.id || "unknown",
    authorName: getBotName(settings),
    isBot: true,
    content: runtime.composeMessageContentForHistory(sent, text),
    referencedMessageId: null
  });
  runtime.store.logAction({
    kind: "minecraft_narration_post",
    guildId: sent.guildId,
    channelId: sent.channelId,
    messageId: sent.id,
    userId: ownerUserId,
    content: text,
    metadata: {
      scopeKey,
      source,
      serverLabel,
      reason,
      events: significantEvents.map((event) => ({
        category: event.category,
        summary: event.summary,
        event: event.event
      })),
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd
      }
    }
  });
  return true;
}
