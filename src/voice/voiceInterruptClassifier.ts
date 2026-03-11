import { buildSingleTurnPromptLog } from "../promptLogging.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import {
  applyOrchestratorOverrideSettings,
  getResolvedVoiceInterruptClassifierBinding
} from "../settings/agentStack.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import {
  defaultVoiceReplyDecisionModel,
  normalizeVoiceReplyDecisionProvider,
  resolveVoiceReplyDecisionMaxOutputTokens
} from "./voiceDecisionRuntime.ts";
import {
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import {
  normalizeInlineText,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import type {
  LoggedVoicePromptBundle,
  VoiceInterruptOverlapBurstEntry,
  VoiceSession
} from "./voiceSessionTypes.ts";

type InterruptClassifierSettings = Record<string, unknown> | null;

type InterruptClassifierStoreLike = {
  logAction?: (entry: {
    kind?: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type InterruptClassifierGenerateResult = {
  text?: string | null;
};

type InterruptClassifierHost = {
  store?: InterruptClassifierStoreLike | null;
  llm?: {
    generate?: (args: {
      settings: InterruptClassifierSettings;
      systemPrompt: string;
      userPrompt: string;
      contextMessages: unknown[];
      trace?: {
        guildId?: string | null;
        channelId?: string | null;
        userId?: string | null;
        source?: string | null;
      };
    }) => Promise<InterruptClassifierGenerateResult>;
  } | null;
};

export type VoiceInterruptClassifierResult = {
  decision: "interrupt" | "ignore";
  source: string;
  latencyMs: number;
  promptLog: LoggedVoicePromptBundle | null;
  rawOutput?: string | null;
  error?: string | null;
};

function normalizeBurstText(text: string, maxChars = STT_TRANSCRIPT_MAX_CHARS) {
  return normalizeVoiceText(text, maxChars);
}

function countTokens(text: string) {
  const normalized = normalizeBurstText(text, STT_REPLY_MAX_CHARS);
  if (!normalized) return 0;
  return normalized.split(/\s+/u).filter(Boolean).length;
}

function isLikelyLaughterToken(text: string) {
  const normalized = normalizeInlineText(text, 120)
    .toLowerCase()
    .replace(/[.!?,'"`~^*_()[\]{}:;|/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return true;
  if (/^(?:ha|heh|haha|hehe|lol|lmao|lmfao|rofl|哈|哈哈|하|하하|ㅋ|ㅋㅋ|ｗ|ww)+$/u.test(normalized.replace(/\s+/gu, ""))) {
    return true;
  }
  return false;
}

function isLikelyLowSignalOverlapText(text: string) {
  const normalized = normalizeInlineText(text, 160)
    .toLowerCase()
    .replace(/[.!?,'"`~^*_()[\]{}:;|/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return true;
  if (isLikelyLaughterToken(normalized)) return true;
  if (/^(?:mm+|mhm+|mhmm+|uh+|uh huh|uhhuh|uh-huh|yeah+|yep+|ya+|ok(?:ay)?|right+|true+|damn+|bro+|crazy+|wild+|woah+|wow+|yo+)(?:\s+(?:mm+|mhm+|yeah+|ok(?:ay)?|right+|true+|damn+|bro+|crazy+|wild+|woah+|wow+|yo+))*$/u.test(normalized)) {
    return true;
  }
  return countTokens(normalized) <= 2 && normalized.length <= 12;
}

export function isObviousInterruptTakeoverText(text: string) {
  const normalized = normalizeInlineText(text, 200)
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;
  if (isCancelIntent(normalized)) return true;
  return /\b(?:wait|hold on|hang on|stop|pause|one sec|one second|let me talk|lemme talk|can i talk|can i say something|listen)\b/u.test(normalized);
}

export function hasObviousInterruptTakeoverBurst(entries: VoiceInterruptOverlapBurstEntry[]) {
  return (Array.isArray(entries) ? entries : []).some((entry) => isObviousInterruptTakeoverText(entry.transcript));
}

function hasClearlySemanticBurst(entries: VoiceInterruptOverlapBurstEntry[]) {
  return entries.some((entry) => {
    const transcript = normalizeBurstText(entry.transcript, STT_REPLY_MAX_CHARS);
    if (!transcript) return false;
    if (isObviousInterruptTakeoverText(transcript)) return true;
    if (/[?]/u.test(transcript)) return true;
    return countTokens(transcript) >= 6 || transcript.length >= 28;
  });
}

function formatBurstEntries(entries: VoiceInterruptOverlapBurstEntry[]) {
  return entries
    .map((entry) => {
      const speaker = normalizeInlineText(entry.speakerName, 80) || "someone";
      const transcript = normalizeBurstText(entry.transcript, STT_REPLY_MAX_CHARS);
      const phase = entry.isFinal ? "final" : "partial";
      return `${speaker} (${phase}): "${transcript}"`;
    })
    .filter(Boolean)
    .join("\n");
}

function buildInterruptClassifierPrompt({
  settings,
  interruptedUtteranceText,
  entries
}: {
  settings: InterruptClassifierSettings;
  interruptedUtteranceText: string;
  entries: VoiceInterruptOverlapBurstEntry[];
}) {
  const botName = getPromptBotName(settings);
  const assistantLine = normalizeBurstText(interruptedUtteranceText, STT_REPLY_MAX_CHARS) || "[unknown]";
  const burstLines = formatBurstEntries(entries);
  const systemPrompt = [
    `You are deciding whether ${botName} should stop speaking right now in a Discord voice chat.`,
    "Return exactly one token: INTERRUPT or IGNORE.",
    "Use INTERRUPT only when someone is clearly taking the floor, redirecting the conversation, asking a real question, giving a command, or meaningfully stopping the assistant.",
    "Use IGNORE for laughter, backchannel, short acknowledgements, filler, ambient reaction noise, or overlap that is too weak or ambiguous to justify stopping the assistant."
  ].join("\n");
  const userPrompt = [
    `Assistant speech in progress: "${assistantLine}"`,
    "",
    "Recent overlapping ASR burst:",
    burstLines || "[none]",
    "",
    "Should the assistant stop speaking right now?"
  ].join("\n");
  return {
    systemPrompt,
    userPrompt,
    promptLog: buildSingleTurnPromptLog({
      systemPrompt,
      userPrompt
    })
  };
}

function parseInterruptDecision(text: string): "interrupt" | "ignore" | null {
  const normalized = normalizeInlineText(text, 80).toUpperCase();
  if (!normalized) return null;
  if (normalized.includes("INTERRUPT")) return "interrupt";
  if (normalized.includes("IGNORE")) return "ignore";
  return null;
}

export async function classifyVoiceInterruptBurst(
  host: InterruptClassifierHost,
  {
    session,
    settings,
    interruptedUtteranceText,
    entries,
    traceUserId = null
  }: {
    session: Pick<VoiceSession, "id" | "guildId" | "textChannelId">;
    settings: InterruptClassifierSettings;
    interruptedUtteranceText: string;
    entries: VoiceInterruptOverlapBurstEntry[];
    traceUserId?: string | null;
  }
): Promise<VoiceInterruptClassifierResult> {
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      ...entry,
      transcript: normalizeBurstText(entry.transcript, STT_REPLY_MAX_CHARS)
    }))
    .filter((entry) => Boolean(entry.transcript));
  if (normalizedEntries.length === 0) {
    return {
      decision: "ignore",
      source: "empty_burst",
      latencyMs: 0,
      promptLog: null
    };
  }
  if (normalizedEntries.every((entry) => isLikelyLowSignalOverlapText(entry.transcript))) {
    return {
      decision: "ignore",
      source: "low_signal_heuristic",
      latencyMs: 0,
      promptLog: null
    };
  }
  if (normalizedEntries.some((entry) => isObviousInterruptTakeoverText(entry.transcript))) {
    return {
      decision: "interrupt",
      source: "takeover_heuristic",
      latencyMs: 0,
      promptLog: null
    };
  }

  const binding = getResolvedVoiceInterruptClassifierBinding(settings);
  const llmProvider = normalizeVoiceReplyDecisionProvider(binding?.provider || "openai");
  const llmModel = String(binding?.model || defaultVoiceReplyDecisionModel(llmProvider)).trim() || defaultVoiceReplyDecisionModel(llmProvider);
  const maxOutputTokens = resolveVoiceReplyDecisionMaxOutputTokens(llmProvider, llmModel);
  const { systemPrompt, userPrompt, promptLog } = buildInterruptClassifierPrompt({
    settings,
    interruptedUtteranceText,
    entries: normalizedEntries
  });

  if (!host.llm?.generate) {
    return {
      decision: hasClearlySemanticBurst(normalizedEntries) ? "interrupt" : "ignore",
      source: "llm_unavailable_fallback",
      latencyMs: 0,
      promptLog,
      error: "llm_generate_unavailable"
    };
  }

  const startedAt = Date.now();
  try {
    const result = await host.llm.generate({
      settings: applyOrchestratorOverrideSettings(settings, {
        provider: llmProvider,
        model: llmModel,
        temperature: 0,
        maxOutputTokens,
        reasoningEffort: "minimal"
      }),
      systemPrompt,
      userPrompt,
      contextMessages: [],
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: traceUserId,
        source: "voice_interrupt_classifier"
      }
    });
    const rawOutput = String(result?.text || "");
    const decision = parseInterruptDecision(rawOutput);
    if (decision) {
      return {
        decision,
        source: decision === "interrupt" ? "model_interrupt" : "model_ignore",
        latencyMs: Date.now() - startedAt,
        promptLog,
        rawOutput
      };
    }
    return {
      decision: hasClearlySemanticBurst(normalizedEntries) ? "interrupt" : "ignore",
      source: "unparseable_fallback",
      latencyMs: Date.now() - startedAt,
      promptLog,
      rawOutput,
      error: `unparseable_interrupt_classifier_output:${rawOutput.slice(0, 60)}`
    };
  } catch (error) {
    const message = String(error?.message || error || "unknown_error");
    host.store?.logAction?.({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: traceUserId,
      content: `voice_interrupt_classifier_failed: ${message}`,
      metadata: {
        sessionId: session.id,
        burstEntryCount: normalizedEntries.length
      }
    });
    return {
      decision: hasClearlySemanticBurst(normalizedEntries) ? "interrupt" : "ignore",
      source: "runtime_error_fallback",
      latencyMs: Date.now() - startedAt,
      promptLog,
      error: message
    };
  }
}

export function isLowSignalInterruptBurst(entries: VoiceInterruptOverlapBurstEntry[]) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  return normalizedEntries.length > 0 &&
    normalizedEntries.every((entry) => isLikelyLowSignalOverlapText(entry.transcript));
}
