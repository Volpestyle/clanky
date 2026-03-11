import { parseStructuredReplyOutput } from "../../../src/botHelpers.ts";
import { shouldAttemptReplyDecision } from "../../../src/bot/replyAdmission.ts";
import { buildReplyPrompt, buildSystemPrompt } from "../../../src/prompts.ts";
import { isBotNameAddressed } from "../../../src/voice/voiceSessionHelpers.ts";
import {
  parseMetadataObject,
  queryRecordedActions
} from "../core/db.ts";
import { runReplayEngine } from "../core/engine.ts";
import { printTurnSnapshots, writeJsonReport } from "../core/output.ts";
import type {
  ActionRow,
  ChannelMode,
  CreateScenarioStateInput,
  LoadDbStateInput,
  ReplayBaseArgs,
  ReplayDecision,
  ReplayEvent,
  ReplayScenarioDefinition
} from "../core/types.ts";
import {
  clamp,
  formatPct,
  isoInWindow,
  stableNumber,
  toRecentMessagesDesc
} from "../core/utils.ts";
import { runJsonJudge } from "../core/judge.ts";

type FloodingReplayArgs = ReplayBaseArgs & {
  actorProvider: string;
  actorModel: string;
  judgeProvider: string;
  judgeModel: string;
  judge: boolean;
  windowStart: string;
  windowEnd: string;
  assertMaxUnaddressedSendRate: number;
  assertMaxUnaddressedSends: number;
  assertMinAddressedSendRate: number;
  assertMinAddressedSends: number;
  assertMaxSentTurns: number;
  assertMinLlmCalls: number;
  failOnLlmError: boolean;
};

type ChannelStats = {
  channelMode: ChannelMode;
  userTurns: number;
  addressedTurns: number;
  unaddressedTurns: number;
  attemptedTurns: number;
  attemptedAddressed: number;
  attemptedUnaddressed: number;
  sentTurns: number;
  sentAddressed: number;
  sentUnaddressed: number;
  skippedTurns: number;
  skippedAddressed: number;
  skippedUnaddressed: number;
  voiceIntentTurns: number;
  noActionTurns: number;
  errorTurns: number;
  llmCalls: number;
  llmCostUsd: number;
};

type JudgeResult = {
  isFlooding: boolean;
  floodScore: number;
  confidence: number;
  summary: string;
  signals: string[];
  rawText: string;
};

type FloodingDbState = {
  decisionByTrigger: Map<string, ActionRow>;
  voiceIntentByMessage: Map<string, ActionRow>;
};

type FloodingScenarioState = {
  actorSettings: Record<string, unknown>;
  judgeSettings: Record<string, unknown>;
  initiativeStats: ChannelStats;
  nonInitiativeStats: ChannelStats;
  decisionByTrigger: Map<string, ActionRow>;
  voiceIntentByMessage: Map<string, ActionRow>;
};

const DEFAULT_ARGS: FloodingReplayArgs = {
  mode: "recorded",
  dbPath: "data/clanker.db",
  since: "2026-02-27T00:00:00.000Z",
  until: "",
  historyLookbackHours: 6,
  channelId: "",
  maxTurns: 0,
  snapshotsLimit: 40,
  actorProvider: "",
  actorModel: "",
  judgeProvider: "",
  judgeModel: "",
  judge: true,
  windowStart: "2026-02-27T16:28:30.000Z",
  windowEnd: "2026-02-27T16:32:45.000Z",
  assertMaxUnaddressedSendRate: -1,
  assertMaxUnaddressedSends: -1,
  assertMinAddressedSendRate: -1,
  assertMinAddressedSends: -1,
  assertMaxSentTurns: -1,
  assertMinLlmCalls: -1,
  failOnLlmError: false,
  outJsonPath: ""
};

