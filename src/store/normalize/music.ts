import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeInt,
  normalizeNumber
} from "./primitives.ts";

export function normalizeMusicSection(section: Settings["music"]): Settings["music"] {
  return {
    ducking: {
      targetGain: normalizeNumber(
        section.ducking.targetGain,
        DEFAULT_SETTINGS.music.ducking.targetGain,
        0,
        1
      ),
      fadeMs: normalizeInt(section.ducking.fadeMs, DEFAULT_SETTINGS.music.ducking.fadeMs, 0, 10_000)
    }
  };
}
