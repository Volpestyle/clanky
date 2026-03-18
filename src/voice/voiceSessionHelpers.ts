import { parseSoundboardReference } from "./soundboardDirector.ts";
import {
  getBotName,
  getBotNameAliases,
  getResolvedVoiceProvider,
  getResolvedVoiceGenerationBinding,
  getVoiceConversationPolicy,
  getVoiceTranscriptionSettings,
  resolveAgentStack
} from "../settings/agentStack.ts";
import { resolveVoiceProviderFromRuntimeMode } from "../settings/voiceDashboardMappings.ts";
import type { VoiceRuntimeEventContext } from "./voiceSessionTypes.ts";

const VOICE_ADDRESSING_ALL_TOKENS = new Set([
  "ALL",
  "EVERYONE",
  "EVERYBODY",
  "WHOLE_ROOM",
  "WHOLE_CHAT",
  "VC"
]);

export function normalizeVoiceAddressingTargetToken(value = "") {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (VOICE_ADDRESSING_ALL_TOKENS.has(upper)) return "ALL";
  return normalized;
}
import {
  normalizeVoiceRuntimeMode,
  normalizeVoiceProvider,
  normalizeBrainProvider,
  normalizeTranscriberProvider,
  VOICE_RUNTIME_MODES
} from "./voiceModes.ts";

type VoiceRuntimeMode = (typeof VOICE_RUNTIME_MODES)[number];
import { normalizeWhitespaceText } from "../normalization/text.ts";

const REALTIME_MEMORY_FACT_LIMIT = 8;
export const SOUNDBOARD_MAX_CANDIDATES = 40;
const OPENAI_REALTIME_MIN_COMMIT_AUDIO_MS = 100;
const SOUNDBOARD_DIRECTIVE_RE = /\[\[SOUNDBOARD:\s*([\s\S]*?)\s*\]\]/gi;
const NOTE_DIRECTIVE_RE = /\[\[NOTE:\s*([\s\S]*?)\s*\]\]/gi;
const NOTE_DIRECTIVE_MAX_LEN = 220;
const OPENAI_TRANSCRIPT_CONTROL_TOKEN_RE = /<\|[^|>]+?\|>/g;
const OPENAI_TRANSCRIPT_RESERVED_AUDIO_MARKER_RE =
  /\b(?:vq_[a-z]+_audio_[a-z0-9_]+|audio_future\d*|end_of_task)\b/gi;
const ASR_TRANSCRIPT_SPEECHLIKE_CONTENT_RE = /[\p{L}\p{N}]/u;
const MAX_SOUNDBOARD_DIRECTIVE_REF_LEN = 180;
const ASR_LANGUAGE_BIAS_PROMPT_MAX_LEN = 280;
const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
// English-token wake/vocative fallbacks. These help with cheap fast-path detection only.
const EN_WAKE_PRIMARY_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);

const VOICE_ASR_LANGUAGE_MODES = new Set(["auto", "fixed"]);
export const STT_TRANSCRIPT_MAX_CHARS = 2000;

export interface AsrTranscriptGuardResult {
  transcript: string;
  malformed: boolean;
  controlTokenCount: number;
  reservedAudioMarkerCount: number;
}

export function normalizeVoiceRuntimeEventContext(value: unknown): VoiceRuntimeEventContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const categoryRaw = String(raw.category || "").trim().toLowerCase();
  const category =
    categoryRaw === "membership"
      ? "membership"
      : categoryRaw === "screen_share"
        ? "screen_share"
        : categoryRaw === "generic"
          ? "generic"
          : "";
  if (!category) return null;

  const eventType = String(raw.eventType || raw.event || "").trim().toLowerCase();
  if (!eventType) return null;

  if (category === "membership" && eventType !== "join" && eventType !== "leave") {
    return null;
  }
  if (category === "screen_share" && eventType !== "share_start" && eventType !== "urgent" && eventType !== "direct_frame") {
    return null;
  }

  const actorRoleRaw = String(raw.actorRole || "").trim().toLowerCase();
  const actorRole =
    actorRoleRaw === "self"
      ? "self"
      : actorRoleRaw === "other"
        ? "other"
        : "unknown";

  const actorUserId = String(raw.actorUserId || "").trim() || null;
  const actorDisplayName = String(raw.actorDisplayName || "").trim().slice(0, 80) || null;

  return {
    category,
    eventType,
    actorUserId,
    actorDisplayName,
    actorRole,
    hasVisibleFrame: category === "screen_share" ? Boolean(raw.hasVisibleFrame) : undefined
  };
}

