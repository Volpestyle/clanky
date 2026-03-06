import type { ClankerBot } from "../bot.ts";
import {
  buildSubAgentSessionsRuntime as buildSubAgentSessionsRuntimeForAgentTasks,
  runModelRequestedBrowserBrowse as runModelRequestedBrowserBrowseForAgentTasks,
  runModelRequestedCodeTask as runModelRequestedCodeTaskForAgentTasks
} from "./agentTasks.ts";
import {
  buildBrowserBrowseContext as buildBrowserBrowseContextForBudgetTracking,
  buildImageLookupContext as buildImageLookupContextForBudgetTracking,
  buildMemoryLookupContext as buildMemoryLookupContextForBudgetTracking,
  buildVideoReplyContext as buildVideoReplyContextForBudgetTracking,
  buildWebSearchContext as buildWebSearchContextForBudgetTracking,
  getGifBudgetState as getGifBudgetStateForBudgetTracking,
  getImageBudgetState as getImageBudgetStateForBudgetTracking,
  getMediaGenerationCapabilities as getMediaGenerationCapabilitiesForBudgetTracking,
  getVideoGenerationBudgetState as getVideoGenerationBudgetStateForBudgetTracking
} from "./budgetTracking.ts";
import type {
  AgentContext,
  BotContext,
  BudgetContext,
  MediaAttachmentContext,
  QueueGatewayRuntime,
  ReplyPipelineRuntime,
  VoiceReplyRuntime
} from "./botContext.ts";
import type { AutomationEngineRuntime } from "./automationEngine.ts";
import {
  captionRecentHistoryImages as captionRecentHistoryImagesForImageAnalysis,
  mergeImageInputs as mergeImageInputsForImageAnalysis,
  runModelRequestedImageLookup as runModelRequestedImageLookupForImageAnalysis
} from "./imageAnalysis.ts";
import {
  resolveMediaAttachment as resolveMediaAttachmentForMediaAttachment,
  maybeAttachReplyGif as maybeAttachReplyGifForMediaAttachment,
  maybeAttachGeneratedImage as maybeAttachGeneratedImageForMediaAttachment,
  maybeAttachGeneratedVideo as maybeAttachGeneratedVideoForMediaAttachment
} from "./mediaAttachment.ts";
import {
  composeMessageContentForHistory as composeMessageContentForHistoryForMessageHistory,
  getConversationHistoryForPrompt as getConversationHistoryForPromptForMessageHistory,
  getImageInputs as getImageInputsForMessageHistory,
  getRecentLookupContextForPrompt as getRecentLookupContextForPromptForMessageHistory,
  rememberRecentLookupContext as rememberRecentLookupContextForMessageHistory
} from "./messageHistory.ts";
import {
  buildMediaMemoryFacts as buildMediaMemoryFactsForMemorySlice,
  loadPromptMemorySlice as loadPromptMemorySliceForMemorySlice,
  loadRelevantMemoryFacts as loadRelevantMemoryFactsForMemorySlice
} from "./memorySlice.ts";
import {
  isChannelAllowed as isChannelAllowedForPermissions,
  isReplyChannel as isReplyChannelForPermissions,
  isUserBlocked as isUserBlockedForPermissions
} from "./permissions.ts";
import {
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  hasBotMessageInRecentWindow as hasBotMessageInRecentWindowForReplyAdmission,
  shouldAttemptReplyDecision as shouldAttemptReplyDecisionForReplyAdmission
} from "./replyAdmission.ts";
import type { DiscoveryEngineRuntime } from "./discoveryEngine.ts";
import {
  getVoiceScreenShareCapability as getVoiceScreenShareCapabilityForScreenShare,
  maybeHandleScreenShareOfferIntent as maybeHandleScreenShareOfferIntentForScreenShare,
  offerVoiceScreenShareLink as offerVoiceScreenShareLinkForScreenShare,
} from "./screenShare.ts";
import type { ScreenShareRuntime } from "./screenShare.ts";
import type { TextThoughtLoopRuntime } from "./textThoughtLoop.ts";
import type { VoiceCoordinationRuntime } from "./voiceCoordination.ts";
import {
  composeVoiceOperationalMessage as composeVoiceOperationalMessageForVoiceCoordination
} from "./voiceCoordination.ts";

