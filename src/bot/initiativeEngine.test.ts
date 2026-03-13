import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "../store/store.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { createTestSettingsPatch } from "../testSettings.ts";
import { getEligibleInitiativeChannelIds, maybeRunInitiativeCycle } from "./initiativeEngine.ts";

async function withTempStore(run: (store: Store) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-initiative-test-"));
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

test("getEligibleInitiativeChannelIds uses the canonical unified reply-channel pool", () => {
  const rawSettings: unknown = {
    permissions: {
      replies: {
        replyChannelIds: ["reply-1"]
      }
    }
  };

  const settings = normalizeSettings(rawSettings);

  assert.deepEqual(getEligibleInitiativeChannelIds(settings), ["reply-1"]);
});

test("maybeRunInitiativeCycle starts the min-gap cooldown after an initiative skip", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const botUserId = "bot-1";
    const llmCalls: Array<Record<string, unknown>> = [];
    const pendingThoughts = new Map();

    store.patchSettings(createTestSettingsPatch({
      permissions: {
        replies: {
          allowReplies: true,
          allowUnsolicitedReplies: true,
          allowReactions: false,
          replyChannelIds: [channelId],
          allowedChannelIds: [channelId],
          blockedChannelIds: [],
          blockedUserIds: [],
          maxMessagesPerHour: 100,
          maxReactionsPerHour: 0
        }
      },
      memory: {
        enabled: false
      },
      initiative: {
        text: {
          enabled: true,
          eagerness: 100,
          minMinutesBetweenPosts: 60,
          maxPostsPerDay: 3,
          lookbackMessages: 12,
          allowActiveCuriosity: false,
          maxToolSteps: 0,
          maxToolCalls: 0
        }
      }
    }));

    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 1_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "anyone have a strong take on proton mail",
      referencedMessageId: null
    });

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild: {
        id: guildId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send() {
        throw new Error("initiative skip should not send a message");
      }
    };

    const runtime = {
      appConfig: { env: "test" },
      store,
      llm: {
        async generate(payload: Record<string, unknown>) {
          llmCalls.push(payload);
          return {
            text: JSON.stringify({
              skip: true,
              reason: "too quiet to jump in naturally"
            }),
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
      },
      memory: {},
      client: {
        user: {
          id: botUserId,
          username: "clanky"
        },
        guilds: {
          cache: new Map()
        },
        channels: {
          cache: {
            get(id: string) {
              return id === channelId ? channel : undefined;
            }
          }
        }
      },
      botUserId,
      discovery: null,
      search: null,
      initiativeCycleRunning: false,
      getPendingInitiativeThoughts() {
        return pendingThoughts;
      },
      getPendingInitiativeThought(guildId: string) {
        return pendingThoughts.get(guildId) || null;
      },
      setPendingInitiativeThought(guildId: string, thought: unknown) {
        if (!thought) {
          pendingThoughts.delete(guildId);
          return;
        }
        pendingThoughts.set(guildId, thought);
      },
      canSendMessage() {
        return true;
      },
      canTalkNow() {
        return true;
      },
      async hydrateRecentMessages() {
        return [];
      },
      isChannelAllowed() {
        return true;
      },
      isNonPrivateReplyEligibleChannel() {
        return true;
      },
      getSimulatedTypingDelayMs() {
        return 0;
      },
      markSpoke() {},
      composeMessageContentForHistory() {
        return "";
      },
      async loadRelevantMemoryFacts() {
        return [];
      },
      buildMediaMemoryFacts() {
        return [];
      },
      getImageBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getVideoGenerationBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getGifBudgetState() {
        return { canFetch: false, remaining: 0 };
      },
      getMediaGenerationCapabilities() {
        return {
          simpleImageReady: false,
          complexImageReady: false,
          videoReady: false
        };
      },
      async resolveMediaAttachment() {
        throw new Error("initiative skip should not resolve media");
      },
      buildBrowserBrowseContext() {
        return {
          enabled: false,
          configured: false,
          budget: {
            canBrowse: false
          }
        };
      },
      async runModelRequestedBrowserBrowse() {
        return {
          used: false,
          text: "",
          steps: 0,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        };
      }
    } as Parameters<typeof maybeRunInitiativeCycle>[0];

    await maybeRunInitiativeCycle(runtime);
    assert.equal(llmCalls.length, 1);

    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(store.countActionsSince("initiative_skip", since), 1);

    await maybeRunInitiativeCycle(runtime);
    assert.equal(llmCalls.length, 1);
    assert.equal(store.countActionsSince("initiative_skip", since), 1);
  });
});

