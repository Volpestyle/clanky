import { normalizeDiscoveryUrl } from "../services/discovery.ts";
import {
  composeDiscoveryImagePrompt,
  composeDiscoveryVideoPrompt,
  extractUrlsFromText,
  normalizeSkipSentinel,
  parseDiscoveryMediaDirective,
  pickDiscoveryMediaDirective,
  resolveMaxMediaPromptLen,
  splitDiscordMessage
} from "./botHelpers.ts";
import { buildDiscoveryPrompt, buildSystemPrompt } from "../prompts/index.ts";
import { getMediaPromptCraftGuidance } from "../prompts/promptCore.ts";
import { chance, sanitizeBotText, sleep } from "../utils.ts";
import {
  getBotName,
  getDiscoverySettings,
  getMemorySettings,
  getReplyPermissions
} from "../settings/agentStack.ts";
import {
  evaluateDiscoverySchedule,
  pickDiscoveryChannel
} from "./discoverySchedule.ts";
import { resolveDeterministicMentions as resolveDeterministicMentionsForMentions } from "./mentions.ts";
import type { DiscoveryContext } from "./botContext.ts";

type DiscoveryLinkCandidate = {
  url?: string;
  source?: string;
};

type DiscoveryGuildLike = {
  emojis?: {
    cache: {
      map: <T>(callback: (emoji: { animated?: boolean; name?: string; id?: string }) => T) => T[];
    };
  };
};

type DiscoveryChannelLike = {
  id: string;
  guildId?: string;
  name?: string;
  guild?: DiscoveryGuildLike;
  isTextBased?: () => boolean;
  send?: (payload: unknown) => Promise<{
    id: string;
    createdTimestamp: number;
    guildId: string;
    channelId: string;
  }>;
  sendTyping?: () => Promise<unknown>;
};

type DiscoveryClientLike = DiscoveryContext["client"] & {
  user?: {
    id?: string;
  } | null;
  channels: {
    cache: {
      get: (id: string) => DiscoveryChannelLike | undefined;
    };
  };
};

type DiscoveryRecentMessageRow = {
  author_name?: string;
  content?: string;
  created_at?: string;
  is_bot?: boolean;
};

type DiscoveryMediaAttachmentResult = {
  payload: {
    content: string;
    files?: unknown[];
  };
  imageUsed: boolean;
  imageBudgetBlocked: boolean;
  imageCapabilityBlocked: boolean;
  imageVariantUsed: string | null;
  videoUsed: boolean;
  videoBudgetBlocked: boolean;
  videoCapabilityBlocked: boolean;
};

type DiscoveryCollectResult = {
  enabled: boolean;
  topics: string[];
  candidates: DiscoveryLinkCandidate[];
  selected: DiscoveryLinkCandidate[];
  reports: string[];
  errors: string[];
};