type ReplyPipelineFactoryDeps = {
  captionTimestamps: number[];
  unsolicitedReplyContextWindow: number;
};

function createBotContext(bot: ClankerBot): BotContext {
  return {
    appConfig: bot.appConfig,
    store: bot.store,
    llm: bot.llm,
    memory: bot.memory,
    client: bot.client,
    botUserId: String(bot.client.user?.id || "").trim() || null
  };
}

function createAgentContext(bot: ClankerBot, botContext: BotContext): AgentContext {
  return {
    ...botContext,
    browserManager: bot.browserManager,
    activeBrowserTasks: bot.activeBrowserTasks,
    subAgentSessions: bot.subAgentSessions
  };
}

function createBudgetContext(bot: ClankerBot, botContext: BotContext): BudgetContext {
  return {
    ...botContext,
    search: bot.search,
    video: bot.video,
    browserManager: bot.browserManager,
    imageCaptionCache: bot.imageCaptionCache
  };
}

function createMediaAttachmentContext(
  bot: ClankerBot,
  budgetContext: BudgetContext
): MediaAttachmentContext {
  return {
    ...budgetContext,
    gifs: bot.gifs
  };
}

function composeHistoryMessageContent(message: unknown, baseText?: string) {
  return composeMessageContentForHistoryForMessageHistory(message as Parameters<
    typeof composeMessageContentForHistoryForMessageHistory
  >[0], baseText);
}

function markSpoke(bot: ClankerBot) {
  bot.lastBotMessageAt = Date.now();
}

export function buildBotContext(bot: ClankerBot): BotContext {
  return createBotContext(bot);
}

export function buildAgentContext(bot: ClankerBot): AgentContext {
  return createAgentContext(bot, createBotContext(bot));
}

export function buildBudgetContext(bot: ClankerBot): BudgetContext {
  return createBudgetContext(bot, createBotContext(bot));
}

export function buildMediaAttachmentContext(bot: ClankerBot): MediaAttachmentContext {
  return createMediaAttachmentContext(bot, createBudgetContext(bot, createBotContext(bot)));
}

export function buildScreenShareRuntime(bot: ClankerBot): ScreenShareRuntime {
  return {
    ...createBotContext(bot),
    screenShareSessionManager: bot.screenShareSessionManager,
    composeVoiceOperationalMessage: (payload) =>
      composeVoiceOperationalMessageForVoiceCoordination(buildVoiceCoordinationRuntime(bot), {
        settings: null,
        ...payload
      })
  };
}

export function buildVoiceCoordinationRuntime(bot: ClankerBot): VoiceCoordinationRuntime {
  return {
    ...createBotContext(bot),
    client: bot.client,
    voiceSessionManager: bot.voiceSessionManager,
    toVoiceReplyRuntime: () => buildVoiceReplyRuntime(bot)
  };
}

