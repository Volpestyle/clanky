import {
  loadConversationContinuityContext,
  type ConversationContinuityPayload
} from "../bot/conversationContinuity.ts";
import { emptyFactProfileSlice, normalizeFactProfileSlice } from "../bot/memorySlice.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";
import { loadSessionBehavioralMemoryFacts, loadSessionConversationHistory } from "./voiceSessionMemoryCache.ts";
import type {
  RealtimeInstructionMemorySlice,
  VoiceRealtimeToolSettings,
  VoiceSession,
  VoiceToolRuntimeSessionLike
} from "./voiceSessionTypes.ts";

type LoadRecentConversationHistoryFn = (payload: {
  guildId: string;
  channelId?: string | null;
  queryText: string;
  limit?: number;
  maxAgeHours?: number;
}) => Promise<unknown[]> | unknown[];

type SearchConversationWindowsFn = (payload: {
  guildId: string;
  channelId: string | null;
  queryText: string;
  limit?: number;
  maxAgeHours?: number;
  before?: number;
  after?: number;
}) => Promise<unknown[]> | unknown[];

type SearchDurableFactsFn = (payload: {
  guildId: string;
  channelId: string | null;
  queryText: string;
  participantIds?: string[];
  limit?: number;
  trace?: Record<string, unknown>;
}) => Promise<MemoryFactRow[]> | MemoryFactRow[];

type LoadBehavioralFactsFn = (payload: {
  settings: VoiceRealtimeToolSettings | null;
  guildId: string;
  channelId: string | null;
  queryText: string;
  participantIds: string[];
  trace: {
    guildId: string;
    channelId: string | null;
    userId: string | null;
    source: string;
  };
  limit: number;
}) => Promise<MemoryFactRow[]> | MemoryFactRow[];

type RankBehavioralFactsFn = (payload: {
  candidates: MemoryFactRow[];
  queryText: string;
  channelId: string | null;
  settings: VoiceRealtimeToolSettings | null;
  trace: Record<string, unknown>;
  limit: number;
}) => Promise<MemoryFactRow[]> | MemoryFactRow[];

export interface VoiceMemoryContextHost {
  searchConversationWindows?: SearchConversationWindowsFn;
  loadRecentConversationHistory?: LoadRecentConversationHistoryFn | null;
  getSessionFactProfileSlice?: (payload: {
    session: VoiceSession;
    userId?: string | null;
  }) => {
    participantProfiles?: unknown[];
    selfFacts?: unknown[];
    loreFacts?: unknown[];
    userFacts: unknown[];
    relevantFacts: unknown[];
    guidanceFacts?: unknown[];
  } | null;
  searchDurableFacts?: SearchDurableFactsFn | null;
  loadBehavioralFactsForPrompt?: LoadBehavioralFactsFn | null;
  rankBehavioralFacts?: RankBehavioralFactsFn | null;
}

export interface LoadedVoiceMemoryContext {
  memorySlice: RealtimeInstructionMemorySlice;
  usedCachedBehavioralFacts: boolean;
  continuityLoadMs: number;
  behavioralMemoryLoadMs: number;
  totalLoadMs: number;
}

export type VoiceMemoryContextSessionLike = VoiceSession | (VoiceToolRuntimeSessionLike & {
  guildId: string;
  textChannelId?: string | null;
  pendingMemoryIngest?: Promise<unknown> | null;
});

