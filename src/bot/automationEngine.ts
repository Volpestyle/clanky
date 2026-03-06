import { resolveFollowingNextRunAt } from "../automation.ts";
import {
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  normalizeSkipSentinel,
  parseStructuredReplyOutput,
  pickReplyMediaDirective,
  REPLY_OUTPUT_JSON_SCHEMA,
  resolveMaxMediaPromptLen,
  splitDiscordMessage
} from "../botHelpers.ts";
import { buildAutomationPrompt, buildSystemPrompt } from "../prompts.ts";
import { getMediaPromptCraftGuidance } from "../promptCore.ts";
import { buildReplyToolSet, executeReplyTool } from "../tools/replyTools.ts";
import type { ReplyToolContext, ReplyToolRuntime } from "../tools/replyTools.ts";
import { sanitizeBotText, sleep } from "../utils.ts";
import {
  getAutomationsSettings,
  getBotName,
  getDiscoverySettings,
  getMemorySettings,
  getReplyPermissions
} from "../settings/agentStack.ts";
import {
  buildContextContentBlocks,
  type ContentBlock,
  type ContextMessage
} from "../llm/serviceShared.ts";
import type { BotContext } from "./botContext.ts";

const MAX_AUTOMATION_RUNS_PER_TICK = 4;

type AutomationMemorySlice = {
  userFacts: Array<Record<string, unknown>>;
  relevantFacts: Array<Record<string, unknown>>;
  relevantMessages: Array<Record<string, unknown>>;
};

type AutomationChannelLike = {
  id: string;
  guildId?: string;
  name?: string;
  send?: (payload: unknown) => Promise<{
    id: string;
    createdTimestamp: number;
    guildId: string;
    channelId: string;
  }>;
  sendTyping?: () => Promise<unknown>;
};

type AutomationClientLike = BotContext["client"] & {
  user?: {
    id?: string;
  } | null;
  channels: {
    cache: {
      get: (id: string) => AutomationChannelLike | undefined;
    };
  };
};

type AutomationRowLike = {
  id?: number;
  guild_id?: string;
  channel_id?: string;
  title?: string;
  instruction?: string;
  created_by_user_id?: string;
  next_run_at?: string | null;
  schedule?: Record<string, unknown>;
};

type ImageBudgetLike = {
  canGenerate: boolean;
  remaining: number;
};

type VideoBudgetLike = {
  canGenerate: boolean;
  remaining: number;
};

type GifBudgetLike = {
  canFetch: boolean;
  remaining: number;
};

type MediaCapabilitiesLike = {
  simpleImageReady: boolean;
  complexImageReady: boolean;
  videoReady: boolean;
};

export type AutomationEngineRuntime = BotContext & {
  readonly client: AutomationClientLike;
  readonly search: ReplyToolRuntime["search"];
  automationCycleRunning: boolean;
  isChannelAllowed: (settings: Record<string, unknown>, channelId: string) => boolean;
  canSendMessage: (maxPerHour: number) => boolean;
  canTalkNow: (settings: Record<string, unknown>) => boolean;
  getSimulatedTypingDelayMs: (minMs: number, jitterMs: number) => number;
  markSpoke: () => void;
  composeMessageContentForHistory: (message: unknown, baseText?: string) => string;
  loadPromptMemorySlice: (payload: {
    settings: Record<string, unknown>;
    userId?: string | null;
    guildId?: string;
    channelId?: string;
    queryText?: string;
    trace?: Record<string, unknown>;
    source?: string;
  }) => Promise<AutomationMemorySlice>;
  buildMediaMemoryFacts: (payload: {
    userFacts: Array<Record<string, unknown>>;
    relevantFacts: Array<Record<string, unknown>>;
  }) => string[];
  buildMemoryLookupContext: (payload: {
    settings: Record<string, unknown>;
  }) => Record<string, unknown>;
  getImageBudgetState: (settings: Record<string, unknown>) => ImageBudgetLike;
  getVideoGenerationBudgetState: (settings: Record<string, unknown>) => VideoBudgetLike;
  getGifBudgetState: (settings: Record<string, unknown>) => GifBudgetLike;
  getMediaGenerationCapabilities: (settings: Record<string, unknown>) => MediaCapabilitiesLike;
  resolveMediaAttachment: (payload: {
    settings: Record<string, unknown>;
    text: string;
    directive: {
      type: string | null;
      gifQuery?: string | null;
      imagePrompt?: string | null;
      complexImagePrompt?: string | null;
      videoPrompt?: string | null;
    };
    trace: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      source?: string;
    };
  }) => Promise<{
    payload: {
      content: string;
      files?: unknown[];
    };
    media: unknown;
  }>;
};

