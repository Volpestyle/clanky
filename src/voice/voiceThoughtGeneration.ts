import { clamp } from "../utils.ts";
import {
  applyOrchestratorOverrideSettings,
  getMemorySettings,
  getResolvedVoiceInitiativeBinding,
  getVoiceConversationPolicy,
  getVoiceInitiativeSettings
} from "../settings/agentStack.ts";
import { buildVoiceToneGuardrails } from "../prompts/promptCore.ts";
import { buildSystemPrompt } from "../prompts/promptFormatters.ts";
import {
  buildCuratedMemoryLogMetadata,
  loadCuratedPromptMemory
} from "../memory/curatedMemory.ts";
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
import type {
  VoicePendingAmbientThought,
  VoiceSession
} from "./voiceSessionTypes.ts";

type ThoughtSettings = Record<string, unknown> | null;

interface VoiceThoughtEngineConfig {
  enabled: boolean;
  provider: string;
  model: string;
  temperature: number;
  eagerness: number;
  minSilenceSeconds: number;
  minSecondsBetweenThoughts: number;
}

interface VoiceThoughtTopicalityBias {
  silenceSeconds: number;
  topicTetherStrength: number;
  randomInspirationStrength: number;
  phase: string;
  topicalStartSeconds: number;
  fullDriftSeconds: number;
  promptHint: string;
}

