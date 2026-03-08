import { clamp, sanitizeBotText } from "../utils.ts";
import { buildReplyPrompt, buildSystemPrompt } from "../prompts/index.ts";
import { getMediaPromptCraftGuidance } from "../prompts/promptCore.ts";
import type { ReplyAttemptOptions } from "../bot.ts";
import {
  REPLY_OUTPUT_JSON_SCHEMA,
  composeReplyImagePrompt,
  composeReplyVideoPrompt,
  embedWebSearchSources,
  emptyMentionResolution,
  parseStructuredReplyOutput,
  pickReplyMediaDirective,
  resolveMaxMediaPromptLen,
  normalizeSkipSentinel,
  splitDiscordMessage
} from "./botHelpers.ts";
import { getLocalTimeZoneLabel } from "./automation.ts";
import { buildReplyToolSet, executeReplyTool } from "../tools/replyTools.ts";
import type { ReplyToolContext, ReplyToolRuntime } from "../tools/replyTools.ts";
import {
  maybeRegenerateWithMemoryLookup as maybeRegenerateWithMemoryLookupForReplyFollowup,
  resolveReplyFollowupGenerationSettings as resolveReplyFollowupGenerationSettingsForReplyFollowup,
  runModelRequestedWebSearch as runModelRequestedWebSearchForReplyFollowup
} from "./replyFollowup.ts";
import {
  buildTextReplyScopeKey
} from "../tools/activeReplyRegistry.ts";
import {
  isAbortError,
  throwIfAborted
} from "../tools/browserTaskRuntime.ts";
import { resolveDeterministicMentions as resolveDeterministicMentionsForMentions } from "./mentions.ts";
import {
  MAX_MODEL_IMAGE_INPUTS,
  UNICODE_REACTIONS,
  appendReplyFollowupPrompt,
  buildLoggedReplyPrompts,
  createReplyPerformanceTracker,
  createReplyPromptCapture,
  finalizeReplyPerformanceSample
} from "./replyPipelineShared.ts";
import { loadConversationContinuityContext } from "./conversationContinuity.ts";
import {
  getActivitySettings,
  getAutomationsSettings,
  getBotName,
  getDirectiveSettings,
  getDiscoverySettings,
  getMemorySettings,
  getReplyPermissions,
  getVisionSettings,
  getVoiceSettings,
  isDevTaskEnabled
} from "../settings/agentStack.ts";
import type { Settings } from "../settings/settingsSchema.ts";
import {
  buildContextContentBlocks,
  type ContentBlock,
  type ContextMessage
} from "../llm/serviceShared.ts";
import type { ReplyPipelineRuntime } from "./botContext.ts";

type ReplyPipelineAttachment = {
  url?: string;
  proxyURL?: string;
};

type ReplyPipelineAttachmentCollection = {
  size?: number;
  values: () => IterableIterator<ReplyPipelineAttachment>;
};

type ReplyPipelineEmbed = {
  url?: string;
  video?: {
    url?: string;
    proxyURL?: string;
  } | null;
};

type ReplyPipelineGuildMember = {
  id?: string;
  displayName?: string;
  nickname?: string | null;
  user?: {
    id?: string;
    username?: string;
    globalName?: string | null;
  } | null;
};

type ReplyPipelineGuild = {
  members?: {
    cache?: {
      size?: number;
      values: () => IterableIterator<ReplyPipelineGuildMember>;
    };
    search?: (options: {
      query: string;
      limit: number;
    }) => Promise<{
      values: () => IterableIterator<ReplyPipelineGuildMember>;
    }>;
  } | null;
};

type ReplyPipelineMentions = {
  users?: {
    size: number;
    has: (id: string | undefined) => boolean;
  } | null;
  repliedUser?: {
    id: string;
  } | null;
};

type ReplyMessagePayload = Record<string, unknown> & {
  content: string;
  allowedMentions?: {
    repliedUser?: boolean;
  };
};

type ReplyPipelineSentMessage = {
  id: string;
  createdTimestamp: number;
  guildId: string;
  channelId: string;
  content?: string;
  attachments?: ReplyPipelineAttachmentCollection;
  embeds?: ReplyPipelineEmbed[];
};

type ReplyPipelineChannel = {
  sendTyping: () => Promise<unknown>;
  send: (payload: ReplyMessagePayload) => Promise<ReplyPipelineSentMessage>;
};

type ReplyPipelineMessage = ReplyPipelineSentMessage & {
  content: string;
  guild: ReplyPipelineGuild | null;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    displayName?: string | null;
  } | null;
  channel: ReplyPipelineChannel;
  mentions?: ReplyPipelineMentions;
  react: (emoji: string) => Promise<unknown>;
  reply: (payload: ReplyMessagePayload) => Promise<ReplyPipelineSentMessage>;
};

type ReplyAddressSignal =
  | ReplyAttemptOptions["addressSignal"]
  | Awaited<ReturnType<ReplyPipelineRuntime["getReplyAddressSignal"]>>;
type ReplyRecentMessage = Record<string, unknown>;
type ReplyImageInput = Record<string, unknown> & {
  url?: string;
  mediaType?: string;
  contentType?: string;
  dataBase64?: string;
};
type ReplyGeneration = {
  provider?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  costUsd?: number | null;
  text: string;
  rawContent?: unknown;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};
type ReplyToolExecutionResult = Awaited<ReturnType<typeof executeReplyTool>>;
type ReplyPerformance = ReturnType<typeof createReplyPerformanceTracker>;
type ReplyPromptCaptureState = ReturnType<typeof createReplyPromptCapture>;
type ReplyPrompts = ReturnType<typeof buildLoggedReplyPrompts>;
type ReplyContinuityContext = Awaited<ReturnType<typeof loadConversationContinuityContext>>;
type ReplyPromptBase = Parameters<typeof buildReplyPrompt>[0];
type ReplyTrace = {
  guildId: string;
  channelId: string;
  userId: string;
  source: string | null;
  event: string | null;
  reason: string | null;
  messageId: string | null;
};
type ReplyDirective = ReturnType<typeof parseStructuredReplyOutput>;
type ReplyMediaDirective = ReturnType<typeof pickReplyMediaDirective>;
type ReplyMentionResolution = Awaited<ReturnType<typeof resolveDeterministicMentionsForMentions>>;
type ReplyReactionResult = Awaited<ReturnType<ReplyPipelineRuntime["maybeApplyReplyReaction"]>>;
type ReplyScreenShareOffer = Awaited<ReturnType<ReplyPipelineRuntime["maybeHandleScreenShareOfferIntent"]>>;
type ReplyFollowupGenerationSettings = ReturnType<typeof resolveReplyFollowupGenerationSettingsForReplyFollowup>;
type ReplyWebSearchState = ReturnType<ReplyPipelineRuntime["buildWebSearchContext"]> & {
  summaryText?: string | null;
};

