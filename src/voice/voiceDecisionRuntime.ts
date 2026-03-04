import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";

const VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS = 10;
const VOICE_LOW_SIGNAL_MIN_WORDS = 2;
const OPENAI_REALTIME_SHORT_CLIP_ASR_MS = 1200;
const PCM16_MONO_BYTES_PER_SAMPLE = 2;
// English-only low-signal fallback tokens; this should stay a cheap fast-path, not the main admission policy.
const EN_LOW_SIGNAL_GUARD_TOKENS = new Set(["yo", "hi", "sup", "ey", "oi", "oy", "ha"]);

export function isLowSignalVoiceFragment(transcript = "") {
  const normalized = String(transcript || "").trim();
  if (!normalized) return true;
  if (/[?¿؟？]/u.test(normalized)) return false;
  if (/^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|won'?t)\b/i.test(normalized)) {
    return false;
  }
  const normalizedTokens = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  if (
    normalizedTokens.length > 0 &&
    normalizedTokens.length <= 2 &&
    normalizedTokens.every((token) => EN_LOW_SIGNAL_GUARD_TOKENS.has(token))
  ) {
    return false;
  }

  const alnumChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  if (wordCount >= 3 && alnumChars >= 6) {
    return false;
  }
  if (alnumChars >= VOICE_LOW_SIGNAL_MIN_ALNUM_CHARS && wordCount >= VOICE_LOW_SIGNAL_MIN_WORDS) {
    return false;
  }

  return true;
}

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
  if (normalizedProvider === "openai" && /^gpt-5(?:$|[-_])/u.test(normalizedModel)) {
    return 64;
  }
  return 2;
}

export function resolveRealtimeTurnTranscriptionPlan({
  mode,
  configuredModel = "gpt-4o-mini-transcribe",
  pcmByteLength = 0,
  sampleRateHz = 24000
}) {
  const normalizedModel = String(configuredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
  if (String(mode || "") !== "openai_realtime") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_model"
    };
  }

  if (normalizedModel !== "gpt-4o-mini-transcribe") {
    return {
      primaryModel: normalizedModel,
      fallbackModel: null,
      reason: "configured_non_mini_model"
    };
  }

  const clipDurationMs = estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz);
  if (clipDurationMs > 0 && clipDurationMs <= OPENAI_REALTIME_SHORT_CLIP_ASR_MS) {
    return {
      primaryModel: "gpt-4o-mini-transcribe",
      fallbackModel: null,
      reason: "short_clip_prefers_full_model"
    };
  }

  return {
    primaryModel: normalizedModel,
    fallbackModel: "whisper-1",
    reason: "mini_with_full_fallback"
  };
}

export function parseVoiceDecisionContract(rawText) {
  const normalized = String(rawText || "").trim();
  if (!normalized) {
    return {
      allow: false,
      confident: false
    };
  }

  const unwrapped = normalized.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsedJson = JSON.parse(unwrapped);
    const jsonDecisionValue =
      typeof parsedJson === "string"
        ? parsedJson
        : parsedJson && typeof parsedJson === "object"
          ? parsedJson.decision || parsedJson.answer || parsedJson.value || ""
          : "";
    const jsonDecision = String(jsonDecisionValue || "").trim().toUpperCase();
    if (jsonDecision === "YES") {
      return {
        allow: true,
        confident: true
      };
    }
    if (jsonDecision === "NO") {
      return {
        allow: false,
        confident: true
      };
    }
  } catch {
    // ignore invalid JSON and continue with token parsing fallback
  }

  const quoted = unwrapped
    .replace(/^["'`]\s*/g, "")
    .replace(/\s*["'`]$/g, "")
    .trim()
    .toUpperCase();
  if (quoted === "YES") {
    return {
      allow: true,
      confident: true
    };
  }
  if (quoted === "NO") {
    return {
      allow: false,
      confident: true
    };
  }

  return {
    allow: false,
    confident: false
  };
}

export function parseVoiceThoughtDecisionContract(rawText) {
  const normalized = String(rawText || "").trim();
  if (!normalized) {
    return {
      allow: false,
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
      const allowValue = parseAllowValue(
        parsedJson.allow ??
          parsedJson.decision ??
          parsedJson.answer ??
          parsedJson.value
      );
      if (allowValue !== null) {
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
          allow: allowValue,
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
      allow: false,
      confident: false,
      finalThought: "",
      usedMemory: false,
      reason: ""
    };
  }

  const allow = String(tokenMatch[1] || "").toUpperCase() === "YES";
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
    allow,
    confident: true,
    finalThought: allow ? remainder : "",
    usedMemory,
    reason
  };
}

function estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
  const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
  const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
  return Math.round((normalizedBytes / (PCM16_MONO_BYTES_PER_SAMPLE * normalizedRate)) * 1000);
}
