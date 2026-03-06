import { formatReactionSummary } from "../botHelpers.ts";
import { getBotName } from "../settings/agentStack.ts";
import type { BotContext } from "./botContext.ts";
import {
  CONVERSATION_HISTORY_PROMPT_LIMIT,
  CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
  CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER,
  CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE,
  LOOKUP_CONTEXT_PROMPT_LIMIT,
  LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
} from "./replyPipelineShared.ts";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_IMAGE_INPUTS = 3;
const LOOKUP_CONTEXT_TTL_HOURS = 48;
const LOOKUP_CONTEXT_MAX_RESULTS = 5;
const LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL = 120;

type HistoryAttachment = {
  url?: string;
  proxyURL?: string;
  name?: string;
  contentType?: string;
};

type HistoryAttachmentCollection = {
  size?: number;
  values: () => IterableIterator<HistoryAttachment>;
};

type HistoryEmbed = {
  url?: string;
  video?: {
    url?: string;
    proxyURL?: string;
  } | null;
};

type HistoryReactionCollection = {
  size?: number;
  values: () => IterableIterator<{
    count?: number;
    emoji?: {
      id?: string;
      name?: string;
    } | null;
  }>;
};

type HistoryMember = {
  displayName?: string | null;
  user?: {
    username?: string;
  } | null;
};

export type HistoryMessage = {
  id?: string;
  createdTimestamp?: number;
  guildId?: string;
  channelId?: string;
  content?: string;
  attachments?: HistoryAttachmentCollection;
  embeds?: HistoryEmbed[];
  reactions?: {
    cache?: HistoryReactionCollection;
  } | null;
  reference?: {
    messageId?: string;
  } | null;
  partial?: boolean;
  fetch?: () => Promise<HistoryMessage>;
  author?: {
    id?: string;
    username?: string;
    bot?: boolean;
  } | null;
  member?: {
    displayName?: string | null;
  } | null;
  guild?: {
    members?: {
      cache?: {
        get?: (id: string) => HistoryMember | undefined;
      } | null;
    } | null;
  } | null;
};

type HistoryReaction = {
  partial?: boolean;
  fetch?: () => Promise<HistoryReaction>;
  emoji?: {
    id?: string;
    name?: string;
  } | null;
  message?: HistoryMessage | null;
};

type HistoryUser = {
  id?: string;
  username?: string;
  globalName?: string | null;
};

type LookupContextOptions = {
  guildId?: string | null;
  channelId?: string | null;
  queryText?: string;
  limit?: number;
  maxAgeHours?: number;
};

type ConversationHistoryOptions = LookupContextOptions & {
  before?: number;
  after?: number;
};

type RememberLookupContextOptions = {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  source?: string;
  query?: string;
  provider?: string | null;
  results?: unknown[];
};

function getBotUserId(ctx: BotContext) {
  return String(ctx.botUserId || ctx.client.user?.id || "").trim();
}

async function resolvePartialMessage(message: HistoryMessage | null | undefined) {
  if (!message) return null;
  let resolved = message;
  if (resolved.partial && typeof resolved.fetch === "function") {
    try {
      resolved = await resolved.fetch();
    } catch {
      return null;
    }
  }
  return resolved;
}

async function resolvePartialReaction(reaction: HistoryReaction | null | undefined) {
  if (!reaction) return null;
  let resolved = reaction;
  if (resolved.partial && typeof resolved.fetch === "function") {
    try {
      resolved = await resolved.fetch();
    } catch {
      return null;
    }
  }
  return resolved;
}

