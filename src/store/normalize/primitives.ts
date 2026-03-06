import { normalizeBoundedStringList } from "../../settings/listNormalization.ts";
import { clamp } from "../../utils.ts";

export const PERSONA_FLAVOR_MAX_CHARS = 2_000;
export const BOT_NAME_ALIAS_MAX_ITEMS = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function omitUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedDeep(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    normalized[key] = omitUndefinedDeep(entry);
  }
  return normalized;
}

export function normalizeString(value: unknown, fallback = "", maxLen = 500) {
  const normalized = String(value ?? fallback ?? "").trim();
  return normalized.slice(0, Math.max(0, maxLen));
}

export function normalizeBoolean(value: unknown, fallback: boolean) {
  return value === undefined ? fallback : Boolean(value);
}

export function normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

export function normalizeInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

export function normalizeStringList(
  value: unknown,
  maxItems = 50,
  maxLen = 160,
  fallback: readonly string[] = []
) {
  if (!Array.isArray(value) && value === undefined) return [...fallback];
  return normalizeBoundedStringList(value, { maxItems, maxLen });
}

export function normalizePromptLineList(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 40, 320, fallback);
}

export function normalizePromptLine(value: unknown, fallback: string, maxLen = 400) {
  return normalizeString(value, fallback, maxLen) || fallback;
}

export function normalizePromptBlock(value: unknown, fallback: string, maxLen = 8_000) {
  return normalizeString(value, fallback, maxLen) || fallback;
}

export function normalizeOptionalString(value: unknown, maxLen = 120) {
  const normalized = normalizeString(value, "", maxLen);
  return normalized || undefined;
}

export function normalizeHttpBaseUrl(value: unknown, fallback: string, maxLen = 300) {
  const candidate = normalizeString(value, fallback, maxLen) || fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fallback;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallback;
  }
}

export function normalizeDiscoveryRssFeeds(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 50, 500, fallback).filter((entry) => {
    try {
      const parsed = new URL(entry);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });
}

export function normalizeXHandles(value: unknown) {
  return normalizeStringList(value, 50, 120)
    .map((entry) => entry.replace(/^@+/, "").trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeSubreddits(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 50, 80, fallback)
    .map((entry) => entry.replace(/^r\//i, "").trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeLanguageHint(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 20)
    .toLowerCase()
    .replace(/_/g, "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) {
    return fallback;
  }
  return normalized || fallback;
}

export function normalizeOpenAiRealtimeAudioFormat(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "audio/pcm" || normalized === "pcm16") return "pcm16";
  if (normalized === "g711_ulaw" || normalized === "g711_alaw") return normalized;
  return fallback;
}

export function normalizeOpenAiRealtimeTranscriptionMethod(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "file_wav") return "file_wav";
  if (normalized === "realtime_bridge") return "realtime_bridge";
  return fallback;
}
