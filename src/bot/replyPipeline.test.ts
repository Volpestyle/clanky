import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClankerBot } from "../bot.ts";
import { rmTempDir } from "../testHelpers.ts";
import { buildReplyPipelineRuntime } from "./botRuntimeFactories.ts";
import { maybeReplyToMessagePipeline } from "./replyPipeline.ts";
import type { ActiveReply } from "../tools/activeReplyRegistry.ts";
import { ActiveReplyRegistry, buildTextReplyScopeKey } from "../tools/activeReplyRegistry.ts";
import { createAbortError } from "../tools/abortError.ts";
import { Store } from "../store/store.ts";
import { createTestSettingsPatch } from "../testSettings.ts";
import type { SubAgentSession } from "../agents/subAgentSession.ts";

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
    await rmTempDir(dir);
  }
}

function applyBaselineSettings(store: Store, channelId: string) {
  store.patchSettings(createTestSettingsPatch({
    identity: {
      botName: "clanky"
    },
    interaction: {
      activity: {
        ambientReplyEagerness: 65,
        reactivity: 0,
        minSecondsBetweenMessages: 0,
        replyCoalesceWindowSeconds: 0,
        replyCoalesceMaxMessages: 1
      }
    },
    permissions: {
      replies: {
        allowReplies: true,
        allowUnsolicitedReplies: true,
        allowReactions: false,
        replyChannelIds: [],
        allowedChannelIds: [channelId],
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
      },
      vision: {
        enabled: false
      }
    },
    initiative: {
      discovery: {
        allowReplyImages: false,
        allowReplyVideos: false,
        allowReplyGifs: false,
        sources: {
          reddit: false,
          hackerNews: false,
          youtube: false,
          rss: false,
          x: false
        }
      }
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
      username: "clanky",
      tag: "clanky#0001"
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
    assert.equal(typingCallsRef.count, 1);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(replyPayloads.length, 0);
  });
});

test("maybeReplyToMessagePipeline recovers unstructured model output as prose reply", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          return {
            text: "I need to consider the context here before I answer.",
            toolCalls: [],
            rawContent: null,
            provider: "claude-oauth",
            model: "claude-opus-4-6",
            usage: {
              inputTokens: 10,
              outputTokens: 8,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            },
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
      content: "play daft punk",
      replyPayloads
    });
    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });

    const handled = await maybeReplyToMessagePipeline(runtime, message, settings, {
      source: "text_thought_loop",
      forceDecisionLoop: true,
      recentMessages: [],
      triggerMessageIds: [message.id],
      addressSignal: {
        direct: false,
        inferred: false,
        triggered: false,
        reason: "llm_decides",
        confidence: 0,
        threshold: 0.62,
        confidenceSource: "fallback"
      }
    });

    assert.equal(handled, true);
    assert.equal(typingCallsRef.count, 1);
    const sentPayload = channelSendPayloads[0] || replyPayloads[0];
    assert.ok(sentPayload, "expected a sent message (via channel.send or message.reply)");
    assert.equal(
      sentPayload?.content,
      "I need to consider the context here before I answer."
    );

    const warning = store.getRecentActions(10).find((entry) => entry.kind === "bot_warning");
    assert.equal(warning?.content, "structured_output_recovered_as_prose");
  });
});

test("maybeReplyToMessagePipeline skips tool narration prose after a tool loop", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    store.recordMessage({
      messageId: "history-1",
      createdAt: Date.now() - 5_000,
      guildId: "guild-1",
      channelId,
      authorId: "user-2",
      authorName: "bob",
      isBot: false,
      content: "CURSED conk said hello earlier",
      referencedMessageId: null
    });

    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };
    let generateCount = 0;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate() {
          generateCount += 1;
          if (generateCount === 1) {
            return {
              text: "",
              rawContent: null,
              toolCalls: [
                {
                  id: "tool-1",
                  name: "conversation_search",
                  input: {
                    query: "what did cursed say"
                  }
                }
              ],
              provider: "claude-oauth",
              model: "claude-opus-4-6",
              usage: {
                inputTokens: 10,
                outputTokens: 8,
                cacheWriteTokens: 0,
                cacheReadTokens: 0
              },
              costUsd: 0
            };
          }

          return {
            text: "I searched the conversation history and found that cursed conk said hello earlier today.",
            rawContent: null,
            toolCalls: [],
            provider: "claude-oauth",
            model: "claude-opus-4-6",
            usage: {
              inputTokens: 10,
              outputTokens: 8,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            },
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
      content: "what did cursed say",
      replyPayloads
    });
    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });

    const handled = await maybeReplyToMessagePipeline(runtime, message, settings, {
      source: "text_thought_loop",
      forceDecisionLoop: true,
      recentMessages: [],
      triggerMessageIds: [message.id],
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct",
        confidence: 1,
        threshold: 0.62,
        confidenceSource: "direct"
      }
    });

    assert.equal(handled, false);
    assert.equal(replyPayloads.length, 0);
    assert.equal(channelSendPayloads.length, 0);
    assert.equal(
      store.getRecentActions(20).some((entry) => entry.kind === "reply_skipped" && entry.content === "invalid_structured_output_after_tool_loop"),
      true
    );
  });
});

