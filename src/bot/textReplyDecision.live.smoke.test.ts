import { test } from "bun:test";
import assert from "node:assert/strict";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { ClankerBot } from "../bot.ts";
import { ADDRESSING_SMOKE_CASES } from "../addressingSmokeCases.ts";
import { Store } from "../store.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";
import { envFlag } from "../testHelpers.ts";

function defaultModelForProvider(provider) {
  if (provider === "anthropic") {
    return "claude-sonnet-4-5";
  }
  if (provider === "xai") {
    return String(appConfig.defaultXaiModel || defaultModelForLlmProvider("xai"));
  }
  if (provider === "claude-code") {
    return String(appConfig.defaultClaudeCodeModel || defaultModelForLlmProvider("claude-code"));
  }
  return String(appConfig.defaultOpenAiModel || defaultModelForLlmProvider("openai"));
}

function hasProviderCredentials(provider) {
  if (provider === "anthropic") return Boolean(appConfig.anthropicApiKey);
  if (provider === "xai") return Boolean(appConfig.xaiApiKey);
  if (provider === "claude-code") return true;
  return Boolean(appConfig.openaiApiKey);
}

function buildGuild() {
  return {
    id: "live-text-guild",
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

function buildChannel({ guild, channelId, channelSendPayloads }) {
  return {
    id: channelId,
    guildId: guild.id,
    name: "general",
    guild,
    isTextBased() {
      return true;
    },
    async sendTyping() {
      return undefined;
    },
    async send(payload) {
      channelSendPayloads.push(payload);
      return {
        id: `sent-${Date.now()}`,
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

function buildIncomingMessage({
  guild,
  channel,
  messageId,
  content
}) {
  return {
    id: messageId,
    createdTimestamp: Date.now(),
    guildId: guild.id,
    channelId: channel.id,
    guild,
    channel,
    author: {
      id: "speaker-1",
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

test("smoke: live text reply admission handles wake variants and prank-like negatives", { timeout: 30_000 }, async () => {
  if (!envFlag("RUN_LIVE_TEXT_REPLY_SMOKE")) return;

  const provider = normalizeLlmProvider(process.env.LIVE_TEXT_SMOKE_PROVIDER || "claude-code");
  const model = String(process.env.LIVE_TEXT_SMOKE_MODEL || defaultModelForProvider(provider)).trim()
    || defaultModelForProvider(provider);

  assert.equal(
    hasProviderCredentials(provider),
    true,
    `Missing API credentials for live text smoke provider "${provider}".`
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-live-text-smoke-"));
  const dbPath = path.join(tempDir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  try {
    const llm = new LLMService({ appConfig, store });
    const bot = new ClankerBot({
      appConfig: {
        ...appConfig,
        disableSimulatedTypingDelay: true
      },
      store,
      llm,
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
    const channelId = "live-text-channel";
    const channelSendPayloads = [];
    const channel = buildChannel({ guild, channelId, channelSendPayloads });

    store.patchSettings({
      botName: "clanker conk",
      llm: {
        provider,
        model,
        temperature: 0.1,
        maxOutputTokens: 220
      },
      activity: {
        replyLevelReplyChannels: 50,
        replyLevelOtherChannels: 50,
        reactionLevel: 0,
        minSecondsBetweenMessages: 0,
        replyCoalesceWindowSeconds: 0,
        replyCoalesceMaxMessages: 1
      },
      permissions: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: false,
        replyChannelIds: [],
        allowedChannelIds: [channelId],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 200,
        maxReactionsPerHour: 0
      },
      memory: {
        enabled: false,
        maxRecentMessages: 20
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
      },
      voice: {
        enabled: false
      }
    });

    const settings = store.getSettings();
    const staticRecentMessages = [
      {
        message_id: "context-bot-1",
        author_id: "bot-1",
        author_name: "clanker conk",
        content: "hanging out in chat.",
        created_at: new Date(Date.now() - 1500).toISOString()
      },
      {
        message_id: "context-user-1",
        author_id: "speaker-2",
        author_name: "bob",
        content: "anyone around?",
        created_at: new Date(Date.now() - 1200).toISOString()
      }
    ];

    for (let index = 0; index < ADDRESSING_SMOKE_CASES.length; index += 1) {
      const row = ADDRESSING_SMOKE_CASES[index];
      const beforeSendCount = channelSendPayloads.length;
      const message = buildIncomingMessage({
        guild,
        channel,
        messageId: `live-text-msg-${index + 1}`,
        content: row.text
      });
      const addressSignal = await bot.getReplyAddressSignal(settings, message, staticRecentMessages);
      assert.equal(
        Boolean(addressSignal?.triggered),
        row.expected,
        `Unexpected admission/addressing signal for "${row.text}".`
      );

      const replied = await bot.maybeReplyToMessage(message, settings, {
        source: "live_text_smoke",
        recentMessages: staticRecentMessages,
        addressSignal,
        forceRespond: Boolean(addressSignal?.triggered)
      });

      if (!row.expected) {
        assert.equal(replied, false, `Expected skip for non-addressed turn "${row.text}".`);
        const didSend = channelSendPayloads.length > beforeSendCount;
        assert.equal(didSend, false, `Expected no text send for "${row.text}".`);
      }
    }
  } finally {
    store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
