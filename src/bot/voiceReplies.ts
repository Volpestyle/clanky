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
import { normalizeFactProfileSlice } from "./memorySlice.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";
import {
  resolveWarmMemory,
  updateTopicFingerprint,
  captureWarmSnapshot,
  invalidateWarmSnapshot
} from "../voice/voiceSessionWarmMemory.ts";
import {
  getActivitySettings,
  applyOrchestratorOverrideSettings,
  getMemorySettings,
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding,
  getVoiceConversationPolicy,
  getVoiceSoundboardSettings,
  getVoiceStreamWatchSettings
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
  parseSoundboardDirectiveSequence,
  extractNoteDirectives
} from "../voice/voiceSessionHelpers.ts";
import {
  invalidateSessionBehavioralMemoryCache,
  loadSessionConversationHistory
} from "../voice/voiceSessionMemoryCache.ts";
import {
  loadSharedVoiceMemoryContext,
  type VoiceMemoryContextSessionLike
} from "../voice/voiceMemoryContext.ts";
import { isStreamWatchFrameReady } from "../voice/voiceStreamWatch.ts";
import { recordVoiceToolCallEvent } from "../voice/voiceToolCallToolRegistry.ts";
import {
  buildSharedVoiceTurnContext,
  normalizeVoiceScreenWatchCapability
} from "../voice/voiceTurnContext.ts";
import {
  summarizeVoiceToolError,
  summarizeVoiceToolResult
} from "../voice/voiceToolResultSummary.ts";
import { mergeImageInputs } from "./imageAnalysis.ts";
import { MAX_MODEL_IMAGE_INPUTS } from "./replyPipelineShared.ts";
import {
  appendPromptFollowup,
  buildLoggedPromptBundle,
  createPromptCapture
} from "../promptLogging.ts";
import type { VoiceOutputLeaseMode } from "../voice/voiceSessionTypes.ts";

const SESSION_DURABLE_CONTEXT_MAX_ENTRIES = 50;
const SELF_SUBJECT = "__self__";
const LORE_SUBJECT = "__lore__";
const LEADING_REPLY_METADATA_DIRECTIVE_RE =
  /^\[\[\s*(TO|LEASE)\s*:\s*([^\]]+?)\s*\]\]\s*/i;
const MAX_LEADING_REPLY_ADDRESSING_BUFFER_CHARS = 160;
const STREAM_WATCH_STREAMING_MIN_SENTENCES = 3;
const STREAM_WATCH_STREAMING_EAGER_FIRST_CHUNK_CHARS = 120;
const STREAM_WATCH_STREAMING_MAX_BUFFER_CHARS = 420;

type SessionDurableContextCategory = "fact" | "plan" | "preference" | "relationship";
type GeneratedVoiceAddressing = {
  talkingTo: string | null;
};
type GeneratedVoiceOutputLease = {
  mode: Exclude<VoiceOutputLeaseMode, "ambient">;
};

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

function stripInlineSoundboardDirectives(text: unknown) {
  const withoutNotes = extractNoteDirectives(String(text || "")).text;
  const normalized = sanitizeBotText(normalizeSkipSentinel(withoutNotes), 0);
  if (!normalized || normalized === "[SKIP]") return normalized;
  if (!hasInlineSoundboardDirective(normalized)) return normalized;
  return sanitizeBotText(parseSoundboardDirectiveSequence(normalized).text, 0);
}

function normalizeVoiceReplyText(
  text: unknown,
  {
    maxLen,
    preserveInlineSoundboardDirectives = false
  }: {
    maxLen?: number;
    preserveInlineSoundboardDirectives?: boolean;
  } = {}
) {
  // Strip [[NOTE:...]] directives before any other normalization so they
  // are never sent to TTS — even in the streaming path where sentence
  // chunks are dispatched before the post-generation extractNoteDirectives call.
  const withoutNotes = extractNoteDirectives(String(text || "")).text;
  // Pass 0 when no maxLen to bypass sanitizeBotText's default Discord limit.
  const effectiveMaxLen = maxLen ?? 0;
  const normalized = sanitizeBotText(normalizeSkipSentinel(withoutNotes), effectiveMaxLen);
  if (!normalized || normalized === "[SKIP]") return normalized;
  if (preserveInlineSoundboardDirectives) return normalized;
  if (!hasInlineSoundboardDirective(normalized)) return normalized;
  return sanitizeBotText(parseSoundboardDirectiveSequence(normalized).text, effectiveMaxLen);
}

function hasGeneratedVoiceAddressing(addressing: GeneratedVoiceAddressing | null) {
  if (!addressing || typeof addressing !== "object") return false;
  return Boolean(addressing.talkingTo);
}

function hasGeneratedVoiceOutputLease(outputLease: GeneratedVoiceOutputLease | null) {
  if (!outputLease || typeof outputLease !== "object") return false;
  return outputLease.mode === "assertive" || outputLease.mode === "atomic";
}

