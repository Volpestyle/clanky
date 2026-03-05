import { clamp } from "lodash";
import {
  getPromptBotName
} from "../promptCore.ts";
import {
  normalizeInlineText,
  normalizeVoiceText,
  STT_TRANSCRIPT_MAX_CHARS,
  isVoiceTurnAddressedToBot,
  isLikelyVocativeAddressToOtherParticipant,
  isRealtimeMode,
  normalizeVoiceAddressingTargetToken
} from "./voiceSessionHelpers.ts";
import {
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS,
  NON_DIRECT_REPLY_MIN_SILENCE_MS,
  RECENT_ENGAGEMENT_WINDOW_MS,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
} from "./voiceSessionManager.constants.ts";
import {
  isLowSignalVoiceFragment
} from "./voiceDecisionRuntime.ts";
import { hasBotNameCue, DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD } from "../directAddressConfidence.ts";
import type {
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceAddressingState,
  VoiceAddressingAnnotation
} from "./voiceSessionTypes.ts";
import {
  musicPhaseShouldForceCommandOnly,
  musicPhaseShouldLockOutput
} from "./voiceSessionTypes.ts";


export function hasBotNameCueForTranscript(manager: any, { transcript = "", settings = null } = {}) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;

  const resolvedSettings = settings || manager.store.getSettings();
  const botName = getPromptBotName(resolvedSettings);
  const aliases = Array.isArray(resolvedSettings?.botNameAliases) ? resolvedSettings.botNameAliases : [];
  const primaryToken = String(botName || "")
    .replace(/[^a-z0-9\s]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .at(0) || "";
  const shortPrimaryToken = primaryToken.length >= 5 ? primaryToken.slice(0, 5) : "";
  const candidateNames = [
    botName,
    ...aliases,
    primaryToken,
    shortPrimaryToken
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);

  for (const candidate of candidateNames) {
    if (hasBotNameCue({ transcript: normalizedTranscript, botName: candidate })) {
      return true;
    }
  }
  return false;
}

export function buildVoiceConversationContext(manager: any, {
  session = null,
  userId = null,
  directAddressed = false,
  addressedToOtherParticipant = false,
  now = Date.now()
} = {}): VoiceConversationContext {
  const normalizedUserId = String(userId || "").trim();

  const lastAudioDeltaAt = Number(session?.lastAudioDeltaAt || 0);
  const msSinceAssistantReply = lastAudioDeltaAt > 0 ? Math.max(0, now - lastAudioDeltaAt) : null;
  const recentAssistantReply =
    Number.isFinite(msSinceAssistantReply) &&
    msSinceAssistantReply <= RECENT_ENGAGEMENT_WINDOW_MS;

  const lastDirectAddressUserId = String(session?.lastDirectAddressUserId || "").trim();
  const sameAsRecentDirectAddress =
    Boolean(normalizedUserId) &&
    Boolean(lastDirectAddressUserId) &&
    normalizedUserId === lastDirectAddressUserId;
  const lastDirectAddressAt = Number(session?.lastDirectAddressAt || 0);
  const msSinceDirectAddress = lastDirectAddressAt > 0 ? Math.max(0, now - lastDirectAddressAt) : null;
  const recentDirectAddress =
    Number.isFinite(msSinceDirectAddress) &&
    msSinceDirectAddress <= RECENT_ENGAGEMENT_WINDOW_MS;

  const engagedWithCurrentSpeaker =
    Boolean(directAddressed) ||
    (recentAssistantReply && sameAsRecentDirectAddress) ||
    (recentDirectAddress && sameAsRecentDirectAddress);
  const engaged =
    !addressedToOtherParticipant &&
    engagedWithCurrentSpeaker;

  return {
    engagementState: engaged ? "engaged" : "wake_word_biased",
    engaged,
    engagedWithCurrentSpeaker,
    recentAssistantReply,
    recentDirectAddress,
    sameAsRecentDirectAddress,
    msSinceAssistantReply: Number.isFinite(msSinceAssistantReply) ? msSinceAssistantReply : null,
    msSinceDirectAddress: Number.isFinite(msSinceDirectAddress) ? msSinceDirectAddress : null
  };
}

