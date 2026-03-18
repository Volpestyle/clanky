// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { deepMerge, nowIso } from "../utils.ts";
import { SETTINGS_KEY } from "./store.ts";
import { isRecord } from "./normalize/primitives.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { DEFAULT_SETTINGS, type SettingsInput } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "./settingsNormalization.ts";
import { minimizeSettingsIntent } from "../settings/settingsIntent.ts";

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

interface RuntimeSettingsRecord {
  intent: SettingsInput;
  settings: RuntimeSettings;
  updatedAt: string;
}

type VersionedSettingsWriteResult =
  | {
      ok: true;
      intent: SettingsInput;
      settings: RuntimeSettings;
      updatedAt: string;
    }
  | ({
      ok: false;
    } & RuntimeSettingsRecord);

const CANONICAL_DEFAULT_SETTINGS_INTENT = minimizeSettingsIntent({});

function mergeSettingsPatch(current: SettingsInput, patch: unknown): SettingsInput {
  const patchRecord = isRecord(patch) ? patch : {};
  const merged = deepMerge(current, patchRecord);

  if (Object.prototype.hasOwnProperty.call(patchRecord, "memoryLlm")) {
    merged.memoryLlm = patchRecord.memoryLlm;
  }

  return minimizeSettingsIntent(merged);
}

export function rewriteRuntimeSettingsRow(store: SettingsStore, rawValue: string | null | undefined) {
  const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
  const intent = minimizeSettingsIntent(parsed);
  const intentJson = JSON.stringify(intent);
  if (intentJson === String(rawValue || "")) {
    return normalizeSettings(intent);
  }

  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(intentJson, nowIso(), SETTINGS_KEY);
  return normalizeSettings(intent);
}

export function getSettings(store: SettingsStore) {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  return normalizeSettings(minimizeSettingsIntent(parsed));
}

export function getSettingsRecord(store: SettingsStore): RuntimeSettingsRecord {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value, updated_at FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  const intent = minimizeSettingsIntent(parsed);
  return {
    intent,
    settings: normalizeSettings(intent),
    updatedAt: String(row?.updated_at || "")
  };
}

export function setSettings(store: SettingsStore, next) {
  const intent = minimizeSettingsIntent(next);
  const normalized = normalizeSettings(intent);
  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(JSON.stringify(intent), nowIso(), SETTINGS_KEY);
  return normalized;
}

export function patchSettings(store: SettingsStore, patch) {
  const current = getSettingsRecord(store);
  return store.setSettings(mergeSettingsPatch(current.intent, patch));
}

export function patchSettingsWithVersion(
  store: SettingsStore,
  patch: unknown,
  expectedUpdatedAt: string
): VersionedSettingsWriteResult {
  const current = getSettingsRecord(store);
  if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
    return {
      ok: false,
      ...current
    };
  }

  const nextIntent = mergeSettingsPatch(current.intent, patch);
  const nextSettings = normalizeSettings(nextIntent);
  const nextUpdatedAt = nowIso();
  const result = store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
    .run(JSON.stringify(nextIntent), nextUpdatedAt, SETTINGS_KEY, current.updatedAt);

  if (Number(result.changes || 0) !== 1) {
    return {
      ok: false,
      ...getSettingsRecord(store)
    };
  }

  return {
    ok: true,
    intent: nextIntent,
    settings: nextSettings,
    updatedAt: nextUpdatedAt
  };
}

export function replaceSettingsWithVersion(
  store: SettingsStore,
  next: unknown,
  expectedUpdatedAt: string
): VersionedSettingsWriteResult {
  const current = getSettingsRecord(store);
  if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
    return {
      ok: false,
      ...current
    };
  }

  const nextIntent = minimizeSettingsIntent(next);
  const nextSettings = normalizeSettings(nextIntent);
  const nextUpdatedAt = nowIso();
  const result = store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
    .run(JSON.stringify(nextIntent), nextUpdatedAt, SETTINGS_KEY, current.updatedAt);

  if (Number(result.changes || 0) !== 1) {
    return {
      ok: false,
      ...getSettingsRecord(store)
    };
  }

  return {
    ok: true,
    intent: nextIntent,
    settings: nextSettings,
    updatedAt: nextUpdatedAt
  };
}

export function resetSettings(store: SettingsStore) {
  return store.setSettings(CANONICAL_DEFAULT_SETTINGS_INTENT);
}
