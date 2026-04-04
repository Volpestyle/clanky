import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ClankerBot } from "../bot.ts";
import { Store } from "../store/store.ts";
import { rmTempDir } from "../testHelpers.ts";
import { createTestSettingsPatch } from "../testSettings.ts";
import { buildTextReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { buildBrowserTaskScopeKey } from "../tools/browserTaskRuntime.ts";

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-text-cancel-test-"));
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

function configureStore(store: Store, channelId: string) {
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
      enabled: false
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
}

function createIncomingMessage({
  guildId,
  channelId,
  content,
  replyPayloads,
  reactionCalls
}: {
  guildId: string;
  channelId: string;
  content: string;
  replyPayloads: Array<Record<string, unknown>>;
  reactionCalls: string[];
}) {
  const guild = {
    id: guildId,
    members: {
      cache: new Map()
    }
  };
  const channel = {
    id: channelId,
    guildId,
    guild,
    isTextBased() {
      return true;
    }
  };

  return {
    id: "msg-1",
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
    content,
    reference: null,
    attachments: new Map(),
    embeds: [],
    async reply(payload: Record<string, unknown>) {
      replyPayloads.push(payload);
      return {
        id: `bot-reply-${replyPayloads.length}`,
        createdTimestamp: Date.now(),
        guildId,
        channelId,
        content: String(payload?.content || ""),
        attachments: new Map(),
        embeds: []
      };
    },
    async react(emoji: string) {
      reactionCalls.push(emoji);
    }
  };
}

test("text cancel uses a model-generated acknowledgement after aborting active work", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "chan-1";
    configureStore(store, channelId);

    const llmCalls: Array<Record<string, unknown>> = [];
    const replyPayloads: Array<Record<string, unknown>> = [];
    const reactionCalls: string[] = [];
    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload: Record<string, unknown>) {
          llmCalls.push(payload);
          return {
            text: "Sure, stopping there.",
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

    const replyScopeKey = buildTextReplyScopeKey({ guildId, channelId });
    const activeReply = bot.activeReplies.begin(replyScopeKey, "text-reply");
    const browserScopeKey = buildBrowserTaskScopeKey({ guildId, channelId });
    const activeBrowserTask = bot.activeBrowserTasks.beginTask(browserScopeKey);
    bot.replyQueues.set(channelId, [
      {
        message: {
          id: "queued-1"
        }
      }
    ]);
    bot.replyQueuedMessageIds.add("queued-1");

    const message = createIncomingMessage({
      guildId,
      channelId,
      content: "stop",
      replyPayloads,
      reactionCalls
    });

    try {
      await bot.handleMessage(message);

      assert.equal(activeReply.abortController.signal.aborted, true);
      assert.equal(activeBrowserTask.abortController.signal.aborted, true);
      assert.equal(bot.replyQueues.has(channelId), false);
      assert.equal(bot.replyQueuedMessageIds.has("queued-1"), false);
      assert.equal(replyPayloads.length, 1);
      assert.equal(replyPayloads[0]?.content, "Sure, stopping there.");
      assert.deepEqual(replyPayloads[0]?.allowedMentions, { repliedUser: false });
      assert.deepEqual(reactionCalls, []);
      assert.equal(llmCalls.length, 1);
      assert.match(String(llmCalls[0]?.userPrompt || ""), /queued repl/i);
      assert.match(String(llmCalls[0]?.userPrompt || ""), /active browser task/i);
    } finally {
      await bot.stop();
    }
  });
});

test("text cancel falls back to a reaction when acknowledgement generation fails", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "chan-1";
    configureStore(store, channelId);

    const replyPayloads: Array<Record<string, unknown>> = [];
    const reactionCalls: string[] = [];
    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          throw new Error("llm unavailable");
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

    const replyScopeKey = buildTextReplyScopeKey({ guildId, channelId });
    bot.activeReplies.begin(replyScopeKey, "text-reply");
    const message = createIncomingMessage({
      guildId,
      channelId,
      content: "nevermind",
      replyPayloads,
      reactionCalls
    });

    try {
      await bot.handleMessage(message);

      assert.deepEqual(replyPayloads, []);
      assert.deepEqual(reactionCalls, ["🛑"]);
    } finally {
      await bot.stop();
    }
  });
});
