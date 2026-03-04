import type { VoiceSubprocessClient } from "./voiceSubprocessClient.ts";
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
        realtimeReplyStrategy?: string;
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

export interface VoiceSessionMusicState {
    active: boolean;
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
    subprocessClient: VoiceSubprocessClient | null;
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
    lastInboundAudioAt: number;
    realtimeReplySupersededCount: number;
    pendingRealtimeInputBytes: number;
    nextResponseRequestId: number;
    pendingResponse: any;
    activeReplyInterruptionPolicy: any;
    pendingBargeInRetry: any;
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
    pendingDeferredTurns: any[];
    deferredTurnFlushTimer: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
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
    joinGreetingPending?: boolean;
    lastGenerationContext?: any;
    openAiAsrSessionIdleTtlMs?: number;
    realtimeTurnCoalesceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    voiceLookupBusyAnnounceTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
    [key: string]: any;
}
