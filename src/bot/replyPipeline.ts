import { clamp } from "lodash";
import { sanitizeBotText } from "../utils.ts";
import { 
  buildReplyPrompt, 
  buildSystemPrompt 
} from "../prompts.ts";
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
  normalizeSkipSentinel
} from "../botHelpers.ts";
import { getLocalTimeZoneLabel } from "../automation.ts";
import {
  maybeRegenerateWithMemoryLookup as maybeRegenerateWithMemoryLookupForReplyFollowup,
  resolveReplyFollowupGenerationSettings as resolveReplyFollowupGenerationSettingsForReplyFollowup,
  runModelRequestedWebSearch as runModelRequestedWebSearchForReplyFollowup
} from "./replyFollowup.ts";
import { resolveDeterministicMentions as resolveDeterministicMentionsForMentions } from "./mentions.ts";

// Helper copied from bot.ts (or re-implemented)
const UNICODE_REACTIONS = ["🔥", "💀", "😂", "👀", "🤝", "🫡", "😮", "🧠", "💯", "😭"];
const MAX_MODEL_IMAGE_INPUTS = 8;
const LOOKUP_CONTEXT_PROMPT_LIMIT = 4;
const LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS = 72;

function createReplyPerformanceTracker({ messageCreatedAtMs, source, seed }: any) {
  return {
    source,
    startedAtMs: Date.now(),
    triggerMessageCreatedAtMs: seed?.triggerMessageCreatedAtMs || messageCreatedAtMs || null,
    queuedAtMs: seed?.queuedAtMs || null,
    ingestMs: seed?.ingestMs || null,
    memorySliceMs: null,
    llm1Ms: null,
    followupMs: null
  };
}

function createReplyPromptCapture({ systemPrompt, initialUserPrompt }: any) {
  return {
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts: []
  };
}

function buildLoggedReplyPrompts(capture: any, followupSteps: number) {
  return {
    hiddenByDefault: true,
    systemPrompt: capture.systemPrompt,
    initialUserPrompt: capture.initialUserPrompt,
    followupUserPrompts: capture.followupUserPrompts,
    followupSteps
  };
}

function appendReplyFollowupPrompt(capture: any, prompt: string) {
  capture.followupUserPrompts.push(prompt);
}



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
  const isInitiativeChannel = bot.isInitiativeChannel(settings, message.channelId);
  const replyEagerness = clamp(
    Number(
      isInitiativeChannel
        ? settings.activity?.replyLevelInitiative
        : settings.activity?.replyLevelNonInitiative
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
    isInitiativeChannel,
    forceRespond: Boolean(options.forceRespond),
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
  const memorySlice = await bot.loadPromptMemorySlice({
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
    source
  });
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
  let webSearch = bot.buildWebSearchContext(settings, message.content);
  const recentWebLookups = bot.getRecentLookupContextForPrompt({
    guildId: message.guildId,
    channelId: message.channelId,
    queryText: message.content,
    limit: LOOKUP_CONTEXT_PROMPT_LIMIT,
    maxAgeHours: LOOKUP_CONTEXT_PROMPT_MAX_AGE_HOURS
  });
  let memoryLookup = bot.buildMemoryLookupContext({ settings });
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
  let modelImageInputs = [...attachmentImageInputs, ...(videoContext.frameImages || [])].slice(0, MAX_MODEL_IMAGE_INPUTS);
  let imageLookup = bot.buildImageLookupContext({
    recentMessages,
    excludedUrls: modelImageInputs.map((image) => String(image?.url || "").trim())
  });
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
  
  const systemPrompt = buildSystemPrompt(settings);
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
      settings.initiative.allowReplyImages && simpleImageCapabilityReady && imageBudget.canGenerate,
    allowReplyComplexImages:
      settings.initiative.allowReplyImages && complexImageCapabilityReady && imageBudget.canGenerate,
    remainingReplyImages: imageBudget.remaining,
    allowReplyVideos:
      settings.initiative.allowReplyVideos && videoCapabilityReady && videoBudget.canGenerate,
    remainingReplyVideos: videoBudget.remaining,
    allowReplyGifs: settings.initiative.allowReplyGifs && gifsConfigured && gifBudget.canFetch,
    remainingReplyGifs: gifBudget.remaining,
    gifRepliesEnabled: settings.initiative.allowReplyGifs,
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
    allowAutomationDirective: true,
    automationTimeZoneLabel: getLocalTimeZoneLabel(),
    voiceMode: {
      enabled: Boolean(settings?.voice?.enabled),
      activeSession: inVoiceChannelNow,
      participantRoster: activeVoiceParticipantRoster,
      musicDisambiguation
    },
    recentWebLookups,
    screenShare: screenShareCapability,
    videoContext,
    channelMode: isInitiativeChannel ? "initiative" : "non_initiative",
    maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
    mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
  };
  const initialUserPrompt = buildReplyPrompt({
    ...replyPromptBase,
    imageInputs: modelImageInputs,
    webSearch,
    memoryLookup,
    imageLookup,
    allowWebSearchDirective: true,
    allowMemoryLookupDirective: true,
    allowImageLookupDirective: true
  });
  const replyPromptCapture = createReplyPromptCapture({
    systemPrompt,
    initialUserPrompt
  });
  let replyPrompts = buildLoggedReplyPrompts(replyPromptCapture, 0);
  
  return {
    shouldRun: true,
    recentMessages, addressSignal, triggerMessageIds, addressed, reactionEagerness,
    isInitiativeChannel, replyEagerness, reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, webSearch, recentWebLookups, memoryLookup,
    videoContext, modelImageInputs, imageLookup, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture, replyPrompts
  };
}


