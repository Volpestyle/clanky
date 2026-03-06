import { clamp } from "lodash";
import {
  getPromptBotName
} from "../promptCore.ts";
import {
  buildVoiceAdmissionPolicyLines
} from "../prompts/voiceAdmissionPolicy.ts";
import {
  normalizeInlineText,
  normalizeVoiceText,
  STT_TRANSCRIPT_MAX_CHARS,
  isVoiceTurnAddressedToBot,
  isLikelyVocativeAddressToOtherParticipant,
  isRealtimeMode,
  normalizeVoiceAddressingTargetToken
} from "./voiceSessionHelpers.ts";
import { parseBooleanFlag } from "../normalization/valueParsers.ts";
import {
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS,
  RECENT_ENGAGEMENT_WINDOW_MS,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
} from "./voiceSessionManager.constants.ts";
import {
  normalizeVoiceReplyDecisionProvider,
  defaultVoiceReplyDecisionModel
} from "./voiceDecisionRuntime.ts";
import { hasBotNameCue, DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD } from "../directAddressConfidence.ts";
import type {
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceAddressingState,
  VoiceAddressingAnnotation
} from "./voiceSessionTypes.ts";
import {
  musicPhaseShouldForceCommandOnly
} from "./voiceSessionTypes.ts";
import {
  applyOrchestratorOverrideSettings,
  getBotNameAliases,
  getResolvedVoiceAdmissionClassifierBinding,
  getVoiceAdmissionSettings,
  getVoiceConversationPolicy
} from "../settings/agentStack.ts";

const DEFAULT_REALTIME_ADMISSION_MODE = "hard_classifier";
const DEFAULT_MUSIC_WAKE_LATCH_SECONDS = 15;
const CLASSIFIER_HISTORY_MAX_TURNS = 6;
const CLASSIFIER_HISTORY_MAX_CHARS = 900;
const VOICE_CLASSIFIER_DEBUG_PROMPT_MAX_CHARS = 12_000;
const VOICE_CLASSIFIER_DEBUG_OUTPUT_MAX_CHARS = 1_200;

function resolveRealtimeAdmissionMode(settings: any): "hard_classifier" | "generation_only" {
  const raw = String(getVoiceAdmissionSettings(settings).mode || "")
    .trim()
    .toLowerCase();
  return raw === "generation_decides" ? "generation_only" : DEFAULT_REALTIME_ADMISSION_MODE;
}

function resolveMusicWakeLatchSeconds(settings: any): number {
  return clamp(
    Number(getVoiceAdmissionSettings(settings).musicWakeLatchSeconds) || DEFAULT_MUSIC_WAKE_LATCH_SECONDS,
    5,
    60
  );
}

function clearMusicWakeLatch(session: any) {
  if (!session || typeof session !== "object") return;
  session.musicWakeLatchedUntil = 0;
  session.musicWakeLatchedByUserId = null;
}

function getMusicWakeLatchState(session: any, now = Date.now()) {
  const latchedUntil = Number(session?.musicWakeLatchedUntil || 0);
  if (!Number.isFinite(latchedUntil) || latchedUntil <= now) {
    if (latchedUntil > 0) clearMusicWakeLatch(session);
    return {
      active: false,
      latchedUntil: 0,
      msUntilExpiry: null
    };
  }
  return {
    active: true,
    latchedUntil,
    msUntilExpiry: Math.max(0, Math.round(latchedUntil - now))
  };
}

function touchMusicWakeLatch(session: any, settings: any, userId: string, now = Date.now()) {
  if (!session || typeof session !== "object") return 0;
  const latchWindowMs = Math.round(resolveMusicWakeLatchSeconds(settings) * 1000);
  const nextLatchedUntil = now + latchWindowMs;
  session.musicWakeLatchedUntil = nextLatchedUntil;
  session.musicWakeLatchedByUserId = String(userId || "").trim() || null;
  return nextLatchedUntil;
}

