import { buildSingleTurnPromptLog } from "../promptLogging.ts";
import { clamp } from "../utils.ts";
import {
  OPENAI_ASR_SESSION_IDLE_TTL_MS,
  OPENAI_TOOL_CALL_EVENT_MAX,
  RECENT_ENGAGEMENT_WINDOW_MS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
  VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS
} from "./voiceSessionManager.constants.ts";
import { listActiveNativeDiscordScreenSharers } from "./nativeDiscordScreenShare.ts";
import { isRealtimeMode, resolveRealtimeProvider } from "./voiceSessionHelpers.ts";
import type {
  StreamWatchNoteEntry,
  VoiceAddressingState,
  VoiceConversationContext,
  VoiceLivePromptSnapshotEntry,
  VoiceMembershipPromptEntry,
  VoiceSession,
  VoiceSessionDurableContextCategory
} from "./voiceSessionTypes.ts";

type RuntimeSnapshotClientLike = {
  users?: {
    cache?: {
      get?: (userId: string) => {
        displayName?: string | null;
        globalName?: string | null;
        username?: string | null;
      } | null;
    } | null;
  } | null;
} | null;

type RuntimeSnapshotReplyManagerLike = {
  syncAssistantOutputState: (
    session: VoiceSession,
    source: string
  ) => {
    phase?: string | null;
  } | null;
};

type RuntimeSnapshotDeferredActionQueueLike = {
  getDeferredQueuedUserTurns: (session: VoiceSession) => unknown[];
};

type StreamWatchNotePayloadLike = {
  prompt?: string | null;
  notes?: unknown[];
  lastAt?: number;
  provider?: string | null;
  model?: string | null;
} | null;

type VoiceRuntimeSnapshotDurableContextEntry = {
  text: string;
  category: VoiceSessionDurableContextCategory;
  at: string | null;
};

interface VoiceRuntimeSnapshotDeps {
  client?: RuntimeSnapshotClientLike;
  replyManager: RuntimeSnapshotReplyManagerLike;
  deferredActionQueue: RuntimeSnapshotDeferredActionQueueLike;
  getVoiceChannelParticipants: (
    session: VoiceSession
  ) => Array<{ userId: string; displayName: string }>;
  getRecentVoiceMembershipEvents: (
    session: VoiceSession,
    args: { maxItems: number }
  ) => VoiceMembershipPromptEntry[];
  buildVoiceConversationContext: (args: {
    session: VoiceSession;
    now: number;
  }) => VoiceConversationContext | null;
  buildVoiceAddressingState: (args: {
    session: VoiceSession;
    userId?: string | null;
    now?: number;
    maxItems?: number;
  }) => VoiceAddressingState | null;
  getStreamWatchNotesForPrompt: (
    session: VoiceSession,
    settings: Record<string, unknown> | null
  ) => StreamWatchNotePayloadLike;
  snapshotMusicRuntimeState: (session: VoiceSession) => unknown;
}

function toIsoOrNull(value: number | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeLoggedPromptBundle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bundle = value as {
    hiddenByDefault?: unknown;
    systemPrompt?: unknown;
    initialUserPrompt?: unknown;
    followupUserPrompts?: unknown;
    followupSteps?: unknown;
    tools?: unknown;
  };
  const followupUserPrompts = Array.isArray(bundle.followupUserPrompts)
    ? bundle.followupUserPrompts.map((entry) => String(entry || ""))
    : [];
  const followupSteps = Number(bundle.followupSteps);
  const tools = Array.isArray(bundle.tools)
    ? bundle.tools
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const tool = t as { name?: unknown; description?: unknown; parameters?: unknown };
        const name = String(tool.name || "").trim();
        return name
          ? {
            name,
            description: String(tool.description || ""),
            parameters: tool.parameters && typeof tool.parameters === "object"
              ? tool.parameters as Record<string, unknown>
              : null
          }
          : null;
      })
      .filter((t): t is { name: string; description: string; parameters: Record<string, unknown> | null } => t !== null)
    : [];

  return {
    hiddenByDefault: bundle.hiddenByDefault !== false,
    systemPrompt: String(bundle.systemPrompt || ""),
    initialUserPrompt: String(bundle.initialUserPrompt || ""),
    followupUserPrompts,
    followupSteps: Number.isFinite(followupSteps)
      ? Math.max(0, Math.floor(followupSteps))
      : followupUserPrompts.length,
    tools
  };
}

