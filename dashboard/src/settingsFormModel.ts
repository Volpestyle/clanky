import {
  DEFAULT_SETTINGS,
  PROVIDER_MODEL_FALLBACKS,
  type SettingsInput
} from "../../src/settings/settingsSchema.ts";
import { normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";
import {
  formatCommaList,
  formatLineList,
  normalizeBoundedStringList,
  parseUniqueLineList,
  parseUniqueList
} from "../../src/settings/listNormalization.ts";
import {
  getActivitySettings,
  getAgentStackSettings,
  getAutomationsSettings,
  getBotName,
  getBotNameAliases,
  getBrowserRuntimeConfig,
  getDevTaskPermissions,
  getDevTeamRuntimeConfig,
  getDirectiveSettings,
  getDiscoverySettings,
  getFollowupSettings,
  getMemorySettings,
  getPersonaSettings,
  getPromptingSettings,
  getReplyPermissions,
  getResearchRuntimeConfig,
  getResolvedFollowupBinding,
  getResolvedMemoryBinding,
  getResolvedOrchestratorBinding,
  getResolvedVoiceProvider,
  getResolvedVisionBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceGenerationBinding,
  getResolvedVoiceInitiativeBinding,
  getSessionOrchestrationSettings,
  getStartupSettings,
  getTextInitiativeSettings,
  getVideoContextSettings,
  getVisionSettings,
  getVoiceAdmissionSettings,
  getVoiceChannelPolicy,
  getVoiceConversationPolicy,
  getVoiceInitiativeSettings,
  getVoiceRuntimeConfig,
  getVoiceSessionLimits,
  getVoiceSettings,
  getVoiceSoundboardSettings,
  getVoiceStreamWatchSettings,
  getVoiceTranscriptionSettings,
  resolveAgentStack
} from "../../src/settings/agentStack.ts";

export const OPENAI_REALTIME_MODEL_OPTIONS = Object.freeze([
  "gpt-realtime",
  "gpt-realtime-1.5",
  "gpt-realtime-mini"
]);

export const OPENAI_REALTIME_VOICE_OPTIONS = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse"
]);

export const OPENAI_TRANSCRIPTION_MODEL_OPTIONS = Object.freeze([
  "whisper-1",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-latest"
]);

export const OPENAI_REALTIME_TRANSCRIPTION_METHOD_OPTIONS = Object.freeze([
  "realtime_bridge",
  "file_wav"
]);

export const GEMINI_REALTIME_MODEL_OPTIONS = Object.freeze([
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash"
]);

export const XAI_VOICE_OPTIONS = Object.freeze([
  "Ara",
  "Rex",
  "Sal",
  "Eve",
  "Leo"
]);

export const BROWSER_PROVIDER_MODEL_FALLBACKS = Object.freeze({
  anthropic: ["claude-sonnet-4-5-20250929"],
  openai: ["gpt-5-mini"]
});

function buildSettingsFormView(settings: unknown) {
  const source = settings || DEFAULT_SETTINGS;
  const agentStack = getAgentStackSettings(source);
  const prompting = getPromptingSettings(source);
  const activity = getActivitySettings(source);
  const permissions = getReplyPermissions(source);
  const textThoughtLoop = getTextInitiativeSettings(source);
  const memory = getMemorySettings(source);
  const directives = getDirectiveSettings(source);
  const automations = getAutomationsSettings(source);
  const sessions = getSessionOrchestrationSettings(source);
  const followup = getFollowupSettings(source);
  const followupBinding = getResolvedFollowupBinding(source);
  const orchestrator = getResolvedOrchestratorBinding(source);
  const memoryBinding = getResolvedMemoryBinding(source);
  const research = getResearchRuntimeConfig(source);
  const browser = getBrowserRuntimeConfig(source);
  const browserExecution = browser.localBrowserAgent?.execution;
  const browserBinding =
    browserExecution?.mode === "dedicated_model" && browserExecution.model
      ? browserExecution.model
      : orchestrator;
  const devPermissions = getDevTaskPermissions(source);
  const devTeam = getDevTeamRuntimeConfig(source);
  const resolvedStack = resolveAgentStack(source);
  const vision = getVisionSettings(source);
  const visionBinding = getResolvedVisionBinding(source);
  const videoContext = getVideoContextSettings(source);
  const voiceSettings = getVoiceSettings(source);
  const transcription = getVoiceTranscriptionSettings(source);
  const voiceChannelPolicy = getVoiceChannelPolicy(source);
  const voiceSessionLimits = getVoiceSessionLimits(source);
  const voiceConversation = getVoiceConversationPolicy(source);
  const voiceAdmission = getVoiceAdmissionSettings(source);
  const voiceInitiative = getVoiceInitiativeSettings(source);
  const voiceInitiativeBinding = getResolvedVoiceInitiativeBinding(source);
  const voiceRuntime = getVoiceRuntimeConfig(source);
  const voiceGenerationBinding = getResolvedVoiceGenerationBinding(source);
  const voiceClassifierBinding = getResolvedVoiceAdmissionClassifierBinding(source);
  const voiceStreamWatch = getVoiceStreamWatchSettings(source);
  const voiceSoundboard = getVoiceSoundboardSettings(source);
  const startup = getStartupSettings(source);
  const discovery = getDiscoverySettings(source);
  const codingWorkers = Array.isArray(resolvedStack.devTeam?.codingWorkers) ? resolvedStack.devTeam.codingWorkers : [];
  const codeAgentProvider =
    codingWorkers.length === 1
      ? codingWorkers[0] === "codex"
        ? "codex"
        : "claude-code"
      : "auto";

  return {
    agentStack,
    botName: getBotName(source),
    botNameAliases: getBotNameAliases(source),
    persona: getPersonaSettings(source),
    prompt: {
      capabilityHonestyLine: prompting.global.capabilityHonestyLine,
      impossibleActionLine: prompting.global.impossibleActionLine,
      memoryEnabledLine: prompting.global.memoryEnabledLine,
      memoryDisabledLine: prompting.global.memoryDisabledLine,
      skipLine: prompting.global.skipLine,
      textGuidance: prompting.text.guidance,
      voiceGuidance: prompting.voice.guidance,
      voiceOperationalGuidance: prompting.voice.operationalGuidance,
      voiceLookupBusySystemPrompt: prompting.voice.lookupBusySystemPrompt,
      mediaPromptCraftGuidance: prompting.media.promptCraftGuidance
    },
    activity,
    permissions,
    textThoughtLoop,
    memory,
    adaptiveDirectives: directives,
    automations,
    subAgentOrchestration: sessions,
    llm: orchestrator,
    replyFollowupLlm: {
      enabled: followup.enabled,
      provider: followupBinding.provider,
      model: followupBinding.model,
      maxToolSteps: followup.toolBudget.maxToolSteps,
      maxTotalToolCalls: followup.toolBudget.maxTotalToolCalls,
      maxWebSearchCalls: followup.toolBudget.maxWebSearchCalls,
      maxMemoryLookupCalls: followup.toolBudget.maxMemoryLookupCalls,
      maxImageLookupCalls: followup.toolBudget.maxImageLookupCalls,
      toolTimeoutMs: followup.toolBudget.toolTimeoutMs
    },
    memoryLlm: memoryBinding,
    browser: {
      runtime: resolvedStack.browserRuntime,
      enabled: browser.enabled,
      openAiComputerUseModel: String(browser.openaiComputerUse?.model || ""),
      maxBrowseCallsPerHour: browser.localBrowserAgent.maxBrowseCallsPerHour,
      llm: browserBinding,
      maxStepsPerTask: browser.localBrowserAgent.maxStepsPerTask,
      stepTimeoutMs: browser.localBrowserAgent.stepTimeoutMs,
      sessionTimeoutMs: browser.localBrowserAgent.sessionTimeoutMs
    },
    codeAgent: {
      enabled: devPermissions.allowedUserIds.length > 0 && Boolean(devTeam.codex?.enabled || devTeam.claudeCode?.enabled),
      provider: codeAgentProvider,
      model: String(devTeam.claudeCode?.model || ""),
      codexModel: String(devTeam.codex?.model || ""),
      maxTurns: Math.max(Number(devTeam.codex?.maxTurns || 0), Number(devTeam.claudeCode?.maxTurns || 0)),
      timeoutMs: Math.max(Number(devTeam.codex?.timeoutMs || 0), Number(devTeam.claudeCode?.timeoutMs || 0)),
      maxBufferBytes: Math.max(
        Number(devTeam.codex?.maxBufferBytes || 0),
        Number(devTeam.claudeCode?.maxBufferBytes || 0)
      ),
      defaultCwd: String(devTeam.codex?.defaultCwd || devTeam.claudeCode?.defaultCwd || ""),
      maxTasksPerHour: Math.max(
        Number(devTeam.codex?.maxTasksPerHour || 0),
        Number(devTeam.claudeCode?.maxTasksPerHour || 0)
      ),
      maxParallelTasks: Math.max(
        Number(devTeam.codex?.maxParallelTasks || 0),
        Number(devTeam.claudeCode?.maxParallelTasks || 0)
      ),
      allowedUserIds: devPermissions.allowedUserIds
    },
    vision: {
      captionEnabled: vision.enabled,
      provider: visionBinding.provider,
      model: visionBinding.model,
      maxAutoIncludeImages: vision.maxAutoIncludeImages,
      maxCaptionsPerHour: vision.maxCaptionsPerHour
    },
    webSearch: {
      runtime: resolvedStack.researchRuntime,
      enabled: research.enabled,
      nativeUserLocation: research.openaiNativeWebSearch.userLocation,
      nativeAllowedDomains: research.openaiNativeWebSearch.allowedDomains,
      safeSearch: research.localExternalSearch.safeSearch,
      maxSearchesPerHour: research.maxSearchesPerHour,
      maxResults: research.localExternalSearch.maxResults,
      maxPagesToRead: research.localExternalSearch.maxPagesToRead,
      maxCharsPerPage: research.localExternalSearch.maxCharsPerPage,
      providerOrder: research.localExternalSearch.providerOrder,
      recencyDaysDefault: research.localExternalSearch.recencyDaysDefault,
      maxConcurrentFetches: research.localExternalSearch.maxConcurrentFetches
    },
    videoContext,
    voice: {
      enabled: voiceSettings.enabled,
      voiceProvider: getResolvedVoiceProvider(source),
      replyPath: voiceConversation.replyPath,
      ttsMode: voiceConversation.ttsMode,
      asrLanguageMode: transcription.languageMode,
      asrLanguageHint: transcription.languageHint,
      allowNsfwHumor: voiceConversation.allowNsfwHumor,
      intentConfidenceThreshold: voiceAdmission.intentConfidenceThreshold,
      maxSessionMinutes: voiceSessionLimits.maxSessionMinutes,
      inactivityLeaveSeconds: voiceSessionLimits.inactivityLeaveSeconds,
      maxSessionsPerDay: voiceSessionLimits.maxSessionsPerDay,
      replyEagerness: voiceConversation.replyEagerness,
      commandOnlyMode: voiceConversation.commandOnlyMode,
      thoughtEngine: {
        enabled: voiceInitiative.enabled,
        provider: voiceInitiativeBinding.provider,
        model: voiceInitiativeBinding.model,
        temperature: voiceInitiativeBinding.temperature,
        eagerness: voiceInitiative.eagerness,
        minSilenceSeconds: voiceInitiative.minSilenceSeconds,
        minSecondsBetweenThoughts: voiceInitiative.minSecondsBetweenThoughts
      },
      replyDecisionLlm: {
        realtimeAdmissionMode: voiceAdmission.mode,
        musicWakeLatchSeconds: voiceAdmission.musicWakeLatchSeconds,
        provider: voiceClassifierBinding?.provider || orchestrator.provider,
        model: voiceClassifierBinding?.model || orchestrator.model
      },
      generationLlm: {
        useTextModel: voiceRuntime.generation?.mode !== "dedicated_model",
        provider: voiceGenerationBinding.provider,
        model: voiceGenerationBinding.model
      },
      allowedVoiceChannelIds: voiceChannelPolicy.allowedChannelIds,
      blockedVoiceChannelIds: voiceChannelPolicy.blockedChannelIds,
      blockedVoiceUserIds: voiceChannelPolicy.blockedUserIds,
      xai: voiceRuntime.xai,
      openaiRealtime: voiceRuntime.openaiRealtime,
      elevenLabsRealtime: voiceRuntime.elevenLabsRealtime,
      geminiRealtime: voiceRuntime.geminiRealtime,
      sttPipeline: voiceRuntime.sttPipeline,
      streamWatch: voiceStreamWatch,
      soundboard: voiceSoundboard,
      asrEnabled: transcription.enabled,
      textOnlyMode: voiceConversation.textOnlyMode,
      operationalMessages: voiceConversation.operationalMessages
    },
    startup,
    discovery
  };
}

