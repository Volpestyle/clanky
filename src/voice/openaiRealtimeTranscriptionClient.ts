import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildCommonRealtimeState,
  closeRealtimeSocket,
  compactObject,
  handleRealtimeSocketClose,
  handleRealtimeSocketError,
  markRealtimeConnected,
  openRealtimeSocket,
  sendRealtimePayload
} from "./realtimeClientCore.ts";
import {
  DEFAULT_OPENAI_BASE_URL,
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  normalizeOpenAiBaseUrl,
  normalizeOpenAiRealtimeTranscriptionModel
} from "./realtimeProviderNormalization.ts";

const TRANSCRIPT_DELTA_TYPES = new Set([
  "conversation.item.input_audio_transcription.delta"
]);

const TRANSCRIPT_FINAL_TYPES = new Set([
  "conversation.item.input_audio_transcription.completed"
]);

const INPUT_AUDIO_SPEECH_STARTED_TYPE = "input_audio_buffer.speech_started";
const INPUT_AUDIO_SPEECH_STOPPED_TYPE = "input_audio_buffer.speech_stopped";
const OPENAI_REALTIME_ASR_TURN_DETECTION = Object.freeze({
  type: "server_vad",
  threshold: 0.55,
  prefix_padding_ms: 240,
  silence_duration_ms: 450,
  create_response: false,
  interrupt_response: false
});

export class OpenAiRealtimeTranscriptionClient extends EventEmitter {
  apiKey;
  baseUrl;
  logger;
  ws;
  connectedAt;
  lastEventAt;
  lastError;
  sessionId;
  lastCloseCode;
  lastCloseReason;
  lastOutboundEventType;
  lastOutboundEventAt;
  lastOutboundEvent;
  recentOutboundEvents;
  sessionConfig;
  committedInputAudioItems;

  constructor({ apiKey, baseUrl = DEFAULT_OPENAI_BASE_URL, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim() || DEFAULT_OPENAI_BASE_URL;
    this.logger = typeof logger === "function" ? logger : null;
    this.ws = null;
    this.connectedAt = 0;
    this.lastEventAt = 0;
    this.lastError = null;
    this.sessionId = null;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
    this.lastOutboundEventType = null;
    this.lastOutboundEventAt = 0;
    this.lastOutboundEvent = null;
    this.recentOutboundEvents = [];
    this.sessionConfig = null;
    this.committedInputAudioItems = new Map();
  }

  async connect({
    model = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
    inputAudioFormat = "pcm16",
    inputTranscriptionModel = OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
    inputTranscriptionLanguage = "",
    inputTranscriptionPrompt = ""
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing OPENAI_API_KEY for OpenAI realtime transcription runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const resolvedInputAudioFormat = normalizeOpenAiRealtimeAudioFormat(inputAudioFormat);
    const resolvedInputTranscriptionModel = normalizeOpenAiRealtimeTranscriptionModel(
      inputTranscriptionModel || model,
      OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
    );
    const resolvedInputTranscriptionLanguage = String(inputTranscriptionLanguage || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-")
      .slice(0, 24);
    const resolvedInputTranscriptionPrompt = String(inputTranscriptionPrompt || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);

    this.committedInputAudioItems.clear();
    const ws = await this.openSocket(this.buildRealtimeUrl());
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "openai_realtime_asr_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "openai_realtime_asr_ws_closed"
      });
    });