function parseFloodingReplayArgs(argv: string[]): FloodingReplayArgs {
  const out: FloodingReplayArgs = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || "").trim();
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const rawValue = String(argv[i + 1] || "").trim();
    const needsValue = !["judge", "no-judge", "fail-on-llm-error"].includes(name);
    if (needsValue && !rawValue.startsWith("--")) {
      i += 1;
    }

    switch (name) {
      case "mode":
        out.mode = rawValue === "live" ? "live" : "recorded";
        break;
      case "db":
        out.dbPath = rawValue || out.dbPath;
        break;
      case "since":
        out.since = rawValue || out.since;
        break;
      case "until":
        out.until = rawValue;
        break;
      case "channel-id":
        out.channelId = rawValue;
        break;
      case "history-lookback-hours":
        out.historyLookbackHours = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "max-turns":
        out.maxTurns = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "snapshots-limit":
        out.snapshotsLimit = Math.max(0, Math.floor(Number(rawValue) || 0));
        break;
      case "actor-provider":
        out.actorProvider = rawValue;
        break;
      case "actor-model":
        out.actorModel = rawValue;
        break;
      case "judge-provider":
        out.judgeProvider = rawValue;
        break;
      case "judge-model":
        out.judgeModel = rawValue;
        break;
      case "judge":
        out.judge = true;
        break;
      case "no-judge":
        out.judge = false;
        break;
      case "window-start":
        out.windowStart = rawValue;
        break;
      case "window-end":
        out.windowEnd = rawValue;
        break;
      case "assert-max-unaddressed-send-rate":
        out.assertMaxUnaddressedSendRate = Number.isFinite(Number(rawValue))
          ? Number(rawValue)
          : -1;
        break;
      case "assert-max-unaddressed-sends":
        out.assertMaxUnaddressedSends = Number.isFinite(Number(rawValue))
          ? Math.floor(Number(rawValue))
          : -1;
        break;
      case "assert-min-addressed-send-rate":
        out.assertMinAddressedSendRate = Number.isFinite(Number(rawValue))
          ? Number(rawValue)
          : -1;
        break;
      case "assert-min-addressed-sends":
        out.assertMinAddressedSends = Number.isFinite(Number(rawValue))
          ? Math.floor(Number(rawValue))
          : -1;
        break;
      case "assert-max-sent-turns":
        out.assertMaxSentTurns = Number.isFinite(Number(rawValue))
          ? Math.floor(Number(rawValue))
          : -1;
        break;
      case "assert-min-llm-calls":
        out.assertMinLlmCalls = Number.isFinite(Number(rawValue))
          ? Math.floor(Number(rawValue))
          : -1;
        break;
      case "fail-on-llm-error":
        out.failOnLlmError = true;
        break;
      case "out-json":
        out.outJsonPath = rawValue;
        break;
      default:
        break;
    }
  }
  return out;
}

function buildAddressSignal({
  botUserId,
  botName,
  message,
  recentById
}: {
  botUserId: string;
  botName: string;
  message: { content: string; referenced_message_id: string | null };
  recentById: Map<string, { is_bot: number; author_id: string }>;
}) {
  const content = String(message.content || "");
  const normalized = content.toLowerCase();
  const mentioned =
    normalized.includes(`<@${botUserId.toLowerCase()}>`) ||
    normalized.includes(`<@!${botUserId.toLowerCase()}>`);
  const namePing = isBotNameAddressed({
    transcript: content,
    botName
  });
  const referencedId = String(message.referenced_message_id || "").trim();
  const referenced = referencedId ? recentById.get(referencedId) : null;
  const replyToBot = Boolean(
    referenced &&
      Number(referenced.is_bot) === 1 &&
      String(referenced.author_id) === botUserId
  );
  const direct = Boolean(mentioned || namePing || replyToBot);
  return {
    direct,
    inferred: false,
    triggered: direct,
    reason: direct ? "direct" : "llm_decides"
  };
}

function buildChannelStats(channelMode: ChannelMode): ChannelStats {
  return {
    channelMode,
    userTurns: 0,
    addressedTurns: 0,
    unaddressedTurns: 0,
    attemptedTurns: 0,
    attemptedAddressed: 0,
    attemptedUnaddressed: 0,
    sentTurns: 0,
    sentAddressed: 0,
    sentUnaddressed: 0,
    skippedTurns: 0,
    skippedAddressed: 0,
    skippedUnaddressed: 0,
    voiceIntentTurns: 0,
    noActionTurns: 0,
    errorTurns: 0,
    llmCalls: 0,
    llmCostUsd: 0
  };
}

