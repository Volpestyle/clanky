import { buildVoiceSystemPrompt, buildVoiceTurnPrompt } from "../prompts/index.ts";
import {
  buildHardLimitsSection,
  DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptVoiceOperationalGuidance,
  getPromptStyle
} from "../prompts/promptCore.ts";
import {
  normalizeSkipSentinel,
  serializeForPrompt
} from "./botHelpers.ts";
import {
  buildReplyToolSet,
  executeReplyTool
} from "../tools/replyTools.ts";
import type { ReplyToolRuntime, ReplyToolContext } from "../tools/replyTools.ts";
import { createAbortError, isAbortError, throwIfAborted } from "../tools/browserTaskRuntime.ts";
import { shouldRequestVoiceToolFollowup } from "../tools/sharedToolSchemas.ts";
import { clamp, sanitizeBotText } from "../utils.ts";
import { loadConversationContinuityContext } from "./conversationContinuity.ts";
import { emptyFactProfileSlice, loadBehavioralMemoryFacts, normalizeFactProfileSlice } from "./memorySlice.ts";
import {
  getActivitySettings,
  applyOrchestratorOverrideSettings,
  getMemorySettings,
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding,
  getVoiceConversationPolicy,
  getVoiceSoundboardSettings
} from "../settings/agentStack.ts";
import {
  buildContextContentBlocks,
  type ContentBlock,
  type ContextMessage
} from "../llm/serviceShared.ts";
import type { VoiceReplyRuntime } from "./botContext.ts";
import { SentenceAccumulator } from "../voice/sentenceAccumulator.ts";
import {
  normalizeVoiceRuntimeEventContext,
  normalizeVoiceAddressingTargetToken,
  parseSoundboardDirectiveSequence
} from "../voice/voiceSessionHelpers.ts";
import {
  invalidateSessionBehavioralMemoryCache,
  loadSessionBehavioralMemoryFacts,
  loadSessionConversationHistory
} from "../voice/voiceSessionMemoryCache.ts";
import { mergeImageInputs } from "./imageAnalysis.ts";
import { MAX_MODEL_IMAGE_INPUTS } from "./replyPipelineShared.ts";
import {
  appendPromptFollowup,
  buildLoggedPromptBundle,
  createPromptCapture
} from "../promptLogging.ts";
import {
  VOICE_GENERATION_BEHAVIORAL_TIMEOUT_MS,
  VOICE_GENERATION_CONTINUITY_TIMEOUT_MS
} from "../voice/voiceSessionManager.constants.ts";

const SESSION_DURABLE_CONTEXT_MAX_ENTRIES = 50;
const SELF_SUBJECT = "__self__";
const LORE_SUBJECT = "__lore__";
const LEADING_REPLY_ADDRESSING_DIRECTIVE_RE =
  /^\s*\[\[\s*TO\s*:\s*([^\]]+?)\s*\]\]\s*/i;
const MAX_LEADING_REPLY_ADDRESSING_BUFFER_CHARS = 160;

type SessionDurableContextCategory = "fact" | "plan" | "preference" | "relationship";
type GeneratedVoiceAddressing = {
  talkingTo: string | null;
};

type VoiceGenerationPrepStageOptions<T> = {
  runtime: VoiceReplyRuntime;
  guildId: string;
  channelId: string;
  userId: string;
  sessionId?: string | null;
  stage: string;
  timeoutMs: number;
  signal?: AbortSignal;
  task: Promise<T>;
  fallbackValue: T;
};

function createVoiceGenerationPrepTimeoutError(stage: string, timeoutMs: number) {
  const error = new Error(`${stage} timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
}

function isVoiceGenerationPrepTimeoutError(error: unknown) {
  return String((error as Error | null)?.name || "").trim() === "TimeoutError";
}

async function awaitVoiceGenerationPrepStage<T>({
  runtime,
  guildId,
  channelId,
  userId,
  sessionId = null,
  stage,
  timeoutMs,
  signal,
  task,
  fallbackValue
}: VoiceGenerationPrepStageOptions<T>): Promise<T> {
  const normalizedStage = String(stage || "").trim() || "unknown";
  runtime.store.logAction({
    kind: "voice_runtime",
    guildId,
    channelId,
    userId,
    content: "voice_generation_prep_stage",
    metadata: {
      sessionId: sessionId || null,
      stage: normalizedStage,
      state: "start",
      timeoutMs
    }
  });
  const startedAt = Date.now();
  try {
    throwIfAborted(signal, `Voice generation ${normalizedStage} cancelled`);
    const result = await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler();
      };
      const onAbort = () => {
        finish(() => reject(createAbortError(signal?.reason || `Voice generation ${normalizedStage} cancelled`)));
      };
      const timer = setTimeout(() => {
        finish(() => reject(createVoiceGenerationPrepTimeoutError(normalizedStage, timeoutMs)));
      }, Math.max(1, Math.round(Number(timeoutMs) || 1)));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void task.then((value) => finish(() => resolve(value))).catch((error: unknown) => finish(() => reject(error)));
    });
    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId,
      content: "voice_generation_prep_stage",
      metadata: {
        sessionId: sessionId || null,
        stage: normalizedStage,
        state: "ok",
        elapsedMs: Math.max(0, Date.now() - startedAt)
      }
    });
    return result;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }
    runtime.store.logAction({
      kind: isVoiceGenerationPrepTimeoutError(error) ? "voice_runtime" : "voice_error",
      guildId,
      channelId,
      userId,
      content: isVoiceGenerationPrepTimeoutError(error)
        ? "voice_generation_prep_stage"
        : `voice_generation_${normalizedStage}_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: sessionId || null,
        stage: normalizedStage,
        state: isVoiceGenerationPrepTimeoutError(error) ? "timeout" : "error",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        timeoutMs,
        fallbackUsed: true,
        error: String((error as Error)?.message || error)
      }
    });
    return fallbackValue;
  }
}

function appendUniqueStrings(target: string[], values: unknown[]) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || target.includes(normalized)) continue;
    target.push(normalized);
  }
}

