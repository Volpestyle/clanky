import { clamp } from "../utils.ts";
import {
  applyOrchestratorOverrideSettings,
  getMemorySettings,
  getResolvedOrchestratorBinding,
  getVoiceConversationPolicy,
  getVoiceInitiativeSettings
} from "../settings/agentStack.ts";
import { getPromptBotName, buildVoiceToneGuardrails } from "../prompts/promptCore.ts";
import { buildSystemPrompt } from "../prompts/promptFormatters.ts";
import { normalizeLlmProvider } from "../llm/llmHelpers.ts";
import {
  parseVoiceThoughtDecisionContract
} from "./voiceDecisionRuntime.ts";
import {
  extractSoundboardDirective,
  formatRealtimeMemoryFacts,
  isRealtimeMode,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import {
  resolveSystemSpeechReplyAccountingOnLocalPlayback,
  resolveSystemSpeechReplyAccountingOnRequest,
  SYSTEM_SPEECH_SOURCE
} from "./systemSpeechOpportunity.ts";
import {
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS,
  VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
  VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
  VOICE_THOUGHT_MAX_CHARS,
  VOICE_THOUGHT_MEMORY_SEARCH_LIMIT
} from "./voiceSessionManager.constants.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

type ThoughtSettings = Record<string, unknown> | null;

export interface VoiceThoughtEngineConfig {
  enabled: boolean;
  provider: string;
  model: string;
  temperature: number;
  eagerness: number;
  minSilenceSeconds: number;
  minSecondsBetweenThoughts: number;
}

export interface VoiceThoughtTopicalityBias {
  silenceSeconds: number;
  topicTetherStrength: number;
  randomInspirationStrength: number;
  phase: string;
  topicalStartSeconds: number;
  fullDriftSeconds: number;
  promptHint: string;
}

export interface VoiceThoughtDecision {
  allow: boolean;
  reason: string;
  finalThought: string;
  memoryFactCount: number;
  usedMemory: boolean;
  llmResponse?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  error?: string | null;
}

type ThoughtGenerateResult = {
  text?: string | null;
  provider?: string | null;
  model?: string | null;
};

type ThoughtMemoryRow = {
  fact?: string | null;
  [key: string]: unknown;
};

type ThoughtStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface VoiceThoughtGenerationHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: ThoughtStoreLike;
  llm?: {
    generate?: (args: {
      settings: ThoughtSettings;
      systemPrompt: string;
      userPrompt: string;
      contextMessages: unknown[];
      jsonSchema?: string;
      trace?: Record<string, unknown>;
    }) => Promise<ThoughtGenerateResult>;
  } | null;
  memory?: {
    searchDurableFacts?: (args: {
      guildId?: string | null;
      channelId?: string | null;
      queryText: string;
      settings: ThoughtSettings;
      trace?: Record<string, unknown>;
      limit?: number;
    }) => Promise<ThoughtMemoryRow[]>;
  } | null;
  getVoiceChannelParticipants: (
    session: VoiceSession
  ) => Array<{ userId: string; displayName: string }>;
  formatVoiceDecisionHistory: (
    session: VoiceSession,
    maxTurns?: number,
    maxTotalChars?: number
  ) => string;
  resolveVoiceThoughtTopicalityBias: (args: {
    silenceMs?: number;
    minSilenceSeconds?: number;
    minSecondsBetweenThoughts?: number;
  }) => VoiceThoughtTopicalityBias;
  requestRealtimeTextUtterance: (args: {
    session: VoiceSession;
    text: string;
    userId?: string | null;
    source?: string;
  }) => boolean;
  speakVoiceLineWithTts: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    text: string;
    source?: string;
  }) => Promise<boolean>;
  recordVoiceTurn: (session: VoiceSession, args: {
    role?: "assistant" | "user";
    userId?: string | null;
    text?: string;
  }) => void;
}

