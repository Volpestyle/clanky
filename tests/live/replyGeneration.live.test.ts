/**
 * Live structured-reply tests for text and voice generation.
 *
 * GENERATION LLM ONLY — no classifier. Each scenario builds a full generation
 * prompt (buildSystemPrompt + buildVoiceTurnPrompt) and sends it directly to
 * the LLM via llm.generate(). The classifier admission pipeline
 * (evaluateVoiceReplyDecision) is never called here.
 *
 * Asserts whether the generation LLM's structured output is a real spoken
 * reply or [SKIP] — i.e. "does the brain make the right call given context?"
 *
 * Env:
 *   LIVE_REPLY_FILTER=text|voice|label-substring
 *   LIVE_REPLY_DEBUG=1
 *   TEXT_LLM_PROVIDER=openai|anthropic|claude-oauth|xai|codex-cli
 *   TEXT_LLM_MODEL=...
 *   VOICE_LLM_PROVIDER=openai|anthropic|claude-oauth|xai|codex-cli
 *   VOICE_LLM_MODEL=...
 *
 * Examples:
 *   bun test tests/live/replyGeneration.live.test.ts
 *   TEXT_LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... bun test tests/live/replyGeneration.live.test.ts
 *   TEXT_LLM_PROVIDER=claude-oauth VOICE_LLM_PROVIDER=claude-oauth VOICE_LLM_MODEL=claude-sonnet-4-6 bun test tests/live/replyGeneration.live.test.ts
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { REPLY_OUTPUT_JSON_SCHEMA, parseStructuredReplyOutput } from "../../src/bot/botHelpers.ts";
import { LLMService } from "../../src/llm.ts";
import { normalizeDefaultModel, normalizeLlmProvider } from "../../src/llm/llmHelpers.ts";
import { parseBooleanFlag } from "../../src/normalization/valueParsers.ts";
import { buildReplyPrompt, buildSystemPrompt, buildVoiceTurnPrompt } from "../../src/prompts/index.ts";
import { buildVoiceToneGuardrails } from "../../src/prompts/promptCore.ts";
import {
  applyOrchestratorOverrideSettings,
  getResolvedOrchestratorBinding,
  getResolvedVoiceGenerationBinding
} from "../../src/settings/agentStack.ts";
import { isClaudeOAuthConfigured } from "../../src/llm/claudeOAuth.ts";
import { createTestSettings } from "../../src/testSettings.ts";
import {
  isVoiceTurnAddressedToBot
} from "../../src/voice/voiceSessionHelpers.ts";
import {
  VOICE_LIVE_SCENARIO_GROUPS,
  type VoiceLiveScenario
} from "./shared/voiceLiveScenarios.ts";

type LiveBinding = {
  provider: string;
  model: string;
};

type PromptEnvelope = {
  binding: LiveBinding;
  settings: unknown;
  systemPrompt: string;
  userPrompt: string;
};

type LiveScenario = {
  label: string;
  expected: "reply" | "skip";
  buildPrompt: () => PromptEnvelope;
};

const SUPPORTED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "claude-oauth",
  "xai",
  "codex-cli"
]);

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5",
  "claude-oauth": "claude-sonnet-4-6",
  xai: "grok-3-mini-latest",
  "codex-cli": "gpt-5.4"
};

const LIVE_REPLY_FILTER = String(process.env.LIVE_REPLY_FILTER || "").trim().toLowerCase();
const LIVE_REPLY_DEBUG = parseBooleanFlag(process.env.LIVE_REPLY_DEBUG, false);
const TEXT_BINDING = resolveLiveBinding("TEXT", "claude-oauth");
const VOICE_BINDING = resolveLiveBinding("VOICE", "claude-oauth");
const LOGS: Array<Record<string, unknown>> = [];

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
  voiceEagerness = 50
}: {
  botName?: string;
  textBinding?: LiveBinding;
  voiceBinding?: LiveBinding;
  replyEagerness?: number;
  voiceEagerness?: number;
} = {}) {
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
      enabled: false
    },
    webSearch: {
      enabled: false
    },
    adaptiveDirectives: {
      enabled: false
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

function buildTextPrompt({
  messageContent,
  recentMessages,
  replyEagerness,
  addressing,
  channelMode = "other_channel"
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
}): PromptEnvelope {
  const settings = buildBaseSettings({ replyEagerness });
  return {
    binding: getResolvedOrchestratorBinding(settings),
    settings,
    systemPrompt: buildSystemPrompt(settings),
    userPrompt: buildReplyPrompt({
      message: {
        authorName: "alice",
        content: messageContent
      },
      triggerMessageIds: ["msg-live-1"],
      imageInputs: [],
      recentMessages,
      relevantMessages: [],
      userFacts: [],
      relevantFacts: [],
      emojiHints: [],
      reactionEmojiOptions: [],
      replyEagerness,
      reactionEagerness: 15,
      addressing,
      webSearch: {
        enabled: false,
        configured: false,
        used: false,
        blockedByBudget: false,
        optedOutByUser: false,
        budget: {
          canSearch: false
        }
      },
      browserBrowse: {
        enabled: false,
        configured: false,
        used: false,
        blockedByBudget: false,
        budget: {
          canBrowse: false
        }
      },
      recentConversationHistory: [],
      recentWebLookups: [],
      memoryLookup: null,
      imageLookup: null,
      allowWebSearchDirective: false,
      allowBrowserBrowseDirective: false,
      allowMemoryLookupDirective: false,
      allowImageLookupDirective: false,
      allowMemoryDirective: false,
      allowAdaptiveDirective: false,
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
    maxOutputTokens: 220
  });
  const directAddressed =
    (sc.inputKind || "transcript") !== "event" &&
    isVoiceTurnAddressedToBot(sc.transcript, settings);
  const engaged = Boolean(sc.recentAssistantReply) || sc.msSinceDirectAddress != null;
  const speakerName = sc.speaker || sc.participants[0] || "someone";
  const participantRoster = Array.isArray(sc.participants) ? sc.participants : [];
  const conversationContext = {
    recentAssistantReply: Boolean(sc.recentAssistantReply),
    msSinceAssistantReply: sc.msSinceAssistantReply ?? null,
    msSinceDirectAddress: sc.msSinceDirectAddress ?? null,
    engaged,
    engagedWithCurrentSpeaker: engaged,
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
  parsedText = null
}: {
  label: string;
  binding: LiveBinding;
  stage: "prompt" | "result";
  systemPrompt?: string | null;
  userPrompt?: string | null;
  raw?: string | null;
  parsedText?: string | null;
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
  console.error(lines.join("\n"));
}

async function runStructuredReplyScenario(label: string, prompt: PromptEnvelope) {
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
    contextMessages: [],
    jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
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
    parsedText: String(parsed.text || "")
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

  return {
    raw,
    parsed
  };
}

function assertExpectedReply({
  label,
  expected,
  raw,
  parsedText
}: {
  label: string;
  expected: "reply" | "skip" | "either";
  raw: string;
  parsedText: string;
}) {
  const normalizedText = String(parsedText || "").trim();
  if (expected === "reply") {
    assert.ok(
      Boolean(normalizedText) && normalizedText !== "[SKIP]",
      `Expected a spoken reply but got ${JSON.stringify(normalizedText)} (raw: ${JSON.stringify(raw)}) for ${label}`
    );
    return;
  }

  if (expected === "either") {
    assert.ok(
      Boolean(normalizedText),
      `Expected a non-empty structured output but got ${JSON.stringify(normalizedText)} (raw: ${JSON.stringify(raw)}) for ${label}`
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
  })
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

describe("voice reply live tests", () => {
  for (const scenarioGroup of VOICE_LIVE_SCENARIO_GROUPS) {
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
            parsedText: result.parsed.text
          });
        }, voiceTimeoutMs);
      }
    });
  }
});