export function buildVoiceAddressingState(manager: any, {
  session = null,
  userId = null,
  now = Date.now(),
  maxItems = 6
} = {}): VoiceAddressingState | null {
  const sourceTurns = Array.isArray(session?.transcriptTurns) ? session.transcriptTurns : [];
  if (!sourceTurns.length) return null;

  const normalizedUserId = String(userId || "").trim();
  const normalizedMaxItems = Math.max(1, Math.min(12, Math.floor(Number(maxItems) || 6)));
  const annotatedRows = sourceTurns
    .filter((row) => row && typeof row === "object" && (row.role === "user" || row.role === "assistant"))
    .map((row) => {
      const normalized = manager.normalizeVoiceAddressingAnnotation({
        rawAddressing: row?.addressing
      });
      if (!normalized) return null;
      const atRaw = Number(row?.at || 0);
      const at = atRaw > 0 ? atRaw : null;
      const ageMs = at ? Math.max(0, now - at) : null;
      return {
        role: row.role === "assistant" ? "assistant" : "user",
        userId: String(row?.userId || "").trim() || null,
        speakerName: String(row?.speakerName || "").trim() || "someone",
        talkingTo: normalized.talkingTo || null,
        directedConfidence: Number(normalized.directedConfidence || 0),
        at,
        ageMs
      };
    })
    .filter(Boolean);
  if (!annotatedRows.length) return null;

  const recentAddressingGuesses = annotatedRows
    .slice(-normalizedMaxItems)
    .map((row) => ({
      speakerName: row.speakerName,
      talkingTo: row.talkingTo || null,
      directedConfidence: Number(clamp(Number(row.directedConfidence) || 0, 0, 1).toFixed(3)),
      ageMs: Number.isFinite(row.ageMs) ? Math.round(row.ageMs) : null
    }));

  const currentSpeakerRow = normalizedUserId
    ? [...annotatedRows]
      .reverse()
      .find((row) => row.role === "user" && String(row.userId || "") === normalizedUserId) || null
    : null;
  const lastDirectedToMeRow =
    [...annotatedRows]
      .reverse()
      .find((row) => row.role === "user" && row.talkingTo === "ME" && Number(row.directedConfidence || 0) > 0) ||
    null;

  return {
    currentSpeakerTarget: currentSpeakerRow?.talkingTo || null,
    currentSpeakerDirectedConfidence: Number(
      clamp(Number(currentSpeakerRow?.directedConfidence) || 0, 0, 1).toFixed(3)
    ),
    lastDirectedToMe: lastDirectedToMeRow
      ? {
        speakerName: lastDirectedToMeRow.speakerName,
        directedConfidence: Number(clamp(Number(lastDirectedToMeRow.directedConfidence) || 0, 0, 1).toFixed(3)),
        ageMs: Number.isFinite(lastDirectedToMeRow.ageMs) ? Math.round(lastDirectedToMeRow.ageMs) : null
      }
      : null,
    recentAddressingGuesses
  };
}

