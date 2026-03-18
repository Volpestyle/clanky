import type { ClankerBot } from "../bot.ts";
import {
  buildSubAgentSessionsRuntime,
  runModelRequestedBrowserBrowse,
  runModelRequestedCodeTask
} from "./agentTasks.ts";
import {
  buildBrowserBrowseContext,
  buildImageLookupContext,
  buildMemoryLookupContext,
  buildWebSearchContext,
  getGifBudgetState,
  getImageBudgetState,
  getMediaGenerationCapabilities,
  getVideoGenerationBudgetState
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
  captionRecentHistoryImages,
  mergeImageInputs,
  runModelRequestedImageLookup
} from "./imageAnalysis.ts";
import {
  resolveMediaAttachment,
  maybeAttachReplyGif,
  maybeAttachGeneratedImage,
  maybeAttachGeneratedVideo
} from "./mediaAttachment.ts";
import {
  composeMessageContentForHistory,
  getConversationHistoryForPrompt,
  getImageInputs,
  getVideoInputs
} from "./messageHistory.ts";
import {
  buildMediaMemoryFacts,
  loadFactProfile,
  loadRelevantMemoryFacts
} from "./memorySlice.ts";
import {
  isChannelAllowed,
  isDiscoveryChannel,
  isReplyChannel,
  isUserBlocked
} from "./permissions.ts";
import {
  getReplyAddressSignal,
  shouldAttemptReplyDecision
} from "./replyAdmission.ts";
import {
  getVoiceScreenWatchCapability,
  maybeHandleScreenWatchIntent,
  startVoiceScreenWatch,
} from "./screenShare.ts";
import type { ScreenShareRuntime } from "./screenShare.ts";
import type { VoiceCoordinationRuntime } from "./voiceCoordination.ts";
import {
  composeVoiceOperationalMessage
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
  return composeMessageContentForHistory(message as Parameters<
    typeof composeMessageContentForHistory
  >[0], baseText);
}

function markSpoke(bot: ClankerBot) {
  bot.lastBotMessageAt = Date.now();
}

