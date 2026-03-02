import { OpenAiRealtimeTranscriptionClient } from "./openaiRealtimeTranscriptionClient.ts";
import { normalizeVoiceText, resolveVoiceAsrLanguageGuidance, getRealtimeCommitMinimumBytes } from "./voiceSessionHelpers.ts";
import { normalizeInlineText, OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL, normalizeOpenAiRealtimeTranscriptionModel } from "./voiceSessionManager.ts";
import { STT_TRANSCRIPT_MAX_CHARS, OPENAI_ASR_SESSION_IDLE_TTL_MS, OPENAI_ASR_TRANSCRIPT_STABLE_MS, OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS } from "./voiceSessionManager.constants.ts";

export function injectAsrMethods(target: any) {

      target.prototype.getOpenAiSharedAsrState = function(session) {
    if (!session || session.ending) return null;
    if (!session.openAiSharedAsrState) {
      session.openAiSharedAsrState = {
        userId: null,
        client: null,
        connectPromise: null,
        closing: false,
        isCommittingAsr: false,
        committingUtteranceId: 0,
        pendingAudioChunks: [],
        pendingAudioBytes: 0,
        connectedAt: 0,
        lastAudioAt: 0,
        lastTranscriptAt: 0,
        lastPartialLogAt: 0,
        lastPartialText: "",
        idleTimer: null,
        utterance: {
          id: 0,
          startedAt: 0,
          bytesSent: 0,
          partialText: "",
          finalSegments: [],
          finalSegmentEntries: [],
          lastUpdateAt: 0
        },
        itemIdToUserId: new Map(),
        finalTranscriptsByItemId: new Map(),
        pendingCommitResolvers: [],
        pendingCommitRequests: []
      };
    }
    return session.openAiSharedAsrState;
      };

      target.prototype.getOpenAiAsrSessionMap = function(session) {
    if (!session || session.ending) return null;
    if (!(session.openAiAsrSessions instanceof Map)) {
      session.openAiAsrSessions = new Map();
    }
    return session.openAiAsrSessions;
      };

      target.prototype.getOrCreateOpenAiAsrSessionState = function({ session, userId }) {
    const sessionMap = this.getOpenAiAsrSessionMap(session);
    const normalizedUserId = String(userId || "").trim();
    if (!sessionMap || !normalizedUserId) return null;
    const existing = sessionMap.get(normalizedUserId);
    if (existing && typeof existing === "object") {
      return existing;
    }

    const state = {
      userId: normalizedUserId,
      client: null,
      connectPromise: null,
      closing: false,
      isCommittingAsr: false,
      committingUtteranceId: 0,
      pendingAudioChunks: [],
      pendingAudioBytes: 0,
      connectedAt: 0,
      lastAudioAt: 0,
      lastTranscriptAt: 0,
      lastPartialLogAt: 0,
      lastPartialText: "",
      idleTimer: null,
      utterance: {
        id: 0,
        startedAt: 0,
        bytesSent: 0,
        partialText: "",
        finalSegments: [],
        finalSegmentEntries: [],
        lastUpdateAt: 0
      }
    };
    sessionMap.set(normalizedUserId, state);
    return state;
      };

      target.prototype.createOpenAiAsrRuntimeLogger = function(session, userId) {
    return ({ level, event, metadata }) => {
      this.store.logAction({
        kind: level === "warn" ? "voice_error" : "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: String(userId || "").trim() || this.client.user?.id || null,
        content: event,
        metadata: {
          sessionId: session.id,
          ...(metadata && typeof metadata === "object" ? metadata : {})
        }
      });
    };
      };

      target.prototype.orderOpenAiAsrFinalSegments = function(entries = []) {
    const normalizedEntries = Array.isArray(entries)
      ? entries
        .map((entry, index) => ({
          itemId: normalizeInlineText(entry?.itemId, 180),
          previousItemId: normalizeInlineText(entry?.previousItemId, 180) || null,
          text: normalizeVoiceText(entry?.text || "", STT_TRANSCRIPT_MAX_CHARS),
          receivedAt: Math.max(0, Number(entry?.receivedAt || 0)),
          index
        }))
        .filter((entry) => entry.itemId && entry.text)
      : [];
    if (normalizedEntries.length <= 1) {
      return normalizedEntries.map((entry) => entry.text);
    }

    const byId = new Map();
    for (const entry of normalizedEntries) {
      byId.set(entry.itemId, entry);
    }
    const sorted = [...byId.values()].sort((a, b) => {
      const delta = Number(a.receivedAt || 0) - Number(b.receivedAt || 0);
      if (delta !== 0) return delta;
      return Number(a.index || 0) - Number(b.index || 0);
    });

    const placed = new Set();
    const ordered = [];
    while (ordered.length < sorted.length) {
      let progressed = false;
      for (const entry of sorted) {
        if (placed.has(entry.itemId)) continue;
        const previousItemId = String(entry.previousItemId || "");
        if (!previousItemId || !byId.has(previousItemId) || placed.has(previousItemId)) {
          placed.add(entry.itemId);
          ordered.push(entry.text);
          progressed = true;
        }
      }
      if (progressed) continue;
      // Fall back to arrival order if chain is incomplete/cyclic.
      for (const entry of sorted) {
        if (placed.has(entry.itemId)) continue;
        placed.add(entry.itemId);
        ordered.push(entry.text);
      }
    }

    return ordered;
      };

      target.prototype.closeAllOpenAiAsrSessions = async function(session, reason = "session_end") {
    if (!session) return;
    const sessionMap = this.getOpenAiAsrSessionMap(session);
    if (!sessionMap || sessionMap.size <= 0) return;
    const userIds = [...sessionMap.keys()];
    for (const userId of userIds) {
      await this.closeOpenAiAsrSession({
        session,
        userId,
        reason
      });
    }
      };

      target.prototype.getOpenAiSharedAsrPendingCommitRequests = function(asrState) {
    if (!asrState || typeof asrState !== "object") return [];
    const pendingCommitRequests = Array.isArray(asrState.pendingCommitRequests)
      ? asrState.pendingCommitRequests
      : [];
    asrState.pendingCommitRequests = pendingCommitRequests;
    return pendingCommitRequests;
      };

      target.prototype.pruneOpenAiSharedAsrPendingCommitRequests = function(asrState, maxAgeMs = 30_000) {
    const pendingCommitRequests = this.getOpenAiSharedAsrPendingCommitRequests(asrState);
    if (!pendingCommitRequests.length) return pendingCommitRequests;
    const maxAge = Math.max(1_000, Number(maxAgeMs) || 30_000);
    const now = Date.now();
    while (pendingCommitRequests.length > 0) {
      const head = pendingCommitRequests[0];
      const requestedAt = Math.max(0, Number(head?.requestedAt || 0));
      if (requestedAt > 0 && now - requestedAt <= maxAge) break;
      pendingCommitRequests.shift();
    }
    return pendingCommitRequests;
      };

      target.prototype.scheduleOpenAiSharedAsrSessionIdleClose = function(session) {
    if (!session || session.ending) return;
    const asrState = this.getOpenAiSharedAsrState(session);
    if (!asrState) return;
    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }
    const ttlMs = Math.max(
      1_000,
      Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
    );
    asrState.idleTimer = setTimeout(() => {
      asrState.idleTimer = null;
      this.closeOpenAiSharedAsrSession(session, "idle_ttl").catch(() => undefined);
    }, ttlMs);
      };

      target.prototype.releaseOpenAiSharedAsrActiveUser = function(session, userId = null) {
    if (!session || session.ending) return;
    const asrState = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
      ? session.openAiSharedAsrState
      : null;
    if (!asrState) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId || String(asrState.userId || "").trim() === normalizedUserId) {
      asrState.userId = null;
    }
      };

      target.prototype.tryHandoffSharedAsrToWaitingCapture = function({ session, settings = null }) {
    if (!session || session.ending) return false;
    if (!this.shouldUseOpenAiSharedTranscription({ session, settings })) return false;
    const asrState = this.getOpenAiSharedAsrState(session);
    if (!asrState || asrState.closing) return false;
    if (asrState.userId) return false;

    for (const [candidateUserId, captureState] of session.userCaptures) {
      if (!captureState || !candidateUserId) continue;
      if (Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) > 0) continue;
      if (Math.max(0, Number(captureState.bytesSent || 0)) <= 0) continue;

      const began = this.beginOpenAiSharedAsrUtterance({
        session,
        settings,
        userId: candidateUserId
      });
      if (!began) continue;

      const chunks = Array.isArray(captureState.pcmChunks) ? captureState.pcmChunks : [];
      if (chunks.length <= 0) {
        this.releaseOpenAiSharedAsrActiveUser(session, candidateUserId);
        continue;
      }
      let replayedChunks = 0;
      let replayedBytes = 0;
      for (const chunk of chunks) {
        if (!chunk || !chunk.length) continue;
        const appended = this.appendAudioToOpenAiSharedAsr({
          session,
          settings,
          userId: candidateUserId,
          pcmChunk: chunk
        });
        if (appended) {
          replayedChunks += 1;
          replayedBytes += chunk.length;
          captureState.sharedAsrBytesSent =
            Math.max(0, Number(captureState.sharedAsrBytesSent || 0)) + chunk.length;
        }
      }
      if (replayedChunks <= 0 || replayedBytes <= 0) {
        this.releaseOpenAiSharedAsrActiveUser(session, candidateUserId);
        continue;
      }

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: candidateUserId,
        content: "openai_shared_asr_handoff",
        metadata: {
          sessionId: session.id,
          replayedChunks,
          replayedBytes
        }
      });
      return true;
    }
    return false;
      };

      target.prototype.closeOpenAiSharedAsrSession = async function(session, reason = "manual") {
    if (!session) return;
    const state = session.openAiSharedAsrState && typeof session.openAiSharedAsrState === "object"
      ? session.openAiSharedAsrState
      : null;
    if (!state) return;
    state.closing = true;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const pendingResolvers = Array.isArray(state.pendingCommitResolvers) ? state.pendingCommitResolvers : [];
    while (pendingResolvers.length > 0) {
      const entry = pendingResolvers.shift();
      if (entry && typeof entry.resolve === "function") {
        entry.resolve("");
      }
    }
    session.openAiSharedAsrState = null;

    try {
      await state.client?.close?.();
    } catch {
      // ignore
    }

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: String(state.userId || "").trim() || null,
      content: "openai_realtime_asr_session_closed",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "manual")
      }
    });
      };

      target.prototype.flushPendingOpenAiAsrAudio = async function({
        session,
        userId,
        asrState = null,
        utteranceId = null
      }) {
    const state = asrState && typeof asrState === "object"
      ? asrState
      : this.getOrCreateOpenAiAsrSessionState({
        session,
        userId
      });
    if (!state || state.closing) return;
    const client = state.client;
    if (!client || !client.ws || client.ws.readyState !== 1) return;
    const targetUtteranceId = Math.max(
      0,
      Number(
        utteranceId !== null && utteranceId !== undefined
          ? utteranceId
          : state.utterance?.id || 0
      )
    );
    if (!targetUtteranceId) return;
    const committingUtteranceId = Math.max(0, Number(state.committingUtteranceId || 0));
    if (
      state.isCommittingAsr &&
      committingUtteranceId > 0 &&
      targetUtteranceId !== committingUtteranceId
    ) {
      return;
    }
    const chunks = Array.isArray(state.pendingAudioChunks) ? state.pendingAudioChunks : [];
    if (!chunks.length) return;

    const remainingChunks = [];
    while (chunks.length > 0) {
      const entry = chunks.shift();
      if (!entry || !Buffer.isBuffer(entry.chunk)) continue;
      if (Number(entry.utteranceId || 0) !== targetUtteranceId) {
        remainingChunks.push(entry);
        continue;
      }
      try {
        client.appendInputAudioPcm(entry.chunk);
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: `openai_realtime_asr_audio_append_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        break;
      }
    }
    state.pendingAudioChunks = remainingChunks;
    state.pendingAudioBytes = state.pendingAudioChunks.reduce(
      (total, pendingChunk) => total + Number(pendingChunk?.chunk?.length || 0),
      0
    );
      };

      target.prototype.ensureOpenAiAsrSessionConnected = async function({
        session,
        settings = null,
        userId
      }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseOpenAiPerUserTranscription({ session, settings })) return null;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return null;
    if (asrState.closing) return null;

    const ws = asrState.client?.ws;
    if (ws && ws.readyState === 1) {
      return asrState;
    }

    if (asrState.connectPromise) {
      await asrState.connectPromise.catch(() => undefined);
      return asrState.client ? asrState : null;
    }

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const voiceAsrGuidance = resolveVoiceAsrLanguageGuidance(resolvedSettings);
    const model = String(
      session.openAiPerUserAsrModel ||
      resolvedSettings?.voice?.openaiRealtime?.inputTranscriptionModel ||
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    )
      .trim()
      .slice(0, 120);
    const normalizedModel = normalizeOpenAiRealtimeTranscriptionModel(
      model,
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
    const runtimeLogger = this.createOpenAiAsrRuntimeLogger(session, userId);
    const client = new OpenAiRealtimeTranscriptionClient({
      apiKey: this.appConfig.openaiApiKey,
      logger: runtimeLogger
    });
    asrState.client = client;
    asrState.connectPromise = (async () => {
      client.on("transcript", (payload) => {
        if (session.ending) return;
        const transcript = normalizeVoiceText(payload?.text || "", STT_TRANSCRIPT_MAX_CHARS);
        if (!transcript) return;

        const eventType = String(payload?.eventType || "").trim();
        const isFinal = Boolean(payload?.final);
        const itemId = normalizeInlineText(payload?.itemId, 180);
        const previousItemId = normalizeInlineText(payload?.previousItemId, 180) || null;
        const now = Date.now();
        asrState.lastTranscriptAt = now;
        asrState.utterance.lastUpdateAt = now;
        if (isFinal) {
          if (itemId) {
            const entries = Array.isArray(asrState.utterance.finalSegmentEntries)
              ? asrState.utterance.finalSegmentEntries
              : [];
            const nextEntry = {
              itemId,
              previousItemId,
              text: transcript,
              receivedAt: now
            };
            const existingIndex = entries.findIndex((entry) => String(entry?.itemId || "") === itemId);
            if (existingIndex >= 0) {
              entries[existingIndex] = nextEntry;
            } else {
              entries.push(nextEntry);
            }
            asrState.utterance.finalSegmentEntries = entries;
            asrState.utterance.finalSegments = this.orderOpenAiAsrFinalSegments(entries);
          } else {
            asrState.utterance.finalSegments.push(transcript);
          }
          asrState.utterance.partialText = "";
        } else {
          asrState.utterance.partialText = transcript;
        }

        const speakerName = this.resolveVoiceSpeakerName(session, userId) || "someone";
        const shouldLogPartial =
          !isFinal &&
          transcript !== asrState.lastPartialText &&
          now - Number(asrState.lastPartialLogAt || 0) >= 180;
        if (isFinal || shouldLogPartial) {
          if (!isFinal) {
            asrState.lastPartialLogAt = now;
            asrState.lastPartialText = transcript;
          }
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: String(userId || "").trim() || null,
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

      client.on("error_event", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: `openai_realtime_asr_error: ${String(payload?.message || "unknown error")}`,
          metadata: {
            sessionId: session.id,
            code: payload?.code || null,
            param: payload?.param || null
          }
        });
      });

      client.on("socket_closed", (payload) => {
        if (session.ending) return;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
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
      await this.flushPendingOpenAiAsrAudio({
        session,
        userId,
        asrState
      });
    })();

    try {
      await asrState.connectPromise;
      return asrState;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: String(userId || "").trim() || null,
        content: `openai_realtime_asr_connect_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      await this.closeOpenAiAsrSession({
        session,
        userId,
        reason: "connect_failed"
      });
      return null;
    } finally {
      asrState.connectPromise = null;
    }
      };

      target.prototype.beginOpenAiAsrUtterance = function({
        session,
        settings = null,
        userId
      }) {
    if (!session || session.ending) return;
    if (!this.shouldUseOpenAiPerUserTranscription({ session, settings })) return;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return;

    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }

    asrState.utterance = {
      id: Math.max(0, Number(asrState.utterance?.id || 0)) + 1,
      startedAt: Date.now(),
      bytesSent: 0,
      partialText: "",
      finalSegments: [],
      finalSegmentEntries: [],
      lastUpdateAt: 0
    };
    asrState.lastPartialText = "";
    asrState.lastPartialLogAt = 0;
    if (!asrState.isCommittingAsr) {
      try {
        asrState.client?.clearInputAudioBuffer?.();
      } catch {
        // ignore
      }
    }

    void this.ensureOpenAiAsrSessionConnected({
      session,
      settings,
      userId
    });
      };

      target.prototype.commitOpenAiAsrUtterance = async function({
        session,
        settings = null,
        userId,
        captureReason = "stream_end"
      }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseOpenAiPerUserTranscription({ session, settings })) return null;
    const asrState = await this.ensureOpenAiAsrSessionConnected({
      session,
      settings,
      userId
    });
    if (!asrState || asrState.closing) return null;
    const trackedUtterance = asrState.utterance && typeof asrState.utterance === "object"
      ? asrState.utterance
      : null;
    const trackedUtteranceId = Math.max(0, Number(trackedUtterance?.id || 0));
    if (!trackedUtteranceId) return null;
    const transcriptionModelPrimary = normalizeOpenAiRealtimeTranscriptionModel(
      session.openAiPerUserAsrModel,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const utteranceBytesSent = Math.max(0, Number(trackedUtterance?.bytesSent || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (utteranceBytesSent < minCommitBytes) {
      if (utteranceBytesSent > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: "openai_realtime_asr_commit_skipped_small_buffer",
          metadata: {
            sessionId: session.id,
            utteranceBytesSent,
            minCommitBytes,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }
      this.scheduleOpenAiAsrSessionIdleClose({
        session,
        userId
      });
      return {
        transcript: "",
        asrStartedAtMs: 0,
        asrCompletedAtMs: 0,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_per_user_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    }

    asrState.isCommittingAsr = true;
    asrState.committingUtteranceId = trackedUtteranceId;
    await this.flushPendingOpenAiAsrAudio({
      session,
      userId,
      asrState,
      utteranceId: trackedUtteranceId
    });

    if (trackedUtterance) {
      trackedUtterance.finalSegments = [];
      trackedUtterance.finalSegmentEntries = [];
      trackedUtterance.partialText = "";
      trackedUtterance.lastUpdateAt = 0;
    }

    const asrStartedAtMs = Date.now();
    try {
      asrState.client?.commitInputAudioBuffer?.();
      const transcript = await this.waitForOpenAiAsrTranscriptSettle({
        session,
        asrState,
        utterance: trackedUtterance
      });
      const asrCompletedAtMs = Date.now();

      this.scheduleOpenAiAsrSessionIdleClose({
        session,
        userId
      });
      if (trackedUtterance) {
        trackedUtterance.bytesSent = 0;
      }

      if (!transcript) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: String(userId || "").trim() || null,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_per_user_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: String(userId || "").trim() || null,
        content: `openai_realtime_asr_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return null;
    } finally {
      asrState.isCommittingAsr = false;
      asrState.committingUtteranceId = 0;
      const activeUtteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
      if (activeUtteranceId > 0) {
        void this.flushPendingOpenAiAsrAudio({
          session,
          userId,
          asrState,
          utteranceId: activeUtteranceId
        });
      }
    }
      };

      target.prototype.waitForOpenAiAsrTranscriptSettle = async function({
        session,
        asrState,
        utterance = null
      }) {
    if (!session || session.ending || !asrState) return "";
    const trackedUtterance = utterance && typeof utterance === "object"
      ? utterance
      : asrState.utterance;
    const stableWindowMs = Math.max(
      100,
      Number(session.openAiAsrTranscriptStableMs || OPENAI_ASR_TRANSCRIPT_STABLE_MS)
    );
    const maxWaitMs = Math.max(
      stableWindowMs + 120,
      Number(session.openAiAsrTranscriptWaitMaxMs || OPENAI_ASR_TRANSCRIPT_WAIT_MAX_MS)
    );
    const startedAt = Date.now();
    while (Date.now() - startedAt <= maxWaitMs) {
      if (session.ending) return "";
      const now = Date.now();
      const lastUpdateAt = Math.max(0, Number(trackedUtterance?.lastUpdateAt || 0));
      const stable = lastUpdateAt > 0 ? now - lastUpdateAt >= stableWindowMs : false;
      const finalText = normalizeVoiceText(
        Array.isArray(trackedUtterance?.finalSegments)
          ? trackedUtterance.finalSegments.join(" ")
          : "",
        STT_TRANSCRIPT_MAX_CHARS
      );
      const partialText = normalizeVoiceText(
        trackedUtterance?.partialText || "",
        STT_TRANSCRIPT_MAX_CHARS
      );
      if (finalText && stable) return finalText;
      if (!finalText && partialText && stable) return partialText;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const finalText = normalizeVoiceText(
      Array.isArray(trackedUtterance?.finalSegments)
        ? trackedUtterance.finalSegments.join(" ")
        : "",
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (finalText) return finalText;
    return normalizeVoiceText(trackedUtterance?.partialText || "", STT_TRANSCRIPT_MAX_CHARS);
      };

      target.prototype.scheduleOpenAiAsrSessionIdleClose = function({
        session,
        userId
      }) {
    if (!session || session.ending) return;
    const asrState = this.getOrCreateOpenAiAsrSessionState({
      session,
      userId
    });
    if (!asrState) return;
    if (asrState.idleTimer) {
      clearTimeout(asrState.idleTimer);
      asrState.idleTimer = null;
    }
    const ttlMs = Math.max(
      1_000,
      Number(session.openAiAsrSessionIdleTtlMs || OPENAI_ASR_SESSION_IDLE_TTL_MS)
    );
    asrState.idleTimer = setTimeout(() => {
      asrState.idleTimer = null;
      this.closeOpenAiAsrSession({
        session,
        userId,
        reason: "idle_ttl"
      }).catch(() => undefined);
    }, ttlMs);
      };

      target.prototype.shouldUseOpenAiPerUserTranscription = function({
        session = null,
        settings = null
      }: {
        session?: {
          ending?: boolean;
          mode?: string;
          settingsSnapshot?: Record<string, unknown> | null;
        } | null;
        settings?: Record<string, unknown> | null;
      } = {}) {
    if (!session || session.ending) return false;
    if (session.mode !== "openai_realtime") return false;
    if (!this.appConfig?.openaiApiKey) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (this.resolveRealtimeReplyStrategy({
      session,
      settings: resolvedSettings
    }) !== "brain") {
      return false;
    }
    if (resolvedSettings?.voice?.openaiRealtime?.usePerUserAsrBridge === false) {
      return false;
    }
    return true;
      };

      target.prototype.shouldUseOpenAiSharedTranscription = function({
        session = null,
        settings = null
      }: {
        session?: {
          ending?: boolean;
          mode?: string;
          settingsSnapshot?: Record<string, unknown> | null;
        } | null;
        settings?: Record<string, unknown> | null;
      } = {}) {
    if (!session || session.ending) return false;
    if (session.mode !== "openai_realtime") return false;
    if (!this.appConfig?.openaiApiKey) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (this.resolveRealtimeReplyStrategy({
      session,
      settings: resolvedSettings
    }) !== "brain") {
      return false;
    }
    if (resolvedSettings?.voice?.openaiRealtime?.usePerUserAsrBridge === true) {
      return false;
    }
    return true;
      };

      target.prototype.flushPendingOpenAiSharedAsrAudio = async function({
        session,
        asrState = null,
        utteranceId = null
      }) {
    const state = asrState && typeof asrState === "object"
      ? asrState
      : this.getOpenAiSharedAsrState(session);
    if (!state || state.closing) return;
    const client = state.client;
    if (!client || !client.ws || client.ws.readyState !== 1) return;
    const targetUtteranceId = Math.max(
      0,
      Number(
        utteranceId !== null && utteranceId !== undefined
          ? utteranceId
          : state.utterance?.id || 0
      )
    );
    if (!targetUtteranceId) return;
    const committingUtteranceId = Math.max(0, Number(state.committingUtteranceId || 0));
    if (
      state.isCommittingAsr &&
      committingUtteranceId > 0 &&
      targetUtteranceId !== committingUtteranceId
    ) {
      return;
    }
    const chunks = Array.isArray(state.pendingAudioChunks) ? state.pendingAudioChunks : [];
    if (!chunks.length) return;

    const remainingChunks = [];
    while (chunks.length > 0) {
      const entry = chunks.shift();
      if (!entry || !Buffer.isBuffer(entry.chunk)) continue;
      if (Number(entry.utteranceId || 0) !== targetUtteranceId) {
        remainingChunks.push(entry);
        continue;
      }
      try {
        client.appendInputAudioPcm(entry.chunk);
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: state.userId || null,
          content: `openai_realtime_asr_audio_append_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        break;
      }
    }
    state.pendingAudioChunks = remainingChunks;
    state.pendingAudioBytes = state.pendingAudioChunks.reduce(
      (total, pendingChunk) => total + Number(pendingChunk?.chunk?.length || 0),
      0
    );
      };

      target.prototype.commitOpenAiSharedAsrUtterance = async function({
        session,
        settings = null,
        userId,
        captureReason = "stream_end"
      }) {
    if (!session || session.ending) return null;
    if (!this.shouldUseOpenAiSharedTranscription({ session, settings })) return null;
    const asrState = await this.ensureOpenAiSharedAsrSessionConnected({
      session,
      settings
    });
    const normalizedUserId = String(userId || "").trim();
    if (!asrState || asrState.closing || !normalizedUserId) return null;
    if (asrState.userId && asrState.userId !== normalizedUserId) {
      return null;
    }
    asrState.userId = normalizedUserId;
    const trackedUtterance = asrState.utterance && typeof asrState.utterance === "object"
      ? asrState.utterance
      : null;
    const trackedUtteranceId = Math.max(0, Number(trackedUtterance?.id || 0));
    if (!trackedUtteranceId) return null;
    const transcriptionModelPrimary = normalizeOpenAiRealtimeTranscriptionModel(
      session.openAiPerUserAsrModel,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const utteranceBytesSent = Math.max(0, Number(trackedUtterance?.bytesSent || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (utteranceBytesSent < minCommitBytes) {
      if (utteranceBytesSent > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "openai_realtime_asr_commit_skipped_small_buffer",
          metadata: {
            sessionId: session.id,
            utteranceBytesSent,
            minCommitBytes,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }
      if (asrState.userId === normalizedUserId) {
        asrState.userId = null;
      }
      if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
        this.scheduleOpenAiSharedAsrSessionIdleClose(session);
      }
      return {
        transcript: "",
        asrStartedAtMs: 0,
        asrCompletedAtMs: 0,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_shared_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    }

    asrState.isCommittingAsr = true;
    asrState.committingUtteranceId = trackedUtteranceId;
    await this.flushPendingOpenAiSharedAsrAudio({
      session,
      asrState,
      utteranceId: trackedUtteranceId
    });

    const asrStartedAtMs = Date.now();
    try {
      const pendingCommitRequests = this.pruneOpenAiSharedAsrPendingCommitRequests(asrState);
      const commitRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      pendingCommitRequests.push({
        id: commitRequestId,
        userId: normalizedUserId,
        requestedAt: Date.now()
      });
      asrState.client?.commitInputAudioBuffer?.();
      const committedItemId = await this.waitForOpenAiSharedAsrCommittedItem({
        session,
        asrState,
        userId: normalizedUserId,
        commitRequestId
      });
      const transcript = await this.waitForOpenAiSharedAsrTranscriptByItem({
        session,
        asrState,
        itemId: committedItemId
      });
      const asrCompletedAtMs = Date.now();

      if (asrState.utterance === trackedUtterance) {
        trackedUtterance.bytesSent = 0;
      }
      if (asrState.userId === normalizedUserId) {
        asrState.userId = null;
      }
      if (!this.tryHandoffSharedAsrToWaitingCapture({ session, settings })) {
        this.scheduleOpenAiSharedAsrSessionIdleClose(session);
      }

      if (!transcript) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: "voice_realtime_transcription_empty",
          metadata: {
            sessionId: session.id,
            source: "openai_realtime_asr",
            model: transcriptionModelPrimary,
            captureReason: String(captureReason || "stream_end")
          }
        });
      }

      return {
        transcript,
        asrStartedAtMs,
        asrCompletedAtMs,
        transcriptionModelPrimary,
        transcriptionModelFallback: null,
        transcriptionPlanReason: "openai_realtime_shared_transcription",
        usedFallbackModel: false,
        captureReason: String(captureReason || "stream_end")
      };
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: `openai_realtime_asr_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return null;
    } finally {
      asrState.isCommittingAsr = false;
      asrState.committingUtteranceId = 0;
      const activeUtteranceId = Math.max(0, Number(asrState.utterance?.id || 0));
      if (activeUtteranceId > 0) {
        void this.flushPendingOpenAiSharedAsrAudio({
          session,
          asrState,
          utteranceId: activeUtteranceId
        });
      }
    }
      };
}