function ensureLlmSettings(
  baseSettings: Record<string, unknown>,
  providerOverride: string,
  modelOverride: string
) {
  const next = structuredClone(baseSettings) as Record<string, unknown> & {
    llm?: Record<string, unknown>;
  };
  if (!next.llm || typeof next.llm !== "object") next.llm = {};
  if (providerOverride) next.llm.provider = providerOverride;
  if (modelOverride) next.llm.model = modelOverride;
  return next;
}

async function runLiveActorDecision({
  llm,
  settings,
  botUserId,
  message,
  recentMessages,
  addressed,
  ambientReplyEagerness,
  reactivity
}: {
  llm: {
    generate: (input: {
      settings: Record<string, unknown>;
      systemPrompt: string;
      userPrompt: string;
      trace: Record<string, unknown>;
    }) => Promise<{
      text: string;
      provider: string;
      model: string;
      costUsd: number;
    }>;
  };
  settings: Record<string, unknown>;
  botUserId: string;
  message: {
    guild_id: string | null;
    channel_id: string;
    message_id: string;
    author_name: string;
    content: string;
  };
  recentMessages: {
    author_name: string;
    content: string;
  }[];
  addressed: boolean;
  ambientReplyEagerness: number;
  reactivity: number;
}): Promise<ReplayDecision> {
  const systemPrompt = buildSystemPrompt(settings);
  const userPrompt = buildReplyPrompt({
    message: {
      authorName: String(message.author_name || "unknown"),
      content: String(message.content || "")
    },
    imageInputs: [],
    recentMessages,
    relevantMessages: [],
    userFacts: [],
    relevantFacts: [],
    emojiHints: [],
    reactionEmojiOptions: [],
    allowReplySimpleImages: false,
    allowReplyComplexImages: false,
    allowReplyVideos: false,
    allowReplyGifs: false,
    remainingReplyImages: 0,
    remainingReplyVideos: 0,
    remainingReplyGifs: 0,
    ambientReplyEagerness,
    reactivity,
    addressing: {
      directlyAddressed: addressed,
      responseRequired: addressed
    },
    webSearch: {
      enabled: false,
      configured: false,
      requested: false,
      used: false,
      query: "",
      results: [],
      blockedByBudget: false,
      budget: { maxPerHour: 0, remaining: 0 }
    },
    memoryLookup: {
      enabled: false,
      requested: false,
      used: false,
      query: "",
      results: [],
      error: null
    },
    imageLookup: {
      enabled: false,
      requested: false,
      used: false,
      query: "",
      candidates: [],
      results: [],
      error: null
    },
    allowWebSearchDirective: false,
    allowMemoryLookupDirective: false,
    allowImageLookupDirective: false,
    allowMemoryDirective: false,
    allowAutomationDirective: false,
    voiceMode: {
      enabled: Boolean(
        (settings as { voice?: { enabled?: boolean } })?.voice?.enabled
      )
    },
    screenShare: {
      enabled: false,
      status: "disabled",
      publicUrl: ""
    },
    videoContext: {
      requested: false,
      enabled: false,
      used: false,
      blockedByBudget: false,
      error: null,
      errors: [],
      detectedVideos: 0,
      detectedFromRecentMessages: false,
      videos: [],
      frameImages: [],
      budget: {
        maxPerHour: 0,
        used: 0,
        successCount: 0,
        errorCount: 0,
        remaining: 0,
        canLookup: false
      }
    },
    maxMediaPromptChars: Number(
      (
        settings as { initiative?: { maxMediaPromptChars?: number } }
      )?.initiative?.maxMediaPromptChars || 900
    ),
    mediaPromptCraftGuidance: ""
  });

  const generation = await llm.generate({
    settings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: message.guild_id || null,
      channelId: message.channel_id,
      userId: botUserId,
      source: "flooding_replay_actor",
      event: "turn_decision",
      reason: addressed ? "addressed" : "unaddressed",
      messageId: message.message_id
    }
  });

  const parsed = parseStructuredReplyOutput(
    generation.text,
    Number(
      (
        settings as { initiative?: { maxMediaPromptChars?: number } }
      )?.initiative?.maxMediaPromptChars || 900
    )
  );
  const text = String(parsed.text || "").trim();
  const voiceIntent = String(parsed.voiceIntent?.intent || "").trim();
  const voiceIntentConfidence = stableNumber(parsed.voiceIntent?.confidence, 0);
  const voiceIntentThreshold = clamp(
    stableNumber(
      (settings as { voice?: { intentConfidenceThreshold?: number } })?.voice
        ?.intentConfidenceThreshold,
      0.75
    ),
    0.4,
    0.99
  );

  if (voiceIntent && voiceIntentConfidence >= voiceIntentThreshold) {
    return {
      kind: "voice_intent_detected",
      addressed,
      attempted: true,
      content: "",
      reason: "voice_intent_detected",
      voiceIntent,
      llmProvider: String(generation.provider || ""),
      llmModel: String(generation.model || ""),
      llmCostUsd: stableNumber(generation.costUsd, 0)
    };
  }

  if (!text || text === "[SKIP]") {
    return {
      kind: "reply_skipped",
      addressed,
      attempted: true,
      content: "llm_skip",
      reason: "llm_skip",
      voiceIntent: "",
      llmProvider: String(generation.provider || ""),
      llmModel: String(generation.model || ""),
      llmCostUsd: stableNumber(generation.costUsd, 0)
    };
  }

  return {
    kind: "sent_message",
    addressed,
    attempted: true,
    content: text,
    reason: "llm_send",
    voiceIntent: "",
    llmProvider: String(generation.provider || ""),
    llmModel: String(generation.model || ""),
    llmCostUsd: stableNumber(generation.costUsd, 0)
  };
}