test("maybeRunInitiativeCycle revisits a pending thought even during fresh-thought cooldown", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const botUserId = "bot-1";
    const pendingThoughts = new Map();
    let sendCount = 0;
    let llmCalls = 0;

    store.patchSettings(createTestSettingsPatch({
      permissions: {
        replies: {
          allowReplies: true,
          allowUnsolicitedReplies: true,
          allowReactions: false,
          replyChannelIds: [channelId],
          allowedChannelIds: [channelId],
          blockedChannelIds: [],
          blockedUserIds: [],
          maxMessagesPerHour: 100,
          maxReactionsPerHour: 0
        }
      },
      memory: {
        enabled: false
      },
      initiative: {
        text: {
          enabled: true,
          eagerness: 100,
          minMinutesBetweenPosts: 60,
          maxPostsPerDay: 3,
          lookbackMessages: 12,
          allowActiveCuriosity: false,
          maxToolSteps: 0,
          maxToolCalls: 0
        }
      }
    }));

    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 1_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "proton mail is interesting again",
      referencedMessageId: null
    });
    store.logAction({
      kind: "initiative_skip",
      guildId,
      channelId,
      userId: botUserId,
      content: "fresh_thought_skip"
    });

    pendingThoughts.set(guildId, {
      id: "thought-1",
      guildId,
      channelId,
      channelName: "general",
      trigger: "timer",
      draftText: "maybe proton mail is worth revisiting",
      currentText: "maybe proton mail is worth revisiting",
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
      basisAt: Date.now() - 120_000,
      notBeforeAt: 0,
      expiresAt: Date.now() + 120_000,
      revision: 1,
      status: "queued",
      lastDecisionReason: "felt half-baked",
      lastDecisionAction: "hold",
      mediaDirective: "none",
      mediaPrompt: null
    });

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild: {
        id: guildId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send(payload: { content: string }) {
        sendCount += 1;
        return {
          id: `sent-${sendCount}`,
          createdTimestamp: Date.now(),
          guildId,
          channelId,
          content: payload.content
        };
      }
    };

    const runtime = {
      appConfig: { env: "test" },
      store,
      llm: {
        async generate() {
          llmCalls += 1;
          return {
            text: JSON.stringify({
              action: "post_now",
              channelId,
              text: "actually proton mail discourse is back in style",
              mediaDirective: "none",
              mediaPrompt: null,
              reason: "ready_now"
            }),
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
      },
      memory: {},
      client: {
        user: {
          id: botUserId,
          username: "clanky"
        },
        guilds: {
          cache: new Map()
        },
        channels: {
          cache: {
            get(id: string) {
              return id === channelId ? channel : undefined;
            }
          }
        }
      },
      botUserId,
      discovery: null,
      search: null,
      initiativeCycleRunning: false,
      getPendingInitiativeThoughts() {
        return pendingThoughts;
      },
      getPendingInitiativeThought(guildId: string) {
        return pendingThoughts.get(guildId) || null;
      },
      setPendingInitiativeThought(guildId: string, thought: unknown) {
        if (!thought) {
          pendingThoughts.delete(guildId);
          return;
        }
        pendingThoughts.set(guildId, thought);
      },
      canSendMessage() {
        return true;
      },
      canTalkNow() {
        return true;
      },
      async hydrateRecentMessages() {
        return [];
      },
      isChannelAllowed() {
        return true;
      },
      isNonPrivateReplyEligibleChannel() {
        return true;
      },
      getSimulatedTypingDelayMs() {
        return 0;
      },
      markSpoke() {},
      composeMessageContentForHistory() {
        return "";
      },
      async loadRelevantMemoryFacts() {
        return [];
      },
      buildMediaMemoryFacts() {
        return [];
      },
      getImageBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getVideoGenerationBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getGifBudgetState() {
        return { canFetch: false, remaining: 0 };
      },
      getMediaGenerationCapabilities() {
        return {
          simpleImageReady: false,
          complexImageReady: false,
          videoReady: false
        };
      },
      async resolveMediaAttachment(payload: { text: string }) {
        return {
          payload: {
            content: payload.text
          },
          media: null
        };
      },
      buildBrowserBrowseContext() {
        return {
          enabled: false,
          configured: false,
          budget: {
            canBrowse: false
          }
        };
      },
      async runModelRequestedBrowserBrowse() {
        return {
          used: false,
          text: "",
          steps: 0,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        };
      }
    } as Parameters<typeof maybeRunInitiativeCycle>[0];

    await maybeRunInitiativeCycle(runtime);

    assert.equal(llmCalls, 1);
    assert.equal(sendCount, 1);
    assert.equal(pendingThoughts.size, 0);
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(store.countActionsSince("initiative_post", since), 1);
  });
});

