import { normalizeSettings } from "./store/settingsNormalization.ts";
import { deepMerge } from "./utils.ts";
import { DEFAULT_SETTINGS } from "./settings/settingsSchema.ts";
import { normalizeLlmProvider } from "./llm/llmHelpers.ts";
import { normalizeVoiceProvider } from "./voice/voiceModes.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasCanonicalRuntimeOverride(raw: Record<string, unknown>, key: "browserRuntime" | "researchRuntime" | "voiceRuntime") {
  const agentStack = isRecord(raw.agentStack) ? raw.agentStack : {};
  const overrides = isRecord(agentStack.overrides) ? agentStack.overrides : {};
  return typeof overrides[key] === "string" && String(overrides[key] || "").trim().length > 0;
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
  return "anthropic_brain_openai_tools";
}

export function normalizeTestSettingsInput(overrides: unknown): Record<string, unknown> {
  const raw = isRecord(overrides) ? overrides : {};
  if (isRecord(raw.identity) || isRecord(raw.agentStack)) {
    return raw;
  }

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

  return {
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
        replyEagerness: activity.replyEagerness,
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
        ...(legacyVoiceRuntimeOverride
          ? {
              voiceRuntime: legacyVoiceRuntimeOverride
            }
          : {}),
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
          ...(legacyVoiceRuntimeOverride
            ? {
                runtimeMode: legacyVoiceRuntimeOverride
              }
            : {}),
          openaiRealtime: voice.openaiRealtime,
          xai: voice.xai,
          elevenLabsRealtime: voice.elevenLabsRealtime,
          geminiRealtime: voice.geminiRealtime,
          sttPipeline: voice.sttPipeline,
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
  } as Record<string, unknown>;
}

export function createTestSettings(overrides: unknown = {}) {
  const legacyRaw = isRecord(overrides) ? overrides : {};
  const raw = normalizeTestSettingsInput(overrides);
  let settings = normalizeSettings(raw);
  let patch: Record<string, unknown> = {};

  if (isRecord(legacyRaw.browser) && !hasCanonicalRuntimeOverride(raw, "browserRuntime")) {
    patch = deepMerge(patch, {
      agentStack: {
        overrides: {
          browserRuntime: "local_browser_agent"
        }
      }
    });
  }

  if (isRecord(legacyRaw.webSearch) && !hasCanonicalRuntimeOverride(raw, "researchRuntime")) {
    patch = deepMerge(patch, {
      agentStack: {
        overrides: {
          researchRuntime: "local_external_search"
        }
      }
    });
  }

  const voice = isRecord(legacyRaw.voice) ? legacyRaw.voice : {};
  const legacyMode = String(voice.mode || "")
    .trim()
    .toLowerCase();
  if (legacyMode) {
    patch = deepMerge(patch, {
      agentStack: {
        overrides: {
          voiceRuntime: legacyMode
        },
        runtimeConfig: {
          voice: {
            runtimeMode: legacyMode
          }
        }
      }
    });
  }

  if (Object.keys(patch).length > 0) {
    settings = normalizeSettings(deepMerge(settings, patch));
  }

  return settings;
}

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

export function createTestSettingsPatch(overrides: unknown = {}) {
  const base = normalizeSettings(DEFAULT_SETTINGS);
  const next = createTestSettings(overrides);
  return (buildSettingsPatch(base, next) || {}) as Record<string, unknown>;
}