type ReplyPipelineContext = {
  shouldRun: true;
  signal?: AbortSignal;
  recentMessages: ReplyRecentMessage[];
  addressSignal: ReplyAddressSignal;
  triggerMessageIds: string[];
  addressed: boolean;
  reactionEagerness: number;
  isReplyChannel: boolean;
  replyEagerness: number;
  reactionEmojiOptions: string[];
  source: string;
  performance: ReplyPerformance;
  memorySlice: ReplyContinuityContext["memorySlice"];
  replyMediaMemoryFacts: ReturnType<ReplyPipelineRuntime["buildMediaMemoryFacts"]>;
  attachmentImageInputs: ReplyImageInput[];
  imageBudget: ReturnType<ReplyPipelineRuntime["getImageBudgetState"]>;
  videoBudget: ReturnType<ReplyPipelineRuntime["getVideoGenerationBudgetState"]>;
  mediaCapabilities: ReturnType<ReplyPipelineRuntime["getMediaGenerationCapabilities"]>;
  simpleImageCapabilityReady: boolean;
  complexImageCapabilityReady: boolean;
  imageCapabilityReady: boolean;
  videoCapabilityReady: boolean;
  gifBudget: ReturnType<ReplyPipelineRuntime["getGifBudgetState"]>;
  gifsConfigured: boolean;
  webSearch: ReplyWebSearchState;
  browserBrowse: ReturnType<ReplyPipelineRuntime["buildBrowserBrowseContext"]>;
  recentConversationHistory: ReplyContinuityContext["recentConversationHistory"];
  recentWebLookups: ReplyContinuityContext["recentWebLookups"];
  memoryLookup: ReturnType<ReplyPipelineRuntime["buildMemoryLookupContext"]>;
  videoContext: Awaited<ReturnType<ReplyPipelineRuntime["buildVideoReplyContext"]>>;
  modelImageInputs: ReplyImageInput[];
  imageLookup: ReturnType<ReplyPipelineRuntime["buildImageLookupContext"]>;
  replyTrace: ReplyTrace;
  screenShareCapability: ReturnType<ReplyPipelineRuntime["getVoiceScreenShareCapability"]>;
  activeVoiceSession: ReturnType<ReplyPipelineRuntime["voiceSessionManager"]["getSession"]> | null;
  inVoiceChannelNow: boolean;
  activeVoiceParticipantRoster: string[];
  musicState: ReturnType<ReplyPipelineRuntime["voiceSessionManager"]["getMusicPromptContext"]> | null;
  musicDisambiguation: ReturnType<ReplyPipelineRuntime["voiceSessionManager"]["getMusicDisambiguationPromptContext"]> | null;
  systemPrompt: string;
  replyPromptBase: ReplyPromptBase;
  initialUserPrompt: string;
  replyPromptCapture: ReplyPromptCaptureState;
  replyPrompts: ReplyPrompts;
};

type ReplyIntentHandledResult = {
  handledByIntent: true;
};

type ReplyActionableLlmResult = {
  handledByIntent: false;
  generation: ReplyGeneration;
  typingDelayMs: number;
  usedWebSearchFollowup: boolean;
  usedBrowserBrowseFollowup: boolean;
  usedMemoryLookupFollowup: boolean;
  usedImageLookupFollowup: boolean;
  followupGenerationSettings: ReplyFollowupGenerationSettings;
  mediaPromptLimit: number;
  replyDirective: ReplyDirective;
  webSearch: ReplyWebSearchState;
  browserBrowse: ReturnType<ReplyPipelineRuntime["buildBrowserBrowseContext"]>;
  memoryLookup: ReturnType<ReplyPipelineRuntime["buildMemoryLookupContext"]>;
  imageLookup: ReturnType<ReplyPipelineRuntime["buildImageLookupContext"]>;
  modelImageInputs: ReplyImageInput[];
  replyPrompts: ReplyPrompts;
};

type ReplyLlmResult = ReplyIntentHandledResult | ReplyActionableLlmResult;

type ReplySkippedActionResult = {
  skipped: true;
};

type ReplySendableActionResult = {
  skipped: false;
  reaction: ReplyReactionResult;
  memoryLine: ReplyDirective["memoryLine"];
  selfMemoryLine: ReplyDirective["selfMemoryLine"];
  memorySaved: boolean;
  selfMemorySaved: boolean;
  mediaDirective: ReplyMediaDirective;
  finalText: string;
  mentionResolution: ReplyMentionResolution;
  screenShareOffer: ReplyScreenShareOffer;
  allowMediaOnlyReply: boolean;
  modelProducedSkip: boolean;
  modelProducedEmpty: boolean;
  payload: ReplyMessagePayload;
  imageUsed: boolean;
  imageBudgetBlocked: boolean;
  imageCapabilityBlocked: boolean;
  imageVariantUsed: string | null;
  videoUsed: boolean;
  videoBudgetBlocked: boolean;
  videoCapabilityBlocked: boolean;
  gifUsed: boolean;
  gifBudgetBlocked: boolean;
  gifConfigBlocked: boolean;
  imagePrompt: ReplyDirective["imagePrompt"];
  complexImagePrompt: ReplyDirective["complexImagePrompt"];
  videoPrompt: ReplyDirective["videoPrompt"];
  gifQuery: ReplyDirective["gifQuery"];
};

type ReplyActionResult = ReplySkippedActionResult | ReplySendableActionResult;

function isReplyActionableLlmResult(result: ReplyLlmResult): result is ReplyActionableLlmResult {
  return result.handledByIntent === false;
}

function isReplySendableActionResult(result: ReplyActionResult): result is ReplySendableActionResult {
  return result.skipped === false;
}



