import {
  AGENT_STACK_PRESETS,
  type DevTeamRoles,
  type SettingsModelBinding,
  type SettingsCodingWorkerName
} from "./settingsSchema.ts";

export type AgentSessionToolPolicy = "none" | "fast_only" | "full";

export type AgentSessionPolicy = {
  persistent: boolean;
  toolPolicy: {
    voice: AgentSessionToolPolicy;
    text: AgentSessionToolPolicy;
  };
};

export type AgentStackPresetDefaults = {
  harness: string;
  orchestrator: SettingsModelBinding;
  researchRuntime: string;
  browserRuntime: string;
  voiceRuntime: string;
  voiceReplyPath: "native" | "bridge" | "brain";
  voiceTtsMode: "realtime" | "api";
  voiceAdmissionPolicy: {
    mode: "generation_decides" | "classifier_gate";
  };
  voiceAdmissionClassifier?: SettingsModelBinding;
  voiceInterruptClassifier?: SettingsModelBinding;
  voiceMusicBrain?: SettingsModelBinding;
  voiceGeneration?: SettingsModelBinding;
  sessionPolicy?: AgentSessionPolicy;
  devTeam: {
    orchestrator: SettingsModelBinding;
    roles: DevTeamRoles;
    codingWorkers: SettingsCodingWorkerName[];
  };
};

export type AgentStackPresetName = (typeof AGENT_STACK_PRESETS)[number];

type AgentStackPresetDefinition = AgentStackPresetDefaults & {
  label: string;
  browserFallback?: SettingsModelBinding;
  visionFallback?: SettingsModelBinding;
};

const AGENT_STACK_PRESET_DEFINITIONS = {
  claude_oauth: {
    label: "Claude OAuth",
    harness: "internal",
    orchestrator: {
      provider: "claude-oauth",
      model: "claude-opus-4-6"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceReplyPath: "brain",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "generation_decides"
    },
    voiceAdmissionClassifier: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    },
    voiceInterruptClassifier: {
      provider: "claude-oauth",
      model: "claude-haiku-4-5"
    },
    voiceMusicBrain: {
      provider: "claude-oauth",
      model: "claude-haiku-4-5"
    },
    voiceGeneration: {
      provider: "claude-oauth",
      model: "claude-sonnet-4-6"
    },
    browserFallback: {
      provider: "claude-oauth",
      model: "claude-opus-4-6"
    },
    visionFallback: {
      provider: "claude-oauth",
      model: "claude-opus-4-6"
    },
    devTeam: {
      orchestrator: {
        provider: "claude-oauth",
        model: "claude-sonnet-4-6"
      },
      roles: {
        design: "claude_code",
        implementation: "claude_code",
        review: "claude_code",
        research: "claude_code"
      },
      codingWorkers: ["claude_code", "codex_cli"]
    }
  },
  claude_api: {
    label: "Claude API",
    harness: "internal",
    orchestrator: {
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceReplyPath: "brain",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "generation_decides"
    },
    voiceAdmissionClassifier: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voiceMusicBrain: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    voiceGeneration: {
      provider: "anthropic",
      model: "claude-haiku-4-5"
    },
    devTeam: {
      orchestrator: {
        provider: "anthropic",
        model: "claude-sonnet-4-6"
      },
      roles: {
        design: "claude_code",
        implementation: "claude_code",
        review: "claude_code",
        research: "claude_code"
      },
      codingWorkers: ["claude_code", "codex_cli"]
    }
  },
  openai_native_realtime: {
    label: "OpenAI Native Realtime",
    harness: "responses_native",
    orchestrator: {
      provider: "openai",
      model: "gpt-5"
    },
    researchRuntime: "openai_native_web_search",
    browserRuntime: "openai_computer_use",
    voiceRuntime: "openai_realtime",
    voiceReplyPath: "bridge",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "classifier_gate"
    },
    voiceAdmissionClassifier: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    voiceMusicBrain: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    devTeam: {
      orchestrator: {
        provider: "openai",
        model: "gpt-5"
      },
      roles: {
        design: "codex_cli",
        implementation: "codex_cli",
        review: "codex_cli",
        research: "codex_cli"
      },
      codingWorkers: ["codex_cli", "claude_code"]
    }
  },
  openai_api: {
    label: "OpenAI API",
    harness: "internal",
    orchestrator: {
      provider: "openai",
      model: "gpt-5"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceReplyPath: "brain",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "generation_decides"
    },
    voiceAdmissionClassifier: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    voiceMusicBrain: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    voiceGeneration: {
      provider: "openai",
      model: "gpt-5-mini"
    },
    devTeam: {
      orchestrator: {
        provider: "openai",
        model: "gpt-5"
      },
      roles: {
        design: "codex_cli",
        implementation: "codex_cli",
        review: "codex_cli",
        research: "codex_cli"
      },
      codingWorkers: ["codex_cli", "claude_code"]
    }
  },
  openai_oauth: {
    label: "OpenAI OAuth",
    harness: "internal",
    orchestrator: {
      provider: "openai-oauth",
      model: "gpt-5.4"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "openai_realtime",
    voiceReplyPath: "brain",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "generation_decides"
    },
    voiceAdmissionClassifier: {
      provider: "openai-oauth",
      model: "gpt-5.1-codex-mini"
    },
    voiceMusicBrain: {
      provider: "openai-oauth",
      model: "gpt-5.4-nano"
    },
    voiceGeneration: {
      provider: "openai-oauth",
      model: "gpt-5.4-mini"
    },
    visionFallback: {
      provider: "openai-oauth",
      model: "gpt-5.4"
    },
    devTeam: {
      orchestrator: {
        provider: "openai-oauth",
        model: "gpt-5.4"
      },
      roles: {
        design: "codex_cli",
        implementation: "codex_cli",
        review: "codex_cli",
        research: "codex_cli"
      },
      codingWorkers: ["codex_cli", "claude_code"]
    }
  },
  grok_native_agent: {
    label: "Grok Native Agent",
    harness: "internal",
    orchestrator: {
      provider: "xai",
      model: "grok-4-latest"
    },
    researchRuntime: "local_external_search",
    browserRuntime: "local_browser_agent",
    voiceRuntime: "voice_agent",
    voiceReplyPath: "native",
    voiceTtsMode: "realtime",
    voiceAdmissionPolicy: {
      mode: "generation_decides"
    },
    voiceAdmissionClassifier: {
      provider: "xai",
      model: "grok-3-mini-latest"
    },
    voiceMusicBrain: {
      provider: "xai",
      model: "grok-3-mini-latest"
    },
    devTeam: {
      orchestrator: {
        provider: "xai",
        model: "grok-4-latest"
      },
      roles: {
        design: "codex_cli",
        implementation: "codex_cli",
        review: "codex_cli",
        research: "codex_cli"
      },
      codingWorkers: ["claude_code", "codex_cli"]
    }
  }
} as const satisfies Record<AgentStackPresetName, AgentStackPresetDefinition>;

