import { deepMerge } from "../utils.ts";
import { isRecord } from "../store/normalize/primitives.ts";
import {
  DEFAULT_SETTINGS,
  type DevTeamRoles,
  type Settings,
  type SettingsCodingWorkerName,
  type SettingsModelBinding,
  type SettingsInput
} from "./settingsSchema.ts";
import {
  getAgentStackPresetDefaults,
  normalizeAgentStackPresetName,
  type AgentSessionPolicy,
  type AgentStackPresetName,
  type AgentStackPresetDefaults as PresetDefaults
} from "./agentStackCatalog.ts";
import {
  resolveVoiceAdmissionModeForSettings,
  resolveVoiceProviderFromRuntimeMode
} from "./voiceDashboardMappings.ts";


type CapabilityExecutionPolicy = {
  mode?: string;
  model?: SettingsModelBinding;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
};

type ResolvedAgentStack = {
  preset: string;
  harness: string;
  sessionPolicy?: AgentSessionPolicy;
  orchestrator: SettingsModelBinding;
  researchRuntime: string;
  browserRuntime: string;
  voiceRuntime: string;
  voiceAdmissionPolicy: {
    mode: string;
    classifierProvider?: string;
    classifierModel?: string;
    musicWakeLatchSeconds?: number;
  };
  devTeam: {
    orchestrator: SettingsModelBinding;
    roles: DevTeamRoles;
    codingWorkers: SettingsCodingWorkerName[];
  };
};

const VALID_CODING_WORKERS = new Set<SettingsCodingWorkerName>([
  "claude_code",
  "codex_cli"
]);

function mergeWithDefaults<T>(defaults: T, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return deepMerge({}, defaults) as T;
  }
  return deepMerge(defaults, value) as T;
}

function isSettingsInput(value: unknown): value is SettingsInput {
  return isRecord(value);
}

function getSettingsInput(settings: unknown): SettingsInput {
  return isSettingsInput(settings) ? settings : {};
}

function getSettingsSection<T>(
  settings: unknown,
  select: (input: SettingsInput) => unknown,
  defaults: T
): T {
  return mergeWithDefaults(defaults, select(getSettingsInput(settings)));
}

function resolveModelBinding(binding: unknown, fallback: SettingsModelBinding): SettingsModelBinding {
  const source: Partial<SettingsModelBinding> = binding && typeof binding === "object" && !Array.isArray(binding)
    ? binding as SettingsModelBinding
    : {};
  const provider = String(source.provider || fallback.provider || "").trim() || String(fallback.provider || "");
  const model = String(source.model || fallback.model || "").trim() || String(fallback.model || "");
  return { provider, model };
}

function resolveExecutionPolicy(
  policy: unknown,
  fallbackBinding: SettingsModelBinding,
  fallbackTemperature?: number,
  fallbackMaxOutputTokens?: number,
  fallbackReasoningEffort?: string
) {
  const source = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy as CapabilityExecutionPolicy
    : {};
  const rawMode = String(source.mode || "inherit_orchestrator").trim().toLowerCase();
  const mode =
    rawMode === "disabled"
      ? "disabled"
      : rawMode === "dedicated_model"
        ? "dedicated_model"
        : "inherit_orchestrator";
  return {
    mode,
    model: mode === "dedicated_model"
      ? resolveModelBinding(source.model, fallbackBinding)
      : undefined,
    temperature:
      source.temperature !== undefined
        ? Number(source.temperature)
        : fallbackTemperature,
    maxOutputTokens:
      source.maxOutputTokens !== undefined
        ? Number(source.maxOutputTokens)
        : fallbackMaxOutputTokens,
    reasoningEffort:
      source.reasoningEffort !== undefined
        ? String(source.reasoningEffort || "").trim()
        : fallbackReasoningEffort
  };
}

function normalizeCodingWorkerName(value: unknown): SettingsCodingWorkerName | null {
  const normalized = String(value || "").trim().toLowerCase() as SettingsCodingWorkerName;
  return VALID_CODING_WORKERS.has(normalized) ? normalized : null;
}

function normalizeCodingWorkerList(values: unknown): SettingsCodingWorkerName[] {
  if (!Array.isArray(values)) return [];
  const normalized: SettingsCodingWorkerName[] = [];
  for (const value of values) {
    const worker = normalizeCodingWorkerName(value);
    if (worker && !normalized.includes(worker)) normalized.push(worker);
  }
  return normalized;
}

