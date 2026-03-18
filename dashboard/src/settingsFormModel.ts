import {
  DEFAULT_SETTINGS,
  PROVIDER_MODEL_FALLBACKS,
  type Settings,
  type SettingsInput
} from "../../src/settings/settingsSchema.ts";
import {
  buildDashboardSettingsEnvelope,
  isDashboardSettingsEnvelope,
  type DashboardSettingsEnvelope
} from "../../src/settings/dashboardSettingsState.ts";
import { minimizeSettingsIntent } from "../../src/settings/settingsIntent.ts";
import { normalizeSettings } from "../../src/store/settingsNormalization.ts";
import {
  formatCommaList,
  formatLineList,
  normalizeBoundedStringList,
  parseUniqueLineList,
  parseUniqueList
} from "../../src/settings/listNormalization.ts";
import {
  getResolvedMemoryBinding,
  getResolvedVoiceInterruptClassifierBinding,
  getResolvedVoiceMusicBrainBinding
} from "../../src/settings/agentStack.ts";
import {
  getPresetVoiceAdmissionClassifierFallback,
  getPresetVoiceInterruptClassifierFallback,
  getPresetVoiceMusicBrainFallback
} from "../../src/settings/agentStackCatalog.ts";
import { normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../src/settings/settingsConstraints.ts";
import {
  normalizeStreamWatchVisualizerMode,
  normalizeVoiceAdmissionModeForDashboard,
  resolveVoiceAdmissionModeForSettings,
  resolveVoiceRuntimeModeFromSelection,
  resolveVoiceRuntimeSelectionFromMode
} from "../../src/settings/voiceDashboardMappings.ts";
import {
  OPENAI_REALTIME_SESSION_MODEL_OPTIONS
} from "../../src/voice/realtimeProviderNormalization.ts";
export const OPENAI_REALTIME_MODEL_OPTIONS = OPENAI_REALTIME_SESSION_MODEL_OPTIONS.slice(0, 3);

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

const BROWSER_PROVIDER_MODEL_FALLBACKS = Object.freeze({
  anthropic: ["claude-sonnet-4-5-20250929"],
  "claude-oauth": [...PROVIDER_MODEL_FALLBACKS["claude-oauth"]],
  openai: ["gpt-5-mini"]
});

export const BROWSER_RUNTIME_SELECTION_OPTIONS = Object.freeze([
  "inherit",
  "local_browser_agent",
  "openai_computer_use"
]);

export const OPENAI_COMPUTER_USE_CLIENT_OPTIONS = Object.freeze([
  "auto",
  "openai",
  "openai-oauth"
]);

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value !== undefined && value !== null ? value : fallback;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBrowserRuntimeSelection(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "local_browser_agent" || normalized === "openai_computer_use") {
    return normalized;
  }
  return "inherit";
}

function normalizeOpenAiComputerUseClientSelection(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-oauth") {
    return normalized;
  }
  return "auto";
}

function resolveSettingsEnvelope(settings: unknown): DashboardSettingsEnvelope {
  if (isDashboardSettingsEnvelope(settings)) {
    return settings;
  }
  return buildDashboardSettingsEnvelope({ intent: settings || DEFAULT_SETTINGS });
}