export async function buildReplyContext(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  options: ReplyAttemptOptions
): Promise<ReplyPipelineContext | false> {
  const memorySettings = getMemorySettings(settings);
  const activity = getActivitySettings(settings);
  const directiveSettings = getDirectiveSettings(settings);
  const automationsSettings = getAutomationsSettings(settings);
  const discovery = getDiscoverySettings(settings);
  const voiceSettings = getVoiceSettings(settings);
  const visionSettings = getVisionSettings(settings);
  const recentMessages = Array.isArray(options.recentMessages)
    ? options.recentMessages
    : bot.store.getRecentMessages(message.channelId, memorySettings.promptSlice.maxRecentMessages);
  const addressSignal =
    options.addressSignal || await bot.getReplyAddressSignal(settings, message, recentMessages);
  const triggerMessageIds = [
    ...new Set(
      [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ];
  const addressed = Boolean(addressSignal?.triggered);
  const reactionEagerness = clamp(Number(activity.reactionLevel) || 0, 0, 100);
  const isReplyChannel = bot.isReplyChannel(settings, message.channelId);
  const replyEagerness = clamp(
    Number(activity.replyEagerness) || 0,
    0,
    100
  );
  const reactionEmojiOptions = [
    ...new Set([...bot.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS])
  ];

  const shouldRunDecisionLoop = bot.shouldAttemptReplyDecision({
    settings,
    recentMessages,
    addressSignal,
    forceRespond: Boolean(options.forceRespond),
    forceDecisionLoop: Boolean(options.forceDecisionLoop),
    triggerMessageId: message.id
  });
  if (!shouldRunDecisionLoop) return false;

  const source = String(options.source || "message_event");
  const performance = createReplyPerformanceTracker({
    messageCreatedAtMs: message?.createdTimestamp,
    source,
    seed: options.performanceSeed
  });

  const memorySliceStartedAtMs = Date.now();
  const continuity = await loadConversationContinuityContext({
    settings,
    userId: message.author.id,
    guildId: message.guildId,
    channelId: message.channelId,
    queryText: message.content,
    trace: {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id
    },
    source,
    recentMessages,
    loadFactProfile: (payload) =>
      bot.loadFactProfile({
        settings: payload.settings,
        userId: payload.userId,
        guildId: String(payload.guildId || message.guildId),
        channelId: payload.channelId,
        queryText: payload.queryText,
        trace: payload.trace,
        source: payload.source
      }),
    loadRecentLookupContext: (payload) => bot.getRecentLookupContextForPrompt(payload),
    loadRecentConversationHistory: (payload) => bot.getConversationHistoryForPrompt(payload),
    loadAdaptiveDirectives:
      Boolean(directiveSettings.enabled) &&
        typeof bot.store?.searchAdaptiveStyleNotesForPrompt === "function"
        ? (payload) =>
          bot.store.searchAdaptiveStyleNotesForPrompt({
            guildId: String(payload.guildId || "").trim(),
            queryText: String(payload.queryText || ""),
            limit: 8
          })
        : null
  });
  const memorySlice = continuity.memorySlice;
  const adaptiveDirectives = Array.isArray(continuity.adaptiveDirectives) ? continuity.adaptiveDirectives : [];
  performance.memorySliceMs = Math.max(0, Date.now() - memorySliceStartedAtMs);
  const replyMediaMemoryFacts = bot.buildMediaMemoryFacts({
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts
  });
  const attachmentImageInputs: ReplyImageInput[] = bot.getImageInputs(message);
  const imageBudget = bot.getImageBudgetState(settings);
  const videoBudget = bot.getVideoGenerationBudgetState(settings);
  const mediaCapabilities = bot.getMediaGenerationCapabilities(settings);
  const simpleImageCapabilityReady = mediaCapabilities.simpleImageReady;
  const complexImageCapabilityReady = mediaCapabilities.complexImageReady;
  const imageCapabilityReady = simpleImageCapabilityReady || complexImageCapabilityReady;
  const videoCapabilityReady = mediaCapabilities.videoReady;
  const gifBudget = bot.getGifBudgetState(settings);
  const gifsConfigured = Boolean(bot.gifs?.isConfigured?.());
  const webSearch: ReplyWebSearchState = bot.buildWebSearchContext(settings, message.content);
  const browserBrowse = bot.buildBrowserBrowseContext(settings);
  const recentWebLookups = continuity.recentWebLookups;
  const recentConversationHistory = continuity.recentConversationHistory;
  const memoryLookup = bot.buildMemoryLookupContext({ settings });
  const videoContext = await bot.buildVideoReplyContext({
    settings,
    message,
    recentMessages,
    trace: {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      source
    }
  });
  const modelImageInputs: ReplyImageInput[] = [
    ...attachmentImageInputs,
    ...(videoContext.frameImages || [])
  ].slice(0, MAX_MODEL_IMAGE_INPUTS);
  const imageLookup = bot.buildImageLookupContext({
    recentMessages,
    excludedUrls: modelImageInputs.map((image) => String(image?.url || "").trim())
  });

  if (Boolean(visionSettings.enabled) && imageLookup.candidates?.length) {
    // Fire-and-forget: caption uncaptioned images in background for future text matching.
    // Historical images stay out of direct model vision context until the model explicitly asks.
    bot.captionRecentHistoryImages({
      candidates: imageLookup.candidates,
      settings,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source: "reply_pipeline_auto_caption"
      }
    });
  }
  const replyTrace = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    source,
    event: null,
    reason: null,
    messageId: message.id
  };
  const screenShareCapability = bot.getVoiceScreenShareCapability({
    settings,
    guildId: message.guildId,
    channelId: message.channelId,
    requesterUserId: message.author?.id || null
  });
  const activeVoiceSession =
    typeof bot.voiceSessionManager?.getSession === "function"
      ? bot.voiceSessionManager.getSession(message.guildId)
      : null;
  const inVoiceChannelNow = Boolean(activeVoiceSession && !activeVoiceSession.ending);
  const activeVoiceParticipantRoster =
    inVoiceChannelNow && typeof bot.voiceSessionManager?.getVoiceChannelParticipants === "function"
      ? bot.voiceSessionManager
        .getVoiceChannelParticipants(activeVoiceSession)
        .map((entry) => String(entry?.displayName || "").trim())
        .filter(Boolean)
      : [];
  const musicDisambiguation =
    inVoiceChannelNow &&
      typeof bot.voiceSessionManager?.getMusicDisambiguationPromptContext === "function"
      ? bot.voiceSessionManager.getMusicDisambiguationPromptContext(activeVoiceSession)
      : null;
  const musicState =
    inVoiceChannelNow &&
      typeof bot.voiceSessionManager?.getMusicPromptContext === "function"
      ? bot.voiceSessionManager.getMusicPromptContext(activeVoiceSession)
      : null;

  const systemPrompt = buildSystemPrompt(settings, {
    adaptiveDirectives
  });
  const replyPromptBase: ReplyPromptBase = {
    message: {
      authorName: message.member?.displayName || message.author.username,
      content: message.content
    },
    triggerMessageIds,
    imageInputs: modelImageInputs,
    recentMessages,
    relevantMessages: memorySlice.relevantMessages,
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts,
    emojiHints: bot.getEmojiHints(message.guild),
    reactionEmojiOptions,
    allowReplySimpleImages:
      discovery.allowReplyImages && simpleImageCapabilityReady && imageBudget.canGenerate,
    allowReplyComplexImages:
      discovery.allowReplyImages && complexImageCapabilityReady && imageBudget.canGenerate,
    remainingReplyImages: imageBudget.remaining,
    allowReplyVideos:
      discovery.allowReplyVideos && videoCapabilityReady && videoBudget.canGenerate,
    remainingReplyVideos: videoBudget.remaining,
    allowReplyGifs: discovery.allowReplyGifs && gifsConfigured && gifBudget.canFetch,
    remainingReplyGifs: gifBudget.remaining,
    gifRepliesEnabled: discovery.allowReplyGifs,
    gifsConfigured,
    replyEagerness,
    reactionEagerness,
    addressing: {
      directlyAddressed: addressed,
      directAddressConfidence: Number(addressSignal?.confidence) || 0,
      directAddressThreshold: Number(addressSignal?.threshold) || 0.62,
      responseRequired: Boolean(options.forceRespond),
      mentionsOtherUsers: Boolean(
        !addressed &&
        message.mentions?.users?.size > 0 &&
        !message.mentions.users.has(bot.client.user?.id)
      ),
      repliesToOtherUser: Boolean(
        !addressed &&
        message.mentions?.repliedUser &&
        message.mentions.repliedUser.id !== bot.client.user?.id
      )
    },
    allowMemoryDirective: memorySettings.enabled,
    allowAdaptiveDirective: Boolean(directiveSettings.enabled),
    allowAutomationDirective: Boolean(automationsSettings.enabled),
    automationTimeZoneLabel: getLocalTimeZoneLabel(),
    voiceMode: {
      enabled: Boolean(voiceSettings.enabled),
      activeSession: inVoiceChannelNow,
      participantRoster: activeVoiceParticipantRoster,
      musicState,
      musicDisambiguation
    },
    recentConversationHistory,
    recentWebLookups,
    screenShare: screenShareCapability,
    videoContext,
    channelMode: isReplyChannel ? "reply_channel" : "other_channel",
    maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
    mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
  };
  const initialUserPrompt = buildReplyPrompt({
    ...replyPromptBase,
    imageInputs: modelImageInputs,
    webSearch,
    browserBrowse,
    memoryLookup,
    imageLookup,
    allowWebSearchDirective: true,
    allowBrowserBrowseDirective: true,
    allowMemoryLookupDirective: true,
    allowImageLookupDirective: true
  });
  const replyPromptCapture = createReplyPromptCapture({
    systemPrompt,
    initialUserPrompt
  });
  const replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, 0);

  return {
    shouldRun: true,
    recentMessages, addressSignal, triggerMessageIds, addressed, reactionEagerness,
    isReplyChannel, replyEagerness, reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, webSearch, browserBrowse, recentConversationHistory, recentWebLookups, memoryLookup,
    videoContext, modelImageInputs, imageLookup, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicState, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture, replyPrompts
  };
}


