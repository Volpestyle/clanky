const VOICE_RUNTIME_SELECTIONS = [
  "xai",
  "openai",
  "gemini",
  "elevenlabs"
] as const;

const VOICE_RUNTIME_MODE_TO_SELECTION = Object.freeze({
  voice_agent: "xai",
  openai_realtime: "openai",
  gemini_realtime: "gemini",
  elevenlabs_realtime: "elevenlabs"
} as const);

export const STREAM_WATCH_VISUALIZER_MODES = [
  "off",
  "cqt",
  "spectrum",
  "waves",
  "vectorscope"
] as const;

type VoiceRuntimeSelection = (typeof VOICE_RUNTIME_SELECTIONS)[number];
export type StreamWatchVisualizerMode = (typeof STREAM_WATCH_VISUALIZER_MODES)[number];
type VoiceRuntimeProvider = VoiceRuntimeSelection;
const VOICE_RUNTIME_SELECTION_SET = new Set<string>(VOICE_RUNTIME_SELECTIONS);

function normalizeVoiceRuntimeSelection(
  value: unknown,
  fallback: VoiceRuntimeSelection = "openai"
): VoiceRuntimeSelection {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (VOICE_RUNTIME_SELECTION_SET.has(normalized)) {
    return normalized as VoiceRuntimeSelection;
  }
  return fallback;
}

export function resolveVoiceRuntimeSelectionFromMode(
  runtimeMode: unknown
): VoiceRuntimeSelection {
  const normalized = String(runtimeMode || "")
    .trim()
    .toLowerCase();
  return VOICE_RUNTIME_MODE_TO_SELECTION[normalized as keyof typeof VOICE_RUNTIME_MODE_TO_SELECTION] || "openai";
}

export function resolveVoiceRuntimeModeFromSelection(
  selection: unknown
): "voice_agent" | "openai_realtime" | "gemini_realtime" | "elevenlabs_realtime" {
  const normalized = normalizeVoiceRuntimeSelection(selection);
  const entry = Object.entries(VOICE_RUNTIME_MODE_TO_SELECTION).find(([, value]) => value === normalized);
  return (entry?.[0] || "openai_realtime") as "voice_agent" | "openai_realtime" | "gemini_realtime" | "elevenlabs_realtime";
}

export function resolveVoiceProviderFromRuntimeMode(runtimeMode: unknown): VoiceRuntimeProvider | null {
  const normalized = String(runtimeMode || "").trim().toLowerCase();
  const selection = VOICE_RUNTIME_MODE_TO_SELECTION[normalized as keyof typeof VOICE_RUNTIME_MODE_TO_SELECTION];
  return selection || null;
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