function resolveCodingWorkerName(
  value: unknown,
  fallback: SettingsCodingWorkerName,
  availableWorkers: readonly SettingsCodingWorkerName[]
): SettingsCodingWorkerName {
  const desired = normalizeCodingWorkerName(value);
  if (desired && (availableWorkers.length === 0 || availableWorkers.includes(desired))) {
    return desired;
  }

  const fallbackWorker = normalizeCodingWorkerName(fallback);
  if (fallbackWorker && (availableWorkers.length === 0 || availableWorkers.includes(fallbackWorker))) {
    return fallbackWorker;
  }

  return availableWorkers[0] || fallbackWorker || "codex_cli";
}

function getIdentitySettings(settings: unknown): Settings["identity"] {
  return getSettingsSection(settings, (input) => input.identity, DEFAULT_SETTINGS.identity);
}

export function getBotName(settings: unknown): string {
  return String(getIdentitySettings(settings).botName || DEFAULT_SETTINGS.identity.botName);
}

export function getBotNameAliases(settings: unknown): string[] {
  const identity = getIdentitySettings(settings);
  return Array.isArray(identity.botNameAliases)
    ? identity.botNameAliases.map((value) => String(value || "").trim()).filter(Boolean)
    : [...DEFAULT_SETTINGS.identity.botNameAliases];
}

export function getPersonaSettings(settings: unknown): Settings["persona"] {
  return getSettingsSection(settings, (input) => input.persona, DEFAULT_SETTINGS.persona);
}

export function getPromptingSettings(settings: unknown): Settings["prompting"] {
  return getSettingsSection(settings, (input) => input.prompting, DEFAULT_SETTINGS.prompting);
}

export function getReplyPermissions(settings: unknown): Settings["permissions"]["replies"] {
  return getSettingsSection(
    settings,
    (input) => input.permissions?.replies,
    DEFAULT_SETTINGS.permissions.replies
  );
}

export function getDevTaskPermissions(settings: unknown): Settings["permissions"]["devTasks"] {
  return getSettingsSection(
    settings,
    (input) => input.permissions?.devTasks,
    DEFAULT_SETTINGS.permissions.devTasks
  );
}

export function getActivitySettings(settings: unknown): Settings["interaction"]["activity"] {
  return getSettingsSection(
    settings,
    (input) => input.interaction?.activity,
    DEFAULT_SETTINGS.interaction.activity
  );
}

export function getReplyGenerationSettings(settings: unknown): Settings["interaction"]["replyGeneration"] {
  return getSettingsSection(
    settings,
    (input) => input.interaction?.replyGeneration,
    DEFAULT_SETTINGS.interaction.replyGeneration
  );
}

export function getFollowupSettings(settings: unknown): Settings["interaction"]["followup"] {
  return getSettingsSection(
    settings,
    (input) => input.interaction?.followup,
    DEFAULT_SETTINGS.interaction.followup
  );
}

export function getStartupSettings(settings: unknown): Settings["interaction"]["startup"] {
  return getSettingsSection(
    settings,
    (input) => input.interaction?.startup,
    DEFAULT_SETTINGS.interaction.startup
  );
}

function getAgentStackSettings(settings: unknown): Settings["agentStack"] {
  return getSettingsSection(settings, (input) => input.agentStack, DEFAULT_SETTINGS.agentStack);
}

export function getMemorySettings(settings: unknown): Settings["memory"] {
  return getSettingsSection(settings, (input) => input.memory, DEFAULT_SETTINGS.memory);
}

export function getTextInitiativeSettings(settings: unknown): Settings["initiative"]["text"] {
  return getSettingsSection(
    settings,
    (input) => input.initiative?.text,
    DEFAULT_SETTINGS.initiative.text
  );
}

export function getVoiceInitiativeSettings(settings: unknown): Settings["initiative"]["voice"] {
  return getSettingsSection(
    settings,
    (input) => input.initiative?.voice,
    DEFAULT_SETTINGS.initiative.voice
  );
}

