import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ClankerBot } from "./bot.ts";
import { pickTextThoughtLoopCandidate } from "./bot/textThoughtLoop.ts";
import { Store } from "./store.ts";
import { createTestSettingsPatch } from "./testSettings.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-loop-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitForCondition(check, { timeoutMs = 7000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

test("message/reaction loops cover ingest, read context, reaction, and reply", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "chan-1";
    const botUserId = "bot-1";
    const incomingMessageId = "msg-100";
    const botReplyMessageId = "bot-msg-0";

    store.patchSettings(createTestSettingsPatch({
      activity: {
        minSecondsBetweenMessages: 0,
        replyCoalesceWindowSeconds: 0,
        replyCoalesceMaxMessages: 1
      },
      permissions: {
        allowReplies: true,
        allowUnsolicitedReplies: false,
        allowReactions: true,
        replyChannelIds: [],
        allowedChannelIds: [channelId],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 100,
        maxReactionsPerHour: 100
      },
      memory: {
        enabled: true,
        maxRecentMessages: 10
      },
      webSearch: {
        enabled: false,
        maxSearchesPerHour: 0
      },
      videoContext: {
        enabled: false,
        maxLookupsPerHour: 0
      },
      discovery: {
        enabled: false,
        allowReplyImages: false,
        allowReplyVideos: false,
        allowReplyGifs: false
      }
    }));

    const memoryIngestCalls = [];
    const llmCalls = [];
    const reactionCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    let typingCalls = 0;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "bet",
              skip: false,
              reactionEmoji: "🔥",
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: {
                operation: "none"
              },
              voiceIntent: {
                intent: "none",
                confidence: 0,
                reason: null
              }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: {
        async ingestMessage(payload) {
          memoryIngestCalls.push(payload);
          return true;
        },
        async buildPromptMemorySlice() {
          return {
            userFacts: [],
            relevantFacts: [],
            relevantMessages: []
          };
        }
      },
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: botUserId,
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = {
      id: guildId,
      emojis: {
        cache: {
          map() {
            return [];
          }
        }
      },
      members: {
        cache: new Map()
      }
    };

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild,
      isTextBased() {
        return true;
      },
      async sendTyping() {
        typingCalls += 1;
      },
      async send(payload) {
        channelSendPayloads.push(payload);
        return {
          id: "bot-msg-standalone",
          createdTimestamp: Date.now(),
          guildId,
          channelId,
          content: String(payload?.content || ""),
          attachments: new Map(),
          embeds: []
        };
      }
    };

    store.recordMessage({
      messageId: "msg-context-1",
      createdAt: Date.now() - 1200,
      guildId,
      channelId,
      authorId: "user-2",
      authorName: "bob",
      isBot: false,
      content: "older context line",
      referencedMessageId: null
    });

    const botReplyMessage = {
      id: botReplyMessageId,
      createdTimestamp: Date.now() - 100,
      guildId,
      channelId,
      guild,
      channel,
      author: {
        id: botUserId,
        username: "clanker conk",
        bot: true
      },
      member: {
        displayName: "clanker conk"
      },
      content: "bet",
      reference: {
        messageId: incomingMessageId
      },
      attachments: new Map(),
      embeds: [],
      reactions: {
        cache: new Map([
          [
            "fire",
            {
              count: 1,
              emoji: {
                id: null,
                name: "🔥"
              }
            }
          ]
        ])
      }
    };

    store.recordMessage({
      messageId: botReplyMessageId,
      createdAt: botReplyMessage.createdTimestamp,
      guildId,
      channelId,
      authorId: botUserId,
      authorName: "clanker conk",
      isBot: true,
      content: "bet",
      referencedMessageId: incomingMessageId
    });

    const incomingMessage = {
      id: incomingMessageId,
      createdTimestamp: Date.now(),
      guildId,
      channelId,
      guild,
      channel,
      author: {
        id: "user-1",
        username: "alice",
        bot: false
      },
      member: {
        displayName: "alice"
      },
      content: "clanker conk, weigh in on this",
      mentions: {
        users: {
          has(userId) {
            return String(userId || "") === botUserId;
          }
        },
        repliedUser: null
      },
      reference: null,
      attachments: new Map(),
      embeds: [],
      reactions: {
        cache: new Map([
          [
            "fire",
            {
              count: 2,
              emoji: {
                id: null,
                name: "🔥"
              }
            }
          ]
        ])
      },
      async react(emoji) {
        reactionCalls.push(emoji);
      },
      async reply(payload) {
        replyPayloads.push(payload);
        return {
          id: "bot-reply-1",
          createdTimestamp: Date.now(),
          guildId,
          channelId,
          content: String(payload?.content || ""),
          attachments: new Map(),
          embeds: []
        };
      }
    };

    const reactionEvent = {
      partial: false,
      message: botReplyMessage,
      emoji: {
        id: null,
        name: "🔥"
      }
    };

    const reactingUser = {
      id: "user-1",
      username: "alice",
      globalName: null,
      bot: false
    };

    try {
      bot.client.emit("messageReactionAdd", reactionEvent, reactingUser);
      await waitForCondition(() => {
        const rows = store.getRecentMessages(channelId, 20);
        const reactionRow = rows.find((item) => String(item.message_id).startsWith("reaction:"));
        return Boolean(reactionRow?.content?.includes("alice reacted with 🔥 to clanker conk's message"));
      });

      bot.client.emit("messageCreate", incomingMessage);
      await waitForCondition(() => (replyPayloads.length + channelSendPayloads.length) === 1 && bot.getReplyQueuePendingCount() === 0);

      assert.equal(memoryIngestCalls.length, 1);
      assert.equal(memoryIngestCalls[0].messageId, incomingMessageId);
      assert.match(String(llmCalls[0]?.userPrompt || ""), /alice reacted with 🔥 to clanker conk's message: "bet"/);
      assert.equal(reactionCalls.length, 1);
      assert.equal(reactionCalls[0], "🔥");
      assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
      assert.equal(typingCalls > 0, true);
      assert.equal(store.hasTriggeredResponse(incomingMessageId), true);

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      assert.equal(store.countActionsSince("reacted", since), 1);
      assert.equal(store.countActionsSince("sent_reply", since) + store.countActionsSince("sent_message", since), 1);
    } finally {
      await bot.stop();
    }
  });
}, 15_000);