async function runJudge({
  llm,
  settings,
  mode,
  windowTimeline,
  nonInitiativeStats,
  initiativeStats,
  windowStart,
  windowEnd
}: {
  llm: {
    generate: (input: {
      settings: Record<string, unknown>;
      systemPrompt: string;
      userPrompt: string;
      trace: Record<string, unknown>;
    }) => Promise<{ text: string }>;
  };
  settings: Record<string, unknown>;
  mode: "recorded" | "live";
  windowTimeline: ReplayEvent[];
  nonInitiativeStats: ChannelStats;
  initiativeStats: ChannelStats;
  windowStart: string;
  windowEnd: string;
}): Promise<JudgeResult> {
  const summarizedTimeline = windowTimeline
    .slice(0, 220)
    .map(
      (entry) =>
        `${entry.createdAt} | ${entry.role} | ${entry.authorName}: ${entry.content}`
    )
    .join("\n");

  const systemPrompt = [
    "You are a strict evaluator for Discord flooding behavior.",
    "Judge whether the bot is flooding chat.",
    "Flooding means the bot repeatedly jumps into unaddressed human conversation, dominates turn-taking, or adds low-value interruptions.",
    "In initiative channels, some extra chatter is allowed, but obvious domination still counts as flooding.",
    "Return strict JSON only."
  ].join("\n");

  const userPrompt = [
    `Mode: ${mode}`,
    `Window: ${windowStart || "(not set)"} -> ${windowEnd || "(not set)"}`,
    `Non-initiative stats: unaddressed_sent=${nonInitiativeStats.sentUnaddressed}, unaddressed_turns=${nonInitiativeStats.unaddressedTurns}, sent_turns=${nonInitiativeStats.sentTurns}, user_turns=${nonInitiativeStats.userTurns}`,
    `Initiative stats: unaddressed_sent=${initiativeStats.sentUnaddressed}, unaddressed_turns=${initiativeStats.unaddressedTurns}, sent_turns=${initiativeStats.sentTurns}, user_turns=${initiativeStats.userTurns}`,
    "Conversation timeline:",
    summarizedTimeline || "(no window events)",
    'Output schema: {"isFlooding":true|false,"floodScore":0..100,"confidence":0..1,"summary":"...","signals":["..."]}'
  ].join("\n\n");

  return await runJsonJudge<JudgeResult>({
    llm,
    settings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: null,
      channelId: null,
      userId: null,
      source: "flooding_replay_judge",
      event: "flooding_verdict"
    },
    onParsed: (parsed, rawText) => {
      const rawSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
      const signals = rawSignals
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 10);

      return {
        isFlooding: Boolean(parsed.isFlooding),
        floodScore: clamp(Math.floor(stableNumber(parsed.floodScore, 0)), 0, 100),
        confidence: clamp(stableNumber(parsed.confidence, 0), 0, 1),
        summary: String(parsed.summary || "").trim(),
        signals,
        rawText
      };
    },
    onParseError: (rawText) => ({
      isFlooding: false,
      floodScore: 0,
      confidence: 0,
      summary: "judge_parse_error",
      signals: [],
      rawText
    })
  });
}

