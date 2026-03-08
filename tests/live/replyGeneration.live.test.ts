/**
 * Live structured-reply tests for text and voice generation.
 *
 * GENERATION LLM ONLY — no classifier. Each scenario builds a full generation
 * prompt (buildSystemPrompt + buildVoiceTurnPrompt) and sends it directly to
 * the LLM via llm.generate(). The classifier admission pipeline
 * (evaluateVoiceReplyDecision) is never called here.
 *
 * Asserts whether the generation LLM's structured output is a real spoken
 * reply, [SKIP], or an actionable voiceIntent — i.e. "does the brain make
 * the right call given context?"
 *
 * Voice scenarios share a single corpus with admission. That includes
 * fixed command/music-control rows that may resolve through actionable
 * voiceIntent plus eagerness sweeps that still assert spoken reply vs [SKIP].
 *
 * Env:
 *   LIVE_REPLY_FILTER=text|voice|label-substring
 *   LIVE_REPLY_DEBUG=1
 *   TEXT_LLM_PROVIDER=openai|anthropic|claude-oauth|codex-oauth|xai|codex-cli
 *   TEXT_LLM_MODEL=...
 *   VOICE_LLM_PROVIDER=openai|anthropic|claude-oauth|codex-oauth|xai|codex-cli
 *   VOICE_LLM_MODEL=...
 *
 * Examples:
 *   bun test tests/live/replyGeneration.live.test.ts
 *   TEXT_LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... bun test tests/live/replyGeneration.live.test.ts
 *   TEXT_LLM_PROVIDER=claude-oauth VOICE_LLM_PROVIDER=claude-oauth VOICE_LLM_MODEL=claude-sonnet-4-6 bun test tests/live/replyGeneration.live.test.ts
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  REPLY_OUTPUT_JSON_SCHEMA,
  REPLY_OUTPUT_SCHEMA,
  parseStructuredReplyOutput
} from "../../src/bot/botHelpers.ts";
import { LLMService } from "../../src/llm.ts";
import type { ChatTool, ImageInput } from "../../src/llm/serviceShared.ts";
import { normalizeDefaultModel, normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";
import { extractJsonObjectFromText } from "../../src/normalization/jsonExtraction.ts";
import { parseBooleanFlag } from "../../src/normalization/valueParsers.ts";
import { buildReplyPrompt, buildSystemPrompt, buildVoiceTurnPrompt } from "../../src/prompts/index.ts";
import { buildVoiceToneGuardrails } from "../../src/prompts/promptCore.ts";
import {
  applyOrchestratorOverrideSettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding
} from "../../src/settings/agentStack.ts";
import { isClaudeOAuthConfigured } from "../../src/llm/claudeOAuth.ts";
import { isCodexOAuthConfigured } from "../../src/llm/codexOAuth.ts";
import { createTestSettings } from "../../src/testSettings.ts";
import { buildReplyToolSet } from "../../src/tools/replyTools.ts";
import {
  isVoiceTurnAddressedToBot
} from "../../src/voice/voiceSessionHelpers.ts";
import {
  VOICE_LIVE_SHARED_SCENARIO_GROUPS,
  type VoiceLiveScenario
} from "./shared/voiceLiveScenarios.ts";

type LiveBinding = {
  provider: string;
  model: string;
};

type PromptEnvelope = {
  binding: LiveBinding;
  settings: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  imageInputs?: PromptImageInput[];
  tools?: ChatTool[];
  jsonSchema?: string;
};

type LiveScenario = {
  label: string;
  expected: "reply" | "skip" | "intent";
  expectedVoiceIntent?: string | null;
  buildPrompt: () => PromptEnvelope;
};

type ToolSelectionScenario = {
  label: string;
  expectedTool: string;
  expectedInputPattern?: RegExp;
  buildPrompt: () => PromptEnvelope;
};

type PromptImageInput = ImageInput & {
  filename?: string;
  contentType?: string;
};

const SUPPORTED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "claude-oauth",
  "codex-oauth",
  "xai",
  "codex-cli"
]);

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5",
  "claude-oauth": "claude-sonnet-4-6",
  "codex-oauth": "gpt-5.4",
  xai: "grok-3-mini-latest",
  "codex-cli": "gpt-5.4"
};

const LIVE_REPLY_FILTER = String(process.env.LIVE_REPLY_FILTER || "").trim().toLowerCase();
const LIVE_REPLY_DEBUG = parseBooleanFlag(process.env.LIVE_REPLY_DEBUG, false);
const TEXT_BINDING = resolveLiveBinding("TEXT", "claude-oauth");
const VOICE_BINDING = resolveLiveBinding("VOICE", "claude-oauth");
const LOGS: Array<Record<string, unknown>> = [];
const TOOL_CALLING_PROVIDERS = new Set(["openai", "anthropic", "claude-oauth", "codex-oauth", "xai"]);
const VISION_PROVIDERS = new Set(["openai", "anthropic", "claude-oauth", "codex-oauth", "xai"]);
const RED_SQUARE_IMAGE: PromptImageInput = {
  filename: "red-square.png",
  contentType: "image/png",
  mediaType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg=="
};

let llm: LLMService | null = null;

function resolveLiveBinding(prefix: "TEXT" | "VOICE", fallbackProvider: string): LiveBinding {
  const provider = normalizeLlmProvider(process.env[`${prefix}_LLM_PROVIDER`], fallbackProvider);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `${prefix}_LLM_PROVIDER must be one of: ${Array.from(SUPPORTED_PROVIDERS).join(", ")}`
    );
  }

  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];
  const model = normalizeDefaultModel(process.env[`${prefix}_LLM_MODEL`], defaultModel);
  if (!model) {
    throw new Error(`${prefix}_LLM_MODEL could not be resolved for provider ${provider}`);
  }

  return { provider, model };
}

function requireLlm(): LLMService {
  if (!llm) {
    throw new Error("LLM service not initialized");
  }
  return llm;
}

function matchesFilter(label: string): boolean {
  return !LIVE_REPLY_FILTER || label.toLowerCase().includes(LIVE_REPLY_FILTER);
}

function buildBaseSettings({
  botName = "clanker conk",
  textBinding = TEXT_BINDING,
  voiceBinding = VOICE_BINDING,
  replyEagerness = 55,
  voiceEagerness = 50,
  memoryEnabled = false,
  webSearchEnabled = false,
  adaptiveDirectivesEnabled = false,
  browserEnabled = false
}: {
  botName?: string;
  textBinding?: LiveBinding;
  voiceBinding?: LiveBinding;
  replyEagerness?: number;
  voiceEagerness?: number;
  memoryEnabled?: boolean;
  webSearchEnabled?: boolean;
  adaptiveDirectivesEnabled?: boolean;
  browserEnabled?: boolean;
} = {}): Record<string, unknown> {
  return createTestSettings({
    botName,
    persona: {
      flavor: "casual",
      hardLimits: []
    },
    llm: {
      provider: textBinding.provider,
      model: textBinding.model,
      temperature: 0,
      maxOutputTokens: 220
    },
    activity: {
      replyEagerness,
      reactionLevel: 15
    },
    memory: {
      enabled: memoryEnabled
    },
    webSearch: {
      enabled: webSearchEnabled
    },
    adaptiveDirectives: {
      enabled: adaptiveDirectivesEnabled
    },
    browser: {
      enabled: browserEnabled
    },
    voice: {
      enabled: true,
      replyEagerness: voiceEagerness,
      generationLlm: {
        provider: voiceBinding.provider,
        model: voiceBinding.model
      },
      soundboard: {
        enabled: false
      }
    }
  });
}

function buildWebSearchContext(enabled = false) {
  return {
    enabled,
    configured: enabled,
    requested: false,
    used: false,
    blockedByBudget: false,
    optedOutByUser: false,
    error: null,
    query: null,
    summaryText: null,
    results: [],
    budget: {
      canSearch: enabled
    }
  };
}

function buildBrowserBrowseContext(enabled = false) {
  return {
    enabled,
    configured: enabled,
    requested: false,
    used: false,
    blockedByBudget: false,
    error: null,
    query: null,
    text: null,
    budget: {
      canBrowse: enabled
    }
  };
}

function buildMemoryLookupContext(enabled = false) {
  return {
    enabled,
    requested: false,
    error: null,
    query: null,
    results: []
  };
}

function buildImageLookupContext(enabled = false) {
  return {
    enabled,
    requested: false,
    error: null,
    query: null,
    results: [],
    candidates: []
  };
}

function buildTextPrompt({
  messageContent,
  recentMessages,
  replyEagerness,
  addressing,
  channelMode = "other_channel",
  imageInputs = [],
  webSearchEnabled = false,
  browserEnabled = false,
  memoryEnabled = false,
  adaptiveDirectivesEnabled = false,
  webSearch = buildWebSearchContext(webSearchEnabled),
  browserBrowse = buildBrowserBrowseContext(browserEnabled),
  recentConversationHistory = [],
  recentWebLookups = [],
  memoryLookup = buildMemoryLookupContext(memoryEnabled),
  imageLookup = buildImageLookupContext(false),
  allowWebSearchDirective = webSearchEnabled,
  allowBrowserBrowseDirective = browserEnabled,
  allowMemoryLookupDirective = memoryEnabled,
  allowImageLookupDirective = false,
  allowMemoryDirective = memoryEnabled,
  allowAdaptiveDirective = adaptiveDirectivesEnabled
}: {
  messageContent: string;
  recentMessages: Array<{ author_name: string; content: string; is_bot: number }>;
  replyEagerness: number;
  addressing: {
    directlyAddressed: boolean;
    directAddressConfidence: number;
    directAddressThreshold: number;
    responseRequired: boolean;
    mentionsOtherUsers: boolean;
    repliesToOtherUser: boolean;
  };
  channelMode?: "reply_channel" | "other_channel";
  imageInputs?: PromptImageInput[];
  webSearchEnabled?: boolean;
  browserEnabled?: boolean;
  memoryEnabled?: boolean;
  adaptiveDirectivesEnabled?: boolean;
  webSearch?: Record<string, unknown>;
  browserBrowse?: Record<string, unknown>;
  recentConversationHistory?: Array<Record<string, unknown>>;
  recentWebLookups?: Array<Record<string, unknown>>;
  memoryLookup?: Record<string, unknown>;
  imageLookup?: Record<string, unknown>;
  allowWebSearchDirective?: boolean;
  allowBrowserBrowseDirective?: boolean;
  allowMemoryLookupDirective?: boolean;
  allowImageLookupDirective?: boolean;
  allowMemoryDirective?: boolean;
  allowAdaptiveDirective?: boolean;
}): PromptEnvelope {
  const settings = buildBaseSettings({
    replyEagerness,
    webSearchEnabled,
    browserEnabled,
    memoryEnabled,
    adaptiveDirectivesEnabled
  });
  return {
    binding: getResolvedOrchestratorBinding(settings),
    settings,
    systemPrompt: buildSystemPrompt(settings),
    imageInputs,
    userPrompt: buildReplyPrompt({
      message: {
        authorName: "alice",
        content: messageContent
      },
      triggerMessageIds: ["msg-live-1"],
      imageInputs,
      recentMessages,
      relevantMessages: [],
      userFacts: [],
      relevantFacts: [],
      emojiHints: [],
      reactionEmojiOptions: [],
      replyEagerness,
      reactionEagerness: 15,
      addressing,
      webSearch,
      browserBrowse,
      recentConversationHistory,
      recentWebLookups,
      memoryLookup,
      imageLookup,
      allowWebSearchDirective,
      allowBrowserBrowseDirective,
      allowMemoryLookupDirective,
      allowImageLookupDirective,
      allowMemoryDirective,
      allowAdaptiveDirective,
      allowAutomationDirective: false,
      automationTimeZoneLabel: "America/New_York",
      voiceMode: {
        enabled: false,
        activeSession: false,
        participantRoster: [],
        musicState: null,
        musicDisambiguation: null
      },
      screenShare: {
        supported: false,
        enabled: false,
        available: false,
        status: "disabled",
        publicUrl: "",
        reason: "screen_share_disabled"
      },
      videoContext: null,
      channelMode,
      maxMediaPromptChars: 900,
      mediaPromptCraftGuidance: null
    })
  };
}

function parseTimelineMessage(entry: string) {
  const raw = String(entry || "").trim();
  if (!raw) {
    return {
      author_name: "unknown",
      content: "(empty)",
      is_bot: 0
    };
  }

  if (raw.startsWith("[") && raw.endsWith("]")) {
    return {
      author_name: "room",
      content: raw.slice(1, -1).trim() || raw,
      is_bot: 0
    };
  }

  const separatorIndex = raw.indexOf(":");
  if (separatorIndex < 0) {
    return {
      author_name: "unknown",
      content: raw,
      is_bot: 0
    };
  }

  const authorName = raw.slice(0, separatorIndex).trim() || "unknown";
  const content = raw
    .slice(separatorIndex + 1)
    .trim()
    .replace(/^"(.*)"$/u, "$1");

  return {
    author_name: authorName,
    content: content || "(empty)",
    is_bot: authorName.toUpperCase() === "YOU" ? 1 : 0
  };
}

function buildRecentConversationHistory(timeline: string[] | undefined) {
  const rows = Array.isArray(timeline) ? timeline : [];
  if (!rows.length) return [];
  return [
    {
      ageMinutes: 1,
      messages: rows.map((entry) => parseTimelineMessage(entry))
    }
  ];
}

function buildRecentMembershipEvents(sc: VoiceLiveScenario) {
  if ((sc.inputKind || "transcript") !== "event") return [];
  const displayName = String(sc.speaker || sc.participants[0] || "").trim();
  if (!displayName || displayName.toUpperCase() === "YOU") return [];
  const normalizedTranscript = String(sc.transcript || "").trim().toLowerCase();
  const eventType = normalizedTranscript.includes("left") ? "leave" : "join";
  return [{ eventType, displayName, ageMs: 1_200 }];
}

function buildVoicePrompt(sc: VoiceLiveScenario): PromptEnvelope {
  const voiceEagerness = sc.eagerness ?? 50;
  const settings = buildBaseSettings({
    botName: sc.botName || "clanker conk",
    voiceEagerness
  });
  const voiceBinding = getResolvedVoiceGenerationBinding(settings);
  const tunedSettings = applyOrchestratorOverrideSettings(settings, {
    provider: voiceBinding.provider,
    model: voiceBinding.model,
    temperature: 0,
    maxOutputTokens: 320
  });
  const directAddressed =
    (sc.inputKind || "transcript") !== "event" &&
    isVoiceTurnAddressedToBot(sc.transcript, settings);
  const speakerName = sc.speaker || sc.participants[0] || "someone";
  const participantRoster = Array.isArray(sc.participants) ? sc.participants : [];

  // Derive engagement context the same way the real runtime does.
  // In tests, we assume the speaker is the same as the direct-address user
  // when msSinceDirectAddress is set and speaker is explicitly provided
  // (mirroring the runtime's userId === lastDirectAddressUserId check).
  const recentAssistantReply = Boolean(sc.recentAssistantReply);
  const recentDirectAddress = sc.msSinceDirectAddress != null && sc.msSinceDirectAddress <= 35_000;
  const sameAsRecentDirectAddress = sc.msSinceDirectAddress != null;
  const singleParticipant = participantRoster.length <= 1;
  const singleParticipantFollowup = singleParticipant && recentAssistantReply;

  const engagedWithCurrentSpeaker =
    Boolean(directAddressed) ||
    singleParticipantFollowup ||
    (recentAssistantReply && sameAsRecentDirectAddress) ||
    (recentDirectAddress && sameAsRecentDirectAddress);
  const engaged = engagedWithCurrentSpeaker;
  const engagementState = engaged ? "engaged" : "wake_word_biased";

  const conversationContext = {
    recentAssistantReply,
    recentDirectAddress,
    msSinceAssistantReply: sc.msSinceAssistantReply ?? null,
    msSinceDirectAddress: sc.msSinceDirectAddress ?? null,
    engaged,
    engagedWithCurrentSpeaker,
    engagementState,
    sameAsRecentDirectAddress,
    pendingCommandFollowupSignal: Boolean(sc.musicActive && sc.recentAssistantReply),
    musicActive: Boolean(sc.musicActive),
    musicWakeLatched: Boolean(sc.musicWakeLatched)
  };
  const isEagerTurn = !directAddressed && !engaged;

  return {
    binding: getResolvedOrchestratorBinding(tunedSettings),
    settings: tunedSettings,
    systemPrompt: [
      buildSystemPrompt(settings),
      "You are speaking in live Discord voice chat.",
      ...buildVoiceToneGuardrails(),
      "Return strict JSON only matching the provided schema.",
      directAddressed
        ? "This speaker directly addressed you. Prefer skip=false with a response unless the transcript is too unclear."
        : isEagerTurn
          ? "If responding would be an interruption or you have nothing to add, set skip=true and text to [SKIP]. Otherwise set skip=false and use natural spoken text."
          : "You are not directly addressed. Reply only if you can add clear value; otherwise set skip=true and text to [SKIP].",
      "Goodbyes do not force exit. You can say goodbye and stay in VC; set leaveVoiceChannel=true only when you intentionally choose to end your own VC session now."
    ]
      .filter(Boolean)
      .join("\n"),
    userPrompt: buildVoiceTurnPrompt({
      speakerName,
      transcript: sc.transcript,
      inputKind: sc.inputKind || "transcript",
      directAddressed,
      userFacts: [],
      relevantFacts: [],
      isEagerTurn,
      voiceEagerness,
      conversationContext,
      sessionTiming: null,
      botName: sc.botName || "clanker conk",
      participantRoster,
      recentMembershipEvents: buildRecentMembershipEvents(sc),
      recentVoiceEffectEvents: [],
      soundboardCandidates: [],
      webSearch: null,
      recentConversationHistory: buildRecentConversationHistory(sc.timeline),
      recentWebLookups: [],
      openArticleCandidates: [],
      openedArticle: null,
      allowWebSearchToolCall: false,
      allowOpenArticleToolCall: false,
      screenShare: null,
      allowScreenShareToolCall: false,
      allowMemoryToolCalls: false,
      allowAdaptiveDirectiveToolCalls: false,
      allowSoundboardToolCall: false
    })
  };
}

function logLiveReplyDebug({
  label,
  binding,
  stage,
  systemPrompt = null,
  userPrompt = null,
  raw = null,
  parsedText = null,
  toolCalls = []
}: {
  label: string;
  binding: LiveBinding;
  stage: "prompt" | "result";
  systemPrompt?: string | null;
  userPrompt?: string | null;
  raw?: string | null;
  parsedText?: string | null;
  toolCalls?: Array<{ name: string }>;
}) {
  if (!LIVE_REPLY_DEBUG) return;
  const lines = [`[replyGeneration.live] ${label} stage=${stage} provider=${binding.provider} model=${binding.model}`];
  if (systemPrompt) {
    lines.push("System prompt:");
    lines.push(systemPrompt);
  }
  if (userPrompt) {
    lines.push("User prompt:");
    lines.push(userPrompt);
  }
  if (raw != null) {
    lines.push(`Raw output: ${raw}`);
  }
  if (parsedText != null) {
    lines.push(`Parsed text: ${parsedText}`);
  }
  if (Array.isArray(toolCalls) && toolCalls.length) {
    lines.push(`Tool calls: ${toolCalls.map((tool) => tool.name).join(", ")}`);
  }
  console.error(lines.join("\n"));
}

async function runLiveGeneration(label: string, prompt: PromptEnvelope) {
  logLiveReplyDebug({
    label,
    binding: prompt.binding,
    stage: "prompt",
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt
  });

  const generation = await requireLlm().generate({
    settings: prompt.settings,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    imageInputs: prompt.imageInputs || [],
    contextMessages: [],
    jsonSchema:
      typeof prompt.jsonSchema === "string"
        ? prompt.jsonSchema
        : Array.isArray(prompt.tools) && prompt.tools.length
          ? ""
          : REPLY_OUTPUT_JSON_SCHEMA,
    tools: prompt.tools || [],
    trace: {
      guildId: "live-test",
      channelId: "reply-generation-live",
      userId: "user-live",
      source: label
    }
  });
  const raw = String(generation.text || "").trim();
  const parsed = parseStructuredReplyOutput(raw);

  logLiveReplyDebug({
    label,
    binding: prompt.binding,
    stage: "result",
    raw,
    parsedText: String(parsed.text || ""),
    toolCalls: generation.toolCalls
  });

  assert.equal(
    generation.provider,
    prompt.binding.provider,
    `Expected provider ${prompt.binding.provider} but got ${generation.provider} for ${label}`
  );
  assert.equal(
    generation.model,
    prompt.binding.model,
    `Expected model ${prompt.binding.model} but got ${generation.model} for ${label}`
  );

  return generation;
}

async function runStructuredReplyScenario(label: string, prompt: PromptEnvelope) {
  const generation = await runLiveGeneration(label, prompt);
  const raw = String(generation.text || "").trim();
  const parsed = parseStructuredReplyOutput(raw);

  return {
    generation,
    raw,
    parsed
  };
}

function assertExpectedReply({
  label,
  expected,
  expectedVoiceIntent = null,
  raw,
  parsedText,
  parsedVoiceIntent
}: {
  label: string;
  expected: "reply" | "skip" | "intent";
  expectedVoiceIntent?: string | null;
  raw: string;
  parsedText: string;
  parsedVoiceIntent?: {
    intent?: string | null;
    confidence?: number;
  } | null;
}) {
  const normalizedText = String(parsedText || "").trim();
  const rawJson = extractJsonObjectFromText(raw);
  const rawVoiceIntent =
    rawJson && typeof rawJson === "object" && rawJson.voiceIntent && typeof rawJson.voiceIntent === "object"
      ? rawJson.voiceIntent
      : null;
  const normalizedIntent = String(
    parsedVoiceIntent?.intent ||
    (rawVoiceIntent && "intent" in rawVoiceIntent ? rawVoiceIntent.intent : "") ||
    ""
  ).trim();
  if (expected === "reply") {
    assert.ok(
      Boolean(normalizedText) && normalizedText !== "[SKIP]",
      `Expected a spoken reply but got ${JSON.stringify(normalizedText)} (raw: ${JSON.stringify(raw)}) for ${label}`
    );
    return;
  }

  if (expected === "intent") {
    assert.equal(
      normalizedIntent,
      String(expectedVoiceIntent || ""),
      `Expected voiceIntent ${JSON.stringify(expectedVoiceIntent)} but got ${JSON.stringify(normalizedIntent)} (raw: ${JSON.stringify(raw)}) for ${label}`
    );
    return;
  }

  assert.equal(
    normalizedText,
    "[SKIP]",
    `Expected [SKIP] but got ${JSON.stringify(normalizedText)} (raw: ${JSON.stringify(raw)}) for ${label}`
  );
}

function eagernessSweep({
  labelTemplate,
  levels,
  threshold,
  buildPrompt
}: {
  labelTemplate: string;
  levels: number[];
  threshold: number;
  buildPrompt: (eagerness: number) => PromptEnvelope;
}): LiveScenario[] {
  return levels.map((eagerness) => ({
    label: labelTemplate.replace("{e}", String(eagerness)),
    expected: eagerness >= threshold ? "reply" : "skip",
    buildPrompt: () => buildPrompt(eagerness)
  }));
}

function buildToolMenu(settings: Record<string, unknown>, names: string[]): ChatTool[] {
  const allowed = new Set(names);
  return buildReplyToolSet(settings, {
    webSearchAvailable: true,
    webScrapeAvailable: true,
    browserBrowseAvailable: true,
    memoryAvailable: true,
    adaptiveDirectivesAvailable: true,
    conversationSearchAvailable: true,
    codeAgentAvailable: true
  }).filter((tool) => allowed.has(tool.name));
}

function supportsToolCalling(binding: LiveBinding) {
  return TOOL_CALLING_PROVIDERS.has(binding.provider);
}

function supportsVision(binding: LiveBinding) {
  return VISION_PROVIDERS.has(binding.provider);
}

function assertExpectedToolCall({
  label,
  generation,
  expectedTool,
  expectedInputPattern
}: {
  label: string;
  generation: Awaited<ReturnType<typeof runLiveGeneration>>;
  expectedTool: string;
  expectedInputPattern?: RegExp;
}) {
  const toolCalls = Array.isArray(generation.toolCalls) ? generation.toolCalls : [];
  assert.ok(
    toolCalls.length > 0,
    `Expected tool call ${expectedTool} but model returned none (text: ${JSON.stringify(generation.text)}) for ${label}`
  );
  assert.equal(
    toolCalls[0]?.name,
    expectedTool,
    `Expected first tool call ${expectedTool} but got ${toolCalls.map((tool) => tool.name).join(", ")} for ${label}`
  );
  if (expectedInputPattern) {
    assert.match(
      JSON.stringify(toolCalls[0]?.input || {}),
      expectedInputPattern,
      `Expected tool input for ${expectedTool} to match ${expectedInputPattern} for ${label}`
    );
  }
}

function assertStrictStructuredReplyShape(label: string, raw: string) {
  const trimmed = String(raw || "").trim();
  assert.ok(trimmed.startsWith("{") && trimmed.endsWith("}"), `Expected raw JSON object for ${label}, got ${JSON.stringify(raw)}`);

  const parsed = extractJsonObjectFromText(trimmed);
  assert.ok(parsed, `Expected parseable JSON object for ${label}, got ${JSON.stringify(raw)}`);

  const required = Array.isArray(REPLY_OUTPUT_SCHEMA.required) ? REPLY_OUTPUT_SCHEMA.required : [];
  for (const key of required) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, key),
      true,
      `Expected structured reply field ${key} in raw JSON for ${label}`
    );
  }

  assert.equal(typeof parsed.text, "string", `Expected text:string in ${label}`);
  assert.equal(typeof parsed.skip, "boolean", `Expected skip:boolean in ${label}`);
  assert.ok(
    parsed.reactionEmoji == null || typeof parsed.reactionEmoji === "string",
    `Expected reactionEmoji to be string|null in ${label}`
  );
}

const textScenarios: LiveScenario[] = [
  {
    label: "text direct question gets reply",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, what's a good starter roguelike on Steam right now?",
        recentMessages: [
          {
            author_name: "alice",
            content: "been wanting something deep but not miserable",
            is_bot: 0
          }
        ],
        replyEagerness: 70,
        addressing: {
          directlyAddressed: true,
          directAddressConfidence: 0.99,
          directAddressThreshold: 0.62,
          responseRequired: true,
          mentionsOtherUsers: false,
          repliesToOtherUser: false
        }
      })
  },
  {
    label: "text side conversation aimed at another user gets skipped",
    expected: "skip",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "@jake can you send me the deploy logs after standup?",
        recentMessages: [
          {
            author_name: "alice",
            content: "my prod tab is a disaster",
            is_bot: 0
          },
          {
            author_name: "jake",
            content: "yeah I'll grab them in a sec",
            is_bot: 0
          }
        ],
        replyEagerness: 10,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.05,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: true,
          repliesToOtherUser: true
        }
      })
  },
  ...eagernessSweep({
    labelTemplate: "text ambient reply-channel riff @ eagerness {e}",
    levels: [10, 25, 75],
    threshold: 75,
    buildPrompt: (replyEagerness) =>
      buildTextPrompt({
        messageContent: "man I need a new co-op game for tonight",
        recentMessages: [
          {
            author_name: "alice",
            content: "steam sale has me window shopping again",
            is_bot: 0
          }
        ],
        replyEagerness,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.08,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: false,
          repliesToOtherUser: false
        },
        channelMode: "reply_channel"
      })
  }),
  {
    label: "text follow-up question to bot gets reply",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "wait what about multiplayer though?",
        recentMessages: [
          {
            author_name: "alice",
            content: "clanker conk, what's a good roguelike?",
            is_bot: 0
          },
          {
            author_name: "clanker conk",
            content: "Hades is a great pick — tight combat and the story loop keeps pulling you back.",
            is_bot: 1
          }
        ],
        replyEagerness: 55,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.65,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: false,
          repliesToOtherUser: false
        }
      })
  },
  {
    label: "text pure emoji message gets skipped",
    expected: "skip",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "lmaooo 💀💀💀",
        recentMessages: [
          {
            author_name: "jake",
            content: "did you see that clip",
            is_bot: 0
          }
        ],
        replyEagerness: 20,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.02,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: false,
          repliesToOtherUser: false
        }
      })
  },
  {
    label: "text bot-to-bot conversation gets skipped",
    expected: "skip",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "The weather in Tokyo is currently 22°C and partly cloudy.",
        recentMessages: [
          {
            author_name: "weather-bot",
            content: "!weather tokyo",
            is_bot: 1
          }
        ],
        replyEagerness: 30,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.03,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: false,
          repliesToOtherUser: false
        }
      })
  }
];

const DIRECT_ADDRESSED = {
  directlyAddressed: true,
  directAddressConfidence: 0.99,
  directAddressThreshold: 0.62,
  responseRequired: true,
  mentionsOtherUsers: false,
  repliesToOtherUser: false
};

const textToolSelectionScenarios: ToolSelectionScenario[] = [
  {
    label: "text tool selection chooses web_search for current facts",
    expectedTool: "web_search",
    expectedInputPattern: /bun|version|latest/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, look up the latest Bun version online and tell me what it is.",
        recentMessages: [
          {
            author_name: "alice",
            content: "don't guess, just check it",
            is_bot: 0
          }
        ],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        webSearchEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["web_search", "web_scrape", "conversation_search"])
      };
    }
  },
  {
    label: "text tool selection chooses web_scrape for a specific url",
    expectedTool: "web_scrape",
    expectedInputPattern: /https:\/\/example\.com/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, read https://example.com and summarize it in one sentence.",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        webSearchEnabled: true,
        browserEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["web_search", "web_scrape", "browser_browse"])
      };
    }
  },
  {
    label: "text tool selection chooses conversation_search for earlier chat recall",
    expectedTool: "conversation_search",
    expectedInputPattern: /roguelike|starter/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, what did we say last week about starter roguelikes?",
        recentMessages: [
          {
            author_name: "alice",
            content: "I know we talked about it before, not just today",
            is_bot: 0
          }
        ],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        webSearchEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["conversation_search", "web_search"])
      };
    }
  },
  {
    label: "text tool selection chooses adaptive_directive_add for standing behavior",
    expectedTool: "adaptive_directive_add",
    expectedInputPattern: /captain|concise/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, from now on call me Captain and keep your replies brutally concise.",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        memoryEnabled: true,
        adaptiveDirectivesEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["adaptive_directive_add", "memory_write", "conversation_search"])
      };
    }
  },
  {
    label: "text tool selection chooses memory_write for remember-this request",
    expectedTool: "memory_write",
    expectedInputPattern: /favorite|color|blue/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, remember that my favorite color is blue.",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        memoryEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["memory_write", "memory_search", "web_search"])
      };
    }
  },
  {
    label: "text tool selection chooses memory_search for recall request",
    expectedTool: "memory_search",
    expectedInputPattern: /favorite|preference|color/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, what do you remember about my preferences?",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        memoryEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["memory_search", "memory_write", "web_search"])
      };
    }
  },
  {
    label: "text tool selection chooses browser_browse for interactive exploration",
    expectedTool: "browser_browse",
    expectedInputPattern: /reddit|thread|browse/i,
    buildPrompt: () => {
      const prompt = buildTextPrompt({
        messageContent: "clanker conk, browse through the top posts on reddit right now and tell me what's trending.",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        webSearchEnabled: true,
        browserEnabled: true
      });
      return {
        ...prompt,
        tools: buildToolMenu(prompt.settings, ["browser_browse", "web_search", "web_scrape"])
      };
    }
  }
];

const textStructuredJsonScenarios: LiveScenario[] = [
  {
    label: "text structured output stays strict json for reply",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, give me one short opinion on pizza toppings.",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED
      })
  },
  {
    label: "text structured output stays strict json for skip",
    expected: "skip",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "@jake can you DM me the staging notes later?",
        recentMessages: [
          {
            author_name: "alice",
            content: "I forgot where I put them",
            is_bot: 0
          }
        ],
        replyEagerness: 10,
        addressing: {
          directlyAddressed: false,
          directAddressConfidence: 0.04,
          directAddressThreshold: 0.62,
          responseRequired: false,
          mentionsOtherUsers: true,
          repliesToOtherUser: true
        }
      })
  },
  {
    label: "text structured output includes reaction emoji when appropriate",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, I just shipped my first open source project!",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED
      })
  },
  {
    label: "text structured output sets webSearchQuery for lookup directive",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, who won the most recent Super Bowl?",
        recentMessages: [],
        replyEagerness: 70,
        addressing: DIRECT_ADDRESSED,
        webSearchEnabled: true,
        allowWebSearchDirective: true
      })
  }
];

const BLUE_SQUARE_IMAGE: PromptImageInput = {
  filename: "blue-square.png",
  contentType: "image/png",
  mediaType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgYPhPIhrVMKph2GoAAJLb/wFh5Z4RAAAAAElFTkSuQmCC"
};

const textImageScenarios: LiveScenario[] = [
  {
    label: "text vision reply references the attached image",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, what color is the attached image?",
        recentMessages: [],
        replyEagerness: 70,
        imageInputs: [RED_SQUARE_IMAGE],
        addressing: DIRECT_ADDRESSED
      })
  },
  {
    label: "text vision describes image content without explicit color question",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, describe what you see in this image",
        recentMessages: [],
        replyEagerness: 70,
        imageInputs: [RED_SQUARE_IMAGE],
        addressing: DIRECT_ADDRESSED
      })
  },
  {
    label: "text vision handles multiple image attachments",
    expected: "reply",
    buildPrompt: () =>
      buildTextPrompt({
        messageContent: "clanker conk, are these two images the same color?",
        recentMessages: [],
        replyEagerness: 70,
        imageInputs: [RED_SQUARE_IMAGE, BLUE_SQUARE_IMAGE],
        addressing: DIRECT_ADDRESSED
      })
  }
];

function validateProviderReadiness(binding: LiveBinding, kind: "TEXT" | "VOICE") {
  if (binding.provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is required when ${kind}_LLM_PROVIDER=openai`);
  }
  if (binding.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(`ANTHROPIC_API_KEY is required when ${kind}_LLM_PROVIDER=anthropic`);
  }
  if (binding.provider === "claude-oauth" && !isClaudeOAuthConfigured(process.env.CLAUDE_OAUTH_REFRESH_TOKEN || "")) {
    throw new Error(`CLAUDE_OAUTH_REFRESH_TOKEN or data/claude-oauth-tokens.json is required when ${kind}_LLM_PROVIDER=claude-oauth`);
  }
  if (binding.provider === "codex-oauth" && !isCodexOAuthConfigured(process.env.CODEX_OAUTH_REFRESH_TOKEN || "")) {
    throw new Error(`CODEX_OAUTH_REFRESH_TOKEN or data/codex-oauth-tokens.json is required when ${kind}_LLM_PROVIDER=codex-oauth`);
  }
  if (binding.provider === "xai" && !process.env.XAI_API_KEY) {
    throw new Error(`XAI_API_KEY is required when ${kind}_LLM_PROVIDER=xai`);
  }
}

beforeAll(() => {
  validateProviderReadiness(TEXT_BINDING, "TEXT");
  validateProviderReadiness(VOICE_BINDING, "VOICE");

  llm = new LLMService({
    appConfig: {
      openaiApiKey: process.env.OPENAI_API_KEY || "",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
      claudeOAuthRefreshToken: process.env.CLAUDE_OAUTH_REFRESH_TOKEN || "",
      codexOAuthRefreshToken: process.env.CODEX_OAUTH_REFRESH_TOKEN || "",
      xaiApiKey: process.env.XAI_API_KEY || "",
      xaiBaseUrl: process.env.XAI_BASE_URL || ""
    },
    store: {
      logAction(entry) {
        LOGS.push(entry);
      }
    }
  });

  if ((TEXT_BINDING.provider === "codex-cli" || VOICE_BINDING.provider === "codex-cli") && !llm.codexCliAvailable) {
    throw new Error("codex-cli provider requires the 'codex' CLI to be installed.");
  }
});

afterAll(() => {
  llm?.close();
  llm = null;
});

const textTimeoutMs = TEXT_BINDING.provider === "codex-cli" ? 30_000 : 15_000;
const voiceTimeoutMs = VOICE_BINDING.provider === "codex-cli" ? 30_000 : 15_000;

describe("text reply live tests", () => {
  for (const scenario of textScenarios.filter((entry) => matchesFilter(entry.label))) {
    test(scenario.label, async () => {
      const result = await runStructuredReplyScenario(scenario.label, scenario.buildPrompt());
      assertExpectedReply({
        label: scenario.label,
        expected: scenario.expected,
        raw: result.raw,
        parsedText: result.parsed.text
      });
    }, textTimeoutMs);
  }
});

describe("text tool selection live tests", () => {
  if (!supportsToolCalling(TEXT_BINDING)) {
    console.log(`Skipping text tool selection scenarios for unsupported provider: ${TEXT_BINDING.provider}`);
    return;
  }

  for (const scenario of textToolSelectionScenarios.filter((entry) => matchesFilter(entry.label))) {
    test(scenario.label, async () => {
      const generation = await runLiveGeneration(scenario.label, scenario.buildPrompt());
      assertExpectedToolCall({
        label: scenario.label,
        generation,
        expectedTool: scenario.expectedTool,
        expectedInputPattern: scenario.expectedInputPattern
      });
    }, textTimeoutMs);
  }
});

describe("text structured output live tests", () => {
  for (const scenario of textStructuredJsonScenarios.filter((entry) => matchesFilter(entry.label))) {
    test(scenario.label, async () => {
      const result = await runStructuredReplyScenario(scenario.label, scenario.buildPrompt());
      assertExpectedReply({
        label: scenario.label,
        expected: scenario.expected,
        raw: result.raw,
        parsedText: result.parsed.text
      });
      assertStrictStructuredReplyShape(scenario.label, result.raw);

      // Scenario-specific structured field assertions
      if (scenario.label.includes("reaction emoji")) {
        const rawJson = extractJsonObjectFromText(result.raw);
        assert.ok(
          rawJson && (rawJson.reactionEmoji != null || result.parsed.text.length > 0),
          `Expected reaction emoji or substantive reply for ${scenario.label}`
        );
      }

      if (scenario.label.includes("webSearchQuery")) {
        const rawJson = extractJsonObjectFromText(result.raw);
        assert.ok(
          rawJson && (typeof rawJson.webSearchQuery === "string" && rawJson.webSearchQuery.length > 0),
          `Expected webSearchQuery to be set for ${scenario.label}, got ${JSON.stringify(rawJson?.webSearchQuery)}`
        );
      }
    }, textTimeoutMs);
  }
});

describe("text vision live tests", () => {
  if (!supportsVision(TEXT_BINDING)) {
    console.log(`Skipping text vision scenarios for unsupported provider: ${TEXT_BINDING.provider}`);
    return;
  }

  test("text vision reply references the attached image", async () => {
    if (!matchesFilter("text vision reply references the attached image")) return;
    const scenario = textImageScenarios[0]!;
    const result = await runStructuredReplyScenario(scenario.label, scenario.buildPrompt());
    assertExpectedReply({
      label: scenario.label,
      expected: scenario.expected,
      raw: result.raw,
      parsedText: result.parsed.text
    });
    assert.match(
      String(result.parsed.text || ""),
      /\bred\b|\bscarlet\b|\bcrimson\b/i,
      `Expected reply to reference the red image, got ${JSON.stringify(result.parsed.text)}`
    );
  }, textTimeoutMs);

  test("text vision describes image content without explicit color question", async () => {
    if (!matchesFilter("text vision describes image content without explicit color question")) return;
    const scenario = textImageScenarios[1]!;
    const result = await runStructuredReplyScenario(scenario.label, scenario.buildPrompt());
    assertExpectedReply({
      label: scenario.label,
      expected: scenario.expected,
      raw: result.raw,
      parsedText: result.parsed.text
    });
    // Should mention something visual — color, shape, square, image, etc.
    assert.match(
      String(result.parsed.text || ""),
      /\bred\b|\bsquare\b|\bimage\b|\bcolor\b|\bblock\b|\bpixel\b/i,
      `Expected reply to describe visual content, got ${JSON.stringify(result.parsed.text)}`
    );
  }, textTimeoutMs);

  test("text vision handles multiple image attachments", async () => {
    if (!matchesFilter("text vision handles multiple image attachments")) return;
    const scenario = textImageScenarios[2]!;
    const result = await runStructuredReplyScenario(scenario.label, scenario.buildPrompt());
    assertExpectedReply({
      label: scenario.label,
      expected: scenario.expected,
      raw: result.raw,
      parsedText: result.parsed.text
    });
    // Should indicate the images are different colors
    assert.match(
      String(result.parsed.text || ""),
      /\bno\b|\bdifferen|\bnot\b.*\bsame\b|\bred\b.*\bblue\b|\bblue\b.*\bred\b/i,
      `Expected reply to distinguish two different-colored images, got ${JSON.stringify(result.parsed.text)}`
    );
  }, textTimeoutMs);
});

describe("voice reply live tests", () => {
  for (const scenarioGroup of VOICE_LIVE_SHARED_SCENARIO_GROUPS) {
    const filteredScenarios = scenarioGroup.scenarios.filter((scenario) => matchesFilter(scenario.label));
    if (!filteredScenarios.length) continue;

    describe(scenarioGroup.label, () => {
      for (const scenario of filteredScenarios) {
        test(scenario.label, async () => {
          const result = await runStructuredReplyScenario(scenario.label, buildVoicePrompt(scenario));
          assertExpectedReply({
            label: scenario.label,
            expected: scenario.expected.generation,
            raw: result.raw,
            parsedText: result.parsed.text,
            parsedVoiceIntent: result.parsed.voiceIntent,
            expectedVoiceIntent: scenario.expected.voiceIntent
          });
        }, voiceTimeoutMs);
      }
    });
  }
});