export async function executeReplyLlm(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  _options: ReplyAttemptOptions,
  ctx: ReplyPipelineContext
): Promise<ReplyLlmResult> {
  const {
    addressSignal, triggerMessageIds, source, performance, signal,
    replyTrace, systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture
  } = ctx;
  let { webSearch, browserBrowse, memoryLookup, modelImageInputs, imageLookup, replyPrompts } = ctx;

  const replyTools = buildReplyToolSet(settings, {
    webSearchAvailable:
      Boolean(webSearch?.enabled) &&
      Boolean(webSearch?.configured) &&
      !webSearch?.optedOutByUser &&
      !webSearch?.blockedByBudget &&
      webSearch?.budget?.canSearch !== false,
    browserBrowseAvailable:
      Boolean(browserBrowse?.enabled) &&
      Boolean(browserBrowse?.configured) &&
      !browserBrowse?.blockedByBudget &&
      browserBrowse?.budget?.canBrowse !== false,
    memoryAvailable: Boolean(getMemorySettings(settings).enabled),
    adaptiveDirectivesAvailable: Boolean(getDirectiveSettings(settings).enabled),
    imageLookupAvailable: Boolean(imageLookup?.enabled),
    openArticleAvailable: false,
    codeAgentAvailable: isDevTaskEnabled(settings)
  });
  const replyToolRuntime: ReplyToolRuntime = {
    search: bot.search,
    browser: {
      browse: async ({ settings: toolSettings, query, guildId, channelId, userId, source }) => {
        browserBrowse = await bot.runModelRequestedBrowserBrowse({
          settings: toolSettings,
          browserBrowse,
          query,
          guildId,
          channelId,
          userId,
          source,
          signal
        });
        return browserBrowse;
      }
    },
    codeAgent: {
      runTask: async ({ settings: toolSettings, task, cwd, guildId, channelId, userId, source }) =>
        await bot.runModelRequestedCodeTask({
          settings: toolSettings,
          task,
          cwd,
          guildId,
          channelId,
          userId,
          source,
          signal
        })
    },
    memory: bot.memory,
    store: bot.store,
    subAgentSessions: bot.buildSubAgentSessionsRuntime()
  };
  const replyToolContext: ReplyToolContext = {
    settings,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    sourceMessageId: message.id,
    sourceText: message.content,
    botUserId: bot.client.user?.id || undefined,
    actorName: message.member?.displayName || message.author?.username || undefined,
    trace: {
      ...replyTrace,
      source
    },
    signal
  };
  let replyContextMessages: ContextMessage[] = [];

  throwIfAborted(signal, "Reply cancelled");
  const typingStartedAtMs = Date.now();
  await message.channel.sendTyping();
  const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);
  const llm1StartedAtMs = Date.now();
  let generation: ReplyGeneration = await bot.llm.generate({
    settings,
    systemPrompt,
    userPrompt: initialUserPrompt,
    imageInputs: modelImageInputs,
    contextMessages: replyContextMessages,
    jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
    tools: replyTools,
    trace: replyTrace,
    signal
  });
  const followupGenerationSettings = resolveReplyFollowupGenerationSettingsForReplyFollowup(settings);
  performance.llm1Ms = Math.max(0, Date.now() - llm1StartedAtMs);
  let usedWebSearchFollowup = false;
  let usedBrowserBrowseFollowup = false;
  let usedMemoryLookupFollowup = false;
  let usedImageLookupFollowup = false;
  const REPLY_TOOL_LOOP_MAX_STEPS = 2;
  const REPLY_TOOL_LOOP_MAX_CALLS = 3;
  let replyToolLoopSteps = 0;
  let replyTotalToolCalls = 0;

  while (
    generation.toolCalls?.length > 0 &&
    replyToolLoopSteps < REPLY_TOOL_LOOP_MAX_STEPS &&
    replyTotalToolCalls < REPLY_TOOL_LOOP_MAX_CALLS
  ) {
    throwIfAborted(signal, "Reply cancelled");
    const assistantContent = buildContextContentBlocks(generation.rawContent, generation.text);
    replyContextMessages = [
      ...replyContextMessages,
      { role: "user", content: initialUserPrompt },
      { role: "assistant", content: assistantContent }
    ];

    const toolResultMessages: ContentBlock[] = [];

    // Separate sub-agent tools (can run concurrently) from sequential tools
    const CONCURRENT_TOOL_NAMES = new Set(["code_task", "browser_browse"]);
    const eligibleToolCalls = generation.toolCalls.slice(
      0,
      Math.max(0, REPLY_TOOL_LOOP_MAX_CALLS - replyTotalToolCalls)
    );
    replyTotalToolCalls += eligibleToolCalls.length;

    const concurrentCalls = eligibleToolCalls.filter((tc) => CONCURRENT_TOOL_NAMES.has(tc.name));
    const sequentialCalls = eligibleToolCalls.filter((tc) => !CONCURRENT_TOOL_NAMES.has(tc.name));

    // Run concurrent sub-agent calls in parallel
    const concurrentResults = new Map<string, ReplyToolExecutionResult>();
    if (concurrentCalls.length > 0) {
      const settledCalls = await Promise.allSettled(concurrentCalls.map(async (toolCall) => {
        throwIfAborted(signal, "Reply cancelled");
        const toolInput = toolCall.input;
        const result = await executeReplyTool(toolCall.name, toolInput, replyToolRuntime, replyToolContext);
        concurrentResults.set(toolCall.id, result);
      }));
      settledCalls.forEach((settled, index) => {
        if (settled.status === "fulfilled") return;
        const toolCall = concurrentCalls[index];
        const errorMessage =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason || "unknown_error");
        concurrentResults.set(toolCall.id, {
          content: `${toolCall.name} failed: ${errorMessage}`,
          isError: true
        });
        bot.store?.logAction?.({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id || null,
          content: `reply_tool_concurrent_failure:${toolCall.name}`,
          metadata: {
            source,
            toolCallId: toolCall.id,
            error: errorMessage
          }
        });
      });
    }

    // Run sequential tools in order
    const sequentialResults = new Map<string, ReplyToolExecutionResult>();
    for (const toolCall of sequentialCalls) {
      throwIfAborted(signal, "Reply cancelled");
      const toolInput = toolCall.input;
      let result: ReplyToolExecutionResult;
      if (toolCall.name === "web_search") {
        const toolQuery = String(toolInput.query || "");
        webSearch = await runModelRequestedWebSearchForReplyFollowup(
          { llm: bot.llm, search: bot.search, memory: bot.memory },
          {
            settings,
            webSearch,
            query: toolQuery,
            trace: {
              ...replyTrace,
              source
            },
            signal
          }
        );
        usedWebSearchFollowup = Boolean(webSearch?.used);
        const rows = Array.isArray(webSearch?.results) ? webSearch.results : [];
        result = {
          isError: Boolean(webSearch?.error),
          content: webSearch?.error
            ? `Web search failed: ${String(webSearch.error)}`
            : rows.length || String(webSearch?.summaryText || "").trim()
              ? `Web results for "${String(webSearch?.query || toolQuery)}":\n\n${[
                String(webSearch?.summaryText || "").trim()
                  ? `Summary:\n${String(webSearch?.summaryText || "").trim()}`
                  : "",
                rows
                  .map((item, index) => {
                    const title = String(item?.title || "untitled").trim();
                    const url = String(item?.url || "").trim();
                    const domain = String(item?.domain || "").trim();
                    const snippet = String(item?.snippet || "").trim();
                    const pageSummary = String(item?.pageSummary || "").trim();
                    const domainLabel = domain ? ` (${domain})` : "";
                    const snippetLine = snippet ? `\nSnippet: ${snippet}` : "";
                    const pageLine = pageSummary ? `\nPage: ${pageSummary}` : "";
                    return `[${index + 1}] ${title}${domainLabel}\nURL: ${url}${snippetLine}${pageLine}`;
                  })
                  .join("\n\n")
              ]
                .filter(Boolean)
                .join("\n\n")}`
              : `No results found for: "${toolQuery}"`
        };
      } else {
        result = await executeReplyTool(
          toolCall.name,
          toolInput,
          replyToolRuntime,
          replyToolContext
        );
      }

      if (toolCall.name === "memory_search" && !result.isError) {
        usedMemoryLookupFollowup = true;
      } else if (toolCall.name === "image_lookup" && !result.isError) {
        const imageLookupRequest = String(toolInput.imageId || toolInput.query || "");
        imageLookup = await bot.runModelRequestedImageLookup({
          imageLookup,
          query: imageLookupRequest
        });
        modelImageInputs = bot.mergeImageInputs({
          baseInputs: modelImageInputs,
          extraInputs: imageLookup.selectedImageInputs || [],
          maxInputs: MAX_MODEL_IMAGE_INPUTS
        });
        usedImageLookupFollowup = Boolean(imageLookup?.used);
      }

      sequentialResults.set(toolCall.id, result);
    }

    // Collect results in original order
    for (const toolCall of eligibleToolCalls) {
      const result = concurrentResults.get(toolCall.id) || sequentialResults.get(toolCall.id);
      if (result) {
        if (toolCall.name === "browser_browse" && !result.isError) {
          usedBrowserBrowseFollowup = Boolean(browserBrowse?.used);
        }
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.content
        });
      }
    }

    replyContextMessages = [
      ...replyContextMessages,
      { role: "user", content: toolResultMessages }
    ];

    throwIfAborted(signal, "Reply cancelled");
    generation = await bot.llm.generate({
      settings: followupGenerationSettings,
      systemPrompt,
      userPrompt: "",
      imageInputs: modelImageInputs,
      contextMessages: replyContextMessages,
      jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
      tools: replyTools,
      trace: {
        ...replyTrace,
        event: `reply_tool_loop:${replyToolLoopSteps + 1}`
      },
      signal
    });
    replyToolLoopSteps += 1;
  }

  const mediaPromptLimit = resolveMaxMediaPromptLen(settings);
  let replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
  let voiceIntentHandled = await bot.maybeHandleStructuredVoiceIntent({
    message,
    settings,
    replyDirective
  });
  if (voiceIntentHandled) return { handledByIntent: true };

  const automationIntentHandled = await bot.maybeHandleStructuredAutomationIntent({
    message,
    settings,
    replyDirective,
    generation,
    source,
    triggerMessageIds,
    addressing: addressSignal,
    performance,
    replyPrompts
  });
  if (automationIntentHandled) return { handledByIntent: true };

  const followupStartedAtMs = Date.now();
  const followup = await maybeRegenerateWithMemoryLookupForReplyFollowup(
    { llm: bot.llm, search: bot.search, memory: bot.memory },
    {
      settings,
      followupSettings: followupGenerationSettings,
      systemPrompt,
      generation,
      directive: replyDirective,
      webSearch,
      browserBrowse,
      memoryLookup,
      imageLookup,
      guildId: message.guildId,
      channelId: message.channelId,
      trace: {
        ...replyTrace,
        source,
        event: "reply_followup"
      },
      mediaPromptLimit,
      imageInputs: modelImageInputs,
      forceRegenerate: false,
      buildUserPrompt: ({
        webSearch: nextWebSearch,
        browserBrowse: nextBrowserBrowse,
        memoryLookup: nextMemoryLookup,
        imageLookup: nextImageLookup,
        imageInputs: nextImageInputs,
        allowWebSearchDirective,
        allowBrowserBrowseDirective,
        allowMemoryLookupDirective,
        allowImageLookupDirective
      }) => {
        const followupUserPrompt = buildReplyPrompt({
          ...replyPromptBase,
          imageInputs: nextImageInputs,
          webSearch: nextWebSearch,
          browserBrowse: nextBrowserBrowse,
          memoryLookup: nextMemoryLookup,
          imageLookup: nextImageLookup,
          allowWebSearchDirective,
          allowBrowserBrowseDirective,
          allowMemoryLookupDirective,
          allowImageLookupDirective
        });
        appendReplyFollowupPrompt(replyPromptCapture, followupUserPrompt);
        return followupUserPrompt;
      },
      runModelRequestedWebSearch: async ({ webSearch: currentWebSearch, query }) =>
        await runModelRequestedWebSearchForReplyFollowup(
          { llm: bot.llm, search: bot.search, memory: bot.memory },
          {
            settings,
            webSearch: currentWebSearch,
            query,
            trace: {
              ...replyTrace,
              source
            },
            signal
          }
        ),
      runModelRequestedBrowserBrowse: async ({ browserBrowse: currentBrowserBrowse, query }) =>
        await bot.runModelRequestedBrowserBrowse({
          settings,
          browserBrowse: currentBrowserBrowse,
          query,
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          source
        }),
      runModelRequestedImageLookup: (payload) => bot.runModelRequestedImageLookup(payload),
      mergeImageInputs: (payload) => bot.mergeImageInputs(payload),
      maxModelImageInputs: MAX_MODEL_IMAGE_INPUTS,
      jsonSchema: REPLY_OUTPUT_JSON_SCHEMA
    }
  );
  generation = followup.generation;
  replyDirective = followup.directive;
  webSearch = followup.webSearch || webSearch;
  browserBrowse = followup.browserBrowse || browserBrowse;
  memoryLookup = followup.memoryLookup;
  imageLookup = followup.imageLookup;
  modelImageInputs = followup.imageInputs;
  usedWebSearchFollowup = followup.usedWebSearch;
  usedBrowserBrowseFollowup = followup.usedBrowserBrowse;
  usedMemoryLookupFollowup = followup.usedMemoryLookup;
  usedImageLookupFollowup = followup.usedImageLookup;
  replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, followup.followupSteps);

  if (usedWebSearchFollowup && webSearch.used && Array.isArray(webSearch.results) && webSearch.results.length) {
    bot.rememberRecentLookupContext({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      source,
      query: webSearch.query || replyDirective.webSearchQuery,
      provider: webSearch.providerUsed || null,
      results: webSearch.results
    });
  }

  if (followup.regenerated) {
    voiceIntentHandled = await bot.maybeHandleStructuredVoiceIntent({
      message,
      settings,
      replyDirective
    });
    if (voiceIntentHandled) return { handledByIntent: true };

    const followupAutomationHandled = await bot.maybeHandleStructuredAutomationIntent({
      message,
      settings,
      replyDirective,
      generation,
      source,
      triggerMessageIds,
      addressing: addressSignal,
      performance,
      replyPrompts
    });
    if (followupAutomationHandled) return { handledByIntent: true };
  }
  if (
    followup.regenerated ||
    usedWebSearchFollowup ||
    usedBrowserBrowseFollowup ||
    usedMemoryLookupFollowup ||
    usedImageLookupFollowup
  ) {
    performance.followupMs = Math.max(0, Date.now() - followupStartedAtMs);
  }


  return {
    handledByIntent: false,
    generation, typingDelayMs, usedWebSearchFollowup, usedBrowserBrowseFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    followupGenerationSettings, mediaPromptLimit, replyDirective,
    webSearch, browserBrowse, memoryLookup, imageLookup, modelImageInputs, replyPrompts
  };
}


