import { getFollowupSettings, getVoiceConversationPolicy } from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import { shouldAllowSystemSpeechSkipAfterFire } from "./systemSpeechOpportunity.ts";
import {
  JOIN_GREETING_LLM_WINDOW_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  STT_CONTEXT_MAX_MESSAGES,
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
} from "./voiceSessionManager.constants.ts";
import {
  SOUNDBOARD_MAX_CANDIDATES,
  formatSoundboardCandidateLine,
  isRealtimeMode,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import { providerSupports } from "./voiceModes.ts";
import {
  normalizeSoundboardRefs as normalizeSoundboardRefsModule,
  resolveSoundboardCandidates as resolveSoundboardCandidatesModule
} from "./voiceSoundboard.ts";
import type { ReplyInterruptionPolicy } from "./bargeInController.ts";
import type {
  VoiceConversationContext,
  VoiceGenerationContextSnapshot,
  VoicePendingResponseLatencyContext,
  VoiceRealtimeToolSettings,
  VoiceSession
} from "./voiceSessionTypes.ts";
import type { VoiceSessionManager } from "./voiceSessionManager.ts";

type GeneratedPayload = {
  text?: string;
  soundboardRefs?: unknown[];
  usedWebSearchFollowup?: boolean;
  usedOpenArticleFollowup?: boolean;
  usedScreenShareOffer?: boolean;
  leaveVoiceChannelRequested?: boolean;
  voiceAddressing?: unknown;
  generationContextSnapshot?: VoiceGenerationContextSnapshot | null;
};

type ContextMessage = {
  role: "assistant" | "user";
  content: string;
};

export interface VoiceReplyPipelineParams {
  session: VoiceSession;
  settings: VoiceRealtimeToolSettings | null;
  userId: string | null;
  transcript: string;
  directAddressed?: boolean;
  directAddressConfidence?: number;
  conversationContext?: VoiceConversationContext | null;
  mode: "brain" | "bridge";
  source?: string;
  inputKind?: string;
  latencyContext?: VoicePendingResponseLatencyContext | null;
  forceSpokenOutput?: boolean;
  spokenOutputRetryCount?: number;
}

export type VoiceReplyPipelineHost = Pick<VoiceSessionManager,
  | "annotateLatestVoiceTurnAddressing"
  | "beginVoiceWebLookupBusy"
  | "buildReplyInterruptionPolicy"
  | "buildVoiceAddressingState"
  | "buildVoiceConversationContext"
  | "buildVoiceReplyPlaybackPlan"
  | "buildVoiceToolCallbacks"
  | "endSession"
  | "generateVoiceTurn"
  | "getRecentVoiceMembershipEvents"
  | "getStreamWatchBrainContextForPrompt"
  | "getVoiceChannelParticipants"
  | "logVoiceLatencyStage"
  | "maybeClearActiveReplyInterruptionPolicy"
  | "normalizeVoiceAddressingAnnotation"
  | "playVoiceReplyInOrder"
  | "recordVoiceTurn"
  | "setActiveReplyInterruptionPolicy"
  | "soundboardDirector"
  | "updateModelContextSummary"
  | "waitForLeaveDirectivePlayback"
> & {
  client: VoiceSessionManager["client"];
  instructionManager: VoiceSessionManager["instructionManager"];
  llm: VoiceSessionManager["llm"];
  sessionLifecycle: VoiceSessionManager["sessionLifecycle"];
  store: VoiceSessionManager["store"];
};

function toGeneratedPayload(value: unknown): GeneratedPayload {
  if (value && typeof value === "object") {
    return value as GeneratedPayload;
  }
  return {
    text: typeof value === "string" ? value : "",
    soundboardRefs: [],
    usedWebSearchFollowup: false,
    usedOpenArticleFollowup: false,
    usedScreenShareOffer: false,
    leaveVoiceChannelRequested: false,
    voiceAddressing: null
  };
}

function buildContextMessages(session: VoiceSession, normalizedTranscript: string) {
  const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
  const contextTurns = Array.isArray(session.recentVoiceTurns)
    ? session.recentVoiceTurns
      .filter((row) => row && typeof row === "object")
      .slice(-STT_CONTEXT_MAX_MESSAGES)
    : [];
  if (contextTurns.length > 0 && contextTranscript) {
    const lastTurn = contextTurns[contextTurns.length - 1];
    const lastRole = lastTurn?.role === "assistant" ? "assistant" : "user";
    const lastContent = normalizeVoiceText(lastTurn?.text, STT_REPLY_MAX_CHARS);
    if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
      contextTurns.pop();
    }
  }
  const contextMessages: ContextMessage[] = contextTurns
    .map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
    }))
    .filter((row): row is ContextMessage => Boolean(row.content));
  const contextMessageChars = contextMessages.reduce((total, row) => total + row.content.length, 0);
  return { contextMessages, contextMessageChars, contextTurns };
}

