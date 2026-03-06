import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  BOT_NAME_ALIAS_MAX_ITEMS,
  normalizeString,
  normalizeStringList
} from "./primitives.ts";

export function normalizeIdentitySection(section: Settings["identity"]): Settings["identity"] {
  return {
    botName: normalizeString(section.botName, DEFAULT_SETTINGS.identity.botName, 50),
    botNameAliases: normalizeStringList(
      section.botNameAliases,
      BOT_NAME_ALIAS_MAX_ITEMS,
      50,
      DEFAULT_SETTINGS.identity.botNameAliases
    )
  };
}