export async function dispatchReplyActions(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  _options: ReplyAttemptOptions,
  ctx: ReplyPipelineContext,
  llmResult: ReplyActionableLlmResult
): Promise<ReplyActionResult> {
  const memorySettings = getMemorySettings(settings);
  const discovery = getDiscoverySettings(settings);
  const {
    addressSignal, triggerMessageIds, reactionEmojiOptions, source, performance,
    replyMediaMemoryFacts
  } = ctx;
  const {
    generation, usedWebSearchFollowup, mediaPromptLimit, replyDirective,
    webSearch, replyPrompts
  } = llmResult;

  const reaction = await bot.maybeApplyReplyReaction({
    message,
    settings,
    emojiOptions: reactionEmojiOptions,
    emojiToken: replyDirective.reactionEmoji,
    generation,
    source,
    triggerMessageId: message.id,
    triggerMessageIds,
    addressing: addressSignal
  });

  const memoryLine = replyDirective.memoryLine;
  const selfMemoryLine = replyDirective.selfMemoryLine;
  let memorySaved = false;
  let selfMemorySaved = false;
  if (memorySettings.enabled && memoryLine) {
    try {
      memorySaved = await bot.memory.rememberDirectiveLine({
        line: memoryLine,
        sourceMessageId: message.id,
        userId: message.author.id,
        guildId: message.guildId,
        channelId: message.channelId,
        sourceText: message.content,
        scope: "lore"
      });
    } catch (error) {
      bot.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        content: `memory_directive: ${String(error?.message || error)}`
      });
    }
  }

  const mediaDirective = pickReplyMediaDirective(replyDirective);
  let finalText = sanitizeBotText(replyDirective.text || "");
  let mentionResolution = emptyMentionResolution();
  finalText = normalizeSkipSentinel(finalText);
  const screenShareOffer = await bot.maybeHandleScreenShareOfferIntent({
    message,
    replyDirective,
    source
  });
  if (screenShareOffer.appendText) {
    const textParts = [];
    if (finalText && finalText !== "[SKIP]") textParts.push(finalText);
    textParts.push(screenShareOffer.appendText);
    finalText = sanitizeBotText(textParts.join("\n"), 1700);
  }
  const allowMediaOnlyReply = !finalText && Boolean(mediaDirective);
  const modelProducedSkip = finalText === "[SKIP]";
  const modelProducedEmpty = !finalText;
  if (modelProducedEmpty && !allowMediaOnlyReply) {
    bot.store.logAction({
      kind: "bot_error",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: bot.client.user?.id || null,
      content: "reply_model_output_empty",
      metadata: {
        source,
        triggerMessageIds,
        addressed: Boolean(addressSignal?.triggered)
      }
    });
  }
  if (finalText === "[SKIP]" || (!finalText && !allowMediaOnlyReply)) {
    bot.logSkippedReply({
      message,
      source,
      triggerMessageIds,
      addressSignal,
      generation,
      usedWebSearchFollowup,
      reason: modelProducedSkip ? "llm_skip" : "empty_reply",
      reaction,
      screenShareOffer,
      performance,
      prompts: replyPrompts
    });
    return { skipped: true };
  }

  if (memorySettings.enabled && selfMemoryLine) {
    try {
      selfMemorySaved = await bot.memory.rememberDirectiveLine({
        line: selfMemoryLine,
        sourceMessageId: `${message.id}-self`,
        userId: bot.client.user?.id || message.author.id,
        guildId: message.guildId,
        channelId: message.channelId,
        sourceText: finalText,
        scope: "self"
      });
    } catch (error) {
      bot.store.logAction({
        kind: "bot_error",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: bot.client.user?.id || null,
        content: `memory_self_directive: ${String(error?.message || error)}`
      });
    }
  }

  mentionResolution = await resolveDeterministicMentionsForMentions(
    { store: bot.store },
    {
      text: finalText,
      guild: message.guild,
      guildId: message.guildId
    }
  );
  finalText = mentionResolution.text;
  finalText = embedWebSearchSources(finalText, webSearch);

  let payload: ReplyMessagePayload = { content: finalText };
  let imageUsed = false;
  let imageBudgetBlocked = false;
  let imageCapabilityBlocked = false;
  let imageVariantUsed = null;
  let videoUsed = false;
  let videoBudgetBlocked = false;
  let videoCapabilityBlocked = false;
  let gifUsed = false;
  let gifBudgetBlocked = false;
  let gifConfigBlocked = false;
  const imagePrompt = replyDirective.imagePrompt;
  const complexImagePrompt = replyDirective.complexImagePrompt;
  const videoPrompt = replyDirective.videoPrompt;
  const gifQuery = replyDirective.gifQuery;
  const mediaAttachment = await bot.resolveMediaAttachment({
    settings,
    text: finalText,
    directive: {
      type: mediaDirective?.type ?? null,
      gifQuery,
      imagePrompt:
        mediaDirective?.type === "image_simple" && discovery.allowReplyImages && imagePrompt
          ? composeReplyImagePrompt(
            imagePrompt,
            finalText,
            mediaPromptLimit,
            replyMediaMemoryFacts
          )
          : null,
      complexImagePrompt:
        mediaDirective?.type === "image_complex" && discovery.allowReplyImages && complexImagePrompt
          ? composeReplyImagePrompt(
            complexImagePrompt,
            finalText,
            mediaPromptLimit,
            replyMediaMemoryFacts
          )
          : null,
      videoPrompt:
        mediaDirective?.type === "video" && discovery.allowReplyVideos && videoPrompt
          ? composeReplyVideoPrompt(
            videoPrompt,
            finalText,
            mediaPromptLimit,
            replyMediaMemoryFacts
          )
          : null
    },
    trace: {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      source: "reply_message"
    }
  });
  payload = mediaAttachment.payload;
  imageUsed = mediaAttachment.imageUsed;
  imageBudgetBlocked = mediaAttachment.imageBudgetBlocked;
  imageCapabilityBlocked = mediaAttachment.imageCapabilityBlocked;
  imageVariantUsed = mediaAttachment.imageVariantUsed;
  videoUsed = mediaAttachment.videoUsed;
  videoBudgetBlocked = mediaAttachment.videoBudgetBlocked;
  videoCapabilityBlocked = mediaAttachment.videoCapabilityBlocked;
  gifUsed = mediaAttachment.gifUsed;
  gifBudgetBlocked = mediaAttachment.gifBudgetBlocked;
  gifConfigBlocked = mediaAttachment.gifConfigBlocked;

  if (!finalText && !imageUsed && !videoUsed && !gifUsed) {
    bot.store.logAction({
      kind: "bot_error",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: bot.client.user?.id || null,
      content: "reply_model_output_empty_after_media",
      metadata: {
        source,
        triggerMessageIds,
        addressed: Boolean(addressSignal?.triggered)
      }
    });
    bot.logSkippedReply({
      message,
      source,
      triggerMessageIds,
      addressSignal,
      generation,
      usedWebSearchFollowup,
      reason: "empty_reply_after_media",
      reaction,
      screenShareOffer,
      performance,
      prompts: replyPrompts
    });
    return { skipped: true };
  }


  return {
    skipped: false,
    reaction, memoryLine, selfMemoryLine, memorySaved, selfMemorySaved, mediaDirective,
    finalText, mentionResolution, screenShareOffer, allowMediaOnlyReply, modelProducedSkip,
    modelProducedEmpty, payload, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  };
}


