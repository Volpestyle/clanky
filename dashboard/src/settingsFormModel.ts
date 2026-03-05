import { DEFAULT_SETTINGS, PROVIDER_MODEL_FALLBACKS } from "../../src/settings/settingsSchema.ts";
import { normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";
import {
  formatLineList,
  normalizeBoundedStringList,
  parseUniqueLineList,
  parseUniqueList
} from "../../src/settings/listNormalization.ts";

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

export function settingsToForm(settings) {
  const defaults = DEFAULT_SETTINGS;
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
  const activity = settings?.activity ?? {};
  const selectedVoiceProvider = settings?.voice?.voiceProvider ?? defaultVoice.voiceProvider;
  return {
    botName: settings?.botName ?? defaults.botName,
    botNameAliases: formatLineList(settings?.botNameAliases ?? defaults.botNameAliases),
    personaFlavor: settings?.persona?.flavor ?? defaults.persona.flavor,
    personaHardLimits: formatLineList(settings?.persona?.hardLimits),
    promptCapabilityHonestyLine: settings?.prompt?.capabilityHonestyLine ?? defaultPrompt.capabilityHonestyLine,
    promptImpossibleActionLine:
      settings?.prompt?.impossibleActionLine ?? defaultPrompt.impossibleActionLine,
    promptMemoryEnabledLine:
      settings?.prompt?.memoryEnabledLine ?? defaultPrompt.memoryEnabledLine,
    promptMemoryDisabledLine:
      settings?.prompt?.memoryDisabledLine ?? defaultPrompt.memoryDisabledLine,
    promptSkipLine: settings?.prompt?.skipLine ?? defaultPrompt.skipLine,
    promptTextGuidance: formatLineList(settings?.prompt?.textGuidance ?? defaultPrompt.textGuidance),
    promptVoiceGuidance: formatLineList(settings?.prompt?.voiceGuidance ?? defaultPrompt.voiceGuidance),
    promptVoiceOperationalGuidance:
      formatLineList(settings?.prompt?.voiceOperationalGuidance ?? defaultPrompt.voiceOperationalGuidance),
    promptVoiceLookupBusySystemPrompt:
      settings?.prompt?.voiceLookupBusySystemPrompt ?? defaultPrompt.voiceLookupBusySystemPrompt,
    promptMediaPromptCraftGuidance: settings?.prompt?.mediaPromptCraftGuidance ?? defaultPrompt.mediaPromptCraftGuidance,
    replyLevelReplyChannels:
      activity.replyLevelReplyChannels ?? defaultActivity.replyLevelReplyChannels,
    replyLevelOtherChannels:
      activity.replyLevelOtherChannels ?? defaultActivity.replyLevelOtherChannels,
    reactionLevel: activity.reactionLevel ?? defaultActivity.reactionLevel,
    minGap: activity.minSecondsBetweenMessages ?? defaultActivity.minSecondsBetweenMessages,
    allowReplies: settings?.permissions?.allowReplies ?? defaultPermissions.allowReplies,
    allowUnsolicitedReplies:
      settings?.permissions?.allowUnsolicitedReplies ?? defaultPermissions.allowUnsolicitedReplies,
    allowReactions: settings?.permissions?.allowReactions ?? defaultPermissions.allowReactions,
    textThoughtLoopEnabled:
      settings?.textThoughtLoop?.enabled ?? defaultTextThoughtLoop.enabled,
    textThoughtLoopEagerness:
      settings?.textThoughtLoop?.eagerness ?? defaultTextThoughtLoop.eagerness,
    textThoughtLoopMinMinutesBetweenThoughts:
      settings?.textThoughtLoop?.minMinutesBetweenThoughts ??
      defaultTextThoughtLoop.minMinutesBetweenThoughts,
    textThoughtLoopMaxThoughtsPerDay:
      settings?.textThoughtLoop?.maxThoughtsPerDay ?? defaultTextThoughtLoop.maxThoughtsPerDay,
    textThoughtLoopLookbackMessages:
      settings?.textThoughtLoop?.lookbackMessages ?? defaultTextThoughtLoop.lookbackMessages,
    memoryEnabled: settings?.memory?.enabled ?? defaults.memory.enabled,
    adaptiveDirectivesEnabled:
      settings?.adaptiveDirectives?.enabled ?? defaults.adaptiveDirectives.enabled,
    automationsEnabled:
      settings?.automations?.enabled ?? defaults.automations.enabled,
    memoryReflectionStrategy:
      settings?.memory?.reflection?.strategy ?? defaults.memory.reflection.strategy,
    provider: settings?.llm?.provider ?? defaultLlm.provider,
    model: settings?.llm?.model ?? defaultLlm.model,
    replyFollowupLlmEnabled: settings?.replyFollowupLlm?.enabled ?? defaultReplyFollowupLlm.enabled,
    replyFollowupLlmProvider: settings?.replyFollowupLlm?.provider ?? defaultReplyFollowupLlm.provider,
    replyFollowupLlmModel: settings?.replyFollowupLlm?.model ?? defaultReplyFollowupLlm.model,
    replyFollowupMaxToolSteps: settings?.replyFollowupLlm?.maxToolSteps ?? defaultReplyFollowupLlm.maxToolSteps,
    replyFollowupMaxTotalToolCalls:
      settings?.replyFollowupLlm?.maxTotalToolCalls ?? defaultReplyFollowupLlm.maxTotalToolCalls,
    replyFollowupMaxWebSearchCalls:
      settings?.replyFollowupLlm?.maxWebSearchCalls ?? defaultReplyFollowupLlm.maxWebSearchCalls,
    replyFollowupMaxMemoryLookupCalls:
      settings?.replyFollowupLlm?.maxMemoryLookupCalls ?? defaultReplyFollowupLlm.maxMemoryLookupCalls,
    replyFollowupMaxImageLookupCalls:
      settings?.replyFollowupLlm?.maxImageLookupCalls ?? defaultReplyFollowupLlm.maxImageLookupCalls,
    replyFollowupToolTimeoutMs:
      settings?.replyFollowupLlm?.toolTimeoutMs ?? defaultReplyFollowupLlm.toolTimeoutMs,
    memoryLlmProvider: settings?.memoryLlm?.provider ?? defaultMemoryLlm.provider,
    memoryLlmModel: settings?.memoryLlm?.model ?? defaultMemoryLlm.model,
    temperature: settings?.llm?.temperature ?? defaultLlm.temperature,
    maxTokens: settings?.llm?.maxOutputTokens ?? defaultLlm.maxOutputTokens,
    browserEnabled: settings?.browser?.enabled ?? defaults.browser.enabled,
    browserMaxPerHour: settings?.browser?.maxBrowseCallsPerHour ?? defaults.browser.maxBrowseCallsPerHour,
    browserLlmProvider: settings?.browser?.llm?.provider ?? defaults.browser.llm.provider,
    browserLlmModel: settings?.browser?.llm?.model ?? defaults.browser.llm.model,
    browserMaxSteps: settings?.browser?.maxStepsPerTask ?? defaults.browser.maxStepsPerTask,
    browserStepTimeoutMs: settings?.browser?.stepTimeoutMs ?? defaults.browser.stepTimeoutMs,
    browserSessionTimeoutMs: settings?.browser?.sessionTimeoutMs ?? defaults.browser.sessionTimeoutMs,
    visionCaptionEnabled: settings?.vision?.captionEnabled ?? defaultVision.captionEnabled,
    visionProvider: settings?.vision?.provider ?? defaultVision.provider,
    visionModel: settings?.vision?.model ?? defaultVision.model,
    visionMaxAutoIncludeImages: settings?.vision?.maxAutoIncludeImages ?? defaultVision.maxAutoIncludeImages,
    visionMaxCaptionsPerHour: settings?.vision?.maxCaptionsPerHour ?? defaultVision.maxCaptionsPerHour,
    webSearchEnabled: settings?.webSearch?.enabled ?? defaultWebSearch.enabled,
    webSearchSafeMode: settings?.webSearch?.safeSearch ?? defaultWebSearch.safeSearch,
    webSearchPerHour: settings?.webSearch?.maxSearchesPerHour ?? defaultWebSearch.maxSearchesPerHour,
    webSearchMaxResults: settings?.webSearch?.maxResults ?? defaultWebSearch.maxResults,
    webSearchMaxPages: settings?.webSearch?.maxPagesToRead ?? defaultWebSearch.maxPagesToRead,
    webSearchMaxChars: settings?.webSearch?.maxCharsPerPage ?? defaultWebSearch.maxCharsPerPage,
    webSearchProviderOrder: (settings?.webSearch?.providerOrder || defaultWebSearch.providerOrder).join(","),
    webSearchRecencyDaysDefault: settings?.webSearch?.recencyDaysDefault ?? defaultWebSearch.recencyDaysDefault,
    webSearchMaxConcurrentFetches: settings?.webSearch?.maxConcurrentFetches ?? defaultWebSearch.maxConcurrentFetches,
    videoContextEnabled: settings?.videoContext?.enabled ?? defaultVideoContext.enabled,
    videoContextPerHour: settings?.videoContext?.maxLookupsPerHour ?? defaultVideoContext.maxLookupsPerHour,
    videoContextMaxVideos: settings?.videoContext?.maxVideosPerMessage ?? defaultVideoContext.maxVideosPerMessage,
    videoContextMaxChars: settings?.videoContext?.maxTranscriptChars ?? defaultVideoContext.maxTranscriptChars,
    videoContextKeyframeInterval: settings?.videoContext?.keyframeIntervalSeconds ?? defaultVideoContext.keyframeIntervalSeconds,
    videoContextMaxKeyframes: settings?.videoContext?.maxKeyframesPerVideo ?? defaultVideoContext.maxKeyframesPerVideo,
    videoContextAsrFallback: settings?.videoContext?.allowAsrFallback ?? defaultVideoContext.allowAsrFallback,
    videoContextMaxAsrSeconds: settings?.videoContext?.maxAsrSeconds ?? defaultVideoContext.maxAsrSeconds,
    voiceEnabled: settings?.voice?.enabled ?? defaultVoice.enabled,
    voiceProvider: selectedVoiceProvider,
    voiceReplyPath: settings?.voice?.replyPath ?? (settings?.voice?.realtimeReplyStrategy === "native" ? "native" : "bridge"),
    voiceBrainProvider: settings?.voice?.brainProvider ?? defaultVoice.brainProvider,
    voiceAsrLanguageMode: settings?.voice?.asrLanguageMode ?? defaultVoice.asrLanguageMode,
    voiceAsrLanguageHint: settings?.voice?.asrLanguageHint ?? defaultVoice.asrLanguageHint,
    voiceAllowNsfwHumor: settings?.voice?.allowNsfwHumor ?? defaultVoice.allowNsfwHumor,
    voiceIntentConfidenceThreshold: settings?.voice?.intentConfidenceThreshold ?? defaultVoice.intentConfidenceThreshold,
    voiceMaxSessionMinutes: settings?.voice?.maxSessionMinutes ?? defaultVoice.maxSessionMinutes,
    voiceInactivityLeaveSeconds: settings?.voice?.inactivityLeaveSeconds ?? defaultVoice.inactivityLeaveSeconds,
    voiceMaxSessionsPerDay: settings?.voice?.maxSessionsPerDay ?? defaultVoice.maxSessionsPerDay,
    voiceReplyEagerness: settings?.voice?.replyEagerness ?? defaultVoice.replyEagerness,
    voiceCommandOnlyMode: settings?.voice?.commandOnlyMode ?? defaultVoice.commandOnlyMode,
    voiceThoughtEngineEnabled:
      settings?.voice?.thoughtEngine?.enabled ?? defaultVoiceThoughtEngine.enabled,
    voiceThoughtEngineProvider:
      settings?.voice?.thoughtEngine?.provider ?? defaultVoiceThoughtEngine.provider,
    voiceThoughtEngineModel:
      settings?.voice?.thoughtEngine?.model ?? defaultVoiceThoughtEngine.model,
    voiceThoughtEngineTemperature:
      settings?.voice?.thoughtEngine?.temperature ?? defaultVoiceThoughtEngine.temperature,
    voiceThoughtEngineEagerness:
      settings?.voice?.thoughtEngine?.eagerness ?? defaultVoiceThoughtEngine.eagerness,
    voiceThoughtEngineMinSilenceSeconds:
      settings?.voice?.thoughtEngine?.minSilenceSeconds ?? defaultVoiceThoughtEngine.minSilenceSeconds,
    voiceThoughtEngineMinSecondsBetweenThoughts:
      settings?.voice?.thoughtEngine?.minSecondsBetweenThoughts ??
      defaultVoiceThoughtEngine.minSecondsBetweenThoughts,
    voiceReplyDecisionLlmProvider:
      settings?.voice?.replyDecisionLlm?.provider ?? defaultVoice.replyDecisionLlm.provider,
    voiceReplyDecisionLlmModel:
      settings?.voice?.replyDecisionLlm?.model ?? defaultVoice.replyDecisionLlm.model,
    voiceGenerationLlmUseTextModel:
      settings?.voice?.generationLlm?.useTextModel ?? defaultVoiceGenerationLlm.useTextModel,
    voiceGenerationLlmProvider:
      settings?.voice?.generationLlm?.provider ?? defaultVoiceGenerationLlm.provider,
    voiceGenerationLlmModel:
      settings?.voice?.generationLlm?.model ?? defaultVoiceGenerationLlm.model,
    voiceAllowedChannelIds: formatLineList(settings?.voice?.allowedVoiceChannelIds),
    voiceBlockedChannelIds: formatLineList(settings?.voice?.blockedVoiceChannelIds),
    voiceBlockedUserIds: formatLineList(settings?.voice?.blockedVoiceUserIds),
    voiceXaiVoice: settings?.voice?.xai?.voice ?? defaultVoiceXai.voice,
    voiceXaiAudioFormat: settings?.voice?.xai?.audioFormat ?? defaultVoiceXai.audioFormat,
    voiceXaiSampleRateHz: settings?.voice?.xai?.sampleRateHz ?? defaultVoiceXai.sampleRateHz,
    voiceXaiRegion: settings?.voice?.xai?.region ?? defaultVoiceXai.region,
    voiceOpenAiRealtimeModel: settings?.voice?.openaiRealtime?.model ?? defaultVoiceOpenAiRealtime.model,
    voiceOpenAiRealtimeVoice: settings?.voice?.openaiRealtime?.voice ?? defaultVoiceOpenAiRealtime.voice,
    voiceOpenAiRealtimeTranscriptionMethod:
      settings?.voice?.openaiRealtime?.transcriptionMethod ?? defaultVoiceOpenAiRealtime.transcriptionMethod,
    voiceOpenAiRealtimeInputTranscriptionModel:
      settings?.voice?.openaiRealtime?.inputTranscriptionModel ?? defaultVoiceOpenAiRealtime.inputTranscriptionModel,
    voiceOpenAiRealtimeUsePerUserAsrBridge:
      settings?.voice?.openaiRealtime?.usePerUserAsrBridge ?? defaultVoiceOpenAiRealtime.usePerUserAsrBridge,
    voiceElevenLabsRealtimeAgentId:
      settings?.voice?.elevenLabsRealtime?.agentId ?? defaultVoiceElevenLabsRealtime.agentId,
    voiceElevenLabsRealtimeVoiceId:
      settings?.voice?.elevenLabsRealtime?.voiceId ?? defaultVoiceElevenLabsRealtime.voiceId,
    voiceElevenLabsRealtimeApiBaseUrl:
      settings?.voice?.elevenLabsRealtime?.apiBaseUrl ?? defaultVoiceElevenLabsRealtime.apiBaseUrl,
    voiceElevenLabsRealtimeInputSampleRateHz:
      settings?.voice?.elevenLabsRealtime?.inputSampleRateHz ?? defaultVoiceElevenLabsRealtime.inputSampleRateHz,
    voiceElevenLabsRealtimeOutputSampleRateHz:
      settings?.voice?.elevenLabsRealtime?.outputSampleRateHz ?? defaultVoiceElevenLabsRealtime.outputSampleRateHz,
    voiceGeminiRealtimeModel:
      settings?.voice?.geminiRealtime?.model ?? defaultVoiceGeminiRealtime.model,
    voiceGeminiRealtimeVoice: settings?.voice?.geminiRealtime?.voice ?? defaultVoiceGeminiRealtime.voice,
    voiceGeminiRealtimeApiBaseUrl:
      settings?.voice?.geminiRealtime?.apiBaseUrl ?? defaultVoiceGeminiRealtime.apiBaseUrl,
    voiceGeminiRealtimeInputSampleRateHz: settings?.voice?.geminiRealtime?.inputSampleRateHz ?? defaultVoiceGeminiRealtime.inputSampleRateHz,
    voiceGeminiRealtimeOutputSampleRateHz: settings?.voice?.geminiRealtime?.outputSampleRateHz ?? defaultVoiceGeminiRealtime.outputSampleRateHz,
    voiceStreamWatchEnabled: settings?.voice?.streamWatch?.enabled ?? defaultVoiceStreamWatch.enabled,
    voiceStreamWatchMinCommentaryIntervalSeconds:
      settings?.voice?.streamWatch?.minCommentaryIntervalSeconds ?? defaultVoiceStreamWatch.minCommentaryIntervalSeconds,
    voiceStreamWatchMaxFramesPerMinute: settings?.voice?.streamWatch?.maxFramesPerMinute ?? defaultVoiceStreamWatch.maxFramesPerMinute,
    voiceStreamWatchMaxFrameBytes: settings?.voice?.streamWatch?.maxFrameBytes ?? defaultVoiceStreamWatch.maxFrameBytes,
    voiceStreamWatchCommentaryPath:
      settings?.voice?.streamWatch?.commentaryPath ?? defaultVoiceStreamWatch.commentaryPath,
    voiceStreamWatchKeyframeIntervalMs:
      settings?.voice?.streamWatch?.keyframeIntervalMs ?? defaultVoiceStreamWatch.keyframeIntervalMs,
    voiceStreamWatchAutonomousCommentaryEnabled:
      settings?.voice?.streamWatch?.autonomousCommentaryEnabled ?? defaultVoiceStreamWatch.autonomousCommentaryEnabled,
    voiceStreamWatchBrainContextEnabled:
      settings?.voice?.streamWatch?.brainContextEnabled ?? defaultVoiceStreamWatch.brainContextEnabled,
    voiceStreamWatchBrainContextMinIntervalSeconds:
      settings?.voice?.streamWatch?.brainContextMinIntervalSeconds ??
      defaultVoiceStreamWatch.brainContextMinIntervalSeconds,
    voiceStreamWatchBrainContextMaxEntries:
      settings?.voice?.streamWatch?.brainContextMaxEntries ?? defaultVoiceStreamWatch.brainContextMaxEntries,
    voiceStreamWatchBrainContextPrompt:
      settings?.voice?.streamWatch?.brainContextPrompt ?? defaultVoiceStreamWatch.brainContextPrompt,
    voiceStreamWatchSharePageMaxWidthPx:
      settings?.voice?.streamWatch?.sharePageMaxWidthPx ?? defaultVoiceStreamWatch.sharePageMaxWidthPx,
    voiceStreamWatchSharePageJpegQuality:
      settings?.voice?.streamWatch?.sharePageJpegQuality ?? defaultVoiceStreamWatch.sharePageJpegQuality,
    voiceSoundboardEnabled: settings?.voice?.soundboard?.enabled ?? defaultVoiceSoundboard.enabled,
    voiceSoundboardAllowExternalSounds: settings?.voice?.soundboard?.allowExternalSounds ?? defaultVoiceSoundboard.allowExternalSounds,
    voiceSoundboardPreferredSoundIds: formatLineList(settings?.voice?.soundboard?.preferredSoundIds),
    voiceAsrDuringMusic: settings?.voice?.asrDuringMusic ?? defaultVoice.asrDuringMusic ?? true,
    voiceAsrEnabled: settings?.voice?.asrEnabled ?? defaultVoice.asrEnabled ?? true,
    voiceOperationalMessages: settings?.voice?.operationalMessages ?? defaultVoice.operationalMessages ?? "all",
    maxMessages: settings?.permissions?.maxMessagesPerHour ?? defaultPermissions.maxMessagesPerHour,
    maxReactions: settings?.permissions?.maxReactionsPerHour ?? defaultPermissions.maxReactionsPerHour,
    catchupEnabled: settings?.startup?.catchupEnabled !== false,
    catchupLookbackHours: settings?.startup?.catchupLookbackHours ?? defaultStartup.catchupLookbackHours,
    catchupMaxMessages: settings?.startup?.catchupMaxMessagesPerChannel ?? defaultStartup.catchupMaxMessagesPerChannel,
    catchupMaxReplies: settings?.startup?.maxCatchupRepliesPerChannel ?? defaultStartup.maxCatchupRepliesPerChannel,
    discoveryEnabled: settings?.discovery?.enabled ?? defaultDiscovery.enabled,
    discoveryPostsPerDay:
      settings?.discovery?.maxPostsPerDay ?? defaultDiscovery.maxPostsPerDay,
    discoveryMinMinutes:
      settings?.discovery?.minMinutesBetweenPosts ?? defaultDiscovery.minMinutesBetweenPosts,
    discoveryPacingMode:
      settings?.discovery?.pacingMode === "spontaneous" ? "spontaneous" : "even",
    discoverySpontaneity:
      settings?.discovery?.spontaneity ?? defaultDiscovery.spontaneity,
    discoveryStartupPost:
      settings?.discovery?.postOnStartup ?? defaultDiscovery.postOnStartup,
    discoveryImageEnabled:
      settings?.discovery?.allowImagePosts ?? defaultDiscovery.allowImagePosts,
    discoveryVideoEnabled:
      settings?.discovery?.allowVideoPosts ?? defaultDiscovery.allowVideoPosts,
    replyImageEnabled:
      settings?.discovery?.allowReplyImages ?? defaultDiscovery.allowReplyImages,
    replyVideoEnabled:
      settings?.discovery?.allowReplyVideos ?? defaultDiscovery.allowReplyVideos,
    replyGifEnabled:
      settings?.discovery?.allowReplyGifs ?? defaultDiscovery.allowReplyGifs,
    maxImagesPerDay: settings?.discovery?.maxImagesPerDay ?? defaultDiscovery.maxImagesPerDay,
    maxVideosPerDay: settings?.discovery?.maxVideosPerDay ?? defaultDiscovery.maxVideosPerDay,
    maxGifsPerDay: settings?.discovery?.maxGifsPerDay ?? defaultDiscovery.maxGifsPerDay,
    discoverySimpleImageModel:
      settings?.discovery?.simpleImageModel ?? defaultDiscovery.simpleImageModel,
    discoveryComplexImageModel:
      settings?.discovery?.complexImageModel ?? defaultDiscovery.complexImageModel,
    discoveryVideoModel:
      settings?.discovery?.videoModel ?? defaultDiscovery.videoModel,
    discoveryAllowedImageModels:
      formatLineList(settings?.discovery?.allowedImageModels ?? []),
    discoveryAllowedVideoModels:
      formatLineList(settings?.discovery?.allowedVideoModels ?? []),
    discoveryExternalEnabled:
      settings?.discovery?.linkChancePercent > 0 ||
      settings?.discovery?.sources?.reddit === true ||
      settings?.discovery?.sources?.hackerNews === true ||
      settings?.discovery?.sources?.youtube === true ||
      settings?.discovery?.sources?.rss === true ||
      settings?.discovery?.sources?.x === true,
    discoveryLinkChance:
      settings?.discovery?.linkChancePercent ?? defaultDiscovery.linkChancePercent,
    discoveryMaxLinks:
      settings?.discovery?.maxLinksPerPost ?? defaultDiscovery.maxLinksPerPost,
    discoveryMaxCandidates:
      settings?.discovery?.maxCandidatesForPrompt ?? defaultDiscovery.maxCandidatesForPrompt,
    discoveryFreshnessHours:
      settings?.discovery?.freshnessHours ?? defaultDiscovery.freshnessHours,
    discoveryDedupeHours:
      settings?.discovery?.dedupeHours ?? defaultDiscovery.dedupeHours,
    discoveryRandomness:
      settings?.discovery?.randomness ?? defaultDiscovery.randomness,
    discoveryFetchLimit:
      settings?.discovery?.sourceFetchLimit ?? defaultDiscovery.sourceFetchLimit,
    discoveryAllowNsfw:
      settings?.discovery?.allowNsfw ?? defaultDiscovery.allowNsfw,
    discoverySourceReddit:
      settings?.discovery?.sources?.reddit ?? defaultDiscovery.sources.reddit,
    discoverySourceHackerNews:
      settings?.discovery?.sources?.hackerNews ?? defaultDiscovery.sources.hackerNews,
    discoverySourceYoutube:
      settings?.discovery?.sources?.youtube ?? defaultDiscovery.sources.youtube,
    discoverySourceRss:
      settings?.discovery?.sources?.rss ?? defaultDiscovery.sources.rss,
    discoverySourceX:
      settings?.discovery?.sources?.x ?? defaultDiscovery.sources.x,
    discoveryPreferredTopics:
      formatLineList(settings?.discovery?.preferredTopics),
    discoveryRedditSubs:
      formatLineList(settings?.discovery?.redditSubreddits),
    discoveryYoutubeChannels:
      formatLineList(settings?.discovery?.youtubeChannelIds),
    discoveryRssFeeds:
      formatLineList(settings?.discovery?.rssFeeds),
    discoveryXHandles:
      formatLineList(settings?.discovery?.xHandles),
    discoveryXNitterBase:
      settings?.discovery?.xNitterBaseUrl ?? defaultDiscovery.xNitterBaseUrl,
    replyChannels: formatLineList(settings?.permissions?.replyChannelIds),
    discoveryChannels: formatLineList(settings?.discovery?.channelIds),
    allowedChannels: formatLineList(settings?.permissions?.allowedChannelIds),
    blockedChannels: formatLineList(settings?.permissions?.blockedChannelIds),
    blockedUsers: formatLineList(settings?.permissions?.blockedUserIds)
  };
}

export function formToSettingsPatch(form) {
  const discoveryExternalEnabled = Boolean(form.discoveryExternalEnabled);
  return {
    botName: form.botName.trim(),
    botNameAliases: parseUniqueList(form.botNameAliases),
    persona: {
      flavor: form.personaFlavor.trim(),
      hardLimits: parseUniqueLineList(form.personaHardLimits)
    },
    prompt: {
      capabilityHonestyLine: String(form.promptCapabilityHonestyLine || "").trim(),
      impossibleActionLine: String(form.promptImpossibleActionLine || "").trim(),
      memoryEnabledLine: String(form.promptMemoryEnabledLine || "").trim(),
      memoryDisabledLine: String(form.promptMemoryDisabledLine || "").trim(),
      skipLine: String(form.promptSkipLine || "").trim(),
      textGuidance: parseUniqueLineList(form.promptTextGuidance),
      voiceGuidance: parseUniqueLineList(form.promptVoiceGuidance),
      voiceOperationalGuidance: parseUniqueLineList(form.promptVoiceOperationalGuidance),
      voiceLookupBusySystemPrompt: String(form.promptVoiceLookupBusySystemPrompt || "").trim(),
      mediaPromptCraftGuidance: String(form.promptMediaPromptCraftGuidance || "").trim()
    },
    activity: {
      replyLevelReplyChannels: Number(form.replyLevelReplyChannels),
      replyLevelOtherChannels: Number(form.replyLevelOtherChannels),
      reactionLevel: Number(form.reactionLevel),
      minSecondsBetweenMessages: Number(form.minGap)
    },
    textThoughtLoop: {
      enabled: Boolean(form.textThoughtLoopEnabled),
      eagerness: Number(form.textThoughtLoopEagerness),
      minMinutesBetweenThoughts: Number(form.textThoughtLoopMinMinutesBetweenThoughts),
      maxThoughtsPerDay: Number(form.textThoughtLoopMaxThoughtsPerDay),
      lookbackMessages: Number(form.textThoughtLoopLookbackMessages)
    },
    llm: {
      provider: form.provider,
      model: form.model.trim(),
      temperature: Number(form.temperature),
      maxOutputTokens: Number(form.maxTokens)
    },
    replyFollowupLlm: {
      enabled: Boolean(form.replyFollowupLlmEnabled),
      provider: String(form.replyFollowupLlmProvider || "").trim(),
      model: String(form.replyFollowupLlmModel || "").trim(),
      maxToolSteps: Number(form.replyFollowupMaxToolSteps),
      maxTotalToolCalls: Number(form.replyFollowupMaxTotalToolCalls),
      maxWebSearchCalls: Number(form.replyFollowupMaxWebSearchCalls),
      maxMemoryLookupCalls: Number(form.replyFollowupMaxMemoryLookupCalls),
      maxImageLookupCalls: Number(form.replyFollowupMaxImageLookupCalls),
      toolTimeoutMs: Number(form.replyFollowupToolTimeoutMs)
    },
    memoryLlm: {
      provider: String(form.memoryLlmProvider || "").trim(),
      model: String(form.memoryLlmModel || "").trim()
    },
    browser: {
      enabled: form.browserEnabled,
      maxBrowseCallsPerHour: Number(form.browserMaxPerHour),
      llm: {
        provider: String(form.browserLlmProvider || "").trim(),
        model: String(form.browserLlmModel || "").trim()
      },
      maxStepsPerTask: Number(form.browserMaxSteps),
      stepTimeoutMs: Number(form.browserStepTimeoutMs),
      sessionTimeoutMs: Number(form.browserSessionTimeoutMs)
    },
    vision: {
      captionEnabled: Boolean(form.visionCaptionEnabled),
      provider: String(form.visionProvider || "").trim(),
      model: String(form.visionModel || "").trim(),
      maxAutoIncludeImages: Number(form.visionMaxAutoIncludeImages),
      maxCaptionsPerHour: Number(form.visionMaxCaptionsPerHour)
    },
    webSearch: {
      enabled: form.webSearchEnabled,
      maxSearchesPerHour: Number(form.webSearchPerHour),
      maxResults: Number(form.webSearchMaxResults),
      maxPagesToRead: Number(form.webSearchMaxPages),
      maxCharsPerPage: Number(form.webSearchMaxChars),
      safeSearch: form.webSearchSafeMode,
      providerOrder: parseUniqueList(form.webSearchProviderOrder),
      recencyDaysDefault: Number(form.webSearchRecencyDaysDefault),
      maxConcurrentFetches: Number(form.webSearchMaxConcurrentFetches)
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
    },
    voice: {
      enabled: form.voiceEnabled,
      voiceProvider: String(form.voiceProvider || "openai").trim(),
      replyPath: String(form.voiceReplyPath || "bridge").trim().toLowerCase(),
      brainProvider:
        String(form.voiceBrainProvider || "openai").trim().toLowerCase() === "native"
          ? "openai"
          : String(form.voiceBrainProvider || "openai").trim(),
      transcriberProvider: "openai",
      asrLanguageMode: String(form.voiceAsrLanguageMode || "").trim(),
      asrLanguageHint: String(form.voiceAsrLanguageHint || "").trim(),
      allowNsfwHumor: form.voiceAllowNsfwHumor,
      intentConfidenceThreshold: Number(form.voiceIntentConfidenceThreshold),
      maxSessionMinutes: Number(form.voiceMaxSessionMinutes),
      inactivityLeaveSeconds: Number(form.voiceInactivityLeaveSeconds),
      maxSessionsPerDay: Number(form.voiceMaxSessionsPerDay),
      replyEagerness: Number(form.voiceReplyEagerness),
      commandOnlyMode: Boolean(form.voiceCommandOnlyMode),
      thoughtEngine: {
        enabled: Boolean(form.voiceThoughtEngineEnabled),
        provider: String(form.voiceThoughtEngineProvider || "").trim(),
        model: String(form.voiceThoughtEngineModel || "").trim(),
        temperature: Number(form.voiceThoughtEngineTemperature),
        eagerness: Number(form.voiceThoughtEngineEagerness),
        minSilenceSeconds: Number(form.voiceThoughtEngineMinSilenceSeconds),
        minSecondsBetweenThoughts: Number(form.voiceThoughtEngineMinSecondsBetweenThoughts)
      },
      replyDecisionLlm: {
        provider: String(form.voiceReplyDecisionLlmProvider || "").trim(),
        model: String(form.voiceReplyDecisionLlmModel || "").trim()
      },
      generationLlm: {
        useTextModel: Boolean(form.voiceGenerationLlmUseTextModel),
        provider: String(form.voiceGenerationLlmProvider || "").trim(),
        model: String(form.voiceGenerationLlmModel || "").trim()
      },
      allowedVoiceChannelIds: parseUniqueList(form.voiceAllowedChannelIds),
      blockedVoiceChannelIds: parseUniqueList(form.voiceBlockedChannelIds),
      blockedVoiceUserIds: parseUniqueList(form.voiceBlockedUserIds),
      xai: {
        voice: String(form.voiceXaiVoice || "").trim(),
        audioFormat: String(form.voiceXaiAudioFormat || "").trim(),
        sampleRateHz: Number(form.voiceXaiSampleRateHz),
        region: String(form.voiceXaiRegion || "").trim()
      },
      openaiRealtime: {
        model: String(form.voiceOpenAiRealtimeModel || "").trim(),
        voice: String(form.voiceOpenAiRealtimeVoice || "").trim(),
        inputAudioFormat: "pcm16",
        outputAudioFormat: "pcm16",
        transcriptionMethod: String(form.voiceOpenAiRealtimeTranscriptionMethod || "").trim().toLowerCase(),
        inputTranscriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim(),
        usePerUserAsrBridge: Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge)
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
      },
      asrDuringMusic: Boolean(form.voiceAsrDuringMusic),
      asrEnabled: Boolean(form.voiceAsrEnabled),
      operationalMessages: String(form.voiceOperationalMessages || "all").trim().toLowerCase()
    },
    startup: {
      catchupEnabled: form.catchupEnabled,
      catchupLookbackHours: Number(form.catchupLookbackHours),
      catchupMaxMessagesPerChannel: Number(form.catchupMaxMessages),
      maxCatchupRepliesPerChannel: Number(form.catchupMaxReplies)
    },
    permissions: {
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
    },
    memory: {
      enabled: form.memoryEnabled,
      reflection: {
        strategy: String(form.memoryReflectionStrategy || "").trim().toLowerCase() === "one_pass_main"
          ? "one_pass_main"
          : "two_pass_extract_then_main"
      }
    },
    adaptiveDirectives: {
      enabled: Boolean(form.adaptiveDirectivesEnabled)
    },
    automations: {
      enabled: Boolean(form.automationsEnabled)
    }
  };
}