function mergeSpokenReplyText(parts: string[]) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function hasInlineSoundboardDirective(text: string) {
  return /\[\[\s*SOUNDBOARD:/i.test(text);
}

function stripInlineSoundboardDirectives(text: unknown, maxLen = 520) {
  const normalized = sanitizeBotText(normalizeSkipSentinel(String(text || "")), maxLen);
  if (!normalized || normalized === "[SKIP]") return normalized;
  if (!hasInlineSoundboardDirective(normalized)) return normalized;
  return sanitizeBotText(parseSoundboardDirectiveSequence(normalized).text, maxLen);
}

function normalizeVoiceReplyText(
  text: unknown,
  {
    maxLen = 520,
    preserveInlineSoundboardDirectives = false
  }: {
    maxLen?: number;
    preserveInlineSoundboardDirectives?: boolean;
  } = {}
) {
  const normalized = sanitizeBotText(normalizeSkipSentinel(String(text || "")), maxLen);
  if (!normalized || normalized === "[SKIP]") return normalized;
  if (preserveInlineSoundboardDirectives) return normalized;
  if (!hasInlineSoundboardDirective(normalized)) return normalized;
  return sanitizeBotText(parseSoundboardDirectiveSequence(normalized).text, maxLen);
}

function hasGeneratedVoiceAddressing(addressing: GeneratedVoiceAddressing | null) {
  if (!addressing || typeof addressing !== "object") return false;
  return Boolean(addressing.talkingTo);
}

function parseLeadingReplyAddressingDirective(
  text: unknown,
  {
    currentSpeakerName = ""
  }: {
    currentSpeakerName?: string;
  } = {}
) {
  const source = String(text || "");
  const match = source.match(LEADING_REPLY_ADDRESSING_DIRECTIVE_RE);
  if (!match) {
    return {
      text: source,
      voiceAddressing: null,
      matched: false
    };
  }

  return {
    text: source.slice(match[0].length),
    voiceAddressing: normalizeGeneratedVoiceAddressing(
      {
        talkingTo: match[1] || ""
      },
      { currentSpeakerName }
    ),
    matched: true
  };
}

function consumeLeadingReplyAddressingDirectiveChunk(
  state: {
    resolved: boolean;
    buffer: string;
  },
  delta: unknown,
  {
    currentSpeakerName = ""
  }: {
    currentSpeakerName?: string;
  } = {}
) {
  if (state.resolved) {
    return {
      nextState: state,
      textDelta: String(delta || ""),
      voiceAddressing: null
    };
  }

  const nextBuffer = `${state.buffer}${String(delta || "")}`;
  const trimmedLeading = nextBuffer.replace(/^\s+/, "");
  if (!trimmedLeading) {
    return {
      nextState: {
        resolved: false,
        buffer: nextBuffer
      },
      textDelta: "",
      voiceAddressing: null
    };
  }

  if (!trimmedLeading.startsWith("[[")) {
    return {
      nextState: {
        resolved: true,
        buffer: ""
      },
      textDelta: nextBuffer,
      voiceAddressing: null
    };
  }

  const hasClosingFence = trimmedLeading.includes("]]");
  if (!hasClosingFence && nextBuffer.length < MAX_LEADING_REPLY_ADDRESSING_BUFFER_CHARS) {
    return {
      nextState: {
        resolved: false,
        buffer: nextBuffer
      },
      textDelta: "",
      voiceAddressing: null
    };
  }

  const parsed = parseLeadingReplyAddressingDirective(nextBuffer, {
    currentSpeakerName
  });
  return {
    nextState: {
      resolved: true,
      buffer: ""
    },
    textDelta: parsed.matched ? parsed.text : nextBuffer,
    voiceAddressing: parsed.voiceAddressing
  };
}

function normalizeSpokenSentenceDispatchResult(result: unknown) {
  if (!result || result === true) {
    return {
      accepted: result !== false,
      playedSoundboardRefs: [] as string[],
      requestedRealtimeUtterance: false
    };
  }
  if (result === false) {
    return {
      accepted: false,
      playedSoundboardRefs: [] as string[],
      requestedRealtimeUtterance: false
    };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    return {
      accepted: true,
      playedSoundboardRefs: [] as string[],
      requestedRealtimeUtterance: false
    };
  }
  const normalizedResult = result as Record<string, unknown>;
  const playedSoundboardRefs = Array.isArray(normalizedResult.playedSoundboardRefs)
    ? normalizedResult.playedSoundboardRefs
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, 10)
    : [];
  return {
    accepted: normalizedResult.accepted !== false,
    playedSoundboardRefs,
    requestedRealtimeUtterance: Boolean(normalizedResult.requestedRealtimeUtterance)
  };
}

function ensureAssistantContentIncludesResolvedText(content: ContentBlock[], fallbackText: unknown): ContentBlock[] {
  const normalizedFallback = String(fallbackText || "").trim();
  if (!normalizedFallback) return content;

  const hasTextBlock = content.some((block) => {
    if (!block || typeof block !== "object" || block.type !== "text") return false;
    return String(block.text || "").trim().length > 0;
  });
  if (hasTextBlock) return content;

  return [
    { type: "text" as const, text: normalizedFallback },
    ...content
  ];
}

function normalizeSessionDurableContextCategory(value: unknown): SessionDurableContextCategory {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "plan") return "plan";
  if (normalized === "preference") return "preference";
  if (normalized === "relationship") return "relationship";
  return "fact";
}

function appendSessionDurableContextEntry({
  session,
  text,
  category,
  at
}: {
  session: Record<string, unknown> | null;
  text: unknown;
  category: unknown;
  at: unknown;
}) {
  if (!session || typeof session !== "object") return null;

  const normalizedText = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (!normalizedText) return null;

  const normalizedCategory = normalizeSessionDurableContextCategory(category);
  const normalizedAt = Number.isFinite(Number(at)) ? Math.max(0, Math.round(Number(at))) : Date.now();
  const current = Array.isArray(session.durableContext) ? session.durableContext : [];
  const matchKey = normalizedText.toLowerCase();
  const duplicate = current.some((entry) => String(entry?.text || "").trim().toLowerCase() === matchKey);
  const nextEntries = [
    ...current.filter((entry) => String(entry?.text || "").trim().toLowerCase() !== matchKey),
    {
      text: normalizedText,
      category: normalizedCategory,
      at: normalizedAt
    }
  ].slice(-SESSION_DURABLE_CONTEXT_MAX_ENTRIES);

  session.durableContext = nextEntries;
  return {
    entry: nextEntries[nextEntries.length - 1] || null,
    duplicate,
    total: nextEntries.length
  };
}