const DEFAULT_SETTINGS_LEGACY_VIEW = buildSettingsFormView(DEFAULT_SETTINGS);

export function settingsToForm(settings: unknown) {
  const defaults = DEFAULT_SETTINGS_LEGACY_VIEW;
  const resolved = buildSettingsFormView(settings || DEFAULT_SETTINGS);
  const defaultPrompt = defaults.prompt;
  const defaultActivity = defaults.activity;
  const defaultPermissions = defaults.permissions;
  const defaultLlm = defaults.llm;
  const defaultReplyFollowupLlm = defaults.replyFollowupLlm;
  const defaultMemoryLlm = defaults.memoryLlm;
  const defaultWebSearch = defaults.webSearch;
  const defaultVideoContext = defaults.videoContext;
  const defaultVision = defaults.vision;
  const defaultVoice = defaults.voice;
  const defaultVoiceXai = defaults.voice.xai;
  const defaultVoiceOpenAiRealtime = defaults.voice.openaiRealtime;
  const defaultVoiceElevenLabsRealtime = defaults.voice.elevenLabsRealtime;
  const defaultVoiceGeminiRealtime = defaults.voice.geminiRealtime;
  const defaultVoiceThoughtEngine = defaults.voice.thoughtEngine;
  const defaultVoiceGenerationLlm = defaults.voice.generationLlm;
  const defaultVoiceStreamWatch = defaults.voice.streamWatch;
  const defaultVoiceSoundboard = defaults.voice.soundboard;
  const defaultStartup = defaults.startup;
  const defaultTextThoughtLoop = defaults.textThoughtLoop;
  const defaultDiscovery = defaults.discovery;
  const activity = resolved.activity;
  const selectedVoiceProvider = resolved.voice.voiceProvider;
  return {
    stackPreset: resolved.agentStack.preset ?? DEFAULT_SETTINGS.agentStack.preset,
    stackAdvancedOverridesEnabled:
      resolved.agentStack.advancedOverridesEnabled ?? DEFAULT_SETTINGS.agentStack.advancedOverridesEnabled,
    botName: resolved.botName ?? defaults.botName,
    botNameAliases: formatCommaList(resolved.botNameAliases ?? defaults.botNameAliases),
    personaFlavor: resolved.persona.flavor ?? defaults.persona.flavor,
    personaHardLimits: formatLineList(resolved.persona.hardLimits),
    promptCapabilityHonestyLine: resolved.prompt.capabilityHonestyLine ?? defaultPrompt.capabilityHonestyLine,
    promptImpossibleActionLine:
      resolved.prompt.impossibleActionLine ?? defaultPrompt.impossibleActionLine,
    promptMemoryEnabledLine:
      resolved.prompt.memoryEnabledLine ?? defaultPrompt.memoryEnabledLine,
    promptMemoryDisabledLine:
      resolved.prompt.memoryDisabledLine ?? defaultPrompt.memoryDisabledLine,
    promptSkipLine: resolved.prompt.skipLine ?? defaultPrompt.skipLine,
    promptTextGuidance: formatLineList(resolved.prompt.textGuidance ?? defaultPrompt.textGuidance),
    promptVoiceGuidance: formatLineList(resolved.prompt.voiceGuidance ?? defaultPrompt.voiceGuidance),
    promptVoiceOperationalGuidance:
      formatLineList(resolved.prompt.voiceOperationalGuidance ?? defaultPrompt.voiceOperationalGuidance),
    promptVoiceLookupBusySystemPrompt:
      resolved.prompt.voiceLookupBusySystemPrompt ?? defaultPrompt.voiceLookupBusySystemPrompt,
    promptMediaPromptCraftGuidance: resolved.prompt.mediaPromptCraftGuidance ?? defaultPrompt.mediaPromptCraftGuidance,
    replyEagerness: activity.replyEagerness ?? defaultActivity.replyEagerness,
    reactionLevel: activity.reactionLevel ?? defaultActivity.reactionLevel,
    minGap: activity.minSecondsBetweenMessages ?? defaultActivity.minSecondsBetweenMessages,
    allowReplies: resolved.permissions.allowReplies ?? defaultPermissions.allowReplies,
    allowUnsolicitedReplies:
      resolved.permissions.allowUnsolicitedReplies ?? defaultPermissions.allowUnsolicitedReplies,
    allowReactions: resolved.permissions.allowReactions ?? defaultPermissions.allowReactions,
    textThoughtLoopEnabled:
      resolved.textThoughtLoop.enabled ?? defaultTextThoughtLoop.enabled,
    textThoughtLoopEagerness:
      resolved.textThoughtLoop.eagerness ?? defaultTextThoughtLoop.eagerness,
    textThoughtLoopMinMinutesBetweenThoughts:
      resolved.textThoughtLoop.minMinutesBetweenThoughts ??
      defaultTextThoughtLoop.minMinutesBetweenThoughts,
    textThoughtLoopMaxThoughtsPerDay:
      resolved.textThoughtLoop.maxThoughtsPerDay ?? defaultTextThoughtLoop.maxThoughtsPerDay,
    textThoughtLoopLookbackMessages:
      resolved.textThoughtLoop.lookbackMessages ?? defaultTextThoughtLoop.lookbackMessages,
    memoryEnabled: resolved.memory.enabled ?? defaults.memory.enabled,
    adaptiveDirectivesEnabled:
      resolved.adaptiveDirectives.enabled ?? defaults.adaptiveDirectives.enabled,
    automationsEnabled:
      resolved.automations.enabled ?? defaults.automations.enabled,
    subAgentSessionIdleTimeoutMs:
      resolved.subAgentOrchestration.sessionIdleTimeoutMs ?? defaults.subAgentOrchestration.sessionIdleTimeoutMs,
    subAgentMaxConcurrentSessions:
      resolved.subAgentOrchestration.maxConcurrentSessions ?? defaults.subAgentOrchestration.maxConcurrentSessions,
    memoryReflectionStrategy:
      resolved.memory.reflection.strategy ?? defaults.memory.reflection.strategy,
    provider: resolved.llm.provider ?? defaultLlm.provider,
    model: resolved.llm.model ?? defaultLlm.model,
    replyFollowupLlmEnabled: resolved.replyFollowupLlm.enabled ?? defaultReplyFollowupLlm.enabled,
    replyFollowupLlmProvider: resolved.replyFollowupLlm.provider ?? defaultReplyFollowupLlm.provider,
    replyFollowupLlmModel: resolved.replyFollowupLlm.model ?? defaultReplyFollowupLlm.model,
    replyFollowupMaxToolSteps: resolved.replyFollowupLlm.maxToolSteps ?? defaultReplyFollowupLlm.maxToolSteps,
    replyFollowupMaxTotalToolCalls:
      resolved.replyFollowupLlm.maxTotalToolCalls ?? defaultReplyFollowupLlm.maxTotalToolCalls,
    replyFollowupMaxWebSearchCalls:
      resolved.replyFollowupLlm.maxWebSearchCalls ?? defaultReplyFollowupLlm.maxWebSearchCalls,
    replyFollowupMaxMemoryLookupCalls:
      resolved.replyFollowupLlm.maxMemoryLookupCalls ?? defaultReplyFollowupLlm.maxMemoryLookupCalls,
    replyFollowupMaxImageLookupCalls:
      resolved.replyFollowupLlm.maxImageLookupCalls ?? defaultReplyFollowupLlm.maxImageLookupCalls,
    replyFollowupToolTimeoutMs:
      resolved.replyFollowupLlm.toolTimeoutMs ?? defaultReplyFollowupLlm.toolTimeoutMs,
    memoryLlmProvider: resolved.memoryLlm.provider ?? defaultMemoryLlm.provider,
    memoryLlmModel: resolved.memoryLlm.model ?? defaultMemoryLlm.model,
    temperature: resolved.llm.temperature ?? defaultLlm.temperature,
    maxTokens: resolved.llm.maxOutputTokens ?? defaultLlm.maxOutputTokens,
    browserEnabled: resolved.browser.enabled ?? defaults.browser.enabled,
    stackResolvedResearchRuntime: resolved.webSearch.runtime ?? defaultWebSearch.runtime,
    stackResolvedBrowserRuntime: resolved.browser.runtime ?? defaults.browser.runtime,
    browserOpenAiComputerUseModel:
      resolved.browser.openAiComputerUseModel ?? defaults.browser.openAiComputerUseModel,
    browserMaxPerHour: resolved.browser.maxBrowseCallsPerHour ?? defaults.browser.maxBrowseCallsPerHour,
    browserLlmProvider: resolved.browser.llm.provider ?? defaults.browser.llm.provider,
    browserLlmModel: resolved.browser.llm.model ?? defaults.browser.llm.model,
    browserMaxSteps: resolved.browser.maxStepsPerTask ?? defaults.browser.maxStepsPerTask,
    browserStepTimeoutMs: resolved.browser.stepTimeoutMs ?? defaults.browser.stepTimeoutMs,
    browserSessionTimeoutMs: resolved.browser.sessionTimeoutMs ?? defaults.browser.sessionTimeoutMs,
    codeAgentEnabled: resolved.codeAgent.enabled ?? defaults.codeAgent.enabled,
    codeAgentProvider: resolved.codeAgent.provider ?? defaults.codeAgent.provider,
    codeAgentModel: resolved.codeAgent.model ?? defaults.codeAgent.model,
    codeAgentCodexModel: resolved.codeAgent.codexModel ?? defaults.codeAgent.codexModel,
    codeAgentMaxTurns: resolved.codeAgent.maxTurns ?? defaults.codeAgent.maxTurns,
    codeAgentTimeoutMs: resolved.codeAgent.timeoutMs ?? defaults.codeAgent.timeoutMs,
    codeAgentMaxBufferBytes: resolved.codeAgent.maxBufferBytes ?? defaults.codeAgent.maxBufferBytes,
    codeAgentDefaultCwd: resolved.codeAgent.defaultCwd ?? defaults.codeAgent.defaultCwd,
    codeAgentMaxTasksPerHour: resolved.codeAgent.maxTasksPerHour ?? defaults.codeAgent.maxTasksPerHour,
    codeAgentMaxParallelTasks: resolved.codeAgent.maxParallelTasks ?? defaults.codeAgent.maxParallelTasks,
    codeAgentAllowedUserIds: formatLineList(resolved.codeAgent.allowedUserIds ?? defaults.codeAgent.allowedUserIds),
    visionCaptionEnabled: resolved.vision.captionEnabled ?? defaultVision.captionEnabled,
    visionProvider: resolved.vision.provider ?? defaultVision.provider,
    visionModel: resolved.vision.model ?? defaultVision.model,
    visionMaxAutoIncludeImages: resolved.vision.maxAutoIncludeImages ?? defaultVision.maxAutoIncludeImages,
    visionMaxCaptionsPerHour: resolved.vision.maxCaptionsPerHour ?? defaultVision.maxCaptionsPerHour,
    webSearchEnabled: resolved.webSearch.enabled ?? defaultWebSearch.enabled,
    webSearchOpenAiUserLocation: resolved.webSearch.nativeUserLocation ?? defaultWebSearch.nativeUserLocation,
    webSearchOpenAiAllowedDomains:
      formatLineList(resolved?.webSearch?.nativeAllowedDomains ?? defaultWebSearch.nativeAllowedDomains),
    webSearchSafeMode: resolved?.webSearch?.safeSearch ?? defaultWebSearch.safeSearch,
    webSearchPerHour: resolved?.webSearch?.maxSearchesPerHour ?? defaultWebSearch.maxSearchesPerHour,
    webSearchMaxResults: resolved?.webSearch?.maxResults ?? defaultWebSearch.maxResults,
    webSearchMaxPages: resolved?.webSearch?.maxPagesToRead ?? defaultWebSearch.maxPagesToRead,
    webSearchMaxChars: resolved?.webSearch?.maxCharsPerPage ?? defaultWebSearch.maxCharsPerPage,
    webSearchProviderOrder: (resolved?.webSearch?.providerOrder || defaultWebSearch.providerOrder).join(","),
    webSearchRecencyDaysDefault: resolved?.webSearch?.recencyDaysDefault ?? defaultWebSearch.recencyDaysDefault,
    webSearchMaxConcurrentFetches: resolved?.webSearch?.maxConcurrentFetches ?? defaultWebSearch.maxConcurrentFetches,
    videoContextEnabled: resolved?.videoContext?.enabled ?? defaultVideoContext.enabled,
    videoContextPerHour: resolved?.videoContext?.maxLookupsPerHour ?? defaultVideoContext.maxLookupsPerHour,
    videoContextMaxVideos: resolved?.videoContext?.maxVideosPerMessage ?? defaultVideoContext.maxVideosPerMessage,
    videoContextMaxChars: resolved?.videoContext?.maxTranscriptChars ?? defaultVideoContext.maxTranscriptChars,
    videoContextKeyframeInterval: resolved?.videoContext?.keyframeIntervalSeconds ?? defaultVideoContext.keyframeIntervalSeconds,
    videoContextMaxKeyframes: resolved?.videoContext?.maxKeyframesPerVideo ?? defaultVideoContext.maxKeyframesPerVideo,
    videoContextAsrFallback: resolved?.videoContext?.allowAsrFallback ?? defaultVideoContext.allowAsrFallback,
    videoContextMaxAsrSeconds: resolved?.videoContext?.maxAsrSeconds ?? defaultVideoContext.maxAsrSeconds,
    voiceEnabled: resolved?.voice?.enabled ?? defaultVoice.enabled,
    voiceProvider: selectedVoiceProvider,
    voiceReplyPath: resolved?.voice?.replyPath ?? defaultVoice.replyPath,
    voiceTtsMode: resolved?.voice?.ttsMode ?? defaultVoice.ttsMode ?? "realtime",
    voiceAsrLanguageMode: resolved?.voice?.asrLanguageMode ?? defaultVoice.asrLanguageMode,
    voiceAsrLanguageHint: resolved?.voice?.asrLanguageHint ?? defaultVoice.asrLanguageHint,
    voiceAllowNsfwHumor: resolved?.voice?.allowNsfwHumor ?? defaultVoice.allowNsfwHumor,
    voiceIntentConfidenceThreshold: resolved?.voice?.intentConfidenceThreshold ?? defaultVoice.intentConfidenceThreshold,
    voiceMaxSessionMinutes: resolved?.voice?.maxSessionMinutes ?? defaultVoice.maxSessionMinutes,
    voiceInactivityLeaveSeconds: resolved?.voice?.inactivityLeaveSeconds ?? defaultVoice.inactivityLeaveSeconds,
    voiceMaxSessionsPerDay: resolved?.voice?.maxSessionsPerDay ?? defaultVoice.maxSessionsPerDay,
    voiceReplyEagerness: resolved?.voice?.replyEagerness ?? defaultVoice.replyEagerness,
    voiceCommandOnlyMode: resolved?.voice?.commandOnlyMode ?? defaultVoice.commandOnlyMode,
    voiceThoughtEngineEnabled:
      resolved?.voice?.thoughtEngine?.enabled ?? defaultVoiceThoughtEngine.enabled,
    voiceThoughtEngineProvider:
      resolved?.voice?.thoughtEngine?.provider ?? defaultVoiceThoughtEngine.provider,
    voiceThoughtEngineModel:
      resolved?.voice?.thoughtEngine?.model ?? defaultVoiceThoughtEngine.model,
    voiceThoughtEngineTemperature:
      resolved?.voice?.thoughtEngine?.temperature ?? defaultVoiceThoughtEngine.temperature,
    voiceThoughtEngineEagerness:
      resolved?.voice?.thoughtEngine?.eagerness ?? defaultVoiceThoughtEngine.eagerness,
    voiceThoughtEngineMinSilenceSeconds:
      resolved?.voice?.thoughtEngine?.minSilenceSeconds ?? defaultVoiceThoughtEngine.minSilenceSeconds,
    voiceThoughtEngineMinSecondsBetweenThoughts:
      resolved?.voice?.thoughtEngine?.minSecondsBetweenThoughts ??
      defaultVoiceThoughtEngine.minSecondsBetweenThoughts,
    voiceReplyDecisionRealtimeAdmissionMode:
      resolved?.voice?.replyDecisionLlm?.realtimeAdmissionMode ?? defaultVoice.replyDecisionLlm.realtimeAdmissionMode,
    voiceReplyDecisionMusicWakeLatchSeconds:
      resolved?.voice?.replyDecisionLlm?.musicWakeLatchSeconds ?? defaultVoice.replyDecisionLlm.musicWakeLatchSeconds,
    voiceReplyDecisionLlmProvider:
      resolved?.voice?.replyDecisionLlm?.provider ?? defaultVoice.replyDecisionLlm.provider,
    voiceReplyDecisionLlmModel:
      resolved?.voice?.replyDecisionLlm?.model ?? defaultVoice.replyDecisionLlm.model,
    voiceGenerationLlmUseTextModel:
      resolved?.voice?.generationLlm?.useTextModel ?? defaultVoiceGenerationLlm.useTextModel,
    voiceGenerationLlmProvider:
      resolved?.voice?.generationLlm?.provider ?? defaultVoiceGenerationLlm.provider,
    voiceGenerationLlmModel:
      resolved?.voice?.generationLlm?.model ?? defaultVoiceGenerationLlm.model,
    voiceAllowedChannelIds: formatLineList(resolved?.voice?.allowedVoiceChannelIds),
    voiceBlockedChannelIds: formatLineList(resolved?.voice?.blockedVoiceChannelIds),
    voiceBlockedUserIds: formatLineList(resolved?.voice?.blockedVoiceUserIds),
    voiceXaiVoice: resolved?.voice?.xai?.voice ?? defaultVoiceXai.voice,
    voiceXaiAudioFormat: resolved?.voice?.xai?.audioFormat ?? defaultVoiceXai.audioFormat,
    voiceXaiSampleRateHz: resolved?.voice?.xai?.sampleRateHz ?? defaultVoiceXai.sampleRateHz,
    voiceXaiRegion: resolved?.voice?.xai?.region ?? defaultVoiceXai.region,
    voiceOpenAiRealtimeModel: resolved?.voice?.openaiRealtime?.model ?? defaultVoiceOpenAiRealtime.model,
    voiceOpenAiRealtimeVoice: resolved?.voice?.openaiRealtime?.voice ?? defaultVoiceOpenAiRealtime.voice,
    voiceOpenAiRealtimeTranscriptionMethod:
      resolved?.voice?.openaiRealtime?.transcriptionMethod ?? defaultVoiceOpenAiRealtime.transcriptionMethod,
    voiceOpenAiRealtimeInputTranscriptionModel:
      resolved?.voice?.openaiRealtime?.inputTranscriptionModel ?? defaultVoiceOpenAiRealtime.inputTranscriptionModel,
    voiceOpenAiRealtimeUsePerUserAsrBridge:
      resolved?.voice?.openaiRealtime?.usePerUserAsrBridge ?? defaultVoiceOpenAiRealtime.usePerUserAsrBridge,
    voiceElevenLabsRealtimeAgentId:
      resolved?.voice?.elevenLabsRealtime?.agentId ?? defaultVoiceElevenLabsRealtime.agentId,
    voiceElevenLabsRealtimeVoiceId:
      resolved?.voice?.elevenLabsRealtime?.voiceId ?? defaultVoiceElevenLabsRealtime.voiceId,
    voiceElevenLabsRealtimeApiBaseUrl:
      resolved?.voice?.elevenLabsRealtime?.apiBaseUrl ?? defaultVoiceElevenLabsRealtime.apiBaseUrl,
    voiceElevenLabsRealtimeInputSampleRateHz:
      resolved?.voice?.elevenLabsRealtime?.inputSampleRateHz ?? defaultVoiceElevenLabsRealtime.inputSampleRateHz,
    voiceElevenLabsRealtimeOutputSampleRateHz:
      resolved?.voice?.elevenLabsRealtime?.outputSampleRateHz ?? defaultVoiceElevenLabsRealtime.outputSampleRateHz,
    voiceGeminiRealtimeModel:
      resolved?.voice?.geminiRealtime?.model ?? defaultVoiceGeminiRealtime.model,
    voiceGeminiRealtimeVoice: resolved?.voice?.geminiRealtime?.voice ?? defaultVoiceGeminiRealtime.voice,
    voiceGeminiRealtimeApiBaseUrl:
      resolved?.voice?.geminiRealtime?.apiBaseUrl ?? defaultVoiceGeminiRealtime.apiBaseUrl,
    voiceGeminiRealtimeInputSampleRateHz: resolved?.voice?.geminiRealtime?.inputSampleRateHz ?? defaultVoiceGeminiRealtime.inputSampleRateHz,
    voiceGeminiRealtimeOutputSampleRateHz: resolved?.voice?.geminiRealtime?.outputSampleRateHz ?? defaultVoiceGeminiRealtime.outputSampleRateHz,
    voiceStreamWatchEnabled: resolved?.voice?.streamWatch?.enabled ?? defaultVoiceStreamWatch.enabled,
    voiceStreamWatchMinCommentaryIntervalSeconds:
      resolved?.voice?.streamWatch?.minCommentaryIntervalSeconds ?? defaultVoiceStreamWatch.minCommentaryIntervalSeconds,
    voiceStreamWatchMaxFramesPerMinute: resolved?.voice?.streamWatch?.maxFramesPerMinute ?? defaultVoiceStreamWatch.maxFramesPerMinute,
    voiceStreamWatchMaxFrameBytes: resolved?.voice?.streamWatch?.maxFrameBytes ?? defaultVoiceStreamWatch.maxFrameBytes,
    voiceStreamWatchCommentaryPath:
      resolved?.voice?.streamWatch?.commentaryPath ?? defaultVoiceStreamWatch.commentaryPath,
    voiceStreamWatchKeyframeIntervalMs:
      resolved?.voice?.streamWatch?.keyframeIntervalMs ?? defaultVoiceStreamWatch.keyframeIntervalMs,
    voiceStreamWatchAutonomousCommentaryEnabled:
      resolved?.voice?.streamWatch?.autonomousCommentaryEnabled ?? defaultVoiceStreamWatch.autonomousCommentaryEnabled,
    voiceStreamWatchBrainContextEnabled:
      resolved?.voice?.streamWatch?.brainContextEnabled ?? defaultVoiceStreamWatch.brainContextEnabled,
    voiceStreamWatchBrainContextMinIntervalSeconds:
      resolved?.voice?.streamWatch?.brainContextMinIntervalSeconds ??
      defaultVoiceStreamWatch.brainContextMinIntervalSeconds,
    voiceStreamWatchBrainContextMaxEntries:
      resolved?.voice?.streamWatch?.brainContextMaxEntries ?? defaultVoiceStreamWatch.brainContextMaxEntries,
    voiceStreamWatchBrainContextPrompt:
      resolved?.voice?.streamWatch?.brainContextPrompt ?? defaultVoiceStreamWatch.brainContextPrompt,
    voiceStreamWatchSharePageMaxWidthPx:
      resolved?.voice?.streamWatch?.sharePageMaxWidthPx ?? defaultVoiceStreamWatch.sharePageMaxWidthPx,
    voiceStreamWatchSharePageJpegQuality:
      resolved?.voice?.streamWatch?.sharePageJpegQuality ?? defaultVoiceStreamWatch.sharePageJpegQuality,
    voiceSoundboardEnabled: resolved?.voice?.soundboard?.enabled ?? defaultVoiceSoundboard.enabled,
    voiceSoundboardAllowExternalSounds: resolved?.voice?.soundboard?.allowExternalSounds ?? defaultVoiceSoundboard.allowExternalSounds,
    voiceSoundboardPreferredSoundIds: formatLineList(resolved?.voice?.soundboard?.preferredSoundIds),
    voiceSttPipelineTtsModel:
      resolved?.voice?.sttPipeline?.ttsModel ?? defaults.voice.sttPipeline.ttsModel,
    voiceSttPipelineTtsVoice:
      resolved?.voice?.sttPipeline?.ttsVoice ?? defaults.voice.sttPipeline.ttsVoice,
    voiceSttPipelineTtsSpeed:
      resolved?.voice?.sttPipeline?.ttsSpeed ?? defaults.voice.sttPipeline.ttsSpeed,
    voiceAsrEnabled: resolved?.voice?.asrEnabled ?? defaultVoice.asrEnabled ?? true,
    voiceTextOnlyMode: resolved?.voice?.textOnlyMode ?? defaultVoice.textOnlyMode ?? false,
    voiceOperationalMessages: resolved?.voice?.operationalMessages ?? defaultVoice.operationalMessages ?? "all",
    maxMessages: resolved?.permissions?.maxMessagesPerHour ?? defaultPermissions.maxMessagesPerHour,
    maxReactions: resolved?.permissions?.maxReactionsPerHour ?? defaultPermissions.maxReactionsPerHour,
    catchupEnabled: Boolean(resolved?.startup?.catchupEnabled ?? true),
    catchupLookbackHours: resolved?.startup?.catchupLookbackHours ?? defaultStartup.catchupLookbackHours,
    catchupMaxMessages: resolved?.startup?.catchupMaxMessagesPerChannel ?? defaultStartup.catchupMaxMessagesPerChannel,
    catchupMaxReplies: resolved?.startup?.maxCatchupRepliesPerChannel ?? defaultStartup.maxCatchupRepliesPerChannel,
    discoveryEnabled: resolved?.discovery?.enabled ?? defaultDiscovery.enabled,
    discoveryPostsPerDay:
      resolved?.discovery?.maxPostsPerDay ?? defaultDiscovery.maxPostsPerDay,
    discoveryMinMinutes:
      resolved?.discovery?.minMinutesBetweenPosts ?? defaultDiscovery.minMinutesBetweenPosts,
    discoveryPacingMode:
      String(resolved?.discovery?.pacingMode || defaultDiscovery.pacingMode) === "spontaneous" ? "spontaneous" : "even",
    discoverySpontaneity:
      resolved?.discovery?.spontaneity ?? defaultDiscovery.spontaneity,
    discoveryStartupPost:
      resolved?.discovery?.postOnStartup ?? defaultDiscovery.postOnStartup,
    discoveryImageEnabled:
      resolved?.discovery?.allowImagePosts ?? defaultDiscovery.allowImagePosts,
    discoveryVideoEnabled:
      resolved?.discovery?.allowVideoPosts ?? defaultDiscovery.allowVideoPosts,
    replyImageEnabled:
      resolved?.discovery?.allowReplyImages ?? defaultDiscovery.allowReplyImages,
    replyVideoEnabled:
      resolved?.discovery?.allowReplyVideos ?? defaultDiscovery.allowReplyVideos,
    replyGifEnabled:
      resolved?.discovery?.allowReplyGifs ?? defaultDiscovery.allowReplyGifs,
    maxImagesPerDay: resolved?.discovery?.maxImagesPerDay ?? defaultDiscovery.maxImagesPerDay,
    maxVideosPerDay: resolved?.discovery?.maxVideosPerDay ?? defaultDiscovery.maxVideosPerDay,
    maxGifsPerDay: resolved?.discovery?.maxGifsPerDay ?? defaultDiscovery.maxGifsPerDay,
    discoverySimpleImageModel:
      resolved?.discovery?.simpleImageModel ?? defaultDiscovery.simpleImageModel,
    discoveryComplexImageModel:
      resolved?.discovery?.complexImageModel ?? defaultDiscovery.complexImageModel,
    discoveryVideoModel:
      resolved?.discovery?.videoModel ?? defaultDiscovery.videoModel,
    discoveryAllowedImageModels:
      formatLineList(resolved?.discovery?.allowedImageModels ?? []),
    discoveryAllowedVideoModels:
      formatLineList(resolved?.discovery?.allowedVideoModels ?? []),
    discoveryExternalEnabled: Boolean(
      Number(resolved?.discovery?.linkChancePercent) > 0 ||
      resolved?.discovery?.sources?.reddit ||
      resolved?.discovery?.sources?.hackerNews ||
      resolved?.discovery?.sources?.youtube ||
      resolved?.discovery?.sources?.rss ||
      resolved?.discovery?.sources?.x
    ),
    discoveryLinkChance:
      resolved?.discovery?.linkChancePercent ?? defaultDiscovery.linkChancePercent,
    discoveryMaxLinks:
      resolved?.discovery?.maxLinksPerPost ?? defaultDiscovery.maxLinksPerPost,
    discoveryMaxCandidates:
      resolved?.discovery?.maxCandidatesForPrompt ?? defaultDiscovery.maxCandidatesForPrompt,
    discoveryFreshnessHours:
      resolved?.discovery?.freshnessHours ?? defaultDiscovery.freshnessHours,
    discoveryDedupeHours:
      resolved?.discovery?.dedupeHours ?? defaultDiscovery.dedupeHours,
    discoveryRandomness:
      resolved?.discovery?.randomness ?? defaultDiscovery.randomness,
    discoveryFetchLimit:
      resolved?.discovery?.sourceFetchLimit ?? defaultDiscovery.sourceFetchLimit,
    discoveryAllowNsfw:
      resolved?.discovery?.allowNsfw ?? defaultDiscovery.allowNsfw,
    discoverySourceReddit:
      resolved?.discovery?.sources?.reddit ?? defaultDiscovery.sources.reddit,
    discoverySourceHackerNews:
      resolved?.discovery?.sources?.hackerNews ?? defaultDiscovery.sources.hackerNews,
    discoverySourceYoutube:
      resolved?.discovery?.sources?.youtube ?? defaultDiscovery.sources.youtube,
    discoverySourceRss:
      resolved?.discovery?.sources?.rss ?? defaultDiscovery.sources.rss,
    discoverySourceX:
      resolved?.discovery?.sources?.x ?? defaultDiscovery.sources.x,
    discoveryPreferredTopics:
      formatLineList(resolved?.discovery?.preferredTopics),
    discoveryRedditSubs:
      formatLineList(resolved?.discovery?.redditSubreddits),
    discoveryYoutubeChannels:
      formatLineList(resolved?.discovery?.youtubeChannelIds),
    discoveryRssFeeds:
      formatLineList(resolved?.discovery?.rssFeeds),
    discoveryXHandles:
      formatLineList(resolved?.discovery?.xHandles),
    discoveryXNitterBase:
      resolved?.discovery?.xNitterBaseUrl ?? defaultDiscovery.xNitterBaseUrl,
    replyChannels: formatLineList(resolved?.permissions?.replyChannelIds),
    discoveryChannels: formatLineList(resolved?.discovery?.channelIds),
    allowedChannels: formatLineList(resolved?.permissions?.allowedChannelIds),
    blockedChannels: formatLineList(resolved?.permissions?.blockedChannelIds),
    blockedUsers: formatLineList(resolved?.permissions?.blockedUserIds)
  };
}

