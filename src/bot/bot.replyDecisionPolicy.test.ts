import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  getMemorySettings,
  getResolvedOrchestratorBinding
} from "../settings/agentStack.ts";
import { ClankerBot } from "../bot.ts";
import { getReplyAddressSignal as getReplyAddressSignalForReplyAdmission } from "./replyAdmission.ts";
import { isReplyChannel as isReplyChannelForPermissions } from "./permissions.ts";
import { Store } from "../store/store.ts";
import { rmTempDir } from "../testHelpers.ts";
import { createTestSettingsPatch } from "../testSettings.ts";

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-reply-policy-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    await run(store);
  } finally {
    store.close();
    await rmTempDir(dir);
  }
}

function buildGuild() {
  return {
    id: "guild-1",
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
}

function buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef }) {
  return {
    id: channelId,
    guildId: guild.id,
    name: "general",
    guild,
    isTextBased() {
      return true;
    },
    async sendTyping() {
      typingCallsRef.count += 1;
    },
    async send(payload) {
      channelSendPayloads.push(payload);
      return {
        id: `standalone-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId,
        content: String(payload?.content || ""),
        attachments: new Map(),
        embeds: []
      };
    }
  };
}

function buildPrivateThreadChannel({ guild, channelId = "private-thread-1" } = {}) {
  return {
    id: channelId,
    guildId: guild.id,
    guild,
    private: true,
    isTextBased() {
      return true;
    },
    isThread() {
      return true;
    },
    isDMBased() {
      return false;
    },
    async send() {
      return undefined;
    }
  };
}

function buildIncomingMessage({
  guild,
  channel,
  messageId,
  content,
  replyPayloads,
  authorId = "user-1",
  username = "alice",
  referenceMessageId = null,
  referencedAuthorId = null
}) {
  return {
    id: messageId,
    createdTimestamp: Date.now(),
    guildId: guild.id,
    channelId: channel.id,
    guild,
    channel,
    author: {
      id: authorId,
      username,
      bot: false
    },
    member: {
      displayName: username
    },
    content,
    mentions: {
      users: {
        has() {
          return false;
        }
      },
      repliedUser: referencedAuthorId ? { id: referencedAuthorId } : null
    },
    reference: referenceMessageId ? { messageId: referenceMessageId } : null,
    referencedMessage: referenceMessageId
      ? {
          id: referenceMessageId,
          author: referencedAuthorId ? { id: referencedAuthorId } : undefined
        }
      : null,
    attachments: new Map(),
    embeds: [],
    reactions: {
      cache: new Map()
    },
    async react() {
      return undefined;
    },
    async reply(payload) {
      replyPayloads.push(payload);
      return {
        id: `reply-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId: channel.id,
        content: String(payload?.content || ""),
        attachments: new Map(),
        embeds: []
      };
    }
  };
}

function recordSameAuthorFollowupContext(
  store,
  {
    guildId,
    channelId,
    authorId = "user-1",
    authorName = "alice",
    botUserId = "bot-1",
    botName = "clanky",
    humanMessageId = "human-context-1",
    botMessageId = "bot-context-1"
  }
) {
  store.recordMessage({
    messageId: humanMessageId,
    createdAt: Date.now() - 1_500,
    guildId,
    channelId,
    authorId,
    authorName,
    isBot: false,
    content: "starter takes are chaos",
    referencedMessageId: null
  });
  store.recordMessage({
    messageId: botMessageId,
    createdAt: Date.now() - 750,
    guildId,
    channelId,
    authorId: botUserId,
    authorName: botName,
    isBot: true,
    content: "last bot line",
    referencedMessageId: humanMessageId
  });

  return {
    humanMessageId,
    botMessageId
  };
}

function patchTestSettings(store, patch) {
  store.patchSettings(createTestSettingsPatch(patch));
}

