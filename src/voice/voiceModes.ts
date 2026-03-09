export const VOICE_PROVIDERS = ["openai", "xai", "gemini", "elevenlabs"] as const;
export const BRAIN_PROVIDERS = ["native", "openai", "anthropic", "xai", "gemini"] as const;
export const TRANSCRIBER_PROVIDERS = ["openai"] as const;

export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export type BrainProvider = (typeof BRAIN_PROVIDERS)[number];
export type TranscriberProvider = (typeof TRANSCRIBER_PROVIDERS)[number];

export function normalizeVoiceProvider(value: unknown, fallback: VoiceProvider = "openai"): VoiceProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (VOICE_PROVIDERS.includes(normalized as VoiceProvider)) {
    return normalized as VoiceProvider;
  }
  return fallback;
}

export function normalizeBrainProvider(
  value: unknown,
  voiceProvider: unknown,
  fallback: BrainProvider = "openai"
): BrainProvider {
  const normalizedInput = String(value || fallback || "")
    .trim()
    .toLowerCase();
  const normalized = normalizedInput === "native" ? "openai" : normalizedInput;
  if (BRAIN_PROVIDERS.includes(normalized as BrainProvider)) {
    return normalized as BrainProvider;
  }
  return fallback;
}

export function normalizeTranscriberProvider(
  value: unknown,
  fallback: TranscriberProvider = "openai"
): TranscriberProvider {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (TRANSCRIBER_PROVIDERS.includes(normalized as TranscriberProvider)) {
    return normalized as TranscriberProvider;
  }
  return fallback;
}

export const VOICE_RUNTIME_MODES = [
  "voice_agent",
  "openai_realtime",
  "gemini_realtime",
  "elevenlabs_realtime"
] as const;

type VoiceRuntimeMode = (typeof VOICE_RUNTIME_MODES)[number];

export function normalizeVoiceRuntimeMode(value: unknown, fallback: VoiceRuntimeMode = "voice_agent"): VoiceRuntimeMode {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  return "voice_agent";
}

export function parseVoiceRuntimeMode(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "voice_agent") return "voice_agent";
  if (normalized === "openai_realtime") return "openai_realtime";
  if (normalized === "gemini_realtime") return "gemini_realtime";
  if (normalized === "elevenlabs_realtime") return "elevenlabs_realtime";
  return null;
}

// ---------------------------------------------------------------------------
// Realtime provider capability map
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  textInput: boolean;
  updateInstructions: boolean;
  updateTools: boolean;
  cancelResponse: boolean;
  perUserAsr: boolean;
  sharedAsr: boolean;
}

/**
 * Declares what each realtime runtime mode supports.
 * Keys are VoiceRuntimeMode values (what `session.mode` holds).
 */
export const REALTIME_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai_realtime: {
    textInput: true,
    updateInstructions: true,
    updateTools: true,
    cancelResponse: true,
    perUserAsr: true,
    sharedAsr: true,
  },
  voice_agent: {
    textInput: true,
    updateInstructions: true,
    updateTools: true,
    cancelResponse: true,
    perUserAsr: true,
    sharedAsr: true,
  },
  gemini_realtime: {
    textInput: true,
    updateInstructions: true,
    updateTools: false,
    cancelResponse: false,
    perUserAsr: false,
    sharedAsr: true,
  },
  elevenlabs_realtime: {
    textInput: true,
    updateInstructions: false,
    updateTools: false,
    cancelResponse: false,
    perUserAsr: false,
    sharedAsr: true,
  },
};

export function providerSupports(mode: string, cap: keyof ProviderCapabilities): boolean {
  const caps = REALTIME_PROVIDER_CAPABILITIES[mode];
  if (!caps) return false;
  return caps[cap];
}