function buildPromptSnapshotEntry(entry: VoiceLivePromptSnapshotEntry | null | undefined) {
  if (!entry || typeof entry !== "object") return null;
  const replyPrompts = normalizeLoggedPromptBundle(entry.replyPrompts);
  if (!replyPrompts) return null;
  return {
    updatedAt: toIsoOrNull(entry.updatedAt),
    source: String(entry.source || "").trim() || null,
    replyPrompts
  };
}

function buildRecentTurnAddressing(row: VoiceSession["transcriptTurns"][number]) {
  return row?.addressing && typeof row.addressing === "object"
    ? {
      talkingTo: row.addressing.talkingTo || null,
      directedConfidence: Number.isFinite(Number(row.addressing.directedConfidence))
        ? Number(clamp(Number(row.addressing.directedConfidence), 0, 1).toFixed(3))
        : 0,
      source: row.addressing.source || null,
      reason: row.addressing.reason || null
    }
    : null;
}

function buildMemoryFactSnapshot(row: unknown) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as {
    id?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    guild_id?: unknown;
    channel_id?: unknown;
    subject?: unknown;
    fact?: unknown;
    fact_type?: unknown;
    evidence_text?: unknown;
    source_message_id?: unknown;
    confidence?: unknown;
  };
  const fact = String(record.fact || "").trim();
  if (!fact) return null;
  const confidence = Number(record.confidence);
  return {
    id: Number.isInteger(Number(record.id)) ? Number(record.id) : null,
    createdAt: record.created_at ? String(record.created_at) : null,
    updatedAt: record.updated_at ? String(record.updated_at) : null,
    guildId: record.guild_id ? String(record.guild_id) : null,
    channelId: record.channel_id ? String(record.channel_id) : null,
    subject: String(record.subject || "").trim() || null,
    fact,
    factType: String(record.fact_type || "").trim() || null,
    evidenceText: record.evidence_text ? String(record.evidence_text) : null,
    sourceMessageId: record.source_message_id ? String(record.source_message_id) : null,
    confidence: Number.isFinite(confidence) ? Number(clamp(confidence, 0, 1).toFixed(3)) : null
  };
}

function buildLatencySnapshot(session: VoiceSession) {
  const stages = Array.isArray(session.latencyStages) ? session.latencyStages : [];
  if (stages.length === 0) return null;

  const recentTurns = stages.slice(-8).reverse().map((entry) => ({
    at: new Date(entry.at).toISOString(),
    finalizedToAsrStartMs: entry.finalizedToAsrStartMs ?? null,
    asrToGenerationStartMs: entry.asrToGenerationStartMs ?? null,
    generationToReplyRequestMs: entry.generationToReplyRequestMs ?? null,
    replyRequestToAudioStartMs: entry.replyRequestToAudioStartMs ?? null,
    totalMs: entry.totalMs ?? null,
    queueWaitMs: entry.queueWaitMs ?? null,
    pendingQueueDepth: entry.pendingQueueDepth ?? null
  }));
  const avg = (field: "finalizedToAsrStartMs" | "asrToGenerationStartMs" | "generationToReplyRequestMs" | "replyRequestToAudioStartMs" | "totalMs") => {
    const values = stages
      .map((entry) => entry[field])
      .filter((value): value is number => Number.isFinite(value) && value >= 0);
    return values.length > 0
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : null;
  };

  return {
    recentTurns,
    averages: {
      finalizedToAsrStartMs: avg("finalizedToAsrStartMs"),
      asrToGenerationStartMs: avg("asrToGenerationStartMs"),
      generationToReplyRequestMs: avg("generationToReplyRequestMs"),
      replyRequestToAudioStartMs: avg("replyRequestToAudioStartMs"),
      totalMs: avg("totalMs")
    },
    turnCount: stages.length
  };
}

