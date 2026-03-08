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
import {
  getVoiceScreenShareCapability,
  offerVoiceScreenShareLink
} from "./screenShare.ts";
import { getReplyAddressSignal as getReplyAddressSignalForReplyAdmission } from "./replyAdmission.ts";
import { isReplyChannel as isReplyChannelForPermissions } from "./permissions.ts";
import { Store } from "../store/store.ts";
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
    await fs.rm(dir, { recursive: true, force: true });
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
  replyPayloads
}) {
  return {
    id: messageId,
    createdTimestamp: Date.now(),
    guildId: guild.id,
    channelId: channel.id,
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
    content,
    mentions: {
      users: {
        has() {
          return false;
        }
      },
      repliedUser: null
    },
    reference: null,
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

function patchTestSettings(store, patch) {
  store.patchSettings(createTestSettingsPatch(patch));
}

function applyBaselineSettings(store, channelId) {
  patchTestSettings(store, {
    activity: {
      replyEagerness: 65,
      reactionLevel: 20,
      minSecondsBetweenMessages: 5,
      replyCoalesceWindowSeconds: 0,
      replyCoalesceMaxMessages: 1
    },
    permissions: {
      allowReplies: true,
      allowUnsolicitedReplies: true,
      allowReactions: true,
      replyChannelIds: [],
      allowedChannelIds: [channelId],
      blockedChannelIds: [],
      blockedUserIds: [],
      maxMessagesPerHour: 120,
      maxReactionsPerHour: 120
    },
    memory: {
      enabled: false,
      maxRecentMessages: 12
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
  });
}

test("non-addressed non-initiative turn can still post when model contributes value", async () => {
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-1",
      content: "pokemon starter takes are all over the place rn",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
      (row) => row.kind === "sent_message" && row.message_id !== "bot-context-1"
    );
    assert.equal(sentAction?.metadata?.replyPrompts?.hiddenByDefault, true);
    assert.equal(typeof sentAction?.metadata?.replyPrompts?.systemPrompt, "string");
    assert.equal(typeof sentAction?.metadata?.replyPrompts?.initialUserPrompt, "string");
    assert.deepEqual(sentAction?.metadata?.replyPrompts?.followupUserPrompts, []);

  });
});

test("non-addressed non-initiative turn is skipped when model declines", async () => {
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
    });

    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-2",
      content: "random side chatter between people",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
        author_name: "clanker conk",
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
        replyChannelIds: [channelId]
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-initiative-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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

test("reply channels do not immediately evaluate cold non-addressed turns without prior bot context", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replyChannelIds: [channelId]
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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

    assert.equal(sent, false);
    assert.equal(llmCalls.length, 0);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 0);
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
        allowUnsolicitedReplies: false
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-direct",
      content: "clanker conk you there?",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });

    store.recordMessage({
      messageId: "bot-context-search-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
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
        preset: "openai_native",
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "bot-context-1",
      createdAt: Date.now() - 750,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
      isBot: true,
      content: "last bot line",
      referencedMessageId: null
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
      activity: {
        replyEagerness: 100
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    store.recordMessage({
      messageId: "img-context-1",
      createdAt: Date.now() - 3_000,
      guildId: guild.id,
      channelId,
      authorId: "bot-1",
      authorName: "clanker conk",
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
            codex: {
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
      authorName: "clanker conk",
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

test("voice intent handoff routes join requests to voice session manager instead of sending text", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.75
      }
    });

    const replyPayloads = [];
    const channelSendPayloads = [];
    const typingCallsRef = { count: 0 };
    let joinCall = null;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              text: "bet hopping in",
              skip: false,
              reactionEmoji: null,
              media: null,
              webSearchQuery: null,
              memoryLookupQuery: null,
              memoryLine: null,
              automationAction: { operation: "none" },
              voiceIntent: { intent: "join", confidence: 0.92, reason: "explicit join request" },
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };
    bot.voiceSessionManager.requestJoin = async (payload) => {
      joinCall = payload;
      return true;
    };

    const guild = buildGuild();
    const channel = buildChannel({ guild, channelId, channelSendPayloads, typingCallsRef });
    const incoming = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-voice-join",
      content: "clanker join vc",
      replyPayloads
    });

    const settings = store.getSettings();
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
    assert.equal(Boolean(joinCall), true);
    assert.equal(joinCall?.intentConfidence, 0.92);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(typingCallsRef.count, 1);

    const intentEvent = store
      .getRecentActions(20)
      .find((row) => row.kind === "voice_intent_detected" && row.message_id === "msg-voice-join");
    assert.equal(Boolean(intentEvent), true);
    assert.equal(intentEvent?.content, "join");
  });
});

