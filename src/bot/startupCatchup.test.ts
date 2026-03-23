import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClankerBot } from "../bot.ts";
import { Store } from "../store/store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";
import { runStartupCatchup } from "./startupCatchup.ts";

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-startup-catchup-test-"));
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

function applyBaselineSettings(store: Store, explicitChannelId: string) {
  store.patchSettings(createTestSettingsPatch({
    interaction: {
      startup: {
        catchupEnabled: true,
        catchupLookbackHours: 6,
        catchupMaxMessagesPerChannel: 20,
        maxCatchupRepliesPerChannel: 2
      }
    },
    permissions: {
      replies: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: false,
        replyChannelIds: [explicitChannelId],
        allowedChannelIds: [],
        discoveryChannelIds: [],
        blockedChannelIds: [],
        blockedUserIds: [],
        maxMessagesPerHour: 120,
        maxReactionsPerHour: 0
      }
    },
    memory: {
      enabled: false,
      promptSlice: {
        maxRecentMessages: 12
      }
    }
  }));
}

function buildSendableChannel({ id, guild }: { id: string; guild: { id: string } }) {
  return {
    id,
    guildId: guild.id,
    guild,
    name: `channel-${id}`,
    isTextBased() {
      return true;
    },
    async send() {
      return { id: `sent-${id}`, createdTimestamp: Date.now(), guildId: guild.id, channelId: id };
    },
    async sendTyping() {
      return undefined;
    }
  };
}

test("getStartupScanChannels includes reply-eligible channels beyond explicit startup channels", async () => {
  await withTempStore(async (store) => {
    applyBaselineSettings(store, "chan-explicit");

    const guild = {
      id: "guild-1",
      channels: {
        cache: new Map<string, ReturnType<typeof buildSendableChannel>>()
      }
    };
    const explicitChannel = buildSendableChannel({ id: "chan-explicit", guild });
    const ambientChannel = buildSendableChannel({ id: "chan-ambient", guild });
    guild.channels.cache.set(explicitChannel.id, explicitChannel);
    guild.channels.cache.set(ambientChannel.id, ambientChannel);

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: { async generate() { return { text: "", toolCalls: [] }; } },
      memory: null,
      discovery: null,
      search: null,
      gifs: null,
      video: null
    });

    bot.client.user = { id: "bot-1", username: "clanky", tag: "clanky#0001" };
    bot.client.channels = {
      cache: new Map([
        [explicitChannel.id, explicitChannel],
        [ambientChannel.id, ambientChannel]
      ])
    };
    bot.client.guilds = {
      cache: new Map([[guild.id, guild]])
    };

    const channels = bot.getStartupScanChannels(store.getSettings());
    assert.deepEqual(
      channels.map((channel) => channel.id),
      ["chan-explicit", "chan-ambient"]
    );

    const actions = store.getRecentActions(10);
    assert.equal(
      actions.some(
        (entry) =>
          entry.content === "startup_catchup_channel_scan_complete" &&
          entry.metadata?.selectedChannelCount === 2 &&
          entry.metadata?.explicitSelectedCount === 1 &&
          entry.metadata?.replyEligibleSelectedCount === 1
      ),
      true
    );
  });
});

test("runStartupCatchup logs begin, per-channel scan, and completion summaries", async () => {
  await withTempStore(async (store) => {
    applyBaselineSettings(store, "chan-explicit");

    const channel = {
      id: "chan-explicit",
      guildId: "guild-1",
      guild: { id: "guild-1" }
    };
    const message = {
      id: "msg-1",
      createdTimestamp: Date.now() - 1_000,
      guild: channel.guild,
      guildId: channel.guildId,
      channel,
      channelId: channel.id,
      author: { id: "user-1" }
    };

    await runStartupCatchup({
      botUserId: "bot-1",
      store,
      getStartupScanChannels() {
        return [channel];
      },
      async hydrateRecentMessages() {
        return [message];
      },
      isChannelAllowed() {
        return true;
      },
      isUserBlocked() {
        return false;
      },
      async getReplyAddressSignal() {
        return {
          direct: true,
          inferred: false,
          triggered: true,
          reason: "direct",
          confidence: 1,
          threshold: 0.62,
          confidenceSource: "direct"
        };
      },
      hasStartupFollowupAfterMessage() {
        return false;
      },
      enqueueReplyJob() {
        return true;
      }
    }, store.getSettings());

    const actions = store.getRecentActions(10);
    assert.equal(actions.some((entry) => entry.content === "startup_catchup_begin"), true);
    assert.equal(
      actions.some((entry) => entry.content === "startup_catchup_channel_scanned" && entry.metadata?.queuedReplyCount === 1),
      true
    );
    assert.equal(
      actions.some((entry) => entry.content === "startup_catchup_complete" && entry.metadata?.queuedReplyCount === 1),
      true
    );
  });
});