function buildAsrSessionsSnapshot(
  session: VoiceSession,
  {
    now,
    participantDisplayByUserId
  }: {
    now: number;
    participantDisplayByUserId: Map<string, string>;
  }
) {
  const asrMap = session.openAiAsrSessions instanceof Map ? session.openAiAsrSessions : null;
  if (!asrMap || asrMap.size === 0) return null;

  return [...asrMap.entries()].map(([uid, asr]) => {
    const ws = asr?.client?.ws;
    const connected = Boolean(ws && ws.readyState === 1);
    const idleTtlMs = Math.max(
      1_000,
      Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
    );
    const lastActivityMs = Math.max(
      Number(asr.lastAudioAt || 0),
      Number(asr.lastTranscriptAt || 0)
    );
    const idleMs = lastActivityMs > 0 ? Math.max(0, now - lastActivityMs) : null;
    return {
      userId: String(uid || ""),
      displayName: participantDisplayByUserId.get(String(uid || "")) || null,
      connected,
      phase: String(asr.phase || "idle"),
      connectedAt: asr.connectedAt > 0 ? new Date(asr.connectedAt).toISOString() : null,
      lastAudioAt: asr.lastAudioAt > 0 ? new Date(asr.lastAudioAt).toISOString() : null,
      lastTranscriptAt: asr.lastTranscriptAt > 0 ? new Date(asr.lastTranscriptAt).toISOString() : null,
      idleMs,
      idleTtlMs,
      hasIdleTimer: Boolean(asr.idleTimer),
      pendingAudioBytes: Number(asr.pendingAudioBytes || 0),
      pendingAudioChunks: Array.isArray(asr.pendingAudioChunks) ? asr.pendingAudioChunks.length : 0,
      utterance: asr.utterance ? {
        partialText: String(asr.utterance.partialText || "").slice(0, 200),
        finalSegments: Array.isArray(asr.utterance.finalSegments) ? asr.utterance.finalSegments.length : 0,
        bytesSent: Number(asr.utterance.bytesSent || 0)
      } : null,
      model: String(
        asr.client?.sessionConfig?.inputTranscriptionModel ||
        session.openAiPerUserAsrModel ||
        ""
      ).trim() || null,
      sessionId: asr.client?.sessionId || null
    };
  });
}

function buildSharedAsrSessionSnapshot(
  session: VoiceSession,
  {
    now,
    participantDisplayByUserId
  }: {
    now: number;
    participantDisplayByUserId: Map<string, string>;
  }
) {
  const shared = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
    ? session.openAiSharedAsrState
    : null;
  if (!shared) return null;

  const ws = shared.client?.ws;
  const connected = Boolean(ws && ws.readyState === 1);
  const idleTtlMs = Math.max(
    1_000,
    Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
  );
  const lastActivityMs = Math.max(
    Number(shared.lastAudioAt || 0),
    Number(shared.lastTranscriptAt || 0)
  );
  const idleMs = lastActivityMs > 0 ? Math.max(0, now - lastActivityMs) : null;
  const activeUserId = String(shared.userId || "").trim();
  return {
    connected,
    phase: String(shared.phase || "idle"),
    userId: activeUserId || null,
    displayName: activeUserId ? participantDisplayByUserId.get(activeUserId) || null : null,
    connectedAt: shared.connectedAt > 0 ? new Date(shared.connectedAt).toISOString() : null,
    lastAudioAt: shared.lastAudioAt > 0 ? new Date(shared.lastAudioAt).toISOString() : null,
    lastTranscriptAt: shared.lastTranscriptAt > 0 ? new Date(shared.lastTranscriptAt).toISOString() : null,
    idleMs,
    idleTtlMs,
    hasIdleTimer: Boolean(shared.idleTimer),
    pendingAudioBytes: Number(shared.pendingAudioBytes || 0),
    pendingAudioChunks: Array.isArray(shared.pendingAudioChunks) ? shared.pendingAudioChunks.length : 0,
    pendingCommitResolvers: Array.isArray(shared.pendingCommitResolvers) ? shared.pendingCommitResolvers.length : 0,
    pendingCommitRequests: Array.isArray(shared.pendingCommitRequests) ? shared.pendingCommitRequests.length : 0,
    transcriptByItemIds: shared.finalTranscriptsByItemId instanceof Map ? shared.finalTranscriptsByItemId.size : 0,
    speakerByItemIds: shared.itemIdToUserId instanceof Map ? shared.itemIdToUserId.size : 0,
    utterance: shared.utterance
      ? {
        partialText: String(shared.utterance.partialText || "").slice(0, 200),
        finalSegments: Array.isArray(shared.utterance.finalSegments) ? shared.utterance.finalSegments.length : 0,
        bytesSent: Number(shared.utterance.bytesSent || 0)
      }
      : null,
    model: String(
      shared.client?.sessionConfig?.inputTranscriptionModel ||
      session.openAiPerUserAsrModel ||
      ""
    ).trim() || null,
    sessionId: shared.client?.sessionId || null
  };
}

