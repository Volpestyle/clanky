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
      provider:
        normalizeString(
          transcription.provider,
          DEFAULT_SETTINGS.voice.transcription.provider,
          40
        ).toLowerCase() === "elevenlabs"
          ? "elevenlabs"
          : "openai",
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
      useInterruptClassifier: normalizeBoolean(
        conversationPolicy.useInterruptClassifier,
        DEFAULT_SETTINGS.voice.conversationPolicy.useInterruptClassifier
      ),
      replyPath: normalizedReplyPath,
      ttsMode: normalizedTtsMode,
      thinking:
        normalizeString(
          conversationPolicy.thinking,
          DEFAULT_SETTINGS.voice.conversationPolicy.thinking,
          20
        ).toLowerCase() === "think_aloud"
          ? "think_aloud"
          : normalizeString(
              conversationPolicy.thinking,
              DEFAULT_SETTINGS.voice.conversationPolicy.thinking,
              20
            ).toLowerCase() === "enabled"
            ? "enabled"
            : "disabled",
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
      commentaryEagerness: normalizeInt(
        streamWatch.commentaryEagerness,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryEagerness,
        0,
        100
      ),
      visualizerMode: normalizeStreamWatchVisualizerMode(
        streamWatch.visualizerMode,
        DEFAULT_SETTINGS.voice.streamWatch.visualizerMode
      ),
      commentaryIntervalSeconds: normalizeInt(
        streamWatch.commentaryIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryIntervalSeconds,
        5,
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
      noteProvider: normalizeString(
        streamWatch.noteProvider,
        DEFAULT_SETTINGS.voice.streamWatch.noteProvider,
        40
      ),
      noteModel: normalizeString(
        streamWatch.noteModel,
        DEFAULT_SETTINGS.voice.streamWatch.noteModel,
        120
      ),
      noteIntervalSeconds: normalizeInt(
        streamWatch.noteIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.noteIntervalSeconds,
        3,
        120
      ),
      noteIdleIntervalSeconds: normalizeInt(
        streamWatch.noteIdleIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.noteIdleIntervalSeconds,
        10,
        120
      ),
      staticFloor: normalizeNumber(
        streamWatch.staticFloor,
        DEFAULT_SETTINGS.voice.streamWatch.staticFloor,
        0.001,
        0.05
      ),
      maxNoteEntries: normalizeInt(
        streamWatch.maxNoteEntries,
        DEFAULT_SETTINGS.voice.streamWatch.maxNoteEntries,
        1,
        24
      ),
      changeThreshold: normalizeNumber(
        streamWatch.changeThreshold,
        DEFAULT_SETTINGS.voice.streamWatch.changeThreshold,
        0.005,
        1.0
      ),
      changeMinIntervalSeconds: normalizeInt(
        streamWatch.changeMinIntervalSeconds,
        DEFAULT_SETTINGS.voice.streamWatch.changeMinIntervalSeconds,
        1,
        30
      ),
      notePrompt: normalizePromptBlock(
        streamWatch.notePrompt,
        DEFAULT_SETTINGS.voice.streamWatch.notePrompt,
        420
      ),
      commentaryProvider: normalizeString(
        streamWatch.commentaryProvider,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryProvider,
        40
      ),
      commentaryModel: normalizeString(
        streamWatch.commentaryModel,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryModel,
        120
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
      nativeDiscordJpegQuality: normalizeInt(
        streamWatch.nativeDiscordJpegQuality,
        DEFAULT_SETTINGS.voice.streamWatch.nativeDiscordJpegQuality,
        10,
        100
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
