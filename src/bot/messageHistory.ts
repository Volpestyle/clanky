import { formatReactionSummary } from "./botHelpers.ts";
import { getBotName } from "../settings/agentStack.ts";
import type { BotContext } from "./botContext.ts";
import {
  CONVERSATION_HISTORY_PROMPT_LIMIT,
  CONVERSATION_HISTORY_PROMPT_MAX_AGE_HOURS,
  CONVERSATION_HISTORY_PROMPT_WINDOW_AFTER,
  CONVERSATION_HISTORY_PROMPT_WINDOW_BEFORE
} from "./replyPipelineShared.ts";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg)$/i;
const ANIMATED_IMAGE_EXT_RE = /\.gif$/i;
const MAX_IMAGE_INPUTS = 3;
const MAX_VIDEO_INPUTS = 3;

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
  type?: string;
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

type HistoryMessage = {
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

type ConversationHistoryOptions = {
  guildId?: string | null;
  channelId?: string | null;
  queryText?: string;
  limit?: number;
  maxAgeHours?: number;
  before?: number;
  after?: number;
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
    const isAnimatedImage = contentType === "image/gif" || ANIMATED_IMAGE_EXT_RE.test(filename) || ANIMATED_IMAGE_EXT_RE.test(urlPath);
    const isImage =
      contentType.startsWith("image/") || IMAGE_EXT_RE.test(filename) || IMAGE_EXT_RE.test(urlPath);
    if (!isImage || isAnimatedImage) continue;

    images.push({ url, filename, contentType });
  }

  return images;
}

function deriveFilenameFromUrl(url: string, fallback = "(unnamed)") {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return fallback;
  try {
    const parsed = new URL(normalizedUrl);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1) || "";
    const decoded = decodeURIComponent(segment).trim();
    return decoded || fallback;
  } catch {
    const segment = normalizedUrl.split("?")[0].split("/").filter(Boolean).at(-1) || "";
    const decoded = decodeURIComponent(segment).trim();
    return decoded || fallback;
  }
}

function isLikelyVideoAttachment({
  url,
  filename,
  contentType
}: {
  url: string;
  filename: string;
  contentType: string;
}) {
  const urlPath = String(url || "").split("?")[0];
  return (
    String(contentType || "").startsWith("video/") ||
    String(contentType || "").toLowerCase() === "image/gif" ||
    VIDEO_EXT_RE.test(String(filename || "")) ||
    VIDEO_EXT_RE.test(urlPath) ||
    ANIMATED_IMAGE_EXT_RE.test(String(filename || "")) ||
    ANIMATED_IMAGE_EXT_RE.test(urlPath)
  );
}

export function getVideoInputs(message: HistoryMessage) {
  const videos = [];
  const seen = new Set();
  const pushVideo = (entry: { url: string; filename: string; contentType: string }) => {
    const url = String(entry.url || "").trim();
    if (!url || seen.has(url) || videos.length >= MAX_VIDEO_INPUTS) return;
    seen.add(url);
    videos.push({
      url,
      filename: String(entry.filename || "(unnamed)").trim() || "(unnamed)",
      contentType: String(entry.contentType || "").toLowerCase()
    });
  };

  for (const attachment of message.attachments?.values?.() || []) {
    if (videos.length >= MAX_VIDEO_INPUTS) break;

    const url = String(attachment.url || attachment.proxyURL || "").trim();
    if (!url) continue;
    const filename = String(attachment.name || "").trim() || deriveFilenameFromUrl(url);
    const contentType = String(attachment.contentType || "").toLowerCase();
    if (!isLikelyVideoAttachment({ url, filename, contentType })) continue;

    pushVideo({ url, filename, contentType });
  }

  for (const embed of Array.isArray(message.embeds) ? message.embeds : []) {
    if (videos.length >= MAX_VIDEO_INPUTS) break;

    const embedVideoUrl = String(embed?.video?.url || embed?.video?.proxyURL || "").trim();
    if (embedVideoUrl) {
      const filename = deriveFilenameFromUrl(embedVideoUrl);
      pushVideo({
        url: embedVideoUrl,
        filename,
        contentType: ""
      });
      continue;
    }

    const embedUrl = String(embed?.url || "").trim();
    if (!embedUrl) continue;
    const filename = deriveFilenameFromUrl(embedUrl);
    const embedType = String(embed?.type || "").toLowerCase();
    if (embedType !== "video" && !isLikelyVideoAttachment({ url: embedUrl, filename, contentType: "" })) continue;
    pushVideo({
      url: embedUrl,
      filename,
      contentType: ""
    });
  }

  return videos;
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

export async function getConversationHistoryForPrompt(
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
  const normalizedGuildId = String(guildId || "").trim() || null;
  const normalizedChannelId = String(channelId || "").trim() || null;
  if (!normalizedGuildId && !normalizedChannelId) return [];
  const normalizedQuery = String(queryText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  if (!normalizedQuery) return [];
  try {
    if (ctx.memory && typeof ctx.memory.searchConversationHistory === "function") {
      return await ctx.memory.searchConversationHistory({
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        queryText: normalizedQuery,
        settings: ctx.store.getSettings(),
        trace: {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId,
          source: "conversation_history_prompt"
        },
        limit,
        maxAgeHours,
        before,
        after
      });
    }
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
    try {
      ctx.store.logAction({
        kind: "bot_error",
        guildId: normalizedGuildId || null,
        channelId: normalizedChannelId,
        userId: getBotUserId(ctx) || null,
        content: `conversation_history_search: ${String(error?.message || error)}`
      });
    } catch {
      // Logging must not mask the original prompt-context fallback path.
    }
    return [];
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

function normalizeImageContentTypeFromExt(rawExt: string) {
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