function applyBaselineSettings(store, channelId) {
  patchTestSettings(store, {
    interaction: {
      activity: {
        ambientReplyEagerness: 65,
        reactivity: 20,
        minSecondsBetweenMessages: 5,
        replyCoalesceWindowSeconds: 0,
        replyCoalesceMaxMessages: 1
      }
    },
    permissions: {
      replies: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: true,
        replyChannelIds: [],
        allowedChannelIds: [channelId],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 120,
        maxReactionsPerHour: 120
      }
    },
    memory: {
      enabled: false,
      promptSlice: {
        maxRecentMessages: 12
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
  });
}

test("same-author active follow-up turn can still post when model contributes value", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "evo lines decide everything ngl, base forms are only first impressions",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    const { botMessageId } = recordSameAuthorFollowupContext(store, {
      guildId: guild.id,
      channelId
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-1",
      content: "pokemon starter takes are all over the place rn",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);
    assert.match(String(channelSendPayloads[0]?.content || ""), /evo lines decide everything/i);
    const sentAction = store.getRecentActions(12).find(
      (row) => row.kind === "sent_message" && row.message_id !== botMessageId
    );
    assert.equal(sentAction?.metadata?.replyPrompts?.hiddenByDefault, true);
    assert.equal(typeof sentAction?.metadata?.replyPrompts?.systemPrompt, "string");
    assert.equal(typeof sentAction?.metadata?.replyPrompts?.initialUserPrompt, "string");
    assert.deepEqual(sentAction?.metadata?.replyPrompts?.followupUserPrompts, []);

  });
});

test("same-author active follow-up turn is skipped when the model declines", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "[SKIP]",
              skip: true,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    recordSameAuthorFollowupContext(store, {
      guildId: guild.id,
      channelId
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-2",
      content: "random side chatter between people",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, false);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);

    const recentActions = store.getRecentActions(12);
    const skipped = recentActions.find(
      (row) => row.kind === "reply_skipped" && row.message_id === "msg-2"
    );
    assert.equal(Boolean(skipped), true);
    assert.equal(skipped?.content, "llm_skip");
    assert.equal(skipped?.metadata?.replyPrompts?.hiddenByDefault, true);
    assert.equal(typeof skipped?.metadata?.replyPrompts?.systemPrompt, "string");
    assert.equal(typeof skipped?.metadata?.replyPrompts?.initialUserPrompt, "string");
    assert.deepEqual(skipped?.metadata?.replyPrompts?.followupUserPrompts, []);
  });
});

test("smoke: text followup-window turn addressed to another user is llm-skipped", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "[SKIP]",
              skip: true,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-followup-directed-away",
      content: "hey joey guess what game i'm playing",
      replyPayloads
    });

    const recentMessages = [
      {
        message_id: "bot-context-followup",
        author_id: "bot-1",
        author_name: "clanky",
        content: "yeah that build looked scuffed",
        created_at: new Date(Date.now() - 1_200).toISOString()
      },
      {
        message_id: "user-context-followup",
        author_id: "user-2",
        author_name: "joey",
        content: "what game?",
        created_at: new Date(Date.now() - 900).toISOString()
      }
    ];

    const settings = store.getSettings();
    const addressSignal = await getReplyAddressSignalForReplyAdmission(
      {
        botUserId: String(bot.client.user?.id || "").trim(),
        isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
          bot.isDirectlyAddressed(resolvedSettings, resolvedMessage)
      },
      settings,
      incoming,
      recentMessages
    );
    assert.equal(Boolean(addressSignal?.triggered), false);
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal
    });

    assert.equal(sent, false);
    assert.equal(llmCalls.length, 1);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 1);
  });
});

test("non-addressed initiative turn can still contribute when model responds", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replies: {
          replyChannelIds: [channelId]
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "lmao this queue got hands",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-initiative-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanky",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-1",
      content: "this match is chaos",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);

  });
});

test("reply channels pass cold ambient turns to LLM for decision", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      interaction: {
        activity: {
          ambientReplyEagerness: 100
        }
      },
      permissions: {
        replies: {
          replyChannelIds: [channelId]
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "yep i'm tracking",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-no-context",
      content: "anyone got loadout ideas",
      replyPayloads
    });

    const settings = store.getSettings();
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages: [],
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 1);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);
  });
});

test("empty reply channel list disables reply-channel behavior everywhere (explicit-only)", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-default-reply";
    applyBaselineSettings(store, channelId);

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

    const guild = buildGuild();
    const publicChannel = buildChannel({
      guild,
      channelId,
      channelSendPayloads: [],
      typingCallsRef: { count: 0 }
    });
    const privateThread = buildPrivateThreadChannel({ guild });

    bot.client.channels.cache.set(publicChannel.id, publicChannel);
    bot.client.channels.cache.set(privateThread.id, privateThread);

    const settings = store.getSettings();
    assert.equal(isReplyChannelForPermissions(settings, publicChannel.id), false);
    assert.equal(isReplyChannelForPermissions(settings, privateThread.id), false);
  });
});

