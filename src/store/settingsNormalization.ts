import { DEFAULT_SETTINGS, PROVIDER_MODEL_FALLBACKS } from "../settings/settingsSchema.ts";
import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import { normalizeProviderOrder } from "../search.ts";
import { clamp, deepMerge } from "../utils.ts";
import {
  normalizeLlmProvider,
  normalizeOpenAiReasoningEffort
} from "../llm/llmHelpers.ts";
import {
  normalizeVoiceProvider
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
) {
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
  ) as Record<string, unknown>;
  if (normalized.mode !== "dedicated_model") {
    return normalized;
  }
  const rawModel = isRecord(normalized.model) ? normalized.model : {};
  const rawProvider = normalizeLlmProvider(rawModel.provider, "anthropic");
  const provider = normalizeBrowserProvider(rawProvider, "anthropic");
  const fallbackModel =
    provider === "openai"
      ? "gpt-5-mini"
      : "claude-sonnet-4-5-20250929";
  return {
    ...normalized,
    model: {
      provider,
      model:
        normalizeString(rawProvider === provider ? rawModel.model : "", fallbackModel, 120) ||
        fallbackModel
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
) {
  const source = isRecord(policy) ? policy : {};
  const modeRaw = normalizeString(source.mode, fallbackMode, 40).toLowerCase();
  const mode = modeRaw === "dedicated_model" ? "dedicated_model" : "inherit_orchestrator";
  const normalized: Record<string, unknown> = { mode };
  if (mode === "dedicated_model") {
    normalized.model = normalizeModelBinding(source.model, fallbackProvider, fallbackModel);
  }
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

function inferLegacyPreset(raw: Record<string, unknown>) {
  const llmProvider = normalizeLlmProvider(raw?.llm && isRecord(raw.llm) ? raw.llm.provider : undefined, "anthropic");
  const legacyVoiceProvider = normalizeVoiceProvider(
    raw?.voice && isRecord(raw.voice) ? raw.voice.voiceProvider : undefined,
    "openai"
  );
  if (llmProvider === "openai" && legacyVoiceProvider === "openai") {
    return "openai_native";
  }
  if (llmProvider === "anthropic" && legacyVoiceProvider === "openai") {
    return "anthropic_brain_openai_tools";
  }
  return "multi_provider_legacy";
}

function migrateLegacySettings(raw: Record<string, unknown>) {
  const prompt = isRecord(raw.prompt) ? raw.prompt : {};
  const activity = isRecord(raw.activity) ? raw.activity : {};
  const llm = isRecord(raw.llm) ? raw.llm : {};
  const replyFollowupLlm = isRecord(raw.replyFollowupLlm) ? raw.replyFollowupLlm : {};
  const memoryLlm = isRecord(raw.memoryLlm) ? raw.memoryLlm : {};
  const webSearch = isRecord(raw.webSearch) ? raw.webSearch : {};
  const browser = isRecord(raw.browser) ? raw.browser : {};
  const voice = isRecord(raw.voice) ? raw.voice : {};
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  const discovery = isRecord(raw.discovery) ? raw.discovery : {};
  const startup = isRecord(raw.startup) ? raw.startup : {};
  const textThoughtLoop = isRecord(raw.textThoughtLoop) ? raw.textThoughtLoop : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const reflection = isRecord(memory.reflection) ? memory.reflection : {};
  const codeAgent = isRecord(raw.codeAgent) ? raw.codeAgent : {};
  const adaptiveDirectives = isRecord(raw.adaptiveDirectives) ? raw.adaptiveDirectives : {};
  const automations = isRecord(raw.automations) ? raw.automations : {};
  const subAgentOrchestration = isRecord(raw.subAgentOrchestration) ? raw.subAgentOrchestration : {};
  const voiceThoughtEngine = isRecord(voice.thoughtEngine) ? voice.thoughtEngine : {};
  const voiceGenerationLlm = isRecord(voice.generationLlm) ? voice.generationLlm : {};
  const voiceReplyDecisionLlm = isRecord(voice.replyDecisionLlm) ? voice.replyDecisionLlm : {};
  const vision = isRecord(raw.vision) ? raw.vision : {};
  const videoContext = isRecord(raw.videoContext) ? raw.videoContext : {};

  const migrated: Record<string, unknown> = {
    identity: {
      botName: raw.botName,
      botNameAliases: raw.botNameAliases
    },
    persona: raw.persona,
    prompting: {
      global: {
        capabilityHonestyLine: prompt.capabilityHonestyLine,
        impossibleActionLine: prompt.impossibleActionLine,
        memoryEnabledLine: prompt.memoryEnabledLine,
        memoryDisabledLine: prompt.memoryDisabledLine,
        skipLine: prompt.skipLine
      },
      text: {
        guidance: prompt.textGuidance
      },
      voice: {
        guidance: prompt.voiceGuidance,
        operationalGuidance: prompt.voiceOperationalGuidance,
        lookupBusySystemPrompt: prompt.voiceLookupBusySystemPrompt
      },
      media: {
        promptCraftGuidance: prompt.mediaPromptCraftGuidance
      }
    },
    permissions: {
      replies: {
        allowReplies: permissions.allowReplies,
        allowUnsolicitedReplies: permissions.allowUnsolicitedReplies,
        allowReactions: permissions.allowReactions,
        replyChannelIds: permissions.replyChannelIds,
        allowedChannelIds: permissions.allowedChannelIds,
        blockedChannelIds: permissions.blockedChannelIds,
        blockedUserIds: permissions.blockedUserIds,
        maxMessagesPerHour: permissions.maxMessagesPerHour,
        maxReactionsPerHour: permissions.maxReactionsPerHour
      },
      devTasks: {
        allowedUserIds: codeAgent.allowedUserIds
      }
    },
    interaction: {
      activity: {
        replyEagerness: activity.replyEagerness ?? activity.replyLevelReplyChannels,
        reactionLevel: activity.reactionLevel,
        minSecondsBetweenMessages: activity.minSecondsBetweenMessages,
        replyCoalesceWindowSeconds: activity.replyCoalesceWindowSeconds,
        replyCoalesceMaxMessages: activity.replyCoalesceMaxMessages
      },
      replyGeneration: {
        temperature: llm.temperature,
        maxOutputTokens: llm.maxOutputTokens,
        reasoningEffort: llm.reasoningEffort,
        pricing: llm.pricing
      },
      followup: {
        enabled: replyFollowupLlm.enabled,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: replyFollowupLlm.provider ?? llm.provider,
            model: replyFollowupLlm.model ?? llm.model
          }
        },
        toolBudget: {
          maxToolSteps: replyFollowupLlm.maxToolSteps,
          maxTotalToolCalls: replyFollowupLlm.maxTotalToolCalls,
          maxWebSearchCalls: replyFollowupLlm.maxWebSearchCalls,
          maxMemoryLookupCalls: replyFollowupLlm.maxMemoryLookupCalls,
          maxImageLookupCalls: replyFollowupLlm.maxImageLookupCalls,
          toolTimeoutMs: replyFollowupLlm.toolTimeoutMs
        }
      },
      startup: {
        catchupEnabled: startup.catchupEnabled,
        catchupLookbackHours: startup.catchupLookbackHours,
        catchupMaxMessagesPerChannel: startup.catchupMaxMessagesPerChannel,
        maxCatchupRepliesPerChannel: startup.maxCatchupRepliesPerChannel
      },
      sessions: {
        sessionIdleTimeoutMs: subAgentOrchestration.sessionIdleTimeoutMs,
        maxConcurrentSessions: subAgentOrchestration.maxConcurrentSessions
      }
    },
    agentStack: {
      preset: inferLegacyPreset(raw),
      advancedOverridesEnabled: true,
      overrides: {
        orchestrator: {
          provider: llm.provider,
          model: llm.model
        },
        devTeam: {
          codingWorkers:
            String(codeAgent.provider || "").trim().toLowerCase() === "codex"
              ? ["codex"]
              : String(codeAgent.provider || "").trim().toLowerCase() === "claude-code"
                ? ["claude_code"]
                : undefined
        },
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: voiceReplyDecisionLlm.provider,
            model: voiceReplyDecisionLlm.model
          }
        }
      },
      runtimeConfig: {
        research: {
          enabled: webSearch.enabled,
          maxSearchesPerHour: webSearch.maxSearchesPerHour,
          localExternalSearch: {
            safeSearch: webSearch.safeSearch,
            providerOrder: webSearch.providerOrder,
            maxResults: webSearch.maxResults,
            maxPagesToRead: webSearch.maxPagesToRead,
            maxCharsPerPage: webSearch.maxCharsPerPage,
            recencyDaysDefault: webSearch.recencyDaysDefault,
            maxConcurrentFetches: webSearch.maxConcurrentFetches
          }
        },
        browser: {
          enabled: browser.enabled,
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: browser.llm && isRecord(browser.llm) ? browser.llm.provider : undefined,
                model: browser.llm && isRecord(browser.llm) ? browser.llm.model : undefined
              }
            },
            maxBrowseCallsPerHour: browser.maxBrowseCallsPerHour,
            maxStepsPerTask: browser.maxStepsPerTask,
            stepTimeoutMs: browser.stepTimeoutMs,
            sessionTimeoutMs: browser.sessionTimeoutMs
          }
        },
        voice: {
          openaiRealtime: voice.openaiRealtime,
          legacyVoiceStack: {
            selectedProvider: voice.voiceProvider,
            xai: voice.xai,
            elevenLabsRealtime: voice.elevenLabsRealtime,
            geminiRealtime: voice.geminiRealtime,
            sttPipeline: voice.sttPipeline,
            generation: Boolean(voiceGenerationLlm.useTextModel)
              ? { mode: "inherit_orchestrator" }
              : {
                  mode: "dedicated_model",
                  model: {
                    provider: voiceGenerationLlm.provider,
                    model: voiceGenerationLlm.model
                  }
                }
          }
        },
        devTeam: {
          codex: {
            enabled:
              String(codeAgent.provider || "").trim().toLowerCase() === "codex" ||
              String(codeAgent.provider || "").trim().toLowerCase() === "auto",
            model: codeAgent.codexModel,
            maxTurns: codeAgent.maxTurns,
            timeoutMs: codeAgent.timeoutMs,
            maxBufferBytes: codeAgent.maxBufferBytes,
            defaultCwd: codeAgent.defaultCwd,
            maxTasksPerHour: codeAgent.maxTasksPerHour,
            maxParallelTasks: codeAgent.maxParallelTasks
          },
          claudeCode: {
            enabled:
              String(codeAgent.provider || "").trim().toLowerCase() !== "codex",
            model: codeAgent.model,
            maxTurns: codeAgent.maxTurns,
            timeoutMs: codeAgent.timeoutMs,
            maxBufferBytes: codeAgent.maxBufferBytes,
            defaultCwd: codeAgent.defaultCwd,
            maxTasksPerHour: codeAgent.maxTasksPerHour,
            maxParallelTasks: codeAgent.maxParallelTasks
          }
        }
      }
    },
    memory: {
      enabled: memory.enabled,
      promptSlice: {
        maxRecentMessages: memory.maxRecentMessages,
        maxHighlights: memory.maxHighlights
      },
      execution: {
        mode: "dedicated_model",
        model: {
          provider: memoryLlm.provider ?? llm.provider,
          model: memoryLlm.model ?? llm.model
        },
        temperature: memoryLlm.temperature,
        maxOutputTokens: memoryLlm.maxOutputTokens
      },
      extraction: {
        enabled: true
      },
      embeddingModel: memory.embeddingModel,
      reflection: {
        enabled: reflection.enabled,
        strategy: reflection.strategy,
        hour: reflection.hour,
        minute: reflection.minute,
        maxFactsPerReflection: reflection.maxFactsPerReflection
      },
      dailyLogRetentionDays: memory.dailyLogRetentionDays
    },
    directives: {
      enabled: adaptiveDirectives.enabled
    },
    initiative: {
      text: {
        enabled: textThoughtLoop.enabled,
        execution: {
          mode: "inherit_orchestrator"
        },
        eagerness: textThoughtLoop.eagerness,
        minMinutesBetweenThoughts: textThoughtLoop.minMinutesBetweenThoughts,
        maxThoughtsPerDay: textThoughtLoop.maxThoughtsPerDay,
        lookbackMessages: textThoughtLoop.lookbackMessages
      },
      voice: {
        enabled: voiceThoughtEngine.enabled,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: voiceThoughtEngine.provider,
            model: voiceThoughtEngine.model
          },
          temperature: voiceThoughtEngine.temperature
        },
        eagerness: voiceThoughtEngine.eagerness,
        minSilenceSeconds: voiceThoughtEngine.minSilenceSeconds,
        minSecondsBetweenThoughts: voiceThoughtEngine.minSecondsBetweenThoughts
      },
      discovery
    },
    voice: {
      enabled: voice.enabled,
      transcription: {
        enabled: voice.asrEnabled,
        languageMode: voice.asrLanguageMode,
        languageHint: voice.asrLanguageHint
      },
      channelPolicy: {
        allowedChannelIds: voice.allowedVoiceChannelIds,
        blockedChannelIds: voice.blockedVoiceChannelIds,
        blockedUserIds: voice.blockedVoiceUserIds
      },
      sessionLimits: {
        maxSessionMinutes: voice.maxSessionMinutes,
        inactivityLeaveSeconds: voice.inactivityLeaveSeconds,
        maxSessionsPerDay: voice.maxSessionsPerDay,
        maxConcurrentSessions: voice.maxConcurrentSessions
      },
      conversationPolicy: {
        replyEagerness: voice.replyEagerness,
        commandOnlyMode: voice.commandOnlyMode,
        allowNsfwHumor: voice.allowNsfwHumor,
        textOnlyMode: voice.textOnlyMode,
        replyPath: voice.replyPath,
        ttsMode: voice.ttsMode,
        operationalMessages: voice.operationalMessages
      },
      admission: {
        mode:
          voiceReplyDecisionLlm.enabled === false
            ? "generation_decides"
            : voiceReplyDecisionLlm.realtimeAdmissionMode,
        intentConfidenceThreshold: voice.intentConfidenceThreshold,
        musicWakeLatchSeconds: voiceReplyDecisionLlm.musicWakeLatchSeconds
      },
      streamWatch: voice.streamWatch,
      soundboard: voice.soundboard
    },
    media: {
      vision: {
        enabled: vision.captionEnabled,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: vision.provider,
            model: vision.model
          }
        },
        maxAutoIncludeImages: vision.maxAutoIncludeImages,
        maxCaptionsPerHour: vision.maxCaptionsPerHour
      },
      videoContext
    },
    music: {
      ducking: voice.musicDucking
    },
    automations: {
      enabled: automations.enabled
    }
  };

  return migrated;
}

