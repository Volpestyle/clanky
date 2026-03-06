import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeBoolean,
  normalizeInt
} from "./primitives.ts";
import { normalizeExecutionPolicy } from "./shared.ts";

export function normalizeMediaSection(section: Settings["media"]): Settings["media"] {
  const vision = section.vision;
  const videoContext = section.videoContext;

  return {
    vision: {
      enabled: normalizeBoolean(vision.enabled, DEFAULT_SETTINGS.media.vision.enabled),
      execution: normalizeExecutionPolicy(vision.execution, "anthropic", "claude-haiku-4-5", {
        fallbackMode: "dedicated_model"
      }),
      maxCaptionsPerHour: normalizeInt(
        vision.maxCaptionsPerHour,
        DEFAULT_SETTINGS.media.vision.maxCaptionsPerHour,
        0,
        500
      )
    },
    videoContext: {
      enabled: normalizeBoolean(videoContext.enabled, DEFAULT_SETTINGS.media.videoContext.enabled),
      execution: normalizeExecutionPolicy(videoContext.execution, "openai", "gpt-5"),
      maxLookupsPerHour: normalizeInt(
        videoContext.maxLookupsPerHour,
        DEFAULT_SETTINGS.media.videoContext.maxLookupsPerHour,
        0,
        200
      ),
      maxVideosPerMessage: normalizeInt(
        videoContext.maxVideosPerMessage,
        DEFAULT_SETTINGS.media.videoContext.maxVideosPerMessage,
        0,
        6
      ),
      maxTranscriptChars: normalizeInt(
        videoContext.maxTranscriptChars,
        DEFAULT_SETTINGS.media.videoContext.maxTranscriptChars,
        200,
        4_000
      ),
      keyframeIntervalSeconds: normalizeInt(
        videoContext.keyframeIntervalSeconds,
        DEFAULT_SETTINGS.media.videoContext.keyframeIntervalSeconds,
        0,
        120
      ),
      maxKeyframesPerVideo: normalizeInt(
        videoContext.maxKeyframesPerVideo,
        DEFAULT_SETTINGS.media.videoContext.maxKeyframesPerVideo,
        0,
        8
      ),
      allowAsrFallback: normalizeBoolean(
        videoContext.allowAsrFallback,
        DEFAULT_SETTINGS.media.videoContext.allowAsrFallback
      ),
      maxAsrSeconds: normalizeInt(
        videoContext.maxAsrSeconds,
        DEFAULT_SETTINGS.media.videoContext.maxAsrSeconds,
        15,
        600
      )
    }
  };
}
