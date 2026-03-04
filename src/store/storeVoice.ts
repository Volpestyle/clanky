// Extracted Store Methods
import { clamp } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";

export function getRecentVoiceSessions(store: any, limit = 3) {
const boundedLimit = clamp(Math.floor(Number(limit) || 3), 1, 20);
const fetchLimit = boundedLimit * 6;
const rows = store.db
  .prepare(
    `SELECT id, created_at, guild_id, kind, content, metadata
         FROM actions
         WHERE kind IN ('voice_session_start', 'voice_session_end')
         ORDER BY created_at DESC
         LIMIT ?`
  )
  .all(fetchLimit);

const starts = new Map<string, { guildId: string; mode: string; startedAt: string }>();
const ends = new Map<string, { endedAt: string; durationSeconds: number; endReason: string }>();

for (const row of rows) {
  const meta = safeJsonParse(row.metadata, null);
  const sessionId = meta?.sessionId;
  if (!sessionId) continue;

  if (row.kind === "voice_session_start" && !starts.has(sessionId)) {
    starts.set(sessionId, {
      guildId: row.guild_id || "",
      mode: meta.mode || "voice_agent",
      startedAt: row.created_at
    });
  } else if (row.kind === "voice_session_end" && !ends.has(sessionId)) {
    ends.set(sessionId, {
      endedAt: row.created_at,
      durationSeconds: Number(meta.durationSeconds) || 0,
      endReason: row.content || "unknown"
    });
  }
}

const sessions: Array<{
  sessionId: string;
  guildId: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  endReason: string;
}> = [];

for (const [sessionId, end] of ends) {
  const start = starts.get(sessionId);
  if (!start) continue;
  sessions.push({ sessionId, ...start, ...end });
}

sessions.sort((a, b) => (b.endedAt > a.endedAt ? 1 : -1));
return sessions.slice(0, boundedLimit);
}

export function getVoiceSessionEvents(store: any, sessionId: string, limit = 500) {
const sanitized = String(sessionId || "").replace(/[%_\\]/g, "");
if (!sanitized) return [];
const boundedLimit = clamp(Math.floor(Number(limit) || 500), 1, 2000);

const rows = store.db
  .prepare(
    `SELECT id, created_at, guild_id, channel_id, message_id, user_id, kind, content, metadata, usd_cost
         FROM actions
         WHERE kind LIKE 'voice\\_%' ESCAPE '\\'
           AND metadata LIKE ?
         ORDER BY created_at ASC
         LIMIT ?`
  )
  .all(`%"sessionId":"${sanitized}"%`, boundedLimit);

return rows.map((row) => ({
  ...row,
  metadata: safeJsonParse(row.metadata, null)
}));
}