function printStats(label: string, stats: ChannelStats) {
  const unaddressedSendRate =
    stats.unaddressedTurns > 0
      ? (100 * stats.sentUnaddressed) / stats.unaddressedTurns
      : 0;
  const addressedSendRate =
    stats.addressedTurns > 0 ? (100 * stats.sentAddressed) / stats.addressedTurns : 0;
  const attemptedRate =
    stats.userTurns > 0 ? (100 * stats.attemptedTurns) / stats.userTurns : 0;
  console.log(`${label}`);
  console.log(
    `  userTurns=${stats.userTurns} attemptedTurns=${stats.attemptedTurns} attemptedRate=${attemptedRate.toFixed(1)}%`
  );
  console.log(
    `  addressedTurns=${stats.addressedTurns} sent=${stats.sentAddressed} skipped=${stats.skippedAddressed} sendRate=${addressedSendRate.toFixed(1)}%`
  );
  console.log(
    `  unaddressedTurns=${stats.unaddressedTurns} sent=${stats.sentUnaddressed} skipped=${stats.skippedUnaddressed} sendRate=${unaddressedSendRate.toFixed(1)}%`
  );
  console.log(
    `  voiceIntentTurns=${stats.voiceIntentTurns} noActionTurns=${stats.noActionTurns} errors=${stats.errorTurns}`
  );
  console.log(`  llmCalls=${stats.llmCalls} llmCostUsd=${stats.llmCostUsd.toFixed(6)}`);
}

function evaluateAssertions({
  args,
  nonInitiativeStats,
  initiativeStats
}: {
  args: FloodingReplayArgs;
  nonInitiativeStats: ChannelStats;
  initiativeStats: ChannelStats;
}) {
  const failures: string[] = [];
  const nonAddressedRate = formatPct(
    nonInitiativeStats.sentAddressed,
    nonInitiativeStats.addressedTurns
  );
  const nonUnaddressedRate = formatPct(
    nonInitiativeStats.sentUnaddressed,
    nonInitiativeStats.unaddressedTurns
  );
  const totalErrorTurns = nonInitiativeStats.errorTurns + initiativeStats.errorTurns;
  const totalLlmCalls = nonInitiativeStats.llmCalls + initiativeStats.llmCalls;

  if (
    args.assertMaxUnaddressedSendRate >= 0 &&
    nonUnaddressedRate > args.assertMaxUnaddressedSendRate
  ) {
    failures.push(
      `assert-max-unaddressed-send-rate failed: actual=${nonUnaddressedRate.toFixed(1)} threshold=${args.assertMaxUnaddressedSendRate}`
    );
  }
  if (
    args.assertMaxUnaddressedSends >= 0 &&
    nonInitiativeStats.sentUnaddressed > args.assertMaxUnaddressedSends
  ) {
    failures.push(
      `assert-max-unaddressed-sends failed: actual=${nonInitiativeStats.sentUnaddressed} threshold=${args.assertMaxUnaddressedSends}`
    );
  }
  if (
    args.assertMinAddressedSendRate >= 0 &&
    nonAddressedRate < args.assertMinAddressedSendRate
  ) {
    failures.push(
      `assert-min-addressed-send-rate failed: actual=${nonAddressedRate.toFixed(1)} threshold=${args.assertMinAddressedSendRate}`
    );
  }
  if (
    args.assertMinAddressedSends >= 0 &&
    nonInitiativeStats.sentAddressed < args.assertMinAddressedSends
  ) {
    failures.push(
      `assert-min-addressed-sends failed: actual=${nonInitiativeStats.sentAddressed} threshold=${args.assertMinAddressedSends}`
    );
  }
  if (
    args.assertMaxSentTurns >= 0 &&
    nonInitiativeStats.sentTurns > args.assertMaxSentTurns
  ) {
    failures.push(
      `assert-max-sent-turns failed: actual=${nonInitiativeStats.sentTurns} threshold=${args.assertMaxSentTurns}`
    );
  }
  if (args.assertMinLlmCalls >= 0 && totalLlmCalls < args.assertMinLlmCalls) {
    failures.push(
      `assert-min-llm-calls failed: actual=${totalLlmCalls} threshold=${args.assertMinLlmCalls}`
    );
  }
  if (args.failOnLlmError && totalErrorTurns > 0) {
    failures.push(`fail-on-llm-error failed: llm_error_turns=${totalErrorTurns}`);
  }

  return failures;
}