export function parseRealtimeErrorPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      message: String(payload || "unknown realtime error"),
      code: null,
      param: null,
      lastOutboundEventType: null,
      lastOutboundEvent: null,
      recentOutboundEvents: null
    };
  }

  const message = String(payload.message || "unknown realtime error");
  const code = payload.code ? String(payload.code) : null;
  const param =
    payload.param !== undefined && payload.param !== null
      ? String(payload.param)
      : payload?.event?.error?.param
        ? String(payload.event.error.param)
        : null;
  const lastOutboundEventType = payload.lastOutboundEventType
    ? String(payload.lastOutboundEventType)
    : null;
  const lastOutboundEvent =
    payload.lastOutboundEvent && typeof payload.lastOutboundEvent === "object"
      ? payload.lastOutboundEvent
      : null;
  const recentOutboundEvents = Array.isArray(payload.recentOutboundEvents)
    ? payload.recentOutboundEvents.slice(-4)
    : null;
  return {
    message,
    code,
    param,
    lastOutboundEventType,
    lastOutboundEvent,
    recentOutboundEvents
  };
}

export function isRecoverableRealtimeError({ mode, code, message }) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalizedMode !== "openai_realtime") return false;

  const normalizedCode = String(code || "")
    .trim()
    .toLowerCase();
  if (normalizedCode === "input_audio_buffer_commit_empty") return true;
  if (normalizedCode === "conversation_already_has_active_response") return true;
  if (normalizedCode === "response_cancel_not_active") return true;

  const normalizedMessage = String(message || "")
    .trim()
    .toLowerCase();
  if (!normalizedMessage) return false;
  if (normalizedMessage.includes("active response in progress")) return true;
  if (normalizedMessage.includes("no active response found")) return true;
  return normalizedMessage.includes("input audio buffer") && normalizedMessage.includes("buffer too small");
}

export function getRealtimeCommitMinimumBytes(mode, sampleRateHz = 24000) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();
  if (normalizedMode !== "openai_realtime") return 1;
  const hz = Math.max(8_000, Number(sampleRateHz) || 24_000);
  const bytesPerSecond = hz * 2;
  const minBytes = Math.ceil((bytesPerSecond * OPENAI_REALTIME_MIN_COMMIT_AUDIO_MS) / 1000);
  return Math.max(1, minBytes);
}

export function parseResponseDoneId(event) {
  if (!event || typeof event !== "object") return null;
  const direct = event.response_id || event.id || null;
  const nested = event.response?.id || null;
  const value = nested || direct;
  if (!value) return null;
  return String(value);
}

export function parseResponseDoneStatus(event) {
  if (!event || typeof event !== "object") return null;
  const status = event.response?.status || event.status || null;
  if (!status) return null;
  return String(status);
}

export function parseResponseDoneModel(event) {
  if (!event || typeof event !== "object") return null;
  const model = event.response?.model || null;
  if (!model) return null;
  return String(model);
}

export function parseResponseDoneUsage(event) {
  if (!event || typeof event !== "object") return null;
  const response = event.response && typeof event.response === "object" ? event.response : null;
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  if (!usage) return null;

  const inputDetails =
    usage.input_token_details && typeof usage.input_token_details === "object"
      ? usage.input_token_details
      : {};
  const outputDetails =
    usage.output_token_details && typeof usage.output_token_details === "object"
      ? usage.output_token_details
      : {};

  return {
    inputTokens: clampUsageTokenCount(usage.input_tokens),
    outputTokens: clampUsageTokenCount(usage.output_tokens),
    totalTokens: clampUsageTokenCount(usage.total_tokens),
    cacheReadTokens: clampUsageTokenCount(inputDetails.cached_tokens),
    inputAudioTokens: clampUsageTokenCount(inputDetails.audio_tokens),
    inputTextTokens: clampUsageTokenCount(inputDetails.text_tokens),
    outputAudioTokens: clampUsageTokenCount(outputDetails.audio_tokens),
    outputTextTokens: clampUsageTokenCount(outputDetails.text_tokens)
  };
}

