import type { ClankvoxClient } from "./clankvoxClient.ts";
import type { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import type { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";
import type { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import type { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";
import type { StreamWatchVisualizerMode } from "../settings/voiceDashboardMappings.ts";
import type { ReplyInterruptionPolicy } from "./bargeInController.ts";
import type { AsrBridgeState, AsrCommitResult } from "./voiceAsrBridge.ts";
import type {
    AssistantOutputLockReason,
    AssistantOutputPhase,
    AssistantOutputState
} from "./assistantOutputState.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";
import type { LoggedPromptBundle } from "../promptLogging.ts";

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

export type VoicePendingAmbientThoughtStatus = "queued" | "reconsider";

export interface VoicePendingAmbientThought {
    id: string;
    status: VoicePendingAmbientThoughtStatus;
    trigger: string;
    draftText: string;
    currentText: string;
    createdAt: number;
    updatedAt: number;
    basisAt: number;
    notBeforeAt: number;
    expiresAt: number;
    revision: number;
    lastDecisionReason: string | null;
    lastDecisionAction: "hold" | "speak_now" | "drop" | null;
    memoryFactCount: number;
    usedMemory: boolean;
    invalidatedAt: number | null;
    invalidatedByUserId: string | null;
    invalidationReason?: string | null;
}

export type VoiceConversationContext = {
    attentionMode: "ACTIVE" | "AMBIENT";
    currentSpeakerActive: boolean;
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
    pendingCommandFollowupSignal?: boolean;
    musicActive?: boolean;
    musicWakeLatched?: boolean;
    msUntilMusicWakeLatchExpiry?: number | null;
    interruptedAssistantReply?: {
        utteranceText: string;
        interruptedByUserId: string | null;
        interruptedBySpeakerName: string | null;
        interruptedAt: number;
        ageMs: number | null;
        source: string | null;
    } | null;
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
    runtimeEventContext?: VoiceRuntimeEventContext | null;
    replyPrompts?: LoggedVoicePromptBundle | null;
};

export type LoggedVoicePromptBundle = LoggedPromptBundle;

export type VoiceLivePromptSlot = "classifier" | "generation" | "bridge";

export interface VoiceLivePromptSnapshotEntry {
    updatedAt: number;
    source: string | null;
    replyPrompts: LoggedVoicePromptBundle | null;
}

export interface VoiceLivePromptState {
    classifier: VoiceLivePromptSnapshotEntry | null;
    generation: VoiceLivePromptSnapshotEntry | null;
    bridge: VoiceLivePromptSnapshotEntry | null;
}

export type VoiceTimelineTurn = {
    kind?: "speech";
    role: "assistant" | "user";
    userId: string | null;
    speakerName: string;
    text: string;
    at: number;
    addressing?: VoiceAddressingAnnotation;
};

export type VoiceTimelineMembershipEntry = {
    kind: "membership";
    role: "user";
    userId: string | null;
    speakerName: string;
    text: string;
    at: number;
    eventType: "join" | "leave";
    addressing?: VoiceAddressingAnnotation;
};

export type VoiceTimelineEffectEntry = {
    kind: "effect";
    role: "user";
    userId: string | null;
    speakerName: string;
    text: string;
    at: number;
    effectType: "soundboard" | "emoji" | "unknown";
    summary: string;
    soundId: string | null;
    soundName: string | null;
    emoji: string | null;
    addressing?: VoiceAddressingAnnotation;
};

export type VoiceTranscriptTimelineEntry =
    | VoiceTimelineTurn
    | VoiceTimelineMembershipEntry
    | VoiceTimelineEffectEntry;

export type VoiceRealtimeToolDescriptor = {
    toolType: "function" | "mcp";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    serverName?: string | null;
    continuationPolicy?: "always" | "if_no_spoken_text" | "never";
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
    responseId?: string | null;
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

export type RealtimeToolOwnership = "transport_only" | "provider_native";

export type VoiceToolRuntimeSessionLike = {
    ending?: boolean;
    mode?: string;
    realtimeToolOwnership?: RealtimeToolOwnership | null;
    realtimeClient?: object | null;
    mcpStatus?: VoiceMcpServerStatus[];
    settingsSnapshot?: VoiceRealtimeToolSettings | null;
    realtimeToolDefinitions?: VoiceRealtimeToolDescriptor[];
    lastRealtimeToolHash?: string | null;
    lastRealtimeToolRefreshAt?: number | null;
    guildId?: string;
    textChannelId?: string;
    id?: string;
    realtimeToolResponseDebounceTimer?: ReturnType<typeof setTimeout> | null;
    realtimeToolCallExecutions?: Map<string, VoiceToolExecutionState>;
    realtimePendingToolCalls?: Map<string, VoicePendingToolCallState>;
    realtimeCompletedToolCallIds?: Map<string, number>;
    realtimePendingToolAbortControllers?: Map<string, AbortController>;
    realtimeResponsesWithAssistantOutput?: Map<string, number>;
    realtimeToolFollowupNeeded?: boolean;
    toolMusicTrackCatalog?: Map<string, unknown>;
    memoryWriteWindow?: number[];
    behavioralFactCache?: VoiceBehavioralFactCacheEntry | null;
    conversationHistoryCaches?: Partial<Record<VoiceConversationHistoryCacheStrategy, VoiceConversationHistoryCacheEntry | null>> | null;
    toolCallEvents?: VoiceToolCallEvent[];
    musicQueueState?: Record<string, unknown> | null;
    soundboard?: VoiceSessionSoundboardState | null;
    recentVoiceTurns?: Array<Record<string, unknown>>;
    lastRealtimeToolCallerUserId?: string | null;
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
    musicWakeRefreshAfterSpeech?: boolean;
}

export interface VoiceLastRequestedRealtimeUtterance {
    utteranceText: string | null;
    requestedAt: number;
    source: string;
    interruptionPolicy: ReplyInterruptionPolicy | null;
}

export interface VoiceInterruptedAssistantReply {
    utteranceText: string;
    interruptedByUserId: string | null;
    interruptedAt: number;
    source: string | null;
    interruptionPolicy?: ReplyInterruptionPolicy | null;
}

export interface VoiceQueuedRealtimeAssistantUtterance {
    prompt: string;
    utteranceText: string | null;
    userId: string | null;
    source: string;
    queuedAt: number;
    interruptionPolicy: ReplyInterruptionPolicy | null;
    latencyContext: VoicePendingResponseLatencyContext | null;
    musicWakeRefreshAfterSpeech?: boolean;
}

interface VoiceMusicQueueTrack {
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

export type VoiceRuntimeEventCategory = "membership" | "screen_share" | "generic";
export type VoiceRuntimeEventActorRole = "self" | "other" | "unknown";
export type VoiceRuntimeScreenShareEventType = "share_start" | "scene_changed" | "silence";

export interface VoiceRuntimeEventContext {
    category: VoiceRuntimeEventCategory;
    eventType: VoiceMembershipEvent["eventType"] | VoiceRuntimeScreenShareEventType | string;
    actorUserId: string | null;
    actorDisplayName: string | null;
    actorRole: VoiceRuntimeEventActorRole;
    hasVisibleFrame?: boolean;
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
    runtimeEventContext?: VoiceRuntimeEventContext | null;
    userFacts?: unknown[];
    relevantFacts?: unknown[];
    participantRoster?: string[];
    membershipEvents?: VoiceMembershipPromptEntry[];
    effectEvents?: VoiceChannelEffectPromptEntry[];
    memoryFacts?: VoiceGenerationMemoryFacts;
    recentConversationHistory?: unknown[];
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
    | "paused_wake_word"  // auto-paused because the bot owns the floor inside a wake-word music handoff
    | "stopping";         // stop requested, waiting for subprocess acknowledgement

/** Why music was paused — only meaningful when phase is "paused" or "paused_wake_word". */
export type MusicPauseReason = "user_pause" | "wake_word" | "slash_command" | "tool_call" | null;
export type MusicReplyHandoffMode = "duck" | "pause";

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
    ducked: boolean;
    pauseReason: MusicPauseReason;
    replyHandoffMode?: MusicReplyHandoffMode | null;
    replyHandoffRequestedByUserId?: string | null;
    replyHandoffSource?: string | null;
    replyHandoffAt?: number;
    startedAt: number;
    stoppedAt: number;
    provider: string | null;
    source: string | null;
    lastTrackId: string | null;
    lastTrackTitle: string | null;
    lastTrackArtists: string[];
    lastTrackUrl: string | null;
    lastPlaybackUrl?: string | null;
    lastPlaybackResolvedDirectUrl?: boolean;
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

export type InFlightBrainTurnPhase = "generation_only" | "tool_call_started" | "playback_requested";

export interface InFlightAcceptedBrainTurn {
    transcript: string;
    userId: string | null;
    pcmBuffer: Buffer | null;
    source: string;
    acceptedAt: number;
    phase: InFlightBrainTurnPhase;
    captureReason: string;
    directAddressed: boolean;
    interruptionPolicy?: ReplyInterruptionPolicy | null;
    toolPhaseRecoveryEligible?: boolean;
    toolPhaseRecoveryReason?: string | null;
    toolPhaseLastToolName?: string | null;
}

export interface SupersededPrePlaybackReply {
    userId: string | null;
    transcript: string;
    pcmBuffer: Buffer | null;
    source: string;
    captureReason: string;
    directAddressed: boolean;
    queuedAt: number;
    interruptionPolicy: ReplyInterruptionPolicy | null;
    supersededAt: number;
    supersededByUserId: string | null;
    supersededBySource: string;
}

export interface HeldPrePlaybackReply {
    userId: string | null;
    startedAt: number;
    source: string;
}

export type DeferredVoiceActionType = "queued_user_turns";

type DeferredVoiceActionStatus = "scheduled" | "deferred";

type DeferredVoiceActionFreshnessPolicy =
    | "retry_exact"
    | "regenerate_from_goal"
    | "retry_then_regenerate";

interface DeferredVoiceActionBase {
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

export type DeferredVoiceAction = DeferredQueuedUserTurnsAction;

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

export interface VoiceSessionNativeScreenShareStreamState {
    ssrc: number;
    rtxSsrc: number | null;
    rid: string | null;
    quality: number | null;
    streamType: string | null;
    active: boolean | null;
    maxBitrate: number | null;
    maxFramerate: number | null;
    width: number | null;
    height: number | null;
    resolutionType: string | null;
    pixelCount: number | null;
}

export interface VoiceSessionNativeScreenShareSharerState {
    userId: string;
    audioSsrc: number | null;
    videoSsrc: number | null;
    codec: string | null;
    streams: VoiceSessionNativeScreenShareStreamState[];
    updatedAt: number;
    lastFrameAt: number;
    lastFrameCodec: string | null;
    lastFrameKeyframeAt: number;
}

export interface VoiceSessionNativeScreenShareState {
    sharers: Map<string, VoiceSessionNativeScreenShareSharerState>;
    subscribedTargetUserId: string | null;
    decodeInFlight: boolean;
    lastDecodeAttemptAt: number;
    lastDecodeSuccessAt: number;
    lastDecodeFailureAt: number;
    lastDecodeFailureReason: string | null;
    ffmpegAvailable: boolean | null;
    activeStreamKey: string | null;
    lastRtcServerId: string | null;
    lastStreamEndpoint: string | null;
    lastCredentialsReceivedAt: number;
    lastVoiceSessionId: string | null;
    transportStatus: string | null;
    transportReason: string | null;
    transportUpdatedAt: number;
    transportConnectedAt: number;
}

export interface VoiceSessionGoLiveStreamState {
    /** Whether a Go Live stream is available with full credentials. */
    active: boolean;
    /** Stream key (e.g. "guild:123:456:789"). */
    streamKey: string | null;
    /** User who is streaming via Go Live. */
    targetUserId: string | null;
    /** Guild the stream belongs to. */
    guildId: string | null;
    /** Channel the stream is in. */
    channelId: string | null;
    /** RTC server ID from STREAM_CREATE. */
    rtcServerId: string | null;
    /** Stream media endpoint from STREAM_SERVER_UPDATE. */
    endpoint: string | null;
    /** Stream auth token from STREAM_SERVER_UPDATE. */
    token: string | null;
    /** When the Go Live stream was discovered. */
    discoveredAt: number;
    /** When stream credentials were received. */
    credentialsReceivedAt: number;
}

export interface VoiceSessionStreamPublishState {
    active: boolean;
    paused: boolean;
    streamKey: string | null;
    guildId: string | null;
    channelId: string | null;
    rtcServerId: string | null;
    endpoint: string | null;
    token: string | null;
    sourceKind: "music" | "browser_session" | null;
    visualizerMode: StreamWatchVisualizerMode | null;
    sourceKey: string | null;
    sourceUrl: string | null;
    sourceLabel: string | null;
    discoveredAt: number;
    credentialsReceivedAt: number;
    requestedAt: number;
    startedAt: number;
    pausedAt: number;
    stoppedAt: number;
    lastVoiceSessionId: string | null;
    transportStatus: string | null;
    transportReason: string | null;
    transportUpdatedAt: number;
    transportConnectedAt: number;
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
    bargeInGateLoggedAt: number;
    musicWakeFollowupEligibleAtPromotion: boolean;
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

export type VoiceInterruptOverlapDecision = "pending" | "ignore" | "interrupt";

export interface VoiceInterruptOverlapBurstEntry {
    userId: string | null;
    speakerName: string;
    transcript: string;
    utteranceId: number;
    isFinal: boolean;
    receivedAt: number;
    eventType: string | null;
    itemId: string | null;
    previousItemId: string | null;
}

export interface VoiceInterruptOverlapBurstState {
    id: number;
    openedAt: number;
    lastTranscriptAt: number;
    assistantUtteranceText: string;
    assistantRequestId: number | null;
    assistantItemId: string | null;
    quietTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    maxTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    evaluating: boolean;
    entries: VoiceInterruptOverlapBurstEntry[];
    utteranceIds: number[];
}

export interface VoiceInterruptOverlapUtteranceState {
    transcript: string;
    decision: VoiceInterruptOverlapDecision;
    decidedAt: number;
    source: string;
    burstId: number;
}

export interface VoicePendingSpeechStartedInterrupt {
    userId: string | null;
    speakerName: string;
    utteranceId: number;
    startedAt: number;
    audioStartMs: number | null;
    itemId: string | null;
    eventType: string | null;
    timer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
}

export interface VoicePendingInterruptBridgeTurn {
    userId: string;
    pcmBuffer: Buffer;
    captureReason: string;
    finalizedAt: number;
    musicWakeFollowupEligibleAtCapture: boolean;
    bridgeUtteranceId: number | null;
    asrResult: AsrCommitResult | null;
    source: string;
}

export interface RealtimeQueuedTurn {
    session: VoiceSession;
    userId: string;
    pcmBuffer: Buffer;
    captureReason: string;
    queuedAt: number;
    finalizedAt: number;
    replyScopeStartedAt: number;
    transcriptOverride: string | null;
    clipDurationMsOverride: number | null;
    asrStartedAtMsOverride: number;
    asrCompletedAtMsOverride: number;
    transcriptionModelPrimaryOverride: string | null;
    transcriptionModelFallbackOverride: string | null;
    transcriptionPlanReasonOverride: string | null;
    usedFallbackModelForTranscriptOverride: boolean;
    transcriptLogprobsOverride: VoiceTranscriptLogprob[] | null;
    bridgeUtteranceId: number | null;
    bridgeRevision: number;
    musicWakeFollowupEligibleAtCapture: boolean;
    mergedTurnCount: number;
    droppedHeadBytes: number;
}

export interface FileAsrQueuedTurn {
    session: VoiceSession;
    userId: string;
    pcmBuffer: Buffer;
    captureReason: string;
    queuedAt: number;
}

export interface TurnProcessorState {
    responseFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    pendingRealtimeInputBytes: number;
    pendingFileAsrTurns: number;
    fileAsrTurnDrainActive: boolean;
    pendingFileAsrTurnsQueue: FileAsrQueuedTurn[];
    realtimeTurnDrainActive: boolean;
    pendingRealtimeTurns: RealtimeQueuedTurn[];
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
}

export interface RealtimeInstructionMemorySlice {
    participantProfiles: unknown[];
    selfFacts: unknown[];
    loreFacts: unknown[];
    userFacts: unknown[];
    relevantFacts: unknown[];
    guidanceFacts: unknown[];
    behavioralFacts: unknown[];
    recentConversationHistory: unknown[];
}

export interface VoiceUserFactProfile {
    userFacts: MemoryFactRow[];
    guidanceFacts: MemoryFactRow[];
    loadedAt: number;
}

export interface VoiceGuildFactProfile {
    selfFacts: MemoryFactRow[];
    loreFacts: MemoryFactRow[];
    guidanceFacts: MemoryFactRow[];
    loadedAt: number;
}

export interface VoiceBehavioralFactCacheEntry {
    guildId: string;
    participantKey: string;
    loadedAt: number;
    facts: MemoryFactRow[];
}

export type VoiceConversationHistoryCacheStrategy = "lexical" | "semantic";

export interface VoiceConversationHistoryCacheEntry {
    strategy: VoiceConversationHistoryCacheStrategy;
    guildId: string;
    channelId: string | null;
    queryText: string;
    queryTokens: string[];
    limit: number;
    maxAgeHours: number;
    loadedAt: number;
    windows: unknown[];
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
    lastRealtimeInstructions: string;
    lastRealtimeInstructionsAt: number;
    realtimeInstructionRefreshTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    realtimeTurnContextRefreshState: RealtimeTurnContextRefreshState | null;
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
    realtimeToolOwnership: RealtimeToolOwnership;
    realtimeInputSampleRateHz: number;
    realtimeOutputSampleRateHz: number;
    recentVoiceTurns: VoiceTimelineTurn[];
    transcriptTurns: VoiceTranscriptTimelineEntry[];
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
    interruptedAssistantReply?: VoiceInterruptedAssistantReply | null;
    pendingRealtimeAssistantUtterances?: VoiceQueuedRealtimeAssistantUtterance[];
    realtimeAssistantUtteranceBackpressureActive?: boolean;
    lastRealtimeAssistantUtteranceDrainBlockSignature?: string | null;
    pendingFileAsrTurns: TurnProcessorState["pendingFileAsrTurns"];
    fileAsrTurnDrainActive: TurnProcessorState["fileAsrTurnDrainActive"];
    pendingFileAsrTurnsQueue: TurnProcessorState["pendingFileAsrTurnsQueue"];
    realtimeTurnDrainActive: TurnProcessorState["realtimeTurnDrainActive"];
    pendingRealtimeTurns: TurnProcessorState["pendingRealtimeTurns"];
    activeRealtimeTurn?: RealtimeQueuedTurn | null;
    interruptOverlapBurst?: VoiceInterruptOverlapBurstState | null;
    interruptDecisionsByUtteranceId?: Map<number, VoiceInterruptOverlapUtteranceState>;
    pendingSpeechStartedInterrupts?: Map<number, VoicePendingSpeechStartedInterrupt>;
    pendingInterruptBridgeTurns?: Map<number, VoicePendingInterruptBridgeTurn>;
    nextInterruptBurstId?: number;
    openAiAsrSessions: Map<string, AsrBridgeState>;
    perUserAsrEnabled: boolean;
    sharedAsrEnabled: boolean;
    openAiSharedAsrState: AsrBridgeState | null;
    openAiPerUserAsrModel: string;
    openAiPerUserAsrLanguage: string;
    openAiPerUserAsrPrompt: string;
    realtimePendingToolCalls?: Map<string, VoicePendingToolCallState>;
    realtimeToolCallExecutions?: Map<string, VoiceToolExecutionState>;
    realtimeToolResponseDebounceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    realtimeCompletedToolCallIds?: Map<string, number>;
    realtimePendingToolAbortControllers?: Map<string, AbortController>;
    realtimeResponsesWithAssistantOutput?: Map<string, number>;
    realtimeToolFollowupNeeded?: boolean;
    lastRealtimeAssistantAudioItemId: string | null;
    lastRealtimeAssistantAudioItemContentIndex: number;
    lastRealtimeAssistantAudioItemReceivedMs: number;
    ignoredRealtimeAssistantOutputItemIds?: Map<string, number>;
    realtimeToolDefinitions?: VoiceRealtimeToolDescriptor[];
    lastRealtimeToolHash?: string;
    lastRealtimeToolRefreshAt?: number;
    lastRealtimeToolCallerUserId: string | null;
    awaitingToolOutputs?: boolean;
    toolCallEvents: VoiceToolCallEvent[];
    mcpStatus: VoiceMcpServerStatus[];
    toolMusicTrackCatalog: Map<string, unknown>;
    memoryWriteWindow: number[];
    behavioralFactCache?: VoiceBehavioralFactCacheEntry | null;
    conversationHistoryCaches?: Partial<Record<VoiceConversationHistoryCacheStrategy, VoiceConversationHistoryCacheEntry | null>> | null;
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
    pendingAmbientThought?: VoicePendingAmbientThought | null;
    userCaptures: Map<string, CaptureState>;
    streamWatch: VoiceSessionStreamWatchState;
    nativeScreenShare: VoiceSessionNativeScreenShareState;
    goLiveStream: VoiceSessionGoLiveStreamState;
    streamPublish: VoiceSessionStreamPublishState;
    music: VoiceSessionMusicState;
    soundboard: VoiceSessionSoundboardState;
    latencyStages: VoiceLatencyStageEntry[];
    membershipEvents: VoiceMembershipEvent[];
    voiceChannelEffects?: VoiceChannelEffectEvent[];
    baseVoiceInstructions: InstructionManagerState["baseVoiceInstructions"];
    lastRealtimeInstructions: InstructionManagerState["lastRealtimeInstructions"];
    lastRealtimeInstructionsAt: InstructionManagerState["lastRealtimeInstructionsAt"];
    realtimeInstructionRefreshTimer: InstructionManagerState["realtimeInstructionRefreshTimer"];
    realtimeTurnContextRefreshState: InstructionManagerState["realtimeTurnContextRefreshState"];
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
    livePromptState?: VoiceLivePromptState | null;
    inFlightAcceptedBrainTurn?: InFlightAcceptedBrainTurn | null;
    heldPrePlaybackReply?: HeldPrePlaybackReply | null;
    supersededPrePlaybackReply?: SupersededPrePlaybackReply | null;
    openAiAsrSessionIdleTtlMs?: number;
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    [key: string]: unknown;
}