test("non-addressed turn is dropped before llm when unsolicited gate is closed", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replies: {
          allowUnsolicitedReplies: false
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "this should never be used",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-gated",
      content: "this should stay between humans",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, false);
    assert.equal(llmCalls.length, 0);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 0);
  });
});

test("direct-addressed turn bypasses unsolicited gate and marks response as required", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replies: {
          allowUnsolicitedReplies: false
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "yeah i'm here, what's up",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-direct",
      content: "clanky you there?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 1);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);

  });
});

test("text reply follow-up can run web search and append cited sources", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      agentStack: {
        overrides: {
          researchRuntime: "local_external_search"
        },
        runtimeConfig: {
          research: {
            enabled: true,
            maxSearchesPerHour: 8
          }
        }
      }
    });

    const llmCalls = [];
    const searchCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "tc_web_1",
                  name: "web_search",
                  input: { query: "latest rust stable version" }
                }
              ],
              rawContent: [
                { type: "text", text: "" },
                { type: "tool_use", id: "tc_web_1", name: "web_search", input: { query: "latest rust stable version" } }
              ],
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "latest stable rust is [1]",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: null,
      discovery: null,
      search: {
        isConfigured() {
          return true;
        },
        async searchAndRead(payload) {
          searchCalls.push(payload);
          return {
            query: String(payload?.query || "").trim(),
            results: [
              {
                title: "Rust 1.90.0",
                url: "https://blog.rust-lang.org/2025/09/18/Rust-1.90.0.html",
                domain: "blog.rust-lang.org",
                snippet: "Rust 1.90.0 is released."
              }
            ],
            fetchedPages: 1,
            providerUsed: "brave",
            providerFallbackUsed: false
          };
        }
      },
      gifs: null,
      video: null
    });

    bot.client.user = {
      id: "bot-1",
      username: "clanky",
      tag: "clanky#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    recordSameAuthorFollowupContext(store, {
      guildId: guild.id,
      channelId,
      humanMessageId: "human-context-search-1",
      botMessageId: "bot-context-search-1"
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-web-followup",
      content: "what rust version is stable right now?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 2);
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0]?.query, "latest rust stable version");
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(typeof channelSendPayloads[0]?.content, "string");
    assert.equal(channelSendPayloads[0].content.length > 0, true);
  });
});

test("reply follow-up regeneration can use dedicated provider/model override", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      agentStack: {
        preset: "openai_native_realtime",
        advancedOverridesEnabled: true,
        overrides: {
          orchestrator: {
            provider: "openai",
            model: "claude-haiku-4-5"
          }
        }
      },
      interaction: {
        followup: {
          enabled: true,
          execution: {
            mode: "dedicated_model",
            model: {
              provider: "anthropic",
              model: "claude-haiku-4-5"
            }
          }
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "tc_mem_1",
                  name: "memory_search",
                  input: { query: "starter opinions" }
                }
              ],
              rawContent: [
                { type: "text", text: "" },
                { type: "tool_use", id: "tc_mem_1", name: "memory_search", input: { query: "starter opinions" } }
              ],
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }
          return {
            text: JSON.stringify({
              text: "still think evo lines decide everything",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
      memory: {
        async searchDurableFacts() {
          return [{ id: 1, fact: "user likes offensive starters" }];
        },
        async rememberDirectiveLine() {
          return true;
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    recordSameAuthorFollowupContext(store, {
      guildId: guild.id,
      channelId
    });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-followup-override",
      content: "starter takes still chaotic",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
    assert.equal(llmCalls.length, 2);
    assert.equal(getResolvedOrchestratorBinding(llmCalls[0]?.settings).provider, "openai");
    assert.equal(getResolvedOrchestratorBinding(llmCalls[0]?.settings).model, "claude-haiku-4-5");
    assert.equal(getResolvedOrchestratorBinding(llmCalls[1]?.settings).provider, "anthropic");
    assert.equal(getResolvedOrchestratorBinding(llmCalls[1]?.settings).model, "claude-haiku-4-5");
  });
});

test("reply follow-up regeneration can add history images when model requests image lookup", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      interaction: {
        activity: {
          ambientReplyEagerness: 100
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "tc_img_1",
                  name: "image_lookup",
                  input: { query: "that dog starter photo" }
                }
              ],
              rawContent: [
                { type: "text", text: "" },
                { type: "tool_use", id: "tc_img_1", name: "image_lookup", input: { query: "that dog starter photo" } }
              ],
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "that one was the dog starter image",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "img-context-1",
      createdAt: Date.now() - 3_000,
      guildId: guild.id,
      channelId,
      authorId: "user-2",
      authorName: "smelly conk",
      isBot: false,
      content:
        "https://cdn.discordapp.com/attachments/chan-1/9001/starter-dog.jpg?ex=69a358b6&is=69a20736&hm=abc",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-image-lookup",
      content: "my bad, what is the photo referencing?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
    assert.equal(llmCalls.length, 2);
    assert.match(String(llmCalls[0]?.userPrompt || ""), /smelly conk: \[IMG 1 by smelly conk/);
    assert.doesNotMatch(String(llmCalls[0]?.userPrompt || ""), /Current message attachments:\n- starter-dog/);
    const secondCallContext = llmCalls[1]?.contextMessages || [];
    const hasToolResult = secondCallContext.some((msg) =>
      Array.isArray(msg?.content) && msg.content.some((c) => c?.type === "tool_result")
    );
    assert.equal(hasToolResult, true);
  });
});

