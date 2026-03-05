import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeBoundedStringList } from "../settings/listNormalization.ts";
import {
  defaultModelForLlmProvider,
  normalizeLlmProvider,
  normalizeOpenAiReasoningEffort
} from "../llm/llmHelpers.ts";
import { normalizeProviderOrder } from "../search.ts";
import { clamp, deepMerge, uniqueIdList } from "../utils.ts";
import {
  normalizeVoiceProvider,
  normalizeBrainProvider,
  normalizeTranscriberProvider
} from "../voice/voiceModes.ts";
import {
  DEFAULT_PROMPT_VOICE_LOOKUP_BUSY_SYSTEM_PROMPT
} from "../promptCore.ts";
import {
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiRealtimeTranscriptionModel
} from "../voice/realtimeProviderNormalization.ts";

export const PERSONA_FLAVOR_MAX_CHARS = 2_000;
const BROWSER_LLM_PROVIDER_FALLBACK_MODELS = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-5-mini"
} as const;

function normalizeBrowserLlmProvider(value, fallback = "anthropic") {
  const provider = normalizeLlmProvider(value, fallback);
  return provider === "openai" || provider === "anthropic" ? provider : fallback;
}

function normalizeCodeAgentProvider(value, fallback = "claude-code") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "claude-code") return "claude-code";
  if (normalized === "codex") return "codex";
  if (normalized === "auto") return "auto";

  const fallbackProvider = String(fallback || "")
    .trim()
    .toLowerCase();
  if (fallbackProvider === "codex") return "codex";
  if (fallbackProvider === "auto") return "auto";
  return "claude-code";
}