export function transcriptSourceFromEventType(eventType) {
  const normalized = String(eventType || "").trim();
  if (!normalized) return "unknown";
  if (normalized === "conversation.item.input_audio_transcription.completed") return "input";
  if (normalized === "user_transcript") return "input";
  if (normalized === "agent_response") return "output";
  if (normalized === "agent_response_correction") return "output";
  if (normalized.includes("input_audio_transcription")) return "input";
  if (normalized.includes("output_audio_transcription")) return "output";
  if (normalized.includes("server_content_text")) return "output";
  if (normalized.includes("response.text")) return "output";
  if (normalized.includes("output_text")) return "output";
  if (/audio_transcript/i.test(normalized)) return "output";
  if (/transcript/i.test(normalized)) return "unknown";
  return "unknown";
}

export function isFinalRealtimeTranscriptEventType(eventType, source = null) {
  const normalized = String(eventType || "")
    .trim()
    .toLowerCase();
  const normalizedSource = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return normalizedSource !== "output";
  }

  if (normalized.includes("delta") || normalized.includes("partial")) return false;
  if (normalized === "server_content_text") return false;

  if (normalized.includes("input_audio_transcription")) {
    return normalized.includes("completed") || normalized === "input_audio_transcription";
  }

  if (normalized.includes("output_audio_transcription")) {
    return (
      normalized.includes("done") ||
      normalized.includes("completed") ||
      normalized === "output_audio_transcription"
    );
  }

  if (normalized.includes("output_audio_transcript")) {
    return normalized.includes("done") || normalized.includes("completed");
  }

  if (normalized.includes("response.output_text")) {
    return normalized.endsWith(".done") || normalized.includes("completed");
  }

  if (normalized.includes("response.text")) {
    return normalized.includes("done") || normalized.includes("completed");
  }

  if (/audio_transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }

  if (/transcript/u.test(normalized)) {
    return !normalized.includes("delta");
  }

  return true;
}

export function extractSoundboardDirective(rawText) {
  const parsed = parseSoundboardDirectiveSequence(rawText);
  const refs = Array.isArray(parsed?.references) ? parsed.references : [];
  const text = String(rawText || "");
  if (!text || !refs.length) {
    return {
      text: parsed?.text || "",
      reference: null
    };
  }

  return {
    text: parsed.text || "",
    reference: refs[refs.length - 1] || null
  };
}

export function parseSoundboardDirectiveSequence(rawText) {
  const text = String(rawText || "");
  if (!text) {
    return {
      text: "",
      references: [],
      sequence: []
    };
  }

  const sequence = [];
  const references = [];
  let cursor = 0;

  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;
  let match = null;
  while ((match = SOUNDBOARD_DIRECTIVE_RE.exec(text))) {
    const fullMatch = String(match?.[0] || "");
    if (!fullMatch) continue;
    const start = Number(match.index || 0);
    const end = start + fullMatch.length;
    if (start > cursor) {
      sequence.push({
        type: "speech",
        text: text.slice(cursor, start)
      });
    }
    const reference = String(match?.[1] || "")
      .trim()
      .slice(0, MAX_SOUNDBOARD_DIRECTIVE_REF_LEN);
    if (reference) {
      references.push(reference);
      sequence.push({
        type: "soundboard",
        reference
      });
    }
    cursor = end;
  }
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;

  if (cursor < text.length) {
    sequence.push({
      type: "speech",
      text: text.slice(cursor)
    });
  }

  const withoutDirective = text
    .replace(SOUNDBOARD_DIRECTIVE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;

  return {
    text: withoutDirective,
    references,
    sequence
  };
}

/**
 * Extract trailing [[NOTE:...]] directives from raw LLM output.
 * Notes are private observations the brain writes for itself — they are
 * never spoken aloud.  Call this on the raw generation text *before*
 * normalizeSkipSentinel / normalizeVoiceReplyText so that a
 * `[SKIP] [[NOTE:...]]` output correctly resolves to a skip + stored note.
 *
 * Returns { text, notes } where `text` has all [[NOTE:...]] stripped and
 * `notes` is the extracted note strings (usually 0 or 1).
 */
export function extractNoteDirectives(rawText: unknown): {
  text: string;
  notes: string[];
} {
  const text = String(rawText || "").trim();
  if (!text) return { text: "", notes: [] };

  const notes: string[] = [];
  NOTE_DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = NOTE_DIRECTIVE_RE.exec(text))) {
    const note = String(match?.[1] || "").trim().slice(0, NOTE_DIRECTIVE_MAX_LEN);
    if (note) notes.push(note);
  }
  NOTE_DIRECTIVE_RE.lastIndex = 0;

  if (notes.length === 0) return { text, notes: [] };

  const withoutNotes = text
    .replace(NOTE_DIRECTIVE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  NOTE_DIRECTIVE_RE.lastIndex = 0;

  return { text: withoutNotes, notes };
}