test("text thought loop selects from explicit reply channel list", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-thought";
    const channelId = "chan-thought";

    store.patchSettings(createTestSettingsPatch({
      textThoughtLoop: {
        enabled: true,
        minMinutesBetweenThoughts: 1,
        maxThoughtsPerDay: 5,
        lookbackMessages: 12
      },
      permissions: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: true,
        replyChannelIds: [channelId],
        allowedChannelIds: [channelId],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 100,
        maxReactionsPerHour: 100
      }
    }));

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: null,
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = {
      id: guildId,
      emojis: {
        cache: {
          map() {
            return [];
          }
        }
      },
      members: {
        cache: new Map()
      }
    };

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild,
      isTextBased() {
        return true;
      },
      isDMBased() {
        return false;
      },
      isThread() {
        return false;
      },
      async sendTyping() {
        return undefined;
      },
      async send() {
        return undefined;
      }
    };

    bot.client.channels.cache.set(channelId, channel);

    store.recordMessage({
      messageId: "human-thought-1",
      createdAt: Date.now() - 5_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "anyone trying the new patch",
      referencedMessageId: null
    });

    try {
      const candidate = await pickTextThoughtLoopCandidate(bot.toTextThoughtLoopRuntime(), store.getSettings());
      assert.equal(candidate?.channel?.id, channelId);
      assert.equal(candidate?.message?.content, "anyone trying the new patch");
    } finally {
      await bot.stop();
    }
  });
});
