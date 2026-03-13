import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageType, type ChatInputCommandInteraction } from "discord.js";
import { ClankerBot } from "../bot.ts";
import { createTestSettings } from "../testSettings.ts";

function createBot() {
  return new ClankerBot({
    appConfig: {},
    store: {
      getSettings() {
        return createTestSettings({
          identity: {
            botName: "clanky"
          }
        });
      },
      countActionsSince() {
        return 0;
      },
      logAction() {}
    },
    llm: {
      getCodexCompatibleClient() {
        return null;
      },
      openai: null,
      codexOAuth: null
    },
    memory: null,
    discovery: null,
    search: null,
    gifs: null,
    video: null
  });
}

function createClankSlashInteraction({
  subcommand,
  subcommandGroup = null
}: {
  subcommand: string;
  subcommandGroup?: string | null;
}) {
  const replies: string[] = [];

  const interaction = {
    commandName: "clank",
    guildId: "guild-1",
    channelId: "text-1",
    guild: { id: "guild-1" },
    channel: { id: "text-1" },
    user: { id: "user-1" },
    options: {
      getSubcommandGroup(required?: boolean) {
        if (subcommandGroup) return subcommandGroup;
        if (required) throw new Error("missing subcommand group");
        return null;
      },
      getSubcommand(required?: boolean) {
        if (subcommand) return subcommand;
        if (required) throw new Error("missing subcommand");
        return null;
      },
      getString() {
        return null;
      }
    },
    async reply(payload: string | { content?: string }) {
      replies.push(typeof payload === "string" ? payload : String(payload.content || ""));
      return null;
    }
  };

  return {
    interaction,
    replies
  };
}

test("handleClankSlashCommand routes /clank say to the voice session manager", async () => {
  const bot = createBot();
  const voiceCalls: Array<Record<string, unknown>> = [];
  bot.voiceSessionManager.handleClankSlashCommand = async (
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) => {
    voiceCalls.push({ interaction, settings });
  };

  const slash = createClankSlashInteraction({
    subcommand: "say"
  });

  await bot.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction);

  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0]?.interaction, slash.interaction);
  assert.equal(slash.replies.length, 0);
});

test("handleClankSlashCommand routes /clank music subcommands to the voice session manager", async () => {
  const bot = createBot();
  const voiceCalls: Array<Record<string, unknown>> = [];
  bot.voiceSessionManager.handleClankSlashCommand = async (
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) => {
    voiceCalls.push({ interaction, settings });
  };

  const slash = createClankSlashInteraction({
    subcommand: "play",
    subcommandGroup: "music"
  });

  await bot.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction);

  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0]?.interaction, slash.interaction);
  assert.equal(slash.replies.length, 0);
});

test("handleClankSlashCommand routes /clank browse to the browse handler", async () => {
  const bot = createBot();
  const browseCalls: Array<Record<string, unknown>> = [];
  bot.handleClankBrowseSlashCommand = async (
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) => {
    browseCalls.push({ interaction, settings });
  };

  const slash = createClankSlashInteraction({
    subcommand: "browse"
  });

  await bot.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction);

  assert.equal(browseCalls.length, 1);
  assert.equal(browseCalls[0]?.interaction, slash.interaction);
  assert.equal(slash.replies.length, 0);
});

test("handleClankSlashCommand routes /clank code to the code handler", async () => {
  const bot = createBot();
  const codeCalls: Array<Record<string, unknown>> = [];
  bot.handleClankCodeSlashCommand = async (
    interaction: ChatInputCommandInteraction,
    settings: Record<string, unknown> | null
  ) => {
    codeCalls.push({ interaction, settings });
  };

  const slash = createClankSlashInteraction({
    subcommand: "code"
  });

  await bot.handleClankSlashCommand(slash.interaction as ChatInputCommandInteraction);

  assert.equal(codeCalls.length, 1);
  assert.equal(codeCalls[0]?.interaction, slash.interaction);
  assert.equal(slash.replies.length, 0);
});

test("handleMessage ignores slash command invocation messages so they do not trigger normal text replies", async () => {
  const recordedMessages: Array<Record<string, unknown>> = [];
  const queuedReplies: Array<Record<string, unknown>> = [];
  const bot = new ClankerBot({
    appConfig: {},
    store: {
      getSettings() {
        return createTestSettings({
          identity: {
            botName: "clanky"
          }
        });
      },
      countActionsSince() {
        return 0;
      },
      logAction() {},
      recordMessage(payload: Record<string, unknown>) {
        recordedMessages.push(payload);
      },
      getRecentMessages() {
        return [];
      },
      hasTriggeredResponse() {
        return false;
      }
    },
    llm: {
      getCodexCompatibleClient() {
        return null;
      },
      openai: null,
      codexOAuth: null
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
  bot.enqueueReplyJob = (payload: Record<string, unknown>) => {
    queuedReplies.push(payload);
    return true;
  };

  await bot.handleMessage({
    id: "msg-1",
    type: MessageType.ChatInputCommand,
    guildId: "guild-1",
    channelId: "text-1",
    guild: { id: "guild-1" },
    channel: { id: "text-1", isTextBased() { return true; } },
    author: {
      id: "user-1",
      username: "alice",
      bot: false
    }
  });

  assert.equal(recordedMessages.length, 0);
  assert.equal(queuedReplies.length, 0);
});
