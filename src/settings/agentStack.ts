import { deepMerge } from "../utils.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsInput
} from "./settingsSchema.ts";

type ModelBinding = {
  provider?: string;
  model?: string;
};

export type AgentSessionToolPolicy = "none" | "fast_only" | "full";

export type AgentSessionPolicy = {
  persistent: boolean;
  toolPolicy: {
    voice: AgentSessionToolPolicy;
    text: AgentSessionToolPolicy;
  };
};

export type CapabilityExecutionPolicy = {
  mode?: string;
  model?: ModelBinding;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
};

type DevTeamRoles = {
  design: CapabilityExecutionPolicy;
  implementation: CapabilityExecutionPolicy;
  review: CapabilityExecutionPolicy;
  research?: CapabilityExecutionPolicy;
};

type PresetDefaults = {
  harness: string;
  orchestrator: Required<ModelBinding>;
  researchRuntime: string;
  browserRuntime: string;
  voiceRuntime: string;
  voiceAdmissionPolicy: {
    mode: string;
  };
  voiceAdmissionClassifier?: Required<ModelBinding>;
  sessionPolicy?: AgentSessionPolicy;
  devTeam: {
    orchestrator: Required<ModelBinding>;
    roles: DevTeamRoles;
    codingWorkers: string[];
  };
};

export type ResolvedAgentStack = {
  preset: string;
  harness: string;
  sessionPolicy?: AgentSessionPolicy;
  orchestrator: Required<ModelBinding>;
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
    orchestrator: Required<ModelBinding>;
    roles: {
      design: ReturnType<typeof resolveExecutionPolicy>;
      implementation: ReturnType<typeof resolveExecutionPolicy>;
      review: ReturnType<typeof resolveExecutionPolicy>;
      research?: ReturnType<typeof resolveExecutionPolicy>;
    };
    codingWorkers: string[];
  };
};

function dedicatedModel(provider: string, model: string): CapabilityExecutionPolicy {
  return {
    mode: "dedicated_model",
    model: {
      provider,
      model
    }
  };
}

function inheritOrchestrator(): CapabilityExecutionPolicy {
  return {
    mode: "inherit_orchestrator"
  };
}

