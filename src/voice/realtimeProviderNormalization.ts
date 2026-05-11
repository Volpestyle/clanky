export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export const OPENAI_REALTIME_DEFAULT_SESSION_MODEL = "gpt-realtime";
export const OPENAI_REALTIME_SESSION_MODEL_OPTIONS = Object.freeze([
  "gpt-realtime-2",
  "gpt-realtime",
  "gpt-realtime-1.5",
  "gpt-realtime-mini",
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview"
]);
const OPENAI_REALTIME_SUPPORTED_SESSION_MODELS: ReadonlySet<string> = new Set(OPENAI_REALTIME_SESSION_MODEL_OPTIONS);

const OPENAI_REALTIME_REASONING_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  "gpt-realtime-2"
]);

export const OPENAI_REALTIME_REASONING_EFFORT_OPTIONS = Object.freeze([
  "",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);
const OPENAI_REALTIME_SUPPORTED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

export const OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS = new Set([
  "whisper-1",
  "gpt-4o-transcribe-latest",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-mini-transcribe"
]);

export const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-think-fast-1.0";
export const XAI_REALTIME_MODEL_OPTIONS = Object.freeze([
  "grok-voice-think-fast-1.0",
  "grok-voice-fast-1.0"
]);
const XAI_REALTIME_SUPPORTED_MODELS: ReadonlySet<string> = new Set(XAI_REALTIME_MODEL_OPTIONS);

export const XAI_REALTIME_DEFAULT_VOICE = "eve";
export const XAI_REALTIME_VOICE_OPTIONS = Object.freeze([
  "eve",
  "ara",
  "rex",
  "sal",
  "leo"
]);
const XAI_REALTIME_BUILT_IN_VOICES: ReadonlySet<string> = new Set(XAI_REALTIME_VOICE_OPTIONS);

export const XAI_REALTIME_AUDIO_FORMAT_OPTIONS = Object.freeze([
  "audio/pcm"
]);
const XAI_REALTIME_SUPPORTED_AUDIO_FORMATS: ReadonlySet<string> = new Set(XAI_REALTIME_AUDIO_FORMAT_OPTIONS);

export const XAI_REALTIME_PCM_SAMPLE_RATE_OPTIONS = Object.freeze([
  8000,
  16000,
  22050,
  24000,
  32000,
  44100,
  48000
]);
const XAI_REALTIME_SUPPORTED_PCM_SAMPLE_RATES: ReadonlySet<number> = new Set(XAI_REALTIME_PCM_SAMPLE_RATE_OPTIONS);

export function normalizeOpenAiBaseUrl(value: unknown) {
  const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
  const normalized = raw || DEFAULT_OPENAI_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function normalizeOpenAiRealtimeTranscriptionModel(
  value: unknown,
  fallback = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
  return OPENAI_REALTIME_SUPPORTED_TRANSCRIPTION_MODELS.has(normalized)
    ? normalized
    : OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;
}

export function normalizeOpenAiRealtimeSessionModel(
  value: unknown,
  fallback = OPENAI_REALTIME_DEFAULT_SESSION_MODEL
) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || OPENAI_REALTIME_DEFAULT_SESSION_MODEL;
  return OPENAI_REALTIME_SUPPORTED_SESSION_MODELS.has(normalized)
    ? normalized
    : OPENAI_REALTIME_DEFAULT_SESSION_MODEL;
}

export function realtimeModelSupportsReasoningEffort(model: unknown) {
  const normalized = String(model || "").trim();
  if (!normalized) return false;
  return OPENAI_REALTIME_REASONING_CAPABLE_MODELS.has(normalized);
}

export function normalizeOpenAiRealtimeReasoningEffort(value: unknown, fallback: unknown = "") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized && OPENAI_REALTIME_SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return normalized;
  }
  const normalizedFallback = String(fallback ?? "").trim().toLowerCase();
  if (normalizedFallback && OPENAI_REALTIME_SUPPORTED_REASONING_EFFORTS.has(normalizedFallback)) {
    return normalizedFallback;
  }
  return "";
}

export function normalizeXaiRealtimeModel(
  value: unknown,
  fallback = XAI_REALTIME_DEFAULT_MODEL
) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || XAI_REALTIME_DEFAULT_MODEL;
  return XAI_REALTIME_SUPPORTED_MODELS.has(normalized)
    ? normalized
    : XAI_REALTIME_DEFAULT_MODEL;
}

export function normalizeXaiRealtimeVoice(
  value: unknown,
  fallback = XAI_REALTIME_DEFAULT_VOICE
) {
  const normalized =
    String(value || "").trim() || String(fallback || "").trim() || XAI_REALTIME_DEFAULT_VOICE;
  const builtIn = normalized.toLowerCase();
  return XAI_REALTIME_BUILT_IN_VOICES.has(builtIn)
    ? builtIn
    : normalized.slice(0, 200);
}

export function normalizeXaiRealtimeAudioFormat(
  value: unknown,
  fallback = "audio/pcm"
) {
  const normalized =
    String(value || "").trim().toLowerCase() || String(fallback || "").trim().toLowerCase() || "audio/pcm";
  return XAI_REALTIME_SUPPORTED_AUDIO_FORMATS.has(normalized)
    ? normalized
    : "audio/pcm";
}

export function normalizeXaiRealtimeSampleRateHz(
  value: unknown,
  fallback = 24000
) {
  const numeric = Math.floor(Number(value));
  if (XAI_REALTIME_SUPPORTED_PCM_SAMPLE_RATES.has(numeric)) return numeric;

  const fallbackNumeric = Math.floor(Number(fallback));
  return XAI_REALTIME_SUPPORTED_PCM_SAMPLE_RATES.has(fallbackNumeric)
    ? fallbackNumeric
    : 24000;
}

export function normalizeGeminiBaseUrl(value: unknown) {
  const raw = String(value || DEFAULT_GEMINI_BASE_URL).trim();
  if (!raw) return DEFAULT_GEMINI_BASE_URL;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_GEMINI_BASE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_GEMINI_BASE_URL;
  }
}

export function normalizeElevenLabsBaseUrl(value: unknown) {
  const target = String(value || DEFAULT_ELEVENLABS_BASE_URL).trim() || DEFAULT_ELEVENLABS_BASE_URL;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_ELEVENLABS_BASE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
}
