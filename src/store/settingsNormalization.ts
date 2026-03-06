import {
  DEFAULT_SETTINGS,
  PROVIDER_MODEL_FALLBACKS,
  type Settings,
  type SettingsExecutionPolicy,
  type SettingsModelBinding,
  type SettingsInput
} from "../settings/settingsSchema.ts";
import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import { normalizeProviderOrder } from "../search.ts";
import { clamp, deepMerge } from "../utils.ts";
import {
  normalizeLlmProvider,
  normalizeOpenAiReasoningEffort
} from "../llm/llmHelpers.ts";
import {
  normalizeVoiceRuntimeMode
} from "../voice/voiceModes.ts";
import {
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeTranscriptionModel
} from "../voice/realtimeProviderNormalization.ts";

export const PERSONA_FLAVOR_MAX_CHARS = 2_000;
export const BOT_NAME_ALIAS_MAX_ITEMS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function omitUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedDeep(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    normalized[key] = omitUndefinedDeep(entry);
  }
  return normalized;
}

function normalizeString(value: unknown, fallback = "", maxLen = 500) {
  const normalized = String(value ?? fallback ?? "").trim();
  return normalized.slice(0, Math.max(0, maxLen));
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return value === undefined ? fallback : Boolean(value);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

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

function normalizeModelBinding(
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

function normalizeBrowserExecutionPolicy(policy: unknown) {
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

function normalizeHttpBaseUrl(value: unknown, fallback: string, maxLen = 300) {
  const candidate = normalizeString(value, fallback, maxLen) || fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fallback;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallback;
  }
}

function normalizeDiscoveryRssFeeds(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 50, 500, fallback).filter((entry) => {
    try {
      const parsed = new URL(entry);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });
}

function normalizeXHandles(value: unknown) {
  return normalizeStringList(value, 50, 120)
    .map((entry) => entry.replace(/^@+/, "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeSubreddits(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 50, 80, fallback)
    .map((entry) => entry.replace(/^r\//i, "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeLanguageHint(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 20)
    .toLowerCase()
    .replace(/_/g, "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) {
    return fallback;
  }
  return normalized || fallback;
}

function normalizeOpenAiRealtimeAudioFormat(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "audio/pcm" || normalized === "pcm16") return "pcm16";
  if (normalized === "g711_ulaw" || normalized === "g711_alaw") return normalized;
  return fallback;
}

function normalizeOpenAiRealtimeTranscriptionMethod(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "file_wav") return "file_wav";
  if (normalized === "realtime_bridge") return "realtime_bridge";
  return fallback;
}

function normalizeReplyPath(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 20).toLowerCase();
  if (normalized === "native") return "native";
  if (normalized === "brain") return "brain";
  if (normalized === "bridge") return "bridge";
  return fallback;
}

function normalizeOperationalMessages(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "all") return "all";
  if (normalized === "essential" || normalized === "important_only") return "essential";
  if (normalized === "minimal") return "minimal";
  if (normalized === "none" || normalized === "off") return "none";
  return fallback;
}

function normalizeStreamWatchCommentaryPath(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 40).toLowerCase();
  if (normalized === "anthropic_keyframes") return "anthropic_keyframes";
  if (normalized === "auto") return "auto";
  return fallback;
}

function normalizeReflectionStrategy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 64).toLowerCase();
  if (normalized === "one_pass_main") return "one_pass_main";
  if (normalized === "two_pass_extract_then_main") return "two_pass_extract_then_main";
  return fallback;
}

function normalizeClaudeCodeSessionScope(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 32).toLowerCase();
  if (normalized === "guild") return "guild";
  if (normalized === "channel") return "channel";
  if (normalized === "voice_session") return "voice_session";
  return fallback;
}

function normalizeClaudeCodeContextPruningStrategy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 32).toLowerCase();
  if (normalized === "summarize") return "summarize";
  if (normalized === "evict_oldest") return "evict_oldest";
  if (normalized === "sliding_window") return "sliding_window";
  return fallback;
}

function normalizeAgentSessionToolPolicy(value: unknown, fallback: string) {
  const normalized = normalizeString(value, fallback, 16).toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "fast_only") return "fast_only";
  if (normalized === "full") return "full";
  return fallback;
}