export function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, raw ?? {});
  if (!merged.persona || typeof merged.persona !== "object") merged.persona = {};
  if (!merged.activity || typeof merged.activity !== "object") merged.activity = {};
  if (!merged.textThoughtLoop || typeof merged.textThoughtLoop !== "object") merged.textThoughtLoop = {};
  if (!merged.startup || typeof merged.startup !== "object") merged.startup = {};
  if (!merged.permissions || typeof merged.permissions !== "object") merged.permissions = {};
  if (!merged.discovery || typeof merged.discovery !== "object") merged.discovery = {};
  if (!merged.memory || typeof merged.memory !== "object") merged.memory = {};
  if (!merged.codeAgent || typeof merged.codeAgent !== "object") merged.codeAgent = {};
  if (!merged.adaptiveDirectives || typeof merged.adaptiveDirectives !== "object") merged.adaptiveDirectives = {};
  if (!merged.automations || typeof merged.automations !== "object") merged.automations = {};
  if (!merged.llm || typeof merged.llm !== "object") merged.llm = {};
  if (!merged.replyFollowupLlm || typeof merged.replyFollowupLlm !== "object") merged.replyFollowupLlm = {};
  if (!merged.memoryLlm || typeof merged.memoryLlm !== "object") merged.memoryLlm = {};
  const defaultMemoryLlmProvider = normalizeLlmProvider(DEFAULT_SETTINGS.memoryLlm?.provider || "anthropic");
  const normalizedMemoryProviderForDefaults = normalizeLlmProvider(
    merged.memoryLlm?.provider,
    defaultMemoryLlmProvider
  );
  const defaultMemoryLlmModel =
    normalizedMemoryProviderForDefaults === defaultMemoryLlmProvider
      ? String(DEFAULT_SETTINGS.memoryLlm?.model || "").trim()
      : "";
  const normalizedMemoryLlm = normalizeProviderModelPair(
    merged.memoryLlm,
    defaultMemoryLlmProvider,
    defaultMemoryLlmModel
  );
  merged.memoryLlm.provider = normalizedMemoryLlm.provider;
  merged.memoryLlm.model = normalizedMemoryLlm.model;
  if (!merged.webSearch || typeof merged.webSearch !== "object") merged.webSearch = {};
  if (!merged.browser || typeof merged.browser !== "object") merged.browser = {};
  if (!merged.browser.llm || typeof merged.browser.llm !== "object") merged.browser.llm = {};
  if (!merged.videoContext || typeof merged.videoContext !== "object") merged.videoContext = {};
  if (!merged.voice || typeof merged.voice !== "object") merged.voice = {};
  if (!merged.prompt || typeof merged.prompt !== "object") merged.prompt = {};

  merged.botName = String(merged.botName || "clanker conk").slice(0, 50);
  merged.botNameAliases = uniqueStringList(
    merged.botNameAliases,
    24,
    50
  );
  merged.persona.flavor = String(merged.persona?.flavor || DEFAULT_SETTINGS.persona.flavor).slice(
    0,
    PERSONA_FLAVOR_MAX_CHARS
  );
  merged.persona.hardLimits = normalizeHardLimitList(
    merged.persona?.hardLimits,
    DEFAULT_SETTINGS.persona?.hardLimits ?? []
  );

  const defaultPrompt = DEFAULT_SETTINGS.prompt;
  merged.prompt.capabilityHonestyLine = normalizePromptLine(
    merged.prompt?.capabilityHonestyLine,
    defaultPrompt.capabilityHonestyLine
  );
  merged.prompt.impossibleActionLine = normalizePromptLine(
    merged.prompt?.impossibleActionLine,
    defaultPrompt.impossibleActionLine
  );
  merged.prompt.memoryEnabledLine = normalizePromptLine(
    merged.prompt?.memoryEnabledLine,
    defaultPrompt.memoryEnabledLine
  );
  merged.prompt.memoryDisabledLine = normalizePromptLine(
    merged.prompt?.memoryDisabledLine,
    defaultPrompt.memoryDisabledLine
  );
  merged.prompt.skipLine = normalizePromptLine(
    merged.prompt?.skipLine,
    defaultPrompt.skipLine
  );
  merged.prompt.textGuidance = normalizePromptLineList(
    merged.prompt?.textGuidance,
    defaultPrompt.textGuidance
  );
  merged.prompt.voiceGuidance = normalizePromptLineList(
    merged.prompt?.voiceGuidance,
    defaultPrompt.voiceGuidance
  );
  merged.prompt.voiceOperationalGuidance = normalizePromptLineList(
    merged.prompt?.voiceOperationalGuidance,
    defaultPrompt.voiceOperationalGuidance
  );
  merged.prompt.voiceLookupBusySystemPrompt = normalizeLongPromptBlock(
    merged.prompt?.voiceLookupBusySystemPrompt,
    defaultPrompt.voiceLookupBusySystemPrompt ?? DEFAULT_PROMPT_VOICE_LOOKUP_BUSY_SYSTEM_PROMPT,
    4000
  );
  merged.prompt.mediaPromptCraftGuidance = normalizeLongPromptBlock(
    merged.prompt?.mediaPromptCraftGuidance,
    defaultPrompt.mediaPromptCraftGuidance,
    8_000
  );

  const replyLevelReplyChannels = clamp(
    Number(merged.activity?.replyLevelReplyChannels ?? DEFAULT_SETTINGS.activity.replyLevelReplyChannels) || 0,
    0,
    100
  );
  const replyLevelOtherChannels = clamp(
    Number(merged.activity?.replyLevelOtherChannels ?? DEFAULT_SETTINGS.activity.replyLevelOtherChannels) || 0,
    0,
    100
  );
  const reactionLevel = clamp(
    Number(merged.activity?.reactionLevel ?? DEFAULT_SETTINGS.activity.reactionLevel) || 0,
    0,
    100
  );
  const minSecondsBetweenMessages = clamp(
    Number(merged.activity?.minSecondsBetweenMessages) || 5,
    5,
    300
  );
  const replyCoalesceWindowSecondsRaw = Number(merged.activity?.replyCoalesceWindowSeconds);
  const replyCoalesceMaxMessagesRaw = Number(merged.activity?.replyCoalesceMaxMessages);
  const replyCoalesceWindowSeconds = clamp(
    Number.isFinite(replyCoalesceWindowSecondsRaw)
      ? replyCoalesceWindowSecondsRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceWindowSeconds) || 6,
    0,
    20
  );
  const replyCoalesceMaxMessages = clamp(
    Number.isFinite(replyCoalesceMaxMessagesRaw)
      ? replyCoalesceMaxMessagesRaw
      : Number(DEFAULT_SETTINGS.activity?.replyCoalesceMaxMessages) || 6,
    1,
    20
  );
  merged.activity = {
    replyLevelReplyChannels,
    replyLevelOtherChannels,
    reactionLevel,
    minSecondsBetweenMessages,
    replyCoalesceWindowSeconds,
    replyCoalesceMaxMessages
  };

  merged.textThoughtLoop.enabled =
    merged.textThoughtLoop?.enabled !== undefined
      ? Boolean(merged.textThoughtLoop?.enabled)
      : Boolean(DEFAULT_SETTINGS.textThoughtLoop?.enabled);
  merged.textThoughtLoop.eagerness = clamp(
    Number(merged.textThoughtLoop?.eagerness ?? DEFAULT_SETTINGS.textThoughtLoop?.eagerness) || 0,
    0,
    100
  );
  merged.textThoughtLoop.minMinutesBetweenThoughts = clamp(
    Number(
      merged.textThoughtLoop?.minMinutesBetweenThoughts ??
      DEFAULT_SETTINGS.textThoughtLoop?.minMinutesBetweenThoughts
    ) || 60,
    5,
    24 * 60
  );
  merged.textThoughtLoop.maxThoughtsPerDay = clamp(
    Number(merged.textThoughtLoop?.maxThoughtsPerDay ?? DEFAULT_SETTINGS.textThoughtLoop?.maxThoughtsPerDay) || 0,
    0,
    100
  );
  merged.textThoughtLoop.lookbackMessages = clamp(
    Number(merged.textThoughtLoop?.lookbackMessages ?? DEFAULT_SETTINGS.textThoughtLoop?.lookbackMessages) || 0,
    4,
    80
  );

  const defaultLlmProvider = normalizeLlmProvider(DEFAULT_SETTINGS.llm?.provider || "anthropic");
  const defaultLlmModel =
    normalizeLlmProvider(merged.llm?.provider, defaultLlmProvider) === defaultLlmProvider
      ? String(DEFAULT_SETTINGS.llm?.model || "").trim()
      : "";
  const normalizedLlm = normalizeProviderModelPair(
    merged.llm,
    defaultLlmProvider,
    defaultLlmModel
  );
  merged.llm.provider = normalizedLlm.provider;
  merged.llm.model = normalizedLlm.model;
  merged.llm.temperature = clamp(Number(merged.llm?.temperature) || 0.9, 0, 2);
  const defaultLlmMaxOutputTokens = Number(DEFAULT_SETTINGS.llm?.maxOutputTokens) || 800;
  const configuredLlmMaxOutputTokens = Number(merged.llm?.maxOutputTokens);
  const normalizedLlmMaxOutputTokens = Number.isFinite(configuredLlmMaxOutputTokens)
    ? Math.floor(configuredLlmMaxOutputTokens)
    : Math.floor(defaultLlmMaxOutputTokens);
  merged.llm.maxOutputTokens = Math.max(32, normalizedLlmMaxOutputTokens);
  merged.replyFollowupLlm.enabled =
    merged.replyFollowupLlm?.enabled !== undefined
      ? Boolean(merged.replyFollowupLlm?.enabled)
      : Boolean(DEFAULT_SETTINGS.replyFollowupLlm?.enabled);
  const normalizedReplyFollowupLlm = normalizeProviderModelPair(
    merged.replyFollowupLlm,
    merged.llm.provider || "anthropic",
    merged.llm.model || ""
  );
  merged.replyFollowupLlm.provider = normalizedReplyFollowupLlm.provider;
  merged.replyFollowupLlm.model = normalizedReplyFollowupLlm.model;
  delete merged.replyFollowupLlm.useTextModel;
  const defaultReplyFollowup = DEFAULT_SETTINGS.replyFollowupLlm;
  const maxToolStepsRaw = Number(merged.replyFollowupLlm?.maxToolSteps);
  const maxTotalToolCallsRaw = Number(merged.replyFollowupLlm?.maxTotalToolCalls);
  const maxWebSearchCallsRaw = Number(merged.replyFollowupLlm?.maxWebSearchCalls);
  const maxMemoryLookupCallsRaw = Number(merged.replyFollowupLlm?.maxMemoryLookupCalls);
  const maxImageLookupCallsRaw = Number(merged.replyFollowupLlm?.maxImageLookupCalls);
  const toolTimeoutMsRaw = Number(merged.replyFollowupLlm?.toolTimeoutMs);
  merged.replyFollowupLlm.maxToolSteps = clamp(
    Number.isFinite(maxToolStepsRaw)
      ? maxToolStepsRaw
      : Number(defaultReplyFollowup.maxToolSteps) || 2,
    0,
    6
  );
  merged.replyFollowupLlm.maxTotalToolCalls = clamp(
    Number.isFinite(maxTotalToolCallsRaw)
      ? maxTotalToolCallsRaw
      : Number(defaultReplyFollowup.maxTotalToolCalls) || 3,
    0,
    12
  );
  merged.replyFollowupLlm.maxWebSearchCalls = clamp(
    Number.isFinite(maxWebSearchCallsRaw)
      ? maxWebSearchCallsRaw
      : Number(defaultReplyFollowup.maxWebSearchCalls) || 2,
    0,
    6
  );
  merged.replyFollowupLlm.maxMemoryLookupCalls = clamp(
    Number.isFinite(maxMemoryLookupCallsRaw)
      ? maxMemoryLookupCallsRaw
      : Number(defaultReplyFollowup.maxMemoryLookupCalls) || 2,
    0,
    6
  );
  merged.replyFollowupLlm.maxImageLookupCalls = clamp(
    Number.isFinite(maxImageLookupCallsRaw)
      ? maxImageLookupCallsRaw
      : Number(defaultReplyFollowup.maxImageLookupCalls) || 2,
    0,
    6
  );
  merged.replyFollowupLlm.toolTimeoutMs = clamp(
    Number.isFinite(toolTimeoutMsRaw)
      ? toolTimeoutMsRaw
      : Number(defaultReplyFollowup.toolTimeoutMs) || 10_000,
    0,
    60_000
  );

  merged.webSearch.enabled = Boolean(merged.webSearch?.enabled);
  const maxSearchesRaw = Number(merged.webSearch?.maxSearchesPerHour);
  const maxResultsRaw = Number(merged.webSearch?.maxResults);
  const maxPagesRaw = Number(merged.webSearch?.maxPagesToRead);
  const maxCharsRaw = Number(merged.webSearch?.maxCharsPerPage);
  const recencyDaysRaw = Number(merged.webSearch?.recencyDaysDefault);
  const maxConcurrentFetchesRaw = Number(merged.webSearch?.maxConcurrentFetches);
  merged.webSearch.maxSearchesPerHour = clamp(
    Number.isFinite(maxSearchesRaw)
      ? maxSearchesRaw
      : Number(DEFAULT_SETTINGS.webSearch?.maxSearchesPerHour) || 20,
    1,
    120
  );
  merged.webSearch.maxResults = clamp(Number.isFinite(maxResultsRaw) ? maxResultsRaw : 5, 1, 10);
  merged.webSearch.maxPagesToRead = clamp(Number.isFinite(maxPagesRaw) ? maxPagesRaw : 3, 0, 5);
  merged.webSearch.maxCharsPerPage = clamp(Number.isFinite(maxCharsRaw) ? maxCharsRaw : 6000, 350, 24000);
  merged.webSearch.safeSearch =
    merged.webSearch?.safeSearch !== undefined ? Boolean(merged.webSearch?.safeSearch) : true;
  merged.webSearch.providerOrder = normalizeProviderOrder(merged.webSearch?.providerOrder);
  merged.webSearch.recencyDaysDefault = clamp(Number.isFinite(recencyDaysRaw) ? recencyDaysRaw : 30, 1, 365);
  merged.webSearch.maxConcurrentFetches = clamp(
    Number.isFinite(maxConcurrentFetchesRaw) ? maxConcurrentFetchesRaw : 5,
    1,
    10
  );

  merged.browser.enabled = Boolean(merged.browser?.enabled);
  const defaultBrowserLlmProvider = normalizeBrowserLlmProvider(DEFAULT_SETTINGS.browser?.llm?.provider || "anthropic");
  const browserLlmProvider = normalizeBrowserLlmProvider(merged.browser?.llm?.provider, defaultBrowserLlmProvider);
  const browserLlmDefaultModel =
    BROWSER_LLM_PROVIDER_FALLBACK_MODELS[browserLlmProvider] ||
    String(DEFAULT_SETTINGS.browser?.llm?.model || "").trim() ||
    defaultModelForLlmProvider(browserLlmProvider);
  const normalizedBrowserLlm = normalizeProviderModelPair(
    merged.browser.llm,
    defaultBrowserLlmProvider,
    browserLlmDefaultModel
  );
  const resolvedBrowserLlmProvider = normalizeBrowserLlmProvider(
    normalizedBrowserLlm.provider,
    defaultBrowserLlmProvider
  );
  merged.browser.llm.provider = resolvedBrowserLlmProvider;
  merged.browser.llm.model =
    resolvedBrowserLlmProvider === normalizedBrowserLlm.provider
      ? normalizedBrowserLlm.model
      : BROWSER_LLM_PROVIDER_FALLBACK_MODELS[resolvedBrowserLlmProvider];
  const browserMaxPerHourRaw = Number(merged.browser?.maxBrowseCallsPerHour);
  const browserMaxStepsRaw = Number(merged.browser?.maxStepsPerTask);
  const browserStepTimeoutRaw = Number(merged.browser?.stepTimeoutMs);
  const browserSessionTimeoutRaw = Number(merged.browser?.sessionTimeoutMs);
  merged.browser.maxBrowseCallsPerHour = clamp(
    Number.isFinite(browserMaxPerHourRaw)
      ? browserMaxPerHourRaw
      : Number(DEFAULT_SETTINGS.browser?.maxBrowseCallsPerHour) || 10,
    1,
    60
  );
  merged.browser.maxStepsPerTask = clamp(
    Number.isFinite(browserMaxStepsRaw)
      ? browserMaxStepsRaw
      : Number(DEFAULT_SETTINGS.browser?.maxStepsPerTask) || 15,
    1,
    30
  );
  merged.browser.stepTimeoutMs = clamp(
    Number.isFinite(browserStepTimeoutRaw)
      ? browserStepTimeoutRaw
      : Number(DEFAULT_SETTINGS.browser?.stepTimeoutMs) || 30_000,
    5_000,
    120_000
  );
  merged.browser.sessionTimeoutMs = clamp(
    Number.isFinite(browserSessionTimeoutRaw)
      ? browserSessionTimeoutRaw
      : Number(DEFAULT_SETTINGS.browser?.sessionTimeoutMs) || 300_000,
    30_000,
    600_000
  );

  // --- Vision ---
  if (!merged.vision || typeof merged.vision !== "object") merged.vision = {};
  merged.vision.captionEnabled =
    merged.vision?.captionEnabled !== undefined
      ? Boolean(merged.vision.captionEnabled)
      : Boolean(DEFAULT_SETTINGS.vision?.captionEnabled);
  const defaultVisionProvider = normalizeLlmProvider(DEFAULT_SETTINGS.vision?.provider || "anthropic");
  const visionProvider = normalizeLlmProvider(merged.vision?.provider, defaultVisionProvider);
  const defaultVisionModel =
    visionProvider === defaultVisionProvider
      ? String(DEFAULT_SETTINGS.vision?.model || "").trim()
      : "";
  const normalizedVisionLlm = normalizeProviderModelPair(
    merged.vision,
    defaultVisionProvider,
    defaultVisionModel
  );
  merged.vision.provider = normalizedVisionLlm.provider;
  merged.vision.model = normalizedVisionLlm.model;
  const visionAutoIncludeRaw = Number(merged.vision?.maxAutoIncludeImages);
  merged.vision.maxAutoIncludeImages = clamp(
    Number.isFinite(visionAutoIncludeRaw)
      ? visionAutoIncludeRaw
      : Number(DEFAULT_SETTINGS.vision?.maxAutoIncludeImages) || 3,
    0,
    6
  );
  const visionCaptionsPerHourRaw = Number(merged.vision?.maxCaptionsPerHour);
  merged.vision.maxCaptionsPerHour = clamp(
    Number.isFinite(visionCaptionsPerHourRaw)
      ? visionCaptionsPerHourRaw
      : Number(DEFAULT_SETTINGS.vision?.maxCaptionsPerHour) || 60,
    0,
    300
  );

  merged.videoContext.enabled =
    merged.videoContext?.enabled !== undefined
      ? Boolean(merged.videoContext?.enabled)
      : Boolean(DEFAULT_SETTINGS.videoContext?.enabled);
  const videoPerHourRaw = Number(merged.videoContext?.maxLookupsPerHour);
  const videoPerMessageRaw = Number(merged.videoContext?.maxVideosPerMessage);
  const transcriptCharsRaw = Number(merged.videoContext?.maxTranscriptChars);
  const keyframeIntervalRaw = Number(merged.videoContext?.keyframeIntervalSeconds);
  const keyframeCountRaw = Number(merged.videoContext?.maxKeyframesPerVideo);
  const maxAsrSecondsRaw = Number(merged.videoContext?.maxAsrSeconds);
  merged.videoContext.maxLookupsPerHour = clamp(
    Number.isFinite(videoPerHourRaw) ? videoPerHourRaw : Number(DEFAULT_SETTINGS.videoContext?.maxLookupsPerHour) || 12,
    0,
    120
  );
  merged.videoContext.maxVideosPerMessage = clamp(
    Number.isFinite(videoPerMessageRaw)
      ? videoPerMessageRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxVideosPerMessage) || 2,
    0,
    6
  );
  merged.videoContext.maxTranscriptChars = clamp(
    Number.isFinite(transcriptCharsRaw)
      ? transcriptCharsRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxTranscriptChars) || 1200,
    200,
    4000
  );
  merged.videoContext.keyframeIntervalSeconds = clamp(
    Number.isFinite(keyframeIntervalRaw)
      ? keyframeIntervalRaw
      : Number(DEFAULT_SETTINGS.videoContext?.keyframeIntervalSeconds) || 8,
    0,
    120
  );
  merged.videoContext.maxKeyframesPerVideo = clamp(
    Number.isFinite(keyframeCountRaw)
      ? keyframeCountRaw
      : Number(DEFAULT_SETTINGS.videoContext?.maxKeyframesPerVideo) || 3,
    0,
    8
  );
  merged.videoContext.allowAsrFallback = Boolean(merged.videoContext?.allowAsrFallback);
  merged.videoContext.maxAsrSeconds = clamp(
    Number.isFinite(maxAsrSecondsRaw) ? maxAsrSecondsRaw : Number(DEFAULT_SETTINGS.videoContext?.maxAsrSeconds) || 120,
    15,
    600
  );

  if (!merged.voice.xai || typeof merged.voice.xai !== "object") {
    merged.voice.xai = {};
  }
  if (!merged.voice.openaiRealtime || typeof merged.voice.openaiRealtime !== "object") {
    merged.voice.openaiRealtime = {};
  }
  if (!merged.voice.elevenLabsRealtime || typeof merged.voice.elevenLabsRealtime !== "object") {
    merged.voice.elevenLabsRealtime = {};
  }
  if (!merged.voice.geminiRealtime || typeof merged.voice.geminiRealtime !== "object") {
    merged.voice.geminiRealtime = {};
  }
  if (!merged.voice.sttPipeline || typeof merged.voice.sttPipeline !== "object") {
    merged.voice.sttPipeline = {};
  }
  if (!merged.voice.thoughtEngine || typeof merged.voice.thoughtEngine !== "object") {
    merged.voice.thoughtEngine = {};
  }
  if (!merged.voice.generationLlm || typeof merged.voice.generationLlm !== "object") {
    merged.voice.generationLlm = {};
  }
  if (!merged.voice.replyDecisionLlm || typeof merged.voice.replyDecisionLlm !== "object") {
    merged.voice.replyDecisionLlm = {};
  }
  if (!merged.voice.streamWatch || typeof merged.voice.streamWatch !== "object") {
    merged.voice.streamWatch = {};
  }
  if (!merged.voice.soundboard || typeof merged.voice.soundboard !== "object") {
    merged.voice.soundboard = {};
  }
  if (!merged.voice.musicDucking || typeof merged.voice.musicDucking !== "object") {
    merged.voice.musicDucking = {};
  }

  type VoiceXaiDefaults = {
    voice?: string;
    audioFormat?: string;
    sampleRateHz?: number;
    region?: string;
  };
  type VoiceOpenAiRealtimeDefaults = {
    model?: string;
    voice?: string;
    inputAudioFormat?: string;
    outputAudioFormat?: string;
    transcriptionMethod?: string;
    inputTranscriptionModel?: string;
    usePerUserAsrBridge?: boolean;
  };
  type VoiceElevenLabsRealtimeDefaults = {
    agentId?: string;
    apiBaseUrl?: string;
    inputSampleRateHz?: number;
    outputSampleRateHz?: number;
  };
  type VoiceGeminiRealtimeDefaults = {
    model?: string;
    voice?: string;
    apiBaseUrl?: string;
    inputSampleRateHz?: number;
    outputSampleRateHz?: number;
  };
  type VoiceSttPipelineDefaults = {
    transcriptionModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
  };
  type VoiceThoughtEngineDefaults = {
    enabled?: boolean;
    provider?: string;
    model?: string;
    temperature?: number;
    eagerness?: number;
    minSilenceSeconds?: number;
    minSecondsBetweenThoughts?: number;
  };
  type VoiceReplyDecisionDefaults = {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
  type VoiceGenerationDefaults = {
    useTextModel?: boolean;
    provider?: string;
    model?: string;
  };
  type VoiceStreamWatchDefaults = {
    enabled?: boolean;
    minCommentaryIntervalSeconds?: number;
    maxFramesPerMinute?: number;
    maxFrameBytes?: number;
    commentaryPath?: string;
    keyframeIntervalMs?: number;
    autonomousCommentaryEnabled?: boolean;
    brainContextEnabled?: boolean;
    brainContextMinIntervalSeconds?: number;
    brainContextMaxEntries?: number;
    brainContextPrompt?: string;
  };
  type VoiceSoundboardDefaults = {
    enabled?: boolean;
    allowExternalSounds?: boolean;
  };
  type VoiceMusicDuckingDefaults = {
    targetGain?: number;
    fadeMs?: number;
  };
  type VoiceDefaults = {
    enabled?: boolean;
    voiceProvider?: string;
    brainProvider?: string;
    transcriberProvider?: string;
    asrLanguageMode?: string;
    asrLanguageHint?: string;
    allowNsfwHumor?: boolean;
    intentConfidenceThreshold?: number;
    maxSessionMinutes?: number;
    inactivityLeaveSeconds?: number;
    maxSessionsPerDay?: number;
    maxConcurrentSessions?: number;
    replyEagerness?: number;
    commandOnlyMode?: boolean;
    xai?: VoiceXaiDefaults;
    openaiRealtime?: VoiceOpenAiRealtimeDefaults;
    elevenLabsRealtime?: VoiceElevenLabsRealtimeDefaults;
    geminiRealtime?: VoiceGeminiRealtimeDefaults;
    sttPipeline?: VoiceSttPipelineDefaults;
    thoughtEngine?: VoiceThoughtEngineDefaults;
    generationLlm?: VoiceGenerationDefaults;
    replyDecisionLlm?: VoiceReplyDecisionDefaults;
    streamWatch?: VoiceStreamWatchDefaults;
    soundboard?: VoiceSoundboardDefaults;
    musicDucking?: VoiceMusicDuckingDefaults;
    asrDuringMusic?: boolean;
    asrEnabled?: boolean;
    operationalMessages?: string;
  };

  const defaultVoice: VoiceDefaults = DEFAULT_SETTINGS.voice;
  const defaultVoiceXai: VoiceXaiDefaults = defaultVoice.xai ?? {};
  const defaultVoiceOpenAiRealtime: VoiceOpenAiRealtimeDefaults = defaultVoice.openaiRealtime ?? {};
  const defaultVoiceElevenLabsRealtime: VoiceElevenLabsRealtimeDefaults = defaultVoice.elevenLabsRealtime ?? {};
  const defaultVoiceGeminiRealtime: VoiceGeminiRealtimeDefaults = defaultVoice.geminiRealtime ?? {};
  const defaultVoiceSttPipeline: VoiceSttPipelineDefaults = defaultVoice.sttPipeline ?? {};
  const defaultVoiceThoughtEngine: VoiceThoughtEngineDefaults = defaultVoice.thoughtEngine ?? {};
  const defaultVoiceGenerationLlm: VoiceGenerationDefaults = defaultVoice.generationLlm ?? {};
  const defaultVoiceReplyDecisionLlm: VoiceReplyDecisionDefaults = defaultVoice.replyDecisionLlm ?? {};
  const defaultVoiceStreamWatch: VoiceStreamWatchDefaults = defaultVoice.streamWatch ?? {};
  const defaultVoiceSoundboard: VoiceSoundboardDefaults = defaultVoice.soundboard ?? {};
  const defaultVoiceMusicDucking: VoiceMusicDuckingDefaults = defaultVoice.musicDucking ?? {};
  const voiceIntentThresholdRaw = Number(merged.voice?.intentConfidenceThreshold);
  const voiceMaxSessionRaw = Number(merged.voice?.maxSessionMinutes);
  const voiceInactivityRaw = Number(merged.voice?.inactivityLeaveSeconds);
  const voiceDailySessionsRaw = Number(merged.voice?.maxSessionsPerDay);
  const voiceConcurrentSessionsRaw = Number(merged.voice?.maxConcurrentSessions);
  const voiceSampleRateRaw = Number(merged.voice?.xai?.sampleRateHz);
  const elevenLabsRealtimeInputSampleRateRaw = Number(merged.voice?.elevenLabsRealtime?.inputSampleRateHz);
  const elevenLabsRealtimeOutputSampleRateRaw = Number(merged.voice?.elevenLabsRealtime?.outputSampleRateHz);
  const geminiRealtimeInputSampleRateRaw = Number(merged.voice?.geminiRealtime?.inputSampleRateHz);
  const geminiRealtimeOutputSampleRateRaw = Number(merged.voice?.geminiRealtime?.outputSampleRateHz);
  const voiceSttTtsSpeedRaw = Number(merged.voice?.sttPipeline?.ttsSpeed);
  const streamWatchCommentaryIntervalRaw = Number(merged.voice?.streamWatch?.minCommentaryIntervalSeconds);
  const streamWatchMaxFramesPerMinuteRaw = Number(merged.voice?.streamWatch?.maxFramesPerMinute);
  const streamWatchMaxFrameBytesRaw = Number(merged.voice?.streamWatch?.maxFrameBytes);
  const streamWatchKeyframeIntervalRaw = Number(merged.voice?.streamWatch?.keyframeIntervalMs);
  const streamWatchBrainContextIntervalRaw = Number(merged.voice?.streamWatch?.brainContextMinIntervalSeconds);
  const streamWatchBrainContextMaxEntriesRaw = Number(merged.voice?.streamWatch?.brainContextMaxEntries);
  const voiceMusicDuckingTargetGainRaw = Number(merged.voice?.musicDucking?.targetGain);
  const voiceMusicDuckingFadeMsRaw = Number(merged.voice?.musicDucking?.fadeMs);

  merged.voice.enabled =
    merged.voice?.enabled !== undefined ? Boolean(merged.voice?.enabled) : Boolean(defaultVoice.enabled);
  merged.voice.voiceProvider = normalizeVoiceProvider(merged.voice?.voiceProvider, "openai");
  merged.voice.brainProvider = normalizeBrainProvider(
    merged.voice?.brainProvider,
    merged.voice?.voiceProvider,
    "openai"
  );
  merged.voice.transcriberProvider = normalizeTranscriberProvider(
    merged.voice?.transcriberProvider,
    "openai"
  );
  merged.voice.asrLanguageMode = normalizeVoiceAsrLanguageMode(
    merged.voice?.asrLanguageMode,
    defaultVoice.asrLanguageMode || "auto"
  );
  merged.voice.asrLanguageHint = normalizeVoiceAsrLanguageHint(
    merged.voice?.asrLanguageHint,
    defaultVoice.asrLanguageHint || "en"
  );
  merged.voice.allowNsfwHumor =
    merged.voice?.allowNsfwHumor !== undefined
      ? Boolean(merged.voice?.allowNsfwHumor)
      : Boolean(defaultVoice.allowNsfwHumor);
  merged.voice.intentConfidenceThreshold = clamp(
    Number.isFinite(voiceIntentThresholdRaw)
      ? voiceIntentThresholdRaw
      : Number(defaultVoice.intentConfidenceThreshold) || 0.75,
    0.4,
    0.99
  );
  merged.voice.maxSessionMinutes = clamp(
    Number.isFinite(voiceMaxSessionRaw) ? voiceMaxSessionRaw : Number(defaultVoice.maxSessionMinutes) || 30,
    1,
    120
  );
  merged.voice.inactivityLeaveSeconds = clamp(
    Number.isFinite(voiceInactivityRaw) ? voiceInactivityRaw : Number(defaultVoice.inactivityLeaveSeconds) || 300,
    20,
    3600
  );
  merged.voice.maxSessionsPerDay = clamp(
    Number.isFinite(voiceDailySessionsRaw) ? voiceDailySessionsRaw : Number(defaultVoice.maxSessionsPerDay) || 12,
    0,
    120
  );
  merged.voice.maxConcurrentSessions = clamp(
    Number.isFinite(voiceConcurrentSessionsRaw)
      ? voiceConcurrentSessionsRaw
      : Number(defaultVoice.maxConcurrentSessions) || 1,
    1,
    3
  );
  merged.voice.allowedVoiceChannelIds = uniqueIdList(merged.voice?.allowedVoiceChannelIds);
  merged.voice.blockedVoiceChannelIds = uniqueIdList(merged.voice?.blockedVoiceChannelIds);
  merged.voice.blockedVoiceUserIds = uniqueIdList(merged.voice?.blockedVoiceUserIds);

  const voiceEagernessRaw = Number(merged.voice?.replyEagerness);
  merged.voice.replyEagerness = clamp(
    Number.isFinite(voiceEagernessRaw) ? voiceEagernessRaw : 0, 0, 100
  );
  merged.voice.commandOnlyMode =
    merged.voice?.commandOnlyMode !== undefined
      ? Boolean(merged.voice?.commandOnlyMode)
      : Boolean(defaultVoice.commandOnlyMode);

  const rawReplyPath = String(merged.voice?.replyPath || "").trim().toLowerCase();
  const resolvedReplyPath =
    rawReplyPath === "native" || rawReplyPath === "bridge" || rawReplyPath === "brain"
      ? rawReplyPath
      : "bridge";
  merged.voice.replyPath = resolvedReplyPath;

  merged.voice.thoughtEngine.enabled =
    merged.voice?.thoughtEngine?.enabled !== undefined
      ? Boolean(merged.voice?.thoughtEngine?.enabled)
      : defaultVoiceThoughtEngine?.enabled !== undefined
        ? Boolean(defaultVoiceThoughtEngine.enabled)
        : true;
  const voiceThoughtEagernessRaw = Number(merged.voice?.thoughtEngine?.eagerness);
  const defaultVoiceThoughtEagernessRaw = Number(defaultVoiceThoughtEngine.eagerness);
  merged.voice.thoughtEngine.eagerness = clamp(
    Number.isFinite(voiceThoughtEagernessRaw)
      ? voiceThoughtEagernessRaw
      : Number.isFinite(defaultVoiceThoughtEagernessRaw)
        ? defaultVoiceThoughtEagernessRaw
        : 0,
    0,
    100
  );
  const voiceThoughtProviderRaw = String(merged.voice?.thoughtEngine?.provider || "").trim();
  const defaultVoiceThoughtProvider = normalizeLlmProvider(defaultVoiceThoughtEngine.provider || "anthropic");
  const voiceThoughtProvider = normalizeLlmProvider(voiceThoughtProviderRaw, defaultVoiceThoughtProvider);
  const defaultVoiceThoughtModel =
    voiceThoughtProvider === defaultVoiceThoughtProvider
      ? String(defaultVoiceThoughtEngine.model || "").trim()
      : "";
  const normalizedVoiceThoughtLlm = normalizeProviderModelPair(
    merged.voice.thoughtEngine,
    defaultVoiceThoughtProvider,
    defaultVoiceThoughtModel
  );
  merged.voice.thoughtEngine.provider = normalizedVoiceThoughtLlm.provider;
  merged.voice.thoughtEngine.model = normalizedVoiceThoughtLlm.model;
  const voiceThoughtTemperatureRaw = Number(merged.voice?.thoughtEngine?.temperature);
  const defaultVoiceThoughtTemperatureRaw = Number(defaultVoiceThoughtEngine.temperature);
  merged.voice.thoughtEngine.temperature = clamp(
    Number.isFinite(voiceThoughtTemperatureRaw)
      ? voiceThoughtTemperatureRaw
      : Number.isFinite(defaultVoiceThoughtTemperatureRaw)
        ? defaultVoiceThoughtTemperatureRaw
        : 0.8,
    0,
    2
  );
  const voiceThoughtMinSilenceRaw = Number(merged.voice?.thoughtEngine?.minSilenceSeconds);
  const defaultVoiceThoughtMinSilenceRaw = Number(defaultVoiceThoughtEngine.minSilenceSeconds);
  merged.voice.thoughtEngine.minSilenceSeconds = clamp(
    Number.isFinite(voiceThoughtMinSilenceRaw)
      ? voiceThoughtMinSilenceRaw
      : Number.isFinite(defaultVoiceThoughtMinSilenceRaw)
        ? defaultVoiceThoughtMinSilenceRaw
        : 20,
    8,
    300
  );
  const voiceThoughtMinGapRaw = Number(merged.voice?.thoughtEngine?.minSecondsBetweenThoughts);
  const defaultVoiceThoughtMinGapRaw = Number(defaultVoiceThoughtEngine.minSecondsBetweenThoughts);
  merged.voice.thoughtEngine.minSecondsBetweenThoughts = clamp(
    Number.isFinite(voiceThoughtMinGapRaw)
      ? voiceThoughtMinGapRaw
      : Number.isFinite(defaultVoiceThoughtMinGapRaw)
        ? defaultVoiceThoughtMinGapRaw
        : merged.voice.thoughtEngine.minSilenceSeconds,
    8,
    600
  );
  merged.voice.generationLlm.useTextModel =
    merged.voice?.generationLlm?.useTextModel !== undefined
      ? Boolean(merged.voice?.generationLlm?.useTextModel)
      : Boolean(defaultVoiceGenerationLlm.useTextModel);
  const voiceGenerationProviderRaw = String(merged.voice?.generationLlm?.provider || "").trim();
  const defaultVoiceGenerationProvider = normalizeLlmProvider(defaultVoiceGenerationLlm.provider || "anthropic");
  const defaultVoiceGenerationModel =
    normalizeLlmProvider(voiceGenerationProviderRaw, defaultVoiceGenerationProvider) === defaultVoiceGenerationProvider
      ? String(defaultVoiceGenerationLlm.model || "").trim()
      : "";
  const normalizedVoiceGenerationLlm = normalizeProviderModelPair(
    merged.voice.generationLlm,
    defaultVoiceGenerationProvider,
    defaultVoiceGenerationModel
  );
  merged.voice.generationLlm.provider = merged.voice.generationLlm.useTextModel
    ? merged.llm.provider
    : normalizedVoiceGenerationLlm.provider;
  merged.voice.generationLlm.model = merged.voice.generationLlm.useTextModel
    ? merged.llm.model
    : normalizedVoiceGenerationLlm.model;
  delete merged.voice.replyDecisionLlm.enabled;
  delete merged.voice.replyDecisionLlm.prompts;
  const voiceReplyDecisionProviderRaw = String(merged.voice?.replyDecisionLlm?.provider || "").trim();
  const defaultVoiceReplyDecisionProvider = normalizeLlmProvider(defaultVoiceReplyDecisionLlm.provider || "anthropic");
  const defaultReplyDecisionModel =
    normalizeLlmProvider(voiceReplyDecisionProviderRaw, defaultVoiceReplyDecisionProvider) ===
      defaultVoiceReplyDecisionProvider
      ? String(defaultVoiceReplyDecisionLlm.model || "").trim()
      : "";
  const normalizedVoiceReplyDecisionLlm = normalizeProviderModelPair(
    merged.voice.replyDecisionLlm,
    defaultVoiceReplyDecisionProvider,
    defaultReplyDecisionModel
  );
  merged.voice.replyDecisionLlm.provider = normalizedVoiceReplyDecisionLlm.provider;
  merged.voice.replyDecisionLlm.model = normalizedVoiceReplyDecisionLlm.model;
  delete merged.voice.replyDecisionLlm.maxAttempts;
  const defaultReplyDecisionReasoningEffort = defaultVoiceReplyDecisionLlm.reasoningEffort || "minimal";
  merged.voice.replyDecisionLlm.reasoningEffort = normalizeOpenAiReasoningEffort(
    merged.voice?.replyDecisionLlm?.reasoningEffort,
    defaultReplyDecisionReasoningEffort
  ) || defaultReplyDecisionReasoningEffort;

  merged.voice.xai.voice = String(merged.voice?.xai?.voice || defaultVoiceXai.voice || "Rex").slice(0, 60);
  merged.voice.xai.audioFormat = String(merged.voice?.xai?.audioFormat || defaultVoiceXai.audioFormat || "audio/pcm")
    .trim()
    .slice(0, 40);
  merged.voice.xai.sampleRateHz = clamp(
    Number.isFinite(voiceSampleRateRaw) ? voiceSampleRateRaw : Number(defaultVoiceXai.sampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.xai.region = String(merged.voice?.xai?.region || defaultVoiceXai.region || "us-east-1")
    .trim()
    .slice(0, 40);
  merged.voice.openaiRealtime.model = String(
    merged.voice?.openaiRealtime?.model || defaultVoiceOpenAiRealtime.model || "gpt-realtime"
  )
    .trim()
    .slice(0, 120);
  merged.voice.openaiRealtime.voice = String(
    merged.voice?.openaiRealtime?.voice || defaultVoiceOpenAiRealtime.voice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.openaiRealtime.inputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.inputAudioFormat || defaultVoiceOpenAiRealtime.inputAudioFormat || "pcm16"
  );
  merged.voice.openaiRealtime.outputAudioFormat = normalizeOpenAiRealtimeAudioFormat(
    merged.voice?.openaiRealtime?.outputAudioFormat || defaultVoiceOpenAiRealtime.outputAudioFormat || "pcm16"
  );
  const openAiRealtimeTranscriptionMethod = String(
    merged.voice?.openaiRealtime?.transcriptionMethod ||
    defaultVoiceOpenAiRealtime.transcriptionMethod ||
    "realtime_bridge"
  )
    .trim()
    .toLowerCase();
  merged.voice.openaiRealtime.transcriptionMethod =
    openAiRealtimeTranscriptionMethod === "file_wav"
      ? "file_wav"
      : "realtime_bridge";
  merged.voice.openaiRealtime.inputTranscriptionModel = String(
    normalizeOpenAiRealtimeTranscriptionModel(
      merged.voice?.openaiRealtime?.inputTranscriptionModel ||
      defaultVoiceOpenAiRealtime.inputTranscriptionModel ||
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    )
  ).slice(0, 120);
  merged.voice.openaiRealtime.usePerUserAsrBridge =
    merged.voice?.openaiRealtime?.usePerUserAsrBridge !== undefined
      ? Boolean(merged.voice?.openaiRealtime?.usePerUserAsrBridge)
      : Boolean(defaultVoiceOpenAiRealtime.usePerUserAsrBridge);
  merged.voice.elevenLabsRealtime.agentId = String(
    merged.voice?.elevenLabsRealtime?.agentId || defaultVoiceElevenLabsRealtime.agentId || ""
  )
    .trim()
    .slice(0, 120);
  merged.voice.elevenLabsRealtime.apiBaseUrl = normalizeHttpBaseUrl(
    merged.voice?.elevenLabsRealtime?.apiBaseUrl,
    defaultVoiceElevenLabsRealtime.apiBaseUrl || "https://api.elevenlabs.io"
  );
  merged.voice.elevenLabsRealtime.inputSampleRateHz = clamp(
    Number.isFinite(elevenLabsRealtimeInputSampleRateRaw)
      ? elevenLabsRealtimeInputSampleRateRaw
      : Number(defaultVoiceElevenLabsRealtime.inputSampleRateHz) || 16000,
    8000,
    48000
  );
  merged.voice.elevenLabsRealtime.outputSampleRateHz = clamp(
    Number.isFinite(elevenLabsRealtimeOutputSampleRateRaw)
      ? elevenLabsRealtimeOutputSampleRateRaw
      : Number(defaultVoiceElevenLabsRealtime.outputSampleRateHz) || 16000,
    8000,
    48000
  );
  merged.voice.geminiRealtime.model = String(
    merged.voice?.geminiRealtime?.model || defaultVoiceGeminiRealtime.model || "gemini-2.5-flash-native-audio-preview-12-2025"
  )
    .trim()
    .slice(0, 140);
  merged.voice.geminiRealtime.voice = String(
    merged.voice?.geminiRealtime?.voice || defaultVoiceGeminiRealtime.voice || "Aoede"
  )
    .trim()
    .slice(0, 60);
  merged.voice.geminiRealtime.apiBaseUrl = normalizeHttpBaseUrl(
    merged.voice?.geminiRealtime?.apiBaseUrl,
    defaultVoiceGeminiRealtime.apiBaseUrl || "https://generativelanguage.googleapis.com"
  );
  merged.voice.geminiRealtime.inputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeInputSampleRateRaw)
      ? geminiRealtimeInputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.inputSampleRateHz) || 16000,
    8000,
    48000
  );
  merged.voice.geminiRealtime.outputSampleRateHz = clamp(
    Number.isFinite(geminiRealtimeOutputSampleRateRaw)
      ? geminiRealtimeOutputSampleRateRaw
      : Number(defaultVoiceGeminiRealtime.outputSampleRateHz) || 24000,
    8000,
    48000
  );
  merged.voice.sttPipeline.transcriptionModel = String(
    merged.voice?.sttPipeline?.transcriptionModel || defaultVoiceSttPipeline.transcriptionModel || "gpt-4o-mini-transcribe"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsModel = String(
    merged.voice?.sttPipeline?.ttsModel || defaultVoiceSttPipeline.ttsModel || "gpt-4o-mini-tts"
  )
    .trim()
    .slice(0, 120);
  merged.voice.sttPipeline.ttsVoice = String(
    merged.voice?.sttPipeline?.ttsVoice || defaultVoiceSttPipeline.ttsVoice || "alloy"
  )
    .trim()
    .slice(0, 60);
  merged.voice.sttPipeline.ttsSpeed = clamp(
    Number.isFinite(voiceSttTtsSpeedRaw)
      ? voiceSttTtsSpeedRaw
      : Number(defaultVoiceSttPipeline.ttsSpeed) || 1,
    0.25,
    2
  );
  merged.voice.streamWatch.enabled =
    merged.voice?.streamWatch?.enabled !== undefined
      ? Boolean(merged.voice?.streamWatch?.enabled)
      : Boolean(defaultVoiceStreamWatch.enabled);
  merged.voice.streamWatch.minCommentaryIntervalSeconds = clamp(
    Number.isFinite(streamWatchCommentaryIntervalRaw)
      ? streamWatchCommentaryIntervalRaw
      : Number(defaultVoiceStreamWatch.minCommentaryIntervalSeconds) || 8,
    3,
    120
  );
  merged.voice.streamWatch.maxFramesPerMinute = clamp(
    Number.isFinite(streamWatchMaxFramesPerMinuteRaw)
      ? streamWatchMaxFramesPerMinuteRaw
      : Number(defaultVoiceStreamWatch.maxFramesPerMinute) || 180,
    6,
    600
  );
  merged.voice.streamWatch.maxFrameBytes = clamp(
    Number.isFinite(streamWatchMaxFrameBytesRaw)
      ? streamWatchMaxFrameBytesRaw
      : Number(defaultVoiceStreamWatch.maxFrameBytes) || 350000,
    50_000,
    4_000_000
  );
  merged.voice.streamWatch.commentaryPath = normalizeStreamWatchCommentaryPath(
    merged.voice?.streamWatch?.commentaryPath,
    defaultVoiceStreamWatch.commentaryPath || "auto"
  );
  merged.voice.streamWatch.keyframeIntervalMs = clamp(
    Number.isFinite(streamWatchKeyframeIntervalRaw)
      ? streamWatchKeyframeIntervalRaw
      : Number(defaultVoiceStreamWatch.keyframeIntervalMs) || 1200,
    250,
    5000
  );
  merged.voice.streamWatch.autonomousCommentaryEnabled =
    merged.voice?.streamWatch?.autonomousCommentaryEnabled !== undefined
      ? Boolean(merged.voice?.streamWatch?.autonomousCommentaryEnabled)
      : defaultVoiceStreamWatch.autonomousCommentaryEnabled !== undefined
        ? Boolean(defaultVoiceStreamWatch.autonomousCommentaryEnabled)
        : true;
  merged.voice.streamWatch.brainContextEnabled =
    merged.voice?.streamWatch?.brainContextEnabled !== undefined
      ? Boolean(merged.voice?.streamWatch?.brainContextEnabled)
      : defaultVoiceStreamWatch.brainContextEnabled !== undefined
        ? Boolean(defaultVoiceStreamWatch.brainContextEnabled)
        : true;
  merged.voice.streamWatch.brainContextMinIntervalSeconds = clamp(
    Number.isFinite(streamWatchBrainContextIntervalRaw)
      ? streamWatchBrainContextIntervalRaw
      : Number(defaultVoiceStreamWatch.brainContextMinIntervalSeconds) || 4,
    1,
    120
  );
  merged.voice.streamWatch.brainContextMaxEntries = clamp(
    Number.isFinite(streamWatchBrainContextMaxEntriesRaw)
      ? streamWatchBrainContextMaxEntriesRaw
      : Number(defaultVoiceStreamWatch.brainContextMaxEntries) || 8,
    1,
    24
  );
  const brainContextPrompt = String(
    merged.voice?.streamWatch?.brainContextPrompt ?? defaultVoiceStreamWatch.brainContextPrompt ?? ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
  merged.voice.streamWatch.brainContextPrompt =
    brainContextPrompt || String(defaultVoiceStreamWatch.brainContextPrompt || "");

  merged.voice.soundboard.enabled =
    merged.voice?.soundboard?.enabled !== undefined
      ? Boolean(merged.voice?.soundboard?.enabled)
      : Boolean(defaultVoiceSoundboard.enabled);
  merged.voice.soundboard.allowExternalSounds =
    merged.voice?.soundboard?.allowExternalSounds !== undefined
      ? Boolean(merged.voice?.soundboard?.allowExternalSounds)
      : Boolean(defaultVoiceSoundboard.allowExternalSounds);
  merged.voice.soundboard.preferredSoundIds = uniqueIdList(merged.voice?.soundboard?.preferredSoundIds).slice(0, 40);
  merged.voice.musicDucking.targetGain = clamp(
    Number.isFinite(voiceMusicDuckingTargetGainRaw)
      ? voiceMusicDuckingTargetGainRaw
      : Number(defaultVoiceMusicDucking.targetGain) || 0.15,
    0.05,
    1
  );
  merged.voice.musicDucking.fadeMs = clamp(
    Number.isFinite(voiceMusicDuckingFadeMsRaw)
      ? Math.round(voiceMusicDuckingFadeMsRaw)
      : Math.round(Number(defaultVoiceMusicDucking.fadeMs) || 300),
    0,
    5000
  );

  // Migration: musicTranscriptionEnabled → asrDuringMusic
  if (
    raw?.voice?.musicTranscriptionEnabled !== undefined &&
    raw?.voice?.asrDuringMusic === undefined
  ) {
    merged.voice.asrDuringMusic = Boolean(raw.voice.musicTranscriptionEnabled);
  } else {
    merged.voice.asrDuringMusic =
      merged.voice?.asrDuringMusic !== undefined
        ? Boolean(merged.voice?.asrDuringMusic)
        : Boolean(defaultVoice.asrDuringMusic);
  }
  delete merged.voice.musicTranscriptionEnabled;

  merged.voice.asrEnabled =
    merged.voice?.asrEnabled !== undefined
      ? Boolean(merged.voice?.asrEnabled)
      : Boolean(defaultVoice.asrEnabled ?? true);

  const validOperationalMessageLevels = ["all", "essential", "minimal", "none"];
  const rawOperationalMessages = String(merged.voice?.operationalMessages || "").trim().toLowerCase();
  merged.voice.operationalMessages = validOperationalMessageLevels.includes(rawOperationalMessages)
    ? rawOperationalMessages
    : String(defaultVoice.operationalMessages || "all");

  merged.startup.catchupEnabled =
    merged.startup?.catchupEnabled !== undefined ? Boolean(merged.startup?.catchupEnabled) : true;
  const catchupLookbackHoursRaw = Number(merged.startup?.catchupLookbackHours);
  merged.startup.catchupLookbackHours = clamp(
    Number.isFinite(catchupLookbackHoursRaw) ? catchupLookbackHoursRaw : 6,
    1,
    24
  );
  merged.startup.catchupMaxMessagesPerChannel = clamp(
    Number(merged.startup?.catchupMaxMessagesPerChannel) || 20,
    5,
    80
  );
  merged.startup.maxCatchupRepliesPerChannel = clamp(
    Number(merged.startup?.maxCatchupRepliesPerChannel) || 2,
    1,
    12
  );

  merged.permissions.allowReplies = Boolean(merged.permissions?.allowReplies);
  merged.permissions.allowUnsolicitedReplies =
    merged.permissions?.allowUnsolicitedReplies !== undefined
      ? Boolean(merged.permissions?.allowUnsolicitedReplies)
      : true;
  merged.permissions.allowReactions = Boolean(merged.permissions?.allowReactions);
  merged.permissions.replyChannelIds = uniqueIdList(merged.permissions?.replyChannelIds);
  merged.permissions.allowedChannelIds = uniqueIdList(merged.permissions?.allowedChannelIds);
  merged.permissions.blockedChannelIds = uniqueIdList(merged.permissions?.blockedChannelIds);
  merged.permissions.blockedUserIds = uniqueIdList(merged.permissions?.blockedUserIds);
  merged.permissions.maxMessagesPerHour = clamp(
    Number(merged.permissions?.maxMessagesPerHour) || 20,
    1,
    200
  );
  merged.permissions.maxReactionsPerHour = clamp(Number(merged.permissions?.maxReactionsPerHour) || 24, 1, 300);

  merged.discovery.enabled =
    merged.discovery?.enabled !== undefined ? Boolean(merged.discovery?.enabled) : false;
  merged.discovery.channelIds = uniqueIdList(merged.discovery?.channelIds);
  merged.discovery.maxPostsPerDay = clamp(Number(merged.discovery?.maxPostsPerDay) || 0, 0, 100);
  merged.discovery.minMinutesBetweenPosts = clamp(
    Number(merged.discovery?.minMinutesBetweenPosts) || 120,
    5,
    24 * 60
  );
  merged.discovery.pacingMode =
    String(merged.discovery?.pacingMode || "even").toLowerCase() === "spontaneous"
      ? "spontaneous"
      : "even";
  merged.discovery.spontaneity = clamp(Number(merged.discovery?.spontaneity) || 65, 0, 100);
  merged.discovery.postOnStartup = Boolean(merged.discovery?.postOnStartup);
  merged.discovery.allowImagePosts = Boolean(merged.discovery?.allowImagePosts);
  merged.discovery.allowVideoPosts = Boolean(merged.discovery?.allowVideoPosts);
  merged.discovery.allowReplyImages = Boolean(merged.discovery?.allowReplyImages);
  merged.discovery.allowReplyVideos = Boolean(merged.discovery?.allowReplyVideos);
  merged.discovery.allowReplyGifs = Boolean(merged.discovery?.allowReplyGifs);
  merged.discovery.maxImagesPerDay = clamp(Number(merged.discovery?.maxImagesPerDay) || 0, 0, 200);
  merged.discovery.maxVideosPerDay = clamp(Number(merged.discovery?.maxVideosPerDay) || 0, 0, 120);
  merged.discovery.maxGifsPerDay = clamp(Number(merged.discovery?.maxGifsPerDay) || 0, 0, 300);
  merged.discovery.simpleImageModel = String(
    merged.discovery?.simpleImageModel || "gpt-image-1.5"
  ).slice(0, 120);
  merged.discovery.complexImageModel = String(
    merged.discovery?.complexImageModel || "grok-imagine-image"
  ).slice(0, 120);
  merged.discovery.videoModel = String(merged.discovery?.videoModel || "grok-imagine-video").slice(0, 120);
  merged.discovery.allowedImageModels = uniqueStringList(
    merged.discovery?.allowedImageModels ?? DEFAULT_SETTINGS.discovery?.allowedImageModels ?? [],
    12,
    120
  );
  merged.discovery.allowedVideoModels = uniqueStringList(
    merged.discovery?.allowedVideoModels ?? DEFAULT_SETTINGS.discovery?.allowedVideoModels ?? [],
    8,
    120
  );
  if (!merged.discovery.sources || typeof merged.discovery.sources !== "object") {
    merged.discovery.sources = {};
  }

  const defaultDiscovery = DEFAULT_SETTINGS.discovery;
  const defaultSources = defaultDiscovery.sources ?? {
    reddit: true,
    hackerNews: true,
    youtube: true,
    rss: true,
    x: false
  };
  const sourceConfig = merged.discovery.sources ?? {};
  merged.discovery = {
    enabled:
      merged.discovery?.enabled !== undefined
        ? Boolean(merged.discovery?.enabled)
        : Boolean(defaultDiscovery.enabled),
    channelIds: uniqueIdList(merged.discovery?.channelIds),
    maxPostsPerDay: clamp(
      Number(merged.discovery?.maxPostsPerDay) || Number(defaultDiscovery.maxPostsPerDay) || 0,
      0,
      100
    ),
    minMinutesBetweenPosts: clamp(
      Number(merged.discovery?.minMinutesBetweenPosts) ||
      Number(defaultDiscovery.minMinutesBetweenPosts) ||
      120,
      5,
      24 * 60
    ),
    pacingMode:
      String(merged.discovery?.pacingMode || defaultDiscovery.pacingMode || "even").toLowerCase() ===
        "spontaneous"
        ? "spontaneous"
        : "even",
    spontaneity: clamp(
      Number(merged.discovery?.spontaneity) || Number(defaultDiscovery.spontaneity) || 65,
      0,
      100
    ),
    postOnStartup:
      merged.discovery?.postOnStartup !== undefined
        ? Boolean(merged.discovery.postOnStartup)
        : Boolean(defaultDiscovery.postOnStartup),
    allowImagePosts:
      merged.discovery?.allowImagePosts !== undefined
        ? Boolean(merged.discovery.allowImagePosts)
        : Boolean(defaultDiscovery.allowImagePosts),
    allowVideoPosts:
      merged.discovery?.allowVideoPosts !== undefined
        ? Boolean(merged.discovery.allowVideoPosts)
        : Boolean(defaultDiscovery.allowVideoPosts),
    allowReplyImages:
      merged.discovery?.allowReplyImages !== undefined
        ? Boolean(merged.discovery.allowReplyImages)
        : Boolean(defaultDiscovery.allowReplyImages),
    allowReplyVideos:
      merged.discovery?.allowReplyVideos !== undefined
        ? Boolean(merged.discovery.allowReplyVideos)
        : Boolean(defaultDiscovery.allowReplyVideos),
    allowReplyGifs:
      merged.discovery?.allowReplyGifs !== undefined
        ? Boolean(merged.discovery.allowReplyGifs)
        : Boolean(defaultDiscovery.allowReplyGifs),
    maxImagesPerDay: clamp(
      Number(merged.discovery?.maxImagesPerDay) || Number(defaultDiscovery.maxImagesPerDay) || 0,
      0,
      200
    ),
    maxVideosPerDay: clamp(
      Number(merged.discovery?.maxVideosPerDay) || Number(defaultDiscovery.maxVideosPerDay) || 0,
      0,
      120
    ),
    maxGifsPerDay: clamp(
      Number(merged.discovery?.maxGifsPerDay) || Number(defaultDiscovery.maxGifsPerDay) || 0,
      0,
      300
    ),
    simpleImageModel: String(
      merged.discovery?.simpleImageModel || defaultDiscovery.simpleImageModel || "gpt-image-1.5"
    ).slice(0, 120),
    complexImageModel: String(
      merged.discovery?.complexImageModel ||
      defaultDiscovery.complexImageModel ||
      "grok-imagine-image"
    ).slice(0, 120),
    videoModel: String(
      merged.discovery?.videoModel || defaultDiscovery.videoModel || "grok-imagine-video"
    ).slice(0, 120),
    allowedImageModels: uniqueStringList(
      merged.discovery?.allowedImageModels ?? defaultDiscovery.allowedImageModels ?? [],
      12,
      120
    ),
    allowedVideoModels: uniqueStringList(
      merged.discovery?.allowedVideoModels ?? defaultDiscovery.allowedVideoModels ?? [],
      8,
      120
    ),
    maxMediaPromptChars: clamp(
      Number(merged.discovery?.maxMediaPromptChars) || Number(defaultDiscovery.maxMediaPromptChars) || 900,
      120,
      2000
    ),
    linkChancePercent: clamp(
      Number(merged.discovery?.linkChancePercent) || Number(defaultDiscovery.linkChancePercent) || 0,
      0,
      100
    ),
    maxLinksPerPost: clamp(
      Number(merged.discovery?.maxLinksPerPost) || Number(defaultDiscovery.maxLinksPerPost) || 2,
      1,
      4
    ),
    maxCandidatesForPrompt: clamp(
      Number(merged.discovery?.maxCandidatesForPrompt) ||
      Number(defaultDiscovery.maxCandidatesForPrompt) ||
      6,
      1,
      12
    ),
    freshnessHours: clamp(
      Number(merged.discovery?.freshnessHours) || Number(defaultDiscovery.freshnessHours) || 96,
      1,
      24 * 14
    ),
    dedupeHours: clamp(
      Number(merged.discovery?.dedupeHours) || Number(defaultDiscovery.dedupeHours) || 168,
      1,
      24 * 45
    ),
    randomness: clamp(
      Number(merged.discovery?.randomness) || Number(defaultDiscovery.randomness) || 55,
      0,
      100
    ),
    sourceFetchLimit: clamp(
      Number(merged.discovery?.sourceFetchLimit) || Number(defaultDiscovery.sourceFetchLimit) || 10,
      2,
      30
    ),
    allowNsfw: Boolean(merged.discovery?.allowNsfw),
    preferredTopics: uniqueStringList(
      merged.discovery?.preferredTopics,
      Number(defaultDiscovery.preferredTopics?.length ? defaultDiscovery.preferredTopics.length : 12),
      80
    ),
    redditSubreddits: uniqueStringList(
      merged.discovery?.redditSubreddits,
      20,
      40
    ).map((entry) => entry.replace(/^r\//i, "")),
    youtubeChannelIds: uniqueStringList(merged.discovery?.youtubeChannelIds, 20, 80),
    rssFeeds: uniqueStringList(merged.discovery?.rssFeeds, 30, 240).filter(isHttpLikeUrl),
    xHandles: uniqueStringList(merged.discovery?.xHandles, 20, 40).map((entry) =>
      entry.replace(/^@/, "")
    ),
    xNitterBaseUrl: normalizeHttpBaseUrl(
      merged.discovery?.xNitterBaseUrl,
      defaultDiscovery.xNitterBaseUrl || "https://nitter.net"
    ),
    sources: {
      reddit:
        sourceConfig.reddit !== undefined
          ? Boolean(sourceConfig.reddit)
          : Boolean(defaultSources.reddit ?? true),
      hackerNews:
        sourceConfig.hackerNews !== undefined
          ? Boolean(sourceConfig.hackerNews)
          : Boolean(defaultSources.hackerNews ?? true),
      youtube:
        sourceConfig.youtube !== undefined
          ? Boolean(sourceConfig.youtube)
          : Boolean(defaultSources.youtube ?? true),
      rss:
        sourceConfig.rss !== undefined
          ? Boolean(sourceConfig.rss)
          : Boolean(defaultSources.rss ?? true),
      x:
        sourceConfig.x !== undefined
          ? Boolean(sourceConfig.x)
          : Boolean(defaultSources.x ?? false)
    }
  };

  merged.memory.enabled = Boolean(merged.memory?.enabled);
  merged.adaptiveDirectives.enabled =
    merged.adaptiveDirectives?.enabled !== undefined
      ? Boolean(merged.adaptiveDirectives?.enabled)
      : Boolean(DEFAULT_SETTINGS.adaptiveDirectives?.enabled);
  merged.automations.enabled =
    merged.automations?.enabled !== undefined
      ? Boolean(merged.automations?.enabled)
      : Boolean(DEFAULT_SETTINGS.automations?.enabled);
  merged.memory.maxRecentMessages = clamp(Number(merged.memory?.maxRecentMessages) || 35, 10, 120);
  merged.memory.embeddingModel = String(merged.memory?.embeddingModel || "text-embedding-3-small").slice(0, 120);

  if (!merged.memory.reflection || typeof merged.memory.reflection !== "object") {
    merged.memory.reflection = {};
  }
  const defaultMemoryReflection = DEFAULT_SETTINGS.memory?.reflection || {
    enabled: true,
    strategy: "two_pass_extract_then_main",
    hour: 4,
    minute: 0,
    maxFactsPerReflection: 20
  };
  merged.memory.reflection.enabled =
    merged.memory.reflection?.enabled !== undefined
      ? Boolean(merged.memory.reflection?.enabled)
      : Boolean(defaultMemoryReflection.enabled);
  merged.memory.reflection.strategy =
    String(merged.memory.reflection?.strategy || "").trim().toLowerCase() === "one_pass_main"
      ? "one_pass_main"
      : "two_pass_extract_then_main";
  merged.memory.reflection.hour = clamp(
    Number(merged.memory.reflection?.hour) || Number(defaultMemoryReflection.hour) || 4,
    0,
    23
  );
  merged.memory.reflection.minute = clamp(
    Number(merged.memory.reflection?.minute) || Number(defaultMemoryReflection.minute) || 0,
    0,
    59
  );
  merged.memory.reflection.maxFactsPerReflection = clamp(
    Number(merged.memory.reflection?.maxFactsPerReflection) || Number(defaultMemoryReflection.maxFactsPerReflection) || 20,
    1,
    100
  );
  merged.memory.dailyLogRetentionDays = clamp(
    Number(merged.memory?.dailyLogRetentionDays) || Number(DEFAULT_SETTINGS.memory?.dailyLogRetentionDays) || 30,
    1,
    365
  );

  merged.codeAgent.enabled = Boolean(merged.codeAgent?.enabled);
  merged.codeAgent.provider = normalizeCodeAgentProvider(
    merged.codeAgent?.provider,
    String(DEFAULT_SETTINGS.codeAgent?.provider || "claude-code")
  );
  merged.codeAgent.model = String(merged.codeAgent?.model || DEFAULT_SETTINGS.codeAgent?.model || "sonnet").trim().slice(0, 120);
  const normalizedCodeAgentCodexModel = String(
    merged.codeAgent?.codexModel || DEFAULT_SETTINGS.codeAgent?.codexModel || "codex-mini-latest"
  ).trim().slice(0, 120);
  merged.codeAgent.codexModel =
    normalizedCodeAgentCodexModel || String(DEFAULT_SETTINGS.codeAgent?.codexModel || "codex-mini-latest");
  merged.codeAgent.maxTurns = clamp(
    Number(merged.codeAgent?.maxTurns) || Number(DEFAULT_SETTINGS.codeAgent?.maxTurns) || 30,
    1,
    200
  );
  merged.codeAgent.timeoutMs = clamp(
    Number(merged.codeAgent?.timeoutMs) || Number(DEFAULT_SETTINGS.codeAgent?.timeoutMs) || 300_000,
    10_000,
    1_800_000
  );
  merged.codeAgent.maxBufferBytes = clamp(
    Number(merged.codeAgent?.maxBufferBytes) || Number(DEFAULT_SETTINGS.codeAgent?.maxBufferBytes) || 2 * 1024 * 1024,
    4096,
    10 * 1024 * 1024
  );
  merged.codeAgent.defaultCwd = String(merged.codeAgent?.defaultCwd ?? DEFAULT_SETTINGS.codeAgent?.defaultCwd ?? "").trim().slice(0, 500);
  merged.codeAgent.maxTasksPerHour = clamp(
    Number(merged.codeAgent?.maxTasksPerHour) || Number(DEFAULT_SETTINGS.codeAgent?.maxTasksPerHour) || 10,
    1,
    100
  );
  merged.codeAgent.maxParallelTasks = clamp(
    Number(merged.codeAgent?.maxParallelTasks) || Number(DEFAULT_SETTINGS.codeAgent?.maxParallelTasks) || 2,
    1,
    10
  );
  merged.codeAgent.allowedUserIds = uniqueIdList(merged.codeAgent?.allowedUserIds).slice(0, 50);

  if (!merged.subAgentOrchestration || typeof merged.subAgentOrchestration !== "object") merged.subAgentOrchestration = {};
  const defaultOrch = DEFAULT_SETTINGS.subAgentOrchestration;
  merged.subAgentOrchestration.sessionIdleTimeoutMs = clamp(
    Number(merged.subAgentOrchestration?.sessionIdleTimeoutMs) || Number(defaultOrch.sessionIdleTimeoutMs) || 300_000,
    10_000,
    1_800_000
  );
  merged.subAgentOrchestration.maxConcurrentSessions = clamp(
    Number(merged.subAgentOrchestration?.maxConcurrentSessions) || Number(defaultOrch.maxConcurrentSessions) || 20,
    1,
    50
  );

  return merged;
}

function uniqueStringList(input, maxItems = 20, maxLen = 120) {
  return normalizeBoundedStringList(input, { maxItems, maxLen });
}

function isHttpLikeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpBaseUrl(value, fallback) {
  const target = String(value || fallback || "").trim();

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return String(fallback || "https://nitter.net");
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(fallback || "https://nitter.net");
  }
}

function normalizeVoiceAsrLanguageMode(value, fallback = "auto") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "fixed") return "fixed";
  return "auto";
}

