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
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_INTERRUPT_CLASSIFIER_TIMEOUT_MS
} from "./voiceSessionManager.constants.ts";
import {
  normalizeInlineText,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import type {
  LoggedVoicePromptBundle,
  VoiceSession
} from "./voiceSessionTypes.ts";

type PrePlaybackReplyClassifierSettings = Record<string, unknown> | null;

type PrePlaybackReplyClassifierStoreLike = {
  logAction?: (entry: {
    kind?: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type PrePlaybackReplyClassifierGenerateResult = {
  text?: string | null;
};

type PrePlaybackReplyClassifierHost = {
  store?: PrePlaybackReplyClassifierStoreLike | null;
  llm?: {
    generate?: (args: {
      settings: PrePlaybackReplyClassifierSettings;
      systemPrompt: string;
      userPrompt: string;
      contextMessages: unknown[];
      trace?: {
        guildId?: string | null;
        channelId?: string | null;
        userId?: string | null;
        source?: string | null;
      };
      signal?: AbortSignal;
    }) => Promise<PrePlaybackReplyClassifierGenerateResult>;
  } | null;
};

export type PrePlaybackReplyClassifierDecision = "replace" | "ignore";

export type PrePlaybackReplyClassifierResult = {
  decision: PrePlaybackReplyClassifierDecision;
  source: string;
  latencyMs: number;
  promptLog: LoggedVoicePromptBundle | null;
  rawOutput?: string | null;
  error?: string | null;
};

function normalizeClassifierText(text: string, maxChars = STT_TRANSCRIPT_MAX_CHARS) {
  return normalizeVoiceText(text, maxChars);
}

function countTokens(text: string) {
  const normalized = normalizeClassifierText(text, STT_REPLY_MAX_CHARS);
  if (!normalized) return 0;
  return normalized.split(/\s+/u).filter(Boolean).length;
}

function normalizeCompact(text: string, maxChars = 220) {
  return normalizeInlineText(text, maxChars)
    .toLowerCase()
    .replace(/[.!?,'"`~^*_()[\]{}:;|/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isLikelyLowSignalBackchannel(text: string) {
  const normalized = normalizeCompact(text, 160);
  if (!normalized) return true;
  if (
    /^(?:ha|heh|haha|hehe|lol|lmao|lmfao|rofl|哈|哈哈|하|하하|ㅋ|ㅋㅋ|ｗ|ww)+$/u.test(
      normalized.replace(/\s+/gu, "")
    )
  ) {
    return true;
  }
  if (
    /^(?:mm+|mhm+|mhmm+|uh+|uh huh|uhhuh|uh-huh|yeah+|yep+|ya+|ok(?:ay)?|right+|true+|damn+|bro+|woah+|wow+)(?:\s+(?:mm+|mhm+|yeah+|ok(?:ay)?|right+|true+|damn+|bro+|woah+|wow+))*$/u.test(
      normalized
    )
  ) {
    return true;
  }
  return countTokens(normalized) <= 2 && normalized.length <= 12;
}

function isObviousReplacementText(text: string) {
  const normalized = normalizeCompact(text, 220);
  if (!normalized) return false;
  if (isCancelIntent(normalized)) return true;
  if (
    /\b(?:wait|hold on|hang on|actually|scratch that|never mind|nevermind|instead|i meant|make that|change it to)\b/u.test(
      normalized
    )
  ) {
    return true;
  }
  if (/[?]/u.test(text)) return true;
  if (
    /^(?:can|could|would|will|do|did|does|what|when|where|why|how|which|who|is|are|am|should|please|tell me|give me|look up|search|play|pause|resume|stop|skip|queue)\b/u.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

function buildPrePlaybackReplyClassifierPrompt({
  settings,
  pendingTranscript,
  pendingSource,
  incomingTranscript
}: {
  settings: PrePlaybackReplyClassifierSettings;
  pendingTranscript: string;
  pendingSource: string;
  incomingTranscript: string;
}) {
  const botName = getPromptBotName(settings);
  const systemPrompt = [
    `You are deciding whether new user speech should replace a pending spoken reply from ${botName} before ${botName} has started speaking.`,
    "Return exactly one token: REPLACE or IGNORE.",
    "Use REPLACE only when the new speech clearly changes the job: a new question, a corrected request, a redirect, or an explicit stop/cancel.",
    "Use IGNORE for side commentary, backchannel, narrating the delay, social chatter, or speech that does not change the answer the user is still waiting for."
  ].join("\n");
  const userPrompt = [
    `Pending reply source: "${pendingSource || "unknown"}"`,
    `Pending user request: "${pendingTranscript || "[unknown]"}"`,
    "",
    `New finalized user speech: "${incomingTranscript || "[unknown]"}"`,
    "",
    "Should the new speech replace the pending reply?"
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

function parseClassifierDecision(text: string): PrePlaybackReplyClassifierDecision | null {
  const normalized = normalizeInlineText(text, 80).toUpperCase();
  if (!normalized) return null;
  if (normalized.includes("REPLACE")) return "replace";
  if (normalized.includes("IGNORE")) return "ignore";
  return null;
}

export async function classifyPrePlaybackReplyReplacement(
  host: PrePlaybackReplyClassifierHost,
  {
    session,
    settings,
    userId = null,
    pendingTranscript,
    pendingSource,
    incomingTranscript
  }: {
    session: Pick<VoiceSession, "id" | "guildId" | "textChannelId">;
    settings: PrePlaybackReplyClassifierSettings;
    userId?: string | null;
    pendingTranscript: string;
    pendingSource?: string | null;
    incomingTranscript: string;
  }
): Promise<PrePlaybackReplyClassifierResult> {
  const normalizedPendingTranscript = normalizeClassifierText(pendingTranscript, STT_REPLY_MAX_CHARS);
  const normalizedIncomingTranscript = normalizeClassifierText(incomingTranscript, STT_REPLY_MAX_CHARS);
  const normalizedPendingSource = String(pendingSource || "").trim() || "unknown";

  if (!normalizedIncomingTranscript) {
    return {
      decision: "ignore",
      source: "empty_transcript",
      latencyMs: 0,
      promptLog: null
    };
  }
  if (isLikelyLowSignalBackchannel(normalizedIncomingTranscript)) {
    return {
      decision: "ignore",
      source: "low_signal_heuristic",
      latencyMs: 0,
      promptLog: null
    };
  }
  if (isObviousReplacementText(normalizedIncomingTranscript)) {
    return {
      decision: "replace",
      source: "replace_heuristic",
      latencyMs: 0,
      promptLog: null
    };
  }

  const binding = getResolvedVoiceInterruptClassifierBinding(settings);
  const llmProvider = normalizeVoiceReplyDecisionProvider(binding?.provider || "openai");
  const llmModel =
    String(binding?.model || defaultVoiceReplyDecisionModel(llmProvider)).trim() ||
    defaultVoiceReplyDecisionModel(llmProvider);
  const maxOutputTokens = resolveVoiceReplyDecisionMaxOutputTokens(llmProvider, llmModel);
  const { systemPrompt, userPrompt, promptLog } = buildPrePlaybackReplyClassifierPrompt({
    settings,
    pendingTranscript: normalizedPendingTranscript || "[unknown]",
    pendingSource: normalizedPendingSource,
    incomingTranscript: normalizedIncomingTranscript
  });

  if (!host.llm?.generate) {
    return {
      decision: "ignore",
      source: "llm_unavailable_fallback",
      latencyMs: 0,
      promptLog,
      error: "llm_generate_unavailable"
    };
  }

  const startedAt = Date.now();
  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const timeout =
    abortController
      ? setTimeout(() => {
        abortController.abort(new Error("voice_preplay_reply_classifier_timeout"));
      }, VOICE_INTERRUPT_CLASSIFIER_TIMEOUT_MS)
      : null;
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
        userId,
        source: "voice_preplay_reply_classifier"
      },
      signal: abortController?.signal
    });
    const rawOutput = String(result?.text || "");
    const decision = parseClassifierDecision(rawOutput);
    if (decision) {
      return {
        decision,
        source: decision === "replace" ? "model_replace" : "model_ignore",
        latencyMs: Date.now() - startedAt,
        promptLog,
        rawOutput
      };
    }
    return {
      decision: "ignore",
      source: "unparseable_fallback",
      latencyMs: Date.now() - startedAt,
      promptLog,
      rawOutput,
      error: `unparseable_preplay_reply_classifier_output:${rawOutput.slice(0, 60)}`
    };
  } catch (error) {
    const message = String((error as Error | null)?.message || error || "unknown_error");
    const timedOut =
      Boolean(abortController?.signal.aborted) &&
      message.includes("voice_preplay_reply_classifier_timeout");
    host.store?.logAction?.({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: timedOut
        ? "voice_preplay_reply_classifier_timed_out"
        : `voice_preplay_reply_classifier_failed: ${message}`,
      metadata: {
        sessionId: session.id,
        timeoutMs: timedOut ? VOICE_INTERRUPT_CLASSIFIER_TIMEOUT_MS : undefined
      }
    });
    return {
      decision: "ignore",
      source: timedOut ? "timeout_fallback" : "runtime_error_fallback",
      latencyMs: Date.now() - startedAt,
      promptLog,
      error: message
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