export function sanitizeAliasListInput(value) {
  return formatLineList(parseUniqueList(value));
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
  "replyChannels",
  "discoveryChannels",
  "allowedChannels",
  "blockedChannels",
  "blockedUsers"
]);

export function settingsToFormPreserving(settings, currentForm) {
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

export function resolveProviderModelOptions(modelCatalog, provider) {
  const key = normalizeLlmProvider(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = PROVIDER_MODEL_FALLBACKS[key] || [];
  return normalizeBoundedStringList([...fromCatalog, ...fallback], { maxItems: 80, maxLen: 120 });
}

export function resolveBrowserProviderModelOptions(modelCatalog, provider) {
  const key = normalizeLlmProvider(provider);
  const fromCatalog = Array.isArray(modelCatalog?.[key]) ? modelCatalog[key] : [];
  const fallback = Array.isArray(BROWSER_PROVIDER_MODEL_FALLBACKS[key])
    ? BROWSER_PROVIDER_MODEL_FALLBACKS[key]
    : [];
  return normalizeBoundedStringList([...fromCatalog, ...fallback], { maxItems: 80, maxLen: 120 });
}

export function resolveModelOptions(...sources) {
  const combined = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      combined.push(...source);
      continue;
    }
    combined.push(source);
  }
  return normalizeBoundedStringList(combined, { maxItems: 80, maxLen: 140 });
}

export function resolveModelOptionsFromText(value, ...sources) {
  return resolveModelOptions(parseUniqueLineList(value), ...sources);
}

export function resolvePresetModelSelection({ modelCatalog, provider, model }) {
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