export async function composeVoiceOperationalMessage(runtime: VoiceReplyRuntime, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  event = "voice_runtime",
  reason = null,
  details = {},
  maxOutputChars = 180,
  allowSkip = false
}) {
  if (!runtime.llm?.generate || !settings) {
    runtime.store?.logAction?.({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || null,
      messageId: messageId || null,
      userId: userId || null,
      content: "voice_operational_llm_unavailable",
      metadata: {
        event,
        reason
      }
    });
    return "";
  }
  const detailsPayload: Record<string, unknown> = {};
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) {
      detailsPayload[String(key)] = value;
    }
  } else {
    detailsPayload.detail = String(details || "");
  }
  const normalizedEvent = String(event || "voice_runtime")
    .trim()
    .toLowerCase();
  const isVoiceSessionEnd = normalizedEvent === "voice_session_end";
  const isVoiceStatusRequest = normalizedEvent === "voice_status_request";
  const isScreenShareOffer = normalizedEvent === "voice_screen_share_offer";
  const operationalTemperature = isVoiceSessionEnd ? 0.35 : 0.55;
  const operationalMaxOutputTokens = isVoiceSessionEnd ? 60 : isScreenShareOffer ? 140 : 100;
  const outputCharLimit = clamp(Number(maxOutputChars) || 180, 80, 700);
  const statusRequesterText = isVoiceStatusRequest
    ? String(detailsPayload?.requestText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220)
    : "";

  const operationalBinding = getResolvedOrchestratorBinding(settings);
  const operationalReplyGeneration = getReplyGenerationSettings(settings);
  const tunedSettings = applyOrchestratorOverrideSettings(settings, {
    provider: operationalBinding.provider,
    model: operationalBinding.model,
    temperature: clamp(Number(operationalReplyGeneration.temperature) || operationalTemperature, 0, 0.7),
    maxOutputTokens: clamp(Number(operationalReplyGeneration.maxOutputTokens) || operationalMaxOutputTokens, 32, 110),
    reasoningEffort: operationalBinding.reasoningEffort
  });
  const operationalMemoryFacts = await runtime.loadRelevantMemoryFacts({
    settings,
    guildId,
    channelId,
    queryText: `${String(event || "")} ${String(reason || "")}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280),
    trace: {
      guildId,
      channelId,
      userId,
      source: "voice_operational_message"
    },
    limit: 6
  });
  const operationalMemoryHints = runtime.buildMediaMemoryFacts({
    userFacts: [],
    relevantFacts: operationalMemoryFacts,
    maxItems: 6
  });
  const operationalGuidance = getPromptVoiceOperationalGuidance(
    settings,
    DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE
  );

  const systemPrompt = [
    `You are ${getPromptBotName(settings)}, a Discord regular posting a voice-mode update.`,
    `Style: ${getPromptStyle(settings)}.`,
    allowSkip
      ? "Write one short user-facing message for the text channel only if it's actually helpful."
      : "Write exactly one short user-facing message for the text channel.",
    "Stay in character as a regular server member with your usual voice, not a dashboard logger.",
    ...operationalGuidance,
    "For voice_session_end, keep it to one brief sentence (4-12 words).",
    isVoiceStatusRequest
      ? "For voice_status_request, answer the user's actual ask first in character using Details JSON."
      : "",
    isVoiceStatusRequest
      ? "Default to a direct presence check answer for check-in questions; include extra metrics only when asked."
      : "",
    isVoiceStatusRequest
      ? "Do not dump every status field by default."
      : "",
    isScreenShareOffer
      ? "If Details JSON includes linkUrl, include that exact URL unchanged in the final message."
      : "",
    getPromptCapabilityHonestyLine(settings),
    ...buildHardLimitsSection(settings, { maxItems: 12 }),
    allowSkip
      ? "If posting a message would be redundant, output exactly [SKIP]."
      : "Do not output [SKIP].",
    "Do not output JSON, markdown headings, code blocks, labels, or directives.",
    "Do not invent details that are not in the event payload."
  ].join("\n");

  const userPrompt = [
    `Event: ${String(event || "voice_runtime")}`,
    `Reason: ${String(reason || "unknown")}`,
    `Details JSON: ${serializeForPrompt(detailsPayload, 1400)}`,
    statusRequesterText ? `Requester text: ${statusRequesterText}` : "",
    isVoiceStatusRequest
      ? "Status field meanings: elapsedSeconds=time already in VC; inactivitySeconds=time until inactivity auto-leave; remainingSeconds=time until max session time cap; activeCaptures=current live inbound captures."
      : "",
    isVoiceStatusRequest
      ? "Answer the requester text directly. If they asked a yes/no presence question, lead with that answer and keep timers secondary."
      : "",
    operationalMemoryHints.length
      ? `Relevant durable memory (use only if directly useful): ${operationalMemoryHints.join(" | ")}`
      : "",
    isVoiceSessionEnd
      ? "Constraint: one chill sentence, 4-12 words."
      : isScreenShareOffer
        ? "Constraint: low-key tone, 1-2 short sentences."
        : "Constraint: one brief sentence.",
    allowSkip ? "If no useful update is needed, return exactly [SKIP]." : "",
    "Return only the final message text."
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const generation = await runtime.llm.generate({
      settings: tunedSettings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId,
        channelId,
        messageId,
        userId,
        source: "voice_operational_message",
        event,
        reason
      }
    });

    const normalized = sanitizeBotText(
      normalizeSkipSentinel(generation.text || ""),
      outputCharLimit
    );
    if (!normalized) return "";
    if (normalized === "[SKIP]") return allowSkip ? "[SKIP]" : "";
    return normalized;
  } catch (error) {
    runtime.store?.logAction?.({
      kind: "voice_error",
      guildId: guildId || null,
      channelId: channelId || null,
      messageId: messageId || null,
      userId: userId || null,
      content: `voice_operational_llm_failed: ${String(error?.message || error)}`,
      metadata: {
        event,
        reason
      }
    });
    return "";
  }
}

export async function generateVoiceTurnReply(runtime: VoiceReplyRuntime, {
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  transcript = "",
  inputKind = "transcript",
  directAddressed = false,
  contextMessages = [],
  sessionId = null,
  isEagerTurn = false,
  sessionTiming = null,
  voiceAmbientReplyEagerness = 0,
  conversationContext = null,
  participantRoster = [],
  recentMembershipEvents = [],
  recentVoiceEffectEvents = [],
  soundboardCandidates = [],
  streamWatchLatestFrame = null,
  streamWatchDurableScreenNotes = [],
  webSearchTimeoutMs: _webSearchTimeoutMs = null,
  voiceToolCallbacks = null,
  onSpokenSentence = null,
  runtimeEventContext = null,
  signal = undefined
}) {
  if (!runtime.llm?.generate || !settings) return { text: "" };
  const normalizedInputKind = String(inputKind || "").trim().toLowerCase() === "event"
    ? "event"
    : "transcript";
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
  const incomingTranscript = String(transcript || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  if (!incomingTranscript) return { text: "" };

  const normalizedContextMessages: ContextMessage[] = (Array.isArray(contextMessages) ? contextMessages : [])
    .map((row) => ({
      role: row?.role === "assistant" ? "assistant" : "user",
      content: String(row?.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 520)
    }))
    .filter((row) => row.content)
    .slice(-10);
  const normalizedSoundboardCandidates = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const activityReactivity = Number(getActivitySettings(settings).reactivity) || 0;
  const soundboardEagerness = Number(getVoiceSoundboardSettings(settings).eagerness) || 0;
  const allowSoundboardToolCall = Boolean(
    getVoiceSoundboardSettings(settings).enabled && normalizedSoundboardCandidates.length
  );
  const allowMemoryToolCalls = Boolean(getMemorySettings(settings).enabled);
  const allowWebSearchToolCall = Boolean(
    typeof runtime.search?.searchAndRead === "function"
  );
  const allowBrowserBrowseToolCall = Boolean(
    typeof runtime.runModelRequestedBrowserBrowse === "function" &&
    typeof runtime.buildBrowserBrowseContext === "function"
  );
  const screenShare = resolveVoiceScreenWatchCapability(runtime, {
    settings,
    guildId,
    channelId,
    userId
  });
  const allowScreenShareToolCall = Boolean(
    screenShare.available &&
    typeof runtime.startVoiceScreenWatch === "function" &&
    guildId &&
    userId &&
    (screenShare.nativeAvailable || channelId)
  );
  const activeVoiceSession =
    sessionId && typeof runtime.voiceSessionManager?.getSessionById === "function"
      ? runtime.voiceSessionManager.getSessionById(sessionId)
      : null;
  const realtimeToolOwnership = activeVoiceSession?.realtimeToolOwnership === "provider_native"
    ? "provider_native"
    : "transport_only";
  const runtimeMode = String(activeVoiceSession?.mode || "").trim() || null;
  const musicContext =
    activeVoiceSession && typeof runtime.voiceSessionManager?.getMusicPromptContext === "function"
      ? runtime.voiceSessionManager.getMusicPromptContext(activeVoiceSession)
      : null;
  const guild = runtime.client.guilds.cache.get(String(guildId || ""));
  const speakerName =
    guild?.members?.cache?.get(String(userId || ""))?.displayName ||
    guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
    runtime.client.users?.cache?.get(String(userId || ""))?.username ||
    "unknown";
  const normalizedParticipantRoster = (Array.isArray(participantRoster) ? participantRoster : [])
    .map((entry) => {
      if (typeof entry === "string") {
        return String(entry).trim();
      }
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, 12);
  const normalizedMembershipEvents = (Array.isArray(recentMembershipEvents) ? recentMembershipEvents : [])
    .map((entry) => {
      const eventType = String(entry?.eventType || entry?.event || "")
        .trim()
        .toLowerCase();
      if (eventType !== "join" && eventType !== "leave") return null;
      const displayName = String(entry?.displayName || entry?.name || "").trim().slice(0, 80);
      if (!displayName) return null;
      const ageMsRaw = Number(entry?.ageMs);
      const ageMs = Number.isFinite(ageMsRaw) ? Math.max(0, Math.round(ageMsRaw)) : null;
      return {
        eventType,
        displayName,
        ageMs
      };
    })
    .filter(Boolean)
    .slice(-6);
  const normalizedVoiceEffectEvents = (Array.isArray(recentVoiceEffectEvents) ? recentVoiceEffectEvents : [])
    .map((entry) => {
      const displayName = String(entry?.displayName || "").trim().slice(0, 80);
      const effectType = String(entry?.effectType || "").trim().toLowerCase();
      const soundName = String(entry?.soundName || "").trim().slice(0, 80) || null;
      const emoji = String(entry?.emoji || "").trim().slice(0, 80) || null;
      const ageMsRaw = Number(entry?.ageMs);
      const ageMs = Number.isFinite(ageMsRaw) ? Math.max(0, Math.round(ageMsRaw)) : null;
      if (!displayName) return null;
      if (effectType !== "soundboard" && effectType !== "emoji" && effectType !== "unknown") {
        return null;
      }
      return {
        displayName,
        effectType,
        soundName,
        emoji,
        ageMs
      };
    })
    .filter(Boolean)
    .slice(-6);
  const loadRecentConversationHistory =
    typeof runtime.loadRecentConversationHistory === "function"
      ? (payload: {
        guildId: string;
        channelId?: string | null;
        queryText: string;
        limit: number;
        maxAgeHours: number;
      }) =>
        activeVoiceSession
          ? loadSessionConversationHistory({
            session: activeVoiceSession,
            loadRecentConversationHistory: runtime.loadRecentConversationHistory,
            strategy: "semantic",
            guildId: String(payload.guildId || "").trim(),
            channelId: String(payload.channelId || "").trim() || null,
            queryText: String(payload.queryText || ""),
            limit: Number(payload.limit) || 1,
            maxAgeHours: Number(payload.maxAgeHours) || 1
          })
          : runtime.loadRecentConversationHistory(payload)
      : null;

  const continuityStartedAt = Date.now();
  const continuity = await awaitVoiceGenerationPrepStage({
    runtime,
    guildId,
    channelId,
    userId,
    sessionId,
    stage: "continuity",
    timeoutMs: VOICE_GENERATION_CONTINUITY_TIMEOUT_MS,
    signal,
    task: loadConversationContinuityContext({
      settings,
      userId,
      guildId,
      channelId,
      queryText: incomingTranscript,
      trace: {
        guildId,
        channelId,
        userId
      },
      source: "voice_realtime_generation",
      loadFactProfile:
        (payload) => {
          if (activeVoiceSession && typeof runtime.voiceSessionManager?.getSessionFactProfileSlice === "function") {
            if (activeVoiceSession) {
              return runtime.voiceSessionManager.getSessionFactProfileSlice({
                session: activeVoiceSession,
                userId: String(payload.userId || "").trim() || null
              });
            }
          }
          if (typeof runtime.loadFactProfile === "function") {
            return runtime.loadFactProfile(payload);
          }
          return { userFacts: [], relevantFacts: [] };
        },
      loadRecentConversationHistory,
    }),
    fallbackValue: {
      memorySlice: emptyFactProfileSlice(),
      recentConversationHistory: []
    }
  });
  const continuityLoadMs = Math.max(0, Date.now() - continuityStartedAt);
  throwIfAborted(signal, "Voice generation continuity cancelled");
  const promptMemorySlice = normalizeFactProfileSlice(continuity.memorySlice);
  const recentConversationHistory = continuity.recentConversationHistory;
  const participantIds =
    Array.isArray(promptMemorySlice.participantProfiles)
      ? promptMemorySlice.participantProfiles
          .map((entry) => String(entry?.userId || "").trim())
          .filter(Boolean)
      : [];
  const behavioralStartedAt = Date.now();
  const behavioralMemoryResult = await awaitVoiceGenerationPrepStage({
    runtime,
    guildId,
    channelId,
    userId,
    sessionId,
    stage: "behavioral_memory",
    timeoutMs: VOICE_GENERATION_BEHAVIORAL_TIMEOUT_MS,
    signal,
    task: (async () => {
      const cachedBehavioralFacts =
        activeVoiceSession
          ? await loadSessionBehavioralMemoryFacts({
            session: activeVoiceSession,
            searchDurableFacts:
              typeof runtime.memory?.searchDurableFacts === "function"
                ? (payload) => runtime.memory.searchDurableFacts(payload)
                : null,
            rankBehavioralFacts:
              typeof runtime.memory?.rankHybridCandidates === "function"
                ? async ({ candidates, queryText, channelId, settings, trace, limit }) => {
                  const ranked = await runtime.memory.rankHybridCandidates({
                    candidates,
                    queryText,
                    settings,
                    trace,
                    channelId,
                    requireRelevanceGate: true
                  });
                  const boundedLimit = Math.max(1, Math.min(12, Math.floor(Number(limit) || 8)));
                  return Array.isArray(ranked) ? ranked.slice(0, boundedLimit) : [];
                }
                : null,
            settings,
            guildId,
            channelId,
            queryText: incomingTranscript,
            participantIds,
            trace: {
              guildId,
              channelId,
              userId,
              source: "voice_realtime_behavioral_memory:generation"
            },
            limit: 8
          })
          : null;
      return {
        facts: cachedBehavioralFacts ?? await loadBehavioralMemoryFacts(runtime, {
          settings,
          guildId,
          channelId,
          queryText: incomingTranscript,
          participantIds,
          trace: {
            guildId,
            channelId,
            userId,
            source: "voice_realtime_behavioral_memory:generation"
          },
          limit: 8
        }),
        usedCachedBehavioralFacts: Array.isArray(cachedBehavioralFacts)
      };
    })(),
    fallbackValue: {
      facts: [],
      usedCachedBehavioralFacts: false
    }
  });
  const behavioralMemoryLoadMs = Math.max(0, Date.now() - behavioralStartedAt);
  throwIfAborted(signal, "Voice generation behavioral memory cancelled");
  const behavioralFacts = Array.isArray(behavioralMemoryResult.facts) ? behavioralMemoryResult.facts : [];
  const totalMemoryLoadMs = Math.max(0, Date.now() - continuityStartedAt);
  runtime.store.logAction({
    kind: "voice_runtime",
    guildId,
    channelId,
    userId,
    content: "voice_generation_memory_loaded",
    metadata: {
      sessionId: sessionId || null,
      memorySource: "voice_realtime_generation",
      transcriptChars: incomingTranscript.length,
      continuityLoadMs,
      behavioralMemoryLoadMs,
      totalLoadMs: totalMemoryLoadMs,
      usedCachedBehavioralFacts: Boolean(behavioralMemoryResult.usedCachedBehavioralFacts),
      participantProfileCount: Array.isArray(promptMemorySlice.participantProfiles)
        ? promptMemorySlice.participantProfiles.length
        : 0,
      userFactCount: Array.isArray(promptMemorySlice.userFacts) ? promptMemorySlice.userFacts.length : 0,
      relevantFactCount: Array.isArray(promptMemorySlice.relevantFacts)
        ? promptMemorySlice.relevantFacts.length
        : 0,
      guidanceFactCount: Array.isArray(promptMemorySlice.guidanceFacts)
        ? promptMemorySlice.guidanceFacts.length
        : 0,
      behavioralFactCount: Array.isArray(behavioralFacts) ? behavioralFacts.length : 0,
      recentConversationHistoryCount: Array.isArray(recentConversationHistory)
        ? recentConversationHistory.length
        : 0
    }
  });

  const voiceGenerationBinding = getResolvedVoiceGenerationBinding(settings);
  const replyGeneration = getReplyGenerationSettings(settings);
  const tunedSettings = applyOrchestratorOverrideSettings(settings, {
    provider: voiceGenerationBinding.provider,
    model: voiceGenerationBinding.model,
    temperature: Number(replyGeneration.temperature) || 1.0,
    maxOutputTokens: Number(replyGeneration.maxOutputTokens) || 2500
  });
  const tunedBinding = getResolvedOrchestratorBinding(tunedSettings);

  const webSearch = allowWebSearchToolCall && typeof runtime.buildWebSearchContext === "function"
    ? runtime.buildWebSearchContext(settings, incomingTranscript)
    : {
      requested: false,
      configured: false,
      enabled: false,
      used: false,
      blockedByBudget: false,
      optedOutByUser: false,
      error: null,
      query: "",
      results: [],
      fetchedPages: 0,
      providerUsed: null,
      providerFallbackUsed: false,
      budget: {
        maxPerHour: 0,
        used: 0,
        successCount: 0,
        errorCount: 0,
        remaining: 0,
        canSearch: false
      }
    };
  const webSearchAvailableNow = Boolean(
    webSearch?.enabled &&
    webSearch?.configured &&
    !webSearch?.optedOutByUser &&
    !webSearch?.blockedByBudget &&
    webSearch?.budget?.canSearch !== false
  );
  const browserBrowse = allowBrowserBrowseToolCall
    ? runtime.buildBrowserBrowseContext(settings)
    : {
      requested: false,
      configured: false,
      enabled: false,
      used: false,
      blockedByBudget: false,
      error: null,
      query: "",
      text: "",
      steps: 0,
      hitStepLimit: false,
      budget: {
        maxPerHour: 0,
        used: 0,
        remaining: 0,
        canBrowse: false
      }
    };
  const browserBrowseAvailableNow = Boolean(
    browserBrowse?.enabled &&
    browserBrowse?.configured &&
    !browserBrowse?.blockedByBudget &&
    browserBrowse?.budget?.canBrowse !== false
  );
  const voiceConversationPolicy = getVoiceConversationPolicy(settings);
  const streamingEnabled = Boolean(
    voiceConversationPolicy.streaming?.enabled &&
    typeof onSpokenSentence === "function" &&
    typeof runtime.llm?.generateStreaming === "function"
  );
  let usedWebSearchFollowup = false;
  let usedScreenShareOffer = false;
  let leaveVoiceChannelRequested = false;

  const systemPrompt = buildVoiceSystemPrompt(settings);
  const buildVoiceUserPrompt = ({
    webSearchContext = webSearch,
    allowWebSearch = allowWebSearchToolCall,
    allowVoiceTools = Boolean(voiceToolCallbacks)
  } = {}) =>
    buildVoiceTurnPrompt({
      inputKind: normalizedInputKind,
      speakerName,
      transcript: incomingTranscript,
      directAddressed,
      participantProfiles: promptMemorySlice.participantProfiles,
      selfFacts: promptMemorySlice.selfFacts,
      loreFacts: promptMemorySlice.loreFacts,
      userFacts: promptMemorySlice.userFacts,
      relevantFacts: promptMemorySlice.relevantFacts,
      guidanceFacts: promptMemorySlice.guidanceFacts,
      behavioralFacts,
      isEagerTurn,
      voiceAmbientReplyEagerness,
      responseWindowEagerness: Number(getActivitySettings(settings).responseWindowEagerness) || 0,
      conversationContext,
      runtimeEventContext: normalizedRuntimeEventContext,
      sessionTiming,
      botName: getPromptBotName(settings),
      participantRoster: normalizedParticipantRoster,
      recentMembershipEvents: normalizedMembershipEvents,
      recentVoiceEffectEvents: normalizedVoiceEffectEvents,
      soundboardCandidates: normalizedSoundboardCandidates,
      soundboardEagerness,
      webSearch: webSearchContext,
      browserBrowse,
      recentConversationHistory,
      allowWebSearchToolCall: allowWebSearch,
      allowBrowserBrowseToolCall,
      screenShare,
      allowScreenShareToolCall,
      allowMemoryToolCalls,
      allowSoundboardToolCall,
      allowInlineSoundboardDirectives: allowSoundboardToolCall,
      allowVoiceToolCalls: allowVoiceTools,
      musicContext,
      hasDirectVisionFrame: Boolean(streamWatchLatestFrame?.dataBase64),
      durableScreenNotes: streamWatchDurableScreenNotes,
      durableContext: Array.isArray(activeVoiceSession?.durableContext) ? activeVoiceSession.durableContext : []
    });

  const generationContextSnapshot = {
    capturedAt: new Date().toISOString(),
    incomingTranscript,
    speakerName,
    directAddressed: Boolean(directAddressed),
    isEagerTurn: Boolean(isEagerTurn),
    contextMessages: normalizedContextMessages,
    conversationContext: conversationContext || null,
    runtimeEventContext: normalizedRuntimeEventContext,
    participantRoster: normalizedParticipantRoster,
    membershipEvents: normalizedMembershipEvents,
    effectEvents: normalizedVoiceEffectEvents,
    memoryFacts: {
      guidanceFacts: promptMemorySlice.guidanceFacts,
      behavioralFacts,
      userFacts: promptMemorySlice.userFacts,
      relevantFacts: promptMemorySlice.relevantFacts
    },
    recentConversationHistory,
    durableContext: Array.isArray(activeVoiceSession?.durableContext) ? activeVoiceSession.durableContext : [],
    sessionTiming: sessionTiming || null,
    tools: {
      soundboard: allowSoundboardToolCall,
      webSearch: allowWebSearchToolCall,
      browserBrowse: allowBrowserBrowseToolCall,
      screenShare: allowScreenShareToolCall,
      memory: allowMemoryToolCalls
    },
    soundboardCandidateCount: normalizedSoundboardCandidates.length,
    activityReactivity,
    soundboardEagerness,
    llmConfig: {
      provider: tunedBinding.provider,
      model: tunedBinding.model,
      temperature: tunedBinding.temperature,
      maxOutputTokens: tunedBinding.maxOutputTokens
    }
  };

  try {
    const voiceTrace = {
      guildId,
      channelId,
      userId,
      source: "voice_realtime_generation",
      event: sessionId ? "voice_session" : "voice_turn",
      reason: null,
      messageId: null
    };

    const codeAgentRuntimeAvailable = typeof runtime.runModelRequestedCodeTask === "function";
    const voiceReplyTools = buildReplyToolSet(settings as Record<string, unknown>, {
      webSearchAvailable: allowWebSearchToolCall && webSearchAvailableNow,
      webScrapeAvailable: allowWebSearchToolCall && webSearchAvailableNow,
      browserBrowseAvailable: allowBrowserBrowseToolCall && browserBrowseAvailableNow,
      memoryAvailable: allowMemoryToolCalls,
      imageLookupAvailable: false,
      screenShareAvailable: allowScreenShareToolCall,
      soundboardAvailable: allowSoundboardToolCall,
      codeAgentAvailable: codeAgentRuntimeAvailable,
      voiceToolsAvailable: Boolean(voiceToolCallbacks)
    });

    const subAgentSessions =
      typeof runtime.buildSubAgentSessionsRuntime === "function"
        ? runtime.buildSubAgentSessionsRuntime()
        : undefined;
    const voiceToolRuntime: ReplyToolRuntime = {
      search: {
        searchAndRead: async ({ settings: toolSettings, query, trace, signal: toolSignal }) =>
          await runtime.search.searchAndRead({
            settings: toolSettings,
            query,
            trace: {
              guildId: trace.guildId ?? null,
              channelId: trace.channelId ?? null,
              userId: trace.userId ?? null,
              source: trace.source ?? null
            },
            signal: toolSignal
          }),
        readPageSummary:
          typeof runtime.search.readPageSummary === "function"
            ? async (url, maxChars, toolSignal) => await runtime.search.readPageSummary(url, maxChars, toolSignal)
            : undefined
      },
      browser: {
        browse: async ({ settings: toolSettings, query, guildId, channelId, userId, source, signal: toolSignal }) =>
          await runtime.runModelRequestedBrowserBrowse({
            settings: toolSettings,
            browserBrowse,
            query,
            guildId,
            channelId,
            userId,
            source,
            signal: toolSignal
          })
      },
      screenShare:
        typeof runtime.startVoiceScreenWatch === "function"
          ? {
              startWatch: async ({
                settings: toolSettings,
                guildId,
                channelId,
                requesterUserId,
                target,
                transcript,
                source,
                signal: toolSignal
              }) =>
                await runtime.startVoiceScreenWatch({
                  settings: toolSettings,
                  guildId,
                  channelId,
                  requesterUserId,
                  target,
                  transcript,
                  source,
                  signal: toolSignal
                })
            }
          : undefined,
      voiceSessionControl: {
        requestLeaveVoiceChannel: async () => ({ ok: true })
      },
      codeAgent: runtime.runModelRequestedCodeTask ? {
        runTask: async ({ settings: toolSettings, task, cwd, guildId, channelId, userId, source, signal: toolSignal }) =>
          await runtime.runModelRequestedCodeTask({
            settings: toolSettings,
            task,
            cwd,
            guildId,
            channelId,
            userId,
            source,
            signal: toolSignal
          })
      } : undefined,
      memory: runtime.memory,
      store: runtime.store,
      subAgentSessions,
      voiceSession: voiceToolCallbacks || undefined
    };
    const voiceToolContext: ReplyToolContext = {
      settings: settings as Record<string, unknown>,
      guildId: String(guildId || ""),
      channelId: channelId ? String(channelId) : null,
      userId: String(userId || ""),
      sourceMessageId: `voice-${String(guildId || "guild")}-${Date.now()}`,
      sourceText: incomingTranscript,
      botUserId: runtime.client?.user?.id || undefined,
      trace: voiceTrace,
      signal
    };

    const initialUserPrompt = buildVoiceUserPrompt();
    const promptCapture = createPromptCapture({
      systemPrompt,
      initialUserPrompt,
      tools: voiceReplyTools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema || null }))
    });
    let voiceContextMessages: ContextMessage[] = [
      ...normalizedContextMessages
    ];

    let voiceImageInputs =
      streamWatchLatestFrame?.dataBase64
        ? [
            {
              mediaType: String(streamWatchLatestFrame.mimeType || "image/jpeg"),
              dataBase64: String(streamWatchLatestFrame.dataBase64)
            }
          ]
        : [];
    const spokenTextParts: string[] = [];
    const playedSoundboardRefs: string[] = [];
    let streamedSentenceCount = 0;
    let streamedSentenceIndex = 0;
    let screenNote: string | null = null;
    let screenMoment: string | null = null;
    let voiceAddressing = normalizeGeneratedVoiceAddressing(null, {
      currentSpeakerName: speakerName
    });
    const preserveInlineSoundboardDirectives = allowSoundboardToolCall;
    let streamedRequestedRealtimeUtterance = false;

    const captureGenerationText = (rawText: unknown) => {
      const normalized = normalizeVoiceReplyText(rawText, {
        maxLen: 520,
        preserveInlineSoundboardDirectives
      });
      if (!normalized || normalized === "[SKIP]") return;
      spokenTextParts.push(normalized);
    };

    const runVoiceGeneration = async ({
      userPrompt,
      contextMessages,
      trace
    }: {
      userPrompt: string;
      contextMessages: ContextMessage[];
      trace: typeof voiceTrace;
    }) => {
      let streamedTextAccepted = false;
      const streamedTextParts: string[] = [];
      if (!streamingEnabled) {
        const generation = await runtime.llm.generate({
          settings: tunedSettings,
          systemPrompt,
          userPrompt,
          imageInputs: voiceImageInputs,
          contextMessages,
          tools: voiceReplyTools,
          trace,
          signal
        });
        const parsedReplyAddressing = parseLeadingReplyAddressingDirective(generation.text, {
          currentSpeakerName: speakerName
        });
        if (hasGeneratedVoiceAddressing(parsedReplyAddressing.voiceAddressing)) {
          voiceAddressing = parsedReplyAddressing.voiceAddressing;
        }
        const resolvedSpokenText = normalizeVoiceReplyText(parsedReplyAddressing.text, {
          maxLen: 520,
          preserveInlineSoundboardDirectives
        });
        return {
          ...generation,
          streamedTextAccepted,
          resolvedSpokenText
        };
      }

      const accumulator = new SentenceAccumulator({
        eagerFirstChunk: true,
        minSentencesPerChunk: Number(voiceConversationPolicy.streaming?.minSentencesPerChunk),
        eagerMinChars: Number(voiceConversationPolicy.streaming?.eagerFirstChunkChars),
        maxBufferChars: Number(voiceConversationPolicy.streaming?.maxBufferChars),
        onSentence(text) {
          const normalized = normalizeVoiceReplyText(text, {
            maxLen: 520,
            preserveInlineSoundboardDirectives
          });
          if (!normalized || normalized === "[SKIP]" || signal?.aborted) return;
          streamedDispatchChain = streamedDispatchChain.then(async () => {
            if (signal?.aborted) return;
            const dispatchResult = normalizeSpokenSentenceDispatchResult(
              await onSpokenSentence({
                text: normalized,
                index: streamedSentenceIndex,
                voiceAddressing: voiceAddressing ? { ...voiceAddressing } : null
              })
            );
            if (!dispatchResult.accepted) return;
            streamedTextAccepted = true;
            streamedTextParts.push(normalized);
            appendUniqueStrings(playedSoundboardRefs, dispatchResult.playedSoundboardRefs);
            streamedRequestedRealtimeUtterance =
              streamedRequestedRealtimeUtterance || dispatchResult.requestedRealtimeUtterance;
            streamedSentenceIndex += 1;
            streamedSentenceCount += 1;
          });
        }
      });
      let streamedDispatchChain = Promise.resolve();
      let leadingReplyAddressingState = {
        resolved: false,
        buffer: ""
      };

      const generation = await runtime.llm.generateStreaming({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        imageInputs: voiceImageInputs,
        contextMessages,
        tools: voiceReplyTools,
        trace,
        signal,
        onTextDelta(delta) {
          const consumed = consumeLeadingReplyAddressingDirectiveChunk(
            leadingReplyAddressingState,
            delta,
            {
              currentSpeakerName: speakerName
            }
          );
          leadingReplyAddressingState = consumed.nextState;
          if (hasGeneratedVoiceAddressing(consumed.voiceAddressing)) {
            voiceAddressing = consumed.voiceAddressing;
          }
          if (consumed.textDelta) {
            accumulator.push(consumed.textDelta);
          }
        }
      });
      if (!leadingReplyAddressingState.resolved && leadingReplyAddressingState.buffer) {
        const consumed = consumeLeadingReplyAddressingDirectiveChunk(
          leadingReplyAddressingState,
          "",
          {
            currentSpeakerName: speakerName
          }
        );
        leadingReplyAddressingState = consumed.nextState;
        if (hasGeneratedVoiceAddressing(consumed.voiceAddressing)) {
          voiceAddressing = consumed.voiceAddressing;
        }
        if (consumed.textDelta) {
          accumulator.push(consumed.textDelta);
        }
      }
      accumulator.flush();
      await streamedDispatchChain;
      const parsedReplyAddressing = parseLeadingReplyAddressingDirective(generation.text, {
        currentSpeakerName: speakerName
      });
      if (hasGeneratedVoiceAddressing(parsedReplyAddressing.voiceAddressing)) {
        voiceAddressing = parsedReplyAddressing.voiceAddressing;
      }
      const resolvedSpokenText = normalizeVoiceReplyText(parsedReplyAddressing.text, {
        maxLen: 520,
        preserveInlineSoundboardDirectives
      }) || normalizeVoiceReplyText(mergeSpokenReplyText(streamedTextParts), {
        maxLen: 520,
        preserveInlineSoundboardDirectives
      });
      return {
        ...generation,
        streamedTextAccepted,
        resolvedSpokenText
      };
    };

    let generation = await runVoiceGeneration({
      userPrompt: initialUserPrompt,
      contextMessages: voiceContextMessages,
      trace: voiceTrace
    });
    captureGenerationText(generation.resolvedSpokenText);

    const VOICE_TOOL_LOOP_MAX_STEPS = 2;
    const VOICE_TOOL_LOOP_MAX_CALLS = 6;
    let voiceToolLoopSteps = 0;
    let voiceTotalToolCalls = 0;
    let toolPhaseRecoveryStillEligible = true;
    let sawToolPhaseFollowup = false;

    while (
      generation.toolCalls?.length > 0 &&
      voiceToolLoopSteps < VOICE_TOOL_LOOP_MAX_STEPS &&
      voiceTotalToolCalls < VOICE_TOOL_LOOP_MAX_CALLS
    ) {
      const generationHasSpokenText = Boolean(stripInlineSoundboardDirectives(generation.resolvedSpokenText, 520));
      const assistantContent = ensureAssistantContentIncludesResolvedText(
        buildContextContentBlocks(generation.rawContent, generation.resolvedSpokenText),
        generation.resolvedSpokenText
      );
      voiceContextMessages = [
        ...voiceContextMessages,
        { role: "user" as const, content: initialUserPrompt },
        { role: "assistant" as const, content: assistantContent }
      ];

      const toolResultMessages: ContentBlock[] = [];
      let toolResultImageInputsAdded = false;
      let continuationRequested = false;
      if (activeVoiceSession?.inFlightAcceptedBrainTurn?.phase === "generation_only") {
        const heldReplyAbortedBeforeToolCall =
          activeVoiceSession &&
          typeof runtime.voiceSessionManager?.abortHeldPrePlaybackReplyBeforeToolCall === "function"
            ? runtime.voiceSessionManager.abortHeldPrePlaybackReplyBeforeToolCall({
              session: activeVoiceSession,
              source: "voice_generation_tool_boundary"
            })
            : false;
        if (heldReplyAbortedBeforeToolCall) {
          throw createAbortError("held_preplay_reply_replaced_before_tool_call");
        }
        activeVoiceSession.inFlightAcceptedBrainTurn.phase = "tool_call_started";
        activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryEligible = false;
        activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryReason = "tool_call_started";
        activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseLastToolName = null;
      }
      for (const toolCall of generation.toolCalls) {
        if (voiceTotalToolCalls >= VOICE_TOOL_LOOP_MAX_CALLS) break;
        voiceTotalToolCalls += 1;

        const toolInput = toolCall.input as Record<string, unknown>;
        const toolStartMs = Date.now();
        const result = toolCall.name === "note_context"
          ? (() => {
            const stored = appendSessionDurableContextEntry({
              session: activeVoiceSession,
              text: toolInput?.text,
              category: toolInput?.category,
              at: Date.now()
            });
            if (!stored?.entry) {
              return {
                content: JSON.stringify({
                  ok: false,
                  error: "Session durable context is unavailable."
                }),
                imageInputs: undefined,
                isError: true
              };
            }
            return {
              content: JSON.stringify({
                ok: true,
                duplicate: stored.duplicate,
                total: stored.total,
                text: stored.entry.text,
                category: stored.entry.category
              }),
              imageInputs: undefined
            };
          })()
          : await executeReplyTool(
            toolCall.name,
            toolInput,
            voiceToolRuntime,
            voiceToolContext
          );
        const toolDurationMs = Date.now() - toolStartMs;

        runtime.store.logAction({
          kind: "voice_runtime",
          guildId,
          channelId,
          userId,
          content: "voice_brain_tool_call",
          metadata: {
            sessionId,
            source: voiceTrace.source,
            replyPath: "brain",
            realtimeToolOwnership,
            runtimeMode,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            toolCallIndex: voiceTotalToolCalls,
            durationMs: toolDurationMs,
            imageInputCount: Array.isArray(result.imageInputs) ? result.imageInputs.length : 0,
            isError: result.isError || false
          }
        });

        if (Array.isArray(result.imageInputs) && result.imageInputs.length) {
          voiceImageInputs = mergeImageInputs({
            baseInputs: voiceImageInputs,
            extraInputs: result.imageInputs,
            maxInputs: MAX_MODEL_IMAGE_INPUTS
          });
          toolResultImageInputsAdded = true;
        }

        if (toolCall.name === "web_search" && !result.isError) {
          usedWebSearchFollowup = true;
        }
        if (toolCall.name === "play_soundboard" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          const playedRefs = Array.isArray(toolPayload?.played)
            ? toolPayload.played
            : Array.isArray((toolCall.input as Record<string, unknown>)?.refs)
              ? (toolCall.input as Record<string, unknown>).refs as unknown[]
              : [];
          appendUniqueStrings(playedSoundboardRefs, playedRefs);
        }
        if (toolCall.name === "screen_note" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          const note = String(toolPayload?.note || "").replace(/\s+/g, " ").trim().slice(0, 220);
          screenNote = note || screenNote;
        }
        if (toolCall.name === "screen_moment" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          const moment = String(toolPayload?.moment || "").replace(/\s+/g, " ").trim().slice(0, 220);
          screenMoment = moment || screenMoment;
        }
        if (toolCall.name === "start_screen_watch" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          usedScreenShareOffer = usedScreenShareOffer || Boolean(toolPayload?.started);
        }
        if (toolCall.name === "leave_voice_channel" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          leaveVoiceChannelRequested = leaveVoiceChannelRequested || Boolean(toolPayload?.ok);
        }
        if (toolCall.name === "memory_write" && !result.isError && activeVoiceSession) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          const writtenEntries = Array.isArray(toolPayload?.written) ? toolPayload.written : [];
          if (toolPayload?.ok !== false && writtenEntries.length > 0) {
            invalidateSessionBehavioralMemoryCache(activeVoiceSession);
            const writtenSubjects = new Set(
              writtenEntries
                .map((entry) => String(entry?.subject || "").trim())
                .filter(Boolean)
            );
            if (
              typeof runtime.voiceSessionManager?.refreshSessionGuildFactProfile === "function" &&
              (writtenSubjects.has(SELF_SUBJECT) || writtenSubjects.has(LORE_SUBJECT))
            ) {
              runtime.voiceSessionManager.refreshSessionGuildFactProfile(activeVoiceSession);
            }
            if (typeof runtime.voiceSessionManager?.refreshSessionUserFactProfile === "function") {
              for (const subject of writtenSubjects) {
                if (subject === SELF_SUBJECT || subject === LORE_SUBJECT) continue;
                runtime.voiceSessionManager.refreshSessionUserFactProfile(activeVoiceSession, subject);
              }
            }
          }
        }

        const toolFollowupRequested = shouldRequestVoiceToolFollowup(toolCall.name, {
          hasSpokenText: generationHasSpokenText
        });
        const toolRecovery = classifyVoiceToolPrePlaybackRecovery(toolCall.name, result);
        const suppressToolFollowup =
          toolRecovery.reason === "music_play_started_loading" ||
          toolRecovery.reason === "video_play_started_loading";
        const effectiveToolFollowupRequested =
          toolFollowupRequested && !suppressToolFollowup;
        toolPhaseRecoveryStillEligible = toolPhaseRecoveryStillEligible && toolRecovery.eligible;
        sawToolPhaseFollowup = sawToolPhaseFollowup || effectiveToolFollowupRequested;
        if (activeVoiceSession?.inFlightAcceptedBrainTurn?.phase === "tool_call_started") {
          activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryEligible =
            sawToolPhaseFollowup && toolPhaseRecoveryStillEligible;
          activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseRecoveryReason =
            effectiveToolFollowupRequested || suppressToolFollowup
              ? toolRecovery.reason
              : `tool_followup_not_required:${toolRecovery.reason}`;
          activeVoiceSession.inFlightAcceptedBrainTurn.toolPhaseLastToolName = toolCall.name;
        }

        if (effectiveToolFollowupRequested) {
          continuationRequested = true;
        }
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }

      if (!continuationRequested) {
        break;
      }

      voiceContextMessages = [
        ...voiceContextMessages,
        { role: "user" as const, content: toolResultMessages }
      ];

      generation = await runVoiceGeneration({
        userPrompt: toolResultImageInputsAdded
          ? "Attached are images returned by the previous tool call. Use them if they help."
          : "",
        contextMessages: voiceContextMessages,
        trace: {
          ...voiceTrace,
          event: `${sessionId ? "voice_session" : "voice_turn"}:tool_loop:${voiceToolLoopSteps + 1}`
        },
      });
      appendPromptFollowup(
        promptCapture,
        toolResultImageInputsAdded
          ? "Attached are images returned by the previous tool call. Use them if they help."
          : ""
      );
      captureGenerationText(generation.resolvedSpokenText);
      voiceToolLoopSteps += 1;
    }

    const replyPrompts = buildLoggedPromptBundle(promptCapture, voiceToolLoopSteps);

    const finalText = normalizeVoiceReplyText(mergeSpokenReplyText(spokenTextParts), {
      maxLen: 520,
      preserveInlineSoundboardDirectives
    });
    if (!finalText && playedSoundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      return {
        text: "",
        usedWebSearchFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        screenNote,
        screenMoment,
        streamedSentenceCount,
        streamedRequestedRealtimeUtterance,
        generationContextSnapshot,
        replyPrompts
      };
    }
    if (!finalText) {
      const response = {
        text: "",
        playedSoundboardRefs,
        usedWebSearchFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        screenNote,
        screenMoment,
        streamedSentenceCount,
        streamedRequestedRealtimeUtterance,
        generationContextSnapshot,
        replyPrompts
      };
      if (leaveVoiceChannelRequested) {
        return {
          ...response,
          leaveVoiceChannelRequested: true
        };
      }
      return response;
    }

    const response = {
      text: finalText,
      playedSoundboardRefs,
      usedWebSearchFollowup,
      usedScreenShareOffer,
      voiceAddressing,
      screenNote,
      screenMoment,
      streamedSentenceCount,
      streamedRequestedRealtimeUtterance,
      generationContextSnapshot,
      replyPrompts
    };
    if (leaveVoiceChannelRequested) {
      return {
        ...response,
        leaveVoiceChannelRequested: true
      };
    }
    return response;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return { text: "", generationContextSnapshot: null, replyPrompts: null };
    }
    runtime.store.logAction({
      kind: "voice_error",
      guildId,
      channelId,
      userId,
      content: `voice_brain_generation_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId,
        replyPath: "brain",
        realtimeToolOwnership,
        runtimeMode
      }
    });
    return { text: "", generationContextSnapshot: null, replyPrompts: null };
  }
}