export async function executeReplyLlm(bot: any, message: any, settings: any, options: any, ctx: any) {
  let {
    recentMessages, addressSignal, triggerMessageIds, addressed, reactionEagerness,
    isInitiativeChannel, replyEagerness, reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, webSearch, recentWebLookups, memoryLookup,
    videoContext, modelImageInputs, imageLookup, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture, replyPrompts
  } = ctx;

  const llm1StartedAtMs = Date.now();
  let generation = await bot.llm.generate({
    settings,
    systemPrompt,
    userPrompt: initialUserPrompt,
    imageInputs: modelImageInputs,
    jsonSchema: REPLY_OUTPUT_JSON_SCHEMA,
    trace: replyTrace
  });
  performance.llm1Ms = Math.max(0, Date.now() - llm1StartedAtMs);
  let usedWebSearchFollowup = false;
  let usedMemoryLookupFollowup = false;
  let usedImageLookupFollowup = false;
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
        memoryLookup: nextMemoryLookup,
        imageLookup: nextImageLookup,
        imageInputs: nextImageInputs,
        allowWebSearchDirective,
        allowMemoryLookupDirective,
        allowImageLookupDirective
      }) => {
        const followupUserPrompt = buildReplyPrompt({
          ...replyPromptBase,
          imageInputs: nextImageInputs,
          webSearch: nextWebSearch,
          memoryLookup: nextMemoryLookup,
          imageLookup: nextImageLookup,
          allowWebSearchDirective,
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
      runModelRequestedImageLookup: (payload) => bot.runModelRequestedImageLookup(payload),
      mergeImageInputs: (payload) => bot.mergeImageInputs(payload),
      maxModelImageInputs: MAX_MODEL_IMAGE_INPUTS,
      jsonSchema: REPLY_OUTPUT_JSON_SCHEMA
    }
  );
  generation = followup.generation;
  replyDirective = followup.directive;
  webSearch = followup.webSearch || webSearch;
  memoryLookup = followup.memoryLookup;
  imageLookup = followup.imageLookup;
  modelImageInputs = followup.imageInputs;
  usedWebSearchFollowup = followup.usedWebSearch;
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
  if (followup.regenerated || usedWebSearchFollowup || usedMemoryLookupFollowup || usedImageLookupFollowup) {
    performance.followupMs = Math.max(0, Date.now() - followupStartedAtMs);
  }
  

  return {
    handledByIntent: false,
    generation, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    followupGenerationSettings, mediaPromptLimit, replyDirective,
    webSearch, memoryLookup, imageLookup, modelImageInputs, replyPrompts
  };
}


export async function dispatchReplyActions(bot: any, message: any, settings: any, options: any, ctx: any, llmResult: any) {
  let {
    recentMessages, addressSignal, triggerMessageIds, addressed, reactionEagerness,
    isInitiativeChannel, replyEagerness, reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, recentWebLookups,
    videoContext, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture
  } = ctx;
  let {
    generation, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    followupGenerationSettings, mediaPromptLimit, replyDirective,
    webSearch, memoryLookup, imageLookup, modelImageInputs, replyPrompts
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
  
  if (mediaDirective?.type === "image_simple" && settings.initiative.allowReplyImages && imagePrompt) {
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
  
  if (mediaDirective?.type === "image_complex" && settings.initiative.allowReplyImages && complexImagePrompt) {
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
  
  if (mediaDirective?.type === "video" && settings.initiative.allowReplyVideos && videoPrompt) {
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
  let {
    recentMessages, addressSignal, triggerMessageIds, addressed, reactionEagerness,
    isInitiativeChannel, replyEagerness, reactionEmojiOptions, source, performance,
    memorySlice, replyMediaMemoryFacts, attachmentImageInputs, imageBudget, videoBudget,
    mediaCapabilities, simpleImageCapabilityReady, complexImageCapabilityReady, imageCapabilityReady,
    videoCapabilityReady, gifBudget, gifsConfigured, recentWebLookups,
    videoContext, replyTrace, screenShareCapability,
    activeVoiceSession, inVoiceChannelNow, activeVoiceParticipantRoster, musicDisambiguation,
    systemPrompt, replyPromptBase, initialUserPrompt, replyPromptCapture
  } = ctx;
  let {
    generation, usedWebSearchFollowup, usedMemoryLookupFollowup, usedImageLookupFollowup,
    followupGenerationSettings, mediaPromptLimit, replyDirective,
    webSearch, memoryLookup, imageLookup, modelImageInputs, replyPrompts
  } = llmResult;
  let {
    reaction, memoryLine, selfMemoryLine, memorySaved, selfMemorySaved, mediaDirective,
    finalText, mentionResolution, screenShareOffer, allowMediaOnlyReply, modelProducedSkip,
    modelProducedEmpty, payload, imageUsed, imageBudgetBlocked, imageCapabilityBlocked,
    imageVariantUsed, videoUsed, videoBudgetBlocked, videoCapabilityBlocked, gifUsed,
    gifBudgetBlocked, gifConfigBlocked, imagePrompt, complexImagePrompt, videoPrompt, gifQuery
  } = actionResult;

  
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