function isSendableChannel(
  channel: AutomationChannelLike | null | undefined
): channel is AutomationChannelLike {
  return Boolean(channel) &&
    typeof channel.send === "function" &&
    typeof channel.sendTyping === "function";
}

export async function maybeRunAutomationCycle(runtime: AutomationEngineRuntime) {
  const settings = runtime.store.getSettings();
  if (!getAutomationsSettings(settings).enabled) return;
  if (runtime.automationCycleRunning) return;
  runtime.automationCycleRunning = true;

  try {
    const dueRows = runtime.store.claimDueAutomations({
      now: new Date().toISOString(),
      limit: MAX_AUTOMATION_RUNS_PER_TICK
    });
    if (!dueRows.length) return;

    for (const row of dueRows) {
      await runAutomationJob(runtime, row as AutomationRowLike);
    }
  } finally {
    runtime.automationCycleRunning = false;
  }
}

export async function runAutomationJob(
  runtime: AutomationEngineRuntime,
  automation: AutomationRowLike
) {
  const startedAt = new Date().toISOString();
  const guildId = String(automation?.guild_id || "").trim();
  const channelId = String(automation?.channel_id || "").trim();
  const automationId = Number(automation?.id || 0);
  if (!guildId || !channelId || !Number.isInteger(automationId) || automationId <= 0) return;

  const settings = runtime.store.getSettings();
  const permissions = getReplyPermissions(settings);
  const botName = getBotName(settings);
  let status = "active";
  let nextRunAt = null;
  let runStatus = "ok";
  let summary = "";
  let errorText = "";
  let sentMessageId = null;
  let retrySoon = false;

  try {
    if (!runtime.isChannelAllowed(settings, channelId)) {
      runStatus = "error";
      errorText = "channel blocked by current settings";
    } else if (!runtime.canSendMessage(permissions.maxMessagesPerHour)) {
      runStatus = "skipped";
      summary = "hourly message cap hit; retrying soon";
      retrySoon = true;
    } else if (!runtime.canTalkNow(settings)) {
      runStatus = "skipped";
      summary = "message cooldown active; retrying soon";
      retrySoon = true;
    } else {
      const channel = runtime.client.channels.cache.get(channelId);
      if (!isSendableChannel(channel)) {
        runStatus = "error";
        errorText = "channel unavailable";
      } else {
        const generationResult = await generateAutomationPayload(runtime, {
          automation,
          settings,
          channel
        });

        if (generationResult.skip) {
          runStatus = "skipped";
          summary = generationResult.summary || "model skipped this run";
        } else {
          await channel.sendTyping();
          await sleep(runtime.getSimulatedTypingDelayMs(350, 1100));
          const autoChunks = splitDiscordMessage(generationResult.payload.content);
          const autoFirstPayload = { ...generationResult.payload, content: autoChunks[0] };
          const sent = await channel.send(autoFirstPayload);
          for (let i = 1; i < autoChunks.length; i++) {
            await channel.send({ content: autoChunks[i] });
          }
          sentMessageId = sent.id;
          summary = generationResult.summary || "posted";
          runtime.markSpoke();
          runtime.store.recordMessage({
            messageId: sent.id,
            createdAt: sent.createdTimestamp,
            guildId: sent.guildId,
            channelId: sent.channelId,
            authorId: runtime.client.user?.id || "unknown",
            authorName: botName,
            isBot: true,
            content: runtime.composeMessageContentForHistory(sent, generationResult.text),
            referencedMessageId: null
          });
          runtime.store.logAction({
            kind: "automation_post",
            guildId: sent.guildId,
            channelId: sent.channelId,
            messageId: sent.id,
            userId: runtime.client.user?.id || null,
            content: generationResult.text,
            metadata: {
              automationId,
              media: generationResult.media || null,
              llm: generationResult.llm || null
            }
          });
        }
      }
    }
  } catch (error) {
    runStatus = "error";
    errorText = String(error instanceof Error ? error.message : error);
  }

  if (runStatus === "error") {
    status = "paused";
    nextRunAt = null;
  } else if (retrySoon) {
    nextRunAt = new Date(Date.now() + 5 * 60_000).toISOString();
  } else {
    nextRunAt = resolveFollowingNextRunAt({
      schedule: automation.schedule,
      previousNextRunAt: automation.next_run_at,
      runFinishedMs: Date.now()
    });
    if (!nextRunAt) {
      status = "paused";
    }
  }

  const finishedAt = new Date().toISOString();
  const finalized = runtime.store.finalizeAutomationRun({
    automationId,
    guildId,
    status,
    nextRunAt,
    lastRunAt: finishedAt,
    lastError: errorText || null,
    lastResult: summary || (runStatus === "error" ? "error" : runStatus)
  });
  runtime.store.recordAutomationRun({
    automationId,
    startedAt,
    finishedAt,
    status: runStatus,
    summary: summary || null,
    error: errorText || null,
    messageId: sentMessageId,
    metadata: {
      nextRunAt,
      statusAfterRun: finalized?.status || status
    }
  });

  runtime.store.logAction({
    kind: runStatus === "error" ? "automation_error" : "automation_run",
    guildId,
    channelId,
    messageId: sentMessageId,
    userId: runtime.client.user?.id || null,
    content:
      runStatus === "error"
        ? `automation #${automationId}: ${errorText || "run failed"}`
        : `automation #${automationId}: ${summary || runStatus}`,
    metadata: {
      automationId,
      runStatus,
      statusAfterRun: finalized?.status || status,
      nextRunAt
    }
  });
}