export function shortError(text) {
  return String(text || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function resolveVoiceProvider(settings) {
  return normalizeVoiceProvider(getResolvedVoiceProvider(settings), "openai");
}

function resolveBrainProvider(settings) {
  const voiceProvider = resolveVoiceProvider(settings);
  return normalizeBrainProvider(getResolvedVoiceGenerationBinding(settings).provider, voiceProvider, "openai");
}

export function resolveTranscriberProvider(settings) {
  const transcription = getVoiceTranscriptionSettings(settings);
  return normalizeTranscriberProvider(transcription.provider, "openai");
}

export function resolveVoiceApiTtsProvider(settings) {
  const voiceProvider = resolveVoiceProvider(settings);
  return voiceProvider === "elevenlabs" ? "elevenlabs" : "openai";
}

export function resolveVoiceRuntimeMode(settings) {
  const resolvedStack = resolveAgentStack(settings);
  return normalizeVoiceRuntimeMode(resolvedStack.voiceRuntime, "openai_realtime") as VoiceRuntimeMode;
}

export function resolveRealtimeProvider(mode) {
  return resolveVoiceProviderFromRuntimeMode(mode);
}

export function isRealtimeMode(mode) {
  return Boolean(resolveRealtimeProvider(mode));
}

export function getRealtimeRuntimeLabel(mode) {
  const provider = resolveRealtimeProvider(mode);
  if (provider === "xai") return "xai";
  if (provider === "openai") return "openai_realtime";
  if (provider === "gemini") return "gemini_realtime";
  if (provider === "elevenlabs") return "elevenlabs_realtime";
  return "realtime";
}

export function parsePreferredSoundboardReferences(values) {
  const source = Array.isArray(values) ? values : [];
  const parsed = source
    .map((value) => parseSoundboardReference(value))
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      name: null,
      origin: "preferred"
    }));
  return dedupeSoundboardCandidates(parsed).slice(0, SOUNDBOARD_MAX_CANDIDATES);
}

export function dedupeSoundboardCandidates(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const out = [];

  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const reference = String(entry.reference || "").trim();
    if (!reference) continue;
    const key = reference.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...entry,
      reference
    });
  }

  return out;
}

export function formatSoundboardCandidateLine(entry) {
  const reference = String(entry?.reference || "").trim();
  const name = String(entry?.name || "").trim();
  if (!reference) return "";
  return name ? `- ${reference} | ${name}` : `- ${reference}`;
}

export function formatVoiceChannelEffectSummary(entry, { includeTiming = false } = {}) {
  const effectType = String(entry?.effectType || "")
    .trim()
    .toLowerCase();
  const displayName = normalizeVoiceText(entry?.displayName || "someone", 80) || "someone";
  const soundName = normalizeVoiceText(entry?.soundName || "", 80);
  const emoji = normalizeVoiceText(entry?.emoji || "", 80);
  let summary = "";

  if (effectType === "soundboard") {
    summary = soundName
      ? `${displayName} played soundboard "${soundName}"`
      : `${displayName} played a soundboard effect`;
  } else if (effectType === "emoji") {
    summary = emoji
      ? `${displayName} sent voice effect ${emoji}`
      : `${displayName} sent a voice effect`;
  } else {
    summary = `${displayName} sent a voice effect`;
  }

  if (!includeTiming) return summary;
  const ageMs = Number(entry?.ageMs);
  if (!Number.isFinite(ageMs)) return summary;
  return `${summary} (${Math.max(0, Math.round(ageMs))}ms ago)`;
}