export async function loadSharedVoiceMemoryContext(
  host: VoiceMemoryContextHost,
  {
    session,
    settings,
    userId = null,
    transcript = "",
    continuitySource,
    behavioralSource,
    behavioralLimit = 8,
    recentConversationLimit = 1,
    recentConversationMaxAgeHours = 1
  }: {
    session: VoiceMemoryContextSessionLike;
    settings: VoiceRealtimeToolSettings | null;
    userId?: string | null;
    transcript?: string;
    continuitySource: string;
    behavioralSource: string;
    behavioralLimit?: number;
    recentConversationLimit?: number;
    recentConversationMaxAgeHours?: number;
  }
): Promise<LoadedVoiceMemoryContext> {
  const normalizedTranscript = String(transcript || "").trim();
  const normalizedUserId = String(userId || "").trim() || null;
  if (!normalizedTranscript) {
    const factProfile =
      typeof host.getSessionFactProfileSlice === "function"
        ? host.getSessionFactProfileSlice({
            session,
            userId: normalizedUserId
          })
        : null;
    return {
      memorySlice: {
        participantProfiles: Array.isArray(factProfile?.participantProfiles) ? factProfile.participantProfiles : [],
        selfFacts: Array.isArray(factProfile?.selfFacts) ? factProfile.selfFacts : [],
        loreFacts: Array.isArray(factProfile?.loreFacts) ? factProfile.loreFacts : [],
        userFacts: Array.isArray(factProfile?.userFacts) ? factProfile.userFacts : [],
        relevantFacts: Array.isArray(factProfile?.relevantFacts) ? factProfile.relevantFacts : [],
        guidanceFacts: Array.isArray(factProfile?.guidanceFacts) ? factProfile.guidanceFacts : [],
        behavioralFacts: [],
        recentConversationHistory: []
      },
      usedCachedBehavioralFacts: false,
      continuityLoadMs: 0,
      behavioralMemoryLoadMs: 0,
      totalLoadMs: 0
    };
  }

  if (session?.pendingMemoryIngest) {
    try {
      await session.pendingMemoryIngest;
    } catch {
      // Best effort. A stale memory slice is still better than failing the turn.
    }
    session.pendingMemoryIngest = null;
  }

  const loadStartedAt = Date.now();
  const loadRecentConversationHistory: LoadRecentConversationHistoryFn | null =
    typeof host.loadRecentConversationHistory === "function"
      ? host.loadRecentConversationHistory
      : typeof host.searchConversationWindows === "function"
      ? (payload) =>
          loadSessionConversationHistory({
            session,
            loadRecentConversationHistory: ({ guildId, channelId, queryText, limit, maxAgeHours }) =>
              (host.searchConversationWindows?.({
                guildId,
                channelId,
                queryText,
                limit,
                maxAgeHours,
                before: 1,
                after: 1
              }) || []),
            strategy: "lexical",
            guildId: String(payload.guildId || "").trim(),
            channelId: String(payload.channelId || "").trim() || null,
            queryText: String(payload.queryText || ""),
            limit: Number(payload.limit) || recentConversationLimit,
            maxAgeHours: Number(payload.maxAgeHours) || recentConversationMaxAgeHours
          })
      : null;

  const continuityStartedAt = Date.now();
  const continuity = await loadConversationContinuityContext({
    settings,
    userId: normalizedUserId,
    guildId: session.guildId,
    channelId: session.textChannelId,
    queryText: normalizedTranscript,
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId
    },
    source: continuitySource,
    loadFactProfile:
      typeof host.getSessionFactProfileSlice === "function"
        ? (_payload: ConversationContinuityPayload) =>
            host.getSessionFactProfileSlice?.({
              session,
              userId: normalizedUserId
            }) || emptyFactProfileSlice()
        : null,
    loadRecentConversationHistory
  });
  const continuityLoadMs = Math.max(0, Date.now() - continuityStartedAt);

  const normalizedFactProfile = normalizeFactProfileSlice(continuity.memorySlice);
  const participantIds = normalizedFactProfile.participantProfiles
    .map((entry) => String((entry as Record<string, unknown>)?.userId || "").trim())
    .filter(Boolean);

  const behavioralStartedAt = Date.now();
  const cachedBehavioralFacts = await loadSessionBehavioralMemoryFacts({
    session,
    searchDurableFacts: host.searchDurableFacts || null,
    rankBehavioralFacts: host.rankBehavioralFacts || null,
    guildId: String(session.guildId || "").trim(),
    channelId: String(session.textChannelId || "").trim() || null,
    queryText: normalizedTranscript,
    participantIds,
    settings,
    trace: {
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId,
      source: behavioralSource
    },
    limit: behavioralLimit
  });
  const behavioralFacts = cachedBehavioralFacts ?? (
    typeof host.loadBehavioralFactsForPrompt === "function"
      ? await host.loadBehavioralFactsForPrompt({
          settings,
          guildId: session.guildId,
          channelId: session.textChannelId,
          queryText: normalizedTranscript,
          participantIds,
          trace: {
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: normalizedUserId,
            source: behavioralSource
          },
          limit: behavioralLimit
        })
      : []
  );
  const behavioralMemoryLoadMs = Math.max(0, Date.now() - behavioralStartedAt);

  return {
    memorySlice: {
      participantProfiles: normalizedFactProfile.participantProfiles,
      selfFacts: normalizedFactProfile.selfFacts,
      loreFacts: normalizedFactProfile.loreFacts,
      userFacts: normalizedFactProfile.userFacts,
      relevantFacts: normalizedFactProfile.relevantFacts,
      guidanceFacts: normalizedFactProfile.guidanceFacts,
      behavioralFacts: Array.isArray(behavioralFacts) ? behavioralFacts : [],
      recentConversationHistory: Array.isArray(continuity.recentConversationHistory)
        ? continuity.recentConversationHistory
        : []
    },
    usedCachedBehavioralFacts: Array.isArray(cachedBehavioralFacts),
    continuityLoadMs,
    behavioralMemoryLoadMs,
    totalLoadMs: Math.max(0, Date.now() - loadStartedAt)
  };
}