export async function sendReplyMessage(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  options: ReplyAttemptOptions,
  ctx: ReplyPipelineContext,
  llmResult: ReplyActionableLlmResult,
  actionResult: ReplySendableActionResult
): Promise<true> {
  const botName = getBotName(settings);
  const {
    addressSignal, triggerMessageIds, addressed,
    isReplyChannel, source, performance,
    imageBudget, videoBudget,
    simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget,
    videoContext
  } = ctx;
  const {
    generation, typingDelayMs, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    webSearch, imageLookup, memoryLookup, replyPrompts
  } = llmResult;
  const {
    reaction, memorySaved, selfMemorySaved,
    finalText, mentionResolution, screenShareOffer, payload, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  } = actionResult;

  const shouldThreadReply = addressed || options.forceRespond;
  const canStandalonePost = isReplyChannel || !shouldThreadReply;
  const sendAsReply = bot.shouldSendAsReply({
    isReplyChannel,
    shouldThreadReply,
    replyText: finalText
  });
  const sendStartedAtMs = Date.now();
  const textChunks = splitDiscordMessage(payload.content);
  const firstPayload = { ...payload, content: textChunks[0] };
  const sent = sendAsReply
    ? await message.reply({
      ...firstPayload,
      allowedMentions: { repliedUser: false }
    })
    : await message.channel.send(firstPayload);
  for (let i = 1; i < textChunks.length; i++) {
    await message.channel.send({ content: textChunks[i] });
  }
  const sendMs = Math.max(0, Date.now() - sendStartedAtMs);
  const actionKind = sendAsReply ? "sent_reply" : "sent_message";
  const referencedMessageId = sendAsReply ? message.id : null;

  bot.markSpoke();
  bot.store.recordMessage({
    messageId: sent.id,
    createdAt: sent.createdTimestamp,
    guildId: sent.guildId,
    channelId: sent.channelId,
    authorId: bot.client.user.id,
    authorName: botName,
    isBot: true,
    content: bot.composeMessageContentForHistory(sent, finalText),
    referencedMessageId
  });
  bot.store.logAction({
    kind: actionKind,
    guildId: sent.guildId,
    channelId: sent.channelId,
    messageId: sent.id,
    userId: bot.client.user.id,
    content: finalText,
    metadata: {
      triggerMessageId: message.id,
      triggerMessageIds,
      source,
      addressing: addressSignal,
      replyPrompts,
      sendAsReply,
      canStandalonePost,
      image: {
        requestedByModel: Boolean(imagePrompt || complexImagePrompt),
        requestedSimpleByModel: Boolean(imagePrompt),
        requestedComplexByModel: Boolean(complexImagePrompt),
        selectedVariant: imageVariantUsed,
        used: imageUsed,
        blockedByDailyCap: imageBudgetBlocked,
        blockedByCapability: imageCapabilityBlocked,
        maxPerDay: imageBudget.maxPerDay,
        remainingAtPromptTime: imageBudget.remaining,
        simpleCapabilityReadyAtPromptTime: simpleImageCapabilityReady,
        complexCapabilityReadyAtPromptTime: complexImageCapabilityReady,
        capabilityReadyAtPromptTime: imageCapabilityReady
      },
      videoGeneration: {
        requestedByModel: Boolean(videoPrompt),
        used: videoUsed,
        blockedByDailyCap: videoBudgetBlocked,
        blockedByCapability: videoCapabilityBlocked,
        maxPerDay: videoBudget.maxPerDay,
        remainingAtPromptTime: videoBudget.remaining,
        capabilityReadyAtPromptTime: videoCapabilityReady
      },
      gif: {
        requestedByModel: Boolean(gifQuery),
        used: gifUsed,
        blockedByDailyCap: gifBudgetBlocked,
        blockedByConfiguration: gifConfigBlocked,
        maxPerDay: gifBudget.maxPerDay,
        remainingAtPromptTime: gifBudget.remaining
      },
      memory: {
        toolCallsUsed: usedMemoryLookupFollowup,
        saved: Boolean(memorySaved || selfMemorySaved),
        query: memoryLookup?.query || null,
        results: (memoryLookup?.results || []).map((r: Record<string, unknown>) => ({
          fact: r.fact,
          fact_type: r.fact_type,
          subject: r.subject,
          confidence: r.confidence
        }))
      },
      imageLookup: {
        requested: imageLookup.requested,
        used: imageLookup.used,
        query: imageLookup.query,
        candidateCount: imageLookup.candidates?.length || 0,
        resultCount: imageLookup.results?.length || 0,
        error: imageLookup.error || null,
        results: (imageLookup.results || []).map((r: Record<string, unknown>) => ({
          filename: r.filename,
          authorName: r.authorName,
          url: r.url,
          matchReason: r.matchReason
        }))
      },
      mentions: mentionResolution,
      reaction,
      screenShareOffer,
      webSearch: {
        requested: webSearch.requested,
        used: webSearch.used,
        query: webSearch.query,
        resultCount: webSearch.results?.length || 0,
        results: (webSearch.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          domain: r.domain
        })),
        fetchedPages: webSearch.fetchedPages || 0,
        providerUsed: webSearch.providerUsed || null,
        providerFallbackUsed: Boolean(webSearch.providerFallbackUsed),
        blockedByHourlyCap: webSearch.blockedByBudget,
        maxPerHour: webSearch.budget?.maxPerHour ?? null,
        remainingAtPromptTime: webSearch.budget?.remaining ?? null,
        configured: webSearch.configured,
        optedOutByUser: webSearch.optedOutByUser,
        error: webSearch.error || null
      },
      video: {
        requested: videoContext.requested,
        used: videoContext.used,
        detectedVideos: videoContext.detectedVideos,
        detectedFromRecentMessages: videoContext.detectedFromRecentMessages,
        fetchedVideos: videoContext.videos?.length || 0,
        extractedKeyframes: videoContext.frameImages?.length || 0,
        blockedByHourlyCap: videoContext.blockedByBudget,
        maxPerHour: videoContext.budget?.maxPerHour ?? null,
        remainingAtPromptTime: videoContext.budget?.remaining ?? null,
        enabled: videoContext.enabled,
        errorCount: videoContext.errors?.length || 0,
        videos: (videoContext.videos || []).map((v: Record<string, unknown>) => ({
          title: v.title,
          url: v.url,
          provider: v.provider,
          channel: v.channel
        }))
      },
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        costUsd: generation.costUsd,
        usedWebSearchFollowup,
        usedMemoryLookupFollowup,
        usedImageLookupFollowup
      },
      performance: finalizeReplyPerformanceSample({
        performance,
        actionKind,
        typingDelayMs,
        sendMs
      })
    }
  });

  return true;
}


