import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "../store/store.ts";
import { rmTempDir } from "../testHelpers.ts";
import {
  createMinecraftNarrationState,
  maybePostMinecraftNarration
} from "./minecraftNarration.ts";
import type { MinecraftGameEvent } from "../agents/minecraft/types.ts";

function mcEvent(event: MinecraftGameEvent): MinecraftGameEvent {
  return event;
}

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-minecraft-narration-test-"));
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

function buildRuntime({
  store,
  guildId,
  channelId,
  llmGenerate,
  onSend
}: {
  store: Store;
  guildId: string;
  channelId: string;
  llmGenerate: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onSend?: (payload: Record<string, unknown>) => void;
}) {
  const channel = {
    id: channelId,
    guildId,
    name: "survival",
    async sendTyping() {
      return true;
    },
    async send(payload: Record<string, unknown>) {
      onSend?.(payload);
      return {
        id: `sent-${Date.now()}`,
        createdTimestamp: Date.now(),
        guildId,
        channelId
      };
    }
  };

  return {
    appConfig: { env: "test" },
    store,
    llm: {
      generate: llmGenerate
    },
    memory: {},
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: {
          get() {
            return undefined;
          }
        }
      },
      channels: {
        cache: {
          get(id: string) {
            return id === channelId ? channel : undefined;
          }
        }
      }
    },
    botUserId: "bot-1",
    canSendMessage() {
      return true;
    },
    canTalkNow() {
      return true;
    },
    getSimulatedTypingDelayMs() {
      return 0;
    },
    markSpoke() {},
    composeMessageContentForHistory(_message: unknown, baseText = "") {
      return baseText;
    }
  } as Parameters<typeof maybePostMinecraftNarration>[0];
}

test("maybePostMinecraftNarration posts a Discord narration message for significant events", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const llmCalls: Array<Record<string, unknown>> = [];
    const sentPayloads: Array<Record<string, unknown>> = [];

    store.patchSettings({
      permissions: {
        replies: {
          maxMessagesPerHour: 100
        }
      },
      agentStack: {
        runtimeConfig: {
          minecraft: {
            narration: {
              eagerness: 100,
              minSecondsBetweenPosts: 0
            }
          }
        }
      }
    });
    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 1_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "how's the cave run going",
      referencedMessageId: null
    });

    const runtime = buildRuntime({
      store,
      guildId,
      channelId,
      onSend(payload) {
        sentPayloads.push(payload);
      },
      async llmGenerate(payload) {
        llmCalls.push(payload);
        return {
          text: JSON.stringify({
            skip: false,
            text: "i just ate shit and died in the cave lmao",
            reason: "death is worth surfacing"
          }),
          toolCalls: [],
          rawContent: null,
          provider: "test",
          model: "test-model",
          usage: {
            inputTokens: 0,
            outputTokens: 0
          },
          costUsd: 0.01
        };
      }
    });

    const posted = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "death", timestamp: "2026-04-04T12:00:00.000Z", summary: "death" })],
      state: createMinecraftNarrationState()
    });

    assert.equal(posted, true);
    assert.equal(llmCalls.length, 1);
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0]?.content, "i just ate shit and died in the cave lmao");
    assert.match(String(llmCalls[0]?.userPrompt || ""), /how's the cave run going/i);

    const postLog = store.getRecentActions(10, { kinds: ["minecraft_narration_post"] })[0];
    assert.equal(postLog?.content, "i just ate shit and died in the cave lmao");
  });
});

test("maybePostMinecraftNarration honors model skip and starts a per-channel min-gap cooldown", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    let llmCallCount = 0;

    store.patchSettings({
      permissions: {
        replies: {
          maxMessagesPerHour: 100
        }
      },
      agentStack: {
        runtimeConfig: {
          minecraft: {
            narration: {
              eagerness: 100,
              minSecondsBetweenPosts: 120
            }
          }
        }
      }
    });

    const runtime = buildRuntime({
      store,
      guildId,
      channelId,
      async llmGenerate() {
        llmCallCount += 1;
        return {
          text: JSON.stringify({
            skip: true,
            text: "[SKIP]",
            reason: "not worth posting to Discord"
          }),
          toolCalls: [],
          rawContent: null,
          provider: "test",
          model: "test-model",
          usage: {
            inputTokens: 0,
            outputTokens: 0
          },
          costUsd: 0.01
        };
      }
    });
    const state = createMinecraftNarrationState();

    const first = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "player_join", timestamp: "2026-04-04T12:00:00.000Z", summary: "player joined: Alice", playerName: "Alice" })],
      state
    });
    const second = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "player_leave", timestamp: "2026-04-04T12:00:05.000Z", summary: "player left: Alice", playerName: "Alice" })],
      state
    });

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(llmCallCount, 1);
    assert.equal(store.getRecentActions(10, { kinds: ["minecraft_narration_skip"] }).length, 1);
    assert.equal(
      store.getRecentActions(10, { kinds: ["minecraft_narration_blocked"] }).some((entry) => entry.content === "min_gap_active"),
      true
    );
  });
});

