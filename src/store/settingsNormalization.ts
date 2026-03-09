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

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumberOrNull(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function migrateLegacyInitiativeInput(canonicalInput: SettingsInput): SettingsInput {
  const input = isRecordLike(canonicalInput) ? canonicalInput : {};
  const permissions = isRecordLike(input.permissions) ? input.permissions : {};
  const replies = isRecordLike(permissions.replies) ? permissions.replies : {};
  const initiative = isRecordLike(input.initiative) ? input.initiative : {};
  const rawText = isRecordLike(initiative.text) ? initiative.text : {};
  const rawDiscovery = isRecordLike(initiative.discovery) ? initiative.discovery : {};
  const rawTextRecord = rawText as Record<string, unknown>;
  const rawDiscoveryRecord = rawDiscovery as Record<string, unknown>;

  const migratedReplyChannelIds = [
    ...new Set([
      ...normalizeStringArray(replies.replyChannelIds),
      ...normalizeStringArray(rawDiscoveryRecord.channelIds)
    ])
  ];

  const legacyTextMinMinutes = asNumberOrNull(rawTextRecord.minMinutesBetweenThoughts);
  const legacyDiscoveryMinMinutes = asNumberOrNull(rawDiscoveryRecord.minMinutesBetweenPosts);
  const legacyTextMaxPerDay = asNumberOrNull(rawTextRecord.maxThoughtsPerDay);
  const legacyDiscoveryMaxPerDay = asNumberOrNull(rawDiscoveryRecord.maxPostsPerDay);
  const hasLegacyDiscoveryDisabled = rawDiscoveryRecord.enabled === false;
  const rawDiscoverySources = isRecordLike(rawDiscovery.sources) ? rawDiscovery.sources : {};

  const nextInitiativeText = {
    ...rawText,
    ...(rawTextRecord.minMinutesBetweenPosts === undefined &&
    (legacyTextMinMinutes !== null || legacyDiscoveryMinMinutes !== null)
      ? {
          minMinutesBetweenPosts: Math.max(
            legacyTextMinMinutes ?? 0,
            legacyDiscoveryMinMinutes ?? 0
          )
        }
      : {}),
    ...(rawTextRecord.maxPostsPerDay === undefined &&
    (legacyTextMaxPerDay !== null || legacyDiscoveryMaxPerDay !== null)
      ? {
          maxPostsPerDay: Math.max(
            legacyTextMaxPerDay ?? 0,
            legacyDiscoveryMaxPerDay ?? 0
          )
        }
      : {})
  };

  const nextDiscoverySources = hasLegacyDiscoveryDisabled
    ? {
        reddit: false,
        hackerNews: false,
        youtube: false,
        rss: false,
        x: false
      }
    : rawDiscoverySources;

  return deepMerge(canonicalInput, {
    permissions: {
      replies: {
        replyChannelIds: migratedReplyChannelIds
      }
    },
    initiative: {
      text: nextInitiativeText,
      discovery: {
        ...rawDiscovery,
        sources: nextDiscoverySources
      }
    }
  }) as SettingsInput;
}

export function normalizeSettings(raw: unknown): Settings {
  const rawRecord = isRecord(raw) ? raw : {};
  const canonicalInput = migrateLegacyInitiativeInput(
    omitUndefinedDeep(rawRecord) as SettingsInput
  );
  const merged = deepMerge(DEFAULT_SETTINGS, canonicalInput) as Settings;

  const rawAgentStack = isRecord(canonicalInput.agentStack) ? canonicalInput.agentStack : {};
  const rawOverrides = isRecord(rawAgentStack.overrides) ? rawAgentStack.overrides : {};
  const rawVoice = isRecord(canonicalInput.voice) ? canonicalInput.voice : {};
  const rawVoiceAdmission = isRecord(rawVoice.admission) ? rawVoice.admission : {};
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
    voice: normalizedVoice,
    media: normalizeMediaSection(merged.media, presetConfig),
    music: normalizeMusicSection(merged.music),
    automations: normalizeAutomationsSection(merged.automations)
  };
}
