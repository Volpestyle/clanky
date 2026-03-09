// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { clamp } from "../utils.ts";
import { normalizeMessageCreatedAt } from "./storeHelpers.ts";

const EN_CONVERSATION_SEARCH_STOPWORDS = new Set([
  "about",
  "again",
  "anything",
  "before",
  "could",
  "found",
  "hello",
  "just",
  "know",
  "like",
  "look",
  "looking",
  "maybe",
  "remember",
  "said",
  "something",
  "talk",
  "talked",
  "tell",
  "that",
  "them",
  "then",
  "there",
  "they",
  "this",
  "those",
  "today",
  "what",
  "when",
  "where",
  "which",
  "without",
  "would",
  "yeah",
  "yesterday",
  "your"
]);

interface MessageStore {
  db: Database;
}

interface MessageSqlRow {
  message_id: string;
  created_at: string;
  guild_id?: string | null;
  channel_id: string;
  author_id: string;
  author_name: string;
  is_bot: number;
  content: string;
  referenced_message_id?: string | null;
}

interface StoredMessageRow extends Record<string, unknown> {
  message_id: string;
  created_at: string;
  guild_id?: string | null;
  channel_id: string;
  author_id: string;
  author_name: string;
  is_bot: boolean;
  content: string;
  referenced_message_id?: string | null;
}

interface ConversationMessageRow extends MessageSqlRow {
  guild_id: string | null;
}

interface ActiveChannelRow {
  channel_id: string;
  message_count: number;
}

interface ReferencedMessageStatsRow {
  referenced_message_id: string;
  reaction_count: number;
  reply_count: number;
}

function mapStoredMessageRow(row: MessageSqlRow): StoredMessageRow {
  return {
    ...row,
    is_bot: row.is_bot === 1
  };
}

export function recordMessage(store: MessageStore, message) {
const createdAt = normalizeMessageCreatedAt(
  message?.createdAt ?? message?.created_at ?? message?.createdTimestamp
);
store.db
  .prepare(
    `INSERT INTO messages(
          message_id,
          created_at,
          guild_id,
          channel_id,
          author_id,
          author_name,
          is_bot,
          content,
          referenced_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          author_id = excluded.author_id,
          author_name = excluded.author_name,
          is_bot = excluded.is_bot,
          content = excluded.content,
          referenced_message_id = excluded.referenced_message_id`
  )
  .run(
    String(message.messageId),
    createdAt,
    message.guildId ? String(message.guildId) : null,
    String(message.channelId),
    String(message.authorId),
    String(message.authorName).slice(0, 80),
    message.isBot ? 1 : 0,
    String(message.content ?? "").slice(0, 2000),
    message.referencedMessageId ? String(message.referencedMessageId) : null
  );
}

export function getRecentMessages(store: MessageStore, channelId, limit = 40) {
return store.db
.prepare<MessageSqlRow, [string, number]>(
`SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
)
.all(String(channelId), clamp(Math.floor(limit), 1, 200))
.map(mapStoredMessageRow);
}

export function getRecentMessagesAcrossGuild(store: MessageStore, guildId, limit = 120) {
return store.db
.prepare<MessageSqlRow, [string, number]>(
`SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE guild_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
)
.all(String(guildId), clamp(Math.floor(limit), 1, 300))
.map(mapStoredMessageRow);
}

export function searchRelevantMessages(store: MessageStore, channelId, queryText, limit = 8) {
const raw = String(queryText ?? "").toLowerCase();
const tokens = [...new Set(raw.match(/[a-z0-9]{4,}/g) ?? [])].slice(0, 5);

if (!tokens.length) {
  return store.db
    .prepare<MessageSqlRow, [string, number]>(
      `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
           FROM messages
           WHERE channel_id = ? AND is_bot = 0
           ORDER BY created_at DESC
           LIMIT ?`
    )
    .all(String(channelId), clamp(limit, 1, 24))
    .map(mapStoredMessageRow);
}

const clauses = tokens.map(() => "content LIKE ?").join(" OR ");
const args = [String(channelId), ...tokens.map((t) => `%${t}%`), clamp(limit, 1, 24)];

return store.db
  .prepare<MessageSqlRow, Array<string | number>>(
    `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ? AND is_bot = 0 AND (${clauses})
         ORDER BY created_at DESC
         LIMIT ?`
  )
  .all(...args)
  .map(mapStoredMessageRow);
}

