import {
  DEFAULT_SETTINGS,
  PROVIDER_MODEL_FALLBACKS,
  type Settings,
  type SettingsExecutionPolicy,
  type SettingsModelBinding
} from "../../settings/settingsSchema.ts";
import { getAgentStackPresetDefinition, normalizeAgentStackPresetName } from "../../settings/agentStackCatalog.ts";
import {
  normalizeLlmProvider,
  normalizeOpenAiReasoningEffort
} from "../../llm/llmHelpers.ts";
import {
  isRecord,
  normalizeBoolean,
  normalizeInt,
  normalizeNumber,
  normalizeString
} from "./primitives.ts";

function fallbackModelForProvider(
  provider: string,
  fallbackProvider: string,
  fallbackModel: string
) {
  if (provider === fallbackProvider) {
    return normalizeString(fallbackModel, fallbackModel, 120) || fallbackModel;
  }
  const providerDefaults = PROVIDER_MODEL_FALLBACKS[provider as keyof typeof PROVIDER_MODEL_FALLBACKS];
  const providerFallback = Array.isArray(providerDefaults) ? providerDefaults[0] : fallbackModel;
  return normalizeString(providerFallback, fallbackModel, 120) || fallbackModel;
}

export function normalizeModelBinding(
  binding: unknown,
  fallbackProvider: string,
  fallbackModel: string
): SettingsModelBinding {
  const source = isRecord(binding) ? binding : {};
  const provider = normalizeLlmProvider(source.provider, fallbackProvider);
  const modelFallback = fallbackModelForProvider(provider, fallbackProvider, fallbackModel);
  const model = normalizeString(source.model, modelFallback, 120) || modelFallback;
  return {
    provider,
    model
  };
}

export function normalizeOptionalModelBinding(
  binding: unknown,
  fallbackProvider: string,
  fallbackModel: string
): Partial<SettingsModelBinding> {
  const source = isRecord(binding) ? binding : {};
  const hasConfiguredBinding =
    Boolean(normalizeString(source.provider, "", 40)) ||
    Boolean(normalizeString(source.model, "", 120));
  if (!hasConfiguredBinding) {
    return {};
  }
  return normalizeModelBinding(binding, fallbackProvider, fallbackModel);
}

function normalizeBrowserProvider(value: unknown, fallback = "anthropic") {
  const provider = normalizeLlmProvider(value, fallback);
  return provider === "openai" || provider === "anthropic" || provider === "claude-oauth" ? provider : fallback;
}

export function normalizeExecutionPolicy(
  policy: unknown,
  fallbackProvider: string,
  fallbackModel: string,
  {
    fallbackMode = "inherit_orchestrator",
    fallbackTemperature,
    fallbackMaxOutputTokens,
    fallbackReasoningEffort = ""
  }: {
    fallbackMode?: string;
    fallbackTemperature?: number;
    fallbackMaxOutputTokens?: number;
    fallbackReasoningEffort?: string;
  } = {}
): SettingsExecutionPolicy {
  const source = isRecord(policy) ? policy : {};
  const modeRaw = normalizeString(source.mode, fallbackMode, 40).toLowerCase();
  const mode =
    modeRaw === "disabled"
      ? "disabled"
      : modeRaw === "dedicated_model"
        ? "dedicated_model"
        : "inherit_orchestrator";
  const normalized: SettingsExecutionPolicy =
    mode === "dedicated_model"
      ? {
          mode,
          model: normalizeModelBinding(source.model, fallbackProvider, fallbackModel)
        }
      : { mode };
  if (source.temperature !== undefined || fallbackTemperature !== undefined) {
    normalized.temperature = normalizeNumber(source.temperature, fallbackTemperature ?? 0.7, 0, 2);
  }
  if (source.maxOutputTokens !== undefined || fallbackMaxOutputTokens !== undefined) {
    normalized.maxOutputTokens = normalizeInt(
      source.maxOutputTokens,
      fallbackMaxOutputTokens ?? 800,
      32,
      16_384
    );
  }
  const reasoningEffort = normalizeOpenAiReasoningEffort(
    source.reasoningEffort,
    fallbackReasoningEffort
  );
  if (reasoningEffort) {
    normalized.reasoningEffort = reasoningEffort;
  }
  return normalized;
}

export function normalizeBrowserExecutionPolicy(policy: unknown, presetFallback?: SettingsModelBinding) {
  const defaultProvider = presetFallback?.provider || "anthropic";
  const defaultModel = presetFallback?.model || "claude-sonnet-4-5-20250929";
  const normalized = normalizeExecutionPolicy(
    policy,
    defaultProvider,
    defaultModel
  );
  if (normalized.mode !== "dedicated_model") {
    return normalized;
  }
  const rawProvider = normalizeLlmProvider(normalized.model.provider, defaultProvider);
  const provider = normalizeBrowserProvider(rawProvider, defaultProvider);
  const fallbackModel =
    provider === "openai"
      ? "gpt-5-mini"
      : provider === "claude-oauth"
        ? (presetFallback?.model || "claude-opus-4-6")
      : "claude-sonnet-4-5-20250929";
  return {
    ...normalized,
    model: {
      provider,
      model: normalizeString(
        rawProvider === provider ? normalized.model.model : "",
        fallbackModel,
        120
      ) || fallbackModel
    }
  };
}

