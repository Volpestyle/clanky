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
import type { InitiativeRuntime } from "./initiativeEngine.ts";
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
  getVideoInputs as getVideoInputsForMessageHistory
} from "./messageHistory.ts";
import {
  buildMediaMemoryFacts as buildMediaMemoryFactsForMemorySlice,
  loadFactProfile as loadFactProfileForMemorySlice,
  loadRelevantMemoryFacts as loadRelevantMemoryFactsForMemorySlice
} from "./memorySlice.ts";
import {
  isChannelAllowed as isChannelAllowedForPermissions,
  isDiscoveryChannel as isDiscoveryChannelForPermissions,
  isReplyChannel as isReplyChannelForPermissions,
  isUserBlocked as isUserBlockedForPermissions
} from "./permissions.ts";
import {
  getReplyAddressSignal as getReplyAddressSignalForReplyAdmission,
  shouldAttemptReplyDecision as shouldAttemptReplyDecisionForReplyAdmission
} from "./replyAdmission.ts";
import {
  getVoiceScreenWatchCapability as getVoiceScreenWatchCapabilityForScreenShare,
  maybeHandleScreenWatchIntent as maybeHandleScreenWatchIntentForScreenShare,
  startVoiceScreenWatch as startVoiceScreenWatchForScreenShare,
} from "./screenShare.ts";
import type { ScreenShareRuntime } from "./screenShare.ts";
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
    voiceSessionManager: bot.voiceSessionManager,
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

