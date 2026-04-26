import type { VoiceSessionManager } from "./voiceSessionManager.ts";
import type { VoiceRealtimeToolSettings } from "./voiceSessionTypes.ts";
import type { SubAgentSession } from "../agents/subAgentSession.ts";

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
  createMinecraftSession?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => Promise<SubAgentSession | null | undefined> | SubAgentSession | null | undefined) | null;
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
  type?: string;
  ownerUserId?: string | null;
  status?: string;
  lastUsedAt?: number;
  getBrowserSessionKey?: () => string | null;
  cancel?: (reason?: string) => void;
  runTurn: (instruction: string, options?: { signal?: AbortSignal }) => Promise<SubAgentTurnResult>;
}

export interface SubAgentSessionRegistry {
  get: (sessionId: string) => SubAgentInteractiveSession | null | undefined;
  register: (session: SubAgentInteractiveSession) => void;
  list?: () => Array<{ id: string; type: string; status: string; lastUsedAt: number }>;
  remove?: (sessionId: string) => boolean;
}
