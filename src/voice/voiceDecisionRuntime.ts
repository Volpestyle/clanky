import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";

const OPENAI_REALTIME_SHORT_CLIP_ASR_MS = 1200;
const PCM16_MONO_BYTES_PER_SAMPLE = 2;
const OPENAI_MINI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TRANSCRIBER_PROVIDER = "openai";

export function normalizeVoiceReplyDecisionProvider(value) {
  return normalizeLlmProvider(value);
}

export function defaultVoiceReplyDecisionModel(provider) {
  return defaultModelForLlmProvider(provider);
}

export function resolveVoiceReplyDecisionMaxOutputTokens(provider, model) {
  const normalizedProvider = normalizeVoiceReplyDecisionProvider(provider);
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase();
  if (normalizedProvider === "openai" || normalizedProvider === "openai-oauth") {
    if (/^gpt-5(?:$|[-_.])/u.test(normalizedModel)) {
      return 64;
    }
    return 16;
  }
  return 2;
}

type VoiceTurnTranscriptionPlan = {
  primaryModel: string;
  fallbackModel: string | null;
  reason: string;
};

export function resolveTurnTranscriptionPlan({
  mode,
  provider = DEFAULT_TRANSCRIBER_PROVIDER,
  configuredModel = OPENAI_MINI_TRANSCRIPTION_MODEL,
  pcmByteLength = 0,
  sampleRateHz = 24000
}: {
  mode?: string | null;
  provider?: string | null;
  configuredModel?: string | null;
  pcmByteLength?: number;
  sampleRateHz?: number;
}): VoiceTurnTranscriptionPlan {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const normalizedProvider = String(provider || DEFAULT_TRANSCRIBER_PROVIDER).trim().toLowerCase();
  const normalizedModel =
    normalizedProvider === "openai"
      ? String(configuredModel || OPENAI_MINI_TRANSCRIPTION_MODEL).trim() || OPENAI_MINI_TRANSCRIPTION_MODEL
      : String(configuredModel || "").trim();
  if (normalizedProvider !== "openai") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: normalizedModel ? "configured_model" : "provider_default_model"
    };
  }
  if (normalizedMode !== "openai_realtime") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: normalizedModel === OPENAI_MINI_TRANSCRIPTION_MODEL
        ? "mini_no_fallback_runtime"
        : "configured_model"
    };
  }

  if (normalizedModel !== OPENAI_MINI_TRANSCRIPTION_MODEL) {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_non_mini_model"
    };
  }

  const clipDurationMs = estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz);
  if (clipDurationMs > 0 && clipDurationMs <= OPENAI_REALTIME_SHORT_CLIP_ASR_MS) {
    return {
      primaryModel: OPENAI_MINI_TRANSCRIPTION_MODEL,
      fallbackModel: null,
      reason: "short_clip_prefers_full_model"
    };
  }

  return {
    primaryModel: normalizedModel,
    fallbackModel: null,
    reason: "mini_no_fallback"
  };
}

export async function transcribePcmTurnWithPlan<TSession>({
  transcribe,
  session,
  userId,
  pcmBuffer,
  plan,
  sampleRateHz = 24000,
  captureReason,
  traceSource,
  errorPrefix,
  emptyTranscriptRuntimeEvent,
  emptyTranscriptErrorStreakThreshold,
  asrLanguage,
  asrPrompt
}: {
  transcribe: (args: {
    session: TSession;
    userId: string;
    pcmBuffer: Buffer;
    model: string;
    sampleRateHz?: number;
    captureReason?: string;
    traceSource?: string;
    errorPrefix?: string;
    emptyTranscriptRuntimeEvent?: string;
    emptyTranscriptErrorStreakThreshold?: number;
    suppressEmptyTranscriptLogs?: boolean;
    asrLanguage?: string;
    asrPrompt?: string;
  }) => Promise<string>;
  session: TSession;
  userId: string;
  pcmBuffer: Buffer;
  plan: VoiceTurnTranscriptionPlan;
  sampleRateHz?: number;
  captureReason?: string;
  traceSource?: string;
  errorPrefix?: string;
  emptyTranscriptRuntimeEvent?: string;
  emptyTranscriptErrorStreakThreshold?: number;
  asrLanguage?: string;
  asrPrompt?: string;
}) {
  let transcript = await transcribe({
    session,
    userId,
    pcmBuffer,
    model: plan.primaryModel,
    sampleRateHz,
    captureReason,
    traceSource,
    errorPrefix,
    emptyTranscriptRuntimeEvent,
    emptyTranscriptErrorStreakThreshold,
    asrLanguage,
    asrPrompt
  });

  let usedFallbackModel = false;
  if (
    !transcript &&
    plan.fallbackModel &&
    plan.fallbackModel !== plan.primaryModel
  ) {
    transcript = await transcribe({
      session,
      userId,
      pcmBuffer,
      model: plan.fallbackModel,
      sampleRateHz,
      captureReason,
      traceSource: traceSource ? `${traceSource}_fallback` : undefined,
      errorPrefix: errorPrefix ? errorPrefix.replace(/_failed$/u, "_fallback_failed") : undefined,
      emptyTranscriptRuntimeEvent,
      emptyTranscriptErrorStreakThreshold,
      suppressEmptyTranscriptLogs: true,
      asrLanguage,
      asrPrompt
    });
    if (transcript) {
      usedFallbackModel = true;
    }
  }

  return {
    transcript,
    usedFallbackModel,
    fallbackModel: plan.fallbackModel,
    reason: plan.reason
  };
}