export type SettingsForm = ReturnType<typeof settingsToForm>;

export function formToSettingsPatch(form: SettingsForm): SettingsInput {
  const discoveryExternalEnabled = Boolean(form.discoveryExternalEnabled);
  const advancedOverridesEnabled = Boolean(form.stackAdvancedOverridesEnabled);
  return {
    identity: {
      botName: form.botName.trim(),
      botNameAliases: parseUniqueList(form.botNameAliases)
    },
    persona: {
      flavor: form.personaFlavor.trim(),
      hardLimits: parseUniqueLineList(form.personaHardLimits)
    },
    prompting: {
      global: {
        capabilityHonestyLine: String(form.promptCapabilityHonestyLine || "").trim(),
        impossibleActionLine: String(form.promptImpossibleActionLine || "").trim(),
        memoryEnabledLine: String(form.promptMemoryEnabledLine || "").trim(),
        memoryDisabledLine: String(form.promptMemoryDisabledLine || "").trim(),
        skipLine: String(form.promptSkipLine || "").trim()
      },
      text: {
        guidance: parseUniqueLineList(form.promptTextGuidance)
      },
      voice: {
        guidance: parseUniqueLineList(form.promptVoiceGuidance),
        operationalGuidance: parseUniqueLineList(form.promptVoiceOperationalGuidance),
        lookupBusySystemPrompt: String(form.promptVoiceLookupBusySystemPrompt || "").trim()
      },
      media: {
        promptCraftGuidance: String(form.promptMediaPromptCraftGuidance || "").trim()
      }
    },
    permissions: {
      replies: {
        allowReplies: form.allowReplies,
        allowUnsolicitedReplies: form.allowUnsolicitedReplies,
        allowReactions: form.allowReactions,
        replyChannelIds: parseUniqueList(form.replyChannels),
        allowedChannelIds: parseUniqueList(form.allowedChannels),
        blockedChannelIds: parseUniqueList(form.blockedChannels),
        blockedUserIds: parseUniqueList(form.blockedUsers),
        maxMessagesPerHour: Number(form.maxMessages),
        maxReactionsPerHour: Number(form.maxReactions)
      },
      devTasks: {
        allowedUserIds: parseUniqueList(form.codeAgentAllowedUserIds)
      }
    },
    interaction: {
      activity: {
        replyEagerness: Number(form.replyEagerness),
        reactionLevel: Number(form.reactionLevel),
        minSecondsBetweenMessages: Number(form.minGap)
      },
      replyGeneration: {
        temperature: Number(form.temperature),
        maxOutputTokens: Number(form.maxTokens)
      },
      followup: {
        enabled: Boolean(form.replyFollowupLlmEnabled),
        execution: {
          mode: "dedicated_model",
          model: {
            provider: String(form.replyFollowupLlmProvider || "").trim(),
            model: String(form.replyFollowupLlmModel || "").trim()
          }
        },
        toolBudget: {
          maxToolSteps: Number(form.replyFollowupMaxToolSteps),
          maxTotalToolCalls: Number(form.replyFollowupMaxTotalToolCalls),
          maxWebSearchCalls: Number(form.replyFollowupMaxWebSearchCalls),
          maxMemoryLookupCalls: Number(form.replyFollowupMaxMemoryLookupCalls),
          maxImageLookupCalls: Number(form.replyFollowupMaxImageLookupCalls),
          toolTimeoutMs: Number(form.replyFollowupToolTimeoutMs)
        }
      },
      startup: {
        catchupEnabled: form.catchupEnabled,
        catchupLookbackHours: Number(form.catchupLookbackHours),
        catchupMaxMessagesPerChannel: Number(form.catchupMaxMessages),
        maxCatchupRepliesPerChannel: Number(form.catchupMaxReplies)
      },
      sessions: {
        sessionIdleTimeoutMs: Math.max(10_000, Number(form.subAgentSessionIdleTimeoutMs) || 300_000),
        maxConcurrentSessions: Math.max(1, Number(form.subAgentMaxConcurrentSessions) || 20)
      }
    },
    agentStack: {
      preset: String(form.stackPreset || "openai_native").trim(),
      advancedOverridesEnabled,
      overrides: advancedOverridesEnabled ? {
        orchestrator: {
          provider: form.provider,
          model: form.model.trim()
        },
        devTeam: {
          codingWorkers:
            String(form.codeAgentProvider || "auto").trim().toLowerCase() === "codex"
              ? ["codex"]
              : String(form.codeAgentProvider || "auto").trim().toLowerCase() === "claude-code"
                ? ["claude_code"]
                : ["codex", "claude_code"]
        },
        voiceAdmissionClassifier: {
          mode: "dedicated_model",
          model: {
            provider: String(form.voiceReplyDecisionLlmProvider || "").trim(),
            model: String(form.voiceReplyDecisionLlmModel || "").trim()
          }
        }
      } : {},
      runtimeConfig: {
        research: {
          enabled: form.webSearchEnabled,
          maxSearchesPerHour: Number(form.webSearchPerHour),
          openaiNativeWebSearch: {
            userLocation: String(form.webSearchOpenAiUserLocation || "").trim(),
            allowedDomains: parseUniqueList(form.webSearchOpenAiAllowedDomains)
          },
          localExternalSearch: {
            safeSearch: form.webSearchSafeMode,
            providerOrder: parseUniqueList(form.webSearchProviderOrder),
            maxResults: Number(form.webSearchMaxResults),
            maxPagesToRead: Number(form.webSearchMaxPages),
            maxCharsPerPage: Number(form.webSearchMaxChars),
            recencyDaysDefault: Number(form.webSearchRecencyDaysDefault),
            maxConcurrentFetches: Number(form.webSearchMaxConcurrentFetches)
          }
        },
        browser: {
          enabled: form.browserEnabled,
          openaiComputerUse: {
            model: String(form.browserOpenAiComputerUseModel || "gpt-5.4").trim()
          },
          localBrowserAgent: {
            execution: {
              mode: "dedicated_model",
              model: {
                provider: String(form.browserLlmProvider || "").trim(),
                model: String(form.browserLlmModel || "").trim()
              }
            },
            maxBrowseCallsPerHour: Number(form.browserMaxPerHour),
            maxStepsPerTask: Number(form.browserMaxSteps),
            stepTimeoutMs: Number(form.browserStepTimeoutMs),
            sessionTimeoutMs: Number(form.browserSessionTimeoutMs)
          }
        },
        voice: {
          runtimeMode:
            String(form.voiceProvider || "openai").trim() === "xai"
              ? "voice_agent"
              : String(form.voiceProvider || "openai").trim() === "gemini"
                ? "gemini_realtime"
                : String(form.voiceProvider || "openai").trim() === "elevenlabs"
                  ? "elevenlabs_realtime"
                  : "openai_realtime",
          openaiRealtime: {
            model: String(form.voiceOpenAiRealtimeModel || "").trim(),
            voice: String(form.voiceOpenAiRealtimeVoice || "").trim(),
            inputAudioFormat: "pcm16",
            outputAudioFormat: "pcm16",
            transcriptionMethod: String(form.voiceOpenAiRealtimeTranscriptionMethod || "").trim().toLowerCase(),
            inputTranscriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim(),
            usePerUserAsrBridge: Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge)
          },
          generation: form.voiceGenerationLlmUseTextModel
            ? { mode: "inherit_orchestrator" }
            : {
                mode: "dedicated_model",
                model: {
                  provider: String(form.voiceGenerationLlmProvider || "").trim(),
                  model: String(form.voiceGenerationLlmModel || "").trim()
                }
              },
          xai: {
            voice: String(form.voiceXaiVoice || "").trim(),
            audioFormat: String(form.voiceXaiAudioFormat || "").trim(),
            sampleRateHz: Number(form.voiceXaiSampleRateHz),
            region: String(form.voiceXaiRegion || "").trim()
          },
          elevenLabsRealtime: {
            agentId: String(form.voiceElevenLabsRealtimeAgentId || "").trim(),
            voiceId: String(form.voiceElevenLabsRealtimeVoiceId || "").trim(),
            apiBaseUrl: String(form.voiceElevenLabsRealtimeApiBaseUrl || "").trim(),
            inputSampleRateHz: Number(form.voiceElevenLabsRealtimeInputSampleRateHz),
            outputSampleRateHz: Number(form.voiceElevenLabsRealtimeOutputSampleRateHz)
          },
          geminiRealtime: {
            model: String(form.voiceGeminiRealtimeModel || "").trim(),
            voice: String(form.voiceGeminiRealtimeVoice || "").trim(),
            apiBaseUrl: String(form.voiceGeminiRealtimeApiBaseUrl || "").trim(),
            inputSampleRateHz: Number(form.voiceGeminiRealtimeInputSampleRateHz),
            outputSampleRateHz: Number(form.voiceGeminiRealtimeOutputSampleRateHz)
          },
          sttPipeline: {
            transcriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim(),
            ttsModel: String(form.voiceSttPipelineTtsModel || "").trim(),
            ttsVoice: String(form.voiceSttPipelineTtsVoice || "").trim(),
            ttsSpeed: Number(form.voiceSttPipelineTtsSpeed)
          }
        },
        devTeam: {
          codex: {
            enabled: Boolean(form.codeAgentEnabled),
            model: String(form.codeAgentCodexModel || "gpt-5-codex").trim(),
            maxTurns: Number(form.codeAgentMaxTurns),
            timeoutMs: Number(form.codeAgentTimeoutMs),
            maxBufferBytes: Number(form.codeAgentMaxBufferBytes),
            defaultCwd: String(form.codeAgentDefaultCwd || "").trim(),
            maxTasksPerHour: Number(form.codeAgentMaxTasksPerHour),
            maxParallelTasks: Number(form.codeAgentMaxParallelTasks)
          },
          claudeCode: {
            enabled: Boolean(form.codeAgentEnabled),
            model: String(form.codeAgentModel || "sonnet").trim(),
            maxTurns: Number(form.codeAgentMaxTurns),
            timeoutMs: Number(form.codeAgentTimeoutMs),
            maxBufferBytes: Number(form.codeAgentMaxBufferBytes),
            defaultCwd: String(form.codeAgentDefaultCwd || "").trim(),
            maxTasksPerHour: Number(form.codeAgentMaxTasksPerHour),
            maxParallelTasks: Number(form.codeAgentMaxParallelTasks)
          }
        }
      }
    },
    memory: {
      enabled: form.memoryEnabled,
      execution: {
        mode: "dedicated_model",
        model: {
          provider: String(form.memoryLlmProvider || "").trim(),
          model: String(form.memoryLlmModel || "").trim()
        }
      },
      reflection: {
        strategy:
          String(form.memoryReflectionStrategy || "").trim().toLowerCase() === "one_pass_main"
            ? "one_pass_main"
            : "two_pass_extract_then_main"
      }
    },
    directives: {
      enabled: Boolean(form.adaptiveDirectivesEnabled)
    },
    initiative: {
      text: {
        enabled: Boolean(form.textThoughtLoopEnabled),
        execution: {
          mode: "inherit_orchestrator"
        },
        eagerness: Number(form.textThoughtLoopEagerness),
        minMinutesBetweenThoughts: Number(form.textThoughtLoopMinMinutesBetweenThoughts),
        maxThoughtsPerDay: Number(form.textThoughtLoopMaxThoughtsPerDay),
        lookbackMessages: Number(form.textThoughtLoopLookbackMessages)
      },
      voice: {
        enabled: Boolean(form.voiceThoughtEngineEnabled),
        execution: {
          mode: "dedicated_model",
          model: {
            provider: String(form.voiceThoughtEngineProvider || "").trim(),
            model: String(form.voiceThoughtEngineModel || "").trim()
          },
          temperature: Number(form.voiceThoughtEngineTemperature)
        },
        eagerness: Number(form.voiceThoughtEngineEagerness),
        minSilenceSeconds: Number(form.voiceThoughtEngineMinSilenceSeconds),
        minSecondsBetweenThoughts: Number(form.voiceThoughtEngineMinSecondsBetweenThoughts)
      },
      discovery: {
        enabled: form.discoveryEnabled,
        channelIds: parseUniqueList(form.discoveryChannels),
        maxPostsPerDay: Number(form.discoveryPostsPerDay),
        minMinutesBetweenPosts: Number(form.discoveryMinMinutes),
        pacingMode: form.discoveryPacingMode,
        spontaneity: Number(form.discoverySpontaneity),
        postOnStartup: form.discoveryStartupPost,
        allowImagePosts: form.discoveryImageEnabled,
        allowVideoPosts: form.discoveryVideoEnabled,
        allowReplyImages: form.replyImageEnabled,
        allowReplyVideos: form.replyVideoEnabled,
        allowReplyGifs: form.replyGifEnabled,
        maxImagesPerDay: Number(form.maxImagesPerDay),
        maxVideosPerDay: Number(form.maxVideosPerDay),
        maxGifsPerDay: Number(form.maxGifsPerDay),
        simpleImageModel: form.discoverySimpleImageModel.trim(),
        complexImageModel: form.discoveryComplexImageModel.trim(),
        videoModel: form.discoveryVideoModel.trim(),
        allowedImageModels: parseUniqueList(form.discoveryAllowedImageModels),
        allowedVideoModels: parseUniqueList(form.discoveryAllowedVideoModels),
        linkChancePercent: discoveryExternalEnabled ? Number(form.discoveryLinkChance) : 0,
        maxLinksPerPost: Number(form.discoveryMaxLinks),
        maxCandidatesForPrompt: Number(form.discoveryMaxCandidates),
        freshnessHours: Number(form.discoveryFreshnessHours),
        dedupeHours: Number(form.discoveryDedupeHours),
        randomness: Number(form.discoveryRandomness),
        sourceFetchLimit: Number(form.discoveryFetchLimit),
        allowNsfw: discoveryExternalEnabled ? form.discoveryAllowNsfw : false,
        preferredTopics: parseUniqueList(form.discoveryPreferredTopics),
        redditSubreddits: parseUniqueList(form.discoveryRedditSubs),
        youtubeChannelIds: parseUniqueList(form.discoveryYoutubeChannels),
        rssFeeds: parseUniqueList(form.discoveryRssFeeds),
        xHandles: parseUniqueList(form.discoveryXHandles),
        xNitterBaseUrl: form.discoveryXNitterBase.trim(),
        sources: {
          reddit: discoveryExternalEnabled ? form.discoverySourceReddit : false,
          hackerNews: discoveryExternalEnabled ? form.discoverySourceHackerNews : false,
          youtube: discoveryExternalEnabled ? form.discoverySourceYoutube : false,
          rss: discoveryExternalEnabled ? form.discoverySourceRss : false,
          x: discoveryExternalEnabled ? form.discoverySourceX : false
        }
      }
    },
    voice: {
      enabled: form.voiceEnabled,
      transcription: {
        enabled: Boolean(form.voiceAsrEnabled),
        languageMode: String(form.voiceAsrLanguageMode || "").trim(),
        languageHint: String(form.voiceAsrLanguageHint || "").trim()
      },
      channelPolicy: {
        allowedChannelIds: parseUniqueList(form.voiceAllowedChannelIds),
        blockedChannelIds: parseUniqueList(form.voiceBlockedChannelIds),
        blockedUserIds: parseUniqueList(form.voiceBlockedUserIds)
      },
      sessionLimits: {
        maxSessionMinutes: Number(form.voiceMaxSessionMinutes),
        inactivityLeaveSeconds: Number(form.voiceInactivityLeaveSeconds),
        maxSessionsPerDay: Number(form.voiceMaxSessionsPerDay),
        maxConcurrentSessions: Number(form.subAgentMaxConcurrentSessions || 1)
      },
      conversationPolicy: {
        replyEagerness: Number(form.voiceReplyEagerness),
        commandOnlyMode: Boolean(form.voiceCommandOnlyMode),
        allowNsfwHumor: form.voiceAllowNsfwHumor,
        textOnlyMode: Boolean(form.voiceTextOnlyMode),
        replyPath: String(form.voiceReplyPath || "bridge").trim().toLowerCase(),
        ttsMode: String(form.voiceTtsMode || "realtime").trim().toLowerCase(),
        operationalMessages: String(form.voiceOperationalMessages || "all").trim().toLowerCase()
      },
      admission: {
        mode: String(form.voiceReplyDecisionRealtimeAdmissionMode || "adaptive").trim().toLowerCase(),
        intentConfidenceThreshold: Number(form.voiceIntentConfidenceThreshold),
        musicWakeLatchSeconds: Number(form.voiceReplyDecisionMusicWakeLatchSeconds)
      },
      streamWatch: {
        enabled: form.voiceStreamWatchEnabled,
        minCommentaryIntervalSeconds: Number(form.voiceStreamWatchMinCommentaryIntervalSeconds),
        maxFramesPerMinute: Number(form.voiceStreamWatchMaxFramesPerMinute),
        maxFrameBytes: Number(form.voiceStreamWatchMaxFrameBytes),
        commentaryPath: String(form.voiceStreamWatchCommentaryPath || "").trim(),
        keyframeIntervalMs: Number(form.voiceStreamWatchKeyframeIntervalMs),
        autonomousCommentaryEnabled: Boolean(form.voiceStreamWatchAutonomousCommentaryEnabled),
        brainContextEnabled: Boolean(form.voiceStreamWatchBrainContextEnabled),
        brainContextMinIntervalSeconds: Number(form.voiceStreamWatchBrainContextMinIntervalSeconds),
        brainContextMaxEntries: Number(form.voiceStreamWatchBrainContextMaxEntries),
        brainContextPrompt: String(form.voiceStreamWatchBrainContextPrompt || "").trim(),
        sharePageMaxWidthPx: Number(form.voiceStreamWatchSharePageMaxWidthPx),
        sharePageJpegQuality: Number(form.voiceStreamWatchSharePageJpegQuality)
      },
      soundboard: {
        enabled: form.voiceSoundboardEnabled,
        allowExternalSounds: form.voiceSoundboardAllowExternalSounds,
        preferredSoundIds: parseUniqueList(form.voiceSoundboardPreferredSoundIds)
      }
    },
    media: {
      vision: {
        enabled: Boolean(form.visionCaptionEnabled),
        execution: {
          mode: "dedicated_model",
          model: {
            provider: String(form.visionProvider || "").trim(),
            model: String(form.visionModel || "").trim()
          }
        },
        maxAutoIncludeImages: Number(form.visionMaxAutoIncludeImages),
        maxCaptionsPerHour: Number(form.visionMaxCaptionsPerHour)
      },
      videoContext: {
        enabled: form.videoContextEnabled,
        maxLookupsPerHour: Number(form.videoContextPerHour),
        maxVideosPerMessage: Number(form.videoContextMaxVideos),
        maxTranscriptChars: Number(form.videoContextMaxChars),
        keyframeIntervalSeconds: Number(form.videoContextKeyframeInterval),
        maxKeyframesPerVideo: Number(form.videoContextMaxKeyframes),
        allowAsrFallback: form.videoContextAsrFallback,
        maxAsrSeconds: Number(form.videoContextMaxAsrSeconds)
      }
    },
    automations: {
      enabled: Boolean(form.automationsEnabled)
    }
  };
}

