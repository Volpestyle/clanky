import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";
import {
    OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
    normalizeOpenAiRealtimeTranscriptionModel,
    resolveVoiceAsrLanguageGuidance,
    normalizeVoiceText,
    normalizeInlineText,
    STT_TRANSCRIPT_MAX_CHARS
} from "./voiceSessionHelpers.ts";
import type { VoiceSession } from "./voiceSessionTypes.ts";

export type AsrSessionMode = "per_user" | "shared";

export interface EnsureAsrSessionOptions {
    session: VoiceSession;
    asrState: any;
    mode: AsrSessionMode;
    settings?: any;
    userId?: string | null;
    appConfig: any;
    store: any;
    runtimeLogger: any;
    orderFinalSegments: (entries: any[]) => string[];
    resolveSpeakerUserId?: (opts: any) => string | null;
    resolveSpeakerName: (session: VoiceSession, userId: string | null) => string;
    onConnected?: (asrState: any) => Promise<void>;
    onConnectFailed?: (asrState: any, error: any) => Promise<void>;
}

export async function ensureOpenAiAsrSessionConnected({
    session,
    asrState,
    mode,
    settings = null,
    userId = null,
    appConfig,
    store,
    runtimeLogger,
    orderFinalSegments,
    resolveSpeakerUserId,
    resolveSpeakerName,
    onConnected,
    onConnectFailed
}: EnsureAsrSessionOptions): Promise<any | null> {
    if (!session || session.ending) return null;
    if (!asrState || asrState.closing) return null;

    const ws = asrState.client?.ws;
    if (ws && ws.readyState === 1) {
        return asrState;
    }

    if (asrState.connectPromise) {
        await asrState.connectPromise.catch(() => undefined);
        return asrState.client ? asrState : null;
    }

    const resolvedSettings = settings || session.settingsSnapshot || store.getSettings();
    const voiceAsrGuidance = resolveVoiceAsrLanguageGuidance(resolvedSettings);
    const modelName = String(
        session.openAiPerUserAsrModel ||
        resolvedSettings?.voice?.openaiRealtime?.inputTranscriptionModel ||
        OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    )
        .trim()
        .slice(0, 120);
    const normalizedModel = normalizeOpenAiRealtimeTranscriptionModel(
        modelName,
        OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const language = String(
        session.openAiPerUserAsrLanguage || voiceAsrGuidance.language || ""
    )
        .trim()
        .toLowerCase()
        .replace(/_/g, "-")
        .slice(0, 24);
    const prompt = String(session.openAiPerUserAsrPrompt || voiceAsrGuidance.prompt || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280);

    let client: any;
    if (mode === "per_user" && session.subprocessClient) {
        client = {
            on: (event: string, handler: any) => {
                if (!asrState._eventHandlers) {
                    asrState._eventHandlers = new Map();
                }
                if (!asrState._eventHandlers.has(event)) {
                    asrState._eventHandlers.set(event, []);
                }
                asrState._eventHandlers.get(event).push(handler);
            },
            emit: (event: string, payload: any) => {
                const handlers = asrState._eventHandlers?.get(event) || [];
                for (const h of handlers) {
                    try {
                        h(payload);
                    } catch (e) {
                        try {
                            runtimeLogger?.({ level: "warn", event: "mock_asr_event_error", metadata: { event, error: String(e) } });
                        } catch { /* ignore */ }
                    }
                }
            },
            connect: async () => {
                const tUserId = String(userId || "").trim();
                session.subprocessClient.connectAsr({
                    userId: tUserId,
                    apiKey: appConfig.openaiApiKey,
                    model: normalizedModel,
                    language: language || null,
                    prompt: prompt || null
                });
                if (!asrState.wiredToSubprocess) {
                    asrState.wiredToSubprocess = true;
                    // Translates Rust subprocess asrTranscript events into the shape expected below
                    session.subprocessClient.on("asrTranscript", (evtUserId: string, text: string, isFinal: boolean) => {
                        if (evtUserId === tUserId) {
                            client.emit("transcript", {
                                text,
                                final: isFinal,
                                eventType: isFinal ? "conversation.item.input_audio_transcription.completed" : "conversation.item.input_audio_transcription.delta"
                            });
                        }
                    });
                }
            },
            commitInputAudioBuffer: () => {
                session.subprocessClient.commitAsr(String(userId || "").trim());
            },
            clearInputAudioBuffer: () => {
                session.subprocessClient.clearAsr(String(userId || "").trim());
            },
            appendInputAudioPcm: () => {
                // No-op: The Rust subprocess natively pushes audio to the websocket
            },
            close: async () => {
                session.subprocessClient.disconnectAsr(String(userId || "").trim());
            }
        };
    } else {
        client = new OpenAiRealtimeTranscriptionClient({
            apiKey: appConfig.openaiApiKey,
            logger: runtimeLogger
        });
    }

    asrState.client = client;

    asrState.connectPromise = (async () => {
        if (mode === "shared") {
            client.on("event", (event: any) => {
                if (session.ending || !event || typeof event !== "object") return;
                if (event.type === "input_audio_buffer.committed") {
                    const itemId = event.item_id || event.item?.id;
                    if (itemId && Array.isArray(asrState.committingItemIds)) {
                        asrState.committingItemIds.push(String(itemId));
                    }
                }
            });
        }

        client.on("transcript", (payload: any) => {
            if (session.ending) return;
            const transcript = normalizeVoiceText(payload?.text || "", STT_TRANSCRIPT_MAX_CHARS);
            if (!transcript) return;

            const eventType = String(payload?.eventType || "").trim();
            const isFinal = Boolean(payload?.final);
            const itemId = normalizeInlineText(payload?.itemId, 180);
            const previousItemId = normalizeInlineText(payload?.previousItemId, 180) || null;
            const now = Date.now();

            asrState.lastTranscriptAt = now;
            if (asrState.utterance) {
                asrState.utterance.lastUpdateAt = now;
            }

            if (isFinal) {
                if (itemId) {
                    const entries = Array.isArray(asrState.utterance?.finalSegmentEntries)
                        ? asrState.utterance.finalSegmentEntries
                        : [];
                    const nextEntry = {
                        itemId,
                        previousItemId,
                        text: transcript,
                        receivedAt: now
                    };
                    const existingIndex = entries.findIndex((entry: any) => String(entry?.itemId || "") === itemId);
                    if (existingIndex >= 0) {
                        entries[existingIndex] = nextEntry;
                    } else {
                        entries.push(nextEntry);
                    }
                    if (asrState.utterance) {
                        asrState.utterance.finalSegmentEntries = entries;
                        asrState.utterance.finalSegments = orderFinalSegments(entries);
                    }

                    if (mode === "shared") {
                        if (!(asrState.finalTranscriptsByItemId instanceof Map)) {
                            asrState.finalTranscriptsByItemId = new Map();
                        }
                        asrState.finalTranscriptsByItemId.set(itemId, transcript);
                        if (asrState.finalTranscriptsByItemId.size > 320) {
                            const overflow = asrState.finalTranscriptsByItemId.size - 320;
                            let dropped = 0;
                            for (const staleItemId of asrState.finalTranscriptsByItemId.keys()) {
                                asrState.finalTranscriptsByItemId.delete(staleItemId);
                                dropped += 1;
                                if (dropped >= overflow) break;
                            }
                        }
                    }
                } else if (asrState.utterance) {
                    asrState.utterance.finalSegments.push(transcript);
                }
                if (asrState.utterance) {
                    asrState.utterance.partialText = "";
                }
            } else if (asrState.utterance) {
                asrState.utterance.partialText = transcript;
            }

            let transcriptSpeakerUserId: string | null = userId;
            if (mode === "shared" && resolveSpeakerUserId) {
                transcriptSpeakerUserId = resolveSpeakerUserId({
                    session,
                    asrState,
                    itemId,
                    fallbackUserId: asrState.userId
                });
            }

            const speakerName = resolveSpeakerName(session, transcriptSpeakerUserId) || "someone";
            const shouldLogPartial =
                !isFinal &&
                transcript !== asrState.lastPartialText &&
                now - Number(asrState.lastPartialLogAt || 0) >= 180;

            if (isFinal || shouldLogPartial) {
                if (!isFinal) {
                    asrState.lastPartialLogAt = now;
                    asrState.lastPartialText = transcript;
                }
                store.logAction({
                    kind: "voice_runtime",
                    guildId: session.guildId,
                    channelId: session.textChannelId,
                    userId: transcriptSpeakerUserId ? String(transcriptSpeakerUserId).trim() : null,
                    content: isFinal ? "openai_realtime_asr_final_segment" : "openai_realtime_asr_partial_segment",
                    metadata: {
                        sessionId: session.id,
                        speakerName,
                        transcript,
                        eventType: eventType || null,
                        itemId: itemId || null,
                        previousItemId
                    }
                });
            }
        });

        client.on("error_event", (payload: any) => {
            if (session.ending) return;
            const errorUserId = mode === "shared" ? asrState.userId : String(userId || "").trim();
            store.logAction({
                kind: "voice_error",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: errorUserId || null,
                content: `openai_realtime_asr_error: ${String(payload?.message || "unknown error")}`,
                metadata: {
                    sessionId: session.id,
                    code: payload?.code || null,
                    param: payload?.param || null
                }
            });
        });

        client.on("socket_closed", (payload: any) => {
            if (session.ending) return;
            const closedUserId = mode === "shared" ? asrState.userId : String(userId || "").trim();
            store.logAction({
                kind: "voice_runtime",
                guildId: session.guildId,
                channelId: session.textChannelId,
                userId: closedUserId || null,
                content: "openai_realtime_asr_socket_closed",
                metadata: {
                    sessionId: session.id,
                    code: Number(payload?.code || 0) || null,
                    reason: String(payload?.reason || "").trim() || null
                }
            });
        });

        await client.connect({
            model: normalizedModel,
            inputAudioFormat: "pcm16",
            inputTranscriptionModel: normalizedModel,
            inputTranscriptionLanguage: language,
            inputTranscriptionPrompt: prompt
        });

        asrState.connectedAt = Date.now();

        if (onConnected) {
            await onConnected(asrState);
        }
    })();

    try {
        await asrState.connectPromise;
        return asrState;
    } catch (error: any) {
        const errorUserId = mode === "shared" ? asrState.userId : String(userId || "").trim();
        store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: errorUserId || null,
            content: `openai_realtime_asr_connect_failed: ${String(error?.message || error)}`,
            metadata: {
                sessionId: session.id
            }
        });

        if (onConnectFailed) {
            await onConnectFailed(asrState, error);
        }
        return null;
    } finally {
        asrState.connectPromise = null;
    }
}
