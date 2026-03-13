import {
  loadInitiativeChannelIds,
  loadMessagesForReplay,
  loadRuntimeSettings,
  openReadOnlyDb,
  primeReplayHistory,
  resolveBotUserId
} from "./db.ts";
import { createReplayLlmService } from "./llm.ts";
import type {
  ChannelMode,
  MessageRow,
  ReplayBaseArgs,
  ReplayEvent,
  ReplayEngineResult,
  ReplayScenarioDefinition,
  TurnSnapshot
} from "./types.ts";
import { computeContextSince, stableNumber } from "./utils.ts";

export async function runReplayEngine<
  TArgs extends ReplayBaseArgs,
  TScenarioState,
  TDbState
>(
  scenario: ReplayScenarioDefinition<TArgs, TScenarioState, TDbState>,
  args: TArgs
): Promise<ReplayEngineResult<TArgs, TScenarioState, TDbState>> {
  const contextSince = computeContextSince(args.since, args.historyLookbackHours);
  const db = openReadOnlyDb(args.dbPath);

  let runtimeSettings: Record<string, unknown>;
  let messages: MessageRow[];
  let replayMessages: MessageRow[];
  let dbState: TDbState;
  try {
    runtimeSettings = loadRuntimeSettings(db);
    const loadedMessages = loadMessagesForReplay(db, {
      contextSince,
      since: args.since,
      until: args.until,
      channelId: args.channelId,
      maxTurns: args.maxTurns
    });
    messages = loadedMessages.messages;
    replayMessages = loadedMessages.replayMessages;
    dbState = scenario.loadDbState({
      db,
      args,
      contextSince,
      messages
    });
  } finally {
    db.close();
  }

  const botUserId = resolveBotUserId(messages);
  const initiativeChannelIds = loadInitiativeChannelIds(runtimeSettings);
  const scenarioState = scenario.createScenarioState({
    args,
    dbState,
    runtimeSettings,
    botUserId,
    initiativeChannelIds
  });

  const llmService = createReplayLlmService();
  const { historyByChannel, historyByMessageId } = primeReplayHistory(
    messages,
    args.since
  );

  const timeline: ReplayEvent[] = [];
  const turnSnapshots: TurnSnapshot[] = [];
  const botName = String(runtimeSettings.botName || "clanky");
  let syntheticBotCounter = 0;
  let processedTurns = 0;

  for (const message of replayMessages) {
    const channelId = String(message.channel_id || "");
    const createdAt = String(message.created_at || "");
    const channelMode: ChannelMode = initiativeChannelIds.has(channelId)
      ? "initiative"
      : "non_initiative";

    const history = historyByChannel.get(channelId) || [];
    history.push(message);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(String(message.message_id), message);
    processedTurns += 1;

    timeline.push({
      createdAt,
      channelId,
      role: "USER" as const,
      authorName: String(message.author_name || "user"),
      content: String(message.content || "")
    });

    const turnResult = await scenario.runTurn({
      args,
      scenarioState,
      runtimeSettings,
      mode: args.mode,
      message,
      channelMode,
      history,
      historyByMessageId,
      botUserId,
      llmService,
      turnIndex: processedTurns
    });

    const snapshot: TurnSnapshot = {
      index: processedTurns,
      messageId: String(message.message_id || ""),
      createdAt,
      channelId,
      channelMode,
      authorName: String(message.author_name || "user"),
      userContent: String(message.content || ""),
      addressed: Boolean(turnResult.addressed),
      attempted: Boolean(turnResult.attempted),
      decisionKind: turnResult.decision.kind,
      decisionReason: String(turnResult.decision.reason || ""),
      botContent: "",
      llmProvider: String(turnResult.decision.llmProvider || ""),
      llmModel: String(turnResult.decision.llmModel || ""),
      llmCostUsd: stableNumber(turnResult.decision.llmCostUsd, 0)
    };
    turnSnapshots.push(snapshot);

    if (turnResult.decision.kind === "voice_intent_detected") {
      timeline.push({
        createdAt,
        channelId,
        role: "BOT_ACTION",
        authorName: botName,
        content: `[voice_intent:${turnResult.decision.voiceIntent || "detected"}]`
      });
      continue;
    }

    if (
      turnResult.decision.kind === "reply_skipped" ||
      turnResult.decision.kind === "no_action"
    ) {
      continue;
    }

    const botMessage: MessageRow = {
      message_id: `sim-bot-${++syntheticBotCounter}`,
      created_at: createdAt,
      guild_id: message.guild_id,
      channel_id: message.channel_id,
      author_id: botUserId,
      author_name: botName,
      is_bot: 1,
      content: String(turnResult.decision.content || ""),
      referenced_message_id: null
    };
    history.push(botMessage);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(botMessage.message_id, botMessage);
    snapshot.botContent = botMessage.content;
    timeline.push({
      createdAt,
      channelId,
      role: "BOT",
      authorName: botName,
      content: botMessage.content
    });
  }

  return {
    args,
    contextSince,
    runtimeSettings,
    botUserId,
    initiativeChannelIds,
    messages,
    replayMessages,
    processedTurns,
    timeline,
    turnSnapshots,
    llmService,
    scenarioState,
    dbState
  };
}