test("maybeRunInitiativeCycle can post a fresh thought in another guild while a pending thought exists elsewhere", async () => {
  await withTempStore(async (store) => {
    const guildOneId = "guild-1";
    const guildTwoId = "guild-2";
    const channelOneId = "channel-1";
    const channelTwoId = "channel-2";
    const botUserId = "bot-1";
    const pendingThoughts = new Map();
    const sentChannelIds: string[] = [];

    store.patchSettings(createTestSettingsPatch({
      permissions: {
        replies: {
          allowReplies: true,
          allowUnsolicitedReplies: true,
          allowReactions: false,
          replyChannelIds: [channelOneId, channelTwoId],
          allowedChannelIds: [channelOneId, channelTwoId],
          blockedChannelIds: [],
          blockedUserIds: [],
          maxMessagesPerHour: 100,
          maxReactionsPerHour: 0
        }
      },
      memory: {
        enabled: false
      },
      initiative: {
        text: {
          enabled: true,
          eagerness: 100,
          minMinutesBetweenPosts: 60,
          maxPostsPerDay: 3,
          lookbackMessages: 12,
          allowActiveCuriosity: false,
          maxToolSteps: 0,
          maxToolCalls: 0
        }
      }
    }));

    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 2_000,
      guildId: guildOneId,
      channelId: channelOneId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "still chewing on the earlier topic",
      referencedMessageId: null
    });
    store.recordMessage({
      messageId: "msg-2",
      createdAt: Date.now() - 1_000,
      guildId: guildTwoId,
      channelId: channelTwoId,
      authorId: "user-2",
      authorName: "bob",
      isBot: false,
      content: "yo does anyone have a weird fact",
      referencedMessageId: null
    });

    pendingThoughts.set(guildOneId, {
      id: "thought-1",
      guildId: guildOneId,
      channelId: channelOneId,
      channelName: "general-one",
      trigger: "timer",
      draftText: "maybe bring back the earlier topic",
      currentText: "maybe bring back the earlier topic",
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      basisAt: Date.now() - 60_000,
      notBeforeAt: 0,
      expiresAt: Date.now() + 60_000,
      revision: 1,
      status: "queued",
      lastDecisionReason: "timing felt off",
      lastDecisionAction: "hold",
      mediaDirective: "none",
      mediaPrompt: null
    });

    const channelOne = {
      id: channelOneId,
      guildId: guildOneId,
      name: "general-one",
      guild: {
        id: guildOneId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send(payload: { content: string }) {
        sentChannelIds.push(`${channelOneId}:${payload.content}`);
        return {
          id: "sent-1",
          createdTimestamp: Date.now(),
          guildId: guildOneId,
          channelId: channelOneId,
          content: payload.content
        };
      }
    };
    const channelTwo = {
      id: channelTwoId,
      guildId: guildTwoId,
      name: "general-two",
      guild: {
        id: guildTwoId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send(payload: { content: string }) {
        sentChannelIds.push(`${channelTwoId}:${payload.content}`);
        return {
          id: "sent-2",
          createdTimestamp: Date.now(),
          guildId: guildTwoId,
          channelId: channelTwoId,
          content: payload.content
        };
      }
    };

    const runtime = {
      appConfig: { env: "test" },
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              action: "post_now",
              channelId: channelTwoId,
              text: "weird fact drop: wombats have cube poop",
              mediaDirective: "none",
              mediaPrompt: null,
              reason: "fresh_room"
            }),
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
      },
      memory: {},
      client: {
        user: {
          id: botUserId,
          username: "clanky"
        },
        guilds: {
          cache: new Map()
        },
        channels: {
          cache: {
            get(id: string) {
              if (id === channelOneId) return channelOne;
              if (id === channelTwoId) return channelTwo;
              return undefined;
            }
          }
        }
      },
      botUserId,
      discovery: null,
      search: null,
      initiativeCycleRunning: false,
      getPendingInitiativeThoughts() {
        return pendingThoughts;
      },
      getPendingInitiativeThought(guildId: string) {
        return pendingThoughts.get(guildId) || null;
      },
      setPendingInitiativeThought(guildId: string, thought: unknown) {
        if (!thought) {
          pendingThoughts.delete(guildId);
          return;
        }
        pendingThoughts.set(guildId, thought);
      },
      canSendMessage() {
        return true;
      },
      canTalkNow() {
        return true;
      },
      async hydrateRecentMessages() {
        return [];
      },
      isChannelAllowed() {
        return true;
      },
      isNonPrivateReplyEligibleChannel() {
        return true;
      },
      getSimulatedTypingDelayMs() {
        return 0;
      },
      markSpoke() {},
      composeMessageContentForHistory() {
        return "";
      },
      async loadRelevantMemoryFacts() {
        return [];
      },
      buildMediaMemoryFacts() {
        return [];
      },
      getImageBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getVideoGenerationBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getGifBudgetState() {
        return { canFetch: false, remaining: 0 };
      },
      getMediaGenerationCapabilities() {
        return {
          simpleImageReady: false,
          complexImageReady: false,
          videoReady: false
        };
      },
      async resolveMediaAttachment(payload: { text: string }) {
        return {
          payload: {
            content: payload.text
          },
          media: null
        };
      },
      buildBrowserBrowseContext() {
        return {
          enabled: false,
          configured: false,
          budget: {
            canBrowse: false
          }
        };
      },
      async runModelRequestedBrowserBrowse() {
        return {
          used: false,
          text: "",
          steps: 0,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        };
      }
    } as Parameters<typeof maybeRunInitiativeCycle>[0];

    await maybeRunInitiativeCycle(runtime);

    assert.deepEqual(sentChannelIds, [`${channelTwoId}:weird fact drop: wombats have cube poop`]);
    assert.equal(pendingThoughts.has(guildOneId), true);
    assert.equal(pendingThoughts.has(guildTwoId), false);
  });
});

