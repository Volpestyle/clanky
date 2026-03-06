import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizePromptBlock,
  normalizePromptLine,
  normalizePromptLineList
} from "./primitives.ts";

export function normalizePromptingSection(section: Settings["prompting"]): Settings["prompting"] {
  const global = section.global;
  const text = section.text;
  const voice = section.voice;
  const media = section.media;

  return {
    global: {
      capabilityHonestyLine: normalizePromptLine(
        global.capabilityHonestyLine,
        DEFAULT_SETTINGS.prompting.global.capabilityHonestyLine
      ),
      impossibleActionLine: normalizePromptLine(
        global.impossibleActionLine,
        DEFAULT_SETTINGS.prompting.global.impossibleActionLine
      ),
      memoryEnabledLine: normalizePromptLine(
        global.memoryEnabledLine,
        DEFAULT_SETTINGS.prompting.global.memoryEnabledLine
      ),
      memoryDisabledLine: normalizePromptLine(
        global.memoryDisabledLine,
        DEFAULT_SETTINGS.prompting.global.memoryDisabledLine
      ),
      skipLine: normalizePromptLine(global.skipLine, DEFAULT_SETTINGS.prompting.global.skipLine)
    },
    text: {
      guidance: normalizePromptLineList(text.guidance, DEFAULT_SETTINGS.prompting.text.guidance)
    },
    voice: {
      guidance: normalizePromptLineList(voice.guidance, DEFAULT_SETTINGS.prompting.voice.guidance),
      operationalGuidance: normalizePromptLineList(
        voice.operationalGuidance,
        DEFAULT_SETTINGS.prompting.voice.operationalGuidance
      ),
      lookupBusySystemPrompt: normalizePromptBlock(
        voice.lookupBusySystemPrompt,
        DEFAULT_SETTINGS.prompting.voice.lookupBusySystemPrompt,
        4_000
      )
    },
    media: {
      promptCraftGuidance: normalizePromptBlock(
        media.promptCraftGuidance,
        DEFAULT_SETTINGS.prompting.media.promptCraftGuidance,
        8_000
      )
    }
  };
}
