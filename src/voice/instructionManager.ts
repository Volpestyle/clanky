import {
  formatBehaviorMemoryFacts,
  formatConversationParticipantMemory,
  formatConversationWindows
} from "../prompts/promptFormatters.ts";
import {
  buildWebToolRoutingPolicyLine,
  BROWSER_BROWSE_POLICY_LINE,
  BROWSER_SCREENSHOT_POLICY_LINE,
  CONVERSATION_SEARCH_POLICY_LINE,
  IMMEDIATE_WEB_SEARCH_POLICY_LINE
} from "../prompts/toolPolicy.ts";
import {
  buildActiveMusicReplyGuidanceLines,
  MUSIC_ACTIVE_AUTONOMY_POLICY_LINE,
  MUSIC_REPLY_HANDOFF_POLICY_LINE
} from "../prompts/voiceLivePolicy.ts";
import { buildSingleTurnPromptLog } from "../promptLogging.ts";
import {
  loadConversationContinuityContext,
  type ConversationContinuityPayload
} from "../bot/conversationContinuity.ts";
import {
  REALTIME_CONTEXT_MEMBER_LIMIT,
  REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
  REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
} from "./voiceSessionManager.constants.ts";
import { getCompactedSessionSummaryContext } from "./voiceContextCompaction.ts";
import {
  formatVoiceChannelEffectSummary,
  inspectAsrTranscript,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import {
  loadSessionBehavioralMemoryFacts,
  loadSessionConversationHistory
} from "./voiceSessionMemoryCache.ts";
import { getNativeDiscordScreenSharePromptEntries } from "./nativeDiscordScreenShare.ts";
import {
  buildVoiceInstructions,
  isTransportOnlySession,
  shouldHandleRealtimeFunctionCalls,
  shouldRegisterRealtimeTools
} from "./voiceConfigResolver.ts";
import { getVoiceStreamWatchSettings } from "../settings/agentStack.ts";
import { getScreenWatchCommentaryTier } from "../prompts/voiceAdmissionPolicy.ts";
import type {
  RealtimeInstructionMemorySlice,
  RealtimeTurnContextRefreshState,
  VoiceRealtimeToolSettings,
  VoiceSession
} from "./voiceSessionTypes.ts";
import { refreshRealtimeTools } from "./voiceToolCallInfra.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";
import { providerSupports } from "./voiceModes.ts";

type InstructionSettings = VoiceRealtimeToolSettings | null;

interface InstructionStoreLike {
  getSettings: () => InstructionSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
  searchLookupContext?: (payload: {
    guildId: string;
    channelId: string | null;
    queryText: string;
    limit?: number;
    maxAgeHours?: number;
  }) => Promise<unknown[]> | unknown[];
  searchConversationWindows?: (payload: {
    guildId: string;
    channelId: string | null;
    queryText: string;
    limit?: number;
    maxAgeHours?: number;
    before?: number;
    after?: number;
  }) => Promise<unknown[]> | unknown[];
}

interface StreamWatchPromptContext {
  prompt?: string;
  notes?: string[];
  active?: boolean;
}

function toPromptRecordRows(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows.filter((entry): entry is Record<string, unknown> => (
    Boolean(entry) &&
    typeof entry === "object" &&
    !Array.isArray(entry)
  ));
}

interface ScreenShareCapabilityLike {
  available?: boolean;
  supported?: boolean;
  reason?: string | null;
}

interface VoiceChannelParticipant {
  userId: string;
  displayName: string;
}

interface VoiceMembershipPromptEntry {
  userId: string;
  displayName: string;
  eventType: string;
  at: number;
  ageMs: number;
}

interface VoiceChannelEffectPromptEntry {
  userId: string;
  displayName: string;
  channelId: string;
  guildId: string;
  effectType: string;
  soundId: string | null;
  soundName: string | null;
  soundVolume: number | null;
  emoji: string | null;
  animationType: number | null;
  animationId: number | null;
  at: number;
  ageMs: number;
  summary: string;
}

interface VoiceCommandStateLike {
  userId: string | null;
  domain: string | null;
  intent: string | null;
  startedAt: number;
  expiresAt: number;
}

interface MusicDisambiguationPromptContext {
  active?: boolean;
  action?: string | null;
  query?: string | null;
  options?: Array<{
    title?: string;
    artist?: string;
    id?: string;
  }>;
}

interface MusicPromptContext {
  playbackState: "playing" | "paused" | "stopped" | "idle";
  replyHandoffMode: "duck" | "pause" | null;
  currentTrack: { id: string | null; title: string; artists: string[] } | null;
  lastTrack: { id: string | null; title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ id: string | null; title: string; artist: string | null }>;
  lastAction: "play_now" | "stop" | "pause" | "resume" | "skip" | null;
  lastQuery: string | null;
}

interface QueueRealtimeTurnContextRefreshArgs {
  session: VoiceSession;
  settings?: InstructionSettings;
  userId?: string | null;
  transcript?: string;
  captureReason?: string;
}

interface PrepareRealtimeTurnContextArgs {
  session: VoiceSession;
  settings?: InstructionSettings;
  userId?: string | null;
  transcript?: string;
  captureReason?: string;
}

interface RefreshRealtimeInstructionsArgs {
  session: VoiceSession;
  settings?: InstructionSettings;
  reason?: string;
  speakerUserId?: string | null;
  transcript?: string;
  memorySlice?: RealtimeInstructionMemorySlice | null;
}

interface BuildRealtimeInstructionsArgs {
  session: VoiceSession;
  settings?: InstructionSettings;
  speakerUserId?: string | null;
  transcript?: string;
  memorySlice?: RealtimeInstructionMemorySlice | null;
}

interface BuildRealtimeMemorySliceArgs {
  session: VoiceSession;
  settings?: InstructionSettings;
  userId?: string | null;
  transcript?: string;
}

type InstructionManagerHost = VoiceToolCallManager & {
  store: InstructionStoreLike;
  resolveVoiceSpeakerName: (session: VoiceSession, userId?: string | null) => string;
  getStreamWatchBrainContextForPrompt: (
    session: VoiceSession,
    settings?: InstructionSettings
  ) => StreamWatchPromptContext | null;
  getVoiceScreenWatchCapability: (args?: {
    settings?: InstructionSettings;
    guildId?: string | null;
    channelId?: string | null;
    requesterUserId?: string | null;
  }) => ScreenShareCapabilityLike | null;
  getVoiceChannelParticipants: (session: VoiceSession) => VoiceChannelParticipant[];
  getRecentVoiceMembershipEvents: (
    session: VoiceSession,
    args?: { now?: number; maxItems?: number }
  ) => VoiceMembershipPromptEntry[];
  getRecentVoiceChannelEffectEvents: (
    session: VoiceSession,
    args?: { now?: number; maxItems?: number }
  ) => VoiceChannelEffectPromptEntry[];
  ensureVoiceCommandState: (session: VoiceSession) => VoiceCommandStateLike | null;
  getMusicDisambiguationPromptContext: (
    session: VoiceSession
  ) => MusicDisambiguationPromptContext | null;
  getMusicPromptContext: (session: VoiceSession) => MusicPromptContext | null;
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
  };
};

