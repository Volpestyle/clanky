import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import { normalizeBoolean } from "./primitives.ts";

export function normalizeDirectivesSection(section: Settings["directives"]): Settings["directives"] {
  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.directives.enabled)
  };
}