test("maybePostMinecraftNarration surfaces in-game chat history into the narration prompt", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const llmCalls: Array<Record<string, unknown>> = [];

    store.patchSettings({
      permissions: {
        replies: {
          maxMessagesPerHour: 100
        }
      },
      agentStack: {
        runtimeConfig: {
          minecraft: {
            narration: {
              eagerness: 100,
              minSecondsBetweenPosts: 0
            }
          }
        }
      }
    });

    const runtime = buildRuntime({
      store,
      guildId,
      channelId,
      async llmGenerate(payload) {
        llmCalls.push(payload);
        return {
          text: JSON.stringify({
            skip: true,
            text: "[SKIP]",
            reason: "chat already handled it"
          }),
          toolCalls: [],
          rawContent: null,
          provider: "test",
          model: "test-model",
          usage: {
            inputTokens: 0,
            outputTokens: 0
          },
          costUsd: 0.01
        };
      }
    });

    const posted = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "player_join", timestamp: "2026-04-04T12:00:00.000Z", summary: "player joined: Alice", playerName: "Alice" })],
      chatHistory: [
        {
          sender: "Alice",
          text: "yo clanky where u at",
          timestamp: "2026-04-04T11:59:55.000Z",
          isBot: false
        },
        {
          sender: "Clanky",
          text: "coming down the hill now",
          timestamp: "2026-04-04T11:59:58.000Z",
          isBot: true
        }
      ],
      state: createMinecraftNarrationState()
    });

    assert.equal(posted, false);
    assert.equal(llmCalls.length, 1);
    const userPrompt = String(llmCalls[0]?.userPrompt || "");
    assert.match(userPrompt, /=== RECENT IN-GAME CHAT ===/);
    assert.match(userPrompt, /<Alice> yo clanky where u at/);
    assert.match(userPrompt, /coming down the hill now/);
  });
});

test("maybePostMinecraftNarration dedups progression milestones per session (first diamond fires, second is filtered)", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    let llmCallCount = 0;

    store.patchSettings({
      permissions: {
        replies: {
          maxMessagesPerHour: 100
        }
      },
      agentStack: {
        runtimeConfig: {
          minecraft: {
            narration: {
              eagerness: 100,
              minSecondsBetweenPosts: 0
            }
          }
        }
      }
    });

    const runtime = buildRuntime({
      store,
      guildId,
      channelId,
      async llmGenerate() {
        llmCallCount += 1;
        return {
          text: JSON.stringify({
            skip: true,
            text: "[SKIP]",
            reason: "not worth posting"
          }),
          toolCalls: [],
          rawContent: null,
          provider: "test",
          model: "test-model",
          usage: {
            inputTokens: 0,
            outputTokens: 0
          },
          costUsd: 0.01
        };
      }
    });
    const state = createMinecraftNarrationState();

    const first = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "item_pickup", timestamp: "2026-04-04T12:00:00.000Z", summary: "collected 1 block(s) of diamond_ore", itemName: "diamond_ore", count: 1 })],
      state
    });
    const second = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [mcEvent({ type: "item_pickup", timestamp: "2026-04-04T12:01:00.000Z", summary: "collected 1 block(s) of diamond_ore", itemName: "diamond_ore", count: 1 })],
      state
    });

    // First call: milestone passes filter, LLM invoked (and returns [SKIP]).
    // Milestone is consumed even on skip — this is the "once per session"
    // progression semantic. Second identical event must be filtered OUT
    // categorically, with zero additional LLM calls.
    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(llmCallCount, 1);
    const filteredEntries = store
      .getRecentActions(10, { kinds: ["minecraft_narration_filtered"] })
      .filter((entry) => entry.content === "no_significant_events");
    assert.equal(filteredEntries.length, 1);
  });
});

test("maybePostMinecraftNarration filters routine Minecraft events before invoking the LLM", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    let llmCallCount = 0;

    store.patchSettings({
      agentStack: {
        runtimeConfig: {
          minecraft: {
            narration: {
              eagerness: 100,
              minSecondsBetweenPosts: 0
            }
          }
        }
      }
    });

    const runtime = buildRuntime({
      store,
      guildId,
      channelId,
      async llmGenerate() {
        llmCallCount += 1;
        return {
          text: "",
          toolCalls: [],
          rawContent: null,
          provider: "test",
          model: "test-model",
          usage: {
            inputTokens: 0,
            outputTokens: 0
          }
        };
      }
    });

    const posted = await maybePostMinecraftNarration(runtime, {
      guildId,
      channelId,
      ownerUserId: "user-1",
      scopeKey: "guild-1:channel-1",
      source: "reply_session",
      serverLabel: "Survival SMP",
      events: [
        mcEvent({ type: "navigation", timestamp: "2026-04-04T12:00:00.000Z", summary: "pathfinding to 10,64,10 (range=1)", x: 10, y: 64, z: 10, range: 1 }),
        mcEvent({ type: "chat", timestamp: "2026-04-04T12:00:01.000Z", summary: "sent chat: ok heading over", sender: "ClankyBuddy", message: "ok heading over", isBot: true })
      ],
      state: createMinecraftNarrationState()
    });

    assert.equal(posted, false);
    assert.equal(llmCallCount, 0);
    assert.equal(
      store.getRecentActions(10, { kinds: ["minecraft_narration_filtered"] }).some((entry) => entry.content === "no_significant_events"),
      true
    );
  });
});
