import type { Database } from "bun:sqlite";

import { clamp, nowIso } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";

const ADAPTIVE_DIRECTIVE_TEXT_MAX_CHARS = 420;
const ADAPTIVE_DIRECTIVE_PREVIEW_MAX_CHARS = 220;
const ADAPTIVE_DIRECTIVE_KIND_SET = new Set(["guidance", "behavior"]);

interface AdaptiveDirectiveAction {
  kind: string;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  userId?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  usdCost?: number | null;
}

interface AdaptiveDirectiveStore {
  db: Database;
  logAction(entry: AdaptiveDirectiveAction): void;
}

type AdaptiveDirectiveSqlRow = Record<string, unknown>;

function isAdaptiveDirectiveSqlRow(value: unknown): value is AdaptiveDirectiveSqlRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toAdaptiveDirectiveSqlRow(value: unknown): AdaptiveDirectiveSqlRow | null {
  return isAdaptiveDirectiveSqlRow(value) ? value : null;
}

function toAdaptiveDirectiveSqlRows(value: unknown): AdaptiveDirectiveSqlRow[] {
  return Array.isArray(value) ? value.filter(isAdaptiveDirectiveSqlRow) : [];
}

function normalizeAdaptiveDirectiveText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ADAPTIVE_DIRECTIVE_TEXT_MAX_CHARS);
}