interface VoiceThoughtDecision {
  action: "speak_now" | "hold" | "drop";
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

interface VoiceThoughtGenerationHost {
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

function loadVoiceThoughtCuratedMemory(
  host: VoiceThoughtGenerationHost,
  session: VoiceSession,
  {
    source,
    metadata = {}
  }: {
    source: string;
    metadata?: Record<string, unknown>;
  }
) {
  const curatedMemory = loadCuratedPromptMemory({
    mode: "voice",
    ownerPrivate: false
  });
  host.store.logAction({
    kind: "memory_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: host.client.user?.id || null,
    content: "curated_prompt_memory_loaded",
    metadata: {
      source,
      sessionId: session.id,
      ...metadata,
      ...buildCuratedMemoryLogMetadata(curatedMemory)
    }
  });
  return curatedMemory;
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

function describePendingThoughtInvalidationReason(reason: string | null | undefined) {
  const normalizedReason = String(reason || "").trim().toLowerCase();
  if (!normalizedReason) return null;
  switch (normalizedReason) {
    case "new_user_turn":
      return "someone new spoke";
    case "member_join":
      return "someone joined the room";
    case "member_leave":
      return "someone left the room";
    case "voice_effect":
      return "someone fired off a voice effect";
    case "room_activity":
      return "the room shifted";
    default:
      return normalizedReason.replace(/_/g, " ");
  }
}

export function resolveVoiceThoughtEngineConfig(settings: ThoughtSettings = null): VoiceThoughtEngineConfig {
  const thoughtEngine = getVoiceInitiativeSettings(settings);
  const binding = getResolvedVoiceInitiativeBinding(settings);
  const enabled = Boolean(thoughtEngine.enabled);
  const provider = normalizeLlmProvider(binding.provider, "anthropic");
  const model = String(binding.model || "").trim().slice(0, 120) || "claude-opus-4-6";
  const temperature = clamp(Number(binding.temperature) || 0.8, 0, 2);
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
    trigger = "timer",
    pendingThought = null
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    config?: VoiceThoughtEngineConfig | null;
    trigger?: string;
    pendingThought?: VoicePendingAmbientThought | null;
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
  const normalizedPendingThought = pendingThought && typeof pendingThought === "object"
    ? {
      currentText: normalizeVoiceText(pendingThought.currentText || "", VOICE_THOUGHT_MAX_CHARS),
      status: pendingThought.status === "reconsider" ? "reconsider" : "queued",
      revision: Math.max(1, Number(pendingThought.revision || 1)),
      ageMs: Math.max(0, Math.round(Date.now() - Number(pendingThought.createdAt || Date.now()))),
      lastDecisionReason: String(pendingThought.lastDecisionReason || "").trim() || null,
      invalidationReason: String(pendingThought.invalidationReason || "").trim() || null,
      invalidatedAt: Number(pendingThought.invalidatedAt || 0) || null
    }
    : null;
  const curatedMemory = loadVoiceThoughtCuratedMemory(host, session, {
    source: "voice_thought_generation",
    metadata: { trigger: String(trigger || "timer") }
  });
  const systemPrompt = [
    buildSystemPrompt(settings, { curatedMemory }),
    "You are speaking in live Discord voice chat.",
    ...buildVoiceToneGuardrails(),
    "=== AUTONOMOUS THOUGHT MODE ===",
    normalizedPendingThought
      ? "Nobody is speaking to you right now. You are checking back in with an ambient thought you have been holding."
      : "Nobody is speaking to you right now. You are deciding whether to say something on your own initiative.",
    normalizedPendingThought
      ? "Answer the question: what are you thinking right now? Return exactly one short natural spoken line that captures your current thought, or exactly [SKIP] if the thought has faded."
      : "Draft exactly one short natural spoken line that might fit right now — or output exactly [SKIP] if silence is better.",
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
  if (normalizedPendingThought?.currentText) {
    userPromptParts.push(`Your current thought: "${normalizedPendingThought.currentText}"`);
    userPromptParts.push(`Current thought status: ${normalizedPendingThought.status}.`);
    userPromptParts.push(`Current thought revision: ${normalizedPendingThought.revision}.`);
    userPromptParts.push(`Current thought age ms: ${normalizedPendingThought.ageMs}.`);
    if (normalizedPendingThought.lastDecisionReason) {
      userPromptParts.push(`Why you kept it: ${normalizedPendingThought.lastDecisionReason}.`);
    }
    if (normalizedPendingThought.invalidatedAt) {
      const invalidationReason = describePendingThoughtInvalidationReason(
        normalizedPendingThought.invalidationReason
      );
      userPromptParts.push(
        invalidationReason
          ? `What changed since then: ${invalidationReason}. Refresh it instead of clinging to stale context.`
          : "Something happened in the room after you formed that thought. Refresh it instead of clinging to stale context."
      );
    }
    userPromptParts.push("Question: what are you thinking right now?");
  }
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
    topicalityBias = null,
    pendingThought = null
  }: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    memoryFacts?: ThoughtMemoryRow[];
    topicalityBias?: VoiceThoughtTopicalityBias | null;
    pendingThought?: VoicePendingAmbientThought | null;
  }
): Promise<VoiceThoughtDecision> {
  const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
  if (!normalizedThought) {
    return {
      action: "drop",
      reason: "empty_thought_candidate",
      finalThought: "",
      usedMemory: false,
      memoryFactCount: 0
    };
  }

  if (!host.llm?.generate) {
    return {
      action: "drop",
      reason: "llm_generate_unavailable",
      finalThought: "",
      usedMemory: false,
      memoryFactCount: 0
    };
  }

  const binding = getResolvedVoiceInitiativeBinding(settings);
  const llmProvider = normalizeLlmProvider(binding.provider, "anthropic");
  const llmModel = String(binding.model || "").trim().slice(0, 120) || "claude-opus-4-6";
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
  const normalizedPendingThought = pendingThought && typeof pendingThought === "object"
    ? {
      currentText: normalizeVoiceText(pendingThought.currentText || "", VOICE_THOUGHT_MAX_CHARS),
      status: pendingThought.status === "reconsider" ? "reconsider" : "queued",
      revision: Math.max(1, Number(pendingThought.revision || 1)),
      ageMs: Math.max(0, Math.round(Date.now() - Number(pendingThought.createdAt || Date.now()))),
      lastDecisionReason: String(pendingThought.lastDecisionReason || "").trim() || null,
      invalidationReason: String(pendingThought.invalidationReason || "").trim() || null,
      invalidatedAt: Number(pendingThought.invalidatedAt || 0) || null
    }
    : null;

  const curatedMemory = loadVoiceThoughtCuratedMemory(host, session, {
    source: "voice_thought_decision"
  });
  const systemPrompt = [
    buildSystemPrompt(settings, { curatedMemory }),
    "You are speaking in live Discord voice chat.",
    ...buildVoiceToneGuardrails(),
    "=== THOUGHT QUEUE MODE ===",
    "You are deciding what to do with an ambient thought during a lull in live voice chat.",
    "Return strict JSON with keys: action (\"speak_now\"|\"hold\"|\"drop\"), finalThought (string), usedMemory (boolean), reason (string).",
    "If action is \"speak_now\", finalThought must contain one short spoken line you would actually say now.",
    "If action is \"hold\", finalThought must contain one short line that captures the thought you want to keep holding for later. It can be refined, replaced, or tightened.",
    "If action is \"drop\", finalThought must be an empty string.",
    "Prefer hold over speak_now when the thought has potential but the timing is not quite right yet.",
    "Prefer drop over clinging to a stale, awkward, or dead thought.",
    "You may weave in a memory fact only when it feels natural and additive.",
    "No markdown, no extra keys."
  ].join("\n");
  const userPromptParts = [
    `Thought candidate right now: "${normalizedThought}"`,
    `Thought eagerness: ${thoughtEagerness}/100.`,
    `Current human participant count: ${participants.length || 0}.`,
    `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
    `Topic tether strength: ${resolvedTopicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
    `Random inspiration strength: ${resolvedTopicalityBias.randomInspirationStrength}/100.`,
    `Topic drift phase: ${resolvedTopicalityBias.phase}.`,
    `Topic drift guidance: ${resolvedTopicalityBias.promptHint}`,
    `Final thought hard max chars: ${VOICE_THOUGHT_MAX_CHARS}.`,
    "Decision rule: choose speak_now only when saying the final line now would feel natural and additive. Choose hold when the thought is still alive but better saved for later."
  ];
  if (normalizedPendingThought?.currentText) {
    userPromptParts.push(`Your current thought before this pass: "${normalizedPendingThought.currentText}"`);
    userPromptParts.push(`Current thought status: ${normalizedPendingThought.status}.`);
    userPromptParts.push(`Current thought revision: ${normalizedPendingThought.revision}.`);
    userPromptParts.push(`Current thought age ms: ${normalizedPendingThought.ageMs}.`);
    if (normalizedPendingThought.lastDecisionReason) {
      userPromptParts.push(`Why you kept it: ${normalizedPendingThought.lastDecisionReason}.`);
    }
    if (normalizedPendingThought.invalidatedAt) {
      const invalidationReason = describePendingThoughtInvalidationReason(
        normalizedPendingThought.invalidationReason
      );
      userPromptParts.push(
        invalidationReason
          ? `What changed since then: ${invalidationReason}. Re-check whether it still fits.`
          : "New room activity happened after you formed that thought. Re-check whether it still fits."
      );
    }
  }
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
        required: ["action", "finalThought", "usedMemory", "reason"],
        properties: {
          action: {
            type: "string",
            enum: ["speak_now", "hold", "drop"]
          },
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
        action: "drop",
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
    if (parsed.action !== "drop" && (!sanitizedThought || sanitizedThought === "[SKIP]")) {
      return {
        action: "drop",
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
    const parsedAction: "speak_now" | "hold" | "drop" =
      parsed.action === "speak_now" || parsed.action === "hold" ? parsed.action : "drop";
    return {
      action: parsedAction,
      reason: parsedReason || (
        parsedAction === "speak_now"
          ? "llm_speak_now"
          : parsedAction === "hold"
            ? "llm_hold"
            : "llm_drop"
      ),
      finalThought: parsedAction === "drop" ? "" : sanitizedThought || "",
      usedMemory: parsedAction === "drop" ? false : Boolean(parsed.usedMemory),
      memoryFactCount: ambientMemoryFacts.length,
      llmResponse: raw,
      llmProvider: generation?.provider || llmProvider,
      llmModel: generation?.model || llmModel
    };
  } catch (error) {
    return {
      action: "drop",
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
