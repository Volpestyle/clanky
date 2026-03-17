import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ClankerBot } from "../bot.ts";
import { buildStreamKey, createGoLiveStreamState } from "../selfbot/streamDiscovery.ts";
import { Store } from "../store/store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";

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
      interaction: {
        activity: {
          minSecondsBetweenMessages: 0,
          replyCoalesceWindowSeconds: 0,
          replyCoalesceMaxMessages: 1
        }
      },
      permissions: {
        replies: {
          allowReplies: true,
          allowUnsolicitedReplies: false,
          allowReactions: true,
          replyChannelIds: [],
          allowedChannelIds: [channelId],
          blockedChannelIds: [],
          blockedUserIds: [],
          maxMessagesPerHour: 100,
          maxReactionsPerHour: 100
        }
      },
      memory: {
        enabled: true,
        promptSlice: {
          maxRecentMessages: 10
        }
      },
      agentStack: {
        runtimeConfig: {
          research: {
            enabled: false,
            maxSearchesPerHour: 0
          }
        }
      },
      media: {
        videoContext: {
          enabled: false,
          maxLookupsPerHour: 0
        }
      },
      initiative: {
        discovery: {
          allowReplyImages: false,
          allowReplyVideos: false,
          allowReplyGifs: false
        }
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
        loadFactProfile() {
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
      username: "clanky",
      tag: "clanky#0001"
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
        username: "clanky",
        bot: true
      },
      member: {
        displayName: "clanky"
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
      authorName: "clanky",
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
      content: "clanky, weigh in on this",
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
        return Boolean(reactionRow?.content?.includes("alice reacted with 🔥 to clanky's message"));
      });

      bot.client.emit("messageCreate", incomingMessage);
      await waitForCondition(() => (replyPayloads.length + channelSendPayloads.length) === 1 && bot.getReplyQueuePendingCount() === 0);

      assert.equal(memoryIngestCalls.length, 2);
      const userIngest = memoryIngestCalls.find((entry) => entry?.messageId === incomingMessageId);
      const botIngest = memoryIngestCalls.find((entry) => entry?.isBot === true);
      assert.equal(userIngest?.messageId, incomingMessageId);
      assert.equal(botIngest?.authorId, botUserId);
      assert.equal(botIngest?.isBot, true);
      assert.equal(botIngest?.trace?.source, "text_reply_memory_ingest");
      assert.match(String(llmCalls[0]?.userPrompt || ""), /alice reacted with 🔥 to clanky's message: "bet"/);
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

test("stream discovery seeds session Go Live target before credentials arrive", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const voiceChannelId = "voice-1";
    const targetUserId = "user-1";
    const streamKey = `guild:${guildId}:${voiceChannelId}:${targetUserId}`;

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
      username: "clanky",
      tag: "clanky#0001"
    };

    const session = {
      id: "session-1",
      guildId,
      textChannelId: "text-1",
      voiceChannelId,
      mode: "openai_realtime",
      ending: false,
      goLiveStream: createGoLiveStreamState()
    };
    bot.voiceSessionManager.sessions.set(guildId, session as never);

    try {
      bot.client.emit("clientReady", bot.client);
      bot.client.emit("raw", {
        t: "STREAM_CREATE",
        d: {
          stream_key: streamKey,
          rtc_server_id: "rtc-1",
          region: "us-east"
        }
      });

      await waitForCondition(() => session.goLiveStream.targetUserId === targetUserId);

      assert.equal(session.goLiveStream.active, false);
      assert.equal(session.goLiveStream.targetUserId, targetUserId);
      assert.equal(session.goLiveStream.streamKey, streamKey);
      assert.equal(session.goLiveStream.channelId, voiceChannelId);
      assert.equal(session.goLiveStream.guildId, guildId);
      assert.equal(session.goLiveStream.rtcServerId, "rtc-1");
    } finally {
      await bot.stop();
    }
  });
});

