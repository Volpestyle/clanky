import type { ClankvoxClient } from "./clankvoxClient.ts";
import type { OpenAiRealtimeClient } from "./openaiRealtimeClient.ts";
import type { GeminiRealtimeClient } from "./geminiRealtimeClient.ts";
import type { XaiRealtimeClient } from "./xaiRealtimeClient.ts";
import type { ElevenLabsRealtimeClient } from "./elevenLabsRealtimeClient.ts";

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
    addressedToOtherSignal?: boolean;
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
                type: "function";
                name: string;
                description: string;
                parameters: Record<string, unknown>;
            }>;
            toolChoice?: "auto" | "none" | "required" | { type: "function"; name: string };
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
    openAiToolCallExecutions?: Map<string, Promise<void>>;
    openAiPendingToolCalls?: Map<string, unknown>;
    openAiCompletedToolCallIds?: Map<string, number>;
    toolMusicTrackCatalog?: Map<string, unknown>;
    memoryWriteWindow?: number[];
    toolCallEvents?: VoiceToolCallEvent[];
    musicQueueState?: Record<string, unknown>;
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
    provider: any;
    source: any;
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
    pendingResults: any[];
    pendingRequestedByUserId: string | null;
    pendingRequestedAt: number;
}

export type DeferredVoiceActionType = "join_greeting" | "interrupted_reply" | "queued_user_turns";

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

export interface DeferredJoinGreetingAction extends DeferredVoiceActionBase {
    type: "join_greeting";
    goal: "announce_join";
    freshnessPolicy: "regenerate_from_goal";
    payload: {
        trigger: string | null;
    };
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
        interruptionPolicy: any;
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
    | DeferredJoinGreetingAction
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
    brainContextEntries: any[];
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
    catalogCandidates: any[];
    catalogFetchedAt: number;
    lastDirectiveKey: string;
    lastDirectiveAt: number;
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
    recentVoiceTurns: any[];
    transcriptTurns: VoiceTimelineTurn[];
    modelContextSummary: {
        generation: any;
        decider: any;
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
    botTurnOpen: boolean;
    bargeInSuppressionUntil: number;
    bargeInSuppressedAudioChunks: number;
    bargeInSuppressedAudioBytes: number;
    lastBotActivityTouchAt: number;
    responseFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    responseWatchdogTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    responseDoneGraceTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    botDisconnectTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    lastResponseRequestAt: number;
    lastAudioDeltaAt: number;
    lastAssistantReplyAt: number;
    lastDirectAddressAt: number;
    lastDirectAddressUserId: string | null;
    musicWakeLatchedUntil: number;
    musicWakeLatchedByUserId: string | null;
    lastInboundAudioAt: number;
    realtimeReplySupersededCount: number;
    pendingRealtimeInputBytes: number;
    nextResponseRequestId: number;
    pendingResponse: any;
    activeReplyInterruptionPolicy: any;
    lastRequestedRealtimeUtterance: any;
    pendingSttTurns: number;
    sttTurnDrainActive: boolean;
    pendingSttTurnsQueue: any[];
    realtimeTurnDrainActive: boolean;
    pendingRealtimeTurns: any[];
    openAiAsrSessions: Map<string, any>;
    perUserAsrEnabled: boolean;
    sharedAsrEnabled: boolean;
    openAiSharedAsrState: any;
    openAiPerUserAsrModel: string;
    openAiPerUserAsrLanguage: string;
    openAiPerUserAsrPrompt: string;
    openAiPendingToolCalls: Map<string, any>;
    openAiToolCallExecutions: Map<string, Promise<void>>;
    openAiToolResponseDebounceTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    openAiCompletedToolCallIds: Map<string, number>;
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
    toolMusicTrackCatalog: Map<string, any>;
    memoryWriteWindow: number[];
    voiceCommandState: VoiceCommandState | null;
    musicQueueState: {
        guildId: string;
        voiceChannelId: string;
        tracks: any[];
        nowPlayingIndex: number | null;
        isPaused: boolean;
        volume: number;
    };
    thoughtLoopTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    thoughtLoopBusy: boolean;
    nextThoughtAt: number;
    lastThoughtAttemptAt: number;
    lastThoughtSpokenAt: number;
    userCaptures: Map<string, any>;
    streamWatch: VoiceSessionStreamWatchState;
    music: VoiceSessionMusicState;
    soundboard: VoiceSessionSoundboardState;
    latencyStages: any[];
    membershipEvents: any[];
    voiceLookupBusyCount: number;
    lastSuppressedCaptureLogAt: number;
    baseVoiceInstructions: string;
    lastOpenAiRealtimeInstructions: string;
    lastOpenAiRealtimeInstructionsAt: number;
    realtimeInstructionRefreshTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    openAiTurnContextRefreshState: any;
    settingsSnapshot: VoiceRealtimeToolSettings | null;
    cleanupHandlers: Array<() => void>;
    ending: boolean;
    playbackArmed?: boolean;
    playbackArmedReason?: string | null;
    playbackArmedAt?: number;
    deferredVoiceActions?: Partial<Record<DeferredVoiceActionType, DeferredVoiceAction>>;
    deferredVoiceActionTimers?: Partial<Record<DeferredVoiceActionType, ReturnType<typeof setTimeout> | NodeJS.Timeout | null>>;
    lastGenerationContext?: any;
    openAiAsrSessionIdleTtlMs?: number;
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    voiceLookupBusyAnnounceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    [key: string]: any;
}