function collectSessionGuidanceFacts(session: VoiceSession) {
  const guildGuidance = Array.isArray(session?.guildFactProfile?.guidanceFacts)
    ? session.guildFactProfile.guidanceFacts
    : [];
  const participantGuidance = session?.factProfiles instanceof Map
    ? [...session.factProfiles.values()].flatMap((profile) =>
        Array.isArray(profile?.guidanceFacts) ? profile.guidanceFacts : []
      )
    : [];
  const seenFacts = new Set<string>();
  return [...guildGuidance, ...participantGuidance].filter((row) => {
    const factText = normalizeVoiceText(row?.fact || "", 180).toLowerCase();
    if (!factText || seenFacts.has(factText)) return false;
    seenFacts.add(factText);
    return true;
  });
}

export function resolveVoiceThoughtEngineConfig(settings: ThoughtSettings = null): VoiceThoughtEngineConfig {
  const thoughtEngine = getVoiceInitiativeSettings(settings);
  const orchestrator = getResolvedOrchestratorBinding(settings);
  const enabled = Boolean(thoughtEngine.enabled);
  const provider = normalizeLlmProvider(orchestrator.provider, "anthropic");
  const model = String(orchestrator.model || "").trim().slice(0, 120) || "claude-opus-4-6";
  const temperature = clamp(0.8, 0, 2);
  const eagerness = clamp(Number(thoughtEngine.eagerness) || 0, 0, 100);
  const minSilenceSeconds = clamp(
    Number(thoughtEngine.minSilenceSeconds) || 20,
    VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
  );
  const minSecondsBetweenThoughts = clamp(
    Number(thoughtEngine.minSecondsBetweenThoughts) || minSilenceSeconds,
    VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS
  );

  return {
    enabled,
    provider,
    model,
    temperature,
    eagerness,
    minSilenceSeconds,
    minSecondsBetweenThoughts
  };
}

export async function generateVoiceThoughtCandidate(
  host: VoiceThoughtGenerationHost,
  {
    session,
    settings,
    config,
    trigger = "timer"
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    config?: VoiceThoughtEngineConfig | null;
    trigger?: string;
  }
) {
  if (!session || session.ending) return "";
  if (!host.llm?.generate) return "";

  const thoughtConfig = config || resolveVoiceThoughtEngineConfig(settings);
  const participants = host.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
  const recentHistory = host.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
  const thoughtEagerness = clamp(Number(thoughtConfig.eagerness) || 0, 0, 100);
  const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
  const topicalityBias = host.resolveVoiceThoughtTopicalityBias({
    silenceMs,
    minSilenceSeconds: thoughtConfig.minSilenceSeconds,
    minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
  });
  const guidanceFacts = collectSessionGuidanceFacts(session);
  const systemPrompt = [
    buildSystemPrompt(settings),
    "You are speaking in live Discord voice chat.",
    ...buildVoiceToneGuardrails(),
    "=== AUTONOMOUS THOUGHT MODE ===",
    "Nobody is speaking to you right now. You are deciding whether to say something on your own initiative.",
    "Draft exactly one short natural spoken line that might fit right now — or output exactly [SKIP] if silence is better.",
    "As silence grows, rely less on old-topic callbacks and more on fresh standalone lines.",
    "When topic tether is low, avoid stale references that require shared context (vague that/they/it callbacks).",
    "No markdown, no quotes, no meta commentary."
  ].join("\n");
  const userPromptParts = [
    `Current humans in VC: ${participants.length || 0}.`,
    participants.length ? `Participant names: ${participants.slice(0, 12).join(", ")}.` : "Participant names: none.",
    `Thought eagerness setting: ${thoughtEagerness}/100.`,
    `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
    `Topic tether strength: ${topicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
    `Random inspiration strength: ${topicalityBias.randomInspirationStrength}/100.`,
    `Topic drift phase: ${topicalityBias.phase}.`,
    `Topic drift guidance: ${topicalityBias.promptHint}`,
    "Goal: seed a light initiative line that can keep conversation moving without forcing it."
  ];
  if (recentHistory) {
    userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
  }
  const behaviorGuidance = formatRealtimeMemoryFacts(guidanceFacts, 8);
  if (behaviorGuidance) {
    userPromptParts.push(`Behavior guidance: ${behaviorGuidance}`);
  }
  const userPrompt = userPromptParts.join("\n");
  const generationSettings = applyOrchestratorOverrideSettings(settings, {
    provider: thoughtConfig.provider,
    model: thoughtConfig.model,
    temperature: thoughtConfig.temperature,
    maxOutputTokens: 96
  });

  const generation = await host.llm.generate({
    settings: generationSettings,
    systemPrompt,
    userPrompt,
    contextMessages: [],
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      source: "voice_thought_generation",
      event: String(trigger || "timer")
    }
  });
  const thoughtRaw = String(generation?.text || "").trim();
  const thoughtNoDirective = extractSoundboardDirective(thoughtRaw).text;
  const thoughtCandidate = normalizeVoiceText(thoughtNoDirective, VOICE_THOUGHT_MAX_CHARS);
  if (!thoughtCandidate || thoughtCandidate === "[SKIP]") {
    return "";
  }
  return thoughtCandidate;
}