export function buildDiscoveryEngineRuntime(bot: ClankerBot): DiscoveryEngineRuntime {
  const botContext = createBotContext(bot);
  const budgetContext = createBudgetContext(bot, botContext);
  const mediaAttachmentContext = createMediaAttachmentContext(bot, budgetContext);
  const runtime: DiscoveryEngineRuntime = {
    ...botContext,
    client: bot.client,
    discovery: bot.discovery,
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    canTalkNow: (settings) => bot.canTalkNow(settings),
    hydrateRecentMessages: (channel, limit) => bot.hydrateRecentMessages(channel, limit),
    loadRelevantMemoryFacts: (payload) =>
      loadRelevantMemoryFactsForMemorySlice(
        botContext,
        payload as Parameters<typeof loadRelevantMemoryFactsForMemorySlice>[1]
      ),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    getImageBudgetState: (settings) =>
      getImageBudgetStateForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getImageBudgetStateForBudgetTracking>[1]
      ),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetStateForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getVideoGenerationBudgetStateForBudgetTracking>[1]
      ),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilitiesForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getMediaGenerationCapabilitiesForBudgetTracking>[1]
      ),
    getEmojiHints: (guild) => bot.getEmojiHints(guild),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachmentForMediaAttachment(
        mediaAttachmentContext,
        payload as Parameters<typeof resolveMediaAttachmentForMediaAttachment>[1]
      ),
    composeMessageContentForHistory: (message, baseText) =>
      composeHistoryMessageContent(message, baseText),
    markSpoke: () => {
      markSpoke(bot);
    },
    getSimulatedTypingDelayMs: (minMs, jitterMs) => bot.getSimulatedTypingDelayMs(minMs, jitterMs),
    isChannelAllowed: (settings, channelId) =>
      isChannelAllowedForPermissions(
        settings as Parameters<typeof isChannelAllowedForPermissions>[0],
        String(channelId)
      ),
    discoveryPosting: bot.discoveryPosting
  };

  Object.defineProperty(runtime, "discoveryPosting", {
    get: () => bot.discoveryPosting,
    set: (value) => {
      bot.discoveryPosting = Boolean(value);
    },
    enumerable: true
  });

  return runtime;
}

export function buildAutomationEngineRuntime(bot: ClankerBot): AutomationEngineRuntime {
  const botContext = createBotContext(bot);
  const budgetContext = createBudgetContext(bot, botContext);
  const mediaAttachmentContext = createMediaAttachmentContext(bot, budgetContext);
  const runtime: AutomationEngineRuntime = {
    ...botContext,
    client: bot.client,
    search: bot.search,
    isChannelAllowed: (settings, channelId) =>
      isChannelAllowedForPermissions(
        settings as Parameters<typeof isChannelAllowedForPermissions>[0],
        String(channelId)
      ),
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    canTalkNow: (settings) => bot.canTalkNow(settings),
    getSimulatedTypingDelayMs: (minMs, jitterMs) => bot.getSimulatedTypingDelayMs(minMs, jitterMs),
    markSpoke: () => {
      markSpoke(bot);
    },
    composeMessageContentForHistory: (message, baseText) =>
      composeHistoryMessageContent(message, baseText),
    loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    buildMemoryLookupContext: (payload) =>
      buildMemoryLookupContextForBudgetTracking(
        budgetContext,
        payload as Parameters<typeof buildMemoryLookupContextForBudgetTracking>[1]
      ),
    getImageBudgetState: (settings) =>
      getImageBudgetStateForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getImageBudgetStateForBudgetTracking>[1]
      ),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetStateForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getVideoGenerationBudgetStateForBudgetTracking>[1]
      ),
    getGifBudgetState: (settings) =>
      getGifBudgetStateForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getGifBudgetStateForBudgetTracking>[1]
      ),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilitiesForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof getMediaGenerationCapabilitiesForBudgetTracking>[1]
      ),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachmentForMediaAttachment(
        mediaAttachmentContext,
        payload as Parameters<typeof resolveMediaAttachmentForMediaAttachment>[1]
      ),
    automationCycleRunning: bot.automationCycleRunning
  };

  Object.defineProperty(runtime, "automationCycleRunning", {
    get: () => bot.automationCycleRunning,
    set: (value) => {
      bot.automationCycleRunning = Boolean(value);
    },
    enumerable: true
  });

  return runtime;
}