test("reply generation passes a structured JSON schema contract for voice intent directives", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.75
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
    assert.match(String(llmCalls[0]?.jsonSchema || ""), /"voiceIntent"/);
    assert.match(String(llmCalls[0]?.jsonSchema || ""), /"join"/);
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
        intentConfidenceThreshold: 0.9
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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

test("maybeHandleStructuredVoiceIntent respects canonical voice admission threshold", async () => {
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

    let joinCallCount = 0;
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
    bot.voiceSessionManager.requestJoin = async () => {
      joinCallCount += 1;
      return true;
    };

    const handled = await bot.maybeHandleStructuredVoiceIntent({
      message: {
        id: "msg-canonical-voice-threshold",
        guildId: "guild-1",
        channelId,
        author: { id: "user-1", username: "alice" },
        member: { displayName: "alice" }
      },
      settings: store.getSettings(),
      replyDirective: {
        voiceIntent: {
          intent: "join",
          confidence: 0.8,
          reason: "not confident enough"
        }
      }
    });

    assert.equal(handled, false);
    assert.equal(joinCallCount, 0);
  });
});

test("voice intent dispatcher routes all supported intents to voice session manager handlers", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      voice: {
        enabled: true,
        intentConfidenceThreshold: 0.75
      }
    });

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: "",
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
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const called = [];
    bot.voiceSessionManager.requestJoin = async () => {
      called.push("join");
      return true;
    };
    bot.voiceSessionManager.requestLeave = async () => {
      called.push("leave");
      return true;
    };
    bot.voiceSessionManager.requestStatus = async () => {
      called.push("status");
      return true;
    };
    bot.voiceSessionManager.requestWatchStream = async () => {
      called.push("watch_stream");
      return true;
    };
    bot.voiceSessionManager.requestStopWatchingStream = async () => {
      called.push("stop_watching_stream");
      return true;
    };
    bot.voiceSessionManager.requestStreamWatchStatus = async () => {
      called.push("stream_status");
      return true;
    };
    bot.voiceSessionManager.requestPlayMusic = async (payload: { action?: string } = {}) => {
      const action = payload.action;
      called.push(
        action === "queue_next"
          ? "music_queue_next"
          : action === "queue_add"
            ? "music_queue_add"
            : "music_play_now"
      );
      return true;
    };
    bot.voiceSessionManager.requestStopMusic = async () => {
      called.push("music_stop");
      return true;
    };
    bot.voiceSessionManager.requestPauseMusic = async () => {
      called.push("music_pause");
      return true;
    };

    const message = {
      id: "msg-intent-dispatch",
      guildId: "guild-1",
      channelId,
      author: { id: "user-1", username: "alice" },
      member: { displayName: "alice" }
    };
    const settings = store.getSettings();
    const intents = [
      "join",
      "leave",
      "status",
      "watch_stream",
      "stop_watching_stream",
      "stream_status",
      "music_play_now",
      "music_queue_next",
      "music_queue_add",
      "music_stop",
      "music_pause"
    ];

    for (const intent of intents) {
      const handled = await bot.maybeHandleStructuredVoiceIntent({
        message,
        settings,
        replyDirective: {
          voiceIntent: {
            intent,
            confidence: 0.99,
            reason: "explicit command"
          }
        }
      });
      assert.equal(handled, true);
    }

    assert.deepEqual(called, intents);
  });
});