function buildSettingsFormView(settings: unknown) {
  const d = DEFAULT_SETTINGS;
  const envelope = resolveSettingsEnvelope(settings);
  const s = (envelope.effective || d) as Partial<Settings>;
  const intent = (envelope.intent || {}) as Partial<Settings>;
  const resolved = envelope.bindings;
  const agentStack = valueOr(s.agentStack, d.agentStack);
  const prompting = valueOr(s.prompting, d.prompting);
  const activity = valueOr(s.interaction?.activity, d.interaction.activity);
  const permissions = valueOr(s.permissions?.replies, d.permissions.replies);
  const textInitiative = valueOr(s.initiative?.text, d.initiative.text);
  const memory = valueOr(s.memory, d.memory);
  const automations = valueOr(s.automations, d.automations);
  const sessions = valueOr(s.interaction?.sessions, d.interaction.sessions);
  const followup = valueOr(s.interaction?.followup, d.interaction.followup);
  const replyGeneration = valueOr(s.interaction?.replyGeneration, d.interaction.replyGeneration);
  const orchestrator = resolved?.orchestrator || { provider: agentStack.overrides?.orchestrator?.provider || "openai", model: agentStack.overrides?.orchestrator?.model || "gpt-5" };
  const followupBinding = resolved?.followupBinding || orchestrator;
  const rawMemoryBinding =
    intent.memoryLlm && typeof intent.memoryLlm === "object" && !Array.isArray(intent.memoryLlm)
      ? intent.memoryLlm
      : {};
  const memoryOverrideConfigured =
    Boolean(String((rawMemoryBinding as Record<string, unknown>).provider || "").trim()) ||
    Boolean(String((rawMemoryBinding as Record<string, unknown>).model || "").trim());
  const memoryBinding = resolved?.memoryBinding || getResolvedMemoryBinding(s);
  const research = valueOr(agentStack.runtimeConfig?.research, d.agentStack.runtimeConfig.research);
  const browser = valueOr(agentStack.runtimeConfig?.browser, d.agentStack.runtimeConfig.browser);
  const browserRuntimeSelection = normalizeBrowserRuntimeSelection(intent.agentStack?.overrides?.browserRuntime);
  const browserExecution = browser.localBrowserAgent?.execution;
  const browserBinding =
    browserExecution?.mode === "dedicated_model" && browserExecution.model
      ? browserExecution.model
      : orchestrator;
  const devPermissions = valueOr(s.permissions?.devTasks, d.permissions.devTasks);
  const devTeam = valueOr(agentStack.runtimeConfig?.devTeam, d.agentStack.runtimeConfig.devTeam);
  const resolvedStack = resolved?.agentStack;
  const vision = valueOr(s.media?.vision, d.media.vision);
  const visionBinding = resolved?.visionBinding || orchestrator;
  const videoContext = valueOr(s.media?.videoContext, d.media.videoContext);
  const voiceSettings = valueOr(s.voice, d.voice);
  const transcription = valueOr(s.voice?.transcription, d.voice.transcription);
  const voiceChannelPolicy = valueOr(s.voice?.channelPolicy, d.voice.channelPolicy);
  const voiceSessionLimits = valueOr(s.voice?.sessionLimits, d.voice.sessionLimits);
  const voiceConversation = valueOr(s.voice?.conversationPolicy, d.voice.conversationPolicy);
  const voiceAdmission = valueOr(s.voice?.admission, d.voice.admission);
  const voiceInitiative = valueOr(s.initiative?.voice, d.initiative.voice);
  const voiceInitiativeBinding = resolved?.voiceInitiativeBinding || orchestrator;
  const textInitiativeBinding = resolved?.textInitiativeBinding || orchestrator;
  const voiceRuntime = valueOr(agentStack.runtimeConfig?.voice, d.agentStack.runtimeConfig.voice);
  const voiceGenerationBinding = resolved?.voiceGenerationBinding || orchestrator;
  const voiceClassifierBinding = resolved?.voiceAdmissionClassifierBinding;
  const voiceInterruptClassifierBinding =
    resolved?.voiceInterruptClassifierBinding || getResolvedVoiceInterruptClassifierBinding(s);
  const rawVoiceInterruptClassifier = intent.agentStack?.overrides?.voiceInterruptClassifier;
  const voiceInterruptClassifierExplicit = isRecordLike(rawVoiceInterruptClassifier);
  const voiceMusicBrainBinding = resolved?.voiceMusicBrainBinding || orchestrator;
  const voiceMusicBrainMode = String(voiceRuntime.musicBrain?.mode || d.agentStack.runtimeConfig.voice.musicBrain.mode || "disabled")
    .trim()
    .toLowerCase() === "disabled"
      ? "disabled"
      : "dedicated_model";
  const presetClassifierFallback = getPresetVoiceAdmissionClassifierFallback(agentStack.preset);
  const voiceClassifierFallback = voiceClassifierBinding || presetClassifierFallback || orchestrator;
  const presetInterruptClassifierFallback = getPresetVoiceInterruptClassifierFallback(agentStack.preset);
  const voiceInterruptClassifierFallback =
    voiceInterruptClassifierBinding || presetInterruptClassifierFallback || voiceClassifierFallback;
  const presetMusicBrainFallback = getPresetVoiceMusicBrainFallback(agentStack.preset);
  const voiceMusicBrainFallback = voiceMusicBrainBinding || presetMusicBrainFallback || orchestrator;
  const voiceStreamWatch = valueOr(s.voice?.streamWatch, d.voice.streamWatch);
  const voiceSoundboard = valueOr(s.voice?.soundboard, d.voice.soundboard);
  const startup = valueOr(s.interaction?.startup, d.interaction.startup);
  const discovery = valueOr(s.initiative?.discovery, d.initiative.discovery);
  const codingWorkers = resolvedStack?.devTeam?.codingWorkers || [];
  const codeAgentProvider =
    codingWorkers.length === 1
      ? codingWorkers[0] === "codex"
        ? "codex"
        : codingWorkers[0] === "codex_cli"
          ? "codex-cli"
        : "claude-code"
      : "auto";

  const voiceProviderStr = resolveVoiceRuntimeSelectionFromMode(
    voiceRuntime.runtimeMode || resolved?.agentStack?.voiceRuntime
  );

  return {
    agentStack,
    botName: s.identity?.botName || d.identity.botName,
    botNameAliases: Array.isArray(s.identity?.botNameAliases)
      ? s.identity.botNameAliases.map((v) => String(v || "").trim()).filter(Boolean)
      : [...d.identity.botNameAliases],
    persona: valueOr(s.persona, d.persona),
    prompt: {
      capabilityHonestyLine: prompting.global.capabilityHonestyLine,
      impossibleActionLine: prompting.global.impossibleActionLine,
      memoryEnabledLine: prompting.global.memoryEnabledLine,
      memoryDisabledLine: prompting.global.memoryDisabledLine,
      skipLine: prompting.global.skipLine,
      textGuidance: prompting.text.guidance,
      voiceGuidance: prompting.voice.guidance,
      voiceOperationalGuidance: prompting.voice.operationalGuidance,
      mediaPromptCraftGuidance: prompting.media.promptCraftGuidance
    },
    activity,
    permissions,
    textInitiative: {
      ...textInitiative,
      useTextModel: textInitiative.execution?.mode !== "dedicated_model",
      provider: textInitiativeBinding.provider,
      model: textInitiativeBinding.model
    },
    memory,
    automations,
    subAgentOrchestration: sessions,
    llm: orchestrator,
    replyGeneration: {
      temperature: replyGeneration.temperature,
      maxOutputTokens: replyGeneration.maxOutputTokens
    },
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
    memoryLlmInheritTextModel: !memoryOverrideConfigured,
    browser: {
      runtime: resolvedStack?.browserRuntime || "",
      runtimeSelection: browserRuntimeSelection,
      enabled: browser.enabled,
      headed: browser.headed,
      profile: String(browser.profile || ""),
      openAiComputerUseClient: normalizeOpenAiComputerUseClientSelection(browser.openaiComputerUse?.client),
      openAiComputerUseModel: String(browser.openaiComputerUse?.model || ""),
      maxBrowseCallsPerHour: browser.localBrowserAgent.maxBrowseCallsPerHour,
      llm: browserBinding,
      maxStepsPerTask: browser.localBrowserAgent.maxStepsPerTask,
      stepTimeoutMs: browser.localBrowserAgent.stepTimeoutMs,
      sessionTimeoutMs: browser.localBrowserAgent.sessionTimeoutMs
    },
    codeAgent: {
      enabled: devPermissions.allowedUserIds.length > 0 && Boolean(devTeam.codex?.enabled || devTeam.codexCli?.enabled || devTeam.claudeCode?.enabled),
      provider: codeAgentProvider,
      model: String(devTeam.claudeCode?.model || ""),
      codexModel: String(devTeam.codex?.model || ""),
      codexCliModel: String(devTeam.codexCli?.model || ""),
      maxTurns: Math.max(Number(devTeam.codex?.maxTurns || 0), Number(devTeam.codexCli?.maxTurns || 0), Number(devTeam.claudeCode?.maxTurns || 0)),
      timeoutMs: Math.max(Number(devTeam.codex?.timeoutMs || 0), Number(devTeam.codexCli?.timeoutMs || 0), Number(devTeam.claudeCode?.timeoutMs || 0)),
      maxBufferBytes: Math.max(
        Number(devTeam.codex?.maxBufferBytes || 0),
        Number(devTeam.codexCli?.maxBufferBytes || 0),
        Number(devTeam.claudeCode?.maxBufferBytes || 0)
      ),
      defaultCwd: String(devTeam.codexCli?.defaultCwd || devTeam.claudeCode?.defaultCwd || devTeam.codex?.defaultCwd || ""),
      maxTasksPerHour: Math.max(
        Number(devTeam.codex?.maxTasksPerHour || 0),
        Number(devTeam.codexCli?.maxTasksPerHour || 0),
        Number(devTeam.claudeCode?.maxTasksPerHour || 0)
      ),
      maxParallelTasks: Math.max(
        Number(devTeam.codex?.maxParallelTasks || 0),
        Number(devTeam.codexCli?.maxParallelTasks || 0),
        Number(devTeam.claudeCode?.maxParallelTasks || 0)
      ),
      asyncDispatchEnabled: Boolean(
        devTeam.codex?.asyncDispatch?.enabled ||
        devTeam.codexCli?.asyncDispatch?.enabled ||
        devTeam.claudeCode?.asyncDispatch?.enabled
      ),
      asyncDispatchThresholdMs: Math.max(
        Number(devTeam.codex?.asyncDispatch?.thresholdMs || 0),
        Number(devTeam.codexCli?.asyncDispatch?.thresholdMs || 0),
        Number(devTeam.claudeCode?.asyncDispatch?.thresholdMs || 0)
      ),
      asyncProgressReportsEnabled: Boolean(
        devTeam.codex?.asyncDispatch?.progressReports?.enabled ||
        devTeam.codexCli?.asyncDispatch?.progressReports?.enabled ||
        devTeam.claudeCode?.asyncDispatch?.progressReports?.enabled
      ),
      asyncProgressIntervalMs: Math.max(
        Number(devTeam.codex?.asyncDispatch?.progressReports?.intervalMs || 0),
        Number(devTeam.codexCli?.asyncDispatch?.progressReports?.intervalMs || 0),
        Number(devTeam.claudeCode?.asyncDispatch?.progressReports?.intervalMs || 0)
      ),
      asyncMaxReportsPerTask: Math.max(
        Number(devTeam.codex?.asyncDispatch?.progressReports?.maxReportsPerTask || 0),
        Number(devTeam.codexCli?.asyncDispatch?.progressReports?.maxReportsPerTask || 0),
        Number(devTeam.claudeCode?.asyncDispatch?.progressReports?.maxReportsPerTask || 0)
      ),
      allowedUserIds: devPermissions.allowedUserIds,
      roleDesign: String(resolvedStack?.devTeam?.roles?.design || ""),
      roleImplementation: String(resolvedStack?.devTeam?.roles?.implementation || ""),
      roleReview: String(resolvedStack?.devTeam?.roles?.review || ""),
      roleResearch: String(resolvedStack?.devTeam?.roles?.research || ""),
      workerConfigs: {
        codex: { ...devTeam.codex },
        codexCli: { ...devTeam.codexCli },
        claudeCode: { ...devTeam.claudeCode }
      }
    },
    vision: {
      captionEnabled: vision.enabled,
      provider: visionBinding.provider,
      model: visionBinding.model,
      maxCaptionsPerHour: vision.maxCaptionsPerHour
    },
    voiceMusicBrainMode,
    webSearch: {
      runtime: resolvedStack?.researchRuntime || "",
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
      voiceProvider: voiceProviderStr,
      replyPath: voiceConversation.replyPath,
      ttsMode: voiceConversation.ttsMode,
      thinking: voiceConversation.thinking || "disabled",
      transcriptionProvider: transcription.provider,
      asrLanguageMode: transcription.languageMode,
      asrLanguageHint: transcription.languageHint,
      allowNsfwHumor: voiceConversation.allowNsfwHumor,
      defaultInterruptionMode: voiceConversation.defaultInterruptionMode,
      useInterruptClassifier: voiceConversation.useInterruptClassifier,
      maxSessionMinutes: voiceSessionLimits.maxSessionMinutes,
      inactivityLeaveSeconds: voiceSessionLimits.inactivityLeaveSeconds,
      maxSessionsPerDay: voiceSessionLimits.maxSessionsPerDay,
      maxConcurrentSessions: voiceSessionLimits.maxConcurrentSessions,
      ambientReplyEagerness: voiceConversation.ambientReplyEagerness,
      streaming: voiceConversation.streaming,
      commandOnlyMode: voiceConversation.commandOnlyMode,
      thoughtEngine: {
        enabled: voiceInitiative.enabled,
        provider: voiceInitiativeBinding.provider,
        model: voiceInitiativeBinding.model,
        temperature: voiceInitiative.execution?.temperature,
        eagerness: voiceInitiative.eagerness,
        minSilenceSeconds: voiceInitiative.minSilenceSeconds,
        minSecondsBetweenThoughts: voiceInitiative.minSecondsBetweenThoughts
      },
      replyDecisionLlm: {
        realtimeAdmissionMode: voiceAdmission.mode,
        musicWakeLatchSeconds: voiceAdmission.musicWakeLatchSeconds,
        provider: voiceClassifierFallback.provider,
        model: voiceClassifierFallback.model
      },
      interruptLlm: {
        explicit: voiceInterruptClassifierExplicit,
        provider: voiceInterruptClassifierFallback.provider,
        model: voiceInterruptClassifierFallback.model
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
      openaiAudioApi: voiceRuntime.openaiAudioApi,
      streamWatch: voiceStreamWatch,
      soundboard: voiceSoundboard,
      asrEnabled: transcription.enabled,
      textOnlyMode: voiceConversation.textOnlyMode,
      operationalMessages: voiceConversation.operationalMessages
    },
    startup,
    discovery,
    providerAuth: resolved?.providerAuth || {}
  };
}

const DEFAULT_VIEW = buildSettingsFormView(DEFAULT_SETTINGS);

export function settingsToForm(settings: unknown) {
  const defaults = DEFAULT_VIEW;
  const envelope = resolveSettingsEnvelope(settings || DEFAULT_SETTINGS);
  const resolved = buildSettingsFormView(envelope);
  const voiceMusicBrainFallback = getResolvedVoiceMusicBrainBinding(envelope.effective);
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
  const defaultVoiceInterruptLlm = defaults.voice.interruptLlm;
  const defaultVoiceMusicBrainMode = defaults.voiceMusicBrainMode || "disabled";
  const defaultVoiceStreaming = defaults.voice.streaming;
  const defaultVoiceStreamWatch = defaults.voice.streamWatch;
  const defaultVoiceSoundboard = defaults.voice.soundboard;
  const defaultStartup = defaults.startup;
  const defaultTextInitiative = defaults.textInitiative;
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
    promptMediaPromptCraftGuidance: resolved.prompt.mediaPromptCraftGuidance ?? defaultPrompt.mediaPromptCraftGuidance,
    textAmbientReplyEagerness:
      activity.ambientReplyEagerness ?? defaultActivity.ambientReplyEagerness,
    responseWindowEagerness:
      activity.responseWindowEagerness ?? defaultActivity.responseWindowEagerness,
    reactivity: activity.reactivity ?? defaultActivity.reactivity,
    minGap: activity.minSecondsBetweenMessages ?? defaultActivity.minSecondsBetweenMessages,
    allowReplies: resolved.permissions.allowReplies ?? defaultPermissions.allowReplies,
    allowUnsolicitedReplies:
      resolved.permissions.allowUnsolicitedReplies ?? defaultPermissions.allowUnsolicitedReplies,
    allowReactions: resolved.permissions.allowReactions ?? defaultPermissions.allowReactions,
    textInitiativeEnabled:
      resolved.textInitiative.enabled ?? defaultTextInitiative.enabled,
    textInitiativeEagerness:
      resolved.textInitiative.eagerness ?? defaultTextInitiative.eagerness,
    textInitiativeMinMinutesBetweenPosts:
      resolved.textInitiative.minMinutesBetweenPosts ??
      defaultTextInitiative.minMinutesBetweenPosts,
    textInitiativeMaxPostsPerDay:
      resolved.textInitiative.maxPostsPerDay ?? defaultTextInitiative.maxPostsPerDay,
    textInitiativeLookbackMessages:
      resolved.textInitiative.lookbackMessages ?? defaultTextInitiative.lookbackMessages,
    textInitiativeAllowActiveCuriosity:
      resolved.textInitiative.allowActiveCuriosity ?? defaultTextInitiative.allowActiveCuriosity,
    textInitiativeMaxToolSteps:
      resolved.textInitiative.maxToolSteps ?? defaultTextInitiative.maxToolSteps,
    textInitiativeMaxToolCalls:
      resolved.textInitiative.maxToolCalls ?? defaultTextInitiative.maxToolCalls,
    textInitiativeUseTextModel:
      resolved.textInitiative.useTextModel ?? defaultTextInitiative.useTextModel,
    textInitiativeLlmProvider:
      resolved.textInitiative.provider ?? defaultTextInitiative.provider,
    textInitiativeLlmModel:
      resolved.textInitiative.model ?? defaultTextInitiative.model,
    memoryEnabled: resolved.memory.enabled ?? defaults.memory.enabled,
    automationsEnabled:
      resolved.automations.enabled ?? defaults.automations.enabled,
    subAgentSessionIdleTimeoutMs:
      resolved.subAgentOrchestration.sessionIdleTimeoutMs ?? defaults.subAgentOrchestration.sessionIdleTimeoutMs,
    subAgentMaxConcurrentSessions:
      resolved.subAgentOrchestration.maxConcurrentSessions ?? defaults.subAgentOrchestration.maxConcurrentSessions,
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
    memoryLlmInheritTextModel: resolved.memoryLlmInheritTextModel ?? true,
    memoryLlmProvider: resolved.memoryLlm.provider ?? defaultMemoryLlm.provider,
    memoryLlmModel: resolved.memoryLlm.model ?? defaultMemoryLlm.model,
    temperature: resolved.replyGeneration.temperature ?? defaults.replyGeneration.temperature,
    maxTokens: resolved.replyGeneration.maxOutputTokens ?? defaults.replyGeneration.maxOutputTokens,
    browserEnabled: resolved.browser.enabled ?? defaults.browser.enabled,
    browserHeaded: resolved.browser.headed ?? defaults.browser.headed,
    browserProfile: resolved.browser.profile ?? defaults.browser.profile ?? "",
    stackResolvedResearchRuntime: resolved.webSearch.runtime ?? defaultWebSearch.runtime,
    stackResolvedBrowserRuntime: resolved.browser.runtime ?? defaults.browser.runtime,
    browserRuntimeSelection: resolved.browser.runtimeSelection ?? defaults.browser.runtimeSelection,
    browserOpenAiComputerUseClient:
      resolved.browser.openAiComputerUseClient ?? defaults.browser.openAiComputerUseClient,
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
    codeAgentCodexCliModel: resolved.codeAgent.codexCliModel ?? defaults.codeAgent.codexCliModel,
    codeAgentMaxTurns: resolved.codeAgent.maxTurns ?? defaults.codeAgent.maxTurns,
    codeAgentTimeoutMs: resolved.codeAgent.timeoutMs ?? defaults.codeAgent.timeoutMs,
    codeAgentMaxBufferBytes: resolved.codeAgent.maxBufferBytes ?? defaults.codeAgent.maxBufferBytes,
    codeAgentDefaultCwd: resolved.codeAgent.defaultCwd ?? defaults.codeAgent.defaultCwd,
    codeAgentMaxTasksPerHour: resolved.codeAgent.maxTasksPerHour ?? defaults.codeAgent.maxTasksPerHour,
    codeAgentMaxParallelTasks: resolved.codeAgent.maxParallelTasks ?? defaults.codeAgent.maxParallelTasks,
    codeAgentAsyncDispatchEnabled:
      resolved.codeAgent.asyncDispatchEnabled ?? defaults.codeAgent.asyncDispatchEnabled,
    codeAgentAsyncDispatchThresholdMs:
      resolved.codeAgent.asyncDispatchThresholdMs ?? defaults.codeAgent.asyncDispatchThresholdMs,
    codeAgentAsyncProgressReportsEnabled:
      resolved.codeAgent.asyncProgressReportsEnabled ?? defaults.codeAgent.asyncProgressReportsEnabled,
    codeAgentAsyncProgressIntervalMs:
      resolved.codeAgent.asyncProgressIntervalMs ?? defaults.codeAgent.asyncProgressIntervalMs,
    codeAgentAsyncMaxReportsPerTask:
      resolved.codeAgent.asyncMaxReportsPerTask ?? defaults.codeAgent.asyncMaxReportsPerTask,
    codeAgentAllowedUserIds: formatLineList(resolved.codeAgent.allowedUserIds ?? defaults.codeAgent.allowedUserIds),
    codeAgentRoleDesign: String(resolved.codeAgent.roleDesign ?? "claude_code"),
    codeAgentRoleImplementation: String(resolved.codeAgent.roleImplementation ?? "claude_code"),
    codeAgentRoleReview: String(resolved.codeAgent.roleReview ?? "claude_code"),
    codeAgentRoleResearch: String(resolved.codeAgent.roleResearch ?? "claude_code"),
    providerAuthClaudeCode: Boolean(resolved.providerAuth?.claude_code),
    providerAuthCodexCli: Boolean(resolved.providerAuth?.codex_cli),
    providerAuthCodex: Boolean(resolved.providerAuth?.codex),
    codeAgentWorkerConfigs: resolved.codeAgent.workerConfigs ?? defaults.codeAgent.workerConfigs,
    visionCaptionEnabled: resolved.vision.captionEnabled ?? defaultVision.captionEnabled,
    visionProvider: resolved.vision.provider ?? defaultVision.provider,
    visionModel: resolved.vision.model ?? defaultVision.model,
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
    voiceThinking: resolved?.voice?.thinking ?? defaultVoice.thinking ?? "disabled",
    voiceAsrLanguageMode: resolved?.voice?.asrLanguageMode ?? defaultVoice.asrLanguageMode,
    voiceAsrLanguageHint: resolved?.voice?.asrLanguageHint ?? defaultVoice.asrLanguageHint,
    voiceAllowNsfwHumor: resolved?.voice?.allowNsfwHumor ?? defaultVoice.allowNsfwHumor,
    voiceDefaultInterruptionMode:
      resolved?.voice?.defaultInterruptionMode ?? defaultVoice.defaultInterruptionMode ?? "speaker",
    voiceUseInterruptClassifier:
      resolved?.voice?.useInterruptClassifier ?? defaultVoice.useInterruptClassifier ?? true,
    voiceMaxSessionMinutes: resolved?.voice?.maxSessionMinutes ?? defaultVoice.maxSessionMinutes,
    voiceInactivityLeaveSeconds: resolved?.voice?.inactivityLeaveSeconds ?? defaultVoice.inactivityLeaveSeconds,
    voiceMaxSessionsPerDay: resolved?.voice?.maxSessionsPerDay ?? defaultVoice.maxSessionsPerDay,
    voiceMaxConcurrentSessions: resolved?.voice?.maxConcurrentSessions ?? defaultVoice.maxConcurrentSessions,
    voiceAmbientReplyEagerness:
      resolved?.voice?.ambientReplyEagerness ?? defaultVoice.ambientReplyEagerness,
    voiceStreamingEnabled:
      resolved?.voice?.streaming?.enabled ?? defaultVoiceStreaming.enabled,
    voiceStreamingMinSentencesPerChunk:
      resolved?.voice?.streaming?.minSentencesPerChunk ?? defaultVoiceStreaming.minSentencesPerChunk,
    voiceStreamingEagerFirstChunkChars:
      resolved?.voice?.streaming?.eagerFirstChunkChars ?? defaultVoiceStreaming.eagerFirstChunkChars,
    voiceStreamingMaxBufferChars:
      resolved?.voice?.streaming?.maxBufferChars ?? defaultVoiceStreaming.maxBufferChars,
    voiceCommandOnlyMode: resolved?.voice?.commandOnlyMode ?? defaultVoice.commandOnlyMode,
    voiceThoughtEngineEnabled:
      resolved?.voice?.thoughtEngine?.enabled ?? defaultVoiceThoughtEngine.enabled,
    voiceThoughtEngineEagerness:
      resolved?.voice?.thoughtEngine?.eagerness ?? defaultVoiceThoughtEngine.eagerness,
    voiceThoughtEngineMinSilenceSeconds:
      resolved?.voice?.thoughtEngine?.minSilenceSeconds ?? defaultVoiceThoughtEngine.minSilenceSeconds,
    voiceThoughtEngineMinSecondsBetweenThoughts:
      resolved?.voice?.thoughtEngine?.minSecondsBetweenThoughts ??
      defaultVoiceThoughtEngine.minSecondsBetweenThoughts,
    voiceReplyDecisionRealtimeAdmissionMode: resolveVoiceAdmissionModeForSettings({
      value:
        resolved?.voice?.replyDecisionLlm?.realtimeAdmissionMode ??
        defaultVoice.replyDecisionLlm.realtimeAdmissionMode,
      replyPath: resolved?.voice?.replyPath ?? defaultVoice.replyPath
    }),
    voiceReplyDecisionMusicWakeLatchSeconds:
      resolved?.voice?.replyDecisionLlm?.musicWakeLatchSeconds ?? defaultVoice.replyDecisionLlm.musicWakeLatchSeconds,
    voiceReplyDecisionLlmProvider:
      resolved?.voice?.replyDecisionLlm?.provider ?? defaultVoice.replyDecisionLlm.provider,
    voiceReplyDecisionLlmModel:
      resolved?.voice?.replyDecisionLlm?.model ?? defaultVoice.replyDecisionLlm.model,
    voiceInterruptLlmExplicit:
      resolved?.voice?.interruptLlm?.explicit ?? false,
    voiceInterruptLlmProvider:
      resolved?.voice?.interruptLlm?.provider ?? defaultVoiceInterruptLlm.provider,
    voiceInterruptLlmModel:
      resolved?.voice?.interruptLlm?.model ?? defaultVoiceInterruptLlm.model,
    voiceMusicBrainMode:
      resolved.voiceMusicBrainMode ?? defaultVoiceMusicBrainMode,
    voiceMusicBrainLlmProvider:
      voiceMusicBrainFallback.provider,
    voiceMusicBrainLlmModel:
      voiceMusicBrainFallback.model,
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
    voiceElevenLabsRealtimeVoiceId:
      resolved?.voice?.elevenLabsRealtime?.voiceId ?? defaultVoiceElevenLabsRealtime.voiceId,
    voiceElevenLabsRealtimeTtsModel:
      resolved?.voice?.elevenLabsRealtime?.ttsModel ?? defaultVoiceElevenLabsRealtime.ttsModel,
    voiceElevenLabsRealtimeTranscriptionModel:
      resolved?.voice?.elevenLabsRealtime?.transcriptionModel ?? defaultVoiceElevenLabsRealtime.transcriptionModel,
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
    voiceStreamWatchCommentaryEagerness:
      resolved?.voice?.streamWatch?.commentaryEagerness ?? defaultVoiceStreamWatch.commentaryEagerness,
    voiceStreamWatchVisualizerMode:
      resolved?.voice?.streamWatch?.visualizerMode ?? defaultVoiceStreamWatch.visualizerMode,
    voiceStreamWatchCommentaryIntervalSeconds:
      resolved?.voice?.streamWatch?.commentaryIntervalSeconds ?? defaultVoiceStreamWatch.commentaryIntervalSeconds,
    voiceStreamWatchMaxFramesPerMinute: resolved?.voice?.streamWatch?.maxFramesPerMinute ?? defaultVoiceStreamWatch.maxFramesPerMinute,
    voiceStreamWatchMaxFrameBytes: resolved?.voice?.streamWatch?.maxFrameBytes ?? defaultVoiceStreamWatch.maxFrameBytes,
    voiceStreamWatchKeyframeIntervalMs:
      resolved?.voice?.streamWatch?.keyframeIntervalMs ?? defaultVoiceStreamWatch.keyframeIntervalMs,
    voiceStreamWatchAutonomousCommentaryEnabled:
      resolved?.voice?.streamWatch?.autonomousCommentaryEnabled ?? defaultVoiceStreamWatch.autonomousCommentaryEnabled,
    voiceStreamWatchNoteProvider:
      resolved?.voice?.streamWatch?.noteProvider ?? defaultVoiceStreamWatch.noteProvider ?? "",
    voiceStreamWatchNoteModel:
      resolved?.voice?.streamWatch?.noteModel ?? defaultVoiceStreamWatch.noteModel ?? "",
    voiceStreamWatchNoteIntervalSeconds:
      resolved?.voice?.streamWatch?.noteIntervalSeconds ?? defaultVoiceStreamWatch.noteIntervalSeconds,
    voiceStreamWatchNoteIdleIntervalSeconds:
      resolved?.voice?.streamWatch?.noteIdleIntervalSeconds ?? defaultVoiceStreamWatch.noteIdleIntervalSeconds,
    voiceStreamWatchStaticFloor:
      resolved?.voice?.streamWatch?.staticFloor ?? defaultVoiceStreamWatch.staticFloor,
    voiceStreamWatchMaxNoteEntries:
      resolved?.voice?.streamWatch?.maxNoteEntries ?? defaultVoiceStreamWatch.maxNoteEntries,
    voiceStreamWatchChangeThreshold:
      resolved?.voice?.streamWatch?.changeThreshold ?? defaultVoiceStreamWatch.changeThreshold,
    voiceStreamWatchChangeMinIntervalSeconds:
      resolved?.voice?.streamWatch?.changeMinIntervalSeconds ?? defaultVoiceStreamWatch.changeMinIntervalSeconds,
    voiceStreamWatchNotePrompt:
      resolved?.voice?.streamWatch?.notePrompt ?? defaultVoiceStreamWatch.notePrompt,
    voiceStreamWatchCommentaryProvider:
      resolved?.voice?.streamWatch?.commentaryProvider ?? defaultVoiceStreamWatch.commentaryProvider ?? "",
    voiceStreamWatchCommentaryModel:
      resolved?.voice?.streamWatch?.commentaryModel ?? defaultVoiceStreamWatch.commentaryModel ?? "",
    voiceStreamWatchNativeDiscordMaxFramesPerSecond:
      resolved?.voice?.streamWatch?.nativeDiscordMaxFramesPerSecond ??
      defaultVoiceStreamWatch.nativeDiscordMaxFramesPerSecond,
    voiceStreamWatchNativeDiscordPreferredQuality:
      resolved?.voice?.streamWatch?.nativeDiscordPreferredQuality ??
      defaultVoiceStreamWatch.nativeDiscordPreferredQuality,
    voiceStreamWatchNativeDiscordPreferredPixelCount:
      resolved?.voice?.streamWatch?.nativeDiscordPreferredPixelCount ??
      defaultVoiceStreamWatch.nativeDiscordPreferredPixelCount,
    voiceStreamWatchNativeDiscordJpegQuality:
      resolved?.voice?.streamWatch?.nativeDiscordJpegQuality ??
      defaultVoiceStreamWatch.nativeDiscordJpegQuality,
    voiceStreamWatchNativeDiscordPreferredStreamType:
      resolved?.voice?.streamWatch?.nativeDiscordPreferredStreamType ??
      defaultVoiceStreamWatch.nativeDiscordPreferredStreamType,
    voiceStreamWatchSharePageMaxWidthPx:
      resolved?.voice?.streamWatch?.sharePageMaxWidthPx ?? defaultVoiceStreamWatch.sharePageMaxWidthPx,
    voiceStreamWatchSharePageJpegQuality:
      resolved?.voice?.streamWatch?.sharePageJpegQuality ?? defaultVoiceStreamWatch.sharePageJpegQuality,
    voiceSoundboardEagerness:
      resolved?.voice?.soundboard?.eagerness ?? defaultVoiceSoundboard.eagerness,
    voiceSoundboardEnabled: resolved?.voice?.soundboard?.enabled ?? defaultVoiceSoundboard.enabled,
    voiceSoundboardAllowExternalSounds: resolved?.voice?.soundboard?.allowExternalSounds ?? defaultVoiceSoundboard.allowExternalSounds,
    voiceSoundboardPreferredSoundIds: formatLineList(resolved?.voice?.soundboard?.preferredSoundIds),
    voiceApiTtsModel:
      resolved?.voice?.openaiAudioApi?.ttsModel ?? defaults.voice.openaiAudioApi.ttsModel,
    voiceApiTtsVoice:
      resolved?.voice?.openaiAudioApi?.ttsVoice ?? defaults.voice.openaiAudioApi.ttsVoice,
    voiceApiTtsSpeed:
      resolved?.voice?.openaiAudioApi?.ttsSpeed ?? defaults.voice.openaiAudioApi.ttsSpeed,
    voiceAsrEnabled: resolved?.voice?.asrEnabled ?? defaultVoice.asrEnabled ?? true,
    voiceTranscriptionProvider:
      resolved?.voice?.transcriptionProvider ?? defaultVoice.transcriptionProvider ?? "openai",
    voiceTextOnlyMode: resolved?.voice?.textOnlyMode ?? defaultVoice.textOnlyMode ?? false,
    voiceOperationalMessages: resolved?.voice?.operationalMessages ?? defaultVoice.operationalMessages ?? "minimal",
    maxMessages: resolved?.permissions?.maxMessagesPerHour ?? defaultPermissions.maxMessagesPerHour,
    maxReactions: resolved?.permissions?.maxReactionsPerHour ?? defaultPermissions.maxReactionsPerHour,
    catchupEnabled: Boolean(resolved?.startup?.catchupEnabled ?? true),
    catchupLookbackHours: resolved?.startup?.catchupLookbackHours ?? defaultStartup.catchupLookbackHours,
    catchupMaxMessages: resolved?.startup?.catchupMaxMessagesPerChannel ?? defaultStartup.catchupMaxMessagesPerChannel,
    catchupMaxReplies: resolved?.startup?.maxCatchupRepliesPerChannel ?? defaultStartup.maxCatchupRepliesPerChannel,
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
    discoveryFeedEnabled: Boolean(
      resolved?.discovery?.sources?.reddit ||
      resolved?.discovery?.sources?.hackerNews ||
      resolved?.discovery?.sources?.youtube ||
      resolved?.discovery?.sources?.rss ||
      resolved?.discovery?.sources?.x
    ),
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
    discoveryMaxLinks:
      resolved?.discovery?.maxLinksPerPost ?? defaultDiscovery.maxLinksPerPost,
    discoveryMaxCandidates:
      resolved?.discovery?.maxCandidatesForPrompt ?? defaultDiscovery.maxCandidatesForPrompt,
    discoveryMaxMediaPromptChars:
      resolved?.discovery?.maxMediaPromptChars ?? defaultDiscovery.maxMediaPromptChars,
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
    discoveryAllowSelfCuration:
      resolved?.discovery?.allowSelfCuration ?? defaultDiscovery.allowSelfCuration,
    discoveryMaxSourcesPerType:
      resolved?.discovery?.maxSourcesPerType ?? defaultDiscovery.maxSourcesPerType,
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
    discoveryChannels: formatLineList(resolved?.permissions?.discoveryChannelIds),
    allowedChannels: formatLineList(resolved?.permissions?.allowedChannelIds),
    blockedChannels: formatLineList(resolved?.permissions?.blockedChannelIds),
    blockedUsers: formatLineList(resolved?.permissions?.blockedUserIds)
  };
}

