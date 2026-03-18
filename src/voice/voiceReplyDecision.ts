import { clamp } from "../utils.ts";
import { buildSingleTurnPromptLog } from "../promptLogging.ts";
import { getPromptBotName } from "../prompts/promptCore.ts";
import {
  normalizeVoiceText,
  isRealtimeMode,
  normalizeVoiceRuntimeEventContext
} from "./voiceSessionHelpers.ts";
import {
  buildVoiceAddressingState as buildVoiceAddressingStateFromTranscript,
  hasBotNameCueForTranscript as hasBotNameCueForTranscriptFromSettings,
  normalizeVoiceAddressingAnnotation as normalizeVoiceAddressingAnnotationFromTranscript,
  resolveVoiceDirectAddressSignal
} from "./voiceAddressing.ts";
import { parseBooleanFlag } from "../normalization/valueParsers.ts";
import {
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS,
  RECENT_ENGAGEMENT_WINDOW_MS,
  STT_REPLY_MAX_CHARS,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
} from "./voiceSessionManager.constants.ts";
import {
  normalizeVoiceReplyDecisionProvider,
  defaultVoiceReplyDecisionModel,
  resolveVoiceReplyDecisionMaxOutputTokens
} from "./voiceDecisionRuntime.ts";
import { DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD } from "../bot/directAddressConfidence.ts";
import type {
  VoiceConversationContext,
  VoiceReplyDecision,
  VoiceAddressingState,
  VoiceAddressingAnnotation,
  VoiceCommandState,
  LoggedVoicePromptBundle,
  VoiceSession,
  OutputChannelState,
  MusicPlaybackPhase,
  VoiceRuntimeEventContext,
  SpeakerTranscript
} from "./voiceSessionTypes.ts";
import {
  musicPhaseShouldForceCommandOnly
} from "./voiceSessionTypes.ts";
import {
  applyOrchestratorOverrideSettings,
  getActivitySettings,
  getResolvedVoiceAdmissionClassifierBinding,
  getVoiceAdmissionSettings,
  getVoiceConversationPolicy
} from "../settings/agentStack.ts";
import { resolveRealtimeAdmissionModeForRuntime } from "../settings/voiceDashboardMappings.ts";
import { isCancelIntent } from "../tools/cancelDetection.ts";
import {
  clearMusicWakeLatch,
  getMusicWakeFollowupState,
  touchMusicWakeLatch
} from "./musicWakeLatch.ts";

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
  hasPendingMusicDisambiguationForUser?: (
    session: ReplyDecisionSessionLike | null | undefined,
    userId?: string | null
  ) => boolean;
  getVoiceChannelParticipants: (
    session: ReplyDecisionSessionLike | null | undefined
  ) => Array<{ userId: string; displayName: string }>;
  resolveVoiceSpeakerName: (
    session: ReplyDecisionSessionLike | null | undefined,
    userId?: string | null
  ) => string;
  getOutputChannelState: (
    session: ReplyDecisionSessionLike | null | undefined
  ) => Pick<
    OutputChannelState,
    "locked" | "lockReason" | "toolCallsRunning" | "awaitingToolOutputs" | "pendingResponse"
  >;
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
  shouldUseTextMediatedRealtimeReply?: (args: {
    session: ReplyDecisionSessionLike | null | undefined;
    settings?: ReplyDecisionSettings;
  }) => boolean;
  formatVoiceDecisionHistory?: (
    session: ReplyDecisionSessionLike | null | undefined,
    maxTurns?: number,
    maxTotalChars?: number
  ) => string;
  getMusicPhase?: (session: ReplyDecisionSessionLike | null | undefined) => MusicPlaybackPhase;
}