function logReplySkipped({
  host,
  params,
  replyText,
  usedWebSearchFollowup,
  usedOpenArticleFollowup,
  usedScreenShareOffer,
  generatedVoiceAddressing,
  leaveVoiceChannelRequested,
  joinWindowActive,
  joinWindowAgeMs,
  resolvedConversationContext,
  contextMessages,
  contextTurns,
  contextMessageChars
}: {
  host: VoiceReplyPipelineHost;
  params: VoiceReplyPipelineParams;
  replyText: string;
  usedWebSearchFollowup: boolean;
  usedOpenArticleFollowup: boolean;
  usedScreenShareOffer: boolean;
  generatedVoiceAddressing: ReturnType<VoiceReplyPipelineHost["normalizeVoiceAddressingAnnotation"]>;
  leaveVoiceChannelRequested: boolean;
  joinWindowActive: boolean;
  joinWindowAgeMs: number;
  resolvedConversationContext: VoiceConversationContext | null;
  contextMessages: ContextMessage[];
  contextTurns: Array<Record<string, unknown>>;
  contextMessageChars: number;
}) {
  const skipCause = !replyText
    ? "empty_reply_text"
    : replyText === "[SKIP]"
      ? "model_skip"
      : "no_playback_steps";
  host.store.logAction({
    kind: "voice_runtime",
    guildId: params.session.guildId,
    channelId: params.session.textChannelId,
    userId: host.client.user?.id || null,
    content: params.mode === "bridge" ? "realtime_reply_skipped" : "stt_pipeline_reply_skipped",
    metadata: {
      sessionId: params.session.id,
      mode: params.session.mode,
      source: String(params.source || params.mode),
      forceSpokenOutput: Boolean(params.forceSpokenOutput),
      usedWebSearchFollowup,
      usedOpenArticleFollowup,
      usedScreenShareOffer,
      talkingTo: generatedVoiceAddressing?.talkingTo || null,
      directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
        ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
        : 0,
      soundboardRefs: [],
      leaveVoiceChannelRequested,
      skipCause,
      replyTextPreview: replyText ? replyText.slice(0, 220) : null,
      joinWindowActive,
      joinWindowAgeMs: Math.round(joinWindowAgeMs),
      conversationState: resolvedConversationContext?.engagementState || null,
      engagedWithCurrentSpeaker: Boolean(resolvedConversationContext?.engagedWithCurrentSpeaker),
      contextTurnsSent: contextMessages.length,
      contextTurnsAvailable: contextTurns.length,
      contextCharsSent: contextMessageChars
    }
  });
}