export class InstructionManager {
  constructor(private readonly host: InstructionManagerHost) {}

  private sanitizeRealtimeContextTranscript({
    session,
    userId,
    transcript = "",
    maxChars,
    stage,
    captureReason = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    transcript?: string;
    maxChars: number;
    stage: string;
    captureReason?: string | null;
  }) {
    const transcriptGuard = inspectAsrTranscript(transcript, maxChars);
    if (!transcriptGuard.malformed) return transcriptGuard.transcript;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: String(userId || "").trim() || null,
      content: "openai_realtime_turn_context_control_token_transcript_dropped",
      metadata: {
        sessionId: session.id,
        stage,
        captureReason: captureReason ? String(captureReason || "stream_end") : null,
        transcript: transcriptGuard.transcript,
        controlTokenCount: transcriptGuard.controlTokenCount,
        reservedAudioMarkerCount: transcriptGuard.reservedAudioMarkerCount
      }
    });
    return "";
  }

  queueRealtimeTurnContextRefresh({
    session,
    settings,
    userId,
    transcript = "",
    captureReason = "stream_end"
  }: QueueRealtimeTurnContextRefreshArgs) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    const pendingRefreshState = this.ensureTurnContextRefreshState(session);
    pendingRefreshState.pending = {
      settings: settings || session.settingsSnapshot || this.store.getSettings(),
      userId: String(userId || "").trim() || null,
      transcript: this.sanitizeRealtimeContextTranscript({
        session,
        userId,
        transcript,
        maxChars: REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
        stage: "queue_realtime_turn_context_refresh",
        captureReason
      }),
      captureReason: String(captureReason || "stream_end")
    };
    if (pendingRefreshState.inFlight) return;
    pendingRefreshState.inFlight = true;

    const runQueuedRefresh = async () => {
      let nextRefresh = null;
      try {
        while (!session.ending) {
          const queued = pendingRefreshState.pending;
          pendingRefreshState.pending = null;
          if (!queued) break;
          await this.prepareRealtimeTurnContext({
            session,
            settings: queued.settings,
            userId: queued.userId,
            transcript: queued.transcript,
            captureReason: queued.captureReason
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.host.client.user?.id || null,
          content: `openai_realtime_turn_context_refresh_failed: ${String((error as Error)?.message || error)}`,
          metadata: {
            sessionId: session.id,
            source: "queued_turn_context_refresh"
          }
        });
      } finally {
        pendingRefreshState.inFlight = false;
        if (session.ending) {
          if (session.realtimeTurnContextRefreshState === pendingRefreshState) {
            session.realtimeTurnContextRefreshState = null;
          }
        } else if (pendingRefreshState.pending) {
          nextRefresh = pendingRefreshState.pending;
        } else if (session.realtimeTurnContextRefreshState === pendingRefreshState) {
          session.realtimeTurnContextRefreshState = null;
        }
      }

      if (nextRefresh) {
        this.queueRealtimeTurnContextRefresh({
          session,
          settings: nextRefresh.settings,
          userId: nextRefresh.userId,
          transcript: nextRefresh.transcript,
          captureReason: nextRefresh.captureReason
        });
      }
    };

    void runQueuedRefresh();
  }

  async prepareRealtimeTurnContext({
    session,
    settings,
    userId,
    transcript = "",
    captureReason: _captureReason = "stream_end"
  }: PrepareRealtimeTurnContextArgs) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    const normalizedTranscript = this.sanitizeRealtimeContextTranscript({
      session,
      userId,
      transcript,
      maxChars: REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
      stage: "prepare_realtime_turn_context",
      captureReason: _captureReason
    });
    const transportOnly = isTransportOnlySession({ session, settings });
    const memorySlice = transportOnly
      ? null
      : await this.buildRealtimeMemorySlice({
          session,
          settings,
          userId,
          transcript: normalizedTranscript
        });

    await this.refreshRealtimeInstructions({
      session,
      settings,
      reason: "turn_context",
      speakerUserId: userId,
      transcript: normalizedTranscript,
      memorySlice
    });
  }

  async buildRealtimeMemorySlice({
    session,
    settings,
    userId,
    transcript = ""
  }: BuildRealtimeMemorySliceArgs): Promise<RealtimeInstructionMemorySlice> {
    const normalizedTranscript = this.sanitizeRealtimeContextTranscript({
      session,
      userId,
      transcript,
      maxChars: STT_TRANSCRIPT_MAX_CHARS,
      stage: "build_realtime_memory_slice"
    });
    if (!normalizedTranscript) {
      const factProfile =
        typeof this.host.getSessionFactProfileSlice === "function"
          ? this.host.getSessionFactProfileSlice({
              session,
              userId: String(userId || "").trim() || null
            })
          : null;
      return {
        participantProfiles: Array.isArray(factProfile?.participantProfiles) ? factProfile.participantProfiles : [],
        selfFacts: Array.isArray(factProfile?.selfFacts) ? factProfile.selfFacts : [],
        loreFacts: Array.isArray(factProfile?.loreFacts) ? factProfile.loreFacts : [],
        userFacts: Array.isArray(factProfile?.userFacts) ? factProfile.userFacts : [],
        relevantFacts: Array.isArray(factProfile?.relevantFacts) ? factProfile.relevantFacts : [],
        guidanceFacts: Array.isArray(factProfile?.guidanceFacts) ? factProfile.guidanceFacts : [],
        behavioralFacts: [],
        recentConversationHistory: []
      };
    }

    if (session?.pendingMemoryIngest) {
      try {
        await session.pendingMemoryIngest;
      } catch {
        // Best effort — fresh instructions are still more useful than failing the turn.
      }
      session.pendingMemoryIngest = null;
    }

    const normalizedUserId = String(userId || "").trim() || null;
    const memoryLoadStartedAt = Date.now();
    const loadRecentConversationHistory =
      this.store.searchConversationWindows
        ? (payload: {
          guildId: string;
          channelId?: string | null;
          queryText: string;
          limit?: number;
          maxAgeHours?: number;
        }) =>
          loadSessionConversationHistory({
            session,
            loadRecentConversationHistory: ({ guildId, channelId, queryText, limit, maxAgeHours }) =>
              (this.store.searchConversationWindows?.({
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
            limit: Number(payload.limit) || 1,
            maxAgeHours: Number(payload.maxAgeHours) || 1
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
      source: "voice_realtime_instruction_context",
      loadFactProfile:
        typeof this.host.getSessionFactProfileSlice === "function"
          ? (_payload: ConversationContinuityPayload) =>
            this.host.getSessionFactProfileSlice({
              session,
              userId: normalizedUserId
            })
          : null,
      loadRecentConversationHistory
    });
    const continuityLoadMs = Math.max(0, Date.now() - continuityStartedAt);
    const guidanceFacts = Array.isArray(continuity.memorySlice?.guidanceFacts)
      ? continuity.memorySlice.guidanceFacts
      : [];
    const participantIds = Array.isArray(continuity.memorySlice?.participantProfiles)
      ? continuity.memorySlice.participantProfiles
          .map((entry) => String((entry as Record<string, unknown>)?.userId || "").trim())
          .filter(Boolean)
      : [];
    const behavioralStartedAt = Date.now();
    const cachedBehavioralFacts = await loadSessionBehavioralMemoryFacts({
      session,
      searchDurableFacts:
        typeof this.host.memory?.searchDurableFacts === "function"
          ? (payload) => this.host.memory.searchDurableFacts(payload)
          : null,
      guildId: String(session.guildId || "").trim(),
      channelId: String(session.textChannelId || "").trim() || null,
      queryText: normalizedTranscript,
      participantIds,
      settings,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        source: "voice_realtime_behavioral_memory:instruction_refresh"
      },
      limit: 8
    });
    const behavioralFacts = cachedBehavioralFacts ?? (
      typeof this.host.memory?.loadBehavioralFactsForPrompt === "function"
        ? await this.host.memory.loadBehavioralFactsForPrompt({
            guildId: String(session.guildId || "").trim(),
            channelId: String(session.textChannelId || "").trim() || null,
            queryText: normalizedTranscript,
            participantIds,
            settings,
            trace: {
              guildId: session.guildId,
              channelId: session.textChannelId,
              userId: normalizedUserId,
              source: "voice_realtime_behavioral_memory:instruction_refresh"
            },
            limit: 8
          })
        : []
    );
    const behavioralMemoryLoadMs = Math.max(0, Date.now() - behavioralStartedAt);
    const usedCachedBehavioralFacts = Array.isArray(cachedBehavioralFacts);
    const totalLoadMs = Math.max(0, Date.now() - memoryLoadStartedAt);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: normalizedUserId || this.host.client.user?.id || null,
      content: "voice_realtime_instruction_memory_loaded",
      metadata: {
        sessionId: session.id,
        memorySource: "voice_realtime_instruction_context",
        transcriptChars: normalizedTranscript.length,
        continuityLoadMs,
        behavioralMemoryLoadMs,
        totalLoadMs,
        usedCachedBehavioralFacts,
        participantProfileCount: Array.isArray(continuity.memorySlice?.participantProfiles)
          ? continuity.memorySlice.participantProfiles.length
          : 0,
        userFactCount: Array.isArray(continuity.memorySlice?.userFacts)
          ? continuity.memorySlice.userFacts.length
          : 0,
        relevantFactCount: Array.isArray(continuity.memorySlice?.relevantFacts)
          ? continuity.memorySlice.relevantFacts.length
          : 0,
        guidanceFactCount: guidanceFacts.length,
        behavioralFactCount: Array.isArray(behavioralFacts) ? behavioralFacts.length : 0,
        recentConversationHistoryCount: Array.isArray(continuity.recentConversationHistory)
          ? continuity.recentConversationHistory.length
          : 0
      }
    });
    return {
      participantProfiles: Array.isArray(continuity.memorySlice?.participantProfiles)
        ? continuity.memorySlice.participantProfiles
        : [],
      selfFacts: Array.isArray(continuity.memorySlice?.selfFacts) ? continuity.memorySlice.selfFacts : [],
      loreFacts: Array.isArray(continuity.memorySlice?.loreFacts) ? continuity.memorySlice.loreFacts : [],
      userFacts: Array.isArray(continuity.memorySlice?.userFacts) ? continuity.memorySlice.userFacts : [],
      relevantFacts: Array.isArray(continuity.memorySlice?.relevantFacts) ? continuity.memorySlice.relevantFacts : [],
      guidanceFacts,
      behavioralFacts: Array.isArray(behavioralFacts) ? behavioralFacts : [],
      recentConversationHistory: Array.isArray(continuity.recentConversationHistory)
        ? continuity.recentConversationHistory
        : []
    };
  }

  scheduleRealtimeInstructionRefresh({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }: RefreshRealtimeInstructionsArgs) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    if (session.realtimeInstructionRefreshTimer) {
      clearTimeout(session.realtimeInstructionRefreshTimer);
      session.realtimeInstructionRefreshTimer = null;
    }

    session.realtimeInstructionRefreshTimer = setTimeout(() => {
      session.realtimeInstructionRefreshTimer = null;
      this.spawnRealtimeInstructionRefresh({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        reason,
        speakerUserId,
        transcript,
        memorySlice
      });
    }, REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS);
  }

  private spawnRealtimeInstructionRefresh({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }: RefreshRealtimeInstructionsArgs) {
    void this.refreshRealtimeInstructions({
      session,
      settings,
      reason,
      speakerUserId,
      transcript,
      memorySlice
    }).catch((error: unknown) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: speakerUserId || this.host.client.user?.id || null,
        content: `openai_realtime_instruction_refresh_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    });
  }

  async refreshRealtimeInstructions({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }: RefreshRealtimeInstructionsArgs) {
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;
    if (!session.realtimeClient) return;
    const updateInstructions =
      "updateInstructions" in session.realtimeClient &&
        typeof session.realtimeClient.updateInstructions === "function"
        ? session.realtimeClient.updateInstructions.bind(session.realtimeClient)
        : null;
    if (!updateInstructions) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (shouldRegisterRealtimeTools({ session, settings: resolvedSettings })) {
      await refreshRealtimeTools(this.host, {
        session,
        settings: resolvedSettings,
        reason
      });
    }
    const instructions = this.buildRealtimeInstructions({
      session,
      settings: resolvedSettings,
      speakerUserId,
      transcript,
      memorySlice
    });
    if (!instructions) return;
    if (instructions === session.lastRealtimeInstructions) return;

    try {
      updateInstructions(instructions);
      session.lastRealtimeInstructions = instructions;
      session.lastRealtimeInstructionsAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
        content: "openai_realtime_instructions_updated",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh"),
          speakerUserId: speakerUserId ? String(speakerUserId) : null,
          participantCount: this.host.getVoiceChannelParticipants(session).length,
          transcriptChars: transcript ? String(transcript).length : 0,
          userFactCount: Array.isArray(memorySlice?.userFacts) ? memorySlice.userFacts.length : 0,
          relevantFactCount: Array.isArray(memorySlice?.relevantFacts) ? memorySlice.relevantFacts.length : 0,
          conversationWindowCount: Array.isArray(memorySlice?.recentConversationHistory)
            ? memorySlice.recentConversationHistory.length
            : 0,
          instructionsChars: instructions.length,
          replyPrompts: buildSingleTurnPromptLog({
            systemPrompt: instructions,
            userPrompt: ""
          })
        }
      });
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.host.client.user?.id || null,
        content: `openai_realtime_instruction_update_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    }
  }

  buildRealtimeInstructions({
    session,
    settings,
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }: BuildRealtimeInstructionsArgs) {
    const baseInstructions = String(session?.baseVoiceInstructions || buildVoiceInstructions(settings)).trim();
    const speakerName = this.host.resolveVoiceSpeakerName(session, speakerUserId);
    const normalizedTranscript = this.sanitizeRealtimeContextTranscript({
      session,
      userId: speakerUserId,
      transcript,
      maxChars: REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
      stage: "build_realtime_instructions"
    });
    const streamWatchBrainContext = this.host.getStreamWatchBrainContextForPrompt(session, settings);
    const hasScreenFrameContext =
      Array.isArray(streamWatchBrainContext?.notes) && streamWatchBrainContext.notes.length > 0;
    const hasActiveScreenFrameContext = hasScreenFrameContext && Boolean(streamWatchBrainContext?.active);
    const hasRecentScreenFrameMemory = hasScreenFrameContext && !streamWatchBrainContext?.active;
    const screenShareCapability = this.host.getVoiceScreenWatchCapability({
      settings,
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      requesterUserId: speakerUserId || null
    });
    const nativeDiscordSharers = getNativeDiscordScreenSharePromptEntries(
      session,
      (currentSession, userId) => this.host.resolveVoiceSpeakerName(currentSession, userId)
    );
    const participants = this.host.getVoiceChannelParticipants(session);
    const recentMembershipEvents = this.host.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const recentVoiceChannelEffects = this.host.getRecentVoiceChannelEffectEvents(session, {
      maxItems: VOICE_CHANNEL_EFFECT_EVENT_PROMPT_LIMIT
    });
    const guild = this.host.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const voiceChannel = guild?.channels?.cache?.get(String(session?.voiceChannelId || "")) || null;
    const roster =
      participants.length > 0
        ? participants
          .slice(0, REALTIME_CONTEXT_MEMBER_LIMIT)
          .map((participant) => participant.displayName)
          .join(", ")
        : "unknown";
    const membershipSummary = recentMembershipEvents.length
      ? recentMembershipEvents
        .map((entry) => {
          const action = entry.eventType === "join" ? "joined" : "left";
          return `${entry.displayName} ${action} (${Math.max(0, Math.round(entry.ageMs))}ms ago)`;
        })
        .join(" | ")
      : "none";
    const effectSummary = recentVoiceChannelEffects.length
      ? recentVoiceChannelEffects
        .map((entry) => formatVoiceChannelEffectSummary(entry, { includeTiming: true }))
        .join(" | ")
      : "none";
    const participantMemory = formatConversationParticipantMemory({
      participantProfiles: toPromptRecordRows(memorySlice?.participantProfiles),
      selfFacts: toPromptRecordRows(memorySlice?.selfFacts),
      loreFacts: toPromptRecordRows(memorySlice?.loreFacts)
    });
    const recentConversationHistory = formatConversationWindows(memorySlice?.recentConversationHistory);
    const guidanceFacts = formatBehaviorMemoryFacts(memorySlice?.guidanceFacts, 8);
    const behavioralFacts = formatBehaviorMemoryFacts(memorySlice?.behavioralFacts, 8);
    const compactedSessionSummary = getCompactedSessionSummaryContext(session);
    const activeVoiceCommandState = this.host.ensureVoiceCommandState(session);
    const musicDisambiguation = this.host.getMusicDisambiguationPromptContext(session);

    const sections = [baseInstructions];
    sections.push(
      [
        "Live server context:",
        `- Server: ${String(guild?.name || "unknown").trim() || "unknown"}`,
        `- Voice channel: ${String(voiceChannel?.name || "unknown").trim() || "unknown"}`,
        `- Humans currently in channel: ${roster}`,
        `- Recent membership changes: ${membershipSummary}`,
        `- Recent voice effects: ${effectSummary}`,
        "- If someone recently joined, a quick natural greeting is usually good.",
        "- If someone recently left, a brief natural goodbye/acknowledgement is usually good."
      ].join("\n")
    );

    if (speakerName || normalizedTranscript) {
      sections.push(
        [
          "Current turn context:",
          speakerName ? `- Active speaker: ${speakerName}` : null,
          normalizedTranscript ? `- Latest speaker transcript: ${normalizedTranscript}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (
      Array.isArray(memorySlice?.participantProfiles) && memorySlice.participantProfiles.length > 0 ||
      Array.isArray(memorySlice?.selfFacts) && memorySlice.selfFacts.length > 0 ||
      Array.isArray(memorySlice?.loreFacts) && memorySlice.loreFacts.length > 0
    ) {
      sections.push(
        [
          "People in this conversation:",
          participantMemory
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (Array.isArray(memorySlice?.guidanceFacts) && memorySlice.guidanceFacts.length > 0) {
      sections.push(
        [
          "Behavior guidance:",
          "- These are standing guidance facts that should shape how you act in this conversation.",
          guidanceFacts
        ].join("\n")
      );
    }

    if (Array.isArray(memorySlice?.recentConversationHistory) && memorySlice.recentConversationHistory.length > 0) {
      sections.push(
        [
          "Recent conversation continuity:",
          "- These windows come from persisted shared text/voice history.",
          recentConversationHistory
        ].join("\n")
      );
    }

    if (compactedSessionSummary?.text) {
      sections.push(
        [
          "Session conversation summary:",
          `- ${compactedSessionSummary.text}`
        ].join("\n")
      );
    }

    if (Array.isArray(memorySlice?.behavioralFacts) && memorySlice.behavioralFacts.length > 0) {
      sections.push(
        [
          "Relevant behavioral memory:",
          "- These behavior memories were retrieved because they match the current turn. Follow them when relevant.",
          behavioralFacts
        ].join("\n")
      );
    }

    if (activeVoiceCommandState || musicDisambiguation) {
      sections.push(
        [
          "Active command session:",
          activeVoiceCommandState?.userId
            ? `- Locked speaker user ID: ${activeVoiceCommandState.userId}`
            : null,
          activeVoiceCommandState?.domain
            ? `- Domain: ${activeVoiceCommandState.domain}`
            : null,
          activeVoiceCommandState?.intent
            ? `- Intent: ${activeVoiceCommandState.intent}`
            : null,
          activeVoiceCommandState
            ? `- Command session expires in about ${Math.max(0, Math.round((activeVoiceCommandState.expiresAt - Date.now()) / 1000))} seconds.`
            : null,
          "- In command-only mode, a follow-up from the locked speaker does not need the wake word again.",
          musicDisambiguation?.active
            ? `- Pending music action: ${musicDisambiguation.action}`
            : null,
          musicDisambiguation?.query
            ? `- Pending music query: ${musicDisambiguation.query}`
            : null,
          ...(musicDisambiguation?.options || []).slice(0, 5).map((option, index) =>
            `- Music option ${index + 1}: ${String(option?.title || "").trim()} - ${String(option?.artist || "").trim()} [${String(option?.id || "").trim()}]`
          )
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    const musicContext = this.host.getMusicPromptContext(session);
    if (
      musicContext && (
        musicContext.currentTrack?.title ||
        musicContext.lastTrack?.title ||
        musicContext.queueLength > 0 ||
        musicContext.lastAction ||
        musicContext.lastQuery
      )
    ) {
      const musicDisplayState =
        musicContext.playbackState === "idle" &&
        (musicContext.currentTrack?.title || musicContext.lastTrack?.title)
          ? "stopped"
          : musicContext.playbackState;
      const musicLines = ["Music playback:"];
      musicLines.push(`- Status: ${musicDisplayState}`);
      if (musicContext.currentTrack) {
        const artists = musicContext.currentTrack.artists.length
          ? musicContext.currentTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(
          `- Current song: ${musicContext.currentTrack.title} by ${artists} (${musicDisplayState})${musicContext.currentTrack.id ? ` [selection_id: ${musicContext.currentTrack.id}]` : ""}`
        );
      }
      if (
        musicContext.lastTrack && (
          !musicContext.currentTrack ||
          musicContext.currentTrack.title !== musicContext.lastTrack.title ||
          musicContext.currentTrack.artists.join(" | ") !== musicContext.lastTrack.artists.join(" | ")
        )
      ) {
        const artists = musicContext.lastTrack.artists.length
          ? musicContext.lastTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(
          `- Last played: ${musicContext.lastTrack.title} by ${artists}${musicContext.lastTrack.id ? ` [selection_id: ${musicContext.lastTrack.id}]` : ""}`
        );
      }
      if (musicContext.queueLength > 0) {
        musicLines.push(`- Queue: ${musicContext.queueLength} track(s)`);
        for (const [index, track] of musicContext.upcomingTracks.entries()) {
          musicLines.push(
            `- Queue item ${index + 1}: ${track.title}${track.artist ? ` - ${track.artist}` : ""}${track.id ? ` [selection_id: ${track.id}]` : ""}`
          );
        }
      }
      if (musicContext.lastAction) {
        musicLines.push(`- Last action: ${musicContext.lastAction}`);
      }
      if (musicContext.lastQuery) {
        musicLines.push(`- Last music query: ${musicContext.lastQuery}`);
      }
      if (musicContext.replyHandoffMode === "pause") {
        musicLines.push("- Your next spoken reply can take the floor: music is paused now and auto-resumes when you finish or stay silent.");
      } else if (musicContext.replyHandoffMode === "duck") {
        musicLines.push("- Your next spoken reply can take the floor: music stays live and ducks under your voice, then unducks when you finish.");
      }
      musicLines.push(...buildActiveMusicReplyGuidanceLines(musicContext));
      sections.push(musicLines.join("\n"));
    }

    const configuredTools = Array.isArray(session.realtimeToolDefinitions) ? session.realtimeToolDefinitions : [];
    if (shouldHandleRealtimeFunctionCalls({ session, settings }) && configuredTools.length > 0) {
      const localToolNames = configuredTools
        .filter((tool) => tool?.toolType !== "mcp")
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, 16);
      const localToolNameSet = new Set(localToolNames);
      const hasWebSearchTool = localToolNameSet.has("web_search");
      const hasWebScrapeTool = localToolNameSet.has("web_scrape");
      const hasBrowserBrowseTool = localToolNameSet.has("browser_browse");
      const hasConversationSearchTool = localToolNameSet.has("conversation_search");
      const hasMemoryWriteTool = localToolNameSet.has("memory_write");
      const mcpToolNames = configuredTools
        .filter((tool) => tool?.toolType === "mcp")
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, 16);
      sections.push(
        [
          "Tooling policy:",
          localToolNames.length > 0 ? `- Local tools: ${localToolNames.join(", ")}` : null,
          mcpToolNames.length > 0 ? `- MCP tools: ${mcpToolNames.join(", ")}` : null,
          "- Use tools when they improve factuality or action execution. Always call the tool — never just say you will.",
          hasWebSearchTool || hasWebScrapeTool
            ? `- ${buildWebToolRoutingPolicyLine({ includeBrowserBrowse: hasBrowserBrowseTool })}`
            : hasBrowserBrowseTool
              ? `- ${BROWSER_BROWSE_POLICY_LINE}`
              : null,
          hasBrowserBrowseTool ? `- ${BROWSER_SCREENSHOT_POLICY_LINE}` : null,
          hasWebSearchTool ? `- ${IMMEDIATE_WEB_SEARCH_POLICY_LINE} Do not respond with only audio saying you will search.` : null,
          hasConversationSearchTool ? `- ${CONVERSATION_SEARCH_POLICY_LINE}` : null,
          hasMemoryWriteTool ? "- For memory writes, only store concise durable facts and avoid secrets." : null,
          "- For music controls, use music_play to start or replace playback now. It searches internally and may return disambiguation options.",
          "- If music_play returns choices, ask which one they want and then call music_play again with selection_id.",
          "- For YouTube video playback, use video_play. It resolves YouTube results and uses outbound stream publish when that runtime path is available.",
          "- If video_play returns choices, ask which one they want and then call video_play again with selection_id.",
          "- Omit selection_id unless you are reusing an exact one already shown in prompt context or a prior tool result. Never invent placeholder or markup tokens.",
          "- Use music_search only for explicit browsing requests or when the user wants options. Ordinary play and queue requests can resolve directly from query text.",
          "- Use video_search only for explicit video options. If thumbnails, page layout, or browsing the YouTube site would help, browser_browse may fit better.",
          "- For a fresh play request, pass query to music_play. For a followup choice after disambiguation, call music_play with selection_id.",
          "- For a fresh video request, pass query to video_play. For a followup choice after disambiguation, call video_play with selection_id.",
          "- If Music playback context already shows a selection_id for the exact track you want, reuse that selection_id with music_play and include the matching query text instead of re-searching.",
          "- Use music_queue_next to place a track after the current one and music_queue_add to append. Both can take direct query text or exact prior IDs.",
          "- For requests like \"play X, then queue Y\", call music_play for X first and music_queue_next for Y second in the same tool response.",
          "- Do not claim a track is queued or added until music_queue_next or music_queue_add succeeds.",
          "- Use media_stop to stop playback.",
          "- Do not emulate play-now by chaining music_queue_add and media_skip.",
          "- Do not use media_skip as a substitute for media_stop.",
          `- ${MUSIC_ACTIVE_AUTONOMY_POLICY_LINE}`,
          `- ${MUSIC_REPLY_HANDOFF_POLICY_LINE}`,
          "- If a tool fails, explain the failure briefly and continue naturally."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    const rawScreenShareReason = String(screenShareCapability?.reason || "").trim().toLowerCase();
    const screenShareReason = rawScreenShareReason || "unavailable";
    const screenShareAvailable = Boolean(screenShareCapability?.available);
    const screenShareSupported = Boolean(screenShareCapability?.supported);

    const commentaryEagerness = Math.max(0, Math.min(100,
      Number(getVoiceStreamWatchSettings(settings).commentaryEagerness) || 60
    ));
    if (hasActiveScreenFrameContext) {
      sections.push(
        [
          "Visual context:",
          "- You currently have screen-watch frame snapshots for this conversation.",
          "- You may comment only on what those snapshots show.",
          "- Do not imply you have a continuous live view beyond the provided frame context.",
          `Screen watch commentary eagerness: ${commentaryEagerness}/100.`,
          getScreenWatchCommentaryTier(commentaryEagerness)
        ].join("\n")
      );
    } else if (hasRecentScreenFrameMemory) {
      sections.push(
        [
          "Visual context:",
          "- You do not currently see the user's screen.",
          "- You do retain notes from an earlier screen-watch in this conversation.",
          "- If asked, answer only from those earlier notes and make clear they are not a live view."
        ].join("\n")
      );
    } else {
      if (screenShareAvailable) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content until actual frame context is provided.",
            "- If the speaker asks you to see/watch/share their screen or stream, call start_screen_watch.",
            "- The runtime chooses the best available watch method automatically."
          ].join("\n")
        );
      } else if (screenShareSupported) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Screen watch exists but is unavailable right now.",
            `- Current unavailability reason: ${screenShareReason}.`,
            "- If asked, say screen watch is unavailable right now.",
            "- Do not claim to see or watch the screen."
          ].join("\n")
        );
      } else {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content.",
            "- If asked about screen watching, explain that you need active frame context before you can comment on what is on screen."
          ].join("\n")
        );
      }
    }

    if (nativeDiscordSharers.length > 0) {
      const nativeStreamActionLine = screenShareAvailable
        ? "- If watching one of them would help, call start_screen_watch to request actual frame context."
        : screenShareSupported
          ? "- Screen watch start is unavailable right now, so do not call start_screen_watch yet."
          : "- Screen watch is unavailable in this session, so do not call start_screen_watch.";
      const nativeStreamTargetLine = screenShareAvailable
        ? "- If more than one share is live and you want a specific one, pass { target: \"display name\" }."
        : "- If more than one share is live, keep track of who is sharing but do not request a watch until it becomes available.";
      sections.push(
        [
          "Native Discord streams live right now:",
          ...nativeDiscordSharers.slice(0, 6).map((entry) => {
            const details = [
              entry.streamType,
              entry.codec,
              entry.width && entry.height ? `${entry.width}x${entry.height}` : null
            ]
              .filter(Boolean)
              .join(", ");
            return `- ${entry.displayName}${details ? ` (${details})` : ""}`;
          }),
          "- You do not automatically see those shares just because they are active.",
          nativeStreamActionLine,
          nativeStreamTargetLine
        ].join("\n")
      );
    }

    if (hasScreenFrameContext) {
      sections.push(
        [
          hasActiveScreenFrameContext ? "Screen-watch frame context:" : "Recent screen-watch memory:",
          `- Guidance: ${String(streamWatchBrainContext?.prompt || "").trim()}`,
          ...(streamWatchBrainContext?.notes || []).slice(-8).map((note) => `- ${note}`),
          hasActiveScreenFrameContext
            ? "- Treat these notes as snapshots, not a continuous feed."
            : "- Treat these notes as earlier snapshots, not a current live view."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return sections.join("\n\n").slice(0, 5200);
  }

  private ensureTurnContextRefreshState(
    session: VoiceSession
  ): RealtimeTurnContextRefreshState {
    const current = session.realtimeTurnContextRefreshState;
    if (current && typeof current === "object") {
      return current;
    }
    const nextState: RealtimeTurnContextRefreshState = {
      inFlight: false,
      pending: null
    };
    session.realtimeTurnContextRefreshState = nextState;
    return nextState;
  }

  private get store() {
    return this.host.store;
  }
}
