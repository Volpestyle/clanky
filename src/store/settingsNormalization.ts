import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsInput
} from "../settings/settingsSchema.ts";
import { deepMerge } from "../utils.ts";
import { normalizeAgentStackSection } from "./normalize/agentStack.ts";
import { normalizeAutomationsSection } from "./normalize/automations.ts";
import { normalizeDirectivesSection } from "./normalize/directives.ts";
import { normalizeIdentitySection } from "./normalize/identity.ts";
import { normalizeInitiativeSection } from "./normalize/initiative.ts";
import { normalizeInteractionSection } from "./normalize/interaction.ts";
import { normalizeMediaSection } from "./normalize/media.ts";
import { normalizeMemorySection } from "./normalize/memory.ts";
import { normalizeMusicSection } from "./normalize/music.ts";
import { normalizePermissionsSection } from "./normalize/permissions.ts";
import { normalizePersonaSection } from "./normalize/persona.ts";
import { normalizePromptingSection } from "./normalize/prompting.ts";
import {
  isRecord,
  omitUndefinedDeep
} from "./normalize/primitives.ts";
import {
  normalizeModelBinding,
  resolveAgentStackPresetConfig
} from "./normalize/shared.ts";
import { normalizeVoiceSection } from "./normalize/voice.ts";

export {
  BOT_NAME_ALIAS_MAX_ITEMS,
  PERSONA_FLAVOR_MAX_CHARS
} from "./normalize/primitives.ts";

export function normalizeSettings(raw: unknown): Settings {
  const rawRecord = isRecord(raw) ? raw : {};
  const canonicalInput = omitUndefinedDeep(rawRecord) as SettingsInput;
  const merged = deepMerge(DEFAULT_SETTINGS, canonicalInput) as Settings;

  const rawAgentStack = isRecord(canonicalInput.agentStack) ? canonicalInput.agentStack : {};
  const rawOverrides = isRecord(rawAgentStack.overrides) ? rawAgentStack.overrides : {};
  const presetConfig = resolveAgentStackPresetConfig(rawAgentStack);
  const orchestratorOverride = normalizeModelBinding(
    rawOverrides.orchestrator,
    presetConfig.presetOrchestratorFallback.provider,
    presetConfig.presetOrchestratorFallback.model
  );

  return {
    identity: normalizeIdentitySection(merged.identity),
    persona: normalizePersonaSection(merged.persona),
    prompting: normalizePromptingSection(merged.prompting),
    permissions: normalizePermissionsSection(merged.permissions),
    interaction: normalizeInteractionSection(merged.interaction, orchestratorOverride),
    agentStack: normalizeAgentStackSection(
      merged.agentStack,
      rawAgentStack,
      rawOverrides,
      presetConfig,
      orchestratorOverride
    ),
    memory: normalizeMemorySection(merged.memory),
    directives: normalizeDirectivesSection(merged.directives),
    initiative: normalizeInitiativeSection(merged.initiative),
    voice: normalizeVoiceSection(merged.voice),
    media: normalizeMediaSection(merged.media),
    music: normalizeMusicSection(merged.music),
    automations: normalizeAutomationsSection(merged.automations)
  };
}