export async function runVoiceReplyPipeline(
  host: VoiceReplyPipelineHost,
  params: VoiceReplyPipelineParams
): Promise<boolean> {
  const { session } = params;
  const source = String(params.source || params.mode).trim() || params.mode;
  if (!session || session.ending) return false;

  if (params.mode === "brain") {
    if (session.mode !== "stt_pipeline") return false;
    if (!host.llm?.synthesizeSpeech || typeof host.generateVoiceTurn !== "function") return false;
  } else {
    if (!isRealtimeMode(session.mode)) return false;
    if (typeof host.generateVoiceTurn !== "function") {
      host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: params.userId,
        content: "realtime_generation_unavailable",
        metadata: {
          sessionId: session.id,
          source
        }
      });
      return false;
    }
  }

  const normalizedTranscript = normalizeVoiceText(params.transcript, STT_TRANSCRIPT_MAX_CHARS);
  if (!normalizedTranscript) return false;

  const { contextMessages, contextMessageChars, contextTurns } = buildContextMessages(session, normalizedTranscript);
  host.updateModelContextSummary(session, "generation", {
    source,
    capturedAt: new Date().toISOString(),
    availableTurns: contextTurns.length,
    sentTurns: contextMessages.length,
    maxTurns: STT_CONTEXT_MAX_MESSAGES,
    contextChars: contextMessageChars,
    transcriptChars: normalizedTranscript.length,
    directAddressed: Boolean(params.directAddressed)
  });

  const soundboardCandidateInfo = await resolveSoundboardCandidatesModule(host, {
    session,
    settings: params.settings
  });
  const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
    ? soundboardCandidateInfo.candidates
    : []
  )
    .map((entry) => formatSoundboardCandidateLine(entry))
    .filter(Boolean)
    .slice(0, SOUNDBOARD_MAX_CANDIDATES);

  const resolvedConversationContext =
    params.conversationContext && typeof params.conversationContext === "object"
      ? params.conversationContext
      : host.buildVoiceConversationContext({
        session,
        userId: params.userId,
        directAddressed: Boolean(params.directAddressed)
      });
  const participantRoster = host.getVoiceChannelParticipants(session).slice(0, REALTIME_CONTEXT_MEMBER_LIMIT);
  const recentMembershipEvents = host.getRecentVoiceMembershipEvents(session, {
    maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
  });
  const contextNow = Date.now();
  const joinWindowAgeMs = Math.max(0, contextNow - Number(session.startedAt || 0));
  const joinWindowActive = Boolean(session.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
  const sessionTiming = host.sessionLifecycle.buildVoiceSessionTimingContext(session);
  const streamWatchBrainContext = host.getStreamWatchBrainContextForPrompt(session, params.settings);
  const voiceAddressingState = host.buildVoiceAddressingState({
    session,
    userId: params.userId,
    now: contextNow
  });
  const generationConversationContext = {
    ...(resolvedConversationContext || {}),
    joinWindowActive,
    joinWindowAgeMs: Math.round(joinWindowAgeMs),
    sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
    sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
    streamWatchBrainContext,
    voiceAddressingState
  };

  const normalizedLatencyContext =
    params.mode === "bridge" && params.latencyContext && typeof params.latencyContext === "object"
      ? params.latencyContext
      : null;
  const latencyFinalizedAtMs = Math.max(0, Number(normalizedLatencyContext?.finalizedAtMs || 0));
  const latencyAsrStartedAtMs = Math.max(0, Number(normalizedLatencyContext?.asrStartedAtMs || 0));
  const latencyAsrCompletedAtMs = Math.max(0, Number(normalizedLatencyContext?.asrCompletedAtMs || 0));
  const latencyQueueWaitMs = Number.isFinite(Number(normalizedLatencyContext?.queueWaitMs))
    ? Math.max(0, Math.round(Number(normalizedLatencyContext?.queueWaitMs)))
    : null;
  const latencyPendingQueueDepth = Number.isFinite(Number(normalizedLatencyContext?.pendingQueueDepth))
    ? Math.max(0, Math.round(Number(normalizedLatencyContext?.pendingQueueDepth)))
    : null;
  const latencyCaptureReason = String(normalizedLatencyContext?.captureReason || "").trim() || null;

  const generationStartedAt = Date.now();
  let releaseLookupBusy: (() => void) | null = null;
  let generatedPayload: GeneratedPayload | null = null;
  const voiceConversation = getVoiceConversationPolicy(params.settings);
  const followup = getFollowupSettings(params.settings);
  try {
    generatedPayload = toGeneratedPayload(await host.generateVoiceTurn({
      settings: params.settings,
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      transcript: normalizedTranscript,
      ...(params.mode === "bridge" ? { inputKind: params.inputKind || "transcript" } : {}),
      directAddressed: Boolean(params.directAddressed),
      contextMessages,
      sessionId: session.id,
      isEagerTurn: !params.directAddressed && !generationConversationContext?.engaged,
      joinWindowActive,
      joinWindowAgeMs,
      voiceEagerness: Number(voiceConversation.replyEagerness) || 0,
      conversationContext: generationConversationContext,
      sessionTiming,
      participantRoster,
      recentMembershipEvents,
      soundboardCandidates: soundboardCandidateLines,
      onWebLookupStart: async ({ query }: { query: string }) => {
        if (typeof releaseLookupBusy === "function") return;
        releaseLookupBusy = host.beginVoiceWebLookupBusy({
          session,
          settings: params.settings,
          userId: params.userId,
          query,
          source: params.mode === "bridge" ? `${source}:web_lookup` : "stt_pipeline_web_lookup"
        });
      },
      onWebLookupComplete: async () => {
        if (typeof releaseLookupBusy !== "function") return;
        releaseLookupBusy();
        releaseLookupBusy = null;
      },
      webSearchTimeoutMs: Number(followup.toolBudget?.toolTimeoutMs),
      voiceToolCallbacks: host.buildVoiceToolCallbacks({ session, settings: params.settings })
    }));
    if (generatedPayload?.generationContextSnapshot) {
      session.lastGenerationContext = {
        ...generatedPayload.generationContextSnapshot,
        source,
        mode: session.mode || source
      };
    }
  } catch (error) {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: params.userId,
      content: `${params.mode === "bridge" ? "realtime" : "stt_pipeline"}_generation_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        source
      }
    });
    return false;
  } finally {
    if (typeof releaseLookupBusy === "function") {
      releaseLookupBusy();
      releaseLookupBusy = null;
    }
  }

  if (session.ending) return false;

  const replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
  const requestedSoundboardRefs = normalizeSoundboardRefsModule(generatedPayload?.soundboardRefs);
  const usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
  const usedOpenArticleFollowup = Boolean(generatedPayload?.usedOpenArticleFollowup);
  const usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
  const leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
  const generatedVoiceAddressing = host.normalizeVoiceAddressingAnnotation({
    rawAddressing: generatedPayload?.voiceAddressing,
    directAddressed: Boolean(params.directAddressed),
    directedConfidence: Number(params.directAddressConfidence),
    source: "generation",
    reason: "voice_generation"
  });
  if (generatedVoiceAddressing) {
    host.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId: params.userId,
      text: normalizedTranscript,
      addressing: generatedVoiceAddressing
    });
  }

  const replyInterruptionPolicy: ReplyInterruptionPolicy | null = params.mode === "bridge"
    ? host.buildReplyInterruptionPolicy({
      session,
      userId: params.userId,
      directAddressed: Boolean(params.directAddressed),
      conversationContext: resolvedConversationContext,
      generatedVoiceAddressing,
      source
    })
    : null;

  const shouldRetryForcedSpeech =
    params.mode === "bridge" &&
    Boolean(params.forceSpokenOutput) &&
    !shouldAllowSystemSpeechSkipAfterFire(source) &&
    Math.max(0, Number(params.spokenOutputRetryCount || 0)) < 1 &&
    (!replyText || replyText === "[SKIP]");
  if (shouldRetryForcedSpeech) {
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "realtime_reply_retrying_forced_system_speech",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source,
        retryCount: Number(params.spokenOutputRetryCount || 0) + 1
      }
    });
    return await runVoiceReplyPipeline(host, {
      ...params,
      source,
      transcript: `${normalizedTranscript} Respond now with one short spoken line. Do not return [SKIP].`,
      conversationContext: resolvedConversationContext,
      spokenOutputRetryCount: Number(params.spokenOutputRetryCount || 0) + 1
    });
  }

  const playbackPlan = host.buildVoiceReplyPlaybackPlan({
    replyText,
    trailingSoundboardRefs: requestedSoundboardRefs
  });
  if (!playbackPlan.spokenText && playbackPlan.soundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
    logReplySkipped({
      host,
      params: { ...params, source },
      replyText,
      usedWebSearchFollowup,
      usedOpenArticleFollowup,
      usedScreenShareOffer,
      generatedVoiceAddressing,
      leaveVoiceChannelRequested,
      joinWindowActive,
      joinWindowAgeMs,
      resolvedConversationContext,
      contextMessages,
      contextTurns,
      contextMessageChars
    });
    return true;
  }

  if (
    params.mode === "bridge" &&
    playbackPlan.spokenText &&
    providerSupports(session.mode || "", "updateInstructions")
  ) {
    void host.instructionManager.prepareRealtimeTurnContext({
      session,
      settings: params.settings,
      userId: params.userId,
      transcript: normalizedTranscript,
      captureReason: source
    }).catch((error: unknown) => {
      host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: `openai_realtime_turn_context_refresh_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source
        }
      });
    });
  }

  const replyRequestedAt = Date.now();
  const replyLatencyContext = params.mode === "bridge"
    ? {
      finalizedAtMs: latencyFinalizedAtMs,
      asrStartedAtMs: latencyAsrStartedAtMs,
      asrCompletedAtMs: latencyAsrCompletedAtMs,
      generationStartedAtMs: generationStartedAt,
      replyRequestedAtMs: replyRequestedAt,
      audioStartedAtMs: 0,
      source,
      captureReason: latencyCaptureReason,
      queueWaitMs: latencyQueueWaitMs,
      pendingQueueDepth: latencyPendingQueueDepth
    }
    : null;
  if (replyInterruptionPolicy) {
    host.setActiveReplyInterruptionPolicy(session, replyInterruptionPolicy);
  }
  if (params.mode === "bridge") {
    session.lastAssistantReplyAt = replyRequestedAt;
  }

  const playbackSource = params.mode === "bridge" ? `${source}:reply` : `${source}_reply`;
  const useRealtimeTts =
    params.mode === "bridge"
      ? String(getVoiceConversationPolicy(params.settings).ttsMode || "").trim().toLowerCase() !== "api"
      : false;
  const playbackResult = await host.playVoiceReplyInOrder({
    session,
    settings: params.settings,
    spokenText: playbackPlan.spokenText,
    playbackSteps: playbackPlan.steps,
    source: playbackSource,
    preferRealtimeUtterance: useRealtimeTts,
    interruptionPolicy: replyInterruptionPolicy,
    latencyContext: replyLatencyContext
  });
  if (!playbackResult.completed) {
    if (playbackPlan.spokenText) {
      host.recordVoiceTurn(session, {
        role: "assistant",
        userId: host.client.user?.id || null,
        text: `[interrupted] ${playbackPlan.spokenText}`
      });
    }
    if (params.mode === "bridge") {
      host.maybeClearActiveReplyInterruptionPolicy(session);
    }
    return false;
  }

  const requestedRealtimeUtterance = Boolean(playbackResult.requestedRealtimeUtterance);
  try {
    const replyAt = params.mode === "bridge" ? replyRequestedAt : Date.now();
    if (params.mode === "bridge") {
      const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
      host.logVoiceLatencyStage({
        session,
        userId: host.client.user?.id || null,
        stage: "reply_requested",
        source,
        captureReason: latencyCaptureReason,
        requestId: pendingRequestId,
        queueWaitMs: latencyQueueWaitMs,
        pendingQueueDepth: latencyPendingQueueDepth,
        finalizedAtMs: latencyFinalizedAtMs,
        asrStartedAtMs: latencyAsrStartedAtMs,
        asrCompletedAtMs: latencyAsrCompletedAtMs,
        generationStartedAtMs: generationStartedAt,
        replyRequestedAtMs: replyRequestedAt,
        audioStartedAtMs: 0
      });
      if (playbackResult.spokeLine && !requestedRealtimeUtterance) {
        session.lastAudioDeltaAt = replyRequestedAt;
        session.lastAssistantReplyAt = replyRequestedAt;
      }
      if (playbackPlan.spokenText && !requestedRealtimeUtterance) {
        host.recordVoiceTurn(session, {
          role: "assistant",
          userId: host.client.user?.id || null,
          text: playbackPlan.spokenText
        });
      }
      host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: "realtime_reply_requested",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source,
          requestId: pendingRequestId,
          replyText: playbackPlan.spokenText || null,
          requestedRealtimeUtterance,
          soundboardRefs: playbackPlan.soundboardRefs,
          playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          leaveVoiceChannelRequested,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
    } else {
      const spokeLine = Boolean(playbackResult.spokeLine);
      const replyRuntimeEvent = playbackPlan.spokenText
        ? "stt_pipeline_reply_spoken"
        : playbackPlan.soundboardRefs.length > 0
          ? "stt_pipeline_soundboard_only"
          : leaveVoiceChannelRequested
            ? "stt_pipeline_leave_directive"
            : "stt_pipeline_reply_skipped";
      if (spokeLine) {
        session.lastAudioDeltaAt = replyAt;
      }
      session.lastAssistantReplyAt = replyAt;
      if (playbackPlan.spokenText) {
        host.recordVoiceTurn(session, {
          role: "assistant",
          userId: host.client.user?.id || null,
          text: playbackPlan.spokenText
        });
      }
      host.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: replyRuntimeEvent,
        metadata: {
          sessionId: session.id,
          replyText: playbackPlan.spokenText || null,
          spokeLine,
          soundboardRefs: playbackPlan.soundboardRefs,
          playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          leaveVoiceChannelRequested,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
    }
  } catch (error) {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: `${params.mode === "bridge" ? "realtime" : "stt_pipeline"}_audio_write_failed: ${String(error?.message || error)}`,
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source
      }
    });
  }

  if (!leaveVoiceChannelRequested || session.ending) {
    return true;
  }

  if (playbackPlan.spokenText && playbackResult.spokeLine) {
    await host.waitForLeaveDirectivePlayback({
      session,
      expectRealtimeAudio: requestedRealtimeUtterance,
      source: params.mode === "bridge" ? `${source}:leave_directive` : `${source}_leave_directive`
    });
  }

  await host.endSession({
    guildId: session.guildId,
    reason: "assistant_leave_directive",
    requestedByUserId: host.client.user?.id || null,
    settings: params.settings,
    announcement: "wrapping up vc."
  }).catch((error: unknown) => {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: `assistant_leave_directive_failed: ${String((error as Error)?.message || error)}`,
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source
      }
    });
  });

  return true;
}
