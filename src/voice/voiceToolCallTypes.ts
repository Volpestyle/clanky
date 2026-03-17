import type { VoiceSessionManager } from "./voiceSessionManager.ts";
import type { VoiceRealtimeToolSettings } from "./voiceSessionTypes.ts";
import type { CodeAgentRole } from "../agents/codeAgent.ts";

export type VoiceToolCallManager = Pick<
  VoiceSessionManager,
  | "appConfig"
  | "activeReplies"
  | "abortActiveInboundCaptures"
  | "bargeInController"
  | "beginVoiceCommandSession"
  | "browserManager"
  | "buildVoiceQueueStatePayload"
  | "client"
  | "composeOperationalMessage"
  | "clearVoiceCommandSession"
  | "deferredActionQueue"
  | "endSession"
  | "ensureSessionMusicState"
  | "ensureToolMusicQueueState"
  | "getVoiceScreenWatchCapability"
  | "hasRealtimeAssistantOutputForResponse"
  | "hasBotNameCueForTranscript"
  | "haltSessionOutputForMusicPlayback"
  | "isMusicDisambiguationResolutionTurn"
  | "isMusicPlaybackActive"
  | "instructionManager"
  | "llm"
  | "memory"
  | "maybeClearActiveReplyInterruptionPolicy"
  | "maybeHandlePendingMusicDisambiguationTurn"
  | "musicPlayback"
  | "musicPlayer"
  | "musicSearch"
  | "normalizeMusicSelectionResult"
  | "startVoiceScreenWatch"
  | "playVoiceQueueTrackByIndex"
  | "requestPauseMusic"
  | "requestPlayMusic"
  | "requestRealtimePromptUtterance"
  | "requestStopMusic"
  | "refreshSessionGuildFactProfile"
  | "refreshSessionUserFactProfile"
  | "replyManager"
  | "resolveVoiceSpeakerName"
  | "scheduleRealtimeToolFollowupResponse"
  | "search"
  | "sessions"
  | "setMusicPhase"
  | "startVisualizerStreamPublish"
  | "soundboardDirector"
  | "store"
  | "transcribePcmTurn"
  | "updateVoiceMcpStatus"
  | "waitForLeaveDirectivePlayback"
> & {
  createBrowserAgentSession?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => SubAgentInteractiveSession | null | undefined) | null;
  createCodeAgentSession?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    role?: CodeAgentRole;
    cwd?: string;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => SubAgentInteractiveSession | null | undefined) | null;
  runModelRequestedCodeTask?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    task: string;
    role?: CodeAgentRole;
    cwd?: string;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
    signal?: AbortSignal;
  }) => Promise<{
    text?: string;
    costUsd?: number;
    error?: unknown;
    blockedByPermission?: boolean;
    blockedByBudget?: boolean;
    blockedByParallelLimit?: boolean;
  }>) | null;
  subAgentSessions?: SubAgentSessionRegistry | null;
};

export type VoiceToolCallArgs = Record<string, unknown>;

export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  toolType: "function" | "mcp";
  serverName: string | null;
  continuationPolicy?: "always" | "fire_and_forget";
};

interface SubAgentTurnResult {
  isError?: boolean;
  errorMessage?: string | null;
  text: string;
  costUsd?: number | null;
  sessionCompleted?: boolean;
}

export interface SubAgentInteractiveSession {
  id: string;
  ownerUserId?: string | null;
  getBrowserSessionKey?: () => string | null;
  runTurn: (instruction: string, options?: { signal?: AbortSignal }) => Promise<SubAgentTurnResult>;
}

export interface SubAgentSessionRegistry {
  get: (sessionId: string) => SubAgentInteractiveSession | null | undefined;
  register: (session: SubAgentInteractiveSession) => void;
  remove?: (sessionId: string) => boolean;
}