function normalizeVoiceAsrLanguageHint(value, fallback = "en") {
  if (value === undefined || value === null) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized) return "";
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/u.test(normalized)) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  return normalized.slice(0, 24);
}

function normalizeStreamWatchCommentaryPath(value, fallback = "auto") {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "anthropic_keyframes") return "anthropic_keyframes";
  return "auto";
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "audio/pcm") return "pcm16";
  return "pcm16";
}

function normalizeHardLimitList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return normalizeBoundedStringList(source, { maxItems: 24, maxLen: 180 });
}

function normalizePromptLine(value, fallback = "") {
  const resolved = String(value === undefined || value === null ? fallback : value)
    .replace(/\s+/g, " ")
    .trim();
  return resolved.slice(0, 400);
}

function normalizeLongPromptBlock(value, fallback = "", maxLen = 8000) {
  const limit = clamp(Number(maxLen) || 8000, 256, 20_000);
  const candidate = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (candidate) return candidate.slice(0, limit);
  const fallbackText = String(fallback ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return fallbackText.slice(0, limit);
}

function normalizePromptLineList(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  return normalizeBoundedStringList(source, { maxItems: 40, maxLen: 240 });
}

function normalizeProviderModelPair(input, fallbackProvider, fallbackModel = "") {
  const provider = normalizeLlmProvider(input?.provider, fallbackProvider);
  const normalizedFallbackModel = String(fallbackModel || "")
    .trim()
    .slice(0, 120);
  const model = String(
    String(input?.model || "")
      .trim()
      .slice(0, 120) || normalizedFallbackModel || defaultModelForLlmProvider(provider)
  );
  return {
    provider,
    model
  };
}