test("image lookup tool accepts direct IMG refs from chat history", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "tc_img_1",
                  name: "image_lookup",
                  input: { imageId: "IMG 1" }
                }
              ],
              rawContent: [
                { type: "text", text: "" },
                { type: "tool_use", id: "tc_img_1", name: "image_lookup", input: { imageId: "IMG 1" } }
              ],
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "yep that was the earlier image",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "img-context-1",
      createdAt: Date.now() - 3_000,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanky",
      isBot: true,
      content: "https://cdn.discordapp.com/attachments/chan-1/9001/selfie.png?ex=69a358b6&is=69a20736&hm=abc",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-image-lookup-direct-ref",
      content: "what was in that earlier pic",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 2);
    assert.equal(Array.isArray(llmCalls[1]?.imageInputs), true);
    assert.equal(llmCalls[1].imageInputs.length, 1);
    assert.equal(llmCalls[1].imageInputs[0].filename, "selfie.png");
  });
});

test("reply tool loop keeps remaining concurrent tool results when one concurrent tool throws", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    patchTestSettings(store, {
      permissions: {
        devTasks: {
          allowedUserIds: ["user-1"]
        }
      },
      agentStack: {
        runtimeConfig: {
          devTeam: {
            codexCli: {
              enabled: true
            }
          }
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (llmCalls.length === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "tc_browser_1",
                  name: "browser_browse",
                  input: { query: "open the docs" }
                },
                {
                  id: "tc_code_1",
                  name: "code_task",
                  input: { task: "inspect the repo status" }
                }
              ],
              rawContent: [
                { type: "text", text: "" },
                {
                  type: "tool_use",
                  id: "tc_browser_1",
                  name: "browser_browse",
                  input: { query: "open the docs" }
                },
                {
                  type: "tool_use",
                  id: "tc_code_1",
                  name: "code_task",
                  input: { task: "inspect the repo status" }
                }
              ],
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "kept the surviving tool result",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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
    const originalToReplyPipelineRuntime = bot.toReplyPipelineRuntime.bind(bot);
    bot.toReplyPipelineRuntime = () => ({
      ...originalToReplyPipelineRuntime(),
      runModelRequestedCodeTask: async () => ({
        text: "repo status inspected",
        isError: false,
        costUsd: 0,
        error: null
      }),
      buildSubAgentSessionsRuntime: () => ({
        manager: bot.subAgentSessions,
        createCodeSession() {
          return null;
        },
        createBrowserSession() {
          throw new Error("browser session init exploded");
        }
      })
    });

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "bot-context-concurrent-tools",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanky",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-concurrent-tools",
      content: "check both tools",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      recentMessages,
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length, 2);
    assert.equal(channelSendPayloads.length, 1);
    const followupContext = JSON.stringify(llmCalls[1]?.contextMessages || []);
    assert.match(followupContext, /repo status inspected/);
    assert.match(followupContext, /browser_browse failed: browser session init exploded/);
  });
});

