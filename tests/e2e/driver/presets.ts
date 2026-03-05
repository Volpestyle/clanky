type E2EPipelinePreset = {
  name: string;
  description: string;
  overrides: Record<string, unknown>;
};

const SHARED_TEST_DEFAULTS: Record<string, unknown> = {
  activity: {
    replyEagerness: 50
  },
  voice: {
    replyEagerness: 50,
    commandOnlyMode: false,
    thoughtEngine: {
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
        replyPath: "bridge",
        voiceProvider: "openai",
        brainProvider: "openai",
        replyDecisionLlm: { realtimeAdmissionMode: "hard_classifier" }
      }
    })
  },
  native: {
    name: "native",
    description: "Direct audio passthrough, no ASR",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        replyPath: "native",
        voiceProvider: "openai",
        brainProvider: "openai",
        replyDecisionLlm: { realtimeAdmissionMode: "generation_only" }
      }
    })
  },
  gemini: {
    name: "gemini",
    description: "Gemini realtime for everything",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        replyPath: "brain",
        voiceProvider: "gemini",
        brainProvider: "gemini",
        replyDecisionLlm: { realtimeAdmissionMode: "generation_only" }
      }
    })
  },
  elevenlabs: {
    name: "elevenlabs",
    description: "ElevenLabs voice, OpenAI brain",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        replyPath: "brain",
        voiceProvider: "elevenlabs",
        brainProvider: "openai",
        replyDecisionLlm: { realtimeAdmissionMode: "generation_only" }
      }
    })
  },
  "brain-anthropic": {
    name: "brain-anthropic",
    description: "OpenAI voice, Anthropic text brain",
    overrides: deepMergePreset(SHARED_TEST_DEFAULTS, {
      voice: {
        replyPath: "brain",
        voiceProvider: "openai",
        brainProvider: "anthropic",
        replyDecisionLlm: { realtimeAdmissionMode: "generation_only" }
      }
    })
  }
};

const DEFAULT_PRESET = "bridge-openai";

type ParsedFlags = {
  presetName: string;
  overrides: Record<string, unknown>;
};

export function parseE2EPipelineFlags(argv: string[]): ParsedFlags {
  let presetName = DEFAULT_PRESET;
  const voiceOverrides: Record<string, unknown> = {};

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
        if (hasValue) voiceOverrides.replyPath = next;
        break;

      case "voice-provider":
        if (hasValue) voiceOverrides.voiceProvider = next;
        break;

      case "brain-provider":
        if (hasValue) voiceOverrides.brainProvider = next;
        break;

      case "brain-model":
        if (hasValue) {
          voiceOverrides.generationLlm = {
            ...(voiceOverrides.generationLlm as Record<string, unknown> | undefined),
            model: next,
            provider: next
          };
          const provider = inferProviderFromModel(next);
          if (provider) {
            (voiceOverrides.generationLlm as Record<string, unknown>).provider = provider;
          }
        }
        break;

      case "voice-model":
        if (hasValue) {
          voiceOverrides.openaiRealtime = {
            ...(voiceOverrides.openaiRealtime as Record<string, unknown> | undefined),
            model: next
          };
        }
        break;

      case "voice-name":
        if (hasValue) {
          voiceOverrides.openaiRealtime = {
            ...(voiceOverrides.openaiRealtime as Record<string, unknown> | undefined),
            voice: next
          };
        }
        break;

      case "classifier":
        if (hasValue) {
          voiceOverrides.replyDecisionLlm = {
            ...(voiceOverrides.replyDecisionLlm as Record<string, unknown> | undefined),
            realtimeAdmissionMode: next === "on" ? "hard_classifier" : "generation_only"
          };
        }
        break;

      case "thought-engine":
        if (hasValue) {
          voiceOverrides.thoughtEngine = {
            ...(voiceOverrides.thoughtEngine as Record<string, unknown> | undefined),
            enabled: next === "on"
          };
        }
        break;

      case "command-only":
        if (hasValue) {
          voiceOverrides.commandOnlyMode = next === "on";
        }
        break;
    }
  }

  const flagOverrides: Record<string, unknown> =
    Object.keys(voiceOverrides).length > 0 ? { voice: voiceOverrides } : {};

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
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
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