test("maybeReplyToMessagePipeline lets the model attach tool-returned images in the final reply", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls: Array<{
      userPrompt: string;
      imageInputs?: unknown;
      contextMessages?: unknown;
    }> = [];
    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };
    let generateCount = 0;

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push({
            userPrompt: String(payload.userPrompt || ""),
            imageInputs: payload.imageInputs,
            contextMessages: payload.contextMessages
          });
          generateCount += 1;

          if (generateCount === 1) {
            return {
              text: "let me check",
              toolCalls: [
                {
                  id: "tool-1",
                  name: "browser_browse",
                  input: {
                    query: "show me the stream"
                  }
                }
              ],
              rawContent: null,
              provider: "claude-oauth",
              model: "claude-opus-4-6",
              usage: {
                inputTokens: 12,
                outputTokens: 10,
                cacheWriteTokens: 0,
                cacheReadTokens: 0
              },
              costUsd: 0
            };
          }

          return {
            text: JSON.stringify({
              text: "yep here it is",
              skip: false,
              reactionEmoji: null,
              media: { type: "tool_images", prompt: null },
              automationAction: {
                operation: "none",
                title: null,
                instruction: null,
                schedule: null,
                targetQuery: null,
                automationId: null,
                runImmediately: false,
                targetChannelId: null
              },
              screenWatchIntent: {
                action: "none",
                confidence: 0,
                reason: null
              },
            }),
            toolCalls: [],
            rawContent: null,
            provider: "claude-oauth",
            model: "claude-opus-4-6",
            usage: {
              inputTokens: 14,
              outputTokens: 18,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            },
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
      content: "can you show me the screenshot?",
      replyPayloads
    });
    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });
    runtime.buildBrowserBrowseContext = () => ({
      requested: false,
      configured: true,
      enabled: true,
      used: false,
      blockedByBudget: false,
      error: null,
      query: "",
      text: "",
      imageInputs: [],
      steps: 0,
      hitStepLimit: false,
      budget: {
        maxPerHour: 10,
        used: 0,
        remaining: 10,
        canBrowse: true
      }
    });
    runtime.runModelRequestedBrowserBrowse = async () => ({
      used: true,
      text: "Browser screenshot captured.",
      imageInputs: [
        {
          mediaType: "image/png",
          dataBase64: Buffer.from("browser-shot").toString("base64")
        }
      ],
      steps: 1,
      hitStepLimit: false,
      error: null,
      blockedByBudget: false
    });

    const handled = await maybeReplyToMessagePipeline(runtime, message, settings, {
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

    assert.equal(handled, true);
    assert.equal(typingCallsRef.count, 1);
    const sentPayload = replyPayloads[0] || channelSendPayloads[0];
    assert.ok(sentPayload, "expected a sent reply payload");
    assert.equal(sentPayload.content, "yep here it is");
    assert.equal(Array.isArray(sentPayload.files), true);
    assert.equal(sentPayload.files?.length, 1);
    assert.equal(sentPayload.files?.[0]?.name, "clanky-tool-1.png");
    assert.match(llmCalls[1]?.userPrompt || "", /tool_images/);
  });
});

