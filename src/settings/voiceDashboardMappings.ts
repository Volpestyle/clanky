const VOICE_RUNTIME_SELECTIONS = [
  "xai",
  "openai",
  "gemini",
  "elevenlabs"
] as const;

export const STREAM_WATCH_VISUALIZER_MODES = [
  "off",
  "cqt",
  "spectrum",
  "waves",
  "vectorscope"
] as const;

type VoiceRuntimeSelection = (typeof VOICE_RUNTIME_SELECTIONS)[number];
export type StreamWatchVisualizerMode = (typeof STREAM_WATCH_VISUALIZER_MODES)[number];

function normalizeVoiceRuntimeSelection(
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
): "generation_decides" | "classifier_gate" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "classifier_gate" ? "classifier_gate" : "generation_decides";
}

export function resolveVoiceAdmissionModeForSettings({
  value,
  replyPath
}: {
  value: unknown;
  replyPath: unknown;
}): "generation_decides" | "classifier_gate" {
  const normalizedReplyPath = String(replyPath || "brain").trim().toLowerCase();
  if (normalizedReplyPath === "bridge") {
    return "classifier_gate";
  }
  if (normalizedReplyPath === "brain") {
    return normalizeVoiceAdmissionModeForDashboard(value);
  }
  return "generation_decides";
}

export function resolveRealtimeAdmissionModeForRuntime(
  value: unknown,
  replyPath: unknown
): "hard_classifier" | "generation_only" {
  const normalizedReplyPath = String(replyPath || "brain").trim().toLowerCase();
  if (normalizedReplyPath === "bridge") {
    return "hard_classifier";
  }
  if (
    normalizedReplyPath === "brain" &&
    normalizeVoiceAdmissionModeForDashboard(value) === "classifier_gate"
  ) {
    return "hard_classifier";
  }
  return "generation_only";
}

export function normalizeStreamWatchVisualizerMode(
  value: unknown,
  fallback: StreamWatchVisualizerMode = "cqt"
): StreamWatchVisualizerMode {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (normalized === "off") return "off";
  if (normalized === "spectrum") return "spectrum";
  if (normalized === "waves") return "waves";
  if (normalized === "vectorscope") return "vectorscope";
  return "cqt";
}
