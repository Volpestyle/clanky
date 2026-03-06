import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
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
  normalizeStreamWatchCommentaryPath,
  normalizeVoiceAdmissionMode
} from "./shared.ts";

export function normalizeVoiceSection(section: Settings["voice"]): Settings["voice"] {
  const transcription = section.transcription;
  const channelPolicy = section.channelPolicy;
  const sessionLimits = section.sessionLimits;
  const conversationPolicy = section.conversationPolicy;
  const admission = section.admission;
  const streamWatch = section.streamWatch;
  const soundboard = section.soundboard;

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
        1,
        240
      ),
      inactivityLeaveSeconds: normalizeInt(
        sessionLimits.inactivityLeaveSeconds,
        DEFAULT_SETTINGS.voice.sessionLimits.inactivityLeaveSeconds,
        15,
        3_600
      ),
      maxSessionsPerDay: normalizeInt(
        sessionLimits.maxSessionsPerDay,
        DEFAULT_SETTINGS.voice.sessionLimits.maxSessionsPerDay,
        0,
        240
      ),
      maxConcurrentSessions: normalizeInt(
        sessionLimits.maxConcurrentSessions,
        DEFAULT_SETTINGS.voice.sessionLimits.maxConcurrentSessions,
        1,
        3
      )
    },
    conversationPolicy: {
      replyEagerness: normalizeInt(
        conversationPolicy.replyEagerness,
        DEFAULT_SETTINGS.voice.conversationPolicy.replyEagerness,
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
      replyPath: normalizeReplyPath(
        conversationPolicy.replyPath,
        DEFAULT_SETTINGS.voice.conversationPolicy.replyPath
      ),
      ttsMode:
        normalizeString(
          conversationPolicy.ttsMode,
          DEFAULT_SETTINGS.voice.conversationPolicy.ttsMode,
          20
        ).toLowerCase() === "api"
          ? "api"
          : "realtime",
      operationalMessages: normalizeOperationalMessages(
        conversationPolicy.operationalMessages,
        DEFAULT_SETTINGS.voice.conversationPolicy.operationalMessages
      )
    },
    admission: {
      mode: normalizeVoiceAdmissionMode(admission.mode, DEFAULT_SETTINGS.voice.admission.mode),
      wakeSignals: normalizeStringList(
        admission.wakeSignals,
        10,
        40,
        DEFAULT_SETTINGS.voice.admission.wakeSignals
      ),
      intentConfidenceThreshold: normalizeNumber(
        admission.intentConfidenceThreshold,
        DEFAULT_SETTINGS.voice.admission.intentConfidenceThreshold,
        0,
        1
      ),
      musicWakeLatchSeconds: normalizeInt(
        admission.musicWakeLatchSeconds,
        DEFAULT_SETTINGS.voice.admission.musicWakeLatchSeconds,
        0,
        120
      )
    },
    streamWatch: {
      enabled: normalizeBoolean(streamWatch.enabled, DEFAULT_SETTINGS.voice.streamWatch.enabled),
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
      commentaryPath: normalizeStreamWatchCommentaryPath(
        streamWatch.commentaryPath,
        DEFAULT_SETTINGS.voice.streamWatch.commentaryPath
      ),
      keyframeIntervalMs: normalizeInt(
        streamWatch.keyframeIntervalMs,
        DEFAULT_SETTINGS.voice.streamWatch.keyframeIntervalMs,
        250,
        10_000
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
      brainContextPrompt: normalizePromptBlock(
        streamWatch.brainContextPrompt,
        DEFAULT_SETTINGS.voice.streamWatch.brainContextPrompt,
        420
      ),
      sharePageMaxWidthPx: normalizeInt(
        streamWatch.sharePageMaxWidthPx,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageMaxWidthPx,
        320,
        1_920
      ),
      sharePageJpegQuality: normalizeNumber(
        streamWatch.sharePageJpegQuality,
        DEFAULT_SETTINGS.voice.streamWatch.sharePageJpegQuality,
        0.1,
        1
      )
    },
    soundboard: {
      enabled: normalizeBoolean(soundboard.enabled, DEFAULT_SETTINGS.voice.soundboard.enabled),
      allowExternalSounds: normalizeBoolean(
        soundboard.allowExternalSounds,
        DEFAULT_SETTINGS.voice.soundboard.allowExternalSounds
      ),
      preferredSoundIds: normalizeStringList(soundboard.preferredSoundIds, 100, 160)
    }
  };
}