test("maybeRunInitiativeCycle preserves a pending thought on structured contract violations", async () => {
  await withTempStore(async (store) => {
    const guildId = "guild-1";
    const channelId = "channel-1";
    const botUserId = "bot-1";
    const pendingThoughts = new Map();

    store.patchSettings(createTestSettingsPatch({
      permissions: {
        replies: {
          allowReplies: true,
          allowUnsolicitedReplies: true,
          allowReactions: false,
          replyChannelIds: [channelId],
          allowedChannelIds: [channelId],
          blockedChannelIds: [],
          blockedUserIds: [],
          maxMessagesPerHour: 100,
          maxReactionsPerHour: 0
        }
      },
      memory: {
        enabled: false
      },
      initiative: {
        text: {
          enabled: true,
          eagerness: 100,
          minMinutesBetweenPosts: 60,
          maxPostsPerDay: 3,
          lookbackMessages: 12,
          allowActiveCuriosity: false,
          maxToolSteps: 0,
          maxToolCalls: 0
        }
      }
    }));

    store.recordMessage({
      messageId: "msg-1",
      createdAt: Date.now() - 1_000,
      guildId,
      channelId,
      authorId: "user-1",
      authorName: "alice",
      isBot: false,
      content: "maybe bring that bit back later",
      referencedMessageId: null
    });

    pendingThoughts.set(guildId, {
      id: "thought-1",
      guildId,
      channelId,
      channelName: "general",
      trigger: "timer",
      draftText: "the bit might work later",
      currentText: "the bit might work later",
      createdAt: Date.now() - 30_000,
      updatedAt: Date.now() - 30_000,
      basisAt: Date.now() - 30_000,
      notBeforeAt: 0,
      expiresAt: Date.now() + 60_000,
      revision: 1,
      status: "queued",
      lastDecisionReason: "timing felt off",
      lastDecisionAction: "hold",
      mediaDirective: "none",
      mediaPrompt: null
    });

    const channel = {
      id: channelId,
      guildId,
      name: "general",
      guild: {
        id: guildId
      },
      isTextBased() {
        return true;
      },
      async sendTyping() {
        return true;
      },
      async send() {
        throw new Error("contract-violation revisit should not send a message");
      }
    };

    const runtime = {
      appConfig: { env: "test" },
      store,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({
              action: "hold",
              channelId,
              reason: "later"
            }),
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
      },
      memory: {},
      client: {
        user: {
          id: botUserId,
          username: "clanky"
        },
        guilds: {
          cache: new Map()
        },
        channels: {
          cache: {
            get(id: string) {
              return id === channelId ? channel : undefined;
            }
          }
        }
      },
      botUserId,
      discovery: null,
      search: null,
      initiativeCycleRunning: false,
      getPendingInitiativeThoughts() {
        return pendingThoughts;
      },
      getPendingInitiativeThought(guildId: string) {
        return pendingThoughts.get(guildId) || null;
      },
      setPendingInitiativeThought(guildId: string, thought: unknown) {
        if (!thought) {
          pendingThoughts.delete(guildId);
          return;
        }
        pendingThoughts.set(guildId, thought);
      },
      canSendMessage() {
        return true;
      },
      canTalkNow() {
        return true;
      },
      async hydrateRecentMessages() {
        return [];
      },
      isChannelAllowed() {
        return true;
      },
      isNonPrivateReplyEligibleChannel() {
        return true;
      },
      getSimulatedTypingDelayMs() {
        return 0;
      },
      markSpoke() {},
      composeMessageContentForHistory() {
        return "";
      },
      async loadRelevantMemoryFacts() {
        return [];
      },
      buildMediaMemoryFacts() {
        return [];
      },
      getImageBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getVideoGenerationBudgetState() {
        return { canGenerate: false, remaining: 0 };
      },
      getGifBudgetState() {
        return { canFetch: false, remaining: 0 };
      },
      getMediaGenerationCapabilities() {
        return {
          simpleImageReady: false,
          complexImageReady: false,
          videoReady: false
        };
      },
      async resolveMediaAttachment() {
        throw new Error("contract-violation revisit should not resolve media");
      },
      buildBrowserBrowseContext() {
        return {
          enabled: false,
          configured: false,
          budget: {
            canBrowse: false
          }
        };
      },
      async runModelRequestedBrowserBrowse() {
        return {
          used: false,
          text: "",
          steps: 0,
          hitStepLimit: false,
          error: null,
          blockedByBudget: false
        };
      }
    } as Parameters<typeof maybeRunInitiativeCycle>[0];

    await maybeRunInitiativeCycle(runtime);

    assert.equal(pendingThoughts.size, 1);
    assert.equal(pendingThoughts.get(guildId)?.id, "thought-1");
    assert.equal(pendingThoughts.get(guildId)?.revision, 1);
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.equal(store.countActionsSince("initiative_skip", since), 1);
  });
});