function parseClassifierDecision(rawText: string): "allow" | "deny" | null {
  const normalized = String(rawText || "")
    .replace(/[`*_~]/g, "")
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  if (/^(YES|ALLOW)\b/u.test(normalized)) return "allow";
  if (/^(NO|DENY)\b/u.test(normalized)) return "deny";
  return null;
}


export function hasBotNameCueForTranscript(manager: any, { transcript = "", settings = null } = {}) {
  const normalizedTranscript = normalizeInlineText(transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;

  const resolvedSettings = settings || manager.store.getSettings();
  const botName = getPromptBotName(resolvedSettings);
  const aliases = getBotNameAliases(resolvedSettings);
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

  // Engagement uses the last observed assistant audio delta as a recency hint.
  // It is intentionally not the authoritative "bot is still speaking" signal.
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
  const directAddressed = directAddressConfidence >= directAddressThreshold;
  const replyEagerness = clamp(Number(settings?.voice?.replyEagerness) || 0, 0, 100);
  const sameSpeakerPendingCommandFollowup =
    typeof manager.isMusicDisambiguationResolutionTurn === "function" &&
    manager.isMusicDisambiguationResolutionTurn(session, normalizedUserId, normalizedTranscript);
  const musicActive = typeof manager.isMusicPlaybackActive === "function" && manager.isMusicPlaybackActive(session);
  if (!musicActive) {
    clearMusicWakeLatch(session);
  }
  let musicWakeLatchState = getMusicWakeLatchState(session, now);
  let musicWakeLatched = musicWakeLatchState.active;
  let msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
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
  const buildConversationContext = () => ({
    ...baseConversationContext,
    voiceAddressingState,
    currentTurnAddressing,
    addressedToOtherSignal: Boolean(addressedToOtherParticipant),
    pendingCommandFollowupSignal: Boolean(sameSpeakerPendingCommandFollowup),
    musicActive: Boolean(musicActive),
    musicWakeLatched: Boolean(musicWakeLatched),
    msUntilMusicWakeLatchExpiry: Number.isFinite(Number(msUntilMusicWakeLatchExpiry))
      ? Math.max(0, Math.round(Number(msUntilMusicWakeLatchExpiry)))
      : null
  });
  let conversationContext = buildConversationContext();

  const replyOutputLockState = manager.getReplyOutputLockState(session);
  const lockedByMusicOnly =
    Boolean(replyOutputLockState.locked) &&
    replyOutputLockState.reason === "music_playback_active";
  if (replyOutputLockState.locked && !lockedByMusicOnly) {
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

  // Pending command followup (e.g., music disambiguation "2" / "the second one")
  // remains a deterministic fast-path before any other admission gate.
  if (sameSpeakerPendingCommandFollowup) {
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

  if (manager.isCommandOnlyActive(session, settings)) {
    if (directAddressed || directAddressedByWakePhrase) {
      if (musicActive) {
        touchMusicWakeLatch(session, settings, normalizedUserId, now);
        musicWakeLatchState = getMusicWakeLatchState(session, now);
        musicWakeLatched = musicWakeLatchState.active;
        msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
        conversationContext = buildConversationContext();
      }
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
    if (!musicActive) {
      const latchWindowMs = Math.round(resolveMusicWakeLatchSeconds(settings) * 1000);
      const lastDirectAddressAt = Number(session?.lastDirectAddressAt || 0);
      const msSinceDirectAddress = lastDirectAddressAt > 0 ? Math.max(0, now - lastDirectAddressAt) : Infinity;
      if (msSinceDirectAddress <= latchWindowMs) {
        // Within the command mode latch window — fall through to classifier/generation
      } else {
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
    }
    if (!musicWakeLatched) {
      return {
        allow: false,
        reason: "music_playing_not_awake",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }
  }

  if (directAddressed) {
    if (musicActive) {
      touchMusicWakeLatch(session, settings, normalizedUserId, now);
      musicWakeLatchState = getMusicWakeLatchState(session, now);
      musicWakeLatched = musicWakeLatchState.active;
      msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
      conversationContext = buildConversationContext();
    }
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

  // Eagerness 0 no longer hard-rejects — it flows to classifier/generation
  // where the tier-based personality prompt handles the conservative behavior.

  const sessionMode = String(session?.mode || settings?.voice?.mode || "").trim().toLowerCase();
  const mergedWithGeneration =
    sessionMode === "stt_pipeline" ||
    (isRealtimeMode(sessionMode) &&
      typeof manager.resolveRealtimeReplyStrategy === "function" &&
      manager.resolveRealtimeReplyStrategy({ session, settings }) === "brain");

  // STT pipeline: the full text LLM genuinely decides via [SKIP], so just allow through
  if (sessionMode === "stt_pipeline" && mergedWithGeneration) {
    return {
      allow: true,
      reason: "generation_decides",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  // No brain session (native realtime without brain path)
  if (!mergedWithGeneration) {
    return {
      allow: false,
      reason: "no_brain_session",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  // Bridge mode: deterministic wake arms a short music follow-up latch.
  const nameCueDetected = hasBotNameCueForTranscript(manager, {
    transcript: normalizedTranscript,
    settings
  });
  if (musicActive) {
    if (nameCueDetected || directAddressedByWakePhrase) {
      touchMusicWakeLatch(session, settings, normalizedUserId, now);
      musicWakeLatchState = getMusicWakeLatchState(session, now);
      musicWakeLatched = musicWakeLatchState.active;
      msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
      conversationContext = buildConversationContext();
    }
    if (!musicWakeLatched) {
      return {
        allow: false,
        reason: "music_playing_not_awake",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }
  }

  const realtimeAdmissionMode = resolveRealtimeAdmissionMode(settings);
  if (realtimeAdmissionMode === "generation_only") {
    return {
      allow: true,
      reason: "generation_decides",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext
    };
  }

  // Bridge mode: hard classifier gate
  const commonFields = {
    participantCount,
    directAddressed,
    directAddressConfidence,
    directAddressThreshold,
    transcript: normalizedTranscript,
    conversationContext
  };
  const classifierResult = await runVoiceReplyClassifier(manager, {
    session,
    settings,
    userId: normalizedUserId,
    transcript: normalizedTranscript,
    speakerName,
    participantCount,
    participantList,
    conversationContext,
    replyEagerness,
    addressedToOtherSignal: addressedToOtherParticipant,
    pendingCommandFollowupSignal: sameSpeakerPendingCommandFollowup,
    musicActive,
    musicWakeLatched,
    msUntilMusicWakeLatchExpiry,
    currentSpeakerDirectedConfidence: Number(voiceAddressingState?.currentSpeakerDirectedConfidence || 0),
    currentSpeakerTarget: String(voiceAddressingState?.currentSpeakerTarget || "").trim() || null
  });
  if (classifierResult.allow && musicActive && musicWakeLatched) {
    touchMusicWakeLatch(session, settings, normalizedUserId, now);
    musicWakeLatchState = getMusicWakeLatchState(session, now);
    musicWakeLatched = musicWakeLatchState.active;
    msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
    conversationContext = buildConversationContext();
  }
  return {
    allow: classifierResult.allow,
    reason: classifierResult.allow ? "classifier_allow" : "classifier_deny",
    classifierLatencyMs: classifierResult.latencyMs,
    classifierDecision: classifierResult.decision,
    classifierConfidence: classifierResult.confidence,
    classifierTarget: classifierResult.target,
    classifierReason: classifierResult.reason,
    error: classifierResult.error,
    ...commonFields,
    conversationContext
  };
}

export async function runVoiceReplyClassifier(manager: any, {
  session,
  settings,
  userId,
  transcript,
  speakerName,
  participantCount,
  participantList,
  conversationContext,
  replyEagerness,
  addressedToOtherSignal = false,
  pendingCommandFollowupSignal = false,
  musicActive = false,
  musicWakeLatched = false,
  msUntilMusicWakeLatchExpiry = null,
  currentSpeakerDirectedConfidence = 0,
  currentSpeakerTarget = null
}: {
  session: any;
  settings: any;
  userId: string;
  transcript: string;
  speakerName: string;
  participantCount: number;
  participantList: string[];
  conversationContext: VoiceConversationContext;
  replyEagerness: number;
  addressedToOtherSignal?: boolean;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  currentSpeakerDirectedConfidence?: number;
  currentSpeakerTarget?: string | null;
}): Promise<{
  allow: boolean;
  decision: "allow" | "deny" | null;
  latencyMs: number;
  confidence: number | null;
  target: string | null;
  reason: string | null;
  error: string | null;
}> {
  const classifierBinding = getResolvedVoiceAdmissionClassifierBinding(settings);
  const llmProvider = normalizeVoiceReplyDecisionProvider(
    classifierBinding?.provider || "openai"
  );
  const llmModel = String(classifierBinding?.model || defaultVoiceReplyDecisionModel(llmProvider))
    .trim()
    .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);
  const classifierDebugEnabled = parseBooleanFlag(process.env.VOICE_CLASSIFIER_DEBUG, false);
  const botName = getPromptBotName(settings);
  const normalizedDirectedConfidence = Math.max(0, Math.min(1, Number(currentSpeakerDirectedConfidence) || 0));
  const normalizedTarget = String(currentSpeakerTarget || "").trim() || null;
  const normalizedUserId = String(userId || "").trim() || null;
  const logClassifierDebug = ({
    stage = "result",
    promptSnapshot = null,
    rawOutput = null,
    parsedDecision = null,
    allow = null,
    reason = null,
    error = null,
    latencyMs = null
  }: {
    stage?: "prompt" | "result" | "error";
    promptSnapshot?: string | null;
    rawOutput?: string | null;
    parsedDecision?: "allow" | "deny" | null;
    allow?: boolean | null;
    reason?: string | null;
    error?: string | null;
    latencyMs?: number | null;
  }) => {
    if (!classifierDebugEnabled) return;
    if (!manager?.store || typeof manager.store.logAction !== "function") return;

    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      userId: normalizedUserId,
      content: "voice_reply_classifier_debug",
      metadata: {
        sessionId: session?.id || null,
        stage,
        provider: llmProvider,
        model: llmModel,
        speakerName: String(speakerName || "").trim() || "someone",
        transcript: String(transcript || "").trim() || null,
        participantCount: Math.max(0, Number(participantCount) || 0),
        participantList: Array.isArray(participantList)
          ? participantList
            .map((name) => String(name || "").trim())
            .filter(Boolean)
            .slice(0, 12)
          : [],
        replyEagerness: Number.isFinite(Number(replyEagerness))
          ? clamp(Number(replyEagerness), 0, 100)
          : null,
        addressedToOtherSignal: Boolean(addressedToOtherSignal),
        pendingCommandFollowupSignal: Boolean(pendingCommandFollowupSignal),
        musicActive: Boolean(musicActive),
        musicWakeLatched: Boolean(musicWakeLatched),
        msUntilMusicWakeLatchExpiry: Number.isFinite(Number(msUntilMusicWakeLatchExpiry))
          ? Math.max(0, Math.round(Number(msUntilMusicWakeLatchExpiry)))
          : null,
        conversationContext: conversationContext && typeof conversationContext === "object"
          ? {
            engagementState: String(conversationContext.engagementState || "").trim() || null,
            engaged: Boolean(conversationContext.engaged),
            engagedWithCurrentSpeaker: Boolean(conversationContext.engagedWithCurrentSpeaker),
            recentAssistantReply: Boolean(conversationContext.recentAssistantReply),
            recentDirectAddress: Boolean(conversationContext.recentDirectAddress),
            sameAsRecentDirectAddress: Boolean(conversationContext.sameAsRecentDirectAddress),
            msSinceAssistantReply: Number.isFinite(Number(conversationContext.msSinceAssistantReply))
              ? Math.max(0, Math.round(Number(conversationContext.msSinceAssistantReply)))
              : null,
            msSinceDirectAddress: Number.isFinite(Number(conversationContext.msSinceDirectAddress))
              ? Math.max(0, Math.round(Number(conversationContext.msSinceDirectAddress)))
              : null,
            addressedToOtherSignal: Boolean(conversationContext.addressedToOtherSignal),
            pendingCommandFollowupSignal: Boolean(conversationContext.pendingCommandFollowupSignal),
            musicActive: Boolean(conversationContext.musicActive),
            musicWakeLatched: Boolean(conversationContext.musicWakeLatched),
            msUntilMusicWakeLatchExpiry: Number.isFinite(Number(conversationContext.msUntilMusicWakeLatchExpiry))
              ? Math.max(0, Math.round(Number(conversationContext.msUntilMusicWakeLatchExpiry)))
              : null
          }
          : null,
        promptSnapshot: String(promptSnapshot || "").slice(0, VOICE_CLASSIFIER_DEBUG_PROMPT_MAX_CHARS) || null,
        rawOutput: String(rawOutput || "").slice(0, VOICE_CLASSIFIER_DEBUG_OUTPUT_MAX_CHARS) || null,
        parsedDecision,
        allow: typeof allow === "boolean" ? allow : null,
        reason: String(reason || "").trim() || null,
        error: String(error || "").trim() || null,
        latencyMs: Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.round(Number(latencyMs))) : null
      }
    });
  };

  if (!manager.llm?.generate) {
    return {
      allow: false,
      decision: "deny",
      latencyMs: 0,
      confidence: null,
      target: addressedToOtherSignal ? "OTHER" : "UNKNOWN",
      reason: "llm_unavailable",
      error: "llm_generate_unavailable"
    };
  }
  const recentHistory = typeof manager.formatVoiceDecisionHistory === "function"
    ? manager.formatVoiceDecisionHistory(session, CLASSIFIER_HISTORY_MAX_TURNS, CLASSIFIER_HISTORY_MAX_CHARS)
    : "";
  const policyLines = buildVoiceAdmissionPolicyLines({
    mode: "classifier",
    directAddressed: false,
    isEagerTurn: !conversationContext?.engaged,
    replyEagerness,
    participantCount,
    conversationContext,
    addressedToOtherSignal,
    pendingCommandFollowupSignal,
    musicActive,
    musicWakeLatched
  });

  const promptParts = [
    `You are a realtime voice admission classifier for a bot named "${botName}".`,
    `Output exactly one token: YES or NO.`,
    `Do not output anything else.`,
    `Participant count: ${participantCount}`,
    `Participants: ${participantList.join(", ") || "none"}`,
    `Speaker: ${speakerName}`,
    `Transcript: "${transcript}"`,
    normalizedDirectedConfidence > 0
      ? `Speaker-directed-to-bot confidence: ${normalizedDirectedConfidence.toFixed(2)} (target: ${normalizedTarget || "unknown"})`
      : `Speaker-directed-to-bot confidence: unknown`,
    `Note: voice transcription often mishears the bot's name "${botName}". If the transcript contains a word that sounds similar (e.g. rhymes, off-by-one syllable), treat it as likely addressed to the bot.`,
    `Addressed-to-other signal: ${addressedToOtherSignal ? "true" : "false"}`,
    `Pending-command-followup signal: ${pendingCommandFollowupSignal ? "true" : "false"}`,
    `Music active: ${musicActive ? "true" : "false"}`,
    `Music wake latched: ${musicWakeLatched ? "true" : "false"}`,
    `Music wake latch expires in ms: ${
      Number.isFinite(Number(msUntilMusicWakeLatchExpiry))
        ? Math.max(0, Math.round(Number(msUntilMusicWakeLatchExpiry)))
        : "none"
    }`,
    conversationContext.msSinceDirectAddress != null
      ? `Last addressed ${Math.round(conversationContext.msSinceDirectAddress / 1000)}s ago`
      : `Never directly addressed`,
    conversationContext.recentAssistantReply
      ? `Bot last spoke ${Math.round(Number(conversationContext.msSinceAssistantReply || 0) / 1000)}s ago`
      : `Bot has not spoken recently`,
    ...policyLines,
    `Decision: should the bot respond to this speaker turn right now?`
  ];
  if (recentHistory) {
    promptParts.push(`Recent attributed voice turns:\n${recentHistory}`);
  }
  const promptSnapshot = promptParts.join("\n");
  logClassifierDebug({
    stage: "prompt",
    promptSnapshot
  });

  const startMs = Date.now();
  try {
    const result = await manager.llm.generate({
      settings: applyOrchestratorOverrideSettings(settings, {
        provider: llmProvider,
        model: llmModel,
        temperature: 0,
        maxOutputTokens: 4,
        reasoningEffort: "minimal"
      }),
      systemPrompt: "",
      userPrompt: promptParts.join("\n"),
      contextMessages: [],
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        source: "voice_reply_classifier"
      }
    });
    const latencyMs = Date.now() - startMs;
    const rawText = String(result?.text || "");
    const decision = parseClassifierDecision(rawText);
    if (decision === "allow") {
      logClassifierDebug({
        stage: "result",
        promptSnapshot,
        rawOutput: rawText,
        parsedDecision: decision,
        allow: true,
        reason: "model_yes",
        latencyMs
      });
      return {
        allow: true,
        decision,
        latencyMs,
        confidence: null,
        target: addressedToOtherSignal ? "OTHER" : "UNKNOWN",
        reason: "model_yes",
        error: null
      };
    }
    if (decision === "deny") {
      logClassifierDebug({
        stage: "result",
        promptSnapshot,
        rawOutput: rawText,
        parsedDecision: decision,
        allow: false,
        reason: "model_no",
        latencyMs
      });
      return {
        allow: false,
        decision,
        latencyMs,
        confidence: null,
        target: addressedToOtherSignal ? "OTHER" : "UNKNOWN",
        reason: "model_no",
        error: null
      };
    }
    logClassifierDebug({
      stage: "error",
      promptSnapshot,
      rawOutput: rawText,
      parsedDecision: null,
      allow: false,
      reason: "unparseable_classifier_output",
      error: `unparseable_classifier_output:${rawText.slice(0, 60)}`,
      latencyMs
    });
    return {
      allow: false,
      decision: null,
      latencyMs,
      confidence: null,
      target: addressedToOtherSignal ? "OTHER" : "UNKNOWN",
      reason: "unparseable_classifier_output",
      error: `unparseable_classifier_output:${rawText.slice(0, 60)}`
    };
  } catch (error) {
    logClassifierDebug({
      stage: "error",
      promptSnapshot,
      parsedDecision: "deny",
      allow: false,
      reason: "classifier_runtime_error",
      error: String(error?.message || error || "unknown_error"),
      latencyMs: Date.now() - startMs
    });
    return {
      allow: false,
      decision: "deny",
      latencyMs: Date.now() - startMs,
      confidence: null,
      target: addressedToOtherSignal ? "OTHER" : "UNKNOWN",
      reason: "classifier_runtime_error",
      error: String(error?.message || error || "unknown_error")
    };
  }
}

export function isCommandOnlyActive(manager: any, session, settings = null) {
  const resolved = settings || session?.settingsSnapshot || manager.store.getSettings();
  if (getVoiceConversationPolicy(resolved).commandOnlyMode) return true;
  return musicPhaseShouldForceCommandOnly(manager.getMusicPhase(session));
}
