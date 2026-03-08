import { clamp } from "../utils.ts";
import {
  getPromptBotName
} from "../prompts/promptCore.ts";
import {
  normalizeInlineText,
  normalizeVoiceText,
  STT_TRANSCRIPT_MAX_CHARS,
  isVoiceTurnAddressedToBot,
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
import { hasBotNameCue, DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD } from "../bot/directAddressConfidence.ts";
import type {
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceAddressingState,
  VoiceAddressingAnnotation,
  VoiceCommandState,
  VoiceSession,
  OutputChannelState,
  MusicPlaybackPhase
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
import { isVoiceSpeechTimelineEntry } from "./voiceTimeline.ts";

const DEFAULT_REALTIME_ADMISSION_MODE = "hard_classifier";
const DEFAULT_MUSIC_WAKE_LATCH_SECONDS = 15;
const CLASSIFIER_HISTORY_MAX_TURNS = 6;
const CLASSIFIER_HISTORY_MAX_CHARS = 900;
const VOICE_CLASSIFIER_DEBUG_PROMPT_MAX_CHARS = 12_000;
const VOICE_CLASSIFIER_DEBUG_OUTPUT_MAX_CHARS = 1_200;
type ReplyDecisionSettings = Record<string, unknown> | null;
type ReplyDecisionSessionLike = Partial<VoiceSession>;

type ReplyDecisionStoreLike = {
  getSettings: () => ReplyDecisionSettings;
  logAction: (entry: {
    kind?: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type ReplyDecisionGenerateResult = {
  text?: string | null;
};

type ReplyDecisionGenerateArgs = {
  settings: ReplyDecisionSettings;
  systemPrompt: string;
  userPrompt: string;
  contextMessages: unknown[];
  trace?: {
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    source?: string | null;
  };
};

type SingleParticipantAssistantFollowupState = {
  active: boolean;
  msSinceAssistantTurn: number | null;
};

export interface ReplyDecisionHost {
  store: ReplyDecisionStoreLike;
  llm?: {
    generate?: (args: ReplyDecisionGenerateArgs) => Promise<ReplyDecisionGenerateResult>;
  } | null;
  ensureVoiceCommandState?: (
    session: ReplyDecisionSessionLike | null | undefined
  ) => VoiceCommandState | null;
  getVoiceChannelParticipants: (
    session: ReplyDecisionSessionLike | null | undefined
  ) => Array<{ userId: string; displayName: string }>;
  resolveVoiceSpeakerName: (
    session: ReplyDecisionSessionLike | null | undefined,
    userId?: string | null
  ) => string;
  getOutputChannelState: (
    session: ReplyDecisionSessionLike | null | undefined
  ) => Pick<OutputChannelState, "locked" | "lockReason">;
  isMusicDisambiguationResolutionTurn?: (
    session: ReplyDecisionSessionLike | null | undefined,
    userId?: string | null,
    transcript?: string
  ) => boolean;
  isMusicPlaybackActive?: (session: ReplyDecisionSessionLike | null | undefined) => boolean;
  isCommandOnlyActive: (
    session: ReplyDecisionSessionLike | null | undefined,
    settings?: ReplyDecisionSettings
  ) => boolean;
  resolveRealtimeReplyStrategy?: (args: {
    session: ReplyDecisionSessionLike | null | undefined;
    settings?: ReplyDecisionSettings;
  }) => string | null;
  formatVoiceDecisionHistory?: (
    session: ReplyDecisionSessionLike | null | undefined,
    maxTurns?: number,
    maxTotalChars?: number
  ) => string;
  getMusicPhase?: (session: ReplyDecisionSessionLike | null | undefined) => MusicPlaybackPhase;
}

function resolveRealtimeAdmissionMode(settings: ReplyDecisionSettings): "hard_classifier" | "generation_only" {
  const replyPath = String(getVoiceConversationPolicy(settings).replyPath || "")
    .trim()
    .toLowerCase();
  // Bridge always needs the classifier — it's the only gate before generation.
  if (replyPath === "bridge") return "hard_classifier";
  // Brain: default off (generation LLM decides), but allow explicit opt-in.
  const raw = String(getVoiceAdmissionSettings(settings).mode || "")
    .trim()
    .toLowerCase();
  if (raw === "classifier_gate" || raw === "hard_classifier") return "hard_classifier";
  return "generation_only";
}

function resolveMusicWakeLatchSeconds(settings: ReplyDecisionSettings): number {
  return clamp(
    Number(getVoiceAdmissionSettings(settings).musicWakeLatchSeconds) || DEFAULT_MUSIC_WAKE_LATCH_SECONDS,
    5,
    60
  );
}


function clearMusicWakeLatch(session: ReplyDecisionSessionLike | null | undefined) {
  if (!session || typeof session !== "object") return;
  session.musicWakeLatchedUntil = 0;
  session.musicWakeLatchedByUserId = null;
}

function getMusicWakeLatchState(
  session: ReplyDecisionSessionLike | null | undefined,
  now = Date.now()
) {
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

function touchMusicWakeLatch(
  session: ReplyDecisionSessionLike | null | undefined,
  settings: ReplyDecisionSettings,
  userId: string,
  now = Date.now()
) {
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


export function hasBotNameCueForTranscript(
  manager: ReplyDecisionHost,
  { transcript = "", settings = null }: {
    transcript?: string;
    settings?: ReplyDecisionSettings;
  } = {}
) {
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

function detectSingleParticipantAssistantFollowup(manager: ReplyDecisionHost, {
  session = null,
  userId = null,
  participantCount = null,
  now = Date.now()
}: {
  session?: ReplyDecisionSessionLike | null;
  userId?: string | null;
  participantCount?: number | null;
  now?: number;
} = {}): SingleParticipantAssistantFollowupState {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return {
      active: false,
      msSinceAssistantTurn: null
    };
  }

  const normalizedParticipantCount = Number.isFinite(Number(participantCount))
    ? Math.max(0, Math.floor(Number(participantCount)))
    : manager.getVoiceChannelParticipants(session).length;
  if (normalizedParticipantCount !== 1) {
    return {
      active: false,
      msSinceAssistantTurn: null
    };
  }

  const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
  if (!turns.length) {
    return {
      active: false,
      msSinceAssistantTurn: null
    };
  }

  const latestTurn = turns.at(-1) || null;
  const previousTurn = turns.at(-2) || null;

  let assistantTurn = null;
  if (
    latestTurn?.role === "user" &&
    String(latestTurn.userId || "").trim() === normalizedUserId &&
    previousTurn?.role === "assistant"
  ) {
    assistantTurn = previousTurn;
  } else if (latestTurn?.role === "assistant") {
    assistantTurn = latestTurn;
  }

  const assistantTurnAt = Number(assistantTurn?.at || 0);
  if (!assistantTurn || !Number.isFinite(assistantTurnAt) || assistantTurnAt <= 0) {
    return {
      active: false,
      msSinceAssistantTurn: null
    };
  }

  const referenceTurnAt = Number(latestTurn?.at || 0);
  const referenceAt =
    Number.isFinite(referenceTurnAt) && referenceTurnAt > 0
      ? referenceTurnAt
      : now;
  const msSinceAssistantTurn = Math.max(0, referenceAt - assistantTurnAt);
  return {
    active: msSinceAssistantTurn <= RECENT_ENGAGEMENT_WINDOW_MS,
    msSinceAssistantTurn
  };
}

export function buildVoiceConversationContext(manager: ReplyDecisionHost, {
  session = null,
  userId = null,
  directAddressed = false,
  participantCount = null,
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
  const activeVoiceCommandState = manager.ensureVoiceCommandState?.(session) || null;
  const sameAsVoiceCommandUser =
    Boolean(normalizedUserId) &&
    Boolean(activeVoiceCommandState?.userId) &&
    normalizedUserId === activeVoiceCommandState.userId;
  const singleParticipantAssistantFollowup = detectSingleParticipantAssistantFollowup(manager, {
    session,
    userId: normalizedUserId,
    participantCount,
    now
  });

  const engagedWithCurrentSpeaker =
    Boolean(directAddressed) ||
    singleParticipantAssistantFollowup.active ||
    sameAsVoiceCommandUser ||
    (recentAssistantReply && sameAsRecentDirectAddress) ||
    (recentDirectAddress && sameAsRecentDirectAddress);
  const engaged = engagedWithCurrentSpeaker;

  return {
    engagementState: engaged ? "engaged" : activeVoiceCommandState ? "command_only_engaged" : "wake_word_biased",
    engaged,
    engagedWithCurrentSpeaker,
    singleParticipantAssistantFollowup: singleParticipantAssistantFollowup.active,
    recentAssistantReply,
    recentDirectAddress,
    sameAsRecentDirectAddress,
    msSinceAssistantReply: Number.isFinite(msSinceAssistantReply) ? msSinceAssistantReply : null,
    msSinceDirectAddress: Number.isFinite(msSinceDirectAddress) ? msSinceDirectAddress : null,
    activeCommandSpeaker: activeVoiceCommandState?.userId || null,
    activeCommandDomain: activeVoiceCommandState?.domain || null,
    activeCommandIntent: activeVoiceCommandState?.intent || null,
    msUntilCommandSessionExpiry: activeVoiceCommandState
      ? Math.max(0, activeVoiceCommandState.expiresAt - now)
      : null
  };
}

export function buildVoiceAddressingState(manager: ReplyDecisionHost, {
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
    .filter((row) => isVoiceSpeechTimelineEntry(row))
    .map((row) => {
      const normalized = normalizeVoiceAddressingAnnotation(manager, {
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

export function normalizeVoiceAddressingAnnotation(_manager: ReplyDecisionHost, {
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

export async function evaluateVoiceReplyDecision(manager: ReplyDecisionHost, {
  session,
  settings,
  userId,
  transcript,
  inputKind = "transcript",
  source: _source = "stt_pipeline",
  transcriptionContext: _transcriptionContext = null
}): Promise<VoiceReplyDecision> {
  const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
  const normalizedInputKind = inputKind === "event" ? "event" : "transcript";
  const normalizedUserId = String(userId || "").trim();
  const voiceChannelParticipants = manager.getVoiceChannelParticipants(session);
  const participantCount = voiceChannelParticipants.length;
  const speakerName = manager.resolveVoiceSpeakerName(session, userId) || "someone";
  const participantList = voiceChannelParticipants
    .map((entry) => entry.displayName)
    .filter(Boolean)
    .slice(0, 10);
  const now = Date.now();
  if (!normalizedTranscript) {
    const emptyConversationContext = buildVoiceConversationContext(manager, {
      session,
      userId: normalizedUserId,
      directAddressed: false,
      participantCount,
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
  const directAddressedByWakePhrase = normalizedInputKind === "event"
    ? false
    : normalizedTranscript
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
  const botWakeTokens = normalizeWakeTokens(getPromptBotName(settings));
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
  const replyEagerness = clamp(Number(getVoiceConversationPolicy(settings).replyEagerness) || 0, 0, 100);
  const sameSpeakerPendingCommandFollowup =
    normalizedInputKind === "event"
      ? false
      :
      typeof manager.isMusicDisambiguationResolutionTurn === "function" &&
      manager.isMusicDisambiguationResolutionTurn(session, normalizedUserId, normalizedTranscript);
  const musicActive = typeof manager.isMusicPlaybackActive === "function" && manager.isMusicPlaybackActive(session);
  if (!musicActive) {
    clearMusicWakeLatch(session);
  }
  let musicWakeLatchState = getMusicWakeLatchState(session, now);
  let musicWakeLatched = musicWakeLatchState.active;
  let msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
  const baseConversationContext = buildVoiceConversationContext(manager, {
    session,
    userId: normalizedUserId,
    directAddressed,
    participantCount,
    now
  });
  const voiceAddressingState = buildVoiceAddressingState(manager, {
    session,
    userId: normalizedUserId,
    now
  });
  const currentTurnAddressing = normalizeVoiceAddressingAnnotation(manager, {
    directAddressed,
    directedConfidence: directAddressConfidence,
    source: "decision",
    reason: directAddressAssessment?.reason || null
  });
  const buildConversationContext = () => ({
    ...baseConversationContext,
    voiceAddressingState,
    currentTurnAddressing,
    pendingCommandFollowupSignal: Boolean(sameSpeakerPendingCommandFollowup),
    musicActive: Boolean(musicActive),
    musicWakeLatched: Boolean(musicWakeLatched),
    msUntilMusicWakeLatchExpiry: Number.isFinite(Number(msUntilMusicWakeLatchExpiry))
      ? Math.max(0, Math.round(Number(msUntilMusicWakeLatchExpiry)))
      : null
  });
  let conversationContext = buildConversationContext();

  const outputChannelState = manager.getOutputChannelState(session);
  const lockedByMusicOnly =
    Boolean(outputChannelState.locked) &&
    outputChannelState.lockReason === "music_playback_active";
  if (outputChannelState.locked && !lockedByMusicOnly) {
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
      outputLockReason: outputChannelState.lockReason
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

  // Direct address arms the music wake latch but no longer fast-paths —
  // the classifier decides with directAddressed as a strong hint.
  if (directAddressed && musicActive) {
    touchMusicWakeLatch(session, settings, normalizedUserId, now);
    musicWakeLatchState = getMusicWakeLatchState(session, now);
    musicWakeLatched = musicWakeLatchState.active;
    msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
    conversationContext = buildConversationContext();
  }

  // Eagerness 0 no longer hard-rejects — it flows to classifier/generation
  // where the tier-based personality prompt handles the conservative behavior.

  const sessionMode = String(session?.mode || "").trim().toLowerCase();
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

  // Native realtime without brain path — the realtime model decides what to respond to
  if (!mergedWithGeneration) {
    return {
      allow: true,
      reason: "native_realtime",
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
    inputKind: normalizedInputKind,
    speakerName,
    participantCount,
    participantList,
    conversationContext,
    replyEagerness,
    pendingCommandFollowupSignal: sameSpeakerPendingCommandFollowup,
    directAddressed,
    nameCueDetected,
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

export type ClassifierPromptInput = {
  botName: string;
  inputKind?: "transcript" | "event";
  replyEagerness: number;
  participantCount: number;
  participantList: string[];
  speakerName: string;
  transcript: string;
  directAddressed?: boolean;
  nameCueDetected?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  conversationContext: {
    recentAssistantReply?: boolean;
    msSinceAssistantReply?: number | null;
    msSinceDirectAddress?: number | null;
  };
  recentHistory?: string;
};

export function buildClassifierPrompt(input: ClassifierPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const normalizedEagerness = Math.max(0, Math.min(100, Number(input.replyEagerness) || 0));
  const normalizedInputKind = input.inputKind === "event" ? "event" : "transcript";

  const systemPrompt = `You are "${input.botName}" (anything phonetically similar to "${input.botName}" is also you), an agentic discord voice channel member. You can play music, search the web, and handle commands. Decide whether to speak right now. Return exactly one token: YES or NO.`;

  // --- Build context block first ---
  const parts: string[] = [];

  parts.push(`Participants: ${input.participantList.join(", ") || "none"}`);
  if (normalizedInputKind === "event") {
    parts.push(`Triggering member: ${input.speakerName}`);
    parts.push(`Event: "${input.transcript}"`);
  } else {
    parts.push(`Speaker: ${input.speakerName}`);
    parts.push(`Transcript: "${input.transcript}"`);
  }

  // Conversation recency
  if (input.conversationContext.recentAssistantReply) {
    const msSince = Number(input.conversationContext.msSinceAssistantReply || 0);
    const secsSinceReply = Math.round(msSince / 1000);
    const hasRecentDirectAddress = input.conversationContext.msSinceDirectAddress != null
      && input.conversationContext.msSinceDirectAddress <= 15_000;
    if (msSince <= 15_000 && hasRecentDirectAddress) {
      parts.push(`You spoke ${secsSinceReply}s ago in an active back-and-forth — follow-ups are likely for you.`);
    } else {
      parts.push(`You spoke ${secsSinceReply}s ago.`);
    }
  }
  if (input.conversationContext.msSinceDirectAddress != null) {
    parts.push(`Last addressed by name ${Math.round(input.conversationContext.msSinceDirectAddress / 1000)}s ago.`);
  }

  // History
  if (input.recentHistory) {
    parts.push(``);
    parts.push(`Recent voice timeline:\n${input.recentHistory}`);
  }

  // Music state
  if (input.musicActive) {
    parts.push(``);
    parts.push(`Music playing.`);
    if (input.musicWakeLatched) {
      parts.push(`Wake latch active — you are listening for music commands (skip, volume, queue, etc). Prefer YES for short control commands.`);
      if (Number.isFinite(Number(input.msUntilMusicWakeLatchExpiry))) {
        parts.push(`Latch expires in ${Math.max(0, Math.round(Number(input.msUntilMusicWakeLatchExpiry) / 1000))}s.`);
      }
    }
  }

  // --- Guidelines (after context, so model reads situation first) ---
  parts.push(``);

  // Room prior
  if (normalizedInputKind !== "event" && input.participantCount <= 1) {
    parts.push("One-on-one room — speech is likely directed at you. Prefer YES unless clearly self-talk or non-speech.");
  }

  // Event-specific guidance
  if (normalizedInputKind === "event") {
    if (input.speakerName === "YOU") {
      if (normalizedEagerness >= 25 || input.participantCount <= 1) {
        parts.push(`You just joined — say YES to greet unless there is a strong reason not to.`);
      } else {
        parts.push(`You just joined a room where others are talking. Only greet if directly prompted.`);
      }
    } else {
      if (normalizedEagerness >= 50) {
        parts.push(`Someone joined or left. Consider greeting them if it feels natural.`);
      } else {
        parts.push(`Someone joined or left.`);
      }
    }
  }

  // Name detection hints from upstream
  if (input.directAddressed) {
    parts.push("The speaker said your name. This is a strong YES signal unless the context clearly shows they are talking ABOUT you, not TO you.");
  } else if (input.nameCueDetected) {
    parts.push("The speaker may have said your name (fuzzy match). Lean toward YES.");
  }

  // Eagerness tier
  if (normalizedEagerness <= 10) {
    parts.push("Say YES only when you are clearly the intended recipient — your name is used, or a command/request is aimed at you specifically. Say NO when people are talking to each other.");
  } else if (normalizedEagerness <= 25) {
    parts.push("Say YES when you are the likely recipient — addressed by name, given a command, or in a back-and-forth conversation with the speaker. Say NO when people are having their own conversation.");
  } else if (normalizedEagerness <= 50) {
    parts.push("Say YES when you can contribute — questions, commands, follow-ups, greetings, or anything where you can add value. Say NO for filler noise or conversations clearly between others.");
  } else if (normalizedEagerness <= 75) {
    parts.push("Say YES when the conversation interests you or you can add value. Be social and willing to engage. Only say NO for clear filler noise or someone explicitly talking to another person by name.");
  } else {
    parts.push("Say YES to almost everything. You are in maximum engagement mode. Only say NO for literal non-speech sounds.");
  }

  parts.push(``);
  parts.push(`Should you speak? YES or NO:`);

  return { systemPrompt, userPrompt: parts.join("\n") };
}

export async function runVoiceReplyClassifier(manager: ReplyDecisionHost, {
  session,
  settings,
  userId,
  transcript,
  inputKind = "transcript",
  speakerName,
  participantCount,
  participantList,
  conversationContext,
  replyEagerness,
  pendingCommandFollowupSignal = false,
  directAddressed = false,
  nameCueDetected = false,
  musicActive = false,
  musicWakeLatched = false,
  msUntilMusicWakeLatchExpiry = null,
  currentSpeakerDirectedConfidence = 0,
  currentSpeakerTarget = null
}: {
  session: ReplyDecisionSessionLike;
  settings: ReplyDecisionSettings;
  userId: string;
  transcript: string;
  inputKind?: "transcript" | "event";
  speakerName: string;
  participantCount: number;
  participantList: string[];
  conversationContext: VoiceConversationContext;
  replyEagerness: number;
  pendingCommandFollowupSignal?: boolean;
  directAddressed?: boolean;
  nameCueDetected?: boolean;
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
  const _normalizedDirectedConfidence = Math.max(0, Math.min(1, Number(currentSpeakerDirectedConfidence) || 0));
  const _normalizedTarget = String(currentSpeakerTarget || "").trim() || null;
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
      target: "UNKNOWN",
      reason: "llm_unavailable",
      error: "llm_generate_unavailable"
    };
  }
  const recentHistory = typeof manager.formatVoiceDecisionHistory === "function"
    ? manager.formatVoiceDecisionHistory(session, CLASSIFIER_HISTORY_MAX_TURNS, CLASSIFIER_HISTORY_MAX_CHARS)
    : "";

  const { systemPrompt: classifierSystemPrompt, userPrompt: classifierUserPrompt } = buildClassifierPrompt({
    botName,
    inputKind,
    replyEagerness,
    participantCount,
    participantList,
    speakerName,
    transcript,
    directAddressed,
    nameCueDetected,
    musicActive,
    musicWakeLatched,
    msUntilMusicWakeLatchExpiry,
    conversationContext,
    recentHistory
  });
  const promptSnapshot = classifierUserPrompt;
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
      systemPrompt: classifierSystemPrompt,
      userPrompt: classifierUserPrompt,
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
        target: "UNKNOWN",
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
        target: "UNKNOWN",
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
      target: "UNKNOWN",
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
      target: "UNKNOWN",
      reason: "classifier_runtime_error",
      error: String(error?.message || error || "unknown_error")
    };
  }
}

export function isCommandOnlyActive(
  manager: ReplyDecisionHost,
  session: ReplyDecisionSessionLike | null | undefined,
  settings: ReplyDecisionSettings = null
) {
  const resolved = settings || session?.settingsSnapshot || manager.store.getSettings();
  if (getVoiceConversationPolicy(resolved).commandOnlyMode) return true;
  return typeof manager.getMusicPhase === "function"
    ? musicPhaseShouldForceCommandOnly(manager.getMusicPhase(session))
    : false;
}