export function parseVoiceThoughtDecisionContract(rawText) {
  const normalized = String(rawText || "").trim();
  if (!normalized) {
    return {
      action: "drop",
      confident: false,
      finalThought: "",
      usedMemory: false,
      reason: ""
    };
  }

  const unwrapped = normalized.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```$/i, "").trim();
  const parseAllowValue = (value) => {
    if (typeof value === "boolean") return value;
    const normalizedValue = String(value || "").trim().toUpperCase();
    if (normalizedValue === "YES" || normalizedValue === "TRUE" || normalizedValue === "1") return true;
    if (normalizedValue === "NO" || normalizedValue === "FALSE" || normalizedValue === "0") return false;
    return null;
  };

  try {
    const parsedJson = JSON.parse(unwrapped);
    if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
      const rawAction = String(parsedJson.action || "")
        .trim()
        .toLowerCase();
      const action: "speak_now" | "hold" | "drop" | null =
        rawAction === "speak_now" || rawAction === "hold" || rawAction === "drop"
          ? rawAction
          : (() => {
            const allowValue = parseAllowValue(
              parsedJson.allow ??
                parsedJson.decision ??
                parsedJson.answer ??
                parsedJson.value
            );
            if (allowValue === true) return "speak_now";
            if (allowValue === false) return "drop";
            return null;
          })();
      if (action) {
        const finalThoughtValue =
          typeof parsedJson.finalThought === "string"
            ? parsedJson.finalThought
            : typeof parsedJson.thought === "string"
              ? parsedJson.thought
              : typeof parsedJson.line === "string"
                ? parsedJson.line
                : typeof parsedJson.text === "string"
                  ? parsedJson.text
                  : "";
        const usedMemoryValue = parsedJson.usedMemory;
        const usedMemory =
          typeof usedMemoryValue === "boolean"
            ? usedMemoryValue
            : /^(true|yes|1)$/i.test(String(usedMemoryValue || "").trim());
        return {
          action,
          confident: true,
          finalThought: String(finalThoughtValue || "").trim(),
          usedMemory,
          reason: String(parsedJson.reason || "").trim()
        };
      }
    }
  } catch {
    // ignore invalid JSON and continue with token parsing fallback
  }

  const tokenMatch = unwrapped.match(/^\s*(YES|NO)\b/i);
  if (!tokenMatch) {
    return {
      action: "drop",
      confident: false,
      finalThought: "",
      usedMemory: false,
      reason: ""
    };
  }

  const action: "speak_now" | "drop" =
    String(tokenMatch[1] || "").toUpperCase() === "YES" ? "speak_now" : "drop";
  let remainder = unwrapped.slice(tokenMatch[0].length).trim();
  remainder = remainder.replace(/^[:-]\s*/, "");
  let usedMemory = false;
  const usedMemoryMatch = remainder.match(/\bused[_\s-]?memory\s*[:=]\s*(true|false|yes|no|1|0)\b/i);
  if (usedMemoryMatch) {
    usedMemory = /^(true|yes|1)$/i.test(String(usedMemoryMatch[1] || "").trim());
    remainder = `${remainder.slice(0, usedMemoryMatch.index)} ${remainder.slice((usedMemoryMatch.index || 0) + usedMemoryMatch[0].length)}`.trim();
  }

  let reason = "";
  const reasonMatch = remainder.match(/\breason\s*[:=]\s*([a-z0-9_.-]+)/i);
  if (reasonMatch) {
    reason = String(reasonMatch[1] || "").trim();
    remainder = `${remainder.slice(0, reasonMatch.index)} ${remainder.slice((reasonMatch.index || 0) + reasonMatch[0].length)}`.trim();
  }

  return {
    action,
    confident: true,
    finalThought: action === "speak_now" ? remainder : "",
    usedMemory,
    reason
  };
}

interface AsrLogprobEntry {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

interface AsrTranscriptConfidence {
  meanLogprob: number;
  minLogprob: number;
  tokenCount: number;
}

export function computeAsrTranscriptConfidence(
  logprobs: AsrLogprobEntry[] | null | undefined
): AsrTranscriptConfidence | null {
  if (!Array.isArray(logprobs) || logprobs.length === 0) return null;
  let sum = 0;
  let min = Infinity;
  let count = 0;
  for (const entry of logprobs) {
    if (!entry || typeof entry.logprob !== "number" || !Number.isFinite(entry.logprob)) continue;
    sum += entry.logprob;
    if (entry.logprob < min) min = entry.logprob;
    count += 1;
  }
  if (count === 0) return null;
  return {
    meanLogprob: sum / count,
    minLogprob: min,
    tokenCount: count
  };
}

function estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
  return Math.round((normalizedBytes / (PCM16_MONO_BYTES_PER_SAMPLE * normalizedRate)) * 1000);
}