type SettingsForm = ReturnType<typeof settingsToForm>;

export function getEffectiveBrowserRuntime(form: Record<string, unknown> | null | undefined) {
  const selection = normalizeBrowserRuntimeSelection(form?.browserRuntimeSelection);
  if (selection !== "inherit") return selection;
  const resolvedRuntime = String(form?.stackResolvedBrowserRuntime || "").trim().toLowerCase();
  return resolvedRuntime || "local_browser_agent";
}

export function getCodeAgentValidationError(form: SettingsForm): string {
  if (!form.stackAdvancedOverridesEnabled || !form.codeAgentEnabled) {
    return "";
  }
  const patch = formToSettingsPatch(form);
  return (patch.permissions?.devTasks?.allowedUserIds || []).length > 0
    ? ""
    : "Add at least one allowed user ID before enabling the code agent.";
}

type SettingsFormValidationError = {
  sectionId: string;
  message: string;
};

function isBlankNumericInput(value: unknown) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function validateNumericField({
  enabled = true,
  sectionId,
  label,
  value,
  min,
  max,
  integer = true
}: {
  enabled?: boolean;
  sectionId: string;
  label: string;
  value: unknown;
  min: number;
  max: number;
  integer?: boolean;
}): SettingsFormValidationError | null {
  if (!enabled) return null;
  if (isBlankNumericInput(value)) {
    return {
      sectionId,
      message: `${label} is required.`
    };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      sectionId,
      message: `${label} must be a valid number.`
    };
  }
  if (integer && !Number.isInteger(parsed)) {
    return {
      sectionId,
      message: `${label} must be a whole number.`
    };
  }
  if (parsed < min || parsed > max) {
    return {
      sectionId,
      message: `${label} must be between ${min} and ${max}.`
    };
  }

  return null;
}