function normalizeConversationSearchTokens(queryText) {
const raw = String(queryText || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();
if (!raw) return [];

return [...new Set(raw.match(/[a-z0-9]{3,}/g) || [])]
  .filter((token) => !EN_CONVERSATION_SEARCH_STOPWORDS.has(token))
  .slice(0, 8);
}

function scoreConversationMessage(row, {
  tokens = [],
  phrase = "",
  channelId = null
} = {}) {
const content = String(row?.content || "").toLowerCase();
const authorName = String(row?.author_name || "").toLowerCase();
const rowChannelId = String(row?.channel_id || "").trim();
const normalizedChannelId = String(channelId || "").trim();
const createdAtMs = Date.parse(String(row?.created_at || ""));
const ageMinutes = Number.isFinite(createdAtMs)
  ? Math.max(0, Math.round((Date.now() - createdAtMs) / 60000))
  : null;

let score = 0;
if (phrase && content.includes(phrase)) {
  score += 10;
}

for (const token of tokens) {
  if (!token) continue;
  if (content.includes(token)) {
    score += 3;
    continue;
  }
  if (authorName.includes(token)) {
    score += 1;
  }
}

if (normalizedChannelId && rowChannelId && rowChannelId === normalizedChannelId) {
  score += 4;
}
if (Number.isFinite(ageMinutes)) {
  if (ageMinutes <= 30) {
    score += 3;
  } else if (ageMinutes <= 6 * 60) {
    score += 2;
  } else if (ageMinutes <= 24 * 60) {
    score += 1;
  }
}

return {
  score,
  ageMinutes
};
}

function fetchConversationWindowRows(
  store: MessageStore,
  anchorRow: Pick<ConversationMessageRow, "message_id" | "channel_id" | "created_at">,
  before = 1,
  after = 1
) {
if (!anchorRow?.message_id || !anchorRow?.channel_id || !anchorRow?.created_at) return [];

const boundedBefore = clamp(Math.floor(Number(before) || 1), 0, 4);
const boundedAfter = clamp(Math.floor(Number(after) || 1), 0, 4);
const channelId = String(anchorRow.channel_id);
const createdAt = String(anchorRow.created_at);
const messageId = String(anchorRow.message_id);

const beforeRows = boundedBefore > 0
  ? store.db
      .prepare<ConversationMessageRow, [string, string, number]>(
        `SELECT message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content
             FROM messages
             WHERE channel_id = ?
               AND created_at < ?
             ORDER BY created_at DESC
             LIMIT ?`
      )
      .all(channelId, createdAt, boundedBefore)
      .reverse()
  : [];

const anchorRows = store.db
  .prepare<ConversationMessageRow, [string]>(
    `SELECT message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE message_id = ?
         LIMIT 1`
  )
  .all(messageId);

const afterRows = boundedAfter > 0
  ? store.db
      .prepare<ConversationMessageRow, [string, string, number]>(
        `SELECT message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content
             FROM messages
             WHERE channel_id = ?
               AND created_at > ?
             ORDER BY created_at ASC
             LIMIT ?`
      )
      .all(channelId, createdAt, boundedAfter)
  : [];

return [...beforeRows, ...anchorRows, ...afterRows];
}

export function searchConversationWindows(store: MessageStore, {
    guildId,
    channelId = null,
    queryText = "",
    limit = 4,
    maxAgeHours = 168,
    before = 1,
    after = 1
  }) {
const normalizedGuildId = String(guildId || "").trim();
if (!normalizedGuildId) return [];

const tokens = normalizeConversationSearchTokens(queryText);
const normalizedPhrase = String(queryText || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 180);
if (!tokens.length) return [];

const boundedLimit = clamp(Math.floor(Number(limit) || 4), 1, 8);
const boundedMaxAgeHours = clamp(Math.floor(Number(maxAgeHours) || 168), 1, 24 * 30);
const sinceIso = new Date(Date.now() - boundedMaxAgeHours * 60 * 60 * 1000).toISOString();
const candidateLimit = clamp(boundedLimit * 20, boundedLimit, 160);
const likeArgs = tokens.map((token) => `%${token}%`);
const tokenClauses = tokens.map(() => "content LIKE ? COLLATE NOCASE");
const args: Array<string | number> = [normalizedGuildId, sinceIso];
let whereClause = "";
if (tokenClauses.length) {
  whereClause = ` AND (${tokenClauses.join(" OR ")})`;
  args.push(...likeArgs);
}
args.push(candidateLimit);

const rows = store.db
  .prepare<ConversationMessageRow, Array<string | number>>(
    `SELECT message_id, created_at, guild_id, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE guild_id = ?
           AND created_at >= ?${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`
  )
  .all(...args);

if (!rows.length) return [];

const normalizedChannelId = String(channelId || "").trim() || null;
const rankedRows = rows
  .map((row, index) => {
    const scored = scoreConversationMessage(row, {
      tokens,
      phrase: normalizedPhrase,
      channelId: normalizedChannelId
    });
    return {
      ...row,
      _score: scored.score,
      _ageMinutes: scored.ageMinutes,
      _rank: index
    };
  })
  .filter((row) => row._score > 0)
  .sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return a._rank - b._rank;
  });

