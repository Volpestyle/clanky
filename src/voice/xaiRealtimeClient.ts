import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildCommonRealtimeState,
  closeRealtimeSocket,
  compactObject,
  extractAudioBase64,
  handleRealtimeSocketClose,
  handleRealtimeSocketError,
  markRealtimeConnected,
  openRealtimeSocket,
  safeJsonPreview,
  sendRealtimePayload
} from "./realtimeClientCore.ts";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";

const AUDIO_DELTA_TYPES = new Set([
  "response.audio.delta",
  "response.output_audio.delta",
  "output_audio.delta",
  "audio.delta",
  "response.audio.chunk",
  "response.output_audio.chunk"
]);

const TRANSCRIPT_TYPES = new Set([
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.audio_transcript.done",
  "response.audio_transcript.completed",
  "response.text.delta",
  "response.text.done",
  "response.output_text.delta",
  "response.output_text.done",
  "transcript.completed"
]);

export class XaiRealtimeClient extends EventEmitter {
  apiKey;
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
  audioBase64Buffer: Buffer | null;

  constructor({ apiKey, logger = null }) {
    super();
    this.apiKey = String(apiKey || "").trim();
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
    this.audioBase64Buffer = null;
  }

  async connect({
    voice = "Rex",
    instructions = "",
    region = "us-east-1",
    inputAudioFormat = "audio/pcm",
    outputAudioFormat = "audio/pcm",
    inputSampleRateHz = 24000,
    outputSampleRateHz = 24000
  } = {}) {
    if (!this.apiKey) {
      throw new Error("Missing XAI_API_KEY for realtime voice runtime.");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.getState();
    }

    const ws = await this.openSocket();
    markRealtimeConnected(this, ws);

    ws.on("message", (payload) => {
      this.lastEventAt = Date.now();
      this.handleIncoming(payload);
    });

    ws.on("error", (error) => {
      handleRealtimeSocketError(this, error, {
        logEvent: "xai_realtime_ws_error"
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      handleRealtimeSocketClose(this, code, reasonBuffer, {
        logEvent: "xai_realtime_ws_closed"
      });
    });

    this.send({
      type: "session.update",
      session: compactObject({
        voice,
        instructions,
        audio: {
          input: {
            format: {
              type: inputAudioFormat,
              rate: Number(inputSampleRateHz) || 24000
            }
          },
          output: {
            format: {
              type: outputAudioFormat,
              rate: Number(outputSampleRateHz) || 24000
            }
          }
        },
        turn_detection: {
          type: null
        },
        region,
        modalities: ["audio", "text"]
      })
    });

    return this.getState();
  }

  async openSocket(): Promise<WebSocket> {
    return await openRealtimeSocket({
      url: XAI_REALTIME_URL,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeoutMessage: "Timed out connecting to xAI realtime after 10000ms.",
      connectErrorPrefix: "xAI realtime connection failed"
    });
  }

  _responseInProgress = false;

  handleIncoming(payload) {
    let event = null;

    try {
      event = JSON.parse(String(payload || ""));
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;

    this.emit("event", event);

    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessionId = event.session?.id || this.sessionId;
      this.log("info", "xai_realtime_session_created", { sessionId: this.sessionId });
      return;
    }

    if (event.type === "response.created") {
      this._responseInProgress = true;
    }

    if (event.type === "error") {
      const errorPayload = event.error && typeof event.error === "object" ? event.error : {};
      const message =
        event.error?.message || event.error?.code || event.message || "Unknown xAI realtime error";
      this.lastError = String(message);
      const errorMetadata = {
        error: this.lastError,
        code: errorPayload?.code || null,
        type: event.type,
        param: errorPayload?.param || null,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      };
      this.log("warn", "xai_realtime_error_event", {
        ...errorMetadata
      });
      this.emit("error_event", {
        message: this.lastError,
        code: errorPayload?.code || null,
        param: errorPayload?.param || null,
        event,
        lastOutboundEventType: this.lastOutboundEventType || null,
        lastOutboundEvent: this.lastOutboundEvent || null,
        recentOutboundEvents: this.recentOutboundEvents.slice(-4)
      });
      return;
    }

    if (AUDIO_DELTA_TYPES.has(event.type)) {
      const audioBase64 = extractAudioBase64(event);
      if (audioBase64) {
        this.emit("audio_delta", audioBase64);
      }
      return;
    }

    if (TRANSCRIPT_TYPES.has(event.type)) {
      const transcript =
        event.transcript ||
        event.text ||
        event.delta ||
        event?.item?.content?.[0]?.transcript ||
        null;

      if (transcript) {
        this.emit("transcript", {
          text: String(transcript),
          eventType: String(event.type || "")
        });
      }
      return;
    }

    if (event.type === "response.done") {
      this._responseInProgress = false;
      this.emit("response_done", event);
    }
  }

  appendInputAudioPcm(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length) return;

    const combined = this.audioBase64Buffer
      ? Buffer.concat([this.audioBase64Buffer, audioBuffer])
      : audioBuffer;

    const remainder = combined.length % 6;
    const sendLength = combined.length - remainder;

    if (sendLength > 0) {
      const sendBuffer = combined.subarray(0, sendLength);
      this.appendInputAudioBase64(sendBuffer.toString("base64"));
    }

    this.audioBase64Buffer = remainder > 0
      ? combined.subarray(sendLength)
      : null;
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

  createAudioResponse() {
    this.send({
      type: "response.create",
      response: {
        modalities: ["audio", "text"]
      }
    });
  }

  cancelActiveResponse() {
    try {
      this.send({
        type: "response.cancel"
      });
      return true;
    } catch (error) {
      this.log("warn", "xai_realtime_response_cancel_failed", {
        error: String(error?.message || error)
      });
      return false;
    }
  }

  requestTextUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    });
    this.createAudioResponse();
  }

  updateInstructions(instructions: string) {
    this.send({
      type: "session.update",
      session: { instructions }
    });
  }

  updateTools(tools: Array<{ type: string; name: string; description: string; parameters: object }>) {
    this.send({
      type: "session.update",
      session: { tools }
    });
  }

  isResponseInProgress(): boolean {
    return this._responseInProgress;
  }

  send(payload) {
    sendRealtimePayload(this, {
      payload,
      eventType: String(payload?.type || "unknown"),
      summarizeOutboundPayload,
      skipHistoryEventType: "input_audio_buffer.append",
      skipLogEventType: "input_audio_buffer.append",
      logEvent: "xai_realtime_client_event_sent",
      socketNotOpenMessage: "xAI realtime socket is not open."
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
    this.audioBase64Buffer = null;
  }

  getState() {
    return buildCommonRealtimeState(this);
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }
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

  if (type === "input_audio_buffer.commit" || type === "response.create") {
    const response = payload.response && typeof payload.response === "object" ? payload.response : null;
    return compactObject({
      type,
      response: response
        ? {
          modalities: Array.isArray(response.modalities) ? response.modalities.slice(0, 4) : null
        }
        : null
    });
  }

  if (type === "session.update") {
    const session = payload.session && typeof payload.session === "object" ? payload.session : {};
    return compactObject({
      type,
      voice: session.voice || null,
      region: session.region || null,
      modalities: Array.isArray(session.modalities) ? session.modalities.slice(0, 4) : null,
      inputAudioType: session?.audio?.input?.format?.type || null,
      inputAudioRate: Number(session?.audio?.input?.format?.rate) || null,
      outputAudioType: session?.audio?.output?.format?.type || null,
      outputAudioRate: Number(session?.audio?.output?.format?.rate) || null,
      turnDetectionType:
        session?.turn_detection && typeof session.turn_detection === "object"
          ? String(session.turn_detection.type || "")
          : null,
      instructionsChars: session.instructions ? String(session.instructions).length : 0
    });
  }

  const preview = safeJsonPreview(payload);
  return compactObject({
    type,
    preview
  });
}
