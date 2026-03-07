import { getDirectiveSettings } from "../settings/agentStack.ts";
import { loadPromptMemorySliceFromMemory } from "../memory/promptMemorySlice.ts";
import {
  formatAdaptiveDirectives,
  formatConversationWindows,
  formatRecentLookupContext
} from "../prompts/promptFormatters.ts";
import {
  loadConversationContinuityContext,
  type ConversationContinuityPayload
} from "../bot/conversationContinuity.ts";
import type { GreetingManager } from "./greetingManager.ts";
import {
  REALTIME_CONTEXT_MEMBER_LIMIT,
  REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
  REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS,
  STT_TRANSCRIPT_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
} from "./voiceSessionManager.constants.ts";
import {
  REALTIME_MEMORY_FACT_LIMIT,
  formatRealtimeMemoryFacts,
  normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import { buildVoiceInstructions } from "./voiceConfigResolver.ts";
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
  searchAdaptiveStyleNotesForPrompt?: (payload: {
    guildId: string;
    queryText: string;
    limit: number;
  }) => Promise<unknown[]> | unknown[];
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
  currentTrack: { title: string; artists: string[] } | null;
  lastTrack: { title: string; artists: string[] } | null;
  queueLength: number;
  upcomingTracks: Array<{ title: string; artist: string | null }>;
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

export type InstructionManagerHost = VoiceToolCallManager & {
  store: InstructionStoreLike;
  resolveVoiceSpeakerName: (session: VoiceSession, userId?: string | null) => string;
  getStreamWatchBrainContextForPrompt: (
    session: VoiceSession,
    settings?: InstructionSettings
  ) => StreamWatchPromptContext | null;
  getVoiceScreenShareCapability: (args?: {
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
  ensureVoiceCommandState: (session: VoiceSession) => VoiceCommandStateLike | null;
  getMusicDisambiguationPromptContext: (
    session: VoiceSession
  ) => MusicDisambiguationPromptContext | null;
  getMusicPromptContext: (session: VoiceSession) => MusicPromptContext | null;
  greetingManager: Pick<GreetingManager, "getJoinGreetingOpportunity" | "scheduleJoinGreetingOpportunity">;
};

export class InstructionManager {
  constructor(private readonly host: InstructionManagerHost) {}

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
      transcript: normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS),
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
          if (session.openAiTurnContextRefreshState === pendingRefreshState) {
            session.openAiTurnContextRefreshState = null;
          }
        } else if (pendingRefreshState.pending) {
          nextRefresh = pendingRefreshState.pending;
        } else if (session.openAiTurnContextRefreshState === pendingRefreshState) {
          session.openAiTurnContextRefreshState = null;
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
    void _captureReason;
    if (!session || session.ending) return;
    if (!providerSupports(session.mode || "", "updateInstructions")) return;

    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const memorySlice = await this.buildRealtimeMemorySlice({
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
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) {
      const adaptiveDirectives =
        Boolean(getDirectiveSettings(settings).enabled) &&
          this.store.searchAdaptiveStyleNotesForPrompt
          ? await this.store.searchAdaptiveStyleNotesForPrompt({
            guildId: String(session?.guildId || "").trim(),
            queryText: "",
            limit: 8
          })
          : [];
      return {
        userFacts: [],
        relevantFacts: [],
        relevantMessages: [],
        recentConversationHistory: [],
        recentWebLookups: [],
        adaptiveDirectives: Array.isArray(adaptiveDirectives) ? adaptiveDirectives : []
      };
    }

    if (session?.pendingMemoryIngest) {
      try {
        await session.pendingMemoryIngest;
      } catch {
        // Best effort. Fresh instructions are still more useful than failing the turn.
      }
      session.pendingMemoryIngest = null;
    }

    const normalizedUserId = String(userId || "").trim() || null;
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
      loadPromptMemorySlice:
        this.host.memory && typeof this.host.memory === "object"
          ? (payload: ConversationContinuityPayload) =>
            loadPromptMemorySliceFromMemory({
              settings: payload.settings,
              memory: this.host.memory,
              userId: String(payload.userId || "").trim() || null,
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              trace: payload.trace || {},
              source: String(payload.source || "voice_realtime_instruction_context"),
              onError: ({ error }) => {
                this.store.logAction({
                  kind: "voice_error",
                  guildId: session.guildId,
                  channelId: session.textChannelId,
                  userId: normalizedUserId,
                  content: `voice_realtime_memory_slice_failed: ${String((error as Error)?.message || error)}`,
                  metadata: {
                    sessionId: session.id
                  }
                });
              }
            })
          : null,
      loadRecentLookupContext:
        this.store.searchLookupContext
          ? (payload) =>
            (this.store.searchLookupContext?.({
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              limit: Number(payload.limit) || undefined,
              maxAgeHours: Number(payload.maxAgeHours) || undefined
            }) || [])
          : null,
      loadRecentConversationHistory:
        this.store.searchConversationWindows
          ? (payload) =>
            (this.store.searchConversationWindows?.({
              guildId: String(payload.guildId || "").trim(),
              channelId: String(payload.channelId || "").trim() || null,
              queryText: String(payload.queryText || ""),
              limit: Number(payload.limit) || undefined,
              maxAgeHours: Number(payload.maxAgeHours) || undefined,
              before: 1,
              after: 1
            }) || [])
          : null,
      loadAdaptiveDirectives:
        Boolean(getDirectiveSettings(settings).enabled) &&
          this.store.searchAdaptiveStyleNotesForPrompt
          ? (payload) =>
            (this.store.searchAdaptiveStyleNotesForPrompt?.({
              guildId: String(payload.guildId || "").trim(),
              queryText: String(payload.queryText || ""),
              limit: 8
            }) || [])
          : null
    });
    return {
      userFacts: Array.isArray(continuity.memorySlice?.userFacts) ? continuity.memorySlice.userFacts : [],
      relevantFacts: Array.isArray(continuity.memorySlice?.relevantFacts) ? continuity.memorySlice.relevantFacts : [],
      relevantMessages: Array.isArray(continuity.memorySlice?.relevantMessages)
        ? continuity.memorySlice.relevantMessages
        : [],
      recentConversationHistory: Array.isArray(continuity.recentConversationHistory)
        ? continuity.recentConversationHistory
        : [],
      recentWebLookups: Array.isArray(continuity.recentWebLookups) ? continuity.recentWebLookups : [],
      adaptiveDirectives: Array.isArray(continuity.adaptiveDirectives) ? continuity.adaptiveDirectives : []
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
    await refreshRealtimeTools(this.host, {
      session,
      settings: resolvedSettings,
      reason
    });
    const instructions = this.buildRealtimeInstructions({
      session,
      settings: resolvedSettings,
      speakerUserId,
      transcript,
      memorySlice
    });
    if (!instructions) return;
    if (instructions === session.lastOpenAiRealtimeInstructions) return;

    try {
      updateInstructions(instructions);
      session.lastOpenAiRealtimeInstructions = instructions;
      session.lastOpenAiRealtimeInstructionsAt = Date.now();

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
          instructionsChars: instructions.length
        }
      });

      const joinGreetingOpportunity = this.host.greetingManager.getJoinGreetingOpportunity(session);
      if (joinGreetingOpportunity && session.playbackArmed && !session.lastAssistantReplyAt) {
        const delayMs = Math.max(0, Number(joinGreetingOpportunity.fireAt || 0) - Date.now());
        this.host.greetingManager.scheduleJoinGreetingOpportunity(session, {
          delayMs,
          reason: "join_greeting_grace"
        });
      }
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
    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const streamWatchBrainContext = this.host.getStreamWatchBrainContextForPrompt(session, settings);
    const hasScreenFrameContext =
      Array.isArray(streamWatchBrainContext?.notes) && streamWatchBrainContext.notes.length > 0;
    const hasActiveScreenFrameContext = hasScreenFrameContext && Boolean(streamWatchBrainContext?.active);
    const hasRecentScreenFrameMemory = hasScreenFrameContext && !streamWatchBrainContext?.active;
    const screenShareCapability = this.host.getVoiceScreenShareCapability({
      settings,
      guildId: session?.guildId || null,
      channelId: session?.textChannelId || null,
      requesterUserId: speakerUserId || null
    });
    const participants = this.host.getVoiceChannelParticipants(session);
    const recentMembershipEvents = this.host.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
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
    const userFacts = formatRealtimeMemoryFacts(memorySlice?.userFacts, REALTIME_MEMORY_FACT_LIMIT);
    const relevantFacts = formatRealtimeMemoryFacts(memorySlice?.relevantFacts, REALTIME_MEMORY_FACT_LIMIT);
    const recentConversationHistory = formatConversationWindows(memorySlice?.recentConversationHistory);
    const recentWebLookups = formatRecentLookupContext(memorySlice?.recentWebLookups);
    const adaptiveDirectives = formatAdaptiveDirectives(memorySlice?.adaptiveDirectives, 8);
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

    if (userFacts || relevantFacts) {
      sections.push(
        [
          "Durable memory context:",
          userFacts ? `- Known facts about active speaker: ${userFacts}` : null,
          relevantFacts ? `- Other relevant memory: ${relevantFacts}` : null
        ]
          .filter(Boolean)
          .join("\n")
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

    if (Array.isArray(memorySlice?.recentWebLookups) && memorySlice.recentWebLookups.length > 0) {
      sections.push(
        [
          "Recent lookup continuity:",
          "- These are recent successful web searches from the shared text/voice conversation.",
          recentWebLookups
        ].join("\n")
      );
    }

    if (Array.isArray(memorySlice?.adaptiveDirectives) && memorySlice.adaptiveDirectives.length > 0) {
      sections.push(
        [
          "Adaptive directives:",
          "- Guidance directives shape tone/persona. Behavior directives define recurring trigger/action behavior when the current turn matches.",
          adaptiveDirectives
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
    if (musicContext && musicContext.playbackState !== "idle") {
      const musicLines = ["Music playback:"];
      musicLines.push(`- Status: ${musicContext.playbackState}`);
      if (musicContext.currentTrack) {
        const artists = musicContext.currentTrack.artists.length
          ? musicContext.currentTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(`- Now playing: ${musicContext.currentTrack.title} by ${artists}`);
      } else if (musicContext.lastTrack && musicContext.playbackState === "stopped") {
        const artists = musicContext.lastTrack.artists.length
          ? musicContext.lastTrack.artists.join(", ")
          : "unknown artist";
        musicLines.push(`- Last played: ${musicContext.lastTrack.title} by ${artists}`);
      }
      if (musicContext.queueLength > 0) {
        musicLines.push(`- Queue: ${musicContext.queueLength} track(s)`);
      }
      sections.push(musicLines.join("\n"));
    }

    const configuredTools = Array.isArray(session.openAiToolDefinitions) ? session.openAiToolDefinitions : [];
    if (configuredTools.length > 0) {
      const localToolNames = configuredTools
        .filter((tool) => tool?.toolType !== "mcp")
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, 16);
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
          "- Lookup chain: web_search → web_scrape → browser_browse. Start with web_search for general queries. Use web_scrape to read a specific URL. Use browser_browse only when you need JS rendering or page interaction (clicking, scrolling).",
          "- When users ask you to look something up, search for something, find prices, or need current/factual information, call web_search immediately in the same response. Do not respond with only audio saying you will search — include the tool call.",
          "- Use conversation_search when the speaker asks what was said earlier or asks you to remember a prior exchange.",
          "- For memory writes, only store concise durable facts and avoid secrets.",
          getDirectiveSettings(settings).enabled
            ? "- If someone explicitly asks you to change how you talk, follow a standing instruction, or perform a recurring trigger/action behavior in future conversations, use adaptive_directive_add or adaptive_directive_remove instead of memory_write."
            : "- Adaptive directives are disabled right now. Do not imply you can save standing behavior changes for later.",
          "- For music controls, use music_play_now for immediate playback, music_queue_next to place a track after the current one, music_queue_add to append, and music_stop to stop playback.",
          "- Do not emulate play-now by chaining music_queue_add and music_skip.",
          "- Do not use music_skip as a substitute for music_stop.",
          "- If a tool fails, explain the failure briefly and continue naturally."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (hasActiveScreenFrameContext) {
      sections.push(
        [
          "Visual context:",
          "- You currently have screen-share frame snapshots for this conversation.",
          "- You may comment only on what those snapshots show.",
          "- Do not imply you have a continuous live view beyond the provided frame context."
        ].join("\n")
      );
    } else if (hasRecentScreenFrameMemory) {
      sections.push(
        [
          "Visual context:",
          "- You do not currently see the user's screen.",
          "- You do retain notes from an earlier screen-share in this conversation.",
          "- If asked, answer only from those earlier notes and make clear they are not a live view."
        ].join("\n")
      );
    } else {
      const rawScreenShareReason = String(screenShareCapability?.reason || "").trim().toLowerCase();
      const screenShareReason = rawScreenShareReason || "unavailable";
      const screenShareAvailable = Boolean(screenShareCapability?.available);
      const screenShareSupported = Boolean(screenShareCapability?.supported);
      if (screenShareAvailable) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content until actual frame context is provided.",
            "- If the speaker asks you to see/watch/share their screen or stream, call offer_screen_share_link.",
            "- After offering the link, you may briefly tell them to open the link and start sharing."
          ].join("\n")
        );
      } else if (screenShareSupported) {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Screen-share link capability exists but is unavailable right now.",
            `- Current unavailability reason: ${screenShareReason}.`,
            "- If asked, say the link flow is unavailable right now.",
            "- Do not claim to see or watch the screen."
          ].join("\n")
        );
      } else {
        sections.push(
          [
            "Visual context:",
            "- You do not currently see the user's screen.",
            "- Do not claim to see, watch, or react to on-screen content.",
            "- If asked about screen sharing, explain that you need an active screen-share link and incoming frame context before you can comment on what is on screen."
          ].join("\n")
        );
      }
    }

    if (hasScreenFrameContext) {
      sections.push(
        [
          hasActiveScreenFrameContext ? "Screen-share stream frame context:" : "Recent screen-share memory:",
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
    const current = session.openAiTurnContextRefreshState;
    if (current && typeof current === "object") {
      return current;
    }
    const nextState: RealtimeTurnContextRefreshState = {
      inFlight: false,
      pending: null
    };
    session.openAiTurnContextRefreshState = nextState;
    return nextState;
  }

  private get store() {
    return this.host.store;
  }
}
