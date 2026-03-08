import type { ClankvoxClient } from "./clankvoxClient.ts";
import type { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import type { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";
import type { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import type { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";
import type { ReplyInterruptionPolicy } from "./bargeInController.ts";
import type { AsrBridgeState } from "./voiceAsrBridge.ts";
import type {
    AssistantOutputLockReason,
    AssistantOutputPhase,
    AssistantOutputState
} from "./assistantOutputState.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";

export type {
    AssistantOutputLockReason,
    AssistantOutputPhase,
    AssistantOutputReason,
    AssistantOutputState,
    ReplyOutputLockState,
    TtsPlaybackState
} from "./assistantOutputState.ts";

export type VoiceAddressingAnnotation = {
    talkingTo: string | null;
    directedConfidence: number;
    source: string | null;
    reason: string | null;
};

export type VoiceAddressingState = {
    currentSpeakerTarget: string | null;
    currentSpeakerDirectedConfidence: number;
    lastDirectedToMe: {
        speakerName: string;
        directedConfidence: number;
        ageMs: number | null;
    } | null;
    recentAddressingGuesses: Array<{
        speakerName: string;
        talkingTo: string | null;
        directedConfidence: number;
        ageMs: number | null;
    }>;
};

export type VoiceConversationContext = {
    engagementState: string;
    engaged: boolean;
    engagedWithCurrentSpeaker: boolean;
    singleParticipantAssistantFollowup?: boolean;
    recentAssistantReply: boolean;
    recentDirectAddress: boolean;
    sameAsRecentDirectAddress: boolean;
    msSinceAssistantReply: number | null;
    msSinceDirectAddress: number | null;
    activeCommandSpeaker?: string | null;
    activeCommandDomain?: string | null;
    activeCommandIntent?: string | null;
    msUntilCommandSessionExpiry?: number | null;
    voiceAddressingState?: VoiceAddressingState | null;
    currentTurnAddressing?: VoiceAddressingAnnotation | null;
    pendingCommandFollowupSignal?: boolean;
    musicActive?: boolean;
    musicWakeLatched?: boolean;
    msUntilMusicWakeLatchExpiry?: number | null;
};

export type VoiceReplyDecision = {
    allow: boolean;
    reason: string;
    participantCount: number;
    directAddressed: boolean;
    directAddressConfidence: number;
    directAddressThreshold: number;
    transcript: string;
    conversationContext: VoiceConversationContext;
    voiceAddressing?: VoiceAddressingAnnotation | null;
    error?: string | null;
    retryAfterMs?: number | null;
    requiredSilenceMs?: number | null;
    msSinceInboundAudio?: number | null;
    outputLockReason?: string | null;
    classifierLatencyMs?: number | null;
    classifierDecision?: "allow" | "deny" | null;
    classifierConfidence?: number | null;
    classifierTarget?: string | null;
    classifierReason?: string | null;
};

export type VoiceTimelineTurn = {
    role: "assistant" | "user";
    userId: string | null;
    speakerName: string;
    text: string;
    at: number;
    addressing?: VoiceAddressingAnnotation;
};

export type VoiceRealtimeToolDescriptor = {
    toolType: "function" | "mcp";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    serverName?: string | null;
};

export type VoiceToolCallEvent = {
    callId: string;
    toolName: string;
    toolType: "function" | "mcp";
    arguments: Record<string, unknown>;
    startedAt: string;
    completedAt: string | null;
    runtimeMs: number | null;
    success: boolean;
    outputSummary: string | null;
    error: string | null;
    sourceEventType?: string | null;
};

export type VoicePendingToolCallState = {
    callId: string;
    name: string;
    argumentsText: string;
    done: boolean;
    startedAtMs: number;
    sourceEventType: string;
};

export type VoiceToolExecutionState = {
    startedAtMs: number;
    toolName: string;
};

export type VoiceMcpServerStatus = {
    serverName: string;
    connected: boolean;
    tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    lastError: string | null;
    lastConnectedAt: string | null;
    lastCallAt: string | null;
    baseUrl: string;
    toolPath: string;
    timeoutMs: number;
    headers: Record<string, string>;
};

export type VoiceRealtimeToolSettings = {
    webSearch?: {
        enabled?: boolean;
        maxResults?: number;
        recencyDaysDefault?: number;
    };
    memory?: {
        enabled?: boolean;
    };
    browser?: {
        enabled?: boolean;
    };
    voice?: {
        replyPath?: string;
    };
    [key: string]: unknown;
};

export type VoiceToolRuntimeSessionLike = {
    ending?: boolean;
    mode?: string;
    realtimeClient?: {
        updateTools?: (payload: {
            tools: Array<{
                type: string;
                name: string;
                description: string;
                parameters: Record<string, unknown>;
            }>;
            toolChoice?: string;
        }) => void;
    } | null;
    mcpStatus?: VoiceMcpServerStatus[];
    settingsSnapshot?: VoiceRealtimeToolSettings | null;
    openAiToolDefinitions?: VoiceRealtimeToolDescriptor[];
    lastOpenAiRealtimeToolHash?: string | null;
    lastOpenAiRealtimeToolRefreshAt?: number | null;
    guildId?: string;
    textChannelId?: string;
    id?: string;
    openAiToolResponseDebounceTimer?: ReturnType<typeof setTimeout> | null;
    openAiToolCallExecutions?: Map<string, VoiceToolExecutionState>;
    openAiPendingToolCalls?: Map<string, VoicePendingToolCallState>;
    openAiCompletedToolCallIds?: Map<string, number>;
    openAiPendingToolAbortControllers?: Map<string, AbortController>;
    toolMusicTrackCatalog?: Map<string, unknown>;
    memoryWriteWindow?: number[];
    toolCallEvents?: VoiceToolCallEvent[];
    musicQueueState?: Record<string, unknown> | null;
    lastOpenAiToolCallerUserId?: string | null;
    awaitingToolOutputs?: boolean;
    voiceCommandState?: {
        userId: string | null;
        domain: string | null;
        intent: string | null;
        startedAt: number;
        expiresAt: number;
    } | null;
    [key: string]: unknown;
};

export type MusicSelectionResult = {
    id: string;
    title: string;
    artist: string;
    platform: "youtube" | "soundcloud" | "discord" | "auto";
    externalUrl: string | null;
    durationSeconds: number | null;
};

export type MusicDisambiguationPayload = {
    session?: Record<string, unknown> | null;
    query?: string;
    platform?: string;
    action?: "play_now" | "queue_next" | "queue_add";
    results?: Array<Record<string, unknown>>;
    requestedByUserId?: string | null;
};

export type MusicTextCommandMessage = {
    guild?: { id?: string | null } | null;
    guildId?: string | null;
    channel?: unknown;
    channelId?: string | null;
    author?: { id?: string | null } | null;
    id?: string | null;
    content?: string | null;
};

export type MusicTextRequestPayload = {
    message?: MusicTextCommandMessage | null;
    settings?: Record<string, unknown> | null;
};

export interface StreamWatchBrainContextEntry {
    text: string;
    at: number;
    provider: string | null;
    model: string | null;
    speakerName: string | null;
}

export type VoiceSessionDurableContextCategory = "fact" | "plan" | "preference" | "relationship";

export interface VoiceSessionDurableContextEntry {
    text: string;
    category: VoiceSessionDurableContextCategory;
    at: number;
}

export interface SoundboardCandidate {
    soundId: string;
    sourceGuildId: string | null;
    reference: string;
    name: string | null;
    origin: "preferred" | "guild_catalog";
}

export interface VoicePendingResponseLatencyContext {
    finalizedAtMs: number;
    asrStartedAtMs: number;
    asrCompletedAtMs: number;
    generationStartedAtMs: number;
    replyRequestedAtMs: number;
    audioStartedAtMs: number;
    source: string;
    captureReason: string | null;
    queueWaitMs: number | null;
    pendingQueueDepth: number | null;
}

export interface VoicePendingResponse {
    requestId: number;
    userId: string | null;
    requestedAt: number;
    retryCount: number;
    hardRecoveryAttempted: boolean;
    source: string;
    handlingSilence: boolean;
    audioReceivedAt: number;
    interruptionPolicy: ReplyInterruptionPolicy | null;
    utteranceText: string | null;
    latencyContext: VoicePendingResponseLatencyContext | null;
}

export interface VoiceLastRequestedRealtimeUtterance {
    utteranceText: string | null;
    requestedAt: number;
    source: string;
    interruptionPolicy: ReplyInterruptionPolicy | null;
}

export interface VoiceMusicQueueTrack {
    id: string;
    title: string;
    artist: string | null;
    durationMs: number | null;
    source: "yt" | "sc";
    streamUrl: string | null;
    platform: "youtube" | "soundcloud" | "discord" | "auto";
    externalUrl: string | null;
}

export interface VoiceMusicQueueState {
    guildId: string;
    voiceChannelId: string;
    tracks: VoiceMusicQueueTrack[];
    nowPlayingIndex: number | null;
    isPaused: boolean;
    volume: number;
    [key: string]: unknown;
}

export interface VoiceLatencyStageEntry {
    at: number;
    stage: string;
    source: string;
    finalizedToAsrStartMs: number | null;
    asrToGenerationStartMs: number | null;
    generationToReplyRequestMs: number | null;
    replyRequestToAudioStartMs: number | null;
    totalMs: number;
    queueWaitMs: number | null;
    pendingQueueDepth: number | null;
}

export interface VoiceMembershipEvent {
    userId: string;
    displayName: string;
    eventType: "join" | "leave";
    at: number;
}

export interface VoiceMembershipPromptEntry extends VoiceMembershipEvent {
    ageMs: number;
}

export interface VoiceChannelEffectEvent {
    userId: string;
    displayName: string;
    channelId: string;
    guildId: string;
    effectType: "soundboard" | "emoji" | "unknown";
    soundId: string | null;
    soundName: string | null;
    soundVolume: number | null;
    emoji: string | null;
    animationType: number | null;
    animationId: number | null;
    at: number;
}

export interface VoiceChannelEffectPromptEntry extends VoiceChannelEffectEvent {
    ageMs: number;
    summary: string;
}

export interface VoiceSessionTimingContext {
    timeoutWarningActive: boolean;
    timeoutWarningReason: "none" | "max_duration" | "inactivity";
    maxSecondsRemaining: number | null;
    inactivitySecondsRemaining: number | null;
}

export interface VoiceGenerationContextMessage {
    role: "assistant" | "user";
    content: string;
}

export interface VoiceGenerationMemoryFacts {
    userFacts: unknown[];
    relevantFacts: unknown[];
}

export interface VoiceModelContextSummary {
    capturedAt?: string;
    source?: string;
    availableTurns?: number;
    sentTurns?: number;
    maxTurns?: number;
    contextChars?: number;
    transcriptChars?: number;
    directAddressed?: boolean;
    [key: string]: unknown;
}

export interface VoiceGenerationContextSnapshot {
    capturedAt: string;
    incomingTranscript: string;
    speakerName: string | null;
    directAddressed: boolean;
    isEagerTurn: boolean;
    contextMessages: VoiceGenerationContextMessage[];
    conversationContext: VoiceConversationContext | null;
    userFacts?: unknown[];
    relevantFacts?: unknown[];
    participantRoster?: string[];
    membershipEvents?: VoiceMembershipPromptEntry[];
    effectEvents?: VoiceChannelEffectPromptEntry[];
    memoryFacts?: VoiceGenerationMemoryFacts;
    recentConversationHistory?: unknown[];
    recentWebLookups?: unknown[];
    sessionTiming?: VoiceSessionTimingContext | null;
    tools?: Record<string, boolean>;
    soundboardCandidateCount?: number;
    llmConfig?: {
        provider?: string;
        model?: string;
        temperature?: number | null;
        maxOutputTokens?: number | null;
        [key: string]: unknown;
    };
    source?: string;
    mode?: string;
    [key: string]: unknown;
}

/**
 * Explicit music playback state machine.
 *
 * Every piece of code that needs to know about music state should derive
 * its answer from this single enum via the `musicPhase*` query helpers
 * rather than checking scattered booleans.
 */
export type MusicPlaybackPhase =
    | "idle"              // no music context — nothing loaded, nothing paused
    | "loading"           // track URL is being resolved / subprocess is buffering
    | "playing"           // audio is actively being sent to Discord
    | "paused"            // user-initiated pause — bot can converse, music can resume
    | "paused_wake_word"  // auto-paused because user addressed the bot by wake word
    | "stopping";         // stop requested, waiting for subprocess acknowledgement

/** Why music was paused — only meaningful when phase is "paused" or "paused_wake_word". */
export type MusicPauseReason = "user_pause" | "wake_word" | "slash_command" | "tool_call" | null;

// ── Derived query helpers ────────────────────────────────────────────
// These are the ONLY way consuming code should ask questions about music
// state. They replace the old isMusicPlaybackActive / isMusicPlaybackAudible
// scattered boolean checks.

/** Music is conceptually "present" — a track is loaded, playing, or paused. */
export function musicPhaseIsActive(phase: MusicPlaybackPhase): boolean {
    return phase === "loading" || phase === "playing" || phase === "paused" || phase === "paused_wake_word";
}

/** Audio is physically being sent to Discord right now. */
export function musicPhaseIsAudible(phase: MusicPlaybackPhase): boolean {
    return phase === "playing";
}

/** The session output lock should be engaged (bot should not generate new replies). */
export function musicPhaseShouldLockOutput(phase: MusicPlaybackPhase): boolean {
    return phase === "playing" || phase === "loading";
}

/** Command-only mode should be active (only wake-word / direct address passes through). */
export function musicPhaseShouldForceCommandOnly(phase: MusicPlaybackPhase): boolean {
    return phase === "playing" || phase === "loading";
}

/** Music can be resumed from its current state. */
export function musicPhaseCanResume(phase: MusicPlaybackPhase): boolean {
    return phase === "paused" || phase === "paused_wake_word";
}

/** Music can be paused from its current state. */
export function musicPhaseCanPause(phase: MusicPlaybackPhase): boolean {
    return phase === "playing" || phase === "loading";
}

/** Ducking is relevant (music is audible and not paused). */
export function musicPhaseShouldAllowDucking(phase: MusicPlaybackPhase): boolean {
    return phase === "playing";
}

export interface VoiceSessionMusicState {
    /** Single source of truth for music playback lifecycle. */
    phase: MusicPlaybackPhase;
    /** @deprecated Use `phase` instead. Kept temporarily for backward compat during migration. */
    active: boolean;
    ducked: boolean;
    pauseReason: MusicPauseReason;
    startedAt: number;
    stoppedAt: number;
    provider: string | null;
    source: string | null;
    lastTrackId: string | null;
    lastTrackTitle: string | null;
    lastTrackArtists: string[];
    lastTrackUrl: string | null;
    lastQuery: string | null;
    lastRequestedByUserId: string | null;
    lastRequestText: string | null;
    lastCommandAt: number;
    lastCommandReason: string | null;
    pendingQuery: string | null;
    pendingPlatform: "auto" | "youtube" | "soundcloud" | "discord";
    pendingAction: "play_now" | "queue_next" | "queue_add";
    pendingResults: MusicSelectionResult[];
    pendingRequestedByUserId: string | null;
    pendingRequestedAt: number;
}

export type DeferredVoiceActionType = "interrupted_reply" | "queued_user_turns";

export type DeferredVoiceActionStatus = "scheduled" | "deferred";

export type DeferredVoiceActionFreshnessPolicy =
    | "retry_exact"
    | "regenerate_from_goal"
    | "retry_then_regenerate";

export interface DeferredVoiceActionBase {
    type: DeferredVoiceActionType;
    goal: string;
    freshnessPolicy: DeferredVoiceActionFreshnessPolicy;
    status: DeferredVoiceActionStatus;
    createdAt: number;
    updatedAt: number;
    notBeforeAt: number;
    expiresAt: number;
    reason: string;
    revision: number;
}

export interface DeferredInterruptedReplyAction extends DeferredVoiceActionBase {
    type: "interrupted_reply";
    goal: "complete_interrupted_reply";
    freshnessPolicy: "retry_then_regenerate";
    payload: {
        utteranceText: string | null;
        interruptedByUserId: string | null;
        interruptedAt: number;
        source: string | null;
        interruptionPolicy: ReplyInterruptionPolicy | null;
    };
}

export interface DeferredQueuedUserTurn {
    userId: string | null;
    transcript: string;
    pcmBuffer: Buffer | null;
    captureReason: string;
    source: string;
    directAddressed: boolean;
    deferReason: string;
    flushDelayMs: number;
    queuedAt: number;
}

export interface DeferredQueuedUserTurnsAction extends DeferredVoiceActionBase {
    type: "queued_user_turns";
    goal: "respond_to_deferred_user_turns";
    freshnessPolicy: "regenerate_from_goal";
    payload: {
        turns: DeferredQueuedUserTurn[];
        nextFlushAt: number;
    };
}

export type DeferredVoiceAction =
    | DeferredInterruptedReplyAction
    | DeferredQueuedUserTurnsAction;

export interface VoiceCommandState {
    userId: string | null;
    domain: string | null;
    intent: string | null;
    startedAt: number;
    expiresAt: number;
}

export interface VoiceSessionStreamWatchState {
    active: boolean;
    targetUserId: string | null;
    requestedByUserId: string | null;
    lastFrameAt: number;
    lastCommentaryAt: number;
    lastCommentaryNote: string | null;
    lastMemoryRecapAt: number;
    lastMemoryRecapText: string | null;
    lastMemoryRecapDurableSaved: boolean;
    lastMemoryRecapReason: string | null;
    lastBrainContextAt: number;
    lastBrainContextProvider: string | null;
    lastBrainContextModel: string | null;
    brainContextEntries: StreamWatchBrainContextEntry[];
    durableScreenNotes: string[];
    ingestedFrameCount: number;
    acceptedFrameCountInWindow: number;
    frameWindowStartedAt: number;
    latestFrameMimeType: string | null;
    latestFrameDataBase64: string;
    latestFrameAt: number;
}

export interface VoiceSessionSoundboardState {
    playCount: number;
    lastPlayedAt: number;
    catalogCandidates: SoundboardCandidate[];
    catalogFetchedAt: number;
    lastDirectiveKey: string;
    lastDirectiveAt: number;
}

export interface CaptureState {
    userId: string;
    startedAt: number;
    promotedAt: number;
    promotionReason: string | null;
    asrUtteranceId: number;
    bytesSent: number;
    signalSampleCount: number;
    signalActiveSampleCount: number;
    signalPeakAbs: number;
    signalSumSquares: number;
    pcmChunks: Buffer[];
    sharedAsrBytesSent: number;
    lastActivityTouchAt: number;
    idleFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    maxFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    speakingEndFinalizeTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    finalize: ((reason?: string) => void) | null;
    abort: ((reason?: string) => void) | null;
    removeSubprocessListeners: (() => void) | null;
}

export interface VoiceTranscriptLogprob {
    token: string;
    logprob: number;
    bytes: number[] | null;
}

export interface RealtimeQueuedTurn {
    session: VoiceSession;
    userId: string;
    pcmBuffer: Buffer;
    captureReason: string;
    queuedAt: number;
    finalizedAt: number;
    transcriptOverride: string | null;
    clipDurationMsOverride: number | null;
    asrStartedAtMsOverride: number;
    asrCompletedAtMsOverride: number;
    transcriptionModelPrimaryOverride: string | null;
    transcriptionModelFallbackOverride: string | null;
    transcriptionPlanReasonOverride: string | null;
    usedFallbackModelForTranscriptOverride: boolean;
    transcriptLogprobsOverride: VoiceTranscriptLogprob[] | null;
    mergedTurnCount: number;
    droppedHeadBytes: number;
}

export interface SttPipelineQueuedTurn {
    session: VoiceSession;
    userId: string;
    pcmBuffer: Buffer;
    captureReason: string;
    queuedAt: number;
}

export interface TurnProcessorState {
    responseFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    pendingRealtimeInputBytes: number;
    pendingSttTurns: number;
    sttTurnDrainActive: boolean;
    pendingSttTurnsQueue: SttPipelineQueuedTurn[];
    realtimeTurnDrainActive: boolean;
    pendingRealtimeTurns: RealtimeQueuedTurn[];
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
}

export interface RealtimeInstructionMemorySlice {
    userFacts: unknown[];
    relevantFacts: unknown[];
    relevantMessages: unknown[];
    recentConversationHistory: unknown[];
    recentWebLookups: unknown[];
    adaptiveDirectives: unknown[];
}

export interface VoiceUserFactProfile {
    userFacts: MemoryFactRow[];
    loadedAt: number;
}

export interface VoiceGuildFactProfile {
    selfFacts: MemoryFactRow[];
    loreFacts: MemoryFactRow[];
    loadedAt: number;
}

export interface QueuedRealtimeTurnContextRefresh {
    settings: VoiceRealtimeToolSettings | null;
    userId: string | null;
    transcript: string;
    captureReason: string;
}

export interface RealtimeTurnContextRefreshState {
    inFlight: boolean;
    pending: QueuedRealtimeTurnContextRefresh | null;
}

export interface InstructionManagerState {
    baseVoiceInstructions: string;
    lastOpenAiRealtimeInstructions: string;
    lastOpenAiRealtimeInstructionsAt: number;
    realtimeInstructionRefreshTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    openAiTurnContextRefreshState: RealtimeTurnContextRefreshState | null;
}

export type OutputChannelDeferredBlockReason =
    | "session_inactive"
    | "active_captures"
    | "pending_response"
    | "active_response"
    | "awaiting_tool_outputs"
    | "tool_calls_running";

export interface OutputChannelState {
    phase: AssistantOutputPhase;
    locked: boolean;
    lockReason: AssistantOutputLockReason | null;
    musicActive: boolean;
    captureBlocking: boolean;
    bargeInSuppressed: boolean;
    turnBacklog: number;
    toolCallsRunning: boolean;
    botTurnOpen: boolean;
    bufferedBotSpeech: boolean;
    pendingResponse: boolean;
    openAiActiveResponse: boolean;
    awaitingToolOutputs: boolean;
    streamBufferedBytes: number;
    deferredBlockReason: OutputChannelDeferredBlockReason | null;
}

export interface VoiceSession {
    id: string;
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
    requestedByUserId: string;
    mode: string;
    realtimeProvider: string;
    realtimeInputSampleRateHz: number;
    realtimeOutputSampleRateHz: number;
    recentVoiceTurns: VoiceTimelineTurn[];
    transcriptTurns: VoiceTimelineTurn[];
    durableContext?: VoiceSessionDurableContextEntry[];
    modelContextSummary: {
        generation: VoiceModelContextSummary | null;
        decider: VoiceModelContextSummary | null;
    };
    voxClient: ClankvoxClient | null;
    realtimeClient: OpenAiRealtimeClient | GeminiRealtimeClient | XaiRealtimeClient | ElevenLabsRealtimeClient | null;
    startedAt: number;
    lastActivityAt: number;
    maxEndsAt: number | null;
    inactivityEndsAt: number | null;
    maxTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    inactivityTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    botTurnResetTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    /** Short echo/barge-in guard after assistant speech begins. Not the authoritative output phase. */
    botTurnOpen: boolean;
    bargeInSuppressionUntil: number;
    bargeInSuppressedAudioChunks: number;
    bargeInSuppressedAudioBytes: number;
    lastBotActivityTouchAt: number;
    responseFlushTimer: TurnProcessorState["responseFlushTimer"];
    responseWatchdogTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    responseDoneGraceTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    botDisconnectTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    lastResponseRequestAt: number;
    /** Timestamp of the most recent live assistant audio delta. Useful for latency/engagement heuristics only. */
    lastAudioDeltaAt: number;
    lastAssistantReplyAt: number;
    lastDirectAddressAt: number;
    lastDirectAddressUserId: string | null;
    musicWakeLatchedUntil: number;
    musicWakeLatchedByUserId: string | null;
    lastInboundAudioAt: number;
    realtimeReplySupersededCount: number;
    pendingRealtimeInputBytes: TurnProcessorState["pendingRealtimeInputBytes"];
    nextResponseRequestId: number;
    pendingResponse: VoicePendingResponse | null;
    activeReplyInterruptionPolicy: ReplyInterruptionPolicy | null;
    lastRequestedRealtimeUtterance: VoiceLastRequestedRealtimeUtterance | null;
    pendingSttTurns: TurnProcessorState["pendingSttTurns"];
    sttTurnDrainActive: TurnProcessorState["sttTurnDrainActive"];
    pendingSttTurnsQueue: TurnProcessorState["pendingSttTurnsQueue"];
    realtimeTurnDrainActive: TurnProcessorState["realtimeTurnDrainActive"];
    pendingRealtimeTurns: TurnProcessorState["pendingRealtimeTurns"];
    openAiAsrSessions: Map<string, AsrBridgeState>;
    perUserAsrEnabled: boolean;
    sharedAsrEnabled: boolean;
    openAiSharedAsrState: AsrBridgeState | null;
    openAiPerUserAsrModel: string;
    openAiPerUserAsrLanguage: string;
    openAiPerUserAsrPrompt: string;
    openAiPendingToolCalls: Map<string, VoicePendingToolCallState>;
    openAiToolCallExecutions: Map<string, VoiceToolExecutionState>;
    openAiToolResponseDebounceTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    openAiCompletedToolCallIds: Map<string, number>;
    openAiPendingToolAbortControllers?: Map<string, AbortController>;
    lastOpenAiAssistantAudioItemId: string | null;
    lastOpenAiAssistantAudioItemContentIndex: number;
    lastOpenAiAssistantAudioItemReceivedMs: number;
    openAiToolDefinitions: VoiceRealtimeToolDescriptor[];
    lastOpenAiRealtimeToolHash: string;
    lastOpenAiRealtimeToolRefreshAt: number;
    lastOpenAiToolCallerUserId: string | null;
    awaitingToolOutputs: boolean;
    toolCallEvents: VoiceToolCallEvent[];
    mcpStatus: VoiceMcpServerStatus[];
    toolMusicTrackCatalog: Map<string, unknown>;
    memoryWriteWindow: number[];
    factProfiles: Map<string, VoiceUserFactProfile>;
    guildFactProfile: VoiceGuildFactProfile | null;
    voiceCommandState: VoiceCommandState | null;
    musicQueueState: VoiceMusicQueueState;
    assistantOutput: AssistantOutputState;
    thoughtLoopTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    thoughtLoopBusy: boolean;
    nextThoughtAt: number;
    lastThoughtAttemptAt: number;
    lastThoughtSpokenAt: number;
    userCaptures: Map<string, CaptureState>;
    streamWatch: VoiceSessionStreamWatchState;
    music: VoiceSessionMusicState;
    soundboard: VoiceSessionSoundboardState;
    latencyStages: VoiceLatencyStageEntry[];
    membershipEvents: VoiceMembershipEvent[];
    voiceChannelEffects?: VoiceChannelEffectEvent[];
    voiceLookupBusyCount: number;
    lastSuppressedCaptureLogAt: number;
    baseVoiceInstructions: InstructionManagerState["baseVoiceInstructions"];
    lastOpenAiRealtimeInstructions: InstructionManagerState["lastOpenAiRealtimeInstructions"];
    lastOpenAiRealtimeInstructionsAt: InstructionManagerState["lastOpenAiRealtimeInstructionsAt"];
    realtimeInstructionRefreshTimer: InstructionManagerState["realtimeInstructionRefreshTimer"];
    openAiTurnContextRefreshState: InstructionManagerState["openAiTurnContextRefreshState"];
    settingsSnapshot: VoiceRealtimeToolSettings | null;
    cleanupHandlers: Array<() => void>;
    ending: boolean;
    /** Subprocess readiness/bootstrap hint. Not part of the assistant output state machine. */
    playbackArmed?: boolean;
    playbackArmedReason?: string | null;
    playbackArmedAt?: number;
    playerState?: string | null;
    botTurnOpenAt?: number;
    deferredVoiceActions?: Partial<Record<DeferredVoiceActionType, DeferredVoiceAction>>;
    deferredVoiceActionTimers?: Partial<Record<DeferredVoiceActionType, ReturnType<typeof setTimeout> | NodeJS.Timeout | null>>;
    lastGenerationContext?: VoiceGenerationContextSnapshot | null;
    openAiAsrSessionIdleTtlMs?: number;
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    voiceLookupBusyAnnounceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    [key: string]: unknown;
}