const windows = [];
const usedMessageIds = new Set();
for (const row of rankedRows) {
  if (windows.length >= boundedLimit) break;
  if (usedMessageIds.has(String(row.message_id || ""))) continue;
  const messages = fetchConversationWindowRows(store, row, before, after);
  if (!messages.length) continue;
  const messageIds = messages
    .map((entry) => String(entry?.message_id || "").trim())
    .filter(Boolean);
  if (!messageIds.length) continue;
  if (messageIds.some((messageId) => usedMessageIds.has(messageId))) continue;
  for (const messageId of messageIds) {
    usedMessageIds.add(messageId);
  }
  windows.push({
    anchorMessageId: String(row.message_id || "").trim(),
    createdAt: String(row.created_at || "").trim(),
    guildId: String(row.guild_id || "").trim() || null,
    channelId: String(row.channel_id || "").trim() || null,
    authorId: String(row.author_id || "").trim() || null,
    authorName: String(row.author_name || "").trim() || null,
    ageMinutes: row._ageMinutes,
    score: row._score,
    messages: messages.map((entry) => ({
      message_id: String(entry?.message_id || "").trim(),
      created_at: String(entry?.created_at || "").trim(),
      guild_id: String(entry?.guild_id || "").trim() || null,
      channel_id: String(entry?.channel_id || "").trim() || null,
      author_id: String(entry?.author_id || "").trim() || null,
      author_name: String(entry?.author_name || "").trim() || "unknown",
      is_bot: Number(entry?.is_bot) === 1 ? 1 : 0,
      content: String(entry?.content || "").trim()
    }))
  });
}

return windows;
}

export function getActiveChannels(store: MessageStore, guildId, hours = 24, limit = 10) {
const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

return store.db
  .prepare<ActiveChannelRow, [string, string, number]>(
    `SELECT channel_id, COUNT(*) AS message_count
         FROM messages
         WHERE guild_id = ? AND is_bot = 0 AND created_at >= ?
         GROUP BY channel_id
         ORDER BY message_count DESC
         LIMIT ?`
  )
  .all(String(guildId), since, clamp(limit, 1, 50));
}

export function getReferencedMessageStats(
  store: MessageStore,
  {
    messageIds,
    guildId = null,
    sinceIso = null
  }: {
    messageIds: string[];
    guildId?: string | null;
    sinceIso?: string | null;
  }
) {
  const normalizedMessageIds = [...new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!normalizedMessageIds.length) return [];

  const params: Array<string | number> = [];
  const conditions = [
    `referenced_message_id IN (${normalizedMessageIds.map(() => "?").join(", ")})`,
    "is_bot = 0"
  ];
  params.push(...normalizedMessageIds);

  const normalizedGuildId = String(guildId || "").trim();
  if (normalizedGuildId) {
    conditions.push("guild_id = ?");
    params.push(normalizedGuildId);
  }

  const normalizedSinceIso = String(sinceIso || "").trim();
  if (normalizedSinceIso) {
    conditions.push("created_at >= ?");
    params.push(normalizedSinceIso);
  }

  return store.db
    .prepare<ReferencedMessageStatsRow, Array<string | number>>(
      `SELECT referenced_message_id,
              SUM(CASE WHEN message_id LIKE 'reaction:%' THEN 1 ELSE 0 END) AS reaction_count,
              SUM(CASE WHEN message_id LIKE 'reaction:%' THEN 0 ELSE 1 END) AS reply_count
         FROM messages
         WHERE ${conditions.join(" AND ")}
         GROUP BY referenced_message_id`
    )
    .all(...params)
    .map((row) => ({
      referenced_message_id: String(row?.referenced_message_id || "").trim(),
      reaction_count: Number(row?.reaction_count || 0),
      reply_count: Number(row?.reply_count || 0)
    }));
}