function normalizeExecutionPolicy(
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

function normalizeStringList(
  value: unknown,
  maxItems = 50,
  maxLen = 160,
  fallback: readonly string[] = []
) {
  if (!Array.isArray(value) && value === undefined) return [...fallback];
  return normalizeBoundedStringList(value, { maxItems, maxLen });
}

function normalizePromptLineList(value: unknown, fallback: readonly string[]) {
  return normalizeStringList(value, 40, 320, fallback);
}

function normalizePromptLine(value: unknown, fallback: string, maxLen = 400) {
  return normalizeString(value, fallback, maxLen) || fallback;
}

function normalizePromptBlock(value: unknown, fallback: string, maxLen = 8_000) {
  return normalizeString(value, fallback, maxLen) || fallback;
}

function normalizeDiscoverySourceMap(value: unknown) {
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

function normalizeVoiceAdmissionMode(value: unknown, fallback: string) {
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

type AgentStackPresetConfig = {
  preset: string;
  presetOrchestratorFallback: SettingsModelBinding;
  presetVoiceAdmissionClassifierFallback: SettingsModelBinding;
};

function normalizeOptionalString(value: unknown, maxLen = 120) {
  const normalized = normalizeString(value, "", maxLen);
  return normalized || undefined;
}

function resolveAgentStackPresetConfig(rawAgentStack: Record<string, unknown>): AgentStackPresetConfig {
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

function normalizeIdentitySection(section: Settings["identity"]): Settings["identity"] {
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

function normalizePersonaSection(section: Settings["persona"]): Settings["persona"] {
  return {
    flavor: normalizeString(section.flavor, DEFAULT_SETTINGS.persona.flavor, PERSONA_FLAVOR_MAX_CHARS),
    hardLimits: normalizeStringList(section.hardLimits, 40, 220, DEFAULT_SETTINGS.persona.hardLimits)
  };
}

function normalizePromptingSection(section: Settings["prompting"]): Settings["prompting"] {
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

function normalizePermissionsSection(section: Settings["permissions"]): Settings["permissions"] {
  const replies = section.replies;
  const devTasks = section.devTasks;

  return {
    replies: {
      allowReplies: normalizeBoolean(replies.allowReplies, DEFAULT_SETTINGS.permissions.replies.allowReplies),
      allowUnsolicitedReplies: normalizeBoolean(
        replies.allowUnsolicitedReplies,
        DEFAULT_SETTINGS.permissions.replies.allowUnsolicitedReplies
      ),
      allowReactions: normalizeBoolean(
        replies.allowReactions,
        DEFAULT_SETTINGS.permissions.replies.allowReactions
      ),
      replyChannelIds: normalizeStringList(replies.replyChannelIds, 200, 60),
      allowedChannelIds: normalizeStringList(replies.allowedChannelIds, 200, 60),
      blockedChannelIds: normalizeStringList(replies.blockedChannelIds, 200, 60),
      blockedUserIds: normalizeStringList(replies.blockedUserIds, 200, 60),
      maxMessagesPerHour: normalizeInt(
        replies.maxMessagesPerHour,
        DEFAULT_SETTINGS.permissions.replies.maxMessagesPerHour,
        0,
        500
      ),
      maxReactionsPerHour: normalizeInt(
        replies.maxReactionsPerHour,
        DEFAULT_SETTINGS.permissions.replies.maxReactionsPerHour,
        0,
        500
      )
    },
    devTasks: {
      allowedUserIds: normalizeStringList(devTasks.allowedUserIds, 200, 60)
    }
  };
}

function normalizeInteractionSection(
  section: Settings["interaction"],
  orchestratorFallback: SettingsModelBinding
): Settings["interaction"] {
  const activity = section.activity;
  const replyGeneration = section.replyGeneration;
  const followup = section.followup;
  const startup = section.startup;
  const sessions = section.sessions;

  return {
    activity: {
      replyEagerness: normalizeInt(
        activity.replyEagerness,
        DEFAULT_SETTINGS.interaction.activity.replyEagerness,
        0,
        100
      ),
      reactionLevel: normalizeInt(
        activity.reactionLevel,
        DEFAULT_SETTINGS.interaction.activity.reactionLevel,
        0,
        100
      ),
      minSecondsBetweenMessages: normalizeInt(
        activity.minSecondsBetweenMessages,
        DEFAULT_SETTINGS.interaction.activity.minSecondsBetweenMessages,
        5,
        300
      ),
      replyCoalesceWindowSeconds: normalizeInt(
        activity.replyCoalesceWindowSeconds,
        DEFAULT_SETTINGS.interaction.activity.replyCoalesceWindowSeconds,
        0,
        20
      ),
      replyCoalesceMaxMessages: normalizeInt(
        activity.replyCoalesceMaxMessages,
        DEFAULT_SETTINGS.interaction.activity.replyCoalesceMaxMessages,
        1,
        20
      )
    },
    replyGeneration: {
      temperature: normalizeNumber(
        replyGeneration.temperature,
        DEFAULT_SETTINGS.interaction.replyGeneration.temperature,
        0,
        2
      ),
      maxOutputTokens: normalizeInt(
        replyGeneration.maxOutputTokens,
        DEFAULT_SETTINGS.interaction.replyGeneration.maxOutputTokens,
        32,
        16_384
      ),
      reasoningEffort:
        normalizeOpenAiReasoningEffort(
          replyGeneration.reasoningEffort,
          DEFAULT_SETTINGS.interaction.replyGeneration.reasoningEffort
        ) || "",
      pricing: isRecord(replyGeneration.pricing) ? replyGeneration.pricing : {}
    },
    followup: {
      enabled: normalizeBoolean(followup.enabled, DEFAULT_SETTINGS.interaction.followup.enabled),
      execution: normalizeExecutionPolicy(
        followup.execution,
        orchestratorFallback.provider,
        orchestratorFallback.model
      ),
      toolBudget: {
        maxToolSteps: normalizeInt(
          followup.toolBudget.maxToolSteps,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxToolSteps,
          0,
          6
        ),
        maxTotalToolCalls: normalizeInt(
          followup.toolBudget.maxTotalToolCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxTotalToolCalls,
          0,
          12
        ),
        maxWebSearchCalls: normalizeInt(
          followup.toolBudget.maxWebSearchCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxWebSearchCalls,
          0,
          8
        ),
        maxMemoryLookupCalls: normalizeInt(
          followup.toolBudget.maxMemoryLookupCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxMemoryLookupCalls,
          0,
          8
        ),
        maxImageLookupCalls: normalizeInt(
          followup.toolBudget.maxImageLookupCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxImageLookupCalls,
          0,
          8
        ),
        toolTimeoutMs: normalizeInt(
          followup.toolBudget.toolTimeoutMs,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.toolTimeoutMs,
          1_000,
          120_000
        )
      }
    },
    startup: {
      catchupEnabled: normalizeBoolean(
        startup.catchupEnabled,
        DEFAULT_SETTINGS.interaction.startup.catchupEnabled
      ),
      catchupLookbackHours: normalizeInt(
        startup.catchupLookbackHours,
        DEFAULT_SETTINGS.interaction.startup.catchupLookbackHours,
        1,
        168
      ),
      catchupMaxMessagesPerChannel: normalizeInt(
        startup.catchupMaxMessagesPerChannel,
        DEFAULT_SETTINGS.interaction.startup.catchupMaxMessagesPerChannel,
        1,
        200
      ),
      maxCatchupRepliesPerChannel: normalizeInt(
        startup.maxCatchupRepliesPerChannel,
        DEFAULT_SETTINGS.interaction.startup.maxCatchupRepliesPerChannel,
        0,
        20
      )
    },
    sessions: {
      sessionIdleTimeoutMs: normalizeInt(
        sessions.sessionIdleTimeoutMs,
        DEFAULT_SETTINGS.interaction.sessions.sessionIdleTimeoutMs,
        10_000,
        1_800_000
      ),
      maxConcurrentSessions: normalizeInt(
        sessions.maxConcurrentSessions,
        DEFAULT_SETTINGS.interaction.sessions.maxConcurrentSessions,
        1,
        100
      )
    }
  };
}

function normalizeAgentStackSection(
  section: Settings["agentStack"],
  rawAgentStack: Record<string, unknown>,
  rawOverrides: Record<string, unknown>,
  presetConfig: AgentStackPresetConfig,
  orchestratorOverride: SettingsModelBinding
): Settings["agentStack"] {
  const runtimeConfig = section.runtimeConfig;
  const research = runtimeConfig.research;
  const browser = runtimeConfig.browser;
  const voice = runtimeConfig.voice;
  const claudeCodeSession = runtimeConfig.claudeCodeSession;
  const devTeam = runtimeConfig.devTeam;
  const rawDevTeamOverride = isRecord(rawOverrides.devTeam) ? rawOverrides.devTeam : null;

  const overrides: Settings["agentStack"]["overrides"] = {
    orchestrator: orchestratorOverride,
    voiceAdmissionClassifier: normalizeExecutionPolicy(
      rawOverrides.voiceAdmissionClassifier,
      presetConfig.presetVoiceAdmissionClassifierFallback.provider,
      presetConfig.presetVoiceAdmissionClassifierFallback.model,
      { fallbackMode: "dedicated_model" }
    )
  };

  const harness = normalizeOptionalString(rawOverrides.harness, 64);
  if (harness) overrides.harness = harness;

  const researchRuntime = normalizeOptionalString(rawOverrides.researchRuntime, 64);
  if (researchRuntime) overrides.researchRuntime = researchRuntime;

  const browserRuntime = normalizeOptionalString(rawOverrides.browserRuntime, 64);
  if (browserRuntime) overrides.browserRuntime = browserRuntime;

  const voiceRuntime = normalizeOptionalString(rawOverrides.voiceRuntime, 64);
  if (voiceRuntime) overrides.voiceRuntime = voiceRuntime;

  if (rawDevTeamOverride) {
    overrides.devTeam = {
      orchestrator: normalizeModelBinding(
        rawDevTeamOverride.orchestrator,
        presetConfig.presetOrchestratorFallback.provider,
        presetConfig.presetOrchestratorFallback.model
      ),
      codingWorkers: normalizeStringList(rawDevTeamOverride.codingWorkers, 4, 40)
    };
  }

  return {
    preset: presetConfig.preset,
    advancedOverridesEnabled: normalizeBoolean(
      rawAgentStack.advancedOverridesEnabled,
      DEFAULT_SETTINGS.agentStack.advancedOverridesEnabled
    ),
    overrides,
    runtimeConfig: {
      research: {
        enabled: normalizeBoolean(
          research.enabled,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.research.enabled
        ),
        maxSearchesPerHour: normalizeInt(
          research.maxSearchesPerHour,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.research.maxSearchesPerHour,
          0,
          120
        ),
        openaiNativeWebSearch: {
          userLocation: normalizeString(
            research.openaiNativeWebSearch.userLocation,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.openaiNativeWebSearch.userLocation,
            120
          ),
          allowedDomains: normalizeStringList(
            research.openaiNativeWebSearch.allowedDomains,
            50,
            200
          )
        },
        localExternalSearch: {
          safeSearch: normalizeBoolean(
            research.localExternalSearch.safeSearch,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.safeSearch
          ),
          providerOrder: normalizeProviderOrder(research.localExternalSearch.providerOrder),
          maxResults: normalizeInt(
            research.localExternalSearch.maxResults,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxResults,
            1,
            10
          ),
          maxPagesToRead: normalizeInt(
            research.localExternalSearch.maxPagesToRead,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxPagesToRead,
            0,
            5
          ),
          maxCharsPerPage: normalizeInt(
            research.localExternalSearch.maxCharsPerPage,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxCharsPerPage,
            350,
            24_000
          ),
          recencyDaysDefault: normalizeInt(
            research.localExternalSearch.recencyDaysDefault,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.recencyDaysDefault,
            1,
            3_650
          ),
          maxConcurrentFetches: normalizeInt(
            research.localExternalSearch.maxConcurrentFetches,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxConcurrentFetches,
            1,
            10
          )
        }
      },
      browser: {
        enabled: normalizeBoolean(browser.enabled, DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.enabled),
        openaiComputerUse: {
          model: normalizeString(
            browser.openaiComputerUse.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.openaiComputerUse.model,
            120
          )
        },
        localBrowserAgent: {
          execution: normalizeBrowserExecutionPolicy(browser.localBrowserAgent.execution),
          maxBrowseCallsPerHour: normalizeInt(
            browser.localBrowserAgent.maxBrowseCallsPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxBrowseCallsPerHour,
            0,
            60
          ),
          maxStepsPerTask: normalizeInt(
            browser.localBrowserAgent.maxStepsPerTask,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask,
            1,
            30
          ),
          stepTimeoutMs: normalizeInt(
            browser.localBrowserAgent.stepTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs,
            5_000,
            120_000
          ),
          sessionTimeoutMs: normalizeInt(
            browser.localBrowserAgent.sessionTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.sessionTimeoutMs,
            10_000,
            1_800_000
          )
        }
      },
      voice: {
        runtimeMode: normalizeVoiceRuntimeMode(
          voice.runtimeMode,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.runtimeMode
        ),
        openaiRealtime: {
          model: normalizeString(
            voice.openaiRealtime.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.model,
            120
          ),
          voice: normalizeString(
            voice.openaiRealtime.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.voice,
            120
          ),
          inputAudioFormat: normalizeString(
            normalizeOpenAiRealtimeAudioFormat(
              voice.openaiRealtime.inputAudioFormat,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat
            ),
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat,
            120
          ),
          outputAudioFormat: normalizeString(
            normalizeOpenAiRealtimeAudioFormat(
              voice.openaiRealtime.outputAudioFormat,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat
            ),
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat,
            120
          ),
          transcriptionMethod: normalizeOpenAiRealtimeTranscriptionMethod(
            voice.openaiRealtime.transcriptionMethod,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod
          ),
          inputTranscriptionModel: normalizeOpenAiRealtimeTranscriptionModel(
            voice.openaiRealtime.inputTranscriptionModel,
            OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
          ),
          usePerUserAsrBridge: normalizeBoolean(
            voice.openaiRealtime.usePerUserAsrBridge,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge
          )
        },
        xai: {
          voice: normalizeString(
            voice.xai.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.voice,
            120
          ),
          audioFormat: normalizeString(
            voice.xai.audioFormat,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.audioFormat,
            120
          ),
          sampleRateHz: normalizeInt(
            voice.xai.sampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.sampleRateHz,
            8_000,
            96_000
          ),
          region: normalizeString(
            voice.xai.region,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.xai.region,
            120
          )
        },
        elevenLabsRealtime: {
          agentId: normalizeString(
            voice.elevenLabsRealtime.agentId,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.agentId,
            200
          ),
          voiceId: normalizeString(
            voice.elevenLabsRealtime.voiceId,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.voiceId,
            200
          ),
          apiBaseUrl: normalizeHttpBaseUrl(
            voice.elevenLabsRealtime.apiBaseUrl,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.apiBaseUrl
          ),
          inputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.inputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.inputSampleRateHz,
            8_000,
            96_000
          ),
          outputSampleRateHz: normalizeInt(
            voice.elevenLabsRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.elevenLabsRealtime.outputSampleRateHz,
            8_000,
            96_000
          )
        },
        geminiRealtime: {
          model: normalizeString(
            voice.geminiRealtime.model,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.model,
            120
          ),
          voice: normalizeString(
            voice.geminiRealtime.voice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.voice,
            120
          ),
          apiBaseUrl: normalizeHttpBaseUrl(
            voice.geminiRealtime.apiBaseUrl,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.apiBaseUrl
          ),
          inputSampleRateHz: normalizeInt(
            voice.geminiRealtime.inputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.inputSampleRateHz,
            8_000,
            96_000
          ),
          outputSampleRateHz: normalizeInt(
            voice.geminiRealtime.outputSampleRateHz,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.geminiRealtime.outputSampleRateHz,
            8_000,
            96_000
          )
        },
        sttPipeline: {
          transcriptionModel: normalizeString(
            voice.sttPipeline.transcriptionModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.transcriptionModel,
            120
          ),
          ttsModel: normalizeString(
            voice.sttPipeline.ttsModel,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsModel,
            120
          ),
          ttsVoice: normalizeString(
            voice.sttPipeline.ttsVoice,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsVoice,
            120
          ),
          ttsSpeed: normalizeNumber(
            voice.sttPipeline.ttsSpeed,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.sttPipeline.ttsSpeed,
            0.25,
            4
          )
        },
        generation: normalizeExecutionPolicy(voice.generation, "anthropic", "claude-sonnet-4-6")
      },
      claudeCodeSession: {
        sessionScope: normalizeClaudeCodeSessionScope(
          claudeCodeSession.sessionScope,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.sessionScope
        ),
        inactivityTimeoutMs: normalizeInt(
          claudeCodeSession.inactivityTimeoutMs,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.inactivityTimeoutMs,
          10_000,
          12 * 60 * 60 * 1000
        ),
        contextPruningStrategy: normalizeClaudeCodeContextPruningStrategy(
          claudeCodeSession.contextPruningStrategy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.contextPruningStrategy
        ),
        maxPinnedStateChars: normalizeInt(
          claudeCodeSession.maxPinnedStateChars,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.maxPinnedStateChars,
          0,
          200_000
        ),
        voiceToolPolicy: normalizeAgentSessionToolPolicy(
          claudeCodeSession.voiceToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.voiceToolPolicy
        ),
        textToolPolicy: normalizeAgentSessionToolPolicy(
          claudeCodeSession.textToolPolicy,
          DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.textToolPolicy
        )
      },
      devTeam: {
        codex: {
          enabled: normalizeBoolean(
            devTeam.codex.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.enabled
          ),
          model:
            normalizeString(
              devTeam.codex.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
              120
            ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
          maxTurns: normalizeInt(
            devTeam.codex.maxTurns,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTurns,
            1,
            200
          ),
          timeoutMs: normalizeInt(
            devTeam.codex.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.timeoutMs,
            10_000,
            1_800_000
          ),
          maxBufferBytes: normalizeInt(
            devTeam.codex.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxBufferBytes,
            4_096,
            10 * 1024 * 1024
          ),
          defaultCwd: normalizeString(
            devTeam.codex.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.codex.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTasksPerHour,
            0,
            200
          ),
          maxParallelTasks: normalizeInt(
            devTeam.codex.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxParallelTasks,
            1,
            20
          )
        },
        claudeCode: {
          enabled: normalizeBoolean(
            devTeam.claudeCode.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.enabled
          ),
          model:
            normalizeString(
              devTeam.claudeCode.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
              120
            ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
          maxTurns: normalizeInt(
            devTeam.claudeCode.maxTurns,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTurns,
            1,
            200
          ),
          timeoutMs: normalizeInt(
            devTeam.claudeCode.timeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.timeoutMs,
            10_000,
            1_800_000
          ),
          maxBufferBytes: normalizeInt(
            devTeam.claudeCode.maxBufferBytes,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxBufferBytes,
            4_096,
            10 * 1024 * 1024
          ),
          defaultCwd: normalizeString(
            devTeam.claudeCode.defaultCwd,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.defaultCwd,
            400
          ),
          maxTasksPerHour: normalizeInt(
            devTeam.claudeCode.maxTasksPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTasksPerHour,
            0,
            200
          ),
          maxParallelTasks: normalizeInt(
            devTeam.claudeCode.maxParallelTasks,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxParallelTasks,
            1,
            20
          )
        }
      }
    }
  };
}

function normalizeMemorySection(section: Settings["memory"]): Settings["memory"] {
  const promptSlice = section.promptSlice;
  const extraction = section.extraction;
  const reflection = section.reflection;

  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.memory.enabled),
    promptSlice: {
      maxRecentMessages: normalizeInt(
        promptSlice.maxRecentMessages,
        DEFAULT_SETTINGS.memory.promptSlice.maxRecentMessages,
        4,
        120
      ),
      maxHighlights: normalizeInt(
        promptSlice.maxHighlights,
        DEFAULT_SETTINGS.memory.promptSlice.maxHighlights,
        1,
        40
      )
    },
    execution: normalizeExecutionPolicy(section.execution, "anthropic", "claude-haiku-4-5", {
      fallbackMode: "dedicated_model",
      fallbackTemperature: 0,
      fallbackMaxOutputTokens: 320
    }),
    extraction: {
      enabled: normalizeBoolean(extraction.enabled, DEFAULT_SETTINGS.memory.extraction.enabled)
    },
    embeddingModel: normalizeString(
      section.embeddingModel,
      DEFAULT_SETTINGS.memory.embeddingModel,
      120
    ),
    reflection: {
      enabled: normalizeBoolean(reflection.enabled, DEFAULT_SETTINGS.memory.reflection.enabled),
      strategy: normalizeReflectionStrategy(
        reflection.strategy,
        DEFAULT_SETTINGS.memory.reflection.strategy
      ),
      hour: normalizeInt(reflection.hour, DEFAULT_SETTINGS.memory.reflection.hour, 0, 23),
      minute: normalizeInt(reflection.minute, DEFAULT_SETTINGS.memory.reflection.minute, 0, 59),
      maxFactsPerReflection: normalizeInt(
        reflection.maxFactsPerReflection,
        DEFAULT_SETTINGS.memory.reflection.maxFactsPerReflection,
        1,
        100
      )
    },
    dailyLogRetentionDays: normalizeInt(
      section.dailyLogRetentionDays,
      DEFAULT_SETTINGS.memory.dailyLogRetentionDays,
      1,
      365
    )
  };
}

function normalizeDirectivesSection(section: Settings["directives"]): Settings["directives"] {
  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.directives.enabled)
  };
}

function normalizeInitiativeSection(section: Settings["initiative"]): Settings["initiative"] {
  const text = section.text;
  const voice = section.voice;
  const discovery = section.discovery;

  return {
    text: {
      enabled: normalizeBoolean(text.enabled, DEFAULT_SETTINGS.initiative.text.enabled),
      execution: normalizeExecutionPolicy(text.execution, "openai", "gpt-5"),
      eagerness: normalizeInt(text.eagerness, DEFAULT_SETTINGS.initiative.text.eagerness, 0, 100),
      minMinutesBetweenThoughts: normalizeInt(
        text.minMinutesBetweenThoughts,
        DEFAULT_SETTINGS.initiative.text.minMinutesBetweenThoughts,
        5,
        24 * 60
      ),
      maxThoughtsPerDay: normalizeInt(
        text.maxThoughtsPerDay,
        DEFAULT_SETTINGS.initiative.text.maxThoughtsPerDay,
        0,
        100
      ),
      lookbackMessages: normalizeInt(
        text.lookbackMessages,
        DEFAULT_SETTINGS.initiative.text.lookbackMessages,
        4,
        80
      )
    },
    voice: {
      enabled: normalizeBoolean(voice.enabled, DEFAULT_SETTINGS.initiative.voice.enabled),
      execution: normalizeExecutionPolicy(voice.execution, "anthropic", "claude-sonnet-4-6", {
        fallbackMode: "dedicated_model",
        fallbackTemperature: 1.2
      }),
      eagerness: normalizeInt(voice.eagerness, DEFAULT_SETTINGS.initiative.voice.eagerness, 0, 100),
      minSilenceSeconds: normalizeInt(
        voice.minSilenceSeconds,
        DEFAULT_SETTINGS.initiative.voice.minSilenceSeconds,
        1,
        300
      ),
      minSecondsBetweenThoughts: normalizeInt(
        voice.minSecondsBetweenThoughts,
        DEFAULT_SETTINGS.initiative.voice.minSecondsBetweenThoughts,
        1,
        600
      )
    },
    discovery: {
      enabled: normalizeBoolean(discovery.enabled, DEFAULT_SETTINGS.initiative.discovery.enabled),
      channelIds: normalizeStringList(discovery.channelIds, 200, 60),
      maxPostsPerDay: normalizeInt(
        discovery.maxPostsPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxPostsPerDay,
        0,
        50
      ),
      minMinutesBetweenPosts: normalizeInt(
        discovery.minMinutesBetweenPosts,
        DEFAULT_SETTINGS.initiative.discovery.minMinutesBetweenPosts,
        1,
        24 * 60
      ),
      pacingMode:
        normalizeString(
          discovery.pacingMode,
          DEFAULT_SETTINGS.initiative.discovery.pacingMode,
          40
        ).toLowerCase() === "spontaneous"
          ? "spontaneous"
          : "even",
      spontaneity: normalizeInt(
        discovery.spontaneity,
        DEFAULT_SETTINGS.initiative.discovery.spontaneity,
        0,
        100
      ),
      postOnStartup: normalizeBoolean(
        discovery.postOnStartup,
        DEFAULT_SETTINGS.initiative.discovery.postOnStartup
      ),
      allowImagePosts: normalizeBoolean(
        discovery.allowImagePosts,
        DEFAULT_SETTINGS.initiative.discovery.allowImagePosts
      ),
      allowVideoPosts: normalizeBoolean(
        discovery.allowVideoPosts,
        DEFAULT_SETTINGS.initiative.discovery.allowVideoPosts
      ),
      allowReplyImages: normalizeBoolean(
        discovery.allowReplyImages,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyImages
      ),
      allowReplyVideos: normalizeBoolean(
        discovery.allowReplyVideos,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyVideos
      ),
      allowReplyGifs: normalizeBoolean(
        discovery.allowReplyGifs,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyGifs
      ),
      maxImagesPerDay: normalizeInt(
        discovery.maxImagesPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxImagesPerDay,
        0,
        200
      ),
      maxVideosPerDay: normalizeInt(
        discovery.maxVideosPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxVideosPerDay,
        0,
        120
      ),
      maxGifsPerDay: normalizeInt(
        discovery.maxGifsPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxGifsPerDay,
        0,
        300
      ),
      simpleImageModel: normalizeString(
        discovery.simpleImageModel,
        DEFAULT_SETTINGS.initiative.discovery.simpleImageModel,
        120
      ),
      complexImageModel: normalizeString(
        discovery.complexImageModel,
        DEFAULT_SETTINGS.initiative.discovery.complexImageModel,
        120
      ),
      videoModel: normalizeString(
        discovery.videoModel,
        DEFAULT_SETTINGS.initiative.discovery.videoModel,
        120
      ),
      allowedImageModels: normalizeStringList(
        discovery.allowedImageModels,
        20,
        120,
        DEFAULT_SETTINGS.initiative.discovery.allowedImageModels
      ),
      allowedVideoModels: normalizeStringList(
        discovery.allowedVideoModels,
        20,
        120,
        DEFAULT_SETTINGS.initiative.discovery.allowedVideoModels
      ),
      maxMediaPromptChars: normalizeInt(
        discovery.maxMediaPromptChars,
        DEFAULT_SETTINGS.initiative.discovery.maxMediaPromptChars,
        100,
        2_000
      ),
      linkChancePercent: normalizeInt(
        discovery.linkChancePercent,
        DEFAULT_SETTINGS.initiative.discovery.linkChancePercent,
        0,
        100
      ),
      maxLinksPerPost: normalizeInt(
        discovery.maxLinksPerPost,
        DEFAULT_SETTINGS.initiative.discovery.maxLinksPerPost,
        0,
        5
      ),
      maxCandidatesForPrompt: normalizeInt(
        discovery.maxCandidatesForPrompt,
        DEFAULT_SETTINGS.initiative.discovery.maxCandidatesForPrompt,
        1,
        20
      ),
      freshnessHours: normalizeInt(
        discovery.freshnessHours,
        DEFAULT_SETTINGS.initiative.discovery.freshnessHours,
        1,
        24 * 30
      ),
      dedupeHours: normalizeInt(
        discovery.dedupeHours,
        DEFAULT_SETTINGS.initiative.discovery.dedupeHours,
        1,
        24 * 90
      ),
      randomness: normalizeInt(
        discovery.randomness,
        DEFAULT_SETTINGS.initiative.discovery.randomness,
        0,
        100
      ),
      sourceFetchLimit: normalizeInt(
        discovery.sourceFetchLimit,
        DEFAULT_SETTINGS.initiative.discovery.sourceFetchLimit,
        1,
        50
      ),
      allowNsfw: normalizeBoolean(discovery.allowNsfw, DEFAULT_SETTINGS.initiative.discovery.allowNsfw),
      preferredTopics: normalizeStringList(discovery.preferredTopics, 50, 120),
      redditSubreddits: normalizeSubreddits(
        discovery.redditSubreddits,
        DEFAULT_SETTINGS.initiative.discovery.redditSubreddits
      ),
      youtubeChannelIds: normalizeStringList(discovery.youtubeChannelIds, 50, 120),
      rssFeeds: normalizeDiscoveryRssFeeds(
        discovery.rssFeeds,
        DEFAULT_SETTINGS.initiative.discovery.rssFeeds
      ),
      xHandles: normalizeXHandles(discovery.xHandles),
      xNitterBaseUrl: normalizeHttpBaseUrl(
        discovery.xNitterBaseUrl,
        DEFAULT_SETTINGS.initiative.discovery.xNitterBaseUrl
      ),
      sources: normalizeDiscoverySourceMap(discovery.sources)
    }
  };
}

function normalizeVoiceSection(section: Settings["voice"]): Settings["voice"] {
  const transcription = section.transcription;
  const channelPolicy = section.channelPolicy;
  const sessionLimits = section.sessionLimits;
  const conversationPolicy = section.conversationPolicy;
  const admission = section.admission;
  const streamWatch = section.streamWatch;
  const soundboard = section.soundboard;

  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.voice.enabled),
    transcription: {
      enabled: normalizeBoolean(transcription.enabled, DEFAULT_SETTINGS.voice.transcription.enabled),
      languageMode:
        normalizeString(
          transcription.languageMode,
          DEFAULT_SETTINGS.voice.transcription.languageMode,
          40
        ).toLowerCase() === "fixed"
          ? "fixed"
          : "auto",
      languageHint: normalizeLanguageHint(
        transcription.languageHint,
        DEFAULT_SETTINGS.voice.transcription.languageHint
      )
    },
    channelPolicy: {
      allowedChannelIds: normalizeStringList(channelPolicy.allowedChannelIds, 200, 60),
      blockedChannelIds: normalizeStringList(channelPolicy.blockedChannelIds, 200, 60),
      blockedUserIds: normalizeStringList(channelPolicy.blockedUserIds, 200, 60)
    },
    sessionLimits: {
      maxSessionMinutes: normalizeInt(
        sessionLimits.maxSessionMinutes,
        DEFAULT_SETTINGS.voice.sessionLimits.maxSessionMinutes,
        1,
        240
      ),
      inactivityLeaveSeconds: normalizeInt(
        sessionLimits.inactivityLeaveSeconds,
        DEFAULT_SETTINGS.voice.sessionLimits.inactivityLeaveSeconds,
        15,
        3_600
      ),
      maxSessionsPerDay: normalizeInt(
        sessionLimits.maxSessionsPerDay,
        DEFAULT_SETTINGS.voice.sessionLimits.maxSessionsPerDay,
        0,
        240
      ),
      maxConcurrentSessions: normalizeInt(
        sessionLimits.maxConcurrentSessions,
        DEFAULT_SETTINGS.voice.sessionLimits.maxConcurrentSessions,
        1,
        3
      )
    },
    conversationPolicy: {
      replyEagerness: normalizeInt(
        conversationPolicy.replyEagerness,
        DEFAULT_SETTINGS.voice.conversationPolicy.replyEagerness,
        0,
        100
      ),
      commandOnlyMode: normalizeBoolean(
        conversationPolicy.commandOnlyMode,
        DEFAULT_SETTINGS.voice.conversationPolicy.commandOnlyMode
      ),
      allowNsfwHumor: normalizeBoolean(
        conversationPolicy.allowNsfwHumor,
        DEFAULT_SETTINGS.voice.conversationPolicy.allowNsfwHumor
      ),
      textOnlyMode: normalizeBoolean(
        conversationPolicy.textOnlyMode,
        DEFAULT_SETTINGS.voice.conversationPolicy.textOnlyMode
      ),
      replyPath: normalizeReplyPath(
        conversationPolicy.replyPath,
        DEFAULT_SETTINGS.voice.conversationPolicy.replyPath
      ),
      ttsMode:
        normalizeString(
          conversationPolicy.ttsMode,
          DEFAULT_SETTINGS.voice.conversationPolicy.ttsMode,
          20
        ).toLowerCase() === "api"
          ? "api"
          : "realtime",
      operationalMessages: normalizeOperationalMessages(
        conversationPolicy.operationalMessages,
        DEFAULT_SETTINGS.voice.conversationPolicy.operationalMessages
      )
    },
    admission: {
      mode: normalizeVoiceAdmissionMode(admission.mode, DEFAULT_SETTINGS.voice.admission.mode),
      wakeSignals: normalizeStringList(
        admission.wakeSignals,
        10,
        40,
        DEFAULT_SETTINGS.voice.admission.wakeSignals
      ),
      intentConfidenceThreshold: normalizeNumber(
        admission.intentConfidenceThreshold,
        DEFAULT_SETTINGS.voice.admission.intentConfidenceThreshold,
        0,
        1
      ),
      musicWakeLatchSeconds: normalizeInt(
        admission.musicWakeLatchSeconds,
        DEFAULT_SETTINGS.voice.admission.musicWakeLatchSeconds,
        0,
        120
      )
    },
    streamWatch: {
      enabled: normalizeBoolean(streamWatch.enabled, DEFAULT_SETTINGS.voice.streamWatch.enabled),
      minCommentaryIntervalSeconds: normalizeInt(
        streamWatch.minCommentaryIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.minCommentaryIntervalSeconds,
        3,
        120
      ),
      maxFramesPerMinute: normalizeInt(
        streamWatch.maxFramesPerMinute,
        DEFAULT_SETTINGS.voice.streamWatch.maxFramesPerMinute,
        6,
        600
      ),
      maxFrameBytes: normalizeInt(
        streamWatch.maxFrameBytes,
        DEFAULT_SETTINGS.voice.streamWatch.maxFrameBytes,
        50_000,
        4_000_000
      ),
      commentaryPath: normalizeStreamWatchCommentaryPath(
        streamWatch.commentaryPath,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryPath
      ),
      keyframeIntervalMs: normalizeInt(
        streamWatch.keyframeIntervalMs,
        DEFAULT_SETTINGS.voice.streamWatch.keyframeIntervalMs,
        250,
        10_000
      ),
      autonomousCommentaryEnabled: normalizeBoolean(
        streamWatch.autonomousCommentaryEnabled,
        DEFAULT_SETTINGS.voice.streamWatch.autonomousCommentaryEnabled
      ),
      brainContextEnabled: normalizeBoolean(
        streamWatch.brainContextEnabled,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextEnabled
      ),
      brainContextMinIntervalSeconds: normalizeInt(
        streamWatch.brainContextMinIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextMinIntervalSeconds,
        1,
        60
      ),
      brainContextMaxEntries: normalizeInt(
        streamWatch.brainContextMaxEntries,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextMaxEntries,
        1,
        24
      ),
      brainContextPrompt: normalizePromptBlock(
        streamWatch.brainContextPrompt,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextPrompt,
        420
      ),
      sharePageMaxWidthPx: normalizeInt(
        streamWatch.sharePageMaxWidthPx,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageMaxWidthPx,
        320,
        1_920
      ),
      sharePageJpegQuality: normalizeNumber(
        streamWatch.sharePageJpegQuality,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageJpegQuality,
        0.1,
        1
      )
    },
    soundboard: {
      enabled: normalizeBoolean(soundboard.enabled, DEFAULT_SETTINGS.voice.soundboard.enabled),
      allowExternalSounds: normalizeBoolean(
        soundboard.allowExternalSounds,
        DEFAULT_SETTINGS.voice.soundboard.allowExternalSounds
      ),
      preferredSoundIds: normalizeStringList(soundboard.preferredSoundIds, 100, 160)
    }
  };
}

function normalizeMediaSection(section: Settings["media"]): Settings["media"] {
  const vision = section.vision;
  const videoContext = section.videoContext;

  return {
    vision: {
      enabled: normalizeBoolean(vision.enabled, DEFAULT_SETTINGS.media.vision.enabled),
      execution: normalizeExecutionPolicy(vision.execution, "anthropic", "claude-haiku-4-5", {
        fallbackMode: "dedicated_model"
      }),
      maxAutoIncludeImages: normalizeInt(
        vision.maxAutoIncludeImages,
        DEFAULT_SETTINGS.media.vision.maxAutoIncludeImages,
        0,
        10
      ),
      maxCaptionsPerHour: normalizeInt(
        vision.maxCaptionsPerHour,
        DEFAULT_SETTINGS.media.vision.maxCaptionsPerHour,
        0,
        500
      )
    },
    videoContext: {
      enabled: normalizeBoolean(videoContext.enabled, DEFAULT_SETTINGS.media.videoContext.enabled),
      execution: normalizeExecutionPolicy(videoContext.execution, "openai", "gpt-5"),
      maxLookupsPerHour: normalizeInt(
        videoContext.maxLookupsPerHour,
        DEFAULT_SETTINGS.media.videoContext.maxLookupsPerHour,
        0,
        200
      ),
      maxVideosPerMessage: normalizeInt(
        videoContext.maxVideosPerMessage,
        DEFAULT_SETTINGS.media.videoContext.maxVideosPerMessage,
        0,
        6
      ),
      maxTranscriptChars: normalizeInt(
        videoContext.maxTranscriptChars,
        DEFAULT_SETTINGS.media.videoContext.maxTranscriptChars,
        200,
        4_000
      ),
      keyframeIntervalSeconds: normalizeInt(
        videoContext.keyframeIntervalSeconds,
        DEFAULT_SETTINGS.media.videoContext.keyframeIntervalSeconds,
        0,
        120
      ),
      maxKeyframesPerVideo: normalizeInt(
        videoContext.maxKeyframesPerVideo,
        DEFAULT_SETTINGS.media.videoContext.maxKeyframesPerVideo,
        0,
        8
      ),
      allowAsrFallback: normalizeBoolean(
        videoContext.allowAsrFallback,
        DEFAULT_SETTINGS.media.videoContext.allowAsrFallback
      ),
      maxAsrSeconds: normalizeInt(
        videoContext.maxAsrSeconds,
        DEFAULT_SETTINGS.media.videoContext.maxAsrSeconds,
        15,
        600
      )
    }
  };
}

function normalizeMusicSection(section: Settings["music"]): Settings["music"] {
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

function normalizeAutomationsSection(section: Settings["automations"]): Settings["automations"] {
  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.automations.enabled)
  };
}

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
