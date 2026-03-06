import {
  DEFAULT_SETTINGS,
  PROVIDER_MODEL_FALLBACKS,
  type Settings,
  type SettingsExecutionPolicy,
  type SettingsModelBinding
} from "../../settings/settingsSchema.ts";
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

function normalizeBrowserProvider(value: unknown, fallback = "anthropic") {
  const provider = normalizeLlmProvider(value, fallback);
  return provider === "openai" || provider === "anthropic" ? provider : fallback;
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
  const mode = modeRaw === "dedicated_model" ? "dedicated_model" : "inherit_orchestrator";
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

export function normalizeBrowserExecutionPolicy(policy: unknown) {
  const normalized = normalizeExecutionPolicy(
    policy,
    "anthropic",
    "claude-sonnet-4-5-20250929"
  );
  if (normalized.mode !== "dedicated_model") {
    return normalized;
  }
  const rawProvider = normalizeLlmProvider(normalized.model.provider, "anthropic");
  const provider = normalizeBrowserProvider(rawProvider, "anthropic");
  const fallbackModel =
    provider === "openai"
      ? "gpt-5-mini"
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
  if (normalized === "essential" || normalized === "important_only") return "essential";
  if (normalized === "minimal") return "minimal";
  if (normalized === "none" || normalized === "off") return "none";
  return fallback;
}

export function normalizeStreamWatchCommentaryPath(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "anthropic_keyframes") return "anthropic_keyframes";
  if (normalized === "auto") return "auto";
  return fallback;
}

export function normalizeReflectionStrategy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 64).toLowerCase();
  if (normalized === "one_pass_main") return "one_pass_main";
  if (normalized === "two_pass_extract_then_main") return "two_pass_extract_then_main";
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

export function normalizeVoiceAdmissionMode(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "deterministic_only") return "deterministic_only";
  if (normalized === "classifier_gate" || normalized === "hard_classifier") return "classifier_gate";
  if (
    normalized === "generation_decides" ||
    normalized === "generation_only" ||
    normalized === "generation"
  ) {
    return "generation_decides";
  }
  if (normalized === "adaptive") return "adaptive";
  return fallback;
}

export type AgentStackPresetConfig = {
  preset: string;
  presetOrchestratorFallback: SettingsModelBinding;
  presetVoiceAdmissionClassifierFallback: SettingsModelBinding;
};

export function resolveAgentStackPresetConfig(
  rawAgentStack: Record<string, unknown>
): AgentStackPresetConfig {
  const presetRaw = normalizeString(rawAgentStack.preset, DEFAULT_SETTINGS.agentStack.preset, 48);
  const preset =
    presetRaw === "openai_native" ||
    presetRaw === "anthropic_brain_openai_tools" ||
    presetRaw === "claude_code_max" ||
    presetRaw === "custom"
      ? presetRaw
      : DEFAULT_SETTINGS.agentStack.preset;

  return {
    preset,
    presetOrchestratorFallback:
      preset === "anthropic_brain_openai_tools"
        ? { provider: "anthropic", model: "claude-sonnet-4-6" }
        : preset === "claude_code_max"
          ? { provider: "claude_code_session", model: "max" }
          : { provider: "openai", model: "gpt-5" },
    presetVoiceAdmissionClassifierFallback:
      preset === "claude_code_max"
        ? { provider: "claude_code_session", model: "max" }
        : { provider: "openai", model: "gpt-5-mini" }
  };
}