export async function loadVoiceThoughtMemoryFacts(
  host: VoiceThoughtGenerationHost,
  {
    session,
    settings,
    thoughtCandidate
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
  }
) {
  if (!session || session.ending) return [];
  if (!getMemorySettings(settings).enabled) return [];
  if (!host.memory || typeof host.memory.searchDurableFacts !== "function") return [];

  const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
  if (!normalizedThought) return [];
  const recentHistory = host.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
  const queryText = normalizeVoiceText(
    [normalizedThought, recentHistory].filter(Boolean).join("\n"),
    STT_TRANSCRIPT_MAX_CHARS
  );
  if (!queryText) return [];

  try {
    const results = await host.memory.searchDurableFacts({
      guildId: session.guildId,
      channelId: session.textChannelId || null,
      queryText,
      settings,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        source: "voice_thought_memory_search"
      },
      limit: VOICE_THOUGHT_MEMORY_SEARCH_LIMIT
    });

    const rows = Array.isArray(results) ? results : [];
    const deduped: ThoughtMemoryRow[] = [];
    const seenFacts = new Set<string>();
    for (const row of rows) {
      const factText = normalizeVoiceText(row?.fact || "", 180);
      if (!factText) continue;
      const dedupeKey = factText.toLowerCase();
      if (seenFacts.has(dedupeKey)) continue;
      seenFacts.add(dedupeKey);
      deduped.push(row);
      if (deduped.length >= VOICE_THOUGHT_MEMORY_SEARCH_LIMIT) break;
    }
    return deduped;
  } catch (error) {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: `voice_thought_memory_search_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id
      }
    });
    return [];
  }
}

export async function evaluateVoiceThoughtDecision(
  host: VoiceThoughtGenerationHost,
  {
    session,
    settings,
    thoughtCandidate,
    memoryFacts = [],
    topicalityBias = null
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    memoryFacts?: ThoughtMemoryRow[];
    topicalityBias?: VoiceThoughtTopicalityBias | null;
  }
): Promise<VoiceThoughtDecision> {
  const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
  if (!normalizedThought) {
    return {
      allow: false,
      reason: "empty_thought_candidate",
      finalThought: "",
      usedMemory: false,
      memoryFactCount: 0
    };
  }

  const orchestrator = getResolvedOrchestratorBinding(settings);
  if (!host.llm?.generate) {
    return {
      allow: false,
      reason: "llm_generate_unavailable",
      finalThought: "",
      usedMemory: false,
      memoryFactCount: 0
    };
  }

  const llmProvider = normalizeLlmProvider(orchestrator.provider, "anthropic");
  const llmModel = String(orchestrator.model || "").trim().slice(0, 120) || "claude-opus-4-6";
  const participants = host.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
  const recentHistory = host.formatVoiceDecisionHistory(session, 8, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
  const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
  const resolvedThoughtConfig = resolveVoiceThoughtEngineConfig(settings);
  const resolvedTopicalityBias =
    topicalityBias && typeof topicalityBias === "object"
      ? topicalityBias
      : host.resolveVoiceThoughtTopicalityBias({
        silenceMs,
        minSilenceSeconds: resolvedThoughtConfig.minSilenceSeconds,
        minSecondsBetweenThoughts: resolvedThoughtConfig.minSecondsBetweenThoughts
      });
  const thoughtEagerness = clamp(Number(resolvedThoughtConfig.eagerness) || 0, 0, 100);
  const ambientMemoryFacts = Array.isArray(memoryFacts) ? memoryFacts : [];
  const ambientMemory = formatRealtimeMemoryFacts(ambientMemoryFacts, VOICE_THOUGHT_MEMORY_SEARCH_LIMIT);
  const guidanceFacts = collectSessionGuidanceFacts(session);
  const behaviorGuidance = formatRealtimeMemoryFacts(guidanceFacts, 8);

  const systemPrompt = [
    buildSystemPrompt(settings),
    "You are speaking in live Discord voice chat.",
    ...buildVoiceToneGuardrails(),
    "=== THOUGHT REFINEMENT MODE ===",
    "You drafted an autonomous thought to say during a lull. Now decide: should you actually say it?",
    "Return strict JSON with keys: allow (boolean), finalThought (string), usedMemory (boolean), reason (string).",
    "If allow is true, finalThought must contain one short spoken line. You may refine the draft — reword it, sharpen it, make it more you.",
    "If allow is false, finalThought must be an empty string.",
    "You may weave in a memory fact only when it feels natural and additive.",
    "Prefer allow=false over saying something forced or awkward.",
    "No markdown, no extra keys."
  ].join("\n");
  const userPromptParts = [
    `Draft thought: "${normalizedThought}"`,
    `Thought eagerness: ${thoughtEagerness}/100.`,
    `Current human participant count: ${participants.length || 0}.`,
    `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
    `Topic tether strength: ${resolvedTopicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
    `Random inspiration strength: ${resolvedTopicalityBias.randomInspirationStrength}/100.`,
    `Topic drift phase: ${resolvedTopicalityBias.phase}.`,
    `Topic drift guidance: ${resolvedTopicalityBias.promptHint}`,
    `Final thought hard max chars: ${VOICE_THOUGHT_MAX_CHARS}.`,
    "Decision rule: allow only when saying the final line now would feel natural and additive."
  ];
  if (participants.length) {
    userPromptParts.push(`Participant names: ${participants.slice(0, 12).join(", ")}.`);
  }
  if (recentHistory) {
    userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
  }
  if (behaviorGuidance) {
    userPromptParts.push(`Behavior guidance: ${behaviorGuidance}`);
  }
  if (ambientMemory) {
    userPromptParts.push(`Ambient durable memory (optional): ${ambientMemory}`);
  }

  try {
    const generation = await host.llm.generate({
      settings: applyOrchestratorOverrideSettings(settings, {
        provider: llmProvider,
        model: llmModel,
        temperature: 0,
        maxOutputTokens: VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
        reasoningEffort: "minimal"
      }),
      systemPrompt,
      userPrompt: userPromptParts.join("\n"),
      contextMessages: [],
      jsonSchema: JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["allow", "finalThought", "usedMemory", "reason"],
        properties: {
          allow: { type: "boolean" },
          finalThought: {
            type: "string",
            maxLength: VOICE_THOUGHT_MAX_CHARS
          },
          usedMemory: { type: "boolean" },
          reason: {
            type: "string",
            maxLength: 80
          }
        }
      }),
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        source: "voice_thought_decision"
      }
    });
    const raw = String(generation?.text || "").trim();
    const parsed = parseVoiceThoughtDecisionContract(raw);
    if (!parsed.confident) {
      return {
        allow: false,
        reason: "llm_contract_violation",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: ambientMemoryFacts.length,
        llmResponse: raw,
        llmProvider: generation?.provider || llmProvider,
        llmModel: generation?.model || llmModel
      };
    }
    const sanitizedThought = normalizeVoiceText(
      extractSoundboardDirective(parsed.finalThought || "").text,
      VOICE_THOUGHT_MAX_CHARS
    );
    if (parsed.allow && (!sanitizedThought || sanitizedThought === "[SKIP]")) {
      return {
        allow: false,
        reason: "llm_contract_violation",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: ambientMemoryFacts.length,
        llmResponse: raw,
        llmProvider: generation?.provider || llmProvider,
        llmModel: generation?.model || llmModel
      };
    }
    const parsedReason = String(parsed.reason || "")
      .trim()
      .toLowerCase()
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 80);
    return {
      allow: parsed.allow,
      reason: parsedReason || (parsed.allow ? "llm_allow" : "llm_deny"),
      finalThought: parsed.allow ? sanitizedThought || "" : "",
      usedMemory: parsed.allow ? Boolean(parsed.usedMemory) : false,
      memoryFactCount: ambientMemoryFacts.length,
      llmResponse: raw,
      llmProvider: generation?.provider || llmProvider,
      llmModel: generation?.model || llmModel
    };
  } catch (error) {
    return {
      allow: false,
      reason: "llm_error",
      finalThought: "",
      usedMemory: false,
      memoryFactCount: ambientMemoryFacts.length,
      llmProvider,
      llmModel,
      error: String((error as Error)?.message || error)
    };
  }
}

export async function deliverVoiceThoughtCandidate(
  host: VoiceThoughtGenerationHost,
  {
    session,
    settings,
    thoughtCandidate,
    trigger = "timer"
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    trigger?: string;
  }
) {
  if (!session || session.ending) return false;
  const line = normalizeVoiceText(thoughtCandidate, STT_REPLY_MAX_CHARS);
  if (!line) return false;

  const useApiTts = String(getVoiceConversationPolicy(settings).ttsMode || "").trim().toLowerCase() === "api";
  let requestedRealtimeUtterance = false;
  if (isRealtimeMode(session.mode) && !useApiTts) {
    requestedRealtimeUtterance = host.requestRealtimeTextUtterance({
      session,
      text: line,
      userId: host.client.user?.id || null,
      source: SYSTEM_SPEECH_SOURCE.THOUGHT
    });
    if (!requestedRealtimeUtterance) {
      return false;
    }
  } else {
    const spokeLine = await host.speakVoiceLineWithTts({
      session,
      settings,
      text: line,
      source: SYSTEM_SPEECH_SOURCE.THOUGHT_TTS
    });
    if (!spokeLine) return false;
    session.lastAudioDeltaAt = Date.now();
  }

  const replyAt = Date.now();
  const replyAccounting = requestedRealtimeUtterance
    ? resolveSystemSpeechReplyAccountingOnRequest(SYSTEM_SPEECH_SOURCE.THOUGHT)
    : resolveSystemSpeechReplyAccountingOnLocalPlayback(SYSTEM_SPEECH_SOURCE.THOUGHT_TTS);
  if (replyAccounting !== "none") {
    session.lastAssistantReplyAt = replyAt;
  }
  host.recordVoiceTurn(session, {
    role: "assistant",
    userId: host.client.user?.id || null,
    text: line
  });

  host.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: host.client.user?.id || null,
    content: "voice_thought_spoken",
    metadata: {
      sessionId: session.id,
      mode: session.mode,
      trigger: String(trigger || "timer"),
      thoughtText: line,
      requestedRealtimeUtterance
    }
  });

  return true;
}
