import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  PERSONA_FLAVOR_MAX_CHARS,
  normalizeString,
  normalizeStringList
} from "./primitives.ts";

export function normalizePersonaSection(section: Settings["persona"]): Settings["persona"] {
  return {
    flavor: normalizeString(section.flavor, DEFAULT_SETTINGS.persona.flavor, PERSONA_FLAVOR_MAX_CHARS),
    hardLimits: normalizeStringList(section.hardLimits, 40, 220, DEFAULT_SETTINGS.persona.hardLimits)
  };
}