export const AGENT_STACK_PRESET_OPTIONS = AGENT_STACK_PRESETS.map((preset) => ({
  value: preset,
  label: AGENT_STACK_PRESET_DEFINITIONS[preset].label
})) as readonly { value: AgentStackPresetName; label: string }[];

export function normalizeAgentStackPresetName(
  value: unknown,
  fallback: AgentStackPresetName = "claude_oauth"
): AgentStackPresetName {
  const normalized = String(value || "").trim();
  return AGENT_STACK_PRESETS.includes(normalized as AgentStackPresetName)
    ? normalized as AgentStackPresetName
    : fallback;
}

export function getAgentStackPresetDefinition(
  preset: unknown,
  fallback: AgentStackPresetName = "claude_oauth"
): AgentStackPresetDefinition {
  return AGENT_STACK_PRESET_DEFINITIONS[normalizeAgentStackPresetName(preset, fallback)];
}

export function getAgentStackPresetDefaults(
  preset: unknown,
  fallback: AgentStackPresetName = "claude_oauth"
): AgentStackPresetDefaults {
  const definition = getAgentStackPresetDefinition(preset, fallback);
  return {
    harness: definition.harness,
    orchestrator: { ...definition.orchestrator },
    researchRuntime: definition.researchRuntime,
    browserRuntime: definition.browserRuntime,
    voiceRuntime: definition.voiceRuntime,
    voiceReplyPath: definition.voiceReplyPath,
    voiceTtsMode: definition.voiceTtsMode,
    voiceAdmissionPolicy: {
      mode: definition.voiceAdmissionPolicy.mode
    },
    ...(definition.voiceAdmissionClassifier
      ? {
          voiceAdmissionClassifier: {
            ...definition.voiceAdmissionClassifier
          }
        }
      : {}),
    ...(definition.voiceInterruptClassifier
      ? {
          voiceInterruptClassifier: {
            ...definition.voiceInterruptClassifier
          }
        }
      : {}),
    ...(definition.voiceMusicBrain
      ? {
          voiceMusicBrain: {
            ...definition.voiceMusicBrain
          }
        }
      : {}),
    ...(definition.voiceGeneration
      ? {
          voiceGeneration: {
            ...definition.voiceGeneration
          }
        }
      : {}),
    ...(definition.sessionPolicy
      ? {
          sessionPolicy: {
            persistent: definition.sessionPolicy.persistent,
            toolPolicy: {
              voice: definition.sessionPolicy.toolPolicy.voice,
              text: definition.sessionPolicy.toolPolicy.text
            }
          }
        }
      : {}),
    devTeam: {
      orchestrator: { ...definition.devTeam.orchestrator },
      roles: { ...definition.devTeam.roles },
      codingWorkers: [...definition.devTeam.codingWorkers]
    }
  };
}

export function getPresetVoiceAdmissionClassifierFallback(
  preset: unknown
): SettingsModelBinding | undefined {
  const definition = getAgentStackPresetDefinition(preset);
  return definition.voiceAdmissionClassifier
    ? { ...definition.voiceAdmissionClassifier }
    : undefined;
}

export function getPresetVoiceInterruptClassifierFallback(
  preset: unknown
): SettingsModelBinding | undefined {
  const definition = getAgentStackPresetDefinition(preset);
  if (definition.voiceInterruptClassifier) {
    return { ...definition.voiceInterruptClassifier };
  }
  return definition.voiceAdmissionClassifier
    ? { ...definition.voiceAdmissionClassifier }
    : undefined;
}

export function getPresetVoiceMusicBrainFallback(
  preset: unknown
): SettingsModelBinding | undefined {
  const definition = getAgentStackPresetDefinition(preset);
  return definition.voiceMusicBrain
    ? { ...definition.voiceMusicBrain }
    : undefined;
}
