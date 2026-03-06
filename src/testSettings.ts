import { normalizeSettings } from "./store/settingsNormalization.ts";
import { deepMerge } from "./utils.ts";
import { DEFAULT_SETTINGS } from "./settings/settingsSchema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasCanonicalRuntimeOverride(raw: Record<string, unknown>, key: "browserRuntime" | "researchRuntime" | "voiceRuntime") {
  const agentStack = isRecord(raw.agentStack) ? raw.agentStack : {};
  const overrides = isRecord(agentStack.overrides) ? agentStack.overrides : {};
  return typeof overrides[key] === "string" && String(overrides[key] || "").trim().length > 0;
}

export function createTestSettings(overrides: unknown = {}) {
  const raw = isRecord(overrides) ? overrides : {};
  let settings = normalizeSettings(raw);
  let patch: Record<string, unknown> = {};

  if (isRecord(raw.browser) && !hasCanonicalRuntimeOverride(raw, "browserRuntime")) {
    patch = deepMerge(patch, {
      agentStack: {
        overrides: {
          browserRuntime: "local_browser_agent"
        }
      }
    });
  }

  if (isRecord(raw.webSearch) && !hasCanonicalRuntimeOverride(raw, "researchRuntime")) {
    patch = deepMerge(patch, {
      agentStack: {
        overrides: {
          researchRuntime: "local_external_search"
        }
      }
    });
  }

  const voice = isRecord(raw.voice) ? raw.voice : {};
  const legacyMode = String(voice.mode || "")
    .trim()
    .toLowerCase();
  if (legacyMode) {
    if (legacyMode === "openai_realtime") {
      patch = deepMerge(patch, {
        agentStack: {
          overrides: {
            voiceRuntime: "openai_realtime"
          }
        }
      });
    } else {
      const selectedProvider =
        legacyMode === "voice_agent"
          ? "xai"
          : legacyMode === "gemini_realtime"
            ? "gemini"
            : legacyMode === "elevenlabs_realtime"
              ? "elevenlabs"
              : "openai";
      patch = deepMerge(patch, {
        agentStack: {
          overrides: {
            voiceRuntime: "legacy_voice_stack"
          },
          runtimeConfig: {
            voice: {
              legacyVoiceStack: {
                selectedProvider
              }
            }
          }
        }
      });
    }
  }

  if (Object.keys(patch).length > 0) {
    settings = normalizeSettings(deepMerge(settings, patch));
  }

  return settings;
}

function buildSettingsPatch(base: unknown, next: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }
  if (!isRecord(base) || !isRecord(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }

  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    const nested = buildSettingsPatch(base[key], next[key]);
    if (nested !== undefined) {
      patch[key] = nested;
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function createTestSettingsPatch(overrides: unknown = {}) {
  const base = normalizeSettings(DEFAULT_SETTINGS);
  const next = createTestSettings(overrides);
  return (buildSettingsPatch(base, next) || {}) as Record<string, unknown>;
}