function resolveReplyAddressSignal(
  bot: ClankerBot,
  botContext: BotContext,
  settings: unknown,
  message: unknown,
  recentMessages: Array<Record<string, unknown>> = []
) {
  return getReplyAddressSignal(
    {
      botUserId: botContext.botUserId,
      isDirectlyAddressed: (resolvedSettings, resolvedMessage) =>
        bot.isDirectlyAddressed(resolvedSettings, resolvedMessage)
    },
    settings as Parameters<typeof getReplyAddressSignal>[1],
    message,
    recentMessages
  );
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
      composeVoiceOperationalMessage(buildVoiceCoordinationRuntime(bot), {
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
      isChannelAllowed(
        settings as Parameters<typeof isChannelAllowed>[0],
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
      loadRelevantMemoryFacts(
        botContext,
        payload as Parameters<typeof loadRelevantMemoryFacts>[1]
      ),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFacts(payload),
    getImageBudgetState: (settings) =>
      getImageBudgetState(
        budgetContext,
        settings as Parameters<typeof getImageBudgetState>[1]
      ),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetState(
        budgetContext,
        settings as Parameters<typeof getVideoGenerationBudgetState>[1]
      ),
    getGifBudgetState: (settings) =>
      getGifBudgetState(
        budgetContext,
        settings as Parameters<typeof getGifBudgetState>[1]
      ),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilities(
        budgetContext,
        settings as Parameters<typeof getMediaGenerationCapabilities>[1]
      ),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachment(
        mediaAttachmentContext,
        payload as Parameters<typeof resolveMediaAttachment>[1]
      ),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContext(
        budgetContext,
        settings as Parameters<typeof buildBrowserBrowseContext>[1]
      ),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowse(
        createAgentContext(bot, botContext),
        payload as Parameters<typeof runModelRequestedBrowserBrowse>[1]
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
      isChannelAllowed(
        settings as Parameters<typeof isChannelAllowed>[0],
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
    loadFactProfile: (payload) => loadFactProfile(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFacts(payload),
    buildMemoryLookupContext: (payload) =>
      buildMemoryLookupContext(
        budgetContext,
        payload as Parameters<typeof buildMemoryLookupContext>[1]
      ),
    getImageBudgetState: (settings) =>
      getImageBudgetState(
        budgetContext,
        settings as Parameters<typeof getImageBudgetState>[1]
      ),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetState(
        budgetContext,
        settings as Parameters<typeof getVideoGenerationBudgetState>[1]
      ),
    getGifBudgetState: (settings) =>
      getGifBudgetState(
        budgetContext,
        settings as Parameters<typeof getGifBudgetState>[1]
      ),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilities(
        budgetContext,
        settings as Parameters<typeof getMediaGenerationCapabilities>[1]
      ),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachment(
        mediaAttachmentContext,
        payload as Parameters<typeof resolveMediaAttachment>[1]
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
      isChannelAllowed(
        settings as Parameters<typeof isChannelAllowed>[0],
        String(channelId)
      ),
    isUserBlocked: (settings, userId) =>
      isUserBlocked(
        settings as Parameters<typeof isUserBlocked>[0],
        String(userId)
      ),
    getReplyAddressSignal: (settings, message, recentMessages = []) =>
      resolveReplyAddressSignal(
        bot,
        botContext,
        settings,
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
  const screenShareRuntime = buildScreenShareRuntime(bot);

  return {
    ...botContext,
    activeReplies: bot.activeReplies,
    video: bot.video,
    gifs: bot.gifs,
    search: bot.search,
    voiceSessionManager: bot.voiceSessionManager,
    dispatchBackgroundCodeTask: (payload) => bot.dispatchBackgroundCodeTask(payload),
    backgroundTaskRunner: bot.backgroundTaskRunner,
    getReplyAddressSignal: (settings, message, recentMessages = []) =>
      resolveReplyAddressSignal(
        bot,
        botContext,
        settings,
        message,
        recentMessages
      ),
    isReplyChannel: (settings, channelId) =>
      isReplyChannel(
        settings as Parameters<typeof isReplyChannel>[0],
        String(channelId)
      ),
    isDiscoveryChannel: (settings, channelId) =>
      isDiscoveryChannel(
        settings as Parameters<typeof isDiscoveryChannel>[0],
        String(channelId)
      ),
    getReactionEmojiOptions: (guild) => bot.getReactionEmojiOptions(guild),
    shouldAttemptReplyDecision: (payload) =>
      shouldAttemptReplyDecision({
        botUserId: bot.client.user?.id,
        ...payload,
        windowSize: unsolicitedReplyContextWindow
      } as Parameters<typeof shouldAttemptReplyDecision>[0]),
    loadFactProfile: (payload) => loadFactProfile(botContext, payload),
    getConversationHistoryForPrompt: (payload) =>
      getConversationHistoryForPrompt(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFacts(payload),
    getImageInputs: (message) =>
      getImageInputs(message as Parameters<typeof getImageInputs>[0]),
    getVideoInputs: (message) =>
      getVideoInputs(message as Parameters<typeof getVideoInputs>[0]),
    getImageBudgetState: (settings) => getImageBudgetState(budgetContext, settings),
    getVideoGenerationBudgetState: (settings) =>
      getVideoGenerationBudgetState(budgetContext, settings),
    getMediaGenerationCapabilities: (settings) =>
      getMediaGenerationCapabilities(budgetContext, settings),
    getGifBudgetState: (settings) => getGifBudgetState(budgetContext, settings),
    buildWebSearchContext: (settings, messageText) =>
      buildWebSearchContext(budgetContext, settings, messageText),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContext(budgetContext, settings),
    buildMemoryLookupContext: (payload) => buildMemoryLookupContext(budgetContext, payload),
    buildImageLookupContext: (payload) => buildImageLookupContext(budgetContext, payload),
    captionRecentHistoryImages: (payload = {}) =>
      captionRecentHistoryImages(botContext, {
        imageCaptionCache: bot.imageCaptionCache,
        captionTimestamps,
        candidates: payload.candidates || [],
        settings: payload.settings || null,
        trace: payload.trace || null
      }),
    getVoiceScreenWatchCapability: (payload) =>
      getVoiceScreenWatchCapability(screenShareRuntime, payload),
    getEmojiHints: (guild) => bot.getEmojiHints(guild),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowse(agentContext, payload),
    runModelRequestedCodeTask: (payload) => runModelRequestedCodeTask(agentContext, payload),
    buildSubAgentSessionsRuntime: () => buildSubAgentSessionsRuntime(agentContext),
    runModelRequestedImageLookup: (payload) =>
      runModelRequestedImageLookup({
        imageLookup: payload.imageLookup || {},
        query: payload.query || ""
      }),
    mergeImageInputs: (payload) => mergeImageInputs(payload),
    maybeHandleStructuredAutomationIntent: (payload) =>
      bot.maybeHandleStructuredAutomationIntent(payload),
    maybeApplyReplyReaction: (payload) => bot.maybeApplyReplyReaction(payload),
    logSkippedReply: (payload) => bot.logSkippedReply(payload),
    maybeHandleScreenWatchIntent: (payload) =>
      maybeHandleScreenWatchIntent(screenShareRuntime, {
        ...payload,
        settings: bot.store.getSettings()
      }),
    resolveMediaAttachment: (payload) =>
      resolveMediaAttachment(mediaAttachmentContext, payload),
    maybeAttachReplyGif: (payload) => maybeAttachReplyGif(mediaAttachmentContext, payload),
    maybeAttachGeneratedImage: (payload) =>
      maybeAttachGeneratedImage(mediaAttachmentContext, payload),
    maybeAttachGeneratedVideo: (payload) =>
      maybeAttachGeneratedVideo(mediaAttachmentContext, payload),
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
  const screenShareRuntime = buildScreenShareRuntime(bot);

  return {
    ...botContext,
    search: bot.search,
    voiceSessionManager: bot.voiceSessionManager,
    loadRelevantMemoryFacts: (payload) => loadRelevantMemoryFacts(botContext, payload),
    buildMediaMemoryFacts: (payload) => buildMediaMemoryFacts(payload),
    loadFactProfile: (payload) => loadFactProfile(botContext, payload),
    buildWebSearchContext: (settings, messageText) =>
      buildWebSearchContext(budgetContext, settings, messageText),
    loadRecentConversationHistory: (payload) =>
      getConversationHistoryForPrompt(botContext, payload),
    getVoiceScreenWatchCapability: (payload) =>
      getVoiceScreenWatchCapability(screenShareRuntime, payload),
    startVoiceScreenWatch: (payload) =>
      startVoiceScreenWatch(screenShareRuntime, payload),
    runModelRequestedBrowserBrowse: (payload) =>
      runModelRequestedBrowserBrowse(agentContext, payload),
    buildBrowserBrowseContext: (settings) =>
      buildBrowserBrowseContext(budgetContext, settings),
    runModelRequestedCodeTask: (payload) => runModelRequestedCodeTask(agentContext, payload),
    buildSubAgentSessionsRuntime: () => buildSubAgentSessionsRuntime(agentContext),
    dispatchBackgroundCodeTask: (payload) => bot.dispatchBackgroundCodeTask(payload),
    backgroundTaskRunner: bot.backgroundTaskRunner
  };
}
