import { type SettingsInput } from "./settings/settingsSchema.ts";
import { normalizeLlmProvider } from "./llm/llmHelpers.ts";
import { normalizeSettings } from "./store/settingsNormalization.ts";
import { deepMerge } from "./utils.ts";
import { normalizeVoiceProvider } from "./voice/voiceModes.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inferLegacyPreset(raw: Record<string, unknown>) {
  const llmProvider = normalizeLlmProvider(raw?.llm && isRecord(raw.llm) ? raw.llm.provider : undefined, "anthropic");
  const legacyVoiceProvider = normalizeVoiceProvider(
    raw?.voice && isRecord(raw.voice) ? raw.voice.voiceProvider : undefined,
    "openai"
  );
  if (llmProvider === "openai" && legacyVoiceProvider === "openai") {
    return "openai_native_realtime";
  }
  return "claude_api";
}

export function normalizeLegacyTestSettingsInput(overrides: unknown): Record<string, unknown> {
  const raw = isRecord(overrides) ? overrides : {};

  const prompt = isRecord(raw.prompt) ? raw.prompt : {};
  const activity = isRecord(raw.activity) ? raw.activity : {};
  const llm = isRecord(raw.llm) ? raw.llm : {};
  const replyFollowupLlm = isRecord(raw.replyFollowupLlm) ? raw.replyFollowupLlm : {};
  const memoryLlm = isRecord(raw.memoryLlm) ? raw.memoryLlm : {};
  const webSearch = isRecord(raw.webSearch) ? raw.webSearch : {};
  const browser = isRecord(raw.browser) ? raw.browser : {};
  const voice = isRecord(raw.voice) ? raw.voice : {};
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  const initiative = isRecord(raw.initiative) ? raw.initiative : {};
  const initiativeText = isRecord(initiative.text) ? initiative.text : {};
  const initiativeVoice = isRecord(initiative.voice) ? initiative.voice : {};
  const initiativeVoiceExecution = isRecord(initiativeVoice.execution) ? initiativeVoice.execution : {};
  const initiativeVoiceExecutionModel = isRecord(initiativeVoiceExecution.model)
    ? initiativeVoiceExecution.model
    : {};
  const discovery = isRecord(initiative.discovery) ? initiative.discovery : {};
  const startup = isRecord(raw.startup) ? raw.startup : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const reflection = isRecord(memory.reflection) ? memory.reflection : {};
  const codeAgent = isRecord(raw.codeAgent) ? raw.codeAgent : {};
  const automations = isRecord(raw.automations) ? raw.automations : {};
  const subAgentOrchestration = isRecord(raw.subAgentOrchestration) ? raw.subAgentOrchestration : {};
  const voiceGenerationLlm = isRecord(voice.generationLlm) ? voice.generationLlm : {};
  const voiceReplyDecisionLlm = isRecord(voice.replyDecisionLlm) ? voice.replyDecisionLlm : {};
  const vision = isRecord(raw.vision) ? raw.vision : {};
  const videoContext = isRecord(raw.videoContext) ? raw.videoContext : {};
  const legacyVoiceProvider = normalizeVoiceProvider(voice.voiceProvider, "openai");
  const legacyVoiceRuntimeOverride =
    typeof voice.mode === "string"
      ? String(voice.mode).trim().toLowerCase()
      : typeof voice.voiceProvider === "string" && legacyVoiceProvider === "xai"
        ? "voice_agent"
        : typeof voice.voiceProvider === "string" && legacyVoiceProvider === "gemini"
          ? "gemini_realtime"
          : typeof voice.voiceProvider === "string" && legacyVoiceProvider === "elevenlabs"
            ? "elevenlabs_realtime"
            : undefined;

  const normalizedLegacy = {
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
        operationalGuidance: prompt.voiceOperationalGuidance
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
        ambientReplyEagerness: activity.ambientReplyEagerness,
        responseWindowEagerness: activity.responseWindowEagerness,
        reactivity: activity.reactivity,
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
    memoryLlm: {
      provider: memoryLlm.provider,
      model: memoryLlm.model
    },
    agentStack: {
      preset: inferLegacyPreset(raw),
      advancedOverridesEnabled: true,
      overrides: {
        orchestrator: {
          provider: llm.provider,
          model: llm.model
        },
        ...(legacyVoiceRuntimeOverride
          ? {
              voiceRuntime: legacyVoiceRuntimeOverride
            }
          : {}),
        devTeam: {
          codingWorkers:
            String(codeAgent.provider || "").trim().toLowerCase() === "codex-cli"
                ? ["codex_cli"]
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
          headed: browser.headed,
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
          ...(legacyVoiceRuntimeOverride
            ? {
                runtimeMode: legacyVoiceRuntimeOverride
              }
            : {}),
          openaiRealtime: voice.openaiRealtime,
          xai: voice.xai,
          elevenLabsRealtime: voice.elevenLabsRealtime,
          geminiRealtime: voice.geminiRealtime,
          openaiAudioApi: voice.openaiAudioApi,
          generation: voiceGenerationLlm.useTextModel
            ? { mode: "inherit_orchestrator" }
            : {
                mode: "dedicated_model",
                model: {
                  provider: voiceGenerationLlm.provider,
                  model: voiceGenerationLlm.model
                }
              }
        },
        devTeam: {
          codexCli: {
            enabled:
              String(codeAgent.provider || "").trim().toLowerCase() === "codex-cli" ||
              String(codeAgent.provider || "").trim().toLowerCase() === "auto",
            model: codeAgent.codexCliModel,
            maxTurns: codeAgent.maxTurns,
            timeoutMs: codeAgent.timeoutMs,
            maxBufferBytes: codeAgent.maxBufferBytes,
            defaultCwd: codeAgent.defaultCwd,
            maxTasksPerHour: codeAgent.maxTasksPerHour,
            maxParallelTasks: codeAgent.maxParallelTasks
          },
          claudeCode: {
            enabled:
              ["claude-code", "auto"].includes(String(codeAgent.provider || "").trim().toLowerCase()),
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
        maxRecentMessages: memory.maxRecentMessages
      },
      embeddingModel: memory.embeddingModel,
      reflection: {
        enabled: reflection.enabled,
        hour: reflection.hour,
        minute: reflection.minute,
        maxFactsPerReflection: reflection.maxFactsPerReflection
      }
    },
    initiative: {
      text: {
        enabled: initiativeText.enabled,
        execution: {
          mode: "inherit_orchestrator"
        },
        eagerness: initiativeText.eagerness,
        minMinutesBetweenPosts: initiativeText.minMinutesBetweenPosts,
        maxPostsPerDay: initiativeText.maxPostsPerDay,
        lookbackMessages: initiativeText.lookbackMessages,
        allowActiveCuriosity: initiativeText.allowActiveCuriosity,
        maxToolSteps: initiativeText.maxToolSteps,
        maxToolCalls: initiativeText.maxToolCalls
      },
      voice: {
        enabled: initiativeVoice.enabled,
        execution: {
          mode: "dedicated_model",
          model: {
            provider: initiativeVoiceExecutionModel.provider,
            model: initiativeVoiceExecutionModel.model
          },
          temperature: initiativeVoiceExecution.temperature
        },
        eagerness: initiativeVoice.eagerness,
        minSilenceSeconds: initiativeVoice.minSilenceSeconds,
        minSecondsBetweenThoughts: initiativeVoice.minSecondsBetweenThoughts
      },
      discovery: isRecord(discovery)
        ? {
            allowImagePosts: discovery.allowImagePosts,
            allowVideoPosts: discovery.allowVideoPosts,
            allowReplyImages: discovery.allowReplyImages,
            allowReplyVideos: discovery.allowReplyVideos,
            allowReplyGifs: discovery.allowReplyGifs,
            maxImagesPerDay: discovery.maxImagesPerDay,
            maxVideosPerDay: discovery.maxVideosPerDay,
            maxGifsPerDay: discovery.maxGifsPerDay,
            simpleImageModel: discovery.simpleImageModel,
            complexImageModel: discovery.complexImageModel,
            videoModel: discovery.videoModel,
            allowedImageModels: discovery.allowedImageModels,
            allowedVideoModels: discovery.allowedVideoModels,
            maxMediaPromptChars: discovery.maxMediaPromptChars,
            maxLinksPerPost: discovery.maxLinksPerPost,
            maxCandidatesForPrompt: discovery.maxCandidatesForPrompt,
            freshnessHours: discovery.freshnessHours,
            dedupeHours: discovery.dedupeHours,
            randomness: discovery.randomness,
            sourceFetchLimit: discovery.sourceFetchLimit,
            allowNsfw: discovery.allowNsfw,
            allowSelfCuration: discovery.allowSelfCuration,
            maxSourcesPerType: discovery.maxSourcesPerType,
            redditSubreddits: discovery.redditSubreddits,
            youtubeChannelIds: discovery.youtubeChannelIds,
            rssFeeds: discovery.rssFeeds,
            xHandles: discovery.xHandles,
            xNitterBaseUrl: discovery.xNitterBaseUrl,
            sources: discovery.sources
          }
        : discovery
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
        ambientReplyEagerness: voice.ambientReplyEagerness,
        commandOnlyMode: voice.commandOnlyMode,
        allowNsfwHumor: voice.allowNsfwHumor,
        textOnlyMode: voice.textOnlyMode,
        defaultInterruptionMode: voice.defaultInterruptionMode,
        replyPath: voice.replyPath,
        ttsMode: voice.ttsMode,
        operationalMessages: voice.operationalMessages,
        streaming: {
          enabled: Boolean(voice.streamingEnabled),
          minSentencesPerChunk: Number(voice.streamingMinSentencesPerChunk),
          eagerFirstChunkChars: Number(voice.streamingEagerFirstChunkChars),
          maxBufferChars: Number(voice.streamingMaxBufferChars)
        }
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
  } as Record<string, unknown>;

  return deepMerge(normalizedLegacy, raw) as Record<string, unknown>;
}

const TEST_SETTINGS_BASELINE: SettingsInput = {
  agentStack: {
    preset: "claude_api"
  }
};

function buildSettingsPatch(base: unknown, next: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }
  if (!isRecord(base) || !isRecord(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }

  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    const nested = buildSettingsPatch(base[key], next[key]);
    if (nested !== undefined) {
      patch[key] = nested;
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function createTestSettings(overrides: unknown = {}) {
  return normalizeSettings(
    deepMerge(TEST_SETTINGS_BASELINE, normalizeLegacyTestSettingsInput(overrides))
  );
}

export function createTestSettingsPatch(overrides: unknown = {}) {
  const base = normalizeSettings(TEST_SETTINGS_BASELINE);
  const next = createTestSettings(overrides);
  return (buildSettingsPatch(base, next) || {}) as Record<string, unknown>;
}
