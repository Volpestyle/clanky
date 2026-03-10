export const VOICE_RUNTIME_SELECTIONS = [
  "xai",
  "openai",
  "gemini",
  "elevenlabs"
] as const;

export type VoiceRuntimeSelection = (typeof VOICE_RUNTIME_SELECTIONS)[number];

export function normalizeVoiceRuntimeSelection(
  value: unknown,
  fallback: VoiceRuntimeSelection = "openai"
): VoiceRuntimeSelection {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "xai") return "xai";
  if (normalized === "gemini") return "gemini";
  if (normalized === "elevenlabs") return "elevenlabs";
  return "openai";
}

export function resolveVoiceRuntimeSelectionFromMode(
  runtimeMode: unknown
): VoiceRuntimeSelection {
  const normalized = String(runtimeMode || "")
    .trim()
    .toLowerCase();
  if (normalized === "voice_agent") return "xai";
  if (normalized === "gemini_realtime") return "gemini";
  if (normalized === "elevenlabs_realtime") return "elevenlabs";
  return "openai";
}

export function resolveVoiceRuntimeModeFromSelection(
  selection: unknown
): "voice_agent" | "openai_realtime" | "gemini_realtime" | "elevenlabs_realtime" {
  const normalized = normalizeVoiceRuntimeSelection(selection);
  if (normalized === "xai") return "voice_agent";
  if (normalized === "gemini") return "gemini_realtime";
  if (normalized === "elevenlabs") return "elevenlabs_realtime";
  return "openai_realtime";
}

export function normalizeVoiceAdmissionModeForDashboard(
  value: unknown
): "generation_decides" | "classifier_gate" | "adaptive" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "adaptive") {
    return "adaptive";
  }
  if (normalized === "classifier_gate" || normalized === "hard_classifier") {
    return "classifier_gate";
  }
  return "generation_decides";
}