function normalizeAdaptiveDirectiveActorName(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function normalizeAdaptiveDirectiveReason(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeAdaptiveDirectiveKind(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ADAPTIVE_DIRECTIVE_KIND_SET.has(normalized) ? normalized : "guidance";
}

function normalizeAdaptiveDirectiveTokens(value: unknown) {
  return [...new Set(
    normalizeAdaptiveDirectiveText(value)
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) || []
  )].slice(0, 20);
}

function mapAdaptiveDirectiveRow(row: AdaptiveDirectiveSqlRow | null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: String(row.guild_id || ""),
    directiveKind: normalizeAdaptiveDirectiveKind(row.directive_kind),
    noteText: String(row.note_text || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    createdByUserId: String(row.created_by_user_id || "").trim() || null,
    createdByName: String(row.created_by_name || "").trim() || null,
    updatedByUserId: String(row.updated_by_user_id || "").trim() || null,
    updatedByName: String(row.updated_by_name || "").trim() || null,
    sourceMessageId: String(row.source_message_id || "").trim() || null,
    sourceText: String(row.source_text || "").trim() || null,
    isActive: Boolean(Number(row.is_active) || 0),
    removedAt: String(row.removed_at || "").trim() || null,
    removedByUserId: String(row.removed_by_user_id || "").trim() || null,
    removedByName: String(row.removed_by_name || "").trim() || null,
    removalReason: String(row.removal_reason || "").trim() || null
  };
}

function insertAdaptiveDirectiveEvent(store: AdaptiveDirectiveStore, {
  noteId = null,
  guildId,
  directiveKind = "guidance",
  eventType,
  actorUserId = null,
  actorName = null,
  noteText,
  detailText = null,
  sourceMessageId = null,
  metadata = null
}: {
  noteId?: number | null;
  guildId: string;
  directiveKind?: string;
  eventType: string;
  actorUserId?: string | null;
  actorName?: string | null;
  noteText: string;
  detailText?: string | null;
  sourceMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  store.db.prepare(
    `INSERT INTO adaptive_style_note_events(
       created_at,
       note_id,
       guild_id,
       directive_kind,
       event_type,
       actor_user_id,
       actor_name,
       note_text,
       detail_text,
       source_message_id,
       metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nowIso(),
    Number.isInteger(Number(noteId)) ? Number(noteId) : null,
    guildId,
    normalizeAdaptiveDirectiveKind(directiveKind),
    eventType,
    actorUserId ? String(actorUserId) : null,
    actorName ? normalizeAdaptiveDirectiveActorName(actorName) : null,
    noteText,
    detailText ? String(detailText).slice(0, 1000) : null,
    sourceMessageId ? String(sourceMessageId) : null,
    metadata ? JSON.stringify(metadata) : null
  );
}

function getAdaptiveDirectiveRowById(store: AdaptiveDirectiveStore, noteId: number, guildId: string) {
  return toAdaptiveDirectiveSqlRow(store.db.prepare(
    `SELECT id,
            guild_id,
            directive_kind,
            note_text,
            created_at,
            updated_at,
            created_by_user_id,
            created_by_name,
            updated_by_user_id,
            updated_by_name,
            source_message_id,
            source_text,
            is_active,
            removed_at,
            removed_by_user_id,
            removed_by_name,
            removal_reason
       FROM adaptive_style_notes
       WHERE id = ? AND guild_id = ?
       LIMIT 1`
  ).get(noteId, guildId));
}

function getAdaptiveDirectiveRowByExactText(
  store: AdaptiveDirectiveStore,
  guildId: string,
  directiveKind: string,
  noteText: string,
  isActive: boolean
) {
  return toAdaptiveDirectiveSqlRow(store.db.prepare(
    `SELECT id,
            guild_id,
            directive_kind,
            note_text,
            created_at,
            updated_at,
            created_by_user_id,
            created_by_name,
            updated_by_user_id,
            updated_by_name,
            source_message_id,
            source_text,
            is_active,
            removed_at,
            removed_by_user_id,
            removed_by_name,
            removal_reason
       FROM adaptive_style_notes
       WHERE guild_id = ?
         AND directive_kind = ?
         AND lower(note_text) = lower(?)
         AND is_active = ?
       ORDER BY updated_at DESC
       LIMIT 1`
  ).get(
    guildId,
    normalizeAdaptiveDirectiveKind(directiveKind),
    noteText,
    isActive ? 1 : 0
  ));
}

function scoreAdaptiveDirectiveRow(row: AdaptiveDirectiveSqlRow, queryText: string) {
  const directiveKind = normalizeAdaptiveDirectiveKind(row.directiveKind ?? row.directive_kind);
  const noteText = normalizeAdaptiveDirectiveText(row.noteText ?? row.note_text).toLowerCase();
  if (!noteText) return -1;
  const normalizedQuery = normalizeAdaptiveDirectiveText(queryText).toLowerCase();
  const queryTokens = normalizeAdaptiveDirectiveTokens(normalizedQuery);
  let score = directiveKind === "guidance" ? 3 : 0;
  if (!normalizedQuery) {
    return score;
  }
  if (noteText.includes(normalizedQuery) || normalizedQuery.includes(noteText)) {
    score += 24;
  }
  const noteTokens = new Set(normalizeAdaptiveDirectiveTokens(noteText));
  const overlap = queryTokens.filter((token) => noteTokens.has(token)).length;
  score += overlap * 5;
  return score;
}

export function getActiveAdaptiveStyleNotes(store: AdaptiveDirectiveStore, guildId: string, limit = 24) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];
  const boundedLimit = clamp(Math.floor(Number(limit) || 24), 1, 200);
  const rows = toAdaptiveDirectiveSqlRows(store.db.prepare(
    `SELECT id,
            guild_id,
            directive_kind,
            note_text,
            created_at,
            updated_at,
            created_by_user_id,
            created_by_name,
            updated_by_user_id,
            updated_by_name,
            source_message_id,
            source_text,
            is_active,
            removed_at,
            removed_by_user_id,
            removed_by_name,
            removal_reason
       FROM adaptive_style_notes
       WHERE guild_id = ?
         AND is_active = 1
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
  ).all(normalizedGuildId, boundedLimit));
  return rows.map((row) => mapAdaptiveDirectiveRow(row)).filter(Boolean);
}

export function searchAdaptiveStyleNotesForPrompt(
  store: AdaptiveDirectiveStore,
  {
    guildId,
    queryText = "",
    limit = 8
  }: {
    guildId: string;
    queryText?: string;
    limit?: number;
  }
) {
  const rows = getActiveAdaptiveStyleNotes(store, guildId, 80);
  const normalizedQuery = normalizeAdaptiveDirectiveText(queryText);
  return rows
    .map((row) => ({
      ...row,
      _score: scoreAdaptiveDirectiveRow(row, normalizedQuery)
    }))
    .filter((row) => {
      if (!normalizedQuery) return row.directiveKind === "guidance";
      return row._score >= (row.directiveKind === "guidance" ? 2 : 5);
    })
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    })
    .slice(0, clamp(Math.floor(Number(limit) || 8), 1, 24))
    .map(({ _score, ...row }) => row);
}