function normalizeSoundboardReferenceToken(value) {
  return String(value || "")
    .trim()
    .replace(/^[`"'([{<]+/, "")
    .replace(/[`"')\]}>.,!?;:]+$/, "")
    .toLowerCase();
}

export function matchSoundboardReference(options, requestedRef) {
  const token = normalizeSoundboardReferenceToken(requestedRef);
  if (!token) return null;
  return options.find((entry) => String(entry.reference || "").toLowerCase() === token) || null;
}

export function findMentionedSoundboardReference(options, text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return null;
  return options.find((entry) => raw.includes(String(entry.reference || "").toLowerCase())) || null;
}

export function isBotNameAddressed({
  transcript,
  botName = ""
}) {
  const transcriptTokens = tokenizeWakeTokens(transcript);
  if (!transcriptTokens.length) return false;

  const botTokens = tokenizeWakeTokens(botName);
  if (!botTokens.length) return false;
  if (botTokens.length === 1) {
    return hasSingleTokenWakeAddress({
      transcript,
      transcriptTokens,
      wakeToken: botTokens[0] || ""
    });
  }
  if (containsTokenSequence(transcriptTokens, botTokens)) return true;
  const mergedWakeToken = resolveMergedWakeToken(botTokens);
  if (mergedWakeToken && transcriptTokens.some((token) => token === mergedWakeToken)) return true;

  const primaryWakeToken = resolvePrimaryWakeToken(botTokens);
  if (!primaryWakeToken) return false;
  return hasSingleTokenWakeAddress({
    transcript,
    transcriptTokens,
    wakeToken: primaryWakeToken
  });
}

export function isVoiceTurnAddressedToBot(transcript, settings) {
  if (isBotNameAddressed({ transcript, botName: getBotName(settings) })) return true;
  const aliases = getBotNameAliases(settings);
  for (const alias of aliases) {
    if (alias && isBotNameAddressed({ transcript, botName: String(alias) })) return true;
  }
  return false;
}

function tokenizeWakeTokens(value = "") {
  const normalized = normalizeWakeText(value);
  const matches = normalized.match(/[\p{L}\p{N}]+/gu);
  return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

function containsTokenSequence(tokens = [], sequence = []) {
  if (!Array.isArray(tokens) || !Array.isArray(sequence)) return false;
  if (!tokens.length || !sequence.length || sequence.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let matched = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (tokens[start + index] !== sequence[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function resolvePrimaryWakeToken(botTokens = []) {
  const candidates = botTokens.filter((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN);
  if (!candidates.length) return null;
  const preferred = candidates.find((token) => !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token));
  return preferred || candidates[0];
}

function resolveMergedWakeToken(botTokens = []) {
  if (!Array.isArray(botTokens) || botTokens.length < 2) return null;
  const merged = botTokens.join("");
  return merged.length >= PRIMARY_WAKE_TOKEN_MIN_LEN ? merged : null;
}

const LEADING_WAKE_PREFIX_TOKENS = new Set([
  "yo",
  "hey",
  "hi",
  "hello",
  "sup",
  "ay",
  "ayy",
  "oi",
  "ok",
  "okay",
  "alright",
  "please"
]);

function hasSingleTokenWakeAddress({
  transcript,
  transcriptTokens,
  wakeToken
}: {
  transcript: string;
  transcriptTokens: string[];
  wakeToken: string;
}) {
  const normalizedWakeToken = String(wakeToken || "").trim().toLowerCase();
  if (!normalizedWakeToken) return false;
  if (hasLeadingWakeToken(transcriptTokens, normalizedWakeToken)) return true;
  return hasVocativeWakeToken(transcript, normalizedWakeToken);
}

function hasLeadingWakeToken(tokens: string[] = [], wakeToken = "") {
  if (!Array.isArray(tokens) || !tokens.length || !wakeToken) return false;
  let index = 0;
  while (index < tokens.length && LEADING_WAKE_PREFIX_TOKENS.has(tokens[index])) {
    index += 1;
  }
  return tokens[index] === wakeToken;
}

function hasVocativeWakeToken(transcript = "", wakeToken = "") {
  const normalizedTranscript = normalizeWakeText(transcript);
  if (!normalizedTranscript || !wakeToken) return false;
  const escapedWakeToken = escapeRegex(wakeToken);
  return new RegExp(`[,;:.!?]\\s*${escapedWakeToken}(?:\\b|')`, "u").test(normalizedTranscript);
}

function escapeRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldAllowVoiceNsfwHumor(settings) {
  const voiceFlag = getVoiceConversationPolicy(settings).allowNsfwHumor;
  if (voiceFlag === true) return true;
  if (voiceFlag === false) return false;
  return false;
}

function normalizeVoiceAsrLanguageMode(mode = "", fallback = "auto") {
  const normalizedMode = String(mode || fallback || "auto")
    .trim()
    .toLowerCase();
  return VOICE_ASR_LANGUAGE_MODES.has(normalizedMode) ? normalizedMode : "auto";
}

function normalizeVoiceAsrLanguageHint(hint = "", fallback = "") {
  if (hint === undefined || hint === null) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  const normalizedHint = String(hint || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalizedHint) return "";
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/u.test(normalizedHint)) {
    return normalizeVoiceAsrLanguageHint(fallback, "");
  }
  return normalizedHint.slice(0, 24);
}

export function resolveVoiceAsrLanguageGuidance(settings = null) {
  const transcription = getVoiceTranscriptionSettings(settings);
  const mode = normalizeVoiceAsrLanguageMode(transcription.languageMode, "auto");
  const hint = normalizeVoiceAsrLanguageHint(transcription.languageHint, "en");
  const fixedLanguage = mode === "fixed" ? hint : "";
  const promptHint = hint
    ? `Language hint: ${hint}. Prefer this language when uncertain, but transcribe the actual spoken language.`
    : "";
  const prompt = mode === "auto" ? promptHint.slice(0, ASR_LANGUAGE_BIAS_PROMPT_MAX_LEN) : "";
  return {
    mode,
    hint,
    language: fixedLanguage || "",
    prompt
  };
}

export function formatRealtimeMemoryFacts(facts, maxItems = REALTIME_MEMORY_FACT_LIMIT) {
  if (!Array.isArray(facts) || !facts.length) return "";
  return facts
    .slice(0, Math.max(1, Number(maxItems) || REALTIME_MEMORY_FACT_LIMIT))
    .map((row) => {
      const fact = normalizeVoiceText(row?.fact || "", 180);
      if (!fact) return "";
      const type = String(row?.fact_type || "")
        .trim()
        .toLowerCase();
      return type && type !== "other" ? `${type}: ${fact}` : fact;
    })
    .filter(Boolean)
    .join(" | ");
}

export function normalizeVoiceText(value, maxChars = 1200) {
  return normalizeWhitespaceText(value, {
    maxLen: maxChars,
    minLen: 40
  });
}

export function inspectAsrTranscript(value: unknown, maxChars = STT_TRANSCRIPT_MAX_CHARS): AsrTranscriptGuardResult {
  const transcript = normalizeVoiceText(value, maxChars);
  if (!transcript) {
    return {
      transcript: "",
      malformed: false,
      controlTokenCount: 0,
      reservedAudioMarkerCount: 0
    };
  }

  const controlTokenCount = Array.from(
    transcript.matchAll(OPENAI_TRANSCRIPT_CONTROL_TOKEN_RE)
  ).length;
  const reservedAudioMarkerCount = Array.from(
    transcript.matchAll(OPENAI_TRANSCRIPT_RESERVED_AUDIO_MARKER_RE)
  ).length;

  return {
    transcript: ASR_TRANSCRIPT_SPEECHLIKE_CONTENT_RE.test(transcript) ? transcript : "",
    malformed: controlTokenCount > 0 || reservedAudioMarkerCount > 0,
    controlTokenCount,
    reservedAudioMarkerCount
  };
}

export function normalizeInlineText(value: unknown = "", maxChars = STT_TRANSCRIPT_MAX_CHARS) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, Number(maxChars) || STT_TRANSCRIPT_MAX_CHARS));
}

export function buildRealtimeTextUtterancePrompt(text, maxLineChars = 1200) {
  const line = normalizeVoiceText(text, maxLineChars);
  if (!line) return "";
  return `Speak this exact line verbatim and nothing else: ${line}`;
}

export function encodePcm16MonoAsWav(pcmBuffer, sampleRate = 24000) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const normalizedRate = Math.max(8000, Math.min(48000, Number(sampleRate) || 24000));
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = normalizedRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(normalizedRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);

  return buffer;
}

function clampUsageTokenCount(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}