export function normalizeReplyPath(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 20).toLowerCase();
  if (normalized === "native") return "native";
  if (normalized === "brain") return "brain";
  if (normalized === "bridge") return "bridge";
  return fallback;
}

export function normalizeOperationalMessages(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "essential") return "essential";
  if (normalized === "minimal") return "minimal";
  if (normalized === "none") return "none";
  return fallback;
}

export function normalizeVoiceDefaultInterruptionMode(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "speaker") return "speaker";
  if (normalized === "none") return "none";
  if (normalized === "anyone") return "anyone";
  return fallback;
}

export function normalizeClaudeCodeSessionScope(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 32).toLowerCase();
  if (normalized === "guild") return "guild";
  if (normalized === "channel") return "channel";
  if (normalized === "voice_session") return "voice_session";
  return fallback;
}

export function normalizeClaudeCodeContextPruningStrategy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 32).toLowerCase();
  if (normalized === "summarize") return "summarize";
  if (normalized === "evict_oldest") return "evict_oldest";
  if (normalized === "sliding_window") return "sliding_window";
  return fallback;
}

export function normalizeAgentSessionToolPolicy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 16).toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "fast_only") return "fast_only";
  if (normalized === "full") return "full";
  return fallback;
}

export function normalizeDiscoverySourceMap(
  value: unknown
): Settings["initiative"]["discovery"]["sources"] {
  const defaults = DEFAULT_SETTINGS.initiative.discovery.sources;
  const source = isRecord(value) ? value : {};
  return {
    reddit: normalizeBoolean(source.reddit, defaults.reddit),
    hackerNews: normalizeBoolean(source.hackerNews, defaults.hackerNews),
    youtube: normalizeBoolean(source.youtube, defaults.youtube),
    rss: normalizeBoolean(source.rss, defaults.rss),
    x: normalizeBoolean(source.x, defaults.x)
  };
}

export type AgentStackPresetConfig = {
  preset: string;
  presetOrchestratorFallback: SettingsModelBinding;
  presetVoiceAdmissionClassifierFallback?: SettingsModelBinding;
  presetVoiceMusicBrainFallback?: SettingsModelBinding;
  presetVoiceGenerationFallback?: SettingsModelBinding;
  presetVoiceAdmissionMode?: string;
  presetVoiceReplyPath?: string;
  presetVoiceTtsMode?: string;
  presetVoiceRuntimeMode?: string;
  presetBrowserFallback?: SettingsModelBinding;
  presetVisionFallback?: SettingsModelBinding;
};

export function resolveAgentStackPresetConfig(
  rawAgentStack: Record<string, unknown>
): AgentStackPresetConfig {
  const preset = normalizeAgentStackPresetName(
    normalizeString(rawAgentStack.preset, DEFAULT_SETTINGS.agentStack.preset, 48),
    DEFAULT_SETTINGS.agentStack.preset
  );
  const definition = getAgentStackPresetDefinition(preset);

  return {
    preset,
    presetOrchestratorFallback: { ...definition.orchestrator } satisfies SettingsModelBinding,
    ...(definition.voiceAdmissionClassifier
      ? {
          presetVoiceAdmissionClassifierFallback: {
            ...definition.voiceAdmissionClassifier
          } satisfies SettingsModelBinding
        }
      : {}),
    ...(definition.voiceMusicBrain
      ? {
          presetVoiceMusicBrainFallback: {
            ...definition.voiceMusicBrain
          } satisfies SettingsModelBinding
        }
      : {}),
    ...(definition.voiceGeneration
      ? {
          presetVoiceGenerationFallback: {
            ...definition.voiceGeneration
          } satisfies SettingsModelBinding
        }
      : {}),
    presetVoiceAdmissionMode: definition.voiceAdmissionPolicy.mode,
    presetVoiceReplyPath: definition.voiceReplyPath,
    presetVoiceTtsMode: definition.voiceTtsMode,
    presetVoiceRuntimeMode: definition.voiceRuntime,
    ...(definition.browserFallback
      ? {
          presetBrowserFallback: {
            ...definition.browserFallback
          } satisfies SettingsModelBinding
        }
      : {}),
    ...(definition.visionFallback
      ? {
          presetVisionFallback: {
            ...definition.visionFallback
          } satisfies SettingsModelBinding
        }
      : {})
  };
}