export function normalizeSettings(raw: unknown) {
  const rawRecord = isRecord(raw) ? raw : {};
  const canonicalInput =
    isRecord(rawRecord.identity) || isRecord(rawRecord.agentStack)
      ? rawRecord
      : migrateLegacySettings(rawRecord);

  const merged = deepMerge(DEFAULT_SETTINGS, canonicalInput);

  const identity = isRecord(merged.identity) ? merged.identity : {};
  const persona = isRecord(merged.persona) ? merged.persona : {};
  const prompting = isRecord(merged.prompting) ? merged.prompting : {};
  const permissions = isRecord(merged.permissions) ? merged.permissions : {};
  const interaction = isRecord(merged.interaction) ? merged.interaction : {};
  const agentStack = isRecord(merged.agentStack) ? merged.agentStack : {};
  const memory = isRecord(merged.memory) ? merged.memory : {};
  const directives = isRecord(merged.directives) ? merged.directives : {};
  const initiative = isRecord(merged.initiative) ? merged.initiative : {};
  const voice = isRecord(merged.voice) ? merged.voice : {};
  const media = isRecord(merged.media) ? merged.media : {};
  const music = isRecord(merged.music) ? merged.music : {};
  const automations = isRecord(merged.automations) ? merged.automations : {};

  const presetRaw = normalizeString(agentStack.preset, DEFAULT_SETTINGS.agentStack.preset, 48);
  const preset = (
    presetRaw === "openai_native" ||
    presetRaw === "anthropic_brain_openai_tools" ||
    presetRaw === "claude_code_max" ||
    presetRaw === "multi_provider_legacy" ||
    presetRaw === "custom"
  )
    ? presetRaw
    : DEFAULT_SETTINGS.agentStack.preset;
  const presetOrchestratorFallback =
    preset === "anthropic_brain_openai_tools" || preset === "multi_provider_legacy"
      ? { provider: "anthropic", model: "claude-sonnet-4-6" }
      : preset === "claude_code_max"
        ? { provider: "claude_code_session", model: "max" }
        : { provider: "openai", model: "gpt-5" };
  const presetVoiceAdmissionClassifierFallback =
    preset === "claude_code_max"
      ? { provider: "claude_code_session", model: "max" }
      : { provider: "openai", model: "gpt-5-mini" };
  const orchestratorOverride = normalizeModelBinding(
    (agentStack.overrides as any)?.orchestrator,
    presetOrchestratorFallback.provider,
    presetOrchestratorFallback.model
  );

  const normalized = {
    identity: {
      botName: normalizeString(identity.botName, DEFAULT_SETTINGS.identity.botName, 50),
      botNameAliases: normalizeStringList(
        identity.botNameAliases,
        BOT_NAME_ALIAS_MAX_ITEMS,
        50,
        DEFAULT_SETTINGS.identity.botNameAliases
      )
    },
    persona: {
      flavor: normalizeString(persona.flavor, DEFAULT_SETTINGS.persona.flavor, PERSONA_FLAVOR_MAX_CHARS),
      hardLimits: normalizeStringList(persona.hardLimits, 40, 220, DEFAULT_SETTINGS.persona.hardLimits)
    },
    prompting: {
      global: {
        capabilityHonestyLine: normalizePromptLine(
          (prompting.global as any)?.capabilityHonestyLine,
          DEFAULT_SETTINGS.prompting.global.capabilityHonestyLine
        ),
        impossibleActionLine: normalizePromptLine(
          (prompting.global as any)?.impossibleActionLine,
          DEFAULT_SETTINGS.prompting.global.impossibleActionLine
        ),
        memoryEnabledLine: normalizePromptLine(
          (prompting.global as any)?.memoryEnabledLine,
          DEFAULT_SETTINGS.prompting.global.memoryEnabledLine
        ),
        memoryDisabledLine: normalizePromptLine(
          (prompting.global as any)?.memoryDisabledLine,
          DEFAULT_SETTINGS.prompting.global.memoryDisabledLine
        ),
        skipLine: normalizePromptLine(
          (prompting.global as any)?.skipLine,
          DEFAULT_SETTINGS.prompting.global.skipLine
        )
      },
      text: {
        guidance: normalizePromptLineList(
          (prompting.text as any)?.guidance,
          DEFAULT_SETTINGS.prompting.text.guidance
        )
      },
      voice: {
        guidance: normalizePromptLineList(
          (prompting.voice as any)?.guidance,
          DEFAULT_SETTINGS.prompting.voice.guidance
        ),
        operationalGuidance: normalizePromptLineList(
          (prompting.voice as any)?.operationalGuidance,
          DEFAULT_SETTINGS.prompting.voice.operationalGuidance
        ),
        lookupBusySystemPrompt: normalizePromptBlock(
          (prompting.voice as any)?.lookupBusySystemPrompt,
          DEFAULT_SETTINGS.prompting.voice.lookupBusySystemPrompt,
          4_000
        )
      },
      media: {
        promptCraftGuidance: normalizePromptBlock(
          (prompting.media as any)?.promptCraftGuidance,
          DEFAULT_SETTINGS.prompting.media.promptCraftGuidance,
          8_000
        )
      }
    },
    permissions: {
      replies: {
        allowReplies: normalizeBoolean((permissions.replies as any)?.allowReplies, DEFAULT_SETTINGS.permissions.replies.allowReplies),
        allowUnsolicitedReplies: normalizeBoolean(
          (permissions.replies as any)?.allowUnsolicitedReplies,
          DEFAULT_SETTINGS.permissions.replies.allowUnsolicitedReplies
        ),
        allowReactions: normalizeBoolean(
          (permissions.replies as any)?.allowReactions,
          DEFAULT_SETTINGS.permissions.replies.allowReactions
        ),
        replyChannelIds: normalizeStringList((permissions.replies as any)?.replyChannelIds, 200, 60),
        allowedChannelIds: normalizeStringList((permissions.replies as any)?.allowedChannelIds, 200, 60),
        blockedChannelIds: normalizeStringList((permissions.replies as any)?.blockedChannelIds, 200, 60),
        blockedUserIds: normalizeStringList((permissions.replies as any)?.blockedUserIds, 200, 60),
        maxMessagesPerHour: normalizeInt(
          (permissions.replies as any)?.maxMessagesPerHour,
          DEFAULT_SETTINGS.permissions.replies.maxMessagesPerHour,
          0,
          500
        ),
        maxReactionsPerHour: normalizeInt(
          (permissions.replies as any)?.maxReactionsPerHour,
          DEFAULT_SETTINGS.permissions.replies.maxReactionsPerHour,
          0,
          500
        )
      },
      devTasks: {
        allowedUserIds: normalizeStringList((permissions.devTasks as any)?.allowedUserIds, 200, 60)
      }
    },
    interaction: {
      activity: {
        replyEagerness: normalizeInt(
          (interaction.activity as any)?.replyEagerness,
          DEFAULT_SETTINGS.interaction.activity.replyEagerness,
          0,
          100
        ),
        reactionLevel: normalizeInt(
          (interaction.activity as any)?.reactionLevel,
          DEFAULT_SETTINGS.interaction.activity.reactionLevel,
          0,
          100
        ),
        minSecondsBetweenMessages: normalizeInt(
          (interaction.activity as any)?.minSecondsBetweenMessages,
          DEFAULT_SETTINGS.interaction.activity.minSecondsBetweenMessages,
          5,
          300
        ),
        replyCoalesceWindowSeconds: normalizeInt(
          (interaction.activity as any)?.replyCoalesceWindowSeconds,
          DEFAULT_SETTINGS.interaction.activity.replyCoalesceWindowSeconds,
          0,
          20
        ),
        replyCoalesceMaxMessages: normalizeInt(
          (interaction.activity as any)?.replyCoalesceMaxMessages,
          DEFAULT_SETTINGS.interaction.activity.replyCoalesceMaxMessages,
          1,
          20
        )
      },
      replyGeneration: {
        temperature: normalizeNumber(
          (interaction.replyGeneration as any)?.temperature,
          DEFAULT_SETTINGS.interaction.replyGeneration.temperature,
          0,
          2
        ),
        maxOutputTokens: normalizeInt(
          (interaction.replyGeneration as any)?.maxOutputTokens,
          DEFAULT_SETTINGS.interaction.replyGeneration.maxOutputTokens,
          32,
          16_384
        ),
        reasoningEffort:
          normalizeOpenAiReasoningEffort(
            (interaction.replyGeneration as any)?.reasoningEffort,
            DEFAULT_SETTINGS.interaction.replyGeneration.reasoningEffort
          ) || "",
        pricing:
          isRecord((interaction.replyGeneration as any)?.pricing)
            ? (interaction.replyGeneration as any).pricing
            : {}
      },
      followup: {
        enabled: normalizeBoolean(
          (interaction.followup as any)?.enabled,
          DEFAULT_SETTINGS.interaction.followup.enabled
        ),
        execution: normalizeExecutionPolicy(
          (interaction.followup as any)?.execution,
          orchestratorOverride.provider,
          orchestratorOverride.model
        ),
        toolBudget: {
          maxToolSteps: normalizeInt(
            (interaction.followup as any)?.toolBudget?.maxToolSteps,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.maxToolSteps,
            0,
            6
          ),
          maxTotalToolCalls: normalizeInt(
            (interaction.followup as any)?.toolBudget?.maxTotalToolCalls,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.maxTotalToolCalls,
            0,
            12
          ),
          maxWebSearchCalls: normalizeInt(
            (interaction.followup as any)?.toolBudget?.maxWebSearchCalls,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.maxWebSearchCalls,
            0,
            8
          ),
          maxMemoryLookupCalls: normalizeInt(
            (interaction.followup as any)?.toolBudget?.maxMemoryLookupCalls,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.maxMemoryLookupCalls,
            0,
            8
          ),
          maxImageLookupCalls: normalizeInt(
            (interaction.followup as any)?.toolBudget?.maxImageLookupCalls,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.maxImageLookupCalls,
            0,
            8
          ),
          toolTimeoutMs: normalizeInt(
            (interaction.followup as any)?.toolBudget?.toolTimeoutMs,
            DEFAULT_SETTINGS.interaction.followup.toolBudget.toolTimeoutMs,
            1_000,
            120_000
          )
        }
      },
      startup: {
        catchupEnabled: normalizeBoolean(
          (interaction.startup as any)?.catchupEnabled,
          DEFAULT_SETTINGS.interaction.startup.catchupEnabled
        ),
        catchupLookbackHours: normalizeInt(
          (interaction.startup as any)?.catchupLookbackHours,
          DEFAULT_SETTINGS.interaction.startup.catchupLookbackHours,
          1,
          168
        ),
        catchupMaxMessagesPerChannel: normalizeInt(
          (interaction.startup as any)?.catchupMaxMessagesPerChannel,
          DEFAULT_SETTINGS.interaction.startup.catchupMaxMessagesPerChannel,
          1,
          200
        ),
        maxCatchupRepliesPerChannel: normalizeInt(
          (interaction.startup as any)?.maxCatchupRepliesPerChannel,
          DEFAULT_SETTINGS.interaction.startup.maxCatchupRepliesPerChannel,
          0,
          20
        )
      },
      sessions: {
        sessionIdleTimeoutMs: normalizeInt(
          (interaction.sessions as any)?.sessionIdleTimeoutMs,
          DEFAULT_SETTINGS.interaction.sessions.sessionIdleTimeoutMs,
          10_000,
          1_800_000
        ),
        maxConcurrentSessions: normalizeInt(
          (interaction.sessions as any)?.maxConcurrentSessions,
          DEFAULT_SETTINGS.interaction.sessions.maxConcurrentSessions,
          1,
          100
        )
      }
    },
    agentStack: {
      preset,
      advancedOverridesEnabled: normalizeBoolean(
        agentStack.advancedOverridesEnabled,
        DEFAULT_SETTINGS.agentStack.advancedOverridesEnabled
      ),
      overrides: {
        ...(isRecord(agentStack.overrides) ? agentStack.overrides : {}),
        orchestrator: orchestratorOverride,
        ...(isRecord((agentStack.overrides as any)?.devTeam)
          ? {
              devTeam: {
                ...(agentStack.overrides as any).devTeam,
                orchestrator: normalizeModelBinding(
                  (agentStack.overrides as any)?.devTeam?.orchestrator,
                  presetOrchestratorFallback.provider,
                  presetOrchestratorFallback.model
                ),
                codingWorkers: normalizeStringList(
                  (agentStack.overrides as any)?.devTeam?.codingWorkers,
                  4,
                  40
                )
              }
            }
          : {}),
        voiceAdmissionClassifier: normalizeExecutionPolicy(
          (agentStack.overrides as any)?.voiceAdmissionClassifier,
          presetVoiceAdmissionClassifierFallback.provider,
          presetVoiceAdmissionClassifierFallback.model,
          { fallbackMode: "dedicated_model" }
        )
      },
      runtimeConfig: {
        research: {
          enabled: normalizeBoolean(
            (agentStack.runtimeConfig as any)?.research?.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.enabled
          ),
          maxSearchesPerHour: normalizeInt(
            (agentStack.runtimeConfig as any)?.research?.maxSearchesPerHour,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.research.maxSearchesPerHour,
            0,
            120
          ),
          openaiNativeWebSearch: {
            userLocation: normalizeString(
              (agentStack.runtimeConfig as any)?.research?.openaiNativeWebSearch?.userLocation,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.openaiNativeWebSearch.userLocation,
              120
            ),
            allowedDomains: normalizeStringList(
              (agentStack.runtimeConfig as any)?.research?.openaiNativeWebSearch?.allowedDomains,
              50,
              200
            )
          },
          localExternalSearch: {
            safeSearch: normalizeBoolean(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.safeSearch,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.safeSearch
            ),
            providerOrder: normalizeProviderOrder(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.providerOrder
            ),
            maxResults: normalizeInt(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.maxResults,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxResults,
              1,
              10
            ),
            maxPagesToRead: normalizeInt(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.maxPagesToRead,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxPagesToRead,
              0,
              5
            ),
            maxCharsPerPage: normalizeInt(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.maxCharsPerPage,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxCharsPerPage,
              350,
              24_000
            ),
            recencyDaysDefault: normalizeInt(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.recencyDaysDefault,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.recencyDaysDefault,
              1,
              3_650
            ),
            maxConcurrentFetches: normalizeInt(
              (agentStack.runtimeConfig as any)?.research?.localExternalSearch?.maxConcurrentFetches,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.research.localExternalSearch.maxConcurrentFetches,
              1,
              10
            )
          }
        },
        browser: {
          enabled: normalizeBoolean(
            (agentStack.runtimeConfig as any)?.browser?.enabled,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.enabled
          ),
          openaiComputerUse: {
            model: normalizeString(
              (agentStack.runtimeConfig as any)?.browser?.openaiComputerUse?.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.openaiComputerUse.model,
              120
            )
          },
          localBrowserAgent: {
            execution: normalizeBrowserExecutionPolicy(
              (agentStack.runtimeConfig as any)?.browser?.localBrowserAgent?.execution
            ),
            maxBrowseCallsPerHour: normalizeInt(
              (agentStack.runtimeConfig as any)?.browser?.localBrowserAgent?.maxBrowseCallsPerHour,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxBrowseCallsPerHour,
              0,
              60
            ),
            maxStepsPerTask: normalizeInt(
              (agentStack.runtimeConfig as any)?.browser?.localBrowserAgent?.maxStepsPerTask,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.maxStepsPerTask,
              1,
              30
            ),
            stepTimeoutMs: normalizeInt(
              (agentStack.runtimeConfig as any)?.browser?.localBrowserAgent?.stepTimeoutMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.stepTimeoutMs,
              5_000,
              120_000
            ),
            sessionTimeoutMs: normalizeInt(
              (agentStack.runtimeConfig as any)?.browser?.localBrowserAgent?.sessionTimeoutMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.browser.localBrowserAgent.sessionTimeoutMs,
              10_000,
              1_800_000
            )
          }
        },
        voice: {
          openaiRealtime: {
            model: normalizeString(
              (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.model,
              120
            ),
            voice: normalizeString(
              (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.voice,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.voice,
              120
            ),
            inputAudioFormat: normalizeString(
              normalizeOpenAiRealtimeAudioFormat(
                (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.inputAudioFormat,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat
              ),
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.inputAudioFormat,
              120
            ),
            outputAudioFormat: normalizeString(
              normalizeOpenAiRealtimeAudioFormat(
                (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.outputAudioFormat,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat
              ),
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.outputAudioFormat,
              120
            ),
            transcriptionMethod: normalizeOpenAiRealtimeTranscriptionMethod(
              (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.transcriptionMethod,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.transcriptionMethod
            ),
            inputTranscriptionModel: normalizeOpenAiRealtimeTranscriptionModel(
              (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.inputTranscriptionModel,
              OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
            ),
            usePerUserAsrBridge: normalizeBoolean(
              (agentStack.runtimeConfig as any)?.voice?.openaiRealtime?.usePerUserAsrBridge,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.openaiRealtime.usePerUserAsrBridge
            )
          },
          legacyVoiceStack: {
            selectedProvider: normalizeVoiceProvider(
              (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.selectedProvider,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.selectedProvider as any
            ),
            xai: {
              voice: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.xai?.voice,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.xai.voice,
                120
              ),
              audioFormat: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.xai?.audioFormat,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.xai.audioFormat,
                120
              ),
              sampleRateHz: normalizeInt(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.xai?.sampleRateHz,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.xai.sampleRateHz,
                8_000,
                96_000
              ),
              region: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.xai?.region,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.xai.region,
                120
              )
            },
            elevenLabsRealtime: {
              agentId: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.elevenLabsRealtime?.agentId,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.elevenLabsRealtime.agentId,
                200
              ),
              voiceId: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.elevenLabsRealtime?.voiceId,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.elevenLabsRealtime.voiceId,
                200
              ),
              apiBaseUrl: normalizeHttpBaseUrl(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.elevenLabsRealtime?.apiBaseUrl,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.elevenLabsRealtime.apiBaseUrl
              ),
              inputSampleRateHz: normalizeInt(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.elevenLabsRealtime?.inputSampleRateHz,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.elevenLabsRealtime.inputSampleRateHz,
                8_000,
                96_000
              ),
              outputSampleRateHz: normalizeInt(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.elevenLabsRealtime?.outputSampleRateHz,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.elevenLabsRealtime.outputSampleRateHz,
                8_000,
                96_000
              )
            },
            geminiRealtime: {
              model: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.geminiRealtime?.model,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.geminiRealtime.model,
                120
              ),
              voice: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.geminiRealtime?.voice,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.geminiRealtime.voice,
                120
              ),
              apiBaseUrl: normalizeHttpBaseUrl(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.geminiRealtime?.apiBaseUrl,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.geminiRealtime.apiBaseUrl
              ),
              inputSampleRateHz: normalizeInt(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.geminiRealtime?.inputSampleRateHz,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.geminiRealtime.inputSampleRateHz,
                8_000,
                96_000
              ),
              outputSampleRateHz: normalizeInt(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.geminiRealtime?.outputSampleRateHz,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.geminiRealtime.outputSampleRateHz,
                8_000,
                96_000
              )
            },
            sttPipeline: {
              transcriptionModel: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.sttPipeline?.transcriptionModel,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.sttPipeline.transcriptionModel,
                120
              ),
              ttsModel: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.sttPipeline?.ttsModel,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.sttPipeline.ttsModel,
                120
              ),
              ttsVoice: normalizeString(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.sttPipeline?.ttsVoice,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.sttPipeline.ttsVoice,
                120
              ),
              ttsSpeed: normalizeNumber(
                (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.sttPipeline?.ttsSpeed,
                DEFAULT_SETTINGS.agentStack.runtimeConfig.voice.legacyVoiceStack.sttPipeline.ttsSpeed,
                0.25,
                4
              )
            },
            generation: normalizeExecutionPolicy(
              (agentStack.runtimeConfig as any)?.voice?.legacyVoiceStack?.generation,
              "anthropic",
              "claude-sonnet-4-6"
            )
          }
        },
        claudeCodeSession: {
          sessionScope: normalizeClaudeCodeSessionScope(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.sessionScope,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.sessionScope
          ),
          inactivityTimeoutMs: normalizeInt(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.inactivityTimeoutMs,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.inactivityTimeoutMs,
            10_000,
            12 * 60 * 60 * 1000
          ),
          contextPruningStrategy: normalizeClaudeCodeContextPruningStrategy(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.contextPruningStrategy,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.contextPruningStrategy
          ),
          maxPinnedStateChars: normalizeInt(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.maxPinnedStateChars,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.maxPinnedStateChars,
            0,
            200_000
          ),
          voiceToolPolicy: normalizeAgentSessionToolPolicy(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.voiceToolPolicy,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.voiceToolPolicy
          ),
          textToolPolicy: normalizeAgentSessionToolPolicy(
            (agentStack.runtimeConfig as any)?.claudeCodeSession?.textToolPolicy,
            DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession.textToolPolicy
          )
        },
        devTeam: {
          codex: {
            enabled: normalizeBoolean(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.enabled,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.enabled
            ),
            model:
              normalizeString(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
              120
              ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.model,
            maxTurns: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.maxTurns,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTurns,
              1,
              200
            ),
            timeoutMs: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.timeoutMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.timeoutMs,
              10_000,
              1_800_000
            ),
            maxBufferBytes: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.maxBufferBytes,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxBufferBytes,
              4_096,
              10 * 1024 * 1024
            ),
            defaultCwd: normalizeString(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.defaultCwd,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.defaultCwd,
              400
            ),
            maxTasksPerHour: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.maxTasksPerHour,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxTasksPerHour,
              0,
              200
            ),
            maxParallelTasks: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.codex?.maxParallelTasks,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.codex.maxParallelTasks,
              1,
              20
            )
          },
          claudeCode: {
            enabled: normalizeBoolean(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.enabled,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.enabled
            ),
            model:
              normalizeString(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.model,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
              120
              ) || DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.model,
            maxTurns: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.maxTurns,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTurns,
              1,
              200
            ),
            timeoutMs: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.timeoutMs,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.timeoutMs,
              10_000,
              1_800_000
            ),
            maxBufferBytes: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.maxBufferBytes,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxBufferBytes,
              4_096,
              10 * 1024 * 1024
            ),
            defaultCwd: normalizeString(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.defaultCwd,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.defaultCwd,
              400
            ),
            maxTasksPerHour: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.maxTasksPerHour,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxTasksPerHour,
              0,
              200
            ),
            maxParallelTasks: normalizeInt(
              (agentStack.runtimeConfig as any)?.devTeam?.claudeCode?.maxParallelTasks,
              DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam.claudeCode.maxParallelTasks,
              1,
              20
            )
          }
        }
      }
    },
    memory: {
      enabled: normalizeBoolean(memory.enabled, DEFAULT_SETTINGS.memory.enabled),
      promptSlice: {
        maxRecentMessages: normalizeInt(
          (memory.promptSlice as any)?.maxRecentMessages,
          DEFAULT_SETTINGS.memory.promptSlice.maxRecentMessages,
          4,
          120
        ),
        maxHighlights: normalizeInt(
          (memory.promptSlice as any)?.maxHighlights,
          DEFAULT_SETTINGS.memory.promptSlice.maxHighlights,
          1,
          40
        )
      },
      execution: normalizeExecutionPolicy(memory.execution, "anthropic", "claude-haiku-4-5", {
        fallbackMode: "dedicated_model",
        fallbackTemperature: 0,
        fallbackMaxOutputTokens: 320
      }),
      extraction: {
        enabled: normalizeBoolean(
          (memory.extraction as any)?.enabled,
          DEFAULT_SETTINGS.memory.extraction.enabled
        )
      },
      embeddingModel: normalizeString(memory.embeddingModel, DEFAULT_SETTINGS.memory.embeddingModel, 120),
      reflection: {
        enabled: normalizeBoolean(
          (memory.reflection as any)?.enabled,
          DEFAULT_SETTINGS.memory.reflection.enabled
        ),
        strategy: normalizeReflectionStrategy(
          (memory.reflection as any)?.strategy,
          DEFAULT_SETTINGS.memory.reflection.strategy
        ),
        hour: normalizeInt(
          (memory.reflection as any)?.hour,
          DEFAULT_SETTINGS.memory.reflection.hour,
          0,
          23
        ),
        minute: normalizeInt(
          (memory.reflection as any)?.minute,
          DEFAULT_SETTINGS.memory.reflection.minute,
          0,
          59
        ),
        maxFactsPerReflection: normalizeInt(
          (memory.reflection as any)?.maxFactsPerReflection,
          DEFAULT_SETTINGS.memory.reflection.maxFactsPerReflection,
          1,
          100
        )
      },
      dailyLogRetentionDays: normalizeInt(
        memory.dailyLogRetentionDays,
        DEFAULT_SETTINGS.memory.dailyLogRetentionDays,
        1,
        365
      )
    },
    directives: {
      enabled: normalizeBoolean(directives.enabled, DEFAULT_SETTINGS.directives.enabled)
    },
    initiative: {
      text: {
        enabled: normalizeBoolean(
          (initiative.text as any)?.enabled,
          DEFAULT_SETTINGS.initiative.text.enabled
        ),
        execution: normalizeExecutionPolicy(
          (initiative.text as any)?.execution,
          "openai",
          "gpt-5"
        ),
        eagerness: normalizeInt(
          (initiative.text as any)?.eagerness,
          DEFAULT_SETTINGS.initiative.text.eagerness,
          0,
          100
        ),
        minMinutesBetweenThoughts: normalizeInt(
          (initiative.text as any)?.minMinutesBetweenThoughts,
          DEFAULT_SETTINGS.initiative.text.minMinutesBetweenThoughts,
          5,
          24 * 60
        ),
        maxThoughtsPerDay: normalizeInt(
          (initiative.text as any)?.maxThoughtsPerDay,
          DEFAULT_SETTINGS.initiative.text.maxThoughtsPerDay,
          0,
          100
        ),
        lookbackMessages: normalizeInt(
          (initiative.text as any)?.lookbackMessages,
          DEFAULT_SETTINGS.initiative.text.lookbackMessages,
          4,
          80
        )
      },
      voice: {
        enabled: normalizeBoolean(
          (initiative.voice as any)?.enabled,
          DEFAULT_SETTINGS.initiative.voice.enabled
        ),
        execution: normalizeExecutionPolicy(
          (initiative.voice as any)?.execution,
          "anthropic",
          "claude-sonnet-4-6",
          { fallbackMode: "dedicated_model", fallbackTemperature: 1.2 }
        ),
        eagerness: normalizeInt(
          (initiative.voice as any)?.eagerness,
          DEFAULT_SETTINGS.initiative.voice.eagerness,
          0,
          100
        ),
        minSilenceSeconds: normalizeInt(
          (initiative.voice as any)?.minSilenceSeconds,
          DEFAULT_SETTINGS.initiative.voice.minSilenceSeconds,
          1,
          300
        ),
        minSecondsBetweenThoughts: normalizeInt(
          (initiative.voice as any)?.minSecondsBetweenThoughts,
          DEFAULT_SETTINGS.initiative.voice.minSecondsBetweenThoughts,
          1,
          600
        )
      },
      discovery: {
        enabled: normalizeBoolean(
          (initiative.discovery as any)?.enabled,
          DEFAULT_SETTINGS.initiative.discovery.enabled
        ),
        channelIds: normalizeStringList((initiative.discovery as any)?.channelIds, 200, 60),
        maxPostsPerDay: normalizeInt(
          (initiative.discovery as any)?.maxPostsPerDay,
          DEFAULT_SETTINGS.initiative.discovery.maxPostsPerDay,
          0,
          50
        ),
        minMinutesBetweenPosts: normalizeInt(
          (initiative.discovery as any)?.minMinutesBetweenPosts,
          DEFAULT_SETTINGS.initiative.discovery.minMinutesBetweenPosts,
          1,
          24 * 60
        ),
        pacingMode:
          normalizeString(
            (initiative.discovery as any)?.pacingMode,
            DEFAULT_SETTINGS.initiative.discovery.pacingMode,
            40
          ).toLowerCase() === "spontaneous"
            ? "spontaneous"
            : "even",
        spontaneity: normalizeInt(
          (initiative.discovery as any)?.spontaneity,
          DEFAULT_SETTINGS.initiative.discovery.spontaneity,
          0,
          100
        ),
        postOnStartup: normalizeBoolean(
          (initiative.discovery as any)?.postOnStartup,
          DEFAULT_SETTINGS.initiative.discovery.postOnStartup
        ),
        allowImagePosts: normalizeBoolean(
          (initiative.discovery as any)?.allowImagePosts,
          DEFAULT_SETTINGS.initiative.discovery.allowImagePosts
        ),
        allowVideoPosts: normalizeBoolean(
          (initiative.discovery as any)?.allowVideoPosts,
          DEFAULT_SETTINGS.initiative.discovery.allowVideoPosts
        ),
        allowReplyImages: normalizeBoolean(
          (initiative.discovery as any)?.allowReplyImages,
          DEFAULT_SETTINGS.initiative.discovery.allowReplyImages
        ),
        allowReplyVideos: normalizeBoolean(
          (initiative.discovery as any)?.allowReplyVideos,
          DEFAULT_SETTINGS.initiative.discovery.allowReplyVideos
        ),
        allowReplyGifs: normalizeBoolean(
          (initiative.discovery as any)?.allowReplyGifs,
          DEFAULT_SETTINGS.initiative.discovery.allowReplyGifs
        ),
        maxImagesPerDay: normalizeInt(
          (initiative.discovery as any)?.maxImagesPerDay,
          DEFAULT_SETTINGS.initiative.discovery.maxImagesPerDay,
          0,
          200
        ),
        maxVideosPerDay: normalizeInt(
          (initiative.discovery as any)?.maxVideosPerDay,
          DEFAULT_SETTINGS.initiative.discovery.maxVideosPerDay,
          0,
          120
        ),
        maxGifsPerDay: normalizeInt(
          (initiative.discovery as any)?.maxGifsPerDay,
          DEFAULT_SETTINGS.initiative.discovery.maxGifsPerDay,
          0,
          300
        ),
        simpleImageModel: normalizeString(
          (initiative.discovery as any)?.simpleImageModel,
          DEFAULT_SETTINGS.initiative.discovery.simpleImageModel,
          120
        ),
        complexImageModel: normalizeString(
          (initiative.discovery as any)?.complexImageModel,
          DEFAULT_SETTINGS.initiative.discovery.complexImageModel,
          120
        ),
        videoModel: normalizeString(
          (initiative.discovery as any)?.videoModel,
          DEFAULT_SETTINGS.initiative.discovery.videoModel,
          120
        ),
        allowedImageModels: normalizeStringList(
          (initiative.discovery as any)?.allowedImageModels,
          20,
          120,
          DEFAULT_SETTINGS.initiative.discovery.allowedImageModels as unknown as string[]
        ),
        allowedVideoModels: normalizeStringList(
          (initiative.discovery as any)?.allowedVideoModels,
          20,
          120,
          DEFAULT_SETTINGS.initiative.discovery.allowedVideoModels as unknown as string[]
        ),
        maxMediaPromptChars: normalizeInt(
          (initiative.discovery as any)?.maxMediaPromptChars,
          DEFAULT_SETTINGS.initiative.discovery.maxMediaPromptChars,
          100,
          2_000
        ),
        linkChancePercent: normalizeInt(
          (initiative.discovery as any)?.linkChancePercent,
          DEFAULT_SETTINGS.initiative.discovery.linkChancePercent,
          0,
          100
        ),
        maxLinksPerPost: normalizeInt(
          (initiative.discovery as any)?.maxLinksPerPost,
          DEFAULT_SETTINGS.initiative.discovery.maxLinksPerPost,
          0,
          5
        ),
        maxCandidatesForPrompt: normalizeInt(
          (initiative.discovery as any)?.maxCandidatesForPrompt,
          DEFAULT_SETTINGS.initiative.discovery.maxCandidatesForPrompt,
          1,
          20
        ),
        freshnessHours: normalizeInt(
          (initiative.discovery as any)?.freshnessHours,
          DEFAULT_SETTINGS.initiative.discovery.freshnessHours,
          1,
          24 * 30
        ),
        dedupeHours: normalizeInt(
          (initiative.discovery as any)?.dedupeHours,
          DEFAULT_SETTINGS.initiative.discovery.dedupeHours,
          1,
          24 * 90
        ),
        randomness: normalizeInt(
          (initiative.discovery as any)?.randomness,
          DEFAULT_SETTINGS.initiative.discovery.randomness,
          0,
          100
        ),
        sourceFetchLimit: normalizeInt(
          (initiative.discovery as any)?.sourceFetchLimit,
          DEFAULT_SETTINGS.initiative.discovery.sourceFetchLimit,
          1,
          50
        ),
        allowNsfw: normalizeBoolean(
          (initiative.discovery as any)?.allowNsfw,
          DEFAULT_SETTINGS.initiative.discovery.allowNsfw
        ),
        preferredTopics: normalizeStringList((initiative.discovery as any)?.preferredTopics, 50, 120),
        redditSubreddits: normalizeSubreddits(
          (initiative.discovery as any)?.redditSubreddits,
          DEFAULT_SETTINGS.initiative.discovery.redditSubreddits as unknown as string[]
        ),
        youtubeChannelIds: normalizeStringList((initiative.discovery as any)?.youtubeChannelIds, 50, 120),
        rssFeeds: normalizeDiscoveryRssFeeds(
          (initiative.discovery as any)?.rssFeeds,
          DEFAULT_SETTINGS.initiative.discovery.rssFeeds as unknown as string[]
        ),
        xHandles: normalizeXHandles((initiative.discovery as any)?.xHandles),
        xNitterBaseUrl: normalizeHttpBaseUrl(
          (initiative.discovery as any)?.xNitterBaseUrl,
          DEFAULT_SETTINGS.initiative.discovery.xNitterBaseUrl
        ),
        sources: normalizeDiscoverySourceMap((initiative.discovery as any)?.sources)
      }
    },
    voice: {
      enabled: normalizeBoolean(voice.enabled, DEFAULT_SETTINGS.voice.enabled),
      transcription: {
        enabled: normalizeBoolean(
          (voice.transcription as any)?.enabled,
          DEFAULT_SETTINGS.voice.transcription.enabled
        ),
        languageMode:
          normalizeString(
            (voice.transcription as any)?.languageMode,
            DEFAULT_SETTINGS.voice.transcription.languageMode,
            40
          ).toLowerCase() === "fixed"
            ? "fixed"
            : "auto",
        languageHint: normalizeLanguageHint(
          (voice.transcription as any)?.languageHint,
          DEFAULT_SETTINGS.voice.transcription.languageHint
        )
      },
      channelPolicy: {
        allowedChannelIds: normalizeStringList((voice.channelPolicy as any)?.allowedChannelIds, 200, 60),
        blockedChannelIds: normalizeStringList((voice.channelPolicy as any)?.blockedChannelIds, 200, 60),
        blockedUserIds: normalizeStringList((voice.channelPolicy as any)?.blockedUserIds, 200, 60)
      },
      sessionLimits: {
        maxSessionMinutes: normalizeInt(
          (voice.sessionLimits as any)?.maxSessionMinutes,
          DEFAULT_SETTINGS.voice.sessionLimits.maxSessionMinutes,
          1,
          240
        ),
        inactivityLeaveSeconds: normalizeInt(
          (voice.sessionLimits as any)?.inactivityLeaveSeconds,
          DEFAULT_SETTINGS.voice.sessionLimits.inactivityLeaveSeconds,
          15,
          3_600
        ),
        maxSessionsPerDay: normalizeInt(
          (voice.sessionLimits as any)?.maxSessionsPerDay,
          DEFAULT_SETTINGS.voice.sessionLimits.maxSessionsPerDay,
          0,
          240
        ),
        maxConcurrentSessions: normalizeInt(
          (voice.sessionLimits as any)?.maxConcurrentSessions,
          DEFAULT_SETTINGS.voice.sessionLimits.maxConcurrentSessions,
          1,
          3
        )
      },
      conversationPolicy: {
        replyEagerness: normalizeInt(
          (voice.conversationPolicy as any)?.replyEagerness,
          DEFAULT_SETTINGS.voice.conversationPolicy.replyEagerness,
          0,
          100
        ),
        commandOnlyMode: normalizeBoolean(
          (voice.conversationPolicy as any)?.commandOnlyMode,
          DEFAULT_SETTINGS.voice.conversationPolicy.commandOnlyMode
        ),
        allowNsfwHumor: normalizeBoolean(
          (voice.conversationPolicy as any)?.allowNsfwHumor,
          DEFAULT_SETTINGS.voice.conversationPolicy.allowNsfwHumor
        ),
        textOnlyMode: normalizeBoolean(
          (voice.conversationPolicy as any)?.textOnlyMode,
          DEFAULT_SETTINGS.voice.conversationPolicy.textOnlyMode
        ),
        replyPath: normalizeReplyPath(
          (voice.conversationPolicy as any)?.replyPath,
          DEFAULT_SETTINGS.voice.conversationPolicy.replyPath
        ),
        ttsMode:
          normalizeString(
            (voice.conversationPolicy as any)?.ttsMode,
            DEFAULT_SETTINGS.voice.conversationPolicy.ttsMode,
            20
          ).toLowerCase() === "api"
            ? "api"
            : "realtime",
        operationalMessages: normalizeOperationalMessages(
          (voice.conversationPolicy as any)?.operationalMessages,
          DEFAULT_SETTINGS.voice.conversationPolicy.operationalMessages
        )
      },
      admission: {
        mode: normalizeVoiceAdmissionMode(
          (voice.admission as any)?.mode,
          DEFAULT_SETTINGS.voice.admission.mode
        ),
        wakeSignals: normalizeStringList(
          (voice.admission as any)?.wakeSignals,
          10,
          40,
          DEFAULT_SETTINGS.voice.admission.wakeSignals as unknown as string[]
        ),
        intentConfidenceThreshold: normalizeNumber(
          (voice.admission as any)?.intentConfidenceThreshold,
          DEFAULT_SETTINGS.voice.admission.intentConfidenceThreshold,
          0,
          1
        ),
        musicWakeLatchSeconds: normalizeInt(
          (voice.admission as any)?.musicWakeLatchSeconds,
          DEFAULT_SETTINGS.voice.admission.musicWakeLatchSeconds,
          0,
          120
        )
      },
      streamWatch: {
        enabled: normalizeBoolean(
          (voice.streamWatch as any)?.enabled,
          DEFAULT_SETTINGS.voice.streamWatch.enabled
        ),
        minCommentaryIntervalSeconds: normalizeInt(
          (voice.streamWatch as any)?.minCommentaryIntervalSeconds,
          DEFAULT_SETTINGS.voice.streamWatch.minCommentaryIntervalSeconds,
          3,
          120
        ),
        maxFramesPerMinute: normalizeInt(
          (voice.streamWatch as any)?.maxFramesPerMinute,
          DEFAULT_SETTINGS.voice.streamWatch.maxFramesPerMinute,
          6,
          600
        ),
        maxFrameBytes: normalizeInt(
          (voice.streamWatch as any)?.maxFrameBytes,
          DEFAULT_SETTINGS.voice.streamWatch.maxFrameBytes,
          50_000,
          4_000_000
        ),
        commentaryPath: normalizeStreamWatchCommentaryPath(
          (voice.streamWatch as any)?.commentaryPath,
          DEFAULT_SETTINGS.voice.streamWatch.commentaryPath
        ),
        keyframeIntervalMs: normalizeInt(
          (voice.streamWatch as any)?.keyframeIntervalMs,
          DEFAULT_SETTINGS.voice.streamWatch.keyframeIntervalMs,
          250,
          10_000
        ),
        autonomousCommentaryEnabled: normalizeBoolean(
          (voice.streamWatch as any)?.autonomousCommentaryEnabled,
          DEFAULT_SETTINGS.voice.streamWatch.autonomousCommentaryEnabled
        ),
        brainContextEnabled: normalizeBoolean(
          (voice.streamWatch as any)?.brainContextEnabled,
          DEFAULT_SETTINGS.voice.streamWatch.brainContextEnabled
        ),
        brainContextMinIntervalSeconds: normalizeInt(
          (voice.streamWatch as any)?.brainContextMinIntervalSeconds,
          DEFAULT_SETTINGS.voice.streamWatch.brainContextMinIntervalSeconds,
          1,
          60
        ),
        brainContextMaxEntries: normalizeInt(
          (voice.streamWatch as any)?.brainContextMaxEntries,
          DEFAULT_SETTINGS.voice.streamWatch.brainContextMaxEntries,
          1,
          24
        ),
        brainContextPrompt: normalizePromptBlock(
          (voice.streamWatch as any)?.brainContextPrompt,
          DEFAULT_SETTINGS.voice.streamWatch.brainContextPrompt,
          420
        ),
        sharePageMaxWidthPx: normalizeInt(
          (voice.streamWatch as any)?.sharePageMaxWidthPx,
          DEFAULT_SETTINGS.voice.streamWatch.sharePageMaxWidthPx,
          320,
          1_920
        ),
        sharePageJpegQuality: normalizeNumber(
          (voice.streamWatch as any)?.sharePageJpegQuality,
          DEFAULT_SETTINGS.voice.streamWatch.sharePageJpegQuality,
          0.1,
          1
        )
      },
      soundboard: {
        enabled: normalizeBoolean(
          (voice.soundboard as any)?.enabled,
          DEFAULT_SETTINGS.voice.soundboard.enabled
        ),
        allowExternalSounds: normalizeBoolean(
          (voice.soundboard as any)?.allowExternalSounds,
          DEFAULT_SETTINGS.voice.soundboard.allowExternalSounds
        ),
        preferredSoundIds: normalizeStringList((voice.soundboard as any)?.preferredSoundIds, 100, 160)
      }
    },
    media: {
      vision: {
        enabled: normalizeBoolean(
          (media.vision as any)?.enabled,
          DEFAULT_SETTINGS.media.vision.enabled
        ),
        execution: normalizeExecutionPolicy(
          (media.vision as any)?.execution,
          "anthropic",
          "claude-haiku-4-5",
          { fallbackMode: "dedicated_model" }
        ),
        maxAutoIncludeImages: normalizeInt(
          (media.vision as any)?.maxAutoIncludeImages,
          DEFAULT_SETTINGS.media.vision.maxAutoIncludeImages,
          0,
          10
        ),
        maxCaptionsPerHour: normalizeInt(
          (media.vision as any)?.maxCaptionsPerHour,
          DEFAULT_SETTINGS.media.vision.maxCaptionsPerHour,
          0,
          500
        )
      },
      videoContext: {
        enabled: normalizeBoolean(
          (media.videoContext as any)?.enabled,
          DEFAULT_SETTINGS.media.videoContext.enabled
        ),
        execution: normalizeExecutionPolicy(
          (media.videoContext as any)?.execution,
          "openai",
          "gpt-5"
        ),
        maxLookupsPerHour: normalizeInt(
          (media.videoContext as any)?.maxLookupsPerHour,
          DEFAULT_SETTINGS.media.videoContext.maxLookupsPerHour,
          0,
          200
        ),
        maxVideosPerMessage: normalizeInt(
          (media.videoContext as any)?.maxVideosPerMessage,
          DEFAULT_SETTINGS.media.videoContext.maxVideosPerMessage,
          0,
          6
        ),
        maxTranscriptChars: normalizeInt(
          (media.videoContext as any)?.maxTranscriptChars,
          DEFAULT_SETTINGS.media.videoContext.maxTranscriptChars,
          200,
          4_000
        ),
        keyframeIntervalSeconds: normalizeInt(
          (media.videoContext as any)?.keyframeIntervalSeconds,
          DEFAULT_SETTINGS.media.videoContext.keyframeIntervalSeconds,
          0,
          120
        ),
        maxKeyframesPerVideo: normalizeInt(
          (media.videoContext as any)?.maxKeyframesPerVideo,
          DEFAULT_SETTINGS.media.videoContext.maxKeyframesPerVideo,
          0,
          8
        ),
        allowAsrFallback: normalizeBoolean(
          (media.videoContext as any)?.allowAsrFallback,
          DEFAULT_SETTINGS.media.videoContext.allowAsrFallback
        ),
        maxAsrSeconds: normalizeInt(
          (media.videoContext as any)?.maxAsrSeconds,
          DEFAULT_SETTINGS.media.videoContext.maxAsrSeconds,
          15,
          600
        )
      }
    },
    music: {
      ducking: {
        targetGain: normalizeNumber(
          (music.ducking as any)?.targetGain,
          DEFAULT_SETTINGS.music.ducking.targetGain,
          0,
          1
        ),
        fadeMs: normalizeInt(
          (music.ducking as any)?.fadeMs,
          DEFAULT_SETTINGS.music.ducking.fadeMs,
          0,
          10_000
        )
      }
    },
    automations: {
      enabled: normalizeBoolean(automations.enabled, DEFAULT_SETTINGS.automations.enabled)
    }
  };

  return normalized;
}
