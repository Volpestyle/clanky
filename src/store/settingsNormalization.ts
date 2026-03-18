import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsInput
} from "../settings/settingsSchema.ts";
import { deepMerge } from "../utils.ts";
import { normalizeAgentStackSection } from "./normalize/agentStack.ts";
import { normalizeAutomationsSection } from "./normalize/automations.ts";
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
  normalizeOptionalModelBinding,
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
  const rawVoice = isRecord(canonicalInput.voice) ? canonicalInput.voice : {};
  const rawVoiceAdmission = isRecord(rawVoice.admission) ? rawVoice.admission : {};
  const rawMemoryLlm = canonicalInput.memoryLlm;
  const presetConfig = resolveAgentStackPresetConfig(rawAgentStack);
  const orchestratorOverride = normalizeModelBinding(
    rawOverrides.orchestrator,
    presetConfig.presetOrchestratorFallback.provider,
    presetConfig.presetOrchestratorFallback.model
  );
  const normalizedVoiceBase = normalizeVoiceSection(merged.voice);
  const rawVoiceConversationPolicy = isRecord(rawVoice.conversationPolicy) ? rawVoice.conversationPolicy : {};
  let normalizedVoice = normalizedVoiceBase;
  if (rawVoiceAdmission.mode === undefined && presetConfig.presetVoiceAdmissionMode) {
    normalizedVoice = {
      ...normalizedVoice,
      admission: {
        ...normalizedVoice.admission,
        mode: presetConfig.presetVoiceAdmissionMode
      }
    };
  }
  if (rawVoiceConversationPolicy.replyPath === undefined && presetConfig.presetVoiceReplyPath) {
    normalizedVoice = {
      ...normalizedVoice,
      conversationPolicy: {
        ...normalizedVoice.conversationPolicy,
        replyPath: presetConfig.presetVoiceReplyPath
      }
    };
  }
  if (rawVoiceConversationPolicy.ttsMode === undefined && presetConfig.presetVoiceTtsMode) {
    normalizedVoice = {
      ...normalizedVoice,
      conversationPolicy: {
        ...normalizedVoice.conversationPolicy,
        ttsMode: presetConfig.presetVoiceTtsMode
      }
    };
  }

  const normalizedInteraction = normalizeInteractionSection(merged.interaction, orchestratorOverride);

  return {
    identity: normalizeIdentitySection(merged.identity),
    persona: normalizePersonaSection(merged.persona),
    prompting: normalizePromptingSection(merged.prompting),
    permissions: normalizePermissionsSection(merged.permissions),
    interaction: normalizedInteraction,
    agentStack: normalizeAgentStackSection(
      merged.agentStack,
      rawAgentStack,
      rawOverrides,
      presetConfig,
      orchestratorOverride
    ),
    memory: normalizeMemorySection(merged.memory),
    memoryLlm: normalizeOptionalModelBinding(
      rawMemoryLlm,
      orchestratorOverride.provider,
      orchestratorOverride.model
    ),
    initiative: normalizeInitiativeSection(merged.initiative),
    voice: normalizedVoice,
    media: normalizeMediaSection(merged.media, presetConfig),
    music: normalizeMusicSection(merged.music),
    automations: normalizeAutomationsSection(merged.automations)
  };
}