export function getDiscoverySettings(settings: unknown): Settings["initiative"]["discovery"] {
  return getSettingsSection(
    settings,
    (input) => input.initiative?.discovery,
    DEFAULT_SETTINGS.initiative.discovery
  );
}

export function getVoiceSettings(settings: unknown): Settings["voice"] {
  return getSettingsSection(settings, (input) => input.voice, DEFAULT_SETTINGS.voice);
}

export function getVoiceTranscriptionSettings(settings: unknown): Settings["voice"]["transcription"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.transcription,
    DEFAULT_SETTINGS.voice.transcription
  );
}

export function getVoiceChannelPolicy(settings: unknown): Settings["voice"]["channelPolicy"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.channelPolicy,
    DEFAULT_SETTINGS.voice.channelPolicy
  );
}

export function getVoiceSessionLimits(settings: unknown): Settings["voice"]["sessionLimits"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.sessionLimits,
    DEFAULT_SETTINGS.voice.sessionLimits
  );
}

export function getVoiceConversationPolicy(settings: unknown): Settings["voice"]["conversationPolicy"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.conversationPolicy,
    DEFAULT_SETTINGS.voice.conversationPolicy
  );
}

export function getVoiceAdmissionSettings(settings: unknown): Settings["voice"]["admission"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.admission,
    DEFAULT_SETTINGS.voice.admission
  );
}

export function getVoiceStreamWatchSettings(settings: unknown): Settings["voice"]["streamWatch"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.streamWatch,
    DEFAULT_SETTINGS.voice.streamWatch
  );
}

export function getVoiceSoundboardSettings(settings: unknown): Settings["voice"]["soundboard"] {
  return getSettingsSection(
    settings,
    (input) => input.voice?.soundboard,
    DEFAULT_SETTINGS.voice.soundboard
  );
}

export function getVisionSettings(settings: unknown): Settings["media"]["vision"] {
  return getSettingsSection(
    settings,
    (input) => input.media?.vision,
    DEFAULT_SETTINGS.media.vision
  );
}

export function getVideoContextSettings(settings: unknown): Settings["media"]["videoContext"] {
  return getSettingsSection(
    settings,
    (input) => input.media?.videoContext,
    DEFAULT_SETTINGS.media.videoContext
  );
}

export function getAutomationsSettings(settings: unknown): Settings["automations"] {
  return getSettingsSection(settings, (input) => input.automations, DEFAULT_SETTINGS.automations);
}

function getRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"] {
  const agentStack = getAgentStackSettings(settings);
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig, agentStack.runtimeConfig);
}

function getExplicitVoiceRuntimeModeSetting(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;

  const agentStack = "agentStack" in settings ? settings.agentStack : undefined;
  if (!agentStack || typeof agentStack !== "object" || Array.isArray(agentStack)) return undefined;

  const runtimeConfig = "runtimeConfig" in agentStack ? agentStack.runtimeConfig : undefined;
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) return undefined;

  const voice = "voice" in runtimeConfig ? runtimeConfig.voice : undefined;
  if (!voice || typeof voice !== "object" || Array.isArray(voice)) return undefined;

  const runtimeMode = "runtimeMode" in voice ? voice.runtimeMode : undefined;
  return typeof runtimeMode === "string" ? runtimeMode : undefined;
}

export function getResearchRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"]["research"] {
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig.research, getRuntimeConfig(settings).research);
}

export function getBrowserRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"]["browser"] {
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig.browser, getRuntimeConfig(settings).browser);
}

export function getVoiceRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"]["voice"] {
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig.voice, getRuntimeConfig(settings).voice);
}

export function getDevTeamRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"]["devTeam"] {
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam, getRuntimeConfig(settings).devTeam);
}

function getPresetDefaults(settings: unknown): PresetDefaults {
  const agentStack = getAgentStackSettings(settings);
  return getAgentStackPresetDefaults(agentStack.preset || DEFAULT_SETTINGS.agentStack.preset);
}

function normalizeResolvedVoiceRuntime(value: unknown, fallback: string) {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "voice_agent") return "voice_agent";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  return fallback;
}

function normalizeComputerUseClientPreference(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-oauth") return normalized;
  return "auto";
}