export function sanitizeAliasListInput(value: unknown) {
  return formatCommaList(parseUniqueList(value));
}

const LIST_FORM_KEYS: ReadonlySet<string> = new Set([
  "botNameAliases",
  "personaHardLimits",
  "promptTextGuidance",
  "promptVoiceGuidance",
  "promptVoiceOperationalGuidance",
  "voiceAllowedChannelIds",
  "voiceBlockedChannelIds",
  "voiceBlockedUserIds",
  "voiceSoundboardPreferredSoundIds",
  "discoveryAllowedImageModels",
  "discoveryAllowedVideoModels",
  "discoveryPreferredTopics",
  "discoveryRedditSubs",
  "discoveryYoutubeChannels",
  "discoveryRssFeeds",
  "discoveryXHandles",
  "codeAgentAllowedUserIds",
  "replyChannels",
  "discoveryChannels",
  "allowedChannels",
  "blockedChannels",
  "blockedUsers"
]);

export function settingsToFormPreserving(
  settings: unknown,
  currentForm: SettingsForm | null | undefined
) {
  const next = settingsToForm(settings);
  if (!currentForm) return next;
  const result = { ...next };
  for (const key of LIST_FORM_KEYS) {
    const cur = currentForm[key];
    const nxt = result[key];
    if (typeof cur !== "string" || typeof nxt !== "string" || cur === nxt) continue;
    const curParsed = parseUniqueList(cur);
    const nxtParsed = parseUniqueList(nxt);
    if (curParsed.length === nxtParsed.length && curParsed.every((v, i) => v === nxtParsed[i])) {
      result[key] = cur;
    }
  }
  return result;
}