    this.sessionConfig = {
      inputAudioFormat: resolvedInputAudioFormat,
      inputTranscriptionModel: resolvedInputTranscriptionModel,
      inputTranscriptionLanguage: resolvedInputTranscriptionLanguage,
      inputTranscriptionPrompt: resolvedInputTranscriptionPrompt
    };
    this.sendSessionUpdate();
    return this.getState();
  }

  buildRealtimeUrl() {
    const base = normalizeOpenAiBaseUrl(this.baseUrl);
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/realtime`;
    url.searchParams.set("intent", "transcription");
    return url.toString();
  }

  async openSocket(url): Promise<WebSocket> {
    return await openRealtimeSocket({
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeoutMessage: "Timed out connecting to OpenAI realtime ASR after 10000ms.",
      connectErrorPrefix: "OpenAI realtime ASR connection failed"
    });
  }

  handleIncoming(payload) {
    let event = null;

    try {
      event = JSON.parse(String(payload || ""));
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;
    this.emit("event", event);

    if (event.type === "input_audio_buffer.committed") {
      const itemId = normalizeRealtimeItemId(event.item_id || event.item?.id);
      if (!itemId) return;
      const previousItemId = normalizeRealtimeItemId(event.previous_item_id);
      this.committedInputAudioItems.set(itemId, {
        previousItemId: previousItemId || null,
        at: Date.now()
      });
      // Bound memory for long sessions.
      if (this.committedInputAudioItems.size > 320) {
        const overflow = this.committedInputAudioItems.size - 320;
        let dropped = 0;
        for (const staleItemId of this.committedInputAudioItems.keys()) {
          this.committedInputAudioItems.delete(staleItemId);
          dropped += 1;
          if (dropped >= overflow) break;
        }
      }
      return;
    }

    if (
      event.type === "session.created" ||
      event.type === "session.updated" ||
      event.type === "transcription_session.created" ||
      event.type === "transcription_session.updated"
    ) {
      this.sessionId =
        event.session?.id ||
        event.transcription_session?.id ||
        (typeof event.id === "string" ? event.id : null) ||
        this.sessionId;
      this.log("info", "openai_realtime_asr_session_updated", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "error") {
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown OpenAI realtime ASR error";
      this.lastError = String(message);
      this.log("warn", "openai_realtime_asr_error_event", {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        eventId: event.event_id || null
      });
      this.emit("error_event", {
        message: this.lastError,
        code: errorPayload?.code || null,
        param: errorPayload?.param || null,
        event
      });
      return;
    }

    const eventType = String(event.type || "");
    if (
      eventType === INPUT_AUDIO_SPEECH_STARTED_TYPE ||
      eventType === INPUT_AUDIO_SPEECH_STOPPED_TYPE
    ) {
      this.emit(eventType === INPUT_AUDIO_SPEECH_STARTED_TYPE ? "speech_started" : "speech_stopped", {
        eventType,
        audioStartMs: Number.isFinite(Number(event.audio_start_ms))
          ? Math.max(0, Math.round(Number(event.audio_start_ms)))
          : null,
        audioEndMs: Number.isFinite(Number(event.audio_end_ms))
          ? Math.max(0, Math.round(Number(event.audio_end_ms)))
          : null,
        itemId: normalizeRealtimeItemId(event.item_id || event.item?.id) || null
      });
      return;
    }

    if (TRANSCRIPT_DELTA_TYPES.has(eventType) || TRANSCRIPT_FINAL_TYPES.has(eventType)) {
      const itemId = normalizeRealtimeItemId(event.item_id || event.item?.id);
      const previousItemId =
        normalizeRealtimeItemId(event.previous_item_id) ||
        (itemId ? this.committedInputAudioItems.get(itemId)?.previousItemId || null : null);
      const transcript =
        event.transcript ||
        event.text ||
        event.delta ||
        event?.item?.content?.[0]?.transcript ||
        "";
      const normalizedTranscript = String(transcript || "").trim();
      if (!normalizedTranscript) return;
      const isFinal = TRANSCRIPT_FINAL_TYPES.has(eventType);
      this.emit("transcript", {
        text: normalizedTranscript,
        eventType,
        final: isFinal,
        itemId: itemId || null,
        previousItemId: previousItemId || null,
        logprobs: isFinal && Array.isArray(event.logprobs) ? event.logprobs : null
      });
      return;
    }
  }

  appendInputAudioPcm(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) return;
    this.appendInputAudioBase64(audioBuffer.toString("base64"));
  }

  appendInputAudioBase64(audioBase64) {
    if (!audioBase64) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: String(audioBase64)
    });
  }

  commitInputAudioBuffer() {
    this.send({ type: "input_audio_buffer.commit" });
  }

  clearInputAudioBuffer() {
    this.send({ type: "input_audio_buffer.clear" });
  }

  send(payload) {
    sendRealtimePayload(this, {
      payload,
      eventType: String(payload?.type || "unknown"),
      summarizeOutboundPayload,
      skipHistoryEventType: "input_audio_buffer.append",
      skipLogEventType: "input_audio_buffer.append",
      logEvent: "openai_realtime_asr_event_sent",
      socketNotOpenMessage: "OpenAI realtime ASR socket is not open."
    });
  }

  updateTranscriptionGuidance({ language = "", prompt = "" } = {}) {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("OpenAI realtime ASR session config is not initialized.");
    }
    this.sessionConfig = {
      ...this.sessionConfig,
      inputTranscriptionLanguage: String(language || "")
        .trim()
        .toLowerCase()
        .replace(/_/g, "-")
        .slice(0, 24),
      inputTranscriptionPrompt: String(prompt || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280)
    };
    this.sendSessionUpdate();
  }

  sendSessionUpdate() {
    const session = this.sessionConfig && typeof this.sessionConfig === "object" ? this.sessionConfig : {};
    const transcription = compactObject({
      model: normalizeOpenAiRealtimeTranscriptionModel(
        session.inputTranscriptionModel,
        OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL
      ),
      language: String(session.inputTranscriptionLanguage || "").trim() || null,
      prompt: String(session.inputTranscriptionPrompt || "").trim() || null
    });
    const inputAudio = {
      format: normalizeOpenAiRealtimeAudioFormat(session.inputAudioFormat),
      noise_reduction: { type: "near_field" },
      turn_detection: OPENAI_REALTIME_ASR_TURN_DETECTION,
      transcription
    };
    this.send({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: inputAudio
        },
        // Include logprobs so downstream can compute transcript confidence when needed.
        include: ["item.input_audio_transcription.logprobs"]
      }
    });
  }

  async close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return;
    }
    await closeRealtimeSocket(this.ws);
    this.ws = null;
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this)
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
}

function normalizeOpenAiRealtimeAudioFormat(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = String(value.type || "")
      .trim()
      .toLowerCase();
    if (type === "audio/pcm") {
      const rate = Number(value.rate);
      return {
        type: "audio/pcm",
        rate: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 24000
      };
    }
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "audio/pcm" || normalized === "pcm16") {
    return {
      type: "audio/pcm",
      rate: 24000
    };
  }

  return {
    type: "audio/pcm",
    rate: 24000
  };
}

function normalizeRealtimeItemId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.slice(0, 180);
}

function summarizeOutboundPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = String(payload.type || "unknown");
  if (type === "input_audio_buffer.append") {
    const audioChars = typeof payload.audio === "string" ? payload.audio.length : null;
    return compactObject({
      type,
      audioChars
    });
  }

  if (type === "input_audio_buffer.commit" || type === "input_audio_buffer.clear") {
    return {
      type
    };
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    const audio = session.audio && typeof session.audio === "object" ? session.audio : {};
    return compactObject({
      type,
      sessionType: session.type || null,
      inputFormat: audio?.input?.format || null,
      inputTurnDetectionType: audio?.input?.turn_detection?.type || null,
      inputTranscriptionModel: audio?.input?.transcription?.model || null
    });
  }

  return {
    type
  };
}
