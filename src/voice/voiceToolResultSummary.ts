import { normalizeInlineText } from "./voiceSessionHelpers.ts";

export type VoiceToolResultSummary = Record<string, unknown> | string | null;

const MAX_RESULT_PREVIEW_CHARS = 400;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateRawSummary(value: unknown, maxChars = MAX_RESULT_PREVIEW_CHARS) {
  const raw = normalizeInlineText(value, maxChars);
  if (!raw) return null;
  return raw.length > maxChars
    ? raw.slice(0, maxChars) + "..."
    : raw;
}

export function parseVoiceToolResultPayload(content: unknown) {
  if (isObjectRecord(content)) return content;
  const text = String(content || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeVoiceToolPayload(
  toolName: string,
  payload: Record<string, unknown>,
  rawContent: unknown = null
): VoiceToolResultSummary {
  const name = String(toolName || "").trim().toLowerCase();

  if (
    name === "video_search" || name === "video_play" ||
    name === "music_search" || name === "music_play" ||
    name === "music_queue_add" || name === "music_queue_next"
  ) {
    const results = Array.isArray(payload.results) ? payload.results : [];
    const resultSummaries = results.slice(0, 5).map((row: unknown) => {
      if (!isObjectRecord(row)) return null;
      return {
        title: normalizeInlineText(row.title, 80) || null,
        id: normalizeInlineText(row.id, 60) || null,
        platform: normalizeInlineText(row.platform, 20) || null,
        channel: normalizeInlineText(row.channel || row.artist || row.artists, 60) || null,
        url: normalizeInlineText(row.url, 120) || null
      };
    }).filter(Boolean);
    return {
      ok: payload.ok ?? null,
      status: normalizeInlineText(payload.status, 60) || null,
      resultCount: results.length,
      results: resultSummaries.length > 0 ? resultSummaries : null,
      selectedId: normalizeInlineText(payload.selectedId || payload.selection_id, 60) || null,
      trackTitle: normalizeInlineText(payload.title || payload.trackTitle, 80) || null,
      trackId: normalizeInlineText(payload.trackId || payload.id, 60) || null,
      playing: payload.playing ?? null,
      error: normalizeInlineText(payload.error, 200) || null
    };
  }

  if (name === "browser_browse") {
    return {
      ok: payload.ok ?? null,
      sessionId: normalizeInlineText(payload.session_id, 40) || null,
      completed: payload.completed ?? null,
      error: normalizeInlineText(payload.error, 200) || null,
      resultChars: String(rawContent || "").length || null
    };
  }

  if (name === "web_search") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    return {
      ok: payload.ok ?? null,
      resultCount: results.length,
      resultTitles: results.slice(0, 3).map((row: unknown) =>
        normalizeInlineText(isObjectRecord(row) ? row.title : "", 80)
      ).filter(Boolean),
      error: normalizeInlineText(payload.error, 200) || null
    };
  }

  if (name === "memory_write" || name === "memory_search") {
    return {
      ok: payload.ok ?? null,
      count: Array.isArray(payload.written)
        ? payload.written.length
        : Array.isArray(payload.results)
          ? payload.results.length
          : null,
      error: normalizeInlineText(payload.error, 200) || null
    };
  }

  if (name === "start_screen_watch" || name === "stop_screen_watch") {
    return {
      ok: payload.ok ?? null,
      started: payload.started ?? null,
      stopped: payload.stopped ?? null,
      reused: payload.reused ?? null,
      transport: normalizeInlineText(payload.transport, 40) || null,
      reason: normalizeInlineText(payload.reason, 120) || null,
      targetUserId: normalizeInlineText(payload.targetUserId, 80) || null,
      frameReady: payload.frameReady ?? null,
      expiresInMinutes: Number.isFinite(Number(payload.expiresInMinutes))
        ? Math.max(0, Math.round(Number(payload.expiresInMinutes)))
        : null,
      error: normalizeInlineText(payload.error, 200) || null
    };
  }

  const genericSummary = {
    ok: payload.ok ?? null,
    status: normalizeInlineText(payload.status, 60) || null,
    resultCount: Array.isArray(payload.results)
      ? payload.results.length
      : Array.isArray(payload.written)
        ? payload.written.length
        : null,
    error: normalizeInlineText(payload.error, 200) || null
  };

  if (Object.values(genericSummary).some((value) => value !== null && value !== "")) {
    return genericSummary;
  }

  return truncateRawSummary(rawContent);
}

export function summarizeVoiceToolResult(
  toolName: string,
  content: unknown
): VoiceToolResultSummary {
  const payload = parseVoiceToolResultPayload(content);
  if (payload) {
    return summarizeVoiceToolPayload(toolName, payload, content);
  }
  return truncateRawSummary(content);
}

export function summarizeVoiceToolError(content: unknown) {
  const payload = parseVoiceToolResultPayload(content);
  const payloadError = payload?.error;
  if (isObjectRecord(payloadError)) {
    const message = normalizeInlineText(payloadError.message, 280);
    if (message) return message;
  }
  const errorText = normalizeInlineText(payloadError, 280);
  if (errorText) return errorText;
  return normalizeInlineText(content, 280) || null;
}

export function formatVoiceToolResultSummary(
  summary: VoiceToolResultSummary,
  maxChars = 240
) {
  if (summary == null) return null;
  if (typeof summary === "string") {
    return normalizeInlineText(summary, maxChars) || null;
  }
  try {
    return normalizeInlineText(JSON.stringify(summary), maxChars) || null;
  } catch {
    return normalizeInlineText(String(summary), maxChars) || null;
  }
}