export function getAdaptiveStyleNoteAuditLog(store: AdaptiveDirectiveStore, guildId: string, limit = 100) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];
  const boundedLimit = clamp(Math.floor(Number(limit) || 100), 1, 500);
  const rows = toAdaptiveDirectiveSqlRows(store.db.prepare(
    `SELECT id,
            created_at,
            note_id,
            guild_id,
            directive_kind,
            event_type,
            actor_user_id,
            actor_name,
            note_text,
            detail_text,
            source_message_id,
            metadata
       FROM adaptive_style_note_events
       WHERE guild_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
  ).all(normalizedGuildId, boundedLimit));
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at || ""),
    noteId: Number.isInteger(Number(row.note_id)) ? Number(row.note_id) : null,
    guildId: String(row.guild_id || ""),
    directiveKind: normalizeAdaptiveDirectiveKind(row.directive_kind),
    eventType: String(row.event_type || ""),
    actorUserId: String(row.actor_user_id || "").trim() || null,
    actorName: String(row.actor_name || "").trim() || null,
    noteText: String(row.note_text || ""),
    detailText: String(row.detail_text || "").trim() || null,
    sourceMessageId: String(row.source_message_id || "").trim() || null,
    metadata: safeJsonParse(row.metadata, null)
  }));
}

export function addAdaptiveStyleNote(store: AdaptiveDirectiveStore, {
  guildId,
  noteText,
  directiveKind = "guidance",
  actorUserId = null,
  actorName = null,
  sourceMessageId = null,
  sourceText = null,
  source = "conversation"
}: {
  guildId: string;
  noteText: string;
  directiveKind?: string;
  actorUserId?: string | null;
  actorName?: string | null;
  sourceMessageId?: string | null;
  sourceText?: string | null;
  source?: string;
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedKind = normalizeAdaptiveDirectiveKind(directiveKind);
  const normalizedNoteText = normalizeAdaptiveDirectiveText(noteText);
  const normalizedActorName = normalizeAdaptiveDirectiveActorName(actorName);
  const normalizedSourceText = String(sourceText || "").trim().slice(0, 1000) || null;
  if (!normalizedGuildId) {
    return { ok: false, error: "guild_required", note: null };
  }
  if (!normalizedNoteText) {
    return { ok: false, error: "note_required", note: null };
  }

  const activeExact = getAdaptiveDirectiveRowByExactText(
    store,
    normalizedGuildId,
    normalizedKind,
    normalizedNoteText,
    true
  );
  if (activeExact) {
    return {
      ok: true,
      status: "duplicate_active",
      note: mapAdaptiveDirectiveRow(activeExact)
    };
  }

  const now = nowIso();
  const inactiveExact = getAdaptiveDirectiveRowByExactText(
    store,
    normalizedGuildId,
    normalizedKind,
    normalizedNoteText,
    false
  );
  if (inactiveExact) {
    store.db.prepare(
      `UPDATE adaptive_style_notes
          SET updated_at = ?,
              updated_by_user_id = ?,
              updated_by_name = ?,
              source_message_id = ?,
              source_text = ?,
              is_active = 1,
              removed_at = NULL,
              removed_by_user_id = NULL,
              removed_by_name = NULL,
              removal_reason = NULL
        WHERE id = ?`
    ).run(
      now,
      actorUserId ? String(actorUserId) : null,
      normalizedActorName || null,
      sourceMessageId ? String(sourceMessageId) : null,
      normalizedSourceText,
      Number(inactiveExact.id)
    );
    const reactivated = mapAdaptiveDirectiveRow(
      getAdaptiveDirectiveRowById(store, Number(inactiveExact.id), normalizedGuildId)
    );
    insertAdaptiveDirectiveEvent(store, {
      noteId: reactivated?.id || null,
      guildId: normalizedGuildId,
      directiveKind: normalizedKind,
      eventType: "reactivated",
      actorUserId: actorUserId ? String(actorUserId) : null,
      actorName: normalizedActorName || null,
      noteText: normalizedNoteText,
      sourceMessageId: sourceMessageId ? String(sourceMessageId) : null,
      metadata: {
        source
      }
    });
    store.logAction({
      kind: "adaptive_style_note",
      guildId: normalizedGuildId,
      userId: actorUserId ? String(actorUserId) : null,
      messageId: sourceMessageId ? String(sourceMessageId) : null,
      content: normalizedNoteText.slice(0, ADAPTIVE_DIRECTIVE_PREVIEW_MAX_CHARS),
      metadata: {
        operation: "reactivated",
        noteId: reactivated?.id || null,
        directiveKind: normalizedKind,
        source
      }
    });
    return {
      ok: true,
      status: "reactivated",
      note: reactivated
    };
  }

  const result = store.db.prepare(
    `INSERT INTO adaptive_style_notes(
       created_at,
       updated_at,
       guild_id,
       directive_kind,
       note_text,
       created_by_user_id,
       created_by_name,
       updated_by_user_id,
       updated_by_name,
       source_message_id,
       source_text,
       is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    now,
    now,
    normalizedGuildId,
    normalizedKind,
    normalizedNoteText,
    actorUserId ? String(actorUserId) : null,
    normalizedActorName || null,
    actorUserId ? String(actorUserId) : null,
    normalizedActorName || null,
    sourceMessageId ? String(sourceMessageId) : null,
    normalizedSourceText
  );
  const noteId = Number(result?.lastInsertRowid || 0);
  const inserted = mapAdaptiveDirectiveRow(getAdaptiveDirectiveRowById(store, noteId, normalizedGuildId));
  insertAdaptiveDirectiveEvent(store, {
    noteId,
    guildId: normalizedGuildId,
    directiveKind: normalizedKind,
    eventType: "added",
    actorUserId: actorUserId ? String(actorUserId) : null,
    actorName: normalizedActorName || null,
    noteText: normalizedNoteText,
    sourceMessageId: sourceMessageId ? String(sourceMessageId) : null,
    metadata: {
      source
    }
  });
  store.logAction({
    kind: "adaptive_style_note",
    guildId: normalizedGuildId,
    userId: actorUserId ? String(actorUserId) : null,
    messageId: sourceMessageId ? String(sourceMessageId) : null,
    content: normalizedNoteText.slice(0, ADAPTIVE_DIRECTIVE_PREVIEW_MAX_CHARS),
    metadata: {
      operation: "added",
      noteId,
      directiveKind: normalizedKind,
      source
    }
  });
  return {
    ok: true,
    status: "added",
    note: inserted
  };
}

export function updateAdaptiveStyleNote(store: AdaptiveDirectiveStore, {
  noteId,
  guildId,
  noteText,
  directiveKind = "guidance",
  actorUserId = null,
  actorName = null,
  source = "dashboard"
}: {
  noteId: number;
  guildId: string;
  noteText: string;
  directiveKind?: string;
  actorUserId?: string | null;
  actorName?: string | null;
  source?: string;
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedKind = normalizeAdaptiveDirectiveKind(directiveKind);
  const normalizedNoteText = normalizeAdaptiveDirectiveText(noteText);
  const normalizedActorName = normalizeAdaptiveDirectiveActorName(actorName);
  const normalizedNoteId = Number(noteId);
  if (!normalizedGuildId) {
    return { ok: false, error: "guild_required", note: null };
  }
  if (!Number.isInteger(normalizedNoteId) || normalizedNoteId <= 0) {
    return { ok: false, error: "note_id_required", note: null };
  }
  if (!normalizedNoteText) {
    return { ok: false, error: "note_required", note: null };
  }

  const existing = mapAdaptiveDirectiveRow(getAdaptiveDirectiveRowById(store, normalizedNoteId, normalizedGuildId));
  if (!existing || !existing.isActive) {
    return { ok: false, error: "note_not_found", note: null };
  }
  if (
    existing.noteText.toLowerCase() === normalizedNoteText.toLowerCase() &&
    existing.directiveKind === normalizedKind
  ) {
    return { ok: true, status: "unchanged", note: existing };
  }
  const duplicateActive = getAdaptiveDirectiveRowByExactText(
    store,
    normalizedGuildId,
    normalizedKind,
    normalizedNoteText,
    true
  );
  if (duplicateActive && Number(duplicateActive.id) !== normalizedNoteId) {
    return {
      ok: true,
      status: "duplicate_active",
      note: mapAdaptiveDirectiveRow(duplicateActive)
    };
  }

  const now = nowIso();
  store.db.prepare(
    `UPDATE adaptive_style_notes
        SET updated_at = ?,
            directive_kind = ?,
            note_text = ?,
            updated_by_user_id = ?,
            updated_by_name = ?
      WHERE id = ? AND guild_id = ?`
  ).run(
    now,
    normalizedKind,
    normalizedNoteText,
    actorUserId ? String(actorUserId) : null,
    normalizedActorName || null,
    normalizedNoteId,
    normalizedGuildId
  );
  const updated = mapAdaptiveDirectiveRow(getAdaptiveDirectiveRowById(store, normalizedNoteId, normalizedGuildId));
  insertAdaptiveDirectiveEvent(store, {
    noteId: normalizedNoteId,
    guildId: normalizedGuildId,
    directiveKind: normalizedKind,
    eventType: "edited",
    actorUserId: actorUserId ? String(actorUserId) : null,
    actorName: normalizedActorName || null,
    noteText: normalizedNoteText,
    detailText: existing.noteText,
    metadata: {
      previousDirectiveKind: existing.directiveKind,
      source
    }
  });
  store.logAction({
    kind: "adaptive_style_note",
    guildId: normalizedGuildId,
    userId: actorUserId ? String(actorUserId) : null,
    content: normalizedNoteText.slice(0, ADAPTIVE_DIRECTIVE_PREVIEW_MAX_CHARS),
    metadata: {
      operation: "edited",
      noteId: normalizedNoteId,
      directiveKind: normalizedKind,
      previousNoteText: existing.noteText,
      previousDirectiveKind: existing.directiveKind,
      source
    }
  });
  return {
    ok: true,
    status: "edited",
    note: updated
  };
}

export function removeAdaptiveStyleNote(store: AdaptiveDirectiveStore, {
  noteId,
  guildId,
  actorUserId = null,
  actorName = null,
  removalReason = "",
  source = "conversation"
}: {
  noteId: number;
  guildId: string;
  actorUserId?: string | null;
  actorName?: string | null;
  removalReason?: string;
  source?: string;
}) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedNoteId = Number(noteId);
  const normalizedActorName = normalizeAdaptiveDirectiveActorName(actorName);
  const normalizedRemovalReason = normalizeAdaptiveDirectiveReason(removalReason);
  if (!normalizedGuildId) {
    return { ok: false, error: "guild_required", note: null };
  }
  if (!Number.isInteger(normalizedNoteId) || normalizedNoteId <= 0) {
    return { ok: false, error: "note_id_required", note: null };
  }

  const existing = mapAdaptiveDirectiveRow(getAdaptiveDirectiveRowById(store, normalizedNoteId, normalizedGuildId));
  if (!existing || !existing.isActive) {
    return { ok: false, error: "note_not_found", note: null };
  }

  const now = nowIso();
  store.db.prepare(
    `UPDATE adaptive_style_notes
        SET updated_at = ?,
            updated_by_user_id = ?,
            updated_by_name = ?,
            is_active = 0,
            removed_at = ?,
            removed_by_user_id = ?,
            removed_by_name = ?,
            removal_reason = ?
      WHERE id = ? AND guild_id = ?`
  ).run(
    now,
    actorUserId ? String(actorUserId) : null,
    normalizedActorName || null,
    now,
    actorUserId ? String(actorUserId) : null,
    normalizedActorName || null,
    normalizedRemovalReason || null,
    normalizedNoteId,
    normalizedGuildId
  );
  insertAdaptiveDirectiveEvent(store, {
    noteId: normalizedNoteId,
    guildId: normalizedGuildId,
    directiveKind: existing.directiveKind,
    eventType: "removed",
    actorUserId: actorUserId ? String(actorUserId) : null,
    actorName: normalizedActorName || null,
    noteText: existing.noteText,
    detailText: normalizedRemovalReason || null,
    metadata: {
      source
    }
  });
  store.logAction({
    kind: "adaptive_style_note",
    guildId: normalizedGuildId,
    userId: actorUserId ? String(actorUserId) : null,
    content: existing.noteText.slice(0, ADAPTIVE_DIRECTIVE_PREVIEW_MAX_CHARS),
    metadata: {
      operation: "removed",
      noteId: normalizedNoteId,
      directiveKind: existing.directiveKind,
      removalReason: normalizedRemovalReason || null,
      source
    }
  });
  return {
    ok: true,
    status: "removed",
    note: mapAdaptiveDirectiveRow(getAdaptiveDirectiveRowById(store, normalizedNoteId, normalizedGuildId))
  };
}
