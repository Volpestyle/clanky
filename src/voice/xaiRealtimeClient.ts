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
  sessionConfig;
  activeResponseId;
  activeResponseStatus;
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
    this.sessionConfig = null;
    this.activeResponseId = null;
    this.activeResponseStatus = null;
    this.audioBase64Buffer = null;
  }

  async connect({
    voice = "Rex",
    instructions = "",
    region = "us-east-1",
    inputAudioFormat = "audio/pcm",
    outputAudioFormat = "audio/pcm",
    inputSampleRateHz = 24000,
    outputSampleRateHz = 24000,
    tools = [],
    toolChoice = "auto"
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

    this.sessionConfig = {
      voice: String(voice || "Rex").trim() || "Rex",
      instructions: String(instructions || ""),
      region: String(region || "us-east-1").trim() || "us-east-1",
      audio: {
        input: {
          format: {
            type: String(inputAudioFormat || "audio/pcm").trim() || "audio/pcm",
            rate: Number(inputSampleRateHz) || 24000
          }
        },
        output: {
          format: {
            type: String(outputAudioFormat || "audio/pcm").trim() || "audio/pcm",
            rate: Number(outputSampleRateHz) || 24000
          }
        }
      },
      turn_detection: {
        type: null
      },
      modalities: ["audio", "text"],
      tools: normalizeXaiRealtimeTools(tools),
      toolChoice: normalizeXaiRealtimeToolChoice(toolChoice)
    };
    this.sendSessionUpdate();

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
      const responseId =
        event.response?.id ||
        event.response_id ||
        event.id ||
        null;
      const responseStatus =
        event.response?.status ||
        event.status ||
        "in_progress";
      this.setActiveResponse(responseId, responseStatus);
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
      const responseId =
        event.response?.id ||
        event.response_id ||
        event.id ||
        null;
      const responseStatus =
        event.response?.status ||
        event.status ||
        "completed";
      this.finishActiveResponse(responseId, responseStatus);
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
    // Set response-in-progress before sending so concurrent callers see it
    // immediately, closing the TOCTOU window between the send and the async
    // response.created event from the server.
    this._responseInProgress = true;
    this.activeResponseStatus = "in_progress";
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
      this.clearActiveResponse("cancelled");
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
    this.sendTextConversationItem(prompt);
    this.createAudioResponse();
  }

  requestPlaybackUtterance(promptText) {
    const prompt = String(promptText || "").trim();
    if (!prompt) return;
    this.sendTextConversationItem(prompt);
    this.createAudioResponse();
  }

  updateInstructions(instructions: string) {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("xAI realtime session config is not initialized.");
    }
    this.sessionConfig = {
      ...this.sessionConfig,
      instructions: String(instructions || "")
    };
    this.sendSessionUpdate();
  }

  updateTools({
    tools = [],
    toolChoice = "auto"
  }: {
    tools?: Array<{ type: string; name: string; description: string; parameters: object }>;
    toolChoice?: string;
  } = {}) {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("xAI realtime session config is not initialized.");
    }
    this.sessionConfig = {
      ...this.sessionConfig,
      tools: normalizeXaiRealtimeTools(tools),
      toolChoice: normalizeXaiRealtimeToolChoice(toolChoice)
    };
    this.sendSessionUpdate();
  }

  sendFunctionCallOutput({
    callId = "",
    output = ""
  } = {}) {
    const normalizedCallId = String(callId || "").trim();
    if (!normalizedCallId) {
      throw new Error("xAI realtime function_call_output requires a callId.");
    }

    let normalizedOutput = "";
    if (typeof output === "string") {
      normalizedOutput = output;
    } else {
      try {
        normalizedOutput = JSON.stringify(output ?? null);
      } catch {
        normalizedOutput = String(output ?? "");
      }
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: normalizedCallId,
        output: normalizedOutput
      }
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
    this.clearActiveResponse();
  }

  getState() {
    return {
      ...buildCommonRealtimeState(this),
      activeResponseId: this.activeResponseId || null,
      activeResponseStatus: this.activeResponseStatus || null
    };
  }

  log(level, event, metadata = null) {
    if (!this.logger) return;
    this.logger({ level, event, metadata });
  }

  sendSessionUpdate() {
    if (!this.sessionConfig || typeof this.sessionConfig !== "object") {
      throw new Error("xAI realtime session config is not initialized.");
    }
    this.send({
      type: "session.update",
      session: compactObject({
        voice: this.sessionConfig.voice,
        instructions: this.sessionConfig.instructions,
        audio: this.sessionConfig.audio,
        turn_detection: this.sessionConfig.turn_detection,
        region: this.sessionConfig.region,
        modalities: this.sessionConfig.modalities,
        tools: this.sessionConfig.tools
      })
    });
  }

  sendTextConversationItem(prompt) {
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
  }

  setActiveResponse(responseId, status = "in_progress") {
    const normalizedId = responseId ? String(responseId).trim() : "";
    const normalizedStatus = String(status || "in_progress").trim() || "in_progress";
    this._responseInProgress = true;
    if (normalizedId) {
      this.activeResponseId = normalizedId;
    }
    this.activeResponseStatus = normalizedStatus;
  }

  finishActiveResponse(responseId = null, status = "completed") {
    const normalizedStatus = String(status || "completed")
      .trim()
      .toLowerCase();
    const normalizedId = responseId ? String(responseId).trim() : "";
    if (!normalizedId || !this.activeResponseId || normalizedId === this.activeResponseId) {
      this.clearActiveResponse(normalizedStatus || "completed");
      return;
    }
    if (TERMINAL_RESPONSE_STATUSES.has(normalizedStatus)) {
      this.clearActiveResponse(normalizedStatus);
    }
  }

  clearActiveResponse(status = null) {
    this._responseInProgress = false;
    this.activeResponseId = null;
    this.activeResponseStatus = status ? String(status).trim() || null : null;
  }
}

const TERMINAL_RESPONSE_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
  "incomplete"
]);

function normalizeXaiRealtimeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const type = String(tool.type || "").trim();
      const name = String(tool.name || "").trim();
      if (!type || !name) return null;
      return {
        type,
        name,
        description: String(tool.description || "").trim(),
        parameters:
          tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
            ? tool.parameters
            : { type: "object", properties: {}, additionalProperties: true }
      };
    })
    .filter(Boolean);
}

function normalizeXaiRealtimeToolChoice(toolChoice) {
  const normalized = String(toolChoice || "auto").trim().toLowerCase();
  return normalized === "none" ? "none" : "auto";
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
      instructionsChars: session.instructions ? String(session.instructions).length : 0,
      toolsCount: Array.isArray(session.tools) ? session.tools.length : 0
    });
  }

  const preview = safeJsonPreview(payload);
  return compactObject({
    type,
    preview
  });
}