test("maybeReplyToMessagePipeline includes current message video attachments with VID refs in the prompt", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-1";
    applyBaselineSettings(store, channelId);

    const llmCalls: Array<{ userPrompt: string }> = [];
    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push({ userPrompt: String(payload.userPrompt || "") });
          return {
            text: JSON.stringify({
              text: "I can check that clip if needed.",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: {
                operation: "none",
                title: null,
                instruction: null,
                schedule: null,
                targetQuery: null,
                automationId: null,
                runImmediately: false,
                targetChannelId: null
              },
              screenWatchIntent: {
                action: "none",
                confidence: 0,
                reason: null
              }
            }),
            toolCalls: [],
            rawContent: null,
            provider: "claude-oauth",
            model: "claude-opus-4-6",
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            },
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
    const channel = buildChannel({
      guild,
      channelId,
      channelSendPayloads,
      typingCallsRef
    });
    const message = buildIncomingMessage({
      guild,
      channel,
      messageId: "msg-video-1",
      content: "can you break down this clip?",
      replyPayloads
    }) as Record<string, unknown>;
    message.attachments = new Map([
      [
        "video-1",
        {
          url: "https://cdn.discordapp.com/attachments/1/2/demo.mp4",
          proxyURL: "https://media.discordapp.net/attachments/1/2/demo.mp4",
          name: "demo.mp4",
          contentType: "video/mp4"
        }
      ]
    ]);

    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });

    const handled = await maybeReplyToMessagePipeline(runtime, message as never, settings, {
      source: "message_event",
      forceDecisionLoop: true,
      forceRespond: true,
      recentMessages: [],
      triggerMessageIds: [String(message.id || "")],
      addressSignal: {
        direct: true,
        inferred: false,
        triggered: true,
        reason: "direct_address"
      }
    });

    assert.equal(handled, true);
    assert.equal(typingCallsRef.count, 1);
    const sentPayload = replyPayloads[0] || channelSendPayloads[0];
    assert.ok(sentPayload, "expected a sent reply payload");
    assert.equal(sentPayload.content, "I can check that clip if needed.");
    assert.match(llmCalls[0]?.userPrompt || "", /Current message video attachments:/);
    assert.match(llmCalls[0]?.userPrompt || "", /VID 1: demo\.mp4 \(video\/mp4\)/);
    assert.match(
      llmCalls[0]?.userPrompt || "",
      /https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/demo\.mp4/
    );
  });
});

test("maybeReplyToMessagePipeline includes Minecraft docs, tool exposure, and active session hint", async () => {
  await withTempStore(async (store) => {
    const channelId = "chan-mc-1";
    applyBaselineSettings(store, channelId);
    store.patchSettings({
      agentStack: {
        runtimeConfig: {
          minecraft: {
            enabled: true
          }
        }
      }
    });

    const llmCalls: Array<{
      systemPrompt: string;
      userPrompt: string;
      tools: Array<{ name?: string }>;
    }> = [];
    const replyPayloads: Array<Record<string, unknown>> = [];
    const channelSendPayloads: Array<Record<string, unknown>> = [];
    const typingCallsRef = { count: 0 };

    const bot = new ClankerBot({
      appConfig: {},
      store,
      llm: {
        async generate(payload) {
          llmCalls.push({
            systemPrompt: String(payload.systemPrompt || ""),
            userPrompt: String(payload.userPrompt || ""),
            tools: Array.isArray(payload.tools) ? payload.tools as Array<{ name?: string }> : []
          });
          return {
            text: JSON.stringify({
              text: "Minecraft noted.",
              skip: false,
              reactionEmoji: null,
              media: null,
              automationAction: {
                operation: "none",
                title: null,
                instruction: null,
                schedule: null,
                targetQuery: null,
                automationId: null,
                runImmediately: false,
                targetChannelId: null
              },
              screenWatchIntent: {
                action: "none",
                confidence: 0,
                reason: null
              }
            }),
            toolCalls: [],
            rawContent: null,
            provider: "claude-oauth",
            model: "claude-opus-4-6",
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cacheWriteTokens: 0,
              cacheReadTokens: 0
            },
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
    const minecraftSession: SubAgentSession & { getPromptStateHint(): string } = {
      id: "minecraft:guild-1:chan-mc-1:1:1",
      type: "minecraft",
      createdAt: Date.now(),
      ownerUserId: "user-1",
      lastUsedAt: Date.now(),
      status: "idle",
      getPromptStateHint() {
        return "[Minecraft] Active session - goal: \"Stay with Steve\" | mode: companion | server: Survival SMP | connected: yes | last action: Following Steve.";
      },
      async runTurn() {
        throw new Error("not used");
      },
      cancel() {},
      close() {}
    };
    bot.subAgentSessions.register(minecraftSession);

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
      messageId: "msg-mc-1",
      content: "what's going on in Minecraft?",
      replyPayloads
    });

    const settings = store.getSettings();
    const runtime = buildReplyPipelineRuntime(bot, {
      captionTimestamps: [],
      unsolicitedReplyContextWindow: 2
    });

    const handled = await maybeReplyToMessagePipeline(runtime, message, settings, {
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

    assert.equal(handled, true);
    assert.equal(typingCallsRef.count, 1);
    assert.match(llmCalls[0]?.systemPrompt || "", /=== MINECRAFT ===/);
    assert.match(llmCalls[0]?.systemPrompt || "", /hand over the user's intent or relevant context/i);
    assert.match(llmCalls[0]?.userPrompt || "", /\[Minecraft\] Active session - goal: "Stay with Steve"/);
    assert.equal(llmCalls[0]?.tools.some((tool) => tool?.name === "minecraft_task"), true);
  });
});
