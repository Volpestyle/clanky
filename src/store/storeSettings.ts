// Extracted Store Methods
import { deepMerge, nowIso } from "../utils.ts";
import { SETTINGS_KEY } from "../store.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "./settingsNormalization.ts";

export function rewriteRuntimeSettingsRow(store: any, rawValue) {
const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
const normalized = normalizeSettings(parsed);
const normalizedJson = JSON.stringify(normalized);
if (normalizedJson === String(rawValue || "")) return normalized;

store.db
  .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
  .run(normalizedJson, nowIso(), SETTINGS_KEY);
return normalized;
}

export function getSettings(store: any) {
const row = store.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
return normalizeSettings(parsed);
}

export function setSettings(store: any, next) {
const normalized = normalizeSettings(next);
store.db
  .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
  .run(JSON.stringify(normalized), nowIso(), SETTINGS_KEY);
return normalized;
}

export function patchSettings(store: any, patch) {
const current = store.getSettings();
const merged = deepMerge(current, patch ?? {});
return store.setSettings(merged);
}

export function resetSettings(store: any) {
return store.setSettings(DEFAULT_SETTINGS);
}
