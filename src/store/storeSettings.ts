// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { deepMerge, nowIso } from "../utils.ts";
import { SETTINGS_KEY } from "./store.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "./settingsNormalization.ts";

type RuntimeSettings = ReturnType<typeof normalizeSettings>;

interface SettingsStore {
  db: Database;
  getSettings(): RuntimeSettings;
  setSettings(next: unknown): RuntimeSettings;
}

interface SettingsValueRow {
  value: string;
  updated_at?: string;
}

export interface RuntimeSettingsRecord {
  settings: RuntimeSettings;
  updatedAt: string;
}

export type VersionedSettingsPatchResult =
  | {
      ok: true;
      settings: RuntimeSettings;
      updatedAt: string;
    }
  | ({
      ok: false;
    } & RuntimeSettingsRecord);

const CANONICAL_DEFAULT_SETTINGS = normalizeSettings({});
const LEGACY_BOOTSTRAP_DEFAULT_SETTINGS_JSON = JSON.stringify(normalizeSettings(DEFAULT_SETTINGS));

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeSettingsPatch(current: RuntimeSettings, patch: unknown): RuntimeSettings {
  const patchRecord = isRecordLike(patch) ? patch : {};
  const merged = deepMerge(current, patchRecord);

  if (Object.prototype.hasOwnProperty.call(patchRecord, "memoryLlm")) {
    merged.memoryLlm = patchRecord.memoryLlm;
  }

  return normalizeSettings(merged);
}

export function rewriteRuntimeSettingsRow(store: SettingsStore, rawValue: string | null | undefined) {
  const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
  const normalizedParsed = normalizeSettings(parsed);
  const normalized =
    JSON.stringify(normalizedParsed) === LEGACY_BOOTSTRAP_DEFAULT_SETTINGS_JSON
      ? CANONICAL_DEFAULT_SETTINGS
      : normalizedParsed;
  const normalizedJson = JSON.stringify(normalized);
  if (normalizedJson === String(rawValue || "")) return normalized;

  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(normalizedJson, nowIso(), SETTINGS_KEY);
  return normalized;
}

export function getSettings(store: SettingsStore) {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  return normalizeSettings(parsed);
}

export function getSettingsRecord(store: SettingsStore): RuntimeSettingsRecord {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value, updated_at FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  return {
    settings: normalizeSettings(parsed),
    updatedAt: String(row?.updated_at || "")
  };
}

export function setSettings(store: SettingsStore, next) {
  const normalized = normalizeSettings(next);
  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(JSON.stringify(normalized), nowIso(), SETTINGS_KEY);
  return normalized;
}

export function patchSettings(store: SettingsStore, patch) {
  const current = store.getSettings();
  return store.setSettings(mergeSettingsPatch(current, patch));
}

export function patchSettingsWithVersion(
  store: SettingsStore,
  patch: unknown,
  expectedUpdatedAt: string
): VersionedSettingsPatchResult {
  const current = getSettingsRecord(store);
  if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
    return {
      ok: false,
      ...current
    };
  }

  const nextSettings = mergeSettingsPatch(current.settings, patch);
  const nextUpdatedAt = nowIso();
  const result = store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
    .run(JSON.stringify(nextSettings), nextUpdatedAt, SETTINGS_KEY, current.updatedAt);

  if (Number(result.changes || 0) !== 1) {
    return {
      ok: false,
      ...getSettingsRecord(store)
    };
  }

  return {
    ok: true,
    settings: nextSettings,
    updatedAt: nextUpdatedAt
  };
}

export function resetSettings(store: SettingsStore) {
  return store.setSettings(CANONICAL_DEFAULT_SETTINGS);
}