function normalizeGeneratedVoiceAddressing(
  rawAddressing,
  {
    currentSpeakerName = ""
  }: {
    currentSpeakerName?: string;
  } = {}
) {
  const normalizedRaw = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
  const normalizedSpeakerName = String(currentSpeakerName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const rawTalkingToToken = normalizeVoiceAddressingTargetToken(normalizedRaw?.talkingTo || "");
  const talkingToToken =
    String(rawTalkingToToken || "").trim().toUpperCase() === "SPEAKER"
      ? normalizedSpeakerName || "SPEAKER"
      : rawTalkingToToken;

  const talkingTo = talkingToToken || null;
  if (!talkingTo) return null;

  return { talkingTo } satisfies GeneratedVoiceAddressing;
}

function parseReplyToolResultPayload(content: unknown) {
  const text = String(content || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classifyVoiceToolPrePlaybackRecovery(
  toolName: unknown,
  result: {
    content?: unknown;
    isError?: boolean;
  } | null | undefined
) {
  const normalizedToolName = String(toolName || "").trim().toLowerCase();
  const payload = parseReplyToolResultPayload(result?.content);
  switch (normalizedToolName) {
    case "music_play":
    case "video_play": {
      const normalizedStatus = String(payload?.status || "").trim().toLowerCase();
      if (normalizedStatus === "needs_disambiguation") {
        return {
          eligible: true,
          reason: normalizedToolName === "video_play" ? "video_play_needs_disambiguation" : "music_play_needs_disambiguation"
        };
      }
      if (normalizedStatus === "not_found") {
        return {
          eligible: true,
          reason: normalizedToolName === "video_play" ? "video_play_not_found" : "music_play_not_found"
        };
      }
      if (normalizedStatus === "loading") {
        return {
          eligible: false,
          reason: normalizedToolName === "video_play" ? "video_play_started_loading" : "music_play_started_loading"
        };
      }
      if (payload?.ok === false || result?.isError) {
        return {
          eligible: true,
          reason: normalizedToolName === "video_play" ? "video_play_failed_before_playback" : "music_play_failed_before_playback"
        };
      }
      return {
        eligible: false,
        reason: normalizedToolName === "video_play" ? "video_play_side_effect_uncertain" : "music_play_side_effect_uncertain"
      };
    }
    case "music_search":
    case "video_search":
    case "media_now_playing":
    case "web_search":
    case "web_scrape":
    case "memory_search":
    case "conversation_search":
      return {
        eligible: true,
        reason: "read_only_tool"
      };
    default:
      return {
        eligible: false,
        reason: "tool_has_side_effects"
      };
  }
}

function resolveVoiceScreenWatchCapability(runtime, { settings, guildId, channelId, userId }) {
  if (typeof runtime?.getVoiceScreenWatchCapability !== "function") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_watch_capability_unavailable"
    };
  }

  const capability = runtime.getVoiceScreenWatchCapability({
    settings,
    guildId,
    channelId,
    requesterUserId: userId
  });
  const status = String(capability?.status || "disabled").trim().toLowerCase() || "disabled";
  const enabled = Boolean(capability?.enabled);
  const available = capability?.available === undefined ? enabled && status === "ready" : Boolean(capability.available);
  const rawReason = String(capability?.reason || "").trim().toLowerCase();
  const supported =
    capability?.supported === undefined
      ? rawReason !== "screen_watch_unavailable"
      : Boolean(capability.supported);
  return {
    supported,
    enabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "unavailable",
    nativeAvailable: Boolean(capability?.nativeAvailable),
    linkFallbackAvailable: Boolean(capability?.linkFallbackAvailable)
  };
}