function parseLeadingReplyMetadataDirectivesImpl(
  text: unknown,
  {
    currentSpeakerName = "",
    allowDirectiveOnlyTail = true
  }: {
    currentSpeakerName?: string;
    allowDirectiveOnlyTail?: boolean;
  } = {}
) {
  const source = String(text || "");
  let remaining = source;
  let voiceAddressing = null as GeneratedVoiceAddressing | null;
  let voiceOutputLease = null as GeneratedVoiceOutputLease | null;
  let matched = false;

  while (true) {
    const leadingWhitespace = remaining.match(/^\s*/)?.[0] || "";
    const trimmedLeading = remaining.slice(leadingWhitespace.length);
    if (!trimmedLeading) {
      return {
        text: allowDirectiveOnlyTail ? "" : source,
        voiceAddressing,
        voiceOutputLeaseMode: voiceOutputLease?.mode || null,
        matched,
        complete: allowDirectiveOnlyTail || !matched
      };
    }

    if (!trimmedLeading.startsWith("[[")) {
      return {
        text: matched ? remaining : source,
        voiceAddressing,
        voiceOutputLeaseMode: voiceOutputLease?.mode || null,
        matched,
        complete: true
      };
    }

    const directiveMatch = trimmedLeading.match(LEADING_REPLY_METADATA_DIRECTIVE_RE);
    if (!directiveMatch) {
      const hasClosingFence = trimmedLeading.includes("]]");
      return {
        text: source,
        voiceAddressing: null,
        voiceOutputLeaseMode: null,
        matched: false,
        complete: hasClosingFence
      };
    }

    matched = true;
    const directiveName = String(directiveMatch[1] || "").trim().toUpperCase();
    const directiveValue = String(directiveMatch[2] || "").trim();
    if (directiveName === "TO" && !hasGeneratedVoiceAddressing(voiceAddressing)) {
      voiceAddressing = normalizeGeneratedVoiceAddressing(
        { talkingTo: directiveValue },
        { currentSpeakerName }
      );
    }
    if (directiveName === "LEASE" && !hasGeneratedVoiceOutputLease(voiceOutputLease)) {
      voiceOutputLease = normalizeGeneratedVoiceOutputLease({ mode: directiveValue });
    }

    remaining = remaining.slice(leadingWhitespace.length + directiveMatch[0].length);
  }
}