export function buildTextThoughtLoopRuntime(bot: ClankerBot): TextThoughtLoopRuntime {
  const runtime: TextThoughtLoopRuntime = {
    ...createBotContext(bot),
    client: bot.client,
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    canTalkNow: (settings) => bot.canTalkNow(settings),
    maybeReplyToMessage: (message, settings, options) => bot.maybeReplyToMessage(message, settings, options),
    isChannelAllowed: (settings, channelId) =>
      isChannelAllowedForPermissions(
        settings as Parameters<typeof isChannelAllowedForPermissions>[0],
        String(channelId)
      ),
    isNonPrivateReplyEligibleChannel: (channel) => bot.isNonPrivateReplyEligibleChannel(channel),
    hydrateRecentMessages: (channel, limit) => bot.hydrateRecentMessages(channel, limit),
    hasBotMessageInRecentWindow: (payload) =>
      hasBotMessageInRecentWindowForReplyAdmission({
        botUserId: bot.client.user?.id,
        ...payload
      }),
    textThoughtLoopRunning: bot.textThoughtLoopRunning
  };

  Object.defineProperty(runtime, "textThoughtLoopRunning", {
    get: () => bot.textThoughtLoopRunning,
    set: (value) => {
      bot.textThoughtLoopRunning = Boolean(value);
    },
    enumerable: true
  });

  return runtime;
}

export function buildQueueGatewayRuntime(bot: ClankerBot): QueueGatewayRuntime {
  const botContext = createBotContext(bot);
  const runtime: QueueGatewayRuntime = {
    ...botContext,
    lastBotMessageAt: bot.lastBotMessageAt,
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    replyQueues: bot.replyQueues,
    replyQueueWorkers: bot.replyQueueWorkers,
    replyQueuedMessageIds: bot.replyQueuedMessageIds,
    isStopping: bot.isStopping,
    isChannelAllowed: (settings, channelId) =>
      isChannelAllowedForPermissions(
        settings as Parameters<typeof isChannelAllowedForPermissions>[0],
        String(channelId)
      ),
    isUserBlocked: (settings, userId) =>
      isUserBlockedForPermissions(
        settings as Parameters<typeof isUserBlockedForPermissions>[0],
        String(userId)
      ),
    getReplyAddressSignal: (settings, message, recentMessages = []) =>
      getReplyAddressSignalForReplyAdmission(
        {
          botUserId: botContext.botUserId,
          isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
            bot.isDirectlyAddressed(resolvedSettings, resolvedMessage)
        },
        settings as Parameters<typeof getReplyAddressSignalForReplyAdmission>[1],
        message,
        recentMessages
      ),
    maybeReplyToMessage: (message, settings, options = {}) =>
      bot.maybeReplyToMessage(message, settings, options),
    reconnectInFlight: bot.reconnectInFlight,
    hasConnectedAtLeastOnce: bot.hasConnectedAtLeastOnce,
    lastGatewayEventAt: bot.lastGatewayEventAt,
    reconnectTimeout: bot.reconnectTimeout,
    markGatewayEvent: () => {
      bot.lastGatewayEventAt = Date.now();
    },
    reconnectAttempts: bot.reconnectAttempts
  };

  Object.defineProperties(runtime, {
    lastBotMessageAt: {
      get: () => bot.lastBotMessageAt,
      set: (value) => {
        bot.lastBotMessageAt = Number(value) || 0;
      },
      enumerable: true
    },
    isStopping: {
      get: () => bot.isStopping,
      set: (value) => {
        bot.isStopping = Boolean(value);
      },
      enumerable: true
    },
    reconnectInFlight: {
      get: () => bot.reconnectInFlight,
      set: (value) => {
        bot.reconnectInFlight = Boolean(value);
      },
      enumerable: true
    },
    hasConnectedAtLeastOnce: {
      get: () => bot.hasConnectedAtLeastOnce,
      set: (value) => {
        bot.hasConnectedAtLeastOnce = Boolean(value);
      },
      enumerable: true
    },
    lastGatewayEventAt: {
      get: () => bot.lastGatewayEventAt,
      set: (value) => {
        bot.lastGatewayEventAt = Number(value) || Date.now();
      },
      enumerable: true
    },
    reconnectTimeout: {
      get: () => bot.reconnectTimeout,
      set: (value) => {
        bot.reconnectTimeout = value;
      },
      enumerable: true
    },
    reconnectAttempts: {
      get: () => bot.reconnectAttempts,
      set: (value) => {
        bot.reconnectAttempts = Number(value) || 0;
      },
      enumerable: true
    }
  });

  return runtime;
}

