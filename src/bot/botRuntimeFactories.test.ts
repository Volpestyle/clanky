import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  buildBotContext,
  buildQueueGatewayRuntime,
  buildReplyPipelineRuntime
} from "./botRuntimeFactories.ts";

function createBot() {
  const calls = {
    canSendMessage: [] as number[],
    canTalkNow: [] as unknown[],
    maybeReplyToMessage: [] as Array<Record<string, unknown>>,
    isDirectlyAddressed: [] as Array<Record<string, unknown>>,
    getReactionEmojiOptions: [] as unknown[],
    maybeHandleStructuredAutomationIntent: [] as unknown[],
    maybeApplyReplyReaction: [] as unknown[],
    logSkippedReply: [] as unknown[],
    shouldSendAsReply: [] as unknown[],
    requestPlayMusic: [] as unknown[],
    requestStopMusic: [] as unknown[],
    requestPauseMusic: [] as unknown[]
  };

  const bot = {
    appConfig: {
      env: "test"
    },
    store: {
      getSettings() {
        return createTestSettings({
          identity: {
            botName: "clanky"
          }
        });
      },
      logAction() {
        return true;
      }
    },
    llm: {
      name: "llm"
    },
    memory: {
      name: "memory"
    },
    client: {
      user: {
        id: " bot-1 "
      },
      guilds: {
        cache: new Map()
      }
    },
    gifs: {
      name: "gifs"
    },
    search: {
      name: "search"
    },
    video: {
      name: "video"
    },
    browserManager: null,
    imageCaptionCache: {
      name: "image-cache"
    },
    activeBrowserTasks: {
      name: "tasks"
    },
    subAgentSessions: {
      name: "sessions"
    },
    voiceSessionManager: {
      name: "voice-session-manager",
      async requestPlayMusic(payload: unknown) {
        calls.requestPlayMusic.push(payload);
        return true;
      },
      async requestStopMusic(payload: unknown) {
        calls.requestStopMusic.push(payload);
        return true;
      },
      async requestPauseMusic(payload: unknown) {
        calls.requestPauseMusic.push(payload);
        return true;
      }
    },
    replyQueues: new Map([["channel-1", []]]),
    replyQueueWorkers: new Map([["channel-1", { running: true }]]),
    replyQueuedMessageIds: new Set(["msg-1"]),
    lastBotMessageAt: 111,
    isStopping: false,
    reconnectInFlight: false,
    hasConnectedAtLeastOnce: false,
    lastGatewayEventAt: 222,
    reconnectTimeout: null,
    reconnectAttempts: 1,
    canSendMessage(maxPerHour: number) {
      calls.canSendMessage.push(maxPerHour);
      return maxPerHour <= 10;
    },
    canTalkNow(settings: unknown) {
      calls.canTalkNow.push(settings);
      return settings;
    },
    async maybeReplyToMessage(message: Record<string, unknown>, settings: unknown, options: Record<string, unknown>) {
      calls.maybeReplyToMessage.push({ message, settings, options });
      return { replied: true };
    },
    isDirectlyAddressed(settings: unknown, message: Record<string, unknown>) {
      calls.isDirectlyAddressed.push({ settings, message });
      return String(message.content || "").includes("@bot");
    },
    getReactionEmojiOptions(guild: unknown) {
      calls.getReactionEmojiOptions.push(guild);
      return ["🔥", "🫡"];
    },
    getEmojiHints() {
      return ["wave"];
    },
    maybeHandleStructuredAutomationIntent(payload: unknown) {
      calls.maybeHandleStructuredAutomationIntent.push(payload);
      return { handled: true };
    },
    maybeApplyReplyReaction(payload: unknown) {
      calls.maybeApplyReplyReaction.push(payload);
      return true;
    },
    logSkippedReply(payload: unknown) {
      calls.logSkippedReply.push(payload);
    },
    getSimulatedTypingDelayMs(minMs: number, jitterMs: number) {
      return minMs + jitterMs;
    },
    shouldSendAsReply(payload: unknown) {
      calls.shouldSendAsReply.push(payload);
      return Boolean((payload as { shouldReply?: boolean }).shouldReply);
    }
  };

  return { bot, calls };
}

test("buildBotContext maps the core bot services and trims botUserId", () => {
  const { bot } = createBot();

  const context = buildBotContext(bot);

  assert.equal(context.appConfig, bot.appConfig);
  assert.equal(context.store, bot.store);
  assert.equal(context.llm, bot.llm);
  assert.equal(context.memory, bot.memory);
  assert.equal(context.client, bot.client);
  assert.equal(context.botUserId, "bot-1");
});

