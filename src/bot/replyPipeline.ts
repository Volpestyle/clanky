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
import type { ReplyToolContext, ReplyToolRuntime, ReplyToolDefinition } from "../tools/replyTools.ts";
import {
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
import { buildRuntimeDecisionCorrelation } from "../services/runtimeCorrelation.ts";
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
import {
  resolveTextAttentionState
} from "./replyAdmission.ts";
import { loadConversationContinuityContext } from "./conversationContinuity.ts";
import { loadBehavioralMemoryFacts } from "./memorySlice.ts";
import {
  getActivitySettings,
  getAutomationsSettings,
  getBotName,
  getDiscoverySettings,
  getMemorySettings,
  getReplyPermissions,
  getVideoContextSettings,
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
import { VOICE_TOOL_SCHEMAS } from "../tools/sharedToolSchemas.ts";
import type { ReplyPipelineRuntime } from "./botContext.ts";

type ReplyPipelineAttachment = {
  url?: string;
  proxyURL?: string;
  name?: string;
  contentType?: string;
};

type ReplyPipelineAttachmentCollection = {
  size?: number;
  values: () => IterableIterator<ReplyPipelineAttachment>;
};

type ReplyPipelineEmbed = {
  url?: string;
  type?: string;
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

type ReplyMessagePayloadFile = {
  attachment: Buffer;
  name: string;
};

type ReplyMessagePayload = Record<string, unknown> & {
  content: string;
  files?: ReplyMessagePayloadFile[];
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
  reference?: {
    messageId?: string;
  } | null;
  referencedMessage?: {
    id?: string;
  } | null;
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
type ReplyVideoInput = Record<string, unknown> & {
  url?: string;
  filename?: string;
  contentType?: string;
  videoRef?: string;
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
type ReplyScreenShareOffer = Awaited<ReturnType<ReplyPipelineRuntime["maybeHandleScreenWatchIntent"]>>;
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
  reactivity: number;
  isReplyChannel: boolean;
  ambientReplyEagerness: number;
  responseWindowEagerness: number;
  recentReplyWindowActive: boolean;
  reactionEmojiOptions: string[];
  source: string;
  performance: ReplyPerformance;
  memorySlice: ReplyContinuityContext["memorySlice"];
  replyMediaMemoryFacts: ReturnType<ReplyPipelineRuntime["buildMediaMemoryFacts"]>;
  attachmentImageInputs: ReplyImageInput[];
  attachmentVideoInputs: ReplyVideoInput[];
  videoLookupRefs: Record<string, string>;
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
  memoryLookup: ReturnType<ReplyPipelineRuntime["buildMemoryLookupContext"]>;
  modelImageInputs: ReplyImageInput[];
  imageLookup: ReturnType<ReplyPipelineRuntime["buildImageLookupContext"]>;
  replyTrace: ReplyTrace;
  screenShareCapability: ReturnType<ReplyPipelineRuntime["getVoiceScreenWatchCapability"]>;
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
  mediaPromptLimit: number;
  replyDirective: ReplyDirective;
  webSearch: ReplyWebSearchState;
  browserBrowse: ReturnType<ReplyPipelineRuntime["buildBrowserBrowseContext"]>;
  memoryLookup: ReturnType<ReplyPipelineRuntime["buildMemoryLookupContext"]>;
  imageLookup: ReturnType<ReplyPipelineRuntime["buildImageLookupContext"]>;
  modelImageInputs: ReplyImageInput[];
  toolResultImageInputs: ReplyImageInput[];
  replyPrompts: ReplyPrompts;
};

type ReplyLlmResult = ReplyIntentHandledResult | ReplyActionableLlmResult;

type ReplySkippedActionResult = {
  skipped: true;
};

type ReplySendableActionResult = {
  skipped: false;
  reaction: ReplyReactionResult;
  mediaDirective: ReplyMediaDirective;
  finalText: string;
  mentionResolution: ReplyMentionResolution;
  screenShareOffer: ReplyScreenShareOffer;
  allowMediaOnlyReply: boolean;
  modelProducedSkip: boolean;
  modelProducedEmpty: boolean;
  payload: ReplyMessagePayload;
  toolImagesUsed: boolean;
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

function logReplyPipelineGate(
  bot: ReplyPipelineRuntime,
  {
    message,
    settings,
    options,
    allow,
    reason,
    sendBudgetAllowed = null,
    talkNowAllowed = null,
    ctx = null
  }: {
    message: ReplyPipelineMessage;
    settings: Settings;
    options: ReplyAttemptOptions;
    allow: boolean;
    reason: string;
    sendBudgetAllowed?: boolean | null;
    talkNowAllowed?: boolean | null;
    ctx?: ReplyPipelineContext | null;
  }
) {
  const triggerMessageIds = [
    ...new Set(
      [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ];
  const source = String(options.source || "message_event").trim() || "message_event";
  const triggerMessageId = triggerMessageIds[0] || String(message.id || "").trim() || null;
  const isReplyChannel = bot.isReplyChannel(settings, message.channelId);
  const addressSignal = options.addressSignal && typeof options.addressSignal === "object"
    ? options.addressSignal
    : null;

  bot.store.logAction({
    kind: "text_runtime",
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id || null,
    content: "reply_pipeline_gate",
    metadata: {
      ...buildRuntimeDecisionCorrelation({
        botId: bot.client.user?.id || null,
        triggerMessageId,
        source,
        stage: "pipeline",
        allow,
        reason
      }),
      triggerMessageIds,
      forceRespond: Boolean(options.forceRespond),
      forceDecisionLoop: Boolean(options.forceDecisionLoop),
      isReplyChannel,
      sendBudgetAllowed,
      talkNowAllowed,
      ctxBuilt: Boolean(ctx),
      ctxShouldRun: ctx ? Boolean(ctx.shouldRun) : null,
      addressed: ctx ? Boolean(ctx.addressed) : null,
      addressSignal: addressSignal
        ? {
            direct: Boolean(addressSignal.direct),
            inferred: Boolean(addressSignal.inferred),
            triggered: Boolean(addressSignal.triggered),
            reason: String(addressSignal.reason || "llm_decides"),
            confidence: Math.max(0, Math.min(1, Number(addressSignal.confidence) || 0)),
            threshold: Math.max(0.4, Math.min(0.95, Number(addressSignal.threshold) || 0.62)),
            confidenceSource: String(addressSignal.confidenceSource || "fallback")
          }
        : null
    }
  });
}

function buildReplyToolAvailabilityState(
  settings: Settings,
  {
    webSearch,
    browserBrowse,
    imageLookup
  }: Pick<ReplyPipelineContext, "webSearch" | "browserBrowse" | "imageLookup">
): {
  tools: ReplyToolDefinition[];
  capabilities: {
    webSearchAvailable?: boolean;
    webScrapeAvailable?: boolean;
    browserBrowseAvailable?: boolean;
    memoryAvailable?: boolean;
    imageLookupAvailable?: boolean;
    codeAgentAvailable?: boolean;
    voiceToolsAvailable?: boolean;
  };
  includedTools: string[];
  excludedTools: Array<{ name: string; reason: string }>;
} {
  const memoryEnabled = Boolean(getMemorySettings(settings).enabled);
  const voiceEnabled = Boolean(getVoiceSettings(settings).enabled);
  const codeAgentEnabled = isDevTaskEnabled(settings);

  const webSearchReason =
    !webSearch?.enabled
      ? "settings_disabled"
      : !webSearch?.configured
        ? "provider_unconfigured"
        : webSearch?.optedOutByUser
          ? "opted_out_by_user"
          : webSearch?.blockedByBudget
            ? "budget_blocked"
            : webSearch?.budget?.canSearch === false
              ? "budget_exhausted"
              : "available";
  const browserBrowseReason =
    !browserBrowse?.enabled
      ? "settings_disabled"
      : !browserBrowse?.configured
        ? "runtime_unavailable"
        : browserBrowse?.blockedByBudget
          ? "budget_blocked"
          : browserBrowse?.budget?.canBrowse === false
            ? "budget_exhausted"
            : "available";
  const imageLookupReason =
    imageLookup?.enabled
      ? "available"
      : imageLookup?.error
        ? "lookup_error"
        : "no_history_images";
  const memoryReason = memoryEnabled ? "available" : "settings_disabled";
  const codeTaskReason = codeAgentEnabled ? "available" : "settings_disabled";
  const voiceToolReason = voiceEnabled ? "available" : "settings_disabled";

  const videoContextEnabled = Boolean(getVideoContextSettings(settings).enabled);
  const videoContextReason = videoContextEnabled ? "available" : "settings_disabled";

  const capabilities = {
    webSearchAvailable: webSearchReason === "available",
    webScrapeAvailable: webSearchReason === "available",
    browserBrowseAvailable: browserBrowseReason === "available",
    memoryAvailable: memoryReason === "available",
    imageLookupAvailable: imageLookupReason === "available",
    videoContextAvailable: videoContextReason === "available",
    codeAgentAvailable: codeTaskReason === "available",
    voiceToolsAvailable: voiceToolReason === "available"
  };
  const tools = buildReplyToolSet(settings, capabilities);
  const includedSet = new Set(tools.map((tool) => String(tool.name || "").trim()).filter(Boolean));
  const candidates: Array<{ name: string; reason: string }> = [
    { name: "web_search", reason: webSearchReason },
    { name: "web_scrape", reason: webSearchReason },
    { name: "browser_browse", reason: browserBrowseReason },
    { name: "memory_search", reason: memoryReason },
    { name: "memory_write", reason: memoryReason },
    { name: "conversation_search", reason: "available" },
    { name: "image_lookup", reason: imageLookupReason },
    { name: "code_task", reason: codeTaskReason },
    ...VOICE_TOOL_SCHEMAS.map((schema) => ({
      name: schema.name,
      reason: voiceToolReason
    }))
  ];

  return {
    tools,
    capabilities,
    includedTools: candidates
      .map((candidate) => candidate.name)
      .filter((name, index, values) => values.indexOf(name) === index && includedSet.has(name)),
    excludedTools: candidates
      .filter((candidate, index, values) =>
        values.findIndex((entry) => entry.name === candidate.name) === index &&
        !includedSet.has(candidate.name)
      )
      .map((candidate) => ({
        name: candidate.name,
        reason: candidate.reason
      }))
  };
}

function logReplyToolAvailability(
  bot: ReplyPipelineRuntime,
  {
    message,
    options,
    includedTools,
    excludedTools,
    capabilities
  }: {
    message: ReplyPipelineMessage;
    options: ReplyAttemptOptions;
    includedTools: string[];
    excludedTools: Array<{ name: string; reason: string }>;
    capabilities: {
      webSearchAvailable?: boolean;
      webScrapeAvailable?: boolean;
      browserBrowseAvailable?: boolean;
      memoryAvailable?: boolean;
      imageLookupAvailable?: boolean;
      codeAgentAvailable?: boolean;
      voiceToolsAvailable?: boolean;
    };
  }
) {
  const triggerMessageIds = [
    ...new Set(
      [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ];
  const source = String(options.source || "message_event").trim() || "message_event";
  const triggerMessageId = triggerMessageIds[0] || String(message.id || "").trim() || null;
  bot.store.logAction({
    kind: "text_runtime",
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id || null,
    content: "reply_tool_availability",
    metadata: {
      ...buildRuntimeDecisionCorrelation({
        botId: bot.client.user?.id || null,
        triggerMessageId,
        source,
        stage: "tool_availability",
        allow: includedTools.length > 0,
        reason: includedTools.length > 0 ? "tools_available" : "no_tools_available"
      }),
      triggerMessageIds,
      includedToolCount: includedTools.length,
      excludedToolCount: excludedTools.length,
      includedTools,
      excludedTools,
      capabilities
    }
  });
}



async function buildReplyContext(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  options: ReplyAttemptOptions
): Promise<ReplyPipelineContext | false> {
  const memorySettings = getMemorySettings(settings);
  const activity = getActivitySettings(settings);
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
  const reactivity = clamp(Number(activity.reactivity) || 0, 0, 100);
  const isReplyChannel = bot.isReplyChannel(settings, message.channelId);
  const ambientReplyEagerness = clamp(
    Number(activity.ambientReplyEagerness) || 0,
    0,
    100
  );
  const responseWindowEagerness = clamp(
    Number(activity.responseWindowEagerness) || 0,
    0,
    100
  );
  const textAttentionState = resolveTextAttentionState({
    botUserId: bot.client.user?.id || null,
    settings,
    recentMessages,
    addressSignal,
    triggerMessageId: message.id,
    triggerAuthorId: message.author?.id || null,
    triggerReferenceMessageId:
      message.reference?.messageId || message.referencedMessage?.id || null
  });
  const recentReplyWindowActive = textAttentionState.recentReplyWindowActive;
  const reactionEmojiOptions = [
    ...new Set([...bot.getReactionEmojiOptions(message.guild), ...UNICODE_REACTIONS])
  ];

  const shouldRunDecisionLoop = bot.shouldAttemptReplyDecision({
    settings,
    recentMessages,
    addressSignal,
    isReplyChannel,
    forceRespond: Boolean(options.forceRespond),
    forceDecisionLoop: Boolean(options.forceDecisionLoop),
    triggerMessageId: message.id,
    triggerAuthorId: message.author?.id || null,
    triggerReferenceMessageId:
      message.reference?.messageId || message.referencedMessage?.id || null
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
    loadRecentConversationHistory: (payload) => bot.getConversationHistoryForPrompt(payload)
  });
  const memorySlice = continuity.memorySlice;
  const behavioralFacts = await loadBehavioralMemoryFacts(bot, {
    settings,
    guildId: message.guildId,
    channelId: message.channelId,
    queryText: message.content,
    participantIds: Array.isArray(memorySlice?.participantProfiles)
      ? memorySlice.participantProfiles
          .map((entry) => String((entry as Record<string, unknown>)?.userId || "").trim())
          .filter(Boolean)
      : [],
    trace: {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      source: "reply_pipeline_behavioral_memory"
    },
    limit: 8
  });
  performance.memorySliceMs = Math.max(0, Date.now() - memorySliceStartedAtMs);
  const replyMediaMemoryFacts = bot.buildMediaMemoryFacts({
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts
  });
  const attachmentImageInputs: ReplyImageInput[] = bot.getImageInputs(message);
  const attachmentVideoInputs: ReplyVideoInput[] = (bot.getVideoInputs(message) || [])
    .map((video, index) => ({
      ...video,
      videoRef: `VID ${index + 1}`
    }));
  const videoLookupRefs = Object.fromEntries(
    attachmentVideoInputs
      .map((video) => [
        String(video.videoRef || "").trim(),
        String(video.url || "").trim()
      ])
      .filter(([videoRef, url]) => Boolean(videoRef && url))
  );
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
  const recentConversationHistory = continuity.recentConversationHistory;
  const memoryLookup = bot.buildMemoryLookupContext({ settings });
  const modelImageInputs: ReplyImageInput[] = [
    ...attachmentImageInputs
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
  const screenShareCapability = bot.getVoiceScreenWatchCapability({
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

  const systemPrompt = buildSystemPrompt(settings);
  const replyPromptBase: ReplyPromptBase = {
    message: {
      authorName: message.member?.displayName || message.author.username,
      content: message.content
    },
    triggerMessageIds,
    imageInputs: modelImageInputs,
    recentMessages,
    participantProfiles: memorySlice.participantProfiles,
    selfFacts: memorySlice.selfFacts,
    loreFacts: memorySlice.loreFacts,
    guidanceFacts: Array.isArray(memorySlice.guidanceFacts) ? memorySlice.guidanceFacts : [],
    behavioralFacts,
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
    ambientReplyEagerness,
    responseWindowEagerness,
    recentReplyWindowActive,
    textAttentionMode: textAttentionState.mode,
    textAttentionReason: textAttentionState.reason,
    reactivity,
    addressing: {
      directlyAddressed: addressed,
      directAddressConfidence: Number(addressSignal?.confidence) || 0,
      directAddressThreshold: Number(addressSignal?.threshold) || 0.62,
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
    screenShare: screenShareCapability,
    channelMode: isReplyChannel
      ? "reply_channel"
      : bot.isDiscoveryChannel(settings, message.channelId)
        ? "discovery_channel"
        : "other_channel",
    maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
    mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
  };
  const initialUserPrompt = buildReplyPrompt({
    ...replyPromptBase,
    imageInputs: modelImageInputs,
    videoInputs: attachmentVideoInputs,
    webSearch,
    browserBrowse,
    memoryLookup,
    imageLookup
  });
  const replyPromptCapture = createReplyPromptCapture({
    systemPrompt,
    initialUserPrompt
  });
  const replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, 0);

  return {
    shouldRun: true,
    recentMessages, addressSignal, triggerMessageIds, addressed, reactivity,
    isReplyChannel, ambientReplyEagerness, responseWindowEagerness, recentReplyWindowActive,
    reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, attachmentVideoInputs, videoLookupRefs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, webSearch, browserBrowse, recentConversationHistory, memoryLookup,
    modelImageInputs, imageLookup, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicState, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture, replyPrompts
  };
}


async function executeReplyLlm(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  options: ReplyAttemptOptions,
  ctx: ReplyPipelineContext
): Promise<ReplyLlmResult> {
  const {
    addressSignal, triggerMessageIds, source, performance, signal,
    replyTrace, systemPrompt, initialUserPrompt, replyPromptCapture,
    activeVoiceSession, inVoiceChannelNow, videoLookupRefs
  } = ctx;
  let { webSearch, browserBrowse, memoryLookup, modelImageInputs, imageLookup, replyPrompts } = ctx;

  const replyToolAvailability = buildReplyToolAvailabilityState(settings, {
    webSearch,
    browserBrowse,
    imageLookup
  });
  const replyTools = replyToolAvailability.tools;
  logReplyToolAvailability(bot, {
    message,
    options,
    includedTools: replyToolAvailability.includedTools,
    excludedTools: replyToolAvailability.excludedTools,
    capabilities: replyToolAvailability.capabilities
  });

  const activeVoiceCallbacks = inVoiceChannelNow && activeVoiceSession
    ? bot.voiceSessionManager.buildVoiceToolCallbacks({ session: activeVoiceSession, settings })
    : null;

  const replyToolRuntime: ReplyToolRuntime = {
    search: bot.search,
    video: bot.video ? {
      fetchContext: async ({ url, settings: toolSettings, trace }) => {
        const videoContextSettings = getVideoContextSettings(toolSettings);
        const targets = bot.video.extractVideoTargets(url, 1);
        if (!targets.length) {
          // URL didn't match a known video host — fall through with a generic target
          targets.push({
            key: `generic:${url}`,
            url,
            kind: "generic",
            provider: "generic",
            videoId: null
          });
        }
        const result = await bot.video.fetchContexts({
          targets,
          maxTranscriptChars: Number(videoContextSettings.maxTranscriptChars) || 1200,
          keyframeIntervalSeconds: Number(videoContextSettings.keyframeIntervalSeconds) || 0,
          maxKeyframesPerVideo: Number(videoContextSettings.maxKeyframesPerVideo) || 0,
          allowAsrFallback: Boolean(videoContextSettings.allowAsrFallback),
          maxAsrSeconds: Number(videoContextSettings.maxAsrSeconds) || 120,
          trace
        });
        if (result.errors?.length && !result.videos?.length) {
          return {
            text: `Video context extraction failed for ${url}: ${result.errors[0]?.error || "unknown error"}. Try web_scrape or browser_browse as fallback.`,
            isError: true
          };
        }
        const video = result.videos?.[0];
        if (!video) {
          return {
            text: `No video metadata could be extracted from ${url}. Try web_scrape or browser_browse instead.`,
            isError: true
          };
        }
        const lines: string[] = [];
        lines.push(`Provider: ${video.provider || "unknown"}`);
        lines.push(`Title: ${video.title || "untitled"}`);
        lines.push(`Channel: ${video.channel || "unknown"}`);
        if (video.url) lines.push(`URL: ${video.url}`);
        if (video.publishedAt) lines.push(`Published: ${video.publishedAt}`);
        if (video.durationSeconds) lines.push(`Duration: ${video.durationSeconds}s`);
        if (video.viewCount) lines.push(`Views: ${video.viewCount}`);
        if (video.description) lines.push(`Description: ${video.description}`);
        if (video.transcript) lines.push(`Transcript (${video.transcriptSource || "unknown source"}): ${video.transcript}`);
        if (video.transcriptError) lines.push(`Transcript error: ${video.transcriptError}`);
        if (video.keyframeError) lines.push(`Keyframe error: ${video.keyframeError}`);
        const frameImages = video.frameImages || [];
        if (frameImages.length) lines.push(`Keyframes: ${frameImages.length} frame(s) attached`);
        return {
          text: lines.join("\n"),
          imageInputs: frameImages.length ? frameImages : undefined
        };
      }
    } : undefined,
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
      runTask: async ({ settings: toolSettings, task, role, cwd, guildId, channelId, userId, source }) =>
        await bot.runModelRequestedCodeTask({
          settings: toolSettings,
          task,
          role,
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
    subAgentSessions: bot.buildSubAgentSessionsRuntime(),
    backgroundCodeTasks: {
      dispatch: (args) => bot.dispatchBackgroundCodeTask(args)
    },
    voiceSession: activeVoiceCallbacks || undefined,
    voiceJoin: Boolean(getVoiceSettings(settings).enabled) && bot.voiceSessionManager
      ? async () => {
        try {
          const joined = await bot.voiceSessionManager.requestJoin({
            message,
            settings,
            intentConfidence: 1
          });
          if (!joined) {
            return { ok: false, reason: "join_not_handled" };
          }
          const session = bot.voiceSessionManager.getSession(message.guildId);
          if (!session || session.ending) {
            return { ok: false, reason: "session_not_available_after_join" };
          }
          const callbacks = bot.voiceSessionManager.buildVoiceToolCallbacks({ session, settings });
          const voiceChannelId = String(session.voiceChannelId || "");
          const guild = bot.client.guilds?.cache?.get(message.guildId);
          const voiceChannel = voiceChannelId && guild?.channels?.cache?.get(voiceChannelId);
          const voiceChannelName = String(voiceChannel?.name || voiceChannelId || "voice channel");
          return { ok: true, voiceSession: callbacks, voiceChannelName };
        } catch (error) {
          return { ok: false, reason: String((error as Error)?.message || error) };
        }
      }
      : undefined
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
    videoLookup: {
      refs: videoLookupRefs
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
  let toolResultImageInputs: ReplyImageInput[] = [];
  const REPLY_TOOL_LOOP_MAX_STEPS = 2;
  const REPLY_TOOL_LOOP_MAX_CALLS = 3;
  let replyToolLoopSteps = 0;
  let replyTotalToolCalls = 0;
  const followupStartedAtMs = Date.now();

  while (
    generation.toolCalls?.length > 0 &&
    replyToolLoopSteps < REPLY_TOOL_LOOP_MAX_STEPS &&
    replyTotalToolCalls < REPLY_TOOL_LOOP_MAX_CALLS
  ) {
    throwIfAborted(signal, "Reply cancelled");
    const assistantContent = buildContextContentBlocks(generation.rawContent, generation.text);
    // On the first iteration, seed the context with the original user prompt.
    // On subsequent iterations the prompt is already in the history — don't duplicate it.
    if (replyContextMessages.length === 0) {
      replyContextMessages = [
        { role: "user", content: initialUserPrompt },
        { role: "assistant", content: assistantContent }
      ];
    } else {
      replyContextMessages = [
        ...replyContextMessages,
        { role: "assistant", content: assistantContent }
      ];
    }

    const toolResultMessages: ContentBlock[] = [];
    let toolResultImageInputsAdded = false;
    const mergeToolResultImages = (extraInputs: ReplyImageInput[] | undefined) => {
      if (!Array.isArray(extraInputs) || extraInputs.length === 0 || typeof bot.mergeImageInputs !== "function") {
        return false;
      }
      modelImageInputs = bot.mergeImageInputs({
        baseInputs: modelImageInputs,
        extraInputs,
        maxInputs: MAX_MODEL_IMAGE_INPUTS
      });
      toolResultImageInputs = bot.mergeImageInputs({
        baseInputs: toolResultImageInputs,
        extraInputs,
        maxInputs: MAX_MODEL_IMAGE_INPUTS
      });
      return true;
    };

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
        if (mergeToolResultImages(result?.imageInputs)) {
          toolResultImageInputsAdded = true;
        }
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

      if (mergeToolResultImages(result?.imageInputs)) {
        toolResultImageInputsAdded = true;
      }

      if (toolCall.name === "memory_search" && !result.isError) {
        usedMemoryLookupFollowup = true;
      } else if (toolCall.name === "image_lookup" && !result.isError) {
        const imageLookupRequest = String(toolInput.imageId || toolInput.query || "");
        imageLookup = await bot.runModelRequestedImageLookup({
          imageLookup,
          query: imageLookupRequest
        });
        if (mergeToolResultImages(imageLookup.selectedImageInputs || [])) {
          toolResultImageInputsAdded = true;
        }
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
    const toolLoopUserPrompt = toolResultImageInputsAdded
      ? "Attached are images returned by the previous tool call. Use them if they help. If you want to include those exact images in the final Discord reply, set media to {\"type\":\"tool_images\",\"prompt\":null}."
      : "";
    appendReplyFollowupPrompt(replyPromptCapture, toolLoopUserPrompt);
    generation = await bot.llm.generate({
      settings: followupGenerationSettings,
      systemPrompt,
      userPrompt: toolLoopUserPrompt,
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
  const replyDirective = parseStructuredReplyOutput(generation.text, mediaPromptLimit);
  replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, replyToolLoopSteps);

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

  if (
    replyToolLoopSteps > 0 ||
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
    mediaPromptLimit, replyDirective,
    webSearch, browserBrowse, memoryLookup, imageLookup, modelImageInputs, toolResultImageInputs, replyPrompts
  };
}


async function dispatchReplyActions(
  bot: ReplyPipelineRuntime,
  message: ReplyPipelineMessage,
  settings: Settings,
  _options: ReplyAttemptOptions,
  ctx: ReplyPipelineContext,
  llmResult: ReplyActionableLlmResult
): Promise<ReplyActionResult> {
  const discovery = getDiscoverySettings(settings);
  const {
    addressSignal, triggerMessageIds, reactionEmojiOptions, source, performance,
    replyMediaMemoryFacts
  } = ctx;
  const {
    generation, usedWebSearchFollowup, mediaPromptLimit, replyDirective,
    webSearch, toolResultImageInputs, replyPrompts
  } = llmResult;
  if (replyDirective.parseState === "unstructured") {
    const recoveredText = sanitizeBotText(String(generation.text || ""));
    if (recoveredText) {
      replyDirective.text = recoveredText;
      bot.store.logAction({
        kind: "bot_warning",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: bot.client.user?.id || null,
        content: "structured_output_recovered_as_prose",
        metadata: { source, parseState: replyDirective.parseState }
      });
    } else {
      bot.logSkippedReply({
        message,
        source,
        triggerMessageIds,
        addressSignal,
        generation,
        usedWebSearchFollowup,
        reason: "invalid_structured_output",
        reaction: null,
        screenShareOffer: null,
        performance,
        prompts: replyPrompts,
        extraMetadata: {
          rawTextPreview: sanitizeBotText(String(generation.text || ""), 280) || null
        }
      });
      return { skipped: true };
    }
  }

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

  const mediaDirective = pickReplyMediaDirective(replyDirective);
  let finalText = sanitizeBotText(replyDirective.text || "");
  let mentionResolution = emptyMentionResolution();
  finalText = normalizeSkipSentinel(finalText);
  const screenShareOffer = await bot.maybeHandleScreenWatchIntent({
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
  let toolImagesUsed = false;
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
    toolImageInputs: toolResultImageInputs,
    trace: {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      source: "reply_message"
    }
  });
  payload = mediaAttachment.payload;
  toolImagesUsed = mediaAttachment.toolImagesUsed;
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

  if (!finalText && !toolImagesUsed && !imageUsed && !videoUsed && !gifUsed) {
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
    reaction, mediaDirective,
    finalText, mentionResolution, screenShareOffer, allowMediaOnlyReply, modelProducedSkip,
    modelProducedEmpty, payload, toolImagesUsed, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  };
}


async function sendReplyMessage(
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
    videoCapabilityReady, gifBudget
  } = ctx;
  const {
    generation, typingDelayMs, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    toolResultImageInputs,
    webSearch, imageLookup, memoryLookup, replyPrompts
  } = llmResult;
  const {
    reaction, mediaDirective,
    finalText, mentionResolution, screenShareOffer, payload, toolImagesUsed, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  } = actionResult;

  const shouldThreadReply = addressed;
  const isDiscovery = bot.isDiscoveryChannel(settings, message.channelId);
  const canStandalonePost = isReplyChannel || isDiscovery || !shouldThreadReply;
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
  const memorySettings = getMemorySettings(settings);

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
  if (memorySettings.enabled && typeof bot.memory?.ingestMessage === "function") {
    void bot.memory.ingestMessage({
      messageId: sent.id,
      authorId: bot.client.user.id,
      authorName: botName,
      content: finalText,
      isBot: true,
      settings,
      trace: {
        guildId: sent.guildId,
        channelId: sent.channelId,
        userId: bot.client.user.id,
        source: "text_reply_memory_ingest"
      }
    }).catch((error) => {
      bot.store.logAction({
        kind: "bot_error",
        guildId: sent.guildId,
        channelId: sent.channelId,
        messageId: sent.id,
        userId: bot.client.user.id,
        content: `memory_text_reply_ingest: ${String(error?.message || error)}`
      });
    });
  }
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
      toolImages: {
        requestedByModel: mediaDirective?.type === "tool_images",
        availableFromTools: toolResultImageInputs.length,
        used: toolImagesUsed
      },
      memory: {
        toolCallsUsed: usedMemoryLookupFollowup,
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
        mode: "agent_tool"
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
  if (!permissions.allowReplies) {
    logReplyPipelineGate(bot, {
      message,
      settings,
      options,
      allow: false,
      reason: "replies_disabled",
      sendBudgetAllowed: null,
      talkNowAllowed: null
    });
    return false;
  }
  const sendBudgetAllowed = bot.canSendMessage(permissions.maxMessagesPerHour);
  if (!sendBudgetAllowed) {
    logReplyPipelineGate(bot, {
      message,
      settings,
      options,
      allow: false,
      reason: "send_budget_blocked",
      sendBudgetAllowed,
      talkNowAllowed: null
    });
    return false;
  }
  const talkNowAllowed = bot.canTalkNow(settings);
  if (!talkNowAllowed) {
    logReplyPipelineGate(bot, {
      message,
      settings,
      options,
      allow: false,
      reason: "talk_now_blocked",
      sendBudgetAllowed,
      talkNowAllowed
    });
    return false;
  }

  const replyScopeKey = buildTextReplyScopeKey({
    guildId: message.guildId,
    channelId: message.channelId
  });
  const activeReply = bot.activeReplies.begin(replyScopeKey, "text-reply");
  const signal = activeReply.abortController.signal;

  try {
    throwIfAborted(signal, "Reply cancelled");
    const ctx = await buildReplyContext(bot, message, settings, options);
    if (!ctx || !ctx.shouldRun) {
      logReplyPipelineGate(bot, {
        message,
        settings,
        options,
        allow: false,
        reason: "context_unavailable",
        sendBudgetAllowed,
        talkNowAllowed,
        ctx: ctx || null
      });
      return false;
    }
    ctx.signal = signal;
    logReplyPipelineGate(bot, {
      message,
      settings,
      options,
      allow: true,
      reason: "ready",
      sendBudgetAllowed,
      talkNowAllowed,
      ctx
    });

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