test("smoke: 'clanka look at my screen' initiates a screen-share link message", async () => {
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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

test("getVoiceScreenShareCapability normalizes status and handles missing manager", async () => {
  await withTempStore(async (store) => {
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

    const unavailable = getVoiceScreenShareCapability(bot.toScreenShareRuntime());
    assert.equal(unavailable.supported, false);
    assert.equal(unavailable.enabled, false);
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.status, "disabled");
    assert.equal(unavailable.reason, "screen_share_manager_unavailable");

    bot.attachScreenShareSessionManager({
      getLinkCapability() {
        return {
          enabled: true,
          status: "READY",
          publicUrl: " https://demo.trycloudflare.com "
        };
      }
    });

    const ready = getVoiceScreenShareCapability(bot.toScreenShareRuntime());
    assert.equal(ready.supported, true);
    assert.equal(ready.enabled, true);
    assert.equal(ready.available, true);
    assert.equal(ready.status, "ready");
    assert.equal(ready.publicUrl, "https://demo.trycloudflare.com");
    assert.equal(ready.reason, null);

    bot.attachScreenShareSessionManager({
      getLinkCapability() {
        return {
          enabled: true,
          status: "starting",
          publicUrl: "https://demo.trycloudflare.com"
        };
      }
    });

    const warming = getVoiceScreenShareCapability(bot.toScreenShareRuntime());
    assert.equal(warming.supported, true);
    assert.equal(warming.enabled, true);
    assert.equal(warming.available, false);
    assert.equal(warming.status, "starting");
    assert.equal(warming.reason, "starting");
  });
});

test("offerVoiceScreenShareLink sends generated offer to text channel when session is created", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-screen-share-offer";
    applyBaselineSettings(store, channelId);

    const channelSendPayloads = [];
    const createSessionCalls = [];
    const channel = {
      id: channelId,
      guildId: "guild-1",
      async send(payload) {
        channelSendPayloads.push(payload);
        return { id: "msg-1" };
      }
    };
    const guild = buildGuild();
    guild.members.cache.set("user-1", {
      displayName: "alice",
      user: { username: "alice_user" }
    });

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
    bot.client.guilds = {
      cache: new Map([[guild.id, guild]])
    };
    bot.client.users = {
      cache: new Map()
    };
    bot.client.channels = {
      async fetch(id) {
        if (id === channelId) return channel;
        return null;
      }
    };

    bot.attachScreenShareSessionManager({
      async createSession(args) {
        createSessionCalls.push(args);
        return {
          ok: true,
          shareUrl: "https://screen.example/session/abc",
          expiresInMinutes: 12
        };
      }
    });

    const result = await offerVoiceScreenShareLink({
      ...bot.toScreenShareRuntime(),
      composeScreenShareOfferMessage: async (payload) =>
        `bet, open this and start sharing: ${String(payload?.linkUrl || "")}`
    }, {
      settings: store.getSettings(),
      guildId: guild.id,
      channelId,
      requesterUserId: "user-1",
      transcript: "yo look at this",
      source: "voice_turn_directive"
    });

    assert.equal(result.offered, true);
    assert.equal(result.reason, "offered");
    assert.equal(channelSendPayloads.length, 1);
    assert.match(String(channelSendPayloads[0] || ""), /screen\.example\/session\/abc/);
    assert.equal(createSessionCalls.length, 1);
    assert.equal(createSessionCalls[0]?.guildId, guild.id);
    assert.equal(createSessionCalls[0]?.channelId, channelId);
    assert.equal(createSessionCalls[0]?.requesterUserId, "user-1");
    assert.equal(createSessionCalls[0]?.targetUserId, "user-1");
    assert.equal(createSessionCalls[0]?.source, "voice_turn_directive");
  });
});

test("offerVoiceScreenShareLink sends generated unavailable text when session creation fails", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-screen-share-unavailable";
    applyBaselineSettings(store, channelId);

    const channelSendPayloads = [];
    const channel = {
      id: channelId,
      guildId: "guild-1",
      async send(payload) {
        channelSendPayloads.push(payload);
        return { id: "msg-2" };
      }
    };
    const guild = buildGuild();
    guild.members.cache.set("user-1", {
      displayName: "alice",
      user: { username: "alice_user" }
    });

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
    bot.client.guilds = {
      cache: new Map([[guild.id, guild]])
    };
    bot.client.users = {
      cache: new Map()
    };
    bot.client.channels = {
      async fetch(id) {
        if (id === channelId) return channel;
        return null;
      }
    };

    bot.attachScreenShareSessionManager({
      async createSession() {
        return {
          ok: false,
          reason: "provider_unavailable"
        };
      }
    });

    const result = await offerVoiceScreenShareLink({
      ...bot.toScreenShareRuntime(),
      composeScreenShareUnavailableMessage: async () =>
        "can't share screen links right now, try again in a minute"
    }, {
      settings: store.getSettings(),
      guildId: guild.id,
      channelId,
      requesterUserId: "user-1",
      transcript: "screen share broken?",
      source: "voice_turn_directive"
    });

    assert.equal(result.offered, false);
    assert.equal(result.reason, "provider_unavailable");
    assert.equal(channelSendPayloads.length, 1);
    assert.match(String(channelSendPayloads[0] || ""), /can't share screen links right now/i);
  });
});

test("initiative-channel direct turns can be routed to thread replies when policy chooses reply mode", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      permissions: {
        replyChannelIds: [channelId]
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
        replyChannelIds: [channelId]
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
              screenShareIntent: { action: "none", confidence: 0, reason: null }
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
      username: "clanker conk",
      tag: "clanker conk#0001"
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
    const recentMessages = store.getRecentMessages(channelId, settings.memory.maxRecentMessages);
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