export type DiscoveryEngineRuntime = DiscoveryContext & {
  readonly client: DiscoveryClientLike;
  discoveryPosting: boolean;
  canSendMessage: (maxPerHour: number) => boolean;
  canTalkNow: (settings: Record<string, unknown>) => boolean;
  hydrateRecentMessages: (channel: DiscoveryChannelLike, limit: number) => Promise<Array<{
    author?: { bot?: boolean; username?: string };
    member?: { displayName?: string };
    content?: string;
    createdTimestamp: number;
  } & Record<string, unknown>>>;
  loadRelevantMemoryFacts: (payload: {
    settings: Record<string, unknown>;
    guildId?: string | null;
    channelId?: string | null;
    queryText?: string;
    trace?: Record<string, unknown>;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  buildMediaMemoryFacts: (payload: {
    userFacts: Array<Record<string, unknown>>;
    relevantFacts: Array<Record<string, unknown>>;
  }) => string[];
  getImageBudgetState: (settings: Record<string, unknown>) => {
    canGenerate: boolean;
    remaining: number;
  };
  getVideoGenerationBudgetState: (settings: Record<string, unknown>) => {
    canGenerate: boolean;
    remaining: number;
  };
  getMediaGenerationCapabilities: (settings: Record<string, unknown>) => {
    simpleImageReady: boolean;
    complexImageReady: boolean;
    videoReady: boolean;
  };
  getEmojiHints: (guild: DiscoveryGuildLike | null | undefined) => string[];
  resolveMediaAttachment: (payload: {
    settings: Record<string, unknown>;
    text: string;
    directive: {
      type: string | null;
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
  }) => Promise<DiscoveryMediaAttachmentResult>;
  composeMessageContentForHistory: (message: unknown, baseText?: string) => string;
  markSpoke: () => void;
  getSimulatedTypingDelayMs: (minMs: number, jitterMs: number) => number;
  isChannelAllowed: (settings: Record<string, unknown>, channelId: string) => boolean;
};

export async function maybeRunDiscoveryCycle(
  runtime: DiscoveryEngineRuntime,
  { startup = false }: { startup?: boolean } = {}
) {
  if (runtime.discoveryPosting) return;
  runtime.discoveryPosting = true;

  try {
    const settings = runtime.store.getSettings();
    const discovery = getDiscoverySettings(settings);
    const memory = getMemorySettings(settings);
    const permissions = getReplyPermissions(settings);
    const botName = getBotName(settings);
    if (!discovery.enabled) return;
    if (!discovery.channelIds.length) return;
    if (discovery.maxPostsPerDay <= 0) return;
    if (!runtime.canSendMessage(permissions.maxMessagesPerHour)) return;
    if (!runtime.canTalkNow(settings)) return;

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const posts24h = runtime.store.countActionsSince("discovery_post", since24h);
    if (posts24h >= discovery.maxPostsPerDay) return;

    const lastPostAt = runtime.store.getLastActionTime("discovery_post");
    const lastPostTs = lastPostAt ? new Date(lastPostAt).getTime() : 0;
    const nowTs = Date.now();
    const elapsedMs = lastPostTs ? nowTs - lastPostTs : null;
    const scheduleDecision = evaluateDiscoverySchedule({
      settings,
      startup,
      lastPostTs,
      elapsedMs,
      posts24h
    });
    if (!scheduleDecision.shouldPost) return;

    const channel = pickDiscoveryChannel({
      settings,
      client: runtime.client,
      isChannelAllowed: (resolvedSettings, channelId) => runtime.isChannelAllowed(resolvedSettings, channelId)
    });
    if (!channel) return;

    const recent = await runtime.hydrateRecentMessages(channel, memory.promptSlice.maxRecentMessages);
    const recentMessages = recent.length
      ? recent
        .slice()
        .reverse()
        .slice(0, memory.promptSlice.maxRecentMessages)
        .map((msg) => ({
          author_name: msg.member?.displayName || msg.author?.username || "unknown",
          content: String(msg.content || "").trim(),
          created_at: new Date(msg.createdTimestamp).toISOString(),
          is_bot: Boolean(msg.author?.bot)
        }))
      : runtime.store.getRecentMessages(channel.id, memory.promptSlice.maxRecentMessages);
    const discoveryMemoryQuery = recentMessages
      .slice(0, 6)
      .map((row) => String(row?.content || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    const discoveryRelevantFacts = await runtime.loadRelevantMemoryFacts({
      settings,
      guildId: channel.guildId,
      channelId: channel.id,
      queryText: discoveryMemoryQuery,
      trace: {
        guildId: channel.guildId || null,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        source: "discovery_prompt"
      },
      limit: 8
    });
    const discoveryMediaMemoryFacts = runtime.buildMediaMemoryFacts({
      userFacts: [],
      relevantFacts: discoveryRelevantFacts
    });

    const discoveryResult = await collectDiscoveryForPost(runtime, {
      settings,
      channel,
      recentMessages
    });
    const requireDiscoveryLink =
      discoveryResult.enabled &&
      discoveryResult.candidates.length > 0 &&
      chance((discovery.linkChancePercent || 0) / 100);
    const discoveryImageBudget = runtime.getImageBudgetState(settings);
    const discoveryVideoBudget = runtime.getVideoGenerationBudgetState(settings);
    const discoveryMediaCapabilities = runtime.getMediaGenerationCapabilities(settings);
    const discoverySimpleImageCapabilityReady = discoveryMediaCapabilities.simpleImageReady;
    const discoveryComplexImageCapabilityReady = discoveryMediaCapabilities.complexImageReady;
    const discoveryImageCapabilityReady =
      discoverySimpleImageCapabilityReady || discoveryComplexImageCapabilityReady;
    const discoveryVideoCapabilityReady = discoveryMediaCapabilities.videoReady;

    const systemPrompt = buildSystemPrompt(settings);
    const userPrompt = buildDiscoveryPrompt({
      channelName: channel.name || "channel",
      recentMessages,
      relevantFacts: discoveryRelevantFacts,
      emojiHints: runtime.getEmojiHints(channel.guild),
      allowSimpleImagePosts:
        discovery.allowImagePosts &&
        discoverySimpleImageCapabilityReady &&
        discoveryImageBudget.canGenerate,
      allowComplexImagePosts:
        discovery.allowImagePosts &&
        discoveryComplexImageCapabilityReady &&
        discoveryImageBudget.canGenerate,
      remainingDiscoveryImages: discoveryImageBudget.remaining,
      allowVideoPosts:
        discovery.allowVideoPosts &&
        discoveryVideoCapabilityReady &&
        discoveryVideoBudget.canGenerate,
      remainingDiscoveryVideos: discoveryVideoBudget.remaining,
      discoveryFindings: discoveryResult.candidates,
      maxLinksPerPost: discovery.maxLinksPerPost || 2,
      requireDiscoveryLink,
      maxMediaPromptChars: resolveMaxMediaPromptLen(settings),
      mediaPromptCraftGuidance: getMediaPromptCraftGuidance(settings)
    });

    const generation = await runtime.llm.generate({
      settings,
      systemPrompt,
      userPrompt,
      trace: {
        guildId: channel.guildId || null,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        source: startup ? "discovery_startup" : "discovery_scheduler",
        event: "discovery_post",
        reason: null,
        messageId: null
      }
    });

    const discoveryMediaPromptLimit = resolveMaxMediaPromptLen(settings);
    const discoveryDirective = parseDiscoveryMediaDirective(generation.text, discoveryMediaPromptLimit);
    const imagePrompt = discoveryDirective.imagePrompt;
    const complexImagePrompt = discoveryDirective.complexImagePrompt;
    const videoPrompt = discoveryDirective.videoPrompt;
    const mediaDirective = pickDiscoveryMediaDirective(discoveryDirective);
    let finalText = sanitizeBotText(discoveryDirective.text || (mediaDirective ? "" : generation.text));
    finalText = normalizeSkipSentinel(finalText);
    const allowMediaOnlyDiscovery = !finalText && Boolean(mediaDirective);
    if (finalText === "[SKIP]") return;
    if (!finalText && !allowMediaOnlyDiscovery) {
      runtime.store.logAction({
        kind: "bot_error",
        guildId: channel.guildId,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        content: "discovery_model_output_empty",
        metadata: {
          source: startup ? "discovery_startup" : "discovery_scheduler"
        }
      });
      return;
    }
    const linkPolicy = applyDiscoveryLinkPolicy({
      text: finalText,
      candidates: discoveryResult.candidates,
      selected: discoveryResult.selected,
      requireDiscoveryLink
    });
    finalText = normalizeSkipSentinel(linkPolicy.text);
    const allowMediaOnlyAfterLinkPolicy = !finalText && Boolean(mediaDirective);
    if (finalText === "[SKIP]") return;
    if (!finalText && !allowMediaOnlyAfterLinkPolicy) {
      runtime.store.logAction({
        kind: "bot_error",
        guildId: channel.guildId,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        content: "discovery_model_output_empty_after_link_policy",
        metadata: {
          source: startup ? "discovery_startup" : "discovery_scheduler",
          forcedLink: Boolean(linkPolicy.forcedLink)
        }
      });
      return;
    }
    const mentionResolution = await resolveDeterministicMentionsForMentions(
      { store: runtime.store },
      {
        text: finalText,
        guild: channel.guild,
        guildId: channel.guildId
      }
    );
    finalText = mentionResolution.text;

    let payload = { content: finalText };
    let imageUsed = false;
    let imageBudgetBlocked = false;
    let imageCapabilityBlocked = false;
    let imageVariantUsed = null;
    let videoUsed = false;
    let videoBudgetBlocked = false;
    let videoCapabilityBlocked = false;
    const mediaAttachment = await runtime.resolveMediaAttachment({
      settings,
      text: finalText,
      directive: {
        type: mediaDirective?.type ?? null,
        imagePrompt:
          mediaDirective?.type === "image_simple" &&
            discovery.allowImagePosts &&
            imagePrompt
            ? composeDiscoveryImagePrompt(
              imagePrompt,
              finalText,
              discoveryMediaPromptLimit,
              discoveryMediaMemoryFacts
            )
            : null,
        complexImagePrompt:
          mediaDirective?.type === "image_complex" &&
            discovery.allowImagePosts &&
            complexImagePrompt
            ? composeDiscoveryImagePrompt(
              complexImagePrompt,
              finalText,
              discoveryMediaPromptLimit,
              discoveryMediaMemoryFacts
            )
            : null,
        videoPrompt:
          mediaDirective?.type === "video" &&
            discovery.allowVideoPosts &&
            videoPrompt
            ? composeDiscoveryVideoPrompt(
              videoPrompt,
              finalText,
              discoveryMediaPromptLimit,
              discoveryMediaMemoryFacts
            )
            : null
      },
      trace: {
        guildId: channel.guildId || null,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        source: "discovery_post"
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

    if (!finalText && !imageUsed && !videoUsed) {
      runtime.store.logAction({
        kind: "bot_error",
        guildId: channel.guildId,
        channelId: channel.id,
        userId: runtime.client.user?.id || null,
        content: "discovery_model_output_empty_after_media",
        metadata: {
          source: startup ? "discovery_startup" : "discovery_scheduler"
        }
      });
      return;
    }

    await channel.sendTyping();
    await sleep(runtime.getSimulatedTypingDelayMs(500, 1200));

    const discoveryChunks = splitDiscordMessage(payload.content);
    const discoveryFirstPayload = { ...payload, content: discoveryChunks[0] };
    const sent = await channel.send(discoveryFirstPayload);
    for (let i = 1; i < discoveryChunks.length; i++) {
      await channel.send({ content: discoveryChunks[i] });
    }

    runtime.markSpoke();
    runtime.store.recordMessage({
      messageId: sent.id,
      createdAt: sent.createdTimestamp,
      guildId: sent.guildId,
      channelId: sent.channelId,
      authorId: runtime.client.user?.id || "unknown",
      authorName: botName,
      isBot: true,
      content: runtime.composeMessageContentForHistory(sent, finalText),
      referencedMessageId: null
    });
    for (const sharedLink of linkPolicy.usedLinks) {
      runtime.store.recordSharedLink({
        url: sharedLink.url,
        source: sharedLink.source
      });
    }

    runtime.store.logAction({
      kind: "discovery_post",
      guildId: sent.guildId,
      channelId: sent.channelId,
      messageId: sent.id,
      userId: runtime.client.user?.id || null,
      content: finalText,
      metadata: {
        source: startup ? "discovery_startup" : "discovery_scheduler",
        pacing: {
          mode: scheduleDecision.mode,
          trigger: scheduleDecision.trigger,
          chance: "chance" in scheduleDecision ? scheduleDecision.chance ?? null : null,
          roll: "roll" in scheduleDecision ? scheduleDecision.roll ?? null : null,
          elapsedMs: scheduleDecision.elapsedMs ?? null,
          requiredIntervalMs: scheduleDecision.requiredIntervalMs ?? null
        },
        discovery: {
          enabled: discoveryResult.enabled,
          requiredLink: requireDiscoveryLink,
          topics: discoveryResult.topics,
          candidateCount: discoveryResult.candidates.length,
          selectedCount: discoveryResult.selected.length,
          usedLinks: linkPolicy.usedLinks,
          forcedLink: linkPolicy.forcedLink,
          reports: discoveryResult.reports,
          errors: discoveryResult.errors
        },
        mentions: mentionResolution,
        imageRequestedByModel: Boolean(imagePrompt || complexImagePrompt),
        imageRequestedSimpleByModel: Boolean(imagePrompt),
        imageRequestedComplexByModel: Boolean(complexImagePrompt),
        imageUsed,
        imageVariantUsed,
        imageBudgetBlocked,
        imageCapabilityBlocked,
        imageSimpleCapabilityReadyAtPromptTime: discoverySimpleImageCapabilityReady,
        imageComplexCapabilityReadyAtPromptTime: discoveryComplexImageCapabilityReady,
        imageCapabilityReadyAtPromptTime: discoveryImageCapabilityReady,
        videoRequestedByModel: Boolean(videoPrompt),
        videoUsed,
        videoBudgetBlocked,
        videoCapabilityBlocked,
        videoCapabilityReadyAtPromptTime: discoveryVideoCapabilityReady,
        llm: {
          provider: generation.provider,
          model: generation.model,
          usage: generation.usage,
          costUsd: generation.costUsd
        }
      }
    });
  } finally {
    runtime.discoveryPosting = false;
  }
}

export async function collectDiscoveryForPost(
  runtime: DiscoveryEngineRuntime,
  {
    settings,
    channel,
    recentMessages
  }: {
    settings: Record<string, unknown>;
    channel: DiscoveryChannelLike & {
      guild: DiscoveryGuildLike;
    };
    recentMessages: DiscoveryRecentMessageRow[];
  }
): Promise<DiscoveryCollectResult> {
  if (!runtime.discovery) {
    return {
      enabled: false,
      topics: [],
      candidates: [],
      selected: [],
      reports: [],
      errors: []
    };
  }

  try {
    return await runtime.discovery.collect({
      settings,
      guildId: channel.guildId,
      channelId: channel.id,
      channelName: channel.name || "channel",
      recentMessages
    });
  } catch (error) {
    runtime.store.logAction({
      kind: "bot_error",
      guildId: channel.guildId,
      channelId: channel.id,
      userId: runtime.client.user?.id || null,
      content: `discovery_collect: ${String(error instanceof Error ? error.message : error)}`
    });

    return {
      enabled: true,
      topics: [],
      candidates: [],
      selected: [],
      reports: [],
      errors: [String(error instanceof Error ? error.message : error)]
    };
  }
}

export function applyDiscoveryLinkPolicy({
  text,
  candidates,
  selected,
  requireDiscoveryLink
}: {
  text: string;
  candidates?: DiscoveryLinkCandidate[];
  selected?: DiscoveryLinkCandidate[];
  requireDiscoveryLink?: boolean;
}) {
  const cleanText = sanitizeBotText(text);
  const candidateEntries: Array<[string, DiscoveryLinkCandidate]> = [];
  for (const item of candidates || []) {
    const normalizedUrl = normalizeDiscoveryUrl(item.url);
    if (!normalizedUrl) continue;
    candidateEntries.push([normalizedUrl, item]);
  }
  const candidateMap = new Map<string, DiscoveryLinkCandidate>(candidateEntries);
  const mentionedUrls = extractUrlsFromText(cleanText);
  const matchedLinks = mentionedUrls
    .map((url) => normalizeDiscoveryUrl(url))
    .filter(Boolean)
    .filter((url, index, arr) => arr.indexOf(url) === index)
    .map((url) => ({
      url,
      source: candidateMap.get(url)?.source || "discovery"
    }));

  if (matchedLinks.length || !requireDiscoveryLink) {
    return {
      text: cleanText,
      usedLinks: matchedLinks,
      forcedLink: false
    };
  }

  const fallbackPool = [...(selected || []), ...(candidates || [])];
  const fallback = fallbackPool.find((item) => normalizeDiscoveryUrl(item.url));
  if (!fallback) {
    return {
      text: "[SKIP]",
      usedLinks: [],
      forcedLink: false
    };
  }

  const fallbackUrl = normalizeDiscoveryUrl(fallback.url);
  const withForcedLink = sanitizeBotText(`${cleanText}\n${fallbackUrl}`);
  return {
    text: withForcedLink,
    usedLinks: [
      {
        url: fallbackUrl,
        source: fallback.source || "discovery"
      }
    ],
    forcedLink: true
  };
}