export function buildReplyPipelineRuntime(
  bot: ClankerBot,
  { captionTimestamps, unsolicitedReplyContextWindow }: ReplyPipelineFactoryDeps
): ReplyPipelineRuntime {
  const botContext = createBotContext(bot);
  const budgetContext = createBudgetContext(bot, botContext);
  const mediaAttachmentContext = createMediaAttachmentContext(bot, budgetContext);
  const agentContext = createAgentContext(bot, botContext);

  return {
    ...botContext,
    gifs: bot.gifs,
    search: bot.search,
    voiceSessionManager: bot.voiceSessionManager,
    getReplyAddressSignal: (settings, message, recentMessages = []) =>
      getReplyAddressSignalForReplyAdmission(
        {
          botUserId: botContext.botUserId,
          isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
            bot.isDirectlyAddressed(resolvedSettings, resolvedMessage)
        },
        settings as Parameters<typeof getReplyAddressSignalForReplyAdmission>[1],
        message,
        recentMessages
      ),
    isReplyChannel: (settings, channelId) =>
      isReplyChannelForPermissions(
        settings as Parameters<typeof isReplyChannelForPermissions>[0],
        String(channelId)
      ),
    getReactionEmojiOptions: (guild) => bot.getReactionEmojiOptions(guild),
    shouldAttemptReplyDecision: (payload) =>
      shouldAttemptReplyDecisionForReplyAdmission({
        botUserId: bot.client.user?.id,
        ...payload,
        windowSize: unsolicitedReplyContextWindow
      } as Parameters<typeof shouldAttemptReplyDecisionForReplyAdmission>[0]),
    loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
    getRecentLookupContextForPrompt: (payload) =>
      getRecentLookupContextForPromptForMessageHistory(botContext, payload),
    getConversationHistoryForPrompt: (payload) =>
      getConversationHistoryForPromptForMessageHistory(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    getImageInputs: (message) =>
      getImageInputsForMessageHistory(message as Parameters<typeof getImageInputsForMessageHistory>[0]),
    getImageBudgetState: (settings) => getImageBudgetStateForBudgetTracking(budgetContext, settings),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetStateForBudgetTracking(budgetContext, settings),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilitiesForBudgetTracking(budgetContext, settings),
    getGifBudgetState: (settings) => getGifBudgetStateForBudgetTracking(budgetContext, settings),
    buildWebSearchContext: (settings, messageText) =>
      buildWebSearchContextForBudgetTracking(budgetContext, settings, messageText),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContextForBudgetTracking(budgetContext, settings),
    buildMemoryLookupContext: (payload) => buildMemoryLookupContextForBudgetTracking(budgetContext, payload),
    buildVideoReplyContext: (payload) => buildVideoReplyContextForBudgetTracking(budgetContext, payload),
    buildImageLookupContext: (payload) => buildImageLookupContextForBudgetTracking(budgetContext, payload),
    captionRecentHistoryImages: (payload = {}) =>
      captionRecentHistoryImagesForImageAnalysis(botContext, {
        imageCaptionCache: bot.imageCaptionCache,
        captionTimestamps,
        candidates: payload.candidates || [],
        settings: payload.settings || null,
        trace: payload.trace || null
      }),
    getVoiceScreenShareCapability: (payload) =>
      getVoiceScreenShareCapabilityForScreenShare(buildScreenShareRuntime(bot), payload),
    getEmojiHints: (guild) => bot.getEmojiHints(guild),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowseForAgentTasks(agentContext, payload),
    runModelRequestedCodeTask: (payload) => runModelRequestedCodeTaskForAgentTasks(agentContext, payload),
    buildSubAgentSessionsRuntime: () => buildSubAgentSessionsRuntimeForAgentTasks(agentContext),
    runModelRequestedImageLookup: (payload) =>
      runModelRequestedImageLookupForImageAnalysis({
        imageLookup: payload.imageLookup || {},
        query: payload.query || ""
      }),
    mergeImageInputs: (payload) => mergeImageInputsForImageAnalysis(payload),
    maybeHandleStructuredVoiceIntent: (payload) => bot.maybeHandleStructuredVoiceIntent(payload),
    maybeHandleStructuredAutomationIntent: (payload) =>
      bot.maybeHandleStructuredAutomationIntent(payload),
    rememberRecentLookupContext: (payload) =>
      rememberRecentLookupContextForMessageHistory(botContext, payload),
    maybeApplyReplyReaction: (payload) => bot.maybeApplyReplyReaction(payload),
    logSkippedReply: (payload) => bot.logSkippedReply(payload),
    maybeHandleScreenShareOfferIntent: (payload) =>
      maybeHandleScreenShareOfferIntentForScreenShare(buildScreenShareRuntime(bot), {
        ...payload,
        settings: bot.store.getSettings()
      }),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachmentForMediaAttachment(mediaAttachmentContext, payload),
    maybeAttachReplyGif: (payload) => maybeAttachReplyGifForMediaAttachment(mediaAttachmentContext, payload),
    maybeAttachGeneratedImage: (payload) =>
      maybeAttachGeneratedImageForMediaAttachment(mediaAttachmentContext, payload),
    maybeAttachGeneratedVideo: (payload) =>
      maybeAttachGeneratedVideoForMediaAttachment(mediaAttachmentContext, payload),
    getSimulatedTypingDelayMs: (minMs, jitterMs) => bot.getSimulatedTypingDelayMs(minMs, jitterMs),
    shouldSendAsReply: (payload) => bot.shouldSendAsReply(payload),
    markSpoke: () => {
      markSpoke(bot);
    },
    composeMessageContentForHistory: (message, baseText) =>
      composeHistoryMessageContent(message, baseText),
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    canTalkNow: (settings) => bot.canTalkNow(settings)
  };
}

export function buildVoiceReplyRuntime(bot: ClankerBot): VoiceReplyRuntime {
  const botContext = createBotContext(bot);
  const budgetContext = createBudgetContext(bot, botContext);
  const agentContext = createAgentContext(bot, botContext);

  return {
    ...botContext,
    search: bot.search,
    loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFactsForMemorySlice(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    loadPromptMemorySlice: (payload) => loadPromptMemorySliceForMemorySlice(botContext, payload),
    buildWebSearchContext: (settings, messageText) =>
      buildWebSearchContextForBudgetTracking(budgetContext, settings, messageText),
    loadRecentConversationHistory: (payload) =>
      getConversationHistoryForPromptForMessageHistory(botContext, payload),
    loadRecentLookupContext: (payload) =>
      getRecentLookupContextForPromptForMessageHistory(botContext, payload),
    rememberRecentLookupContext: (payload) =>
      rememberRecentLookupContextForMessageHistory(botContext, payload),
    getVoiceScreenShareCapability: (payload) =>
      getVoiceScreenShareCapabilityForScreenShare(buildScreenShareRuntime(bot), payload),
    offerVoiceScreenShareLink: (payload) =>
      offerVoiceScreenShareLinkForScreenShare(buildScreenShareRuntime(bot), payload),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowseForAgentTasks(agentContext, payload),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContextForBudgetTracking(budgetContext, settings),
    runModelRequestedCodeTask: (payload) => runModelRequestedCodeTaskForAgentTasks(agentContext, payload)
  };
}