export function getResolvedOrchestratorBinding(settings: unknown) {
  const interaction = getReplyGenerationSettings(settings);
  const agentStack = getAgentStackSettings(settings);
  const presetDefaults = getPresetDefaults(settings);
  const overrideBinding = agentStack.overrides?.orchestrator;
  const binding = resolveModelBinding(overrideBinding, presetDefaults.orchestrator);
  return {
    ...binding,
    temperature: Number(interaction.temperature),
    maxOutputTokens: Number(interaction.maxOutputTokens),
    reasoningEffort: String(interaction.reasoningEffort || "").trim() || undefined,
    pricing: interaction.pricing
  };
}

export function getResolvedFollowupBinding(settings: unknown) {
  const followup = getFollowupSettings(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(
    followup.execution,
    fallback,
    fallback.temperature,
    fallback.maxOutputTokens,
    fallback.reasoningEffort
  );
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model),
    temperature: policy.temperature ?? fallback.temperature,
    maxOutputTokens: policy.maxOutputTokens ?? fallback.maxOutputTokens,
    reasoningEffort: policy.reasoningEffort ?? fallback.reasoningEffort
  };
}

export function getResolvedMemoryBinding(settings: unknown) {
  const fallback = getResolvedOrchestratorBinding(settings);
  const configured =
    settings && typeof settings === "object" && "memoryLlm" in settings && settings.memoryLlm && typeof settings.memoryLlm === "object"
      ? settings.memoryLlm as CapabilityExecutionPolicy
      : null;
  const binding = resolveModelBinding(configured, fallback);
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model),
    temperature: Number(configured?.temperature ?? fallback.temperature ?? 0),
    maxOutputTokens: Number(configured?.maxOutputTokens ?? fallback.maxOutputTokens ?? 320),
    reasoningEffort: fallback.reasoningEffort
  };
}

export function getResolvedVisionBinding(settings: unknown) {
  const vision = getVisionSettings(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(vision.execution, fallback);
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model)
  };
}

export function getResolvedTextInitiativeBinding(settings: unknown) {
  const textInitiative = getTextInitiativeSettings(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(
    textInitiative.execution,
    fallback,
    fallback.temperature,
    fallback.maxOutputTokens,
    fallback.reasoningEffort
  );
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model),
    temperature: policy.temperature ?? fallback.temperature,
    maxOutputTokens: policy.maxOutputTokens ?? fallback.maxOutputTokens,
    reasoningEffort: policy.reasoningEffort ?? fallback.reasoningEffort
  };
}

export function getResolvedVoiceInitiativeBinding(settings: unknown) {
  const voiceInitiative = getVoiceInitiativeSettings(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(voiceInitiative.execution, fallback, 1.2);
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model),
    temperature: policy.temperature ?? 1.2
  };
}

export function getResolvedVoiceAdmissionClassifierBinding(settings: unknown) {
  const voiceAdmission = getVoiceAdmissionSettings(settings);
  const voiceConversation = getVoiceConversationPolicy(settings);
  const agentStack = getAgentStackSettings(settings);
  const presetDefaults = getPresetDefaults(settings);
  const fallback = presetDefaults.voiceAdmissionClassifier || presetDefaults.orchestrator;
  const overridePolicy = resolveExecutionPolicy(
    agentStack.overrides?.voiceAdmissionClassifier,
    fallback
  );
  const mode = resolveVoiceAdmissionModeForSettings({
    value: voiceAdmission.mode,
    replyPath: voiceConversation.replyPath
  });
  if (mode !== "classifier_gate") {
    return null;
  }
  const binding = overridePolicy.mode === "dedicated_model"
    ? overridePolicy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model)
  };
}

export function getResolvedVoiceInterruptClassifierBinding(settings: unknown) {
  const agentStack = getAgentStackSettings(settings);
  const presetDefaults = getPresetDefaults(settings);
  const fallback =
    presetDefaults.voiceInterruptClassifier ||
    presetDefaults.voiceAdmissionClassifier ||
    presetDefaults.orchestrator;
  const overridePolicy = resolveExecutionPolicy(
    agentStack.overrides?.voiceInterruptClassifier,
    fallback
  );
  const binding = overridePolicy.mode === "dedicated_model"
    ? overridePolicy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model)
  };
}

export function getResolvedVoiceProvider(settings: unknown): string {
  const runtimeMode = String(resolveAgentStack(settings).voiceRuntime || "")
    .trim()
    .toLowerCase();
  return resolveVoiceProviderFromRuntimeMode(runtimeMode) || "openai";
}