function loadFloodingDbState({
  db,
  args,
  contextSince
}: LoadDbStateInput<FloodingReplayArgs>): FloodingDbState {
  const recordedDecisionRows = queryRecordedActions(
    db,
    args,
    contextSince,
    ["sent_reply", "sent_message", "reply_skipped"],
    "AND COALESCE(json_extract(metadata, '$.source'), '') LIKE 'message_event%'"
  );

  const voiceIntentRows = queryRecordedActions(
    db,
    args,
    contextSince,
    ["voice_intent_detected"],
    "",
    true
  );

  const decisionByTrigger = new Map<string, ActionRow>();
  for (const row of recordedDecisionRows) {
    const metadata = parseMetadataObject(row);
    const trigger = String(metadata.triggerMessageId || "").trim();
    if (!trigger) continue;
    decisionByTrigger.set(trigger, row);
  }

  const voiceIntentByMessage = new Map<string, ActionRow>();
  for (const row of voiceIntentRows) {
    const messageId = String(row.message_id || "");
    const metadata = parseMetadataObject(row);
    const inferredMessageId = String(metadata.messageId || "").trim();
    const key = messageId || inferredMessageId;
    if (!key) continue;
    voiceIntentByMessage.set(key, row);
  }

  return {
    decisionByTrigger,
    voiceIntentByMessage
  };
}

function createFloodingScenarioState({
  args,
  dbState,
  runtimeSettings
}: CreateScenarioStateInput<FloodingReplayArgs, FloodingDbState>): FloodingScenarioState {
  const actorSettings = ensureLlmSettings(
    runtimeSettings,
    args.actorProvider,
    args.actorModel
  );
  const judgeSettings = ensureLlmSettings(
    runtimeSettings,
    args.judgeProvider || args.actorProvider,
    args.judgeModel || args.actorModel
  );
  judgeSettings.llm = {
    ...(judgeSettings.llm || {}),
    temperature: 0,
    maxOutputTokens: 420
  };

  return {
    actorSettings,
    judgeSettings,
    initiativeStats: buildChannelStats("initiative"),
    nonInitiativeStats: buildChannelStats("non_initiative"),
    decisionByTrigger: dbState.decisionByTrigger,
    voiceIntentByMessage: dbState.voiceIntentByMessage
  };
}

const floodingScenario: ReplayScenarioDefinition<
  FloodingReplayArgs,
  FloodingScenarioState,
  FloodingDbState
