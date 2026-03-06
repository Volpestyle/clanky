import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeBoolean,
  normalizeDiscoveryRssFeeds,
  normalizeHttpBaseUrl,
  normalizeInt,
  normalizeString,
  normalizeStringList,
  normalizeSubreddits,
  normalizeXHandles
} from "./primitives.ts";
import {
  normalizeDiscoverySourceMap,
  normalizeExecutionPolicy
} from "./shared.ts";

export function normalizeInitiativeSection(section: Settings["initiative"]): Settings["initiative"] {
  const text = section.text;
  const voice = section.voice;
  const discovery = section.discovery;

  return {
    text: {
      enabled: normalizeBoolean(text.enabled, DEFAULT_SETTINGS.initiative.text.enabled),
      execution: normalizeExecutionPolicy(text.execution, "openai", "gpt-5"),
      eagerness: normalizeInt(text.eagerness, DEFAULT_SETTINGS.initiative.text.eagerness, 0, 100),
      minMinutesBetweenThoughts: normalizeInt(
        text.minMinutesBetweenThoughts,
        DEFAULT_SETTINGS.initiative.text.minMinutesBetweenThoughts,
        5,
        24 * 60
      ),
      maxThoughtsPerDay: normalizeInt(
        text.maxThoughtsPerDay,
        DEFAULT_SETTINGS.initiative.text.maxThoughtsPerDay,
        0,
        100
      ),
      lookbackMessages: normalizeInt(
        text.lookbackMessages,
        DEFAULT_SETTINGS.initiative.text.lookbackMessages,
        4,
        80
      )
    },
    voice: {
      enabled: normalizeBoolean(voice.enabled, DEFAULT_SETTINGS.initiative.voice.enabled),
      execution: normalizeExecutionPolicy(voice.execution, "anthropic", "claude-sonnet-4-6", {
        fallbackMode: "dedicated_model",
        fallbackTemperature: 1.2
      }),
      eagerness: normalizeInt(voice.eagerness, DEFAULT_SETTINGS.initiative.voice.eagerness, 0, 100),
      minSilenceSeconds: normalizeInt(
        voice.minSilenceSeconds,
        DEFAULT_SETTINGS.initiative.voice.minSilenceSeconds,
        1,
        300
      ),
      minSecondsBetweenThoughts: normalizeInt(
        voice.minSecondsBetweenThoughts,
        DEFAULT_SETTINGS.initiative.voice.minSecondsBetweenThoughts,
        1,
        600
      )
    },
    discovery: {
      enabled: normalizeBoolean(discovery.enabled, DEFAULT_SETTINGS.initiative.discovery.enabled),
      channelIds: normalizeStringList(discovery.channelIds, 200, 60),
      maxPostsPerDay: normalizeInt(
        discovery.maxPostsPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxPostsPerDay,
        0,
        50
      ),
      minMinutesBetweenPosts: normalizeInt(
        discovery.minMinutesBetweenPosts,
        DEFAULT_SETTINGS.initiative.discovery.minMinutesBetweenPosts,
        1,
        24 * 60
      ),
      pacingMode:
        normalizeString(
          discovery.pacingMode,
          DEFAULT_SETTINGS.initiative.discovery.pacingMode,
          40
        ).toLowerCase() === "spontaneous"
          ? "spontaneous"
          : "even",
      spontaneity: normalizeInt(
        discovery.spontaneity,
        DEFAULT_SETTINGS.initiative.discovery.spontaneity,
        0,
        100
      ),
      postOnStartup: normalizeBoolean(
        discovery.postOnStartup,
        DEFAULT_SETTINGS.initiative.discovery.postOnStartup
      ),
      allowImagePosts: normalizeBoolean(
        discovery.allowImagePosts,
        DEFAULT_SETTINGS.initiative.discovery.allowImagePosts
      ),
      allowVideoPosts: normalizeBoolean(
        discovery.allowVideoPosts,
        DEFAULT_SETTINGS.initiative.discovery.allowVideoPosts
      ),
      allowReplyImages: normalizeBoolean(
        discovery.allowReplyImages,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyImages
      ),
      allowReplyVideos: normalizeBoolean(
        discovery.allowReplyVideos,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyVideos
      ),
      allowReplyGifs: normalizeBoolean(
        discovery.allowReplyGifs,
        DEFAULT_SETTINGS.initiative.discovery.allowReplyGifs
      ),
      maxImagesPerDay: normalizeInt(
        discovery.maxImagesPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxImagesPerDay,
        0,
        200
      ),
      maxVideosPerDay: normalizeInt(
        discovery.maxVideosPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxVideosPerDay,
        0,
        120
      ),
      maxGifsPerDay: normalizeInt(
        discovery.maxGifsPerDay,
        DEFAULT_SETTINGS.initiative.discovery.maxGifsPerDay,
        0,
        300
      ),
      simpleImageModel: normalizeString(
        discovery.simpleImageModel,
        DEFAULT_SETTINGS.initiative.discovery.simpleImageModel,
        120
      ),
      complexImageModel: normalizeString(
        discovery.complexImageModel,
        DEFAULT_SETTINGS.initiative.discovery.complexImageModel,
        120
      ),
      videoModel: normalizeString(
        discovery.videoModel,
        DEFAULT_SETTINGS.initiative.discovery.videoModel,
        120
      ),
      allowedImageModels: normalizeStringList(
        discovery.allowedImageModels,
        20,
        120,
        DEFAULT_SETTINGS.initiative.discovery.allowedImageModels
      ),
      allowedVideoModels: normalizeStringList(
        discovery.allowedVideoModels,
        20,
        120,
        DEFAULT_SETTINGS.initiative.discovery.allowedVideoModels
      ),
      maxMediaPromptChars: normalizeInt(
        discovery.maxMediaPromptChars,
        DEFAULT_SETTINGS.initiative.discovery.maxMediaPromptChars,
        100,
        2_000
      ),
      linkChancePercent: normalizeInt(
        discovery.linkChancePercent,
        DEFAULT_SETTINGS.initiative.discovery.linkChancePercent,
        0,
        100
      ),
      maxLinksPerPost: normalizeInt(
        discovery.maxLinksPerPost,
        DEFAULT_SETTINGS.initiative.discovery.maxLinksPerPost,
        0,
        5
      ),
      maxCandidatesForPrompt: normalizeInt(
        discovery.maxCandidatesForPrompt,
        DEFAULT_SETTINGS.initiative.discovery.maxCandidatesForPrompt,
        1,
        20
      ),
      freshnessHours: normalizeInt(
        discovery.freshnessHours,
        DEFAULT_SETTINGS.initiative.discovery.freshnessHours,
        1,
        24 * 30
      ),
      dedupeHours: normalizeInt(
        discovery.dedupeHours,
        DEFAULT_SETTINGS.initiative.discovery.dedupeHours,
        1,
        24 * 90
      ),
      randomness: normalizeInt(
        discovery.randomness,
        DEFAULT_SETTINGS.initiative.discovery.randomness,
        0,
        100
      ),
      sourceFetchLimit: normalizeInt(
        discovery.sourceFetchLimit,
        DEFAULT_SETTINGS.initiative.discovery.sourceFetchLimit,
        1,
        50
      ),
      allowNsfw: normalizeBoolean(discovery.allowNsfw, DEFAULT_SETTINGS.initiative.discovery.allowNsfw),
      preferredTopics: normalizeStringList(discovery.preferredTopics, 50, 120),
      redditSubreddits: normalizeSubreddits(
        discovery.redditSubreddits,
        DEFAULT_SETTINGS.initiative.discovery.redditSubreddits
      ),
      youtubeChannelIds: normalizeStringList(discovery.youtubeChannelIds, 50, 120),
      rssFeeds: normalizeDiscoveryRssFeeds(
        discovery.rssFeeds,
        DEFAULT_SETTINGS.initiative.discovery.rssFeeds
      ),
      xHandles: normalizeXHandles(discovery.xHandles),
      xNitterBaseUrl: normalizeHttpBaseUrl(
        discovery.xNitterBaseUrl,
        DEFAULT_SETTINGS.initiative.discovery.xNitterBaseUrl
      ),
      sources: normalizeDiscoverySourceMap(discovery.sources)
    }
  };
}
