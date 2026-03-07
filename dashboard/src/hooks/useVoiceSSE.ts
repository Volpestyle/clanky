import { useState, useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";

export type VoiceState = {
  activeCount: number;
  sessions: VoiceSession[];
};

export type VoiceTurn = {
  role: string;
  speakerName: string;
  text: string;
  at: string | null;
};

export type VoiceParticipant = {
  userId: string;
  displayName: string;
};

export type VoiceActiveCapture = {
  userId: string;
  displayName: string | null;
  startedAt: string | null;
  ageMs: number | null;
};

export type VoiceVisualFeedEntry = {
  text: string;
  at: string | null;
  provider: string | null;
  model: string | null;
  speakerName: string | null;
};

export type VoiceBrainContextPayload = {
  prompt: string;
  notes: string[];
  lastAt: string | null;
  provider: string | null;
  model: string | null;
} | null;

export type VoiceMembershipEvent = {
  userId: string;
  displayName: string;
  eventType: "join" | "leave" | string;
  at: string;
  ageMs: number;
};

export type GenerationContextSnapshot = {
  capturedAt: string;
  source: string;
  mode: string;
  incomingTranscript: string;
  speakerName: string;
  directAddressed: boolean;
  isEagerTurn: boolean;
  contextMessages: { role: string; content: string }[];
  conversationContext: {
    engagementState?: string;
    engaged?: boolean;
    streamWatchBrainContext?: string[];
    addressing?: { talkingTo?: string | null; confidence?: number } | null;
    [key: string]: unknown;
  } | null;
  participantRoster: string[];
  membershipEvents: { eventType: string; displayName: string; ageMs: number | null }[];
  memoryFacts: {
    userFacts: Record<string, unknown>[];
    relevantFacts: Record<string, unknown>[];
  };
  sessionTiming: { maxRemainingMs?: number | null; inactivityRemainingMs?: number | null; [key: string]: unknown } | null;
  tools: {
    soundboard: boolean;
    webSearch: boolean;
    openArticle: boolean;
    screenShare: boolean;
    memory: boolean;
  };
  soundboardCandidateCount: number;
  llmConfig: {
    provider: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
  };
};

export type AsrSessionSnapshot = {
  userId: string;
  displayName: string | null;
  connected: boolean;
  closing: boolean;
  connectedAt: string | null;
  lastAudioAt: string | null;
  lastTranscriptAt: string | null;
  idleMs: number | null;
  idleTtlMs: number;
  hasIdleTimer: boolean;
  pendingAudioBytes: number;
  pendingAudioChunks: number;
  utterance: {
    partialText: string;
    finalSegments: number;
    bytesSent: number;
  } | null;
  model: string | null;
  sessionId: string | null;
};

export type BrainToolEntry = {
  name: string;
  toolType: "function" | "mcp";
  serverName: string | null;
  description: string;
};

export type ToolCallEvent = {
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
};

export type McpServerStatus = {
  serverName: string;
  connected: boolean;
  tools: { name: string; description: string }[];
  lastError: string | null;
  lastConnectedAt: string | null;
  lastCallAt: string | null;
};

export type RealtimeState = {
  connected?: boolean;
  connectedAt?: string;
  lastEventAt?: string;
  sessionId?: string;
  lastError?: string;
  lastCloseCode?: number;
  lastCloseReason?: string;
  lastOutboundEventType?: string;
  lastOutboundEventAt?: string;
  activeResponseId?: string;
  activeResponseStatus?: string;
  recentOutboundEvents?: Array<{ type: string; at: string; payloadSummary?: string }>;
  [key: string]: unknown;
};

export type LatencyTurnEntry = {
  at: string;
  finalizedToAsrStartMs: number | null;
  asrToGenerationStartMs: number | null;
  generationToReplyRequestMs: number | null;
  replyRequestToAudioStartMs: number | null;
  totalMs: number | null;
  queueWaitMs: number | null;
  pendingQueueDepth: number | null;
};

export type LatencyAverages = {
  finalizedToAsrStartMs: number | null;
  asrToGenerationStartMs: number | null;
  generationToReplyRequestMs: number | null;
  replyRequestToAudioStartMs: number | null;
  totalMs: number | null;
};

export type SessionLatency = {
  recentTurns: LatencyTurnEntry[];
  averages: LatencyAverages;
  turnCount: number;
} | null;

export type VoiceSession = {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedAt: string;
  lastActivityAt: string;
  maxEndsAt: string | null;
  inactivityEndsAt: string | null;
  activeInputStreams: number;
  activeCaptures: VoiceActiveCapture[];
  soundboard: { playCount: number; lastPlayedAt: string | null };
  mode: string;
  botTurnOpen: boolean;
  playbackArm: { armed: boolean; reason: string | null; armedAt: string | null } | null;
  focusedSpeaker: { userId: string; displayName: string | null; since: string | null } | null;
  conversation: {
    lastAssistantReplyAt: string | null;
    lastDirectAddressAt: string | null;
    lastDirectAddressUserId: string | null;
    wake: {
      state: "awake" | "listening" | string;
      active: boolean;
      engagementState: string;
      engagedWithCurrentSpeaker: boolean;
      recentAssistantReply: boolean;
      recentDirectAddress: boolean;
      msSinceAssistantReply: number | null;
      msSinceDirectAddress: number | null;
      windowMs: number;
    };
    thoughtEngine: {
      busy: boolean;
      nextAttemptAt: string | null;
      lastAttemptAt: string | null;
      lastSpokenAt: string | null;
    };
    modelContext: {
      generation: {
        source: string;
        capturedAt: string;
        availableTurns: number;
        sentTurns: number;
        maxTurns: number;
        contextChars: number;
        transcriptChars: number;
        directAddressed: boolean;
      } | null;
      decider: {
        source: string;
        capturedAt: string;
        availableTurns: number;
        maxTurns: number;
        promptHistoryChars: number;
        transcriptChars: number;
        directAddressed: boolean;
      } | null;
      trackedTurns: number;
      trackedTurnLimit: number;
      trackedTranscriptTurns: number;
    };
  };
  participants: VoiceParticipant[];
  participantCount: number;
  membershipEvents: VoiceMembershipEvent[];
  voiceLookupBusyCount: number;
  pendingDeferredTurns: number;
  recentTurns: VoiceTurn[];
  lastGenerationContext: GenerationContextSnapshot | null;
  streamWatch: {
    active: boolean;
    targetUserId: string | null;
    requestedByUserId: string | null;
    lastFrameAt: string | null;
    lastCommentaryAt: string | null;
    lastCommentaryNote: string | null;
    lastMemoryRecapAt: string | null;
    lastMemoryRecapText: string | null;
    lastMemoryRecapDurableSaved: boolean;
    lastMemoryRecapReason: string | null;
    latestFrameAt: string | null;
    latestFrameMimeType: string | null;
    latestFrameApproxBytes: number;
    acceptedFrameCountInWindow: number;
    frameWindowStartedAt: string | null;
    ingestedFrameCount: number;
    lastBrainContextAt: string | null;
    lastBrainContextProvider: string | null;
    lastBrainContextModel: string | null;
    brainContextCount: number;
    visualFeed: VoiceVisualFeedEntry[];
    brainContextPayload: VoiceBrainContextPayload;
  };
  asrSessions: AsrSessionSnapshot[] | null;
  brainTools: BrainToolEntry[] | null;
  toolCalls: ToolCallEvent[] | null;
  mcpStatus: McpServerStatus[] | null;
  stt: { pendingTurns: number; contextMessages: number } | null;
  realtime: {
    provider: string;
    inputSampleRateHz: number;
    outputSampleRateHz: number;
    recentVoiceTurns: number;
    replySuperseded: number;
    pendingTurns: number;
    drainActive: boolean;
    coalesceActive?: boolean;
    state: RealtimeState | null;
  } | null;
  music: {
    active: boolean;
    provider: string | null;
    source: string | null;
    startedAt: string | null;
    stoppedAt: string | null;
    lastTrackId: string | null;
    lastTrackTitle: string | null;
    lastTrackArtists: string[];
    lastTrackUrl: string | null;
    lastQuery: string | null;
    lastRequestText: string | null;
    lastRequestedByUserId: string | null;
    lastCommandAt: string | null;
    lastCommandReason: string | null;
    pendingQuery: string | null;
    pendingPlatform: string | null;
    pendingRequestedByUserId: string | null;
    pendingRequestedAt: string | null;
    pendingResults: { id: string; title: string; artist: string; platform: string; externalUrl: string | null; durationSeconds: number | null }[];
    disambiguationActive: boolean;
  } | null;
  latency: SessionLatency;
};

export type VoiceEvent = {
  kind: string;
  createdAt: string;
  content?: string;
  guildId?: string;
  channelId?: string;
  metadata?: unknown;
  [key: string]: unknown;
};

export type SSEStatus = "connecting" | "open" | "closed";

const MAX_EVENTS = 200;
const RECONNECT_DELAY_MS = 3_000;

export function useVoiceSSE() {
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [events, setEvents] = useState<VoiceEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const token = getToken();
    const url = `/api/voice/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    esRef.current = es;
    setStatus("connecting");

    es.addEventListener("voice_state", (e: MessageEvent) => {
      try {
        setVoiceState(JSON.parse(e.data));
      } catch { /* malformed */ }
    });

    es.addEventListener("voice_event", (e: MessageEvent) => {
      try {
        const evt: VoiceEvent = JSON.parse(e.data);
        setEvents((prev) => {
          const next = [evt, ...prev];
          return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
        });
      } catch { /* malformed */ }
    });

    es.onopen = () => setStatus("open");

    es.onerror = () => {
      es.close();
      setStatus("closed");
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      esRef.current?.close();
    };
  }, [connect]);

  return { voiceState, events, status };
}