> = {
  name: "flooding",
  loadDbState: loadFloodingDbState,
  createScenarioState: createFloodingScenarioState,
  async runTurn(input) {
    const {
      args,
      scenarioState,
      runtimeSettings,
      message,
      channelMode,
      history,
      historyByMessageId,
      botUserId,
      llmService
    } = input;
    const stats =
      channelMode === "initiative"
        ? scenarioState.initiativeStats
        : scenarioState.nonInitiativeStats;

    stats.userTurns += 1;
    const addressSignal = buildAddressSignal({
      botUserId,
      botName: String(runtimeSettings.botName || "clanker conk"),
      message,
      recentById: historyByMessageId
    });
    const addressed = Boolean(addressSignal.triggered);
    if (addressed) stats.addressedTurns += 1;
    else stats.unaddressedTurns += 1;

    const recentMessages = toRecentMessagesDesc(
      history,
      Number(
        (
          runtimeSettings as { memory?: { maxRecentMessages?: number } }
        )?.memory?.maxRecentMessages
      ) || 35
    );
    const attempted = shouldAttemptReplyDecision({
      botUserId,
      settings: runtimeSettings,
      recentMessages,
      addressSignal,
      forceRespond: false,
      triggerMessageId: message.message_id,
      windowSize: 5
    });

    if (attempted) {
      stats.attemptedTurns += 1;
      if (addressed) stats.attemptedAddressed += 1;
      else stats.attemptedUnaddressed += 1;
    }

    let decision: ReplayDecision;
    if (!attempted && args.mode === "live") {
      decision = {
        kind: "no_action",
        addressed,
        attempted: false,
        content: "",
        reason: "admission_not_attempted",
        voiceIntent: "",
        llmProvider: "",
        llmModel: "",
        llmCostUsd: 0
      };
    } else if (args.mode === "recorded") {
      const recorded = scenarioState.decisionByTrigger.get(String(message.message_id));
      if (recorded) {
        if (recorded.kind === "reply_skipped") {
          decision = {
            kind: "reply_skipped",
            addressed,
            attempted: true,
            content: "llm_skip",
            reason: "recorded_reply_skipped",
            voiceIntent: "",
            llmProvider: "",
            llmModel: "",
            llmCostUsd: 0
          };
        } else {
          decision = {
            kind: recorded.kind === "sent_reply" ? "sent_reply" : "sent_message",
            addressed,
            attempted: true,
            content: String(recorded.content || ""),
            reason: "recorded_sent",
            voiceIntent: "",
            llmProvider: "",
            llmModel: "",
            llmCostUsd: 0
          };
        }
      } else {
        const voiceIntent = scenarioState.voiceIntentByMessage.get(
          String(message.message_id)
        );
        if (voiceIntent) {
          decision = {
            kind: "voice_intent_detected",
            addressed,
            attempted: true,
            content: "",
            reason: "recorded_voice_intent",
            voiceIntent: String(voiceIntent.content || ""),
            llmProvider: "",
            llmModel: "",
            llmCostUsd: 0
          };
        } else {
          decision = {
            kind: "no_action",
            addressed,
            attempted: true,
            content: "",
            reason: "recorded_no_action",
            voiceIntent: "",
            llmProvider: "",
            llmModel: "",
            llmCostUsd: 0
          };
        }
      }
    } else {
      const ambientReplyEagerness = clamp(
        stableNumber(
          channelMode === "initiative"
            ? (
                runtimeSettings as {
                  interaction?: {
                    activity?: { ambientReplyEagerness?: number };
                  };
                }
              )?.interaction?.activity?.ambientReplyEagerness
            : (
                runtimeSettings as {
                  interaction?: {
                    activity?: { ambientReplyEagerness?: number };
                  };
                }
              )?.interaction?.activity?.ambientReplyEagerness,
          0
        ),
        0,
        100
      );
      const reactivity = clamp(
        stableNumber(
          (
            runtimeSettings as {
              interaction?: {
                activity?: { reactivity?: number };
              };
            }
          )?.interaction?.activity?.reactivity,
          20
        ),
        0,
        100
      );

      try {
        decision = await runLiveActorDecision({
          llm: llmService,
          settings: scenarioState.actorSettings,
          botUserId,
          message,
          recentMessages,
          addressed,
          ambientReplyEagerness,
          reactivity
        });
        stats.llmCalls += 1;
        stats.llmCostUsd += decision.llmCostUsd;
      } catch (error) {
        decision = {
          kind: "no_action",
          addressed,
          attempted: true,
          content: "",
          reason: `actor_error:${String((error as Error)?.message || error)}`,
          voiceIntent: "",
          llmProvider: "",
          llmModel: "",
          llmCostUsd: 0
        };
        stats.errorTurns += 1;
      }
    }

    if (decision.kind === "voice_intent_detected") {
      stats.voiceIntentTurns += 1;
    } else if (decision.kind === "reply_skipped") {
      stats.skippedTurns += 1;
      if (addressed) stats.skippedAddressed += 1;
      else stats.skippedUnaddressed += 1;
    } else if (decision.kind === "no_action") {
      stats.noActionTurns += 1;
    } else {
      stats.sentTurns += 1;
      if (addressed) stats.sentAddressed += 1;
      else stats.sentUnaddressed += 1;
    }

    return {
      addressed,
      attempted: Boolean(decision.attempted),
      decision
    };
  }
};

