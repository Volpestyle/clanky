type E2EPipelinePreset = {
  name: string;
  description: string;
  overrides: Record<string, unknown>;
};

const SHARED_TEST_DEFAULTS: Record<string, unknown> = {
  interaction: {
    activity: {
      ambientReplyEagerness: 50,
      responseWindowEagerness: 50
    }
  },
  voice: {
    conversationPolicy: {
      ambientReplyEagerness: 50,
      commandOnlyMode: false
    }
  },
  initiative: {
    voice: {
      enabled: false,
      eagerness: 50
    }
  }
};

export const E2E_PRESETS: Record<string, E2EPipelinePreset> = {
  "bridge-openai": {
    name: "bridge-openai",
    description: "Per-user ASR bridge, OpenAI realtime brain",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        conversationPolicy: {
          replyPath: "bridge"
        },
        admission: { mode: "classifier_gate" }
      },
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "openai_realtime",
            generation: {
              mode: "dedicated_model",
              model: {
                provider: "openai",
                model: "gpt-5"
              }
            }
          }
        }
      }
    })
  },
  native: {
    name: "native",
    description: "Direct audio passthrough, no ASR",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        conversationPolicy: {
          replyPath: "native"
        },
        admission: { mode: "generation_decides" }
      },
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "openai_realtime",
            generation: {
              mode: "dedicated_model",
              model: {
                provider: "openai",
                model: "gpt-5"
              }
            }
          }
        }
      }
    })
  },
  gemini: {
    name: "gemini",
    description: "Gemini realtime for everything",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        },
        admission: { mode: "generation_decides" }
      },
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "gemini_realtime",
            generation: {
              mode: "dedicated_model",
              model: {
                provider: "google",
                model: "gemini-2.5-flash"
              }
            }
          }
        }
      }
    })
  },
  elevenlabs: {
    name: "elevenlabs",
    description: "ElevenLabs voice, OpenAI brain",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        },
        admission: { mode: "generation_decides" }
      },
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "elevenlabs_realtime",
            generation: {
              mode: "dedicated_model",
              model: {
                provider: "openai",
                model: "gpt-5"
              }
            }
          }
        }
      }
    })
  },
  "brain-anthropic": {
    name: "brain-anthropic",
    description: "OpenAI voice, Anthropic text brain",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        },
        admission: { mode: "generation_decides" }
      },
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "openai_realtime",
            generation: {
              mode: "dedicated_model",
              model: {
                provider: "anthropic",
                model: "claude-haiku-4-5"
              }
            }
          }
        }
      }
    })
  }
};

const DEFAULT_PRESET = "bridge-openai";

type ParsedFlags = {
  presetName: string;
  overrides: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveVoiceRuntimeMode(provider: string): string | undefined {
  switch (String(provider || "").trim().toLowerCase()) {
    case "openai":
      return "openai_realtime";
    case "xai":
      return "voice_agent";
    case "gemini":
      return "gemini_realtime";
    case "elevenlabs":
      return "elevenlabs_realtime";
    default:
      return undefined;
  }
}

function defaultBrainModelForProvider(provider: string): string | undefined {
  switch (String(provider || "").trim().toLowerCase()) {
    case "openai":
      return "gpt-5";
    case "anthropic":
      return "claude-haiku-4-5";
    case "xai":
      return "grok-4-latest";
    case "gemini":
      return "gemini-2.5-flash";
    default:
      return undefined;
  }
}

function upsertVoiceRuntime(agentStackOverrides: Record<string, unknown>, runtimeMode: string) {
  const existingOverrides = isRecord(agentStackOverrides.overrides) ? agentStackOverrides.overrides : {};
  const existingRuntimeConfig = isRecord(agentStackOverrides.runtimeConfig) ? agentStackOverrides.runtimeConfig : {};
  const existingVoiceRuntimeConfig = isRecord(existingRuntimeConfig.voice) ? existingRuntimeConfig.voice : {};

  agentStackOverrides.advancedOverridesEnabled = true;
  agentStackOverrides.overrides = {
    ...existingOverrides,
    voiceRuntime: runtimeMode
  };
  agentStackOverrides.runtimeConfig = {
    ...existingRuntimeConfig,
    voice: {
      ...existingVoiceRuntimeConfig,
      runtimeMode
    }
  };
}

function upsertBrainBinding(
  agentStackOverrides: Record<string, unknown>,
  {
    provider,
    model
  }: {
    provider?: string;
    model?: string;
  }
) {
  const existingOverrides = isRecord(agentStackOverrides.overrides) ? agentStackOverrides.overrides : {};
  const existingOrchestrator = isRecord(existingOverrides.orchestrator) ? existingOverrides.orchestrator : {};
  const existingRuntimeConfig = isRecord(agentStackOverrides.runtimeConfig) ? agentStackOverrides.runtimeConfig : {};
  const existingVoiceRuntimeConfig = isRecord(existingRuntimeConfig.voice) ? existingRuntimeConfig.voice : {};
  const existingGeneration = isRecord(existingVoiceRuntimeConfig.generation) ? existingVoiceRuntimeConfig.generation : {};
  const existingGenerationModel = isRecord(existingGeneration.model) ? existingGeneration.model : {};

  agentStackOverrides.advancedOverridesEnabled = true;
  agentStackOverrides.overrides = {
    ...existingOverrides,
    orchestrator: {
      ...existingOrchestrator,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {})
    }
  };
  agentStackOverrides.runtimeConfig = {
    ...existingRuntimeConfig,
    voice: {
      ...existingVoiceRuntimeConfig,
      generation: {
        ...existingGeneration,
        mode: "dedicated_model",
        model: {
          ...existingGenerationModel,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {})
        }
      }
    }
  };
}

