import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../settings/settingsConstraints.ts";
import {
  normalizeBoolean,
  normalizeInt,
  normalizeLanguageHint,
  normalizeNumber,
  normalizePromptBlock,
  normalizeString,
  normalizeStringList
} from "./primitives.ts";
import {
  normalizeOperationalMessages,
  normalizeReplyPath,
  normalizeVoiceDefaultInterruptionMode
} from "./shared.ts";
import {
  normalizeStreamWatchVisualizerMode,
  resolveVoiceAdmissionModeForSettings
} from "../../settings/voiceDashboardMappings.ts";

export function normalizeVoiceSection(section: Settings["voice"]): Settings["voice"] {
  const transcription = section.transcription;
  const channelPolicy = section.channelPolicy;
  const sessionLimits = section.sessionLimits;
  const conversationPolicy = section.conversationPolicy;
  const admission = section.admission;
  const streamWatch = section.streamWatch;
  const soundboard = section.soundboard;
  const normalizedReplyPath = normalizeReplyPath(
    conversationPolicy.replyPath,
    DEFAULT_SETTINGS.voice.conversationPolicy.replyPath
  );
  const normalizedTtsMode = normalizedReplyPath === "brain" &&
    normalizeString(
      conversationPolicy.ttsMode,
      DEFAULT_SETTINGS.voice.conversationPolicy.ttsMode,
      20
    ).toLowerCase() === "api"
    ? "api"
    : "realtime";

  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.voice.enabled),
    transcription: {
      enabled: normalizeBoolean(transcription.enabled, DEFAULT_SETTINGS.voice.transcription.enabled),
      languageMode:
        normalizeString(
          transcription.languageMode,
          DEFAULT_SETTINGS.voice.transcription.languageMode,
          40
        ).toLowerCase() === "fixed"
          ? "fixed"
          : "auto",
      languageHint: normalizeLanguageHint(
        transcription.languageHint,
        DEFAULT_SETTINGS.voice.transcription.languageHint
      )
    },
    channelPolicy: {
      allowedChannelIds: normalizeStringList(channelPolicy.allowedChannelIds, 200, 60),
      blockedChannelIds: normalizeStringList(channelPolicy.blockedChannelIds, 200, 60),
      blockedUserIds: normalizeStringList(channelPolicy.blockedUserIds, 200, 60)
    },
    sessionLimits: {
      maxSessionMinutes: normalizeInt(
        sessionLimits.maxSessionMinutes,
        DEFAULT_SETTINGS.voice.sessionLimits.maxSessionMinutes,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionMinutes.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionMinutes.max
      ),
      inactivityLeaveSeconds: normalizeInt(
        sessionLimits.inactivityLeaveSeconds,
        DEFAULT_SETTINGS.voice.sessionLimits.inactivityLeaveSeconds,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.inactivityLeaveSeconds.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.inactivityLeaveSeconds.max
      ),
      maxSessionsPerDay: normalizeInt(
        sessionLimits.maxSessionsPerDay,
        DEFAULT_SETTINGS.voice.sessionLimits.maxSessionsPerDay,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionsPerDay.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionsPerDay.max
      ),
      maxConcurrentSessions: normalizeInt(
        sessionLimits.maxConcurrentSessions,
        DEFAULT_SETTINGS.voice.sessionLimits.maxConcurrentSessions,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxConcurrentSessions.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxConcurrentSessions.max
      )
    },
    conversationPolicy: {
      ambientReplyEagerness: normalizeInt(
        conversationPolicy.ambientReplyEagerness,
        DEFAULT_SETTINGS.voice.conversationPolicy.ambientReplyEagerness,
        0,
        100
      ),
      commandOnlyMode: normalizeBoolean(
        conversationPolicy.commandOnlyMode,
        DEFAULT_SETTINGS.voice.conversationPolicy.commandOnlyMode
      ),
      allowNsfwHumor: normalizeBoolean(
        conversationPolicy.allowNsfwHumor,
        DEFAULT_SETTINGS.voice.conversationPolicy.allowNsfwHumor
      ),
      textOnlyMode: normalizeBoolean(
        conversationPolicy.textOnlyMode,
        DEFAULT_SETTINGS.voice.conversationPolicy.textOnlyMode
      ),
      defaultInterruptionMode: normalizeVoiceDefaultInterruptionMode(
        conversationPolicy.defaultInterruptionMode,
        DEFAULT_SETTINGS.voice.conversationPolicy.defaultInterruptionMode
      ),
      replyPath: normalizedReplyPath,
      ttsMode: normalizedTtsMode,
      operationalMessages: normalizeOperationalMessages(
        conversationPolicy.operationalMessages,
        DEFAULT_SETTINGS.voice.conversationPolicy.operationalMessages
      ),
      streaming: {
        enabled: normalizeBoolean(
          conversationPolicy.streaming?.enabled,
          DEFAULT_SETTINGS.voice.conversationPolicy.streaming.enabled
        ),
        minSentencesPerChunk: normalizeInt(
          conversationPolicy.streaming?.minSentencesPerChunk,
          DEFAULT_SETTINGS.voice.conversationPolicy.streaming.minSentencesPerChunk,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.minSentencesPerChunk.min,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.minSentencesPerChunk.max
        ),
        eagerFirstChunkChars: normalizeInt(
          conversationPolicy.streaming?.eagerFirstChunkChars,
          DEFAULT_SETTINGS.voice.conversationPolicy.streaming.eagerFirstChunkChars,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.eagerFirstChunkChars.min,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.eagerFirstChunkChars.max
        ),
        maxBufferChars: normalizeInt(
          conversationPolicy.streaming?.maxBufferChars,
          DEFAULT_SETTINGS.voice.conversationPolicy.streaming.maxBufferChars,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.maxBufferChars.min,
          SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.maxBufferChars.max
        )
      }
    },
    admission: {
      mode: resolveVoiceAdmissionModeForSettings({
        value: admission.mode,
        replyPath: normalizedReplyPath
      }),
      wakeSignals: normalizeStringList(
        admission.wakeSignals,
        10,
        40,
        DEFAULT_SETTINGS.voice.admission.wakeSignals
      ),
      musicWakeLatchSeconds: normalizeInt(
        admission.musicWakeLatchSeconds,
        DEFAULT_SETTINGS.voice.admission.musicWakeLatchSeconds,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.admission.musicWakeLatchSeconds.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.admission.musicWakeLatchSeconds.max
      )
    },
    streamWatch: {
      enabled: normalizeBoolean(streamWatch.enabled, DEFAULT_SETTINGS.voice.streamWatch.enabled),
      visualizerMode: normalizeStreamWatchVisualizerMode(
        streamWatch.visualizerMode,
        DEFAULT_SETTINGS.voice.streamWatch.visualizerMode
      ),
      minCommentaryIntervalSeconds: normalizeInt(
        streamWatch.minCommentaryIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.minCommentaryIntervalSeconds,
        3,
        120
      ),
      maxFramesPerMinute: normalizeInt(
        streamWatch.maxFramesPerMinute,
        DEFAULT_SETTINGS.voice.streamWatch.maxFramesPerMinute,
        6,
        600
      ),
      maxFrameBytes: normalizeInt(
        streamWatch.maxFrameBytes,
        DEFAULT_SETTINGS.voice.streamWatch.maxFrameBytes,
        50_000,
        4_000_000
      ),
      keyframeIntervalMs: normalizeInt(
        streamWatch.keyframeIntervalMs,
        DEFAULT_SETTINGS.voice.streamWatch.keyframeIntervalMs,
        500,
        2_000
      ),
      autonomousCommentaryEnabled: normalizeBoolean(
        streamWatch.autonomousCommentaryEnabled,
        DEFAULT_SETTINGS.voice.streamWatch.autonomousCommentaryEnabled
      ),
      brainContextEnabled: normalizeBoolean(
        streamWatch.brainContextEnabled,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextEnabled
      ),
      brainContextMinIntervalSeconds: normalizeInt(
        streamWatch.brainContextMinIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextMinIntervalSeconds,
        1,
        60
      ),
      brainContextMaxEntries: normalizeInt(
        streamWatch.brainContextMaxEntries,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextMaxEntries,
        1,
        24
      ),
      brainContextProvider: normalizeString(
        streamWatch.brainContextProvider,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextProvider,
        40
      ),
      brainContextModel: normalizeString(
        streamWatch.brainContextModel,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextModel,
        120
      ),
      brainContextPrompt: normalizePromptBlock(
        streamWatch.brainContextPrompt,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextPrompt,
        420
      ),
      nativeDiscordMaxFramesPerSecond: normalizeInt(
        streamWatch.nativeDiscordMaxFramesPerSecond,
        DEFAULT_SETTINGS.voice.streamWatch.nativeDiscordMaxFramesPerSecond,
        1,
        10
      ),
      nativeDiscordPreferredQuality: normalizeInt(
        streamWatch.nativeDiscordPreferredQuality,
        DEFAULT_SETTINGS.voice.streamWatch.nativeDiscordPreferredQuality,
        0,
        100
      ),
      nativeDiscordPreferredPixelCount: normalizeInt(
        streamWatch.nativeDiscordPreferredPixelCount,
        DEFAULT_SETTINGS.voice.streamWatch.nativeDiscordPreferredPixelCount,
        64 * 64,
        3840 * 2160
      ),
      nativeDiscordPreferredStreamType: normalizeString(
        streamWatch.nativeDiscordPreferredStreamType,
        DEFAULT_SETTINGS.voice.streamWatch.nativeDiscordPreferredStreamType,
        32
      ),
      sharePageMaxWidthPx: normalizeInt(
        streamWatch.sharePageMaxWidthPx,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageMaxWidthPx,
        640,
        1_920
      ),
      sharePageJpegQuality: normalizeNumber(
        streamWatch.sharePageJpegQuality,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageJpegQuality,
        0.5,
        0.75
      )
    },
    soundboard: {
      eagerness: normalizeInt(
        soundboard.eagerness,
        DEFAULT_SETTINGS.voice.soundboard.eagerness,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.soundboard.eagerness.min,
        SETTINGS_NUMERIC_CONSTRAINTS.voice.soundboard.eagerness.max
      ),
      enabled: normalizeBoolean(soundboard.enabled, DEFAULT_SETTINGS.voice.soundboard.enabled),
      allowExternalSounds: normalizeBoolean(
        soundboard.allowExternalSounds,
        DEFAULT_SETTINGS.voice.soundboard.allowExternalSounds
      ),
      preferredSoundIds: normalizeStringList(soundboard.preferredSoundIds, 100, 160)
    }
  };
}