export async function runFloodingReplayHarness(argv: string[]) {
  const args = parseFloodingReplayArgs(argv);
  const replay = await runReplayEngine(floodingScenario, args);
  const { initiativeStats, nonInitiativeStats, judgeSettings } = replay.scenarioState;

  const windowTimeline = replay.timeline.filter((event) => {
    if (!isoInWindow(event.createdAt, args.windowStart, args.windowEnd)) return false;
    if (args.channelId && event.channelId !== args.channelId) return false;
    return true;
  });
  const windowTurnSnapshots = replay.turnSnapshots.filter((snapshot) => {
    if (!isoInWindow(snapshot.createdAt, args.windowStart, args.windowEnd)) return false;
    if (args.channelId && snapshot.channelId !== args.channelId) return false;
    return true;
  });

  let judgeResult: JudgeResult | null = null;
  if (args.mode === "live" && args.judge && args.windowStart && args.windowEnd) {
    try {
      judgeResult = await runJudge({
        llm: replay.llmService,
        settings: judgeSettings,
        mode: args.mode,
        windowTimeline,
        nonInitiativeStats,
        initiativeStats,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd
      });
    } catch (error) {
      judgeResult = {
        isFlooding: false,
        floodScore: 0,
        confidence: 0,
        summary: `judge_error: ${String((error as Error)?.message || error)}`,
        signals: [],
        rawText: ""
      };
    }
  }

  console.log("Flooding Replay Harness");
  console.log(`mode=${args.mode}`);
  console.log(`db=${args.dbPath}`);
  console.log(`contextSince=${replay.contextSince}`);
  console.log(`since=${args.since}`);
  if (args.until) console.log(`until=${args.until}`);
  if (args.channelId) console.log(`channelId=${args.channelId}`);
  console.log(`processedUserTurns=${replay.processedTurns}`);
  console.log(`botUserId=${replay.botUserId}`);
  console.log(`initiativeChannelIds=[${[...replay.initiativeChannelIds].join(", ")}]`);
  console.log("");

  printStats("initiative", initiativeStats);
  console.log("");
  printStats("non_initiative", nonInitiativeStats);
  console.log("");

  if (windowTimeline.length) {
    console.log(
      `windowTimeline events=${windowTimeline.length} (${args.windowStart} -> ${args.windowEnd})`
    );
    for (const event of windowTimeline.slice(0, 32)) {
      console.log(
        `${event.createdAt} | ${event.channelId} | ${event.role} | ${event.authorName}: ${event.content}`
      );
    }
    if (windowTimeline.length > 32) {
      console.log(
        `... truncated ${windowTimeline.length - 32} more window events`
      );
    }
    console.log("");
  }

  if (windowTurnSnapshots.length) {
    printTurnSnapshots(windowTurnSnapshots, args.snapshotsLimit);
    console.log("");
  }

  if (judgeResult) {
    console.log("judge verdict");
    console.log(`  isFlooding=${judgeResult.isFlooding}`);
    console.log(`  floodScore=${judgeResult.floodScore}`);
    console.log(`  confidence=${judgeResult.confidence.toFixed(2)}`);
    if (judgeResult.summary) console.log(`  summary=${judgeResult.summary}`);
    if (judgeResult.signals.length) {
      for (const signal of judgeResult.signals) {
        console.log(`  signal=${signal}`);
      }
    }
    console.log("");
  }

  const assertionFailures = evaluateAssertions({
    args,
    nonInitiativeStats,
    initiativeStats
  });
  if (assertionFailures.length) {
    console.log("assertions failed");
    for (const failure of assertionFailures) {
      console.log(`  ${failure}`);
    }
    console.log("");
  } else {
    console.log("assertions passed");
    console.log("");
  }

  if (args.outJsonPath) {
    await writeJsonReport(args.outJsonPath, {
      args,
      processedUserTurns: replay.processedTurns,
      botUserId: replay.botUserId,
      initiativeChannelIds: [...replay.initiativeChannelIds],
      stats: {
        initiative: initiativeStats,
        nonInitiative: nonInitiativeStats
      },
      windowTimeline,
      windowTurnSnapshots,
      judge: judgeResult,
      assertions: {
        passed: assertionFailures.length === 0,
        failures: assertionFailures
      }
    });
  }

  if (assertionFailures.length) {
    process.exitCode = 1;
  }
}
