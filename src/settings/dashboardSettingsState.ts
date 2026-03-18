import type { Settings, SettingsInput } from "./settingsSchema.ts";
import {
  getResolvedFollowupBinding,
  getResolvedMemoryBinding,
  getResolvedOrchestratorBinding,
  getResolvedTextInitiativeBinding,
  getResolvedVisionBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceGenerationBinding,
  getResolvedVoiceInitiativeBinding,
  getResolvedVoiceInterruptClassifierBinding,
  getResolvedVoiceMusicBrainBinding,
  getVoiceRuntimeConfig,
  resolveAgentStack
} from "./agentStack.ts";
import { resolveVoiceRuntimeSelectionFromMode } from "./voiceDashboardMappings.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { isRecord } from "../store/normalize/primitives.ts";
import { minimizeSettingsIntent } from "./settingsIntent.ts";

export type DashboardProviderAuthBindings = {
  claude_code?: boolean;
  codex_cli?: boolean;
  codex?: boolean;
};

export type ResolvedBindings = {
  agentStack: ReturnType<typeof resolveAgentStack>;
  orchestrator: ReturnType<typeof getResolvedOrchestratorBinding>;
  followupBinding: ReturnType<typeof getResolvedFollowupBinding>;
  memoryBinding: ReturnType<typeof getResolvedMemoryBinding>;
  textInitiativeBinding: ReturnType<typeof getResolvedTextInitiativeBinding>;
  visionBinding: ReturnType<typeof getResolvedVisionBinding>;
  voiceProvider: ReturnType<typeof resolveVoiceRuntimeSelectionFromMode>;
  voiceInitiativeBinding: ReturnType<typeof getResolvedVoiceInitiativeBinding>;
  voiceAdmissionClassifierBinding: ReturnType<typeof getResolvedVoiceAdmissionClassifierBinding>;
  voiceInterruptClassifierBinding: ReturnType<typeof getResolvedVoiceInterruptClassifierBinding>;
  voiceMusicBrainBinding: ReturnType<typeof getResolvedVoiceMusicBrainBinding>;
  voiceGenerationBinding: ReturnType<typeof getResolvedVoiceGenerationBinding>;
  providerAuth: DashboardProviderAuthBindings;
};

export type DashboardSettingsEnvelopeMeta = {
  updatedAt?: string;
  saveAppliedToRuntime?: boolean;
  saveApplyError?: string;
  [key: string]: unknown;
};

export type DashboardSettingsEnvelope = {
  intent: SettingsInput;
  effective: Settings;
  bindings: ResolvedBindings;
  _meta?: DashboardSettingsEnvelopeMeta;
};

export function isDashboardSettingsEnvelope(value: unknown): value is DashboardSettingsEnvelope {
  return isRecord(value) &&
    isRecord(value.intent) &&
    isRecord(value.effective) &&
    isRecord(value.bindings);
}

export function resolveSettingsBindings(
  settings: unknown,
  providerAuth: DashboardProviderAuthBindings = {}
): ResolvedBindings {
  return {
    agentStack: resolveAgentStack(settings),
    orchestrator: getResolvedOrchestratorBinding(settings),
    followupBinding: getResolvedFollowupBinding(settings),
    memoryBinding: getResolvedMemoryBinding(settings),
    textInitiativeBinding: getResolvedTextInitiativeBinding(settings),
    visionBinding: getResolvedVisionBinding(settings),
    voiceProvider: resolveVoiceRuntimeSelectionFromMode(getVoiceRuntimeConfig(settings).runtimeMode),
    voiceInitiativeBinding: getResolvedVoiceInitiativeBinding(settings),
    voiceAdmissionClassifierBinding: getResolvedVoiceAdmissionClassifierBinding(settings),
    voiceInterruptClassifierBinding: getResolvedVoiceInterruptClassifierBinding(settings),
    voiceMusicBrainBinding: getResolvedVoiceMusicBrainBinding(settings),
    voiceGenerationBinding: getResolvedVoiceGenerationBinding(settings),
    providerAuth: { ...providerAuth }
  };
}

export function buildDashboardSettingsEnvelope({
  intent,
  effective,
  providerAuth = {},
  meta
}: {
  intent: unknown;
  effective?: unknown;
  providerAuth?: DashboardProviderAuthBindings;
  meta?: DashboardSettingsEnvelopeMeta;
}): DashboardSettingsEnvelope {
  const minimizedIntent = minimizeSettingsIntent(intent);
  const resolvedEffective = normalizeSettings(isRecord(effective) ? effective : minimizedIntent);
  const envelope: DashboardSettingsEnvelope = {
    intent: minimizedIntent,
    effective: resolvedEffective,
    bindings: resolveSettingsBindings(resolvedEffective, providerAuth)
  };
  if (meta && Object.keys(meta).length > 0) {
    envelope._meta = meta;
  }
  return envelope;
}
