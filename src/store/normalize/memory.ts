import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeBoolean,
  normalizeInt,
  normalizeString
} from "./primitives.ts";
import {
  normalizeExecutionPolicy,
  normalizeReflectionStrategy
} from "./shared.ts";

export function normalizeMemorySection(section: Settings["memory"]): Settings["memory"] {
  const promptSlice = section.promptSlice;
  const extraction = section.extraction;
  const reflection = section.reflection;

  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.memory.enabled),
    promptSlice: {
      maxRecentMessages: normalizeInt(
        promptSlice.maxRecentMessages,
        DEFAULT_SETTINGS.memory.promptSlice.maxRecentMessages,
        4,
        120
      ),
      maxHighlights: normalizeInt(
        promptSlice.maxHighlights,
        DEFAULT_SETTINGS.memory.promptSlice.maxHighlights,
        1,
        40
      )
    },
    execution: normalizeExecutionPolicy(section.execution, "anthropic", "claude-haiku-4-5", {
      fallbackMode: "dedicated_model",
      fallbackTemperature: 0,
      fallbackMaxOutputTokens: 320
    }),
    extraction: {
      enabled: normalizeBoolean(extraction.enabled, DEFAULT_SETTINGS.memory.extraction.enabled)
    },
    embeddingModel: normalizeString(
      section.embeddingModel,
      DEFAULT_SETTINGS.memory.embeddingModel,
      120
    ),
    reflection: {
      enabled: normalizeBoolean(reflection.enabled, DEFAULT_SETTINGS.memory.reflection.enabled),
      strategy: normalizeReflectionStrategy(
        reflection.strategy,
        DEFAULT_SETTINGS.memory.reflection.strategy
      ),
      hour: normalizeInt(reflection.hour, DEFAULT_SETTINGS.memory.reflection.hour, 0, 23),
      minute: normalizeInt(reflection.minute, DEFAULT_SETTINGS.memory.reflection.minute, 0, 59),
      maxFactsPerReflection: normalizeInt(
        reflection.maxFactsPerReflection,
        DEFAULT_SETTINGS.memory.reflection.maxFactsPerReflection,
        1,
        100
      )
    },
    dailyLogRetentionDays: normalizeInt(
      section.dailyLogRetentionDays,
      DEFAULT_SETTINGS.memory.dailyLogRetentionDays,
      1,
      365
    )
  };
}