export function buildVoiceRuntimeSnapshot(
  sessions: Map<string, VoiceSession>,
  deps: VoiceRuntimeSnapshotDeps
) {
  const runtimeSessions = [...sessions.values()].map((session) => {
    const now = Date.now();
    const participants = deps.getVoiceChannelParticipants(session);
    const participantDisplayByUserId = new Map(
      participants.map((entry) => [String(entry?.userId || ""), String(entry?.displayName || "")])
    );
    const membershipEvents = deps.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const activeCaptureEntries = session.userCaptures instanceof Map
      ? [...session.userCaptures.entries()]
      : [];
    const activeCaptures = activeCaptureEntries
      .map(([rawUserId, rawCapture]) => {
        const userId = String(rawUserId || "").trim();
        if (!userId) return null;
        const capture = rawCapture && typeof rawCapture === "object" ? rawCapture : null;
        const startedAtMs = Number(capture && "startedAt" in capture ? capture.startedAt : 0);
        const startedAt = Number.isFinite(startedAtMs) && startedAtMs > 0
          ? new Date(startedAtMs).toISOString()
          : null;
        const ageMs = Number.isFinite(startedAtMs) && startedAtMs > 0
          ? Math.max(0, Math.round(now - startedAtMs))
          : null;
        const participantDisplayName = String(participantDisplayByUserId.get(userId) || "").trim();
        const membershipDisplayName = String(
          membershipEvents
            .slice()
            .reverse()
            .find((entry) => String(entry?.userId || "") === userId)
            ?.displayName || ""
        ).trim();
        const cachedUser = deps.client?.users?.cache?.get?.(userId) || null;
        const cachedDisplayName = String(
          cachedUser?.displayName ||
          cachedUser?.globalName ||
          cachedUser?.username ||
          ""
        ).trim();
        const displayName = participantDisplayName || membershipDisplayName || cachedDisplayName || null;
        return {
          userId,
          displayName,
          startedAt,
          ageMs
        };
      })
      .filter((entry) => entry !== null);
    const sessionFactProfiles = session.factProfiles instanceof Map
      ? [...session.factProfiles.entries()]
      : [];
    const memoryFactProfiles = sessionFactProfiles
      .map(([rawUserId, rawProfile]) => {
        const userId = String(rawUserId || "").trim();
        if (!userId) return null;
        const profile = rawProfile && typeof rawProfile === "object" ? rawProfile : null;
        const participantDisplayName = String(participantDisplayByUserId.get(userId) || "").trim();
        const membershipDisplayName = String(
          membershipEvents
            .slice()
            .reverse()
            .find((entry) => String(entry?.userId || "") === userId)
            ?.displayName || ""
        ).trim();
        const cachedUser = deps.client?.users?.cache?.get?.(userId) || null;
        const cachedDisplayName = String(
          cachedUser?.displayName ||
          cachedUser?.globalName ||
          cachedUser?.username ||
          ""
        ).trim();
        const displayName = participantDisplayName || membershipDisplayName || cachedDisplayName || null;
        const loadedAtMs = Number(profile && "loadedAt" in profile ? profile.loadedAt : 0);
        return {
          userId,
          displayName,
          loadedAt: Number.isFinite(loadedAtMs) && loadedAtMs > 0
            ? new Date(loadedAtMs).toISOString()
            : null,
          userFacts: Array.isArray(profile && "userFacts" in profile ? profile.userFacts : null)
            ? (profile.userFacts as unknown[])
              .map((row) => buildMemoryFactSnapshot(row))
              .filter((row) => row !== null)
            : []
        };
      })
      .filter((entry) => entry !== null);
    const guildFactProfile = session.guildFactProfile && typeof session.guildFactProfile === "object"
      ? {
          loadedAt: Number(session.guildFactProfile.loadedAt || 0) > 0
            ? new Date(Number(session.guildFactProfile.loadedAt)).toISOString()
            : null,
          selfFacts: Array.isArray(session.guildFactProfile.selfFacts)
            ? session.guildFactProfile.selfFacts
              .map((row) => buildMemoryFactSnapshot(row))
              .filter((row) => row !== null)
            : [],
          loreFacts: Array.isArray(session.guildFactProfile.loreFacts)
            ? session.guildFactProfile.loreFacts
              .map((row) => buildMemoryFactSnapshot(row))
              .filter((row) => row !== null)
            : []
        }
      : null;
    const wakeContext = deps.buildVoiceConversationContext({
      session,
      now
    });
    const addressingState = deps.buildVoiceAddressingState({
      session,
      now
    });
    const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    const deferredQueue = deps.deferredActionQueue.getDeferredQueuedUserTurns(session);
    const generationSummary =
      session.modelContextSummary && typeof session.modelContextSummary === "object"
        ? session.modelContextSummary.generation || null
        : null;
    const deciderSummary =
      session.modelContextSummary && typeof session.modelContextSummary === "object"
        ? session.modelContextSummary.decider || null
        : null;
    const streamWatchRawEntries: StreamWatchNoteEntry[] = Array.isArray(session.streamWatch?.noteEntries)
      ? session.streamWatch.noteEntries
      : [];
    const streamWatchVisualFeed = streamWatchRawEntries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const text = String(entry.text || "").trim();
        if (!text) return null;
        const atMs = Number(entry.at || 0);
        return {
          text: text.slice(0, 220),
          at: Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : null,
          provider: String(entry.provider || "").trim() || null,
          model: String(entry.model || "").trim() || null,
          speakerName: String(entry.speakerName || "").trim() || null
        };
      })
      .filter((entry) => entry !== null);
    const streamWatchNotes = deps.getStreamWatchNotesForPrompt(
      session,
      session.settingsSnapshot || null
    );
    const activeRealtimeInstructions = String(session.lastRealtimeInstructions || session.baseVoiceInstructions || "").trim();
    const instructionsPromptState = activeRealtimeInstructions
      ? {
          updatedAt: toIsoOrNull(session.lastRealtimeInstructionsAt || session.startedAt),
          source: session.lastRealtimeInstructionsAt > 0 ? "realtime_instruction_refresh" : "session_start",
          replyPrompts: normalizeLoggedPromptBundle(
            buildSingleTurnPromptLog({
              systemPrompt: activeRealtimeInstructions,
              userPrompt: ""
            })
          )
        }
      : null;
    const durableContext: VoiceRuntimeSnapshotDurableContextEntry[] = (Array.isArray(session.durableContext) ? session.durableContext : [])
      .map((entry) => {
        const text = String(entry?.text || "").replace(/\s+/g, " ").trim();
        if (!text) return null;
        const rawCategory = String(entry?.category || "").trim().toLowerCase();
        const category: VoiceSessionDurableContextCategory =
          rawCategory === "plan" ||
          rawCategory === "preference" ||
          rawCategory === "relationship"
            ? rawCategory
            : "fact";
        const atMs = Number(entry?.at || 0);
        return {
          text: text.slice(0, 240),
          category,
          at: Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : null
        };
      })
      .filter((entry): entry is VoiceRuntimeSnapshotDurableContextEntry => entry !== null)
      .slice(-50);
    const streamWatchLatestFrameDataBase64 = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
    const streamWatchLatestFrameApproxBytes = streamWatchLatestFrameDataBase64
      ? Math.max(0, Math.floor((streamWatchLatestFrameDataBase64.length * 3) / 4))
      : 0;
    const nativeDiscordScreenSharers = listActiveNativeDiscordScreenSharers(session).map((entry) => {
      const displayName = String(participantDisplayByUserId.get(entry.userId) || "").trim() || null;
      return {
        userId: entry.userId,
        displayName,
        codec: entry.codec || null,
        streamCount: entry.streams.length,
        lastFrameAt: toIsoOrNull(entry.lastFrameAt),
        updatedAt: toIsoOrNull(entry.updatedAt)
      };
    });

    return {
      sessionId: session.id,
      guildId: session.guildId,
      voiceChannelId: session.voiceChannelId,
      textChannelId: session.textChannelId,
      startedAt: new Date(session.startedAt).toISOString(),
      lastActivityAt: new Date(session.lastActivityAt).toISOString(),
      maxEndsAt: toIsoOrNull(session.maxEndsAt),
      inactivityEndsAt: toIsoOrNull(session.inactivityEndsAt),
      activeInputStreams: session.userCaptures.size,
      activeCaptures,
      soundboard: {
        playCount: session.soundboard?.playCount || 0,
        lastPlayedAt: toIsoOrNull(session.soundboard?.lastPlayedAt)
      },
      mode: session.mode || "voice_agent",
      realtimeToolOwnership: session.realtimeToolOwnership || "transport_only",
      botTurnOpen: Boolean(session.botTurnOpen),
      assistantOutput: {
        phase: deps.replyManager.syncAssistantOutputState(session, "runtime_state")?.phase || "idle",
        reason: session.assistantOutput?.reason || null,
        lastTrigger: session.assistantOutput?.lastTrigger || null,
        phaseEnteredAt: Number(session.assistantOutput?.phaseEnteredAt || 0) > 0
          ? new Date(Number(session.assistantOutput?.phaseEnteredAt || 0)).toISOString()
          : null,
        requestId: Number.isFinite(Number(session.assistantOutput?.requestId))
          ? Math.round(Number(session.assistantOutput?.requestId))
          : null,
        ttsPlaybackState: session.assistantOutput?.ttsPlaybackState || "idle",
        ttsBufferedSamples: Math.max(0, Number(session.assistantOutput?.ttsBufferedSamples || 0))
      },
      playbackArm: {
        armed: Boolean(session.playbackArmed),
        reason: session.playbackArmedReason || null,
        armedAt: toIsoOrNull(session.playbackArmedAt)
      },
      conversation: {
        lastAssistantReplyAt: toIsoOrNull(session.lastAssistantReplyAt),
        lastDirectAddressAt: toIsoOrNull(session.lastDirectAddressAt),
        lastDirectAddressUserId: session.lastDirectAddressUserId || null,
        musicWakeLatchedUntil: Number(session.musicWakeLatchedUntil || 0) > 0
          ? new Date(Number(session.musicWakeLatchedUntil)).toISOString()
          : null,
        musicWakeLatchedByUserId: session.musicWakeLatchedByUserId || null,
        wake: {
          attentionMode: wakeContext?.attentionMode || "AMBIENT",
          active: wakeContext?.attentionMode === "ACTIVE",
          currentSpeakerActive: Boolean(wakeContext?.currentSpeakerActive),
          recentAssistantReply: Boolean(wakeContext?.recentAssistantReply),
          recentDirectAddress: Boolean(wakeContext?.recentDirectAddress),
          msSinceAssistantReply: Number.isFinite(wakeContext?.msSinceAssistantReply)
            ? Math.round(wakeContext.msSinceAssistantReply)
            : null,
          msSinceDirectAddress: Number.isFinite(wakeContext?.msSinceDirectAddress)
            ? Math.round(wakeContext.msSinceDirectAddress)
            : null,
          windowMs: RECENT_ENGAGEMENT_WINDOW_MS
        },
        thoughtEngine: {
          busy: Boolean(session.thoughtLoopBusy),
          nextAttemptAt: toIsoOrNull(session.nextThoughtAt),
          lastAttemptAt: toIsoOrNull(session.lastThoughtAttemptAt),
          lastSpokenAt: toIsoOrNull(session.lastThoughtSpokenAt),
          pendingThought: session.pendingAmbientThought
            ? {
              id: String(session.pendingAmbientThought.id || ""),
              status: session.pendingAmbientThought.status || "queued",
              text: String(session.pendingAmbientThought.currentText || ""),
              draftText: String(session.pendingAmbientThought.draftText || ""),
              trigger: String(session.pendingAmbientThought.trigger || ""),
              createdAt: toIsoOrNull(session.pendingAmbientThought.createdAt),
              updatedAt: toIsoOrNull(session.pendingAmbientThought.updatedAt),
              basisAt: toIsoOrNull(session.pendingAmbientThought.basisAt),
              notBeforeAt: toIsoOrNull(session.pendingAmbientThought.notBeforeAt),
              expiresAt: toIsoOrNull(session.pendingAmbientThought.expiresAt),
              ageMs: Math.max(0, Math.round(now - Number(session.pendingAmbientThought.createdAt || now))),
              revision: Math.max(1, Number(session.pendingAmbientThought.revision || 1)),
              lastDecisionReason: session.pendingAmbientThought.lastDecisionReason || null,
              lastDecisionAction: session.pendingAmbientThought.lastDecisionAction || null,
              memoryFactCount: Math.max(0, Number(session.pendingAmbientThought.memoryFactCount || 0)),
              usedMemory: Boolean(session.pendingAmbientThought.usedMemory),
              invalidatedAt: toIsoOrNull(session.pendingAmbientThought.invalidatedAt),
              invalidatedByUserId: session.pendingAmbientThought.invalidatedByUserId || null,
              invalidationReason: session.pendingAmbientThought.invalidationReason || null
            }
            : null
        },
        addressing: addressingState,
        modelContext: {
          generation: generationSummary,
          decider: deciderSummary,
          trackedTurns: modelTurns.length,
          trackedTurnLimit: VOICE_DECIDER_HISTORY_MAX_TURNS,
          trackedTranscriptTurns: transcriptTurns.length
        }
      },
      participants: participants.map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName
      })),
      participantCount: participants.length,
      memory: {
        factProfiles: memoryFactProfiles,
        guildFactProfile
      },
      membershipEvents: membershipEvents.map((entry) => ({
        userId: entry.userId,
        displayName: entry.displayName,
        eventType: entry.eventType,
        at: new Date(entry.at).toISOString(),
        ageMs: Math.max(0, Math.round(entry.ageMs))
      })),
      pendingDeferredTurns: deferredQueue.length,
      recentTurns: transcriptTurns.slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS).map((turn) => ({
        kind: turn.kind || "speech",
        role: turn.role,
        speakerName: turn.speakerName || "",
        text: String(turn.text || ""),
        at: turn.at ? new Date(turn.at).toISOString() : null,
        addressing: buildRecentTurnAddressing(turn)
      })),
      durableContext,
      lastGenerationContext: session.lastGenerationContext || null,
      promptState: {
        instructions: instructionsPromptState,
        classifier: buildPromptSnapshotEntry(session.livePromptState?.classifier),
        generation: buildPromptSnapshotEntry(session.livePromptState?.generation),
        bridge: buildPromptSnapshotEntry(session.livePromptState?.bridge)
      },
      streamWatch: {
        active: Boolean(session.streamWatch?.active),
        targetUserId: session.streamWatch?.targetUserId || null,
        requestedByUserId: session.streamWatch?.requestedByUserId || null,
        lastFrameAt: toIsoOrNull(session.streamWatch?.lastFrameAt),
        lastCommentaryAt: toIsoOrNull(session.streamWatch?.lastCommentaryAt),
        lastCommentaryNote: session.streamWatch?.lastCommentaryNote || null,
        lastMemoryRecapAt: toIsoOrNull(session.streamWatch?.lastMemoryRecapAt),
        lastMemoryRecapText: session.streamWatch?.lastMemoryRecapText || null,
        lastMemoryRecapDurableSaved: Boolean(session.streamWatch?.lastMemoryRecapDurableSaved),
        lastMemoryRecapReason: session.streamWatch?.lastMemoryRecapReason || null,
        latestFrameAt: toIsoOrNull(session.streamWatch?.latestFrameAt),
        latestFrameMimeType: session.streamWatch?.latestFrameMimeType || null,
        latestFrameApproxBytes: streamWatchLatestFrameApproxBytes,
        acceptedFrameCountInWindow: Number(session.streamWatch?.acceptedFrameCountInWindow || 0),
        frameWindowStartedAt: toIsoOrNull(session.streamWatch?.frameWindowStartedAt),
        lastNoteAt: toIsoOrNull(session.streamWatch?.lastNoteAt),
        lastNoteProvider: session.streamWatch?.lastNoteProvider || null,
        lastNoteModel: session.streamWatch?.lastNoteModel || null,
        noteCount: Array.isArray(session.streamWatch?.noteEntries)
          ? session.streamWatch.noteEntries.length
          : 0,
        ingestedFrameCount: Number(session.streamWatch?.ingestedFrameCount || 0),
        visualFeed: streamWatchVisualFeed,
        notePayload: streamWatchNotes
          ? {
            prompt: String(streamWatchNotes.prompt || "").trim(),
            notes: Array.isArray(streamWatchNotes.notes)
              ? streamWatchNotes.notes
                .map((note) => String(note || "").trim())
                .filter(Boolean)
                .slice(-24)
              : [],
            lastAt: Number(streamWatchNotes.lastAt || 0)
              ? new Date(Number(streamWatchNotes.lastAt || 0)).toISOString()
              : null,
            provider: streamWatchNotes.provider || null,
            model: streamWatchNotes.model || null
          }
          : null,
        nativeDiscord: {
          activeSharerCount: nativeDiscordScreenSharers.length,
          subscribedTargetUserId: session.nativeScreenShare?.subscribedTargetUserId || null,
          decodeInFlight: Boolean(session.nativeScreenShare?.decodeInFlight),
          lastDecodeAttemptAt: toIsoOrNull(session.nativeScreenShare?.lastDecodeAttemptAt),
          lastDecodeSuccessAt: toIsoOrNull(session.nativeScreenShare?.lastDecodeSuccessAt),
          lastDecodeFailureAt: toIsoOrNull(session.nativeScreenShare?.lastDecodeFailureAt),
          lastDecodeFailureReason: session.nativeScreenShare?.lastDecodeFailureReason || null,
          ffmpegAvailable:
            typeof session.nativeScreenShare?.ffmpegAvailable === "boolean"
              ? session.nativeScreenShare.ffmpegAvailable
              : null,
          activeSharers: nativeDiscordScreenSharers
        }
      },
      asrSessions: buildAsrSessionsSnapshot(session, {
        now,
        participantDisplayByUserId
      }),
      sharedAsrSession: buildSharedAsrSessionSnapshot(session, {
        now,
        participantDisplayByUserId
      }),
      brainTools: (() => {
        if (session.realtimeToolOwnership !== "provider_native") return null;
        const tools = Array.isArray(session.realtimeToolDefinitions) ? session.realtimeToolDefinitions : [];
        if (!tools.length) return null;
        return tools.map((tool) => ({
          name: String(tool?.name || ""),
          toolType: tool?.toolType === "mcp" ? "mcp" : "function",
          serverName: tool?.serverName || null,
          description: String(tool?.description || "")
        }));
      })(),
      toolCalls: (() => {
        const events = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
        if (!events.length) return null;
        return events.slice(-OPENAI_TOOL_CALL_EVENT_MAX).map((entry) => ({
          callId: String(entry?.callId || ""),
          toolName: String(entry?.toolName || ""),
          toolType: entry?.toolType === "mcp" ? "mcp" : "function",
          arguments: entry?.arguments && typeof entry.arguments === "object" ? entry.arguments : {},
          startedAt: String(entry?.startedAt || ""),
          completedAt: entry?.completedAt ? String(entry.completedAt) : null,
          runtimeMs: Number.isFinite(Number(entry?.runtimeMs)) ? Math.round(Number(entry.runtimeMs)) : null,
          success: Boolean(entry?.success),
          outputSummary:
            entry?.outputSummary && typeof entry.outputSummary === "object"
              ? entry.outputSummary
              : entry?.outputSummary
                ? String(entry.outputSummary)
                : null,
          error: entry?.error ? String(entry.error) : null
        }));
      })(),
      mcpStatus: (() => {
        const rows = Array.isArray(session.mcpStatus) ? session.mcpStatus : [];
        if (!rows.length) return null;
        return rows.map((row) => ({
          serverName: String(row?.serverName || ""),
          connected: Boolean(row?.connected),
          tools: Array.isArray(row?.tools)
            ? row.tools.map((tool) => ({
              name: String(tool?.name || ""),
              description: String(tool?.description || "")
            }))
            : [],
          lastError: row?.lastError ? String(row.lastError) : null,
          lastConnectedAt: row?.lastConnectedAt ? String(row.lastConnectedAt) : null,
          lastCallAt: row?.lastCallAt ? String(row.lastCallAt) : null
        }));
      })(),
      music: deps.snapshotMusicRuntimeState(session),
      batchAsr: Number(session.pendingFileAsrTurns || 0) > 0
        ? {
          pendingTurns: Number(session.pendingFileAsrTurns || 0),
          contextMessages: modelTurns.length
        }
        : null,
      realtime: isRealtimeMode(session.mode)
        ? {
          provider: session.realtimeProvider || resolveRealtimeProvider(session.mode),
          inputSampleRateHz: Number(session.realtimeInputSampleRateHz) || 24000,
          outputSampleRateHz: Number(session.realtimeOutputSampleRateHz) || 24000,
          recentVoiceTurns: modelTurns.length,
          replySuperseded: Math.max(0, Number(session.realtimeReplySupersededCount || 0)),
          pendingTurns:
            (session.realtimeTurnDrainActive ? 1 : 0) +
            (Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0),
          drainActive: Boolean(session.realtimeTurnDrainActive),
          coalesceActive: Boolean(session.realtimeTurnCoalesceTimer),
          state: session.realtimeClient?.getState?.() || null
        }
        : null,
      latency: buildLatencySnapshot(session)
    };
  });

  return {
    activeCount: runtimeSessions.length,
    sessions: runtimeSessions
  };
}