export async function maybeReplyToMessagePipeline(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  options: ReplyAttemptOptions = {}
): Promise<boolean> {
  const permissions = getReplyPermissions(settings);
  if (!permissions.allowReplies) return false;
  if (!bot.canSendMessage(permissions.maxMessagesPerHour)) return false;
  if (!bot.canTalkNow(settings)) return false;

  const replyScopeKey = buildTextReplyScopeKey({
    guildId: message.guildId,
    channelId: message.channelId
  });
  const activeReply = bot.activeReplies.begin(replyScopeKey, "text-reply");
  const signal = activeReply.abortController.signal;

  try {
    throwIfAborted(signal, "Reply cancelled");
    const ctx = await buildReplyContext(bot, message, settings, options);
    if (!ctx || !ctx.shouldRun) return false;
    ctx.signal = signal;

    throwIfAborted(signal, "Reply cancelled");
    const llmResult = await executeReplyLlm(bot, message, settings, options, ctx);
    if (!isReplyActionableLlmResult(llmResult)) return true;
    const actionableLlmResult = llmResult;

    throwIfAborted(signal, "Reply cancelled");
    const actionResult = await dispatchReplyActions(bot, message, settings, options, ctx, actionableLlmResult);
    if (!isReplySendableActionResult(actionResult)) return false;
    const sendableActionResult = actionResult;

    throwIfAborted(signal, "Reply cancelled");
    return await sendReplyMessage(
      bot,
      message,
      settings,
      options,
      ctx,
      actionableLlmResult,
      sendableActionResult
    );
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      // Return true ("reply handled") so the caller does not retry or fall back
      // to another reply path after the user explicitly cancelled this turn.
      return true;
    }
    throw error;
  } finally {
    bot.activeReplies.clear(activeReply);
  }
}