const PRESET_DEFAULTS = {
  openai_native: {
    harness: "openai_agents",
    orchestrator: {
      provider: "openai",
      model: "gpt-5"
    },
    researchRuntime: "openai_native_web_search",
    browserRuntime: "openai_computer_use",
    voiceRuntime: "openai_realtime",
    voiceAdmissionPolicy: {
      mode: "adaptive"
    },
    voiceAdmissionClassifier: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    devTeam: {
      orchestrator: {
        provider: "openai",
        model: "gpt-5"
      },
      roles: {
        design: dedicatedModel("claude-code", "sonnet"),
        implementation: dedicatedModel("codex", "gpt-5-codex"),
        review: dedicatedModel("claude-code", "sonnet"),
        research: inheritOrchestrator()
      },
      codingWorkers: ["codex", "claude_code"]
    }
  },
  anthropic_brain_openai_tools: {
    harness: "internal",
    orchestrator: {
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    },
    researchRuntime: "openai_native_web_search",
    browserRuntime: "openai_computer_use",
    voiceRuntime: "openai_realtime",
    voiceAdmissionPolicy: {
      mode: "adaptive"
    },
    voiceAdmissionClassifier: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    devTeam: {
      orchestrator: {
        provider: "anthropic",
        model: "claude-sonnet-4-6"
      },
      roles: {
        design: dedicatedModel("claude-code", "sonnet"),
        implementation: dedicatedModel("claude-code", "sonnet"),
        review: dedicatedModel("claude-code", "sonnet"),
        research: inheritOrchestrator()
      },
      codingWorkers: ["claude_code", "codex"]
    }
  },
  claude_code_max: {
    harness: "claude_code_session",
    orchestrator: {
      provider: "claude_code_session",
      model: "max"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceAdmissionPolicy: {
      mode: "adaptive"
    },
    voiceAdmissionClassifier: {
      provider: "claude_code_session",
      model: "max"
    },
    sessionPolicy: {
      persistent: true,
      toolPolicy: {
        voice: "fast_only",
        text: "full"
      }
    },
    devTeam: {
      orchestrator: {
        provider: "claude_code_session",
        model: "max"
      },
      roles: {
        design: dedicatedModel("claude_code_session", "max"),
        implementation: dedicatedModel("claude_code_session", "max"),
        review: dedicatedModel("claude_code_session", "max"),
        research: dedicatedModel("claude_code_session", "max")
      },
      codingWorkers: ["claude_code", "codex"]
    }
  },
  custom: {
    harness: "internal",
    orchestrator: {
      provider: "openai",
      model: "gpt-5"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceAdmissionPolicy: {
      mode: "adaptive"
    },
    voiceAdmissionClassifier: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    devTeam: {
      orchestrator: {
        provider: "openai",
        model: "gpt-5"
      },
      roles: {
        design: dedicatedModel("claude-code", "sonnet"),
        implementation: dedicatedModel("codex", "gpt-5-codex"),
        review: dedicatedModel("claude-code", "sonnet"),
        research: inheritOrchestrator()
      },
      codingWorkers: ["codex", "claude_code"]
    }
  }
} as const satisfies Record<string, PresetDefaults>;

function mergeWithDefaults<T>(defaults: T, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return deepMerge({}, defaults) as T;
  }
  return deepMerge(defaults, value) as T;
}

function isSettingsInput(value: unknown): value is SettingsInput {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function resolveModelBinding(binding: unknown, fallback: ModelBinding): Required<ModelBinding> {
  const source = binding && typeof binding === "object" && !Array.isArray(binding)
    ? binding as ModelBinding
    : {};
  const provider = String(source.provider || fallback.provider || "").trim() || String(fallback.provider || "");
  const model = String(source.model || fallback.model || "").trim() || String(fallback.model || "");
  return { provider, model };
}

function resolveExecutionPolicy(
  policy: unknown,
  fallbackBinding: Required<ModelBinding>,
  fallbackTemperature?: number,
  fallbackMaxOutputTokens?: number,
  fallbackReasoningEffort?: string
) {
  const source = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy as CapabilityExecutionPolicy
    : {};
  const mode = String(source.mode || "inherit_orchestrator").trim() || "inherit_orchestrator";
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

export function getIdentitySettings(settings: unknown): Settings["identity"] {
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

export function getInteractionSettings(settings: unknown): Settings["interaction"] {
  return getSettingsSection(settings, (input) => input.interaction, DEFAULT_SETTINGS.interaction);
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

export function getSessionOrchestrationSettings(settings: unknown): Settings["interaction"]["sessions"] {
  return getSettingsSection(
    settings,
    (input) => input.interaction?.sessions,
    DEFAULT_SETTINGS.interaction.sessions
  );
}

export function getAgentStackSettings(settings: unknown): Settings["agentStack"] {
  return getSettingsSection(settings, (input) => input.agentStack, DEFAULT_SETTINGS.agentStack);
}

export function getMemorySettings(settings: unknown): Settings["memory"] {
  return getSettingsSection(settings, (input) => input.memory, DEFAULT_SETTINGS.memory);
}

export function getDirectiveSettings(settings: unknown): Settings["directives"] {
  return getSettingsSection(settings, (input) => input.directives, DEFAULT_SETTINGS.directives);
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

export function getMediaSettings(settings: unknown): Settings["media"] {
  return getSettingsSection(settings, (input) => input.media, DEFAULT_SETTINGS.media);
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

export function getMusicSettings(settings: unknown): Settings["music"] {
  return getSettingsSection(settings, (input) => input.music, DEFAULT_SETTINGS.music);
}

export function getAutomationsSettings(settings: unknown): Settings["automations"] {
  return getSettingsSection(settings, (input) => input.automations, DEFAULT_SETTINGS.automations);
}

export function getRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"] {
  const agentStack = getAgentStackSettings(settings);
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig, agentStack.runtimeConfig);
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

export function getClaudeCodeSessionRuntimeConfig(
  settings: unknown
): Settings["agentStack"]["runtimeConfig"]["claudeCodeSession"] {
  return mergeWithDefaults(
    DEFAULT_SETTINGS.agentStack.runtimeConfig.claudeCodeSession,
    getRuntimeConfig(settings).claudeCodeSession
  );
}

export function getDevTeamRuntimeConfig(settings: unknown): Settings["agentStack"]["runtimeConfig"]["devTeam"] {
  return mergeWithDefaults(DEFAULT_SETTINGS.agentStack.runtimeConfig.devTeam, getRuntimeConfig(settings).devTeam);
}

function getPresetDefaults(settings: unknown): PresetDefaults {
  const agentStack = getAgentStackSettings(settings);
  const presetName = String(agentStack.preset || DEFAULT_SETTINGS.agentStack.preset) as keyof typeof PRESET_DEFAULTS;
  return PRESET_DEFAULTS[presetName] || PRESET_DEFAULTS.openai_native;
}

function normalizeResolvedVoiceRuntime(value: unknown, fallback: string) {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "voice_agent") return "voice_agent";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  if (normalized === "stt_pipeline") return "stt_pipeline";
  return fallback;
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
  const memory = getMemorySettings(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(memory.execution, fallback, 0, 320);
  const binding = policy.mode === "dedicated_model"
    ? policy.model
    : fallback;
  return {
    provider: String(binding?.provider || fallback.provider),
    model: String(binding?.model || fallback.model),
    temperature: policy.temperature ?? 0,
    maxOutputTokens: policy.maxOutputTokens ?? 320,
    reasoningEffort: policy.reasoningEffort ?? fallback.reasoningEffort
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
  const agentStack = getAgentStackSettings(settings);
  const presetDefaults = getPresetDefaults(settings);
  const fallback = presetDefaults.voiceAdmissionClassifier || presetDefaults.orchestrator;
  const overridePolicy = resolveExecutionPolicy(
    agentStack.overrides?.voiceAdmissionClassifier,
    fallback
  );
  const mode = String(voiceAdmission.mode || "");
  if (mode === "deterministic_only" || mode === "generation_decides") {
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

export function getResolvedVoiceProvider(settings: unknown): string {
  const runtimeMode = String(getVoiceRuntimeConfig(settings).runtimeMode || resolveAgentStack(settings).voiceRuntime || "")
    .trim()
    .toLowerCase();
  if (runtimeMode === "voice_agent") return "xai";
  if (runtimeMode === "gemini_realtime") return "gemini";
  if (runtimeMode === "elevenlabs_realtime") return "elevenlabs";
  return "openai";
}

export function getResolvedVoiceGenerationBinding(settings: unknown) {
  const voiceRuntime = getVoiceRuntimeConfig(settings);
  const fallback = getResolvedOrchestratorBinding(settings);
  const policy = resolveExecutionPolicy(
    voiceRuntime.generation,
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
    maxBrowseCallsPerHour: Number(browserRuntime.localBrowserAgent?.maxBrowseCallsPerHour) || 10,
    maxStepsPerTask: Number(browserRuntime.localBrowserAgent?.maxStepsPerTask) || 15,
    stepTimeoutMs: Number(browserRuntime.localBrowserAgent?.stepTimeoutMs) || 30_000,
    sessionTimeoutMs: Number(browserRuntime.localBrowserAgent?.sessionTimeoutMs) || 300_000,
    localAgent: {
      provider: String(browserBinding?.provider || orchestrator.provider || "anthropic"),
      model: String(browserBinding?.model || orchestrator.model || "claude-sonnet-4-5-20250929")
    },
    openaiComputerUse: {
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
  const presetName = String(agentStack.preset || DEFAULT_SETTINGS.agentStack.preset) as keyof typeof PRESET_DEFAULTS;
  const presetDefaults = getPresetDefaults(settings);
  const overrides = agentStack.overrides || {};
  const voiceAdmission = getVoiceAdmissionSettings(settings);
  const claudeCodeSession = getClaudeCodeSessionRuntimeConfig(settings);
  const devTeamRuntime = getDevTeamRuntimeConfig(settings);
  const enabledWorkers = [
    devTeamRuntime?.codex?.enabled ? "codex" : null,
    devTeamRuntime?.claudeCode?.enabled ? "claude_code" : null
  ].filter(Boolean);
  const overrideWorkers = Array.isArray(overrides?.devTeam?.codingWorkers)
    ? overrides.devTeam.codingWorkers.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  const codingWorkers = (overrideWorkers.length ? overrideWorkers : presetDefaults.devTeam.codingWorkers)
    .filter((worker) => enabledWorkers.includes(worker));
  const harness = String(overrides?.harness || presetDefaults.harness);
  const devTeamOrchestrator = resolveModelBinding(
    overrides?.devTeam?.orchestrator,
    presetDefaults.devTeam.orchestrator
  );
  const sessionPolicy =
    harness === "claude_code_session"
      ? {
          persistent: true,
          toolPolicy: {
            voice: String(claudeCodeSession.voiceToolPolicy || presetDefaults.sessionPolicy?.toolPolicy.voice || "fast_only") as AgentSessionToolPolicy,
            text: String(claudeCodeSession.textToolPolicy || presetDefaults.sessionPolicy?.toolPolicy.text || "full") as AgentSessionToolPolicy
          }
        }
      : presetDefaults.sessionPolicy;

  return {
    preset: presetName,
    harness,
    sessionPolicy,
    orchestrator: resolveModelBinding(overrides?.orchestrator, presetDefaults.orchestrator),
    researchRuntime: String(overrides?.researchRuntime || presetDefaults.researchRuntime),
    browserRuntime: String(overrides?.browserRuntime || presetDefaults.browserRuntime),
    voiceRuntime: normalizeResolvedVoiceRuntime(overrides?.voiceRuntime, presetDefaults.voiceRuntime),
    voiceAdmissionPolicy: {
      mode: String(voiceAdmission.mode || presetDefaults.voiceAdmissionPolicy.mode),
      classifierProvider: getResolvedVoiceAdmissionClassifierBinding(settings)?.provider,
      classifierModel: getResolvedVoiceAdmissionClassifierBinding(settings)?.model,
      musicWakeLatchSeconds: Number(voiceAdmission.musicWakeLatchSeconds)
    },
    devTeam: {
      orchestrator: devTeamOrchestrator,
      roles: {
        design: resolveExecutionPolicy(
          presetDefaults.devTeam.roles.design,
          devTeamOrchestrator
        ),
        implementation: resolveExecutionPolicy(
          presetDefaults.devTeam.roles.implementation,
          devTeamOrchestrator
        ),
        review: resolveExecutionPolicy(
          presetDefaults.devTeam.roles.review,
          devTeamOrchestrator
        ),
        ...(presetDefaults.devTeam.roles.research
          ? {
              research: resolveExecutionPolicy(
                presetDefaults.devTeam.roles.research,
                devTeamOrchestrator
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
  const hasWorkers = Boolean(runtime?.codex?.enabled || runtime?.claudeCode?.enabled);
  return hasWorkers && Array.isArray(permissions.allowedUserIds) && permissions.allowedUserIds.length > 0;
}