export function normalizeVoiceAddressingAnnotation(manager: any, {
  rawAddressing = null,
  directAddressed = false,
  directedConfidence = Number.NaN,
  source = "",
  reason = null
} = {}): VoiceAddressingAnnotation | null {
  const input = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
  const talkingToToken = normalizeVoiceAddressingTargetToken(input?.talkingTo ?? input?.target ?? "");
  let talkingTo = talkingToToken || null;

  const confidenceRaw = Number(
    input?.directedConfidence ?? input?.confidence ?? directedConfidence
  );
  let normalizedDirectedConfidence = Number.isFinite(confidenceRaw)
    ? clamp(confidenceRaw, 0, 1)
    : 0;

  if (directAddressed && !talkingTo) {
    talkingTo = "ME";
  }
  if (directAddressed && talkingTo === "ME") {
    normalizedDirectedConfidence = Math.max(normalizedDirectedConfidence, 0.72);
  }

  if (!talkingTo && normalizedDirectedConfidence <= 0) return null;

  const normalizedSource = String(source || "")
    .replace(/\s+/g, "_")
    .trim()
    .toLowerCase()
    .slice(0, 48);
  const normalizedReason =
    String(reason || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || null;

  return {
    talkingTo,
    directedConfidence: Number(normalizedDirectedConfidence.toFixed(3)),
    source: normalizedSource || null,
    reason: normalizedReason
  };
}

export async function evaluateVoiceReplyDecision(manager: any, {
  session,
  settings,
  userId,
  transcript,
  source: _source = "stt_pipeline",
  transcriptionContext: _transcriptionContext = null
}): Promise<VoiceReplyDecision> {
  const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
  const normalizedUserId = String(userId || "").trim();
  const voiceChannelParticipants = manager.getVoiceChannelParticipants(session);
  const participantCount = voiceChannelParticipants.length;
  const speakerName = manager.resolveVoiceSpeakerName(session, userId) || "someone";
  const participantList = voiceChannelParticipants
    .map((entry) => entry.displayName)
    .filter(Boolean)
    .slice(0, 10);
  const addressedToOtherParticipant = isLikelyVocativeAddressToOtherParticipant({
    transcript: normalizedTranscript,
    participantDisplayNames: participantList,
    botName: getPromptBotName(settings),
    speakerName
  });
  const now = Date.now();
  if (!normalizedTranscript) {
    const emptyConversationContext = manager.buildVoiceConversationContext({
      session,
      userId: normalizedUserId,
      directAddressed: false,
      addressedToOtherParticipant,
      now
    });
    return {
      allow: false,
      reason: "missing_transcript",
      participantCount,
      directAddressed: false,
      directAddressConfidence: 0,
      directAddressThreshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
      transcript: "",
      conversationContext: emptyConversationContext
    };
  }
  const directAddressedByWakePhrase = normalizedTranscript
    ? isVoiceTurnAddressedToBot(normalizedTranscript, settings)
    : false;
  const normalizeWakeTokens = (value = ""): string[] =>
    (String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .match(/[\p{L}\p{N}]+/gu) || []) as string[];
  const containsTokenSequence = (tokens = [], sequence = []) => {
    if (!Array.isArray(tokens) || !Array.isArray(sequence)) return false;
    if (!tokens.length || !sequence.length || sequence.length > tokens.length) return false;
    for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
      let matched = true;
      for (let index = 0; index < sequence.length; index += 1) {
        if (tokens[start + index] !== sequence[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
    return false;
  };
  const botWakeTokens = normalizeWakeTokens(settings?.botName || "");
  const transcriptWakeTokens = normalizeWakeTokens(normalizedTranscript);
  const transcriptWakeTokenSet = new Set(transcriptWakeTokens);
  const mergedWakeToken = botWakeTokens.length >= 2 ? botWakeTokens.join("") : "";
  const mergedWakeTokenAddressed = Boolean(mergedWakeToken) && transcriptWakeTokenSet.has(mergedWakeToken);
  const exactWakeSequenceAddressed = containsTokenSequence(transcriptWakeTokens, botWakeTokens);
  const primaryWakeToken = botWakeTokens.find((token) => token.length >= 4 && !["bot", "ai", "assistant"].includes(token))
    || botWakeTokens.find((token) => token.length >= 4)
    || "";
  const primaryWakeTokenAddressed = primaryWakeToken ? transcriptWakeTokenSet.has(primaryWakeToken) : false;
  const deterministicDirectAddressed =
    directAddressedByWakePhrase &&
    (
      primaryWakeTokenAddressed ||
      exactWakeSequenceAddressed ||
      !mergedWakeTokenAddressed
    );
  const directAddressAssessment = {
    confidence: deterministicDirectAddressed ? 0.92 : 0,
    threshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
    addressed: deterministicDirectAddressed,
    reason: deterministicDirectAddressed ? "deterministic_wake_phrase" : "deterministic_not_direct"
  };
  const directAddressConfidence = Number(directAddressAssessment.confidence) || 0;
  const directAddressThreshold = Number(directAddressAssessment.threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD;
  const directAddressed =
    !addressedToOtherParticipant &&
    directAddressConfidence >= directAddressThreshold;
  const replyEagerness = clamp(Number(settings?.voice?.replyEagerness) || 0, 0, 100);
  const baseConversationContext = manager.buildVoiceConversationContext({
    session,
    userId: normalizedUserId,
    directAddressed,
    addressedToOtherParticipant,
    now
  });
  const voiceAddressingState = manager.buildVoiceAddressingState({
    session,
    userId: normalizedUserId,
    now
  });
  const currentTurnAddressing = manager.normalizeVoiceAddressingAnnotation({
    directAddressed,
    directedConfidence: directAddressConfidence,
    source: "decision",
    reason: directAddressAssessment?.reason || null
  });
  const conversationContext = {
    ...baseConversationContext,
    voiceAddressingState,
    currentTurnAddressing
  };

  // Pending command followup (e.g., music disambiguation "2" / "the second one")
  // must be checked BEFORE the output lock — during music playback the session is
  // locked, but disambiguation resolution turns still need to pass through.
  const sameSpeakerPendingCommandFollowup =
    typeof manager.isMusicDisambiguationResolutionTurn === "function" &&
    manager.isMusicDisambiguationResolutionTurn(session, normalizedUserId, normalizedTranscript);
  if (sameSpeakerPendingCommandFollowup && !addressedToOtherParticipant) {
    return {
      allow: true,
      reason: "pending_command_followup",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  const replyOutputLockState = manager.getReplyOutputLockState(session);
  if (replyOutputLockState.locked) {
    return {
      allow: false,
      reason: "bot_turn_open",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext,
      retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
      outputLockReason: replyOutputLockState.reason
    };
  }

  if (manager.isCommandOnlyActive(session, settings)) {
    if (directAddressed || directAddressedByWakePhrase) {
      return {
        allow: true,
        reason: "command_only_direct_address",
        participantCount,
        directAddressed: true,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }
    return {
      allow: false,
      reason: "command_only_not_addressed",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  const lowSignalFragment = isLowSignalVoiceFragment(normalizedTranscript);

  const botRecentReplyFollowup =
    !directAddressed &&
    !addressedToOtherParticipant &&
    !lowSignalFragment &&
    Boolean(conversationContext.recentAssistantReply) &&
    Boolean(conversationContext.sameAsRecentDirectAddress);
  if (botRecentReplyFollowup) {
    return {
      allow: true,
      reason: "bot_recent_reply_followup",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  if (directAddressed) {
    return {
      allow: true,
      reason: "direct_address_fast_path",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  if (!directAddressed && replyEagerness <= 0) {
    return {
      allow: false,
      reason: "eagerness_disabled_without_direct_address",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  if (addressedToOtherParticipant) {
    return {
      allow: false,
      reason: "addressed_to_other_participant",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  const sessionMode = String(session?.mode || settings?.voice?.mode || "").trim().toLowerCase();
  const mergedWithGeneration =
    sessionMode === "stt_pipeline" ||
    (isRealtimeMode(sessionMode) &&
      typeof manager.resolveRealtimeReplyStrategy === "function" &&
      manager.resolveRealtimeReplyStrategy({ session, settings }) === "brain");

  const nameCueDetected = hasBotNameCueForTranscript(manager, {
    transcript: normalizedTranscript,
    settings
  });
  const configuredNonDirectSilenceMs = Number(settings?.voice?.nonDirectReplyMinSilenceMs);
  const nonDirectReplyMinSilenceMs = clamp(
    Number.isFinite(configuredNonDirectSilenceMs)
      ? Math.round(configuredNonDirectSilenceMs)
      : NON_DIRECT_REPLY_MIN_SILENCE_MS,
    600,
    12_000
  );
  const lastInboundAudioAt = Number(session?.lastInboundAudioAt || 0);
  const msSinceInboundAudio =
    lastInboundAudioAt > 0 ? Math.max(0, now - lastInboundAudioAt) : null;
  const wakeModeActive =
    Boolean(conversationContext?.recentAssistantReply) ||
    Boolean(conversationContext?.sameAsRecentDirectAddress);
  const shouldDelayNonDirectRealtimeReply =
    isRealtimeMode(sessionMode) &&
    mergedWithGeneration &&
    participantCount > 1 &&
    !directAddressed &&
    (!nameCueDetected && directAddressConfidence < directAddressThreshold && !wakeModeActive) &&
    Number.isFinite(msSinceInboundAudio) &&
    msSinceInboundAudio < nonDirectReplyMinSilenceMs;
  if (shouldDelayNonDirectRealtimeReply) {
    return {
      allow: false,
      reason: "awaiting_non_direct_silence_window",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext,
      msSinceInboundAudio,
      requiredSilenceMs: nonDirectReplyMinSilenceMs,
      retryAfterMs: Math.max(60, nonDirectReplyMinSilenceMs - Number(msSinceInboundAudio || 0))
    };
  }

  return {
    allow: mergedWithGeneration,
    reason: mergedWithGeneration ? "brain_decides" : "no_brain_session",
    participantCount,
    directAddressed,
    directAddressConfidence,
    directAddressThreshold,
    transcript: normalizedTranscript,
    conversationContext
  };
}

export function isCommandOnlyActive(manager: any, session, settings = null) {
  const resolved = settings || session?.settingsSnapshot || manager.store.getSettings();
  if (resolved?.voice?.commandOnlyMode) return true;
  return musicPhaseShouldForceCommandOnly(manager.getMusicPhase(session));
}

export function getReplyOutputLockState(manager: any, session) {
  if (!session || session.ending) {
    return {
      locked: true,
      reason: "session_inactive",
      musicActive: false,
      botTurnOpen: false,
      pendingResponse: false,
      openAiActiveResponse: false,
      streamBufferedBytes: 0
    };
  }

  const streamBufferedBytes = 0; // Subprocess manages its own stream buffer
  const musicActive = musicPhaseShouldLockOutput(manager.getMusicPhase(session));
  const botTurnOpen = Boolean(session.botTurnOpen);
  const pendingResponse = Boolean(session.pendingResponse && typeof session.pendingResponse === "object");
  const openAiActiveResponse = manager.isRealtimeResponseActive(session);
  const locked =
    musicActive ||
    botTurnOpen ||
    pendingResponse ||
    openAiActiveResponse;

  let reason = "idle";
  if (musicActive) {
    reason = "music_playback_active";
  } else if (pendingResponse) {
    reason = "pending_response";
  } else if (openAiActiveResponse) {
    reason = "openai_active_response";
  } else if (botTurnOpen) {
    reason = "bot_turn_open";
  }

  return {
    locked,
    reason,
    musicActive,
    botTurnOpen,
    pendingResponse,
    openAiActiveResponse,
    streamBufferedBytes
  };
}