export function getResolvedVoiceGenerationBinding(settings: unknown) {
  const voiceRuntime = getVoiceRuntimeConfig(settings);
  const presetDefaults = getPresetDefaults(settings);
  const orchestrator = getResolvedOrchestratorBinding(settings);
  const fallback = presetDefaults.voiceGeneration || orchestrator;
  const policy = resolveExecutionPolicy(
    voiceRuntime.generation,
    fallback
  );
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : orchestrator;
  return {
    provider: String(binding?.provider || orchestrator.provider || fallback.provider),
    model: String(binding?.model || orchestrator.model || fallback.model)
  };
}

export function getResolvedVoiceMusicBrainBinding(settings: unknown) {
  const voiceRuntime = getVoiceRuntimeConfig(settings);
  const presetDefaults = getPresetDefaults(settings);
  const fallback = presetDefaults.voiceMusicBrain || presetDefaults.voiceAdmissionClassifier || presetDefaults.orchestrator;
  const policy = resolveExecutionPolicy(
    voiceRuntime.musicBrain,
    fallback
  );
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model)
  };
}

export function isVoiceMusicBrainEnabled(settings: unknown): boolean {
  const voiceRuntime = getVoiceRuntimeConfig(settings);
  return String(voiceRuntime.musicBrain?.mode || "disabled").trim().toLowerCase() !== "disabled";
}

export function getResolvedBrowserTaskConfig(settings: unknown) {
  const browserRuntime = getBrowserRuntimeConfig(settings);
  const resolvedStack = resolveAgentStack(settings);
  const orchestrator = getResolvedOrchestratorBinding(settings);
  const browserExecution = browserRuntime.localBrowserAgent?.execution;
  const browserBinding =
    browserExecution?.mode === "dedicated_model" && browserExecution.model
      ? browserExecution.model
      : orchestrator;
  return {
    runtime: String(resolvedStack.browserRuntime || "local_browser_agent"),
    enabled: Boolean(browserRuntime.enabled),
    headed: Boolean(browserRuntime.headed),
    profile: String(browserRuntime.profile || "").trim(),
    maxBrowseCallsPerHour: Number(browserRuntime.localBrowserAgent?.maxBrowseCallsPerHour) || 10,
    maxStepsPerTask: Number(browserRuntime.localBrowserAgent?.maxStepsPerTask) || 15,
    stepTimeoutMs: Number(browserRuntime.localBrowserAgent?.stepTimeoutMs) || 30_000,
    sessionTimeoutMs: Number(browserRuntime.localBrowserAgent?.sessionTimeoutMs) || 300_000,
    localAgent: {
      provider: String(browserBinding?.provider || orchestrator.provider || "anthropic"),
      model: String(browserBinding?.model || orchestrator.model || "claude-sonnet-4-5-20250929")
    },
    openaiComputerUse: {
      client: normalizeComputerUseClientPreference(browserRuntime.openaiComputerUse?.client),
      model: String(browserRuntime.openaiComputerUse?.model || "gpt-5.4").trim() || "gpt-5.4"
    }
  };
}