export function getSettingsValidationError(form: SettingsForm): SettingsFormValidationError | null {
  const codeAgentValidationError = getCodeAgentValidationError(form);
  if (codeAgentValidationError) {
    return {
      sectionId: "sec-code-agent",
      message: codeAgentValidationError
    };
  }

  const validations: SettingsFormValidationError[] = [
    validateNumericField({
      sectionId: "sec-llm",
      label: "Temperature",
      value: form.temperature,
      min: 0,
      max: 2,
      integer: false
    }),
    validateNumericField({
      sectionId: "sec-llm",
      label: "Max output tokens",
      value: form.maxTokens,
      min: 32,
      max: 16_384
    }),
    validateNumericField({
      enabled: Boolean(form.replyFollowupLlmEnabled),
      sectionId: "sec-llm",
      label: "Follow-up tool timeout (ms)",
      value: form.replyFollowupToolTimeoutMs,
      min: 1_000,
      max: 120_000
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Text ambient reply eagerness",
      value: form.textAmbientReplyEagerness,
      min: 0,
      max: 100
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Response-window eagerness",
      value: form.responseWindowEagerness,
      min: 0,
      max: 100
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Reactivity",
      value: form.reactivity,
      min: 0,
      max: 100
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Minimum seconds between messages",
      value: form.minGap,
      min: 5,
      max: 300
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Max messages per hour",
      value: form.maxMessages,
      min: SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxMessagesPerHour.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxMessagesPerHour.max
    }),
    validateNumericField({
      sectionId: "sec-rate",
      label: "Max reactions per hour",
      value: form.maxReactions,
      min: SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxReactionsPerHour.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxReactionsPerHour.max
    }),
    validateNumericField({
      sectionId: "sec-startup",
      label: "Catch-up lookback hours",
      value: form.catchupLookbackHours,
      min: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.max
    }),
    validateNumericField({
      sectionId: "sec-startup",
      label: "Catch-up max messages per channel",
      value: form.catchupMaxMessages,
      min: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.max
    }),
    validateNumericField({
      sectionId: "sec-startup",
      label: "Catch-up max replies per channel",
      value: form.catchupMaxReplies,
      min: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled),
      sectionId: "sec-orchestration",
      label: "Session idle timeout (ms)",
      value: form.subAgentSessionIdleTimeoutMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.sessionIdleTimeoutMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.sessionIdleTimeoutMs.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled),
      sectionId: "sec-orchestration",
      label: "Max concurrent sessions",
      value: form.subAgentMaxConcurrentSessions,
      min: SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.maxConcurrentSessions.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.maxConcurrentSessions.max
    }),
    validateNumericField({
      enabled: Boolean(form.browserEnabled),
      sectionId: "sec-browser",
      label: "Max browse calls per hour",
      value: form.browserMaxPerHour,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxBrowseCallsPerHour.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxBrowseCallsPerHour.max
    }),
    validateNumericField({
      enabled: Boolean(form.browserEnabled),
      sectionId: "sec-browser",
      label: "Max steps per task",
      value: form.browserMaxSteps,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxStepsPerTask.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.maxStepsPerTask.max
    }),
    validateNumericField({
      enabled: Boolean(form.browserEnabled),
      sectionId: "sec-browser",
      label: "Browser step timeout (ms)",
      value: form.browserStepTimeoutMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.stepTimeoutMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.stepTimeoutMs.max
    }),
    validateNumericField({
      enabled: Boolean(form.browserEnabled),
      sectionId: "sec-browser",
      label: "Browser session timeout (ms)",
      value: form.browserSessionTimeoutMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.sessionTimeoutMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.browser.sessionTimeoutMs.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled && form.codeAgentEnabled),
      sectionId: "sec-code-agent",
      label: "Max parallel tasks",
      value: form.codeAgentMaxParallelTasks,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled && form.codeAgentEnabled),
      sectionId: "sec-code-agent",
      label: "Max tasks per hour",
      value: form.codeAgentMaxTasksPerHour,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled && form.codeAgentEnabled),
      sectionId: "sec-code-agent",
      label: "Max turns per task",
      value: form.codeAgentMaxTurns,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTurns.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled && form.codeAgentEnabled),
      sectionId: "sec-code-agent",
      label: "Code agent timeout (ms)",
      value: form.codeAgentTimeoutMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.timeoutMs.max
    }),
    validateNumericField({
      enabled: Boolean(form.stackAdvancedOverridesEnabled && form.codeAgentEnabled),
      sectionId: "sec-code-agent",
      label: "Max buffer bytes",
      value: form.codeAgentMaxBufferBytes,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxBufferBytes.max
    }),
    validateNumericField({
      enabled: Boolean(
        form.stackAdvancedOverridesEnabled &&
        form.codeAgentEnabled &&
        form.codeAgentAsyncDispatchEnabled
      ),
      sectionId: "sec-code-agent",
      label: "Async dispatch threshold (ms)",
      value: form.codeAgentAsyncDispatchThresholdMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.max
    }),
    validateNumericField({
      enabled: Boolean(
        form.stackAdvancedOverridesEnabled &&
        form.codeAgentEnabled &&
        form.codeAgentAsyncDispatchEnabled &&
        form.codeAgentAsyncProgressReportsEnabled
      ),
      sectionId: "sec-code-agent",
      label: "Async progress interval (ms)",
      value: form.codeAgentAsyncProgressIntervalMs,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.max
    }),
    validateNumericField({
      enabled: Boolean(
        form.stackAdvancedOverridesEnabled &&
        form.codeAgentEnabled &&
        form.codeAgentAsyncDispatchEnabled &&
        form.codeAgentAsyncProgressReportsEnabled
      ),
      sectionId: "sec-code-agent",
      label: "Async max progress reports per task",
      value: form.codeAgentAsyncMaxReportsPerTask,
      min: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.min,
      max: SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.max
    })
  ].filter((entry): entry is SettingsFormValidationError => entry !== null);

  return validations[0] || null;
}

