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
}

export function rewriteRuntimeSettingsRow(store: SettingsStore, rawValue: string | null | undefined) {
const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
const normalized = normalizeSettings(parsed);
const normalizedJson = JSON.stringify(normalized);
if (normalizedJson === String(rawValue || "")) return normalized;

store.db
  .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
  .run(normalizedJson, nowIso(), SETTINGS_KEY);
return normalized;
}

export function getSettings(store: SettingsStore) {
const row = store.db.prepare<SettingsValueRow, [string]>("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
return normalizeSettings(parsed);
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
const merged = deepMerge(current, patch ?? {});
return store.setSettings(merged);
}

export function resetSettings(store: SettingsStore) {
return store.setSettings(DEFAULT_SETTINGS);
}
