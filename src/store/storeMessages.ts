// Extracted Store Methods
import { clamp, nowIso } from "../utils.ts";
import { normalizeMessageCreatedAt } from "./storeHelpers.ts";

export function recordMessage(store: any, message) {
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

export function getRecentMessages(store: any, channelId, limit = 40) {
return store.db
.prepare(
`SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
)
.all(String(channelId), clamp(Math.floor(limit), 1, 200));
}

export function getRecentMessagesAcrossGuild(store: any, guildId, limit = 120) {
return store.db
.prepare(
`SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE guild_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
)
.all(String(guildId), clamp(Math.floor(limit), 1, 300));
}

export function searchRelevantMessages(store: any, channelId, queryText, limit = 8) {
const raw = String(queryText ?? "").toLowerCase();
const tokens = [...new Set(raw.match(/[a-z0-9]{4,}/g) ?? [])].slice(0, 5);

if (!tokens.length) {
  return store.db
    .prepare(
      `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
           FROM messages
           WHERE channel_id = ? AND is_bot = 0
           ORDER BY created_at DESC
           LIMIT ?`
    )
    .all(String(channelId), clamp(limit, 1, 24));
}

const clauses = tokens.map(() => "content LIKE ?").join(" OR ");
const args = [String(channelId), ...tokens.map((t) => `%${t}%`), clamp(limit, 1, 24)];

return store.db
  .prepare(
    `SELECT message_id, created_at, channel_id, author_id, author_name, is_bot, content
         FROM messages
         WHERE channel_id = ? AND is_bot = 0 AND (${clauses})
         ORDER BY created_at DESC
         LIMIT ?`
  )
  .all(...args);
}

export function getActiveChannels(store: any, guildId, hours = 24, limit = 10) {
const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

return store.db
  .prepare(
    `SELECT channel_id, COUNT(*) AS message_count
         FROM messages
         WHERE guild_id = ? AND is_bot = 0 AND created_at >= ?
         GROUP BY channel_id
         ORDER BY message_count DESC
         LIMIT ?`
  )
  .all(String(guildId), since, clamp(limit, 1, 50));
}