function buildSettingsInputFromForm(form: SettingsForm): SettingsInput {
  const discoveryFeedEnabled = Boolean(form.discoveryFeedEnabled);
  const advancedOverridesEnabled = Boolean(form.stackAdvancedOverridesEnabled);
  const normalizedCodeAgentProvider = String(form.codeAgentProvider || "auto").trim().toLowerCase();
  const rawCodeAgentWorkerConfigs =
    form.codeAgentWorkerConfigs && typeof form.codeAgentWorkerConfigs === "object"
      ? form.codeAgentWorkerConfigs as Record<string, Record<string, unknown>>
      : {};
  const preservedCodeAgentWorkers = {
    codex:
      rawCodeAgentWorkerConfigs.codex && typeof rawCodeAgentWorkerConfigs.codex === "object"
        ? rawCodeAgentWorkerConfigs.codex
        : {},
    codexCli:
      rawCodeAgentWorkerConfigs.codexCli && typeof rawCodeAgentWorkerConfigs.codexCli === "object"
        ? rawCodeAgentWorkerConfigs.codexCli
        : {},
    claudeCode:
      rawCodeAgentWorkerConfigs.claudeCode && typeof rawCodeAgentWorkerConfigs.claudeCode === "object"
        ? rawCodeAgentWorkerConfigs.claudeCode
        : {}
  };
  const preservedCodeAgentAggregate = {
    maxTurns: Math.max(
      Number(preservedCodeAgentWorkers.codex.maxTurns || 0),
      Number(preservedCodeAgentWorkers.codexCli.maxTurns || 0),
      Number(preservedCodeAgentWorkers.claudeCode.maxTurns || 0)
    ),
    timeoutMs: Math.max(
      Number(preservedCodeAgentWorkers.codex.timeoutMs || 0),
      Number(preservedCodeAgentWorkers.codexCli.timeoutMs || 0),
      Number(preservedCodeAgentWorkers.claudeCode.timeoutMs || 0)
    ),
    maxBufferBytes: Math.max(
      Number(preservedCodeAgentWorkers.codex.maxBufferBytes || 0),
      Number(preservedCodeAgentWorkers.codexCli.maxBufferBytes || 0),
      Number(preservedCodeAgentWorkers.claudeCode.maxBufferBytes || 0)
    ),
    defaultCwd: String(
      preservedCodeAgentWorkers.codex.defaultCwd ||
      preservedCodeAgentWorkers.codexCli.defaultCwd ||
      preservedCodeAgentWorkers.claudeCode.defaultCwd ||
      ""
    ).trim(),
    maxTasksPerHour: Math.max(
      Number(preservedCodeAgentWorkers.codex.maxTasksPerHour || 0),
      Number(preservedCodeAgentWorkers.codexCli.maxTasksPerHour || 0),
      Number(preservedCodeAgentWorkers.claudeCode.maxTasksPerHour || 0)
    ),
    maxParallelTasks: Math.max(
      Number(preservedCodeAgentWorkers.codex.maxParallelTasks || 0),
      Number(preservedCodeAgentWorkers.codexCli.maxParallelTasks || 0),
      Number(preservedCodeAgentWorkers.claudeCode.maxParallelTasks || 0)
    ),
    asyncDispatchEnabled: Boolean(
      preservedCodeAgentWorkers.codex.asyncDispatch?.enabled ||
      preservedCodeAgentWorkers.codexCli.asyncDispatch?.enabled ||
      preservedCodeAgentWorkers.claudeCode.asyncDispatch?.enabled
    ),
    asyncDispatchThresholdMs: Math.max(
      Number(preservedCodeAgentWorkers.codex.asyncDispatch?.thresholdMs || 0),
      Number(preservedCodeAgentWorkers.codexCli.asyncDispatch?.thresholdMs || 0),
      Number(preservedCodeAgentWorkers.claudeCode.asyncDispatch?.thresholdMs || 0)
    ),
    asyncProgressReportsEnabled: Boolean(
      preservedCodeAgentWorkers.codex.asyncDispatch?.progressReports?.enabled ||
      preservedCodeAgentWorkers.codexCli.asyncDispatch?.progressReports?.enabled ||
      preservedCodeAgentWorkers.claudeCode.asyncDispatch?.progressReports?.enabled
    ),
    asyncProgressIntervalMs: Math.max(
      Number(preservedCodeAgentWorkers.codex.asyncDispatch?.progressReports?.intervalMs || 0),
      Number(preservedCodeAgentWorkers.codexCli.asyncDispatch?.progressReports?.intervalMs || 0),
      Number(preservedCodeAgentWorkers.claudeCode.asyncDispatch?.progressReports?.intervalMs || 0)
    ),
    asyncMaxReportsPerTask: Math.max(
      Number(preservedCodeAgentWorkers.codex.asyncDispatch?.progressReports?.maxReportsPerTask || 0),
      Number(preservedCodeAgentWorkers.codexCli.asyncDispatch?.progressReports?.maxReportsPerTask || 0),
      Number(preservedCodeAgentWorkers.claudeCode.asyncDispatch?.progressReports?.maxReportsPerTask || 0)
    )
  };
  const codeAgentSharedOverrides = {
    maxTurns: Number(form.codeAgentMaxTurns),
    timeoutMs: Number(form.codeAgentTimeoutMs),
    maxBufferBytes: Number(form.codeAgentMaxBufferBytes),
    defaultCwd: String(form.codeAgentDefaultCwd || "").trim(),
    maxTasksPerHour: Number(form.codeAgentMaxTasksPerHour),
    maxParallelTasks: Number(form.codeAgentMaxParallelTasks),
    asyncDispatchEnabled: Boolean(form.codeAgentAsyncDispatchEnabled),
    asyncDispatchThresholdMs: Number(form.codeAgentAsyncDispatchThresholdMs),
    asyncProgressReportsEnabled: Boolean(form.codeAgentAsyncProgressReportsEnabled),
    asyncProgressIntervalMs: Number(form.codeAgentAsyncProgressIntervalMs),
    asyncMaxReportsPerTask: Number(form.codeAgentAsyncMaxReportsPerTask)
  };
  const shouldOverrideSharedCodeAgentField = (
    field: keyof typeof preservedCodeAgentAggregate
  ) => {
    const currentValue = codeAgentSharedOverrides[field];
    const preservedValue = preservedCodeAgentAggregate[field];
    return typeof currentValue === "string"
      ? currentValue !== String(preservedValue || "").trim()
      : Number(currentValue) !== Number(preservedValue || 0);
  };
  const buildCodeAgentWorkerConfig = ({
    workerKey,
    enabled,
    model,
    fallbackModel
  }: {
    workerKey: keyof typeof preservedCodeAgentWorkers;
    enabled: boolean;
    model: string;
    fallbackModel: string;
  }) => {
    const preserved = preservedCodeAgentWorkers[workerKey];
    return {
      ...preserved,
      enabled,
      model: String(model || fallbackModel).trim(),
      maxTurns: shouldOverrideSharedCodeAgentField("maxTurns")
        ? codeAgentSharedOverrides.maxTurns
        : Number(preserved.maxTurns ?? codeAgentSharedOverrides.maxTurns),
      timeoutMs: shouldOverrideSharedCodeAgentField("timeoutMs")
        ? codeAgentSharedOverrides.timeoutMs
        : Number(preserved.timeoutMs ?? codeAgentSharedOverrides.timeoutMs),
      maxBufferBytes: shouldOverrideSharedCodeAgentField("maxBufferBytes")
        ? codeAgentSharedOverrides.maxBufferBytes
        : Number(preserved.maxBufferBytes ?? codeAgentSharedOverrides.maxBufferBytes),
      defaultCwd: shouldOverrideSharedCodeAgentField("defaultCwd")
        ? codeAgentSharedOverrides.defaultCwd
        : String(preserved.defaultCwd ?? codeAgentSharedOverrides.defaultCwd).trim(),
      maxTasksPerHour: shouldOverrideSharedCodeAgentField("maxTasksPerHour")
        ? codeAgentSharedOverrides.maxTasksPerHour
        : Number(preserved.maxTasksPerHour ?? codeAgentSharedOverrides.maxTasksPerHour),
      maxParallelTasks: shouldOverrideSharedCodeAgentField("maxParallelTasks")
        ? codeAgentSharedOverrides.maxParallelTasks
        : Number(preserved.maxParallelTasks ?? codeAgentSharedOverrides.maxParallelTasks),
      asyncDispatch: {
        enabled: shouldOverrideSharedCodeAgentField("asyncDispatchEnabled")
          ? codeAgentSharedOverrides.asyncDispatchEnabled
          : Boolean(
              preserved.asyncDispatch?.enabled ?? codeAgentSharedOverrides.asyncDispatchEnabled
            ),
        thresholdMs: shouldOverrideSharedCodeAgentField("asyncDispatchThresholdMs")
          ? codeAgentSharedOverrides.asyncDispatchThresholdMs
          : Number(
              preserved.asyncDispatch?.thresholdMs ?? codeAgentSharedOverrides.asyncDispatchThresholdMs
            ),
        progressReports: {
          enabled: shouldOverrideSharedCodeAgentField("asyncProgressReportsEnabled")
            ? codeAgentSharedOverrides.asyncProgressReportsEnabled
            : Boolean(
                preserved.asyncDispatch?.progressReports?.enabled ??
                codeAgentSharedOverrides.asyncProgressReportsEnabled
              ),
          intervalMs: shouldOverrideSharedCodeAgentField("asyncProgressIntervalMs")
            ? codeAgentSharedOverrides.asyncProgressIntervalMs
            : Number(
                preserved.asyncDispatch?.progressReports?.intervalMs ??
                codeAgentSharedOverrides.asyncProgressIntervalMs
              ),
          maxReportsPerTask: shouldOverrideSharedCodeAgentField("asyncMaxReportsPerTask")
            ? codeAgentSharedOverrides.asyncMaxReportsPerTask
            : Number(
                preserved.asyncDispatch?.progressReports?.maxReportsPerTask ??
                codeAgentSharedOverrides.asyncMaxReportsPerTask
              )
        }
      }
    };
  };
  const normalizeCodeAgentRole = (value: unknown): "claude_code" | "codex_cli" | "codex" => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "codex") return "codex";
    if (normalized === "codex_cli") return "codex_cli";
    return "claude_code";
  };
  const selectedCodeAgentRoles = [
    normalizeCodeAgentRole(form.codeAgentRoleDesign),
    normalizeCodeAgentRole(form.codeAgentRoleImplementation),
    normalizeCodeAgentRole(form.codeAgentRoleReview),
    normalizeCodeAgentRole(form.codeAgentRoleResearch)
  ];
  const codeAgentUsesCodex =
    normalizedCodeAgentProvider === "codex" || selectedCodeAgentRoles.includes("codex");
  const codeAgentUsesCodexCli =
    normalizedCodeAgentProvider === "codex-cli" ||
    normalizedCodeAgentProvider === "auto" ||
    selectedCodeAgentRoles.includes("codex_cli");
  const codeAgentUsesClaudeCode =
    normalizedCodeAgentProvider === "claude-code" ||
    normalizedCodeAgentProvider === "auto" ||
    selectedCodeAgentRoles.includes("claude_code");
  const normalizedVoiceRuntimeMode = resolveVoiceRuntimeModeFromSelection(form.voiceProvider);
  const usesElevenLabsVoiceRuntime = normalizedVoiceRuntimeMode === "elevenlabs_realtime";
  const normalizedVoiceReplyPath = usesElevenLabsVoiceRuntime
    ? "brain"
    : String(form.voiceReplyPath || "brain").trim().toLowerCase();
  const normalizedVoiceTtsMode =
    normalizedVoiceReplyPath === "brain" &&
    (usesElevenLabsVoiceRuntime || String(form.voiceTtsMode || "realtime").trim().toLowerCase() === "api")
      ? "api"
      : "realtime";
  const normalizedVoiceTranscriptionProvider =
    normalizedVoiceReplyPath === "brain" &&
    String(form.voiceTranscriptionProvider || "openai").trim().toLowerCase() === "elevenlabs"
      ? "elevenlabs"
      : "openai";
  const normalizedVoiceAdmissionMode = resolveVoiceAdmissionModeForSettings({
    value: form.voiceReplyDecisionRealtimeAdmissionMode || "generation_decides",
    replyPath: normalizedVoiceReplyPath
  });
  const presetClassifierFallback =
    getPresetVoiceAdmissionClassifierFallback(String(form.stackPreset || "claude_oauth").trim()) || {
      provider: String(form.provider || "").trim(),
      model: String(form.model || "").trim()
    };
  const presetInterruptClassifierFallback =
    getPresetVoiceInterruptClassifierFallback(String(form.stackPreset || "claude_oauth").trim()) ||
    presetClassifierFallback;
  const presetMusicBrainFallback =
    getPresetVoiceMusicBrainFallback(String(form.stackPreset || "claude_oauth").trim()) || {
      provider: String(form.provider || "").trim(),
      model: String(form.model || "").trim()
    };
  const normalizedVoiceReplyDecisionProvider =
    String(form.voiceReplyDecisionLlmProvider || presetClassifierFallback.provider || "").trim();
  const normalizedVoiceReplyDecisionModel =
    String(form.voiceReplyDecisionLlmModel || presetClassifierFallback.model || "").trim();
  const normalizedVoiceInterruptProvider =
    String(form.voiceInterruptLlmProvider || presetInterruptClassifierFallback.provider || "").trim();
  const normalizedVoiceInterruptModel =
    String(form.voiceInterruptLlmModel || presetInterruptClassifierFallback.model || "").trim();
  const shouldPersistVoiceInterruptClassifier =
    Boolean(form.voiceInterruptLlmExplicit) ||
    normalizedVoiceInterruptProvider !== presetInterruptClassifierFallback.provider ||
    normalizedVoiceInterruptModel !== presetInterruptClassifierFallback.model;
  const normalizedVoiceMusicBrainProvider =
    String(form.voiceMusicBrainLlmProvider || presetMusicBrainFallback.provider || "").trim();
  const normalizedVoiceMusicBrainModel =
    String(form.voiceMusicBrainLlmModel || presetMusicBrainFallback.model || "").trim();
  const normalizedVoiceMusicBrainMode =
    String(form.voiceMusicBrainMode || "disabled").trim().toLowerCase() === "disabled"
      ? "disabled"
      : "dedicated_model";
  const normalizedBrowserRuntimeSelection = normalizeBrowserRuntimeSelection(form.browserRuntimeSelection);
  const normalizedOpenAiComputerUseClient = normalizeOpenAiComputerUseClientSelection(
    form.browserOpenAiComputerUseClient
  );
  const voiceAdmissionClassifierOverride =
    normalizedVoiceAdmissionMode !== "generation_decides"
      ? {
          mode: "dedicated_model" as const,
          model: {
            provider: normalizedVoiceReplyDecisionProvider,
            model: normalizedVoiceReplyDecisionModel
          }
        }
      : undefined;
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
        operationalGuidance: parseUniqueLineList(form.promptVoiceOperationalGuidance)
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
        discoveryChannelIds: parseUniqueList(form.discoveryChannels),
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
        ambientReplyEagerness: Number(form.textAmbientReplyEagerness),
        responseWindowEagerness: Number(form.responseWindowEagerness),
        reactivity: Number(form.reactivity),
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
      preset: String(form.stackPreset || "claude_oauth").trim(),
      advancedOverridesEnabled,
      overrides: {
        ...(advancedOverridesEnabled
          ? {
              orchestrator: {
                provider: form.provider,
                model: form.model.trim()
              },
              devTeam: {
                roles: {
                  design: selectedCodeAgentRoles[0],
                  implementation: selectedCodeAgentRoles[1],
                  review: selectedCodeAgentRoles[2],
                  research: selectedCodeAgentRoles[3]
                },
                codingWorkers:
                  normalizedCodeAgentProvider === "codex"
                    ? ["codex"]
                    : normalizedCodeAgentProvider === "codex-cli"
                      ? ["codex_cli"]
                      : normalizedCodeAgentProvider === "claude-code"
                        ? ["claude_code"]
                        : undefined
              }
            }
          : {}),
        browserRuntime:
          normalizedBrowserRuntimeSelection === "inherit"
            ? undefined
            : normalizedBrowserRuntimeSelection,
        voiceAdmissionClassifier: voiceAdmissionClassifierOverride,
        voiceInterruptClassifier: shouldPersistVoiceInterruptClassifier
          ? {
              mode: "dedicated_model",
              model: {
                provider: normalizedVoiceInterruptProvider,
                model: normalizedVoiceInterruptModel
              }
            }
          : undefined
      },
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
          headed: Boolean(form.browserHeaded),
          profile: String(form.browserProfile || "").trim(),
          openaiComputerUse: {
            client: normalizedOpenAiComputerUseClient,
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
          runtimeMode: normalizedVoiceRuntimeMode,
          openaiRealtime: {
            model: String(form.voiceOpenAiRealtimeModel || "").trim(),
            voice: String(form.voiceOpenAiRealtimeVoice || "").trim(),
            inputAudioFormat: "pcm16",
            outputAudioFormat: "pcm16",
            transcriptionMethod:
              normalizedVoiceTranscriptionProvider === "elevenlabs"
                ? "file_wav"
                : String(form.voiceOpenAiRealtimeTranscriptionMethod || "").trim().toLowerCase(),
            inputTranscriptionModel: String(form.voiceOpenAiRealtimeInputTranscriptionModel || "").trim(),
            usePerUserAsrBridge: Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge)
          },
          musicBrain: {
            ...(normalizedVoiceMusicBrainMode === "disabled"
              ? {
                  mode: "disabled" as const
                }
              : {
                  mode: "dedicated_model" as const,
                  model: {
                    provider: normalizedVoiceMusicBrainProvider,
                    model: normalizedVoiceMusicBrainModel
                  }
                })
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
            voiceId: String(form.voiceElevenLabsRealtimeVoiceId || "").trim(),
            ttsModel: String(form.voiceElevenLabsRealtimeTtsModel || "").trim(),
            transcriptionModel: String(form.voiceElevenLabsRealtimeTranscriptionModel || "").trim(),
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
          openaiAudioApi: {
            ttsModel: String(form.voiceApiTtsModel || "").trim(),
            ttsVoice: String(form.voiceApiTtsVoice || "").trim(),
            ttsSpeed: Number(form.voiceApiTtsSpeed)
          }
        },
        devTeam: {
          codex: buildCodeAgentWorkerConfig({
            workerKey: "codex",
            enabled: Boolean(form.codeAgentEnabled) && codeAgentUsesCodex,
            model: String(form.codeAgentCodexModel || "gpt-5.4"),
            fallbackModel: "gpt-5.4"
          }),
          codexCli: buildCodeAgentWorkerConfig({
            workerKey: "codexCli",
            enabled: Boolean(form.codeAgentEnabled) && codeAgentUsesCodexCli,
            model: String(form.codeAgentCodexCliModel || "gpt-5.4"),
            fallbackModel: "gpt-5.4"
          }),
          claudeCode: buildCodeAgentWorkerConfig({
            workerKey: "claudeCode",
            enabled: Boolean(form.codeAgentEnabled) && codeAgentUsesClaudeCode,
            model: String(form.codeAgentModel || "sonnet"),
            fallbackModel: "sonnet"
          })
        }
      }
    },
    memory: {
      enabled: form.memoryEnabled,
      reflection: {}
    },
    memoryLlm: form.memoryLlmInheritTextModel
      ? {}
      : {
          provider: String(form.memoryLlmProvider || "").trim(),
          model: String(form.memoryLlmModel || "").trim()
        },
    initiative: {
      text: {
        enabled: Boolean(form.textInitiativeEnabled),
        execution: form.textInitiativeUseTextModel
          ? {
              mode: "inherit_orchestrator"
            }
          : {
              mode: "dedicated_model",
              model: {
                provider: String(form.textInitiativeLlmProvider || "").trim(),
                model: String(form.textInitiativeLlmModel || "").trim()
              }
            },
        eagerness: Number(form.textInitiativeEagerness),
        minMinutesBetweenPosts: Number(form.textInitiativeMinMinutesBetweenPosts),
        maxPostsPerDay: Number(form.textInitiativeMaxPostsPerDay),
        lookbackMessages: Number(form.textInitiativeLookbackMessages),
        allowActiveCuriosity: Boolean(form.textInitiativeAllowActiveCuriosity),
        maxToolSteps: Number(form.textInitiativeMaxToolSteps),
        maxToolCalls: Number(form.textInitiativeMaxToolCalls)
      },
      voice: {
        enabled: Boolean(form.voiceThoughtEngineEnabled),
        eagerness: Number(form.voiceThoughtEngineEagerness),
        minSilenceSeconds: Number(form.voiceThoughtEngineMinSilenceSeconds),
        minSecondsBetweenThoughts: Number(form.voiceThoughtEngineMinSecondsBetweenThoughts)
      },
      discovery: {
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
        maxMediaPromptChars: Number(form.discoveryMaxMediaPromptChars),
        maxLinksPerPost: Number(form.discoveryMaxLinks),
        maxCandidatesForPrompt: Number(form.discoveryMaxCandidates),
        freshnessHours: Number(form.discoveryFreshnessHours),
        dedupeHours: Number(form.discoveryDedupeHours),
        randomness: Number(form.discoveryRandomness),
        sourceFetchLimit: Number(form.discoveryFetchLimit),
        allowNsfw: discoveryFeedEnabled ? form.discoveryAllowNsfw : false,
        allowSelfCuration: Boolean(form.discoveryAllowSelfCuration),
        maxSourcesPerType: Number(form.discoveryMaxSourcesPerType),
        redditSubreddits: parseUniqueList(form.discoveryRedditSubs),
        youtubeChannelIds: parseUniqueList(form.discoveryYoutubeChannels),
        rssFeeds: parseUniqueList(form.discoveryRssFeeds),
        xHandles: parseUniqueList(form.discoveryXHandles),
        xNitterBaseUrl: form.discoveryXNitterBase.trim(),
        sources: {
          reddit: discoveryFeedEnabled ? form.discoverySourceReddit : false,
          hackerNews: discoveryFeedEnabled ? form.discoverySourceHackerNews : false,
          youtube: discoveryFeedEnabled ? form.discoverySourceYoutube : false,
          rss: discoveryFeedEnabled ? form.discoverySourceRss : false,
          x: discoveryFeedEnabled ? form.discoverySourceX : false
        }
      }
    },
    voice: {
      enabled: form.voiceEnabled,
      transcription: {
        enabled: Boolean(form.voiceAsrEnabled),
        provider: normalizedVoiceTranscriptionProvider,
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
        maxConcurrentSessions: Number(form.voiceMaxConcurrentSessions || 1)
      },
      conversationPolicy: {
        ambientReplyEagerness: Number(form.voiceAmbientReplyEagerness),
        streaming: {
          enabled: Boolean(form.voiceStreamingEnabled),
          minSentencesPerChunk: Number(form.voiceStreamingMinSentencesPerChunk),
          eagerFirstChunkChars: Number(form.voiceStreamingEagerFirstChunkChars),
          maxBufferChars: Number(form.voiceStreamingMaxBufferChars)
        },
        commandOnlyMode: Boolean(form.voiceCommandOnlyMode),
        allowNsfwHumor: form.voiceAllowNsfwHumor,
        textOnlyMode: Boolean(form.voiceTextOnlyMode),
        defaultInterruptionMode: String(form.voiceDefaultInterruptionMode || "speaker").trim().toLowerCase(),
        useInterruptClassifier: form.voiceUseInterruptClassifier !== false,
        replyPath: normalizedVoiceReplyPath,
        ttsMode: normalizedVoiceTtsMode,
        thinking: String(form.voiceThinking || "disabled").trim().toLowerCase(),
        operationalMessages: String(form.voiceOperationalMessages || "minimal").trim().toLowerCase()
      },
      admission: {
        mode: normalizedVoiceAdmissionMode,
        musicWakeLatchSeconds: Number(form.voiceReplyDecisionMusicWakeLatchSeconds)
      },
      streamWatch: {
        enabled: form.voiceStreamWatchEnabled,
        commentaryEagerness: Number(form.voiceStreamWatchCommentaryEagerness),
        visualizerMode: normalizeStreamWatchVisualizerMode(
          form.voiceStreamWatchVisualizerMode
        ),
        commentaryIntervalSeconds: Number(form.voiceStreamWatchCommentaryIntervalSeconds),
        maxFramesPerMinute: Number(form.voiceStreamWatchMaxFramesPerMinute),
        maxFrameBytes: Number(form.voiceStreamWatchMaxFrameBytes),
        keyframeIntervalMs: Number(form.voiceStreamWatchKeyframeIntervalMs),
        autonomousCommentaryEnabled: Boolean(form.voiceStreamWatchAutonomousCommentaryEnabled),
        noteProvider: String(form.voiceStreamWatchNoteProvider || "").trim(),
        noteModel: String(form.voiceStreamWatchNoteModel || "").trim(),
        noteIntervalSeconds: Number(form.voiceStreamWatchNoteIntervalSeconds),
        noteIdleIntervalSeconds: Number(form.voiceStreamWatchNoteIdleIntervalSeconds),
        staticFloor: Number(form.voiceStreamWatchStaticFloor),
        maxNoteEntries: Number(form.voiceStreamWatchMaxNoteEntries),
        changeThreshold: Number(form.voiceStreamWatchChangeThreshold),
        changeMinIntervalSeconds: Number(form.voiceStreamWatchChangeMinIntervalSeconds),
        notePrompt: String(form.voiceStreamWatchNotePrompt || "").trim(),
        commentaryProvider: String(form.voiceStreamWatchCommentaryProvider || "").trim(),
        commentaryModel: String(form.voiceStreamWatchCommentaryModel || "").trim(),
        nativeDiscordMaxFramesPerSecond: Number(form.voiceStreamWatchNativeDiscordMaxFramesPerSecond),
        nativeDiscordPreferredQuality: Number(form.voiceStreamWatchNativeDiscordPreferredQuality),
        nativeDiscordPreferredPixelCount: Number(form.voiceStreamWatchNativeDiscordPreferredPixelCount),
        nativeDiscordJpegQuality: Number(form.voiceStreamWatchNativeDiscordJpegQuality),
        nativeDiscordPreferredStreamType: String(form.voiceStreamWatchNativeDiscordPreferredStreamType || "").trim(),
        sharePageMaxWidthPx: Number(form.voiceStreamWatchSharePageMaxWidthPx),
        sharePageJpegQuality: Number(form.voiceStreamWatchSharePageJpegQuality)
      },
      soundboard: {
        eagerness: Number(form.voiceSoundboardEagerness),
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

export function formToSettingsPatch(form: SettingsForm): SettingsInput {
  return minimizeSettingsIntent(buildSettingsInputFromForm(form));
}

export function formToSettingsSnapshot(form: SettingsForm) {
  return normalizeSettings(buildSettingsInputFromForm(form));
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
  const normalizedModel = String(model || "").trim();
  const options = resolveModelOptions(resolveProviderModelOptions(modelCatalog, provider), normalizedModel);
  const selectedPresetModel = options.includes(normalizedModel)
    ? normalizedModel
    : (options[0] || "");

  return {
    options,
    selectedPresetModel
  };
}
