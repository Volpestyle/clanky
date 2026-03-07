import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClankerBot } from "../bot.ts";
import { buildReplyPipelineRuntime } from "./botRuntimeFactories.ts";
import { maybeReplyToMessagePipeline } from "./replyPipeline.ts";
import type { ActiveReply } from "../tools/activeReplyRegistry.ts";
import { ActiveReplyRegistry, buildTextReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import { Store } from "../store/store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";

class TrackingActiveReplyRegistry extends ActiveReplyRegistry {
  clearCalls = 0;

  override clear(reply: ActiveReply | null | undefined) {
    this.clearCalls += 1;
    super.clear(reply);
  }
}

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-reply-pipeline-test-"));
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

function applyBaselineSettings(store: Store, channelId: string) {
  store.patchSettings(createTestSettingsPatch({
    botName: "clanker conk",
    activity: {
      replyEagerness: 65,
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
      maxMessagesPerHour: 120,
      maxReactionsPerHour: 0
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
    },
    vision: {
      enabled: false
    }
  }));
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

function buildChannel({
  guild,
  channelId,
  channelSendPayloads,
  typingCallsRef
}: {
  guild: ReturnType<typeof buildGuild>;
  channelId: string;
  channelSendPayloads: Array<Record<string, unknown>>;
  typingCallsRef: { count: number };
}) {
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
    async send(payload: Record<string, unknown>) {
      channelSendPayloads.push(payload);
      return {
        id: `standalone-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId,
        content: String(payload.content || ""),
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
  content,
  replyPayloads
}: {
  guild: ReturnType<typeof buildGuild>;
  channel: ReturnType<typeof buildChannel>;
  messageId: string;
  content: string;
  replyPayloads: Array<Record<string, unknown>>;
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
        size: 0,
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
    async reply(payload: Record<string, unknown>) {
      replyPayloads.push(payload);
      return {
        id: `reply-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId: guild.id,
        channelId: channel.id,
        content: String(payload.content || ""),
        attachments: new Map(),
        embeds: []
      };
    }
  };
}

test("maybeReplyToMessagePipeline treats an aborted in-flight reply as handled and clears tracking", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    let resolveGenerateStarted: (() => void) | null = null;
    const generateStarted = new Promise<void>((resolve) => {
      resolveGenerateStarted = resolve;
    });
    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          resolveGenerateStarted?.();
          return await new Promise((_, reject) => {
            const abortWithReason = () => {
              reject(createAbortError(payload.signal?.reason || "Reply cancelled"));
            };
            if (payload.signal?.aborted) {
              abortWithReason();
              return;
            }
            payload.signal?.addEventListener("abort", abortWithReason, { once: true });
          });
        }
      },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    const activeReplies = new TrackingActiveReplyRegistry();
    bot.activeReplies = activeReplies;
    bot.client.user = {
      id: "bot-1",
      username: "clanker conk",
      tag: "clanker conk#0001"
    };

    const guild = buildGuild();
    const channel = buildChannel({
      guild,
      channelId,
      channelSendPayloads,
      typingCallsRef
    });
    const message = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-1",
      content: "clanker can you answer this?",
      replyPayloads
    });
    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });
    const replyScopeKey = buildTextReplyScopeKey({
      guildId: guild.id,
      channelId
    });

    const pipelinePromise = maybeReplyToMessagePipeline(runtime, message, settings, {
      source: "message_event",
      forceDecisionLoop: true,
      forceRespond: true,
      recentMessages: [],
      triggerMessageIds: [message.id],
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct_address"
      }
    });

    assert.equal(activeReplies.has(replyScopeKey), true);
    await generateStarted;
    assert.equal(activeReplies.has(replyScopeKey), true);

    const cancelledCount = activeReplies.abortAll(replyScopeKey, "User requested cancellation");
    assert.equal(cancelledCount, 1);

    const handled = await pipelinePromise;
    assert.equal(handled, true);
    assert.equal(activeReplies.has(replyScopeKey), false);
    assert.equal(activeReplies.clearCalls, 1);
    assert.equal(typingCallsRef.count, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(replyPayloads.length, 0);
  });
});