test("buildReplyPipelineRuntime maps bot fields and preserves runtime delegation behavior", async () => {
  const { bot, calls } = createBot();
  const settings = createTestSettings({
    identity: {
      botName: "clanky"
    },
    permissions: {
      replies: {
        allowUnsolicitedReplies: true
      }
    }
  });
  const runtime = buildReplyPipelineRuntime(bot, {
    captionTimestamps: [],
    unsolicitedReplyContextWindow: 2
  });

  assert.equal(runtime.appConfig, bot.appConfig);
  assert.equal(runtime.gifs, bot.gifs);
  assert.equal(runtime.search, bot.search);
  assert.equal(runtime.voiceSessionManager, bot.voiceSessionManager);
  assert.deepEqual(runtime.getReactionEmojiOptions({ id: "guild-1" }), ["🔥", "🫡"]);
  assert.equal(calls.getReactionEmojiOptions.length, 1);

  const addressSignal = await runtime.getReplyAddressSignal(settings, {
    content: "@bot reply please"
  });
  assert.equal(addressSignal.direct, true);
  assert.equal(addressSignal.reason, "direct");
  assert.equal(calls.isDirectlyAddressed.length, 1);

  const shouldAttempt = runtime.shouldAttemptReplyDecision({
    settings,
    recentMessages: [
      { message_id: "m-1", author_id: "user-1" },
      { message_id: "m-2", author_id: "bot-1" },
      { message_id: "m-3", author_id: "user-2" }
    ],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    triggerMessageId: "m-3",
    triggerAuthorId: "user-2",
    triggerReferenceMessageId: "m-2"
  });
  assert.equal(shouldAttempt, true);

  const automationIntentResult = runtime.maybeHandleStructuredAutomationIntent({ intent: "schedule" });
  runtime.maybeApplyReplyReaction({ emoji: "🔥" });
  runtime.logSkippedReply({ reason: "quiet_hours" });
  const canSend = runtime.canSendMessage(5);
  const talkNow = runtime.canTalkNow(settings);
  const shouldReply = runtime.shouldSendAsReply({ shouldReply: true });
  const beforeMarkSpoke = bot.lastBotMessageAt;
  runtime.markSpoke();

  assert.deepEqual(automationIntentResult, { handled: true });
  assert.equal(canSend, true);
  assert.equal(talkNow, settings);
  assert.equal(shouldReply, true);
  assert.equal(calls.canSendMessage.at(-1), 5);
  assert.equal(calls.canTalkNow.at(-1), settings);
  assert.equal(calls.maybeHandleStructuredAutomationIntent.length, 1);
  assert.equal(calls.maybeApplyReplyReaction.length, 1);
  assert.equal(calls.logSkippedReply.length, 1);
  assert.equal(calls.shouldSendAsReply.length, 1);
  assert.ok(bot.lastBotMessageAt >= beforeMarkSpoke);
});

test("buildQueueGatewayRuntime exposes live bot state through getters, setters, and delegating helpers", async () => {
  const { bot, calls } = createBot();
  const settings = createTestSettings({
    identity: {
      botName: "clanky"
    },
    permissions: {
      replies: {
        allowedChannelIds: ["channel-1"],
        blockedUserIds: ["blocked-user"]
      }
    }
  });
  const runtime = buildQueueGatewayRuntime(bot);

  assert.equal(runtime.replyQueues, bot.replyQueues);
  assert.equal(runtime.replyQueueWorkers, bot.replyQueueWorkers);
  assert.equal(runtime.replyQueuedMessageIds, bot.replyQueuedMessageIds);
  assert.equal(runtime.lastBotMessageAt, 111);

  runtime.lastBotMessageAt = 500;
  runtime.isStopping = true;
  runtime.reconnectInFlight = true;
  runtime.hasConnectedAtLeastOnce = true;
  runtime.reconnectAttempts = 4;
  runtime.reconnectTimeout = { id: "timeout" };
  assert.equal(bot.lastBotMessageAt, 500);
  assert.equal(bot.isStopping, true);
  assert.equal(bot.reconnectInFlight, true);
  assert.equal(bot.hasConnectedAtLeastOnce, true);
  assert.equal(bot.reconnectAttempts, 4);
  assert.deepEqual(bot.reconnectTimeout, { id: "timeout" });

  bot.lastBotMessageAt = 777;
  bot.isStopping = false;
  assert.equal(runtime.lastBotMessageAt, 777);
  assert.equal(runtime.isStopping, false);

  const addressSignal = await runtime.getReplyAddressSignal(settings, {
    content: "@bot queue this"
  });
  assert.equal(addressSignal.direct, true);
  assert.equal(addressSignal.reason, "direct");
  assert.equal(runtime.isChannelAllowed(settings, "channel-1"), true);
  assert.equal(runtime.isChannelAllowed(settings, "channel-2"), false);
  assert.equal(runtime.isUserBlocked(settings, "blocked-user"), true);

  const maybeReplyResult = await runtime.maybeReplyToMessage(
    { id: "msg-1" },
    settings,
    { source: "queue" }
  );
  const beforeGatewayMark = bot.lastGatewayEventAt;
  runtime.markGatewayEvent();

  assert.deepEqual(maybeReplyResult, { replied: true });
  assert.equal(calls.maybeReplyToMessage.length, 1);
  assert.equal(calls.isDirectlyAddressed.length, 1);
  assert.ok(bot.lastGatewayEventAt >= beforeGatewayMark);
});