export function resolveProviderModelOptions(modelCatalog: Record<string, unknown> | null | undefined, provider: unknown) {
  const key = normalizeLlmProvider(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = PROVIDER_MODEL_FALLBACKS[key] || [];
  return normalizeBoundedStringList([...fromCatalog, ...fallback], { maxItems: 80, maxLen: 120 });
}

export function resolveBrowserProviderModelOptions(
  modelCatalog: Record<string, unknown> | null | undefined,
  provider: unknown
) {
  const key = normalizeLlmProvider(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = Array.isArray(BROWSER_PROVIDER_MODEL_FALLBACKS[key])
    ? BROWSER_PROVIDER_MODEL_FALLBACKS[key]
    : [];
  return normalizeBoundedStringList([...fromCatalog, ...fallback], { maxItems: 80, maxLen: 120 });
}

export function resolveModelOptions(...sources: unknown[]) {
  const combined: unknown[] = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      combined.push(...source);
      continue;
    }
    combined.push(source);
  }
  return normalizeBoundedStringList(combined, { maxItems: 80, maxLen: 140 });
}

export function resolveModelOptionsFromText(value: unknown, ...sources: unknown[]) {
  return resolveModelOptions(parseUniqueLineList(value), ...sources);
}

export function resolvePresetModelSelection({
  modelCatalog,
  provider,
  model
}: {
  modelCatalog: Record<string, unknown> | null | undefined;
  provider: unknown;
  model: unknown;
}) {
  const options = resolveProviderModelOptions(modelCatalog, provider);
  const normalizedModel = String(model || "").trim();
  const selectedPresetModel = options.includes(normalizedModel)
    ? normalizedModel
    : (options[0] || "");

  return {
    options,
    selectedPresetModel
  };
}
