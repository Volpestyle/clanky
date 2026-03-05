import { clamp } from "lodash";
import { sanitizeBotText, sleep } from "../utils.ts";
import { buildReplyPrompt, buildSystemPrompt } from "../prompts.ts";
import { getMediaPromptCraftGuidance } from "../promptCore.ts";
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
} from "../botHelpers.ts";
import { getLocalTimeZoneLabel } from "../automation.ts";
import { buildReplyToolSet, executeReplyTool } from "../tools/replyTools.ts";
import {
  maybeRegenerateWithMemoryLookup as maybeRegenerateWithMemoryLookupForReplyFollowup,
  resolveReplyFollowupGenerationSettings as resolveReplyFollowupGenerationSettingsForReplyFollowup,
  runModelRequestedWebSearch as runModelRequestedWebSearchForReplyFollowup
} from "./replyFollowup.ts";
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



export async function buildReplyContext(bot: any, message: any, settings: any, options: any) {
  const recentMessages = Array.isArray(options.recentMessages)
    ? options.recentMessages
    : bot.store.getRecentMessages(message.channelId, settings.memory.maxRecentMessages);
  const addressSignal =
    options.addressSignal || await bot.getReplyAddressSignal(settings, message, recentMessages);
  const triggerMessageIds = [
    ...new Set(
      [...(Array.isArray(options.triggerMessageIds) ? options.triggerMessageIds : []), message.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ];
  const addressed = addressSignal.triggered;
  const reactionEagerness = clamp(Number(settings.activity?.reactionLevel) || 0, 0, 100);
  const isReplyChannel = bot.isReplyChannel(settings, message.channelId);
  const replyEagerness = clamp(
    Number(
      isReplyChannel
        ? settings.activity?.replyLevelReplyChannels
        : settings.activity?.replyLevelOtherChannels
    ) || 0,
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
    loadPromptMemorySlice: (payload) => bot.loadPromptMemorySlice(payload),
    loadRecentLookupContext: (payload) => bot.getRecentLookupContextForPrompt(payload),
    loadRecentConversationHistory: (payload) => bot.getConversationHistoryForPrompt(payload),
    loadAdaptiveDirectives:
      Boolean(settings?.adaptiveDirectives?.enabled) &&
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
  const attachmentImageInputs = bot.getImageInputs(message);
  const imageBudget = bot.getImageBudgetState(settings);
  const videoBudget = bot.getVideoGenerationBudgetState(settings);
  const mediaCapabilities = bot.getMediaGenerationCapabilities(settings);
  const simpleImageCapabilityReady = mediaCapabilities.simpleImageReady;
  const complexImageCapabilityReady = mediaCapabilities.complexImageReady;
  const imageCapabilityReady = simpleImageCapabilityReady || complexImageCapabilityReady;
  const videoCapabilityReady = mediaCapabilities.videoReady;
  const gifBudget = bot.getGifBudgetState(settings);
  const gifsConfigured = Boolean(bot.gifs?.isConfigured?.());
  const webSearch = bot.buildWebSearchContext(settings, message.content);
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
  const modelImageInputs = [...attachmentImageInputs, ...(videoContext.frameImages || [])].slice(0, MAX_MODEL_IMAGE_INPUTS);
  const imageLookup = bot.buildImageLookupContext({
    recentMessages,
    excludedUrls: modelImageInputs.map((image) => String(image?.url || "").trim())
  });

  // Auto-include recent history images as direct vision inputs
  const visionSettings = settings?.vision || {};
  const maxAutoInclude = Math.min(
    (visionSettings.maxAutoIncludeImages != null ? Number(visionSettings.maxAutoIncludeImages) : 3),
    Math.max(0, MAX_MODEL_IMAGE_INPUTS - modelImageInputs.length)
  );
  if (maxAutoInclude > 0 && visionSettings.captionEnabled !== false && imageLookup.candidates?.length) {
    const autoImageInputs = bot.getAutoIncludeImageInputs({
      candidates: imageLookup.candidates,
      maxImages: maxAutoInclude
    });
    modelImageInputs.push(...autoImageInputs);

    // Fire-and-forget: caption uncaptioned images in background for future text matching
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
    userId: message.author.id
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
  const replyPromptBase = {
    message: {
      authorName: message.member?.displayName || message.author.username,
      content: message.content
    },
    triggerMessageIds,
    recentMessages,
    relevantMessages: memorySlice.relevantMessages,
    userFacts: memorySlice.userFacts,
    relevantFacts: memorySlice.relevantFacts,
    emojiHints: bot.getEmojiHints(message.guild),
    reactionEmojiOptions,
    allowReplySimpleImages:
      settings.discovery.allowReplyImages && simpleImageCapabilityReady && imageBudget.canGenerate,
    allowReplyComplexImages:
      settings.discovery.allowReplyImages && complexImageCapabilityReady && imageBudget.canGenerate,
    remainingReplyImages: imageBudget.remaining,
    allowReplyVideos:
      settings.discovery.allowReplyVideos && videoCapabilityReady && videoBudget.canGenerate,
    remainingReplyVideos: videoBudget.remaining,
    allowReplyGifs: settings.discovery.allowReplyGifs && gifsConfigured && gifBudget.canFetch,
    remainingReplyGifs: gifBudget.remaining,
    gifRepliesEnabled: settings.discovery.allowReplyGifs,
    gifsConfigured,
    replyEagerness,
    reactionEagerness,
    addressing: {
      directlyAddressed: addressed,
      directAddressConfidence: Number(addressSignal?.confidence) || 0,
      directAddressThreshold: Number(addressSignal?.threshold) || 0.62,
      responseRequired: Boolean(options.forceRespond)
    },
    allowMemoryDirective: settings.memory.enabled,
    allowAdaptiveDirective: Boolean(settings?.adaptiveDirectives?.enabled),
    allowAutomationDirective: Boolean(settings?.automations?.enabled),
    automationTimeZoneLabel: getLocalTimeZoneLabel(),
    voiceMode: {
      enabled: Boolean(settings?.voice?.enabled),
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


export async function executeReplyLlm(bot: any, message: any, settings: any, options: any, ctx: any) {
  const {
    addressSignal, triggerMessageIds, source, performance,
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
    memoryAvailable: Boolean(settings?.memory?.enabled),
    adaptiveDirectivesAvailable: Boolean(settings?.adaptiveDirectives?.enabled),
    imageLookupAvailable: Boolean(imageLookup?.enabled),
    openArticleAvailable: false
  });
  const replyToolRuntime = {
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
          source
        });
        return browserBrowse;
      }
    },
    memory: bot.memory,
    store: bot.store
  };
  const replyToolContext = {
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
    }
  };
  let replyContextMessages: Array<{ role: string; content: unknown }> = [];

  const llm1StartedAtMs = Date.now();
  let generation = await bot.llm.generate({
    settings,
    systemPrompt,
    userPrompt: initialUserPrompt,
    imageInputs: modelImageInputs,
    contextMessages: replyContextMessages,
    jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
    tools: replyTools,
    trace: replyTrace
  });
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
    const assistantContent = generation.rawContent || [
      { type: "text", text: generation.text || "" }
    ];
    replyContextMessages = [
      ...replyContextMessages,
      { role: "user", content: initialUserPrompt },
      { role: "assistant", content: assistantContent }
    ];

    const toolResultMessages: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const toolCall of generation.toolCalls) {
      if (replyTotalToolCalls >= REPLY_TOOL_LOOP_MAX_CALLS) break;
      replyTotalToolCalls += 1;

      const toolInput = toolCall.input as Record<string, unknown>;
      let result;
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
            }
          }
        );
        usedWebSearchFollowup = Boolean(webSearch?.used);
        const rows = Array.isArray(webSearch?.results) ? webSearch.results : [];
        result = {
          isError: Boolean(webSearch?.error),
          content: webSearch?.error
            ? `Web search failed: ${String(webSearch.error)}`
            : rows.length
              ? `Web results for "${String(webSearch?.query || toolQuery)}":\n\n${rows
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
      } else if (toolCall.name === "browser_browse" && !result.isError) {
        usedBrowserBrowseFollowup = Boolean(browserBrowse?.used);
      } else if (toolCall.name === "image_lookup" && !result.isError) {
        imageLookup = await bot.runModelRequestedImageLookup({
          imageLookup,
          query: String(toolInput.query || "")
        });
        modelImageInputs = bot.mergeImageInputs({
          existing: modelImageInputs,
          additions: imageLookup.selectedImageInputs || [],
          maxInputs: MAX_MODEL_IMAGE_INPUTS
        });
        usedImageLookupFollowup = Boolean(imageLookup?.used);
      }

      toolResultMessages.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result.content
      });
    }

    replyContextMessages = [
      ...replyContextMessages,
      { role: "user", content: toolResultMessages }
    ];

    generation = await bot.llm.generate({
      settings,
      systemPrompt,
      userPrompt: "",
      imageInputs: modelImageInputs,
      contextMessages: replyContextMessages,
      jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
      tools: replyTools,
      trace: {
        ...replyTrace,
        event: `reply_tool_loop:${replyToolLoopSteps + 1}`
      }
    });
    replyToolLoopSteps += 1;
  }

  const followupGenerationSettings = resolveReplyFollowupGenerationSettingsForReplyFollowup(settings);
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
            }
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
    generation, usedWebSearchFollowup, usedBrowserBrowseFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    followupGenerationSettings, mediaPromptLimit, replyDirective,
    webSearch, browserBrowse, memoryLookup, imageLookup, modelImageInputs, replyPrompts
  };
}


export async function dispatchReplyActions(bot: any, message: any, settings: any, options: any, ctx: any, llmResult: any) {
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
  if (settings.memory.enabled && memoryLine) {
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

  if (settings.memory.enabled && selfMemoryLine) {
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

  let payload = { content: finalText };
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

  if (mediaDirective?.type === "gif" && gifQuery) {
    const gifResult = await bot.maybeAttachReplyGif({
      settings,
      text: finalText,
      query: gifQuery,
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source: "reply_message"
      }
    });
    payload = gifResult.payload;
    gifUsed = gifResult.gifUsed;
    gifBudgetBlocked = gifResult.blockedByBudget;
    gifConfigBlocked = gifResult.blockedByConfiguration;
  }

  if (mediaDirective?.type === "image_simple" && settings.discovery.allowReplyImages && imagePrompt) {
    const imageResult = await bot.maybeAttachGeneratedImage({
      settings,
      text: finalText,
      prompt: composeReplyImagePrompt(
        imagePrompt,
        finalText,
        mediaPromptLimit,
        replyMediaMemoryFacts
      ),
      variant: "simple",
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source: "reply_message"
      }
    });
    payload = imageResult.payload;
    imageUsed = imageResult.imageUsed;
    imageBudgetBlocked = imageResult.blockedByBudget;
    imageCapabilityBlocked = imageResult.blockedByCapability;
    imageVariantUsed = imageResult.variant || "simple";
  }

  if (mediaDirective?.type === "image_complex" && settings.discovery.allowReplyImages && complexImagePrompt) {
    const imageResult = await bot.maybeAttachGeneratedImage({
      settings,
      text: finalText,
      prompt: composeReplyImagePrompt(
        complexImagePrompt,
        finalText,
        mediaPromptLimit,
        replyMediaMemoryFacts
      ),
      variant: "complex",
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source: "reply_message"
      }
    });
    payload = imageResult.payload;
    imageUsed = imageResult.imageUsed;
    imageBudgetBlocked = imageResult.blockedByBudget;
    imageCapabilityBlocked = imageResult.blockedByCapability;
    imageVariantUsed = imageResult.variant || "complex";
  }

  if (mediaDirective?.type === "video" && settings.discovery.allowReplyVideos && videoPrompt) {
    const videoResult = await bot.maybeAttachGeneratedVideo({
      settings,
      text: finalText,
      prompt: composeReplyVideoPrompt(
        videoPrompt,
        finalText,
        mediaPromptLimit,
        replyMediaMemoryFacts
      ),
      trace: {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        source: "reply_message"
      }
    });
    payload = videoResult.payload;
    videoUsed = videoResult.videoUsed;
    videoBudgetBlocked = videoResult.blockedByBudget;
    videoCapabilityBlocked = videoResult.blockedByCapability;
  }

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


export async function sendReplyMessage(bot: any, message: any, settings: any, options: any, ctx: any, llmResult: any, actionResult: any) {
  const {
    addressSignal, triggerMessageIds, addressed,
    isReplyChannel, source, performance,
    imageBudget, videoBudget,
    simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget,
    videoContext
  } = ctx;
  const {
    generation, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    webSearch, imageLookup, memoryLookup, replyPrompts
  } = llmResult;
  const {
    reaction, memorySaved, selfMemorySaved,
    finalText, mentionResolution, screenShareOffer, payload, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  } = actionResult;

  const typingStartedAtMs = Date.now();
  await message.channel.sendTyping();
  await sleep(bot.getSimulatedTypingDelayMs(600, 1800));
  const typingDelayMs = Math.max(0, Date.now() - typingStartedAtMs);

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
    authorName: settings.botName,
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


export async function maybeReplyToMessagePipeline(bot: any, message: any, settings: any, options: any = {}) {
  if (!settings.permissions.allowReplies) return false;
  if (!bot.canSendMessage(settings.permissions.maxMessagesPerHour)) return false;
  if (!bot.canTalkNow(settings)) return false;

  const ctx = await buildReplyContext(bot, message, settings, options);
  if (!ctx || !ctx.shouldRun) return false;

  const llmResult = await executeReplyLlm(bot, message, settings, options, ctx);
  if (llmResult.handledByIntent) return true;

  const actionResult = await dispatchReplyActions(bot, message, settings, options, ctx, llmResult);
  if (actionResult.skipped) return false;

  return await sendReplyMessage(bot, message, settings, options, ctx, llmResult, actionResult);
}