export function applyOrchestratorOverrideSettings(
  settings: unknown,
  binding: {
    provider?: unknown;
    model?: unknown;
    temperature?: unknown;
    maxOutputTokens?: unknown;
    reasoningEffort?: unknown;
  }
) {
  const provider = String(binding?.provider || "").trim();
  const model = String(binding?.model || "").trim();
  const replyGenerationPatch: Record<string, unknown> = {};
  if (binding?.temperature !== undefined) {
    replyGenerationPatch.temperature = Number(binding.temperature);
  }
  if (binding?.maxOutputTokens !== undefined) {
    replyGenerationPatch.maxOutputTokens = Number(binding.maxOutputTokens);
  }
  if (binding?.reasoningEffort !== undefined) {
    replyGenerationPatch.reasoningEffort = String(binding.reasoningEffort || "").trim();
  }

  return deepMerge(
    deepMerge({}, settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
    {
      agentStack: {
        overrides: {
          orchestrator: {
            provider,
            model
          }
        }
      },
      interaction: {
        replyGeneration: replyGenerationPatch
      }
    }
  );
}

export function resolveAgentStack(settings: unknown) {
  const agentStack = getAgentStackSettings(settings);
  const presetName = normalizeAgentStackPresetName(
    agentStack.preset || DEFAULT_SETTINGS.agentStack.preset
  ) as AgentStackPresetName;
  const presetDefaults = getPresetDefaults(settings);
  const overrides = agentStack.overrides || {};
  const explicitVoiceRuntimeMode = getExplicitVoiceRuntimeModeSetting(settings);
  const voiceAdmission = getVoiceAdmissionSettings(settings);

  const devTeamRuntime = getDevTeamRuntimeConfig(settings);
  const enabledWorkers = [
    devTeamRuntime?.codexCli?.enabled ? "codex_cli" : null,
    devTeamRuntime?.claudeCode?.enabled ? "claude_code" : null
  ].filter(Boolean) as SettingsCodingWorkerName[];
  const overrideWorkers = normalizeCodingWorkerList(overrides?.devTeam?.codingWorkers);
  const presetWorkers = normalizeCodingWorkerList(presetDefaults.devTeam.codingWorkers);
  const codingWorkers = (overrideWorkers.length ? overrideWorkers : presetWorkers)
    .filter((worker) => enabledWorkers.includes(worker));
  const availableWorkers = [
    ...new Set<SettingsCodingWorkerName>([
      ...codingWorkers,
      ...enabledWorkers
    ])
  ];
  const harness = String(overrides?.harness || presetDefaults.harness);
  const devTeamOrchestrator = resolveModelBinding(
    overrides?.devTeam?.orchestrator,
    presetDefaults.devTeam.orchestrator
  );
  const sessionPolicy = presetDefaults.sessionPolicy;

  return {
    preset: presetName,
    harness,
    sessionPolicy,
    orchestrator: resolveModelBinding(overrides?.orchestrator, presetDefaults.orchestrator),
    researchRuntime: String(overrides?.researchRuntime || presetDefaults.researchRuntime),
    browserRuntime: String(overrides?.browserRuntime || presetDefaults.browserRuntime),
    voiceRuntime: normalizeResolvedVoiceRuntime(explicitVoiceRuntimeMode, presetDefaults.voiceRuntime),
    voiceAdmissionPolicy: {
      mode: String(voiceAdmission.mode || presetDefaults.voiceAdmissionPolicy.mode),
      classifierProvider: getResolvedVoiceAdmissionClassifierBinding(settings)?.provider,
      classifierModel: getResolvedVoiceAdmissionClassifierBinding(settings)?.model,
      musicWakeLatchSeconds: Number(voiceAdmission.musicWakeLatchSeconds)
    },
    devTeam: {
      orchestrator: devTeamOrchestrator,
      roles: {
        design: resolveCodingWorkerName(
          overrides?.devTeam?.roles?.design,
          presetDefaults.devTeam.roles.design,
          availableWorkers
        ),
        implementation: resolveCodingWorkerName(
          overrides?.devTeam?.roles?.implementation,
          presetDefaults.devTeam.roles.implementation,
          availableWorkers
        ),
        review: resolveCodingWorkerName(
          overrides?.devTeam?.roles?.review,
          presetDefaults.devTeam.roles.review,
          availableWorkers
        ),
        ...(presetDefaults.devTeam.roles.research
          ? {
              research: resolveCodingWorkerName(
                overrides?.devTeam?.roles?.research,
                presetDefaults.devTeam.roles.research,
                availableWorkers
              )
            }
          : {})
      },
      codingWorkers
    }
  } satisfies ResolvedAgentStack;
}

export function isResearchEnabled(settings: unknown): boolean {
  return Boolean(getResearchRuntimeConfig(settings).enabled);
}

export function isBrowserEnabled(settings: unknown): boolean {
  return Boolean(getBrowserRuntimeConfig(settings).enabled);
}

export function isDevTaskEnabled(settings: unknown): boolean {
  const permissions = getDevTaskPermissions(settings);
  const runtime = getDevTeamRuntimeConfig(settings);
  const hasWorkers = Boolean(runtime?.codexCli?.enabled || runtime?.claudeCode?.enabled);
  return hasWorkers && Array.isArray(permissions.allowedUserIds) && permissions.allowedUserIds.length > 0;
}