export function composeMessageContentForHistory(message: HistoryMessage, baseText = "") {
  const parts = [];
  const text = String(baseText || "").trim();
  if (text) parts.push(text);

  if (message?.attachments?.size) {
    for (const attachment of message.attachments.values()) {
      const url = String(attachment.url || attachment.proxyURL || "").trim();
      if (!url) continue;
      parts.push(url);
    }
  }

  if (Array.isArray(message?.embeds) && message.embeds.length) {
    for (const embed of message.embeds) {
      const videoUrl = String(embed?.video?.url || embed?.video?.proxyURL || "").trim();
      const embedUrl = String(embed?.url || "").trim();
      if (videoUrl) parts.push(videoUrl);
      if (embedUrl) parts.push(embedUrl);
    }
  }

  const reactionSummary = formatReactionSummary(message);
  if (reactionSummary) {
    parts.push(`[reactions: ${reactionSummary}]`);
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function getImageInputs(message: HistoryMessage) {
  const images = [];

  for (const attachment of message.attachments?.values?.() || []) {
    if (images.length >= MAX_IMAGE_INPUTS) break;

    const url = String(attachment.url || attachment.proxyURL || "").trim();
    if (!url) continue;

    const filename = String(attachment.name || "").trim();
    const contentType = String(attachment.contentType || "").toLowerCase();
    const urlPath = url.split("?")[0];
    const isImage =
      contentType.startsWith("image/") || IMAGE_EXT_RE.test(filename) || IMAGE_EXT_RE.test(urlPath);
    if (!isImage) continue;

    images.push({ url, filename, contentType });
  }

  return images;
}

export async function syncMessageSnapshotFromReaction(
  ctx: BotContext,
  reaction: HistoryReaction | null | undefined
) {
  const resolvedReaction = await resolvePartialReaction(reaction);
  if (!resolvedReaction) return;
  await syncMessageSnapshot(ctx, resolvedReaction.message);
}

export async function recordReactionHistoryEvent(
  ctx: BotContext,
  reaction: HistoryReaction | null | undefined,
  user: HistoryUser | null | undefined
) {
  if (!reaction || !user) return;

  const resolvedReaction = await resolvePartialReaction(reaction);
  if (!resolvedReaction) return;

  const targetMessage = await resolvePartialMessage(resolvedReaction.message);
  const botUserId = getBotUserId(ctx);
  const targetAuthorId = String(targetMessage?.author?.id || "").trim();
  if (!botUserId || targetAuthorId !== botUserId) return;

  const reactingUserId = String(user.id || "").trim();
  if (!reactingUserId || reactingUserId === botUserId) return;

  const channelId = String(targetMessage?.channelId || "").trim();
  const guildId = String(targetMessage?.guildId || "").trim();
  const targetMessageId = String(targetMessage?.id || "").trim();
  if (!channelId || !guildId || !targetMessageId) return;

  const reactionLabel = describeReactionForHistory(resolvedReaction.emoji);
  if (!reactionLabel) return;

  const reactingMember = targetMessage?.guild?.members?.cache?.get?.(reactingUserId);
  const reactingName = String(
    reactingMember?.displayName || user.globalName || user.username || reactingUserId
  ).trim();
  const targetAuthorName = String(
    targetMessage?.member?.displayName ||
      targetMessage?.author?.username ||
      getBotName(ctx.store.getSettings())
  ).trim();
  const targetSnippet = summarizeReactionTargetText(String(targetMessage?.content || ""));
  const content = [
    `${reactingName} reacted with ${reactionLabel} to ${targetAuthorName}'s message`,
    targetSnippet ? `"${targetSnippet}"` : ""
  ]
    .filter(Boolean)
    .join(": ");

  ctx.store.recordMessage({
    messageId: buildReactionEventMessageId({
      targetMessageId,
      reactingUserId,
      emoji: reactionLabel,
      createdAt: Date.now()
    }),
    createdAt: Date.now(),
    guildId,
    channelId,
    authorId: reactingUserId,
    authorName: reactingName,
    isBot: false,
    content,
    referencedMessageId: targetMessageId
  });
}

export async function syncMessageSnapshot(
  ctx: BotContext,
  message: HistoryMessage | null | undefined
) {
  const resolved = await resolvePartialMessage(message);
  if (!resolved?.guildId || !resolved?.channelId || !resolved?.id || !resolved?.author?.id) return;

  ctx.store.recordMessage({
    messageId: resolved.id,
    createdAt: resolved.createdTimestamp,
    guildId: resolved.guildId,
    channelId: resolved.channelId,
    authorId: resolved.author.id,
    authorName: resolved.member?.displayName || resolved.author.username || "unknown",
    isBot: Boolean(resolved.author.bot),
    content: composeMessageContentForHistory(resolved, String(resolved.content || "").trim()),
    referencedMessageId: resolved.reference?.messageId
  });
}

export function getRecentLookupContextForPrompt(
  ctx: BotContext,
  {
    guildId = null,
    channelId = null,
    queryText = "",
    limit = LOOKUP_CONTEXT_PROMPT_LIMIT,
    maxAgeHours = LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
  }: LookupContextOptions = {}
) {
  if (!ctx.store || typeof ctx.store.searchLookupContext !== "function") return [];
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  try {
    return ctx.store.searchLookupContext({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      queryText: normalizedQuery,
      limit,
      maxAgeHours
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: getBotUserId(ctx) || null,
      content: `lookup_context_search: ${String(error?.message || error)}`
    });
    return [];
  }
}

export function getConversationHistoryForPrompt(
  ctx: BotContext,
  {
    guildId = null,
    channelId = null,
    queryText = "",
    limit = CONVERSATION_HISTORY_PROMPT_LIMIT,
    maxAgeHours = CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
    before = CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE,
    after = CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER
  }: ConversationHistoryOptions = {}
) {
  if (!ctx.store || typeof ctx.store.searchConversationWindows !== "function") return [];
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  if (!normalizedQuery) return [];
  try {
    return ctx.store.searchConversationWindows({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      queryText: normalizedQuery,
      limit,
      maxAgeHours,
      before,
      after
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: getBotUserId(ctx) || null,
      content: `conversation_history_search: ${String(error?.message || error)}`
    });
    return [];
  }
}

export function rememberRecentLookupContext(
  ctx: BotContext,
  {
    guildId = null,
    channelId = null,
    userId = null,
    source = "reply_web_lookup",
    query = "",
    provider = null,
    results = []
  }: RememberLookupContextOptions = {}
) {
  if (!ctx.store || typeof ctx.store.recordLookupContext !== "function") return false;
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return false;
  const normalizedChannelId = String(channelId || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedSource = String(source || "reply_web_lookup")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const normalizedQuery = String(query || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  if (!normalizedQuery) return false;
  const normalizedResults = (Array.isArray(results) ? results : []).slice(0, LOOKUP_CONTEXT_MAX_RESULTS);
  if (!normalizedResults.length) return false;
  try {
    return ctx.store.recordLookupContext({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: normalizedUserId,
      source: normalizedSource,
      query: normalizedQuery,
      provider,
      results: normalizedResults,
      ttlHours: LOOKUP_CONTEXT_TTL_HOURS,
      maxResults: LOOKUP_CONTEXT_MAX_RESULTS,
      maxRowsPerChannel: LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL
    });
  } catch (error) {
    ctx.store.logAction({
      kind: "bot_error",
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      userId: getBotUserId(ctx) || null,
      content: `lookup_context_record: ${String(error?.message || error)}`
    });
    return false;
  }
}

export function isLikelyImageUrl(rawUrl: string) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (IMAGE_EXT_RE.test(pathname) || pathname.endsWith(".avif")) return true;
    const formatParam = String(parsed.searchParams.get("format") || "")
      .trim()
      .toLowerCase();
    if (formatParam && /^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/.test(formatParam)) return true;
    return false;
  } catch {
    return false;
  }
}

export function parseHistoryImageReference(rawUrl: string) {
  const text = String(rawUrl || "").trim();
  if (!text) return { filename: "(unnamed)", contentType: "" };
  try {
    const parsed = new URL(text);
    const pathname = String(parsed.pathname || "");
    const segment = pathname.split("/").pop() || "";
    const decoded = decodeURIComponent(segment || "");
    const fallback = decoded || segment || "(unnamed)";
    const ext = fallback.includes(".") ? fallback.split(".").pop() : "";
    let contentType = normalizeImageContentTypeFromExt(ext);
    if (!contentType) {
      const formatParam = String(parsed.searchParams.get("format") || "")
        .trim()
        .toLowerCase();
      contentType = normalizeImageContentTypeFromExt(formatParam);
    }
    return {
      filename: fallback,
      contentType
    };
  } catch {
    return { filename: "(unnamed)", contentType: "" };
  }
}

export function normalizeImageContentTypeFromExt(rawExt: string) {
  const ext = String(rawExt || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!ext) return "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "avif") return "image/avif";
  return "";
}

function describeReactionForHistory(emoji: HistoryReaction["emoji"]) {
  const id = String(emoji?.id || "").trim();
  const name = String(emoji?.name || "").trim();
  if (id && name) return `:${name}:`;
  if (name) return name;
  return "";
}

function summarizeReactionTargetText(text: string, maxLen = 80) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLen - 3)).trimEnd()}...`;
}

function buildReactionEventMessageId({
  targetMessageId,
  reactingUserId,
  emoji,
  createdAt
}: {
  targetMessageId: string;
  reactingUserId: string;
  emoji: string;
  createdAt: number;
}) {
  const safeEmoji = String(emoji || "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 32);
  return `reaction:${targetMessageId}:${reactingUserId}:${safeEmoji}:${Number(createdAt) || Date.now()}`;
}