export function buildInitiativeRuntime(bot: ClankerBot): InitiativeRuntime {
  const botContext = createBotContext(bot);
  const budgetContext = createBudgetContext(bot, botContext);
  const mediaAttachmentContext = createMediaAttachmentContext(bot, budgetContext);

  const runtime: InitiativeRuntime = {
    ...botContext,
    client: bot.client,
    discovery: bot.discovery,
    search: bot.search,
    getPendingInitiativeThoughts: () => bot.pendingInitiativeThoughts,
    getPendingInitiativeThought: (guildId) => bot.pendingInitiativeThoughts.get(String(guildId || "").trim()) || null,
    setPendingInitiativeThought: (guildId, thought) => {
      const normalizedGuildId = String(guildId || "").trim();
      if (!normalizedGuildId) return;
      if (!thought) {
        bot.pendingInitiativeThoughts.delete(normalizedGuildId);
        return;
      }
      bot.pendingInitiativeThoughts.set(normalizedGuildId, thought);
    },
    canSendMessage: (maxPerHour) => bot.canSendMessage(maxPerHour),
    canTalkNow: (settings) => bot.canTalkNow(settings),
    hydrateRecentMessages: (channel, limit) => bot.hydrateRecentMessages(channel, limit),
    isChannelAllowed: (settings, channelId) =>
      isChannelAllowedForPermissions(
        settings as Parameters<typeof isChannelAllowedForPermissions>[0],
        String(channelId)
      ),
    isNonPrivateReplyEligibleChannel: (channel) => bot.isNonPrivateReplyEligibleChannel(channel),
    getSimulatedTypingDelayMs: (minMs, jitterMs) => bot.getSimulatedTypingDelayMs(minMs, jitterMs),
    markSpoke: () => {
      markSpoke(bot);
    },
    composeMessageContentForHistory: (message, baseText) =>
      composeHistoryMessageContent(message, baseText),
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
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContextForBudgetTracking(
        budgetContext,
        settings as Parameters<typeof buildBrowserBrowseContextForBudgetTracking>[1]
      ),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowseForAgentTasks(
        createAgentContext(bot, botContext),
        payload as Parameters<typeof runModelRequestedBrowserBrowseForAgentTasks>[1]
      ),
    initiativeCycleRunning: bot.initiativeCycleRunning
  };

  Object.defineProperty(runtime, "initiativeCycleRunning", {
    get: () => bot.initiativeCycleRunning,
    set: (value) => {
      bot.initiativeCycleRunning = Boolean(value);
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
    loadFactProfile: (payload) => loadFactProfileForMemorySlice(botContext, payload),
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
    activeReplies: bot.activeReplies,
    video: bot.video,
    gifs: bot.gifs,
    search: bot.search,
    voiceSessionManager: bot.voiceSessionManager,
    dispatchBackgroundCodeTask: (payload) => bot.dispatchBackgroundCodeTask(payload),
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
    isDiscoveryChannel: (settings, channelId) =>
      isDiscoveryChannelForPermissions(
        settings as Parameters<typeof isDiscoveryChannelForPermissions>[0],
        String(channelId)
      ),
    getReactionEmojiOptions: (guild) => bot.getReactionEmojiOptions(guild),
    shouldAttemptReplyDecision: (payload) =>
      shouldAttemptReplyDecisionForReplyAdmission({
        botUserId: bot.client.user?.id,
        ...payload,
        windowSize: unsolicitedReplyContextWindow
      } as Parameters<typeof shouldAttemptReplyDecisionForReplyAdmission>[0]),
    loadFactProfile: (payload) => loadFactProfileForMemorySlice(botContext, payload),
    getConversationHistoryForPrompt: (payload) =>
      getConversationHistoryForPromptForMessageHistory(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    getImageInputs: (message) =>
      getImageInputsForMessageHistory(message as Parameters<typeof getImageInputsForMessageHistory>[0]),
    getVideoInputs: (message) =>
      getVideoInputsForMessageHistory(message as Parameters<typeof getVideoInputsForMessageHistory>[0]),
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
    buildImageLookupContext: (payload) => buildImageLookupContextForBudgetTracking(budgetContext, payload),
    captionRecentHistoryImages: (payload = {}) =>
      captionRecentHistoryImagesForImageAnalysis(botContext, {
        imageCaptionCache: bot.imageCaptionCache,
        captionTimestamps,
        candidates: payload.candidates || [],
        settings: payload.settings || null,
        trace: payload.trace || null
      }),
    getVoiceScreenWatchCapability: (payload) =>
      getVoiceScreenWatchCapabilityForScreenShare(buildScreenShareRuntime(bot), payload),
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
    maybeHandleStructuredAutomationIntent: (payload) =>
      bot.maybeHandleStructuredAutomationIntent(payload),
    maybeApplyReplyReaction: (payload) => bot.maybeApplyReplyReaction(payload),
    logSkippedReply: (payload) => bot.logSkippedReply(payload),
    maybeHandleScreenWatchIntent: (payload) =>
      maybeHandleScreenWatchIntentForScreenShare(buildScreenShareRuntime(bot), {
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
    voiceSessionManager: bot.voiceSessionManager,
    loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFactsForMemorySlice(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFactsForMemorySlice(payload),
    loadFactProfile: (payload) => loadFactProfileForMemorySlice(botContext, payload),
    buildWebSearchContext: (settings, messageText) =>
      buildWebSearchContextForBudgetTracking(budgetContext, settings, messageText),
    loadRecentConversationHistory: (payload) =>
      getConversationHistoryForPromptForMessageHistory(botContext, payload),
    getVoiceScreenWatchCapability: (payload) =>
      getVoiceScreenWatchCapabilityForScreenShare(buildScreenShareRuntime(bot), payload),
    startVoiceScreenWatch: (payload) =>
      startVoiceScreenWatchForScreenShare(buildScreenShareRuntime(bot), payload),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowseForAgentTasks(agentContext, payload),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContextForBudgetTracking(budgetContext, settings),
    runModelRequestedCodeTask: (payload) => runModelRequestedCodeTaskForAgentTasks(agentContext, payload),
    buildSubAgentSessionsRuntime: () => buildSubAgentSessionsRuntimeForAgentTasks(agentContext),
    dispatchBackgroundCodeTask: (payload) => bot.dispatchBackgroundCodeTask(payload)
  };
}