test("stream discovery seeds provisional session Go Live target from self_stream before stream creation arrives", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const voiceChannelId = "voice-1";
    const targetUserId = "user-1";
    const streamKey = buildStreamKey(guildId, voiceChannelId, targetUserId);

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
      username: "clanky",
      tag: "clanky#0001"
    };

    const session = {
      id: "session-1",
      guildId,
      textChannelId: "text-1",
      voiceChannelId,
      mode: "openai_realtime",
      ending: false,
      goLiveStream: createGoLiveStreamState()
    };
    bot.voiceSessionManager.sessions.set(guildId, session as never);

    try {
      bot.client.emit("clientReady", bot.client);
      bot.client.emit("raw", {
        t: "VOICE_STATE_UPDATE",
        d: {
          user_id: targetUserId,
          guild_id: guildId,
          channel_id: voiceChannelId,
          self_stream: true
        }
      });

      await waitForCondition(() => session.goLiveStream.targetUserId === targetUserId);

      assert.equal(session.goLiveStream.active, false);
      assert.equal(session.goLiveStream.targetUserId, targetUserId);
      assert.equal(session.goLiveStream.streamKey, streamKey);
      assert.equal(session.goLiveStream.channelId, voiceChannelId);
      assert.equal(session.goLiveStream.guildId, guildId);
      assert.equal(session.goLiveStream.rtcServerId, null);

      await waitForCondition(() => store.getRecentActions(20, { kinds: ["stream_discovery"] }).some((entry) =>
        String(entry.content || "").includes("stream_discovery_go_live_bootstrap_seeded")
      ));

      const seededLog = store.getRecentActions(20, { kinds: ["stream_discovery"] }).find((entry) =>
        String(entry.content || "").includes("stream_discovery_go_live_bootstrap_seeded")
      );
      assert.equal(seededLog?.metadata?.streamKey, streamKey);
    } finally {
      await bot.stop();
    }
  });
});

test("stream discovery clears provisional Go Live target when self_stream ends before credentials arrive", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const voiceChannelId = "voice-1";
    const targetUserId = "user-1";
    const streamKey = buildStreamKey(guildId, voiceChannelId, targetUserId);

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
      username: "clanky",
      tag: "clanky#0001"
    };

    const session = {
      id: "session-1",
      guildId,
      textChannelId: "text-1",
      voiceChannelId,
      mode: "openai_realtime",
      ending: false,
      goLiveStream: createGoLiveStreamState()
    };
    bot.voiceSessionManager.sessions.set(guildId, session as never);

    try {
      bot.client.emit("clientReady", bot.client);
      bot.client.emit("raw", {
        t: "VOICE_STATE_UPDATE",
        d: {
          user_id: targetUserId,
          guild_id: guildId,
          channel_id: voiceChannelId,
          self_stream: true
        }
      });
      await waitForCondition(() => session.goLiveStream.targetUserId === targetUserId);

      bot.client.emit("raw", {
        t: "VOICE_STATE_UPDATE",
        d: {
          user_id: targetUserId,
          guild_id: guildId,
          channel_id: voiceChannelId,
          self_stream: false
        }
      });

      await waitForCondition(() => session.goLiveStream.targetUserId === null);

      assert.equal(session.goLiveStream.active, false);
      assert.equal(session.goLiveStream.streamKey, null);
      assert.equal(session.goLiveStream.guildId, null);
      assert.equal(session.goLiveStream.channelId, null);

      await waitForCondition(() => store.getRecentActions(20, { kinds: ["stream_discovery"] }).some((entry) =>
        String(entry.content || "").includes("stream_discovery_go_live_bootstrap_cleared")
      ));

      const clearedLog = store.getRecentActions(20, { kinds: ["stream_discovery"] }).find((entry) =>
        String(entry.content || "").includes("stream_discovery_go_live_bootstrap_cleared")
      );
      assert.equal(clearedLog?.metadata?.streamKey, streamKey);
      assert.equal(clearedLog?.metadata?.reason, "voice_state_self_stream_false");
    } finally {
      await bot.stop();
    }
  });
});

test("stream discovery preserves multiple Go Live users instead of overwriting the first one", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const voiceChannelId = "voice-1";
    const firstUserId = "user-1";
    const secondUserId = "user-2";

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
      username: "clanky",
      tag: "clanky#0001"
    };

    const session = {
      id: "session-1",
      guildId,
      textChannelId: "text-1",
      voiceChannelId,
      mode: "openai_realtime",
      ending: false,
      goLiveStream: createGoLiveStreamState(),
      goLiveStreams: new Map()
    };
    bot.voiceSessionManager.sessions.set(guildId, session as never);

    try {
      bot.client.emit("clientReady", bot.client);
      for (const userId of [firstUserId, secondUserId]) {
        bot.client.emit("raw", {
          t: "VOICE_STATE_UPDATE",
          d: {
            user_id: userId,
            guild_id: guildId,
            channel_id: voiceChannelId,
            self_stream: true
          }
        });
      }

      await waitForCondition(() => session.goLiveStreams.size === 2);

      assert.equal(session.goLiveStreams.size, 2);
      assert.equal(session.goLiveStreams.has(buildStreamKey(guildId, voiceChannelId, firstUserId)), true);
      assert.equal(session.goLiveStreams.has(buildStreamKey(guildId, voiceChannelId, secondUserId)), true);
    } finally {
      await bot.stop();
    }
  });
});