export function parseE2EPipelineFlags(argv: string[]): ParsedFlags {
  let presetName = DEFAULT_PRESET;
  const voiceOverrides: Record<string, unknown> = {};
  const initiativeOverrides: Record<string, unknown> = {};
  const agentStackOverrides: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    if (!token.startsWith("--")) continue;
    const flag = token.slice(2);
    const next = String(argv[i + 1] || "").trim();
    const hasValue = next !== "" && !next.startsWith("--");
    if (hasValue) i += 1;

    switch (flag) {
      case "preset":
        if (hasValue) presetName = next;
        break;

      case "reply-path":
        if (hasValue) {
          voiceOverrides.conversationPolicy = {
            ...(voiceOverrides.conversationPolicy as Record<string, unknown> | undefined),
            replyPath: next
          };
        }
        break;

      case "voice-provider":
        if (hasValue) {
          const runtimeMode = resolveVoiceRuntimeMode(next);
          if (runtimeMode) {
            upsertVoiceRuntime(agentStackOverrides, runtimeMode);
          }
        }
        break;

      case "brain-provider":
        if (hasValue) {
          upsertBrainBinding(agentStackOverrides, {
            provider: next,
            model: defaultBrainModelForProvider(next)
          });
        }
        break;

      case "brain-model":
        if (hasValue) {
          upsertBrainBinding(agentStackOverrides, {
            provider: inferProviderFromModel(next),
            model: next
          });
        }
        break;

      case "voice-model":
        if (hasValue) {
          const existingRuntimeConfig = isRecord(agentStackOverrides.runtimeConfig)
            ? agentStackOverrides.runtimeConfig
            : {};
          const existingVoiceRuntimeConfig = isRecord(existingRuntimeConfig.voice)
            ? existingRuntimeConfig.voice
            : {};
          const existingOpenAiRealtime = isRecord(existingVoiceRuntimeConfig.openaiRealtime)
            ? existingVoiceRuntimeConfig.openaiRealtime
            : {};
          agentStackOverrides.runtimeConfig = {
            ...existingRuntimeConfig,
            voice: {
              ...existingVoiceRuntimeConfig,
              openaiRealtime: {
                ...existingOpenAiRealtime,
                model: next
              }
            }
          };
        }
        break;

      case "voice-name":
        if (hasValue) {
          const existingRuntimeConfig = isRecord(agentStackOverrides.runtimeConfig)
            ? agentStackOverrides.runtimeConfig
            : {};
          const existingVoiceRuntimeConfig = isRecord(existingRuntimeConfig.voice)
            ? existingRuntimeConfig.voice
            : {};
          const existingOpenAiRealtime = isRecord(existingVoiceRuntimeConfig.openaiRealtime)
            ? existingVoiceRuntimeConfig.openaiRealtime
            : {};
          agentStackOverrides.runtimeConfig = {
            ...existingRuntimeConfig,
            voice: {
              ...existingVoiceRuntimeConfig,
              openaiRealtime: {
                ...existingOpenAiRealtime,
                voice: next
              }
            }
          };
        }
        break;

      case "classifier":
        if (hasValue) {
          voiceOverrides.admission = {
            ...(voiceOverrides.admission as Record<string, unknown> | undefined),
            mode: next === "on" ? "classifier_gate" : "generation_decides"
          };
        }
        break;

      case "thought-engine":
        if (hasValue) {
          initiativeOverrides.voice = {
            ...(initiativeOverrides.voice as Record<string, unknown> | undefined),
            enabled: next === "on"
          };
        }
        break;

      case "command-only":
        if (hasValue) {
          voiceOverrides.conversationPolicy = {
            ...(voiceOverrides.conversationPolicy as Record<string, unknown> | undefined),
            commandOnlyMode: next === "on"
          };
        }
        break;
    }
  }

  const flagOverrides: Record<string, unknown> = {};
  if (Object.keys(voiceOverrides).length > 0) {
    flagOverrides.voice = voiceOverrides;
  }
  if (Object.keys(initiativeOverrides).length > 0) {
    flagOverrides.initiative = initiativeOverrides;
  }
  if (Object.keys(agentStackOverrides).length > 0) {
    flagOverrides.agentStack = agentStackOverrides;
  }

  return { presetName, overrides: flagOverrides };
}

export function resolveE2EPipelineOverrides(argv: string[]): ParsedFlags {
  const { presetName, overrides: flagOverrides } = parseE2EPipelineFlags(argv);

  const preset = E2E_PRESETS[presetName];
  if (!preset) {
    const available = Object.keys(E2E_PRESETS).join(", ");
    throw new Error(`Unknown E2E preset "${presetName}". Available: ${available}`);
  }

  const merged = deepMergePreset(preset.overrides, flagOverrides);
  return { presetName, overrides: merged };
}

function inferProviderFromModel(model: string): string | undefined {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o4")) return "openai";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("grok-")) return "xai";
  return undefined;
}

function deepMergePreset(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMergePreset(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}