export async function generateAutomationPayload(
  runtime: AutomationEngineRuntime,
  {
    automation,
    settings,
    channel
  }: {
    automation: AutomationRowLike;
    settings: Record<string, unknown>;
    channel: AutomationChannelLike;
  }
) {
  const memory = getMemorySettings(settings);
  const discovery = getDiscoverySettings(settings);
  if (!runtime.llm?.generate) {
    const fallback = sanitizeBotText(String(automation?.instruction || "scheduled task"), 1200);
    return {
      skip: false,
      summary: fallback.slice(0, 220),
      text: fallback,
      payload: { content: fallback },
      media: null,
      llm: null
    };
  }

  const recentMessages = runtime.store.getRecentMessages(channel.id, memory.promptSlice.maxRecentMessages);
  const automationOwnerId = String(automation?.created_by_user_id || "").trim() || null;
  const automationQuery = `${String(automation?.title || "")} ${String(automation?.instruction || "")}`
    .replace(/\s+/g, " ")
    .trim();
  const memorySlice = await runtime.loadPromptMemorySlice({
    settings,
    userId: automationOwnerId,
    guildId: automation.guild_id,
    channelId: automation.channel_id,
    queryText: automationQuery,
    trace: {
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      userId: automationOwnerId
    },
    source: "automation_run"
  });

  const imageBudget = runtime.getImageBudgetState(settings);
  const videoBudget = runtime.getVideoGenerationBudgetState(settings);
  const gifBudget = runtime.getGifBudgetState(settings);
  const mediaCapabilities = runtime.getMediaGenerationCapabilities(settings);
  const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
  const automationMediaMemoryFacts = runtime.buildMediaMemoryFacts({
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts
  });
  const memoryLookup = runtime.buildMemoryLookupContext({ settings });
  const promptBase = {
    instruction: automation.instruction,
    channelName: channel.name || "channel",
    recentMessages,
    relevantMessages: memorySlice.relevantMessages,
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts,
    allowSimpleImagePosts:
      discovery.allowImagePosts && mediaCapabilities.simpleImageReady && imageBudget.canGenerate,
    allowComplexImagePosts:
      discovery.allowImagePosts && mediaCapabilities.complexImageReady && imageBudget.canGenerate,
    allowVideoPosts:
      discovery.allowVideoPosts && mediaCapabilities.videoReady && videoBudget.canGenerate,
    allowGifs: discovery.allowReplyGifs && gifBudget.canFetch,
    remainingImages: imageBudget.remaining,
    remainingVideos: videoBudget.remaining,
    remainingGifs: gifBudget.remaining,
    maxMediaPromptChars: mediaPromptLimit,
    mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
  };
  const userPrompt = buildAutomationPrompt({
    ...promptBase,
    memoryLookup,
    allowMemoryLookupDirective: false
  });
  const automationSystemPrompt = buildSystemPrompt(settings);

  const automationTrace = {
    guildId: automation.guild_id,
    channelId: automation.channel_id,
    userId: runtime.client.user?.id || null,
    source: "automation_run",
    event: `automation:${automation.id}`,
    reason: null,
    messageId: null
  };
  const automationReplyTools = buildReplyToolSet(settings, {
    webSearchAvailable: false,
    webScrapeAvailable: false,
    browserBrowseAvailable: false,
    memoryAvailable: memory.enabled,
    adaptiveDirectivesAvailable: false,
    imageLookupAvailable: false,
    openArticleAvailable: false
  });
  const automationToolRuntime: ReplyToolRuntime = {
    search: runtime.search,
    memory: runtime.memory,
    store: runtime.store
  };
  const automationToolContext: ReplyToolContext = {
    settings,
    guildId: automation.guild_id || "",
    channelId: automation.channel_id || "",
    userId: runtime.client.user?.id || "",
    sourceMessageId: `automation:${automation.id}`,
    sourceText: String(automation.instruction || ""),
    botUserId: runtime.client.user?.id || undefined,
    trace: automationTrace
  };

  let automationContextMessages: ContextMessage[] = [];
  let generation = await runtime.llm.generate({
    settings,
    systemPrompt: automationSystemPrompt,
    userPrompt,
    contextMessages: automationContextMessages,
    jsonSchema: automationReplyTools.length ? "" : REPLY_OUTPUT_JSON_SCHEMA,
    tools: automationReplyTools,
    trace: automationTrace
  });

  const AUTOMATION_TOOL_LOOP_MAX_STEPS = 2;
  const AUTOMATION_TOOL_LOOP_MAX_CALLS = 3;
  let automationToolLoopSteps = 0;
  let automationTotalToolCalls = 0;

  while (
    generation.toolCalls?.length > 0 &&
    automationToolLoopSteps < AUTOMATION_TOOL_LOOP_MAX_STEPS &&
    automationTotalToolCalls < AUTOMATION_TOOL_LOOP_MAX_CALLS
  ) {
    const assistantContent = buildContextContentBlocks(generation.rawContent, generation.text);
    automationContextMessages = [
      ...automationContextMessages,
      { role: "user", content: userPrompt },
      { role: "assistant", content: assistantContent }
    ];

    const toolResultMessages: ContentBlock[] = [];
    for (const toolCall of generation.toolCalls) {
      if (automationTotalToolCalls >= AUTOMATION_TOOL_LOOP_MAX_CALLS) break;
      automationTotalToolCalls += 1;

      const result = await executeReplyTool(
        toolCall.name,
        toolCall.input as Record<string, unknown>,
        automationToolRuntime,
        automationToolContext
      );

      toolResultMessages.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result.content
      });
    }

    automationContextMessages = [
      ...automationContextMessages,
      { role: "user", content: toolResultMessages }
    ];

    generation = await runtime.llm.generate({
      settings,
      systemPrompt: automationSystemPrompt,
      userPrompt: "",
      contextMessages: automationContextMessages,
      jsonSchema: "",
      tools: automationReplyTools,
      trace: {
        ...automationTrace,
        event: `automation:${automation.id}:tool_loop:${automationToolLoopSteps + 1}`,
        reason: null,
        messageId: null
      }
    });
    automationToolLoopSteps += 1;
  }

  const directive = parseStructuredReplyOutput(generation.text, mediaPromptLimit);

  let finalText = sanitizeBotText(normalizeSkipSentinel(directive.text || ""), 1200);
  if (!finalText) {
    finalText = sanitizeBotText(String(automation.instruction || "scheduled task"), 1200);
  }

  if (finalText === "[SKIP]") {
    return {
      skip: true,
      summary: "model skipped run",
      text: "",
      payload: null,
      media: null,
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd
      }
    };
  }

  const mediaDirective = pickReplyMediaDirective(directive);
  const mediaAttachment = await runtime.resolveMediaAttachment({
    settings,
    text: finalText,
    directive: {
      type: mediaDirective?.type ?? null,
      gifQuery: directive.gifQuery,
      imagePrompt:
        mediaDirective?.type === "image_simple" && directive.imagePrompt
          ? composeReplyImagePrompt(
            directive.imagePrompt,
            finalText,
            mediaPromptLimit,
            automationMediaMemoryFacts
          )
          : null,
      complexImagePrompt:
        mediaDirective?.type === "image_complex" && directive.complexImagePrompt
          ? composeReplyImagePrompt(
            directive.complexImagePrompt,
            finalText,
            mediaPromptLimit,
            automationMediaMemoryFacts
          )
          : null,
      videoPrompt:
        mediaDirective?.type === "video" && directive.videoPrompt
          ? composeReplyVideoPrompt(
            directive.videoPrompt,
            finalText,
            mediaPromptLimit,
            automationMediaMemoryFacts
          )
          : null
    },
    trace: {
      guildId: automation.guild_id,
      channelId: automation.channel_id,
      userId: runtime.client.user?.id || null,
      source: "automation_run"
    }
  });

  return {
    skip: false,
    summary: finalText.slice(0, 220),
    text: finalText,
    payload: mediaAttachment.payload,
    media: mediaAttachment.media,
    llm: {
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
      costUsd: generation.costUsd
    }
  };
}
