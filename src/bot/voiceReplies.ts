import { buildSystemPrompt, buildVoiceTurnPrompt } from "../prompts/index.ts";
import {
  buildHardLimitsSection,
  DEFAULT_PROMPT_VOICE_OPERATIONAL_GUIDANCE,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptVoiceOperationalGuidance,
  getPromptStyle,
  buildVoiceToneGuardrails
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
import { clamp, sanitizeBotText } from "../utils.ts";
import { loadConversationContinuityContext } from "./conversationContinuity.ts";
import {
  applyOrchestratorOverrideSettings,
  getDirectiveSettings,
  getMemorySettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding,
  getReplyGenerationSettings,
  getVoiceConversationPolicy,
  getVoiceSoundboardSettings
} from "../settings/agentStack.ts";
import {
  buildContextContentBlocks,
  type ContentBlock,
  type ContextMessage
} from "../llm/serviceShared.ts";
import type { VoiceReplyRuntime } from "./botContext.ts";
import { normalizeFactProfileSlice } from "./memorySlice.ts";
import { SentenceAccumulator } from "../voice/sentenceAccumulator.ts";

const OPEN_ARTICLE_MAX_CANDIDATES = 12;
const OPEN_ARTICLE_ROW_LIMIT = 4;
const OPEN_ARTICLE_RESULTS_PER_ROW = 5;
const SESSION_DURABLE_CONTEXT_MAX_ENTRIES = 50;

type SessionDurableContextCategory = "fact" | "plan" | "preference" | "relationship";

function runAsyncCallback(callback: unknown, payload: Record<string, unknown>, callbackName: string) {
  if (typeof callback !== "function") return;
  try {
    const maybePromise = callback(payload);
    if (
      maybePromise &&
      typeof maybePromise === "object" &&
      "catch" in maybePromise &&
      typeof maybePromise.catch === "function"
    ) {
      maybePromise.catch((error: unknown) => {
        console.error(`[voiceReplies] ${callbackName} callback failed:`, error);
      });
    }
  } catch (error) {
    console.error(`[voiceReplies] ${callbackName} callback threw:`, error);
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
  voiceEagerness = 0,
  conversationContext = null,
  participantRoster = [],
  recentMembershipEvents = [],
  recentVoiceEffectEvents = [],
  soundboardCandidates = [],
  streamWatchLatestFrame = null,
  streamWatchDurableScreenNotes = [],
  onWebLookupStart = null,
  onWebLookupComplete = null,
  webSearchTimeoutMs: _webSearchTimeoutMs = null,
  voiceToolCallbacks = null,
  onSpokenSentence = null,
  signal = undefined
}) {
  if (!runtime.llm?.generate || !settings) return { text: "" };
  const normalizedInputKind = String(inputKind || "").trim().toLowerCase() === "event"
    ? "event"
    : "transcript";
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
  const allowSoundboardToolCall = Boolean(
    getVoiceSoundboardSettings(settings).enabled && normalizedSoundboardCandidates.length
  );
  const allowMemoryToolCalls = Boolean(getMemorySettings(settings).enabled);
  const allowAdaptiveDirectiveToolCalls = Boolean(getDirectiveSettings(settings).enabled);
  const allowWebSearchToolCall = Boolean(
    typeof runtime.search?.searchAndRead === "function"
  );
  const allowBrowserBrowseToolCall = Boolean(
    typeof runtime.runModelRequestedBrowserBrowse === "function" &&
    typeof runtime.buildBrowserBrowseContext === "function"
  );
  const allowOpenArticleToolCall = Boolean(typeof runtime.search?.readPageSummary === "function");
  const screenShare = resolveVoiceScreenShareCapability(runtime, {
    settings,
    guildId,
    channelId,
    userId
  });
  const allowScreenShareToolCall = Boolean(
    screenShare.available &&
    typeof runtime.offerVoiceScreenShareLink === "function" &&
    guildId &&
    channelId &&
    userId
  );
  const activeVoiceSession =
    sessionId && typeof runtime.voiceSessionManager?.getSessionById === "function"
      ? runtime.voiceSessionManager.getSessionById(sessionId)
      : null;
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

  const continuity = await loadConversationContinuityContext({
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
    source: "voice_stt_pipeline_generation",
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
    loadRecentLookupContext:
      typeof runtime.loadRecentLookupContext === "function"
        ? (payload) => runtime.loadRecentLookupContext(payload)
        : null,
    loadRecentConversationHistory:
      typeof runtime.loadRecentConversationHistory === "function"
        ? (payload) => runtime.loadRecentConversationHistory(payload)
        : null,
    loadAdaptiveDirectives:
      allowAdaptiveDirectiveToolCalls &&
      typeof runtime.store?.searchAdaptiveStyleNotesForPrompt === "function"
        ? (payload) =>
            runtime.store.searchAdaptiveStyleNotesForPrompt({
              guildId: String(payload.guildId || "").trim(),
              queryText: String(payload.queryText || ""),
              limit: 8
            })
        : null
  });
  const promptMemorySlice = normalizeFactProfileSlice(continuity.memorySlice);
  const recentWebLookups = continuity.recentWebLookups;
  const recentConversationHistory = continuity.recentConversationHistory;
  const adaptiveDirectives = Array.isArray(continuity.adaptiveDirectives) ? continuity.adaptiveDirectives : [];

  const voiceGenerationBinding = getResolvedVoiceGenerationBinding(settings);
  const replyGeneration = getReplyGenerationSettings(settings);
  const tunedSettings = applyOrchestratorOverrideSettings(settings, {
    provider: voiceGenerationBinding.provider,
    model: voiceGenerationBinding.model,
    temperature: clamp(Number(replyGeneration.temperature) || 0.8, 0, 1.2),
    // Voice-turn JSON with actionable voiceIntent fields needs more headroom
    // than plain spoken-text replies to avoid truncating the closing schema.
    maxOutputTokens: clamp(Number(replyGeneration.maxOutputTokens) || 320, 40, 420)
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
  const openArticleCandidates = buildOpenArticleCandidates({
    webSearch,
    recentWebLookups
  });
  const openedArticle = null;
  const voiceConversationPolicy = getVoiceConversationPolicy(settings);
  const streamingEnabled = Boolean(
    voiceConversationPolicy.streaming?.enabled &&
    typeof onSpokenSentence === "function" &&
    typeof runtime.llm?.generateStreaming === "function"
  );
  let usedWebSearchFollowup = false;
  let usedOpenArticleFollowup = false;
  let usedScreenShareOffer = false;
  let leaveVoiceChannelRequested = false;

  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const systemPrompt = [
    buildSystemPrompt(settings, {
      adaptiveDirectives
    }),
    "You are speaking in live Discord voice chat.",
    ...voiceToneGuardrails,
    directAddressed
      ? "This speaker directly addressed you. Prefer a spoken response unless the transcript is too unclear."
      : isEagerTurn
        ? "If responding would be an interruption or you have nothing to add, output exactly [SKIP]. Otherwise reply with natural spoken text."
        : "You are not directly addressed. Reply only if you can add clear value; otherwise output exactly [SKIP].",
    "Goodbyes do not force exit. You can say goodbye and stay in VC; call leave_voice_channel only when you intentionally choose to end your own VC session now.",
    allowSoundboardToolCall ? "Never mention soundboard control refs in normal speech." : null
  ]
    .filter(Boolean)
    .join("\n");
  const buildVoiceUserPrompt = ({
    webSearchContext = webSearch,
    allowWebSearch = allowWebSearchToolCall,
    openArticleCandidatesContext = openArticleCandidates,
    openedArticleContext = openedArticle,
    allowOpenArticle = allowOpenArticleToolCall
  } = {}) =>
    buildVoiceTurnPrompt({
      inputKind: normalizedInputKind,
      speakerName,
      transcript: incomingTranscript,
      directAddressed,
      userFacts: promptMemorySlice.userFacts,
      relevantFacts: promptMemorySlice.relevantFacts,
      isEagerTurn,
      voiceEagerness,
      conversationContext,
      sessionTiming,
      botName: getPromptBotName(settings),
      participantRoster: normalizedParticipantRoster,
      recentMembershipEvents: normalizedMembershipEvents,
      recentVoiceEffectEvents: normalizedVoiceEffectEvents,
      soundboardCandidates: normalizedSoundboardCandidates,
      webSearch: webSearchContext,
      browserBrowse,
      recentConversationHistory,
      recentWebLookups,
      openArticleCandidates: openArticleCandidatesContext,
      openedArticle: openedArticleContext,
      allowWebSearchToolCall: allowWebSearch,
      allowBrowserBrowseToolCall,
      allowOpenArticleToolCall: allowOpenArticle,
      screenShare,
      allowScreenShareToolCall,
      allowMemoryToolCalls,
      allowAdaptiveDirectiveToolCalls,
      allowSoundboardToolCall,
      allowVoiceToolCalls: Boolean(voiceToolCallbacks),
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
    participantRoster: normalizedParticipantRoster,
    membershipEvents: normalizedMembershipEvents,
    effectEvents: normalizedVoiceEffectEvents,
    memoryFacts: {
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
      openArticle: allowOpenArticleToolCall,
      screenShare: allowScreenShareToolCall,
      memory: allowMemoryToolCalls,
      adaptiveDirectives: allowAdaptiveDirectiveToolCalls
    },
    soundboardCandidateCount: normalizedSoundboardCandidates.length,
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
      source: "voice_stt_pipeline_generation",
      event: sessionId ? "voice_session" : "voice_turn",
      reason: null,
      messageId: null
    };

    const codeAgentRuntimeAvailable = typeof runtime.runModelRequestedCodeTask === "function";
    const voiceReplyTools = buildReplyToolSet(settings as Record<string, unknown>, {
      webSearchAvailable: allowWebSearchToolCall && webSearchAvailableNow,
      browserBrowseAvailable: allowBrowserBrowseToolCall && browserBrowseAvailableNow,
      memoryAvailable: allowMemoryToolCalls,
      adaptiveDirectivesAvailable: allowAdaptiveDirectiveToolCalls,
      imageLookupAvailable: false,
      openArticleAvailable: allowOpenArticleToolCall && openArticleCandidates.length > 0,
      screenShareAvailable: allowScreenShareToolCall,
      soundboardAvailable: allowSoundboardToolCall,
      codeAgentAvailable: codeAgentRuntimeAvailable,
      voiceToolsAvailable: Boolean(voiceToolCallbacks)
    });

    const voiceToolRuntime: ReplyToolRuntime = {
      search: {
        searchAndRead: async ({ settings: toolSettings, query, trace }) =>
          await runtime.search.searchAndRead({
            settings: toolSettings,
            query,
            trace: {
              guildId: trace.guildId ?? null,
              channelId: trace.channelId ?? null,
              userId: trace.userId ?? null,
              source: trace.source ?? null
            }
          }),
        readPageSummary:
          typeof runtime.search.readPageSummary === "function"
            ? async (url, maxChars) => await runtime.search.readPageSummary(url, maxChars)
            : undefined
      },
      browser: {
        browse: async ({ settings: toolSettings, query, guildId, channelId, userId, source }) =>
          await runtime.runModelRequestedBrowserBrowse({
            settings: toolSettings,
            browserBrowse,
            query,
            guildId,
            channelId,
            userId,
            source
          })
      },
      screenShare:
        typeof runtime.offerVoiceScreenShareLink === "function"
          ? {
              offerLink: async ({ settings: toolSettings, guildId, channelId, requesterUserId, transcript, source }) =>
                await runtime.offerVoiceScreenShareLink({
                  settings: toolSettings,
                  guildId,
                  channelId,
                  requesterUserId,
                  transcript,
                  source
                })
            }
          : undefined,
      voiceSessionControl: {
        requestLeaveVoiceChannel: async () => ({ ok: true })
      },
      codeAgent: runtime.runModelRequestedCodeTask ? {
        runTask: async ({ settings: toolSettings, task, cwd, guildId, channelId, userId, source }) =>
          await runtime.runModelRequestedCodeTask({
            settings: toolSettings,
            task,
            cwd,
            guildId,
            channelId,
            userId,
            source
          })
      } : undefined,
      memory: runtime.memory,
      store: runtime.store,
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
      trace: voiceTrace
    };

    const initialUserPrompt = buildVoiceUserPrompt();
    let voiceContextMessages: ContextMessage[] = [
      ...normalizedContextMessages
    ];

    const voiceImageInputs =
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
      directAddressed: Boolean(directAddressed)
    });

    const captureGenerationText = (rawText: unknown) => {
      const normalized = sanitizeBotText(normalizeSkipSentinel(String(rawText || "")), 520);
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
      if (!streamingEnabled) {
        return await runtime.llm.generate({
          settings: tunedSettings,
          systemPrompt,
          userPrompt,
          imageInputs: voiceImageInputs,
          contextMessages,
          tools: voiceReplyTools,
          trace,
          signal
        });
      }

      const accumulator = new SentenceAccumulator({
        eagerFirstChunk: true,
        eagerMinChars: Number(voiceConversationPolicy.streaming?.eagerFirstChunkChars),
        maxBufferChars: Number(voiceConversationPolicy.streaming?.maxBufferChars),
        onSentence(text) {
          const normalized = sanitizeBotText(normalizeSkipSentinel(text), 520);
          if (!normalized || normalized === "[SKIP]" || signal?.aborted) return;
          const accepted = onSpokenSentence({
            text: normalized,
            index: streamedSentenceIndex
          });
          if (accepted === false) return;
          streamedSentenceIndex += 1;
          streamedSentenceCount += 1;
        }
      });

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
          accumulator.push(delta);
        }
      });
      accumulator.flush();
      return generation;
    };

    let generation = await runVoiceGeneration({
      userPrompt: initialUserPrompt,
      contextMessages: voiceContextMessages,
      trace: voiceTrace
    });
    captureGenerationText(generation.text);

    const VOICE_TOOL_LOOP_MAX_STEPS = 2;
    const VOICE_TOOL_LOOP_MAX_CALLS = 6;
    let voiceToolLoopSteps = 0;
    let voiceTotalToolCalls = 0;
    let webLookupStarted = false;

    while (
      generation.toolCalls?.length > 0 &&
      voiceToolLoopSteps < VOICE_TOOL_LOOP_MAX_STEPS &&
      voiceTotalToolCalls < VOICE_TOOL_LOOP_MAX_CALLS
    ) {
      const assistantContent = buildContextContentBlocks(generation.rawContent, generation.text);
      voiceContextMessages = [
        ...voiceContextMessages,
        { role: "user", content: initialUserPrompt },
        { role: "assistant", content: assistantContent }
      ];

      const toolResultMessages: ContentBlock[] = [];
      for (const toolCall of generation.toolCalls) {
        if (voiceTotalToolCalls >= VOICE_TOOL_LOOP_MAX_CALLS) break;
        voiceTotalToolCalls += 1;

        if (toolCall.name === "web_search" && !webLookupStarted && typeof onWebLookupStart === "function") {
          webLookupStarted = true;
          runAsyncCallback(onWebLookupStart, {
            query: String((toolCall.input as Record<string, unknown>)?.query || ""),
            guildId,
            channelId,
            userId
          }, "onWebLookupStart");
        }

        const toolInput = toolCall.input as Record<string, unknown>;
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
              })
            };
          })()
          : await executeReplyTool(
            toolCall.name,
            toolInput,
            voiceToolRuntime,
            voiceToolContext
          );

        if (toolCall.name === "web_search" && !result.isError) {
          usedWebSearchFollowup = true;
        }
        if (toolCall.name === "open_article" && !result.isError) {
          usedOpenArticleFollowup = true;
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
        if (toolCall.name === "set_addressing" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          voiceAddressing = normalizeGeneratedVoiceAddressing({
            talkingTo: toolPayload?.talkingTo,
            directedConfidence: toolPayload?.directedConfidence
          }, {
            directAddressed: Boolean(directAddressed)
          });
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
        if (toolCall.name === "offer_screen_share_link" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          usedScreenShareOffer = usedScreenShareOffer || Boolean(toolPayload?.offered);
        }
        if (toolCall.name === "leave_voice_channel" && !result.isError) {
          const toolPayload = parseReplyToolResultPayload(result.content);
          leaveVoiceChannelRequested = leaveVoiceChannelRequested || Boolean(toolPayload?.ok);
        }

        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }

      voiceContextMessages = [
        ...voiceContextMessages,
        { role: "user", content: toolResultMessages }
      ];

      generation = await runVoiceGeneration({
        userPrompt: "",
        contextMessages: voiceContextMessages,
        trace: {
          ...voiceTrace,
          event: `${sessionId ? "voice_session" : "voice_turn"}:tool_loop:${voiceToolLoopSteps + 1}`
        },
      });
      captureGenerationText(generation.text);
      voiceToolLoopSteps += 1;
    }

    if (webLookupStarted && typeof onWebLookupComplete === "function") {
      runAsyncCallback(onWebLookupComplete, {
        query: "",
        guildId,
        channelId,
        userId
      }, "onWebLookupComplete");
    }

    const finalText = sanitizeBotText(mergeSpokenReplyText(spokenTextParts), 520);
    if (!finalText && playedSoundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      return {
        text: "",
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        screenNote,
        screenMoment,
        streamedSentenceCount,
        generationContextSnapshot
      };
    }
    if (!finalText) {
      const response = {
        text: "",
        playedSoundboardRefs,
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        voiceAddressing,
        screenNote,
        screenMoment,
        streamedSentenceCount,
        generationContextSnapshot
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
      usedOpenArticleFollowup,
      usedScreenShareOffer,
      voiceAddressing,
      screenNote,
      screenMoment,
      streamedSentenceCount,
      generationContextSnapshot
    };
    if (leaveVoiceChannelRequested) {
      return {
        ...response,
        leaveVoiceChannelRequested: true
      };
    }
    return response;
  } catch (error) {
    runtime.store.logAction({
      kind: "voice_error",
      guildId,
      channelId,
      userId,
      content: `voice_stt_generation_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId
      }
    });
    return { text: "", generationContextSnapshot: null };
  }
}

function normalizeGeneratedVoiceAddressing(rawAddressing, { directAddressed = false } = {}) {
  const normalizedRaw = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
  const talkingToToken = String(normalizedRaw?.talkingTo || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  let talkingTo = talkingToToken || null;

  const directedConfidenceRaw = Number(normalizedRaw?.directedConfidence);
  let directedConfidence = Number.isFinite(directedConfidenceRaw) ? clamp(directedConfidenceRaw, 0, 1) : 0;

  if (directAddressed && !talkingTo) {
    talkingTo = "ME";
  }
  if (directAddressed && talkingTo === "ME") {
    directedConfidence = Math.max(directedConfidence, 0.72);
  }

  return {
    talkingTo,
    directedConfidence
  };
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

function resolveVoiceScreenShareCapability(runtime, { settings, guildId, channelId, userId }) {
  if (typeof runtime?.getVoiceScreenShareCapability !== "function") {
    return {
      supported: false,
      enabled: false,
      available: false,
      status: "disabled",
      publicUrl: "",
      reason: "screen_share_capability_unavailable"
    };
  }

  const capability = runtime.getVoiceScreenShareCapability({
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
      ? rawReason !== "screen_share_manager_unavailable"
      : Boolean(capability.supported);
  return {
    supported,
    enabled,
    available,
    status,
    publicUrl: String(capability?.publicUrl || "").trim(),
    reason: available ? null : rawReason || status || "unavailable"
  };
}

function buildOpenArticleCandidates({ webSearch, recentWebLookups }) {
  const candidates = [];
  const seenUrls = new Set();
  const pushCandidate = ({
    ref,
    title,
    url,
    domain,
    query
  }) => {
    const normalizedRef = String(ref || "").trim();
    const normalizedUrl = String(url || "").trim();
    if (!normalizedRef || !normalizedUrl || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    candidates.push({
      ref: normalizedRef,
      title: String(title || "untitled").trim() || "untitled",
      url: normalizedUrl,
      domain: String(domain || "").trim(),
      query: String(query || "").trim()
    });
  };

  const currentResults = (Array.isArray(webSearch?.results) ? webSearch.results : [])
    .slice(0, OPEN_ARTICLE_RESULTS_PER_ROW);
  for (let index = 0; index < currentResults.length; index += 1) {
    const row = currentResults[index];
    const url = String(row?.url || "").trim();
    if (!url) continue;
    pushCandidate({
      ref: `R0:${index + 1}`,
      title: row?.title,
      url,
      domain: row?.domain,
      query: webSearch?.query || ""
    });
  }

  const cachedRows = (Array.isArray(recentWebLookups) ? recentWebLookups : []).slice(0, OPEN_ARTICLE_ROW_LIMIT);
  for (let rowIndex = 0; rowIndex < cachedRows.length; rowIndex += 1) {
    const row = cachedRows[rowIndex];
    const rowResults = (Array.isArray(row?.results) ? row.results : []).slice(0, OPEN_ARTICLE_RESULTS_PER_ROW);
    for (let resultIndex = 0; resultIndex < rowResults.length; resultIndex += 1) {
      const result = rowResults[resultIndex];
      const url = String(result?.url || "").trim();
      if (!url) continue;
      pushCandidate({
        ref: `R${rowIndex + 1}:${resultIndex + 1}`,
        title: result?.title,
        url,
        domain: result?.domain,
        query: row?.query
      });
    }
  }

  if (!candidates.length) return [];
  const first = candidates[0];
  const withAliases = [first, ...candidates.slice(1)];
  if (first) {
    withAliases.unshift({
      ...first,
      ref: "first"
    });
  }
  return withAliases.slice(0, OPEN_ARTICLE_MAX_CANDIDATES);
}
