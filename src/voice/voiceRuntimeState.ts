import { clamp } from "../utils.ts";
import {
    OPENAI_TOOL_CALL_EVENT_MAX,
    VOICE_DECIDER_HISTORY_MAX_TURNS,
    VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
    VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS,
    OPENAI_ASR_SESSION_IDLE_TTL_MS,
    JOIN_GREETING_LLM_WINDOW_MS,
    RECENT_ENGAGEMENT_WINDOW_MS
} from "./voiceSessionManager.constants.ts";
import {
    isRealtimeMode,
    resolveRealtimeProvider,
    normalizeVoiceText
} from "./voiceSessionHelpers.ts";
import type { VoiceSessionManager } from "./voiceSessionManager.ts";

export function buildRuntimeStateSnapshot({
    manager
}: {
    manager: VoiceSessionManager;
}) {
    const sessions = [...manager.sessions.values()].map((session) => {
        const now = Date.now();
        const participants = manager.getVoiceChannelParticipants(session);
        const participantDisplayByUserId = new Map(
            participants.map((entry) => [String(entry?.userId || ""), String(entry?.displayName || "")])
        );
        const membershipEvents = manager.getRecentVoiceMembershipEvents(session, {
            maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
        });
        const activeCaptureEntries = session.userCaptures instanceof Map
            ? [...session.userCaptures.entries()]
            : [];
        const activeCaptures = activeCaptureEntries
            .map(([rawUserId, rawCapture]) => {
                const userId = String(rawUserId || "").trim();
                if (!userId) return null;
                const capture = rawCapture && typeof rawCapture === "object" ? rawCapture : {};
                const startedAtMs = Number(capture?.startedAt || 0);
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
                const cachedUser = manager.client?.users?.cache?.get?.(userId) || null;
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
            .filter(Boolean);
        const wakeContext = manager.buildVoiceConversationContext({
            session,
            now
        });
        const addressingState = manager.buildVoiceAddressingState({
            session,
            now
        });
        const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
        const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
        const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
        const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
        const deferredQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
        const generationSummary =
            session.modelContextSummary && typeof session.modelContextSummary === "object"
                ? session.modelContextSummary.generation || null
                : null;
        const deciderSummary =
            session.modelContextSummary && typeof session.modelContextSummary === "object"
                ? session.modelContextSummary.decider || null
                : null;
        const streamWatchRawEntries = Array.isArray(session.streamWatch?.brainContextEntries)
            ? session.streamWatch.brainContextEntries
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
            .filter(Boolean);
        const streamWatchBrainContext = manager.getStreamWatchBrainContextForPrompt(
            session,
            session.settingsSnapshot || null
        );
        const streamWatchLatestFrameDataBase64 = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
        const streamWatchLatestFrameApproxBytes = streamWatchLatestFrameDataBase64
            ? Math.max(0, Math.floor((streamWatchLatestFrameDataBase64.length * 3) / 4))
            : 0;

        return {
            sessionId: session.id,
            guildId: session.guildId,
            voiceChannelId: session.voiceChannelId,
            textChannelId: session.textChannelId,
            startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
            lastActivityAt: session.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : null,
            maxEndsAt: session.maxEndsAt ? new Date(session.maxEndsAt).toISOString() : null,
            inactivityEndsAt: session.inactivityEndsAt ? new Date(session.inactivityEndsAt).toISOString() : null,
            activeInputStreams: session.userCaptures.size,
            activeCaptures,
            soundboard: {
                playCount: session.soundboard?.playCount || 0,
                lastPlayedAt: session.soundboard?.lastPlayedAt
                    ? new Date(session.soundboard.lastPlayedAt).toISOString()
                    : null
            },
            mode: session.mode || "voice_agent",
            botTurnOpen: Boolean(session.botTurnOpen),
            playbackArm: {
                armed: Boolean(session.playbackArmed),
                reason: session.playbackArmedReason || null,
                armedAt: session.playbackArmedAt ? new Date(session.playbackArmedAt).toISOString() : null,
            },
            conversation: {
                lastAssistantReplyAt: session.lastAssistantReplyAt
                    ? new Date(session.lastAssistantReplyAt).toISOString()
                    : null,
                lastDirectAddressAt: session.lastDirectAddressAt
                    ? new Date(session.lastDirectAddressAt).toISOString()
                    : null,
                lastDirectAddressUserId: session.lastDirectAddressUserId || null,
                wake: {
                    state: wakeContext?.engaged ? "awake" : "listening",
                    active: Boolean(wakeContext?.engaged),
                    engagementState: wakeContext?.engagementState || "wake_word_biased",
                    engagedWithCurrentSpeaker: Boolean(wakeContext?.engagedWithCurrentSpeaker),
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
                joinWindow: {
                    active: joinWindowActive,
                    ageMs: Math.round(joinWindowAgeMs),
                    windowMs: JOIN_GREETING_LLM_WINDOW_MS,
                    greetingScheduled: Boolean(session.joinGreetingScheduled),
                    greetingTimerActive: Boolean(session.joinGreetingTimer),
                },
                thoughtEngine: {
                    busy: Boolean(session.thoughtLoopBusy),
                    nextAttemptAt: session.nextThoughtAt ? new Date(session.nextThoughtAt).toISOString() : null,
                    lastAttemptAt: session.lastThoughtAttemptAt
                        ? new Date(session.lastThoughtAttemptAt).toISOString()
                        : null,
                    lastSpokenAt: session.lastThoughtSpokenAt
                        ? new Date(session.lastThoughtSpokenAt).toISOString()
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
            participants: participants.map((p) => ({ userId: p.userId, displayName: p.displayName })),
            participantCount: participants.length,
            membershipEvents: membershipEvents.map((entry) => ({
                userId: entry.userId,
                displayName: entry.displayName,
                eventType: entry.eventType,
                at: new Date(entry.at).toISOString(),
                ageMs: Math.max(0, Math.round(entry.ageMs))
            })),
            voiceLookupBusyCount: Number(session.voiceLookupBusyCount || 0),
            pendingDeferredTurns: deferredQueue.length,
            recentTurns: transcriptTurns.slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS).map((t) => ({
                role: t.role,
                speakerName: t.speakerName || "",
                text: String(t.text || ""),
                at: t.at ? new Date(t.at).toISOString() : null,
                addressing:
                    t?.addressing && typeof t.addressing === "object"
                        ? {
                            talkingTo: t.addressing.talkingTo || null,
                            directedConfidence: Number.isFinite(Number(t.addressing.directedConfidence))
                                ? Number(clamp(Number(t.addressing.directedConfidence), 0, 1).toFixed(3))
                                : 0,
                            source: t.addressing.source || null,
                            reason: t.addressing.reason || null
                        }
                        : null
            })),
            lastGenerationContext: session.lastGenerationContext || null,
            streamWatch: {
                active: Boolean(session.streamWatch?.active),
                targetUserId: session.streamWatch?.targetUserId || null,
                requestedByUserId: session.streamWatch?.requestedByUserId || null,
                lastFrameAt: session.streamWatch?.lastFrameAt
                    ? new Date(session.streamWatch.lastFrameAt).toISOString()
                    : null,
                lastCommentaryAt: session.streamWatch?.lastCommentaryAt
                    ? new Date(session.streamWatch.lastCommentaryAt).toISOString()
                    : null,
                latestFrameAt: session.streamWatch?.latestFrameAt
                    ? new Date(session.streamWatch.latestFrameAt).toISOString()
                    : null,
                latestFrameMimeType: session.streamWatch?.latestFrameMimeType || null,
                latestFrameApproxBytes: streamWatchLatestFrameApproxBytes,
                acceptedFrameCountInWindow: Number(session.streamWatch?.acceptedFrameCountInWindow || 0),
                frameWindowStartedAt: session.streamWatch?.frameWindowStartedAt
                    ? new Date(session.streamWatch.frameWindowStartedAt).toISOString()
                    : null,
                lastBrainContextAt: session.streamWatch?.lastBrainContextAt
                    ? new Date(session.streamWatch.lastBrainContextAt).toISOString()
                    : null,
                lastBrainContextProvider: session.streamWatch?.lastBrainContextProvider || null,
                lastBrainContextModel: session.streamWatch?.lastBrainContextModel || null,
                brainContextCount: Array.isArray(session.streamWatch?.brainContextEntries)
                    ? session.streamWatch.brainContextEntries.length
                    : 0,
                ingestedFrameCount: Number(session.streamWatch?.ingestedFrameCount || 0),
                visualFeed: streamWatchVisualFeed,
                brainContextPayload: streamWatchBrainContext
                    ? {
                        prompt: String(streamWatchBrainContext.prompt || "").trim(),
                        notes: Array.isArray(streamWatchBrainContext.notes)
                            ? streamWatchBrainContext.notes
                                .map((note) => String(note || "").trim())
                                .filter(Boolean)
                                .slice(-24)
                            : [],
                        lastAt: Number(streamWatchBrainContext.lastAt || 0)
                            ? new Date(Number(streamWatchBrainContext.lastAt)).toISOString()
                            : null,
                        provider: streamWatchBrainContext.provider || null,
                        model: streamWatchBrainContext.model || null
                    }
                    : null
            },
            asrSessions: (() => {
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
                        closing: Boolean(asr.closing),
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
            })(),
            sharedAsrSession: (() => {
                const shared = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
                    ? session.openAiSharedAsrState
                    : null;
                if (!shared) return null;
                const ws = shared?.client?.ws;
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
                    closing: Boolean(shared.closing),
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
            })(),
            brainTools: (() => {
                const tools = Array.isArray(session.openAiToolDefinitions) ? session.openAiToolDefinitions : [];
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
                    outputSummary: entry?.outputSummary ? String(entry.outputSummary) : null,
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
            music: manager.snapshotMusicRuntimeState(session),
            stt: session.mode === "stt_pipeline"
                ? {
                    pendingTurns: Number(session.pendingSttTurns || 0),
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
            latency: (() => {
                const stages = Array.isArray(session.latencyStages) ? session.latencyStages : [];
                if (stages.length === 0) return null;
                const recentTurns = stages.slice(-8).reverse().map((e) => ({
                    at: new Date(e.at).toISOString(),
                    finalizedToAsrStartMs: e.finalizedToAsrStartMs ?? null,
                    asrToGenerationStartMs: e.asrToGenerationStartMs ?? null,
                    generationToReplyRequestMs: e.generationToReplyRequestMs ?? null,
                    replyRequestToAudioStartMs: e.replyRequestToAudioStartMs ?? null,
                    totalMs: e.totalMs ?? null,
                    queueWaitMs: e.queueWaitMs ?? null,
                    pendingQueueDepth: e.pendingQueueDepth ?? null
                }));
                const avg = (field: any) => {
                    const vals = stages.map((e) => e[field]).filter((v) => Number.isFinite(v) && v >= 0);
                    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
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
            })()
        };
    });

    return {
        activeCount: sessions.length,
        sessions
    };
}