test("reply generation passes a structured JSON schema contract for voice intent directives", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        admission: {
          intentConfidenceThreshold: 0.75
        }
      }
    });

    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              text: "yo",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              imageLookupQuery: null,
              memoryLine: null,
              selfMemoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-voice-schema-contract",
      content: "yo clanker",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(llmCalls.length >= 1, true);
    assert.equal(typeof llmCalls[0]?.jsonSchema, "string");
    assert.match(String(llmCalls[0]?.jsonSchema || ""), /"screenWatchIntent"/);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
  });
});

test("voice intent below confidence threshold falls back to normal text reply path", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        admission: {
          intentConfidenceThreshold: 0.9
        }
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };
    let joinCallCount = 0;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "yo say less",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "join", confidence: 0.5, reason: "weak intent guess" },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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
    bot.voiceSessionManager.requestJoin = async () => {
      joinCallCount += 1;
      return true;
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-voice-low-confidence",
      content: "clanker join vc maybe?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(joinCallCount, 0);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
    assert.equal(typingCallsRef.count > 0, true);
  });
});

test("smoke: 'clanka look at my screen' initiates a screen watch fallback link message", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const shareUrl = "https://public.example.com/share/token-123";
    const llmCalls = [];
    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };
    const createSessionCalls = [];

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push(payload);
          if (String(payload?.trace?.source || "") === "voice_operational_message") {
            return {
              text: `bet, open this and start sharing: ${shareUrl}`,
              provider: "test",
              model: "test-model",
              usage: null,
              costUsd: 0
            };
          }
          return {
            text: JSON.stringify({
              text: "[SKIP]",
              skip: true,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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

    bot.attachScreenShareSessionManager({
      async createSession(args) {
        createSessionCalls.push(args);
        return {
          ok: true,
          shareUrl,
          expiresInMinutes: 12
        };
      }
    });

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-screen-share-request",
      content: "clanka look at my screen",
      replyPayloads
    });

    const settings = store.getSettings();
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages: [],
      addressSignal: {
        direct: true,
        inferred: true,
        triggered: true,
        reason: "name_variant"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
    assert.equal(createSessionCalls.length, 1);
    assert.equal(createSessionCalls[0]?.guildId, guild.id);
    assert.equal(createSessionCalls[0]?.channelId, channel.id);
    assert.equal(createSessionCalls[0]?.requesterUserId, "user-1");
    assert.equal(createSessionCalls[0]?.targetUserId, "user-1");
    assert.equal(createSessionCalls[0]?.source, "message_event");
    const sentContent = String(replyPayloads[0]?.content || channelSendPayloads[0]?.content || "");
    assert.equal(sentContent.includes(shareUrl), true);

    const operationalCall = llmCalls.find(
      (call) => String(call?.trace?.source || "") === "voice_operational_message"
    );
    assert.equal(Boolean(operationalCall), true);
  });
});

test("initiative-channel direct turns can be routed to thread replies when policy chooses reply mode", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replies: {
          replyChannelIds: [channelId]
        }
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "threaded response",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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
    bot.shouldSendAsReply = () => true;

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-threaded",
      content: "clanker respond in thread",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length + channelSendPayloads.length, 1);
  });
});

test("initiative-channel direct turns can be routed to standalone channel messages when policy chooses standalone mode", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replies: {
          replyChannelIds: [channelId]
        }
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "standalone response",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "none", confidence: 0, reason: null },
              screenWatchIntent: { action: "none", confidence: 0, reason: null }
            }),
            provider: "test",
            model: "test-model",
            usage: null,
            costUsd: 0
          };
        }
      },
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
    bot.shouldSendAsReply = () => false;

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-initiative-standalone",
      content: "clanker respond standalone",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(
      channelId,
      getMemorySettings(settings).promptSlice.maxRecentMessages
    );
    const sent = await bot.maybeReplyToMessage(incoming, settings, {
      source: "message_event",
      forceRespond: true,
      recentMessages,
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct"
      }
    });

    assert.equal(sent, true);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 1);
  });
});