function resolveRealtimeAdmissionMode(settings: ReplyDecisionSettings): "hard_classifier" | "generation_only" {
  return resolveRealtimeAdmissionModeForRuntime(
    getVoiceAdmissionSettings(settings).mode,
    getVoiceConversationPolicy(settings).replyPath
  );
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


function hasBotNameCueForTranscript(
  manager: ReplyDecisionHost,
  { transcript = "", settings = null }: {
    transcript?: string;
    settings?: ReplyDecisionSettings;
  } = {}
) {
  return hasBotNameCueForTranscriptFromSettings({
    transcript,
    settings: settings || manager.store.getSettings()
  });
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

function resolveInterruptedAssistantReplyContext(
  manager: ReplyDecisionHost,
  {
    session = null,
    userId = null,
    now = Date.now()
  }: {
    session?: ReplyDecisionSessionLike | null;
    userId?: string | null;
    now?: number;
  } = {}
) {
  const interrupted = session?.interruptedAssistantReply;
  if (!interrupted || typeof interrupted !== "object") return null;

  const normalizedUserId = String(userId || "").trim();
  const interruptedByUserId = String(interrupted.interruptedByUserId || "").trim();
  if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
    return null;
  }

  const interruptedAt = Math.max(0, Number(interrupted.interruptedAt || 0));
  if (!interruptedAt) return null;
  if (now - interruptedAt > RECENT_ENGAGEMENT_WINDOW_MS) {
    return null;
  }
  if (Math.max(0, Number(session?.lastAssistantReplyAt || 0)) > interruptedAt) {
    return null;
  }

  const utteranceText = normalizeVoiceText(interrupted.utteranceText || "", STT_REPLY_MAX_CHARS);
  if (!utteranceText) return null;

  return {
    utteranceText,
    interruptedByUserId,
    interruptedBySpeakerName: manager.resolveVoiceSpeakerName(session, interruptedByUserId),
    interruptedAt,
    ageMs: Math.max(0, now - interruptedAt),
    source: String(interrupted.source || "").trim() || null
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
  const activeVoiceCommandCountsAsEngagement = activeVoiceCommandState?.intent !== "tool_followup";
  const sameAsVoiceCommandUser =
    Boolean(normalizedUserId) &&
    Boolean(activeVoiceCommandState?.userId) &&
    normalizedUserId === activeVoiceCommandState.userId;
  const interruptedAssistantReply = resolveInterruptedAssistantReplyContext(manager, {
    session,
    userId: normalizedUserId,
    now
  });
  const singleParticipantAssistantFollowup = detectSingleParticipantAssistantFollowup(manager, {
    session,
    userId: normalizedUserId,
    participantCount,
    now
  });

  const currentSpeakerActive =
    Boolean(directAddressed) ||
    singleParticipantAssistantFollowup.active ||
    (activeVoiceCommandCountsAsEngagement && sameAsVoiceCommandUser) ||
    (recentAssistantReply && sameAsRecentDirectAddress) ||
    (recentDirectAddress && sameAsRecentDirectAddress) ||
    Boolean(interruptedAssistantReply);
  const attentionMode =
    Boolean(directAddressed) ||
    recentAssistantReply ||
    recentDirectAddress ||
    singleParticipantAssistantFollowup.active ||
    Boolean(interruptedAssistantReply)
      ? "ACTIVE"
      : "AMBIENT";

  return {
    attentionMode,
    currentSpeakerActive,
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
      : null,
    interruptedAssistantReply
  };
}

function buildVoiceAddressingState(manager: ReplyDecisionHost, {
  session = null,
  userId = null,
  now = Date.now(),
  maxItems = 6
} = {}): VoiceAddressingState | null {
  return buildVoiceAddressingStateFromTranscript({
    session,
    userId,
    now,
    maxItems
  });
}

function normalizeVoiceAddressingAnnotation(_manager: ReplyDecisionHost, {
  rawAddressing = null,
  directAddressed = false,
  directedConfidence = Number.NaN,
  source = "",
  reason = null
} = {}): VoiceAddressingAnnotation | null {
  return normalizeVoiceAddressingAnnotationFromTranscript({
    rawAddressing,
    directAddressed,
    directedConfidence,
    source,
    reason
  });
}

export async function evaluateVoiceReplyDecision(manager: ReplyDecisionHost, {
  session,
  settings,
  userId,
  transcript,
  inputKind = "transcript",
  source: _source = "realtime",
  transcriptionContext: _transcriptionContext = null,
  runtimeEventContext = null,
  speakerTranscripts = null
}: {
  session: VoiceSession;
  settings: Record<string, unknown> | null;
  userId: string;
  transcript: string;
  inputKind?: string;
  source?: string;
  transcriptionContext?: Record<string, unknown> | null;
  runtimeEventContext?: VoiceRuntimeEventContext | null;
  speakerTranscripts?: SpeakerTranscript[] | null;
}): Promise<VoiceReplyDecision> {
  const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
  const normalizedInputKind = inputKind === "event" ? "event" : "transcript";
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
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
      conversationContext: emptyConversationContext,
      runtimeEventContext: normalizedRuntimeEventContext
    };
  }
  const directAddressSignal =
    normalizedInputKind === "event"
      ? {
        directAddressed: false,
        nameCueDetected: false,
        addressedOrNamed: false
      }
      : resolveVoiceDirectAddressSignal({
        transcript: normalizedTranscript,
        settings
      });
  const directAddressAssessment = {
    confidence: directAddressSignal.directAddressed ? 0.92 : 0,
    threshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
    addressed: directAddressSignal.directAddressed,
    reason: directAddressSignal.directAddressed ? "deterministic_wake_phrase" : "deterministic_not_direct"
  };
  const directAddressConfidence = Number(directAddressAssessment.confidence) || 0;
  const directAddressThreshold = Number(directAddressAssessment.threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD;
  const directAddressed = directAddressConfidence >= directAddressThreshold;
  const ambientReplyEagerness = clamp(
    Number(getVoiceConversationPolicy(settings).ambientReplyEagerness) || 0,
    0,
    100
  );
  const responseWindowEagerness = clamp(
    Number(getActivitySettings(settings).responseWindowEagerness) || 0,
    0,
    100
  );
  const activeVoiceCommandState =
    typeof manager.ensureVoiceCommandState === "function"
      ? manager.ensureVoiceCommandState(session)
      : null;
  const sameSpeakerPendingCommandFollowup =
    normalizedInputKind === "event"
      ? false
      : Boolean(
        normalizedUserId &&
        activeVoiceCommandState?.userId === normalizedUserId &&
        activeVoiceCommandState?.domain === "music" &&
        typeof manager.hasPendingMusicDisambiguationForUser === "function" &&
        manager.hasPendingMusicDisambiguationForUser(session, normalizedUserId)
      );
  const musicActive = typeof manager.isMusicPlaybackActive === "function" && manager.isMusicPlaybackActive(session);
  // Consume the transient bypass flag set by maybeHandleMusicPlaybackTurn when
  // a control command candidate is deferred to the main brain (musicBrain off).
  const musicControlCommandCandidateBypass = Boolean(session?.musicControlCommandCandidateBypass);
  if (session) {
    session.musicControlCommandCandidateBypass = false;
  }
  if (!musicActive) {
    clearMusicWakeLatch(session);
  }
  let musicWakeLatchState = getMusicWakeFollowupState(session, normalizedUserId, now);
  // Music wake latch is scoped to the user who set it. In a group channel,
  // Alice saying "hey clanky" shouldn't open the latch for Bob's next turn.
  let musicWakeLatched = musicWakeLatchState.passiveWakeFollowupAllowed;
  let msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
  const baseConversationContext = buildVoiceConversationContext(manager, {
    session,
    userId: normalizedUserId,
    directAddressed,
    participantCount,
    now
  });
  const interruptedReplyOwnerFollowup = Boolean(baseConversationContext.interruptedAssistantReply);
  const buildConversationContext = () => ({
    ...baseConversationContext,
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
      runtimeEventContext: normalizedRuntimeEventContext,
      retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
      outputLockReason: outputChannelState.lockReason
    };
  }

  // Resolve active command owner for classifier context.
  // When a tool call is running or the bot is mid-response for a specific user's command,
  // the classifier should know so it can deprioritize cross-talk from other users.
  const toolCallOwnerUserId = String(session.lastRealtimeToolCallerUserId || "").trim() || null;
  const hasActiveCommandFlow = Boolean(
    outputChannelState.toolCallsRunning ||
    outputChannelState.awaitingToolOutputs ||
    outputChannelState.pendingResponse
  );
  const activeCommandOwner =
    hasActiveCommandFlow && toolCallOwnerUserId && toolCallOwnerUserId !== normalizedUserId
      ? manager.resolveVoiceSpeakerName(session, toolCallOwnerUserId) || null
      : null;
  const activeCommandSpeaker = String(baseConversationContext.activeCommandSpeaker || "").trim() || null;
  const activeCommandIntent = String(baseConversationContext.activeCommandIntent || "").trim() || null;
  const ownedToolFollowupActive =
    normalizedInputKind !== "event" &&
    activeCommandIntent === "tool_followup" &&
    Boolean(activeCommandSpeaker);

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
      conversationContext,
      runtimeEventContext: normalizedRuntimeEventContext
    };
  }

  if (ownedToolFollowupActive) {
    if (isCancelIntent(normalizedTranscript)) {
      if (activeCommandSpeaker === normalizedUserId || directAddressSignal.addressedOrNamed) {
        return {
          allow: true,
          reason: "owned_tool_followup_cancel",
          participantCount,
          directAddressed,
          directAddressConfidence,
          directAddressThreshold,
          transcript: normalizedTranscript,
          conversationContext,
          runtimeEventContext: normalizedRuntimeEventContext
        };
      }
    } else if (activeCommandSpeaker === normalizedUserId) {
      return {
        allow: true,
        reason: "owned_tool_followup",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
    if (!isCancelIntent(normalizedTranscript)) {
      return {
        allow: false,
        reason: "owned_tool_followup_other_speaker_blocked",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
  }

  if (manager.isCommandOnlyActive(session, settings)) {
    if (directAddressSignal.addressedOrNamed) {
      if (musicActive) {
        touchMusicWakeLatch(session, settings, normalizedUserId, now);
        musicWakeLatchState = getMusicWakeFollowupState(session, normalizedUserId, now);
        musicWakeLatched = musicWakeLatchState.passiveWakeFollowupAllowed;
        msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
        conversationContext = buildConversationContext();
      }
      return {
        allow: true,
        reason: directAddressed ? "command_only_direct_address" : "command_only_name_cue",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
    if (!musicActive) {
      return {
        allow: false,
        reason: "command_only_not_addressed",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
    if (interruptedReplyOwnerFollowup) {
      return {
        allow: true,
        reason: "interrupted_reply_followup",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
    if (!musicWakeLatched && !musicControlCommandCandidateBypass) {
      return {
        allow: false,
        reason: "music_playing_not_awake",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
      };
    }
  }

  // Direct address arms the music wake latch but no longer fast-paths —
  // the classifier decides with directAddressed as a strong hint.
  if (directAddressed && musicActive) {
    touchMusicWakeLatch(session, settings, normalizedUserId, now);
    musicWakeLatchState = getMusicWakeFollowupState(session, normalizedUserId, now);
    musicWakeLatched = musicWakeLatchState.passiveWakeFollowupAllowed;
    msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
    conversationContext = buildConversationContext();
  }

  // Eagerness 0 no longer hard-rejects — it flows to classifier/generation
  // where the tier-based personality prompt handles the conservative behavior.

  const sessionMode = String(session?.mode || "").trim().toLowerCase();
  const mergedWithGeneration =
    isRealtimeMode(sessionMode) &&
    typeof manager.shouldUseTextMediatedRealtimeReply === "function" &&
    manager.shouldUseTextMediatedRealtimeReply({ session, settings });

  // Native realtime without text mediation — the realtime model decides what to respond to
  if (!mergedWithGeneration) {
    return {
      allow: true,
      reason: "native_realtime",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      conversationContext,
      runtimeEventContext: normalizedRuntimeEventContext
    };
  }

  // Bridge mode: deterministic wake arms a short music follow-up latch.
  const nameCueDetected = directAddressSignal.nameCueDetected;
  if (musicActive) {
    if (nameCueDetected || directAddressed) {
      touchMusicWakeLatch(session, settings, normalizedUserId, now);
      musicWakeLatchState = getMusicWakeFollowupState(session, normalizedUserId, now);
      musicWakeLatched = musicWakeLatchState.passiveWakeFollowupAllowed;
      msUntilMusicWakeLatchExpiry = musicWakeLatchState.msUntilExpiry;
      conversationContext = buildConversationContext();
    }
    if (!musicWakeLatched && !interruptedReplyOwnerFollowup && !musicControlCommandCandidateBypass) {
      return {
        allow: false,
        reason: "music_playing_not_awake",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        runtimeEventContext: normalizedRuntimeEventContext
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
      conversationContext,
      runtimeEventContext: normalizedRuntimeEventContext
    };
  }

  // Classifier-first admission for bridge and optional full-brain classifier mode.
  const commonFields = {
    participantCount,
    directAddressed,
    directAddressConfidence,
    directAddressThreshold,
    transcript: normalizedTranscript,
    conversationContext,
    runtimeEventContext: normalizedRuntimeEventContext
  };
  // Resolve speaker names for cross-speaker coalesced turns.
  const resolvedSpeakerTranscripts =
    Array.isArray(speakerTranscripts) && speakerTranscripts.length > 1
      ? speakerTranscripts
        .filter((s) => s && s.transcript)
        .map((s) => ({
          speakerName: manager.resolveVoiceSpeakerName(session, s.userId) || "someone",
          transcript: s.transcript
        }))
      : null;

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
    ambientReplyEagerness,
    responseWindowEagerness,
    pendingCommandFollowupSignal: sameSpeakerPendingCommandFollowup,
    directAddressed,
    nameCueDetected,
    musicActive,
    musicWakeLatched,
    msUntilMusicWakeLatchExpiry,
    activeCommandOwner,
    runtimeEventContext: normalizedRuntimeEventContext,
    speakerTranscripts: resolvedSpeakerTranscripts
  });
  if (classifierResult.allow && musicActive && musicWakeLatched) {
    touchMusicWakeLatch(session, settings, normalizedUserId, now);
    musicWakeLatchState = getMusicWakeFollowupState(session, normalizedUserId, now);
    musicWakeLatched = musicWakeLatchState.passiveWakeFollowupAllowed;
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
    replyPrompts: classifierResult.replyPrompts,
    error: classifierResult.error,
    ...commonFields,
    conversationContext
  };
}

type ClassifierPromptInput = {
  botName: string;
  inputKind?: "transcript" | "event";
  ambientReplyEagerness: number;
  responseWindowEagerness: number;
  participantCount: number;
  participantList: string[];
  speakerName: string;
  transcript: string;
  directAddressed?: boolean;
  nameCueDetected?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  activeCommandOwner?: string | null;
  conversationContext: Pick<
    VoiceConversationContext,
    | "attentionMode"
    | "currentSpeakerActive"
    | "recentAssistantReply"
    | "recentDirectAddress"
    | "sameAsRecentDirectAddress"
    | "msSinceAssistantReply"
    | "msSinceDirectAddress"
    | "activeCommandSpeaker"
    | "activeCommandIntent"
    | "pendingCommandFollowupSignal"
    | "interruptedAssistantReply"
  >;
  recentHistory?: string;
  runtimeEventContext?: VoiceRuntimeEventContext | null;
  /** Per-speaker transcript segments from cross-speaker room coalescing. */
  speakerTranscripts?: { speakerName: string; transcript: string }[] | null;
};

function buildClassifierPrompt(input: ClassifierPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const normalizedAmbientEagerness = Math.max(
    0,
    Math.min(100, Number(input.ambientReplyEagerness) || 0)
  );
  const normalizedResponseWindowEagerness = Math.max(
    0,
    Math.min(100, Number(input.responseWindowEagerness) || 0)
  );
  const normalizedInputKind = input.inputKind === "event" ? "event" : "transcript";
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(input.runtimeEventContext);
  const selfJoinEvent =
    normalizedInputKind === "event" &&
    normalizedRuntimeEventContext?.category === "membership" &&
    normalizedRuntimeEventContext.eventType === "join" &&
    normalizedRuntimeEventContext.actorRole === "self";
  const membershipEvent =
    normalizedInputKind === "event" && normalizedRuntimeEventContext?.category === "membership"
      ? normalizedRuntimeEventContext
      : null;
  const screenShareEvent =
    normalizedInputKind === "event" && normalizedRuntimeEventContext?.category === "screen_share"
      ? normalizedRuntimeEventContext
      : null;

  const systemPrompt = `You are "${input.botName}" (anything phonetically similar to "${input.botName}" is also you) in a Discord voice channel. You handle music, web searches, browsing, and commands when asked. Return exactly YES or NO.`;

  // --- Build context block first ---
  const parts: string[] = [];

  parts.push(`Participants: ${input.participantList.join(", ") || "none"}`);
  if (normalizedInputKind === "event") {
    const triggeringMember =
      selfJoinEvent
        ? "YOU"
        : String(
          normalizedRuntimeEventContext?.actorDisplayName ||
          input.speakerName ||
          "someone"
        ).trim() || "someone";
    parts.push(`Triggering member: ${triggeringMember}`);
    parts.push(`Event: "${input.transcript}"`);
    if (normalizedRuntimeEventContext?.category && normalizedRuntimeEventContext?.eventType) {
      parts.push(`Structured event type: ${normalizedRuntimeEventContext.category}.${normalizedRuntimeEventContext.eventType}`);
    }
    if (screenShareEvent?.hasVisibleFrame) {
      parts.push("Visible frame attached: yes.");
    }
  } else if (Array.isArray(input.speakerTranscripts) && input.speakerTranscripts.length > 1) {
    // Multi-speaker coalesced turn — show each speaker's contribution.
    parts.push("Multiple speakers (room moment):");
    for (const segment of input.speakerTranscripts) {
      parts.push(`  ${segment.speakerName}: "${segment.transcript}"`);
    }
  } else {
    parts.push(`Speaker: ${input.speakerName}`);
    parts.push(`Transcript: "${input.transcript}"`);
  }

  parts.push(`Current room continuity state: ${input.conversationContext.attentionMode === "ACTIVE" ? "ACTIVE" : "AMBIENT"}.`);
  if (normalizedInputKind !== "event") {
    if (input.conversationContext.currentSpeakerActive) {
      parts.push("Current speaker is already in your active thread.");
    } else {
      parts.push("Current speaker is not currently in an active thread with you.");
    }
  }

  // Conversation recency
  if (input.conversationContext.recentAssistantReply) {
    const msSince = Number(input.conversationContext.msSinceAssistantReply || 0);
    const secsSinceReply = Math.round(msSince / 1000);
    const hasRecentDirectAddress = input.conversationContext.msSinceDirectAddress != null
      && input.conversationContext.msSinceDirectAddress <= 15_000;
    if (msSince <= 15_000 && hasRecentDirectAddress) {
      if (normalizedResponseWindowEagerness >= 70) {
        parts.push(`You spoke ${secsSinceReply}s ago in an active back-and-forth — follow-ups are likely still for you.`);
      } else if (normalizedResponseWindowEagerness >= 35) {
        parts.push(`You spoke ${secsSinceReply}s ago in an active back-and-forth — treat that as a meaningful follow-up signal, not a guarantee.`);
      } else {
        parts.push(`You spoke ${secsSinceReply}s ago, but your follow-up bias is conservative. Only assume the thread is still yours if the next turn clearly reconnects to you.`);
      }
    } else {
      parts.push(`You spoke ${secsSinceReply}s ago.`);
    }
  }
  if (input.conversationContext.msSinceDirectAddress != null) {
    const directAddressSeconds = Math.round(input.conversationContext.msSinceDirectAddress / 1000);
    if (input.conversationContext.sameAsRecentDirectAddress) {
      parts.push(`This same speaker addressed you by name ${directAddressSeconds}s ago.`);
    } else {
      parts.push(`A different speaker addressed you by name ${directAddressSeconds}s ago.`);
    }
  }
  if (input.conversationContext.pendingCommandFollowupSignal) {
    parts.push("Pending command follow-up signal: this speaker may be continuing a command or disambiguation turn.");
  }
  if (input.conversationContext.interruptedAssistantReply?.utteranceText) {
    parts.push("Interrupted-reply recovery is active for this speaker.");
  }

  // History
  if (input.recentHistory) {
    parts.push(``);
    parts.push(`Recent voice timeline:\n${input.recentHistory}`);
  }

  // Music state
  if (input.musicActive) {
    parts.push(``);
    parts.push(`Music overlay active.`);
    if (input.musicWakeLatched) {
      parts.push("Music wake overlay is open. Short playback-control or immediate follow-up turns are likelier to be for you, but this is not a separate command mode.");
      if (Number.isFinite(Number(input.msUntilMusicWakeLatchExpiry))) {
        parts.push(`Music wake overlay expires in ${Math.max(0, Math.round(Number(input.msUntilMusicWakeLatchExpiry) / 1000))}s.`);
      }
    }
  }

  // Active command context
  if (input.activeCommandOwner && input.activeCommandOwner !== input.speakerName) {
    parts.push(``);
    parts.push(`You are currently processing a command for ${input.activeCommandOwner}. Say NO unless ${input.speakerName} is directly addressing you by name.`);
  }

  // --- Guidelines (after context, so model reads situation first) ---
  parts.push(``);

  // Room prior
  if (normalizedInputKind !== "event" && input.participantCount <= 1) {
    parts.push("One-on-one room — speech is likely directed at you. Prefer YES unless clearly self-talk or non-speech.");
  }

  // Event-specific guidance
  if (normalizedInputKind === "event") {
    if (selfJoinEvent) {
      if (normalizedAmbientEagerness >= 25 || input.participantCount <= 1) {
        parts.push(`You just joined — say YES to greet unless there is a strong reason not to.`);
      } else {
        parts.push(`You just joined a room where others are talking. Only greet if directly prompted.`);
      }
    } else if (membershipEvent?.eventType === "join") {
      if (normalizedAmbientEagerness >= 50) {
        parts.push(`Someone joined or left. Consider greeting them if it feels natural.`);
      } else {
        parts.push(`Someone joined or left.`);
      }
    } else if (membershipEvent?.eventType === "leave") {
      parts.push("Someone left the voice channel. Only say YES if a quick acknowledgement would feel natural.");
    } else if (screenShareEvent) {
      parts.push("This is a screen-watch state cue, not spoken text.");
      if (screenShareEvent.hasVisibleFrame) {
        parts.push("A visible frame is attached, so a short reaction can be appropriate.");
      }
      parts.push("Direct address is not required here. Say YES when you have a natural brief reaction to a fresh on-screen moment.");
    } else {
      parts.push("A runtime event occurred. Only say YES if a brief acknowledgement would feel natural.");
    }
  }

  // Name detection hints from upstream
  if (input.directAddressed) {
    parts.push("The speaker said your name. This is a strong YES signal unless the context clearly shows they are talking ABOUT you, not TO you.");
  } else if (input.nameCueDetected) {
    parts.push("The speaker may have said your name (fuzzy match). Lean toward YES.");
  }

  parts.push(`Voice ambient-reply eagerness: ${normalizedAmbientEagerness}/100.`);
  parts.push(`Response-window eagerness: ${normalizedResponseWindowEagerness}/100.`);

  if (normalizedAmbientEagerness <= 10) {
    parts.push("You are very quiet in ambient voice — prefer to stay silent unless someone clearly wants your attention. You're here to listen, not to lead.");
  } else if (normalizedAmbientEagerness <= 25) {
    parts.push("You are selective — you engage when addressed or in active back-and-forth, but you're comfortable staying quiet when others are talking among themselves.");
  } else if (normalizedAmbientEagerness <= 50) {
    parts.push("You are a good listener — happy to contribute when you have something worthwhile to add, but you don't force yourself into every exchange.");
  } else if (normalizedAmbientEagerness <= 75) {
    parts.push("You are social and engaged — you enjoy the conversation and are willing to participate when it interests you or you can add value.");
  } else {
    parts.push("You are fully social — you treat this channel like a group hangout and want to be part of the conversation. You'd rather participate than sit back.");
  }

  if (normalizedResponseWindowEagerness <= 20) {
    parts.push("Recent engagement only slightly increases the chance a follow-up is for you.");
  } else if (normalizedResponseWindowEagerness <= 60) {
    parts.push("Recent engagement is a useful follow-up signal, but not an automatic yes.");
  } else {
    parts.push("Recent engagement is a strong follow-up signal. Stay in the thread unless the room clearly pivots away.");
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
  ambientReplyEagerness,
  responseWindowEagerness,
  pendingCommandFollowupSignal = false,
  directAddressed = false,
  nameCueDetected = false,
  musicActive = false,
  musicWakeLatched = false,
  msUntilMusicWakeLatchExpiry = null,
  activeCommandOwner = null,
  runtimeEventContext = null,
  speakerTranscripts = null
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
  ambientReplyEagerness: number;
  responseWindowEagerness: number;
  pendingCommandFollowupSignal?: boolean;
  directAddressed?: boolean;
  nameCueDetected?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  activeCommandOwner?: string | null;
  runtimeEventContext?: VoiceRuntimeEventContext | null;
  speakerTranscripts?: { speakerName: string; transcript: string }[] | null;
}): Promise<{
  allow: boolean;
  decision: "allow" | "deny" | null;
  latencyMs: number;
  confidence: number | null;
  target: string | null;
  reason: string | null;
  error: string | null;
  replyPrompts: LoggedVoicePromptBundle;
}> {
  const classifierBinding = getResolvedVoiceAdmissionClassifierBinding(settings);
  const llmProvider = normalizeVoiceReplyDecisionProvider(
    classifierBinding?.provider || "openai"
  );
  const llmModel = String(classifierBinding?.model || defaultVoiceReplyDecisionModel(llmProvider))
    .trim()
    .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);
  const classifierMaxOutputTokens = resolveVoiceReplyDecisionMaxOutputTokens(llmProvider, llmModel);
  const classifierDebugEnabled = parseBooleanFlag(process.env.VOICE_CLASSIFIER_DEBUG, false);
  const botName = getPromptBotName(settings);
  const normalizedUserId = String(userId || "").trim() || null;
  const normalizedRuntimeEventContext = normalizeVoiceRuntimeEventContext(runtimeEventContext);
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
        ambientReplyEagerness: Number.isFinite(Number(ambientReplyEagerness))
          ? clamp(Number(ambientReplyEagerness), 0, 100)
          : null,
        responseWindowEagerness: Number.isFinite(Number(responseWindowEagerness))
          ? clamp(Number(responseWindowEagerness), 0, 100)
          : null,
        pendingCommandFollowupSignal: Boolean(pendingCommandFollowupSignal),
        musicActive: Boolean(musicActive),
        musicWakeLatched: Boolean(musicWakeLatched),
        msUntilMusicWakeLatchExpiry: Number.isFinite(Number(msUntilMusicWakeLatchExpiry))
          ? Math.max(0, Math.round(Number(msUntilMusicWakeLatchExpiry)))
          : null,
        conversationContext: conversationContext && typeof conversationContext === "object"
          ? {
            attentionMode:
              String(conversationContext.attentionMode || "").trim().toUpperCase() === "ACTIVE"
                ? "ACTIVE"
                : "AMBIENT",
            currentSpeakerActive: Boolean(conversationContext.currentSpeakerActive),
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
        runtimeEventContext: normalizedRuntimeEventContext,
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

  const recentHistory = typeof manager.formatVoiceDecisionHistory === "function"
    ? manager.formatVoiceDecisionHistory(session, CLASSIFIER_HISTORY_MAX_TURNS, CLASSIFIER_HISTORY_MAX_CHARS)
    : "";

  const { systemPrompt: classifierSystemPrompt, userPrompt: classifierUserPrompt } = buildClassifierPrompt({
    botName,
    inputKind,
    ambientReplyEagerness,
    responseWindowEagerness,
    participantCount,
    participantList,
    speakerName,
    transcript,
    directAddressed,
    nameCueDetected,
    musicActive,
    musicWakeLatched,
    msUntilMusicWakeLatchExpiry,
    activeCommandOwner,
    conversationContext,
    recentHistory,
    runtimeEventContext: normalizedRuntimeEventContext,
    speakerTranscripts
  });
  const replyPrompts = buildSingleTurnPromptLog({
    systemPrompt: classifierSystemPrompt,
    userPrompt: classifierUserPrompt
  });
  const promptSnapshot = classifierUserPrompt;
  if (!manager.llm?.generate) {
    return {
      allow: false,
      decision: "deny",
      latencyMs: 0,
      confidence: null,
      target: "UNKNOWN",
      reason: "llm_unavailable",
      error: "llm_generate_unavailable",
      replyPrompts
    };
  }
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
        maxOutputTokens: classifierMaxOutputTokens,
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
        error: null,
        replyPrompts
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
        error: null,
        replyPrompts
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
      error: `unparseable_classifier_output:${rawText.slice(0, 60)}`,
      replyPrompts
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
      error: String(error?.message || error || "unknown_error"),
      replyPrompts
    };
  }
}

function isCommandOnlyActive(
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