function parseLeadingReplyAddressingDirective(
  text: unknown,
  {
    currentSpeakerName = ""
  }: {
    currentSpeakerName?: string;
  } = {}
) {
  return parseLeadingReplyMetadataDirectivesImpl(text, {
    currentSpeakerName,
    allowDirectiveOnlyTail: true
  });
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
      voiceAddressing: null,
      voiceOutputLeaseMode: null
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
      voiceAddressing: null,
      voiceOutputLeaseMode: null
    };
  }

  if (!trimmedLeading.startsWith("[[")) {
    return {
      nextState: {
        resolved: true,
        buffer: ""
      },
      textDelta: nextBuffer,
      voiceAddressing: null,
      voiceOutputLeaseMode: null
    };
  }

  const parsed = parseLeadingReplyMetadataDirectivesImpl(nextBuffer, {
    currentSpeakerName,
    allowDirectiveOnlyTail: false
  });
  if (!parsed.complete && nextBuffer.length < MAX_LEADING_REPLY_ADDRESSING_BUFFER_CHARS) {
    return {
      nextState: {
        resolved: false,
        buffer: nextBuffer
      },
      textDelta: "",
      voiceAddressing: null,
      voiceOutputLeaseMode: null
    };
  }
  return {
    nextState: {
      resolved: true,
      buffer: ""
    },
    textDelta: parsed.matched ? parsed.text : nextBuffer,
    voiceAddressing: parsed.voiceAddressing,
    voiceOutputLeaseMode: parsed.voiceOutputLeaseMode
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
  source = "",
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
  nativeDiscordSharers = [],
  recentToolOutcomes = [],
  webSearchTimeoutMs: _webSearchTimeoutMs = null,
  voiceToolCallbacks = null,
  onSpokenSentence = null,
  streamingSentencesEnabled: _streamingSentencesEnabled = null,
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
  const screenWatchCommentaryEagerness = Number(getVoiceStreamWatchSettings(settings).commentaryEagerness) || 60;
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
  const activeVoiceSession =
    sessionId && typeof runtime.voiceSessionManager?.getSessionById === "function"
      ? runtime.voiceSessionManager.getSessionById(sessionId)
      : null;
  const canBuildSharedTurnContext = Boolean(
    activeVoiceSession &&
    runtime.voiceSessionManager &&
    typeof runtime.voiceSessionManager.resolveVoiceSpeakerName === "function" &&
    typeof runtime.voiceSessionManager.getStreamWatchNotesForPrompt === "function" &&
    typeof runtime.voiceSessionManager.getVoiceScreenWatchCapability === "function" &&
    typeof runtime.voiceSessionManager.getVoiceChannelParticipants === "function" &&
    typeof runtime.voiceSessionManager.getRecentVoiceMembershipEvents === "function" &&
    typeof runtime.voiceSessionManager.getRecentVoiceChannelEffectEvents === "function"
  );
  const sharedTurnContext =
    canBuildSharedTurnContext && runtime.voiceSessionManager
      ? buildSharedVoiceTurnContext(runtime.voiceSessionManager, {
          session: activeVoiceSession,
          settings,
          speakerUserId: userId,
          maxParticipants: 12,
          maxMembershipEvents: 6,
          maxVoiceEffects: 6
        })
      : null;
  const screenShare = sharedTurnContext?.screenWatchCapability || normalizeVoiceScreenWatchCapability(
    typeof runtime?.getVoiceScreenWatchCapability === "function"
      ? runtime.getVoiceScreenWatchCapability({
          settings,
          guildId,
          channelId,
          requesterUserId: userId
        })
      : null
  );
  const allowScreenShareToolCall = shouldExposeVoiceScreenWatchTool(screenShare, {
    canStartScreenWatch: typeof runtime.startVoiceScreenWatch === "function",
    guildId,
    userId
  });
  const realtimeToolOwnership = activeVoiceSession?.realtimeToolOwnership === "provider_native"
    ? "provider_native"
    : "transport_only";
  const runtimeMode = String(activeVoiceSession?.mode || "").trim() || null;
  const musicContext = sharedTurnContext?.musicContext || (
    activeVoiceSession && typeof runtime.voiceSessionManager?.getMusicPromptContext === "function"
      ? runtime.voiceSessionManager.getMusicPromptContext(activeVoiceSession)
      : null
  );
  const guild = runtime.client.guilds.cache.get(String(guildId || ""));
  const speakerName =
    guild?.members?.cache?.get(String(userId || ""))?.displayName ||
    guild?.members?.cache?.get(String(userId || ""))?.user?.username ||
    runtime.client.users?.cache?.get(String(userId || ""))?.username ||
    "unknown";
  const screenWatchStreamerUserId = String(activeVoiceSession?.streamWatch?.targetUserId || "").trim();
  const screenWatchStreamerName = screenWatchStreamerUserId
    ? (guild?.members?.cache?.get(screenWatchStreamerUserId)?.displayName ||
       guild?.members?.cache?.get(screenWatchStreamerUserId)?.user?.username ||
       runtime.client.users?.cache?.get(screenWatchStreamerUserId)?.username ||
       "")
    : "";
  const normalizedParticipantRoster = (
    sharedTurnContext?.participantRoster.length
      ? sharedTurnContext.participantRoster
      : Array.isArray(participantRoster) ? participantRoster : []
  )
    .map((entry) => {
      if (typeof entry === "string") {
        return String(entry).trim();
      }
      return String(entry?.displayName || entry?.name || "").trim();
    })
    .filter(Boolean)
    .slice(0, 12);
  const normalizedMembershipEvents = (
    sharedTurnContext?.recentMembershipEvents.length
      ? sharedTurnContext.recentMembershipEvents
      : Array.isArray(recentMembershipEvents) ? recentMembershipEvents : []
  )
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
  const normalizedVoiceEffectEvents = (
    sharedTurnContext?.recentVoiceEffectEvents.length
      ? sharedTurnContext.recentVoiceEffectEvents
      : Array.isArray(recentVoiceEffectEvents) ? recentVoiceEffectEvents : []
  )
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
  const normalizedNativeDiscordSharers = (
    sharedTurnContext?.nativeDiscordSharers.length
      ? sharedTurnContext.nativeDiscordSharers
      : Array.isArray(nativeDiscordSharers) ? nativeDiscordSharers : []
  )
    .filter((entry) => entry?.displayName)
    .slice(0, 6);
  const normalizedRecentToolOutcomes = (
    sharedTurnContext?.recentToolOutcomeLines.length
      ? sharedTurnContext.recentToolOutcomeLines
      : Array.isArray(recentToolOutcomes) ? recentToolOutcomes : []
  )
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(-4);
  // ── Warm memory: attempt to resolve from cached snapshot ─────────────
  // Await the pre-computed embedding from the ingest pipeline (already
  // in-flight since transcript capture).  Use it for topic-drift detection
  // to decide whether full retrieval is needed.
  let turnEmbedding: { embedding: number[]; model: string } | null = null;
  let warmMemoryVerdict: import("../voice/voiceSessionWarmMemory.ts").DriftVerdict = "cold";
  let warmMemorySimilarity = 0;
  let warmMemoryReason = "no_session";
  let usedWarmMemory = false;

  if (activeVoiceSession?.warmMemory) {
    const wm = activeVoiceSession.warmMemory;
    // Resolve the pending ingest embedding — keyed by transcript to prevent
    // cross-turn contamination when multiple transcripts land quickly.
    let ingestEntry: import("../voice/voiceSessionWarmMemory.ts").IngestEmbeddingEntry | null = null;
    if (wm.pendingIngestEmbedding) {
      try {
        ingestEntry = await wm.pendingIngestEmbedding;
      } catch {
        ingestEntry = null;
      }
      wm.pendingIngestEmbedding = null;
    }
    if (!ingestEntry && wm.lastIngestEmbedding) {
      ingestEntry = wm.lastIngestEmbedding;
    }
    // Only use the embedding if it matches THIS turn's transcript
    if (ingestEntry && ingestEntry.transcript === incomingTranscript) {
      turnEmbedding = { embedding: ingestEntry.embedding, model: ingestEntry.model };
    }

    const warmResult = resolveWarmMemory(wm, turnEmbedding);
    warmMemoryVerdict = warmResult.drift;
    warmMemorySimilarity = warmResult.similarity;
    warmMemoryReason = warmResult.reason;

    if (warmResult.snapshot) {
      // Warm memory hit — skip full retrieval
      usedWarmMemory = true;
    }
  }

  let promptMemorySlice;
  let recentConversationHistory: unknown[];
  let behavioralFacts: MemoryFactRow[];
  let usedCachedBehavioralFacts: boolean;
  let continuityLoadMs: number;
  let behavioralMemoryLoadMs: number;
  let totalMemoryLoadMs: number;

  if (usedWarmMemory && activeVoiceSession?.warmMemory?.snapshot) {
    // ── Fast path: reuse warm snapshot ──────────────────────────────────
    const snap = activeVoiceSession.warmMemory.snapshot;
    promptMemorySlice = normalizeFactProfileSlice(snap.continuity.memorySlice);
    recentConversationHistory = snap.continuity.recentConversationHistory;
    behavioralFacts = snap.behavioralFacts;
    usedCachedBehavioralFacts = true;
    continuityLoadMs = 0;
    behavioralMemoryLoadMs = 0;
    totalMemoryLoadMs = 0;

    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId,
      content: "voice_generation_memory_loaded",
      metadata: {
        sessionId: sessionId || null,
        memorySource: "warm_memory_reuse",
        warmMemoryVerdict,
        warmMemorySimilarity: Math.round(warmMemorySimilarity * 1000) / 1000,
        warmMemoryReason,
        transcriptChars: incomingTranscript.length,
        continuityLoadMs: 0,
        behavioralMemoryLoadMs: 0,
        totalLoadMs: 0,
        usedCachedBehavioralFacts: true,
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
        behavioralFactCount: behavioralFacts.length,
        recentConversationHistoryCount: Array.isArray(recentConversationHistory)
          ? recentConversationHistory.length
          : 0
      }
    });
  } else {
    // ── Full retrieval path (cold start or topic drift) ─────────────────
    throwIfAborted(signal, "Voice generation memory load cancelled");
    const memoryContextSession: VoiceMemoryContextSessionLike = activeVoiceSession || {
      guildId,
      textChannelId: channelId,
      pendingMemoryIngest: null
    };
    const loaded = await loadSharedVoiceMemoryContext({
      loadRecentConversationHistory:
        typeof runtime.loadRecentConversationHistory === "function"
          ? (payload) =>
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
          : null,
      getSessionFactProfileSlice:
        activeVoiceSession && typeof runtime.voiceSessionManager?.getSessionFactProfileSlice === "function"
          ? (payload) => runtime.voiceSessionManager.getSessionFactProfileSlice(payload)
          : typeof runtime.loadFactProfile === "function"
            ? ({ userId: factUserId }) => runtime.loadFactProfile({
                settings,
                userId: String(factUserId || "").trim() || null,
                guildId,
                channelId,
                queryText: incomingTranscript,
                trace: {
                  guildId,
                  channelId,
                  userId
                }
              })
            : undefined,
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
      loadBehavioralFactsForPrompt:
        typeof runtime.memory?.loadBehavioralFactsForPrompt === "function"
          ? async (payload) => await runtime.memory.loadBehavioralFactsForPrompt(payload)
          : null
    }, {
      session: memoryContextSession,
      settings,
      userId,
      transcript: incomingTranscript,
      continuitySource: "voice_realtime_generation",
      behavioralSource: "voice_realtime_behavioral_memory:generation"
    });
    throwIfAborted(signal, "Voice generation memory load cancelled");
    promptMemorySlice = normalizeFactProfileSlice(loaded.memorySlice);
    recentConversationHistory = Array.isArray(loaded.memorySlice.recentConversationHistory)
      ? loaded.memorySlice.recentConversationHistory
      : [];
    behavioralFacts = Array.isArray(loaded.memorySlice.behavioralFacts)
      ? loaded.memorySlice.behavioralFacts
      : [];
    usedCachedBehavioralFacts = loaded.usedCachedBehavioralFacts;
    continuityLoadMs = loaded.continuityLoadMs;
    behavioralMemoryLoadMs = loaded.behavioralMemoryLoadMs;
    totalMemoryLoadMs = loaded.totalLoadMs;
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
      warmMemoryVerdict,
      warmMemorySimilarity: Math.round(warmMemorySimilarity * 1000) / 1000,
      usedCachedBehavioralFacts,
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

  // Capture warm snapshot for subsequent turns (only after full retrieval)
  if (activeVoiceSession?.warmMemory) {
    captureWarmSnapshot(activeVoiceSession.warmMemory, {
      continuity: {
        memorySlice: promptMemorySlice,
        recentConversationHistory
      },
      behavioralFacts,
      usedCachedBehavioralFacts,
      capturedAt: Date.now(),
      sourceTranscript: incomingTranscript
    });
  }
  } // close else (full retrieval path)

  // Always update the topic fingerprint — even on warm-hit turns — so
  // gradual drift is tracked and the fingerprint stays current.
  if (activeVoiceSession?.warmMemory && turnEmbedding) {
    updateTopicFingerprint(activeVoiceSession.warmMemory, turnEmbedding, "user");
  }

  const voiceGenerationBinding = getResolvedVoiceGenerationBinding(settings);
  const replyGeneration = getReplyGenerationSettings(settings);

  // Stream watch commentary model override: when a dedicated commentary model
  // is configured, use it for bot-initiated screen watch turns. Skip the
  // override on the very first commentary turn (lastCommentaryAt === 0) since
  // the user just asked to watch and is waiting for the first reaction.
  const isStreamWatchCommentary =
    runtimeEventContext?.category === "screen_share" &&
    String(inputKind || "").trim().toLowerCase() === "event";
  const streamWatchSettings = (settings as Record<string, Record<string, Record<string, unknown>>>)
    ?.voice?.streamWatch || {};
  const commentaryProvider = String(streamWatchSettings.commentaryProvider || "").trim();
  const commentaryModel = String(streamWatchSettings.commentaryModel || "").trim();
  const isFirstCommentaryTurn = !activeVoiceSession?.streamWatch?.lastCommentaryAt;
  const normalizedSource = String(source || "").trim().toLowerCase();
  const isInitiativeStreamWatchCommentarySource =
    normalizedSource.startsWith("stream_watch_brain_turn:") ||
    normalizedSource.startsWith("stream_watch_direct_brain_turn:");
  const useCommentaryModelOverride =
    isStreamWatchCommentary &&
    isInitiativeStreamWatchCommentarySource &&
    commentaryModel &&
    !directAddressed &&
    !isFirstCommentaryTurn;

  const effectiveBinding = useCommentaryModelOverride
    ? {
      provider: commentaryProvider || voiceGenerationBinding.provider,
      model: commentaryModel
    }
    : voiceGenerationBinding;

  const tunedSettings = applyOrchestratorOverrideSettings(settings, {
    provider: effectiveBinding.provider,
    model: effectiveBinding.model,
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
  const voiceThinkingMode = String(voiceConversationPolicy.thinking || "disabled").trim().toLowerCase();
  const voiceThinking: "disabled" | "enabled" | "think_aloud" =
    voiceThinkingMode === "think_aloud" ? "think_aloud"
      : voiceThinkingMode === "enabled" ? "enabled"
        : "disabled";
  const streamingEnabled = Boolean(
    (_streamingSentencesEnabled ?? voiceConversationPolicy.streaming?.enabled) &&
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
      screenWatchActive: Boolean(activeVoiceSession?.streamWatch?.active),
      screenWatchStreamerName,
      screenWatchFrameReady: isStreamWatchFrameReady(activeVoiceSession),
      screenShareSnapshotAvailable: Boolean(
        activeVoiceSession?.streamWatch?.active &&
        String(activeVoiceSession?.streamWatch?.latestFrameDataBase64 || "").trim()
      ),
      nativeDiscordSharers: normalizedNativeDiscordSharers,
      allowMemoryToolCalls,
      allowSoundboardToolCall,
      allowInlineSoundboardDirectives: allowSoundboardToolCall,
      allowVoiceToolCalls: allowVoiceTools,
      musicContext,
      hasDirectVisionFrame: Boolean(streamWatchLatestFrame?.dataBase64),
      durableContext: Array.isArray(activeVoiceSession?.durableContext) ? activeVoiceSession.durableContext : [],
      screenWatchCommentaryEagerness,
      recentToolOutcomes: normalizedRecentToolOutcomes
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
    nativeDiscordSharers: normalizedNativeDiscordSharers,
    recentToolOutcomes: normalizedRecentToolOutcomes,
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
      messageId: null,
      sessionId: sessionId || null
    };

    runtime.store.logAction({
      kind: "voice_runtime",
      guildId,
      channelId,
      userId,
      content: "voice_screen_watch_capability",
      metadata: {
        sessionId,
        source: voiceTrace.source,
        supported: screenShare.supported,
        enabled: screenShare.enabled,
        available: screenShare.available,
        status: screenShare.status,
        reason: screenShare.reason,
        nativeSupported: screenShare.nativeSupported,
        nativeEnabled: screenShare.nativeEnabled,
        nativeAvailable: screenShare.nativeAvailable,
        nativeStatus: screenShare.nativeStatus,
        nativeReason: screenShare.nativeReason,
        linkSupported: screenShare.linkSupported,
        linkEnabled: screenShare.linkEnabled,
        linkFallbackAvailable: screenShare.linkFallbackAvailable,
        linkStatus: screenShare.linkStatus,
        linkReason: screenShare.linkReason,
        toolExposed: allowScreenShareToolCall
      }
    });

    const codeAgentRuntimeAvailable = typeof runtime.runModelRequestedCodeTask === "function";
    const voiceReplyTools = buildReplyToolSet(settings as Record<string, unknown>, {
      webSearchAvailable: allowWebSearchToolCall && webSearchAvailableNow,
      webScrapeAvailable: allowWebSearchToolCall && webSearchAvailableNow,
      browserBrowseAvailable: allowBrowserBrowseToolCall && browserBrowseAvailableNow,
      memoryAvailable: allowMemoryToolCalls,
      imageLookupAvailable: false,
      screenShareAvailable: allowScreenShareToolCall,
      screenShareSnapshotAvailable: Boolean(
        activeVoiceSession?.streamWatch?.active &&
        String(activeVoiceSession?.streamWatch?.latestFrameDataBase64 || "").trim()
      ),
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
      screenShare: {
        ...(typeof runtime.startVoiceScreenWatch === "function"
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
          : {}),
        getSnapshot: () => {
          const sw = activeVoiceSession?.streamWatch;
          if (!sw?.active) return null;
          const dataBase64 = String(sw.latestFrameDataBase64 || "").trim();
          if (!dataBase64) return null;
          const frameAgeMs = Math.max(0, Date.now() - Number(sw.latestFrameAt || 0));
          return {
            mimeType: String(sw.latestFrameMimeType || "image/jpeg"),
            dataBase64,
            streamerName: screenWatchStreamerName || null,
            frameAgeMs
          };
        }
      },
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
      voiceSessionManager: runtime.voiceSessionManager || undefined,
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
    let voiceAddressing = normalizeGeneratedVoiceAddressing(null, {
      currentSpeakerName: speakerName
    });
    let voiceOutputLeaseMode: Exclude<VoiceOutputLeaseMode, "ambient"> | null = null;
    const preserveInlineSoundboardDirectives = allowSoundboardToolCall;
    let streamedRequestedRealtimeUtterance = false;
    const rawTextParts: string[] = [];

    const captureGenerationText = (rawText: unknown) => {
      // Preserve the raw generation text (with [[NOTE:...]] directives intact)
      // so the pipeline can extract and store notes before normalization strips them.
      const rawString = String(rawText || "");
      if (rawString.trim()) rawTextParts.push(rawString);
      const normalized = normalizeVoiceReplyText(rawText, {
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
          thinking: voiceThinking,
          thinkingBudgetTokens: voiceThinking !== "disabled" ? 1024 : undefined,
          trace,
          signal
        });
        const parsedReplyAddressing = parseLeadingReplyAddressingDirective(generation.text, {
          currentSpeakerName: speakerName
        });
        if (hasGeneratedVoiceAddressing(parsedReplyAddressing.voiceAddressing)) {
          voiceAddressing = parsedReplyAddressing.voiceAddressing;
        }
        if (parsedReplyAddressing.voiceOutputLeaseMode) {
          voiceOutputLeaseMode = parsedReplyAddressing.voiceOutputLeaseMode;
        }
        const resolvedSpokenText = normalizeVoiceReplyText(parsedReplyAddressing.text, {
          preserveInlineSoundboardDirectives
        });
        const thinkAloudPrefixNonStream = voiceThinking === "think_aloud" && generation.thinkingText
          ? normalizeVoiceReplyText(generation.thinkingText, { maxLen: 300 })
          : "";
        const resolvedSpokenTextWithThinking = thinkAloudPrefixNonStream
          ? `${thinkAloudPrefixNonStream} ... ${resolvedSpokenText}`
          : resolvedSpokenText;
        return {
          ...generation,
          streamedTextAccepted,
          resolvedSpokenText: resolvedSpokenTextWithThinking
        };
      }

      const baseStreamingMinSentences = Number(voiceConversationPolicy.streaming?.minSentencesPerChunk);
      const baseStreamingEagerFirstChunkChars = Number(voiceConversationPolicy.streaming?.eagerFirstChunkChars);
      const baseStreamingMaxBufferChars = Number(voiceConversationPolicy.streaming?.maxBufferChars);
      const prefersBufferedStreamWatchChunks =
        runtimeEventContext?.category === "screen_share" &&
        String(inputKind || "").trim().toLowerCase() === "event" &&
        !directAddressed;
      const streamingMinSentencesPerChunk = prefersBufferedStreamWatchChunks
        ? Math.max(baseStreamingMinSentences || 0, STREAM_WATCH_STREAMING_MIN_SENTENCES)
        : baseStreamingMinSentences;
      const streamingEagerFirstChunkChars = prefersBufferedStreamWatchChunks
        ? Math.max(baseStreamingEagerFirstChunkChars || 0, STREAM_WATCH_STREAMING_EAGER_FIRST_CHUNK_CHARS)
        : baseStreamingEagerFirstChunkChars;
      const streamingMaxBufferChars = prefersBufferedStreamWatchChunks
        ? Math.max(baseStreamingMaxBufferChars || 0, STREAM_WATCH_STREAMING_MAX_BUFFER_CHARS)
        : baseStreamingMaxBufferChars;

      if (prefersBufferedStreamWatchChunks) {
        runtime.store.logAction({
          kind: "voice_runtime",
          guildId,
          channelId,
          userId,
          content: "voice_streaming_chunk_profile",
          metadata: {
            sessionId: sessionId || null,
            profile: "stream_watch_buffered",
            minSentencesPerChunk: streamingMinSentencesPerChunk,
            eagerFirstChunkChars: streamingEagerFirstChunkChars,
            maxBufferChars: streamingMaxBufferChars
          }
        });
      }

      const accumulator = new SentenceAccumulator({
        eagerFirstChunk: true,
        minSentencesPerChunk: streamingMinSentencesPerChunk,
        eagerMinChars: streamingEagerFirstChunkChars,
        maxBufferChars: streamingMaxBufferChars,
        onSentence(text) {
          const normalized = normalizeVoiceReplyText(text, {
            preserveInlineSoundboardDirectives
          });
          if (!normalized || normalized === "[SKIP]" || signal?.aborted) return;
          streamedDispatchChain = streamedDispatchChain.then(async () => {
            if (signal?.aborted) return;
            const dispatchResult = normalizeSpokenSentenceDispatchResult(
              await onSpokenSentence({
                text: normalized,
                index: streamedSentenceIndex,
                voiceAddressing: voiceAddressing ? { ...voiceAddressing } : null,
                voiceOutputLeaseMode
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
        thinking: voiceThinking,
        thinkingBudgetTokens: voiceThinking !== "disabled" ? 1024 : undefined,
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
          if (consumed.voiceOutputLeaseMode) {
            voiceOutputLeaseMode = consumed.voiceOutputLeaseMode;
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
        if (consumed.voiceOutputLeaseMode) {
          voiceOutputLeaseMode = consumed.voiceOutputLeaseMode;
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
      if (parsedReplyAddressing.voiceOutputLeaseMode) {
        voiceOutputLeaseMode = parsedReplyAddressing.voiceOutputLeaseMode;
      }
      const resolvedSpokenText = normalizeVoiceReplyText(parsedReplyAddressing.text, {
        preserveInlineSoundboardDirectives
      }) || normalizeVoiceReplyText(mergeSpokenReplyText(streamedTextParts), {
        preserveInlineSoundboardDirectives
      });
      const thinkAloudPrefix = voiceThinking === "think_aloud" && generation.thinkingText
        ? normalizeVoiceReplyText(generation.thinkingText, { maxLen: 300 })
        : "";
      const resolvedSpokenTextWithThinking = thinkAloudPrefix
        ? `${thinkAloudPrefix} ... ${resolvedSpokenText}`
        : resolvedSpokenText;
      return {
        ...generation,
        streamedTextAccepted,
        resolvedSpokenText: resolvedSpokenTextWithThinking
      };
    };

    let generation = await runVoiceGeneration({
      userPrompt: initialUserPrompt,
      contextMessages: voiceContextMessages,
      trace: voiceTrace
    });
    captureGenerationText(generation.resolvedSpokenText);

    // Pre-tool speech flush: if the generation produced spoken text AND
    // wants to call tools, dispatch the speech to TTS immediately so the
    // user hears it while tools execute (instead of waiting for the full
    // tool loop to finish, which can take 10-30s for browser/search tools).
    if (
      generation.toolCalls?.length > 0 &&
      !generation.streamedTextAccepted &&
      spokenTextParts.length > 0 &&
      typeof onSpokenSentence === "function" &&
      !signal?.aborted
    ) {
      const preToolText = normalizeVoiceReplyText(mergeSpokenReplyText(spokenTextParts), {
        preserveInlineSoundboardDirectives
      });
      if (preToolText && preToolText !== "[SKIP]") {
        const dispatchResult = normalizeSpokenSentenceDispatchResult(
          await onSpokenSentence({
            text: preToolText,
            index: streamedSentenceIndex,
            voiceAddressing,
            voiceOutputLeaseMode
          })
        );
        if (dispatchResult.accepted) {
          streamedSentenceIndex += 1;
          streamedSentenceCount += 1;
          streamedRequestedRealtimeUtterance =
            streamedRequestedRealtimeUtterance || dispatchResult.requestedRealtimeUtterance;
          appendUniqueStrings(playedSoundboardRefs, dispatchResult.playedSoundboardRefs);
        }
      }
    }

    // Track how many spoken parts existed before the tool loop so we can
    // detect and flush any new speech produced by tool-loop iterations.
    const spokenPartsBeforeToolLoop = spokenTextParts.length;

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
      const generationHasSpokenText = Boolean(stripInlineSoundboardDirectives(generation.resolvedSpokenText));
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
        const toolErrorSummary = result.isError
          ? summarizeVoiceToolError(result.content)
          : null;
        const toolResultSummary = summarizeVoiceToolResult(toolCall.name, result.content);

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
            isError: result.isError || false,
            error: toolErrorSummary,
            toolResultSummary
          }
        });
        if (activeVoiceSession && runtime.voiceSessionManager) {
          recordVoiceToolCallEvent(runtime.voiceSessionManager, {
            session: activeVoiceSession,
            event: {
              callId: String(toolCall.id || "").trim() || `brain_tool_${voiceTotalToolCalls}`,
              toolName: toolCall.name,
              toolType: "function",
              arguments: toolInput,
              startedAt: new Date(toolStartMs).toISOString(),
              completedAt: new Date().toISOString(),
              runtimeMs: toolDurationMs,
              success: !result.isError,
              outputSummary: toolResultSummary,
              error: toolErrorSummary,
              sourceEventType: "voice_brain_tool_call"
            }
          });
        }

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
            if (activeVoiceSession?.warmMemory) {
              invalidateWarmSnapshot(activeVoiceSession.warmMemory);
            }
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

    // Post-tool-loop speech flush: if tool-loop iterations produced spoken
    // text that was NOT already streamed to TTS, dispatch it now so the user
    // actually hears the follow-up (e.g. "Got some options here — want the
    // classic Sweden track?"). Without this, the text ends up in the final
    // replyText but is never played because the pipeline sees
    // streamedSentenceCount > 0 from the initial generation and skips the
    // fallback playback path.
    if (
      voiceToolLoopSteps > 0 &&
      spokenTextParts.length > spokenPartsBeforeToolLoop &&
      typeof onSpokenSentence === "function" &&
      !signal?.aborted
    ) {
      const toolLoopParts = spokenTextParts.slice(spokenPartsBeforeToolLoop);
      const toolLoopText = normalizeVoiceReplyText(mergeSpokenReplyText(toolLoopParts), {
        preserveInlineSoundboardDirectives
      });
      // Only flush if this text was not already dispatched via streaming.
      // If the tool-loop generation was streamed and accepted, the
      // SentenceAccumulator already fired onSpokenSentence for each chunk.
      const toolLoopTextAlreadyStreamed = generation.streamedTextAccepted;
      if (toolLoopText && toolLoopText !== "[SKIP]" && !toolLoopTextAlreadyStreamed) {
        const dispatchResult = normalizeSpokenSentenceDispatchResult(
          await onSpokenSentence({
            text: toolLoopText,
            index: streamedSentenceIndex,
            voiceAddressing,
            voiceOutputLeaseMode
          })
        );
        if (dispatchResult.accepted) {
          streamedSentenceIndex += 1;
          streamedSentenceCount += 1;
          streamedRequestedRealtimeUtterance =
            streamedRequestedRealtimeUtterance || dispatchResult.requestedRealtimeUtterance;
          appendUniqueStrings(playedSoundboardRefs, dispatchResult.playedSoundboardRefs);
        }
      }
    }

    const replyPrompts = buildLoggedPromptBundle(promptCapture, voiceToolLoopSteps);

    const finalText = normalizeVoiceReplyText(mergeSpokenReplyText(spokenTextParts), {
      preserveInlineSoundboardDirectives
    });
    // Raw generation text preserves [[NOTE:...]] directives that normalizeVoiceReplyText
    // strips. The pipeline uses this to extract and store notes for screen watch context.
    const rawText = rawTextParts.join(" ").trim() || "";
    if (!finalText && playedSoundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      return {
        text: "",
        rawText,
        usedWebSearchFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        voiceOutputLeaseMode,
        streamedSentenceCount,
        streamedRequestedRealtimeUtterance,
        generationContextSnapshot,
        replyPrompts
      };
    }
    if (!finalText) {
      const response = {
        text: "",
        rawText,
        playedSoundboardRefs,
        usedWebSearchFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        voiceOutputLeaseMode,
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
      rawText,
      playedSoundboardRefs,
      usedWebSearchFollowup,
      usedScreenShareOffer,
      voiceAddressing,
      voiceOutputLeaseMode,
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

function normalizeGeneratedVoiceOutputLease(rawOutputLease: unknown) {
  const normalizedRaw =
    rawOutputLease && typeof rawOutputLease === "object" && !Array.isArray(rawOutputLease)
      ? rawOutputLease as Record<string, unknown>
      : null;
  const normalizedMode = String(normalizedRaw?.mode || "")
    .trim()
    .toLowerCase();
  if (normalizedMode === "atomic") {
    return { mode: "atomic" } satisfies GeneratedVoiceOutputLease;
  }
  if (normalizedMode === "assertive") {
    return { mode: "assertive" } satisfies GeneratedVoiceOutputLease;
  }
  return null;
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

const SCREEN_WATCH_TOOL_HARD_BLOCK_REASONS = new Set([
  "screen_watch_capability_unavailable",
  "screen_watch_unavailable",
  "screen_watch_context_unavailable",
  "session_not_found",
  "requester_not_in_same_vc",
  "stream_watch_provider_unavailable",
  "native_discord_video_decode_unavailable",
  "stream_watch_disabled"
]);

function shouldExposeVoiceScreenWatchTool(
  screenShare: {
    supported?: boolean;
    enabled?: boolean;
    available?: boolean;
    nativeSupported?: boolean;
    nativeEnabled?: boolean;
    nativeAvailable?: boolean;
    nativeReason?: string | null;
    reason?: string | null;
  },
  {
    canStartScreenWatch,
    guildId,
    userId
  }: {
    canStartScreenWatch: boolean;
    guildId: string | null | undefined;
    userId: string | null | undefined;
  }
) {
  if (!canStartScreenWatch || !guildId || !userId) return false;
  const nativeSupported =
    screenShare.nativeSupported === undefined
      ? Boolean(screenShare.supported)
      : Boolean(screenShare.nativeSupported);
  const nativeEnabled =
    screenShare.nativeEnabled === undefined
      ? Boolean(screenShare.enabled)
      : Boolean(screenShare.nativeEnabled);
  if (!nativeSupported || !nativeEnabled) return false;
  if (screenShare.nativeAvailable) return true;
  const nativeReason = String(screenShare.nativeReason || screenShare.reason || "").trim().toLowerCase();
  if (!nativeReason) return true;
  return !SCREEN_WATCH_TOOL_HARD_BLOCK_REASONS.has(nativeReason);
}
