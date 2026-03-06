import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import { normalizeBoolean } from "./primitives.ts";

export function normalizeAutomationsSection(section: Settings["automations"]): Settings["automations"] {
  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.automations.enabled)
  };
}
